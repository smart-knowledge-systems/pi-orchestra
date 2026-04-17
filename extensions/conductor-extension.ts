/**
 * Conductor extension entrypoint.
 *
 * Bootstraps the pi-orchestra runtime and wires the full staged conductor flow:
 * Stage 1 restatement -> Stage 2 expansion -> Stage 3 retrieval ->
 * Stage 4 evidence -> Stage 5 synthesis -> Stage 6 execution ->
 * optional recursive restart.
 *
 * The conductor itself still does not read raw repo files directly. Raw file access,
 * when needed, happens inside deterministic runtime services such as retrieval and
 * evidence assembly.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { complete, type UserMessage } from '@mariozechner/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { ArtifactStore } from '../src/artifacts/store.ts';
import type {
  AnalysisReportV1,
  ChangeSpecV1,
  ExpandedSpec,
  IntentCaptureV1,
  IntentRestatementV1,
  RetrievalIndexV1,
} from '../src/artifacts/types.ts';
import { createEvidencePlan } from '../src/conductor/evidence-plan.ts';
import { ExpansionController, type ExpansionReviewResponse } from '../src/conductor/expansion.ts';
import {
  getPromotionPrompt,
  promoteAndRestart,
  type PromotionResult,
} from '../src/conductor/recursive-intent.ts';
import { canStartRetrieval, inspectRetrievalResult } from '../src/conductor/retrieval.ts';
import { Stage1Controller, type RestateInput } from '../src/conductor/stage-1.ts';
import { CONDUCTOR_SYSTEM_PREAMBLE, RESTATEMENT_INSTRUCTION } from '../src/conductor/prompts.ts';
import { StageMachine } from '../src/conductor/stage-machine.ts';
import { createConfig, type PiOrchestraConfig } from '../src/runtime/config.ts';
import { buildRestatementContext, toIntentFileRefs } from '../src/util/intent-files.ts';
import { evidenceAssemble } from '../src/services/evidence-assembler.ts';
import { executionDispatch } from '../src/services/execution-dispatch.ts';
import { retrievalDispatch } from '../src/services/retrieval-dispatch.ts';
import type { AgentModelCallback } from '../src/retriever/agent-types.ts';
import { synthesisDispatch, type SynthesisTaskType } from '../src/services/synthesis-dispatch.ts';

type OrchestraRuntime = {
  config: PiOrchestraConfig;
  store: ArtifactStore;
  machineReady: Promise<StageMachine>;
  bootedAt: string;
  logPath: string;
};

const runtime = createRuntime(process.cwd());

function createRuntime(repoRoot: string): OrchestraRuntime {
  const config = createConfig(repoRoot);
  return {
    config,
    store: new ArtifactStore(config),
    machineReady: StageMachine.init(config),
    bootedAt: new Date().toISOString(),
    logPath: resolve(config.piDir, 'orchestra.log'),
  };
}

async function logEvent(message: string, details?: unknown): Promise<void> {
  const payload =
    details && typeof details === 'object'
      ? { ts: new Date().toISOString(), message, ...(details as Record<string, unknown>) }
      : { ts: new Date().toISOString(), message, details };
  const line = JSON.stringify(payload);
  await mkdir(dirname(runtime.logPath), { recursive: true });
  await appendFile(runtime.logPath, `${line}\n`, 'utf-8');
}

async function getMachine(): Promise<StageMachine> {
  return runtime.machineReady;
}

async function getModelText(systemPrompt: string, userText: string, ctx: ExtensionContext) {
  if (!ctx.model) {
    throw new Error('No model selected for conductor model call');
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
  }

  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: userText }],
    timestamp: Date.now(),
  };

  const response = await complete(
    ctx.model,
    {
      systemPrompt,
      messages: [userMessage],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
    },
  );

  if (response.stopReason === 'aborted') {
    throw new Error('Conductor model call was aborted');
  }

  const text = response.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Conductor model call returned empty text');
  }

  return text;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [];
}

function extractJsonObject(text: string): string | null {
  const stripped = stripCodeFence(text);
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return stripped.slice(firstBrace, lastBrace + 1);
}

function fallbackExpandedSpecFromText(
  raw: string,
  input: {
    user_intent_verbatim: string;
    approved_restated_intent: string;
    included_files: Array<{ path: string; reason: string }>;
  },
): ExpandedSpec {
  const lines = stripCodeFence(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletValues = (prefixes: string[]): string[] => {
    const values: string[] = [];
    for (const line of lines) {
      const normalized = line.toLowerCase();
      if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
        const value = line.replace(/^[^:]+:\s*/, '').trim();
        if (value) values.push(value);
      } else if (/^[-*]\s+/.test(line)) {
        values.push(line.replace(/^[-*]\s+/, '').trim());
      }
    }
    return Array.from(new Set(values.filter(Boolean)));
  };

  const deliverables = bulletValues(['deliverable:', 'deliverables:']);
  return {
    objective: lines[0] ?? input.approved_restated_intent,
    deliverables: deliverables.length > 0 ? deliverables : [input.approved_restated_intent],
    constraints: bulletValues(['constraint:', 'constraints:']),
    retrieval_focus: bulletValues(['retrieval focus:', 'focus:', 'retrieval:']),
    open_questions: bulletValues(['open question:', 'open questions:', 'question:', 'questions:']),
  };
}

function summarizeEvidencePreview(preview: {
  estimated_lines: number | null;
  estimated_tokens: number | null;
  message: string;
}) {
  return [
    'Evidence preview',
    `Estimated lines: ${preview.estimated_lines ?? 'unknown'}`,
    `Estimated tokens: ${preview.estimated_tokens ?? 'unknown'}`,
    `Assembler note: ${preview.message}`,
  ].join('\n');
}

function summarizeEvidencePlan(
  plan: ReturnType<typeof createDefaultEvidencePlan>,
  index: RetrievalIndexV1,
) {
  const fileSummaries = plan.selection.files.slice(0, 5).map((file) => {
    const match = index.files.find((candidate) => candidate.file_id === file.file_id);
    return `${match?.path ?? file.file_id} — spans=${file.spans.length}, ast=${file.include_ast_skeleton ? 'yes' : 'no'}, summary=${file.include_retriever_summary ? 'yes' : 'no'}`;
  });

  return [
    `Files selected: ${plan.selection.files.length}`,
    formatList('Planned evidence files', fileSummaries),
    `Include cross-file findings: ${plan.selection.include_cross_file_findings ? 'yes' : 'no'}`,
    `Include gaps: ${plan.selection.include_gaps ? 'yes' : 'no'}`,
    `Include follow-up queries: ${plan.selection.include_followup_queries ? 'yes' : 'no'}`,
  ].join('\n\n');
}

function parseExpandedSpec(
  raw: string,
  input: {
    user_intent_verbatim: string;
    approved_restated_intent: string;
    included_files: Array<{ path: string; reason: string }>;
  },
): ParsedExpandedSpec {
  const validationWarnings: string[] = [];
  const jsonCandidate = extractJsonObject(raw);

  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      const objective =
        typeof parsed.objective === 'string' && parsed.objective.trim().length > 0
          ? parsed.objective.trim()
          : input.approved_restated_intent;

      if (typeof parsed.objective !== 'string' || parsed.objective.trim().length === 0) {
        validationWarnings.push(
          'Missing or invalid "objective"; defaulted to approved restated intent.',
        );
      }
      if (!Array.isArray(parsed.deliverables)) {
        validationWarnings.push(
          'Missing or invalid "deliverables" array; coerced to [] or fallback value.',
        );
      }
      if (!Array.isArray(parsed.constraints)) {
        validationWarnings.push('Missing or invalid "constraints" array; coerced to [].');
      }
      if (!Array.isArray(parsed.retrieval_focus)) {
        validationWarnings.push('Missing or invalid "retrieval_focus" array; coerced to [].');
      }
      if (!Array.isArray(parsed.open_questions)) {
        validationWarnings.push('Missing or invalid "open_questions" array; coerced to [].');
      }

      return {
        spec: {
          objective,
          deliverables: coerceStringArray(parsed.deliverables),
          constraints: coerceStringArray(parsed.constraints),
          retrieval_focus: coerceStringArray(parsed.retrieval_focus),
          open_questions: coerceStringArray(parsed.open_questions),
        },
        usedFallback: false,
        validationWarnings,
      };
    } catch (error) {
      validationWarnings.push(
        `Model returned malformed JSON for expansion; using fallback parser (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  } else {
    validationWarnings.push(
      'Model did not return a JSON object for expansion; using fallback parser.',
    );
  }

  return {
    spec: fallbackExpandedSpecFromText(raw, input),
    usedFallback: true,
    validationWarnings,
  };
}

function formatList(title: string, items: string[], maxItems = 5): string {
  if (items.length === 0) return `${title}: none`;
  const shown = items.slice(0, maxItems).map((item) => `  - ${item}`);
  const remainder = items.length > maxItems ? [`  ... +${items.length - maxItems} more`] : [];
  return [`${title}:`, ...shown, ...remainder].join('\n');
}

async function restateWithModel(input: RestateInput, ctx: ExtensionContext): Promise<string> {
  const userText = input.contextBlock
    ? `${input.cleanedIntent}\n\n${input.contextBlock}`
    : input.cleanedIntent;
  return getModelText(`${CONDUCTOR_SYSTEM_PREAMBLE}\n\n${RESTATEMENT_INSTRUCTION}`, userText, ctx);
}

/**
 * Model callback injected into the retriever agent loop. The callback lives
 * at the extension edge so `src/retriever/**` never imports pi host APIs.
 */
function makeRetrieverAgentModel(ctx: ExtensionContext): AgentModelCallback {
  return async ({ systemPrompt, userPrompt }) => getModelText(systemPrompt, userPrompt, ctx);
}

type ParsedExpandedSpec = {
  spec: ExpandedSpec;
  usedFallback: boolean;
  validationWarnings: string[];
};

let lastExpansionParseMeta: ParsedExpandedSpec | null = null;

async function expandWithModel(
  input: {
    user_intent_verbatim: string;
    approved_restated_intent: string;
    included_files: Array<{ path: string; reason: string }>;
  },
  ctx: ExtensionContext,
  strictJsonMode = false,
): Promise<ExpandedSpec> {
  const raw = await getModelText(
    `${CONDUCTOR_SYSTEM_PREAMBLE}

Expand an approved engineering intent into a concise structured specification.
Return JSON only with this exact shape:
{
  "objective": string,
  "deliverables": string[],
  "constraints": string[],
  "retrieval_focus": string[],
  "open_questions": string[]
}
Do not wrap the JSON in prose. Keep arrays compact and practical.${strictJsonMode ? '\nThis is a retry because the previous response was malformed. Output a single valid JSON object only. No markdown fences. No commentary. No trailing text.' : ''}`,
    JSON.stringify(input, null, 2),
    ctx,
  );

  const parsed = parseExpandedSpec(raw, input);
  lastExpansionParseMeta = parsed;
  await logEvent('stage2.expansion_parse', {
    raw,
    parsed: parsed.spec,
    usedFallback: parsed.usedFallback,
    validationWarnings: parsed.validationWarnings,
    usedJsonExtraction: extractJsonObject(raw) !== null,
  });
  return parsed.spec;
}

async function requireArtifact<T>(value: Promise<T | null>, label: string): Promise<T> {
  const artifact = await value;
  if (!artifact) {
    throw new Error(`Required artifact missing: ${label}`);
  }
  return artifact;
}

async function getCurrentIntentArtifacts(machine: StageMachine): Promise<{
  capture: IntentCaptureV1;
  restatement: IntentRestatementV1;
}> {
  const captureId = machine.sessionState.artifacts.intent_capture_id;
  const restatementId = machine.sessionState.artifacts.intent_restatement_id;
  if (!captureId || !restatementId) {
    throw new Error('Intent artifacts are incomplete');
  }

  const capture = await requireArtifact(
    runtime.store.get('intent-capture-v1', captureId),
    captureId,
  );
  const restatement = await requireArtifact(
    runtime.store.get('intent-restatement-v1', restatementId),
    restatementId,
  );
  return { capture, restatement };
}

function summarizeExpandedSpec(spec: ExpandedSpec): string {
  return [
    `Objective: ${spec.objective}`,
    formatList('Deliverables', spec.deliverables),
    formatList('Constraints', spec.constraints),
    formatList('Retrieval focus', spec.retrieval_focus),
    formatList('Open questions', spec.open_questions),
  ].join('\n\n');
}

function createDefaultEvidencePlan(index: RetrievalIndexV1) {
  return createEvidencePlan({
    retrieval_index: index,
    file_controls: index.files.map((file) => ({
      file_id: file.file_id,
      include_ast_skeleton: true,
      include_retriever_summary: true,
      include_entire_file: false,
      spans: file.symbols.slice(0, 2).map((symbol) => ({
        symbol_id: symbol.symbol_id,
        include_span: true,
        neighbor_lines: 3,
      })),
    })),
    include_cross_file_findings: true,
    include_gaps: true,
    include_followup_queries: true,
    target_task: {
      type: 'analysis-report',
      task_label: 'analyze codebase or prepare a change plan',
    },
  });
}

function summarizeInspection(
  inspection: NonNullable<Awaited<ReturnType<typeof inspectRetrievalResult>>['inspection']>,
) {
  const selectedFiles = inspection.files.filter((f) => f.selection_tier === 'selected');
  const reserveFiles = inspection.files.filter((f) => f.selection_tier === 'reserve');

  const selectedLines = selectedFiles
    .slice(0, 8)
    .map(
      (file) =>
        `${file.path} [${file.default_evidence_mode}] — ${file.selection_reason || file.why_relevant} (${file.symbol_count} symbols)`,
    );

  const reserveLines = reserveFiles
    .slice(0, 5)
    .map((file) => `${file.path} — ${file.selection_reason || file.why_relevant}`);

  const rec = inspection.recommended_evidence;
  const recommendedSymbolCount = rec.files.reduce(
    (total, file) => total + file.spans.filter((s) => s.include_span).length,
    0,
  );
  const recommendedLines = [
    `Files in default plan: ${rec.files.length}`,
    `Selected symbol spans: ${recommendedSymbolCount}`,
    `Cross-file findings: ${rec.include_cross_file_findings ? 'yes' : 'no'}`,
    `Gaps: ${rec.include_gaps ? 'yes' : 'no'}`,
    `Follow-up queries: ${rec.include_followup_queries ? 'yes' : 'no'}`,
  ];

  return [
    `Query: ${inspection.query}`,
    `Confidence: ${inspection.confidence}`,
    inspection.strategy_summary ? `Strategy: ${inspection.strategy_summary}` : 'Strategy: (none)',
    `Scout terms: ${inspection.scout_terms.length > 0 ? inspection.scout_terms.slice(0, 8).join(', ') : 'none'}`,
    `Files reviewed: ${inspection.file_count} (selected=${inspection.selected_file_count}, reserve=${inspection.reserve_file_count})`,
    formatList('Selected files', selectedLines, 8),
    formatList('Reserve candidates', reserveLines, 5),
    formatList('Recommended default evidence scope', recommendedLines, recommendedLines.length),
    formatList('Cross-file findings', inspection.cross_file_findings),
    formatList('Gaps', inspection.gaps),
    formatList('Follow-up queries', inspection.followup_queries),
  ].join('\n\n');
}

function summarizeAnalysisReport(report: AnalysisReportV1): string {
  return [
    `Summary: ${report.summary}`,
    formatList('Findings', report.findings),
    formatList('Risks', report.risks),
    formatList('Recommended next steps', report.recommended_next_steps),
  ].join('\n\n');
}

function summarizeChangeSpec(spec: ChangeSpecV1): string {
  const editTargets = spec.edits
    .slice(0, 5)
    .map((edit) => `${edit.path} -> ${edit.target.name} (${edit.intent})`);

  return [
    `Summary: ${spec.summary}`,
    `Goal: ${spec.change_goal}`,
    `Edits planned: ${spec.edits.length}`,
    formatList('Top edit targets', editTargets),
    formatList('Acceptance criteria', spec.acceptance_criteria),
    formatList('Tests', spec.tests),
  ].join('\n\n');
}

function inferSynthesisTask(intent: string): SynthesisTaskType {
  const normalized = intent.toLowerCase();
  if (
    normalized.includes('fix') ||
    normalized.includes('implement') ||
    normalized.includes('edit') ||
    normalized.includes('change') ||
    normalized.includes('refactor') ||
    normalized.includes('improve')
  ) {
    return 'change-spec';
  }
  return 'analysis-report';
}

async function runExpansionStage(machine: StageMachine, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const { capture, restatement } = await getCurrentIntentArtifacts(machine);
  let strictJsonRetry = false;
  const expansion = new ExpansionController(
    runtime.store,
    machine,
    runtime.config.repoRoot,
    (input) => expandWithModel(input, ctx, strictJsonRetry),
  );

  await logEvent('stage2.start', { currentStage: machine.currentStage });
  ctx.ui.notify(
    `Stage 2: expansion\n\nRestated intent: ${restatement.restated_intent}\nTagged files: ${capture.tagged_files.length}`,
    'info',
  );

  let projectDocResponse: Record<string, boolean> | undefined;
  const docQuestion = expansion.checkProjectDocInclusion(capture.tagged_files);
  if (docQuestion) {
    const includeDocs = await ctx.ui.confirm(
      'Conductor: include discovered project docs',
      `${docQuestion.question}\n\n${docQuestion.available_docs.map((doc) => `- ${doc.filename}`).join('\n')}`,
    );
    projectDocResponse = Object.fromEntries(
      docQuestion.available_docs.map((doc) => [doc.filename, includeDocs]),
    );
    await logEvent('stage2.project_docs', { includeDocs, docs: docQuestion.available_docs });
  }

  await expansion.createExpansionInput(capture, restatement, projectDocResponse);
  await logEvent('stage2.expansion_input_created', { sessionState: machine.sessionState });

  while (true) {
    const review = await expansion.runExpansion();
    await logEvent('stage2.expansion_generated', {
      expansionInputId: review.expansion_input_id,
      expandedSpec: review.expanded_spec,
      parseMeta: lastExpansionParseMeta,
    });

    const parseWarning = lastExpansionParseMeta
      ? [
          lastExpansionParseMeta.usedFallback
            ? 'Warning: expansion response required fallback recovery instead of valid JSON.'
            : null,
          ...lastExpansionParseMeta.validationWarnings,
        ]
          .filter(Boolean)
          .join('\n')
      : '';

    if (lastExpansionParseMeta?.usedFallback) {
      const retry = await ctx.ui.confirm(
        'Conductor: fallback expansion recovered',
        `${review.review_prompt}\n\n${summarizeExpandedSpec(review.expanded_spec)}\n\n${parseWarning}\n\nWould you like to retry expansion generation with stricter JSON instructions before reviewing this version?`,
      );

      await logEvent('stage2.fallback_retry_decision', {
        retry,
        expansionInputId: review.expansion_input_id,
        warnings: lastExpansionParseMeta.validationWarnings,
      });

      if (retry) {
        strictJsonRetry = true;
        continue;
      }
    }

    strictJsonRetry = false;
    const approved = await ctx.ui.confirm(
      'Conductor: review expanded specification',
      `${review.review_prompt}\n\n${summarizeExpandedSpec(review.expanded_spec)}${parseWarning ? `\n\n${parseWarning}` : ''}`,
    );

    let response: ExpansionReviewResponse;
    if (approved) {
      response = { action: 'approve' };
    } else {
      const revisedIntent = await ctx.ui.input(
        'Conductor: revise or reject expansion',
        'Provide revision text to regenerate the expansion, or leave empty to reject it.',
      );
      response = revisedIntent?.trim()
        ? { action: 'revise', revised_intent: revisedIntent.trim() }
        : { action: 'reject' };
    }

    const result = await expansion.submitReview(review.expanded_spec, response);
    await logEvent('stage2.review_result', {
      response,
      outcome: result.outcome,
      sessionState: machine.sessionState,
    });

    if (result.outcome === 'approved' || result.outcome === 'rejected') {
      break;
    }
  }

  ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
}

async function runRetrievalStage(machine: StageMachine, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  await logEvent('stage3.start', {
    currentStage: machine.currentStage,
    sessionState: machine.sessionState,
  });
  ctx.ui.notify(
    'Stage 3: retrieval\n\nScanning the repository against the approved intent.',
    'info',
  );
  const allowed = await canStartRetrieval(runtime.store, machine);
  if (!allowed.allowed) {
    throw new Error(allowed.reason ?? 'Retrieval is not allowed');
  }

  const captureId = machine.sessionState.artifacts.intent_capture_id;
  const restatementId = machine.sessionState.artifacts.intent_restatement_id;
  if (!captureId || !restatementId) {
    throw new Error('Retrieval requires capture and restatement IDs');
  }

  ctx.ui.notify('Starting retrieval...', 'info');
  const result = await retrievalDispatch(
    {
      intent_capture_id: captureId,
      intent_restatement_id: restatementId,
      intent_spec_id: machine.sessionState.artifacts.intent_spec_id,
    },
    runtime.store,
    runtime.config,
    {
      retrieverAgentModel: makeRetrieverAgentModel(ctx),
    },
  );
  await logEvent('stage3.dispatch_result', result);

  if (result.status !== 'success' || !result.retrieval_index_id) {
    throw new Error(result.message);
  }

  await machine.setArtifact('retrieval_index_id', result.retrieval_index_id);
  await machine.transition('evidence', result.retrieval_index_id);

  const inspection = await inspectRetrievalResult(runtime.store, result.retrieval_index_id);
  await logEvent(
    'stage3.inspection',
    inspection.success ? { inspection: inspection.inspection } : inspection,
  );

  if (!inspection.success || !inspection.inspection) {
    throw new Error(inspection.message ?? 'Failed to inspect retrieval result');
  }

  ctx.ui.notify(`Retrieval complete.\n\n${summarizeInspection(inspection.inspection)}`, 'info');
  ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
}

async function runEvidenceStage(machine: StageMachine, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  await logEvent('stage4.start', {
    currentStage: machine.currentStage,
    sessionState: machine.sessionState,
  });
  const retrievalIndexId = machine.sessionState.artifacts.retrieval_index_id;
  if (!retrievalIndexId) {
    throw new Error('Evidence stage requires retrieval_index_id');
  }

  const index = await requireArtifact(
    runtime.store.get('retrieval-index-v1', retrievalIndexId),
    retrievalIndexId,
  );

  const plan = createDefaultEvidencePlan(index);
  await runtime.store.put(plan);
  await machine.setArtifact('evidence_plan_id', plan.artifact_id);
  await logEvent('stage4.plan_created', { evidencePlanId: plan.artifact_id, plan });
  ctx.ui.notify(`Stage 4: evidence planning\n\n${summarizeEvidencePlan(plan, index)}`, 'info');

  const preview = await evidenceAssemble(
    {
      mode: 'preview',
      retrieval_index_id: retrievalIndexId,
      evidence_plan_id: plan.artifact_id,
    },
    runtime.store,
  );
  await logEvent('stage4.preview', preview);

  if (preview.status !== 'success' || !('estimated_lines' in preview)) {
    throw new Error(preview.message);
  }

  const proceed = await ctx.ui.confirm(
    'Conductor: materialize evidence bundle',
    `${summarizeEvidencePreview(preview)}\n\nProceed?`,
  );
  if (!proceed) {
    throw new Error('Evidence materialization cancelled by user');
  }

  const materialized = await evidenceAssemble(
    {
      mode: 'materialize',
      retrieval_index_id: retrievalIndexId,
      evidence_plan_id: plan.artifact_id,
    },
    runtime.store,
  );
  await logEvent('stage4.materialize', materialized);

  if (
    materialized.status !== 'success' ||
    !('evidence_bundle_id' in materialized) ||
    !materialized.evidence_bundle_id
  ) {
    throw new Error(materialized.message);
  }

  await machine.setArtifact('evidence_bundle_id', materialized.evidence_bundle_id);
  await machine.transition('synthesis', materialized.evidence_bundle_id);
  ctx.ui.notify(`Evidence bundle ready: ${materialized.evidence_bundle_id}`, 'info');
  ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
}

async function runSynthesisStage(
  machine: StageMachine,
  ctx: ExtensionContext,
): Promise<{
  synthesisType: 'analysis-report-v1' | 'change-spec-v1';
  synthesisId: string;
}> {
  if (!ctx.hasUI) {
    throw new Error('Synthesis stage requires UI');
  }

  await logEvent('stage5.start', {
    currentStage: machine.currentStage,
    sessionState: machine.sessionState,
  });
  ctx.ui.notify(
    'Stage 5: synthesis\n\nConverting the evidence bundle into an analysis report or change specification.',
    'info',
  );

  const captureId = machine.sessionState.artifacts.intent_capture_id;
  const restatementId = machine.sessionState.artifacts.intent_restatement_id;
  const evidenceBundleId = machine.sessionState.artifacts.evidence_bundle_id;
  if (!captureId || !restatementId || !evidenceBundleId) {
    throw new Error('Synthesis requires capture, restatement, and evidence bundle IDs');
  }

  const { capture } = await getCurrentIntentArtifacts(machine);
  const inferred = inferSynthesisTask(capture.user_intent_verbatim);
  const wantsChanges = await ctx.ui.confirm(
    'Conductor: synthesis type',
    `Inferred task: ${inferred}.\n\nWould you like a change specification instead of an analysis report?`,
  );
  const taskType: SynthesisTaskType = wantsChanges ? 'change-spec' : 'analysis-report';

  const result = await synthesisDispatch(
    {
      task_type: taskType,
      intent_capture_id: captureId,
      intent_restatement_id: restatementId,
      intent_spec_id: machine.sessionState.artifacts.intent_spec_id,
      evidence_bundle_id: evidenceBundleId,
      instructions:
        taskType === 'change-spec'
          ? 'Produce a concrete change plan grounded in the evidence.'
          : 'Produce an analysis report grounded in the evidence.',
    },
    runtime.store,
  );
  await logEvent('stage5.dispatch_result', { taskType, result });

  if (result.status !== 'success' || !result.synthesis_artifact_id) {
    throw new Error(result.message);
  }

  await machine.setArtifact('synthesis_id', result.synthesis_artifact_id);

  if (taskType === 'change-spec') {
    await machine.transition('execution', result.synthesis_artifact_id);
    const spec = await requireArtifact(
      runtime.store.get('change-spec-v1', result.synthesis_artifact_id),
      result.synthesis_artifact_id,
    );
    ctx.ui.notify(`Synthesis complete.\n\n${summarizeChangeSpec(spec)}`, 'info');
    ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
    return { synthesisType: 'change-spec-v1', synthesisId: spec.artifact_id };
  }

  await machine.transition('idle', result.synthesis_artifact_id);
  const report = await requireArtifact(
    runtime.store.get('analysis-report-v1', result.synthesis_artifact_id),
    result.synthesis_artifact_id,
  );
  ctx.ui.notify(`Synthesis complete.\n\n${summarizeAnalysisReport(report)}`, 'info');
  ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
  return { synthesisType: 'analysis-report-v1', synthesisId: report.artifact_id };
}

async function runExecutionStage(
  machine: StageMachine,
  ctx: ExtensionContext,
  synthesisId: string,
) {
  if (!ctx.hasUI) {
    return;
  }

  await logEvent('stage6.start', {
    currentStage: machine.currentStage,
    synthesisId,
    sessionState: machine.sessionState,
  });
  ctx.ui.notify(
    'Stage 6: execution\n\nA change specification was produced and can now be executed.',
    'info',
  );

  const execute = await ctx.ui.confirm(
    'Conductor: execution',
    'Would you like me to execute the generated change specification?',
  );
  await logEvent('stage6.execute_decision', { execute });

  if (!execute) {
    await machine.transition('idle', synthesisId);
    ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
    return;
  }

  const evidenceBundleId = machine.sessionState.artifacts.evidence_bundle_id;
  if (!evidenceBundleId) {
    throw new Error('Execution requires evidence_bundle_id');
  }

  const result = await executionDispatch(
    {
      change_spec_id: synthesisId,
      evidence_bundle_id: evidenceBundleId,
      execution_constraints: {
        allow_edits: true,
        run_validation: true,
      },
    },
    runtime.store,
  );
  await logEvent('stage6.dispatch_result', result);

  if (result.status !== 'success' || !result.execution_report_id) {
    throw new Error(result.message);
  }

  await machine.setArtifact('execution_report_id', result.execution_report_id);
  await machine.transition('idle', result.execution_report_id);
  ctx.ui.notify(`Execution complete: ${result.execution_report_id}`, 'info');
  ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
}

async function maybeRecursiveRestart(
  machine: StageMachine,
  ctx: ExtensionContext,
  source: { type: 'analysis-report-v1' | 'change-spec-v1'; id: string },
): Promise<PromotionResult | null> {
  if (!ctx.hasUI) {
    return null;
  }

  const restart = await ctx.ui.confirm('Conductor: recursive restart', getPromotionPrompt());
  await logEvent('recursive.decision', { restart, source });
  if (!restart) {
    return null;
  }

  const newIntent = await ctx.ui.input(
    'Conductor: new recursive intent',
    'Enter the follow-up intent to restart the conductor with...',
  );
  if (!newIntent?.trim()) {
    ctx.ui.notify('Recursive restart skipped: no new intent provided.', 'info');
    return null;
  }

  const promoted = await promoteAndRestart(
    {
      source_artifact_type: source.type,
      source_artifact_id: source.id,
      new_user_intent_verbatim: newIntent.trim(),
    },
    runtime.store,
    machine,
  );
  await logEvent('recursive.result', promoted);

  if (promoted.status !== 'success') {
    throw new Error(promoted.message);
  }

  ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
  return promoted;
}

async function runPipelineFromIntent(initialIntent: string, ctx: ExtensionContext): Promise<void> {
  const machine = await getMachine();
  if (!ctx.hasUI) {
    return;
  }

  await logEvent('pipeline.start', { initialIntent, currentStage: machine.currentStage });

  if (machine.currentStage !== 'idle') {
    throw new Error(`Pipeline can only start from idle, got ${machine.currentStage}`);
  }

  const controller = new Stage1Controller(runtime.store, machine, (input) =>
    restateWithModel(input, ctx),
  );

  const restatementContext = await buildRestatementContext(initialIntent, runtime.config.repoRoot);
  await controller.captureIntent(initialIntent, restatementContext.taggedFiles, {
    cleanedIntent: restatementContext.cleanedIntent,
    intentFileRefs: toIntentFileRefs(restatementContext.files),
    restatementContext: restatementContext.contextBlock || undefined,
  });
  await logEvent('stage1.intent_captured', {
    sessionState: machine.sessionState,
    taggedFiles: restatementContext.taggedFiles,
    intentFileRefs: restatementContext.files.map((file) => ({
      path: file.path,
      source: file.source,
      truncated: file.truncated,
    })),
  });

  let restatement = await controller.produceRestatement();
  await logEvent('stage1.restatement_produced', { restatedIntent: restatement.restated_intent });

  while (true) {
    const approved = await ctx.ui.confirm(
      'Conductor: confirm restatement',
      `${restatement.restated_intent}\n\n${restatement.approval_question}`,
    );
    await logEvent('stage1.restatement_decision', {
      approved,
      restatedIntent: restatement.restated_intent,
    });

    if (approved) {
      const result = await controller.submitApproval(restatement.restated_intent, {
        approved: true,
      });
      if (!result.done) {
        throw new Error('Unexpected conductor state: approval loop did not complete');
      }
      break;
    }

    const correction = await ctx.ui.input(
      'Conductor: correct the restatement',
      'Describe what is wrong or provide a corrected intent...',
    );

    if (!correction?.trim()) {
      await logEvent('stage1.cancelled_missing_correction');
      await machine.reset();
      ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
      ctx.ui.notify('Conductor Stage 1 cancelled. No correction was provided.', 'info');
      return;
    }

    const result = await controller.submitApproval(restatement.restated_intent, {
      approved: false,
      correction: correction.trim(),
    });
    await logEvent('stage1.restatement_corrected', {
      correction: correction.trim(),
      sessionState: machine.sessionState,
    });

    if (result.done) {
      break;
    }

    restatement = result.message;
  }

  const expand = await ctx.ui.confirm(
    'Conductor: expansion',
    controller.getExpansionOffer().expansion_offer,
  );
  await logEvent('stage1.expansion_decision', { expand });

  await controller.finalize(restatement.restated_intent, { expand });
  await logEvent('stage1.finalized', { expand, sessionState: machine.sessionState });
  ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);

  if (expand) {
    await runExpansionStage(machine, ctx);
  }

  await runRetrievalStage(machine, ctx);
  await runEvidenceStage(machine, ctx);

  const synthesis = await runSynthesisStage(machine, ctx);

  if (synthesis.synthesisType === 'change-spec-v1') {
    await runExecutionStage(machine, ctx, synthesis.synthesisId);
  }

  const promoted = await maybeRecursiveRestart(machine, ctx, {
    type: synthesis.synthesisType,
    id: synthesis.synthesisId,
  });

  if (promoted) {
    const recursiveIntent = await requireArtifact(
      runtime.store.get('recursive-intent-v1', promoted.recursive_intent_id!),
      promoted.recursive_intent_id!,
    );
    ctx.ui.notify('Recursive restart created. Starting next cycle...', 'info');
    await runPipelineFromIntent(recursiveIntent.new_user_intent_verbatim, ctx);
    return;
  }

  await logEvent('pipeline.complete', {
    finalStage: machine.currentStage,
    sessionState: machine.sessionState,
  });
  ctx.ui.notify(`pi-orchestra pipeline complete at stage=${machine.currentStage}`, 'info');
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    try {
      const machine = await getMachine();
      await logEvent('session_start', {
        reason: event.reason,
        repoRoot: runtime.config.repoRoot,
        currentStage: machine.currentStage,
      });
      if (ctx.hasUI) {
        ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
        ctx.ui.notify(
          `pi-orchestra loaded (${event.reason}) from ${runtime.config.repoRoot}`,
          'info',
        );
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.setStatus('orchestra', 'boot-error');
        ctx.ui.notify(
          `pi-orchestra failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    }
  });

  pi.registerCommand('orchestra-status', {
    description: 'Show pi-orchestra runtime and stage status',
    handler: async (_args, ctx) => {
      try {
        const machine = await getMachine();
        const lines = [
          'pi-orchestra status',
          `repoRoot: ${runtime.config.repoRoot}`,
          `piDir: ${runtime.config.piDir}`,
          `bootedAt: ${runtime.bootedAt}`,
          `currentStage: ${machine.currentStage}`,
          `sessionStatePath: ${runtime.config.sessionStatePath}`,
          `logPath: ${runtime.logPath}`,
        ];
        ctx.ui.notify(lines.join('\n'), 'info');
      } catch (error) {
        ctx.ui.notify(
          `pi-orchestra status unavailable: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('orchestra-log', {
    description: 'Show pi-orchestra log path',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pi-orchestra log: ${runtime.logPath}`, 'info');
    },
  });

  pi.registerCommand('orchestra-reset', {
    description: 'Reset pi-orchestra session state back to idle',
    handler: async (_args, ctx) => {
      const machine = await getMachine();
      await machine.reset();
      if (ctx.hasUI) {
        ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
      }
      ctx.ui.notify('pi-orchestra session state reset to idle', 'info');
    },
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') {
      return { action: 'continue' };
    }

    const text = event.text.trim();
    if (!text || text.startsWith('/')) {
      return { action: 'continue' };
    }

    try {
      const machine = await getMachine();
      await logEvent('input.received', {
        source: event.source,
        text,
        currentStage: machine.currentStage,
      });

      if (machine.currentStage !== 'idle') {
        await logEvent('input.passthrough', {
          reason: 'non-idle-stage',
          currentStage: machine.currentStage,
        });
        return { action: 'continue' };
      }

      await runPipelineFromIntent(text, ctx);
      return { action: 'handled' };
    } catch (error) {
      await logEvent('pipeline.error', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-orchestra input interception failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
      return { action: 'continue' };
    }
  });
}
