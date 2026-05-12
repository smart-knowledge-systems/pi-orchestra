# piorx — Composability Primitives, Then Advisor

## Context

**Where piorx is today.** A monolithic pi extension that hardcodes a six-stage workflow inside `runPipelineFromIntent` (`extensions/conductor-extension.ts:1040–1167`): intent → expansion → retrieval → evidence → synthesis → execution, plus recursive promotion. The **kernel is cleanly factored** — typed artifacts (`src/artifacts/types.ts`), runtime validators (`src/artifacts/schemas.ts`), the artifact store, deterministic paths/IDs, the agentic retriever (`src/retriever/{scout,agent,executor}.ts`), the deterministic assembler, and the override discriminated union (`src/conductor/evidence-overrides.ts`) are all reusable primitives in waiting. **The shell on top is opinionated**: stage transitions are a literal whitelist (`src/conductor/stage-machine.ts:32–40`), the pipeline shape is hard-coded sequencing, the synthesis task-type heuristic is a regex (`extensions/conductor-extension.ts:558–571`), recursive promotion always targets Stage 1, and **every LLM call routes through one `getModelText` against `ctx.model`** (`extensions/conductor-extension.ts:86–130`) — no per-stage executor, no advisor.

**Why now.** The user wants a default best-in-class workflow that _also_ composes — so a future advisor extension, a "skills as strategies" extension, a different synthesis recipe, or a third-party stage can plug in without forking. The advisor-strategy-assessment (`docs/advisor-strategy-assessment.md`) already prescribes the next concrete LLM-driven work (per-phase model config + `runWithAdvisor()` + real synthesis/execution workers). Doing that work _before_ extracting the composability primitives would re-bake opinion into a second monolith. **Doing primitives first lets the advisor land as the first canonical extension on a clean substrate** rather than the substrate's first patch.

**What we keep, what we re-shape.**

- **Pi philosophy** (Mario Zechner — "minimal core, aggressive extensibility", maximum observability, no opaque subagents, AGENTS.md + slash commands as the customization surface, extensions auto-discovered from `~/.config/pi/agent/extensions/` and `.pi/extensions/`): piorx stays a single pi extension; new primitives are extension-internal abstractions composed from pi's `ExtensionAPI` (`registerCommand`, `registerTool`, `on`, `EventBus`, `appendEntry`).
- **Claude Code shapes** (per `~/code/public/claude-code` survey — Skills, Subagents, Hooks, Gates, layered settings): the _concepts_ are the design vocabulary (Stage, Pipeline, Gate, Skill-as-strategy, layered config). The _wire format_ stays pi-flavored: markdown frontmatter for stages/strategies, JSON for pipelines/settings, no `.claude/` discovery. A user dropping a piorx Stage file should feel at home if they know either Claude Code or pi.
- **pi-community wire-compat**: the first advisor extension uses **rpiv-advisor's zero-arg `advisor()` contract** (`{plan|correction|stop}`) so it's drop-in for the existing pi ecosystem.

---

## Design

### The five primitives

#### 1. `Stage` — typed function over typed artifacts

A stage is a single async function with a stable contract:

```ts
interface Stage<InId extends string, OutId extends string> {
  id: string; // 'restatement' | 'expansion' | ...
  inputs: readonly InId[]; // ArtifactType ids it requires
  output: OutId; // ArtifactType it produces
  modelConfig?: PhaseModelConfig; // only for LLM-driven stages
  control?: StageControl; // optional governance metadata
  run(ctx: StageContext): Promise<StageResult>; // pure-ish: reads/writes via ctx.store
  gate?: GateSpec; // optional HITL seam after run
}

interface StageControl {
  // all fields optional with sensible defaults
  entry_criteria?: string; // human-readable: when may this stage begin
  exit_criteria?: string; // human-readable: when is the stage complete
  acceptance_criteria?: string; // human-readable: when is the output fit for downstream
  failure_handling?: 'retry' | 'tentative' | 'halt' | 'escalate';
  evidence_requirements?: string[]; // what must be in lineage for this stage to be auditable
}
```

Each existing stage controller (`src/conductor/stage-1.ts`, `expansion.ts`, `retrieval.ts`, `synthesis.ts`, recursive-intent) is re-expressed as a `Stage`. The deterministic stages (assembler, normalizer) become Stages without `modelConfig`. The dispatch services (`src/services/*-dispatch.ts`) stay as the implementation under `run()`; they're already typed boundaries.

The `control` block is **optional** with the default "schema validation = exit = acceptance, halt on failure." Most stages don't need it. Advisor / synthesis / execution stages opt in to specify _acceptance criteria distinct from exit_ — an artifact can validate structurally yet be unfit for the next stage (a `change-spec@1` with zero meaningful edits is the canonical example). The split lets the gate after the stage route a "valid but unfit" output to a different outcome than "valid and fit." `failure_handling: 'tentative'` means the artifact is persisted but explicitly labeled as not-fit-for-downstream-consumption until a subsequent decision promotes it; this prevents tentative outputs from being silently consumed as approved deliverables.

#### 2. `WorkflowSpec` — declarative workflow as a first-class typed artifact

The workflow definition is promoted one level above TS code: it becomes an **artifact** of type `piorx/workflow-spec@1`, schema-validated like every other artifact, with rich natural-language fields that make it **agent-readable without TS context**.

The format is **markdown with YAML frontmatter**. The YAML defines the workflow's _shape_ (every field is schema-validated). The markdown body defines its _function and purpose_ — what each stage is for, why each gate exists, what each goal means, with optional code blocks pointing at TS implementations. The split keeps YAML lint-clean while letting prose carry the agent-readable semantics that make the spec the source of truth. Field discriminator is `kind:` (YAML treats `@` as reserved at the start of a scalar; `kind:` is the k8s convention, well-known and lint-clean).

```markdown
---
kind: piorx/workflow-spec@1
id: piorx/workflow/default@1
name: Default piorx workflow
description: Six-stage pipeline turning user intent into either an analysis report or an executed code change.

operating_mode: supervised-change # 'advisory' | 'supervised-change' | 'constrained-autonomous'
mandatory_controls: # gate ids extensions cannot remove or weaken
  - intent.approval
  - execution.allow_edits

goals:
  - Capture user intent verbatim and produce a canonical restatement
  - Build evidence narrowly from retriever-authored defaults
  - Synthesize either an analysis report or an executable change spec

stages:
  - id: synthesis
    name: Stage 5 — Synthesis
    description: Produce an analysis-report or change-spec artifact from the evidence bundle.
    inputs: [piorx/evidence-bundle@1, piorx/intent-restatement@1]
    output: 'piorx/analysis-report@1 | piorx/change-spec@1'
    model_class: llm-with-advisor
    gates: [synthesis.confirm-task-type, synthesis.advisor-review]
    control: # optional; opt in where stages need governance metadata
      acceptance_criteria: Output validates structurally AND contains at least one actionable element
      failure_handling: tentative
  # ...remaining stages elided for brevity

edges:
  - from: synthesis
    to: execution
    when: { eq: [$.synthesis.artifact_type, piorx/change-spec@1] }
    description: Skip execution for analysis-only flows.

governance: # optional; orchestration vs. governance separated visually
  evidence_requirements: [advisor-consultations, override-history, source-access-events]
  version_pinning: strict # lineage records the workflow spec version active at run time

recursive_promotion_target: restatement
---

# Default piorx workflow

[Body expands on each YAML field in plain English. Conventional sections: `## Operating mode`
(rationale paragraph), `## Goals` (one H3 per goal where useful), `## Stages` (one H3 per
stage matching `stages[].id`), optional `## Edges` / `## Governance` where they need
explanation beyond the YAML `description` fields. Code fences may point at TS
implementations for cross-reference.]
```

Extension-authored alternatives compose via a `extends: <parent-workflow-id>` field plus a `stage_overrides:` block that modifies specific stages by id. `mandatory_controls` may be _added_ to a parent, never _removed_ — the registry enforces this at boot.

**Workflows also nest.** A stage can declare `workflow_ref: <sub-workflow-id>` (compositional reuse — multiple parents reference the same published sub-workflow) or an inline `workflow:` block (one-off, sub-workflow intrinsic to one parent). Constraints, all registry-enforced at boot: sub-workflow `operating_mode` must be ≤ parent's (authority cannot be smuggled upward); `mandatory_controls` propagate downward (additive only, same one-way rule as `extends:`); sub-workflow stage ids are namespaced under the parent stage id in the registry (`synthesis.draft`, `synthesis.critique`); lineage records the sub-workflow as a sub-tree with its own `workflow_spec_id` carried down for version traceability; gates compose hierarchically (sub-workflow gates run during sub-execution, parent gates after the sub-workflow returns); a virtual `__exit__` edge target lets a sub-workflow promote any intermediate stage's output as its final artifact without a passthrough stage. Max nesting depth is registry-configurable (default 3); cycles are rejected at boot. Top-level user-driven re-runs use `recursive_promotion_target`, not sub-workflow descent.

**Three load-bearing governance fields beyond orchestration semantics**:

- **`operating_mode`** declares the workflow's authority class — _advisory_ (analysis only, no code execution), _supervised-change_ (proposes changes; execution requires explicit approval), or _constrained-autonomous_ (executes within pre-approved scope and bounded budgets). Mid-workflow promotion between modes is itself a controlled event — a workflow cannot implicitly escalate from advisory to executing.
- **`mandatory_controls`** lists gate ids extensions are forbidden from removing or weakening. The registry validates this at boot. `intent.approval` and `execution.allow_edits` are the canonical defaults for the supervised-change mode; a workflow author can add (never remove) more.
- **`governance` sub-block** (optional) declares evidence requirements, version-pinning policy, and other audit semantics. Orchestration semantics (stages, edges) and governance semantics (mandatory controls, evidence requirements) are visually and structurally separated so a reviewer can see each independently.

**Conflict-resolution rule**: where a workflow's configuration disagrees with platform policy enforced by the registry, **platform policy prevails** — the workflow is rejected at boot rather than silently downgrading the platform's controls.

The default piorx workflow ships as a markdown file with YAML frontmatter (`src/runtime/workflows/piorx-default.workflow.md`), validated at boot as `piorx/workflow-spec@1`. The format mirrors pi's existing slash-command convention and Claude Code's skill / agent / hook / output-style frontmatter, so authors who know either ecosystem are at home. **TS Stage implementations register against stage IDs declared in the workflow spec; the registry validates at boot that every declared stage has a matching implementation with the right input/output types, and errors loudly on drift.** That's the spec/code split: the workflow spec is the source of truth for _what_ the workflow does; TS implementations are the source of truth for _how_ each stage runs. The "compile a workflow spec into code" aspiration is reachable for any capable agent reading the spec + the piorx repo — piorx doesn't ship a compiler; the agent IS the compiler.

The natural-language `description` / `goals` / edge-`description` fields are load-bearing: an agent reading just the JSON should be able to answer "what does this workflow do?", "what would change if I added a verification stage between synthesis and execution?", or "what's the smallest workflow that produces an analysis-report?" without grepping a single TS file. **That agent-readability is a Phase 1 acceptance criterion**, not a downstream property.

This replaces both the implicit transition whitelist in `stage-machine.ts:32–40` and the in-code `runPipelineFromIntent` orchestration. The stage machine becomes a _runtime executor_ over the active workflow spec; `runPipelineFromIntent` collapses to `workflowExecutor.run('piorx/workflow/default@1', initialIntent, ctx)`.

#### 3. `Gate` — HITL/override seam with four-way outcome

The existing `EvidenceOverride` discriminated union (`src/conductor/evidence-overrides.ts:56–90`) is the prototype. Generalize:

```ts
interface GateSpec {
  id: string; // 'evidence.review' | 'synthesis.confirm-task-type' | ...
  presents(ctx: StageContext): Promise<GatePresentation>;
  validateOverride(op: GateOp, ctx: StageContext): GateOpValidation;
  applyOverride(op: GateOp, ctx: StageContext): Promise<void>;
}

type GateOutcome =
  | { kind: 'accepted'; applied?: GateOp[] }
  | { kind: 'rejected_governance'; reason: string } // policy violation, control breach, mandatory_control weakened
  | { kind: 'rejected_technical'; reason: string } // parse failure, timeout, malformed override
  | { kind: 'escalated'; to: 'workflow_owner' | 'policy_authority' | 'user'; reason: string };
```

A gate runs after a stage and before the workflow advances. It can: present a review surface to the conductor (existing `summarizeInspection` / `summarizeEvidencePlan` patterns), accept a typed override op (the discriminated union pattern), validate, apply, and resolve to one of the four outcomes above. Existing gates fall out:

- `intent.approval` — the restatement approval loop (`stage-1.ts`).
- `expansion.review` — approve/revise/reject (`expansion.ts`).
- `evidence.review` — `EvidenceOverride[]` (already done — the reference implementation).
- `synthesis.confirm-task-type` — the inferred-vs-user-confirmed prompt (`extensions/conductor-extension.ts:889–893`).
- `execution.allow_edits` — the safety latch.
- `recursive.promote` — the promote-to-new-intent prompt.

The **four-way outcome distinguishes technical failure from governance failure from escalation**. A malformed override op or a parser timeout (technical) is retry-eligible and routes differently from a policy violation or a `mandatory_controls` breach (governance), which is never silently retried. _Escalation_ is the outcome when the gate cannot resolve the situation under its own authority — it surfaces to the next-higher decision authority. Today the user is the only authority for escalation; the routing field (`workflow_owner | policy_authority | user`) is forward-compatible for future enterprise deployments where roles separate.

Extensions can register _additional_ gates against existing stages (e.g. an advisor extension adds `synthesis.advisor-review` after the synthesis stage). Gates compose by stage id; the order is registration-deterministic. **Mandatory-control gates** (those listed in the workflow spec's `mandatory_controls`) cannot be removed or shadowed by an extension; the registry rejects any extension registration that would do so at boot. This is the property that makes "extensions compose freely" actually safe.

#### 4. `PhaseModelConfig` — per-stage executor + optional advisor

Lifted directly from the advisor-strategy-assessment §7 Phase A:

```ts
type AdvisorMode = 'none' | 'inline' | 'custom' | 'server';

interface PhaseModelConfig {
  executor: { provider: string; model: string };
  advisor?: { mode: AdvisorMode; model: string; maxUses?: number; caching?: 'ephemeral-5m' | null };
}
```

Lives in `src/runtime/config.ts` (currently paths-only). Replaces the `ctx.model` bottleneck. Each `Stage` declares its `modelConfig`; the executor is resolved by piorx, not pi. Advisor mode defaults to `custom` (per advisor doc §6 — pi-ai's `convertTools` strips unknown fields and `Usage.iterations[]` collapses, so `server` mode has telemetry holes today).

#### 5. `StageRegistry` — discovery + composition

Pi already gives us the substrate. The registry is just a thin layer:

```ts
interface StageRegistry {
  registerStage(stage: Stage): void;
  registerPipeline(pipeline: Pipeline): void;
  registerGate(stageId: string, gate: GateSpec): void;
  registerStrategy(name: string, strategy: AdvisorStrategy): void; // skills-as-strategies

  resolveStage(id: string): Stage;
  resolvePipeline(id: string): Pipeline;
  gatesFor(stageId: string): GateSpec[];
}
```

The default piorx extension self-registers the six default Stages, the default Pipeline, and the existing gates. **Other pi extensions can `import { piorxRegistry } from '@piorx/extension-api'` and register their own** — first-name-wins, matching pi's idiom for tool/command resolution. No filesystem discovery in Phase 1; that arrives in Phase 5 with `.piorx/strategies/*.md` (skills-shaped advisors using pi's existing markdown frontmatter convention).

### How the primitives map to Claude Code (without copying its wire format)

| Claude Code                   | piorx primitive                                        | piorx wire (Phase 5)                                   |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Skill (`SKILL.md`)            | `AdvisorStrategy`                                      | `.piorx/strategies/<name>.md` (markdown + frontmatter) |
| Subagent (JSON agent def)     | `Stage` with `isolation` field                         | `Stage` registration in extension code                 |
| Hook (PreToolUse/PostToolUse) | `Gate` (post-stage) + pi `on('tool_call', …)`          | Gate registration in extension code                    |
| Slash command                 | pi `registerCommand` (already there)                   | `pi.registerCommand('piorx:run', …)`                   |
| AGENTS.md / CLAUDE.md         | piorx's existing `docs/`, plus user-level pi AGENTS.md | Already pi-native                                      |
| Settings layering             | `PiOrchestraConfig` resolution from user/project       | `~/.config/piorx/config.json` → `.piorx/config.json`   |

The point of this table: the user knows what's missing if they come from either world, and they can spell each idea in piorx's terms.

### Migration in five phases

Each phase is independently shippable, behavior-preserving where possible, and gated on the previous phase passing all existing tests (497 today).

#### Phase 1 — Scaffolding (no behavior change)

**New files**:

- `src/runtime/stage.ts` — `Stage<>`, `StageContext`, `StageResult` types.
- `src/runtime/workflow-executor.ts` — runtime executor over a loaded `WorkflowSpecV1`. Implements linear-with-conditional-edges traversal, gate invocation, and recursive promotion. Replaces in-code `runPipelineFromIntent`.
- `src/runtime/gate.ts` — `GateSpec`, `GateOp` base, `GateOpValidation`. Generalizes the override pattern from `src/conductor/evidence-overrides.ts`.
- `src/runtime/registry.ts` — `WorkflowRegistry` singleton-per-extension. Loads workflow specs, registers stage implementations by id, validates referential integrity at boot, **enforces extension-conformance** (extensions cannot remove or weaken `mandatory_controls`; platform policy prevails over workflow configuration), and fails loudly on drift.
- `src/runtime/workflows/piorx-default.workflow.md` — the default piorx workflow as a markdown file with YAML frontmatter, hand-authored, schema-validated as `piorx/workflow-spec@1`. The YAML carries shape; the markdown body carries function and purpose. Replaces what would have been `pipelines/default.ts`.
- `tests/runtime/control-baseline.test.ts` — **§19 minimum control baseline conformance test**. Verifies the default workflow declares an `operating_mode`, has stage-level entry/exit criteria available, includes at least one reviewable decision gate before execution, produces immutable artifact lineage, restricts source access by stage policy, records approval dispositions, logs exceptions with the four-way gate outcome, and pins workflow version traceability. This is the literal Phase 1 conformance contract.

**Refactor (keeping behavior)**:

- Each `src/conductor/stage-*.ts` controller wrapped in a `Stage` adapter. The controller code is the `run()` body verbatim; only the type wrapper is new.
- `src/conductor/stage-machine.ts` becomes a runtime validator over the active `Pipeline`'s edge list rather than a hard-coded transition map. The valid-transition table is generated from the pipeline.
- `extensions/conductor-extension.ts:1040–1167` — `runPipelineFromIntent` is rewritten as `workflowExecutor.run('piorx/workflow/default@1', initialIntent, ctx)`. The body of the function shrinks dramatically; the orchestration is in `WorkflowExecutor`.
- `src/conductor/evidence-overrides.ts` re-exports its `EvidenceOverride` union as the first concrete `GateOp` and registers the `evidence.review` gate. No semantic change.
- **Artifact-type IDs gain a hierarchical namespace.** Promote `intent-capture-v1` → `piorx/intent-capture@1` across `src/artifacts/types.ts`, `schemas.ts`, every fixture under `tests/fixtures/sample-artifacts/`, and the store path mappings. The `@N` is the Lexicon-style version separator; the prefix is the publisher namespace. Mechanical search-and-replace; the TS discriminated union and the `artifact_type` field stay, only the string values change. This costs nothing today and lets a future third-party stage register `@yourhandle/decision-tree@1` against the same validator registry without coordinating with the piorx maintainer.

**Extended (artifact kernel)**:

- `src/artifacts/types.ts` — adds the `WorkflowSpecV1` artifact type. Fields: `id`, `name`, `description`, `goals[]`, `stages[]` (each with `id`, `name`, `description`, `inputs`, `output`, `model_class`, `gates`), `edges[]` (with structured `when` predicates plus natural-language `description`), `recursive_promotion_target`.
- `src/artifacts/schemas.ts` — adds the `WorkflowSpecV1` runtime validator (structural shape). The `WorkflowRegistry` layers a _referential_ check at boot: every stage id in the spec has a matching TS implementation; every declared input/output is a known artifact type; every gate id is registered.

**Verification**: all 497 existing tests pass. Add `tests/runtime/workflow-executor.test.ts` (≥10 tests): default workflow spec validates as `piorx/workflow-spec@1`, edges resolve, conditional edges fire on synthesis-type, gates run in order, override path through `evidence.review` produces byte-identical bundles to today, and **boot-time drift detection fires** when a registered Stage's input/output types disagree with the workflow spec.

Add `tests/runtime/workflow-spec-readability.test.ts`: feed the default workflow spec (no TS source) to a stubbed agent and assert it correctly answers five canonical questions about the workflow's structure, deliverables, and decision points. Cheap eval; protects the natural-language description fields against drift over time.

Add `tests/runtime/control-baseline.test.ts`: the §19 minimum-control-baseline conformance test (operating mode declared, reviewable gate before execution, lineage immutability, source-access restriction by stage policy, recorded approval disposition, four-way gate outcome routing, workflow version traceability). This test is the literal definition of "controlled environment" for Phase 1 — any change that breaks it must be explicit.

Add `tests/runtime/extension-conformance.test.ts`: verify a synthetic extension that attempts to (a) remove a `mandatory_controls` gate, (b) weaken a gate's outcome routing, or (c) overlap a stage id with weaker access policy is **rejected at boot** with a clear diagnostic.

**Out of scope this phase**: any new LLM-driven behavior, advisor wiring, filesystem discovery of third-party workflow specs (the registry loads piorx-shipped specs only), public `@piorx/extension-api` package, agent-side spec-to-code compilation tooling (any capable agent can do this with the codebase open; piorx doesn't ship a compiler), and the deferred governance items enumerated in the "Governance — deferred to roadmap" section below.

#### Phase 2 — PhaseModelConfig + runWithAdvisor (advisor doc Phases A & B)

**New / extended**:

- `src/runtime/config.ts` extended with `PhaseModelConfig`, `AdvisorConfig`, the `models: { restatement, expansion, retrieval, synthesis, execution }` block. Validator refuses non-canonical executor/advisor pairs by default (per advisor doc §3.2 + §4.1 — the API matrix is canonical, the validator is loose; this resolves toward "API matrix is the authority").
- `src/runtime/run-with-advisor.ts` — the helper from advisor doc §7 Phase B. Three modes: `inline` (deterministic pre-call), `custom` (pi-ai tool-loop, default — preserves per-side-call billing), `server` (`StreamOptions.onPayload` + `StreamOptions.headers`, behind the canonical-pair validator). All three emit a uniform telemetry record to `.pi/orchestra.log`.
- `getModelText` (`extensions/conductor-extension.ts:86–130`) takes a `phase: keyof PhaseModelConfigs` parameter; resolves executor from `runtime.config.models[phase]`. `ctx.model` stays as a fallback for one minor version.
- Defense-in-depth: always send the `advisor-tool-2026-03-01` beta header on phases that touch shared history when advisor is enabled (Claude Code §4.2); strip advisor blocks otherwise (§4.3); honor `PIORX_DISABLE_ADVISOR` env var (§4.6). All in `run-with-advisor.ts`.

**Verification**: existing 497 tests stay green. Add `tests/runtime/run-with-advisor.test.ts` covering all three modes against a stubbed model callback.

#### Phase 3 — First real LLM-driven Stage (synthesis worker; advisor doc Phase C)

The synthesis stage stops being a deterministic stub and becomes the canonical example of a `Stage` with `modelConfig.advisor.mode = 'custom'`.

**Changed**:

- `src/synthesis/worker.ts` — replaces the stub with a real implementation that calls `runWithAdvisor` with `output_config.format` set from the JSON-Schema translation of `analysis-report-v1` and `change-spec-v1` validators (mechanical from `src/artifacts/schemas.ts`).
- `src/synthesis/prompt.ts` — adds the `ADVISOR_TOOL_INSTRUCTIONS` (advisor doc §4.5, verbatim from Claude Code) when advisor is enabled.
- The `synthesis.confirm-task-type` Gate gets a sibling `synthesis.advisor-review` Gate — opt-in, off by default.

**Verification**: snapshot tests for both task types against a stubbed advisor; the existing E2E regression (`tests/interaction/agentic-retrieval-flow.test.ts`) continues to pass with advisor disabled. Add a new E2E that asserts an enabled advisor produces a bundle with the expected `advisor_iterations` telemetry but byte-identical synthesis output (since the model is stubbed).

#### Phase 4 — Retriever onto `agentLoop`; execution worker, real (advisor doc Phases D & E)

Retriever rewrite collapses `src/retriever/agent.ts` (≈500 LOC) onto `agentLoop` from `@earendil-works/pi-agent-core` (already a transitive dep). Advisor slots in as one more `Tool`. The bounded-budget logic (`shouldStopAfterTurn`) is reused.

Execution worker stops being a stub. Same pattern as synthesis: `Stage` + `runWithAdvisor` + structured output (the `change-spec-v1` resolution).

**Verification**: existing retriever tests pass behind a compatibility shim; add `tests/retriever/agent-loop.test.ts` for the new shape; existing E2E continues to pass.

#### Phase 5 — Skills-as-strategies + filesystem discovery

Now that the primitives have proven themselves through 2–4, expose them to extension authors:

- `pi.registerTool('piorx:advisor', ...)` — interactive advisor in pi's main loop, wire-compat with rpiv-advisor's zero-arg contract (returns `{content, details: {advisorModel, effort, usage, stopReason, errorMessage}}`).
- `.piorx/strategies/<name>.md` — markdown frontmatter for `AdvisorStrategy` (skill-shaped, but pi-flavored — same conventions Mario uses for slash commands). Discovered from `~/.config/piorx/strategies/` and `.piorx/strategies/` (mirroring pi's two-scope discovery for AGENTS.md and extensions).
- An `@piorx/extension-api` shim package exposing `Stage`, `Pipeline`, `Gate`, `AdvisorStrategy`, and `piorxRegistry` for third-party extensions.
- An example second-pipeline (e.g. `piorx.analysis-only` — skips execution) ships as a reference for how to register a non-default flow.

**Verification**: integration test that a strategy file is discovered, registered, and invocable as a tool from an active synthesis stage.

#### Phase 6 (optional, decoupled) — Recursive promotion as data

Recursive promotion (`src/conductor/recursive-intent.ts`) currently always targets Stage 1 (`recursive-intent.ts:48–79`). Promote-target becomes a field on `Pipeline` (`restartTarget?: string`) so an extension's pipeline can recurse into a different starting stage. This is the smallest knob that closes "every workflow opinion is now a pipeline field."

---

## Critical files

**New (Phase 1)**:

- `src/runtime/stage.ts`
- `src/runtime/workflow-executor.ts`
- `src/runtime/gate.ts`
- `src/runtime/registry.ts`
- `src/runtime/workflows/piorx-default.workflow.md`
- `tests/runtime/workflow-executor.test.ts`
- `tests/runtime/workflow-spec-readability.test.ts`
- `tests/runtime/control-baseline.test.ts`
- `tests/runtime/extension-conformance.test.ts`

**Extended (Phase 1, artifact kernel)**:

- `src/artifacts/types.ts` — adds `WorkflowSpecV1`.
- `src/artifacts/schemas.ts` — adds `WorkflowSpecV1` validator (structural). Registry adds boot-time referential validation.

**Refactored (Phase 1, behavior-preserving)**:

- `src/conductor/stage-machine.ts:32–40` — transitions derived from the loaded workflow spec; in-code transition whitelist removed.
- `src/conductor/{stage-1,expansion,retrieval,synthesis,recursive-intent}.ts` — wrapped as `Stage` adapters that register against stage ids declared in the workflow spec.
- `src/conductor/evidence-overrides.ts` — first concrete `GateOp` implementation; re-export pattern for extension authors.
- `src/services/*-dispatch.ts` — stay as the implementation backing `Stage.run`; no changes to their typed boundaries.
- `extensions/conductor-extension.ts:1040–1167` — `runPipelineFromIntent` collapses to `workflowExecutor.run('piorx/workflow/default@1', initialIntent, ctx)`.
- `src/runtime/session-state.ts:46–67` — `lineage[]` extended to record: stage id, gate decisions (with the four-way `GateOutcome`), the **role** that signed each decision (requestor / reviewer / execution_authority — even when one user fills all three, the role is recorded for forward-compat), the **workflow_spec_id** active at run time (so re-running the workflow against a different spec version is reconstructable), and **source-access events** surfaced from worker boundaries (which file was read by which stage at which budget).

**Extended (Phase 2)**:

- `src/runtime/config.ts` — `PhaseModelConfig`, `AdvisorConfig`, `models` block.
- `extensions/conductor-extension.ts:86–130` — `getModelText(...)` takes a `phase` argument; resolves executor from `runtime.config.models[phase]`.

**Created (Phase 2)**:

- `src/runtime/run-with-advisor.ts` — three modes (`inline`, `custom`, `server`), defense-in-depth from Claude Code's integration.

**Touched (Phase 3+)**:

- `src/synthesis/worker.ts`, `src/synthesis/prompt.ts` (Phase 3).
- `src/retriever/agent.ts`, `agent-prompt.ts`, `agent-types.ts` (Phase 4 — collapse onto `agentLoop`).
- `src/execution/worker.ts` (Phase 4 — real implementation).
- `.piorx/strategies/` discovery + `@piorx/extension-api` package (Phase 5).

**Reused as-is**:

- `src/artifacts/{types,schemas,store,ids}.ts` — the deterministic kernel is already in good shape.
- `src/runtime/paths.ts` — extended only to add a strategies/ subdirectory in Phase 5.
- `src/retriever/{scout,executor,normalize,worker}.ts` — Scout-side untouched in Phase 4; agent-side rewrites onto `agentLoop`.
- `src/services/evidence-assembler.ts` — already deterministic; assembler stays as the canonical "no-model Stage" example.

---

## Verification

Each phase has a fixed gate: **all prior tests pass byte-identically**. The kernel's determinism guarantees this holds (the assembler is byte-identical given inputs; the artifact store validates on every read/write).

**Phase 1 gate** (most load-bearing): the existing E2E regression `tests/interaction/agentic-retrieval-flow.test.ts` produces an identical artifact graph before and after the refactor. Diff the recorded artifact IDs — they should differ only in their generated suffixes, never in shape, type, or contents.

**Phase 2 gate**: with `advisor.mode === 'none'` for every stage, behavior matches Phase 1 exactly. With `advisor.mode === 'custom'` against a stubbed advisor model, telemetry records appear in `.pi/orchestra.log` and the executor's output is unchanged.

**Phase 3 gate**: the synthesis stub's deterministic output is replaced by a real model call, but with a stubbed model callback returning the same canned analysis-report/change-spec, the resulting artifact validates against the existing schemas. Real-model evals come behind a `--with-real-models` test flag.

**Phase 4 gate**: retriever migration to `agentLoop` reproduces the existing 14 agent-loop tests' assertions (bounded budgets, stop reasons, fallback recommendation, sanitization).

**Phase 5 gate**: a hand-authored `.piorx/strategies/foo.md` is discovered, registered, and successfully invokes the advisor from an active synthesis stage. The rpiv-advisor wire-compat is checked against its npm package's actual return shape.

**End-to-end smoke** (every phase, blocking): `bun test` is green; `bunx tsc --noEmit` is clean; running piorx against the existing fixture intent (`tests/fixtures/sample-artifacts/intent-capture-v1.json` style) drives the default pipeline through to a synthesis artifact without manual intervention.

---

## What this plan deliberately defers

- **MCP support**. Mario rejects MCP. piorx may eventually expose MCP through an adapter Stage, but it's not a Phase 1–5 concern.
- **Distinct extensions per stage**. piorx stays a single pi extension. Splitting into co-registered single-stage extensions is reachable from this plan but not required by it.
- **`.claude/` discovery**. The user opted for pi-flavored conventions; Claude Code's wire format is the inspiration, not the import.
- **Full LangGraph-style state graph**. The default Pipeline is a linear-with-conditional-edges DAG, which covers piorx's six-stage flow + recursive promotion. If a future user needs cycles or true graph topology, the `Pipeline` type can extend without breaking existing pipelines.
- **Lexicon / RDF / OWL machinery as a runtime substrate.** The _discipline_ is in foundation — typed boundaries, schema-validated artifacts, namespaced IDs (`piorx/intent-capture@1`), and (load-bearing) the **workflow spec as the natural Lexicon-shaped object**: a high-level, agent-readable artifact describing what an agent workflow does. The _runtime substrate_ (NSID dereferencing, triple stores, DL reasoners, JSON-LD wire format on per-call artifacts, distributed-publishing protocol, schema registry hosted at `piorx.dev`) is roadmap, not foundation — it pays off only with ecosystem demand we don't yet have evidence for. The Phase 1 namespacing leaves room to add the registry then, with evidence in hand; promoting the workflow itself to an artifact gives agent-reasonable workflows now.

### Governance — deferred to roadmap

The Phase 1 plan adopts the §19 minimum-control baseline (operating mode, reviewable decision gate before execution, lineage immutability, source-access restriction, recorded approval disposition, four-way gate outcomes, workflow version traceability, extension conformance). The richer governance overlay surfaced by the PMI review is **acknowledged as roadmap, not built now**:

- **Multi-stakeholder governance** (separated Policy Authority, Workflow Owner, Reviewer, Execution Authority, Operator roles) — piorx today is single-user CLI on a developer's laptop; the user fills every role. Lineage records the _role_ that signed each decision (Phase 1 polish), so the upgrade path to multi-stakeholder is a registry-side check, not a schema migration.
- **Formal change control for workflow definitions** beyond git — baseline + change history + emergency procedures + retrospective review. Today: workflow specs are markdown-with-YAML-frontmatter artifacts in the repo, versioned by git, behavioral changes bump `@N`. Sufficient until evidence justifies more.
- **Tamper-resistant audit** — append-only artifacts give most of the integrity property; signing / hash chains / WORM storage is roadmap.
- **Metrics and continuous-improvement framework** — cycle time, approval latency, rejection / override rates, validation-failure rate. Operational dashboards assume an operational team; premature for Phase 1.
- **Policy engine references** in lineage — when an external policy engine exists to refer to. Roadmap.
- **Risk register per workflow** — explicit _pushback_, not deferral. The runtime _enforces_ risks (artifact validators handle malformed outputs; bounded budgets handle exhaustion; gates handle policy bypass). Asking workflow authors to enumerate risks in YAML for every workflow is governance-as-bureaucracy that turns "controlled environment" into "no one wants to author a workflow." The risk _categories_ the PMI review listed are useful as a target the runtime should cover — but they're not workflow-author obligations.

The deferral is **visible** (this section names them), the upgrade path is **clear** (Phase 1 schema fields are forward-compatible with multi-stakeholder roles, formal change control, etc.), and nothing in Phase 1 builds in a way that blocks any of these later. The default workflow's control properties — every deliverable approved, every override audit-trailed, every advisor consultation telemetered — are preserved as composability is added because the registry enforces `mandatory_controls` and "platform policy prevails" at boot.

The throughline: **stop encoding workflow opinions in code; start encoding them in data.** Every primitive in this plan is one step toward that goal.
