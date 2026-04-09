/**
 * Stub service: synthesis dispatch.
 *
 * Takes an evidence bundle and intent artifacts, produces an analysis-report-v1
 * or change-spec-v1. Returns not-implemented until Phase 5.
 */

import type { ArtifactStore } from '../artifacts/store.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type SynthesisTaskType = 'analysis-report' | 'change-spec';

export interface SynthesisDispatchInput {
  task_type: SynthesisTaskType;
  intent_capture_id: string;
  intent_restatement_id: string;
  intent_spec_id: string | null;
  evidence_bundle_id: string;
  instructions: string;
}

export interface SynthesisDispatchResult {
  status: 'not_implemented' | 'success' | 'error';
  synthesis_artifact_id: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

export async function synthesisDispatch(
  _input: SynthesisDispatchInput,
  _store: ArtifactStore,
): Promise<SynthesisDispatchResult> {
  return {
    status: 'not_implemented',
    synthesis_artifact_id: null,
    message: 'Synthesis dispatch is not yet implemented.',
  };
}
