/**
 * Stub service: intent expansion.
 *
 * Takes an approved restatement and optional included files, returns an
 * expanded intent spec. Returns a not-implemented result until Phase 2.
 */

import type { ArtifactStore } from '../artifacts/store.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface IntentExpandInput {
  intent_capture_id: string;
  intent_restatement_id: string;
  included_files: Array<{ path: string; reason: string }>;
}

export interface IntentExpandResult {
  status: 'not_implemented' | 'success' | 'error';
  intent_spec_id: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

export async function intentExpand(
  _input: IntentExpandInput,
  _store: ArtifactStore,
): Promise<IntentExpandResult> {
  return {
    status: 'not_implemented',
    intent_spec_id: null,
    message: 'Intent expansion is not yet implemented.',
  };
}
