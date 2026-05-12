/**
 * WorkflowRegistry — boot-time validator and resolver for the runtime.
 *
 * The registry is the load-bearing seam between the workflow spec
 * (`piorx/workflow-spec@1` artifacts) and the TypeScript implementations
 * (`Stage` adapters, `GateSpec` implementations) that back each declared
 * stage and gate. Per `docs/composability.md`:
 *
 *   - Workflows are typed artifacts, schema-validated like every other
 *     artifact (`src/artifacts/schemas.ts`).
 *   - `Stage` adapters register against stage ids declared in the spec.
 *   - `GateSpec` implementations register against the gate ids declared in
 *     `stages[].gates` and referenced by `mandatory_controls`.
 *   - At boot, the registry validates that every declared stage has an
 *     implementation, every input/output is a known artifact type, and every
 *     gate id has a registered implementation. **Drift is rejected loudly.**
 *   - Extensions composing on top of the default workflow cannot remove or
 *     weaken `mandatory_controls`, cannot register a stage id that overlaps
 *     an existing stage with weaker access policy, and (for sub-workflows)
 *     must operate at an authority class less-than-or-equal-to the parent's.
 *     `mandatory_controls` propagate downward additively only.
 *   - **Platform policy prevails over workflow configuration on conflict.**
 *     A workflow whose registration would violate any platform invariant is
 *     rejected at boot rather than silently downgraded.
 *
 * The registry never reads raw repository files and never invokes any model
 * — it operates entirely on already-parsed artifacts and TypeScript objects.
 */

import { ARTIFACT_TYPES, type ArtifactType, type WorkflowSpecV1 } from '../artifacts/types.ts';
import { validateArtifact } from '../artifacts/schemas.ts';
import { evidenceReviewGate } from '../conductor/evidence-overrides.ts';
import type { GateOp, GateOpValidation, GateSpec } from './gate.ts';
import type { Stage } from './stage.ts';
import {
  discoverStrategies,
  type AdvisorStrategy,
  type DiscoverStrategiesOptions,
  type StrategyDiagnostic,
} from './strategy-loader.ts';
import type { PiOrchestraConfig } from './config.ts';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Raised when the registry rejects a registration at boot. The thrown
 * message lists every violation surfaced by the validator so the caller can
 * fix them in one pass rather than discovering them iteratively.
 */
export class WorkflowRegistryError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(
      violations.length === 1
        ? `WorkflowRegistry: ${violations[0]}`
        : `WorkflowRegistry: ${violations.length} violations\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
    this.name = 'WorkflowRegistryError';
    this.violations = Object.freeze([...violations]);
  }
}

// ---------------------------------------------------------------------------
// Operating-mode authority order
// ---------------------------------------------------------------------------

/**
 * Authority class ordering — `advisory < supervised-change <
 * constrained-autonomous`. A sub-workflow's `operating_mode` must satisfy
 * `<= parent.operating_mode` (less authority is fine; more authority is a
 * platform-policy violation).
 */
const OPERATING_MODE_AUTHORITY: Record<string, number> = {
  advisory: 0,
  'supervised-change': 1,
  'constrained-autonomous': 2,
};

function operatingModeRank(mode: string): number {
  const rank = OPERATING_MODE_AUTHORITY[mode];
  if (rank === undefined) {
    throw new WorkflowRegistryError([`unknown operating_mode "${mode}"`]);
  }
  return rank;
}

// ---------------------------------------------------------------------------
// Access-policy strength helpers
// ---------------------------------------------------------------------------

/**
 * Approximate "access policy strength" of a stage as the cardinality of its
 * `mandatory_controls`-relevant gate set plus the strictness of its
 * `failure_handling`. The exact ordering does not need to be a total order
 * across arbitrary stages; it only needs to detect when an extension's
 * replacement stage drops gates or relaxes failure handling for the same id.
 *
 * Order, strict to lenient: `halt > escalate > tentative > retry`.
 */
const FAILURE_STRICTNESS: Record<string, number> = {
  halt: 3,
  escalate: 2,
  tentative: 1,
  retry: 0,
};

function failureStrictness(handling: string | undefined): number {
  if (!handling) return FAILURE_STRICTNESS.halt!;
  return FAILURE_STRICTNESS[handling] ?? 0;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface WorkflowRegistryOptions {
  /**
   * Maximum sub-workflow nesting depth. Defaults to 3 per
   * `docs/composability.md`'s "max nesting depth is registry-configurable"
   * guidance. Cycles are rejected independently of this cap.
   */
  maxNestingDepth?: number;
}

/**
 * In-memory registry of loaded workflow specs, registered Stage adapters,
 * and registered Gate implementations. Methods either succeed (returning
 * silently or returning the resolved artifact) or throw a
 * `WorkflowRegistryError`.
 *
 * The registry is intentionally not a singleton: tests and callers create a
 * fresh instance per scope. A process-wide singleton can be layered on top
 * (Phase 5's filesystem-discovery work introduces one) without changing the
 * surface defined here.
 */
export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowSpecV1>();
  private readonly stages = new Map<string, Stage>();
  private readonly gates = new Map<string, GateSpec[]>();
  private readonly strategies = new Map<string, AdvisorStrategy>();
  private readonly maxNestingDepth: number;

  constructor(options: WorkflowRegistryOptions = {}) {
    this.maxNestingDepth = options.maxNestingDepth ?? 3;
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a workflow spec. Validates structural shape via
   * `validateArtifact()` and the registry's structural rules (cycles, depth
   * cap, sub-workflow operating_mode bounds, `mandatory_controls` propagation).
   * Referential checks against registered Stages / Gates are deferred to
   * `validate()` so callers can register Stages and Gates in any order.
   */
  registerWorkflow(spec: WorkflowSpecV1): void {
    const validation = validateArtifact(spec);
    if (!validation.valid) {
      throw new WorkflowRegistryError(
        validation.errors.map((e) => `workflow "${spec.id ?? '<unknown>'}": ${e}`),
      );
    }

    const violations: string[] = [];
    this.checkWorkflowStructure(spec, violations);
    if (violations.length > 0) {
      throw new WorkflowRegistryError(violations);
    }

    this.workflows.set(spec.id, spec);
  }

  /**
   * Register a Stage adapter. The adapter must declare every input as a
   * known `ArtifactType` and produce a known `ArtifactType` (or pipe-
   * delimited union of known types). Stage ids are unique across all
   * registered workflows; an attempt to register a second adapter for the
   * same id is rejected unless the new adapter's access policy is strictly
   * stricter than the existing one (the platform-policy-prevails rule).
   */
  registerStage(stage: Stage): void {
    const violations: string[] = [];
    this.checkStageInputsOutputs(stage, violations);
    if (violations.length > 0) {
      throw new WorkflowRegistryError(violations);
    }

    const existing = this.stages.get(stage.id);
    if (existing) {
      const incomingStrictness = failureStrictness(stage.control?.failure_handling);
      const currentStrictness = failureStrictness(existing.control?.failure_handling);
      if (incomingStrictness < currentStrictness) {
        throw new WorkflowRegistryError([
          `stage "${stage.id}" already registered with stricter failure_handling="${existing.control?.failure_handling ?? 'halt'}"; cannot replace with weaker "${stage.control?.failure_handling ?? 'halt'}"`,
        ]);
      }
      // Equal strictness is the silent-replacement trap per "Drift is
      // rejected loudly": accidental re-registration (a test/extension
      // double-registering the same id) would shadow the prior adapter
      // with no diagnostic. Require the replacement adapter to be
      // strictly stricter to be a meaningful "platform-policy prevails"
      // override — otherwise reject so the caller has to confirm intent.
      if (incomingStrictness === currentStrictness) {
        throw new WorkflowRegistryError([
          `stage "${stage.id}" already registered with equal failure_handling="${existing.control?.failure_handling ?? 'halt'}"; refusing silent replacement (re-registration must declare strictly stricter failure_handling)`,
        ]);
      }
    }
    this.stages.set(stage.id, stage);
  }

  /**
   * Register a Gate implementation against a stage id. Multiple gates per
   * stage are kept in registration order — the workflow executor (T7) runs
   * them in that order after the stage produces its artifact.
   *
   * Gate registration is open-ended for stages declared in the workflow
   * spec; conformance against `mandatory_controls` is enforced at
   * `validate()` time, not here, so callers can register gates in any
   * order relative to workflow registration.
   */
  registerGate(stageId: string, gate: GateSpec): void {
    const list = this.gates.get(stageId) ?? [];
    if (list.some((existing) => existing.id === gate.id)) {
      throw new WorkflowRegistryError([
        `gate "${gate.id}" already registered against stage "${stageId}"`,
      ]);
    }
    list.push(gate);
    this.gates.set(stageId, list);
  }

  // -----------------------------------------------------------------------
  // Resolution
  // -----------------------------------------------------------------------

  resolveWorkflow(id: string): WorkflowSpecV1 {
    const spec = this.workflows.get(id);
    if (!spec) {
      throw new WorkflowRegistryError([`workflow "${id}" is not registered`]);
    }
    return spec;
  }

  /**
   * Resolve a Stage adapter by id, optionally namespaced under a parent
   * stage chain. Per `docs/composability.md` "Workflows also nest", sub-
   * workflow stage ids are namespaced under the parent stage id (e.g.
   * `synthesis.draft`, `synthesis.critique`) so they don't collide with
   * top-level stages of the same id.
   *
   * Resolution prefers the namespaced id (`<namespace>.<id>`); if no adapter
   * is registered there, it falls back to the bare id. The fallback keeps
   * the common case of "register one adapter, reuse it across both top-level
   * and inline-sub-workflow positions" working without ceremony, while still
   * letting collision-prone deployments register a distinct adapter under
   * the namespaced id.
   *
   * For nested sub-workflows the namespace concatenates: a sub-workflow
   * inside a sub-workflow inside `synthesis.critique` would resolve under
   * `synthesis.critique.draft` first, then `draft`.
   */
  resolveStage(id: string, namespace?: string): Stage | undefined {
    if (namespace) {
      const namespaced = this.stages.get(`${namespace}.${id}`);
      if (namespaced) return namespaced;
    }
    return this.stages.get(id);
  }

  gatesFor(stageId: string, namespace?: string): readonly GateSpec[] {
    if (namespace) {
      const namespaced = this.gates.get(`${namespace}.${stageId}`);
      if (namespaced && namespaced.length > 0) return namespaced;
    }
    return this.gates.get(stageId) ?? [];
  }

  // -----------------------------------------------------------------------
  // Strategy registration / resolution (Phase 5 — COMP-P5-T2)
  //
  // Strategies are resolved-from-disk advisor recipes (`AdvisorStrategy`).
  // The registry surface for them is intentionally narrow at Phase 5: name
  // uniqueness, retrieval by name, and an enumeration. Invocation
  // semantics — turning a registered strategy into a model call or a tool
  // result — live on extensions and on the synthesis-stage advisor wiring.
  // -----------------------------------------------------------------------

  /**
   * Register a discovered strategy. Names are unique across all scopes; the
   * canonical pattern is to call `discoverStrategiesAndRegister(...)` once
   * at boot, which handles project/user-scope conflict resolution before any
   * registration happens. Direct `registerStrategy` is also supported for
   * tests and for hosts that synthesize strategies programmatically.
   */
  registerStrategy(strategy: AdvisorStrategy): void {
    if (this.strategies.has(strategy.name)) {
      const existing = this.strategies.get(strategy.name)!;
      throw new WorkflowRegistryError([
        `strategy "${strategy.name}" already registered from ${existing.source_path} ` +
          `(${existing.scope} scope); duplicate at ${strategy.source_path} (${strategy.scope} scope)`,
      ]);
    }
    this.strategies.set(strategy.name, strategy);
  }

  /** Resolve a registered strategy by name. */
  resolveStrategy(name: string): AdvisorStrategy | undefined {
    return this.strategies.get(name);
  }

  /** Return every registered strategy in registration order. */
  listStrategies(): readonly AdvisorStrategy[] {
    return [...this.strategies.values()];
  }

  // -----------------------------------------------------------------------
  // Boot-time referential validation
  // -----------------------------------------------------------------------

  /**
   * Cross-cutting boot-time validation across all registered workflows,
   * stages, and gates. Called after every workflow + stage + gate has been
   * registered (the canonical seam is the extension entrypoint). Surfaces
   * every violation in a single `WorkflowRegistryError` so the host can fix
   * them in one pass.
   *
   * Checks:
   *   1. Every stage id declared in any workflow has a registered Stage.
   *   2. Every Stage's declared inputs/output match the spec's stages[].inputs
   *      and stages[].output.
   *   3. Every gate id declared in stages[].gates has at least one registered
   *      GateSpec.
   *   4. Every `mandatory_controls` gate id is declared on at least one
   *      stage's `gates` list and has a registered GateSpec — extensions
   *      cannot remove or shadow a mandatory control.
   *   5. Every input/output artifact-type in any workflow is a known
   *      `ArtifactType` constant.
   *   6. Recursive promotion target resolves to a known stage.
   */
  validate(): void {
    const violations: string[] = [];
    for (const spec of this.workflows.values()) {
      this.checkWorkflowReferences(spec, violations);
    }
    if (violations.length > 0) {
      throw new WorkflowRegistryError(violations);
    }
  }

  /**
   * Walk a `workflow_ref` chain starting at `rootId` and surface any cycle
   * — i.e. a referenced workflow that transitively references an ancestor
   * in the chain. Inline `workflow:` blocks have their own visited-set
   * cycle guard in `checkSubWorkflows`; this is the equivalent for
   * cross-workflow `workflow_ref` resolution. Without it, a pair of
   * registered workflows that mutually reference each other would pass
   * boot validation and stack-overflow the executor at runtime in
   * `runSubWorkflowStage → runSpec → runSubWorkflowStage`.
   */
  private checkWorkflowRefCycle(
    rootId: string,
    refId: string,
    parentStageId: string,
    visited: Set<string>,
    violations: string[],
  ): void {
    if (visited.has(refId)) {
      violations.push(
        `workflow "${rootId}" stage "${parentStageId}": workflow_ref cycle detected (id "${refId}" already in chain)`,
      );
      return;
    }
    const referenced = this.workflows.get(refId);
    if (!referenced) return;
    const nextVisited = new Set(visited);
    nextVisited.add(refId);
    for (const childStage of referenced.stages) {
      if (childStage.workflow_ref) {
        this.checkWorkflowRefCycle(
          rootId,
          childStage.workflow_ref,
          `${parentStageId} → ${refId}.${childStage.id}`,
          nextVisited,
          violations,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — workflow structural validation
  // -----------------------------------------------------------------------

  private checkWorkflowStructure(spec: WorkflowSpecV1, violations: string[]): void {
    const visited = new Set<string>([spec.id]);
    this.checkSubWorkflows(spec, spec, 0, visited, violations);
    this.checkRecursivePromotionTarget(spec, violations);
    this.checkExtensionConformance(spec, violations);
  }

  private checkSubWorkflows(
    root: WorkflowSpecV1,
    body: {
      stages?: WorkflowSpecV1['stages'];
      operating_mode: string;
      mandatory_controls: string[];
      id: string;
    },
    depth: number,
    visited: Set<string>,
    violations: string[],
  ): void {
    if (depth > this.maxNestingDepth) {
      violations.push(
        `workflow "${root.id}": sub-workflow nesting exceeds maxNestingDepth=${this.maxNestingDepth}`,
      );
      return;
    }
    const stages = body.stages ?? [];
    for (const stage of stages) {
      const sub = stage.workflow;
      if (!sub) continue;
      // Operating-mode authority check — sub <= parent.
      if (operatingModeRank(sub.operating_mode) > operatingModeRank(body.operating_mode)) {
        violations.push(
          `workflow "${root.id}" stage "${stage.id}": sub-workflow operating_mode "${sub.operating_mode}" exceeds parent's "${body.operating_mode}"`,
        );
      }
      // Mandatory-controls propagate downward additively only — child must
      // declare at least the parent's mandatory controls (more is fine).
      for (const control of body.mandatory_controls) {
        if (!sub.mandatory_controls.includes(control)) {
          violations.push(
            `workflow "${root.id}" stage "${stage.id}": sub-workflow drops parent mandatory_control "${control}"`,
          );
        }
      }
      // Cycle detection — a sub-workflow cannot reference an ancestor by id.
      if (visited.has(sub.id)) {
        violations.push(
          `workflow "${root.id}" stage "${stage.id}": sub-workflow cycle detected (id "${sub.id}" already in chain)`,
        );
        continue;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(sub.id);
      this.checkSubWorkflows(root, sub, depth + 1, nextVisited, violations);
    }
  }

  private checkRecursivePromotionTarget(spec: WorkflowSpecV1, violations: string[]): void {
    const target = spec.recursive_promotion_target;
    if (!spec.stages.some((s) => s.id === target)) {
      violations.push(
        `workflow "${spec.id}": recursive_promotion_target "${target}" does not match any stage id`,
      );
    }
  }

  private checkExtensionConformance(spec: WorkflowSpecV1, violations: string[]): void {
    const parentId = spec.extends;
    if (!parentId) return;
    const parent = this.workflows.get(parentId);
    if (!parent) {
      // Extension chains may declare a parent that is registered later or
      // is not piorx-shipped (Phase 5 territory). For Phase 1 we record the
      // unresolved parent as a violation so authors don't ship a spec that
      // claims to extend something the platform never sees.
      violations.push(
        `workflow "${spec.id}": extends "${parentId}" but no such workflow is registered`,
      );
      return;
    }

    // Sub <= parent operating_mode.
    if (operatingModeRank(spec.operating_mode) > operatingModeRank(parent.operating_mode)) {
      violations.push(
        `workflow "${spec.id}": operating_mode "${spec.operating_mode}" exceeds parent "${parentId}"'s "${parent.operating_mode}"`,
      );
    }
    // Mandatory controls additive only — every parent control must remain.
    for (const control of parent.mandatory_controls) {
      if (!spec.mandatory_controls.includes(control)) {
        violations.push(
          `workflow "${spec.id}": removes parent mandatory_control "${control}" from "${parentId}"`,
        );
      }
    }
    // stage_overrides cannot weaken access policy — the override's
    // failure_handling and gate set must be at least as strict as the
    // parent's matching stage. Adding gates is fine; dropping them is not.
    const overrides = spec.stage_overrides ?? {};
    for (const [stageId, override] of Object.entries(overrides)) {
      const parentStage = parent.stages.find((s) => s.id === stageId);
      if (!parentStage) {
        // Overriding an id that didn't exist in the parent is a different
        // kind of issue — surface it but allow it through Phase 1 since
        // adding a stage via override is valid composition.
        continue;
      }
      const parentFailure = failureStrictness(parentStage.control?.failure_handling);
      const overrideFailure = failureStrictness(override.control?.failure_handling);
      if (override.control?.failure_handling !== undefined && overrideFailure < parentFailure) {
        violations.push(
          `workflow "${spec.id}": stage_overrides["${stageId}"].control.failure_handling "${override.control.failure_handling}" weakens parent's "${parentStage.control?.failure_handling ?? 'halt'}"`,
        );
      }
      if (override.gates !== undefined) {
        const parentGates = parentStage.gates ?? [];
        for (const gateId of parentGates) {
          if (!override.gates.includes(gateId)) {
            violations.push(
              `workflow "${spec.id}": stage_overrides["${stageId}"].gates drops parent gate "${gateId}"`,
            );
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — stage shape checks
  // -----------------------------------------------------------------------

  private checkStageInputsOutputs(stage: Stage, violations: string[]): void {
    for (const input of stage.inputs) {
      if (!isKnownArtifactType(input)) {
        violations.push(
          `stage "${stage.id}": declared input "${input}" is not a known ArtifactType`,
        );
      }
    }
    for (const part of splitOutputUnion(stage.output)) {
      if (!isKnownArtifactType(part)) {
        violations.push(
          `stage "${stage.id}": declared output part "${part}" is not a known ArtifactType`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — referential checks
  // -----------------------------------------------------------------------

  private checkWorkflowReferences(spec: WorkflowSpecV1, violations: string[]): void {
    for (const stageSpec of spec.stages) {
      // Input/output artifact-type sanity.
      for (const input of stageSpec.inputs) {
        if (!isKnownArtifactType(input)) {
          violations.push(
            `workflow "${spec.id}" stage "${stageSpec.id}": input "${input}" is not a known ArtifactType`,
          );
        }
      }
      for (const part of splitOutputUnion(stageSpec.output)) {
        if (!isKnownArtifactType(part)) {
          violations.push(
            `workflow "${spec.id}" stage "${stageSpec.id}": output part "${part}" is not a known ArtifactType`,
          );
        }
      }
      // workflow_ref reference resolution + authority/control conformance.
      // Inline `workflow:` blocks are validated structurally at registration
      // time by checkSubWorkflows; workflow_ref points at another registered
      // workflow and so its checks are referential and live here. Both
      // forms enforce the same invariants per docs/composability.md
      // "Workflows also nest": sub-workflow operating_mode <= parent's,
      // mandatory_controls propagate downward additively only.
      if (stageSpec.workflow_ref) {
        this.checkWorkflowRefStage(spec, stageSpec.id, stageSpec.workflow_ref, violations);
      }
      // Stage implementation present and matching. Stages that declare a
      // sub-workflow (workflow_ref or inline workflow:) do not require a
      // Stage implementation — descent into the sub-workflow takes the
      // place of `Stage.run()` per docs/composability.md "Workflows also
      // nest". A registered implementation is harmless (descent always
      // wins at runtime) but is not required.
      const declaresSubWorkflow =
        stageSpec.workflow_ref !== undefined || stageSpec.workflow !== undefined;
      if (!declaresSubWorkflow) {
        const impl = this.stages.get(stageSpec.id);
        if (!impl) {
          violations.push(
            `workflow "${spec.id}" stage "${stageSpec.id}": no Stage implementation registered`,
          );
        } else {
          // Inputs/outputs must agree shape-wise.
          if (impl.inputs.length !== stageSpec.inputs.length) {
            violations.push(
              `workflow "${spec.id}" stage "${stageSpec.id}": Stage declares ${impl.inputs.length} inputs but spec declares ${stageSpec.inputs.length}`,
            );
          } else {
            for (let i = 0; i < impl.inputs.length; i++) {
              if (impl.inputs[i] !== stageSpec.inputs[i]) {
                violations.push(
                  `workflow "${spec.id}" stage "${stageSpec.id}": input[${i}] "${impl.inputs[i]}" disagrees with spec's "${stageSpec.inputs[i]}"`,
                );
              }
            }
          }
          if (impl.output !== stageSpec.output) {
            violations.push(
              `workflow "${spec.id}" stage "${stageSpec.id}": Stage output "${impl.output}" disagrees with spec output "${stageSpec.output}"`,
            );
          }
        }
      }
      // Every gate id has a registered GateSpec.
      const gates = stageSpec.gates ?? [];
      for (const gateId of gates) {
        const registered = this.gates.get(stageSpec.id) ?? [];
        if (!registered.some((g) => g.id === gateId)) {
          violations.push(
            `workflow "${spec.id}" stage "${stageSpec.id}": gate "${gateId}" is declared but not registered`,
          );
        }
      }
    }

    // Every mandatory_control gate id is declared on at least one stage and
    // has a registered GateSpec.
    for (const control of spec.mandatory_controls) {
      const declaredOnStage = spec.stages.find((s) => (s.gates ?? []).includes(control));
      if (!declaredOnStage) {
        violations.push(
          `workflow "${spec.id}": mandatory_control "${control}" is not declared on any stage's gates list`,
        );
        continue;
      }
      const registered = this.gates.get(declaredOnStage.id) ?? [];
      if (!registered.some((g) => g.id === control)) {
        violations.push(
          `workflow "${spec.id}": mandatory_control "${control}" has no registered GateSpec on stage "${declaredOnStage.id}"`,
        );
      }
    }

    // Recursive promotion target points at an existing stage.
    if (!spec.stages.some((s) => s.id === spec.recursive_promotion_target)) {
      violations.push(
        `workflow "${spec.id}": recursive_promotion_target "${spec.recursive_promotion_target}" does not match any stage id`,
      );
    }
  }

  /**
   * Validate a stage's `workflow_ref` against the registry.
   *
   * `workflow_ref` points at another registered workflow that the executor
   * will (eventually) descend into when running the parent stage. Three
   * checks at boot:
   *
   *   1. Referential — the referenced workflow id must be registered. A
   *      typo or rename produces a loud diagnostic at boot rather than a
   *      runtime "no Stage implementation registered" mystery.
   *   2. Authority — the referenced workflow's `operating_mode` must be
   *      `<= parent.operating_mode`. Authority cannot be smuggled upward
   *      through nesting, matching the inline-`workflow:` rule enforced by
   *      checkSubWorkflows.
   *   3. Mandatory controls — every parent `mandatory_controls` gate id
   *      must also appear in the referenced workflow's `mandatory_controls`.
   *      Sub-workflows may add controls; they must not drop them.
   *
   * Runtime descent into the referenced workflow is not yet implemented in
   * the executor (see docs/composability.md "deferred sub-workflow runtime
   * work"); validating the references at boot is independent and remains
   * useful — when descent lands, validated specs Just Work without a second
   * pass through the surface.
   */
  private checkWorkflowRefStage(
    parent: WorkflowSpecV1,
    parentStageId: string,
    refId: string,
    violations: string[],
  ): void {
    const referenced = this.workflows.get(refId);
    if (!referenced) {
      violations.push(
        `workflow "${parent.id}" stage "${parentStageId}": workflow_ref "${refId}" is not registered`,
      );
      return;
    }
    if (operatingModeRank(referenced.operating_mode) > operatingModeRank(parent.operating_mode)) {
      violations.push(
        `workflow "${parent.id}" stage "${parentStageId}": referenced workflow "${refId}" operating_mode "${referenced.operating_mode}" exceeds parent's "${parent.operating_mode}"`,
      );
    }
    for (const control of parent.mandatory_controls) {
      if (!referenced.mandatory_controls.includes(control)) {
        violations.push(
          `workflow "${parent.id}" stage "${parentStageId}": referenced workflow "${refId}" drops parent mandatory_control "${control}"`,
        );
      }
    }
    // Cross-workflow cycle detection — inline `workflow:` blocks get this
    // via `checkSubWorkflows`'s visited-set; `workflow_ref` needs the
    // equivalent guard or the executor stack-overflows when two registered
    // workflows reference each other through their workflow_ref chain.
    const visited = new Set<string>([parent.id]);
    this.checkWorkflowRefCycle(parent.id, refId, parentStageId, visited, violations);
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton — Phase 5 (COMP-P5-T3 / @piorx/extension-api)
// ---------------------------------------------------------------------------
//
// Per `docs/composability.md` "5. StageRegistry — discovery + composition":
//
//   > Other pi extensions can `import { piorxRegistry } from
//   > '@piorx/extension-api'` and register their own — first-name-wins,
//   > matching pi's idiom for tool/command resolution.
//
// The class itself is intentionally not a singleton (tests construct a fresh
// instance per scope), but third-party extensions need a single registry
// to register stages, gates, and strategies against. The accessor below
// returns a lazily-instantiated process-wide registry; hosts call
// `setPiorxRegistry(...)` to replace it (the default-pipeline runner does
// this implicitly when it builds its boot-time registry, so extensions
// loaded after boot register against the same instance).

let processRegistry: WorkflowRegistry | null = null;

/**
 * Resolve the process-wide `WorkflowRegistry`. Lazy-instantiated so
 * tests that never touch the singleton do not pay for it.
 */
export function getPiorxRegistry(): WorkflowRegistry {
  if (!processRegistry) processRegistry = new WorkflowRegistry();
  return processRegistry;
}

/**
 * Replace the process-wide registry. Hosts call this when they want
 * extensions loaded later in the boot sequence to register against a
 * registry the host has already populated. Passing `null` resets the
 * accessor so the next `getPiorxRegistry()` call lazy-instantiates a
 * fresh instance — useful between tests.
 */
export function setPiorxRegistry(registry: WorkflowRegistry | null): void {
  processRegistry = registry;
}

// ---------------------------------------------------------------------------
// Default-gate registration
// ---------------------------------------------------------------------------

/**
 * Register every default-workflow `GateSpec` against its declared stage id.
 *
 * Per `docs/composability.md` "Phase 1 — Scaffolding" and COMP-P1-T10, the
 * `evidence.review` gate is the first concrete `GateOp` implementation
 * (`src/conductor/evidence-overrides.ts`). Subsequent Phase 1 tasks land
 * the remaining gates declared in `src/runtime/workflows/piorx-default.workflow.md`
 * (`intent.approval`, `expansion.review`, `synthesis.confirm-task-type`,
 * `execution.allow_edits`); each registers through this helper so the host
 * boot sequence has a single canonical call.
 *
 * The helper is registry-side rather than conductor-side so the runtime
 * ships a complete, self-validating boot path: `registerWorkflow(default)` +
 * `registerDefaultStages(registry)` + `registerDefaultGates(registry)` +
 * `registry.validate()` is the full Phase 1 startup. Extension authors who
 * override individual stages or gates skip the corresponding default-
 * registration step and call `registry.registerGate(...)` directly with
 * their own implementation.
 */
export function registerDefaultGates(registry: WorkflowRegistry): void {
  registry.registerGate('evidence', evidenceReviewGate);
}

// ---------------------------------------------------------------------------
// Strategy discovery (Phase 5 — COMP-P5-T2)
// ---------------------------------------------------------------------------

/**
 * Result of running `discoverStrategiesAndRegister` against a registry.
 *
 * `registered` is the ordered list of strategies the registry now resolves
 * by name. `diagnostics` carries every parse failure, frontmatter rejection,
 * and project/user-scope shadow surfaced during discovery. The host is
 * responsible for surfacing diagnostics — the registry does not log on
 * its own so tests and CLIs can route them as needed.
 */
export interface StrategyDiscoveryResult {
  readonly registered: readonly AdvisorStrategy[];
  readonly diagnostics: readonly StrategyDiagnostic[];
}

/**
 * Discover strategies from `~/.config/piorx/strategies/` and
 * `<repoRoot>/.piorx/strategies/`, registering each surviving entry against
 * the registry. Project scope wins on name conflict (first-name-wins,
 * matching pi's idiom for tool / command resolution); shadowed user-scope
 * files surface as diagnostics rather than silent drops.
 *
 * The function does not throw on malformed strategies — instead it returns
 * the partial set of registered strategies plus a diagnostic per failure so
 * the host can report multiple problems in one pass. A registration-time
 * `WorkflowRegistryError` propagates out only for true conflicts (a
 * programmatic register call collided with a discovered name).
 */
export function discoverStrategiesAndRegister(
  registry: WorkflowRegistry,
  config: PiOrchestraConfig,
  options: DiscoverStrategiesOptions = {},
): StrategyDiscoveryResult {
  const { strategies, diagnostics } = discoverStrategies(config, options);
  const registered: AdvisorStrategy[] = [];
  const dynamicDiagnostics: StrategyDiagnostic[] = [];
  for (const strategy of strategies) {
    try {
      registry.registerStrategy(strategy);
      registered.push(strategy);
    } catch (err) {
      dynamicDiagnostics.push({
        source_path: strategy.source_path,
        scope: strategy.scope,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    registered: Object.freeze([...registered]),
    diagnostics: Object.freeze([...diagnostics, ...dynamicDiagnostics]),
  };
}

// ---------------------------------------------------------------------------
// Opt-in gate registration — synthesis.advisor-review (COMP-P3-T2)
// ---------------------------------------------------------------------------
//
// The `synthesis.advisor-review` gate is the canonical example of gate
// composition by stage id (per `docs/composability.md` "Phase 3"): an
// extension can register an additional gate against the synthesis stage
// alongside the platform's `synthesis.confirm-task-type` mandatory control,
// and the executor will run them in registration order.
//
// The gate is **opt-in and off by default**. The default workflow spec
// (`src/runtime/workflows/piorx-default.workflow.md`) does not list
// `synthesis.advisor-review` in `stages.synthesis.gates`, so the registry's
// boot-time `validate()` does not require an implementation to be
// registered. Hosts that enable advisor-aware synthesis (Phase 3+) call
// `registerSynthesisAdvisorReviewGate(registry)` AFTER `registerWorkflow`
// to attach the gate without modifying the spec.
//
// The default broker (`src/runtime/workflow-executor.ts`) auto-accepts gate
// outcomes when no host UI is wired, so registering this gate without a UI
// does not change runtime behavior — it surfaces in lineage as an
// `accepted` gate decision and nothing else. That keeps the byte-identical
// Phase 2 path intact for hosts that opt in to the gate but have not yet
// surfaced an advisor-review surface to the user.

export const SYNTHESIS_ADVISOR_REVIEW_GATE_ID = 'synthesis.advisor-review';

/** Trivial no-op `GateOp` accepted by `synthesisAdvisorReviewGate`. */
export interface SynthesisAdvisorReviewOp extends GateOp {
  readonly op: 'noop';
}

/**
 * `synthesis.advisor-review` — opt-in advisor-review gate.
 *
 * Sibling of `synthesis.confirm-task-type`, registered against the same
 * `synthesis` stage id. Today it presents an empty review surface and
 * accepts no concrete override ops — its purpose at Phase 3 is to **prove
 * gate composition by stage id**: the executor walks both gates in
 * registration order, the lineage records both decisions, and an extension
 * that swaps in a richer presents/applyOverride implementation needs no
 * registry changes to do so.
 */
export const synthesisAdvisorReviewGate: GateSpec<SynthesisAdvisorReviewOp> = {
  id: SYNTHESIS_ADVISOR_REVIEW_GATE_ID,

  async presents() {
    return {
      summary: 'synthesis.advisor-review: no advisor-review surface attached (opt-in gate).',
    };
  },

  validateOverride(op: SynthesisAdvisorReviewOp): GateOpValidation {
    if (op.op !== 'noop') {
      return { valid: false, errors: [`synthesis.advisor-review: unsupported op "${op.op}"`] };
    }
    return { valid: true, errors: [] };
  },

  async applyOverride(): Promise<void> {
    // No-op: the gate is opt-in and the default implementation does not
    // mutate the synthesis artifact. Extensions that need to mutate state
    // register their own `GateSpec` instead of replacing this one.
  },
};

/**
 * Register the opt-in `synthesis.advisor-review` gate.
 *
 * Hosts that enable advisor-aware synthesis call this AFTER
 * `registerWorkflow` so the executor walks both `synthesis.confirm-task-
 * type` and `synthesis.advisor-review` in registration order. Calling it
 * without enabling advisor wiring is harmless — the default broker auto-
 * accepts the gate and lineage records the decision; runtime behavior is
 * byte-identical to the gate-disabled path.
 */
export function registerSynthesisAdvisorReviewGate(registry: WorkflowRegistry): void {
  registry.registerGate('synthesis', synthesisAdvisorReviewGate);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KNOWN_ARTIFACT_TYPES = new Set<string>(ARTIFACT_TYPES);

function isKnownArtifactType(id: string): id is ArtifactType {
  return KNOWN_ARTIFACT_TYPES.has(id);
}

/**
 * Split a stage's `output` declaration into its constituent artifact-type
 * ids. The synthesis stage produces either an `analysis-report` or a
 * `change-spec` and declares its output as `'piorx/analysis-report@1 |
 * piorx/change-spec@1'`; the registry treats the union as a list of valid
 * outputs at boot validation time.
 */
function splitOutputUnion(output: string): string[] {
  return output
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
