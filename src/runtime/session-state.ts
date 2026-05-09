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

/**
 * The role under which a lineage decision was signed.
 *
 * Forward-compatible with the multi-stakeholder governance roadmap
 * (`docs/composability.md` "Governance — deferred to roadmap"): even when
 * one user fills every role today, recording the role makes the upgrade to
 * separated Workflow Owner / Reviewer / Execution Authority a registry
 * concern rather than a schema migration.
 */
export type LineageRole = 'requestor' | 'reviewer' | 'execution_authority';

/**
 * The four-way `GateOutcome` (`src/runtime/gate.ts`) condensed onto a single
 * lineage record. The string values match the discriminator on `GateOutcome`
 * so a lineage reader can route on `kind` without translating.
 */
export type LineageGateOutcomeKind =
  | 'accepted'
  | 'rejected_governance'
  | 'rejected_technical'
  | 'escalated';

/**
 * One gate decision attached to a lineage entry. Multiple gates can run after
 * a single stage; the executor records each in registration order so the
 * audit trail reads top-to-bottom.
 */
export interface LineageGateDecision {
  /** Gate identifier — matches the gate id in the workflow spec. */
  gate_id: string;
  /** Four-way outcome. Mirrors `GateOutcome.kind` from `src/runtime/gate.ts`. */
  kind: LineageGateOutcomeKind;
  /**
   * Human-readable rejection / escalation reason. Present on the three
   * non-accepted outcomes per `GateOutcome`'s discriminated union. Optional
   * on `accepted` so the lineage shape is uniform.
   */
  reason?: string;
  /**
   * For `accepted` outcomes that applied typed override ops, the list of op
   * discriminator strings (e.g. `'promote_file'`). The full op payloads live
   * on the workflow's mutated artifact graph — lineage records the names
   * only so the audit trail stays compact and free of repository content.
   */
  applied_ops?: string[];
  /**
   * For `escalated` outcomes, the routing target. Mirrors
   * `GateOutcome.escalated.to`.
   */
  escalated_to?: 'workflow_owner' | 'policy_authority' | 'user';
}

/**
 * A source-access event surfaced from a worker boundary.
 *
 * Per `docs/composability.md` "evidence_requirements: source-access-events",
 * stages that read repository content (retrieval, evidence assembly when
 * the assembler reads raw files) emit one of these per file read so the
 * audit trail records which file was read by which stage at which budget.
 *
 * The conductor itself never reads raw files; only worker boundaries do.
 * The executor wraps the adapter's `appendLineage` so events can ride
 * alongside the stage's primary entry without each adapter having to
 * stitch them together manually.
 */
export interface SourceAccessEvent {
  /** Repository-relative path of the file that was read. */
  file_path: string;
  /** Optional budget under which the read occurred (lines, tokens, both). */
  budget?: {
    lines?: number;
    tokens?: number;
  };
  /** ISO timestamp of the read event. */
  read_at: string;
  /** Optional human-readable rationale (e.g. retrieval scout decision). */
  reason?: string;
}

/**
 * One entry in the session lineage.
 *
 * The original Phase 0 shape (`stage`, `artifact_id`, `timestamp`) stays
 * required so existing readers (`tests/artifacts/session-state.test.ts`,
 * `src/conductor/recursive-intent.ts`) continue to function unchanged.
 *
 * COMP-P1-T12 adds optional fields for governance forward-compat:
 *   - `stage_id`: the workflow-spec stage id that produced this entry. For
 *     the default workflow this matches `stage`; for sub-workflows it carries
 *     the namespaced sub-workflow stage id.
 *   - `workflow_spec_id`: the active workflow spec id at run time, so a
 *     re-run against a different spec version is reconstructable from
 *     lineage alone.
 *   - `role`: the role under which the entry's decisions were signed.
 *   - `gate_decisions`: gate outcomes attached to this stage's run, in
 *     registration order. Empty / absent for stages with no gates.
 *   - `source_access_events`: source-access events for retrieval and any
 *     other source-reading stage.
 *
 * All new fields are optional — appending them is purely additive.
 */
export interface LineageEntry {
  stage: Stage;
  artifact_id: string;
  timestamp: string;
  /** Workflow-spec stage id; matches `stage` for the default workflow. */
  stage_id?: string;
  /** Active workflow spec id at run time. */
  workflow_spec_id?: string;
  /** Role that signed the decisions in this entry. */
  role?: LineageRole;
  /** Gate decisions attached to the stage run, in registration order. */
  gate_decisions?: LineageGateDecision[];
  /** Source-access events surfaced from worker boundaries. */
  source_access_events?: SourceAccessEvent[];
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
 * Optional extras attached to a lineage entry beyond the original three
 * fields. The executor (COMP-P1-T7) populates these for stages it drives;
 * the existing inline `runPipelineFromIntent` path still calls
 * `transitionStage` without extras and gets the original shape.
 */
export interface LineageExtras {
  stage_id?: string;
  workflow_spec_id?: string;
  role?: LineageRole;
  gate_decisions?: LineageGateDecision[];
  source_access_events?: SourceAccessEvent[];
}

/**
 * Transition the session to a new stage and optionally record an artifact
 * in the lineage. The optional `extras` parameter populates the
 * COMP-P1-T12 lineage fields (workflow_spec_id, role, gate_decisions,
 * source_access_events). Existing callers that pass only
 * `(state, stage, artifactId)` continue to produce the original shape.
 */
export function transitionStage(
  state: SessionState,
  stage: Stage,
  artifactId?: string,
  extras?: LineageExtras,
): SessionState {
  const now = new Date().toISOString();
  const lineage = [...state.lineage];
  if (artifactId) {
    const entry: LineageEntry = { stage, artifact_id: artifactId, timestamp: now };
    if (extras?.stage_id !== undefined) entry.stage_id = extras.stage_id;
    if (extras?.workflow_spec_id !== undefined) entry.workflow_spec_id = extras.workflow_spec_id;
    if (extras?.role !== undefined) entry.role = extras.role;
    if (extras?.gate_decisions !== undefined) entry.gate_decisions = extras.gate_decisions;
    if (extras?.source_access_events !== undefined) {
      entry.source_access_events = extras.source_access_events;
    }
    lineage.push(entry);
  }
  return {
    ...state,
    current_stage: stage,
    lineage,
    updated_at: now,
  };
}

/**
 * Append a full `LineageEntry` to the session's lineage without changing
 * the current stage. The executor uses this when a gate-only or
 * source-access-only event needs to ride alongside the stage's primary
 * record without forcing a stage transition.
 */
export function appendLineageEntry(state: SessionState, entry: LineageEntry): SessionState {
  return {
    ...state,
    lineage: [...state.lineage, entry],
    updated_at: new Date().toISOString(),
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
