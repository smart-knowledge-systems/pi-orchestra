/**
 * Stage 1 interaction protocol tests.
 *
 * Validates the intent capture → restatement → approval loop,
 * canonical message shapes, approval turn tracking, and the gate
 * preventing retrieval before approval.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from '../../src/runtime/config.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { StageMachine } from '../../src/conductor/stage-machine.ts';
import {
  Stage1Controller,
  isRetrievalAllowed,
  type RestateFunction,
} from '../../src/conductor/stage-1.ts';
import { RESTATEMENT_APPROVAL_QUESTION, EXPANSION_OFFER } from '../../src/conductor/prompts.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Deterministic restate function that prefixes intent with "Restatement: " */
const echoRestate: RestateFunction = (intent) => `Restatement: ${intent}`;

async function setup() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'stage1-test-'));
  const config = createConfig(tmpDir);
  const store = new ArtifactStore(config);
  const machine = await StageMachine.init(config);
  const controller = new Stage1Controller(store, machine, echoRestate);
  return { tmpDir, config, store, machine, controller };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stage 1 — intent capture and restatement', () => {
  let tmpDir: string;
  let store: ArtifactStore;
  let machine: StageMachine;
  let controller: Stage1Controller;

  beforeEach(async () => {
    const env = await setup();
    tmpDir = env.tmpDir;
    store = env.store;
    machine = env.machine;
    controller = env.controller;
  });

  // -- Intent capture ---------------------------------------------------

  describe('captureIntent', () => {
    it('creates and persists an intent-capture-v1 artifact', async () => {
      const capture = await controller.captureIntent('Fix the login bug');

      expect(capture.artifact_type).toBe('intent-capture-v1');
      expect(capture.user_intent_verbatim).toBe('Fix the login bug');
      expect(capture.tagged_files).toEqual([]);
      expect(capture.artifact_id).toMatch(/^intent_/);

      // Verify persisted
      const loaded = await store.get('intent-capture-v1', capture.artifact_id);
      expect(loaded).toEqual(capture);
    });

    it('includes tagged files when provided', async () => {
      const capture = await controller.captureIntent('Refactor auth', [
        'src/auth.ts',
        'src/login.ts',
      ]);
      expect(capture.tagged_files).toEqual(['src/auth.ts', 'src/login.ts']);
    });

    it('transitions stage machine to restatement', async () => {
      await controller.captureIntent('Fix the login bug');
      expect(machine.currentStage).toBe('restatement');
    });

    it('sets intent_capture_id on session state', async () => {
      const capture = await controller.captureIntent('Fix the login bug');
      expect(machine.sessionState.artifacts.intent_capture_id).toBe(capture.artifact_id);
    });
  });

  // -- Restatement production -------------------------------------------

  describe('produceRestatement', () => {
    it('emits the canonical restatement message shape', async () => {
      await controller.captureIntent('Fix the login bug');
      const msg = await controller.produceRestatement();

      expect(msg).toEqual({
        restated_intent: 'Restatement: Fix the login bug',
        approval_question: RESTATEMENT_APPROVAL_QUESTION,
      });
    });

    it('throws if no intent has been captured', async () => {
      await expect(controller.produceRestatement()).rejects.toThrow(
        'Cannot produce restatement: no intent captured yet',
      );
    });
  });

  // -- Approval loop ----------------------------------------------------

  describe('submitApproval', () => {
    it('returns done:true when user approves', async () => {
      await controller.captureIntent('Fix the login bug');
      const msg = await controller.produceRestatement();

      const result = await controller.submitApproval(msg.restated_intent, {
        approved: true,
      });

      expect(result.done).toBe(true);
      if (result.done) {
        expect(result.restated_intent).toBe('Restatement: Fix the login bug');
      }
    });

    it('returns done:false with new restatement on correction', async () => {
      await controller.captureIntent('Fix the login bug');
      const msg = await controller.produceRestatement();

      const result = await controller.submitApproval(msg.restated_intent, {
        approved: false,
        correction: 'Fix the logout bug instead',
      });

      expect(result.done).toBe(false);
      if (!result.done) {
        expect(result.message.restated_intent).toBe('Restatement: Fix the logout bug instead');
        expect(result.message.approval_question).toBe(RESTATEMENT_APPROVAL_QUESTION);
      }
    });

    it('tracks approval turns across corrections', async () => {
      await controller.captureIntent('Fix bug');

      // Turn 1: reject
      await controller.submitApproval('Restatement: Fix bug', {
        approved: false,
        correction: 'Fix auth bug',
      });
      expect(controller.currentApprovalTurns).toBe(1);

      // Turn 2: reject again
      await controller.submitApproval('Restatement: Fix auth bug', {
        approved: false,
        correction: 'Fix login auth bug',
      });
      expect(controller.currentApprovalTurns).toBe(2);

      // Turn 3: approve
      await controller.submitApproval('Restatement: Fix login auth bug', {
        approved: true,
      });
      expect(controller.currentApprovalTurns).toBe(3);
    });

    it('persists corrected intent as a new intent-capture-v1', async () => {
      await controller.captureIntent('Original intent');
      await controller.submitApproval('Restatement: Original intent', {
        approved: false,
        correction: 'Corrected intent',
      });

      // Session state should point to the new capture
      const newCaptureId = machine.sessionState.artifacts.intent_capture_id!;
      const newCapture = await store.get('intent-capture-v1', newCaptureId);
      expect(newCapture?.user_intent_verbatim).toBe('Corrected intent');
    });

    it('preserves tagged files across corrections', async () => {
      await controller.captureIntent('Fix bug', ['src/main.ts']);
      await controller.submitApproval('Restatement: Fix bug', {
        approved: false,
        correction: 'Fix auth bug',
      });

      const newCaptureId = machine.sessionState.artifacts.intent_capture_id!;
      const newCapture = await store.get('intent-capture-v1', newCaptureId);
      expect(newCapture?.tagged_files).toEqual(['src/main.ts']);
    });
  });

  // -- Expansion offer --------------------------------------------------

  describe('getExpansionOffer', () => {
    it('emits the canonical expansion offer message', () => {
      const msg = controller.getExpansionOffer();
      expect(msg).toEqual({ expansion_offer: EXPANSION_OFFER });
    });
  });

  // -- Finalization -----------------------------------------------------

  describe('finalize', () => {
    async function captureAndApprove(ctrl: Stage1Controller) {
      await ctrl.captureIntent('Fix the login bug');
      await ctrl.produceRestatement();
      await ctrl.submitApproval('Restatement: Fix the login bug', { approved: true });
    }

    it('persists an approved intent-restatement-v1', async () => {
      await captureAndApprove(controller);
      const result = await controller.finalize('Restatement: Fix the login bug', {
        expand: false,
      });

      expect(result.intent_restatement.artifact_type).toBe('intent-restatement-v1');
      expect(result.intent_restatement.approved).toBe(true);
      expect(result.intent_restatement.restated_intent).toBe('Restatement: Fix the login bug');
      expect(result.intent_restatement.approval_turns).toBe(1);

      // Verify persisted
      const loaded = await store.get(
        'intent-restatement-v1',
        result.intent_restatement.artifact_id,
      );
      expect(loaded).toEqual(result.intent_restatement);
    });

    it('links restatement to the current intent capture', async () => {
      await captureAndApprove(controller);
      const result = await controller.finalize('Restatement: Fix the login bug', {
        expand: false,
      });

      expect(result.intent_restatement.intent_capture_id).toBe(result.intent_capture.artifact_id);
    });

    it('transitions to expansion when expand is requested', async () => {
      await captureAndApprove(controller);
      await controller.finalize('Restatement: Fix the login bug', { expand: true });
      expect(machine.currentStage).toBe('expansion');
    });

    it('transitions to retrieval when expand is not requested', async () => {
      await captureAndApprove(controller);
      await controller.finalize('Restatement: Fix the login bug', { expand: false });
      expect(machine.currentStage).toBe('retrieval');
    });

    it('records expand_requested in the restatement artifact', async () => {
      await captureAndApprove(controller);
      const result = await controller.finalize('Restatement: Fix the login bug', {
        expand: true,
      });
      expect(result.intent_restatement.expand_requested).toBe(true);
    });

    it('sets intent_restatement_id on session state', async () => {
      await captureAndApprove(controller);
      const result = await controller.finalize('Restatement: Fix the login bug', {
        expand: false,
      });
      expect(machine.sessionState.artifacts.intent_restatement_id).toBe(
        result.intent_restatement.artifact_id,
      );
    });

    it('throws if no intent was captured', async () => {
      await expect(controller.finalize('something', { expand: false })).rejects.toThrow(
        'Cannot finalize: no intent captured',
      );
    });
  });

  // -- Retrieval gate ---------------------------------------------------

  describe('isRetrievalAllowed', () => {
    it('returns false when no restatement ID is set', async () => {
      expect(await isRetrievalAllowed(store, null)).toBe(false);
    });

    it('returns false when restatement does not exist', async () => {
      expect(await isRetrievalAllowed(store, 'restatement_nonexistent_0')).toBe(false);
    });

    it('returns true when an approved restatement exists', async () => {
      await controller.captureIntent('Fix bug');
      await controller.submitApproval('Restatement: Fix bug', { approved: true });
      const result = await controller.finalize('Restatement: Fix bug', { expand: false });

      const allowed = await isRetrievalAllowed(store, result.intent_restatement.artifact_id);
      expect(allowed).toBe(true);
    });
  });

  // -- Full flow --------------------------------------------------------

  describe('end-to-end Stage 1 flow', () => {
    it('completes a full capture → restate → correct → approve → finalize flow', async () => {
      // 1. Capture
      const capture = await controller.captureIntent('Add dark mode', ['src/theme.ts']);
      expect(machine.currentStage).toBe('restatement');

      // 2. First restatement
      const msg1 = await controller.produceRestatement();
      expect(msg1.restated_intent).toBe('Restatement: Add dark mode');

      // 3. User corrects
      const correction = await controller.submitApproval(msg1.restated_intent, {
        approved: false,
        correction: 'Add dark mode toggle to settings page',
      });
      expect(correction.done).toBe(false);

      // 4. User approves corrected restatement
      if (!correction.done) {
        const approval = await controller.submitApproval(correction.message.restated_intent, {
          approved: true,
        });
        expect(approval.done).toBe(true);
      }

      // 5. Expansion offer
      const offer = controller.getExpansionOffer();
      expect(offer.expansion_offer).toBe(EXPANSION_OFFER);

      // 6. Finalize with expansion
      const result = await controller.finalize(
        'Restatement: Add dark mode toggle to settings page',
        { expand: true },
      );

      expect(result.approval_turns).toBe(2);
      expect(result.intent_restatement.approved).toBe(true);
      expect(result.intent_restatement.expand_requested).toBe(true);
      expect(result.intent_restatement.user_intent_verbatim).toBe(
        'Add dark mode toggle to settings page',
      );
      expect(machine.currentStage).toBe('expansion');

      // Verify retrieval gate works with approved restatement
      const allowed = await isRetrievalAllowed(store, result.intent_restatement.artifact_id);
      expect(allowed).toBe(true);
    });
  });
});
