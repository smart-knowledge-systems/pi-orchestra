/**
 * Conductor retrieval stage helpers.
 *
 * Provides the conductor with text-safe access to retrieval results
 * without exposing raw repository content. The conductor uses these
 * helpers to inspect retrieval artifacts and determine next steps.
 *
 * This module does NOT import retriever worker internals.
 *
 * @module conductor/retrieval
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type { StageMachine } from './stage-machine.ts';
import { artifactInspect, type RetrievalIndexInspection } from '../services/artifact-inspect.ts';
import { isRetrievalAllowed } from './stage-1.ts';
import { RETRIEVAL_STARTING, RETRIEVAL_COMPLETE } from './prompts.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalStageResult {
  success: boolean;
  message: string;
  inspection: RetrievalIndexInspection | null;
}

// ---------------------------------------------------------------------------
// Stage guard
// ---------------------------------------------------------------------------

/**
 * Check whether the stage machine and session state permit retrieval.
 *
 * Retrieval requires:
 *   1. Stage machine is in a stage that can transition to 'retrieval'
 *      OR is already at 'retrieval'.
 *   2. An approved restatement exists.
 */
export async function canStartRetrieval(
  store: ArtifactStore,
  machine: StageMachine,
): Promise<{ allowed: boolean; reason?: string }> {
  const stage = machine.currentStage;

  // Must be in a stage that can reach retrieval
  const canReach = stage === 'retrieval' || machine.canTransition('retrieval');
  if (!canReach) {
    return { allowed: false, reason: `Cannot start retrieval from stage "${stage}"` };
  }

  // Must have an approved restatement
  const restatementId = machine.sessionState.artifacts.intent_restatement_id;
  const hasApproval = await isRetrievalAllowed(store, restatementId);
  if (!hasApproval) {
    return { allowed: false, reason: 'Retrieval requires an approved restatement' };
  }

  return { allowed: true };
}

/**
 * Inspect a completed retrieval artifact for conductor consumption.
 *
 * Returns text-safe structural data. The conductor should use this
 * to review retrieval findings before planning evidence assembly.
 */
export async function inspectRetrievalResult(
  store: ArtifactStore,
  retrievalIndexId: string,
): Promise<RetrievalStageResult> {
  const result = await artifactInspect(store, 'retrieval-index-v1', retrievalIndexId);

  if (!result.success) {
    return {
      success: false,
      message: result.error,
      inspection: null,
    };
  }

  return {
    success: true,
    message: RETRIEVAL_COMPLETE,
    inspection: result.inspection,
  };
}
