# pi-orchestra Implementation Specification

A retrospective spec bridging the prototype at `/Users/russfugal/code/sks/pi/` (single-file "Slow & Cheap" extension, early April 2026) and the superseding implementation at `/Users/russfugal/code/sks/piorx/` (pi-orchestra, mid-April 2026).

This document is not the original architectural spec — those live at `/Users/russfugal/code/sks/piorx/docs/specification/00-overview.md` through `03-prompts-and-protocol.md`. This is an as-built description, a delta log against the prototype, and an opinionated list of what's worth revisiting.

---

## 1. What piorx actually implements

### 1.1 Entry points and packaging

- **`/Users/russfugal/code/sks/piorx/package.json`** — package `pi-orchestra` v0.1.0, `type: module`, exposes one bin: `piorx → ./bin/piorx`. Scripts: `test` (bun test), `typecheck` (tsc --noEmit), `lint` (biome), `check`, `format`, `install:pi`, `doctor`, `smoke`. Runtime devDeps only (`@types/bun`, `biome`, `prettier`, `typescript`) — no `@anthropic-ai/sdk`, `@sinclair/typebox`, or `zod` at the project level. The SDK bridge is provided by the globally-installed `@mariozechner/pi-coding-agent` host.
- **`/Users/russfugal/code/sks/piorx/bin/piorx`** — bash wrapper that resolves the repo-local extension and invokes `pi -e extensions/conductor-extension.ts "$@"`. Requires `pi` on PATH (installed via `scripts/install-pi.sh` → `bun add -g @mariozechner/pi-coding-agent`).
- **`/Users/russfugal/code/sks/piorx/extensions/conductor-extension.ts`** — the single extension entrypoint (~1,280 lines). Bootstraps config, artifact store, and stage machine on `session_start`; intercepts user text on `input` from idle stage; drives the entire 6-stage pipeline; parses `<file name="...">...</file>` blocks in the initial intent before restatement; prompts for narrow evidence overrides between plan generation and materialization.

### 1.2 The 6-stage conductor workflow + recursive restart

Fully implemented end-to-end in `conductor-extension.ts` with per-stage controllers in `src/conductor/`:

| Stage                   | Controller                               | Service dispatch                                     | Worker                                                                              | Output artifact                              |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| 1. Intent restatement   | `src/conductor/stage-1.ts`               | —                                                    | direct model call (`restateWithModel`); `src/util/intent-files.ts` pre-parses files | `intent-capture-v1`, `intent-restatement-v1` |
| 2. Expansion (optional) | `src/conductor/expansion.ts`             | `src/services/intent-expand.ts` (stub contract only) | direct model call (`expandWithModel`)                                               | `expansion-input-v1`, `intent-spec-v1`       |
| 3. Retrieval            | `src/conductor/retrieval.ts` (gate only) | `src/services/retrieval-dispatch.ts`                 | `src/retriever/scout.ts` + `src/retriever/agent.ts` (bounded) + `worker.ts`         | `retrieval-index-v1`                         |
| 4. Evidence             | `src/conductor/evidence-plan.ts` + `src/conductor/evidence-overrides.ts` | `src/services/evidence-assembler.ts`                 | — (deterministic)                                                                   | `evidence-plan-v1`, `evidence-bundle-v1`     |
| 5. Synthesis            | `src/conductor/synthesis.ts`             | `src/services/synthesis-dispatch.ts`                 | `src/synthesis/worker.ts` (stub)                                                    | `analysis-report-v1` or `change-spec-v1`     |
| 6. Execution            | —                                        | `src/services/execution-dispatch.ts`                 | `src/execution/worker.ts` (stub)                                                    | `execution-report-v1`                        |
| Recursive               | `src/conductor/recursive-intent.ts`      | `src/services/artifact-promote.ts`                   | —                                                                                   | `recursive-intent-v1`                        |

State transitions are enforced by the `StageMachine` class in `/Users/russfugal/code/sks/piorx/src/conductor/stage-machine.ts`, which wraps the pure session-state helpers in `/Users/russfugal/code/sks/piorx/src/runtime/session-state.ts` and persists every mutation to `.pi/session-state.json`.

### 1.3 The eleven v1 artifact types

Defined as a discriminated union on `artifact_type` in `/Users/russfugal/code/sks/piorx/src/artifacts/types.ts`; runtime validators in `/Users/russfugal/code/sks/piorx/src/artifacts/schemas.ts`; ID generation in `/Users/russfugal/code/sks/piorx/src/artifacts/ids.ts`; persistence in `/Users/russfugal/code/sks/piorx/src/artifacts/store.ts`:

1. `intent-capture-v1`
2. `intent-restatement-v1`
3. `expansion-input-v1`
4. `intent-spec-v1`
5. `retrieval-index-v1`
6. `evidence-plan-v1`
7. `evidence-bundle-v1`
8. `analysis-report-v1`
9. `change-spec-v1`
10. `execution-report-v1`
11. `recursive-intent-v1`

Each type has a directory under `.pi/artifacts/` (see `/Users/russfugal/code/sks/piorx/src/runtime/paths.ts`). Artifacts are immutable; revisions create new IDs, with lineage tracked in session state.

The v1 shapes have grown in place (no version bumps — see §3.5) to support the agentic retrieval architecture landed in April 2026:

- **`intent-capture-v1`** now carries `cleaned_user_intent` (raw intent minus `<file>` blocks) and optional `intent_file_refs: Array<{ path; source: 'inline' | 'reference-only' | 'disk' }>` so downstream stages work from a clean intent without inheriting giant inline file bodies.
- **`retrieval-index-v1`** adds `strategy_summary`, `scout_terms`, per-file `selection_tier: 'selected' | 'reserve'` + `selection_reason` + `default_evidence_mode: 'exclude' | 'summary' | 'summary+ast' | 'spans' | 'whole_file'`, per-symbol `selected_by_default` + `default_neighbor_lines` + `selection_reason`, and a top-level `recommended_evidence` block that is the retriever's authored default evidence plan (file include-flag triple + per-symbol span selections + three top-level `include_*` toggles). Still structural-only: no raw file bodies are stored or inspectable.
- **`evidence-plan-v1`** is built from `recommended_evidence` by `createRecommendedEvidencePlan(index, options?)` in `/Users/russfugal/code/sks/piorx/src/conductor/evidence-plan.ts`. The conductor may then patch that default through the narrow `applyEvidenceOverrides` API in `/Users/russfugal/code/sks/piorx/src/conductor/evidence-overrides.ts` — nine deterministic operations (`promote_file`, `demote_file`, `set_file_mode`, `include_symbol`, `exclude_symbol`, `set_neighbor_lines`, and three `toggle_*` flags) that validate every file/symbol reference against the retrieval artifact.

### 1.4 Hard architectural boundaries (enforced in code and tests)

- **Conductor opacity.** No file-reading tools imported into `/Users/russfugal/code/sks/piorx/src/conductor/**`. File I/O lives only in the retriever worker/scout/agent/executor, the evidence assembler, and the execution worker.
- **Exception: user-supplied intent files (shipped).** `/Users/russfugal/code/sks/piorx/src/util/intent-files.ts` parses `<file name="...">...</file>` blocks from the initial user input and produces a bounded `restatementContext` that the conductor hands to `restateWithModel`. Those paths become `intent_file_refs` + `tagged_files` on `intent-capture-v1`. This is a narrow, pre-restatement exception — no general repo-reading capability is exposed.
- **Retriever boundary (shipped agentic form).** The retriever is now two-phase: a deterministic `src/retriever/scout.ts` narrows to ≤8 selected + ≤4 reserve candidates, and `src/retriever/agent.ts` drives a bounded model-driven loop (defaults: 3 rounds, 4 actions/round, 12 file reads total, 200 lines / 16 KiB / read, 256 KiB total observation budget) whose actions (`read_file`, `search_content`, `search_paths`, `follow_imports`) run through `src/retriever/executor.ts`'s repo-root-sandboxed executors. The pi-host model callback is injected at the extension edge (`makeRetrieverAgentModel` in `extensions/conductor-extension.ts`); `src/retriever/**` has no `pi-ai` / `pi-coding-agent` imports. Raw file contents never leave the retriever boundary — `retrieval-index-v1` remains structural-only.
- **Retriever response embedding.** `evidence-plan-v1` embeds the full `retrieval-index-v1` byte-for-byte; `verifyEmbeddedIndex()` in `/Users/russfugal/code/sks/piorx/src/conductor/evidence-plan.ts` enforces equality.
- **Deterministic evidence assembly.** Same plan + index + repo state → byte-identical bundle. Verified by `/Users/russfugal/code/sks/piorx/tests/assembler/determinism.test.ts` (4 tests).
- **No silent pruning.** `/Users/russfugal/code/sks/piorx/src/util/budget.ts` returns structured `over_budget_reasons` rather than trimming; the assembler refuses unknown file/symbol IDs.
- **Conductor-safe inspection.** `/Users/russfugal/code/sks/piorx/src/services/artifact-inspect.ts` refuses to return raw evidence-bundle payloads; the conductor only sees structural summaries.

### 1.5 Extension API surface actually used

From `/Users/russfugal/code/sks/piorx/extensions/conductor-extension.ts`:

- `pi.on('session_start', ...)` — boot + status
- `pi.on('input', ...)` — idle-stage interception, triggers `runPipelineFromIntent`
- `pi.registerCommand('orchestra-status', ...)` — config/stage summary
- `pi.registerCommand('orchestra-log', ...)` — log path
- `pi.registerCommand('orchestra-reset', ...)` — reset to idle

Model invocation uses `@mariozechner/pi-ai`'s `complete()` via the helper `getModelText(systemPrompt, userText, ctx)` at roughly lines 82–126.

**No `pi.registerTool(...)` calls.** Piorx does not expose LLM-callable tools. Model guidance happens via centralized system prompts in `/Users/russfugal/code/sks/piorx/src/conductor/prompts.ts` and the retriever/synthesis prompt assemblers.

### 1.6 Runtime state on disk

- `/Users/russfugal/code/sks/piorx/.pi/artifacts/{intents,retrieval,evidence-plans,evidence-bundles,synthesis,execution}/` — typed subdirectories, one JSON file per artifact
- `/Users/russfugal/code/sks/piorx/.pi/session-state.json` — current stage, artifact pointers, lineage
- `/Users/russfugal/code/sks/piorx/.pi/orchestra.log` — append-only JSON event log

### 1.7 Test coverage

498 passing tests across 28 files under `/Users/russfugal/code/sks/piorx/tests/`: `artifacts/` (51), `assembler/` (186), `conductor/` (40), `execution/` (26), `interaction/` (77), `retriever/` (84), `synthesis/` (34), plus fixtures. Notable additions from the agentic-retrieval work: `tests/retriever/scout.test.ts` and `tests/retriever/agent.test.ts` exercise the scout + bounded agent loop with a queue-backed `AgentModelCallback`; `tests/assembler/evidence-overrides.test.ts` covers the full override op matrix (success + failure paths + span-seeding semantics); `tests/interaction/agentic-retrieval-flow.test.ts` runs the end-to-end Stage 1 → retrieval dispatch → `createRecommendedEvidencePlan` → assembler flow both scout-only and agent-driven. `tsc --noEmit` is clean. CI is wired at `/Users/russfugal/code/sks/piorx/.github/workflows/ci.yml`.

### 1.8 Planning artifacts at the repo root

- **`/Users/russfugal/code/sks/piorx/HANDOFF_PROMPT.md`** — initial instruction to the implementer; points at `docs/specification/` and asks for a phased plan.
- **`/Users/russfugal/code/sks/piorx/implementation-phase-1.md`** — the original phased plan; 6 phases, per-phase scope/files/interfaces/tests/exit criteria; explicitly defers batch queuing.
- **`/Users/russfugal/code/sks/piorx/implementation-tasks.json`** — 27 tasks (P1-T1 … P6-T5), all marked complete.
- **`/Users/russfugal/code/sks/piorx/implementation-agentic-retrieval.md`** — the 8-sprint plan for the agentic-retrieval redesign (AR-P1 … AR-P8): intent-file context, deterministic scout, bounded retriever agent, structural retrieval artifact, retriever-authored default evidence plan, narrow conductor overrides, extension wiring, and docs + regression tests. See §3.4 below.
- **`/Users/russfugal/code/sks/piorx/agentic-retrieval-tasks.json`** — the per-sprint task tracker for the agentic-retrieval work; all AR-P1 through AR-P8 tasks marked complete.
- **`/Users/russfugal/code/sks/piorx/agentic-retrieval-dev-log.txt`** — chronological dev log for the agentic-retrieval sprints.
- **`/Users/russfugal/code/sks/piorx/dev-log.txt`** — chronological session log for the original 6-phase build-out.
- **`/Users/russfugal/code/sks/piorx/docs/completion_summary.md`** — phase-by-phase summary of what shipped in the original build-out.
- **`/Users/russfugal/code/sks/piorx/docs/batch-api-assessment.md`** — post-hoc analysis of how batch support would be added (see §3.1 below).

---

## 2. What the `/Users/russfugal/code/sks/pi/` prototype had that did not carry over

The prototype was a single-file extension at **`/Users/russfugal/code/sks/pi/slow-cheap-extensions.ts`** (534 lines) plus six overlapping markdown docs (now at `/Users/russfugal/code/sks/docs/` after this move: `slow-cheap.md`, `batch-processing.md`, `structured-outputs.md`, and the duplicative `README_EXTENSION.md`, `EXTENSION_README.md`, `EXTENSION_SUMMARY.md`, `QUICK_START.md`, `IMPLEMENTATION_SUMMARY.md`, `CHECKLIST.md` that remain in `/Users/russfugal/code/sks/pi/`).

| Prototype feature                                                                                                                               | Piorx status                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic Message Batches API integration** (`client.messages.batches.create/retrieve/results/list/cancel`)                                   | **Not implemented.** Piorx uses direct `complete(...)` calls for restatement, expansion, and (stubbed) synthesis. Explicitly deferred — see `/Users/russfugal/code/sks/piorx/docs/batch-api-assessment.md`. |
| **Batch polling loop** with `setInterval` + `session_shutdown` cancelation                                                                      | **Not present.** No async job concept in the stage machine; every stage completes in a single pass.                                                                                                         |
| **Four slash commands** `/batch-create`, `/batch-status`, `/batch-results`, `/batch-list`                                                       | **Replaced** with `orchestra-status`, `orchestra-log`, `orchestra-reset`. Different concern (pipeline introspection, not batch ops).                                                                        |
| **Three LLM-callable tools** `create_batch`, `batch_status`, `batch_results` via `pi.registerTool(...)` with TypeBox schemas                    | **Not present.** Piorx registers no LLM tools; the extension drives the pipeline via `on('input')` interception rather than offering capabilities the model can call.                                       |
| **TypeBox** (`@sinclair/typebox`) runtime schemas for tool parameters                                                                           | **Dropped.** Hand-written validators in `/Users/russfugal/code/sks/piorx/src/artifacts/schemas.ts` instead.                                                                                                 |
| **Structured outputs** (`output_config.format` / JSON-schema-constrained decoding — see `/Users/russfugal/code/sks/docs/structured-outputs.md`) | **Not used.** Piorx validates artifacts post-hoc via `validateArtifact()`; the API is invoked without `output_config`.                                                                                      |
| **Session-manager read** (`ctx.sessionManager.getBranch()`) to harvest recent user messages                                                     | **Not used.** Piorx reads user text only from the `on('input')` event.                                                                                                                                      |
| **Auto-discovery from `~/.pi/agent/extensions/`**                                                                                               | **Replaced** by the explicit `./bin/piorx` wrapper that always passes `-e extensions/conductor-extension.ts`.                                                                                               |
| **50%-cost-savings framing as the core value prop**                                                                                             | **Dropped** from the project's stated value. Piorx's value is correctness (deterministic evidence, hard boundaries, schema-validated artifacts, recursive intents), not cost.                               |
| **`zod` dependency**                                                                                                                            | **Dropped.**                                                                                                                                                                                                |

What did carry over, at least in spirit: the extension-based integration model, the idea that expansion/synthesis are "slow-cheap" candidates, and the presence of reference copies of the Anthropic batch and structured-outputs guides (now at `/Users/russfugal/code/sks/docs/batch-processing.md` and `/Users/russfugal/code/sks/docs/structured-outputs.md`).

---

## 3. Worth revisiting

### 3.1 Batch API for synthesis (and only synthesis, first)

Piorx's own assessment at `/Users/russfugal/code/sks/piorx/docs/batch-api-assessment.md` already lays out a sensible phased path, but it prescribes building a whole `ModelJobRunner` abstraction plus new `model-batch-job-v1` artifacts up front. For a first cut that would actually prove the value, **go narrower**:

- Wire a real (non-stub) synthesis worker in `/Users/russfugal/code/sks/piorx/src/synthesis/worker.ts` in immediate mode first — this is flagged in the assessment and is the right order.
- Only once synthesis is real, add a batch path _for synthesis only_ via a new `synthesis-dispatch` return variant `{ status: 'queued', batch_job_id }`. Retrieval, evidence, and execution are correctly identified as poor batch candidates and should stay direct.
- Expansion is a weak batch candidate too, despite the assessment listing it. It's one model call per session turn, is latency-sensitive from the user's perspective (they're waiting for the inclusion/review screen), and doesn't benefit much from the 50% discount on a handful of tokens. Defer indefinitely.

The prototype's `client.messages.batches.*` usage at `/Users/russfugal/code/sks/pi/slow-cheap-extensions.ts:150-288` is a fine reference implementation for the provider adapter (step 5 of the assessment) — batch creation, retrieval, result streaming, and `session_shutdown` cancelation are all there and working.

### 3.2 Structured outputs for the synthesis worker

Currently the synthesis worker produces JSON that's then fed through `validateArtifact()`. Any schema violation fails at validation time, after the model has already generated the full response — wasted tokens, wasted latency, and no recovery path short of retry.

Switching to `output_config.format` (see `/Users/russfugal/code/sks/docs/structured-outputs.md`) for `analysis-report-v1` and `change-spec-v1` would:

1. Make "schema violation" impossible at the API boundary.
2. Eliminate the need for retry-on-malformed-JSON logic (which piorx doesn't have yet but would need the moment the real worker ships).
3. Keep the existing `validateArtifact()` path as defense-in-depth.

This would require converting the runtime validators in `/Users/russfugal/code/sks/piorx/src/artifacts/schemas.ts` into JSON Schema form for the two synthesis output types. The shapes are already well-defined; it's a mechanical translation.

This pairs naturally with §3.1 — do structured outputs first (during "real synthesis in immediate mode"), then batching.

### 3.3 Real workers for synthesis and execution

Both are stubs:

- `/Users/russfugal/code/sks/piorx/src/synthesis/worker.ts` — deterministic mock output
- `/Users/russfugal/code/sks/piorx/src/execution/worker.ts` — mock execution report, no real file writes or command execution

Everything around them — dispatch, validation, storage, stage transitions, schema enforcement, constraint checking (`allow_edits`, `run_validation`) — is production-quality and thoroughly tested. The hollow core is the main gap between piorx and something you'd use in anger.

### 3.4 Retrieval — shipped agentic design (AR-P1 … AR-P8, April 2026)

The retrieval redesign laid out in earlier revisions of this spec is **now implemented**. The full plan is in `/Users/russfugal/code/sks/piorx/implementation-agentic-retrieval.md`; the sprint-by-sprint log is in `/Users/russfugal/code/sks/piorx/agentic-retrieval-dev-log.txt`. At a glance:

1. **Stage 1 user-intent file context** — `src/util/intent-files.ts` parses `<file name="...">...</file>` blocks, produces a bounded `restatementContext`, and records the paths as `intent_file_refs` + `tagged_files` on `intent-capture-v1`. `cleaned_user_intent` is the raw intent minus those blocks and is what flows to retrieval/expansion.
2. **Deterministic scout** — `src/retriever/scout.ts` builds curated terms weighted by provenance (focus=4, tag=3, restatement=2, intent=1, stop-word filtered, capped at 24), walks the repo in sorted order, and returns ≤8 selected + ≤4 reserve candidates with per-file roles, `default_evidence_mode` hints, top symbol hints, and AST skeletons. Tagged files get a +50 boost.
3. **Bounded retriever agent** — `src/retriever/agent.ts` runs a ≤3-round loop driven by an injected `AgentModelCallback`. Actions (`read_file`, `search_content`, `search_paths`, `follow_imports`) run through `src/retriever/executor.ts`'s repo-root-sandboxed executors with hard caps on file reads (12), per-read lines (200) and bytes (16 KiB), and total observation budget (256 KiB). `stopReason` values: `agent_stopped`, `round_cap`, `action_cap`, `model_error`, `parse_error` — the last two fall back to a scout-synthesized recommendation.
4. **Structural-only retrieval artifact** — `src/retriever/normalize.ts` strips raw content from worker/agent output and builds `recommended_evidence` from `selected_by_default` symbols and per-file include flags. `src/services/artifact-inspect.ts` still refuses to return raw bodies; `retrieval-index-v1` contains only structural metadata.
5. **Retriever-authored default evidence plan** — `createRecommendedEvidencePlan(index, options?)` in `src/conductor/evidence-plan.ts` copies `recommended_evidence.files` into `selection.files` byte-for-byte (include flags + spans + neighbor_lines), validates every file/symbol reference, excludes reserve-tier files unless explicitly promoted, and is the default path in the Stage 4 extension flow. The old summary+first-two-spans heuristic is gone.
6. **Narrow conductor overrides** — `src/conductor/evidence-overrides.ts` exposes nine deterministic operations over the retriever default (`promote_file`, `demote_file`, `set_file_mode`, `include_symbol`, `exclude_symbol`, `set_neighbor_lines`, three `toggle_*` flags). The extension wires `OVERRIDE_HELP` + a JSON-array prompt into Stage 4 between plan generation and materialization; parse/validation errors leave the retriever default intact. Two load-bearing rules reconciled with the assembler: `promote_file` with `mode='spans'` seeds spans from retrieval metadata (and throws if no seed exists), and `set_file_mode` clears stale spans on `summary`/`summary+ast` and splices the file out on `exclude`. See `docs/specification/03-prompts-and-protocol.md` §10 for full semantics.

### 3.4.1 What this changed in responsibility

- **Retriever** is now the primary arbiter of relevance and default evidence scope.
- **Conductor** is a reviewer / policy layer that inspects and selectively amends recommendations without reading raw repo files (except the Stage 1 intent-file exception).
- **Evidence assembler** stays deterministic: same plan + index + repo state → byte-identical bundle.

### 3.4.2 What remains — from this work's original scope

- **Retriever-agent prompt is still stubbed in end-to-end tests.** `extensions/conductor-extension.ts` wires a real `AgentModelCallback` via `makeRetrieverAgentModel(ctx)`, and the executor/loop are fully covered by `tests/retriever/agent.test.ts` with a queue-backed callback. Live model runs have not been benchmarked against real repos yet; once synthesis becomes real (§3.3), the agent's round budget and action caps are the next knob to validate.
- **Symbol extraction is still regex-based** (`src/retriever/symbol-extractor.ts`). The agentic retrieval path is orthogonal to this; upgrading to tree-sitter or ts-morph remains a high-value improvement because it directly sharpens span selection — see §3.7.

### 3.5 Artifact/schema policy — direct v1 edits are allowed (and happened)

Nothing in piorx has shipped externally yet, so **the v1 specs do not need compatibility-preserving version bumps**. The agentic-retrieval work took advantage of this: `intent-capture-v1`, `retrieval-index-v1`, and the semantics of `evidence-plan-v1` were all edited in place — no `-v2` variants were introduced. The one discriminator field (`artifact_type`) is still `*-v1`, and `validateArtifact()` accepts the richer shape because the shape is the v1 shape now.

Continue this policy: prefer correcting `retrieval-index-v1`, `evidence-plan-v1`, and related helpers in place over inventing premature `-v2` variants until there is a real external consumer to be compatible with.

### 3.6 The `intentExpand()` stub

`/Users/russfugal/code/sks/piorx/src/services/intent-expand.ts` defines a typed service contract that is never called — expansion actually runs via `ExpansionController` + a direct model call in the extension. Either wire the service through for consistency with the other dispatch services, or delete it. Dead typed contracts accumulate confusion.

### 3.7 Retriever sophistication — symbol extraction

The desired architectural end state (deterministic scout, bounded model-driven agent, structural-only artifact, retriever-authored default evidence plan, narrow overrides) is now in place — see §3.4. What remains is the **regex-based symbol extraction** in `/Users/russfugal/code/sks/piorx/src/retriever/symbol-extractor.ts`, which is still the weakest link in span quality.

Upgrading to tree-sitter or ts-morph would directly sharpen:

- per-symbol line range accuracy (regex currently overshoots for class bodies with nested methods);
- the `selected_by_default` signal the retriever agent relies on when deciding whether to mark a symbol for a default span;
- the `default_neighbor_lines` heuristic, which is currently driven by rough line-count math rather than block structure.

This is pure quality uplift — it doesn't change the contracts in §3.4 or the override surface in §3.4.1.

### 3.8 Token-budget heuristic

`estimateTokensFromLines()` in `/Users/russfugal/code/sks/piorx/src/util/budget.ts` uses a crude character-based heuristic. If budget estimation starts driving real trimming decisions (rather than just preview UX), swap in the actual tokenizer (`@anthropic-ai/tokenizer` or equivalent). Not urgent — the current heuristic is good enough for the "never silently prune" semantics because it errs toward over-estimating.

### 3.9 Documentation hygiene on the prototype side

The six duplicative markdowns still at `/Users/russfugal/code/sks/pi/` (`README_EXTENSION.md`, `EXTENSION_README.md`, `EXTENSION_SUMMARY.md`, `QUICK_START.md`, `IMPLEMENTATION_SUMMARY.md`, `CHECKLIST.md`) describe the superseded prototype and reference a stale path (`/Users/russfugal/repo/pi/`). They're harmless but misleading. Candidate for consolidation into a single `/Users/russfugal/code/sks/pi/README.md` that points at piorx as the current implementation, or outright deletion now that this spec captures the prototype's contribution.

---

## 4. One-paragraph summary

Pi-orchestra (`/Users/russfugal/code/sks/piorx/`) is a full reimplementation, not a refinement, of the batch-processing prototype at `/Users/russfugal/code/sks/pi/slow-cheap-extensions.ts`. The prototype's single feature — `@anthropic-ai/sdk` batch API integration with four slash commands and three LLM tools — was dropped entirely; what replaced it is a six-stage conductor workflow with typed artifacts, deterministic evidence assembly, hard conductor/retriever/assembler boundaries, immutable artifacts with lineage, and 498 passing tests. The agentic-retrieval redesign (AR-P1 … AR-P8, April 2026) has now landed: Stage 1 reads `<file>` blocks embedded in the initial intent via a bounded helper and persists them as `intent_file_refs` + `cleaned_user_intent`; retrieval is a deterministic scout (curated terms weighted by provenance, ≤8 selected + ≤4 reserve) followed by a bounded model-driven agent (≤3 rounds, ≤4 actions/round, ≤12 file reads, 256 KiB observation budget, repo-root-sandboxed executors, five enumerated `stopReason` values with scout-synthesized fallback); `retrieval-index-v1` stays structural-only but now carries `strategy_summary`, `scout_terms`, per-file `selection_tier` / `default_evidence_mode`, per-symbol `selected_by_default` / `default_neighbor_lines`, and a full retriever-authored `recommended_evidence` block that `createRecommendedEvidencePlan` copies directly into `evidence-plan-v1`; and the conductor may patch that default through a narrow, deterministic `applyEvidenceOverrides` API (nine validated ops) whose semantics are reconciled with the assembler — `promote_file mode='spans'` seeds spans from retrieval metadata or throws, and `set_file_mode` clears stale spans on `summary`/`summary+ast` and splices files out on `exclude`. v1 specs were edited in place rather than versioned forward. The biggest remaining product gaps are still the stubbed synthesis and execution workers (§3.3) and regex-based symbol extraction (§3.7); the retrieval and evidence-planning pipeline they sit on top of is no longer a known weak spot.
