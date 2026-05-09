/**
 * Conductor module for recursive intent promotion and session restart.
 *
 * Coordinates artifact promotion (synthesis output → recursive-intent-v1)
 * with session state reset so the conductor restarts at Stage 1 with a
 * new verbatim intent, while preserving prior lineage in session metadata.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type { StageMachine } from './stage-machine.ts';
import { artifactPromote, type ArtifactPromoteInput } from '../services/artifact-promote.ts';
import { RECURSIVE_RESTART_OFFER } from './prompts.ts';

// ---------------------------------------------------------------------------
// Canonical promotion prompt
// ---------------------------------------------------------------------------

/**
 * Returns the canonical promotion prompt shown to the user after synthesis.
 *
 * Shape matches spec section 11: offers to restart with the synthesis
 * output as a new intent.
 */
export function getPromotionPrompt(): string {
  return RECURSIVE_RESTART_OFFER;
}

// ---------------------------------------------------------------------------
// Promotion + restart
// ---------------------------------------------------------------------------

export interface PromotionResult {
  status: 'success' | 'error';
  recursive_intent_id: string | null;
  message: string;
}

/**
 * Promote a synthesis artifact to a recursive intent and restart the session.
 *
 * 1. Calls the artifact-promote service to create a recursive-intent-v1.
 * 2. Records the recursive intent in session lineage.
 * 3. Resets the stage machine to idle (Stage 1 entry point).
 * 4. Preserves all prior artifact IDs in session lineage history.
 *
 * The caller should then initiate Stage 1 with the new verbatim intent.
 */
export async function promoteAndRestart(
  input: ArtifactPromoteInput,
  store: ArtifactStore,
  machine: StageMachine,
): Promise<PromotionResult> {
  // Step 1: Create recursive-intent-v1 via promotion service
  const promoteResult = await artifactPromote(input, store);

  if (promoteResult.status !== 'success' || !promoteResult.recursive_intent_id) {
    return {
      status: 'error',
      recursive_intent_id: null,
      message: promoteResult.message,
    };
  }

  // Step 2: Transition to idle via the stage machine's normal path.
  // This records the recursive intent ID in the lineage history and
  // moves to idle (Stage 1 entry point). The transition preserves all
  // prior lineage entries.
  await machine.transition('idle', promoteResult.recursive_intent_id);

  // Step 3: Reset artifact pointers so the next cycle starts clean,
  // while keeping the lineage intact.
  await machine.reset();

  return {
    status: 'success',
    recursive_intent_id: promoteResult.recursive_intent_id,
    message: `Session restarted at Stage 1. Recursive intent: ${promoteResult.recursive_intent_id}`,
  };
}

/**
 * Check whether a given synthesis artifact can be promoted.
 *
 * Only analysis-report-v1 and change-spec-v1 are promotable.
 */
export function canPromote(artifactType: string): boolean {
  return artifactType === 'piorx/analysis-report@1' || artifactType === 'piorx/change-spec@1';
}

/**
 * Extract prior artifact IDs from session lineage.
 *
 * Returns all artifact IDs that were recorded in the lineage history,
 * allowing traceability back through recursive restarts.
 */
export function getPriorArtifactIds(machine: StageMachine): string[] {
  return machine.sessionState.lineage.map((entry) => entry.artifact_id);
}
