import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  enforceConstraints,
  resolveConstraints,
  runExecutionWorker,
  ExecutionBlockedError,
  type ExecutionWorkerInput,
} from '../../src/execution/worker.ts';
import {
  executionDispatch,
  type ExecutionDispatchInput,
} from '../../src/services/execution-dispatch.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import type { ChangeSpecV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChangeSpec(): ChangeSpecV1 {
  return {
    artifact_type: 'piorx/change-spec@1',
    artifact_id: 'change_safety_001',
    evidence_bundle_id: 'bundle_safety_001',
    change_goal: 'Add input validation',
    summary: 'Add validation to API endpoints',
    edits: [
      {
        path: '/repo/src/api.ts',
        target: { kind: 'function', name: 'handleRequest', start: 5, count: 15 },
        intent: 'Add input validation',
        required_changes: ['Validate request body'],
        constraints: [],
      },
      {
        path: '/repo/src/middleware.ts',
        target: { kind: 'function', name: 'validateInput', start: 1, count: 10 },
        intent: 'Create validation middleware',
        required_changes: ['New validation function'],
        constraints: [],
      },
    ],
    tests: ['valid input accepted', 'invalid input rejected'],
    acceptance_criteria: ['All endpoints validate input'],
  };
}

// ---------------------------------------------------------------------------
// enforceConstraints unit tests
// ---------------------------------------------------------------------------

describe('enforceConstraints', () => {
  it('allows execution when allow_edits is true', () => {
    expect(() => enforceConstraints({ allow_edits: true, run_validation: true })).not.toThrow();
  });

  it('blocks execution when allow_edits is false', () => {
    expect(() => enforceConstraints({ allow_edits: false, run_validation: true })).toThrow(
      ExecutionBlockedError,
    );
  });

  it('blocks execution when allow_edits is false even with run_validation false', () => {
    expect(() => enforceConstraints({ allow_edits: false, run_validation: false })).toThrow(
      ExecutionBlockedError,
    );
  });

  it('error message mentions allow_edits', () => {
    try {
      enforceConstraints({ allow_edits: false, run_validation: true });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).message).toContain('allow_edits');
    }
  });
});

// ---------------------------------------------------------------------------
// resolveConstraints defaults
// ---------------------------------------------------------------------------

describe('resolveConstraints', () => {
  it('defaults run_validation to true when not specified', () => {
    const resolved = resolveConstraints({ allow_edits: true });
    expect(resolved.run_validation).toBe(true);
  });

  it('preserves explicit run_validation false', () => {
    const resolved = resolveConstraints({ allow_edits: true, run_validation: false });
    expect(resolved.run_validation).toBe(false);
  });

  it('preserves explicit run_validation true', () => {
    const resolved = resolveConstraints({ allow_edits: true, run_validation: true });
    expect(resolved.run_validation).toBe(true);
  });

  it('preserves allow_edits value', () => {
    expect(resolveConstraints({ allow_edits: false }).allow_edits).toBe(false);
    expect(resolveConstraints({ allow_edits: true }).allow_edits).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runExecutionWorker safety tests
// ---------------------------------------------------------------------------

describe('runExecutionWorker', () => {
  it('blocks execution when allow_edits is false', async () => {
    const input: ExecutionWorkerInput = {
      change_spec: makeChangeSpec(),
      constraints: { allow_edits: false, run_validation: true },
    };
    await expect(runExecutionWorker(input)).rejects.toThrow(ExecutionBlockedError);
  });

  it('proceeds when allow_edits is true', async () => {
    const input: ExecutionWorkerInput = {
      change_spec: makeChangeSpec(),
      constraints: { allow_edits: true, run_validation: true },
    };
    const report = await runExecutionWorker(input);
    expect(report.artifact_type).toBe('piorx/execution-report@1');
    expect(report.status).toBe('completed');
  });

  it('records modified files from change spec', async () => {
    const input: ExecutionWorkerInput = {
      change_spec: makeChangeSpec(),
      constraints: { allow_edits: true, run_validation: true },
    };
    const report = await runExecutionWorker(input);
    expect(report.modified_files).toContain('/repo/src/api.ts');
    expect(report.modified_files).toContain('/repo/src/middleware.ts');
  });

  it('runs validation commands when run_validation is true', async () => {
    const input: ExecutionWorkerInput = {
      change_spec: makeChangeSpec(),
      constraints: { allow_edits: true, run_validation: true },
    };
    const report = await runExecutionWorker(input);
    expect(report.validation.commands.length).toBeGreaterThan(0);
    expect(report.validation.passed).toBe(true);
  });

  it('skips validation when run_validation is false', async () => {
    const input: ExecutionWorkerInput = {
      change_spec: makeChangeSpec(),
      constraints: { allow_edits: true, run_validation: false },
    };
    const report = await runExecutionWorker(input);
    expect(report.validation.commands).toEqual([]);
    expect(report.validation.passed).toBe(false);
    expect(report.notes).toContain('Validation skipped per constraints');
  });

  it('references the correct change_spec_id', async () => {
    const spec = makeChangeSpec();
    const report = await runExecutionWorker({
      change_spec: spec,
      constraints: { allow_edits: true, run_validation: true },
    });
    expect(report.change_spec_id).toBe(spec.artifact_id);
  });
});

// ---------------------------------------------------------------------------
// executionDispatch integration safety tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `exec-safety-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('executionDispatch safety', () => {
  it('returns blocked status when allow_edits is false', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const input: ExecutionDispatchInput = {
      change_spec_id: spec.artifact_id,
      evidence_bundle_id: 'bundle_001',
      execution_constraints: { allow_edits: false, run_validation: true },
    };
    const result = await executionDispatch(input, store);
    expect(result.status).toBe('blocked');
    expect(result.execution_report_id).toBeNull();
    expect(result.message).toContain('allow_edits');
  });

  it('succeeds when allow_edits is true', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const input: ExecutionDispatchInput = {
      change_spec_id: spec.artifact_id,
      evidence_bundle_id: 'bundle_001',
      execution_constraints: { allow_edits: true, run_validation: true },
    };
    const result = await executionDispatch(input, store);
    expect(result.status).toBe('success');
    expect(result.execution_report_id).not.toBeNull();
  });

  it('returns error when change spec not found', async () => {
    const input: ExecutionDispatchInput = {
      change_spec_id: 'nonexistent',
      evidence_bundle_id: 'bundle_001',
      execution_constraints: { allow_edits: true, run_validation: true },
    };
    const result = await executionDispatch(input, store);
    expect(result.status).toBe('error');
    expect(result.message).toContain('not found');
  });
});
