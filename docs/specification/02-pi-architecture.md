# pi Extension and Runtime Architecture

This document specifies a concrete pi-oriented architecture for implementing the orchestration system.

## Implementation style

Use a hybrid architecture:

- **pi extension** for interactive orchestration, user approval loops, and tool boundaries
- **deterministic local runtime/services** for artifact storage and evidence assembly
- **subagents / batch tools** for retrieval, expansion, synthesis, and execution

## High-level components

### 1. Conductor session

A pi session whose model is only allowed to:

- restate intent
- request optional expansion
- trigger retrieval
- create evidence plans
- dispatch synthesis/execution steps

### 2. Retriever (scout + bounded agent)

Retrieval runs inside a dedicated boundary that is allowed to read the repo. It has two cooperating components:

- a **deterministic scout** that narrows the candidate set before any model call (curated terms, sorted file walk, selected+reserve tiers, role/mode hints)
- a **bounded retriever agent** that uses an injected model callback and a deterministic executor to read files, follow imports, and author the final `recommended_evidence` package within strict limits

The model callback is injected at the extension edge; `src/retriever/**` has no pi-host imports.

### 3. Intent spec expander

A slow-cheap batch or async task that expands approved restated intent.

### 4. Evidence assembler service

A deterministic resolver with no model calls.

### 5. Synthesizer

A slow-cheap batch or stronger model that consumes evidence bundles.

### 6. Local execution agent

A normal tool-calling agent for repo modifications.

## Conductor tool boundary

The conductor has **no general file-reading tools**. The only exception is a bounded, single-shot read of files the user explicitly embedded in the initial intent (`<file name="...">...</file>` blocks), used solely to build the restatement context at Stage 1.

### Active tools

Recommended conductor-visible tools:

- `intent_expand`
- `retrieval_dispatch`
- `evidence_prepare`
- `evidence_override` — apply a narrow `EvidenceOverride[]` to the retriever-authored default plan
- `synthesis_dispatch`
- `execution_dispatch`
- `artifact_inspect`
- `artifact_promote_to_intent`

### Stage 1 file-reading exception

At Stage 1 only, the conductor parses inline file blocks from the raw user intent and uses `buildRestatementContext(intentText, repoRoot)` to build a bounded context (max chars/lines per file, max total chars). This helper:

- reads inline bodies directly when present
- falls back to a disk read for paths that were referenced by name but not inlined
- records provenance per file as `inline | disk | reference-only`
- never widens into general repo browsing

Nothing else in the conductor code path reads repo files.

### Forbidden tools

Do not expose to the conductor:

- general-purpose `read`
- `bash`
- `grep`
- `find`
- `ls`
- `edit`
- `write`

## Retriever configuration

Retrieval is the only repository-reading stage in the conductor pipeline. It has two components with different agentic posture.

### Scout (deterministic, no model)

- curated term generation weighted by provenance (retrieval focus > tagged files > restatement > cleaned intent)
- sorted file walk with a bounded skip list (`node_modules`, `.git`, `dist`, …)
- per-file scoring over name, path, content, and extracted symbols
- emits `selected` (≤8) and `reserve` (≤4) candidates with rationale, role hint, and default-evidence-mode hint
- no model calls; same repo + same inputs → identical output

### Agent (bounded, model-driven)

- driven by an injected `AgentModelCallback({ systemPrompt, userPrompt, round }) => Promise<string>`
- pi host details stay at the extension edge; `src/retriever/**` has no pi-host imports
- action types: `read_file { path, mode, start?, count?, reason }`, `search_content { term, path_hint?, reason }`, `search_paths { term, dir_hint?, reason }`, `follow_imports { path, reason }`
- deterministic executor bounded by default limits: `maxRounds=3`, `maxActionsPerRound=4`, `maxFileReads=12`, `maxLinesPerRead=200`, `maxBytesPerRead=16 KiB`, `maxObservationBudgetBytes=256 KiB`
- emits final `recommended_evidence` plus strategy summary and followup queries
- raw file bodies are read through the executor but do not leave the retrieval boundary — the normalized artifact is structural-only
- on model/parse errors, falls back to the scout-synthesized recommendation and records `stopReason` (`agent_stopped | round_cap | action_cap | model_error | parse_error`)

### Retriever responsibilities

- scout-driven candidate narrowing
- bounded file reads, content search, path search, import following
- file and symbol summarization, AST skeletons, selection tiers
- authoring the default `recommended_evidence` package

### Retriever non-responsibilities

- repo modification
- emitting raw source to the conductor
- final user-facing synthesis unless explicitly requested

## Intent expansion behavior

### Inputs

Expansion receives:

- `user_intent_verbatim`
- `approved_restated_intent`
- all user-tagged files
- optionally selected project docs

### Project-doc prompt inclusion

If `tagged_files.length === 0` and any of the following exist:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`

then the user must be asked whether any/all should be included in the expansion prompt.

### Output

- `intent-spec-v1`
- user review required before retrieval dispatch

## Deterministic evidence assembler

The evidence assembler is not a tool the conductor uses to read code.
It is a deterministic service invoked through an explicit API.

### Inputs

- full `retrieval-index-v1`, unchanged
- `evidence-plan-v1`

### Outputs

- `evidence-bundle-v1`
- bundle metadata
- stats / size estimates
- optional preview information

### Hard constraints

- no model calls
- no heuristic expansion beyond declared plan
- no omission of required requested sections unless budget rules explicitly require deterministic truncation
- no mutation of retriever artifact semantics

## Artifact store

Use a deterministic artifact store keyed by `artifact_id`.

### Suggested stored artifact classes

- intent artifacts
- retrieval artifacts
- evidence plans
- evidence bundles
- synthesis outputs
- execution outputs
- recursive intents

### Access patterns

- conductor sees artifact metadata and text-safe artifacts
- raw evidence bundles are visible to synthesis and execution layers
- conductor should not be fed raw bundle contents back into model context

## Proposed conductor-facing APIs

## 1. `intent_expand`

Expands approved restated intent via slow-cheap processing.

### Input

```json
{
  "intent_capture_id": "intent_001",
  "intent_restatement_id": "restatement_001",
  "include_files": ["README.md", "docs/models.md"]
}
```

### Output

```json
{
  "intent_spec_id": "spec_001",
  "status": "completed"
}
```

## 2. `retrieval_dispatch`

Triggers retriever agent.

### Input

```json
{
  "intent_capture_id": "intent_001",
  "intent_restatement_id": "restatement_001",
  "intent_spec_id": "spec_001"
}
```

### Output

```json
{
  "retrieval_index_id": "retrieval_001",
  "status": "completed"
}
```

## 3. `evidence_prepare`

Creates or previews an evidence bundle from the retriever-authored default plan. The conductor does not build the plan from scratch: by default it calls `createRecommendedEvidencePlan(retrieval_index)` and hands the result straight to the assembler.

### Input (preview / materialize)

```json
{
  "mode": "preview",
  "retrieval_index_id": "retrieval_001"
}
```

### Optional overrides

Before preview or materialize, the conductor may apply a narrow patch list via `applyEvidenceOverrides`. Each override validates file/symbol references against the retrieval artifact and throws loudly on invalid input.

```json
{
  "overrides": [
    { "op": "promote_file", "file_id": "f2", "mode": "summary" },
    { "op": "include_symbol", "file_id": "f1", "symbol_id": "s2", "neighbor_lines": 2 },
    { "op": "toggle_gaps", "value": true }
  ]
}
```

Supported ops: `promote_file`, `demote_file`, `set_file_mode`, `include_symbol`, `exclude_symbol`, `set_neighbor_lines`, `toggle_cross_file_findings`, `toggle_gaps`, `toggle_followup_queries`.

### Output

```json
{
  "status": "preview",
  "estimated_tokens": 1800,
  "estimated_lines": 86,
  "would_include": {
    "ast_skeletons": 1,
    "summaries": 1,
    "spans": 1,
    "full_files": 0
  }
}
```

### Materialize output

```json
{
  "status": "materialized",
  "evidence_bundle_id": "bundle_001",
  "estimated_tokens": 1800,
  "estimated_lines": 86
}
```

### Critical behavior

- The retrieval artifact is passed to the assembler unchanged.
- The default plan is the retriever-authored `recommended_evidence` — the conductor does not pick summaries and first-two spans.
- Overrides are additive and validated. An invalid reference rejects the whole override list and preserves the default plan byte-identical.
- The assembler materializes only the selected evidence — reserve files are never included unless explicitly promoted.

## 4. `synthesis_dispatch`

Runs a synthesis task against an evidence bundle.

### Input

```json
{
  "task_type": "change-spec",
  "intent_capture_id": "intent_001",
  "intent_restatement_id": "restatement_001",
  "intent_spec_id": "spec_001",
  "evidence_bundle_id": "bundle_001",
  "instructions": "Prepare a detailed handoff for a local execution agent."
}
```

### Output

```json
{
  "status": "completed",
  "output_artifact_type": "change-spec-v1",
  "output_artifact_id": "change_001"
}
```

## 5. `execution_dispatch`

Delegates `change-spec-v1` to a local editing agent.

### Input

```json
{
  "change_spec_id": "change_001",
  "evidence_bundle_id": "bundle_001",
  "execution_constraints": {
    "allow_edits": true,
    "run_validation": true
  }
}
```

### Output

```json
{
  "status": "completed",
  "execution_report_id": "exec_001"
}
```

## 6. `artifact_promote_to_intent`

Promotes a synthesis artifact into a new verbatim user intent and restarts Stage 1.

### Input

```json
{
  "source_artifact_type": "analysis-report-v1",
  "source_artifact_id": "analysis_001",
  "new_user_intent_verbatim": "Using the previous analysis, generate a concrete change specification."
}
```

### Output

```json
{
  "recursive_intent_id": "recur_001",
  "restart_stage": 1
}
```

## Evidence-selection API semantics

The conductor must be able to control, per file:

- AST skeleton inclusion: yes/no
- retriever-generated summary inclusion: yes/no
- resolved file span inclusion: yes/no, by symbol or direct span
- full file inclusion: yes/no

### Canonical per-file selection shape

```json
{
  "file_id": "f1",
  "include_ast_skeleton": true,
  "include_retriever_summary": true,
  "include_entire_file": false,
  "spans": [
    {
      "symbol_id": "s1",
      "include_span": true,
      "neighbor_lines": 8
    },
    {
      "start": 188,
      "count": 32,
      "include_span": true,
      "neighbor_lines": 0
    }
  ]
}
```

## Prompt injection strategy

The evidence assembler should not return a single flat blob. It should produce deterministic sections:

- `intent_context`
- `structural_context`
- `raw_evidence`
- `assembly_notes`

These sections are then injected into downstream prompts by `synthesis_dispatch` or `execution_dispatch`.

## User-facing interactive flow in pi

### Phase A: intent loop

Implemented by extension commands / input interception.

1. User submits intent
2. Conductor restates intent
3. User approves/corrects and chooses expansion yes/no
4. Optional expansion job runs
5. User reviews expansion

### Phase B: retrieval + evidence + synthesis

After approval:

1. Retrieval dispatched
2. Conductor inspects `retrieval-index-v1`
3. Conductor creates evidence plan
4. Evidence bundle prepared
5. Synthesis dispatched
6. Optional execution dispatched

## Session persistence

Persist artifact metadata and IDs using extension entries or a dedicated store. Suggested approach:

- store normalized artifacts on disk under `.pi/artifacts/` or `~/.pi/agent/artifacts/`
- persist only IDs and lightweight state into session entries
- rehydrate state on `session_start`

## Suggested file layout

```text
.pi/
  artifacts/
    intents/
    retrieval/
    evidence-plans/
    evidence-bundles/
    synthesis/
    execution/
  extensions/
    conductor-extension.ts
```

## Recommended implementation order

1. intent restatement loop
2. expansion flow + project-doc prompt inclusion
3. retriever dispatch
4. retrieval-index storage
5. evidence-plan API
6. deterministic evidence assembler with preview/materialize
7. synthesis dispatch
8. recursive promote-to-intent flow
9. execution dispatch
