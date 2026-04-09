# Handoff Prompt for Next Agent

You are picking up implementation work for **pi-orchestra**.

## Repository

- Repo name: `pi-orchestra`
- Working directory: this repository root
- GitHub repo: `smart-knowledge-systems/pi-orchestra`
- Local wrapper command: `piorx`

## Your primary task

Read the specification docs and produce an **implementation plan** for building the system.

Write the plan as one or more files named:

- `implementation-phase-1.md`
- `implementation-phase-2.md`
- `implementation-phase-3.md`
- etc.

Place them in the repository root unless you have a strong reason to place them elsewhere.

## Required source material

You should read these docs fully before planning:

- `docs/specification/00-overview.md`
- `docs/specification/01-artifacts-and-schemas.md`
- `docs/specification/02-pi-architecture.md`
- `docs/specification/03-prompts-and-protocol.md`

## Goal of your output

Create a practical implementation plan that converts the specification into buildable phases for this repo.

Your plan should:

- break implementation into coherent phases
- identify deliverables for each phase
- identify dependencies between phases
- identify what should be built in the pi extension vs deterministic runtime/services
- identify what should be stubbed first vs fully implemented later
- identify testing/validation strategy for each phase
- identify risky or ambiguous parts of the spec that need explicit decisions

## Important project context

This repo is intentionally set up so that:

- plain `pi` does **not** include this project automatically
- `piorx` is the wrapper entrypoint that runs `pi` with this repo's extension entrypoint
- current extension entrypoint is a minimal stub at:
  - `extensions/conductor-extension.ts`

The implementation should follow the specification language already adopted in the repo:

- use **conductor**, not orchestrator
- keep the **evidence assembler deterministic and non-agentic**
- keep the **conductor unable to read raw repository source**
- preserve the staged flow:
  1. user intent capture
  2. restatement/approval loop
  3. optional intent expansion
  4. retrieval
  5. evidence planning
  6. deterministic evidence assembly
  7. synthesis
  8. optional execution
  9. optional recursive restart from synthesis output

## Additional design constraints to preserve

Be careful to preserve these boundaries from the spec:

1. **Conductor boundary**
   - The conductor may read summaries, AST skeletons, symbol summaries, relevance notes, gaps, and followup suggestions.
   - The conductor may not read raw file contents.
   - The conductor must pass the full retriever response unchanged to the evidence assembler.

2. **Evidence assembly boundary**
   - The evidence assembler is deterministic.
   - It resolves only what the conductor explicitly requests.
   - It must support per-file inclusion controls such as:
     - AST skeleton yes/no
     - retriever summary yes/no
     - resolved span yes/no
     - whole file yes/no

3. **Intent expansion boundary**
   - The expansion stage must include all user-tagged files.
   - If no files are tagged and project docs exist (`README.md`, `AGENTS.md`, `CLAUDE.md`), the user must be asked whether any/all should be included.
   - The expansion output must be reviewable and user-approved before retrieval.

4. **Recursive restart behavior**
   - A synthesis output may become a new user intent.
   - If promoted, the system restarts at Stage 1.

## Existing repo contents

Useful current files:

- `README.md`
- `CONTRIBUTING.md`
- `package.json`
- `bin/piorx`
- `extensions/conductor-extension.ts`
- `docs/specification/*`
- `scripts/setup.sh`
- `scripts/install-pi.sh`
- `scripts/doctor.sh`

## What I want from you specifically

Please create an implementation plan that is concrete enough that another agent could begin executing Phase 1 immediately.

For each phase, include at least:

- objective
- scope
- files/modules likely to be created or modified
- interfaces/artifacts involved
- test strategy
- exit criteria
- deferred items

If useful, split the work into tracks such as:

- extension/UI track
- artifact/runtime track
- retriever track
- evidence assembler track
- synthesis/execution track

## Suggested planning lens

It may help to think in terms of these early milestones:

- **Phase 1:** scaffolding, artifact store, minimal conductor loop skeleton
- **Phase 2:** Stage 1 restatement/approval + expansion plumbing
- **Phase 3:** retriever dispatch + retrieval artifact handling
- **Phase 4:** evidence-plan and deterministic evidence assembler
- **Phase 5:** synthesis dispatch and artifact production
- **Phase 6:** execution dispatch and recursive restart flow

You do not have to use exactly those phases if you find a better structure, but your plan should be similarly actionable.

## Output expectation

Write the implementation plan files to disk in this repo.

If one file is enough, use `implementation-phase-1.md` and make it a phased master plan.
If multiple files are better, split them cleanly.

Do not start implementing the system yet unless it is necessary to support the planning output.
Your primary deliverable is the implementation plan.
