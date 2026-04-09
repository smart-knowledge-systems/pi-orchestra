/**
 * Runtime configuration for pi-orchestra.
 *
 * Provides the base directory for artifact storage and session state.
 */

import { resolve } from 'node:path';

export interface PiOrchestraConfig {
  /** Root of the target repository. */
  repoRoot: string;
  /** Base directory for all pi-orchestra data (default: <repoRoot>/.pi). */
  piDir: string;
  /** Directory for artifact JSON files. */
  artifactsDir: string;
  /** Path to the session state file. */
  sessionStatePath: string;
}

/**
 * Build a config rooted at the given repository path.
 *
 * All derived paths are deterministic from the repo root.
 */
export function createConfig(repoRoot: string): PiOrchestraConfig {
  const piDir = resolve(repoRoot, '.pi');
  const artifactsDir = resolve(piDir, 'artifacts');
  const sessionStatePath = resolve(piDir, 'session-state.json');
  return { repoRoot, piDir, artifactsDir, sessionStatePath };
}
