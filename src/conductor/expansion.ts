/**
 * Stage 2 — Expansion inclusion protocol.
 *
 * Responsibilities:
 *   1. Auto-include all tagged files in expansion input
 *   2. If no tagged files, discover project docs and prompt user for inclusion
 *   3. Create and persist `expansion-input-v1` artifacts
 *   4. Manage expansion review loop (approve / revise / reject)
 *   5. Persist approved `intent-spec-v1` on approval
 *
 * This module is pure workflow logic. It does NOT read raw source files
 * and does NOT invoke model calls — the expansion worker is injected.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import type {
  ExpansionInputV1,
  ExpansionIncludedFile,
  IntentCaptureV1,
  IntentRestatementV1,
  IntentSpecV1,
  ExpandedSpec,
} from '../artifacts/types.ts';
import type { StageMachine } from './stage-machine.ts';
import { PROJECT_DOC_INCLUSION_QUESTION, EXPANSION_REVIEW_PROMPT } from './prompts.ts';
import { discoverProjectDocs, type DiscoveredProjectDoc } from '../util/project-docs.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * User's response to the project-doc inclusion question.
 * Maps each discovered doc filename to whether the user wants to include it.
 */
export type ProjectDocInclusionResponse = Record<string, boolean>;

/** The message shape for asking about project doc inclusion. */
export interface ProjectDocInclusionMessage {
  question: string;
  available_docs: DiscoveredProjectDoc[];
}

/** The message shape for presenting expansion results for review. */
export interface ExpansionReviewMessage {
  review_prompt: string;
  expanded_spec: ExpandedSpec;
  expansion_input_id: string;
}

/** Possible user responses to expansion review. */
export type ExpansionReviewResponse =
  | { action: 'approve' }
  | { action: 'revise'; revised_intent: string }
  | { action: 'reject' };

/** Result of a completed expansion flow. */
export interface ExpansionResult {
  expansion_input: ExpansionInputV1;
  intent_spec: IntentSpecV1;
}

/**
 * A function that expands an intent into a detailed spec.
 *
 * In production this will be backed by a model call; in tests it can be
 * a deterministic stub.
 */
export type ExpandFunction = (input: ExpansionInputV1) => Promise<ExpandedSpec>;

// ---------------------------------------------------------------------------
// Expansion controller
// ---------------------------------------------------------------------------

export class ExpansionController {
  private currentExpansionInput: ExpansionInputV1 | null = null;

  constructor(
    private readonly store: ArtifactStore,
    private readonly machine: StageMachine,
    private readonly repoRoot: string,
    private readonly expand: ExpandFunction,
  ) {}

  // -----------------------------------------------------------------------
  // Step 1: Determine inclusion — tagged files vs project-doc question
  // -----------------------------------------------------------------------

  /**
   * Determine whether a project-doc inclusion question is needed.
   *
   * Returns `null` if tagged files exist (auto-inclusion) or if no
   * project docs are found. Returns the question message otherwise.
   */
  checkProjectDocInclusion(taggedFiles: string[]): ProjectDocInclusionMessage | null {
    if (taggedFiles.length > 0) {
      // Tagged files exist — auto-include, no question needed
      return null;
    }

    const docs = discoverProjectDocs(this.repoRoot);
    if (docs.length === 0) {
      // No project docs found — no question needed
      return null;
    }

    return {
      question: PROJECT_DOC_INCLUSION_QUESTION,
      available_docs: docs,
    };
  }

  // -----------------------------------------------------------------------
  // Step 2: Build and persist expansion-input-v1
  // -----------------------------------------------------------------------

  /**
   * Create an `expansion-input-v1` artifact from the approved restatement.
   *
   * - Tagged files are auto-included with reason "user-tagged".
   * - If the user responded to the project-doc question, selected docs
   *   are included with reason "project-doc-included".
   * - Persists the artifact and updates session state.
   */
  async createExpansionInput(
    capture: IntentCaptureV1,
    restatement: IntentRestatementV1,
    projectDocResponse?: ProjectDocInclusionResponse,
  ): Promise<ExpansionInputV1> {
    const includedFiles: ExpansionIncludedFile[] = [];

    // Auto-include all tagged files
    for (const path of capture.tagged_files) {
      includedFiles.push({ path, reason: 'user-tagged' });
    }

    // Include selected project docs (only when no tagged files)
    if (capture.tagged_files.length === 0 && projectDocResponse) {
      const docs = discoverProjectDocs(this.repoRoot);
      for (const doc of docs) {
        if (projectDocResponse[doc.filename]) {
          includedFiles.push({ path: doc.path, reason: 'project-doc-included' });
        }
      }
    }

    const id = generateArtifactId('expansion-input-v1');
    const input: ExpansionInputV1 = {
      artifact_type: 'expansion-input-v1',
      artifact_id: id,
      intent_capture_id: capture.artifact_id,
      intent_restatement_id: restatement.artifact_id,
      // Expansion consumes the cleaned intent (inline <file> blocks stripped)
      // rather than the raw verbatim input to keep downstream prompts focused
      // on the user's request instead of embedded file bodies.
      user_intent_verbatim: capture.cleaned_user_intent,
      approved_restated_intent: restatement.restated_intent,
      included_files: includedFiles,
    };

    await this.store.put(input);
    await this.machine.setArtifact('expansion_input_id', id);
    this.currentExpansionInput = input;
    return input;
  }

  // -----------------------------------------------------------------------
  // Step 3: Run expansion and present for review
  // -----------------------------------------------------------------------

  /**
   * Run the expansion worker and return a review message.
   */
  async runExpansion(): Promise<ExpansionReviewMessage> {
    if (!this.currentExpansionInput) {
      throw new Error('Cannot run expansion: no expansion input created yet');
    }

    const spec = await this.expand(this.currentExpansionInput);

    return {
      review_prompt: EXPANSION_REVIEW_PROMPT,
      expanded_spec: spec,
      expansion_input_id: this.currentExpansionInput.artifact_id,
    };
  }

  // -----------------------------------------------------------------------
  // Step 4: Handle review response
  // -----------------------------------------------------------------------

  /**
   * Process the user's review of the expanded spec.
   *
   * - `approve`: Persist `intent-spec-v1` and transition to retrieval.
   * - `revise`: Create a new `expansion-input-v1` with the revised intent
   *   and re-run expansion. Returns a new review message.
   * - `reject`: Transition to retrieval without an intent spec.
   */
  async submitReview(
    expandedSpec: ExpandedSpec,
    response: ExpansionReviewResponse,
  ): Promise<
    | { outcome: 'approved'; result: ExpansionResult }
    | { outcome: 'revised'; message: ExpansionReviewMessage }
    | { outcome: 'rejected' }
  > {
    if (!this.currentExpansionInput) {
      throw new Error('Cannot submit review: no expansion input exists');
    }

    if (response.action === 'approve') {
      const specId = generateArtifactId('intent-spec-v1');
      const intentSpec: IntentSpecV1 = {
        artifact_type: 'intent-spec-v1',
        artifact_id: specId,
        expansion_input_id: this.currentExpansionInput.artifact_id,
        user_intent_verbatim: this.currentExpansionInput.user_intent_verbatim,
        approved_restated_intent: this.currentExpansionInput.approved_restated_intent,
        expanded_spec: expandedSpec,
        approved: true,
      };

      await this.store.put(intentSpec);
      await this.machine.setArtifact('intent_spec_id', specId);
      await this.machine.transition('retrieval', specId);

      return {
        outcome: 'approved',
        result: {
          expansion_input: this.currentExpansionInput,
          intent_spec: intentSpec,
        },
      };
    }

    if (response.action === 'revise') {
      // Create a new expansion input with the revised intent
      // Reuse the same capture/restatement references but update the verbatim
      const newId = generateArtifactId('expansion-input-v1');
      const newInput: ExpansionInputV1 = {
        artifact_type: 'expansion-input-v1',
        artifact_id: newId,
        intent_capture_id: this.currentExpansionInput.intent_capture_id,
        intent_restatement_id: this.currentExpansionInput.intent_restatement_id,
        user_intent_verbatim: response.revised_intent,
        approved_restated_intent: this.currentExpansionInput.approved_restated_intent,
        included_files: this.currentExpansionInput.included_files,
      };

      await this.store.put(newInput);
      await this.machine.setArtifact('expansion_input_id', newId);
      this.currentExpansionInput = newInput;

      const message = await this.runExpansion();
      return { outcome: 'revised', message };
    }

    // reject — skip expansion, go to retrieval without intent spec
    await this.machine.transition('retrieval');
    return { outcome: 'rejected' };
  }
}
