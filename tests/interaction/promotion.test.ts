import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactPromote, type ArtifactPromoteInput } from '../../src/services/artifact-promote.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import type {
  AnalysisReportV1,
  ChangeSpecV1,
  RecursiveIntentV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `promotion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAnalysisReport(): AnalysisReportV1 {
  return {
    artifact_type: 'analysis-report-v1',
    artifact_id: 'analysis_promo_001',
    evidence_bundle_id: 'bundle_promo_001',
    summary: 'Auth middleware stores session tokens in plaintext',
    findings: ['Session tokens stored in cookies without encryption'],
    risks: ['Compliance violation with new data protection requirements'],
    recommended_next_steps: ['Encrypt session tokens at rest', 'Add token rotation'],
  };
}

function makeChangeSpec(): ChangeSpecV1 {
  return {
    artifact_type: 'change-spec-v1',
    artifact_id: 'change_promo_001',
    evidence_bundle_id: 'bundle_promo_002',
    change_goal: 'Encrypt session tokens in auth middleware',
    summary: 'Replace plaintext cookie storage with encrypted tokens',
    edits: [
      {
        path: '/abs/path/src/auth/middleware.ts',
        target: { kind: 'function', name: 'createSession', start: 10, count: 30 },
        intent: 'Add encryption to session creation',
        required_changes: ['Import crypto module', 'Encrypt token before cookie set'],
        constraints: ['Maintain backward compatibility with existing sessions'],
      },
    ],
    tests: ['encrypted token round-trip', 'legacy session migration'],
    acceptance_criteria: ['All session tokens encrypted at rest'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('artifact promotion to recursive intent', () => {
  it('promotes an analysis-report-v1 to recursive-intent-v1', async () => {
    const report = makeAnalysisReport();
    await store.put(report);

    const input: ArtifactPromoteInput = {
      source_artifact_type: 'analysis-report-v1',
      source_artifact_id: report.artifact_id,
      new_user_intent_verbatim: 'Encrypt session tokens as recommended in the analysis',
    };

    const result = await artifactPromote(input, store);
    expect(result.status).toBe('success');
    expect(result.recursive_intent_id).not.toBeNull();
  });

  it('promotes a change-spec-v1 to recursive-intent-v1', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const input: ArtifactPromoteInput = {
      source_artifact_type: 'change-spec-v1',
      source_artifact_id: spec.artifact_id,
      new_user_intent_verbatim: 'Also add token rotation after encryption',
    };

    const result = await artifactPromote(input, store);
    expect(result.status).toBe('success');
    expect(result.recursive_intent_id).not.toBeNull();
  });

  it('lineage fields point at source artifact id and type', async () => {
    const report = makeAnalysisReport();
    await store.put(report);

    const result = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'Follow up on analysis findings',
      },
      store,
    );

    const intent = (await store.get(
      'recursive-intent-v1',
      result.recursive_intent_id!,
    )) as RecursiveIntentV1;

    expect(intent.source_artifact_type).toBe('analysis-report-v1');
    expect(intent.source_artifact_id).toBe(report.artifact_id);
  });

  it('preserves the new user intent verbatim', async () => {
    const report = makeAnalysisReport();
    await store.put(report);

    const verbatim = 'Implement the recommended next steps from the analysis';
    const result = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: verbatim,
      },
      store,
    );

    const intent = (await store.get(
      'recursive-intent-v1',
      result.recursive_intent_id!,
    )) as RecursiveIntentV1;

    expect(intent.new_user_intent_verbatim).toBe(verbatim);
  });

  it('sets restart_stage to 1', async () => {
    const report = makeAnalysisReport();
    await store.put(report);

    const result = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'Follow up',
      },
      store,
    );

    const intent = (await store.get(
      'recursive-intent-v1',
      result.recursive_intent_id!,
    )) as RecursiveIntentV1;

    expect(intent.restart_stage).toBe(1);
  });

  it('stored recursive-intent-v1 passes schema validation', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await artifactPromote(
      {
        source_artifact_type: 'change-spec-v1',
        source_artifact_id: spec.artifact_id,
        new_user_intent_verbatim: 'Add token rotation',
      },
      store,
    );

    const intent = await store.get('recursive-intent-v1', result.recursive_intent_id!);
    const validation = validateArtifact(intent);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('rejects non-promotable artifact types', async () => {
    const result = await artifactPromote(
      {
        source_artifact_type: 'intent-capture-v1',
        source_artifact_id: 'intent_001',
        new_user_intent_verbatim: 'Try to promote an intent',
      },
      store,
    );

    expect(result.status).toBe('error');
    expect(result.recursive_intent_id).toBeNull();
    expect(result.message).toContain('Cannot promote');
  });

  it('rejects empty intent text', async () => {
    const report = makeAnalysisReport();
    await store.put(report);

    const result = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: '',
      },
      store,
    );

    expect(result.status).toBe('error');
    expect(result.recursive_intent_id).toBeNull();
    expect(result.message).toContain('non-empty');
  });

  it('rejects whitespace-only intent text', async () => {
    const report = makeAnalysisReport();
    await store.put(report);

    const result = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: '   ',
      },
      store,
    );

    expect(result.status).toBe('error');
    expect(result.recursive_intent_id).toBeNull();
  });

  it('errors when source artifact does not exist', async () => {
    const result = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: 'nonexistent_001',
        new_user_intent_verbatim: 'Follow up on missing report',
      },
      store,
    );

    expect(result.status).toBe('error');
    expect(result.recursive_intent_id).toBeNull();
    expect(result.message).toContain('not found');
  });

  it('produces unique artifact IDs for multiple promotions', async () => {
    const report = makeAnalysisReport();
    await store.put(report);

    const result1 = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'First follow-up',
      },
      store,
    );

    const result2 = await artifactPromote(
      {
        source_artifact_type: 'analysis-report-v1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'Second follow-up',
      },
      store,
    );

    expect(result1.recursive_intent_id).not.toBe(result2.recursive_intent_id);
  });

  it('recursive intent is retrievable from store after promotion', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);

    const result = await artifactPromote(
      {
        source_artifact_type: 'change-spec-v1',
        source_artifact_id: spec.artifact_id,
        new_user_intent_verbatim: 'Extend the change spec',
      },
      store,
    );

    const allIntents = await store.listByType('recursive-intent-v1');
    expect(allIntents.length).toBeGreaterThanOrEqual(1);
    expect(allIntents.some((i) => i.artifact_id === result.recursive_intent_id)).toBe(true);
  });
});
