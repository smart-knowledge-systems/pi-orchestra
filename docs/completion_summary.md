# pi-orchestra — Implementation Completion Summary

This document summarizes the initial implementation pass that built pi-orchestra's deterministic runtime, conductor workflow, and worker boundaries from the specification in `docs/specification/` and the phased plan in `implementation-phase-1.md`.

All 27 planned tasks across Phases 1–6 are complete. **376 tests pass, 0 failures, typecheck clean.**

## Phase 1 — scaffolding, artifacts, runtime skeleton

- **P1-T1** `src/artifacts/types.ts`, `src/artifacts/index.ts` — discriminated union over all 11 v1 artifact types with `artifact_type` discriminant and `ArtifactOfType<T>` helper.
- **P1-T2** `src/artifacts/schemas.ts` — runtime validators for every artifact type; 24 schema tests with 11 spec-derived fixtures under `tests/fixtures/sample-artifacts/`.
- **P1-T3** `src/artifacts/ids.ts`, `src/runtime/config.ts`, `src/runtime/paths.ts` — deterministic ID generation and per-type directory mapping under `.pi/artifacts/`.
- **P1-T4** `src/artifacts/store.ts` — `ArtifactStore` with `put`/`get`/`exists`/`listByType`, write-side validation, read-side type enforcement.
- **P1-T5** `src/runtime/session-state.ts` — immutable `SessionState` with stage, artifact pointers, lineage history, and disk persistence.
- **P1-T6** `src/conductor/stage-machine.ts`, `src/conductor/prompts.ts` — stage machine with transition enforcement; centralized prompt constants. No raw repo-read capability in conductor code.
- **P1-T7** `extensions/conductor-extension.ts` — extension boot initializes config, store, and stage machine without exposing `read`/`bash`/`find`/`grep`/`ls`/`edit`/`write` tools to the conductor.
- **P1-T8** `src/services/{intent-expand,retrieval-dispatch,evidence-assembler,synthesis-dispatch,execution-dispatch,artifact-promote}.ts` — typed service contracts (later filled in by phase-specific tasks).
- **P1-T9** `package.json` test script plus `.github/workflows/ci.yml` test job.

## Phase 2 — Stage 1 restatement loop and expansion plumbing

- **P2-T1** `src/conductor/stage-1.ts` — `Stage1Controller` with verbatim capture, canonical restatement message shape, approval loop with turn tracking, expansion yes/no offer, finalize, and retrieval gate. 23 protocol tests.
- **P2-T2** `src/conductor/expansion.ts`, `src/util/project-docs.ts` — `ExpansionController` implementing tagged-file auto-inclusion, project-doc discovery (README/AGENTS/CLAUDE), inclusion question flow, `expansion-input-v1` persistence, and approve/revise/reject review. 21 protocol tests.

## Phase 3 — retrieval dispatch and retrieval artifact handling

- **P3-T1** `src/retriever/worker.ts`, `src/retriever/normalize.ts`, `src/services/retrieval-dispatch.ts` — worker boundary with file discovery, regex-based symbol extraction, and lightweight AST skeletons; normalization into `retrieval-index-v1` with absolute paths, 1-indexed lines, and stripped raw content.
- **P3-T2** `src/retriever/prompt.ts` — retriever system prompt constant and `assembleRetrieverPrompt()` wired into dispatch. 13 prompt tests.
- **P3-T3** `src/retriever/symbol-extractor.ts` — function/class/interface/type/const extraction plus `generateAstSkeleton()`. Absolute-path enforcement. 15 extractor tests.
- **P3-T4** `src/services/artifact-inspect.ts`, `src/conductor/retrieval.ts` — text-safe `artifact_inspect` API that refuses bundle payloads; `canStartRetrieval()` gate wired into the stage machine. 12 tests.

## Phase 4 — evidence planning and deterministic assembler

- **P4-T2** `src/util/spans.ts` — pure span utilities: `resolveSymbolToSpan`, `expandNeighborLines` (clamped), `mergeOverlappingSpans` (deterministic), `batchResolveSpans`. 25 tests.
- **P4-T3** `src/util/budget.ts` + preview mode in `src/services/evidence-assembler.ts` — line/token estimation, structured over-budget reporting (never silent pruning), deterministic preview integration. 28 tests.
- **P4-T4** `src/conductor/evidence-plan.ts` — `createEvidencePlan()` produces `evidence-plan-v1` embedding the retrieval index reference with byte-equal integrity, per-file inclusion controls, cross-file/gap/followup selections, and assembly options. `verifyEmbeddedIndex()` helper. 15 tests.
- **P4-T5** `src/services/evidence-assembler.ts` materialize mode — loads plan and authoritative retrieval index, verifies reference match, builds `intent_context`/`structural_context`/`raw_evidence`/`assembly_notes`, resolves spans with neighbor expansion and dedupe, refuses unknown IDs, produces byte-identical bundles for identical inputs. 14 tests.
- **P4-T6** `tests/assembler/determinism.test.ts` + `tests/assembler/boundaries.test.ts` — 22 additional tests covering byte-identical determinism across runs, budget over-budget surfaces, neighbor math, adjacency/overlap/separation, dedupe on/off, cross-file isolation, no widening, unknown-ID exceptions, file-not-found errors.

## Phase 5 — synthesis dispatch

- **P5-T2** `src/synthesis/prompt.ts` — `assembleSynthesisPrompt()` renders bundle sections in a fixed deterministic order with task-type-specific output directives and no external file references. 16 tests.
- **P5-T3** `src/synthesis/worker.ts`, `src/services/synthesis-dispatch.ts` — worker produces `analysis-report-v1` or `change-spec-v1`; `validateWorkerOutput()` enforces type match and schema validation before persistence, throwing `SynthesisValidationError` with structured errors. 18 tests.
- **P5-T4** `src/conductor/synthesis.ts` — heuristic `selectTaskType()` (explanation → analysis-report, execution handoff → change-spec), plus user-facing renderers that never leak raw evidence or internal target fields. 38 tests.

## Phase 6 — execution dispatch and recursive restart

- **P6-T2** `src/execution/worker.ts`, `src/services/execution-dispatch.ts` — `enforceConstraints()` blocks unless `allow_edits === true`; `resolveConstraints()` defaults `run_validation` to true; worker produces `execution-report-v1` after the safety check; dispatch returns `blocked` on violation. 22 tests.
- **P6-T3** `tests/execution/report.test.ts` — 9 integration tests from `change-spec-v1` fixture to stored, schema-valid `execution-report-v1` with recorded modified files and validation commands.
- **P6-T4** `src/services/artifact-promote.ts`, `src/conductor/recursive-intent.ts` — promotes `analysis-report-v1` or `change-spec-v1` into `recursive-intent-v1` with lineage pointing at the source artifact id and type; schema-validated before persistence. 12 tests.
- **P6-T5** `src/conductor/recursive-intent.ts` — `promoteAndRestart()` resets the stage machine to idle, preserving lineage across restarts; `getPromotionPrompt()` returns the canonical spec §11 prompt shape. 12 tests covering Stage-1 restart, pointer clearing, traceable prior IDs, and lineage growth across multiple restarts.

## Architectural invariants preserved by the implementation

- The **conductor** has no raw-file tools. All file-reading happens in the retriever, evidence assembler, or execution worker.
- The **retriever response** is embedded unchanged into `evidence-plan-v1`; `verifyEmbeddedIndex()` enforces byte-equal integrity.
- The **evidence assembler** is deterministic: same plan + retrieval + repo state produces byte-identical bundles, refuses unknown file/symbol IDs, and never widens selection beyond the plan.
- The **stage machine** blocks retrieval until the restatement is approved, and blocks execution until `allow_edits` is explicitly set.
- **Artifacts are immutable**; revisions create new artifacts and record lineage in session state.
- **Recursive restart** always lands back at Stage 1 with the prior artifact chain still traceable.

## Test totals by phase

| Phase | Cumulative passing tests |
| ----- | ------------------------ |
| 1     | 47                       |
| 2     | 91                       |
| 3     | 151                      |
| 4     | 260                      |
| 5     | 294 → 352                |
| 6     | **376**                  |

All 376 tests pass under `bun test`; `tsc --noEmit` is clean.

## Commit timeline

The implementation landed across 46 commits from repo init to Phase 6 completion. Key milestones, oldest first:

### Repo scaffold and conventions

- `41eddea` initialize pi-orchestra repository scaffold
- `dbf35f1` add conductor workflow specification
- `d952870` add piorx wrapper and extension entrypoint
- `51e28dd` add project metadata and contribution guides
- `0623cd3` add setup script and github scaffolding
- `8cbd909` add typecheck, lint, check, and format scripts
- `eeed44e` add tsconfig, biome, and prettier configs
- `fe8b006` allow running quality scripts without prompting
- `ffcd038` ignore .bak files
- `2c1b29f` add bun lockfile
- `5a7e919` add auto-implement script
- `b3c4d3f` add handoff prompt and phase 1 implementation plan
- `8094b0f` add typescript and @types/bun devDependencies

### Phase 1 — scaffolding, artifacts, runtime skeleton

- `f12fecb` apply prettier formatting to docs and extension stub
- `70f75e4` replace mapfile with portable array helper (script fix)
- `2cfb8ce` scaffold v1 artifact types, validators, and id/path helpers (P1-T1..T3)
- `c9164cf` add .claude directory to gitignore
- `a450785` mark Phase 1 tasks as completed
- `862e5f9` add ArtifactStore with validated persistence (P1-T4)
- `e03549f` add SessionState model with disk persistence (P1-T5)
- `1d71c1b` add stage-machine skeleton and prompt constants (P1-T6)
- `74c17e6` mark P1-T4/T5/T6 completed
- `db87fea` add test job and test script (P1-T9)
- `1f31386` initialize runtime on extension boot (P1-T7)
- `fceb9f0` add stub service contracts (P1-T8)

### Phase 2 — Stage 1 restatement loop and expansion plumbing

- `2e52042` implement stage-1 intent capture and restatement (P2-T1)
- `a798ff3` correct array assignment in read_lines_into_array
- `72531fe` implement expansion inclusion protocol (P2-T2)
- `fa2cf2f` mark P2-T1 and P2-T2 as completed

### Phase 3 — retrieval dispatch and artifact handling

- `2d9071c` implement retrieval dispatch with worker, normalization, and artifact inspection (P3-T2/T3/T4)
- `7f56e7c` wire retrieval-dispatch to orchestrate retriever and normalize pipeline
- `f067ae4` decompose phases 3-6 into granular tasks and log phase-3 completion
- `afd5ba8` improve array handling robustness in auto-implement loop

### Phase 4 — evidence planning and deterministic assembler

- `55fee0a` implement span and budget utilities with evidence preview (P4-T2, P4-T3)
- `75fa24f` mark P3-T2, P4-T2, P4-T3 as completed
- `923cc5e` implement evidence plan authoring helpers (P4-T4)
- `ee1a181` implement deterministic materialize mode (P4-T5)
- `e0d42eb` add determinism and boundary test suite (P4-T6)
- `918b21d` mark P4-T4, P4-T5, P4-T6 as completed

### Phase 5 — synthesis dispatch

- `0711447` add prompt assembly and worker modules (P5-T2, P5-T3)
- `952f61b` implement synthesis dispatch service
- `2e3f82f` mark P5-T2 and P5-T3 as completed
- `8683b19` implement task-type selection and rendering (P5-T4)

### Phase 6 — execution dispatch and recursive restart

- `9bfa9de` implement execution worker with safety constraints (P6-T2, P6-T3)
- `4b6b2f3` mark P5-T4, P6-T2, P6-T3 as completed
- `72d3bd3` implement artifact promotion and recursive intent handling (P6-T4, P6-T5)
- `3282db9` mark P6-T4 and P6-T5 as completed

Notable pattern: feature commits are interleaved with small `docs(plan)` commits recording task-status transitions in `implementation-tasks.json`, and two `fix(scripts)` commits tightened the auto-implement loop driving this pass.
