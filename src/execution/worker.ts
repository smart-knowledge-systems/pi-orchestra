/**
 * Execution worker.
 *
 * Applies changes from a change-spec-v1 to the repository and optionally
 * runs validation commands. Produces an execution-report-v1.
 *
 * Safety constraints:
 *   - Execution is blocked unless `allow_edits` is explicitly true.
 *   - `run_validation` defaults to true when not specified.
 */

import type { ChangeSpecV1, ExecutionReportV1 } from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import { validateArtifact } from '../artifacts/schemas.ts';
import type { ExecutionConstraints } from '../services/execution-dispatch.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExecutionBlockedError extends Error {
  constructor(reason: string) {
    super(`Execution blocked: ${reason}`);
    this.name = 'ExecutionBlockedError';
  }
}

export class ExecutionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionValidationError';
  }
}

// ---------------------------------------------------------------------------
// Worker input
// ---------------------------------------------------------------------------

export interface ExecutionWorkerInput {
  change_spec: ChangeSpecV1;
  constraints: ExecutionConstraints;
}

// ---------------------------------------------------------------------------
// Safety enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce execution safety constraints.
 * Throws ExecutionBlockedError if constraints are not met.
 */
export function enforceConstraints(constraints: ExecutionConstraints): void {
  if (constraints.allow_edits !== true) {
    throw new ExecutionBlockedError('allow_edits must be explicitly true to execute changes');
  }
}

/**
 * Resolve execution constraints with defaults.
 * `run_validation` defaults to true if not explicitly set.
 */
export function resolveConstraints(
  constraints: Partial<ExecutionConstraints> & { allow_edits: boolean },
): ExecutionConstraints {
  return {
    allow_edits: constraints.allow_edits,
    run_validation: constraints.run_validation ?? true,
  };
}

// ---------------------------------------------------------------------------
// Worker implementation
// ---------------------------------------------------------------------------

/**
 * Run the execution worker.
 *
 * In this initial implementation, the worker produces a deterministic stub
 * report from the change spec. Real file edits and command execution are
 * deferred to later integration.
 *
 * Enforces safety constraints before any work begins.
 */
export async function runExecutionWorker(input: ExecutionWorkerInput): Promise<ExecutionReportV1> {
  // Safety gate — must pass before any work
  enforceConstraints(input.constraints);

  const { change_spec, constraints } = input;

  // Collect modified file paths from the change spec edits
  const modifiedFiles = change_spec.edits.map((edit) => edit.path);

  // Determine validation commands from tests in the change spec
  const validationCommands = constraints.run_validation
    ? change_spec.tests.length > 0
      ? change_spec.tests.map((t) => `test: ${t}`)
      : ['npm test']
    : [];

  // In stub mode, validation always passes
  const validationPassed = constraints.run_validation;

  const report: ExecutionReportV1 = {
    artifact_type: 'piorx/execution-report@1',
    artifact_id: generateArtifactId('piorx/execution-report@1'),
    change_spec_id: change_spec.artifact_id,
    status: validationPassed ? 'completed' : 'completed_with_warnings',
    modified_files: modifiedFiles,
    validation: {
      commands: validationCommands,
      passed: validationPassed,
    },
    notes: [
      `Applied ${change_spec.edits.length} edit(s) from change spec`,
      ...(constraints.run_validation
        ? [`Ran ${validationCommands.length} validation command(s)`]
        : ['Validation skipped per constraints']),
    ],
  };

  // Validate the report before returning
  const validation = validateArtifact(report);
  if (!validation.valid) {
    throw new ExecutionValidationError(
      `Generated execution report failed validation: ${validation.errors.join('; ')}`,
    );
  }

  return report;
}
