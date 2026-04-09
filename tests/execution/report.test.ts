import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  executionDispatch,
  type ExecutionDispatchInput,
} from '../../src/services/execution-dispatch.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import type { ChangeSpecV1, ExecutionReportV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Temp directory and store setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `exec-report-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeChangeSpec(): ChangeSpecV1 {
  return {
    artifact_type: 'change-spec-v1',
    artifact_id: 'change_report_001',
    evidence_bundle_id: 'bundle_report_001',
    change_goal: 'Preserve valid custom model ids during session restore',
    summary: 'Adjust restore flow to allow custom model restoration',
    edits: [
      {
        path: '/abs/path/src/core/model-resolver.ts',
        target: { kind: 'function', name: 'restoreModelFromSession', start: 420, count: 70 },
        intent: 'Permit custom model restoration under known providers',
        required_changes: [
          'Check provider availability before rejecting',
          'Construct custom-model fallback object',
        ],
        constraints: ['Do not alter CLI model resolution'],
      },
      {
        path: '/abs/path/test/model-resolver.test.ts',
        target: { kind: 'function', name: 'describe', start: 1, count: 50 },
        intent: 'Add regression tests for custom model restore',
        required_changes: ['Add test cases for custom model scenarios'],
        constraints: [],
      },
    ],
    tests: [
      'restore known model with auth',
      'restore unknown custom model under known provider with auth',
      'fallback when auth is absent',
    ],
    acceptance_criteria: [
      'session restore succeeds for valid custom provider/model combinations',
      'existing built-in restore behavior remains unchanged',
    ],
  };
}

// ---------------------------------------------------------------------------
// Integration tests: change-spec-v1 fixture → stored execution report
// ---------------------------------------------------------------------------

describe('execution report persistence', () => {
  it('produces a stored valid execution-report-v1 from a change-spec-v1', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const input: ExecutionDispatchInput = {
      change_spec_id: spec.artifact_id,
      evidence_bundle_id: 'bundle_report_001',
      execution_constraints: { allow_edits: true, run_validation: true },
    };

    const result = await executionDispatch(input, store);
    expect(result.status).toBe('success');
    expect(result.execution_report_id).not.toBeNull();

    // Load the stored report
    const report = await store.get('execution-report-v1', result.execution_report_id!);
    expect(report).not.toBeNull();
    expect(report!.artifact_type).toBe('execution-report-v1');
  });

  it('stored report passes schema validation', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: true },
      },
      store,
    );

    const report = await store.get('execution-report-v1', result.execution_report_id!);
    const validation = validateArtifact(report);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('report records modified files from the change spec', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: true },
      },
      store,
    );

    const report = (await store.get(
      'execution-report-v1',
      result.execution_report_id!,
    )) as ExecutionReportV1;

    expect(report.modified_files).toContain('/abs/path/src/core/model-resolver.ts');
    expect(report.modified_files).toContain('/abs/path/test/model-resolver.test.ts');
    expect(report.modified_files.length).toBe(2);
  });

  it('report records validation commands', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: true },
      },
      store,
    );

    const report = (await store.get(
      'execution-report-v1',
      result.execution_report_id!,
    )) as ExecutionReportV1;

    expect(report.validation.commands.length).toBeGreaterThan(0);
    expect(report.validation.passed).toBe(true);
  });

  it('report references the correct change_spec_id', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: true },
      },
      store,
    );

    const report = (await store.get(
      'execution-report-v1',
      result.execution_report_id!,
    )) as ExecutionReportV1;

    expect(report.change_spec_id).toBe(spec.artifact_id);
  });

  it('report has a valid status field', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: true },
      },
      store,
    );

    const report = (await store.get(
      'execution-report-v1',
      result.execution_report_id!,
    )) as ExecutionReportV1;

    expect(report.status).toBe('completed');
  });

  it('report includes execution notes', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: true },
      },
      store,
    );

    const report = (await store.get(
      'execution-report-v1',
      result.execution_report_id!,
    )) as ExecutionReportV1;

    expect(report.notes.length).toBeGreaterThan(0);
    expect(report.notes.some((n) => n.includes('edit'))).toBe(true);
  });

  it('report with validation skipped records empty commands', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: false },
      },
      store,
    );

    const report = (await store.get(
      'execution-report-v1',
      result.execution_report_id!,
    )) as ExecutionReportV1;

    expect(report.validation.commands).toEqual([]);
    expect(report.validation.passed).toBe(false);
  });

  it('report can be reloaded from store by ID', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await executionDispatch(
      {
        change_spec_id: spec.artifact_id,
        evidence_bundle_id: 'bundle_report_001',
        execution_constraints: { allow_edits: true, run_validation: true },
      },
      store,
    );

    // Verify the report is listed in store
    const allReports = await store.listByType('execution-report-v1');
    expect(allReports.length).toBeGreaterThanOrEqual(1);
    expect(allReports.some((r) => r.artifact_id === result.execution_report_id)).toBe(true);
  });
});
