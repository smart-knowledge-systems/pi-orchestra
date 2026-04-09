# Contributing

Thanks for your interest in contributing to `pi-orchestra`.

## Goals

This project aims to provide a public, cloneable conductor workflow layer for pi with:

- intent clarification
- optional intent expansion
- retrieval
- deterministic evidence assembly
- synthesis and change-spec generation
- execution handoff

Please keep contributions aligned with the specifications in `docs/specification/`.

## Development setup

Install pi globally:

```bash
npm run install:pi
```

Verify your environment:

```bash
npm run doctor
```

Link the local CLI wrapper:

```bash
npm run link
```

Then run:

```bash
piorx
```

## Contribution guidelines

- Prefer small, focused pull requests.
- Keep behavior consistent with the published specs unless the PR explicitly updates the spec.
- Update documentation when behavior changes.
- Preserve the boundary that the conductor must not read raw repository source.
- Preserve the boundary that the evidence assembler must remain deterministic and non-agentic.

## Commit style

Recommended prefixes:

- `feat:` new functionality
- `fix:` bug fix
- `docs:` documentation changes
- `refactor:` internal restructuring
- `chore:` maintenance

## Specs first

If you are changing the workflow or artifact contracts, update the relevant files under:

```text
docs/specification/
```

before or alongside implementation changes.
