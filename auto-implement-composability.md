# Composability Primitives — Implementation Plan

A task-oriented implementation roadmap for the composability primitives described in [`docs/composability.md`](./docs/composability.md). The design rationale, alternatives, and deferred items live in `docs/composability.md` — this file is the executable plan that drives `composability-tasks.json` and the auto-implement loop.

## Goal

Move from:

- a monolithic six-stage pipeline hardcoded in `runPipelineFromIntent`
- in-code stage transition whitelist
- one `getModelText` against `ctx.model` for every LLM call
- per-stage opinion baked into TS

To:

- workflow as a first-class typed artifact (`piorx/workflow-spec@1`), markdown with YAML frontmatter
- runtime executor over a loaded spec, no in-code orchestration
- per-phase model + advisor configuration
- typed gate primitive with four-way outcome routing
- registry that enforces `mandatory_controls` and platform policy at boot
- skills-as-strategies discoverable from `.piorx/strategies/`

The throughline: **stop encoding workflow opinions in code; start encoding them in data.**

---

## Source of truth split

- **`docs/composability.md`** — design intent, primitives, migration phases, deferred items, and conflict-resolution rules. The canonical reference for _why_.
- **This file (`auto-implement-composability.md`)** — task-level plan, phase gates, verification criteria. The reference for _what next_.
- **`composability-tasks.json`** — atomic tasks consumed by the auto-implement script. The reference for _which tasks_.

If `docs/composability.md` and this file disagree, `docs/composability.md` wins. Update this file rather than letting drift accumulate.

---

## Phases at a glance

| Phase | Sprint   | Tasks | Theme                                                                                                                                                                       |
| ----- | -------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Sprint 1 | 14    | Scaffolding (no behavior change). The artifact kernel, runtime types, registry, default workflow spec, executor, gate generalization, lineage extension, conformance tests. |
| 2     | Sprint 2 | 4     | `PhaseModelConfig` + `runWithAdvisor`. Per-phase model resolution; three advisor modes; behavior preservation with `advisor.mode='none'`.                                   |
| 3     | Sprint 3 | 3     | First real LLM-driven Stage. Synthesis worker becomes the canonical advisor-aware Stage.                                                                                    |
| 4     | Sprint 4 | 3     | Retriever onto `agentLoop`; execution worker becomes real.                                                                                                                  |
| 5     | Sprint 5 | 4     | Skills-as-strategies + filesystem discovery. `@piorx/extension-api` shim. Reference second pipeline.                                                                        |
| 6     | Sprint 6 | 1     | (Optional, decoupled.) Promote recursive promotion target to a spec field.                                                                                                  |

Each phase is independently shippable, behavior-preserving where possible, and gated on the previous phase passing all existing tests (497 today).

---

## Design principles (selected from `docs/composability.md`)

1. **Workflow is data, not code.** The spec is a `piorx/workflow-spec@1` artifact, schema-validated like every other artifact. TS implementations register against stage ids declared in the spec.
2. **Stage is a typed function over typed artifacts.** Inputs and output are artifact-type ids; `run(ctx)` is pure-ish.
3. **Gate is the HITL/override seam with four-way outcome.** `accepted | rejected_governance | rejected_technical | escalated`. Mandatory-control gates can never be removed or weakened by an extension.
4. **Platform policy prevails over workflow configuration on conflict.** The registry rejects extensions that violate `mandatory_controls` or weaken access policies at boot.
5. **Per-phase model + advisor.** No `ctx.model` bottleneck. Each Stage declares its `modelConfig`; runtime resolves the executor per phase.
6. **Agent-readability is a Phase 1 acceptance criterion.** An agent reading the workflow spec without TS source must be able to answer canonical questions about the workflow.

---

## Phase 1 — Scaffolding (no behavior change)

**Goal:** every primitive in place; default workflow runs end-to-end through the new executor with byte-identical output.

### New files

- `src/runtime/stage.ts` — `Stage<>`, `StageContext`, `StageResult`, `StageControl` types.
- `src/runtime/gate.ts` — `GateSpec`, `GateOp`, `GateOpValidation`, `GateOutcome` (four-way).
- `src/runtime/registry.ts` — `WorkflowRegistry` singleton-per-extension. Loads workflow specs, registers Stage implementations by id, validates referential integrity at boot, enforces extension conformance, fails loudly on drift.
- `src/runtime/workflow-executor.ts` — runtime executor over a loaded `WorkflowSpecV1`. Linear-with-conditional-edges traversal, gate invocation, recursive promotion. Replaces in-code `runPipelineFromIntent`.
- `src/runtime/workflows/piorx-default.workflow.md` — the default piorx workflow as a markdown file with YAML frontmatter, hand-authored, schema-validated as `piorx/workflow-spec@1`. The YAML carries shape; the markdown body carries function and purpose.
- `tests/runtime/workflow-executor.test.ts`
- `tests/runtime/control-baseline.test.ts` — section-19 minimum control-baseline conformance test.
- `tests/runtime/workflow-spec-readability.test.ts` — protects the natural-language fields against drift.
- `tests/runtime/extension-conformance.test.ts` — boot-time rejection of malformed extensions.

### Refactor (behavior-preserving)

- `src/conductor/stage-machine.ts:32–40` — transitions derived from the loaded workflow spec; in-code transition whitelist removed.
- `src/conductor/{stage-1,expansion,retrieval,synthesis,recursive-intent}.ts` — wrapped as `Stage` adapters that register against stage ids declared in the workflow spec.
- `src/conductor/evidence-overrides.ts` — first concrete `GateOp` implementation; re-export pattern for extension authors.
- `src/services/*-dispatch.ts` — stay as the implementation backing `Stage.run`; no changes to their typed boundaries.
- `extensions/conductor-extension.ts:1040–1167` — `runPipelineFromIntent` collapses to `workflowExecutor.run('piorx/workflow/default@1', initialIntent, ctx)`.
- `src/runtime/session-state.ts:46–67` — `lineage[]` extended to record stage id, gate decisions (with the four-way `GateOutcome`), the role that signed each decision (requestor / reviewer / execution_authority), the `workflow_spec_id` active at run time, and source-access events surfaced from worker boundaries.

### Extended (artifact kernel)

- `src/artifacts/types.ts` — adds `WorkflowSpecV1`. Fields: `id`, `name`, `description`, `goals[]`, `stages[]` (each with `id`, `name`, `description`, `inputs`, `output`, `model_class`, `gates`), `edges[]` (with structured `when` predicates plus natural-language `description`), `recursive_promotion_target`, `operating_mode`, `mandatory_controls[]`, `governance` sub-block, `extends`, `stage_overrides`, `workflow_ref`/inline `workflow`.
- `src/artifacts/schemas.ts` — adds the `WorkflowSpecV1` runtime validator (structural shape). The `WorkflowRegistry` layers a _referential_ check at boot.

### Hierarchical-namespace migration

Mechanical rename of artifact-type strings from flat ids (`intent-capture-v1`) to namespaced ids (`piorx/intent-capture@1`). Touches `types.ts`, `schemas.ts`, all fixtures under `tests/fixtures/sample-artifacts/`, and store path mappings. Costs nothing today; lets a future third-party stage register `@yourhandle/decision-tree@1` against the same registry.

### Phase 1 gate (most load-bearing)

The existing E2E regression `tests/interaction/agentic-retrieval-flow.test.ts` produces an identical artifact graph before and after the refactor. Diff the recorded artifact ids — they should differ only in their generated suffixes, never in shape, type, or contents.

### Out of scope this phase

Any new LLM-driven behavior, advisor wiring, filesystem discovery of third-party workflow specs (registry loads piorx-shipped specs only), public `@piorx/extension-api` package, agent-side spec-to-code compilation tooling, and the deferred governance items enumerated in `docs/composability.md`'s "Governance — deferred to roadmap" section.

---

## Phase 2 — `PhaseModelConfig` + `runWithAdvisor`

**Goal:** per-phase model resolution; three-mode advisor helper; behavior preservation with `advisor.mode='none'` everywhere.

### New / extended

- `src/runtime/config.ts` extended with `PhaseModelConfig`, `AdvisorConfig`, the `models: { restatement, expansion, retrieval, synthesis, execution }` block. Validator refuses non-canonical executor/advisor pairs by default (advisor doc §3.2 + §4.1 — the API matrix is canonical).
- `src/runtime/run-with-advisor.ts` — three modes:
  - `inline` — deterministic pre-call.
  - `custom` — pi-ai tool-loop (default; preserves per-side-call billing).
  - `server` — `StreamOptions.onPayload` + `StreamOptions.headers`, behind canonical-pair validator.
    All three emit a uniform telemetry record to `.pi/orchestra.log`.
- `getModelText` (`extensions/conductor-extension.ts:86–130`) takes a `phase: keyof PhaseModelConfigs` parameter; resolves executor from `runtime.config.models[phase]`. `ctx.model` stays as a fallback for one minor version.
- Defense-in-depth: always send the `advisor-tool-2026-03-01` beta header on phases that touch shared history when advisor is enabled (Claude Code §4.2); strip advisor blocks otherwise (§4.3); honor `PIORX_DISABLE_ADVISOR` env var (§4.6). All in `run-with-advisor.ts`.

### Phase 2 gate

With `advisor.mode === 'none'` for every stage, behavior matches Phase 1 exactly. With `advisor.mode === 'custom'` against a stubbed advisor model, telemetry records appear in `.pi/orchestra.log` and the executor's output is unchanged.

---

## Phase 3 — First real LLM-driven Stage (synthesis worker)

**Goal:** synthesis becomes the canonical example of an advisor-aware Stage, with structured output derived from existing artifact schemas.

### Changed

- `src/synthesis/worker.ts` — replaces the stub with a real implementation that calls `runWithAdvisor` with `output_config.format` set from the JSON-Schema translation of `analysis-report-v1` and `change-spec-v1` validators (mechanical from `src/artifacts/schemas.ts`).
- `src/synthesis/prompt.ts` — adds the `ADVISOR_TOOL_INSTRUCTIONS` (advisor doc §4.5, verbatim from Claude Code) when advisor is enabled.
- The `synthesis.confirm-task-type` Gate gets a sibling `synthesis.advisor-review` Gate — opt-in, off by default.

### Phase 3 gate

Snapshot tests for both task types against a stubbed advisor; the existing E2E regression continues to pass with advisor disabled. New E2E asserts an enabled advisor produces a bundle with the expected `advisor_iterations` telemetry but byte-identical synthesis output (model is stubbed).

---

## Phase 4 — Retriever onto `agentLoop`; execution worker, real

**Goal:** retriever migrates onto the shared `agentLoop`; execution worker stops being a stub; bounded budgets and existing test coverage preserved.

### Changed

- Retriever rewrite collapses `src/retriever/agent.ts` (≈500 LOC) onto `agentLoop` from `@earendil-works/pi-agent-core` (already a transitive dep). Advisor slots in as one more `Tool`. The bounded-budget logic (`shouldStopAfterTurn`) is reused.
- `src/execution/worker.ts` — same pattern as synthesis: `Stage` + `runWithAdvisor` + structured output (the `change-spec-v1` resolution).

### Phase 4 gate

Existing retriever tests pass behind a compatibility shim; `tests/retriever/agent-loop.test.ts` covers the new shape; the existing agentic-retrieval E2E continues to pass.

---

## Phase 5 — Skills-as-strategies + filesystem discovery

**Goal:** primitives are exposed to extension authors. A user can drop a strategy file in `.piorx/strategies/` and have it discovered, registered, and invocable.

### Changed

- `pi.registerTool('piorx:advisor', ...)` — interactive advisor in pi's main loop, wire-compat with rpiv-advisor's zero-arg contract (returns `{content, details: {advisorModel, effort, usage, stopReason, errorMessage}}`).
- `.piorx/strategies/<name>.md` — markdown frontmatter for `AdvisorStrategy` (skill-shaped, pi-flavored). Discovered from `~/.config/piorx/strategies/` and `.piorx/strategies/` (mirroring pi's two-scope discovery for AGENTS.md and extensions).
- `@piorx/extension-api` shim package exposes `Stage`, `Pipeline` (workflow), `Gate`, `AdvisorStrategy`, and `piorxRegistry` for third-party extensions.
- An example second-pipeline (`piorx.analysis-only` — skips execution) ships as a reference for how to register a non-default flow.

### Phase 5 gate

Integration test: a hand-authored `.piorx/strategies/foo.md` is discovered, registered, and successfully invokes the advisor from an active synthesis stage. The rpiv-advisor wire-compat is checked against its npm package's actual return shape.

---

## Phase 6 (optional, decoupled) — Recursive promotion as data

**Goal:** the smallest knob that closes "every workflow opinion is now in the spec."

### Changed

- `src/conductor/recursive-intent.ts:48–79` — promotion target is fully driven by the workflow spec's `recursive_promotion_target` field; no hardcoded Stage 1 reference remains.

### Phase 6 gate

Default workflow's `recursive_promotion_target=restatement` preserves current behavior; an alternative workflow with a different target is exercisable in tests.

---

## End-to-end smoke (every phase, blocking)

- `bun test` is green.
- `bunx tsc --noEmit` is clean.
- Running piorx against the existing fixture intent (`tests/fixtures/sample-artifacts/intent-capture-v1.json` style) drives the default pipeline through to a synthesis artifact without manual intervention.

---

## Auto-implement integration

This plan pairs with `composability-tasks.json` and the auto-implement script pattern from `scripts/auto-implement-agentic-retrieval.sh`. To run an auto-implement loop for composability work, copy the script to `scripts/auto-implement-composability.sh` and update the file references at the top:

```bash
TASKS_FILE="./composability-tasks.json"
PLAN_FILE="./auto-implement-composability.md"
DEV_LOG="./composability-dev-log.txt"
```

The script's logic (sonnet picker → opus implementer → bun-check repair loop → sonnet evaluator → haiku committer) needs no other changes; the prompts reference the `TASKS_FILE` and `PLAN_FILE` paths through bash variables.

The Phase 1 gate is load-bearing for the entire plan: the auto-implement loop should not advance to Phase 2 tasks until every Phase 1 task is `completed` and the existing E2E regression passes byte-identically.

---

## What this plan deliberately defers

See `docs/composability.md` "What this plan deliberately defers" and "Governance — deferred to roadmap" for the full list. Selected highlights:

- **MCP support.** Eventually exposable through an adapter Stage, but not a Phase 1–5 concern.
- **Distinct extensions per stage.** piorx stays a single pi extension.
- **Multi-stakeholder governance.** Lineage records the _role_ signing each decision (Phase 1, COMP-P1-T12), so the upgrade path is a registry-side check, not a schema migration.
- **Tamper-resistant audit.** Append-only artifacts give most of the integrity property; signing / hash chains / WORM storage is roadmap.
- **Risk register per workflow.** Explicit _pushback_, not deferral. The runtime _enforces_ risks; asking workflow authors to enumerate them is governance-as-bureaucracy.

The deferral is **visible**, the upgrade path is **clear**, and nothing in Phase 1 builds in a way that blocks any of these later.
