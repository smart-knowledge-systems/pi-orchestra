# Multi-Stage Orchestration Specification

This specification defines a layered pi-based orchestration system for intent clarification, agentic retrieval, deterministic evidence assembly, synthesis, and optional execution.

## Goals

- Keep the **conductor agentic**, but structurally unable to inspect raw repository source — with a single narrow exception for files the user explicitly embedded in the initial intent.
- Drive retrieval through a **deterministic scout followed by a bounded file-reading retriever agent**, not a broad single-pass heuristic.
- Make the **retriever the primary author of the default evidence scope** — the stored retrieval artifact carries an explicit recommended-evidence package.
- Keep the stored **retrieval artifact structural-only**: no raw file bodies leak into conductor-visible fields.
- Keep the **evidence assembler deterministic**, materializing only the retriever-authored plan (optionally patched by the conductor).
- Support recursive workflows where a synthesis result can become a new user intent and restart the pipeline.
- Support optional user-approved intent expansion before retrieval.

## Core Principles

1. **The conductor is source-blind** — it does not read repository files, with one exception: files the user explicitly embedded in the initial intent via `<file name="...">...</file>` blocks may be read before restatement.
2. **Retrieval is agentic but bounded**. A deterministic scout narrows the candidate set, then a bounded model-driven retriever agent reads files, follows leads, and authors the default evidence scope within strict limits.
3. **The stored retrieval artifact is structural-only**. It carries summaries, AST skeletons, selection tiers, and an explicit `recommended_evidence` package, but no raw file bodies.
4. **The retriever, not the conductor, authors the default evidence scope**. The conductor's role at Stage 4 is a narrow override layer — promote reserve files, tune spans, toggle section flags — not to reinvent the plan.
5. **The evidence assembler is never agentic**; it deterministically materializes the selected plan.
6. **Raw code is injected only into downstream prompts**, not back into the conductor context.
7. **Intent clarification happens before retrieval**.
8. **A synthesis result may recursively become a new user intent**, restarting at Stage 1.

## Stages

### Stage 0: User intent capture

The user provides an initial intent. Intent text may embed inline file blocks of the form `<file name="path">...contents...</file>`. These are the only repository files the conductor is permitted to read directly.

### Stage 1: Restatement and approval loop

The conductor:

- parses inline `<file name="...">...</file>` blocks out of the initial intent
- extracts **tagged files** and builds a bounded restatement context from those files
- persists both `user_intent_verbatim` (raw) and `cleaned_user_intent` (cleaned of inline file bodies) on `intent-capture-v1`
- produces a **simple restatement** of the user's intent, using the cleaned intent plus the bounded file context
- asks whether the restatement is correct
- asks whether the user wants the intent expanded into a fuller specification before retrieval

If the restatement is incorrect, the user corrects it and Stage 1 repeats. Tagged files and file references are preserved across corrections.

This inline-file read is the **only** conductor-side repo-reading exception. The conductor does not otherwise have `read`/`grep`/`bash`/`ls`/`find` tools.

### Stage 2: Optional expansion

If the user requests expansion:

- the system sends the **verbatim initial intent** and the **approved restated intent** to a slow-cheap model/batch
- optionally includes tagged files and approved project docs
- returns an expanded, reviewable specification
- the user approves or rejects/revises it

If the user rejects or corrects the expansion, this stage may repeat.

### Stage 3: Retrieval (scout + bounded agent)

Retrieval runs as two cooperating passes inside a single boundary:

1. **Deterministic scout** — turns the cleaned intent, restatement, retrieval focus, and tagged files into curated search terms, walks the repo in sorted order, and narrows the candidate set to a small `selected` set plus a `reserve` tier (strict caps: 8 selected + 4 reserve). Scout output is deterministic: same repo + same inputs → identical output. The scout also emits per-file role hints and default-evidence-mode hints.
2. **Bounded retriever agent** — a model-driven loop that receives the scout seed, reads files through a deterministic executor (`read_file`, `search_content`, `search_paths`, `follow_imports`), follows leads, rejects false positives, and authors the final selection. Hard caps on rounds, actions per round, file reads, lines/bytes per read, and total observation budget guarantee termination. The agent produces the final `recommended_evidence` package.

The retriever receives:

- cleaned user intent
- approved restated intent
- optional approved expanded spec
- tagged files from Stage 1

The retriever returns a normalized `retrieval-index-v1` artifact. The stored artifact is **structural-only** — it contains summaries, AST skeletons, selection tiers, scout terms, a strategy summary, and an explicit `recommended_evidence` block, but **no raw file bodies**. Raw file reads stay inside the retriever boundary.

### Stage 4: Evidence planning (retriever-authored default + narrow overrides)

The default evidence plan is **authored by the retriever**, not guessed by the conductor. The conductor:

- builds the default plan directly from `retrieval_index.recommended_evidence` via `createRecommendedEvidencePlan`
- optionally applies a narrow, deterministic set of **overrides** — promote/demote a file, tune file mode, add/remove/adjust symbol spans, toggle cross-file findings / gaps / followup queries
- **never rebuilds the plan from scratch** and never adds new file-reading capability

The conductor produces `evidence-plan-v1` containing the retriever-authored selection (optionally patched) plus assembly and prompt-section options.

### Stage 5: Deterministic evidence assembly

The evidence assembler receives:

- the full, unchanged retriever response
- the conductor's `evidence-plan-v1`

It deterministically materializes only the selected raw evidence and stores an `evidence-bundle-v1`. Reserve files never enter the bundle unless the conductor explicitly promoted them.

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

| Component          | Agentic |                         Can read raw repo code? |                    Can emit raw repo code? |
| ------------------ | ------: | ----------------------------------------------: | -----------------------------------------: |
| Conductor          |     Yes |   Only user-embedded `<file>` blocks at Stage 1 |                                         No |
| Retriever scout    |      No |   Yes, deterministic file walk inside retriever |                     Structural output only |
| Retriever agent    |     Yes | Yes, bounded via executor (read/search/imports) | No raw bodies in stored retrieval artifact |
| Evidence Assembler |      No |                          Yes, deterministically |         Yes, only into bundle/output store |
| Synthesizer        |     Yes |                  Yes, via assembled bundle only |                                        Yes |
| Executor           |     Yes |                                             Yes |                                        Yes |

## Related documents

- [01-artifacts-and-schemas.md](./01-artifacts-and-schemas.md)
- [02-pi-architecture.md](./02-pi-architecture.md)
- [03-prompts-and-protocol.md](./03-prompts-and-protocol.md)
