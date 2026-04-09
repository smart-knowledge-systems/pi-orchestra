/**
 * Stub service: retrieval dispatch.
 *
 * Dispatches a retrieval worker to inspect the repository and produce a
 * retrieval-index-v1 artifact. Returns not-implemented until Phase 3.
 */

import type { ArtifactStore } from '../artifacts/store.ts';

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
// Stub implementation
// ---------------------------------------------------------------------------

export async function retrievalDispatch(
  _input: RetrievalDispatchInput,
  _store: ArtifactStore,
): Promise<RetrievalDispatchResult> {
  return {
    status: 'not_implemented',
    retrieval_index_id: null,
    message: 'Retrieval dispatch is not yet implemented.',
  };
}
