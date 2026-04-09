# How `scripts/auto-implement.sh` Relates to Conductor / Orchestra

`scripts/auto-implement.sh` is **not part of the conductor runtime** itself. It is a **repo-level development automation script** used to build and advance **pi-orchestra**.

## Relationship in one line

- **pi-orchestra / conductor** = the product architecture being implemented
- **`scripts/auto-implement.sh`** = a meta-script that helps an external coding agent implement that architecture task by task

## What the script actually does

It automates the implementation workflow around these files:

- `implementation-tasks.json`
- `implementation-phase-1.md`
- `dev-log.txt`

Specifically, it:

1. selects planned tasks from `implementation-tasks.json`
2. marks them `active`
3. prompts Claude to implement those tasks
4. runs `bun format && bun check`
5. prompts Claude again to fix validation failures if needed
6. evaluates whether tasks are complete
7. marks them `completed` or `in_progress`
8. prompts Claude to create atomic git commits
9. appends activity to `dev-log.txt`

So it is basically an **implementation driver for the repo**, not a user-facing orchestra/conductor stage.

## Why it exists in this repo

This repo was built from a specification and phased implementation plan. The script helps execute that plan incrementally.

You can see that in the prompts embedded in the script:

- “You are reviewing the backlog for **pi-orchestra**”
- “You are implementing the currently active tasks for **pi-orchestra**”

So the script’s purpose is to help **construct the conductor/orchestra system**, not to participate in its runtime behavior.

## How it relates conceptually

You can think of it as operating at a different layer.

### Runtime layer

This is the actual system users interact with:

- `extensions/conductor-extension.ts`
- `src/conductor/*`
- `src/services/*`
- `src/retriever/*`

This is where the **conductor** lives.

### Development layer

This is tooling used by maintainers while building the system:

- `scripts/auto-implement.sh`

This script orchestrates implementation work on the repo, but it is **outside** the conductor architecture.

## Why the names feel related

The repo is called **pi-orchestra**, but the internal architecture uses the term **conductor**.

That means:

- **orchestra** = the whole multi-stage system/project
- **conductor** = the central coordinating component inside that system

`auto-implement.sh` is a kind of **meta-orchestrator for developing pi-orchestra**, but it is not “the conductor” from the architecture docs.

## Important distinction

The conductor has strict boundaries:

- cannot read raw repo source
- moves through stages
- works via artifacts and worker boundaries

`scripts/auto-implement.sh` has none of those runtime constraints. It freely:

- reads task files
- invokes Claude
- runs `bun`
- uses `git`
- updates JSON
- writes logs

So it is a **developer automation script**, not a bounded conductor component.

## Short version

`scripts/auto-implement.sh` relates to conductor/orchestra like this:

- it helps **build and maintain** the orchestra/conductor codebase
- it does **not** implement the conductor runtime protocol
- it is a **meta-development workflow**, not a stage in the user-facing conductor workflow
