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

// ---------------------------------------------------------------------------
// Phase / advisor configuration — Phase 2 placeholder.
// ---------------------------------------------------------------------------
//
// Stages and the workflow runtime reference these types now so Phase 2 can
// land the executor + advisor wiring as a purely additive change. The
// surface here is intentionally empty: Phase 2 fills `executor`, `advisor`,
// `models`, etc. per docs/composability.md "Phase 2 — PhaseModelConfig +
// runWithAdvisor".

/** Per-phase model + advisor configuration. Phase 2 lands the real fields. */
export interface PhaseModelConfig {
  [key: string]: unknown;
}

/** Per-stage advisor configuration. Phase 2 lands the real fields. */
export interface AdvisorConfig {
  [key: string]: unknown;
}
