import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig, type PiOrchestraConfig } from '../../src/runtime/config.ts';
import { StageMachine } from '../../src/conductor/stage-machine.ts';
import {
  promoteAndRestart,
  getPromotionPrompt,
  canPromote,
  getPriorArtifactIds,
} from '../../src/conductor/recursive-intent.ts';
import { RECURSIVE_RESTART_OFFER } from '../../src/conductor/prompts.ts';
import type {
  AnalysisReportV1,
  ChangeSpecV1,
  RecursiveIntentV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let config: PiOrchestraConfig;
let store: ArtifactStore;
let machine: StageMachine;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  config = createConfig(tmpDir);
  store = new ArtifactStore(config);
  machine = await StageMachine.init(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAnalysisReport(): AnalysisReportV1 {
  return {
    artifact_type: 'piorx/analysis-report@1',
    artifact_id: 'analysis_restart_001',
    evidence_bundle_id: 'bundle_restart_001',
    summary: 'Logging gaps in the ingest pipeline',
    findings: ['No structured logging in batch processor'],
    risks: ['Blind spots during incident response'],
    recommended_next_steps: ['Add structured logging to batch processor'],
  };
}

function makeChangeSpec(): ChangeSpecV1 {
  return {
    artifact_type: 'piorx/change-spec@1',
    artifact_id: 'change_restart_001',
    evidence_bundle_id: 'bundle_restart_002',
    change_goal: 'Add structured logging',
    summary: 'Instrument batch processor with structured log calls',
    edits: [
      {
        path: '/abs/path/src/ingest/batch.ts',
        target: { kind: 'function', name: 'processBatch', start: 50, count: 80 },
        intent: 'Add log.info calls at batch boundaries',
        required_changes: ['Import logger', 'Add entry/exit logs'],
        constraints: ['No performance regression beyond 1ms/batch'],
      },
    ],
    tests: ['batch logging output test'],
    acceptance_criteria: ['All batch operations produce structured log entries'],
  };
}

/**
 * Advance the stage machine through a typical flow to synthesis,
 * simulating prior work and building up lineage.
 */
async function advanceToSynthesis(m: StageMachine): Promise<void> {
  await m.transition('restatement', 'intent_r_001');
  await m.setArtifact('intent_capture_id', 'intent_r_001');
  await m.transition('retrieval', 'restate_r_001');
  await m.setArtifact('intent_restatement_id', 'restate_r_001');
  await m.transition('evidence', 'retrieval_r_001');
  await m.setArtifact('retrieval_index_id', 'retrieval_r_001');
  await m.transition('synthesis', 'bundle_r_001');
  await m.setArtifact('evidence_bundle_id', 'bundle_r_001');
}

// ---------------------------------------------------------------------------
// Tests: promotion restarts at Stage 1
// ---------------------------------------------------------------------------

describe('session restart flow from promotion', () => {
  it('promotion restarts session at idle (Stage 1 entry)', async () => {
    const report = makeAnalysisReport();
    await store.put(report);
    await advanceToSynthesis(machine);

    const result = await promoteAndRestart(
      {
        source_artifact_type: 'piorx/analysis-report@1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'Add structured logging as recommended',
      },
      store,
      machine,
    );

    expect(result.status).toBe('success');
    expect(machine.currentStage).toBe('idle');
  });

  it('new verbatim intent is stored in the recursive-intent-v1', async () => {
    const report = makeAnalysisReport();
    await store.put(report);
    await advanceToSynthesis(machine);

    const verbatim = 'Instrument the batch processor with structured logging';
    const result = await promoteAndRestart(
      {
        source_artifact_type: 'piorx/analysis-report@1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: verbatim,
      },
      store,
      machine,
    );

    const intent = (await store.get(
      'piorx/recursive-intent@1',
      result.recursive_intent_id!,
    )) as RecursiveIntentV1;

    expect(intent.new_user_intent_verbatim).toBe(verbatim);
  });

  it('prior artifact IDs remain traceable in session lineage', async () => {
    const report = makeAnalysisReport();
    await store.put(report);
    await advanceToSynthesis(machine);

    // Record prior artifact IDs before restart
    const priorIds = getPriorArtifactIds(machine);
    expect(priorIds.length).toBeGreaterThan(0);

    await promoteAndRestart(
      {
        source_artifact_type: 'piorx/analysis-report@1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'Follow up on analysis',
      },
      store,
      machine,
    );

    // After restart, lineage should still contain prior entries
    const postRestartIds = getPriorArtifactIds(machine);
    for (const id of priorIds) {
      expect(postRestartIds).toContain(id);
    }
  });

  it('artifact pointers are cleared after restart', async () => {
    const report = makeAnalysisReport();
    await store.put(report);
    await advanceToSynthesis(machine);

    await promoteAndRestart(
      {
        source_artifact_type: 'piorx/analysis-report@1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'Follow up',
      },
      store,
      machine,
    );

    const state = machine.sessionState;
    expect(state.artifacts.intent_capture_id).toBeNull();
    expect(state.artifacts.intent_restatement_id).toBeNull();
    expect(state.artifacts.retrieval_index_id).toBeNull();
    expect(state.artifacts.evidence_bundle_id).toBeNull();
    expect(state.artifacts.synthesis_id).toBeNull();
  });

  it('works with change-spec-v1 source', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);
    await advanceToSynthesis(machine);

    const result = await promoteAndRestart(
      {
        source_artifact_type: 'piorx/change-spec@1',
        source_artifact_id: spec.artifact_id,
        new_user_intent_verbatim: 'Also add metrics alongside logging',
      },
      store,
      machine,
    );

    expect(result.status).toBe('success');
    expect(machine.currentStage).toBe('idle');

    const intent = (await store.get(
      'piorx/recursive-intent@1',
      result.recursive_intent_id!,
    )) as RecursiveIntentV1;

    expect(intent.source_artifact_type).toBe('piorx/change-spec@1');
    expect(intent.source_artifact_id).toBe(spec.artifact_id);
  });

  it('errors when source artifact is missing', async () => {
    await advanceToSynthesis(machine);

    const result = await promoteAndRestart(
      {
        source_artifact_type: 'piorx/analysis-report@1',
        source_artifact_id: 'nonexistent_001',
        new_user_intent_verbatim: 'Follow up',
      },
      store,
      machine,
    );

    expect(result.status).toBe('error');
    expect(result.recursive_intent_id).toBeNull();
    // Stage should not have been reset on error
    expect(machine.currentStage).toBe('synthesis');
  });

  it('lineage grows across multiple recursive restarts', async () => {
    const report = makeAnalysisReport();
    await store.put(report);
    await advanceToSynthesis(machine);

    // First restart
    const result1 = await promoteAndRestart(
      {
        source_artifact_type: 'piorx/analysis-report@1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'First follow-up',
      },
      store,
      machine,
    );

    const lineageAfterFirst = machine.sessionState.lineage.length;
    expect(lineageAfterFirst).toBeGreaterThan(0);

    // Advance again for second restart
    await advanceToSynthesis(machine);
    await store.put(report); // re-put since store may already have it

    const result2 = await promoteAndRestart(
      {
        source_artifact_type: 'piorx/analysis-report@1',
        source_artifact_id: report.artifact_id,
        new_user_intent_verbatim: 'Second follow-up',
      },
      store,
      machine,
    );

    expect(result2.status).toBe('success');
    // Lineage should have grown
    expect(machine.sessionState.lineage.length).toBeGreaterThan(lineageAfterFirst);
    // Both recursive intent IDs should be traceable
    const allIds = getPriorArtifactIds(machine);
    expect(allIds).toContain(result1.recursive_intent_id!);
    expect(allIds).toContain(result2.recursive_intent_id!);
  });
});

// ---------------------------------------------------------------------------
// Tests: canonical promotion prompt shape
// ---------------------------------------------------------------------------

describe('canonical promotion prompt', () => {
  it('returns the RECURSIVE_RESTART_OFFER constant', () => {
    const prompt = getPromotionPrompt();
    expect(prompt).toBe(RECURSIVE_RESTART_OFFER);
  });

  it('prompt asks about restarting with the output', () => {
    const prompt = getPromotionPrompt();
    expect(prompt.toLowerCase()).toContain('restart');
    expect(prompt).toContain('yes');
    expect(prompt).toContain('no');
  });
});

// ---------------------------------------------------------------------------
// Tests: canPromote helper
// ---------------------------------------------------------------------------

describe('canPromote', () => {
  it('returns true for analysis-report-v1', () => {
    expect(canPromote('piorx/analysis-report@1')).toBe(true);
  });

  it('returns true for change-spec-v1', () => {
    expect(canPromote('piorx/change-spec@1')).toBe(true);
  });

  it('returns false for other types', () => {
    expect(canPromote('piorx/intent-capture@1')).toBe(false);
    expect(canPromote('piorx/evidence-bundle@1')).toBe(false);
    expect(canPromote('piorx/execution-report@1')).toBe(false);
    expect(canPromote('piorx/recursive-intent@1')).toBe(false);
  });
});
