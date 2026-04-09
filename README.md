# pi-orchestra

`pi-orchestra` is a public extension-oriented workflow layer for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), focused on:

- intent clarification and approval
- optional intent expansion
- retrieval over approved intent/specs
- deterministic evidence assembly
- synthesis and change-spec generation
- local execution handoff
- recursive follow-up flows

The CLI alias is `piorx`.

## Status

Phase 1–6 of the conductor workflow are implemented end-to-end: deterministic artifact store, Stage 1 restatement loop, expansion protocol, retrieval dispatch with a bounded worker, deterministic evidence planning and assembly, synthesis dispatch with task-type selection, execution dispatch with safety constraints, and recursive-restart promotion. **376 tests pass under `bun test`** and `tsc --noEmit` is clean. See [`docs/completion_summary.md`](./docs/completion_summary.md) for the phase-by-phase breakdown and [`implementation-phase-1.md`](./implementation-phase-1.md) for the plan.

## Install UX

### 1. Install pi

```bash
cd piorx
npm run install:pi
```

This runs:

```bash
bun add -g @mariozechner/pi-coding-agent
```

### 2. Verify installation

```bash
npm run doctor
```

### 3. Clone this repo

```bash
git clone <repo-url> piorx
cd piorx
```

### 4. Link the wrapper command

```bash
npm run link
```

### 5. Run the wrapper

```bash
piorx
```

`piorx` runs `pi` with this repository's extension entrypoint. A plain `pi` invocation remains unchanged and does not automatically include this project.

## Repository layout

```text
README.md
implementation-phase-1.md
implementation-tasks.json
package.json
bin/
  piorx
extensions/
  conductor-extension.ts
src/
  artifacts/      # types, schemas, ids, store
  runtime/        # config, paths, session-state
  conductor/      # stage machine, stage-1, expansion, retrieval, evidence-plan, synthesis, recursive-intent
  services/       # intent-expand, retrieval-dispatch, evidence-assembler, synthesis-dispatch, execution-dispatch, artifact-promote, artifact-inspect
  retriever/      # prompt, worker, normalize, symbol-extractor
  synthesis/      # prompt, worker
  execution/      # worker
  util/           # project-docs, spans, budget
tests/
  artifacts/ assembler/ conductor/ execution/ fixtures/ interaction/ retriever/ synthesis/
scripts/
  install-pi.sh
  doctor.sh
docs/
  specification/
```

## Running tests

```bash
bun test          # full suite (376 tests)
bun run typecheck # tsc --noEmit
bun run check     # typecheck + lint
```

## Development

This repo is intended to be easy to clone and extend for anyone who wants a conductor-style workflow on top of pi.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
