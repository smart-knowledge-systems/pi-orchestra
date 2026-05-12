/**
 * Artifact promotion service.
 *
 * Promotes a synthesis output (analysis-report-v1 or change-spec-v1) into a
 * recursive-intent-v1 artifact with lineage references back to the source.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type { RecursiveIntentV1 } from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import { validateArtifact } from '../artifacts/schemas.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface ArtifactPromoteInput {
  source_artifact_type: string;
  source_artifact_id: string;
  new_user_intent_verbatim: string;
}

export interface ArtifactPromoteResult {
  status: 'success' | 'error';
  recursive_intent_id: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Allowed source types for promotion
// ---------------------------------------------------------------------------

const PROMOTABLE_TYPES = ['piorx/analysis-report@1', 'piorx/change-spec@1'] as const;

type PromotableType = (typeof PROMOTABLE_TYPES)[number];

function isPromotableType(t: string): t is PromotableType {
  return (PROMOTABLE_TYPES as readonly string[]).includes(t);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function artifactPromote(
  input: ArtifactPromoteInput,
  store: ArtifactStore,
): Promise<ArtifactPromoteResult> {
  // Validate source type
  if (!isPromotableType(input.source_artifact_type)) {
    return {
      status: 'error',
      recursive_intent_id: null,
      message: `Cannot promote artifact type "${input.source_artifact_type}". Only piorx/analysis-report@1 and piorx/change-spec@1 are promotable.`,
    };
  }

  // Validate intent text
  if (!input.new_user_intent_verbatim || input.new_user_intent_verbatim.trim() === '') {
    return {
      status: 'error',
      recursive_intent_id: null,
      message: 'new_user_intent_verbatim must be a non-empty string.',
    };
  }

  // Verify source artifact exists
  const sourceExists = await store.exists(
    input.source_artifact_type as PromotableType,
    input.source_artifact_id,
  );
  if (!sourceExists) {
    return {
      status: 'error',
      recursive_intent_id: null,
      message: `Source artifact "${input.source_artifact_id}" of type "${input.source_artifact_type}" not found in store.`,
    };
  }

  // Build recursive-intent-v1
  const artifactId = generateArtifactId('piorx/recursive-intent@1');
  const recursiveIntent: RecursiveIntentV1 = {
    artifact_type: 'piorx/recursive-intent@1',
    artifact_id: artifactId,
    source_artifact_type: input.source_artifact_type,
    source_artifact_id: input.source_artifact_id,
    new_user_intent_verbatim: input.new_user_intent_verbatim,
    restart_stage: 1,
  };

  // Validate before storing
  const validation = validateArtifact(recursiveIntent);
  if (!validation.valid) {
    return {
      status: 'error',
      recursive_intent_id: null,
      message: `Schema validation failed: ${validation.errors.join('; ')}`,
    };
  }

  // Persist
  await store.put(recursiveIntent);

  return {
    status: 'success',
    recursive_intent_id: artifactId,
    message: `Promoted "${input.source_artifact_id}" to recursive intent "${artifactId}".`,
  };
}
