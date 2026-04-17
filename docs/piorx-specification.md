# pi-orchestra Implementation Specification

A retrospective spec bridging the prototype at `/Users/russfugal/code/sks/pi/` (single-file "Slow & Cheap" extension, early April 2026) and the superseding implementation at `/Users/russfugal/code/sks/piorx/` (pi-orchestra, mid-April 2026).

This document is not the original architectural spec — those live at `/Users/russfugal/code/sks/piorx/docs/specification/00-overview.md` through `03-prompts-and-protocol.md`. This is an as-built description, a delta log against the prototype, and an opinionated list of what's worth revisiting.

---

## 1. What piorx actually implements

### 1.1 Entry points and packaging

- **`/Users/russfugal/code/sks/piorx/package.json`** — package `pi-orchestra` v0.1.0, `type: module`, exposes one bin: `piorx → ./bin/piorx`. Scripts: `test` (bun test), `typecheck` (tsc --noEmit), `lint` (biome), `check`, `format`, `install:pi`, `doctor`, `smoke`. Runtime devDeps only (`@types/bun`, `biome`, `prettier`, `typescript`) — no `@anthropic-ai/sdk`, `@sinclair/typebox`, or `zod` at the project level. The SDK bridge is provided by the globally-installed `@mariozechner/pi-coding-agent` host.
- **`/Users/russfugal/code/sks/piorx/bin/piorx`** — bash wrapper that resolves the repo-local extension and invokes `pi -e extensions/conductor-extension.ts "$@"`. Requires `pi` on PATH (installed via `scripts/install-pi.sh` → `bun add -g @mariozechner/pi-coding-agent`).
- **`/Users/russfugal/code/sks/piorx/extensions/conductor-extension.ts`** — the single extension entrypoint (~1,037 lines). Bootstraps config, artifact store, and stage machine on `session_start`; intercepts user text on `input` from idle stage; drives the entire 6-stage pipeline.

### 1.2 The 6-stage conductor workflow + recursive restart

Fully implemented end-to-end in `conductor-extension.ts` with per-stage controllers in `src/conductor/`:

| Stage                   | Controller                               | Service dispatch                                     | Worker                                 | Output artifact                              |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| 1. Intent restatement   | `src/conductor/stage-1.ts`               | —                                                    | direct model call (`restateWithModel`) | `intent-capture-v1`, `intent-restatement-v1` |
| 2. Expansion (optional) | `src/conductor/expansion.ts`             | `src/services/intent-expand.ts` (stub contract only) | direct model call (`expandWithModel`)  | `expansion-input-v1`, `intent-spec-v1`       |
| 3. Retrieval            | `src/conductor/retrieval.ts` (gate only) | `src/services/retrieval-dispatch.ts`                 | `src/retriever/worker.ts`              | `retrieval-index-v1`                         |
| 4. Evidence             | `src/conductor/evidence-plan.ts`         | `src/services/evidence-assembler.ts`                 | — (deterministic)                      | `evidence-plan-v1`, `evidence-bundle-v1`     |
| 5. Synthesis            | `src/conductor/synthesis.ts`             | `src/services/synthesis-dispatch.ts`                 | `src/synthesis/worker.ts` (stub)       | `analysis-report-v1` or `change-spec-v1`     |
| 6. Execution            | —                                        | `src/services/execution-dispatch.ts`                 | `src/execution/worker.ts` (stub)       | `execution-report-v1`                        |
| Recursive               | `src/conductor/recursive-intent.ts`      | `src/services/artifact-promote.ts`                   | —                                      | `recursive-intent-v1`                        |

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

### 1.4 Hard architectural boundaries (enforced in code and tests)

- **Conductor opacity.** No file-reading tools imported into `/Users/russfugal/code/sks/piorx/src/conductor/**`. File I/O lives only in the retriever worker, the evidence assembler, and the execution worker.
- **Planned exception: user-supplied intent files.** The next revision should allow the conductor to read files explicitly included in the initial user intent _before restatement only_ (e.g. pi CLI `@file` expansions rendered as `<file name="...">...</file>` blocks). This is a narrow exception for user-provided context, not a general repo-reading capability.
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

376 passing tests across 20 files under `/Users/russfugal/code/sks/piorx/tests/`: `artifacts/` (47), `assembler/` (104), `conductor/` (45), `execution/` (31), `interaction/` (68), `retriever/` (51), `synthesis/` (34), plus fixtures. `tsc --noEmit` is clean. CI is wired at `/Users/russfugal/code/sks/piorx/.github/workflows/ci.yml`.

### 1.8 Planning artifacts at the repo root

- **`/Users/russfugal/code/sks/piorx/HANDOFF_PROMPT.md`** — initial instruction to the implementer; points at `docs/specification/` and asks for a phased plan.
- **`/Users/russfugal/code/sks/piorx/implementation-phase-1.md`** — the phased plan itself; 6 phases, per-phase scope/files/interfaces/tests/exit criteria; explicitly defers batch queuing.
- **`/Users/russfugal/code/sks/piorx/implementation-tasks.json`** — 27 tasks (P1-T1 … P6-T5), all marked complete.
- **`/Users/russfugal/code/sks/piorx/dev-log.txt`** — chronological session log.
- **`/Users/russfugal/code/sks/piorx/docs/completion_summary.md`** — phase-by-phase summary of what shipped.
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

### 3.4 Retrieval roadmap — bounded, agentic, and still conductor-safe

The biggest architectural refinement now worth making is to **move relevance and default evidence-scoping decisions into the retriever**, while keeping the conductor structurally blind to raw repository content.

The intended design is:

1. **Initial user-intent file context for Stage 1.** If the user includes files directly in the initial intent (for example via pi CLI `@file` expansion into `<file name="...">...</file>` blocks), the conductor may read and use those files _before_ restatement. Those paths should also become `tagged_files` on `intent-capture-v1`. This is the only planned conductor-side file-reading exception.
2. **Deterministic scout pass.** The retriever should first run a narrow, code-executed heuristic pass that crafts curated search terms from the approved intent / retrieval focus / tagged files, scores candidate files and symbols, and returns only the highest-signal candidates.
3. **Bounded retrieval agent.** A model-driven retriever agent should then be given the scout results plus the approved intent and should be allowed to read repository files directly. The scout does not replace file reading; it narrows the search space for that file-reading agent.
4. **Structural-only retrieval artifact.** Even though the retriever agent reads raw files, the stored `retrieval-index-v1` should remain conductor-safe and structural only — no raw source payloads.
5. **Retriever-authored default evidence scope.** The retrieval artifact should stop being merely "interesting files" and instead become a recommended default evidence package: which files deserve summary-only treatment, which symbols deserve spans, which files warrant whole-file inclusion, and why.
6. **Conductor override, not conductor ownership.** The conductor should usually trust the retriever's recommendations and materialize them directly, but it should have a narrow API for edge-case adjustments (e.g. include a just-below-threshold file, widen neighbor lines, add a symbol span, or force whole-file inclusion in rare cases).

This is a meaningful shift in responsibility:

- **Retriever** becomes the primary arbiter of relevance and default evidence scope.
- **Conductor** becomes a reviewer / policy layer that can inspect and selectively amend recommendations without reading raw repo files.
- **Evidence assembler** remains deterministic and authoritative for turning a plan into raw evidence.

Concretely, this implies the current naive patterns should be replaced:

- **No more bag-of-words retrieval.** Splitting the intent into arbitrary words and searching them independently is the wrong behavior. The scout should craft intelligent, intent-shaped search terms and path hints instead.
- **No more conductor-guessed evidence defaults.** The current pattern of including summary context for every retrieved file and taking the first couple of symbols per file should be replaced by a helper that builds the default `evidence-plan-v1` from retriever recommendations.

A sensible implementation order is:

1. Stage 1 user-intent file reading before restatement.
2. Deterministic scout-pass refactor.
3. Bounded model-driven retrieval loop with direct file reading inside the retriever boundary.
4. Default evidence-plan generation from retrieval recommendations.
5. Conductor-side plan override API.

### 3.5 Artifact/schema policy — direct v1 edits are allowed

Nothing in piorx has shipped externally yet, so **the v1 specs do not need compatibility-preserving version bumps**. If the retriever and evidence-plan contracts need to change to support the roadmap above, update the existing v1 artifact definitions and validators directly.

In other words: prefer correcting `retrieval-index-v1`, `evidence-plan-v1`, and related helpers in place over inventing premature `-v2` variants.

### 3.6 The `intentExpand()` stub

`/Users/russfugal/code/sks/piorx/src/services/intent-expand.ts` defines a typed service contract that is never called — expansion actually runs via `ExpansionController` + a direct model call in the extension. Either wire the service through for consistency with the other dispatch services, or delete it. Dead typed contracts accumulate confusion.

### 3.7 Retriever sophistication

The regex-based symbol extraction is still an obvious limitation, but it is no longer the only retrieval issue. The more pressing gap is that retrieval is currently a single-pass heuristic scorer rather than a bounded file-reading agent with a scout phase and explicit default evidence recommendations.

The desired end state is:

- deterministic scout for candidate narrowing
- model-guided file reading inside the retriever boundary
- strong per-file and per-symbol rationale
- a retrieval artifact the conductor can trust as the default evidence recommendation
- a narrow override path for conductor edge cases

Once that architecture exists, upgrading symbol extraction to tree-sitter or ts-morph remains a high-value improvement because it directly sharpens span selection and evidence quality.

### 3.8 Token-budget heuristic

`estimateTokensFromLines()` in `/Users/russfugal/code/sks/piorx/src/util/budget.ts` uses a crude character-based heuristic. If budget estimation starts driving real trimming decisions (rather than just preview UX), swap in the actual tokenizer (`@anthropic-ai/tokenizer` or equivalent). Not urgent — the current heuristic is good enough for the "never silently prune" semantics because it errs toward over-estimating.

### 3.9 Documentation hygiene on the prototype side

The six duplicative markdowns still at `/Users/russfugal/code/sks/pi/` (`README_EXTENSION.md`, `EXTENSION_README.md`, `EXTENSION_SUMMARY.md`, `QUICK_START.md`, `IMPLEMENTATION_SUMMARY.md`, `CHECKLIST.md`) describe the superseded prototype and reference a stale path (`/Users/russfugal/repo/pi/`). They're harmless but misleading. Candidate for consolidation into a single `/Users/russfugal/code/sks/pi/README.md` that points at piorx as the current implementation, or outright deletion now that this spec captures the prototype's contribution.

---

## 4. One-paragraph summary

Pi-orchestra (`/Users/russfugal/code/sks/piorx/`) is a full reimplementation, not a refinement, of the batch-processing prototype at `/Users/russfugal/code/sks/pi/slow-cheap-extensions.ts`. The prototype's single feature — `@anthropic-ai/sdk` batch API integration with four slash commands and three LLM tools — was dropped entirely; what replaced it is a six-stage conductor workflow with typed artifacts, deterministic evidence assembly, hard conductor/retriever/assembler boundaries, immutable artifacts with lineage, and 376 passing tests. The revised roadmap is now clear: let the conductor read only user-supplied files embedded in the initial intent before restatement; refactor retrieval into a deterministic scout plus a bounded, model-driven file-reading retriever agent; keep the stored retrieval artifact structural-only; and make that artifact the retriever-authored default evidence recommendation that the conductor can usually trust, while still allowing narrow override hooks for edge cases. Because nothing has shipped yet, these contract changes should be made directly to the existing v1 specs rather than versioned forward prematurely. The biggest remaining product gaps are still the stubbed synthesis and execution workers, but retrieval and evidence planning are now also slated for a substantial redesign in favor of a more agentic, better-scoped pipeline.
