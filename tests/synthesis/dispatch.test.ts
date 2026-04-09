import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  synthesisDispatch,
  type SynthesisDispatchInput,
} from '../../src/services/synthesis-dispatch.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import type {
  EvidenceBundleV1,
  AnalysisReportV1,
  ChangeSpecV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Temp directory and store setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `synth-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture bundle
// ---------------------------------------------------------------------------

function makeBundle(): EvidenceBundleV1 {
  return {
    artifact_type: 'evidence-bundle-v1',
    artifact_id: 'bundle_synth_test_001',
    evidence_plan_id: 'plan_synth_test_001',
    intent_context: {
      user_intent_verbatim: 'Refactor the auth module',
      approved_restated_intent: 'Refactor the authentication module for clarity',
      intent_spec_id: null,
    },
    structural_context: {
      files: [
        {
          path: '/repo/src/auth.ts',
          file_summary: 'Authentication middleware',
          ast_skeleton: ['function validateToken(...)'],
          symbols: [
            { name: 'validateToken', start: 10, count: 20, summary: 'Validates JWT tokens' },
          ],
        },
      ],
      cross_file_findings: ['Auth depends on session module'],
    },
    raw_evidence: [
      {
        path: '/repo/src/auth.ts',
        kind: 'span',
        label: 'validateToken',
        start: 10,
        count: 20,
        content: 'function validateToken() { return true; }',
      },
    ],
    stats: {
      files: 1,
      spans: 1,
      full_files: 0,
      total_lines: 20,
      estimated_tokens: 300,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synthesisDispatch', () => {
  it('produces a stored analysis-report-v1 from a bundle', async () => {
    const bundle = makeBundle();
    await store.put(bundle);

    const input: SynthesisDispatchInput = {
      task_type: 'analysis-report',
      intent_capture_id: 'ic_001',
      intent_restatement_id: 'ir_001',
      intent_spec_id: null,
      evidence_bundle_id: bundle.artifact_id,
      instructions: '',
    };

    const result = await synthesisDispatch(input, store);

    expect(result.status).toBe('success');
    expect(result.synthesis_artifact_id).not.toBeNull();

    // Verify stored artifact
    const stored = await store.get('analysis-report-v1', result.synthesis_artifact_id!);
    expect(stored).not.toBeNull();
    expect(stored!.artifact_type).toBe('analysis-report-v1');
    expect(stored!.evidence_bundle_id).toBe(bundle.artifact_id);
    expect(stored!.summary).toBeTruthy();
    expect(stored!.findings.length).toBeGreaterThan(0);
  });

  it('produces a stored change-spec-v1 from a bundle', async () => {
    const bundle = makeBundle();
    await store.put(bundle);

    const input: SynthesisDispatchInput = {
      task_type: 'change-spec',
      intent_capture_id: 'ic_001',
      intent_restatement_id: 'ir_001',
      intent_spec_id: null,
      evidence_bundle_id: bundle.artifact_id,
      instructions: '',
    };

    const result = await synthesisDispatch(input, store);

    expect(result.status).toBe('success');
    expect(result.synthesis_artifact_id).not.toBeNull();

    const stored = await store.get('change-spec-v1', result.synthesis_artifact_id!);
    expect(stored).not.toBeNull();
    expect(stored!.artifact_type).toBe('change-spec-v1');
    expect(stored!.evidence_bundle_id).toBe(bundle.artifact_id);
    expect(stored!.edits.length).toBeGreaterThan(0);
    expect(stored!.change_goal).toBeTruthy();
  });

  it('returns error when bundle is missing', async () => {
    const input: SynthesisDispatchInput = {
      task_type: 'analysis-report',
      intent_capture_id: 'ic_001',
      intent_restatement_id: 'ir_001',
      intent_spec_id: null,
      evidence_bundle_id: 'nonexistent_bundle',
      instructions: '',
    };

    const result = await synthesisDispatch(input, store);

    expect(result.status).toBe('error');
    expect(result.synthesis_artifact_id).toBeNull();
    expect(result.message).toContain('not found');
  });

  it('stored analysis-report-v1 passes schema validation', async () => {
    const bundle = makeBundle();
    await store.put(bundle);

    const result = await synthesisDispatch(
      {
        task_type: 'analysis-report',
        intent_capture_id: 'ic_001',
        intent_restatement_id: 'ir_001',
        intent_spec_id: null,
        evidence_bundle_id: bundle.artifact_id,
        instructions: 'Be thorough',
      },
      store,
    );

    const stored = await store.get('analysis-report-v1', result.synthesis_artifact_id!);
    const validation = validateArtifact(stored);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('stored change-spec-v1 passes schema validation', async () => {
    const bundle = makeBundle();
    await store.put(bundle);

    const result = await synthesisDispatch(
      {
        task_type: 'change-spec',
        intent_capture_id: 'ic_001',
        intent_restatement_id: 'ir_001',
        intent_spec_id: null,
        evidence_bundle_id: bundle.artifact_id,
        instructions: '',
      },
      store,
    );

    const stored = await store.get('change-spec-v1', result.synthesis_artifact_id!);
    const validation = validateArtifact(stored);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('analysis-report references the correct bundle ID', async () => {
    const bundle = makeBundle();
    await store.put(bundle);

    const result = await synthesisDispatch(
      {
        task_type: 'analysis-report',
        intent_capture_id: 'ic_001',
        intent_restatement_id: 'ir_001',
        intent_spec_id: null,
        evidence_bundle_id: bundle.artifact_id,
        instructions: '',
      },
      store,
    );

    const stored = (await store.get(
      'analysis-report-v1',
      result.synthesis_artifact_id!,
    )) as AnalysisReportV1;
    expect(stored.evidence_bundle_id).toBe(bundle.artifact_id);
  });

  it('change-spec edits reference paths from the bundle', async () => {
    const bundle = makeBundle();
    await store.put(bundle);

    const result = await synthesisDispatch(
      {
        task_type: 'change-spec',
        intent_capture_id: 'ic_001',
        intent_restatement_id: 'ir_001',
        intent_spec_id: null,
        evidence_bundle_id: bundle.artifact_id,
        instructions: '',
      },
      store,
    );

    const stored = (await store.get(
      'change-spec-v1',
      result.synthesis_artifact_id!,
    )) as ChangeSpecV1;
    const bundlePaths = bundle.raw_evidence.map((e) => e.path);
    for (const edit of stored.edits) {
      expect(bundlePaths).toContain(edit.path);
    }
  });
});
