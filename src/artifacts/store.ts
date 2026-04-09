/**
 * JSON-backed artifact store.
 *
 * Persists artifacts as individual JSON files under `.pi/artifacts/<subdir>/`.
 * Supports typed get, put, exists, and listByType operations.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { PiOrchestraConfig } from '../runtime/config.ts';
import { artifactDirPath, artifactFilePath } from '../runtime/paths.ts';
import { validateArtifact, type ValidationResult } from './schemas.ts';
import type { Artifact, ArtifactOfType, ArtifactType } from './types.ts';

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

export class ArtifactStore {
  constructor(private readonly config: PiOrchestraConfig) {}

  /**
   * Persist an artifact to disk.
   *
   * Validates the artifact before writing. Creates the target directory
   * if it does not exist.
   */
  async put(artifact: Artifact): Promise<void> {
    const validation = validateArtifact(artifact);
    if (!validation.valid) {
      throw new ArtifactStoreError(`Invalid artifact: ${validation.errors.join('; ')}`);
    }

    const dir = artifactDirPath(this.config, artifact.artifact_type);
    await mkdir(dir, { recursive: true });

    const filePath = artifactFilePath(this.config, artifact.artifact_type, artifact.artifact_id);
    await writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf-8');
  }

  /**
   * Retrieve an artifact by ID and type.
   *
   * Returns `null` if the artifact does not exist. Throws if the stored
   * artifact's `artifact_type` does not match the requested type.
   */
  async get<T extends ArtifactType>(type: T, id: string): Promise<ArtifactOfType<T> | null> {
    const filePath = artifactFilePath(this.config, type, id);
    if (!existsSync(filePath)) {
      return null;
    }

    const raw = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    const validation = validateArtifact(parsed);
    if (!validation.valid) {
      throw new ArtifactStoreError(
        `Stored artifact ${id} failed validation: ${validation.errors.join('; ')}`,
      );
    }

    const artifact = parsed as Artifact;
    if (artifact.artifact_type !== type) {
      throw new ArtifactStoreError(
        `Type mismatch: expected "${type}", got "${artifact.artifact_type}"`,
      );
    }

    return artifact as ArtifactOfType<T>;
  }

  /** Check whether an artifact exists on disk. */
  async exists(type: ArtifactType, id: string): Promise<boolean> {
    const filePath = artifactFilePath(this.config, type, id);
    return existsSync(filePath);
  }

  /**
   * List all stored artifacts of a given type.
   *
   * Reads all JSON files from the type's subdirectory and returns
   * validated artifacts. Skips files that fail validation.
   */
  async listByType<T extends ArtifactType>(type: T): Promise<ArtifactOfType<T>[]> {
    const dir = artifactDirPath(this.config, type);
    if (!existsSync(dir)) {
      return [];
    }

    const entries = await readdir(dir);
    const results: ArtifactOfType<T>[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;

      const raw = await readFile(`${dir}/${entry}`, 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const validation = validateArtifact(parsed);
      if (!validation.valid) continue;

      const artifact = parsed as Artifact;
      if (artifact.artifact_type === type) {
        results.push(artifact as ArtifactOfType<T>);
      }
    }

    return results;
  }
}
