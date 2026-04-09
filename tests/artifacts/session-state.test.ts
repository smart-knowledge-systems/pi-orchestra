import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../../src/runtime/config.ts';
import type { PiOrchestraConfig } from '../../src/runtime/config.ts';
import {
  createSessionState,
  transitionStage,
  setArtifactPointer,
  resetSession,
  saveSessionState,
  loadSessionState,
  loadOrCreateSessionState,
  type SessionState,
} from '../../src/runtime/session-state.ts';

let tmpDir: string;
let config: PiOrchestraConfig;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'piorx-session-test-'));
  config = createConfig(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe('SessionState — initialization', () => {
  it('creates a fresh state with idle stage and null pointers', () => {
    const state = createSessionState();
    expect(state.current_stage).toBe('idle');
    expect(state.lineage).toEqual([]);
    expect(state.artifacts.intent_capture_id).toBeNull();
    expect(state.artifacts.synthesis_id).toBeNull();
    expect(state.created_at).toBeTruthy();
    expect(state.updated_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------

describe('SessionState — stage transitions', () => {
  it('transitions to a new stage', () => {
    const s0 = createSessionState();
    const s1 = transitionStage(s0, 'restatement');
    expect(s1.current_stage).toBe('restatement');
  });

  it('records artifact in lineage when provided', () => {
    const s0 = createSessionState();
    const s1 = transitionStage(s0, 'restatement', 'intent_123_0');
    expect(s1.lineage).toHaveLength(1);
    expect(s1.lineage[0]!.stage).toBe('restatement');
    expect(s1.lineage[0]!.artifact_id).toBe('intent_123_0');
    expect(s1.lineage[0]!.timestamp).toBeTruthy();
  });

  it('preserves lineage across multiple transitions', () => {
    let state = createSessionState();
    state = transitionStage(state, 'restatement', 'a1');
    state = transitionStage(state, 'retrieval', 'a2');
    state = transitionStage(state, 'synthesis', 'a3');
    expect(state.lineage).toHaveLength(3);
    expect(state.lineage.map((e) => e.stage)).toEqual(['restatement', 'retrieval', 'synthesis']);
  });

  it('does not add lineage entry when no artifact is provided', () => {
    const s0 = createSessionState();
    const s1 = transitionStage(s0, 'restatement');
    expect(s1.lineage).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Artifact pointers
// ---------------------------------------------------------------------------

describe('SessionState — artifact pointers', () => {
  it('sets an artifact pointer', () => {
    const s0 = createSessionState();
    const s1 = setArtifactPointer(s0, 'intent_capture_id', 'intent_100_0');
    expect(s1.artifacts.intent_capture_id).toBe('intent_100_0');
  });

  it('does not mutate the original state', () => {
    const s0 = createSessionState();
    setArtifactPointer(s0, 'intent_capture_id', 'intent_100_0');
    expect(s0.artifacts.intent_capture_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('SessionState — reset', () => {
  it('clears artifact pointers and resets to idle', () => {
    let state = createSessionState();
    state = transitionStage(state, 'synthesis', 'a1');
    state = setArtifactPointer(state, 'intent_capture_id', 'cap1');
    state = setArtifactPointer(state, 'synthesis_id', 'syn1');

    const reset = resetSession(state);
    expect(reset.current_stage).toBe('idle');
    expect(reset.artifacts.intent_capture_id).toBeNull();
    expect(reset.artifacts.synthesis_id).toBeNull();
  });

  it('preserves lineage through reset', () => {
    let state = createSessionState();
    state = transitionStage(state, 'restatement', 'a1');
    state = transitionStage(state, 'retrieval', 'a2');

    const reset = resetSession(state);
    expect(reset.lineage).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence — save/load round-trip
// ---------------------------------------------------------------------------

describe('SessionState — persistence', () => {
  it('saves and reloads session state', async () => {
    let state = createSessionState();
    state = transitionStage(state, 'restatement', 'intent_1');
    state = setArtifactPointer(state, 'intent_capture_id', 'intent_1');
    await saveSessionState(config, state);

    const loaded = loadSessionState(config);
    expect(loaded).not.toBeNull();
    expect(loaded!.current_stage).toBe('restatement');
    expect(loaded!.artifacts.intent_capture_id).toBe('intent_1');
    expect(loaded!.lineage).toHaveLength(1);
  });

  it('returns null when no state file exists', () => {
    const loaded = loadSessionState(config);
    expect(loaded).toBeNull();
  });

  it('loadOrCreate initializes and persists when no file exists', async () => {
    const state = await loadOrCreateSessionState(config);
    expect(state.current_stage).toBe('idle');

    // Should now be on disk
    const loaded = loadSessionState(config);
    expect(loaded).not.toBeNull();
    expect(loaded!.current_stage).toBe('idle');
  });

  it('loadOrCreate returns existing state if present', async () => {
    let state = createSessionState();
    state = transitionStage(state, 'retrieval', 'r1');
    await saveSessionState(config, state);

    const loaded = await loadOrCreateSessionState(config);
    expect(loaded.current_stage).toBe('retrieval');
  });
});
