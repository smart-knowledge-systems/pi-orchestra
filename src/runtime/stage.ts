/**
 * Stage — typed function over typed artifacts.
 *
 * Per docs/composability.md "Design — The five primitives — 1. Stage", a
 * Stage is a single async function with a stable contract: it declares the
 * artifact-type ids it consumes, the artifact-type id it produces, and an
 * optional `modelConfig` (for LLM-driven stages) and `control` block (for
 * stages that need governance metadata beyond the schema-validation default).
 *
 * Existing stage controllers (`src/conductor/stage-1.ts`, `expansion.ts`,
 * `retrieval.ts`, `synthesis.ts`, recursive-intent) are wrapped as Stage
 * adapters in COMP-P1-T8 — this file only defines the primitives.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type {
  WorkflowStageControl as WorkflowStageControlShape,
  WorkflowStageFailureHandling,
} from '../artifacts/types.ts';
import type { PhaseModelConfig } from './config.ts';
import type { LineageEntry, SessionState } from './session-state.ts';

// ---------------------------------------------------------------------------
// Stage control — optional governance metadata
// ---------------------------------------------------------------------------

/**
 * Optional governance metadata for a Stage.
 *
 * All fields are optional. The default contract is "schema validation = exit
 * = acceptance, halt on failure" per docs/composability.md "Design — Stage":
 *
 * - `entry_criteria`   — when the stage may begin (default: previous stage's
 *                        output validates).
 * - `exit_criteria`    — when the stage's output is structurally complete
 *                        (default: produced artifact validates).
 * - `acceptance_criteria` — when the output is fit for downstream consumption
 *                          (default: same as exit_criteria; advisor /
 *                          synthesis / execution stages opt in to specify a
 *                          stricter acceptance distinct from exit so a "valid
 *                          but unfit" output can route to a different gate
 *                          outcome than "valid and fit").
 * - `failure_handling` — `'retry' | 'tentative' | 'halt' | 'escalate'`
 *                        (default: `'halt'`). `'tentative'` persists the
 *                        artifact but labels it not-fit-for-downstream until
 *                        a subsequent decision promotes it.
 * - `evidence_requirements` — what must appear in lineage for the stage to be
 *                             auditable (default: stage id + produced
 *                             artifact id).
 *
 * The shape mirrors `WorkflowStageControl` from
 * `src/artifacts/types.ts` so that workflow-spec-declared control merges
 * trivially with Stage-declared defaults at registry boot.
 */
export type StageControl = WorkflowStageControlShape;

export type { WorkflowStageFailureHandling as StageFailureHandling };

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * A telemetry event emitted by a Stage. Phase 2's `runWithAdvisor` helper
 * extends this with advisor-specific fields (mode, iterations, usage); for
 * Phase 1 the shape is intentionally open so adapters don't need to evolve
 * this type as new stages opt in to telemetry.
 */
export interface StageTelemetryEvent {
  stage_id: string;
  event: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export type StageTelemetry = (event: StageTelemetryEvent) => void;

// ---------------------------------------------------------------------------
// Model and advisor resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve a single model call for the active phase.
 *
 * Phase 1 wires this to the existing `getModelText` shape from
 * `extensions/conductor-extension.ts:86–130`. Phase 2 makes the resolver
 * phase-aware by reading `runtime.config.models[phase]` per
 * docs/composability.md "Phase 2".
 */
export type StageModelCall = (systemPrompt: string, userText: string) => Promise<string>;

/**
 * Advisor resolver placeholder. Phase 2 lands the real `runWithAdvisor`
 * helper in `src/runtime/run-with-advisor.ts` and replaces this stub with
 * a structured request/response contract per docs/composability.md
 * "Phase 2 — PhaseModelConfig + runWithAdvisor".
 */
export type StageAdvisorCall = (
  systemPrompt: string,
  userText: string,
  options?: Record<string, unknown>,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Stage context — the seams a Stage's `run()` reaches through
// ---------------------------------------------------------------------------

/**
 * Append a single entry to the session lineage.
 *
 * The shape of `LineageEntry` is extended by COMP-P1-T12 to carry stage id,
 * gate decisions (with the four-way `GateOutcome`), the role that signed
 * each decision, the active `workflow_spec_id`, and source-access events.
 * Stage adapters call this seam; the executor in COMP-P1-T7 owns the
 * underlying session-state mutation.
 */
export type LineageAppend = (entry: LineageEntry) => void;

/**
 * Update an artifact-pointer slot on the session state.
 *
 * Stages that produce intermediate artifacts during a UI loop (e.g. the
 * restatement adapter writing a fresh `intent-capture@1` when the user
 * corrects the restated intent) need to keep the session's pointer slots in
 * sync so downstream stages see the latest artifact id. The executor binds
 * this seam to its working session-state copy.
 */
export type SessionArtifactPointerSetter = (
  key: keyof SessionState['artifacts'],
  id: string,
) => void;

/**
 * StageContext — everything a Stage's `run()` needs from the runtime.
 *
 * Existing controllers reach for: the artifact store (read inputs, write
 * outputs), session-state (lineage append, current artifact pointers),
 * and a model callback. The advisor + telemetry seams are forward-compat
 * placeholders for Phase 2 and the canonical synthesis stage in Phase 3.
 *
 * The context is read-only with respect to its own fields; mutations to
 * session state are routed through `appendLineage`.
 */
export interface StageContext {
  /** Persistent artifact storage. */
  readonly store: ArtifactStore;

  /** Current session state snapshot — read-only inside a Stage. */
  readonly session: SessionState;

  /** Append-only lineage seam. */
  readonly appendLineage: LineageAppend;

  /** Update an artifact-pointer slot on the session state. */
  readonly setArtifactPointer?: SessionArtifactPointerSetter;

  /** Resolve a single model call for the active phase. */
  readonly model: StageModelCall;

  /** Optional advisor resolver. Phase 2 wires the real implementation. */
  readonly advisor?: StageAdvisorCall;

  /** Optional telemetry sink. */
  readonly telemetry?: StageTelemetry;

  /** Optional abort signal forwarded from the host. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Stage result
// ---------------------------------------------------------------------------

/**
 * The return value from `Stage.run()`.
 *
 * `output_artifact_id` is the id of the produced artifact whose
 * `artifact_type` matches the Stage's declared `output`. Stages that emit
 * intermediate or follow-up artifacts (e.g. expansion writing both an
 * `expansion-input` and an `intent-spec`) record them in
 * `additional_artifact_ids`; the workflow executor consumes the primary
 * output and the additional ids feed lineage.
 *
 * `failure_handling` overrides the Stage's declared `control.failure_handling`
 * for this run only — used when a stage decides at runtime that its output
 * is `tentative` even though the schema validates.
 */
export interface StageResult {
  output_artifact_id: string;
  additional_artifact_ids?: string[];
  failure_handling?: WorkflowStageFailureHandling;
}

// ---------------------------------------------------------------------------
// Stage interface
// ---------------------------------------------------------------------------

/**
 * Stage — typed function over typed artifacts.
 *
 * - `InId`  — the union of artifact-type ids the stage consumes.
 * - `OutId` — the artifact-type id (or pipe-delimited union of ids) the
 *             stage produces.
 *
 * The generic parameters carry the artifact-type ids as string literal
 * types so the workflow registry can validate at boot that every stage's
 * declared inputs and output match the surrounding workflow spec.
 *
 * `gate` is intentionally absent here. COMP-P1-T4 lands `GateSpec` in
 * `src/runtime/gate.ts`; gate composition for a stage happens through the
 * workflow spec's `stages[].gates` field and the registry, not as a per-
 * Stage object reference.
 */
export interface Stage<InId extends string = string, OutId extends string = string> {
  /** Stable identifier — matches `stages[].id` in the workflow spec. */
  readonly id: string;

  /** Artifact-type ids this stage requires as input. */
  readonly inputs: readonly InId[];

  /** Artifact-type id this stage produces. May encode a union ("a | b"). */
  readonly output: OutId;

  /** Optional model configuration. Required for LLM-driven stages. */
  readonly modelConfig?: PhaseModelConfig;

  /** Optional governance metadata. See StageControl docs for defaults. */
  readonly control?: StageControl;

  /** Execute the stage. Reads/writes via `ctx.store`; returns the new artifact id. */
  run(ctx: StageContext): Promise<StageResult>;
}
