import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, ArtifactStoreError } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import type {
  IntentCaptureV1,
  IntentRestatementV1,
  AnalysisReportV1,
} from '../../src/artifacts/types.ts';

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'piorx-store-test-'));
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeIntentCapture(id?: string): IntentCaptureV1 {
  return {
    artifact_type: 'piorx/intent-capture@1',
    artifact_id: id ?? generateArtifactId('piorx/intent-capture@1'),
    user_intent_verbatim: 'Add dark mode support',
    cleaned_user_intent: 'Add dark mode support',
    tagged_files: ['src/theme.ts'],
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// put + get round-trip
// ---------------------------------------------------------------------------

describe('ArtifactStore — put and get', () => {
  it('persists and reloads an artifact by ID', async () => {
    const artifact = makeIntentCapture();
    await store.put(artifact);

    const loaded = await store.get('piorx/intent-capture@1', artifact.artifact_id);
    expect(loaded).toEqual(artifact);
  });

  it('returns null for a non-existent artifact', async () => {
    const result = await store.get('piorx/intent-capture@1', 'nonexistent_0_0');
    expect(result).toBeNull();
  });

  it('rejects invalid artifacts on put', async () => {
    const bad = { artifact_type: 'piorx/intent-capture@1', artifact_id: 'x' } as any;
    await expect(store.put(bad)).rejects.toThrow(ArtifactStoreError);
  });

  it('validates artifact_type on typed get', async () => {
    const capture = makeIntentCapture();
    await store.put(capture);

    // Try to read it as a different type that shares the same subdir
    await expect(store.get('piorx/intent-restatement@1', capture.artifact_id)).rejects.toThrow(
      /Type mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe('ArtifactStore — exists', () => {
  it('returns true for a stored artifact', async () => {
    const artifact = makeIntentCapture();
    await store.put(artifact);
    expect(await store.exists('piorx/intent-capture@1', artifact.artifact_id)).toBe(true);
  });

  it('returns false for a missing artifact', async () => {
    expect(await store.exists('piorx/intent-capture@1', 'missing_0_0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listByType
// ---------------------------------------------------------------------------

describe('ArtifactStore — listByType', () => {
  it('returns all stored artifacts of a given type', async () => {
    const a = makeIntentCapture();
    const b = makeIntentCapture();
    await store.put(a);
    await store.put(b);

    const list = await store.listByType('piorx/intent-capture@1');
    const ids = list.map((x) => x.artifact_id).sort();
    expect(ids).toEqual([a.artifact_id, b.artifact_id].sort());
  });

  it('returns empty array when no artifacts exist', async () => {
    const list = await store.listByType('piorx/retrieval-index@1');
    expect(list).toEqual([]);
  });

  it('filters by artifact_type within a shared subdirectory', async () => {
    // intent-capture-v1 and intent-restatement-v1 share the "intents" subdir
    const capture = makeIntentCapture();
    const restatement: IntentRestatementV1 = {
      artifact_type: 'piorx/intent-restatement@1',
      artifact_id: generateArtifactId('piorx/intent-restatement@1'),
      intent_capture_id: capture.artifact_id,
      user_intent_verbatim: 'Add dark mode support',
      restated_intent: 'Implement dark mode toggle in settings.',
      approved: true,
      expand_requested: false,
      approval_turns: 1,
    };
    await store.put(capture);
    await store.put(restatement);

    const captures = await store.listByType('piorx/intent-capture@1');
    expect(captures).toHaveLength(1);
    expect(captures[0]!.artifact_id).toBe(capture.artifact_id);

    const restatements = await store.listByType('piorx/intent-restatement@1');
    expect(restatements).toHaveLength(1);
    expect(restatements[0]!.artifact_id).toBe(restatement.artifact_id);
  });
});

// ---------------------------------------------------------------------------
// Multiple types
// ---------------------------------------------------------------------------

describe('ArtifactStore — multiple artifact types', () => {
  it('stores and retrieves different artifact types independently', async () => {
    const capture = makeIntentCapture();
    const report: AnalysisReportV1 = {
      artifact_type: 'piorx/analysis-report@1',
      artifact_id: generateArtifactId('piorx/analysis-report@1'),
      evidence_bundle_id: 'bundle_0_0',
      summary: 'All looks good.',
      findings: ['No issues found.'],
      risks: [],
      recommended_next_steps: ['Ship it.'],
    };

    await store.put(capture);
    await store.put(report);

    const loadedCapture = await store.get('piorx/intent-capture@1', capture.artifact_id);
    expect(loadedCapture?.artifact_type).toBe('piorx/intent-capture@1');

    const loadedReport = await store.get('piorx/analysis-report@1', report.artifact_id);
    expect(loadedReport?.artifact_type).toBe('piorx/analysis-report@1');
    expect(loadedReport?.summary).toBe('All looks good.');
  });
});
