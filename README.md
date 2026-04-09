# pi-orchestra

`pi-orchestra` is a public extension-oriented workflow layer for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), focused on:

- intent clarification and approval
- optional intent expansion
- retrieval over approved intent/specs
- deterministic evidence assembly
- synthesis and change-spec generation
- local execution handoff
- recursive follow-up flows

The planned CLI alias is `piorx`.

## Status

This repository currently contains the initial project scaffold and the first-pass architecture/specification docs.

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

## Planned command UX

Once the extension wrapper is implemented, the intended UX is:

```bash
piorx
```

Which will run `pi` with this repository's extension/runtime layer, while a plain `pi` invocation will remain unchanged and will not automatically include this project.

## Repository layout

```text
README.md
package.json
scripts/
  install-pi.sh
  doctor.sh
docs/
  specification/
```

## Development

This repo is intended to be easy to clone and extend for anyone who wants a conductor-style workflow on top of pi.

## License

MIT
