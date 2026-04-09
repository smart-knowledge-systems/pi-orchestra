# Multi-Stage Orchestration Specification

This specification defines a layered pi-based orchestration system for intent clarification, retrieval, deterministic evidence assembly, synthesis, and optional execution.

## Goals

- Keep the **conductor agentic**, but structurally unable to inspect raw repository source.
- Keep the **evidence assembler deterministic**, driven entirely by an explicit conductor API.
- Let retrieval produce rich structural judgments that the conductor can use to decide what evidence is later materialized.
- Support recursive workflows where a synthesis result can become a new user intent and restart the pipeline.
- Support optional user-approved intent expansion before retrieval.

## Core Principles

1. **The conductor never reads raw file contents**.
2. **The retriever may read and search the repository freely** within its allowed tool set.
3. **The evidence assembler is never agentic**; it only resolves the conductor's explicit evidence plan.
4. **The conductor passes the retriever response unchanged** to the evidence assembler.
5. **Raw code is injected only into downstream prompts**, not back into the conductor context.
6. **Intent clarification happens before retrieval**.
7. **A synthesis result may recursively become a new user intent**, restarting at Stage 1.

## Stages

### Stage 0: User intent capture

The user provides an initial intent.

### Stage 1: Restatement and approval loop

The conductor:

- produces a **simple restatement** of the user's intent
- asks whether the restatement is correct
- asks whether the user wants the intent expanded into a fuller specification before retrieval

If the restatement is incorrect, the user corrects it and Stage 1 repeats.

### Stage 2: Optional expansion

If the user requests expansion:

- the system sends the **verbatim initial intent** and the **approved restated intent** to a slow-cheap model/batch
- optionally includes tagged files and approved project docs
- returns an expanded, reviewable specification
- the user approves or rejects/revises it

If the user rejects or corrects the expansion, this stage may repeat.

### Stage 3: Retrieval

The retriever receives:

- verbatim initial intent
- approved restated intent
- optional approved expanded spec

The retriever returns a full `retrieval-index-v1` artifact.

### Stage 4: Evidence planning

The conductor reads the retrieval artifact and decides:

- which files/symbols/spans should be resolved
- whether to include AST skeletons
- whether to include retriever summaries
- whether to include resolved spans
- whether to include whole files
- which downstream synthesis task should run

The conductor produces `evidence-plan-v1`.

### Stage 5: Deterministic evidence assembly

The evidence assembler receives:

- the full, unchanged retriever response
- the conductor's `evidence-plan-v1`

It deterministically resolves and stores an `evidence-bundle-v1`.

### Stage 6: Synthesis

A synthesis model or batch receives:

- intent artifacts
- selected structural context
- selected raw evidence
- task-specific instructions

It returns either:

- `analysis-report-v1`
- `change-spec-v1`
- another output artifact

### Stage 7: Optional execution

If the synthesis output is actionable code work:

- a local execution agent receives the `change-spec-v1` and relevant evidence bundle
- the agent edits the repo, validates, and reports results

### Stage 8: Recursive restart

Any synthesis output may be promoted into a **new user intent**.
When this happens, the system returns to **Stage 1** with:

- a new verbatim user intent derived from the synthesis output
- optional linkage to parent artifacts

## Intent expansion document inclusion rules

### Tagged files

Any file explicitly tagged in the user's intent must be included in the expansion call.

### Untagged-intent project docs

If the user did not tag any files and project docs exist, the user must be asked whether any or all of these should be included in the expansion prompt:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`

This question is asked before the expansion call is created.

## Artifact flow

```text
user intent
  -> intent-capture-v1
  -> intent-restatement-v1
  -> optional intent-spec-v1
  -> retrieval-index-v1
  -> evidence-plan-v1
  -> evidence-bundle-v1
  -> analysis-report-v1 | change-spec-v1 | other synthesis output
  -> optional execution-report-v1
  -> optional recursive new intent
```

## Boundary summary

| Component          | Agentic |        Can read raw repo code? |                  Can emit raw repo code? |
| ------------------ | ------: | -----------------------------: | ---------------------------------------: |
| Conductor          |     Yes |                             No |                                       No |
| Retriever          |     Yes |                            Yes | No direct raw-source return to conductor |
| Evidence Assembler |      No |         Yes, deterministically |       Yes, only into bundle/output store |
| Synthesizer        |     Yes | Yes, via assembled bundle only |                                      Yes |
| Executor           |     Yes |                            Yes |                                      Yes |

## Related documents

- [01-artifacts-and-schemas.md](./01-artifacts-and-schemas.md)
- [02-pi-architecture.md](./02-pi-architecture.md)
- [03-prompts-and-protocol.md](./03-prompts-and-protocol.md)
