---
kind: piorx/workflow-spec@1
id: piorx/workflow/default@1
name: Default piorx workflow
description: Six-stage pipeline turning user intent into either an analysis report (advisory output) or an executed code change (supervised-change output).

operating_mode: supervised-change

mandatory_controls:
  - intent.approval
  - execution.allow_edits

goals:
  - Capture user intent verbatim and produce a canonical, user-approved restatement before any downstream work
  - Optionally expand the approved restatement into a structured spec when the user opts in
  - Build narrow, retriever-authored evidence sized for the user's intent
  - Synthesize either an analysis report or an executable change spec from the evidence
  - Apply changes only behind an explicit per-run user latch

stages:
  - id: restatement
    name: Stage 1 — Restatement
    description: Capture the user's verbatim intent and produce a canonical restatement that the user approves before any downstream stage runs.
    inputs:
      - piorx/intent-capture@1
    output: piorx/intent-restatement@1
    model_class: llm
    gates:
      - intent.approval
    control:
      entry_criteria: A piorx/intent-capture@1 artifact has been written for the current session.
      exit_criteria: A piorx/intent-restatement@1 with approved=true is persisted.
      acceptance_criteria: The user has explicitly approved the canonical restatement.
      failure_handling: halt
      evidence_requirements:
        - approval-disposition

  - id: expansion
    name: Stage 2 — Expansion
    description: Optionally expand the approved restatement into a structured intent-spec covering objective, deliverables, constraints, and retrieval focus. Skipped when the user does not opt into expansion at restatement time.
    inputs:
      - piorx/intent-restatement@1
    output: piorx/intent-spec@1
    model_class: llm
    gates:
      - expansion.review
    control:
      entry_criteria: An approved piorx/intent-restatement@1 exists with expand_requested=true.
      exit_criteria: A piorx/intent-spec@1 with approved=true is persisted.
      acceptance_criteria: The user approved the expanded spec via the expansion.review gate.
      failure_handling: halt
      evidence_requirements:
        - approval-disposition

  - id: retrieval
    name: Stage 3 — Retrieval
    description: Run the agentic retriever to produce a retrieval-index that ranks files and symbols by relevance to the approved intent and seeds the evidence stage's defaults.
    inputs:
      - piorx/intent-restatement@1
    output: piorx/retrieval-index@1
    model_class: llm-agentic
    control:
      entry_criteria: An approved piorx/intent-restatement@1 (and optionally an approved piorx/intent-spec@1) is available.
      exit_criteria: A piorx/retrieval-index@1 with at least one selected file is persisted.
      failure_handling: halt
      evidence_requirements:
        - source-access-events

  - id: evidence
    name: Stage 4 — Evidence
    description: Materialize the retrieval-index's recommended_evidence defaults into an evidence-plan, accept narrow EvidenceOverride operations through the evidence.review gate, and run the deterministic assembler to produce an evidence-bundle.
    inputs:
      - piorx/retrieval-index@1
    output: piorx/evidence-bundle@1
    model_class: deterministic
    gates:
      - evidence.review
    control:
      entry_criteria: A piorx/retrieval-index@1 is available with at least one selected file.
      exit_criteria: A piorx/evidence-bundle@1 validates structurally and is persisted.
      acceptance_criteria: The bundle's stats fit within the evidence-plan's max_total_lines and max_estimated_tokens budgets.
      failure_handling: halt
      evidence_requirements:
        - override-history

  - id: synthesis
    name: Stage 5 — Synthesis
    description: Produce either an analysis-report (advisory output that ends the workflow) or a change-spec (executable output routed to the execution stage). The task-type decision is confirmable through the synthesis.confirm-task-type gate.
    inputs:
      - piorx/evidence-bundle@1
      - piorx/intent-restatement@1
    output: 'piorx/analysis-report@1 | piorx/change-spec@1'
    model_class: llm-with-advisor
    gates:
      - synthesis.confirm-task-type
    control:
      entry_criteria: A piorx/evidence-bundle@1 is available alongside the approved intent restatement.
      exit_criteria: A piorx/analysis-report@1 or piorx/change-spec@1 validates structurally and is persisted.
      acceptance_criteria: Output validates structurally AND contains at least one actionable element (a finding for analysis-report, an edit for change-spec).
      failure_handling: tentative
      evidence_requirements:
        - advisor-consultations

  - id: execution
    name: Stage 6 — Execution
    description: Apply the approved change-spec to the working tree, run validation commands, and persist an execution-report. Always gated behind execution.allow_edits — a mandatory control for supervised-change workflows.
    inputs:
      - piorx/change-spec@1
    output: piorx/execution-report@1
    model_class: deterministic
    gates:
      - execution.allow_edits
    control:
      entry_criteria: A piorx/change-spec@1 has been produced and synthesis.confirm-task-type accepted.
      exit_criteria: A piorx/execution-report@1 is persisted with status set.
      acceptance_criteria: All declared validation commands pass.
      failure_handling: halt

edges:
  - from: restatement
    to: expansion
    when:
      eq:
        - $.restatement.expand_requested
        - true
    description: Take the optional expansion path when the user opted into it during restatement.
  - from: restatement
    to: retrieval
    when:
      eq:
        - $.restatement.expand_requested
        - false
    description: Skip expansion when the user did not request it; the approved restatement feeds retrieval directly.
  - from: expansion
    to: retrieval
    description: Expansion always flows into retrieval; the intent-spec sharpens the retriever's scout terms.
  - from: retrieval
    to: evidence
    description: Retrieval produces a retrieval-index that the evidence stage narrows into a bundle.
  - from: evidence
    to: synthesis
    description: The evidence-bundle is the synthesis stage's primary input alongside the intent restatement for prompt context.
  - from: synthesis
    to: execution
    when:
      eq:
        - $.synthesis.artifact_type
        - piorx/change-spec@1
    description: Route to execution only when synthesis produced a change-spec; an analysis-report ends the workflow.

recursive_promotion_target: restatement

governance:
  evidence_requirements:
    - advisor-consultations
    - override-history
    - source-access-events
  version_pinning: strict
---

# Default piorx workflow

This workflow is the source of truth for piorx's six-stage default pipeline.
The YAML frontmatter declares its shape (every field is schema-validated as
`piorx/workflow-spec@1`); this body explains intent so an agent reading the
spec without TS source can answer canonical questions about the workflow's
structure, deliverables, and decision points.

## Operating mode

`operating_mode: supervised-change` means the workflow may propose code
changes, but never applies them without an explicit user latch. The execution
stage is gated behind `execution.allow_edits`, a `mandatory_control` no
extension can remove or weaken — the registry rejects any extension
registration that would do so at boot.

The two other operating modes — `advisory` (analysis only, no code execution)
and `constrained-autonomous` (executes within pre-approved scope and bounded
budgets) — are reachable through alternative workflow specs that an extension
publishes. This default ships supervised-change because it is the safest
posture for an interactive single-user CLI: every code change is
proposal-then-latch, never auto-apply.

## Goals

The five goals encode what success looks like for one run of this workflow:

1. **Capture intent verbatim and produce a user-approved restatement.** The
   verbatim copy is non-negotiable — every downstream stage reads from it,
   and the restatement closes the loop on "did piorx understand what I asked
   for" before any retrieval, synthesis, or execution begins.
2. **Optionally expand the approved restatement into a structured spec.**
   Expansion is opt-in at restatement time. Users with a quick analysis
   question skip it; users driving a code change usually take it because the
   resulting `intent-spec` sharpens retrieval and synthesis.
3. **Build narrow, retriever-authored evidence.** The retriever picks
   defaults; the evidence stage applies optional narrow overrides; the
   assembler produces a deterministic, byte-stable bundle. Narrowness is the
   point — token budgets are an exit criterion, not an afterthought.
4. **Synthesize either an analysis-report or a change-spec.** Synthesis is
   the only stage in this workflow whose output type varies. The
   `synthesis.confirm-task-type` gate lets the user confirm the inferred
   task type before the workflow commits to one resolution.
5. **Apply changes only behind an explicit user latch.**
   `execution.allow_edits` is mandatory for this workflow. The execution
   stage never auto-applies; its gate is platform-enforced.

## Stages

### restatement

Captures the user's verbatim intent and produces a canonical restatement
gated by `intent.approval`. The verbatim text is preserved on every
downstream artifact for forward-compat with audit, recall, and re-run.
Failure here is `halt` — there is no point retrieving evidence for an intent
the user has not approved. `intent.approval` is one of the workflow's two
mandatory controls; it cannot be removed by any extension.

### expansion

Expands the approved restatement into an `intent-spec` (objective,
deliverables, constraints, retrieval focus, open questions) gated by
`expansion.review`. The user can approve, revise (looping back with revised
intent), or reject. Skipped entirely when the user did not opt into
expansion at restatement time — the `restatement → retrieval` edge fires
instead, conditional on `$.restatement.expand_requested == false`.

### retrieval

Runs the agentic retriever to produce a `retrieval-index` ranking files and
symbols by relevance to the approved intent. The retriever is bounded by
explicit budgets (`shouldStopAfterTurn`); source-access events surface to
lineage so the workflow's `evidence_requirements` can audit which file was
read by which stage at which budget. No gate today — the retrieval-index is
reviewable through the artifact-inspect surface.

### evidence

Materializes the retrieval-index's `recommended_evidence` defaults into an
`evidence-plan`, applies optional narrow `EvidenceOverride` operations
through the `evidence.review` gate, then runs the deterministic assembler
to produce an `evidence-bundle`. Override history is recorded in lineage as
a governance evidence-requirement; the assembler is byte-stable given
identical inputs, so a re-run with the same plan always produces the same
bundle.

### synthesis

Produces either a `piorx/analysis-report@1` (advisory output, ends the
workflow) or a `piorx/change-spec@1` (executable output, routes to the
execution stage). The task-type decision is inferred from the user's
restated intent and confirmable via the `synthesis.confirm-task-type` gate.

The `acceptance_criteria` here is stricter than the schema: a structurally-
valid analysis-report with zero findings, or a change-spec with zero edits,
is a "valid but unfit" output. `failure_handling: tentative` means such an
output is persisted but explicitly labeled not-fit-for-downstream-consumption
until a subsequent decision promotes it.

### execution

Applies the approved change-spec to the working tree, runs declared
validation commands, and persists an `execution-report`. Always gated
behind `execution.allow_edits`, the workflow's second mandatory control.
Skipped entirely for analysis-only flows — the `synthesis → execution` edge
has a `when` predicate keyed on `synthesis.artifact_type` and only fires
when synthesis produced a `change-spec`.

## Edges

The edge list is a linear-with-conditional-edges DAG, not a cyclic state
graph. Cycles enter the workflow through `recursive_promotion_target`
instead (see below).

The three conditional edges are:

- `restatement → expansion` fires only when
  `$.restatement.expand_requested == true`.
- `restatement → retrieval` fires only when
  `$.restatement.expand_requested == false`.
- `synthesis → execution` fires only when
  `$.synthesis.artifact_type == piorx/change-spec@1`. An `analysis-report`
  ends the workflow at synthesis.

All other edges are unconditional. Each edge carries a natural-language
`description` field alongside its structured `when` predicate so an agent
reading the spec can explain the routing decision without parsing JSONPath.

## Governance

`evidence_requirements` lists what must appear in lineage for a run to be
auditable:

- `advisor-consultations` — every advisor call telemetered with mode,
  iterations, and usage.
- `override-history` — every applied `EvidenceOverride` recorded with its
  disposition.
- `source-access-events` — every file read by any stage with the budget
  under which it was read.

`version_pinning: strict` means lineage records the `workflow_spec_id`
active at run time, so a re-run against a different spec version is
reconstructable from lineage alone.

## Recursive promotion

`recursive_promotion_target: restatement` means a "promote to new intent"
operation re-enters the workflow at the restatement stage. This preserves
the `intent.approval` gate as the entry point for every recursion, even
when the recursion is driven by an analysis-report's recommended-next-steps
field. Top-level user-driven re-runs use this field; nested sub-workflow
descent (when a stage declares `workflow_ref` or an inline `workflow:`
block) uses sub-workflow gates and lineage-tracked sub-trees instead.
