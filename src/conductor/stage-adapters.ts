/**
 * Stage adapters — typed `Stage<>` wrappers over the existing conductor
 * controllers and dispatch services.
 *
 * Per `docs/composability.md` "Phase 1 — Scaffolding":
 *
 *   - Each conductor controller (`stage-1`, `expansion`, `retrieval`,
 *     `synthesis`, `recursive-intent`) is re-expressed as a `Stage`
 *     adapter that registers against the stage id declared in the default
 *     workflow spec (`src/runtime/workflows/piorx-default.workflow.md`).
 *   - Service dispatchers (`src/services/*-dispatch.ts`) stay as the
 *     implementation backing `run()`; their typed boundaries do not change.
 *   - Adapters carry the stage's full UI-driven flow when the executor
 *     drives them (COMP-P1-T11). The "fat adapter" shape — capture +
 *     model call + approval/correction loop + finalize — preserves the
 *     existing controller contracts behind `runDefaultPipeline`'s thin
 *     executor invocation, so the host (`extensions/conductor-extension.ts`)
 *     no longer encodes the six-stage sequence inline.
 *
 * Adapters cast the executor's `StageContext` to `StageAdapterContext` to
 * read the optional UI / model-callback / runtime-config services they
 * need. Adapters that don't need a service simply ignore it.
 */

import { generateArtifactId } from '../artifacts/ids.ts';
import type {
  ChangeSpecV1,
  ExecutionReportV1,
  ExpandedSpec,
  ExpansionIncludedFile,
  ExpansionInputV1,
  IntentCaptureV1,
  IntentFileRef,
  IntentRestatementV1,
  IntentSpecV1,
  RetrievalIndexV1,
} from '../artifacts/types.ts';
import type { Stage, StageContext, StageResult } from '../runtime/stage.ts';
import { WorkflowRegistry } from '../runtime/registry.ts';
import { evidenceAssemble } from '../services/evidence-assembler.ts';
import { executionDispatch } from '../services/execution-dispatch.ts';
import { retrievalDispatch } from '../services/retrieval-dispatch.ts';
import { synthesisDispatch, type SynthesisTaskType } from '../services/synthesis-dispatch.ts';
import { selectTaskType } from './synthesis.ts';
import {
  applyEvidenceOverrides,
  deriveEffectiveFileMode,
  type EvidenceOverride,
} from './evidence-overrides.ts';
import { createRecommendedEvidencePlan } from './evidence-plan.ts';
import { discoverProjectDocs } from '../util/project-docs.ts';
import {
  EXPANSION_REVIEW_PROMPT,
  PROJECT_DOC_INCLUSION_QUESTION,
  RESTATEMENT_APPROVAL_QUESTION,
} from './prompts.ts';
import type { PiOrchestraConfig } from '../runtime/config.ts';
import type { AgentModelCallback } from '../retriever/agent-types.ts';

// ---------------------------------------------------------------------------
// Public types — UI services and per-stage callbacks the host injects
// ---------------------------------------------------------------------------

/**
 * Slim UI surface adapters use to drive prompts. The host's pi
 * `ExtensionContext.ui` adapts to this shape; tests can inject a stub.
 */
export interface PipelineUI {
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  setStatus(key: string, text: string | undefined): void;
}

/** Async log sink keyed by message + free-form details. */
export type PipelineLogger = (message: string, details?: unknown) => Promise<void> | void;

/** Restatement model callback shape — matches `src/conductor/stage-1.ts`. */
export type AdapterRestate = (input: {
  cleanedIntent: string;
  contextBlock?: string;
}) => Promise<string>;

/** Expansion model callback shape — matches `src/conductor/expansion.ts`. */
export type AdapterExpand = (
  input: ExpansionInputV1,
  options?: { strictJsonRetry?: boolean },
) => Promise<{ spec: ExpandedSpec; usedFallback: boolean; validationWarnings: string[] }>;

/**
 * Pre-stage capture metadata the restatement adapter needs to write the
 * `intent-capture@1` artifact (verbatim text, cleaned intent, file refs,
 * restatement context block). Built by the host before invoking the
 * executor — matches the existing `buildRestatementContext` output shape.
 */
export interface AdapterIntentMetadata {
  initialIntent: string;
  cleanedIntent: string;
  taggedFiles: string[];
  intentFileRefs: IntentFileRef[];
  restatementContextBlock?: string;
}

// ---------------------------------------------------------------------------
// Adapter context
// ---------------------------------------------------------------------------

/**
 * Optional services the executor's `contextExtras` injects into every
 * `StageContext`. Adapters that need a service cast `ctx` to
 * `StageAdapterContext`; adapters that don't need a service simply ignore
 * the field.
 */
export interface StageAdapterServices {
  readonly runtimeConfig?: PiOrchestraConfig;
  readonly retrieverAgentModel?: AgentModelCallback;
  /** Forced synthesis task type (override the heuristic). */
  readonly synthesisTaskType?: SynthesisTaskType;
  /** Latched `execution.allow_edits` decision from the host. */
  readonly allowEdits?: boolean;
  readonly ui?: PipelineUI;
  readonly logEvent?: PipelineLogger;
  readonly restate?: AdapterRestate;
  readonly expand?: AdapterExpand;
  readonly intentMetadata?: AdapterIntentMetadata;
}

export interface StageAdapterContext extends StageContext, StageAdapterServices {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireArtifactId(id: string | null, label: string): string {
  if (!id) {
    throw new Error(`stage adapter: ${label} required but absent from session state`);
  }
  return id;
}

async function logIfPresent(
  services: StageAdapterServices,
  message: string,
  details?: unknown,
): Promise<void> {
  if (services.logEvent) await services.logEvent(message, details);
}

function requireUI(services: StageAdapterServices): PipelineUI {
  if (!services.ui) {
    throw new Error('stage adapter: PipelineUI is required for the default piorx pipeline');
  }
  return services.ui;
}

function requireRestate(services: StageAdapterServices): AdapterRestate {
  if (!services.restate) {
    throw new Error('stage adapter: AdapterRestate callback is required for restatement');
  }
  return services.restate;
}

function requireExpand(services: StageAdapterServices): AdapterExpand {
  if (!services.expand) {
    throw new Error('stage adapter: AdapterExpand callback is required for expansion');
  }
  return services.expand;
}

function requireIntentMetadata(services: StageAdapterServices): AdapterIntentMetadata {
  if (!services.intentMetadata) {
    throw new Error(
      'stage adapter: AdapterIntentMetadata is required for the restatement stage; ' +
        'the host must build it before executor.run',
    );
  }
  return services.intentMetadata;
}

function formatList(title: string, items: string[], maxItems = 5): string {
  if (items.length === 0) return `${title}: none`;
  const shown = items.slice(0, maxItems).map((item) => `  - ${item}`);
  const remainder = items.length > maxItems ? [`  ... +${items.length - maxItems} more`] : [];
  return [`${title}:`, ...shown, ...remainder].join('\n');
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

// ---------------------------------------------------------------------------
// Stage 1 — restatement
// ---------------------------------------------------------------------------

export const restatementStage: Stage<'piorx/intent-capture@1', 'piorx/intent-restatement@1'> = {
  id: 'restatement',
  inputs: ['piorx/intent-capture@1'],
  output: 'piorx/intent-restatement@1',
  control: {
    entry_criteria: 'A piorx/intent-capture@1 artifact has been written for the current session.',
    exit_criteria: 'A piorx/intent-restatement@1 with approved=true is persisted.',
    acceptance_criteria: 'The user has explicitly approved the canonical restatement.',
    failure_handling: 'halt',
    evidence_requirements: ['approval-disposition'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    const ui = requireUI(services);
    const restate = requireRestate(services);
    const meta = requireIntentMetadata(services);

    // Capture intent into the artifact store and update the session pointer.
    let capture = await persistIntentCapture(ctx, {
      verbatim: meta.initialIntent,
      cleanedIntent: meta.cleanedIntent,
      taggedFiles: meta.taggedFiles,
      intentFileRefs: meta.intentFileRefs,
    });
    await logIfPresent(services, 'stage1.intent_captured', {
      sessionState: ctx.session,
      taggedFiles: meta.taggedFiles,
    });

    let restated = (
      await restate({
        cleanedIntent: capture.cleaned_user_intent,
        contextBlock: meta.restatementContextBlock,
      })
    ).trim();
    let approvalTurns = 1;

    while (true) {
      const approved = await ui.confirm(
        'Conductor: confirm restatement',
        `${restated}\n\n${RESTATEMENT_APPROVAL_QUESTION}`,
      );
      await logIfPresent(services, 'stage1.restatement_decision', {
        approved,
        restatedIntent: restated,
      });
      if (approved) break;

      const correction = await ui.input(
        'Conductor: correct the restatement',
        'Describe what is wrong or provide a corrected intent...',
      );
      if (!correction?.trim()) {
        throw new Error('Conductor Stage 1 cancelled. No correction was provided.');
      }
      capture = await persistIntentCapture(ctx, {
        verbatim: correction.trim(),
        cleanedIntent: correction.trim(),
        taggedFiles: capture.tagged_files,
        intentFileRefs: capture.intent_file_refs ?? [],
      });
      await logIfPresent(services, 'stage1.restatement_corrected', {
        correction: correction.trim(),
        sessionState: ctx.session,
      });
      approvalTurns++;
      restated = (
        await restate({
          cleanedIntent: capture.cleaned_user_intent,
          contextBlock: meta.restatementContextBlock,
        })
      ).trim();
    }

    const expand = await ui.confirm(
      'Conductor: expansion',
      'Should I expand the restated intent into a structured specification before retrieving evidence?',
    );
    await logIfPresent(services, 'stage1.expansion_decision', { expand });

    const restatementId = generateArtifactId('piorx/intent-restatement@1');
    const restatement: IntentRestatementV1 = {
      artifact_type: 'piorx/intent-restatement@1',
      artifact_id: restatementId,
      intent_capture_id: capture.artifact_id,
      user_intent_verbatim: capture.user_intent_verbatim,
      restated_intent: restated,
      approved: true,
      expand_requested: expand,
      approval_turns: approvalTurns,
    };
    await ctx.store.put(restatement);
    await logIfPresent(services, 'stage1.finalized', { expand, restatementId });
    return { output_artifact_id: restatementId };
  },
};

async function persistIntentCapture(
  ctx: StageContext,
  input: {
    verbatim: string;
    cleanedIntent: string;
    taggedFiles: string[];
    intentFileRefs: IntentFileRef[];
  },
): Promise<IntentCaptureV1> {
  const id = generateArtifactId('piorx/intent-capture@1');
  const capture: IntentCaptureV1 = {
    artifact_type: 'piorx/intent-capture@1',
    artifact_id: id,
    user_intent_verbatim: input.verbatim,
    cleaned_user_intent: input.cleanedIntent,
    tagged_files: input.taggedFiles,
    ...(input.intentFileRefs.length > 0 ? { intent_file_refs: input.intentFileRefs } : {}),
    timestamp: new Date().toISOString(),
  };
  await ctx.store.put(capture);
  ctx.setArtifactPointer?.('intent_capture_id', id);
  return capture;
}

// ---------------------------------------------------------------------------
// Stage 2 — expansion
// ---------------------------------------------------------------------------

export const expansionStage: Stage<'piorx/intent-restatement@1', 'piorx/intent-spec@1'> = {
  id: 'expansion',
  inputs: ['piorx/intent-restatement@1'],
  output: 'piorx/intent-spec@1',
  control: {
    entry_criteria: 'An approved piorx/intent-restatement@1 exists with expand_requested=true.',
    exit_criteria: 'A piorx/intent-spec@1 with approved=true is persisted.',
    acceptance_criteria: 'The user approved the expanded spec via the expansion.review gate.',
    failure_handling: 'halt',
    evidence_requirements: ['approval-disposition'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    const ui = requireUI(services);
    const expand = requireExpand(services);
    const repoRoot = services.runtimeConfig?.repoRoot;
    if (!repoRoot) {
      throw new Error('expansion stage: runtimeConfig.repoRoot is required');
    }

    const captureId = requireArtifactId(
      ctx.session.artifacts.intent_capture_id,
      'intent_capture_id',
    );
    const restatementId = requireArtifactId(
      ctx.session.artifacts.intent_restatement_id,
      'intent_restatement_id',
    );
    const capture = await ctx.store.get('piorx/intent-capture@1', captureId);
    if (!capture) {
      throw new Error(`expansion stage: intent-capture "${captureId}" not found`);
    }
    const restatement = await ctx.store.get('piorx/intent-restatement@1', restatementId);
    if (!restatement) {
      throw new Error(`expansion stage: intent-restatement "${restatementId}" not found`);
    }

    await logIfPresent(services, 'stage2.start', { sessionState: ctx.session });
    ui.notify(
      `Stage 2: expansion\n\nRestated intent: ${restatement.restated_intent}\nTagged files: ${capture.tagged_files.length}`,
      'info',
    );

    let projectDocResponse: Record<string, boolean> | undefined;
    if (capture.tagged_files.length === 0) {
      const docs = discoverProjectDocs(repoRoot);
      if (docs.length > 0) {
        const includeDocs = await ui.confirm(
          'Conductor: include discovered project docs',
          `${PROJECT_DOC_INCLUSION_QUESTION}\n\n${docs.map((doc) => `- ${doc.filename}`).join('\n')}`,
        );
        projectDocResponse = Object.fromEntries(docs.map((doc) => [doc.filename, includeDocs]));
        await logIfPresent(services, 'stage2.project_docs', { includeDocs, docs });
      }
    }

    let expansionInput = await persistExpansionInput(ctx, {
      capture,
      restatement,
      repoRoot,
      projectDocResponse,
    });
    await logIfPresent(services, 'stage2.expansion_input_created', {
      sessionState: ctx.session,
      expansionInputId: expansionInput.artifact_id,
    });

    let strictJsonRetry = false;
    while (true) {
      const expansion = await expand(expansionInput, { strictJsonRetry });
      await logIfPresent(services, 'stage2.expansion_generated', {
        expansionInputId: expansionInput.artifact_id,
        expandedSpec: expansion.spec,
        usedFallback: expansion.usedFallback,
        validationWarnings: expansion.validationWarnings,
      });

      const parseWarning = [
        expansion.usedFallback
          ? 'Warning: expansion response required fallback recovery instead of valid JSON.'
          : null,
        ...expansion.validationWarnings,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');

      if (expansion.usedFallback) {
        const retry = await ui.confirm(
          'Conductor: fallback expansion recovered',
          `${EXPANSION_REVIEW_PROMPT}\n\n${summarizeExpandedSpec(expansion.spec)}\n\n${parseWarning}\n\nWould you like to retry expansion generation with stricter JSON instructions before reviewing this version?`,
        );
        await logIfPresent(services, 'stage2.fallback_retry_decision', {
          retry,
          expansionInputId: expansionInput.artifact_id,
          warnings: expansion.validationWarnings,
        });
        if (retry) {
          strictJsonRetry = true;
          continue;
        }
      }
      strictJsonRetry = false;

      const approved = await ui.confirm(
        'Conductor: review expanded specification',
        `${EXPANSION_REVIEW_PROMPT}\n\n${summarizeExpandedSpec(expansion.spec)}${parseWarning ? `\n\n${parseWarning}` : ''}`,
      );

      if (approved) {
        const intentSpec = await persistIntentSpec(ctx, expansionInput, expansion.spec);
        await logIfPresent(services, 'stage2.review_result', {
          response: { action: 'approve' },
          outcome: 'approved',
          sessionState: ctx.session,
        });
        return { output_artifact_id: intentSpec.artifact_id };
      }

      const revisedIntent = await ui.input(
        'Conductor: revise or reject expansion',
        'Provide revision text to regenerate the expansion, or leave empty to reject it.',
      );
      const trimmedRevision = revisedIntent?.trim() ?? '';

      if (trimmedRevision) {
        expansionInput = await persistExpansionInput(ctx, {
          capture,
          restatement,
          repoRoot,
          projectDocResponse,
          revisedIntentVerbatim: trimmedRevision,
          carryIncludedFiles: expansionInput.included_files,
        });
        await logIfPresent(services, 'stage2.review_result', {
          response: { action: 'revise', revised_intent: trimmedRevision },
          outcome: 'revised',
          sessionState: ctx.session,
        });
        continue;
      }

      // Reject — produce a minimal intent-spec so the executor can route to
      // retrieval. The expanded spec body is preserved on the artifact, but
      // `approved=false` records the user's explicit rejection.
      const intentSpec = await persistIntentSpec(ctx, expansionInput, expansion.spec, false);
      await logIfPresent(services, 'stage2.review_result', {
        response: { action: 'reject' },
        outcome: 'rejected',
        sessionState: ctx.session,
      });
      return { output_artifact_id: intentSpec.artifact_id };
    }
  },
};

async function persistExpansionInput(
  ctx: StageContext,
  args: {
    capture: IntentCaptureV1;
    restatement: IntentRestatementV1;
    repoRoot: string;
    projectDocResponse?: Record<string, boolean>;
    revisedIntentVerbatim?: string;
    carryIncludedFiles?: ExpansionIncludedFile[];
  },
): Promise<ExpansionInputV1> {
  const includedFiles: ExpansionIncludedFile[] = args.carryIncludedFiles
    ? [...args.carryIncludedFiles]
    : [];
  if (!args.carryIncludedFiles) {
    for (const path of args.capture.tagged_files) {
      includedFiles.push({ path, reason: 'user-tagged' });
    }
    if (args.capture.tagged_files.length === 0 && args.projectDocResponse) {
      const docs = discoverProjectDocs(args.repoRoot);
      for (const doc of docs) {
        if (args.projectDocResponse[doc.filename]) {
          includedFiles.push({ path: doc.path, reason: 'project-doc-included' });
        }
      }
    }
  }
  const id = generateArtifactId('piorx/expansion-input@1');
  const input: ExpansionInputV1 = {
    artifact_type: 'piorx/expansion-input@1',
    artifact_id: id,
    intent_capture_id: args.capture.artifact_id,
    intent_restatement_id: args.restatement.artifact_id,
    user_intent_verbatim: args.revisedIntentVerbatim ?? args.capture.cleaned_user_intent,
    approved_restated_intent: args.restatement.restated_intent,
    included_files: includedFiles,
  };
  await ctx.store.put(input);
  ctx.setArtifactPointer?.('expansion_input_id', id);
  return input;
}

async function persistIntentSpec(
  ctx: StageContext,
  expansionInput: ExpansionInputV1,
  spec: ExpandedSpec,
  approved = true,
): Promise<IntentSpecV1> {
  const id = generateArtifactId('piorx/intent-spec@1');
  const intentSpec: IntentSpecV1 = {
    artifact_type: 'piorx/intent-spec@1',
    artifact_id: id,
    expansion_input_id: expansionInput.artifact_id,
    user_intent_verbatim: expansionInput.user_intent_verbatim,
    approved_restated_intent: expansionInput.approved_restated_intent,
    expanded_spec: spec,
    approved,
  };
  await ctx.store.put(intentSpec);
  ctx.setArtifactPointer?.('intent_spec_id', id);
  return intentSpec;
}

// ---------------------------------------------------------------------------
// Stage 3 — retrieval
// ---------------------------------------------------------------------------

export const retrievalStage: Stage<'piorx/intent-restatement@1', 'piorx/retrieval-index@1'> = {
  id: 'retrieval',
  inputs: ['piorx/intent-restatement@1'],
  output: 'piorx/retrieval-index@1',
  control: {
    entry_criteria:
      'An approved piorx/intent-restatement@1 (and optionally an approved piorx/intent-spec@1) is available.',
    exit_criteria: 'A piorx/retrieval-index@1 with at least one selected file is persisted.',
    failure_handling: 'halt',
    evidence_requirements: ['source-access-events'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    if (!services.runtimeConfig) {
      throw new Error('retrieval stage: runtimeConfig is required to dispatch retrieval');
    }
    const ui = services.ui;
    const captureId = requireArtifactId(
      ctx.session.artifacts.intent_capture_id,
      'intent_capture_id',
    );
    const restatementId = requireArtifactId(
      ctx.session.artifacts.intent_restatement_id,
      'intent_restatement_id',
    );

    await logIfPresent(services, 'stage3.start', { sessionState: ctx.session });
    ui?.notify(
      'Stage 3: retrieval\n\nScanning the repository against the approved intent.',
      'info',
    );

    const result = await retrievalDispatch(
      {
        intent_capture_id: captureId,
        intent_restatement_id: restatementId,
        intent_spec_id: ctx.session.artifacts.intent_spec_id,
      },
      ctx.store,
      services.runtimeConfig,
      services.retrieverAgentModel ? { retrieverAgentModel: services.retrieverAgentModel } : {},
    );
    await logIfPresent(services, 'stage3.dispatch_result', result);
    if (result.status !== 'success' || !result.retrieval_index_id) {
      throw new Error(`retrieval stage: dispatch failed — ${result.message}`);
    }

    if (ui) {
      ui.notify(`Retrieval complete: ${result.retrieval_index_id}`, 'info');
    }
    return { output_artifact_id: result.retrieval_index_id };
  },
};

// ---------------------------------------------------------------------------
// Stage 4 — evidence
// ---------------------------------------------------------------------------

const EVIDENCE_OVERRIDE_HELP = [
  'Provide a JSON array of narrow override operations, or leave empty to keep retriever defaults.',
  'Supported ops:',
  '  { "op": "promote_file", "file_id": "...", "mode"?: "summary"|"summary+ast"|"spans"|"whole_file" }',
  '  { "op": "demote_file", "file_id": "..." }',
  '  { "op": "set_file_mode", "file_id": "...", "mode": "summary"|"summary+ast"|"spans"|"whole_file"|"exclude" }',
  '  { "op": "include_symbol", "file_id": "...", "symbol_id": "...", "neighbor_lines"?: 0 }',
  '  { "op": "exclude_symbol", "file_id": "...", "symbol_id": "..." }',
  '  { "op": "set_neighbor_lines", "file_id": "...", "symbol_id": "...", "neighbor_lines": 3 }',
  '  { "op": "toggle_cross_file_findings"|"toggle_gaps"|"toggle_followup_queries", "value": true|false }',
].join('\n');

const VALID_EVIDENCE_OVERRIDE_OPS = new Set([
  'promote_file',
  'demote_file',
  'set_file_mode',
  'include_symbol',
  'exclude_symbol',
  'set_neighbor_lines',
  'toggle_cross_file_findings',
  'toggle_gaps',
  'toggle_followup_queries',
]);

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function parseEvidenceOverridesInput(raw: string): EvidenceOverride[] {
  const stripped = stripCodeFence(raw).trim();
  if (!stripped) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new Error(
      `Override input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Override input must be a JSON array of operations');
  }
  return parsed.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Override #${idx}: must be an object`);
    }
    const op = (entry as { op?: unknown }).op;
    if (typeof op !== 'string' || !VALID_EVIDENCE_OVERRIDE_OPS.has(op)) {
      throw new Error(`Override #${idx}: unknown op "${String(op)}"`);
    }
    return entry as EvidenceOverride;
  });
}

function summarizeEvidencePlan(
  plan: ReturnType<typeof createRecommendedEvidencePlan>,
  index: RetrievalIndexV1,
): string {
  const reserveFiles = index.files.filter((f) => f.selection_tier === 'reserve');
  const planFileIds = new Set(plan.selection.files.map((f) => f.file_id));
  const fileSummaries = plan.selection.files.slice(0, 8).map((file) => {
    const match = index.files.find((candidate) => candidate.file_id === file.file_id);
    const effectiveMode = deriveEffectiveFileMode(file);
    const retrievalMode = match?.default_evidence_mode;
    const modeLabel =
      retrievalMode && retrievalMode !== effectiveMode
        ? `${effectiveMode} (retriever default: ${retrievalMode})`
        : effectiveMode;
    const includedSpans = file.spans.filter((s) => s.include_span).length;
    const flags = [
      file.include_entire_file ? 'whole' : null,
      file.include_ast_skeleton ? 'ast' : null,
      file.include_retriever_summary ? 'summary' : null,
      includedSpans > 0 ? `spans=${includedSpans}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return `${match?.path ?? file.file_id} [${modeLabel}] — ${flags || 'exclude'}`;
  });

  const reserveLines = reserveFiles
    .filter((f) => !planFileIds.has(f.file_id))
    .slice(0, 5)
    .map((f) => `${f.path} (${f.file_id}) — ${f.selection_reason || f.why_relevant}`);

  return [
    `Retriever-authored default plan (narrowed from ${index.files.length} retrieved, ${reserveFiles.length} held as reserve)`,
    `Files in plan: ${plan.selection.files.length}`,
    formatList('Selected files (in default plan)', fileSummaries, 8),
    formatList('Reserve candidates (not in default plan)', reserveLines, 5),
    `Include cross-file findings: ${plan.selection.include_cross_file_findings ? 'yes' : 'no'}`,
    `Include gaps: ${plan.selection.include_gaps ? 'yes' : 'no'}`,
    `Include follow-up queries: ${plan.selection.include_followup_queries ? 'yes' : 'no'}`,
  ].join('\n\n');
}

function summarizeEvidencePreview(preview: {
  estimated_lines: number | null;
  estimated_tokens: number | null;
  message: string;
}): string {
  return [
    'Evidence preview',
    `Estimated lines: ${preview.estimated_lines ?? 'unknown'}`,
    `Estimated tokens: ${preview.estimated_tokens ?? 'unknown'}`,
    `Assembler note: ${preview.message}`,
  ].join('\n');
}

export const evidenceStage: Stage<'piorx/retrieval-index@1', 'piorx/evidence-bundle@1'> = {
  id: 'evidence',
  inputs: ['piorx/retrieval-index@1'],
  output: 'piorx/evidence-bundle@1',
  control: {
    entry_criteria: 'A piorx/retrieval-index@1 is available with at least one selected file.',
    exit_criteria: 'A piorx/evidence-bundle@1 validates structurally and is persisted.',
    acceptance_criteria:
      "The bundle's stats fit within the evidence-plan's max_total_lines and max_estimated_tokens budgets.",
    failure_handling: 'halt',
    evidence_requirements: ['override-history'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    const ui = requireUI(services);

    const retrievalIndexId = requireArtifactId(
      ctx.session.artifacts.retrieval_index_id,
      'retrieval_index_id',
    );
    const index = await ctx.store.get('piorx/retrieval-index@1', retrievalIndexId);
    if (!index) {
      throw new Error(`evidence stage: retrieval-index "${retrievalIndexId}" not found`);
    }

    await logIfPresent(services, 'stage4.start', { sessionState: ctx.session });

    let plan = createRecommendedEvidencePlan(index);
    await ctx.store.put(plan);
    ctx.setArtifactPointer?.('evidence_plan_id', plan.artifact_id);
    await logIfPresent(services, 'stage4.plan_created', {
      evidencePlanId: plan.artifact_id,
      plan,
    });
    ui.notify(`Stage 4: evidence planning\n\n${summarizeEvidencePlan(plan, index)}`, 'info');

    const wantsOverrides = await ui.confirm(
      'Conductor: apply narrow evidence overrides?',
      'The retriever-authored default plan is shown above. Apply narrow overrides (promote reserve files, include/exclude symbols, tune neighbor lines) before previewing?',
    );
    await logIfPresent(services, 'stage4.override_decision', { wantsOverrides });

    if (wantsOverrides) {
      const rawInput = await ui.input('Conductor: evidence overrides', EVIDENCE_OVERRIDE_HELP);
      const text = rawInput?.trim() ?? '';
      if (text) {
        try {
          const overrides = parseEvidenceOverridesInput(text);
          if (overrides.length > 0) {
            const result = applyEvidenceOverrides({
              plan,
              retrieval_index: index,
              overrides,
            });
            await ctx.store.put(result.plan);
            ctx.setArtifactPointer?.('evidence_plan_id', result.plan.artifact_id);
            plan = result.plan;
            await logIfPresent(services, 'stage4.overrides_applied', {
              evidencePlanId: plan.artifact_id,
              applied: result.applied,
              overrideCount: overrides.length,
            });
            ui.notify(
              `Overrides applied (${result.applied.length}):\n${result.applied.map((line) => `  - ${line}`).join('\n')}\n\nAdjusted plan:\n\n${summarizeEvidencePlan(plan, index)}`,
              'info',
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await logIfPresent(services, 'stage4.override_error', { message });
          ui.notify(
            `Overrides rejected — keeping retriever defaults.\nReason: ${message}`,
            'warning',
          );
        }
      }
    }

    const preview = await evidenceAssemble(
      {
        mode: 'preview',
        retrieval_index_id: retrievalIndexId,
        evidence_plan_id: plan.artifact_id,
      },
      ctx.store,
    );
    await logIfPresent(services, 'stage4.preview', preview);
    if (preview.status !== 'success' || !('estimated_lines' in preview)) {
      throw new Error(preview.message);
    }

    const proceed = await ui.confirm(
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
      ctx.store,
    );
    await logIfPresent(services, 'stage4.materialize', materialized);
    if (
      materialized.status !== 'success' ||
      !('evidence_bundle_id' in materialized) ||
      !materialized.evidence_bundle_id
    ) {
      throw new Error(materialized.message);
    }

    ui.notify(`Evidence bundle ready: ${materialized.evidence_bundle_id}`, 'info');
    return {
      output_artifact_id: materialized.evidence_bundle_id,
      additional_artifact_ids: [plan.artifact_id],
    };
  },
};

// ---------------------------------------------------------------------------
// Stage 5 — synthesis
// ---------------------------------------------------------------------------

export const synthesisStage: Stage<
  'piorx/evidence-bundle@1' | 'piorx/intent-restatement@1',
  'piorx/analysis-report@1 | piorx/change-spec@1'
> = {
  id: 'synthesis',
  inputs: ['piorx/evidence-bundle@1', 'piorx/intent-restatement@1'],
  output: 'piorx/analysis-report@1 | piorx/change-spec@1',
  control: {
    entry_criteria:
      'A piorx/evidence-bundle@1 is available alongside the approved intent restatement.',
    exit_criteria:
      'A piorx/analysis-report@1 or piorx/change-spec@1 validates structurally and is persisted.',
    acceptance_criteria:
      'Output validates structurally AND contains at least one actionable element (a finding for analysis-report, an edit for change-spec).',
    failure_handling: 'tentative',
    evidence_requirements: ['advisor-consultations'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    const ui = requireUI(services);

    const captureId = requireArtifactId(
      ctx.session.artifacts.intent_capture_id,
      'intent_capture_id',
    );
    const restatementId = requireArtifactId(
      ctx.session.artifacts.intent_restatement_id,
      'intent_restatement_id',
    );
    const evidenceBundleId = requireArtifactId(
      ctx.session.artifacts.evidence_bundle_id,
      'evidence_bundle_id',
    );

    await logIfPresent(services, 'stage5.start', { sessionState: ctx.session });
    ui.notify(
      'Stage 5: synthesis\n\nConverting the evidence bundle into an analysis report or change specification.',
      'info',
    );

    let taskType = services.synthesisTaskType;
    if (!taskType) {
      const capture = await ctx.store.get('piorx/intent-capture@1', captureId);
      if (!capture) {
        throw new Error(`synthesis stage: intent-capture "${captureId}" not found`);
      }
      const inferred = inferSynthesisTaskFromIntent(capture.user_intent_verbatim);
      const wantsChanges = await ui.confirm(
        'Conductor: synthesis type',
        `Inferred task: ${inferred}.\n\nWould you like a change specification instead of an analysis report?`,
      );
      taskType = wantsChanges ? 'change-spec' : 'analysis-report';
    }

    const result = await synthesisDispatch(
      {
        task_type: taskType,
        intent_capture_id: captureId,
        intent_restatement_id: restatementId,
        intent_spec_id: ctx.session.artifacts.intent_spec_id,
        evidence_bundle_id: evidenceBundleId,
        instructions:
          taskType === 'change-spec'
            ? 'Produce a concrete change plan grounded in the evidence.'
            : 'Produce an analysis report grounded in the evidence.',
      },
      ctx.store,
    );
    await logIfPresent(services, 'stage5.dispatch_result', { taskType, result });
    if (result.status !== 'success' || !result.synthesis_artifact_id) {
      throw new Error(`synthesis stage: dispatch failed — ${result.message}`);
    }

    return { output_artifact_id: result.synthesis_artifact_id };
  },
};

function inferSynthesisTaskFromIntent(intent: string): SynthesisTaskType {
  // Mirrors the regex heuristic in the legacy `runSynthesisStage` so the
  // synthesis task-type confirmation prompt reads identically. Distinct from
  // `selectTaskType()` (which scores explanation- vs execution-keywords);
  // this heuristic flags the same execution intents the old code did.
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
  return selectTaskType(intent);
}

// ---------------------------------------------------------------------------
// Stage 6 — execution
// ---------------------------------------------------------------------------

export const executionStage: Stage<'piorx/change-spec@1', 'piorx/execution-report@1'> = {
  id: 'execution',
  inputs: ['piorx/change-spec@1'],
  output: 'piorx/execution-report@1',
  control: {
    entry_criteria:
      'A piorx/change-spec@1 has been produced and synthesis.confirm-task-type accepted.',
    exit_criteria: 'A piorx/execution-report@1 is persisted with status set.',
    acceptance_criteria: 'All declared validation commands pass.',
    failure_handling: 'halt',
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    const ui = requireUI(services);

    const synthesisId = requireArtifactId(ctx.session.artifacts.synthesis_id, 'synthesis_id');
    const evidenceBundleId = requireArtifactId(
      ctx.session.artifacts.evidence_bundle_id,
      'evidence_bundle_id',
    );

    await logIfPresent(services, 'stage6.start', {
      synthesisId,
      sessionState: ctx.session,
    });
    ui.notify(
      'Stage 6: execution\n\nA change specification was produced and can now be executed.',
      'info',
    );

    const allowEdits =
      services.allowEdits ??
      (await ui.confirm(
        'Conductor: execution',
        'Would you like me to execute the generated change specification?',
      ));
    await logIfPresent(services, 'stage6.execute_decision', { execute: allowEdits });

    if (!allowEdits) {
      const skippedId = generateArtifactId('piorx/execution-report@1');
      const skippedReport: ExecutionReportV1 = {
        artifact_type: 'piorx/execution-report@1',
        artifact_id: skippedId,
        change_spec_id: synthesisId,
        status: 'skipped',
        modified_files: [],
        validation: { commands: [], passed: true },
        notes: ['Execution skipped: user did not latch execution.allow_edits.'],
      };
      await ctx.store.put(skippedReport);
      return { output_artifact_id: skippedId };
    }

    const changeSpec = (await ctx.store.get(
      'piorx/change-spec@1',
      synthesisId,
    )) as ChangeSpecV1 | null;
    if (!changeSpec) {
      throw new Error(
        `execution stage: synthesis_id "${synthesisId}" did not resolve to a piorx/change-spec@1 artifact`,
      );
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
      ctx.store,
    );
    await logIfPresent(services, 'stage6.dispatch_result', result);
    if (result.status !== 'success' || !result.execution_report_id) {
      throw new Error(`execution stage: dispatch failed — ${result.message}`);
    }
    ui.notify(`Execution complete: ${result.execution_report_id}`, 'info');
    return { output_artifact_id: result.execution_report_id };
  },
};

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export const DEFAULT_STAGE_ADAPTERS: readonly Stage[] = [
  restatementStage,
  expansionStage,
  retrievalStage,
  evidenceStage,
  synthesisStage,
  executionStage,
];

export function registerDefaultStages(registry: WorkflowRegistry): void {
  for (const stage of DEFAULT_STAGE_ADAPTERS) {
    registry.registerStage(stage);
  }
}
