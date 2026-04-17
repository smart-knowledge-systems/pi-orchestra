/**
 * Tests for conductor retrieval stage wiring (P3-T4).
 *
 * Covers:
 *   - Stage-machine blocks retrieval without approved restatement
 *   - canStartRetrieval checks both stage and approval
 *   - inspectRetrievalResult returns text-safe data
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../../src/runtime/config.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { StageMachine } from '../../src/conductor/stage-machine.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import { canStartRetrieval, inspectRetrievalResult } from '../../src/conductor/retrieval.ts';
import { normalizeRetrievalOutput, resetNormalizeCounters } from '../../src/retriever/normalize.ts';
import type { IntentCaptureV1, IntentRestatementV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), 'piorx-retrieval-stage-'));
  const config = createConfig(tempDir);
  const store = new ArtifactStore(config);
  const machine = await StageMachine.init(config);
  return { config, store, machine };
}

async function teardown() {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}

async function createApprovedIntent(store: ArtifactStore, machine: StageMachine) {
  const captureId = generateArtifactId('intent-capture-v1');
  const capture: IntentCaptureV1 = {
    artifact_type: 'intent-capture-v1',
    artifact_id: captureId,
    user_intent_verbatim: 'Test intent',
    cleaned_user_intent: 'Test intent',
    tagged_files: [],
    timestamp: new Date().toISOString(),
  };
  await store.put(capture);
  await machine.transition('restatement', captureId);
  await machine.setArtifact('intent_capture_id', captureId);

  const restatementId = generateArtifactId('intent-restatement-v1');
  const restatement: IntentRestatementV1 = {
    artifact_type: 'intent-restatement-v1',
    artifact_id: restatementId,
    intent_capture_id: captureId,
    user_intent_verbatim: 'Test intent',
    restated_intent: 'Understand test intent',
    approved: true,
    expand_requested: false,
    approval_turns: 1,
  };
  await store.put(restatement);
  await machine.setArtifact('intent_restatement_id', restatementId);

  return { captureId, restatementId };
}

// ---------------------------------------------------------------------------
// canStartRetrieval tests
// ---------------------------------------------------------------------------

describe('canStartRetrieval', () => {
  let store: ArtifactStore;
  let machine: StageMachine;

  beforeEach(async () => {
    const s = await setup();
    store = s.store;
    machine = s.machine;
  });

  afterEach(teardown);

  test('blocks retrieval from idle stage without restatement', async () => {
    const result = await canStartRetrieval(store, machine);
    // Idle can transition to restatement, not retrieval directly
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test('blocks retrieval at restatement stage without approval', async () => {
    const captureId = generateArtifactId('intent-capture-v1');
    const capture: IntentCaptureV1 = {
      artifact_type: 'intent-capture-v1',
      artifact_id: captureId,
      user_intent_verbatim: 'Test',
      cleaned_user_intent: 'Test',
      tagged_files: [],
      timestamp: new Date().toISOString(),
    };
    await store.put(capture);
    await machine.transition('restatement', captureId);
    await machine.setArtifact('intent_capture_id', captureId);

    // No approved restatement yet
    const result = await canStartRetrieval(store, machine);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('approved restatement');
  });

  test('allows retrieval at restatement stage with approved restatement', async () => {
    await createApprovedIntent(store, machine);

    const result = await canStartRetrieval(store, machine);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('blocks retrieval from evidence stage', async () => {
    await createApprovedIntent(store, machine);
    await machine.transition('retrieval');
    await machine.transition('evidence');

    const result = await canStartRetrieval(store, machine);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Cannot start retrieval');
  });

  test('allows retrieval from expansion stage with approval', async () => {
    // Start fresh for this test — go through restatement -> expansion path
    const captureId = generateArtifactId('intent-capture-v1');
    const capture: IntentCaptureV1 = {
      artifact_type: 'intent-capture-v1',
      artifact_id: captureId,
      user_intent_verbatim: 'Test with expansion',
      cleaned_user_intent: 'Test with expansion',
      tagged_files: [],
      timestamp: new Date().toISOString(),
    };
    await store.put(capture);
    await machine.transition('restatement', captureId);
    await machine.setArtifact('intent_capture_id', captureId);

    const restatementId = generateArtifactId('intent-restatement-v1');
    const restatement: IntentRestatementV1 = {
      artifact_type: 'intent-restatement-v1',
      artifact_id: restatementId,
      intent_capture_id: captureId,
      user_intent_verbatim: 'Test with expansion',
      restated_intent: 'Expanded test',
      approved: true,
      expand_requested: true,
      approval_turns: 1,
    };
    await store.put(restatement);
    await machine.setArtifact('intent_restatement_id', restatementId);
    await machine.transition('expansion');

    const result = await canStartRetrieval(store, machine);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inspectRetrievalResult tests
// ---------------------------------------------------------------------------

describe('inspectRetrievalResult', () => {
  let store: ArtifactStore;

  beforeEach(async () => {
    const s = await setup();
    store = s.store;
    resetNormalizeCounters();
  });

  afterEach(teardown);

  test('returns text-safe inspection for stored retrieval artifact', async () => {
    const normalized = normalizeRetrievalOutput({
      raw: {
        query: 'test',
        confidence: 'high',
        files: [
          {
            path: '/abs/src/main.ts',
            why_relevant: 'Entry point',
            file_summary: 'Main module',
            ast_skeleton: ['function main()'],
            symbols: [{ kind: 'function', name: 'main', start: 1, count: 10, summary: 'Entry' }],
          },
        ],
        gaps: ['Missing tests'],
        followup_queries: ['test coverage'],
        cross_file_findings: ['Main imports config'],
      },
      repoRoot: '/abs',
      intentCaptureId: 'c1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });
    expect(normalized.success).toBe(true);
    if (!normalized.success) return;
    await store.put(normalized.artifact);

    const result = await inspectRetrievalResult(store, normalized.artifact.artifact_id);
    expect(result.success).toBe(true);
    expect(result.inspection).not.toBeNull();
    expect(result.inspection!.file_count).toBe(1);
    expect(result.inspection!.files[0]!.path).toBe('/abs/src/main.ts');
    expect(result.inspection!.gaps).toContain('Missing tests');
  });

  test('returns error for missing retrieval artifact', async () => {
    const result = await inspectRetrievalResult(store, 'nonexistent_id');
    expect(result.success).toBe(false);
    expect(result.inspection).toBeNull();
  });
});
