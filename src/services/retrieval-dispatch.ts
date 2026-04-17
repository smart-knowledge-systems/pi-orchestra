/**
 * Retrieval dispatch service.
 *
 * Orchestrates the deterministic scout, the retriever worker, and the
 * normalizer to produce a stored `retrieval-index-v1` artifact from an
 * approved intent package.
 *
 * Ordering is explicit:
 *   1. Assemble the retriever prompt from cleaned intent + restatement.
 *   2. Run the deterministic scout — narrows the candidate set before any
 *      model-driven agent work.
 *   3. Run the retriever worker with the scout result (no re-scouting).
 *   4. Normalize and persist the structural retrieval artifact.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type { PiOrchestraConfig } from '../runtime/config.ts';
import { runRetrieverWorker } from '../retriever/worker.ts';
import { normalizeRetrievalOutput } from '../retriever/normalize.ts';
import { assembleRetrieverPrompt } from '../retriever/prompt.ts';
import { runScout } from '../retriever/scout.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface RetrievalDispatchInput {
  intent_capture_id: string;
  intent_restatement_id: string;
  intent_spec_id: string | null;
}

export interface RetrievalDispatchResult {
  status: 'not_implemented' | 'success' | 'error';
  retrieval_index_id: string | null;
  message: string;
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
): Promise<RetrievalDispatchResult> {
  // Load the intent capture to get the query text
  const capture = await store.get('intent-capture-v1', input.intent_capture_id);
  if (!capture) {
    return {
      status: 'error',
      retrieval_index_id: null,
      message: `Intent capture ${input.intent_capture_id} not found`,
    };
  }

  // Load restatement for the restated query
  const restatement = await store.get('intent-restatement-v1', input.intent_restatement_id);
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
    const spec = await store.get('intent-spec-v1', input.intent_spec_id);
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
  // does not re-scan the repo.
  const rawOutput = await runRetrieverWorker({
    repoRoot: config.repoRoot,
    query: assembled.query,
    cleanedIntent: capture.cleaned_user_intent,
    restatedIntent: restatement.restated_intent,
    retrievalFocus: assembled.retrievalFocus.length > 0 ? assembled.retrievalFocus : undefined,
    taggedFiles: assembled.taggedFiles.length > 0 ? assembled.taggedFiles : undefined,
    scout,
  });

  // Normalize into retrieval-index-v1
  const result = normalizeRetrievalOutput({
    raw: rawOutput,
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

  return {
    status: 'success',
    retrieval_index_id: result.artifact.artifact_id,
    message: `Retrieval complete: ${selectedCount} selected, ${reserveCount} reserve, confidence=${result.artifact.confidence}`,
  };
}
