---
kind: piorx/workflow-spec@1
id: piorx/workflow/analysis-only@1
name: piorx analysis-only workflow
description: Five-stage advisory pipeline that turns user intent into an analysis report and stops. Demonstrates how to ship a non-default workflow that skips the execution stage entirely.

operating_mode: advisory

mandatory_controls:
  - intent.approval

goals:
  - Capture user intent verbatim and produce a canonical, user-approved restatement before any downstream work
  - Optionally expand the approved restatement into a structured spec when the user opts in
  - Build narrow, retriever-authored evidence sized for the user's intent
  - Synthesize an analysis report grounded in the evidence and end the workflow there

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
    description: Produce an analysis-report grounded in the evidence bundle. The output declaration mirrors the default workflow's union for adapter compatibility, but no edge leaves this stage — the workflow always terminates here regardless of which member of the union the synthesis worker emits. Hosts driving this workflow should set the synthesisTaskType to 'analysis-report' so the worker never produces a change-spec.
    inputs:
      - piorx/evidence-bundle@1
      - piorx/intent-restatement@1
    output: 'piorx/analysis-report@1 | piorx/change-spec@1'
    model_class: llm-with-advisor
    control:
      entry_criteria: A piorx/evidence-bundle@1 is available alongside the approved intent restatement.
      exit_criteria: A piorx/analysis-report@1 validates structurally and is persisted.
      acceptance_criteria: Output validates structurally AND contains at least one finding.
      failure_handling: tentative
      evidence_requirements:
        - advisor-consultations

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

recursive_promotion_target: restatement

governance:
  evidence_requirements:
    - advisor-consultations
    - override-history
    - source-access-events
  version_pinning: strict
---

# piorx analysis-only workflow

This is the reference second pipeline shipped alongside the default
six-stage workflow per `docs/composability.md` "Phase 5 — Skills-as-strategies

- filesystem discovery" and `auto-implement-composability.md` COMP-P5-T4.
  It demonstrates how to register a non-default flow against the same
  runtime executor and registry the default uses, with **no execution
  stage** — every run terminates at synthesis with a `piorx/analysis-report@1`.

## Operating mode

`operating_mode: advisory` declares this workflow as analysis-only — it
never proposes or applies code changes. Per the composability design,
`advisory < supervised-change < constrained-autonomous` in the authority
ordering, so this workflow can be safely composed under a parent of any
operating mode without registry rejection.

The mandatory-controls list mirrors the design rule that
`mandatory_controls` propagate downward additively only — a child workflow
cannot drop a parent's mandatory control. `intent.approval` stays
mandatory; `execution.allow_edits` is removed from the mandatory list
because the workflow has no execution stage to gate.

## Goals

The four goals encode what success looks like for one run of this
workflow:

1. **Capture intent verbatim and produce a user-approved restatement.** The
   verbatim copy is non-negotiable — every downstream stage reads from it,
   and the restatement closes the loop on "did piorx understand what I
   asked for" before any retrieval, synthesis, or execution begins.
2. **Optionally expand the approved restatement into a structured spec.**
   Expansion is opt-in at restatement time. Quick analysis questions
   skip it; questions that benefit from a sharpened retrieval focus
   take it.
3. **Build narrow, retriever-authored evidence.** The retriever picks
   defaults; the evidence stage applies optional narrow overrides; the
   assembler produces a deterministic, byte-stable bundle.
4. **Synthesize an analysis-report and stop.** No change-spec, no
   execution stage, no `synthesis.confirm-task-type` gate — the task
   type is fixed.

## Stages

### restatement

Identical contract to the default workflow's `restatement` stage so the
same `Stage` adapter from `src/conductor/stage-adapters.ts` can register
against it at boot. Mandatory control `intent.approval` is preserved.

### expansion

Identical contract to the default workflow's `expansion` stage. Skipped
when the user did not opt into expansion during restatement.

### retrieval

Identical contract to the default workflow's `retrieval` stage. Produces
a `retrieval-index` that ranks files and symbols by relevance to the
approved intent.

### evidence

Identical contract to the default workflow's `evidence` stage. The
`evidence.review` gate stays in place so narrow `EvidenceOverride`
operations remain available.

### synthesis

The terminal stage of this workflow. The `output` declaration mirrors the
default workflow's `analysis-report | change-spec` union so the same
synthesis `Stage` adapter (`src/conductor/stage-adapters.ts`) registers
cleanly against both workflows — the registry's referential check would
otherwise reject divergent output declarations. Hosts driving the
analysis-only flow set `synthesisTaskType = 'analysis-report'` in the
executor's `contextExtras` so the worker never emits a change-spec.

The runtime backstops that contract: `WorkflowExecutor.runStage` rejects
any `piorx/change-spec@1` output when `operating_mode === advisory`, so a
misconfigured host that forgets to pin `synthesisTaskType` halts the run
instead of silently surfacing an executable artifact.

The `synthesis.confirm-task-type` gate is omitted from this workflow
because the task type is fixed. An extension that wants to re-introduce
confirmation can register the gate against the synthesis stage and the
runtime executor will pick it up.

## Edges

The edge list is identical to the default workflow's, minus the
`synthesis → execution` edge — this workflow ends at synthesis. The
three conditional / unconditional edges are:

- `restatement → expansion` fires only when
  `$.restatement.expand_requested == true`.
- `restatement → retrieval` fires only when
  `$.restatement.expand_requested == false`.
- `expansion → retrieval`, `retrieval → evidence`, `evidence → synthesis`
  are unconditional.

## Governance

Same `evidence_requirements` set as the default workflow — analysis-only
runs are still expected to maintain advisor-consultation, override, and
source-access auditability. `version_pinning: strict` records the
`workflow_spec_id` in lineage so a re-run against a different version is
reconstructable.

## Recursive promotion

`recursive_promotion_target: restatement` — same as the default. A
"promote to new intent" operation re-enters the workflow at the
restatement stage, preserving the `intent.approval` gate as the entry
point for every recursion.
