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

### 2. Retriever agent

A local tool-using agent with read/search powers.

### 3. Intent spec expander

A slow-cheap batch or async task that expands approved restated intent.

### 4. Evidence assembler service

A deterministic resolver with no model calls.

### 5. Synthesizer

A slow-cheap batch or stronger model that consumes evidence bundles.

### 6. Local execution agent

A normal tool-calling agent for repo modifications.

## Conductor tool boundary

The conductor should **not** have direct file-reading tools.

### Active tools

Recommended conductor-visible tools:

- `intent_expand`
- `retrieval_dispatch`
- `evidence_prepare`
- `synthesis_dispatch`
- `execution_dispatch`
- `artifact_inspect`
- `artifact_promote_to_intent`

### Forbidden tools

Do not expose:

- `read`
- `bash`
- `grep`
- `find`
- `ls`
- `edit`
- `write`

## Retriever agent configuration

### Recommended model

- local, tool-capable model
- likely `openai-codex/gpt-5.3-codex-spark`

### Allowed tools

- `read`
- `bash`
- `grep`
- `find`
- `ls`

### Retriever responsibilities

- semantic discovery via `cidx --llm`
- lexical verification
- file and symbol summarization
- AST skeleton generation
- span extraction metadata
- recommended expansion judgments

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

Creates or previews an evidence bundle from the full retriever response and a declarative selection plan.

### Input

```json
{
  "mode": "preview",
  "retrieval_index_id": "retrieval_001",
  "plan": {
    "files": [
      {
        "file_id": "f1",
        "include_ast_skeleton": true,
        "include_retriever_summary": true,
        "include_entire_file": false,
        "spans": [{ "symbol_id": "s1", "include_span": true, "neighbor_lines": 8 }]
      }
    ],
    "include_cross_file_findings": true,
    "include_gaps": false,
    "include_followup_queries": false,
    "max_total_lines": 1200,
    "max_estimated_tokens": 12000
  }
}
```

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

The full retriever response must be passed through unchanged. The `plan` controls deterministic resolution/injection only.

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
