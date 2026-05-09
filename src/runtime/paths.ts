/**
 * Deterministic path mapping from artifact type to on-disk storage directory.
 *
 * Each artifact type maps to a stable subdirectory under `.pi/artifacts/`.
 */

import { resolve } from 'node:path';
import type { ArtifactType } from '../artifacts/types.ts';
import type { PiOrchestraConfig } from './config.ts';

/**
 * Maps each artifact type to its storage subdirectory name.
 */
const DIRECTORY_MAP: Record<ArtifactType, string> = {
  'piorx/intent-capture@1': 'intents',
  'piorx/intent-restatement@1': 'intents',
  'piorx/expansion-input@1': 'intents',
  'piorx/intent-spec@1': 'intents',
  'piorx/retrieval-index@1': 'retrieval',
  'piorx/evidence-plan@1': 'evidence-plans',
  'piorx/evidence-bundle@1': 'evidence-bundles',
  'piorx/analysis-report@1': 'synthesis',
  'piorx/change-spec@1': 'synthesis',
  'piorx/execution-report@1': 'execution',
  'piorx/recursive-intent@1': 'intents',
  'piorx/workflow-spec@1': 'workflows',
};

/** Return the storage subdirectory name for an artifact type. */
export function artifactSubdir(type: ArtifactType): string {
  return DIRECTORY_MAP[type];
}

/** Return the full directory path where artifacts of this type are stored. */
export function artifactDirPath(config: PiOrchestraConfig, type: ArtifactType): string {
  return resolve(config.artifactsDir, DIRECTORY_MAP[type]);
}

/** Return the full file path for a specific artifact. */
export function artifactFilePath(
  config: PiOrchestraConfig,
  type: ArtifactType,
  artifactId: string,
): string {
  return resolve(config.artifactsDir, DIRECTORY_MAP[type], `${artifactId}.json`);
}
