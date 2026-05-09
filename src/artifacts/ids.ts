/**
 * Artifact ID generation helpers.
 *
 * IDs are type-aware: each artifact type has a short prefix followed by a
 * timestamp-based suffix to ensure uniqueness.
 */

import type { ArtifactType } from './types.ts';

const PREFIX_MAP: Record<ArtifactType, string> = {
  'piorx/intent-capture@1': 'intent',
  'piorx/intent-restatement@1': 'restatement',
  'piorx/expansion-input@1': 'expand_in',
  'piorx/intent-spec@1': 'spec',
  'piorx/retrieval-index@1': 'retrieval',
  'piorx/evidence-plan@1': 'plan',
  'piorx/evidence-bundle@1': 'bundle',
  'piorx/analysis-report@1': 'analysis',
  'piorx/change-spec@1': 'change',
  'piorx/execution-report@1': 'exec',
  'piorx/recursive-intent@1': 'recur',
  'piorx/workflow-spec@1': 'workflow',
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
