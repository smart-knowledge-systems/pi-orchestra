/**
 * Retrieval dispatch service.
 *
 * Orchestrates the deterministic scout, the retriever worker (with an
 * optional bounded retriever agent), and the normalizer to produce a
 * stored `retrieval-index-v1` artifact from an approved intent package.
 *
 * Ordering is explicit:
 *   1. Assemble the retriever prompt from cleaned intent + restatement.
 *   2. Run the deterministic scout — narrows the candidate set before any
 *      model-driven agent work.
 *   3. Run the retriever worker with the scout result (no re-scouting).
 *      If a model callback is supplied, the worker drives the bounded
 *      retriever agent loop; otherwise it falls back to scout-only output.
 *   4. Normalize and persist the structural retrieval artifact.
 *
 * The dispatch boundary is where pi-host details meet the retrieval
 * pipeline: the model callback is injected here rather than imported
 * inside `src/retriever/**`, so retrieval stays pi-agnostic.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { ArtifactStore } from '../artifacts/store.ts';
import type { PiOrchestraConfig } from '../runtime/config.ts';
import type { SourceAccessEvent } from '../runtime/session-state.ts';
import { runRetrieverWorkerDetailed } from '../retriever/worker.ts';
import { normalizeRetrievalOutput } from '../retriever/normalize.ts';
import { assembleRetrieverPrompt } from '../retriever/prompt.ts';
import { runScout } from '../retriever/scout.ts';
import type {
  AgentLimits,
  AgentModelCallback,
  AgentRoundTrace,
  ReadFileObservation,
} from '../retriever/agent-types.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface RetrievalDispatchInput {
  intent_capture_id: string;
  intent_restatement_id: string;
  intent_spec_id: string | null;
}

export interface RetrievalDispatchOptions {
  /**
   * Optional retriever-agent model callback. When supplied, the dispatch
   * runs the bounded agent loop after the scout. When omitted, dispatch
   * falls back to the deterministic scout-only output.
   */
  retrieverAgentModel?: AgentModelCallback;
  /** Optional overrides for the retriever-agent bounded limits. */
  retrieverAgentLimits?: Partial<AgentLimits>;
}

export interface RetrievalDispatchResult {
  status: 'not_implemented' | 'success' | 'error';
  retrieval_index_id: string | null;
  message: string;
  /**
   * Source-access events extracted from the bounded retriever-agent's
   * `read_file` actions. Empty when no model callback drove the agent loop
   * (deterministic scout-only path) or when the agent took no `read_file`
   * actions. Surfaces to lineage through the retrieval stage adapter so the
   * audit trail satisfies the default workflow's
   * `evidence_requirements: ['source-access-events']` for retrieval per
   * `docs/composability.md` "Phase 1 — lineage extensions".
   *
   * Scout-side bulk file scoring is intentionally NOT recorded here — the
   * audit value is in the model-driven decisions about what to inspect, not
   * the infrastructural scoring sweep.
   */
  source_access_events?: SourceAccessEvent[];
}

// ---------------------------------------------------------------------------
// Source-access event extraction (agent trace -> lineage)
// ---------------------------------------------------------------------------

function toRepoRelative(repoRoot: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  return rel === '' ? '.' : rel;
}

function extractSourceAccessEvents(
  trace: readonly AgentRoundTrace[],
  repoRoot: string,
): SourceAccessEvent[] {
  const events: SourceAccessEvent[] = [];
  for (const round of trace) {
    for (let i = 0; i < round.actions.length; i++) {
      const action = round.actions[i];
      const observation = round.observations[i];
      if (!action || action.type !== 'read_file') continue;
      if (!observation || observation.action !== 'read_file') continue;
      const obs = observation as ReadFileObservation;
      if (obs.error) continue;
      const event: SourceAccessEvent = {
        file_path: toRepoRelative(repoRoot, obs.path),
        read_at: new Date().toISOString(),
        budget: { lines: obs.count },
      };
      if (action.reason) event.reason = action.reason;
      events.push(event);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Dispatch the retriever pipeline, normalize its output, and persist the
 * resulting `retrieval-index-v1` artifact.
 */
export async function retrievalDispatch(
  input: RetrievalDispatchInput,
  store: ArtifactStore,
  config: PiOrchestraConfig,
  options: RetrievalDispatchOptions = {},
): Promise<RetrievalDispatchResult> {
  // Load the intent capture to get the query text
  const capture = await store.get('piorx/intent-capture@1', input.intent_capture_id);
  if (!capture) {
    return {
      status: 'error',
      retrieval_index_id: null,
      message: `Intent capture ${input.intent_capture_id} not found`,
    };
  }

  // Load restatement for the restated query
  const restatement = await store.get('piorx/intent-restatement@1', input.intent_restatement_id);
  if (!restatement) {
    return {
      status: 'error',
      retrieval_index_id: null,
      message: `Intent restatement ${input.intent_restatement_id} not found`,
    };
  }

  // Load intent spec if available, for retrieval focus hints
  let retrievalFocus: string[] | undefined;
  if (input.intent_spec_id) {
    const spec = await store.get('piorx/intent-spec@1', input.intent_spec_id);
    if (spec) {
      retrievalFocus = spec.expanded_spec.retrieval_focus;
    }
  }

  // Run the deterministic scout first — this narrows the candidate set
  // before any model-driven retrieval agent work. It also supplies curated
  // scout terms, selection tiers, and default-evidence mode hints that
  // feed the normalized artifact.
  const scout = await runScout({
    repoRoot: config.repoRoot,
    cleanedIntent: capture.cleaned_user_intent,
    restatedIntent: restatement.restated_intent,
    retrievalFocus,
    taggedFiles: capture.tagged_files,
  });

  // Assemble the retriever prompt using the scout-authored curated terms.
  // The cleaned intent is used (not the raw verbatim input) so the prompt
  // isn't contaminated with large inline <file> blocks from the initial
  // message.
  const assembled = assembleRetrieverPrompt({
    userIntentVerbatim: capture.cleaned_user_intent,
    restatedIntent: restatement.restated_intent,
    retrievalFocus,
    taggedFiles: capture.tagged_files,
    scoutTerms: scout.scoutTerms,
  });

  // Run the retriever worker. Pass the pre-computed scout so the worker
  // does not re-scan the repo. When a retriever-agent model callback is
  // supplied the worker drives the bounded agent loop inside the
  // retrieval boundary.
  const workerResult = await runRetrieverWorkerDetailed({
    repoRoot: config.repoRoot,
    query: assembled.query,
    cleanedIntent: capture.cleaned_user_intent,
    restatedIntent: restatement.restated_intent,
    retrievalFocus: assembled.retrievalFocus.length > 0 ? assembled.retrievalFocus : undefined,
    taggedFiles: assembled.taggedFiles.length > 0 ? assembled.taggedFiles : undefined,
    scout,
    model: options.retrieverAgentModel,
    agentLimits: options.retrieverAgentLimits,
  });

  // Normalize into retrieval-index-v1
  const result = normalizeRetrievalOutput({
    raw: workerResult.raw,
    repoRoot: config.repoRoot,
    intentCaptureId: input.intent_capture_id,
    intentRestatementId: input.intent_restatement_id,
    intentSpecId: input.intent_spec_id,
  });

  if (!result.success) {
    return {
      status: 'error',
      retrieval_index_id: null,
      message: `Normalization failed: ${result.errors.join('; ')}`,
    };
  }

  // Persist the artifact
  await store.put(result.artifact);

  const selectedCount = result.artifact.files.filter((f) => f.selection_tier === 'selected').length;
  const reserveCount = result.artifact.files.filter((f) => f.selection_tier === 'reserve').length;
  const agentNote = workerResult.agent
    ? `, agent rounds=${workerResult.agent.telemetry.roundsExecuted}, stop=${workerResult.agent.telemetry.stopReason}`
    : '';

  const sourceAccessEvents = workerResult.agent
    ? extractSourceAccessEvents(workerResult.agent.trace, config.repoRoot)
    : [];

  const dispatchResult: RetrievalDispatchResult = {
    status: 'success',
    retrieval_index_id: result.artifact.artifact_id,
    message: `Retrieval complete: ${selectedCount} selected, ${reserveCount} reserve, confidence=${result.artifact.confidence}${agentNote}`,
  };
  if (sourceAccessEvents.length > 0) {
    dispatchResult.source_access_events = sourceAccessEvents;
  }
  return dispatchResult;
}
