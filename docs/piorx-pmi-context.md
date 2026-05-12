# piorx — Technical Context for Project Management Review

## What we're building

piorx is a **controlled environment** for an AI agent to do software-engineering work on a user's codebase. Today it implements a single, opinionated end-to-end workflow — turning a user's natural-language intent into either an analysis report or an executed code change — with explicit approval points, an audit-trailed deliverable per stage, and structural separation between the orchestrator (which never reads source code directly) and the worker components (which do, under bounded budgets).

We are redesigning the orchestrator so that:

- The **default workflow** remains best-in-class and turn-key.
- The **workflow itself** becomes a first-class declarative artifact — agent-readable JSON with rich natural-language description fields — so any capable agent (or human) can read and reason about the controlled environment without reading the implementation source.
- **Alternative workflows** can be composed by extension authors without forking the core.
- An **advisor capability** (a stronger reviewer model that an executor consults at decision points within a stage) lands as the first canonical extension on the new substrate.

Primary design tension: piorx is built as an extension to a deliberately minimalist host (`pi`) that explicitly rejects sprawling workflow concepts. We are adding stage / workflow / gate primitives as _extension-internal abstractions_, not host features.

---

## Vocabulary — the things we manipulate

These are the entities we name, type, persist, and reason about. They are stable across the rest of this document.

- **Artifact** — a typed, schema-validated, immutable JSON document persisted to a session-scoped store. Every artifact has a stable identifier, a type (`piorx/intent-capture@1`, `piorx/evidence-bundle@1`, `piorx/change-spec@1`, etc.), a creation timestamp, and references to its predecessors. Once written, an artifact is never modified — supersession is by producing a new artifact that references it.

- **Stage** — a single unit of work that consumes one or more typed artifacts, optionally invokes a language model, and produces a single typed artifact as its output. Stages are independently testable; their input and output types are the contract. The work is delegated to a specialist worker (retriever, assembler, synthesizer, executor) under a stage-specific access policy. Stages do not run in parallel — the workflow is a sequence of stages with conditional edges, not a concurrent graph.

- **Gate** — a structured approval / override seam at the boundary between two stages. The session pauses, presents the produced artifact to the user (or, in future, an automated reviewer), and accepts a typed override operation that may modify the artifact before the next stage proceeds. Examples in the current default workflow: an _intent approval_ gate (user signs off on a canonical restatement of their request), an _evidence review_ gate (user can narrow or widen the planned evidence scope via typed operations), a _synthesis confirmation_ gate (user confirms the inferred task type), a _safety latch_ gate before any code is modified.

- **Workflow Spec** — a declarative artifact that names a sequence of stages, their conditional successors, the gates wired between them, and the executor / advisor model bindings for each stage. The default piorx workflow is one workflow spec; alternative workflows are alternative workflow specs. The workflow spec is the canonical source of truth for what the workflow does; the implementation code is the source of truth for how each stage runs. The two are validated against each other at startup, with loud failures on drift.

- **Override** — a typed operation accepted by a gate that modifies a stage's output before the next stage proceeds. Overrides are validated against the artifact's schema before being applied; invalid overrides are rejected without modifying the artifact. Every applied override is recorded in the session's audit trail with the operation, the user, and the timestamp.

- **Advisor** — an optional capability: a stronger reviewer model that the executor of a stage consults at decision points within that stage. Advisors are scoped per-stage; they consult, they do not decide. Their consultations are independently telemetered (model id, tokens, latency, outcome) and cost-attributed.

- **Recursive promotion** — converting a stage's output (a completed analysis report, a completed change spec) into the input intent for a fresh workflow run. The promotion is itself a gated decision (the user opts in). Lineage across promotions is preserved so that the chain of decisions can be reconstructed after the fact.

- **Lineage** — the append-only audit trail of which stages ran, which artifacts they produced, which overrides were applied, which advisor consultations occurred, and how recursive promotions chain across sessions. Queryable; immutable; persisted alongside the artifacts themselves.

---

## The default workflow — six stages

| #            | Stage                                                    | Input artifacts                                          | Output artifact                                 | Gate (if any)                                                           | Worker has source-code access?                                                                        |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1            | Intent restatement                                       | User's verbatim text (and inline `<file>` references)    | `intent-capture@1`, `intent-restatement@1`      | Approval — user signs off on the canonical restatement                  | No (only the inline file references the user explicitly tagged)                                       |
| 2            | Expansion (optional)                                     | `intent-restatement@1`, tagged files                     | `intent-spec@1`                                 | Review — user approves / revises / rejects the expanded specification   | No                                                                                                    |
| 3            | Retrieval                                                | `intent-restatement@1`, `intent-spec@1` (if Stage 2 ran) | `retrieval-index@1`                             | None                                                                    | **Yes**, under bounded budget (max 3 rounds × 4 actions × 12 file reads × 256 KiB observation budget) |
| 4            | Evidence assembly                                        | `retrieval-index@1`                                      | `evidence-plan@1`, then `evidence-bundle@1`     | Override — narrow / widen the plan via typed operations before assembly | No (assembler reads only the planned spans)                                                           |
| 5            | Synthesis                                                | `evidence-bundle@1`, intent context                      | Either `analysis-report@1` or `change-spec@1`   | Confirmation — user confirms inferred task type                         | No                                                                                                    |
| 6            | Execution (only when Stage 5 produced a `change-spec@1`) | `change-spec@1`                                          | `execution-report@1`                            | Safety latch — `allow_edits` flag must be explicit                      | **Yes**, modifies user code                                                                           |
| (recurrence) | Recursive promotion                                      | Any final artifact                                       | New `intent-capture@1` for a fresh workflow run | Promote prompt — user opts in                                           | N/A                                                                                                   |

Two structural properties that govern the controlled environment:

1. **The orchestrator is structurally source-blind.** It never reads the user's source code itself. Only the retrieval and execution stages have file-system access, and within bounded budgets. Other stages operate purely on artifacts. This is enforced by the conductor / worker boundary: no general file-read capability is exposed in the conductor's tool surface.

2. **Every change to a deliverable is gated and recorded.** Stages produce artifacts; gates accept typed overrides; the lineage records every decision. Roll-back to any prior stage is possible because the artifacts at each stage are immutable; re-running a later stage does not mutate the earlier ones.

---

## What we're making composable

Today the six-stage flow is hardcoded in procedural code (a single `runPipelineFromIntent` function ~120 lines long). We are promoting it to a layered design:

1. **The workflow definition is a declarative artifact** (`piorx/workflow-spec@1`) — JSON with rich natural-language descriptions of each stage's purpose, its inputs and outputs, and the conditions under which the workflow advances. The spec is the source of truth for what the workflow does.

2. **TypeScript stage implementations register against stage ids declared in the spec.** At startup, the runtime validates that every stage in the spec has a matching implementation with the right input / output types, that every declared gate is registered, and that every artifact type referenced is known. Drift between spec and implementation produces a loud boot-time error.

3. **A registry** lets future extension authors add new stages, register alternative workflow specs, and wire new gates without forking the core.

Future extensions can therefore (a) insert a stage between two existing stages, (b) define an entirely alternative workflow, (c) register an advisor capability for a specific stage, (d) introduce new typed override operations for an existing gate. The default workflow's control properties — every output approved, every override audit-trailed, every advisor consultation telemetered — must be preserved as composability is added; that is one of the design questions below.

---

## Specific questions we'd value input on

1. **Gate design — exception escalation.** Each gate today accepts a discriminated-union of typed override operations and has a binary outcome: _accept_ (apply the override, continue) or _reject_ (roll back to the prior stage). Should there be a third path — an _escalate_ path that surfaces an out-of-bounds situation to a higher authority (today: only the user; future: potentially an automated reviewer or an enterprise policy engine)? Where should that escalation be expressed in the workflow spec?

2. **Tolerances at stage boundaries.** The retrieval stage and the executor stage operate within bounded budgets (max rounds, max file reads, max observation bytes for retrieval; safety constraints for execution). When a budget is exceeded, the stage produces a structured "budget breached" outcome and the workflow continues with a reduced or absent deliverable. Is "continue with reduced deliverable" the right model, or should budget breaches always be raised as exceptions for explicit handling?

3. **Audit and traceability — what's missing from lineage.** Every artifact records its predecessors; every override records the operation, the user, and the timestamp; every advisor consultation logs model, tokens, and outcome. What additional fields would a credible audit demand of this lineage record? In particular, what would a regulator or compliance reviewer expect to find?

4. **Delegation — should worker access policies be hoisted into the workflow spec?** Today the policies are baked into the worker boundaries (the retriever has source access; the synthesizer doesn't). Should these become explicit per-stage delegation bindings in the workflow spec, so an alternative workflow author can adjust them — or is hard-coding them a control property the spec should not surrender?

5. **Failure modes — when a stage's output fails downstream validation.** If a stage produces an artifact that fails its schema validator (e.g., a synthesis worker returns a malformed `change-spec@1`), the current behavior is _raise validation error → stage fails → user is shown the error and may retry the stage or roll back_. Is there a cleaner failure pattern? Specifically: should there be a notion of "tentative output" that lives until a downstream consumer accepts it, or is "fail loud, retry explicitly" the right discipline for a controlled environment?

6. **Composability without losing control.** When extensions can add stages, alter workflow specs, register new gates, and introduce new override types, the _controlled_ environment becomes a _configurable_ one. How do we keep the default workflow's control properties (every deliverable approved, every override audit-trailed, every advisor consultation telemetered) when extensions compose freely? Are there control properties that should be expressible _in the workflow spec itself_ (e.g., "this stage's output must be approved before any successor stage may run") rather than being hard-coded in the runtime?

---

## Constraints we are working within

- **The host is intentionally minimal.** The pi coding-agent host provides four built-in tools (file read, write, edit, shell), an event hook system, and a tool / command registry. It explicitly rejects MCP, built-in subagents, and built-in workflow concepts. piorx's primitives compose pi's existing extension API; we cannot expect host changes.

- **piorx ships as a single binary, single-process.** Each workflow run is a fresh session with disk-persisted artifacts under `.pi/artifacts/`. There is no persistent service; lineage spans sessions only via recursive promotion (which carries forward the prior artifact ids).

- **piorx is pi-flavored, not platform-locked.** Extensions, when they arrive, are markdown-frontmatter or JSON files discovered from well-known paths (`~/.config/piorx/...` and `.piorx/...`). Alternative workflows can be authored by users without forking piorx.

- **The redesign is staged.** Phase 1 promotes the workflow definition to a declarative artifact (the foundation move). Phase 2 introduces per-stage executor + advisor configuration. Phase 3 puts the first real LLM-driven stage on the new substrate. Phases 4–5 broaden composability. Each phase is independently shippable and gated on every prior phase's tests staying green.

---

## Reference material (deeper detail available if useful)

- The current six-stage workflow is documented at `docs/conductor-overview.md` and `docs/specification/00-overview.md` in the piorx repository.
- The advisor strategy assessment (`docs/advisor-strategy-assessment.md`) details how a stronger reviewer model is consulted within an LLM-driven stage, including three operational modes (server-side, custom tool, inline pre-call) and per-phase model bindings.
- Artifact schemas are TypeScript discriminated unions with runtime validators (`src/artifacts/types.ts`, `src/artifacts/schemas.ts`).
- The bounded retriever-agent loop (`src/retriever/agent.ts`) is the closest existing analogue to a stage with tolerances and exception handling already in production.
