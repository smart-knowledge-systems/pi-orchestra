/**
 * Default piorx pipeline runner — host-side orchestration that drives the
 * `piorx/workflow/default@1` workflow through the runtime executor.
 *
 * Per `docs/composability.md` "Phase 1 — Refactor" and COMP-P1-T11, the
 * inline six-stage `runPipelineFromIntent` body in
 * `extensions/conductor-extension.ts:1040–1167` collapses to a single call
 * into `workflowExecutor.run('piorx/workflow/default@1', initialIntent, ctx)`.
 * The orchestration logic — registry construction, gate registration,
 * adapter context assembly, recursive promotion — lives here so the
 * extension entrypoint stays a thin shell.
 *
 * The default workflow is loaded once at module import time from
 * `src/runtime/workflows/piorx-default.workflow.md` and validated through
 * the `WorkflowRegistry`. The "fat adapter" stage implementations in
 * `src/conductor/stage-adapters.ts` carry per-stage UI flow; gates declared
 * in the workflow spec are auto-accepted by the broker for Phase 1
 * (the `evidence.review` gate's override path is exercised inside the
 * evidence adapter so Phase 1 ships with byte-identical behaviour to the
 * legacy `runEvidenceStage`).
 */

import { resolve } from 'node:path';
import type { ArtifactStore } from '../artifacts/store.ts';
import type { ExpandedSpec, ExpansionInputV1, IntentFileRef } from '../artifacts/types.ts';
import type { PipelinePhaseId, PiOrchestraConfig } from '../runtime/config.ts';
import { WorkflowRegistry, registerDefaultGates } from '../runtime/registry.ts';
import { loadWorkflowFromFile } from '../runtime/workflow-loader.ts';
import { WorkflowExecutor, type WorkflowRunResult } from '../runtime/workflow-executor.ts';
import { CONDUCTOR_SYSTEM_PREAMBLE, RESTATEMENT_INSTRUCTION } from './prompts.ts';
import {
  registerDefaultStages,
  type AdapterExpand,
  type AdapterIntentMetadata,
  type AdapterRestate,
  type PipelineLogger,
  type PipelineUI,
} from './stage-adapters.ts';
import { artifactPromote, type ArtifactPromoteInput } from '../services/artifact-promote.ts';
import { RECURSIVE_RESTART_OFFER } from './prompts.ts';
import {
  createSessionState,
  loadSessionState,
  saveSessionState,
  type SessionState,
} from '../runtime/session-state.ts';
import type { AgentModelCallback } from '../retriever/agent-types.ts';
import { buildRestatementContext, toIntentFileRefs } from '../util/intent-files.ts';

// ---------------------------------------------------------------------------
// Default workflow registration — built once at module import
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_PATH = resolve(
  import.meta.dir,
  '../runtime/workflows/piorx-default.workflow.md',
);
const DEFAULT_WORKFLOW_ID = 'piorx/workflow/default@1';

function buildDefaultRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.registerWorkflow(loadWorkflowFromFile(DEFAULT_WORKFLOW_PATH));
  registerDefaultStages(registry);
  registerDefaultGates(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// Public dependencies
// ---------------------------------------------------------------------------

export interface DefaultPipelineDeps {
  initialIntent: string;
  store: ArtifactStore;
  config: PiOrchestraConfig;
  ui: PipelineUI;
  logEvent: PipelineLogger;
  /**
   * Phase-aware model callback. The host resolves the executor from
   * `runtime.config.models[phase]` per `docs/composability.md` "Phase 2";
   * pre-Phase-2 hosts that omit the per-phase config still work because
   * the host emits a one-shot deprecation warning and falls back to
   * `ctx.model`. The default-pipeline forwards the phase id of each call
   * site (`'restatement'`, `'expansion'`, etc.) so the host's resolver
   * sees the active phase verbatim.
   */
  getModelText(
    systemPrompt: string,
    userText: string,
    phase: PipelinePhaseId | string,
  ): Promise<string>;
  retrieverAgentModel: AgentModelCallback;
  /**
   * Optional abort signal forwarded from the host. Surfaces through the
   * executor's `signal` so adapters that wrap aborting workers (retrieval)
   * cooperate with cancellation.
   */
  signal?: AbortSignal;
  /**
   * Optional override for the loaded workflow id. Defaults to the shipped
   * piorx default workflow. Future hosts (Phase 5) supply other workflow
   * ids discovered through `.piorx/strategies/`.
   */
  workflowId?: string;
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export async function runDefaultPipeline(deps: DefaultPipelineDeps): Promise<void> {
  const registry = buildDefaultRegistry();
  const restate = makeRestateCallback(deps.getModelText);
  const expand = makeExpandCallback(deps.getModelText, deps.logEvent);

  let intentForCycle = deps.initialIntent;
  while (true) {
    const meta = await buildIntentMetadata(intentForCycle, deps.config.repoRoot);
    await deps.logEvent('pipeline.start', { initialIntent: intentForCycle });

    const result = await executeWorkflow(deps, registry, restate, expand, meta);
    await saveSessionState(deps.config, result.sessionState);

    const promoted = await maybeRecursiveRestart(deps, result.runResult);
    if (!promoted) break;
    intentForCycle = promoted.newIntent;
    await deps.logEvent('pipeline.recursive_restart', {
      sourceArtifactId: result.runResult.final_artifact_id,
      newIntent: promoted.newIntent,
    });
    deps.ui.notify('Recursive restart created. Starting next cycle...', 'info');
  }

  await deps.logEvent('pipeline.complete', {});
  deps.ui.notify('pi-orchestra pipeline complete', 'info');
}

interface ExecuteResult {
  runResult: WorkflowRunResult;
  sessionState: SessionState;
}

async function executeWorkflow(
  deps: DefaultPipelineDeps,
  registry: WorkflowRegistry,
  restate: AdapterRestate,
  expand: AdapterExpand,
  meta: AdapterIntentMetadata,
): Promise<ExecuteResult> {
  const session = loadSession(deps.config);
  // The static `model` seam preserves backward-compat callers that wrap a
  // pre-Phase-2 generic resolver; `modelForPhase` is the canonical Phase 2
  // wiring per docs/composability.md "Phase 2 — getModelText takes a phase
  // parameter", so a stage's `ctx.model(systemPrompt, userText)` resolves
  // through the host's per-phase configuration.
  const executor = new WorkflowExecutor({
    registry,
    store: deps.store,
    session,
    model: (systemPrompt, userText) => deps.getModelText(systemPrompt, userText, 'unknown'),
    modelForPhase: (phase) => (systemPrompt, userText) =>
      deps.getModelText(systemPrompt, userText, phase),
    ...(deps.signal ? { signal: deps.signal } : {}),
    contextExtras: {
      runtimeConfig: deps.config,
      retrieverAgentModel: deps.retrieverAgentModel,
      ui: deps.ui,
      logEvent: deps.logEvent,
      restate,
      expand,
      intentMetadata: meta,
    },
  });
  const runResult = await executor.run(deps.workflowId ?? DEFAULT_WORKFLOW_ID);
  return { runResult, sessionState: executor.sessionState };
}

function loadSession(config: PiOrchestraConfig): SessionState {
  return loadSessionState(config) ?? createSessionState();
}

// ---------------------------------------------------------------------------
// Restate / expand callbacks
// ---------------------------------------------------------------------------

function makeRestateCallback(getModelText: DefaultPipelineDeps['getModelText']): AdapterRestate {
  return async ({ cleanedIntent, contextBlock }) => {
    const userText = contextBlock ? `${cleanedIntent}\n\n${contextBlock}` : cleanedIntent;
    return getModelText(
      `${CONDUCTOR_SYSTEM_PREAMBLE}\n\n${RESTATEMENT_INSTRUCTION}`,
      userText,
      'restatement',
    );
  };
}

function makeExpandCallback(
  getModelText: DefaultPipelineDeps['getModelText'],
  logEvent: PipelineLogger,
): AdapterExpand {
  return async (input: ExpansionInputV1, options) => {
    const strictRetry = options?.strictJsonRetry === true;
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
Do not wrap the JSON in prose. Keep arrays compact and practical.${strictRetry ? '\nThis is a retry because the previous response was malformed. Output a single valid JSON object only. No markdown fences. No commentary. No trailing text.' : ''}`,
      JSON.stringify(input, null, 2),
      'expansion',
    );
    const parsed = parseExpandedSpec(raw, input);
    await logEvent('stage2.expansion_parse', {
      raw,
      parsed: parsed.spec,
      usedFallback: parsed.usedFallback,
      validationWarnings: parsed.validationWarnings,
      usedJsonExtraction: extractJsonObject(raw) !== null,
    });
    return parsed;
  };
}

// ---------------------------------------------------------------------------
// Intent metadata
// ---------------------------------------------------------------------------

async function buildIntentMetadata(
  initialIntent: string,
  repoRoot: string,
): Promise<AdapterIntentMetadata> {
  const ctx = await buildRestatementContext(initialIntent, repoRoot);
  return {
    initialIntent,
    cleanedIntent: ctx.cleanedIntent,
    taggedFiles: ctx.taggedFiles,
    intentFileRefs: toIntentFileRefs(ctx.files) as IntentFileRef[],
    ...(ctx.contextBlock ? { restatementContextBlock: ctx.contextBlock } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recursive restart
// ---------------------------------------------------------------------------

async function maybeRecursiveRestart(
  deps: DefaultPipelineDeps,
  result: WorkflowRunResult,
): Promise<{ newIntent: string } | null> {
  if (
    result.final_artifact_type !== 'piorx/analysis-report@1' &&
    result.final_artifact_type !== 'piorx/change-spec@1'
  ) {
    return null;
  }

  const restart = await deps.ui.confirm('Conductor: recursive restart', RECURSIVE_RESTART_OFFER);
  await deps.logEvent('recursive.decision', {
    restart,
    sourceType: result.final_artifact_type,
    sourceId: result.final_artifact_id,
  });
  if (!restart) return null;

  const newIntent = await deps.ui.input(
    'Conductor: new recursive intent',
    'Enter the follow-up intent to restart the conductor with...',
  );
  if (!newIntent?.trim()) {
    deps.ui.notify('Recursive restart skipped: no new intent provided.', 'info');
    return null;
  }

  const promoteInput: ArtifactPromoteInput = {
    source_artifact_type: result.final_artifact_type,
    source_artifact_id: result.final_artifact_id,
    new_user_intent_verbatim: newIntent.trim(),
  };
  const promotion = await artifactPromote(promoteInput, deps.store);
  await deps.logEvent('recursive.result', promotion);
  if (promotion.status !== 'success' || !promotion.recursive_intent_id) {
    throw new Error(`recursive promotion failed: ${promotion.message ?? 'unknown error'}`);
  }
  return { newIntent: newIntent.trim() };
}

// ---------------------------------------------------------------------------
// Expansion-response parsing
// ---------------------------------------------------------------------------

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
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

function fallbackExpandedSpecFromText(raw: string, input: ExpansionInputV1): ExpandedSpec {
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

function parseExpandedSpec(
  raw: string,
  input: ExpansionInputV1,
): { spec: ExpandedSpec; usedFallback: boolean; validationWarnings: string[] } {
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

// Re-export the executor's run-result so hosts can type-check pipeline
// outputs without reaching into runtime internals.
export type { WorkflowRunResult } from '../runtime/workflow-executor.ts';
