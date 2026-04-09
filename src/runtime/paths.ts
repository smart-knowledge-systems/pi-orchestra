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
  'intent-capture-v1': 'intents',
  'intent-restatement-v1': 'intents',
  'expansion-input-v1': 'intents',
  'intent-spec-v1': 'intents',
  'retrieval-index-v1': 'retrieval',
  'evidence-plan-v1': 'evidence-plans',
  'evidence-bundle-v1': 'evidence-bundles',
  'analysis-report-v1': 'synthesis',
  'change-spec-v1': 'synthesis',
  'execution-report-v1': 'execution',
  'recursive-intent-v1': 'intents',
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
