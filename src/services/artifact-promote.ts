/**
 * Stub service: artifact promotion to recursive intent.
 *
 * Promotes a synthesis output (analysis-report or change-spec) into a
 * recursive-intent-v1 artifact for restart at Stage 1.
 * Returns not-implemented until Phase 6.
 */

import type { ArtifactStore } from '../artifacts/store.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface ArtifactPromoteInput {
  source_artifact_type: string;
  source_artifact_id: string;
  new_user_intent_verbatim: string;
}

export interface ArtifactPromoteResult {
  status: 'not_implemented' | 'success' | 'error';
  recursive_intent_id: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

export async function artifactPromote(
  _input: ArtifactPromoteInput,
  _store: ArtifactStore,
): Promise<ArtifactPromoteResult> {
  return {
    status: 'not_implemented',
    recursive_intent_id: null,
    message: 'Artifact promotion is not yet implemented.',
  };
}
