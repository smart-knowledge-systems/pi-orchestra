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
import type { IntentCaptureV1, IntentFileRef, IntentRestatementV1 } from '../artifacts/types.ts';
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
 * Input to the restatement function. The cleaned intent is the user's request
 * with inline `<file>` blocks stripped; the optional context block carries
 * bounded file context extracted from those same blocks.
 */
export interface RestateInput {
  cleanedIntent: string;
  contextBlock?: string;
}

/**
 * A function that produces a simple restatement of the user's intent.
 *
 * In production this will be backed by a model call; in tests it can be
 * a deterministic stub.
 */
export type RestateFunction = (input: RestateInput) => Promise<string> | string;

/**
 * Optional capture metadata derived from parsing the initial user intent.
 * When omitted, the cleaned intent defaults to the verbatim text and no
 * file-reference bookkeeping is persisted.
 */
export interface IntentCaptureOptions {
  cleanedIntent?: string;
  intentFileRefs?: IntentFileRef[];
  restatementContext?: string;
}

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
  private restatementContext: string | undefined;

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
    options: IntentCaptureOptions = {},
  ): Promise<IntentCaptureV1> {
    const id = generateArtifactId('piorx/intent-capture@1');
    const capture: IntentCaptureV1 = {
      artifact_type: 'piorx/intent-capture@1',
      artifact_id: id,
      user_intent_verbatim: userIntentVerbatim,
      cleaned_user_intent: options.cleanedIntent ?? userIntentVerbatim,
      tagged_files: taggedFiles,
      ...(options.intentFileRefs && options.intentFileRefs.length > 0
        ? { intent_file_refs: options.intentFileRefs }
        : {}),
      timestamp: new Date().toISOString(),
    };

    await this.store.put(capture);
    await this.machine.transition('restatement', id);
    await this.machine.setArtifact('intent_capture_id', id);
    this.intentCapture = capture;
    this.restatementContext = options.restatementContext;
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
    const restated = await this.restate({
      cleanedIntent: this.intentCapture.cleaned_user_intent,
      contextBlock: this.restatementContext,
    });
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

    // User corrected — recapture with the correction as a new intent.
    // Corrections are typed by the user into a prompt UI and are not expected
    // to contain inline <file> blocks, so the verbatim and cleaned forms
    // match. Existing tagged files and refs are preserved for continuity.
    const newId = generateArtifactId('piorx/intent-capture@1');
    const newCapture: IntentCaptureV1 = {
      artifact_type: 'piorx/intent-capture@1',
      artifact_id: newId,
      user_intent_verbatim: response.correction,
      cleaned_user_intent: response.correction,
      tagged_files: this.intentCapture?.tagged_files ?? [],
      ...(this.intentCapture?.intent_file_refs
        ? { intent_file_refs: this.intentCapture.intent_file_refs }
        : {}),
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

    const id = generateArtifactId('piorx/intent-restatement@1');
    const restatement: IntentRestatementV1 = {
      artifact_type: 'piorx/intent-restatement@1',
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
  const artifact = await store.get('piorx/intent-restatement@1', restatementId);
  return artifact !== null && artifact.approved === true;
}
