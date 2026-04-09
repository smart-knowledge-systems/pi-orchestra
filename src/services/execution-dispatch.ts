/**
 * Stub service: execution dispatch.
 *
 * Takes a change-spec-v1 and evidence bundle, runs local execution, and
 * produces an execution-report-v1. Returns not-implemented until Phase 6.
 */

import type { ArtifactStore } from '../artifacts/store.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface ExecutionConstraints {
  allow_edits: boolean;
  run_validation: boolean;
}

export interface ExecutionDispatchInput {
  change_spec_id: string;
  evidence_bundle_id: string;
  execution_constraints: ExecutionConstraints;
}

export interface ExecutionDispatchResult {
  status: 'not_implemented' | 'success' | 'error';
  execution_report_id: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

export async function executionDispatch(
  _input: ExecutionDispatchInput,
  _store: ArtifactStore,
): Promise<ExecutionDispatchResult> {
  return {
    status: 'not_implemented',
    execution_report_id: null,
    message: 'Execution dispatch is not yet implemented.',
  };
}
