/**
 * Lightweight session state persistence.
 *
 * Tracks the current conductor stage, active artifact IDs, and lineage
 * metadata. Stored as a single JSON file at `.pi/session-state.json`.
 *
 * Artifacts are immutable — the session state is what evolves, pointing
 * to the current artifact chain.
 */

import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PiOrchestraConfig } from './config.ts';

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

export const STAGES = [
  'idle',
  'restatement',
  'expansion',
  'retrieval',
  'evidence',
  'synthesis',
  'execution',
] as const;

export type Stage = (typeof STAGES)[number];

// ---------------------------------------------------------------------------
// Lineage entry — records each significant state transition
// ---------------------------------------------------------------------------

export interface LineageEntry {
  stage: Stage;
  artifact_id: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Session state shape
// ---------------------------------------------------------------------------

export interface SessionState {
  /** Current conductor stage. */
  current_stage: Stage;
  /** Active artifact IDs keyed by role. All are nullable. */
  artifacts: {
    intent_capture_id: string | null;
    intent_restatement_id: string | null;
    expansion_input_id: string | null;
    intent_spec_id: string | null;
    retrieval_index_id: string | null;
    evidence_plan_id: string | null;
    evidence_bundle_id: string | null;
    synthesis_id: string | null;
    execution_report_id: string | null;
  };
  /** Ordered history of stage transitions with artifact pointers. */
  lineage: LineageEntry[];
  /** ISO timestamp of session creation. */
  created_at: string;
  /** ISO timestamp of last state write. */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh, empty session state. */
export function createSessionState(): SessionState {
  const now = new Date().toISOString();
  return {
    current_stage: 'idle',
    artifacts: {
      intent_capture_id: null,
      intent_restatement_id: null,
      expansion_input_id: null,
      intent_spec_id: null,
      retrieval_index_id: null,
      evidence_plan_id: null,
      evidence_bundle_id: null,
      synthesis_id: null,
      execution_report_id: null,
    },
    lineage: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Transition the session to a new stage and optionally record an artifact
 * in the lineage.
 */
export function transitionStage(
  state: SessionState,
  stage: Stage,
  artifactId?: string,
): SessionState {
  const now = new Date().toISOString();
  const lineage = [...state.lineage];
  if (artifactId) {
    lineage.push({ stage, artifact_id: artifactId, timestamp: now });
  }
  return {
    ...state,
    current_stage: stage,
    lineage,
    updated_at: now,
  };
}

/**
 * Set an artifact pointer on the session state.
 *
 * The key must match one of the known artifact slots.
 */
export function setArtifactPointer(
  state: SessionState,
  key: keyof SessionState['artifacts'],
  id: string,
): SessionState {
  return {
    ...state,
    artifacts: { ...state.artifacts, [key]: id },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Reset the session state for a recursive restart.
 *
 * Clears all artifact pointers and moves back to `idle`, preserving lineage.
 */
export function resetSession(state: SessionState): SessionState {
  const now = new Date().toISOString();
  return {
    ...state,
    current_stage: 'idle',
    artifacts: {
      intent_capture_id: null,
      intent_restatement_id: null,
      expansion_input_id: null,
      intent_spec_id: null,
      retrieval_index_id: null,
      evidence_plan_id: null,
      evidence_bundle_id: null,
      synthesis_id: null,
      execution_report_id: null,
    },
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Save session state to disk. Creates parent directory if needed. */
export async function saveSessionState(
  config: PiOrchestraConfig,
  state: SessionState,
): Promise<void> {
  const dir = dirname(config.sessionStatePath);
  await mkdir(dir, { recursive: true });
  writeFileSync(config.sessionStatePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Load session state from disk.
 *
 * Returns `null` if the file does not exist.
 */
export function loadSessionState(config: PiOrchestraConfig): SessionState | null {
  if (!existsSync(config.sessionStatePath)) {
    return null;
  }
  const raw = readFileSync(config.sessionStatePath, 'utf-8');
  return JSON.parse(raw) as SessionState;
}

/**
 * Load existing session state or create and persist a new one.
 */
export async function loadOrCreateSessionState(config: PiOrchestraConfig): Promise<SessionState> {
  const existing = loadSessionState(config);
  if (existing) return existing;
  const fresh = createSessionState();
  await saveSessionState(config, fresh);
  return fresh;
}
