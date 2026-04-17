# Agentic Retrieval + Intent-File Context Implementation Plan

A detailed implementation plan for the revised retrieval architecture in `piorx`.

## Goal

Move from:

- conductor-owned default evidence scoping
- heuristic single-pass retrieval
- broad evidence packages

To:

- intent-aware restatement
- deterministic scout → bounded retriever agent
- retriever-authored default evidence recommendation
- structural-only retrieval artifact
- deterministic evidence materialization from that recommendation
- narrow conductor override hooks

Per current project direction: **edit v1 contracts directly**. Nothing has shipped, so compatibility-preserving version bumps are unnecessary unless a clean break becomes obviously simpler than in-place correction.

---

## Recommended design summary

The intended design is:

1. **User intent may include files**
   - the conductor may read those files before restatement
   - this is the only planned conductor-side repo-reading exception
2. **Retriever scout**
   - deterministic
   - narrows the candidate set
3. **Retriever agent**
   - reads files directly
   - follows leads
   - decides relevance and scope
4. **Normalized retrieval artifact**
   - structural only
   - rich narrowing metadata
   - should usually be trusted as the default evidence recommendation
5. **Evidence assembler**
   - materializes only the selected raw evidence

This implies a responsibility split:

- **Conductor**: workflow + approval + policy, source-blind except for user-supplied intent files
- **Retriever**: file-reading analysis boundary, primary arbiter of relevance and default evidence scope
- **Evidence assembler**: deterministic raw-evidence materializer

---

## Design principles

1. **Only the conductor is source-blind**
   - except for files explicitly included in the initial user intent

2. **The retriever is the file-reading analyst**
   - scout narrows
   - agent reads files
   - agent decides scope

3. **The retrieval artifact is structural-only**
   - no raw file bodies
   - but rich enough for the conductor to trust

4. **The retriever, not the conductor, authors the default evidence scope**
   - conductor may amend, not reinvent

5. **The evidence assembler stays deterministic**
   - it materializes the plan it is given
   - it does not make independent relevance decisions

6. **The override path is narrow**
   - edge-case control only
   - not a substitute for retriever judgment

---

## Architectural target state

### Stage 1 — Intent capture and restatement

- Parse inline `<file name="...">...</file>` blocks in the initial user input.
- Extract tagged file paths and bounded context from those files.
- Use that context during restatement.
- Persist both the raw input and a cleaned intent suitable for downstream stages.

### Stage 3 — Retrieval

- Run a deterministic scout pass first.
- Feed scout output into a bounded model-driven retriever agent.
- Allow the retriever agent to read repository files directly.
- Persist a structural retrieval artifact containing:
  - selected files
  - reserve files / near-threshold candidates
  - selected symbols
  - rationale and confidence
  - exact recommended default evidence scope

### Stage 4 — Evidence

- Build the default evidence plan from retriever recommendations.
- Let the conductor inspect and optionally patch that plan.
- Materialize only the selected evidence.

---

## Contract changes

## 1. `intent-capture-v1`

### Current

```ts
export interface IntentCaptureV1 {
  artifact_type: 'intent-capture-v1';
  user_intent_verbatim: string;
  tagged_files: string[];
  timestamp: string;
}
```

### Proposed changes

Add:

- `cleaned_user_intent: string`
- optionally `intent_file_refs: Array<{ path: string; source: 'inline' | 'reference-only' | 'disk' }>`

### Why

- preserve the raw input exactly
- avoid letting retrieval inherit massive inline file bodies
- make the cleaned intent explicit rather than re-derived ad hoc
- preserve traceability for user-provided file context

### Acceptance criteria

- Stage 1 persists both raw and cleaned forms
- retrieval and expansion use cleaned intent by default
- `tagged_files` remains the canonical file-path list for downstream stages

---

## 2. `retrieval-index-v1`

### Current shape limitations

Current retrieval artifacts contain files, symbols, summaries, and a few recommendation-ish fields, but they do **not** explicitly represent:

- the retriever's default evidence package
- reserve candidates
- file-level selection tier
- symbol-level default inclusion
- strategy summary / scout terms used

### Proposed additions

#### Top-level

- `strategy_summary: string`
- `scout_terms: string[]`
- `recommended_evidence: {
  files: Array<{
    file_id: string;
    include_ast_skeleton: boolean;
    include_retriever_summary: boolean;
    include_entire_file: boolean;
    spans: Array<{
      symbol_id: string;
      include_span: boolean;
      neighbor_lines: number;
    }>;
  }>;
  include_cross_file_findings: boolean;
  include_gaps: boolean;
  include_followup_queries: boolean;
}`

#### Per-file

- `selection_tier: 'selected' | 'reserve'`
- `selection_reason: string`
- `default_evidence_mode: 'exclude' | 'summary' | 'summary+ast' | 'spans' | 'whole_file'`

#### Per-symbol

- `selected_by_default: boolean`
- `default_neighbor_lines: number`
- `selection_reason: string`

### Why

This turns the retrieval artifact into:

- conductor-safe context
- a retriever-authored default evidence recommendation
- a precise override target for conductor edge cases

### Acceptance criteria

- the retrieval artifact alone is sufficient to build the default evidence plan
- the conductor can inspect reserve candidates and override them selectively
- no raw file content is stored in the artifact

---

## 3. `evidence-plan-v1`

### Plan

Keep the core shape if possible. Add helper-level behavior first rather than expanding schema immediately.

Optional future addition:

- `authoring: { source: 'retriever-default' | 'conductor-adjusted'; overrides_applied: number }`

### Why

The plan artifact already expresses the eventual materialization contract well. The missing behavior is mostly **how the plan gets authored**.

### Acceptance criteria

- default plans come directly from retrieval recommendations
- adjusted plans apply explicit conductor overrides deterministically

---

## Phase 1 — Stage 1 user-intent file context

## Objective

Allow the conductor to read files explicitly included in the initial user intent before restatement, and only there.

## Scope

- Parse inline `<file name="...">...</file>` blocks from the incoming message.
- Extract tagged file paths.
- Build a bounded restatement context from those files.
- Persist a cleaned intent for downstream stages.

## Target files

- `extensions/conductor-extension.ts`
- `src/conductor/stage-1.ts`
- `src/artifacts/types.ts`
- `src/artifacts/schemas.ts`
- `src/util/intent-files.ts` (new or completed helper)
- tests:
  - `tests/interaction/stage-1.test.ts`
  - new/updated interaction tests for input parsing

## Implementation steps

1. Parse `<file name="...">...</file>` blocks from `event.text`.
2. Produce:
   - `rawIntent`
   - `cleanedIntent`
   - `taggedFiles`
   - bounded `restatementContext`
3. Change Stage 1 flow so:
   - persisted capture stores raw + cleaned intent
   - restatement model gets cleaned user request plus included-file context
4. Ensure retrieval and expansion use the cleaned intent, not inline file bodies.
5. Preserve `tagged_files` for expansion and retrieval boosting.

## Guardrails

- only files explicitly embedded in the initial user input are readable here
- no general repo browsing from the conductor
- no new general-purpose conductor file-reading API

## Acceptance criteria

- included files appear in `tagged_files`
- restatement improves using file context
- retrieval prompt assembly no longer inherits giant inline file bodies
- conductor still cannot read arbitrary repo files

---

## Phase 2 — Deterministic scout pass

## Objective

Create a deterministic, narrow, high-signal candidate set before the retriever agent's first turn.

## Scope

Split the current heuristic worker into:

- a **scout**
- an **agent coordinator**

## Target files

- `src/retriever/worker.ts` → reduce to orchestration
- `src/retriever/scout.ts` (new)
- `src/retriever/prompt.ts`
- `src/services/retrieval-dispatch.ts`
- tests:
  - `tests/retriever/retrieval-index.test.ts`
  - `tests/retriever/scout.test.ts` (new)

## Implementation steps

1. Build curated scout terms from:
   - cleaned intent
   - approved restatement
   - `retrieval_focus`
   - `tagged_files`
2. Remove naive bag-of-words behavior.
3. Scout should deterministically return:
   - top candidate files
   - top candidate symbols
   - path hits
   - import/cross-file hints
   - reserve candidates
   - gaps
4. Keep scout output aggressively small:
   - e.g. 8 selected + 4 reserve files
5. Feed scout results into the retriever agent's first turn.

## Deterministic scout output should include

- score
- reasons
- top symbol candidates
- file role hints
- likely default evidence mode hints

## Acceptance criteria

- same repo + same inputs => identical scout output
- tagged files are strongly boosted
- candidate set is materially narrower than the current retrieval output
- scout output is enough to seed the first agent turn without exposing raw file content to the conductor

---

## Phase 3 — Bounded retriever agent

## Objective

Let the retriever behave like an analyst: read files, follow leads, and decide what belongs in the default evidence package.

## Scope

Model-driven loop, bounded by strict execution limits.

## Important architecture choice

Do **not** import pi extension APIs into `src/retriever/**`.

Follow the Stage 1 pattern:

- inject a model-calling function into retrieval orchestration
- keep pi host/model details at the extension edge

## Target files

- `extensions/conductor-extension.ts`
- `src/services/retrieval-dispatch.ts`
- `src/retriever/agent.ts` (new)
- `src/retriever/agent-prompt.ts` (new)
- `src/retriever/agent-types.ts` (new)
- `src/retriever/actions.ts` or `src/retriever/executor.ts` (new)
- tests:
  - `tests/retriever/agent.test.ts` (new)
  - `tests/retriever/retrieval-index.test.ts`

## Agent loop shape

### Turn 1 input

- approved restated intent
- optional expanded retrieval focus
- tagged files
- deterministic scout result
- hard limits / budget
- instruction to return structured JSON only

### Agent output per round

```ts
{
  status: 'continue' | 'stop';
  summary: string;
  actions: RetrievalAction[];
}
```

### Recommended action types

- `read_file { path, mode: 'full' | 'window', start?, count?, reason }`
- `search_content { term, path_hint?, reason }`
- `search_paths { term, dir_hint?, reason }`
- `follow_imports { path, reason }`

### Deterministic executor responsibilities

- perform the requested actions
- read files and search within repo bounds
- return bounded observations for the next round

## Limits

Start with hard caps:

- max 3 rounds
- max 4 actions per round
- max 10–12 total file reads
- max bytes/lines per observation
- max total observation budget for the retrieval run

## Final agent output

The final round should emit:

- selected files
- reserve files
- selected symbols
- per-file default evidence mode
- per-symbol default neighbor lines
- strategy summary
- gaps / followups
- cross-file findings
- exact `recommended_evidence`

## Guardrails

- raw file contents exist only inside the retriever loop
- raw file contents are not stored in retrieval artifacts
- raw file contents are not exposed by `artifactInspect`

## Acceptance criteria

- stubbed-model tests show the agent can:
  - read a file
  - follow an import
  - reject a false positive
  - stop within bounds
- the loop always terminates
- selected files/symbols are narrower and better justified than scout-only output

---

## Phase 4 — Normalize into a structural retrieval artifact

## Objective

Persist a conductor-safe artifact that captures the retriever's conclusions and default evidence recommendation.

## Target files

- `src/retriever/normalize.ts`
- `src/artifacts/types.ts`
- `src/artifacts/schemas.ts`
- `src/services/artifact-inspect.ts`
- `src/conductor/retrieval.ts`
- tests:
  - `tests/retriever/normalize.test.ts`
  - `tests/conductor/retrieval-stage.test.ts`
  - sample fixtures

## Implementation steps

1. Update normalization to strip all raw content from worker output.
2. Validate and persist new retrieval fields.
3. Preserve:
   - strategy summary
   - scout terms
   - selected/reserve tiers
   - default evidence modes
   - per-symbol default inclusion data
   - exact `recommended_evidence`

## Inspection API changes

`artifactInspect(..., 'retrieval-index-v1', ...)` should return:

- selected vs reserve files
- default evidence mode per file
- selected symbols
- default neighbor lines
- strategy summary
- exact retriever-recommended evidence scope

## Acceptance criteria

- retrieval artifacts remain structural-only
- the conductor receives enough information to trust the retrieval artifact as the default
- reserve candidates are inspectable and overrideable
- validators and fixtures are updated

---

## Phase 5 — Default evidence plan generation from retriever recommendations

## Objective

Stop making the conductor guess evidence scope.

## Scope

Replace the naive default evidence-plan builder.

## Target files

- `src/conductor/evidence-plan.ts`
- `extensions/conductor-extension.ts`
- `src/util/budget.ts`
- tests:
  - `tests/assembler/evidence-plan.test.ts`
  - `tests/assembler/budget.test.ts`
  - `tests/assembler/evidence-assembler.test.ts`

## Implementation steps

Add a new helper:

- `createRecommendedEvidencePlan(retrievalIndex, options?)`

This helper should:

- copy `recommended_evidence.files` into `selection.files`
- preserve cross-file / gap / followup defaults from retrieval
- apply default neighbor lines exactly
- exclude reserve files unless explicitly promoted

Keep `createEvidencePlan()` as the low-level manual constructor if useful.

## Replace current behavior

Delete or retire the current default pattern:

- summary for every retrieved file
- first two symbols per file

That should no longer exist as the default path.

## Acceptance criteria

- the default evidence plan mirrors retrieval recommendations exactly
- evidence preview is materially smaller / more precise than the current default
- assembler behavior remains deterministic

---

## Phase 6 — Conductor override API

## Objective

Let the conductor amend retriever recommendations without taking over planning.

## Scope

Provide a narrow patch API over the retriever default.

## Target files

- `src/conductor/evidence-plan.ts`
- `src/conductor/evidence-overrides.ts` (new, recommended)
- `extensions/conductor-extension.ts`
- tests:
  - `tests/assembler/evidence-overrides.test.ts` (new)

## Recommended override operations

- `promote_file(file_id, mode)`
- `demote_file(file_id, mode)`
- `include_symbol(file_id, symbol_id, neighbor_lines?)`
- `exclude_symbol(file_id, symbol_id)`
- `set_neighbor_lines(file_id, symbol_id, neighbor_lines)`
- `toggle_cross_file_findings(boolean)`
- `toggle_gaps(boolean)`
- `toggle_followup_queries(boolean)`

## Recommended behavior

- start from `createRecommendedEvidencePlan(index)`
- apply overrides deterministically
- validate all file/symbol references
- keep overrides explicit and minimal

## Important rule

The override API is for edge cases, not for reconstructing the plan from scratch.

## Acceptance criteria

- reserve files can be promoted
- selected files can be widened or narrowed
- overrides affect only the intended targets
- invalid overrides fail loudly

---

## Phase 7 — Extension wiring and UX

## Objective

Wire the new flow into the existing extension without broadening conductor file access.

## Target files

- `extensions/conductor-extension.ts`

## Changes

1. **Stage 1**
   - parse intent files
   - pass cleaned intent + restatement context
2. **Stage 3**
   - retrieval dispatch runs scout + agent
   - conductor notification summarizes:
     - selected files
     - reserve files
     - default evidence scope
3. **Stage 4**
   - plan comes from retriever defaults
   - conductor may optionally apply overrides before preview/materialize

## Suggested summary output

Instead of today's broad summary, show:

- selected files
- reserve candidates
- files planned as summary-only
- files planned as spans
- files planned as whole-file
- key selected symbols
- why the scope is narrow

## Acceptance criteria

- happy path requires no manual conductor planning
- edge-case overrides remain possible
- status / logging stay readable without leaking raw content

---

## Phase 8 — Tests and docs

## Objective

Lock in the new boundary and behavior.

## Docs to update

- `docs/specification/00-overview.md`
- `docs/specification/01-artifacts-and-schemas.md`
- `docs/specification/02-pi-architecture.md`
- `docs/specification/03-prompts-and-protocol.md`
- `docs/conductor-overview.md`

## Test additions

### Stage 1

- parses inline intent files
- stores tagged files
- uses cleaned intent for retrieval
- does not allow arbitrary conductor-side repo file reads

### Scout

- deterministic candidate selection
- tagged-file boosting
- curated query generation

### Agent

- bounded rounds
- file read + lead following
- false-positive rejection
- reserve candidate creation

### Normalization

- no raw content leaks
- new fields validate
- recommended evidence is preserved

### Evidence plan

- default plan equals retriever recommendation
- overrides patch deterministically

### End-to-end

- user intent with included files
- retrieval narrows correctly
- evidence bundle is materially smaller than the current baseline

---

## Suggested implementation order

1. **Contract updates**
   - artifact types / schemas / docs for intent + retrieval recommendation fields
2. **Stage 1 intent-file support**
   - parsing, cleaned intent, tagged files
3. **Scout extraction**
   - deterministic candidate narrowing
4. **Retriever agent loop**
   - injected model callback + bounded file-reading rounds
5. **Normalization + inspection**
   - structural artifact with recommended evidence
6. **Recommended evidence plan helper**
   - replace naive defaults
7. **Override API**
   - narrow conductor adjustments
8. **Docs + full test sweep**

---

## Non-goals for this work

- changing synthesis / execution in the same pass
- exposing raw retrieval reads to the conductor
- making the assembler agentic
- adding new artifact versions purely for compatibility
- reworking batch support as part of retrieval redesign

---

## Up-front decisions to make

1. **Intent capture shape**
   - add `cleaned_user_intent` vs reinterpret existing `user_intent_verbatim`
   - recommendation: **add cleaned field, keep raw input**

2. **How exact the retrieval recommendation should be**
   - implicit via file/symbol metadata
   - or explicit via `recommended_evidence`
   - recommendation: **explicit `recommended_evidence`**

3. **Reserve candidate representation**
   - separate list vs `selection_tier`
   - recommendation: **`selection_tier` on each file**

4. **Override provenance**
   - ignore vs record in plan metadata
   - recommendation: optional, nice-to-have, not phase-1 critical

---

## Definition of done

This work is done when:

- Stage 1 can use user-supplied files for better restatement
- retrieval runs as deterministic scout + bounded file-reading agent
- the retrieval artifact remains structural-only
- the retrieval artifact includes an explicit default evidence recommendation
- the conductor usually accepts retriever recommendations directly
- conductor overrides are possible but narrow
- the evidence assembler materializes only the selected raw evidence
- tests prove the boundary and shrinking behavior

---

## Expected outcome

If implemented successfully, `piorx` will stop treating retrieval as a broad keyword pre-pass and start treating it as a constrained, file-reading analysis stage whose primary output is not just "relevant files" but a **trustworthy default evidence package**.
