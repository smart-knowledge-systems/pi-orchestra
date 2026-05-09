/**
 * WorkflowExecutor — runtime executor over a loaded workflow spec.
 *
 * Per `docs/composability.md` "Phase 1 — Scaffolding" and `auto-implement-
 * composability.md` COMP-P1-T7, the executor walks a `WorkflowSpecV1`'s
 * linear-with-conditional-edges DAG: it resolves Stage adapters from the
 * registry, runs each stage's `run()`, runs every gate registered against
 * the stage in registration order, routes the four-way `GateOutcome`, and
 * navigates to the next stage by evaluating each outgoing edge's `when`
 * predicate against the artifact graph produced so far. Recursive promotion
 * is invoked through `run(..., { startStageId })` with the workflow spec's
 * `recursive_promotion_target` — there are no hard-coded stage references.
 *
 * The executor replaces the inline orchestration in
 * `extensions/conductor-extension.ts:1040–1167` (COMP-P1-T11). For Phase 1
 * the executor is purely additive — it stands up the seam without changing
 * the runtime path that the existing E2E (`tests/interaction/agentic-
 * retrieval-flow.test.ts`) exercises, preserving byte-identical Phase 1
 * gate behavior.
 *
 * Gate handling is delegated to a host-supplied `GateBroker` callback. The
 * broker is responsible for: calling `gate.presents(ctx)` to build the
 * review surface, surfacing it to whichever conductor or UI layer is in
 * effect, validating proposed ops via `gate.validateOverride`, applying
 * accepted ops via `gate.applyOverride`, and resolving to one of the four
 * `GateOutcome` variants. The default broker auto-accepts with no applied
 * ops — sufficient for tests that exercise the flow without a UI.
 */

import { ArtifactStoreError, type ArtifactStore } from '../artifacts/store.ts';
import {
  ARTIFACT_TYPES,
  type Artifact,
  type ArtifactType,
  type WorkflowEdgeSpec,
  type WorkflowSpecBody,
  type WorkflowSpecV1,
  type WorkflowStageSpec,
} from '../artifacts/types.ts';
import type { GateOutcome, GateOp, GateSpec } from './gate.ts';
import type { WorkflowRegistry } from './registry.ts';
import {
  appendLineageEntry,
  setArtifactPointer,
  transitionStage,
  type LineageEntry,
  type LineageExtras,
  type LineageGateDecision,
  type LineageRole,
  type SessionState,
  type SourceAccessEvent,
  type Stage as SessionStage,
} from './session-state.ts';
import type {
  LineageAppend,
  SessionArtifactPointerSetter,
  Stage,
  StageAdvisorCall,
  StageContext,
  StageModelCall,
  StageResult,
  StageTelemetry,
} from './stage.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised by the executor when the workflow cannot proceed: a stage adapter
 * is missing, a gate's outcome routes to a non-acceptance terminal state,
 * or a predicate references a path that does not resolve.
 */
export class WorkflowExecutorError extends Error {
  readonly outcome?: GateOutcome;
  constructor(message: string, outcome?: GateOutcome) {
    super(`WorkflowExecutor: ${message}`);
    this.name = 'WorkflowExecutorError';
    if (outcome) this.outcome = outcome;
  }
}

// ---------------------------------------------------------------------------
// Gate broker
// ---------------------------------------------------------------------------

/**
 * Callback the executor invokes to drive a Gate. The broker is the seam
 * between the gate's typed contract (`GateSpec`) and whatever conductor
 * surface is in effect — a CLI prompt, an automated test, a future
 * extension-author UI.
 *
 * The broker is expected to:
 *   1. Call `gate.presents(ctx)` to build the review surface.
 *   2. Render that surface to the user (or otherwise resolve a decision).
 *   3. For each proposed override op: call `gate.validateOverride(op, ctx)`
 *      and, if valid, `gate.applyOverride(op, ctx)`.
 *   4. Return one of the four `GateOutcome` variants.
 *
 * The default broker auto-accepts with no applied ops — sufficient for the
 * Phase 1 happy-path tests that exercise the executor without a UI.
 */
export type GateBroker = (gate: GateSpec, ctx: StageContext) => Promise<GateOutcome>;

const DEFAULT_GATE_BROKER: GateBroker = async (_gate, _ctx) => ({ kind: 'accepted' });

// ---------------------------------------------------------------------------
// Stage runtime record
// ---------------------------------------------------------------------------

/**
 * What the executor records for each stage that completed during a run.
 *
 * The executor keeps these in a list and exposes them through the run
 * result so callers (lineage consumers, predicate evaluators, downstream
 * orchestration in T11) can reconstruct the path the workflow took.
 */
export interface StageRunRecord {
  stage_id: string;
  output_artifact_id: string;
  output_artifact_type: ArtifactType;
  output_artifact: Artifact;
  additional_artifact_ids: string[];
  gate_decisions: LineageGateDecision[];
  failure_handling: string | undefined;
}

/**
 * The result returned from `executor.run(...)`.
 *
 * `final_artifact_id` and `final_artifact_type` describe the last produced
 * artifact (the one whose stage had no outgoing edge whose predicate
 * resolved). `stage_runs` is the ordered list of stages that fired.
 */
export interface WorkflowRunResult {
  workflow_spec_id: string;
  workflow_spec_artifact_id: string;
  final_stage_id: string;
  final_artifact_id: string;
  final_artifact_type: ArtifactType;
  stage_runs: StageRunRecord[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Per-stage extras the executor merges into the StageContext for the
 * adapters that need services beyond the base seam (retrieval needs the
 * runtime config + a retriever-agent model callback; synthesis needs an
 * optional task-type override; execution needs the `allowEdits` latch).
 *
 * The executor does not interpret these fields — it simply spreads them
 * into the StageContext. Adapters cast their context to
 * `StageAdapterContext` (see `src/conductor/stage-adapters.ts`) to read
 * what they need.
 */
export type StageContextExtras = Record<string, unknown>;

export interface WorkflowExecutorOptions {
  registry: WorkflowRegistry;
  store: ArtifactStore;
  /**
   * Caller-owned, mutable session state. The executor calls
   * `transitionStage` and `appendLineageEntry` on the working copy so the
   * caller can persist it after each run. `current_stage` is updated as
   * stages fire; lineage is appended.
   */
  session: SessionState;
  /**
   * Resolves a single model call for the active phase.
   *
   * Pre-COMP-P2-T3 hosts pass a single `StageModelCall` here and the
   * executor injects it into every Stage's `ctx.model`. Phase-aware hosts
   * pass `modelForPhase` as well; when both are supplied, the executor
   * prefers `modelForPhase(stageId)` per stage and falls back to `model`
   * only when `modelForPhase` returns `undefined`.
   */
  model: StageModelCall;
  /**
   * Optional phase-aware model resolver. Returns the `StageModelCall` to
   * inject into a Stage's `ctx.model`; return `undefined` to fall back to
   * the static `model` seam. This is the canonical Phase 2 wiring per
   * `docs/composability.md` "Phase 2 — `getModelText` takes a phase
   * parameter".
   */
  modelForPhase?: (phase: string) => StageModelCall | undefined;
  /** Optional advisor resolver. Phase 2 wires the real implementation. */
  advisor?: StageAdvisorCall;
  /** Optional telemetry sink. */
  telemetry?: StageTelemetry;
  /** Optional abort signal forwarded from the host. */
  signal?: AbortSignal;
  /** Optional gate broker. Defaults to auto-accept with no applied ops. */
  gateBroker?: GateBroker;
  /**
   * Extras spread into every StageContext before invoking
   * `stage.run(ctx)`. The adapters in `src/conductor/stage-adapters.ts`
   * cast to `StageAdapterContext` to read the service handles.
   */
  contextExtras?: StageContextExtras;
  /**
   * Role used to sign decisions that originate from this run. Defaults to
   * `requestor` (the user driving the workflow). Forward-compatible with
   * multi-stakeholder governance — when separate Reviewer / Execution
   * Authority roles arrive, the executor accepts a different role per call.
   */
  role?: LineageRole;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const KNOWN_ARTIFACT_TYPES = new Set<string>(ARTIFACT_TYPES);

/**
 * Virtual edge target signaling that the (sub-)workflow should terminate at
 * the originating stage and surface that stage's output as the final
 * artifact. Per `docs/composability.md` "Workflows also nest", `__exit__`
 * lets a sub-workflow promote any intermediate stage's output without an
 * explicit passthrough stage. The constant is intentionally a string literal
 * so it can appear verbatim in workflow-spec YAML edges.
 */
export const EXIT_SENTINEL = '__exit__';

/**
 * Maps an artifact-type id to the corresponding session-state slot. Returns
 * `null` for artifact types that do not have a slot (workflow-spec,
 * recursive-intent — neither is consumed by a downstream stage in the
 * default workflow).
 */
function slotForArtifactType(type: ArtifactType): keyof SessionState['artifacts'] | null {
  switch (type) {
    case 'piorx/intent-capture@1':
      return 'intent_capture_id';
    case 'piorx/intent-restatement@1':
      return 'intent_restatement_id';
    case 'piorx/expansion-input@1':
      return 'expansion_input_id';
    case 'piorx/intent-spec@1':
      return 'intent_spec_id';
    case 'piorx/retrieval-index@1':
      return 'retrieval_index_id';
    case 'piorx/evidence-plan@1':
      return 'evidence_plan_id';
    case 'piorx/evidence-bundle@1':
      return 'evidence_bundle_id';
    case 'piorx/analysis-report@1':
    case 'piorx/change-spec@1':
      return 'synthesis_id';
    case 'piorx/execution-report@1':
      return 'execution_report_id';
    case 'piorx/recursive-intent@1':
    case 'piorx/workflow-spec@1':
      return null;
  }
}

/**
 * Split a stage's `output` declaration into its constituent artifact-type
 * ids. Mirrors the helper inside `src/runtime/registry.ts`; duplicated here
 * so the executor stays free of registry-internal exports.
 */
function splitOutputUnion(output: string): string[] {
  return output
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Cast a workflow stage id to the session-state `Stage` type when it
 * matches one of the known stage names; otherwise return `'idle'` so the
 * session state stays valid even when an extension introduces a stage id
 * outside the original six-stage default.
 */
function asSessionStage(stageId: string): SessionStage {
  switch (stageId) {
    case 'idle':
    case 'restatement':
    case 'expansion':
    case 'retrieval':
    case 'evidence':
    case 'synthesis':
    case 'execution':
      return stageId;
    default:
      return 'idle';
  }
}

/**
 * Pull the workflow spec's `artifact_id` if present (specs loaded through
 * `parseWorkflowMarkdown` carry one); fall back to the logical workflow id
 * for purely-in-memory specs constructed in tests.
 */
function workflowArtifactId(spec: WorkflowSpecV1): string {
  return spec.artifact_id ?? spec.id;
}

/**
 * Promote an inline `WorkflowSpecBody` (from a stage's `workflow:` block) to
 * a fully-typed `WorkflowSpecV1` so the recursive descent path can run it
 * through the same `runSpec` machinery as a top-level workflow.
 *
 * The synthesized `artifact_id` is deterministic and namespaced under the
 * parent stage so lineage entries from inline sub-workflows can be traced
 * back to the originating parent without ambiguity.
 */
function materializeInlineSpec(
  parentSpec: WorkflowSpecV1,
  parentStageId: string,
  body: WorkflowSpecBody,
): WorkflowSpecV1 {
  return {
    ...body,
    artifact_type: 'piorx/workflow-spec@1',
    artifact_id: `${workflowArtifactId(parentSpec)}::${parentStageId}::inline`,
  };
}

/**
 * Predicate evaluator for `edge.when`. Supports the bounded subset of
 * operators the default workflow needs today (`eq`); additional operators
 * can be added without changing the executor surface.
 *
 * Paths are JSONPath-style strings starting with `$.` followed by a
 * stage id and a field path: `$.<stage_id>.<field>`. The stage's output
 * artifact is the resolution root; nested fields follow with `.<key>`.
 *
 * Non-string scalars (booleans, numbers, null) and unprefixed strings are
 * treated as literal values, matching the YAML scalar parsing in
 * `src/runtime/workflow-loader.ts`. Quoted strings parse identically — the
 * executor never re-parses YAML; it only inspects the already-decoded
 * value.
 */
function evaluatePredicate(
  when: Record<string, unknown> | undefined,
  records: readonly StageRunRecord[],
): boolean {
  if (!when || Object.keys(when).length === 0) return true;
  for (const [op, args] of Object.entries(when)) {
    if (op === 'eq') {
      if (!Array.isArray(args) || args.length !== 2) {
        throw new WorkflowExecutorError(
          `predicate "eq" expects an array of two arguments, got ${JSON.stringify(args)}`,
        );
      }
      const left = resolvePathOrLiteral(args[0], records);
      const right = resolvePathOrLiteral(args[1], records);
      if (left !== right) return false;
    } else if (op === 'neq') {
      if (!Array.isArray(args) || args.length !== 2) {
        throw new WorkflowExecutorError(
          `predicate "neq" expects an array of two arguments, got ${JSON.stringify(args)}`,
        );
      }
      const left = resolvePathOrLiteral(args[0], records);
      const right = resolvePathOrLiteral(args[1], records);
      if (left === right) return false;
    } else {
      throw new WorkflowExecutorError(`unsupported predicate operator "${op}"`);
    }
  }
  return true;
}

function resolvePathOrLiteral(value: unknown, records: readonly StageRunRecord[]): unknown {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('$.')) return value;
  const segments = value.slice(2).split('.');
  if (segments.length < 1 || segments[0] === '') {
    throw new WorkflowExecutorError(`predicate path "${value}" is malformed`);
  }
  const stageId = segments[0]!;
  const record = records.find((r) => r.stage_id === stageId);
  if (!record) {
    throw new WorkflowExecutorError(
      `predicate path "${value}" references stage "${stageId}" which has not produced an output yet`,
    );
  }
  let cursor: unknown = record.output_artifact;
  for (let i = 1; i < segments.length; i++) {
    const key = segments[i]!;
    if (cursor === null || typeof cursor !== 'object') {
      throw new WorkflowExecutorError(
        `predicate path "${value}" cannot resolve "${key}" against a non-object value`,
      );
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Translate a `GateOutcome` to its lineage-record shape. The gate's
 * `applied?: GateOp[]` shrinks to `applied_ops?: string[]` (op
 * discriminator strings only); raw op payloads stay on the artifact graph.
 */
function lineageGateDecision(gateId: string, outcome: GateOutcome): LineageGateDecision {
  const decision: LineageGateDecision = { gate_id: gateId, kind: outcome.kind };
  switch (outcome.kind) {
    case 'accepted':
      if (outcome.applied && outcome.applied.length > 0) {
        decision.applied_ops = outcome.applied.map((op: GateOp) => op.op);
      }
      break;
    case 'rejected_governance':
    case 'rejected_technical':
      decision.reason = outcome.reason;
      break;
    case 'escalated':
      decision.reason = outcome.reason;
      decision.escalated_to = outcome.to;
      break;
  }
  return decision;
}

/**
 * The executor.
 *
 * `run()` walks the workflow's edge list starting at `startStageId` (or
 * the first declared stage if omitted), invoking each stage adapter,
 * routing each gate's outcome, and navigating to the next stage based on
 * the first edge whose predicate evaluates to true.
 */
export class WorkflowExecutor {
  private readonly registry: WorkflowRegistry;
  private readonly store: ArtifactStore;
  private session: SessionState;
  private readonly model: StageModelCall;
  private readonly modelForPhase?: (phase: string) => StageModelCall | undefined;
  private readonly advisor?: StageAdvisorCall;
  private readonly telemetry?: StageTelemetry;
  private readonly signal?: AbortSignal;
  private readonly gateBroker: GateBroker;
  private readonly contextExtras: StageContextExtras;
  private readonly role: LineageRole;

  constructor(options: WorkflowExecutorOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.session = options.session;
    this.model = options.model;
    if (options.modelForPhase) this.modelForPhase = options.modelForPhase;
    this.advisor = options.advisor;
    this.telemetry = options.telemetry;
    this.signal = options.signal;
    this.gateBroker = options.gateBroker ?? DEFAULT_GATE_BROKER;
    this.contextExtras = options.contextExtras ?? {};
    this.role = options.role ?? 'requestor';
  }

  /**
   * The current session state — mutated as `run()` progresses. Callers
   * persist this to disk between runs.
   */
  get sessionState(): SessionState {
    return this.session;
  }

  /**
   * Execute the workflow.
   *
   * @param workflowId  Workflow spec id (e.g. `piorx/workflow/default@1`).
   * @param options.startStageId  Optional starting stage. Defaults to the
   *   first stage declared in the spec. Pass
   *   `spec.recursive_promotion_target` to drive a recursive restart
   *   without referring to any specific stage id in code.
   */
  async run(workflowId: string, options?: { startStageId?: string }): Promise<WorkflowRunResult> {
    const spec = this.registry.resolveWorkflow(workflowId);
    return this.runSpec(spec, options);
  }

  /**
   * Walk an already-resolved workflow spec. Shared between the public
   * `run(workflowId)` entry and the private sub-workflow descent path —
   * inline `workflow:` blocks are not registered in the registry, so the
   * descent path constructs a `WorkflowSpecV1` from the inline body and
   * passes it directly here.
   *
   * `namespace` (optional) is the parent stage id chain under which Stage
   * adapters and gates resolve, per `docs/composability.md` "Workflows also
   * nest" — sub-workflow stage ids namespace under the parent so they don't
   * collide with top-level stages of the same id (`synthesis.draft`,
   * `synthesis.critique`). The registry's `resolveStage` / `gatesFor` falls
   * back to the bare id if no namespaced adapter is registered, so the
   * common case of "register one adapter, reuse across positions" keeps
   * working without ceremony.
   *
   * `lineageBuffer` (optional) diverts stage entries that would normally be
   * appended to `session.lineage` into a caller-supplied array instead.
   * Used by `runSubWorkflowStage` to capture the sub-workflow's lineage as
   * a sub-tree under the parent stage's entry rather than intermixing with
   * the flat parent sequence (COMP-P7-T3 acceptance criterion: an audit
   * walker can reconstruct the parent/child workflow hierarchy from lineage
   * alone).
   */
  private async runSpec(
    spec: WorkflowSpecV1,
    options?: { startStageId?: string; namespace?: string; lineageBuffer?: LineageEntry[] },
  ): Promise<WorkflowRunResult> {
    if (spec.stages.length === 0) {
      throw new WorkflowExecutorError(`workflow "${spec.id}" has no stages declared`);
    }

    const startStageId = options?.startStageId ?? spec.stages[0]!.id;
    if (!spec.stages.some((s) => s.id === startStageId)) {
      throw new WorkflowExecutorError(
        `workflow "${spec.id}": startStageId "${startStageId}" does not match any declared stage`,
      );
    }
    const namespace = options?.namespace;
    const lineageBuffer = options?.lineageBuffer;

    const records: StageRunRecord[] = [];
    let currentStageId: string | undefined = startStageId;

    while (currentStageId) {
      if (this.signal?.aborted) {
        throw new WorkflowExecutorError(
          `workflow "${spec.id}": aborted before stage "${currentStageId}"`,
        );
      }

      const stageSpec = spec.stages.find((s) => s.id === currentStageId);
      if (!stageSpec) {
        throw new WorkflowExecutorError(
          `workflow "${spec.id}": no stage spec for id "${currentStageId}"`,
        );
      }

      const declaresSubWorkflow =
        stageSpec.workflow_ref !== undefined || stageSpec.workflow !== undefined;

      let record: StageRunRecord;
      if (declaresSubWorkflow) {
        record = await this.runSubWorkflowStage(spec, stageSpec, records, namespace, lineageBuffer);
      } else {
        const stageImpl = this.registry.resolveStage(currentStageId, namespace);
        if (!stageImpl) {
          const namespacedDescription = namespace
            ? ` (looked up under namespace "${namespace}")`
            : '';
          throw new WorkflowExecutorError(
            `workflow "${spec.id}": no Stage implementation registered for "${currentStageId}"${namespacedDescription}`,
          );
        }
        record = await this.runStage(spec, stageSpec, stageImpl, records, namespace, lineageBuffer);
      }
      records.push(record);

      const next = this.selectNextStage(spec, currentStageId, records);
      if (!next) break;
      // `__exit__` is the virtual edge target documented in
      // `docs/composability.md` "Workflows also nest" — it ends the
      // (sub-)workflow at the current stage and promotes that stage's
      // output as the final artifact, without requiring an explicit
      // passthrough stage. The most recent record is already in `records`,
      // so breaking here makes its `output_artifact` the final artifact and
      // its stage id the `final_stage_id`.
      if (next === EXIT_SENTINEL) break;
      currentStageId = next;
    }

    const final = records[records.length - 1];
    if (!final) {
      throw new WorkflowExecutorError(
        `workflow "${spec.id}": no stages completed (start was "${startStageId}")`,
      );
    }
    return {
      workflow_spec_id: spec.id,
      workflow_spec_artifact_id: workflowArtifactId(spec),
      final_stage_id: final.stage_id,
      final_artifact_id: final.output_artifact_id,
      final_artifact_type: final.output_artifact_type,
      stage_runs: records,
    };
  }

  // -----------------------------------------------------------------------
  // Internal — single-stage execution
  // -----------------------------------------------------------------------

  private async runStage(
    spec: WorkflowSpecV1,
    stageSpec: WorkflowStageSpec,
    stageImpl: Stage,
    prior: readonly StageRunRecord[],
    namespace: string | undefined,
    lineageBuffer: LineageEntry[] | undefined,
  ): Promise<StageRunRecord> {
    const sourceAccessEvents: SourceAccessEvent[] = [];
    const ctx = this.buildStageContext(stageImpl.id, sourceAccessEvents);

    const result = await stageImpl.run(ctx);
    const { artifact, type } = await this.loadOutput(stageSpec, result);
    this.applySessionPointers(type, result);

    const gateDecisions = await this.runGates(spec, stageSpec, ctx, prior, namespace);

    this.commitStageRecord({
      stageSpec,
      workflowSpecId: spec.id,
      outputArtifactId: result.output_artifact_id,
      gateDecisions,
      sourceAccessEvents,
      lineageBuffer,
    });

    return {
      stage_id: stageSpec.id,
      output_artifact_id: result.output_artifact_id,
      output_artifact_type: type,
      output_artifact: artifact,
      additional_artifact_ids: result.additional_artifact_ids ?? [],
      gate_decisions: gateDecisions,
      failure_handling: result.failure_handling ?? stageImpl.control?.failure_handling,
    };
  }

  /**
   * Run a stage that declares a sub-workflow (either `workflow_ref` pointing
   * at a registered workflow, or an inline `workflow:` body).
   *
   * Per `docs/composability.md` "Workflows also nest": the sub-workflow's
   * final artifact becomes the parent stage's output; sub-workflow gates run
   * during descent (handled by the recursive `runSpec` call) and the parent
   * stage's gates run after descent returns. Each sub-stage's lineage entry
   * carries the sub-workflow's `workflow_spec_id` (set by the recursive
   * `transitionStage` call inside the descent), forward-compatible with
   * COMP-P7-T3's sub-tree representation.
   */
  private async runSubWorkflowStage(
    parentSpec: WorkflowSpecV1,
    parentStageSpec: WorkflowStageSpec,
    prior: readonly StageRunRecord[],
    parentNamespace: string | undefined,
    parentLineageBuffer: LineageEntry[] | undefined,
  ): Promise<StageRunRecord> {
    const subSpec = this.resolveSubWorkflowSpec(parentSpec, parentStageSpec);

    // Sub-workflow stage ids namespace under the parent stage id chain. For
    // a top-level parent the namespace is just the parent stage's id; for a
    // sub-workflow nested inside a sub-workflow the namespaces concatenate
    // (`outer.inner.parent`). Per `docs/composability.md` "Workflows also
    // nest", this is what lets `synthesis.draft` and `synthesis.critique`
    // co-exist with a top-level `draft` Stage adapter without collisions.
    const subNamespace = parentNamespace
      ? `${parentNamespace}.${parentStageSpec.id}`
      : parentStageSpec.id;

    // Capture the sub-workflow's lineage in a fresh buffer so it attaches as
    // `sub_lineage` on the parent stage's lineage entry rather than
    // intermixing with the flat parent sequence (COMP-P7-T3 acceptance:
    // "Audit walkers can reconstruct the parent/child workflow hierarchy
    // from lineage alone"). Each sub-entry carries its own `workflow_spec_id`
    // (set by the recursive `commitStageRecord` call inside the descent),
    // so version traceability survives the tree-flattening any consumer
    // might do.
    const subLineageBuffer: LineageEntry[] = [];
    const subResult = await this.runSpec(subSpec, {
      namespace: subNamespace,
      lineageBuffer: subLineageBuffer,
    });

    // Adopt the sub-workflow's final artifact as the parent stage's output.
    // `loadOutput` validates the produced type matches one of the parent
    // stage's declared `output` candidates — a sub-workflow whose terminal
    // artifact disagrees with the parent stage's contract surfaces here.
    const surrogate: StageResult = { output_artifact_id: subResult.final_artifact_id };
    const { artifact, type } = await this.loadOutput(parentStageSpec, surrogate);
    this.applySessionPointers(type, surrogate);

    // Parent gates run after the sub-workflow returns. The context's
    // model/advisor seams resolve against the parent stage id so a phase-
    // aware host wires gate-side advisor calls to the parent phase, not the
    // sub-workflow's last stage. Gate resolution honors the OUTER namespace
    // (the parent's namespace) — parent gates belong to the parent's
    // composition position, not to the sub-workflow we just descended into.
    const sourceAccessEvents: SourceAccessEvent[] = [];
    const ctx = this.buildStageContext(parentStageSpec.id, sourceAccessEvents);
    const gateDecisions = await this.runGates(
      parentSpec,
      parentStageSpec,
      ctx,
      prior,
      parentNamespace,
    );

    this.commitStageRecord({
      stageSpec: parentStageSpec,
      workflowSpecId: parentSpec.id,
      outputArtifactId: surrogate.output_artifact_id,
      gateDecisions,
      sourceAccessEvents,
      subLineage: subLineageBuffer,
      lineageBuffer: parentLineageBuffer,
    });

    return {
      stage_id: parentStageSpec.id,
      output_artifact_id: surrogate.output_artifact_id,
      output_artifact_type: type,
      output_artifact: artifact,
      additional_artifact_ids: [],
      gate_decisions: gateDecisions,
      failure_handling: undefined,
    };
  }

  /**
   * Materialize a `WorkflowSpecV1` for a stage's sub-workflow. `workflow_ref`
   * points at a registered workflow and is resolved through the registry
   * (the registry's boot-time `checkWorkflowRefStage` already verified
   * existence + authority + control propagation). An inline `workflow:`
   * body is a `WorkflowSpecBody` without artifact-base fields; the executor
   * synthesizes a deterministic `artifact_id` so lineage entries from the
   * sub-workflow can be correlated back to the parent stage.
   */
  private resolveSubWorkflowSpec(
    parentSpec: WorkflowSpecV1,
    parentStageSpec: WorkflowStageSpec,
  ): WorkflowSpecV1 {
    if (parentStageSpec.workflow_ref) {
      return this.registry.resolveWorkflow(parentStageSpec.workflow_ref);
    }
    const body = parentStageSpec.workflow;
    if (!body) {
      throw new WorkflowExecutorError(
        `workflow "${parentSpec.id}" stage "${parentStageSpec.id}": runSubWorkflowStage called without workflow_ref or inline workflow`,
      );
    }
    return materializeInlineSpec(parentSpec, parentStageSpec.id, body);
  }

  /**
   * Walk the stage's registered gates in registration order, drive each
   * through the broker, route the four-way outcome, and surface a decision
   * list for the lineage record.
   *
   * - `accepted` — continue.
   * - `rejected_technical` — throw, with the gate's reason. Phase 1 surfaces
   *   technical failures as terminal; T11 may layer retry handling on top.
   * - `rejected_governance` — throw. Governance rejections are never
   *   silently retried per `docs/composability.md` "3. Gate".
   * - `escalated` — throw and bubble the routing target up. Today the user
   *   is the only authority for escalation, so the broker (UI) typically
   *   resolves the situation before returning; an explicit `escalated`
   *   outcome means even the user could not.
   */
  private async runGates(
    spec: WorkflowSpecV1,
    stageSpec: WorkflowStageSpec,
    ctx: StageContext,
    _prior: readonly StageRunRecord[],
    namespace: string | undefined,
  ): Promise<LineageGateDecision[]> {
    const decisions: LineageGateDecision[] = [];
    const gates = this.registry.gatesFor(stageSpec.id, namespace);
    const declared = stageSpec.gates ?? [];
    for (const gate of gates) {
      // Phase 1 conservative: only run gates declared by the spec for this
      // stage. Extension-author gates that aren't declared but are
      // registered against the stage id stay dormant until the spec lists
      // them (a future stage-override path will lift this restriction).
      if (declared.length > 0 && !declared.includes(gate.id)) continue;
      const outcome = await this.gateBroker(gate, ctx);
      decisions.push(lineageGateDecision(gate.id, outcome));
      switch (outcome.kind) {
        case 'accepted':
          continue;
        case 'rejected_technical':
          throw new WorkflowExecutorError(
            `workflow "${spec.id}" stage "${stageSpec.id}" gate "${gate.id}" rejected_technical: ${outcome.reason}`,
            outcome,
          );
        case 'rejected_governance':
          throw new WorkflowExecutorError(
            `workflow "${spec.id}" stage "${stageSpec.id}" gate "${gate.id}" rejected_governance: ${outcome.reason}`,
            outcome,
          );
        case 'escalated':
          throw new WorkflowExecutorError(
            `workflow "${spec.id}" stage "${stageSpec.id}" gate "${gate.id}" escalated to ${outcome.to}: ${outcome.reason}`,
            outcome,
          );
      }
    }
    return decisions;
  }

  /**
   * Build a `StageContext` (plus the executor's adapter extras) for the
   * given stage. The `appendLineage` seam wraps the caller-provided callback
   * so source-access events surfaced from a worker boundary ride alongside
   * the stage's primary lineage record without each adapter having to
   * stitch them together manually.
   */
  private buildStageContext(
    stageId: string,
    sourceAccessEvents: SourceAccessEvent[],
  ): StageContext {
    const appendLineage: LineageAppend = (entry: LineageEntry) => {
      // Adapters using `appendLineage` for their own bookkeeping append a
      // bare entry; the executor's transition records the canonical entry
      // for the stage. Source-access events arriving here are aggregated
      // and folded into the canonical entry.
      if (entry.source_access_events && entry.source_access_events.length > 0) {
        for (const ev of entry.source_access_events) sourceAccessEvents.push(ev);
        // If this is purely a source-access aggregator entry (no fresh
        // artifact pointer) we suppress writing it to the lineage list to
        // avoid a duplicate record.
        if (!entry.artifact_id) return;
      }
      this.session = appendLineageEntry(this.session, entry);
    };
    const setPointer: SessionArtifactPointerSetter = (key, id) => {
      this.session = setArtifactPointer(this.session, key, id);
    };
    const phaseModel = this.modelForPhase?.(stageId) ?? this.model;
    const base = {
      store: this.store,
      appendLineage,
      setArtifactPointer: setPointer,
      model: phaseModel,
      ...(this.advisor ? { advisor: this.advisor } : {}),
      ...(this.telemetry ? { telemetry: this.telemetry } : {}),
      ...(this.signal ? { signal: this.signal } : {}),
    };
    // `session` is a getter so adapters that mutate the session via
    // `setArtifactPointer` see their own changes when they re-read
    // `ctx.session.artifacts.*`.
    Object.defineProperty(base, 'session', {
      get: () => this.session,
      enumerable: true,
    });
    // Spread adapter extras (retriever-agent model, runtime config, allowEdits,
    // synthesisTaskType) into the context so adapters that cast to
    // StageAdapterContext can read them. The adapters are responsible for
    // ignoring extras they do not need. We Object.assign onto `base` (which
    // has the live `session` getter) so the assignment preserves the getter
    // — copying via `{...base}` would call the getter once and freeze the
    // value at build time.
    Object.assign(base, this.contextExtras);
    return base as StageContext;
  }

  /**
   * Load the produced artifact from the store, picking the matching type
   * from the stage spec's `output` declaration (which may be a pipe-
   * delimited union for stages like synthesis).
   */
  private async loadOutput(
    stageSpec: WorkflowStageSpec,
    result: StageResult,
  ): Promise<{ artifact: Artifact; type: ArtifactType }> {
    const candidates = splitOutputUnion(stageSpec.output);
    for (const candidate of candidates) {
      if (!KNOWN_ARTIFACT_TYPES.has(candidate)) continue;
      const type = candidate as ArtifactType;
      try {
        const artifact = await this.store.get(type, result.output_artifact_id);
        if (artifact) return { artifact, type };
      } catch (err) {
        // Union outputs that share an on-disk subdirectory (analysis-report
        // and change-spec both live under `synthesis/`) cause `store.get`
        // to load the file but throw a type-mismatch when the produced
        // artifact's `artifact_type` is a different member of the union.
        // Fall through to the next candidate so the executor can pick the
        // matching type without coupling to path layout.
        if (err instanceof ArtifactStoreError && err.message.startsWith('Type mismatch')) {
          continue;
        }
        throw err;
      }
    }
    throw new WorkflowExecutorError(
      `stage "${stageSpec.id}": produced artifact "${result.output_artifact_id}" did not resolve as any of [${candidates.join(', ')}]`,
    );
  }

  /**
   * Update the session-state slot for the produced artifact's type so a
   * downstream stage that reads the slot resolves to the freshly-produced
   * id. Additional artifacts (e.g. evidence stage producing both the plan
   * and the bundle) update their own slots when the executor can resolve
   * their type from the known-types table; opaque additional ids are
   * recorded on the `StageRunRecord` and surfaced through lineage but do
   * not mutate session state.
   */
  private applySessionPointers(type: ArtifactType, result: StageResult): void {
    const slot = slotForArtifactType(type);
    if (slot) {
      this.session = setArtifactPointer(this.session, slot, result.output_artifact_id);
    }
  }

  /**
   * Commit a stage's lineage record either to the session's flat lineage
   * (top-level workflow) or to a caller-provided buffer (sub-workflow
   * descent). When a buffer is provided, `current_stage` and `updated_at`
   * still mutate on the session so a UI mirror of the deepest active stage
   * stays consistent — only the lineage append is diverted into the buffer
   * so the parent's `commitStageRecord` call can attach the buffer as
   * `sub_lineage` on the parent entry.
   */
  private commitStageRecord(args: {
    stageSpec: WorkflowStageSpec;
    workflowSpecId: string;
    outputArtifactId: string;
    gateDecisions: LineageGateDecision[];
    sourceAccessEvents: SourceAccessEvent[];
    subLineage?: LineageEntry[];
    lineageBuffer: LineageEntry[] | undefined;
  }): void {
    const sessionStage = asSessionStage(args.stageSpec.id);
    const extras: LineageExtras = {
      stage_id: args.stageSpec.id,
      workflow_spec_id: args.workflowSpecId,
      role: this.role,
    };
    if (args.gateDecisions.length > 0) extras.gate_decisions = args.gateDecisions;
    if (args.sourceAccessEvents.length > 0) extras.source_access_events = args.sourceAccessEvents;
    if (args.subLineage !== undefined) extras.sub_lineage = args.subLineage;

    if (args.lineageBuffer) {
      const now = new Date().toISOString();
      const entry: LineageEntry = {
        stage: sessionStage,
        artifact_id: args.outputArtifactId,
        timestamp: now,
        stage_id: args.stageSpec.id,
        workflow_spec_id: args.workflowSpecId,
        role: this.role,
      };
      if (extras.gate_decisions !== undefined) entry.gate_decisions = extras.gate_decisions;
      if (extras.source_access_events !== undefined) {
        entry.source_access_events = extras.source_access_events;
      }
      if (extras.sub_lineage !== undefined) entry.sub_lineage = extras.sub_lineage;
      args.lineageBuffer.push(entry);
      this.session = { ...this.session, current_stage: sessionStage, updated_at: now };
      return;
    }

    this.session = transitionStage(this.session, sessionStage, args.outputArtifactId, extras);
  }

  /**
   * Pick the next stage by walking outgoing edges in declaration order and
   * returning the first whose predicate evaluates to true. Returns
   * `undefined` when no edge fires — the workflow ends at the current
   * stage's output.
   */
  private selectNextStage(
    spec: WorkflowSpecV1,
    currentStageId: string,
    records: readonly StageRunRecord[],
  ): string | undefined {
    const outgoing = spec.edges.filter((e: WorkflowEdgeSpec) => e.from === currentStageId);
    for (const edge of outgoing) {
      if (evaluatePredicate(edge.when, records)) {
        return edge.to;
      }
    }
    return undefined;
  }
}
