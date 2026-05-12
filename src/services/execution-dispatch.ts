/**
 * Execution dispatch service.
 *
 * Takes a change-spec-v1 and evidence bundle, runs local execution via the
 * worker, and produces an execution-report-v1.
 *
 * Safety constraints:
 *   - Execution is blocked unless `allow_edits` is explicitly true.
 *   - `run_validation` defaults to true when not specified.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import {
  runExecutionWorker,
  ExecutionBlockedError,
  ExecutionValidationError,
} from '../execution/worker.ts';

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
  status: 'success' | 'blocked' | 'error';
  execution_report_id: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function executionDispatch(
  input: ExecutionDispatchInput,
  store: ArtifactStore,
): Promise<ExecutionDispatchResult> {
  // Load the change spec
  const changeSpec = await store.get('piorx/change-spec@1', input.change_spec_id);
  if (!changeSpec) {
    return {
      status: 'error',
      execution_report_id: null,
      message: `Change spec not found: ${input.change_spec_id}`,
    };
  }

  try {
    // Run the execution worker (enforces safety constraints internally)
    const report = await runExecutionWorker({
      change_spec: changeSpec,
      constraints: input.execution_constraints,
    });

    // Store the validated report
    await store.put(report);

    return {
      status: 'success',
      execution_report_id: report.artifact_id,
      message: `Execution report created: ${report.artifact_id}`,
    };
  } catch (err) {
    if (err instanceof ExecutionBlockedError) {
      return {
        status: 'blocked',
        execution_report_id: null,
        message: err.message,
      };
    }
    if (err instanceof ExecutionValidationError) {
      return {
        status: 'error',
        execution_report_id: null,
        message: err.message,
      };
    }
    return {
      status: 'error',
      execution_report_id: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
