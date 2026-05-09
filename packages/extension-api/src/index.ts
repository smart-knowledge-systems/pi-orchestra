/**
 * `@piorx/extension-api` — stable extension surface for piorx.
 *
 * Per `docs/composability.md` "Phase 5 — Skills-as-strategies + filesystem
 * discovery" and `auto-implement-composability.md` COMP-P5-T3, this shim
 * package re-exports the small set of runtime primitives third-party
 * extensions need: `Stage`, `Pipeline` (workflow), `Gate`, `AdvisorStrategy`,
 * and `piorxRegistry`.
 *
 * The package is **versioned independently** of pi-orchestra core so the
 * runtime internals (`src/runtime/*`) can refactor freely behind a stable
 * surface. Extension authors `import { ... } from '@piorx/extension-api'`
 * once and stay drop-in across piorx minor versions.
 *
 * The re-exports are intentionally narrow:
 *
 *   - Type-only surfaces for the four primitives (`Stage`, `Pipeline`,
 *     `Gate`, `AdvisorStrategy`) so an author's TypeScript checks against
 *     the same shape piorx uses internally.
 *   - The `piorxRegistry` accessor — a process-wide singleton — so
 *     extensions loaded after the host's boot register stages, gates, and
 *     strategies against the same `WorkflowRegistry` the host populated.
 *   - Just enough kernel artifact-type ids and gate-outcome variants to
 *     make a registration round-trip type-check without reaching into
 *     `src/`.
 *
 * If a future API surface needs to grow (per
 * `docs/composability.md` "Migration in five phases — Phase 5"), additions
 * land in this file rather than spreading new re-export paths across the
 * codebase. Consumers therefore have one stable import line — the
 * substrate the design doc treats as the load-bearing extension seam.
 */

// ---------------------------------------------------------------------------
// 1. Stage
// ---------------------------------------------------------------------------

export type {
  Stage,
  StageContext,
  StageResult,
  StageControl,
  StageFailureHandling,
  StageTelemetry,
  StageTelemetryEvent,
  StageModelCall,
  StageAdvisorCall,
  LineageAppend,
  SessionArtifactPointerSetter,
} from '../../../src/runtime/stage.ts';

// ---------------------------------------------------------------------------
// 2. Pipeline (workflow) — re-exports under both `WorkflowSpec` and the
// friendlier `Pipeline` alias, matching the design-doc vocabulary
// (`docs/composability.md` "5. StageRegistry — `registerPipeline`").
// ---------------------------------------------------------------------------

export type {
  WorkflowSpecV1,
  WorkflowSpecV1 as Pipeline,
  WorkflowSpecBody,
  WorkflowStageSpec,
  WorkflowStageControl,
  WorkflowStageFailureHandling,
  WorkflowEdgeSpec,
  WorkflowGovernance,
  WorkflowOperatingMode,
  WorkflowStageOverride,
  ArtifactType,
  ArtifactBase,
} from '../../../src/artifacts/types.ts';

export { ARTIFACT_TYPES, WORKFLOW_OPERATING_MODES } from '../../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// 3. Gate
// ---------------------------------------------------------------------------

export type {
  GateSpec,
  GateOp,
  GateOpValidation,
  GateOutcome,
  GateEscalationTarget,
  GatePresentation,
} from '../../../src/runtime/gate.ts';

// ---------------------------------------------------------------------------
// 4. AdvisorStrategy
// ---------------------------------------------------------------------------

export {
  STRATEGY_KIND,
  parseStrategyMarkdown,
  loadStrategyFromFile,
  discoverStrategies,
} from '../../../src/runtime/strategy-loader.ts';

export type {
  AdvisorStrategy,
  StrategyScope,
  StrategyDiagnostic,
  DiscoveredStrategies,
  DiscoverStrategiesOptions,
} from '../../../src/runtime/strategy-loader.ts';

// ---------------------------------------------------------------------------
// 5. piorxRegistry — process-wide singleton accessor
// ---------------------------------------------------------------------------

export {
  WorkflowRegistry,
  WorkflowRegistryError,
  getPiorxRegistry,
  setPiorxRegistry,
  discoverStrategiesAndRegister,
  registerDefaultGates,
} from '../../../src/runtime/registry.ts';

export type {
  WorkflowRegistryOptions,
  StrategyDiscoveryResult,
} from '../../../src/runtime/registry.ts';

import { getPiorxRegistry } from '../../../src/runtime/registry.ts';

/**
 * Process-wide `WorkflowRegistry` singleton. Resolves through
 * `getPiorxRegistry()` so the same instance is returned across imports
 * inside the same process. Hosts can replace it via `setPiorxRegistry`
 * (e.g. between tests, or to share a registry the host pre-populated
 * during boot).
 *
 * Defined as a `Proxy` so that the live singleton is consulted on every
 * field access — extensions that capture a reference at module load time
 * stay coherent with later `setPiorxRegistry(...)` calls without having
 * to re-import.
 */
import type { WorkflowRegistry } from '../../../src/runtime/registry.ts';

export const piorxRegistry = new Proxy({} as WorkflowRegistry, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getPiorxRegistry() as object, prop, receiver);
    return typeof value === 'function' ? value.bind(getPiorxRegistry()) : value;
  },
}) as WorkflowRegistry;
