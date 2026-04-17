/**
 * Stage 1 — Intent capture and restatement approval loop.
 *
 * Responsibilities:
 *   1. Capture verbatim user intent → persist `intent-capture-v1`
 *   2. Produce a simple restatement (not an expansion)
 *   3. Loop until the user approves the restatement
 *   4. Ask expansion yes/no after approval
 *   5. Persist final `intent-restatement-v1`
 *   6. Gate all downstream stages behind approval
 *
 * This module is pure workflow logic. It does NOT read raw source files
 * and does NOT invoke model calls — those are injected via the
 * `RestateFunction` callback.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import type { IntentCaptureV1, IntentRestatementV1 } from '../artifacts/types.ts';
import type { StageMachine } from './stage-machine.ts';
import {
  RESTATEMENT_INSTRUCTION,
  RESTATEMENT_APPROVAL_QUESTION,
  EXPANSION_OFFER,
} from './prompts.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A function that produces a simple restatement of the user's intent.
 *
 * In production this will be backed by a model call; in tests it can be
 * a deterministic stub.
 */
export type RestateFunction = (userIntent: string) => Promise<string> | string;

/** Possible user responses to the restatement approval question. */
export type ApprovalResponse = { approved: true } | { approved: false; correction: string };

/** Possible user responses to the expansion offer. */
export type ExpansionResponse = { expand: boolean };

/**
 * The canonical message shape emitted by the conductor after producing
 * a restatement for user review.
 */
export interface RestatementMessage {
  restated_intent: string;
  approval_question: string;
}

/**
 * The canonical message shape emitted after the restatement is approved,
 * asking whether the user wants expansion.
 */
export interface ExpansionOfferMessage {
  expansion_offer: string;
}

/**
 * Result of a completed Stage 1 flow.
 */
export interface Stage1Result {
  intent_capture: IntentCaptureV1;
  intent_restatement: IntentRestatementV1;
  approval_turns: number;
}

// ---------------------------------------------------------------------------
// Stage 1 controller
// ---------------------------------------------------------------------------

export class Stage1Controller {
  private approvalTurns = 0;
  private intentCapture: IntentCaptureV1 | null = null;

  constructor(
    private readonly store: ArtifactStore,
    private readonly machine: StageMachine,
    private readonly restate: RestateFunction,
  ) {}

  /**
   * Capture the user's verbatim intent and persist it.
   *
   * Transitions the stage machine from `idle` → `restatement`.
   * Returns the persisted `intent-capture-v1` artifact.
   */
  async captureIntent(
    userIntentVerbatim: string,
    taggedFiles: string[] = [],
  ): Promise<IntentCaptureV1> {
    const id = generateArtifactId('intent-capture-v1');
    const capture: IntentCaptureV1 = {
      artifact_type: 'intent-capture-v1',
      artifact_id: id,
      user_intent_verbatim: userIntentVerbatim,
      cleaned_user_intent: userIntentVerbatim,
      tagged_files: taggedFiles,
      timestamp: new Date().toISOString(),
    };

    await this.store.put(capture);
    await this.machine.transition('restatement', id);
    await this.machine.setArtifact('intent_capture_id', id);
    this.intentCapture = capture;
    return capture;
  }

  /**
   * Produce a restatement of the captured intent.
   *
   * Returns the canonical restatement message shape for presentation
   * to the user.
   */
  async produceRestatement(): Promise<RestatementMessage> {
    if (!this.intentCapture) {
      throw new Error('Cannot produce restatement: no intent captured yet');
    }
    const restated = await this.restate(this.intentCapture.user_intent_verbatim);
    return {
      restated_intent: restated,
      approval_question: RESTATEMENT_APPROVAL_QUESTION,
    };
  }

  /**
   * Submit the user's approval or correction for the current restatement.
   *
   * If approved, returns the restatement text. If not, recaptures the
   * corrected intent and produces a new restatement for the next turn.
   *
   * Each call increments the approval turn counter.
   */
  async submitApproval(
    currentRestatement: string,
    response: ApprovalResponse,
  ): Promise<
    { done: true; restated_intent: string } | { done: false; message: RestatementMessage }
  > {
    this.approvalTurns++;

    if (response.approved) {
      return { done: true, restated_intent: currentRestatement };
    }

    // User corrected — recapture with the correction as a new intent
    const newId = generateArtifactId('intent-capture-v1');
    const newCapture: IntentCaptureV1 = {
      artifact_type: 'intent-capture-v1',
      artifact_id: newId,
      user_intent_verbatim: response.correction,
      cleaned_user_intent: response.correction,
      tagged_files: this.intentCapture?.tagged_files ?? [],
      timestamp: new Date().toISOString(),
    };
    await this.store.put(newCapture);
    await this.machine.setArtifact('intent_capture_id', newId);
    this.intentCapture = newCapture;

    const message = await this.produceRestatement();
    return { done: false, message };
  }

  /**
   * Emit the expansion offer message after approval.
   */
  getExpansionOffer(): ExpansionOfferMessage {
    return { expansion_offer: EXPANSION_OFFER };
  }

  /**
   * Finalize Stage 1 by persisting the approved `intent-restatement-v1`.
   *
   * Must be called after the restatement is approved and expansion
   * preference is collected.
   */
  async finalize(
    approvedRestatement: string,
    expansionResponse: ExpansionResponse,
  ): Promise<Stage1Result> {
    if (!this.intentCapture) {
      throw new Error('Cannot finalize: no intent captured');
    }

    const id = generateArtifactId('intent-restatement-v1');
    const restatement: IntentRestatementV1 = {
      artifact_type: 'intent-restatement-v1',
      artifact_id: id,
      intent_capture_id: this.intentCapture.artifact_id,
      user_intent_verbatim: this.intentCapture.user_intent_verbatim,
      restated_intent: approvedRestatement,
      approved: true,
      expand_requested: expansionResponse.expand,
      approval_turns: this.approvalTurns,
    };

    await this.store.put(restatement);
    await this.machine.setArtifact('intent_restatement_id', id);

    // Transition based on expansion choice
    if (expansionResponse.expand) {
      await this.machine.transition('expansion', id);
    } else {
      await this.machine.transition('retrieval', id);
    }

    return {
      intent_capture: this.intentCapture,
      intent_restatement: restatement,
      approval_turns: this.approvalTurns,
    };
  }

  /** Return the current approval turn count. */
  get currentApprovalTurns(): number {
    return this.approvalTurns;
  }

  /** Check whether an intent has been captured. */
  get hasCapturedIntent(): boolean {
    return this.intentCapture !== null;
  }
}

// ---------------------------------------------------------------------------
// Guard: retrieval requires approval
// ---------------------------------------------------------------------------

/**
 * Check whether retrieval is allowed based on session state.
 *
 * Retrieval cannot proceed unless an approved intent-restatement-v1
 * exists in the store.
 */
export async function isRetrievalAllowed(
  store: ArtifactStore,
  restatementId: string | null,
): Promise<boolean> {
  if (!restatementId) return false;
  const artifact = await store.get('intent-restatement-v1', restatementId);
  return artifact !== null && artifact.approved === true;
}
