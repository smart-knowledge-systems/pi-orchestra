/**
 * Gate — HITL/override seam with four-way outcome.
 *
 * Per docs/composability.md "Design — The five primitives — 3. Gate", a Gate
 * runs after a Stage and before the workflow advances. It can:
 *
 *   1. Present a review surface to the conductor (the existing
 *      `summarizeInspection` / `summarizeEvidencePlan` patterns).
 *   2. Accept a typed override op (the discriminated-union pattern from
 *      `src/conductor/evidence-overrides.ts`).
 *   3. Validate the proposed op against the current artifact graph.
 *   4. Apply the op (mutating downstream artifact state through the stage
 *      context's store / lineage seams).
 *   5. Resolve to one of four outcomes: `accepted`, `rejected_governance`,
 *      `rejected_technical`, or `escalated`.
 *
 * Gates compose by stage id through the workflow registry — multiple gates may
 * run after the same stage, in registration order. Mandatory-control gates
 * (those listed in `WorkflowSpecV1.mandatory_controls`) cannot be removed or
 * shadowed by an extension; the registry rejects any registration that would
 * do so at boot. That property is the registry's responsibility, not this
 * file's, so the types here stay minimal and the conformance check lives in
 * `src/runtime/registry.ts` (COMP-P1-T5).
 *
 * The first concrete `GateOp` lands in COMP-P1-T10 when
 * `src/conductor/evidence-overrides.ts` re-exports its `EvidenceOverride`
 * union as the canonical reference implementation.
 */

import type { StageContext } from './stage.ts';

// ---------------------------------------------------------------------------
// Gate operations — extensible base for stage-specific override shapes
// ---------------------------------------------------------------------------

/**
 * Base type for a typed override operation accepted by a Gate.
 *
 * Each concrete op carries a discriminator string in `op` and any additional
 * fields its stage requires (see the `EvidenceOverride` discriminated union
 * in `src/conductor/evidence-overrides.ts` for the canonical example). Gates
 * are expected to narrow `op` from the base type to a stage-specific union;
 * `GateSpec` is generic over the op shape so each gate's `validateOverride`
 * and `applyOverride` operate on the narrowed union directly.
 */
export interface GateOp {
  readonly op: string;
}

/**
 * Result of validating a `GateOp` before it is applied.
 *
 * The shape mirrors `ValidationResult` from `src/artifacts/schemas.ts` so
 * gates and artifact validators can compose error messages without
 * translation. A gate that needs to surface a structured rejection (e.g. a
 * governance-policy breach distinct from a technical parse failure) returns
 * a non-empty `errors` array AND emits the corresponding `GateOutcome` from
 * its caller — `validateOverride` is structural-only; routing the four-way
 * outcome happens at the call site.
 */
export interface GateOpValidation {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Presentation — what the gate hands to the conductor for review
// ---------------------------------------------------------------------------

/**
 * The review surface a gate presents to the conductor before accepting an
 * override.
 *
 * `summary` is the human-readable line conductor surfaces render directly.
 * `details` is an open-shaped payload the gate can populate with structured
 * data (the existing `summarizeEvidencePlan` / `summarizeInspection` helpers
 * already produce shapes compatible with this slot). The gate is responsible
 * for keeping `details` free of raw repository content — the conductor
 * boundary preserves text-safe access only.
 */
export interface GatePresentation {
  summary: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Outcome — the four-way discriminated union routes after the gate runs
// ---------------------------------------------------------------------------

/**
 * Where an `escalated` outcome is routed.
 *
 * Today piorx is a single-user CLI and the user fills every authority role,
 * so `'user'` is the only routing target ever produced in practice. The
 * other two values are forward-compatible with the multi-stakeholder
 * governance roadmap enumerated in
 * docs/composability.md "Governance — deferred to roadmap", where Workflow
 * Owner and Policy Authority become distinct roles separated from the
 * Reviewer / Operator at run time.
 */
export type GateEscalationTarget = 'workflow_owner' | 'policy_authority' | 'user';

/**
 * Four-way outcome of running a Gate after a Stage.
 *
 * The split between technical failure and governance failure is load-bearing.
 * A malformed override op or a parser timeout (`rejected_technical`) is
 * retry-eligible; a policy violation or a `mandatory_controls` breach
 * (`rejected_governance`) is never silently retried. `escalated` is the
 * outcome when the gate cannot resolve the situation under its own
 * authority and surfaces upward; the routing field is forward-compatible
 * with future enterprise deployments where roles separate.
 *
 * `accepted.applied` carries the ordered list of ops the gate actually
 * applied — useful for lineage and for any downstream stage that needs to
 * reconstruct what the user-confirmed delta was.
 */
export type GateOutcome =
  | { kind: 'accepted'; applied?: GateOp[] }
  | { kind: 'rejected_governance'; reason: string }
  | { kind: 'rejected_technical'; reason: string }
  | { kind: 'escalated'; to: GateEscalationTarget; reason: string };

// ---------------------------------------------------------------------------
// Gate specification
// ---------------------------------------------------------------------------

/**
 * A Gate's declarative contract.
 *
 * - `id` matches the gate id declared in `WorkflowSpecV1.stages[].gates` and
 *   referenced by `WorkflowSpecV1.mandatory_controls`. Ids are stable across
 *   workflow versions so registry resolution and lineage records line up.
 * - `presents` builds the review surface for the conductor.
 * - `validateOverride` runs structural checks on a proposed op without
 *   mutating state.
 * - `applyOverride` mutates downstream artifact state through `StageContext`.
 *   Implementations route their final disposition through one of the four
 *   `GateOutcome` variants — that routing happens at the call site, not
 *   inside `applyOverride`, so the executor can attach the outcome to
 *   lineage uniformly across gates.
 *
 * The interface is generic over `Op extends GateOp` so concrete gates narrow
 * the override type to their own discriminated union. The first concrete
 * implementation (`evidence.review`) lands in COMP-P1-T10; the registry
 * lands in COMP-P1-T5 and binds gates to stage ids.
 */
export interface GateSpec<Op extends GateOp = GateOp> {
  /** Stable identifier — matches the gate id in the workflow spec. */
  readonly id: string;

  /** Build the review surface the conductor renders. */
  presents(ctx: StageContext): Promise<GatePresentation>;

  /** Structurally validate a proposed op. Pure — no side effects. */
  validateOverride(op: Op, ctx: StageContext): GateOpValidation;

  /** Apply a validated op. Mutates artifact state through `ctx`. */
  applyOverride(op: Op, ctx: StageContext): Promise<void>;
}
