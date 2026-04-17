# How the Conductor Works

In this repo, the **conductor** is the workflow brain, not the code-reading worker.

## What it does

It coordinates a staged pipeline:

1. Capture the user’s intent
2. Restate it and get approval
3. Optionally expand it into a fuller spec
4. Kick off retrieval
5. Choose what evidence to assemble
6. Choose synthesis type
7. Optionally hand off execution
8. Optionally restart recursively from the result

## What it explicitly does _not_ do

The key design rule is:

- **The conductor is structurally source-blind**, with one narrow exception: at Stage 1 only, files the user explicitly embedded in the initial intent via `<file name="…">…</file>` blocks may be read through the bounded `buildRestatementContext` helper. Nothing else in the conductor code path reads repository files.

Instead:

- the **retriever** runs as a deterministic scout plus a bounded file-reading agent
- the **evidence assembler** deterministically resolves the retriever-authored plan
- the **synthesizer** sees assembled evidence
- the **executor** can edit/run validation

That boundary is described in `docs/specification/00-overview.md` and enforced in code like:

- `extensions/conductor-extension.ts`
- `src/conductor/stage-machine.ts`
- `src/services/artifact-inspect.ts`

## How it works, stage by stage

### 1. Extension boot

`extensions/conductor-extension.ts`

On startup, the extension:

- creates config
- creates the artifact store
- initializes the stage machine
- stores those runtime objects on the extension context

It **does not expose raw file tools** to conductor logic.

### 2. Stage machine

`src/conductor/stage-machine.ts`

The conductor runs through a strict state machine:

- `idle -> restatement`
- `restatement -> expansion | retrieval`
- `expansion -> retrieval`
- `retrieval -> evidence`
- `evidence -> synthesis`
- `synthesis -> execution | idle`
- `execution -> idle`

The `StageMachine` persists session state and artifact pointers as it moves.

So the conductor is not just “prompting”; it’s operating over persisted workflow state.

### 3. Stage 1: restatement + approval

`src/conductor/stage-1.ts`
`src/util/intent-files.ts`

This is the first real conductor behavior, and the only one with a file-reading exception.

Before restatement:

- parses `<file name="path">…</file>` blocks from the raw intent
- records each tagged file in `intent_file_refs` with provenance (`inline | disk | reference-only`)
- builds a bounded restatement context (per-file and total char/line budgets) — inline bodies are used when present; a disk fallback is permitted for paths referenced by name
- persists both `user_intent_verbatim` (raw) and `cleaned_user_intent` (file bodies stripped) on `intent-capture-v1`

Then it:

- generates a **simple restatement** from the cleaned intent plus the bounded context block
- asks the user to approve/correct it
- loops until approved (tagged files and file refs carry through)
- asks whether the user wants **expansion**
- stores the approved result as `intent-restatement-v1`

If expansion is declined, it can move directly to retrieval.

### 4. Optional expansion

`src/conductor/expansion.ts`

If requested, the conductor sends:

- verbatim user intent
- approved restatement
- optionally tagged files / project docs

for a fuller spec. The user then reviews and approves/revises that spec before continuing.

### 5. Retrieval

`src/conductor/retrieval.ts`
`src/retriever/scout.ts`
`src/retriever/agent.ts`
`src/retriever/worker.ts`

The conductor itself does **not** retrieve code. Retrieval runs as two cooperating passes inside a single boundary:

- a **deterministic scout** (no model) curates search terms using provenance weighting (`retrieval_focus` > tagged > restatement > cleaned intent), walks the repo, and emits a narrow `selected` (≤8) plus `reserve` (≤4) tier with role and default-evidence-mode hints
- a **bounded retriever agent** (model-driven via an injected callback) reads files through a deterministic executor (`read_file`, `search_content`, `search_paths`, `follow_imports`) under hard caps, rejects false positives, and authors the final `recommended_evidence` package

The conductor:

- checks whether retrieval is allowed
- dispatches retrieval once (scout + agent run together)
- later inspects the **structural-only** retrieval artifact

The stored `retrieval-index-v1` contains summaries, AST skeletons, selection tiers, cross-file findings, strategy summary, scout terms, and `recommended_evidence` — but **no raw file bodies**. Raw reads stay inside the retriever boundary.

So the conductor sees things like:

- file summaries
- symbol lists and per-symbol selection defaults
- AST skeletons
- selection tiers and default evidence mode
- cross-file findings
- gaps and follow-up queries
- the retriever-authored `recommended_evidence` block

but not raw source.

### 6. Evidence planning

`src/conductor/evidence-plan.ts`
`src/conductor/evidence-overrides.ts`

The default plan is **authored by the retriever**. The conductor:

- builds the starting plan directly from `retrieval_index.recommended_evidence` via `createRecommendedEvidencePlan`
- optionally applies a narrow list of overrides via `applyEvidenceOverrides` — `promote_file`, `demote_file`, `set_file_mode`, `include_symbol`, `exclude_symbol`, `set_neighbor_lines`, `toggle_cross_file_findings`, `toggle_gaps`, `toggle_followup_queries`
- never reconstructs the plan from scratch and never adds new file-reading capability
- picks the downstream task type

A few override mode semantics are load-bearing and match the assembler:

- `promote_file` with `mode: "spans"` seeds spans from retrieval metadata (`recommended_evidence.files[...].spans`, falling back to `selected_by_default` symbols). Without a seed source it throws — promote with `summary+ast` and add spans via `include_symbol` instead.
- `set_file_mode` with `summary` / `summary+ast` clears any previously selected raw spans so flag changes stay in sync with emitted evidence.
- `set_file_mode` with `exclude` removes the file from `selection.files` entirely. Re-entry requires another `promote_file`.

Overrides are validated against the retrieval artifact. Unknown `file_id`s or `symbol_id`s (or missing span seeds for a `spans`-mode promotion) fail loudly and the whole override list is rejected atomically, preserving the default plan byte-identical.

It then creates `evidence-plan-v1`. The plan embeds a reference to the retrieval index unchanged, and the actual raw materialization is left to the deterministic assembler.

### 7. Deterministic evidence assembly

`src/services/evidence-assembler.ts`

This is _not_ conductor reasoning.

The assembler takes:

- the retriever response unchanged
- the conductor’s evidence plan

and deterministically produces `evidence-bundle-v1`. Only selected files are materialized; reserve files never enter the bundle unless the conductor explicitly promoted them via an override.

That bundle is where raw code can finally appear for downstream use.

### 8. Synthesis

`src/conductor/synthesis.ts`

The conductor chooses the synthesis mode heuristically:

- explanation-ish requests → `analysis-report`
- implementation-ish requests → `change-spec`

Then a synthesis worker produces either:

- `analysis-report-v1`
- `change-spec-v1`

The conductor also renders those results for the user in a safe way, without leaking raw evidence internals.

### 9. Optional execution

`src/services/execution-dispatch.ts`

If the synthesis output is actionable and edits are allowed, an execution worker can:

- apply changes
- run validation
- produce `execution-report-v1`

The conductor does not directly edit files itself in this architecture.

### 10. Recursive restart

`src/conductor/recursive-intent.ts`

A synthesis result can be promoted into a new intent.

That means the conductor can:

- turn the result into `recursive-intent-v1`
- preserve lineage
- reset stage state to `idle`
- restart at Stage 1 with the new intent

This is how follow-up refinement loops work.

## The simplest mental model

Think of the conductor as:

- a **stateful coordinator**
- with **artifact memory**
- that makes **selection and routing decisions**
- but is **structurally forbidden from reading raw code**

So:

- **retriever** = “inspect the repo”
- **conductor** = “decide what matters”
- **assembler** = “materialize exactly that evidence”
- **synthesizer** = “turn evidence into analysis or a change plan”
- **executor** = “apply changes if allowed”

## The core invariant

The most important idea in the whole design is:

> The conductor stays agentic, but cannot inspect raw repository source.

That gives you:

- better control of context
- cleaner separation of responsibilities
- deterministic evidence selection/materialization
- less accidental prompt contamination from too much raw code

## Relevant files

If you want to trace it in code, start here:

- `extensions/conductor-extension.ts`
- `src/conductor/stage-machine.ts`
- `src/conductor/stage-1.ts`
- `src/util/intent-files.ts`
- `src/conductor/retrieval.ts`
- `src/retriever/scout.ts`
- `src/retriever/agent.ts`
- `src/conductor/evidence-plan.ts`
- `src/conductor/evidence-overrides.ts`
- `src/conductor/synthesis.ts`
- `src/conductor/recursive-intent.ts`
- `docs/specification/00-overview.md`
