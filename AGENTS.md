# Development Notes

## Related code available via global codeindex

This repository (`/Users/russfugal/code/sks/piorx`, `repo_id=104`, `store=pg`) is an extension to pi coding-agent.

The pi coding-agent source repository is also indexed in the global codeindex and available for cross-repo retrieval:

- `/Users/russfugal/code/sks/pi-mono/packages/coding-agent`
- `repo_id=103`
- `store=pg`

When implementing or aligning extension behavior with pi internals, use cross-repo `cidx` retrieval to find analogous implementation patterns in repo 103 before local grep sweeps.

Suggested workflow:

1. Use `semantic_search` with `scope=103` or `scope=all` to find relevant coding-agent implementations.
2. Read the selected source files in `pi-mono/packages/coding-agent`.
3. Use `grep` for exact identifiers, callsites, and adjacent logic.
4. Map the discovered pattern back into this repository.
