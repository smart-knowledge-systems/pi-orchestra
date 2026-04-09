# pi-orchestra implementation plan

This document is the phased master implementation plan for building the conductor workflow described in `docs/specification/*`.

It is organized so another agent can begin Phase 1 immediately.

---

## 1. Planning assumptions and hard boundaries

These are non-negotiable constraints carried directly from the specification and should be enforced in architecture, prompts, and tests.

### 1.1 Conductor boundary

- The conductor is agentic.
- The conductor may read only text-safe artifacts such as:
  - summaries
  - AST skeletons
  - symbol summaries
  - relevance notes
  - gaps
  - followup suggestions
- The conductor may **not** read raw repository source.
- The conductor must **not** receive `read`, `bash`, `find`, `grep`, `ls`, `edit`, or `write` tools.
- The conductor must pass the full retriever response unchanged to the evidence assembler path.

### 1.2 Evidence assembler boundary

- The evidence assembler is deterministic and non-agentic.
- It may resolve only what the conductor explicitly requested.
- It must support per-file inclusion controls for:
  - AST skeleton
  - retriever summary
  - resolved spans
  - whole file
- It may merge overlaps only when the plan says to do so.
- It must not choose new files, add judgment, or silently widen scope.

### 1.3 Intent expansion boundary

- Expansion happens only after restatement approval.
- All user-tagged files must be included in expansion input.
- If there are no tagged files and `README.md`, `AGENTS.md`, or `CLAUDE.md` exist, the user must be asked whether to include any/all before expansion.
- Expansion output must be reviewable and user-approved before retrieval.

### 1.4 Recursive restart boundary

- A synthesis output may become a new user intent.
- If promoted, the system restarts at Stage 1, not retrieval.

---

## 2. Proposed implementation tracks

Work should proceed across five coordinated tracks.

### Track A: Extension / interaction layer

Owns:

- Stage 1 restatement loop
- user approval flows
- expansion review flow
- retrieval/evidence/synthesis/execution dispatch UX
- session state pointers to artifact IDs

### Track B: Artifact store / deterministic runtime

Owns:

- artifact schemas and validation
- artifact IDs and persistence
- on-disk storage
- lightweight session rehydration helpers
- evidence assembler service

### Track C: Retriever pipeline

Owns:

- retriever dispatch API
- retriever worker prompt/config
- retrieval artifact normalization
- symbol/span metadata extraction

### Track D: Synthesis / execution pipeline

Owns:

- synthesis dispatch API
- prompt assembly from evidence bundle sections
- execution dispatch API
- recursive intent promotion helpers

### Track E: Validation / fixtures / protocol tests

Owns:

- schema tests
- deterministic assembler tests
- interaction protocol tests
- end-to-end happy path fixtures

---

## 3. Suggested file/module layout

This layout keeps the extension thin and pushes deterministic behavior into normal TypeScript modules.

```text
extensions/
  conductor-extension.ts

src/
  artifacts/
    ids.ts
    schemas.ts
    types.ts
    store.ts
    index.ts
  runtime/
    config.ts
    paths.ts
    session-state.ts
  conductor/
    prompts.ts
    stage-machine.ts
    stage-1.ts
    expansion.ts
    retrieval.ts
    evidence-plan.ts
    synthesis.ts
    execution.ts
    recursive-intent.ts
  services/
    intent-expand.ts
    retrieval-dispatch.ts
    evidence-assembler.ts
    synthesis-dispatch.ts
    execution-dispatch.ts
    artifact-promote.ts
  retriever/
    prompt.ts
    worker.ts
    normalize.ts
    symbol-extractor.ts
  synthesis/
    prompt.ts
    worker.ts
  execution/
    worker.ts
  util/
    json.ts
    fs.ts
    budget.ts
    spans.ts
    project-docs.ts

tests/
  fixtures/
  artifacts/
  assembler/
  interaction/
  e2e/
```

If pi-specific extension APIs require a different layout, keep the same separation of concerns even if filenames move.

---

## 4. Phase overview

- **Phase 1:** repository scaffolding, artifact store, deterministic runtime skeleton, conductor shell
- **Phase 2:** Stage 1 restatement/approval loop and Stage 2 expansion plumbing
- **Phase 3:** retrieval dispatch, retriever worker, `retrieval-index-v1` handling
- **Phase 4:** evidence planning and deterministic evidence assembler
- **Phase 5:** synthesis dispatch and synthesis artifact production
- **Phase 6:** execution dispatch and recursive restart flow

Each phase below includes objective, scope, likely files, interfaces, tests, exit criteria, and deferred items.

---

# Phase 1 — scaffolding, artifacts, runtime skeleton

## Objective

Create the deterministic foundation the rest of the system will rely on:

- artifact types and validation
- artifact persistence
- session state pointers
- extension bootstrapping hooks
- a minimal conductor state machine shell

This phase should not try to implement full retrieval or synthesis behavior yet.

## Scope

### In scope

- Define all artifact TypeScript types for the v1 schemas in `01-artifacts-and-schemas.md`
- Add schema validation for stored artifacts
- Implement on-disk artifact store
- Implement artifact ID generation helpers
- Implement runtime path/config helpers
- Implement lightweight session state model
- Replace the no-op extension with a minimal conductor skeleton that can initialize state and expose placeholder commands/workflows
- Add tests for store and schema round-trips

### Out of scope

- Real model calls
- Real retrieval
- Real evidence resolution
- Real synthesis
- Repo editing execution

## Likely files/modules to create or modify

### Create

- `src/artifacts/types.ts`
- `src/artifacts/schemas.ts`
- `src/artifacts/ids.ts`
- `src/artifacts/store.ts`
- `src/artifacts/index.ts`
- `src/runtime/paths.ts`
- `src/runtime/config.ts`
- `src/runtime/session-state.ts`
- `src/conductor/stage-machine.ts`
- `src/conductor/prompts.ts`
- `tests/artifacts/store.test.ts`
- `tests/artifacts/schemas.test.ts`
- `tests/fixtures/sample-artifacts/*.json`

### Modify

- `extensions/conductor-extension.ts`
- `package.json`
- optionally `.github/workflows/ci.yml` if test commands are added

## Interfaces / artifacts involved

Implement and validate these artifact types now, even if some are only stub-produced later:

- `intent-capture-v1`
- `intent-restatement-v1`
- `expansion-input-v1`
- `intent-spec-v1`
- `retrieval-index-v1`
- `evidence-plan-v1`
- `evidence-bundle-v1`
- `analysis-report-v1`
- `change-spec-v1`
- `execution-report-v1`
- `recursive-intent-v1`

Also define:

- `ArtifactEnvelope` or discriminated union
- `ArtifactStore` API
- `SessionState` with current stage + relevant artifact IDs

## Implementation notes

- Store artifacts under repo-local `.pi/artifacts/` as suggested in the spec.
- Suggested directories:
  - `.pi/artifacts/intents/`
  - `.pi/artifacts/retrieval/`
  - `.pi/artifacts/evidence-plans/`
  - `.pi/artifacts/evidence-bundles/`
  - `.pi/artifacts/synthesis/`
  - `.pi/artifacts/execution/`
- Persist session state separately, e.g. `.pi/session-state.json`.
- Artifact store should support:
  - `put(artifact)`
  - `get(id)`
  - `getTyped(id, artifact_type)`
  - `listByType(type)`
  - `exists(id)`
- ID generation should be deterministic in shape, not necessarily content, e.g. `intent_<timestamp-or-counter>`.
- Keep conductor code unable to access raw file APIs by design; the extension layer should call service functions, not expose repo tools to conductor logic.

## Stubs to build now

- Stub service interfaces returning `not_implemented` or fixture-backed responses:
  - `intent_expand`
  - `retrieval_dispatch`
  - `evidence_prepare`
  - `synthesis_dispatch`
  - `execution_dispatch`
  - `artifact_promote_to_intent`
- Minimal extension boot flow that can load store/session state and register placeholders.

## Test strategy

- Unit tests for every schema validator using valid and invalid fixtures
- Store tests for write/read/list behavior
- Session state tests for rehydration and restart safety
- Snapshot tests for artifact serialization shape

## Exit criteria

- All artifact schemas exist in code and validate against sample fixtures
- Artifact store persists and reloads artifacts under `.pi/artifacts/`
- Session state can be initialized and reloaded
- Extension entrypoint is no longer a no-op; it boots the runtime skeleton safely
- Stubbed service interfaces exist with typed input/output contracts

## Deferred items

- Actual Stage 1 user interaction
- Expansion worker logic
- Retriever worker
- Evidence assembly implementation
- Synthesis and execution workers

---

# Phase 2 — Stage 1 restatement loop and expansion plumbing

## Objective

Implement the strict pre-retrieval approval flow:

1. capture verbatim user intent
2. produce simple restatement
3. get approval/correction
4. ask expansion yes/no
5. if expansion chosen, handle project-doc inclusion protocol
6. create expansion artifacts and review loop

## Scope

### In scope

- `intent-capture-v1` creation from user input
- tagged-file extraction from user input format used by pi
- conductor restatement prompt and Stage 1 response shape
- approval-turn loop tracking
- expansion choice handling
- project-doc discovery (`README.md`, `AGENTS.md`, `CLAUDE.md`)
- expansion-input creation
- expansion worker stub or minimal implementation
- expansion review protocol producing approved `intent-spec-v1`

### Out of scope

- Real retrieval beyond maybe a fixture hook
- Evidence planning
- Synthesis
- Execution

## Likely files/modules to create or modify

### Create

- `src/conductor/stage-1.ts`
- `src/conductor/expansion.ts`
- `src/services/intent-expand.ts`
- `src/util/project-docs.ts`
- `tests/interaction/stage-1.test.ts`
- `tests/interaction/expansion-protocol.test.ts`

### Modify

- `src/conductor/prompts.ts`
- `src/conductor/stage-machine.ts`
- `extensions/conductor-extension.ts`

## Interfaces / artifacts involved

Primary artifacts:

- `intent-capture-v1`
- `intent-restatement-v1`
- `expansion-input-v1`
- `intent-spec-v1`

Primary APIs:

- `intent_expand(input) -> { intent_spec_id, status }`
- project-doc inclusion prompt helper

## Implementation notes

- The restatement must remain simple and must not be an expansion.
- Preserve corrected user text verbatim in a new or updated `intent-capture-v1` lineage decision; choose one approach and document it.
- Recommended decision: keep original `intent-capture-v1` immutable and create a fresh one when the user materially rewrites the intent, linking via session state history.
- If tagged files exist, include them automatically in `expansion-input-v1`.
- If tagged files do not exist and project docs exist, require the exact inclusion question flow before expansion.
- Expansion review must produce one of: approve / revise / reject.
- For `revise`, decide whether edits patch the existing expansion input or create a new one; recommended approach is create a new `expansion-input-v1` and retain lineage via IDs in session state metadata.

## What should be stubbed first vs fully implemented

### Stub first

- actual slow-cheap model call for expansion
- use a deterministic local template/fixture expander first

### Fully implement now

- approval protocol
- project-doc discovery and inclusion rules
- artifact creation and persistence
- expansion review loop UX

## Test strategy

- Protocol tests asserting the exact Stage 1 conductor message shape from the spec
- Tests that tagged files are always included in `expansion-input-v1`
- Tests that project-doc prompt appears only when no tagged files exist and docs exist
- Tests for approve / revise / reject state transitions
- Tests that retrieval cannot start before approved restatement and, if used, approved intent spec

## Exit criteria

- A user can complete Stage 1 end-to-end in the extension
- Expansion is optionally available and reviewable
- Artifacts are persisted for each turn
- All specified inclusion rules are enforced by code and tests

## Deferred items

- Real retrieval implementation
- Rich expansion model quality work
- Human-friendly rendering polish beyond required protocol

---

# Phase 3 — retrieval dispatch and retrieval artifact handling

## Objective

Implement the retrieval stage as a separate worker/service that can inspect the repository, produce structural summaries, and persist a valid `retrieval-index-v1` artifact without exposing raw code to the conductor.

## Scope

### In scope

- retriever service contract
- retriever worker prompt/config
- repository search/read integration inside retriever worker
- normalization into `retrieval-index-v1`
- retrieval artifact storage and conductor-safe inspection path
- confidence, gaps, followup queries, symbol metadata

### Out of scope

- raw evidence assembly
- synthesis
- execution

## Likely files/modules to create or modify

### Create

- `src/services/retrieval-dispatch.ts`
- `src/retriever/prompt.ts`
- `src/retriever/worker.ts`
- `src/retriever/normalize.ts`
- `src/retriever/symbol-extractor.ts`
- `tests/retriever/normalize.test.ts`
- `tests/retriever/retrieval-index.test.ts`
- `tests/fixtures/retrieval/sample-retrieval-index.json`

### Modify

- `src/conductor/retrieval.ts`
- `src/conductor/stage-machine.ts`

## Interfaces / artifacts involved

Primary artifact:

- `retrieval-index-v1`

Primary API:

- `retrieval_dispatch({ intent_capture_id, intent_restatement_id, intent_spec_id? })`

Expected response:

- `{ retrieval_index_id, status }`

## Implementation notes

- Keep retriever as a separate worker boundary from the conductor.
- The retriever may use repo read/search powers; the conductor may not.
- Normalize all file paths to absolute paths in the artifact.
- Use 1-indexed line numbers exactly as required.
- Retrieval output should include:
  - relevant files
  - why relevant
  - file summaries
  - AST skeletons
  - symbols with start/count
  - cross-file findings
  - gaps
  - followup queries
  - recommended expansion judgments
- Initially it is acceptable to build a conservative retriever that focuses on high-signal files rather than perfect coverage.

## What should be stubbed first vs fully implemented

### Stub first

- fancy semantic retrieval
- robust AST parsing for every language

### Fully implement now

- dispatch contract
- retrieval artifact normalization and persistence
- basic lexical + file-read backed summarization pipeline
- conductor-safe artifact inspection view

## Testing / validation strategy

- Schema validation of `retrieval-index-v1`
- Fixture-based tests for symbol/span normalization
- Golden tests that ensure raw file contents are not persisted in retrieval artifact fields meant for the conductor
- Integration test that retrieval dispatch creates a stored artifact and returns its ID

## Exit criteria

- Retrieval can run after approved intent package exists
- A valid `retrieval-index-v1` is stored and inspectable by conductor logic
- Retrieval artifact contains no raw full-file payloads intended for conductor consumption
- Low-confidence and gap paths are represented cleanly

## Deferred items

- semantic ranking improvements
- richer language-aware AST skeleton extraction
- multi-pass retrieval refinement

---

# Phase 4 — evidence planning and deterministic evidence assembler

## Objective

Implement the key architectural boundary of the system:

- conductor creates `evidence-plan-v1` from structural retrieval output
- deterministic assembler resolves exactly the requested evidence into `evidence-bundle-v1`

This is the most important boundary-enforcement phase.

## Scope

### In scope

- evidence-plan authoring helpers for conductor
- preview vs materialize flow
- deterministic span resolution from retrieval metadata
- per-file inclusion controls
- token/line budgeting and deterministic truncation rules
- overlap merging logic when enabled
- bundle stats and deterministic prompt sections

### Out of scope

- sophisticated synthesis quality work
- execution

## Likely files/modules to create or modify

### Create

- `src/conductor/evidence-plan.ts`
- `src/services/evidence-assembler.ts`
- `src/util/spans.ts`
- `src/util/budget.ts`
- `tests/assembler/evidence-plan.test.ts`
- `tests/assembler/evidence-assembler.test.ts`
- `tests/assembler/budget.test.ts`
- `tests/fixtures/evidence/sample-plan.json`
- `tests/fixtures/evidence/sample-bundle.json`

### Modify

- `src/conductor/stage-machine.ts`
- `src/artifacts/schemas.ts`

## Interfaces / artifacts involved

Primary artifacts:

- `evidence-plan-v1`
- `evidence-bundle-v1`

Primary API:

- `evidence_prepare({ mode, retrieval_index_id, plan })`

Modes:

- `preview`
- `materialize`

## Implementation notes

- The conductor should create the plan from retrieval metadata only.
- The assembler should load the full stored `retrieval-index-v1` unchanged and use it as the authoritative mapping for file IDs, symbol IDs, and spans.
- Support canonical per-file controls:
  - `include_ast_skeleton`
  - `include_retriever_summary`
  - `include_entire_file`
  - `spans[]`
- Support direct spans and symbol-based spans.
- Implement deterministic neighbor-line expansion.
- Implement deterministic overlap merge behavior with no heuristic widening.
- Prompt sections in output bundle should be explicit:
  - `intent_context`
  - `structural_context`
  - `raw_evidence`
  - `assembly_notes`
- Do not feed raw bundle contents back into conductor context.

## What should be stubbed first vs fully implemented

### Stub first

- advanced token estimation accuracy
- language-specific code chunk prettification

### Fully implement now

- preview/materialize contract
- span resolution from files on disk
- per-file inclusion controls
- stats and deterministic output sections
- budget enforcement behavior

## Testing / validation strategy

- Unit tests for span merge and neighbor line calculations
- Determinism tests: same plan + same retrieval artifact + same repo state => byte-identical bundle
- Negative tests: assembler refuses unknown file IDs/symbol IDs
- Boundary tests: assembler does not include content not requested by plan
- Preview tests: estimate output without materializing raw evidence

## Exit criteria

- Conductor can create and persist a valid `evidence-plan-v1`
- `evidence_prepare preview` returns stable estimates
- `evidence_prepare materialize` creates a valid `evidence-bundle-v1`
- Raw evidence included in bundle matches plan exactly
- Boundary rules are enforced by tests

## Deferred items

- compression/compaction strategies beyond deterministic basics
- smarter section formatting for model-specific prompts

---

# Phase 5 — synthesis dispatch and synthesis artifact production

## Objective

Use approved intent artifacts plus evidence bundles to generate structured synthesis outputs such as `analysis-report-v1` and `change-spec-v1`.

## Scope

### In scope

- synthesis dispatch service
- synthesis prompt templates
- prompt assembly from bundle sections
- storage of synthesis output artifacts
- task typing for `analysis-report` vs `change-spec`
- user-facing rendering of synthesis results

### Out of scope

- execution of changes
- recursive restart automation beyond offering promotion hook

## Likely files/modules to create or modify

### Create

- `src/services/synthesis-dispatch.ts`
- `src/synthesis/prompt.ts`
- `src/synthesis/worker.ts`
- `tests/synthesis/dispatch.test.ts`
- `tests/synthesis/output-validation.test.ts`

### Modify

- `src/conductor/synthesis.ts`
- `src/conductor/prompts.ts`
- `src/conductor/stage-machine.ts`

## Interfaces / artifacts involved

Input artifacts:

- `intent-capture-v1`
- `intent-restatement-v1`
- optional `intent-spec-v1`
- `evidence-bundle-v1`

Output artifacts:

- `analysis-report-v1`
- `change-spec-v1`

Primary API:

- `synthesis_dispatch({ task_type, intent_capture_id, intent_restatement_id, intent_spec_id?, evidence_bundle_id, instructions })`

## Implementation notes

- Prompt assembly should inject deterministic sections, not free-form mixed context.
- Select output schema based on `task_type`.
- Validate worker output before storing; reject or repair malformed structures.
- The conductor should choose synthesis task type according to spec heuristics:
  - explanation/planning => `analysis-report`
  - execution handoff => `change-spec`
- Ensure synthesis artifacts can be displayed to the user without exposing unrelated raw bundle content.

## What should be stubbed first vs fully implemented

### Stub first

- model selection sophistication
- async queueing / batch execution complexity

### Fully implement now

- dispatch contract
- prompt assembly from bundle sections
- output schema validation and storage
- basic conductor UX for showing results

## Testing / validation strategy

- Tests that prompt assembly includes required sections and only requested sections
- Schema validation tests for analysis and change-spec outputs
- Integration test from evidence bundle to stored synthesis artifact
- Regression tests for malformed model output handling

## Exit criteria

- Synthesis can run on a stored bundle and produce a stored valid artifact
- Both `analysis-report-v1` and `change-spec-v1` paths work
- Conductor can present results and determine possible next actions

## Deferred items

- prompt quality tuning
- multiple synthesis model backends
- advanced retry strategies

---

# Phase 6 — execution dispatch and recursive restart

## Objective

Complete the loop by enabling:

- optional local execution from `change-spec-v1`
- execution reporting
- synthesis output promotion to new intent and restart at Stage 1

## Scope

### In scope

- execution dispatch service
- execution worker prompt/config
- validation command reporting
- `execution-report-v1`
- `artifact_promote_to_intent`
- recursive intent artifact creation
- session reset/restart flow from promoted synthesis output

### Out of scope

- deep sandboxing or remote execution infrastructure
- advanced approval/policy systems beyond basic constraints

## Likely files/modules to create or modify

### Create

- `src/services/execution-dispatch.ts`
- `src/services/artifact-promote.ts`
- `src/execution/worker.ts`
- `src/conductor/execution.ts`
- `src/conductor/recursive-intent.ts`
- `tests/execution/dispatch.test.ts`
- `tests/interaction/recursive-restart.test.ts`

### Modify

- `src/conductor/stage-machine.ts`
- `extensions/conductor-extension.ts`

## Interfaces / artifacts involved

Input artifacts:

- `change-spec-v1`
- `evidence-bundle-v1`

Output artifacts:

- `execution-report-v1`
- `recursive-intent-v1`

Primary APIs:

- `execution_dispatch({ change_spec_id, evidence_bundle_id, execution_constraints })`
- `artifact_promote_to_intent({ source_artifact_type, source_artifact_id, new_user_intent_verbatim })`

## Implementation notes

- Execution worker may inspect/edit repo and run validation commands.
- Keep execution optional and explicit.
- Store modified files and validation results in `execution-report-v1`.
- Promotion should create a `recursive-intent-v1` artifact and reset session stage to Stage 1 with the new verbatim intent.
- Preserve lineage by keeping parent artifact references in session state or auxiliary metadata.

## What should be stubbed first vs fully implemented

### Stub first

- sophisticated sandbox restrictions
- broad command policy engine

### Fully implement now

- dispatch contract
- execution report persistence
- recursive intent creation
- restart behavior to Stage 1

## Testing / validation strategy

- Integration test from `change-spec-v1` to `execution-report-v1`
- Tests that execution is blocked unless constraints allow edits
- Tests that promotion always restarts at Stage 1
- Lineage tests ensuring source synthesis artifact is traceable from recursive intent

## Exit criteria

- A valid `change-spec-v1` can be executed through the execution worker
- `execution-report-v1` is stored with modified files and validation result
- Synthesis artifact promotion creates `recursive-intent-v1`
- Session restarts at Stage 1 with new user intent

## Deferred items

- richer approval checkpoints before execution
- partial execution / dry-run mode enhancements
- multi-agent execution strategies

---

## 5. Cross-phase dependency map

### Hard dependencies

- **Phase 1 -> all later phases**
  - artifact types/store/session state are required everywhere
- **Phase 2 -> Phases 3–6**
  - retrieval cannot run until approved intent package exists
- **Phase 3 -> Phases 4–6**
  - evidence planning depends on `retrieval-index-v1`
- **Phase 4 -> Phases 5–6**
  - synthesis and execution require `evidence-bundle-v1`
- **Phase 5 -> Phase 6**
  - execution requires `change-spec-v1`
  - recursive promotion usually begins from synthesis output

### Soft dependencies

- project-doc discovery can start in Phase 1 if useful
- synthesis prompt assembly can be prototyped during Phase 4 once bundle shape stabilizes
- execution worker shell can be stubbed in Phase 1 without real behavior

---

## 6. What belongs in the pi extension vs deterministic runtime/services

## pi extension responsibilities

These should live in the extension/user-interaction layer:

- intercepting or structuring user interaction
- running the Stage 1 approval loop
- asking expansion inclusion questions
- rendering expanded spec for review
- rendering retrieval/evidence/synthesis summaries for human review
- maintaining current session stage and artifact pointers
- dispatching work to runtime/services

## Deterministic runtime/services responsibilities

These should live outside the conductor model logic:

- artifact persistence and lookup
- schema validation
- project-doc discovery helper
- evidence assembly
- span merging and budgeting
- prompt assembly for synthesis/execution workers
- recursive intent artifact creation
- service dispatch wrappers

## Agentic worker responsibilities

These are model-backed or tool-using workers:

- intent expansion worker
- retriever worker
- synthesizer worker
- execution worker

## Architectural guidance

When in doubt:

- if it reads raw code for selection or assembly, it should be retriever or evidence assembler, not conductor
- if it makes a judgment call, it should be conductor or worker, not deterministic assembler
- if it transforms stored artifacts without judgment, it belongs in deterministic runtime/services

---

## 7. High-risk or ambiguous areas requiring explicit decisions

These should be decided early and documented in code comments or an ADR-style note.

### 7.1 How the extension models the conductor

Question:

- Is the conductor implemented as a custom extension-managed prompt/session workflow, or as a subagent-like model invocation behind extension commands?

Recommendation:

- Start with an extension-managed workflow shell that owns state transitions and calls narrowly scoped service functions. Keep conductor prompt text centralized in `src/conductor/prompts.ts`.

### 7.2 Artifact lineage for revised intents/specs

Question:

- When a user revises a restatement or expansion, do we mutate the same artifact or create a new artifact?

Recommendation:

- Treat artifacts as immutable. Create new artifacts and preserve lineage in session state metadata.

### 7.3 Retriever implementation depth in early versions

Question:

- How much AST/symbol extraction is required before Phase 4?

Recommendation:

- Implement a conservative first pass: file summaries, function/class symbol ranges, and rough AST skeletons. Improve depth later.

### 7.4 Token/line budget policy

Question:

- What happens when requested evidence exceeds budget?

Recommendation:

- In preview mode, surface over-budget estimates. In materialize mode, either fail deterministically with a structured reason or apply only explicitly documented deterministic truncation rules. Do not silently prune.

### 7.5 How raw evidence is stored

Question:

- Should raw evidence be embedded only in bundle JSON or also written as separate text blobs?

Recommendation:

- Start by embedding in bundle JSON for simplicity. If size grows, split large raw sections into companion files while preserving the same artifact API.

### 7.6 Session persistence boundary

Question:

- What goes in pi session entries vs repo-local files?

Recommendation:

- Keep only lightweight stage/artifact IDs in session memory. Keep canonical artifacts on disk under `.pi/artifacts/`.

### 7.7 Execution safety policy

Question:

- How restrictive should execution be at first?

Recommendation:

- Require explicit `allow_edits` and `run_validation` flags; start conservative.

---

## 8. Testing strategy by layer

## Schema and artifact layer

- validate all artifacts against fixtures
- ensure backward-stable serialization shape
- ensure invalid artifacts fail clearly

## Interaction protocol layer

- exact Stage 1 text shape tests
- exact project-doc inclusion question tests
- expansion review state transition tests
- recursive promotion prompt tests

## Retrieval layer

- ensure retrieval artifacts contain structure, not raw source blobs
- ensure paths and line numbers are normalized correctly
- ensure gaps/followups are preserved

## Deterministic assembly layer

- determinism tests
- budget tests
- overlap/neighbor-line tests
- selection boundary tests

## Synthesis/execution layer

- prompt assembly tests
- output schema validation tests
- execution report integrity tests

## End-to-end tests

Add at least two fixture-backed end-to-end paths:

1. explanation path: intent -> restatement -> optional expansion -> retrieval -> evidence -> analysis-report
2. code-change path: intent -> restatement -> retrieval -> evidence -> change-spec -> execution-report -> optional recursive restart

---

## 9. Concrete Phase 1 task list for the next agent

These are the immediate tasks another agent should execute first.

### 9.1 Establish source layout and runtime paths

- Create `src/` tree for artifacts, runtime, conductor, services, util
- Add `.pi/artifacts/` path helpers
- Decide and implement artifact subdirectory mapping by artifact type

### 9.2 Define all artifact TypeScript types

- Encode every v1 artifact as a discriminated union
- Add exported helper types for IDs and typed lookup results

### 9.3 Implement schema validation

- Add runtime validators for every artifact shape
- Include sample fixtures based directly on spec examples

### 9.4 Implement artifact store

- JSON read/write by artifact ID
- type-based listing
- typed retrieval
- atomic-ish writes if practical

### 9.5 Implement session state model

- current stage
- current artifact IDs
- lineage/history list
- restart/reset helpers

### 9.6 Replace no-op extension with bootstrap skeleton

- Initialize runtime/store/session state on startup
- Wire placeholder service registration or command hooks
- Keep conductor file-reading powers absent

### 9.7 Add tests and package scripts

- Add a test runner if not already present
- Add `test` script and basic CI invocation
- Cover schemas, store, and session state first

---

## 10. Suggested initial acceptance milestone

After Phase 1 and before deeper implementation, the repo should be able to demonstrate this minimal scripted flow:

- initialize extension runtime
- capture a mock intent into `intent-capture-v1`
- create a placeholder `intent-restatement-v1`
- persist artifacts to `.pi/artifacts/`
- reload session state and locate the current artifact chain

That milestone proves the project has a real implementation spine and is ready for Phase 2.

---

## 11. Deferred backlog after Phase 6

Not required for the first complete version, but good follow-on work:

- richer semantic retrieval and ranking
- advanced AST extraction per language
- async job queueing for slow stages
- UI polish in pi for artifact browsing
- dry-run execution and patch preview
- artifact diffing/version views
- prompt tuning and model routing
- ADR documentation for architecture decisions

---

## 12. Final recommendation

Build this system with a strict bias toward:

- immutable artifacts
- thin extension orchestration
- deterministic runtime services
- explicit boundary tests

The highest-value early implementation sequence is:

1. artifacts/store/session skeleton
2. Stage 1 + expansion review protocol
3. retrieval artifact production
4. deterministic evidence assembler
5. synthesis outputs
6. execution + recursive restart

That sequence preserves the spec’s core architectural boundaries while keeping each phase independently testable and usable.

---

## 13. Detailed task breakdown for Phases 3–6

The initial `implementation-tasks.json` carried a single umbrella task per phase for P3–P6. This section decomposes each of those phases into concrete, independently pickable tasks so the auto-implement loop can make forward progress in small coherent batches. The original umbrella IDs (P3-T1, P4-T1, P5-T1, P6-T1) remain in place and are considered satisfied by the combined completion of their phase siblings.

### Phase 3 — retrieval

- **P3-T2 — Retriever worker prompt and config.** Author the retriever system prompt (`src/retriever/prompt.ts`) and worker entrypoint (`src/retriever/worker.ts`). The worker runs repo reads/searches behind a boundary the conductor cannot cross. It accepts `{ intent_capture_id, intent_restatement_id, intent_spec_id? }` and emits a draft result for normalization. Acceptance: worker is reached only through `retrieval_dispatch`; conductor code cannot import worker internals; fixture-based prompt assembler test.
- **P3-T3 — Symbol and span metadata extractor.** Implement `src/retriever/symbol-extractor.ts` producing function/class symbol ranges with 1-indexed lines and absolute paths, plus a lightweight AST skeleton. Acceptance: deterministic output on a fixture repo slice; normalized absolute paths; unit tests for symbol start/count and span formatting.
- **P3-T4 — Retrieval normalization, conductor inspection API, and stage wiring.** Finish `src/retriever/normalize.ts` and add `src/conductor/retrieval.ts` plus an `artifact_inspect` API (text-safe reads of stored artifacts) so worker output becomes a valid `retrieval-index-v1` containing only structural fields (summaries, symbols, gaps, followups) with no raw source payload. Wire the stage machine to permit retrieval only after an approved restatement. Acceptance: golden test that the normalized artifact contains no raw file content; `artifact_inspect` cannot return raw bundle payloads; schema validation passes; stage-machine transition test.

### Phase 4 — evidence planning and deterministic assembler

- **P4-T2 — Span utilities.** Implement `src/util/spans.ts`: neighbor-line expansion, deterministic overlap merge, and symbol-to-span resolution against a `retrieval-index-v1`. Acceptance: pure functions, no I/O; unit tests cover merge determinism, neighbor math, and rejection of unknown file/symbol IDs.
- **P4-T3 — Budget utilities and preview mode.** Implement `src/util/budget.ts` with line/token estimates and the `evidence_prepare` preview mode returning stable estimates without materializing raw evidence. Acceptance: preview determinism test; over-budget reports surface structured reasons rather than silent pruning.
- **P4-T4 — Evidence plan authoring helpers.** Implement `src/conductor/evidence-plan.ts` so the conductor can produce a valid `evidence-plan-v1` that **embeds the full `retrieval-index-v1` unchanged** and declares per-file inclusion controls (`include_ast_skeleton`, `include_retriever_summary`, `include_entire_file`, `spans[]`) plus cross-file/gap/followup selections and `assembly_options`. Acceptance: plan round-trips through schema validation; the embedded retrieval index is byte-equal to the stored source; fixture-based authoring test.
- **P4-T5 — Deterministic assembler materialize mode.** Finish `src/services/evidence-assembler.ts` so materialize mode reads the authoritative retrieval artifact plus repo disk state and emits a valid `evidence-bundle-v1` with canonical sections (`intent_context`, `structural_context`, `raw_evidence`, `assembly_notes`). Acceptance: same plan + same retrieval + same repo → byte-identical bundle; assembler refuses unknown IDs; bundle contents match plan exactly.
- **P4-T6 — Determinism and boundary test suite.** Add `tests/assembler/*` covering determinism, budget enforcement, neighbor/overlap behavior, and negative selection boundary tests. Acceptance: test suite green and covers the boundary contracts enumerated in Phase 4.

### Phase 5 — synthesis dispatch

- **P5-T2 — Synthesis prompt assembly.** Implement `src/synthesis/prompt.ts` to assemble deterministic prompt sections from a stored `evidence-bundle-v1` without free-form context mixing. Acceptance: only requested bundle sections are included; fixture snapshot test for prompt shape.
- **P5-T3 — Synthesis worker and output validation.** Implement `src/synthesis/worker.ts` plus `src/services/synthesis-dispatch.ts`, selecting `analysis-report-v1` or `change-spec-v1` by `task_type` and validating worker output before storing. Acceptance: integration test from stored bundle to stored synthesis artifact for both task types; malformed output is rejected cleanly.
- **P5-T4 — Conductor synthesis task-type selection and rendering.** Extend `src/conductor/synthesis.ts` with heuristic selection (explanation → analysis-report, execution handoff → change-spec) and a user-facing result renderer that never exposes raw bundle content. Acceptance: stage-machine test for task-type selection; rendering excludes raw evidence fields.

### Phase 6 — execution dispatch and recursive restart

- **P6-T2 — Execution worker with safety constraints.** Implement `src/execution/worker.ts` and `src/services/execution-dispatch.ts` with required `allow_edits` and `run_validation` flags. Acceptance: execution is blocked unless constraints explicitly allow edits; unit tests cover flag enforcement.
- **P6-T3 — Execution report persistence.** Wire the worker to produce `execution-report-v1` capturing modified files and validation command results. Acceptance: integration test from a `change-spec-v1` fixture to a stored valid execution report.
- **P6-T4 — Artifact promotion to recursive intent.** Implement `src/services/artifact-promote.ts` and `src/conductor/recursive-intent.ts` producing `recursive-intent-v1` with lineage references back to the source synthesis artifact. Acceptance: lineage fields point at the source artifact ID and type; schema validation passes.
- **P6-T5 — Session restart flow from promotion.** Reset the stage machine to Stage 1 when a recursive intent is created, preserving prior lineage in session metadata. Acceptance: protocol test that promotion restarts at Stage 1 with the new verbatim intent and that prior artifact IDs remain traceable.
