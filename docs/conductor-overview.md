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

- **The conductor never reads raw repo files**

Instead:

- the **retriever** can read/search code
- the **evidence assembler** can deterministically resolve raw spans/files
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

This is the first real conductor behavior.

It:

- stores the user’s verbatim request as `intent-capture-v1`
- generates a **simple restatement**
- asks the user to approve/correct it
- loops until approved
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
`src/retriever/worker.ts`

The conductor itself does **not** retrieve code. Instead it:

- checks whether retrieval is allowed
- dispatches to the retriever worker
- later inspects a **text-safe retrieval artifact**

The retriever can read the repo and produces `retrieval-index-v1`, but normalization strips raw file payloads from conductor-visible fields.

So the conductor sees things like:

- file summaries
- symbol lists
- AST skeletons
- gaps
- follow-up suggestions

but not raw source.

### 6. Evidence planning

`src/conductor/evidence-plan.ts`

This is where the conductor makes decisions.

Given the retrieval index, it decides:

- which files matter
- which symbols/spans to include
- whether to include AST skeletons
- whether to include retriever summaries
- whether to include whole files
- whether to include cross-file findings, gaps, followups
- what downstream task type to run

It then creates `evidence-plan-v1`.

Important detail: the plan embeds a reference to the retrieval index unchanged, and the actual raw materialization is left to the deterministic assembler.

### 7. Deterministic evidence assembly

`src/services/evidence-assembler.ts`

This is _not_ conductor reasoning.

The assembler takes:

- the retrieval result
- the conductor’s evidence plan

and deterministically produces `evidence-bundle-v1`.

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
- `src/conductor/retrieval.ts`
- `src/conductor/evidence-plan.ts`
- `src/conductor/synthesis.ts`
- `src/conductor/recursive-intent.ts`
- `docs/specification/00-overview.md`
