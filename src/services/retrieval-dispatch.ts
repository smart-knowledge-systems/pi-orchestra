/**
 * Retrieval dispatch service.
 *
 * Orchestrates the retriever worker and normalizer to produce a stored
 * `retrieval-index-v1` artifact from an approved intent package.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type { PiOrchestraConfig } from '../runtime/config.ts';
import { runRetrieverWorker } from '../retriever/worker.ts';
import { normalizeRetrievalOutput } from '../retriever/normalize.ts';
import { assembleRetrieverPrompt } from '../retriever/prompt.ts';

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
 * Dispatch the retriever worker, normalize its output, and persist the
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

  // Assemble the retriever prompt from intent artifacts
  const assembled = assembleRetrieverPrompt({
    userIntentVerbatim: capture.user_intent_verbatim,
    restatedIntent: restatement.restated_intent,
    retrievalFocus,
    taggedFiles: capture.tagged_files,
  });

  // Run the retriever worker with the assembled prompt
  const rawOutput = await runRetrieverWorker({
    repoRoot: config.repoRoot,
    query: assembled.query,
    retrievalFocus: assembled.retrievalFocus.length > 0 ? assembled.retrievalFocus : undefined,
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

  return {
    status: 'success',
    retrieval_index_id: result.artifact.artifact_id,
    message: `Retrieval complete: ${result.artifact.files.length} file(s), confidence=${result.artifact.confidence}`,
  };
}
