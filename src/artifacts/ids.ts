/**
 * Artifact ID generation helpers.
 *
 * IDs are type-aware: each artifact type has a short prefix followed by a
 * timestamp-based suffix to ensure uniqueness.
 */

import type { ArtifactType } from './types.ts';

const PREFIX_MAP: Record<ArtifactType, string> = {
  'intent-capture-v1': 'intent',
  'intent-restatement-v1': 'restatement',
  'expansion-input-v1': 'expand_in',
  'intent-spec-v1': 'spec',
  'retrieval-index-v1': 'retrieval',
  'evidence-plan-v1': 'plan',
  'evidence-bundle-v1': 'bundle',
  'analysis-report-v1': 'analysis',
  'change-spec-v1': 'change',
  'execution-report-v1': 'exec',
  'recursive-intent-v1': 'recur',
};

/** Returns the short prefix for a given artifact type. */
export function artifactTypePrefix(type: ArtifactType): string {
  return PREFIX_MAP[type];
}

let counter = 0;

/**
 * Generate a unique artifact ID for the given type.
 *
 * Format: `<prefix>_<timestamp>_<counter>`
 *
 * The counter prevents collisions when multiple artifacts are created
 * within the same millisecond.
 */
export function generateArtifactId(type: ArtifactType): string {
  const prefix = PREFIX_MAP[type];
  const ts = Date.now();
  const seq = counter++;
  return `${prefix}_${ts}_${seq}`;
}
