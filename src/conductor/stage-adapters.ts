/**
 * Stage adapters — typed `Stage<>` wrappers over the existing conductor
 * controllers and dispatch services.
 *
 * Per `docs/composability.md` "Phase 1 — Scaffolding":
 *
 *   - Each conductor controller (`stage-1`, `expansion`, `retrieval`,
 *     `synthesis`, `recursive-intent`) is re-expressed as a `Stage`
 *     adapter that registers against the stage id declared in the default
 *     workflow spec (`src/runtime/workflows/piorx-default.workflow.md`).
 *   - Deterministic stages (assembler, normalizer) wrap as Stages without
 *     `modelConfig`.
 *   - Service dispatchers (`src/services/*-dispatch.ts`) stay as the
 *     implementation backing `run()`; their typed boundaries do not change.
 *
 * The adapters here are purely additive in Phase 1:
 *   - They are registered in a `WorkflowRegistry` (so the registry can
 *     resolve every stage id declared in the default workflow spec) but
 *     are not yet invoked by the workflow executor — that landing happens
 *     in COMP-P1-T7 (`src/runtime/workflow-executor.ts`) and COMP-P1-T11
 *     (collapse `runPipelineFromIntent` into `workflowExecutor.run(...)`).
 *   - The existing `runPipelineFromIntent` orchestration in
 *     `extensions/conductor-extension.ts` is untouched, preserving
 *     byte-identical behavior on the Phase 1 gate test
 *     (`tests/interaction/agentic-retrieval-flow.test.ts`).
 *
 * The adapters' `run()` bodies delegate to the existing dispatch services
 * for the deterministic portion of each stage. Multi-step user-facing
 * orchestration (restatement approval loop, expansion review, evidence
 * override review, synthesis task-type confirmation) is the responsibility
 * of `GateSpec` implementations registered against each stage id —
 * COMP-P1-T10 lands the first concrete gate (`evidence.review`), and
 * COMP-P1-T11 routes the remaining UI flows through gate composition
 * inside the executor.
 *
 * The adapters and their registration helper live in a single module so
 * the existing controller files stay free of registry surface.
 */

import { generateArtifactId } from '../artifacts/ids.ts';
import type { ChangeSpecV1, IntentRestatementV1 } from '../artifacts/types.ts';
import type { Stage, StageContext, StageResult } from '../runtime/stage.ts';
import { WorkflowRegistry } from '../runtime/registry.ts';
import { evidenceAssemble } from '../services/evidence-assembler.ts';
import { executionDispatch } from '../services/execution-dispatch.ts';
import { retrievalDispatch } from '../services/retrieval-dispatch.ts';
import { synthesisDispatch, type SynthesisTaskType } from '../services/synthesis-dispatch.ts';
import { selectTaskType } from './synthesis.ts';
import { createRecommendedEvidencePlan } from './evidence-plan.ts';
import type { PiOrchestraConfig } from '../runtime/config.ts';
import type { AgentModelCallback } from '../retriever/agent-types.ts';

// ---------------------------------------------------------------------------
// Adapter context — additional services some run() bodies need beyond
// `StageContext`. The executor (COMP-P1-T7) supplies them when invoking the
// adapters; for Phase 1 they are optional so the adapters can be registered
// without forcing the existing host wiring to change.
// ---------------------------------------------------------------------------

export interface StageAdapterServices {
  /** Runtime config (paths). Required for retrieval dispatch. */
  readonly runtimeConfig?: PiOrchestraConfig;
  /** Retriever agent model callback. Optional — falls back to scout-only. */
  readonly retrieverAgentModel?: AgentModelCallback;
  /**
   * Synthesis task-type override. The default workflow's
   * `synthesis.confirm-task-type` gate replaces the inferred task type with
   * the user-confirmed value; until that gate runs the adapter falls back to
   * the keyword heuristic in `selectTaskType`.
   */
  readonly synthesisTaskType?: SynthesisTaskType;
  /**
   * Whether the user has latched `execution.allow_edits`. Mandatory control
   * — the executor refuses to call the execution adapter without this flag
   * set, but it is plumbed through here for the executor's gate path.
   */
  readonly allowEdits?: boolean;
}

/**
 * The composite context an adapter's `run()` reads. Extends `StageContext`
 * with the optional services above; adapters that don't need them ignore
 * the extension cleanly.
 */
export interface StageAdapterContext extends StageContext, StageAdapterServices {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireArtifactId(id: string | null, label: string): string {
  if (!id) {
    throw new Error(`stage adapter: ${label} required but absent from session state`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Stage 1 — restatement
// ---------------------------------------------------------------------------
//
// The user-facing approval loop lives in `Stage1Controller`. The adapter's
// `run()` produces a draft `intent-restatement@1` (approved=false) from the
// captured intent and the model callback; the `intent.approval` gate flips
// `approved` to `true` after the user confirms. The intent-capture is
// already persisted by the host before this stage runs.

export const restatementStage: Stage<'piorx/intent-capture@1', 'piorx/intent-restatement@1'> = {
  id: 'restatement',
  inputs: ['piorx/intent-capture@1'],
  output: 'piorx/intent-restatement@1',
  control: {
    entry_criteria: 'A piorx/intent-capture@1 artifact has been written for the current session.',
    exit_criteria: 'A piorx/intent-restatement@1 with approved=true is persisted.',
    acceptance_criteria: 'The user has explicitly approved the canonical restatement.',
    failure_handling: 'halt',
    evidence_requirements: ['approval-disposition'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const captureId = requireArtifactId(
      ctx.session.artifacts.intent_capture_id,
      'intent_capture_id',
    );
    const capture = await ctx.store.get('piorx/intent-capture@1', captureId);
    if (!capture) {
      throw new Error(`restatement stage: intent-capture artifact "${captureId}" not found`);
    }

    const restated = await ctx.model(
      'You restate user intent in a single canonical sentence; preserve scope and constraints.',
      capture.cleaned_user_intent,
    );

    const id = generateArtifactId('piorx/intent-restatement@1');
    const restatement: IntentRestatementV1 = {
      artifact_type: 'piorx/intent-restatement@1',
      artifact_id: id,
      intent_capture_id: captureId,
      user_intent_verbatim: capture.user_intent_verbatim,
      restated_intent: restated.trim(),
      approved: false,
      expand_requested: false,
      approval_turns: 0,
    };
    await ctx.store.put(restatement);
    return { output_artifact_id: id };
  },
};

// ---------------------------------------------------------------------------
// Stage 2 — expansion
// ---------------------------------------------------------------------------
//
// Expansion's UI loop (project-doc inclusion question, approve/revise/reject
// review) lives in `ExpansionController`. The adapter is a placeholder
// declaration in Phase 1 — the executor (COMP-P1-T7) and gate composition
// (COMP-P1-T11) drive the controller through the registry. Until those
// land, calling `run()` is a configuration error: the adapter's purpose in
// T8 is to expose the typed Stage<> shape to the registry.

export const expansionStage: Stage<'piorx/intent-restatement@1', 'piorx/intent-spec@1'> = {
  id: 'expansion',
  inputs: ['piorx/intent-restatement@1'],
  output: 'piorx/intent-spec@1',
  control: {
    entry_criteria: 'An approved piorx/intent-restatement@1 exists with expand_requested=true.',
    exit_criteria: 'A piorx/intent-spec@1 with approved=true is persisted.',
    acceptance_criteria: 'The user approved the expanded spec via the expansion.review gate.',
    failure_handling: 'halt',
    evidence_requirements: ['approval-disposition'],
  },
  async run(_ctx: StageContext): Promise<StageResult> {
    throw new Error(
      'expansion stage: orchestrated by ExpansionController + expansion.review gate; ' +
        'the workflow executor (COMP-P1-T7) drives this stage through the registry. ' +
        'Direct adapter invocation is not supported in Phase 1.',
    );
  },
};

// ---------------------------------------------------------------------------
// Stage 3 — retrieval
// ---------------------------------------------------------------------------
//
// Wraps `retrievalDispatch`. The dispatch service is the typed boundary
// behind run() and stays unchanged.

export const retrievalStage: Stage<'piorx/intent-restatement@1', 'piorx/retrieval-index@1'> = {
  id: 'retrieval',
  inputs: ['piorx/intent-restatement@1'],
  output: 'piorx/retrieval-index@1',
  control: {
    entry_criteria:
      'An approved piorx/intent-restatement@1 (and optionally an approved piorx/intent-spec@1) is available.',
    exit_criteria: 'A piorx/retrieval-index@1 with at least one selected file is persisted.',
    failure_handling: 'halt',
    evidence_requirements: ['source-access-events'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    if (!services.runtimeConfig) {
      throw new Error('retrieval stage: runtimeConfig is required to dispatch retrieval');
    }
    const captureId = requireArtifactId(
      ctx.session.artifacts.intent_capture_id,
      'intent_capture_id',
    );
    const restatementId = requireArtifactId(
      ctx.session.artifacts.intent_restatement_id,
      'intent_restatement_id',
    );

    const result = await retrievalDispatch(
      {
        intent_capture_id: captureId,
        intent_restatement_id: restatementId,
        intent_spec_id: ctx.session.artifacts.intent_spec_id,
      },
      ctx.store,
      services.runtimeConfig,
      services.retrieverAgentModel ? { retrieverAgentModel: services.retrieverAgentModel } : {},
    );
    if (result.status !== 'success' || !result.retrieval_index_id) {
      throw new Error(`retrieval stage: dispatch failed — ${result.message}`);
    }
    return { output_artifact_id: result.retrieval_index_id };
  },
};

// ---------------------------------------------------------------------------
// Stage 4 — evidence
// ---------------------------------------------------------------------------
//
// Two-step: build a default evidence plan from the retrieval index, then
// run the deterministic assembler. Narrow `EvidenceOverride` operations
// applied through the `evidence.review` gate (COMP-P1-T10) layer between
// these steps; this adapter handles the no-override path. The override
// path stays in the gate's `applyOverride` until the executor merges them.

export const evidenceStage: Stage<'piorx/retrieval-index@1', 'piorx/evidence-bundle@1'> = {
  id: 'evidence',
  inputs: ['piorx/retrieval-index@1'],
  output: 'piorx/evidence-bundle@1',
  control: {
    entry_criteria: 'A piorx/retrieval-index@1 is available with at least one selected file.',
    exit_criteria: 'A piorx/evidence-bundle@1 validates structurally and is persisted.',
    acceptance_criteria:
      "The bundle's stats fit within the evidence-plan's max_total_lines and max_estimated_tokens budgets.",
    failure_handling: 'halt',
    evidence_requirements: ['override-history'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const retrievalIndexId = requireArtifactId(
      ctx.session.artifacts.retrieval_index_id,
      'retrieval_index_id',
    );
    const index = await ctx.store.get('piorx/retrieval-index@1', retrievalIndexId);
    if (!index) {
      throw new Error(`evidence stage: retrieval-index "${retrievalIndexId}" not found`);
    }
    const plan = createRecommendedEvidencePlan(index);
    await ctx.store.put(plan);

    const result = await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: retrievalIndexId,
        evidence_plan_id: plan.artifact_id,
      },
      ctx.store,
    );
    if (
      result.status !== 'success' ||
      !('evidence_bundle_id' in result) ||
      !result.evidence_bundle_id
    ) {
      throw new Error(`evidence stage: assembler failed — ${result.message}`);
    }
    return {
      output_artifact_id: result.evidence_bundle_id,
      additional_artifact_ids: [plan.artifact_id],
    };
  },
};

// ---------------------------------------------------------------------------
// Stage 5 — synthesis
// ---------------------------------------------------------------------------
//
// Wraps `synthesisDispatch`. The task-type heuristic in `selectTaskType`
// stays as the default; the `synthesis.confirm-task-type` gate replaces it
// when the executor surfaces user confirmation through the StageAdapterContext.
//
// `failure_handling: 'tentative'` per `docs/composability.md` — a
// structurally-valid analysis-report with zero findings (or change-spec
// with zero edits) is "valid but unfit", and the gate routes that to a
// distinct outcome.

export const synthesisStage: Stage<
  'piorx/evidence-bundle@1' | 'piorx/intent-restatement@1',
  'piorx/analysis-report@1 | piorx/change-spec@1'
> = {
  id: 'synthesis',
  inputs: ['piorx/evidence-bundle@1', 'piorx/intent-restatement@1'],
  output: 'piorx/analysis-report@1 | piorx/change-spec@1',
  control: {
    entry_criteria:
      'A piorx/evidence-bundle@1 is available alongside the approved intent restatement.',
    exit_criteria:
      'A piorx/analysis-report@1 or piorx/change-spec@1 validates structurally and is persisted.',
    acceptance_criteria:
      'Output validates structurally AND contains at least one actionable element (a finding for analysis-report, an edit for change-spec).',
    failure_handling: 'tentative',
    evidence_requirements: ['advisor-consultations'],
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    const captureId = requireArtifactId(
      ctx.session.artifacts.intent_capture_id,
      'intent_capture_id',
    );
    const restatementId = requireArtifactId(
      ctx.session.artifacts.intent_restatement_id,
      'intent_restatement_id',
    );
    const evidenceBundleId = requireArtifactId(
      ctx.session.artifacts.evidence_bundle_id,
      'evidence_bundle_id',
    );

    let taskType = services.synthesisTaskType;
    if (!taskType) {
      const restatement = await ctx.store.get('piorx/intent-restatement@1', restatementId);
      if (!restatement) {
        throw new Error(`synthesis stage: restatement "${restatementId}" not found`);
      }
      taskType = selectTaskType(restatement.restated_intent);
    }

    const instructions =
      taskType === 'change-spec'
        ? 'Produce a concrete change plan grounded in the evidence.'
        : 'Produce an analysis report grounded in the evidence.';

    const result = await synthesisDispatch(
      {
        task_type: taskType,
        intent_capture_id: captureId,
        intent_restatement_id: restatementId,
        intent_spec_id: ctx.session.artifacts.intent_spec_id,
        evidence_bundle_id: evidenceBundleId,
        instructions,
      },
      ctx.store,
    );
    if (result.status !== 'success' || !result.synthesis_artifact_id) {
      throw new Error(`synthesis stage: dispatch failed — ${result.message}`);
    }
    return { output_artifact_id: result.synthesis_artifact_id };
  },
};

// ---------------------------------------------------------------------------
// Stage 6 — execution
// ---------------------------------------------------------------------------
//
// Wraps `executionDispatch`. Always gated behind `execution.allow_edits`
// (one of the workflow's two `mandatory_controls`). The adapter refuses
// to run unless the gate has set `allowEdits` true; the executor (T7)
// surfaces the gate decision through `StageAdapterServices.allowEdits`.

export const executionStage: Stage<'piorx/change-spec@1', 'piorx/execution-report@1'> = {
  id: 'execution',
  inputs: ['piorx/change-spec@1'],
  output: 'piorx/execution-report@1',
  control: {
    entry_criteria:
      'A piorx/change-spec@1 has been produced and synthesis.confirm-task-type accepted.',
    exit_criteria: 'A piorx/execution-report@1 is persisted with status set.',
    acceptance_criteria: 'All declared validation commands pass.',
    failure_handling: 'halt',
  },
  async run(ctx: StageContext): Promise<StageResult> {
    const services = ctx as StageAdapterContext;
    if (services.allowEdits !== true) {
      throw new Error(
        'execution stage: blocked — execution.allow_edits gate has not been latched. ' +
          'The mandatory control prevents the worker from being invoked.',
      );
    }
    const synthesisId = requireArtifactId(ctx.session.artifacts.synthesis_id, 'synthesis_id');
    const evidenceBundleId = requireArtifactId(
      ctx.session.artifacts.evidence_bundle_id,
      'evidence_bundle_id',
    );

    const changeSpec = (await ctx.store.get(
      'piorx/change-spec@1',
      synthesisId,
    )) as ChangeSpecV1 | null;
    if (!changeSpec) {
      throw new Error(
        `execution stage: synthesis_id "${synthesisId}" did not resolve to a piorx/change-spec@1 artifact`,
      );
    }

    const result = await executionDispatch(
      {
        change_spec_id: synthesisId,
        evidence_bundle_id: evidenceBundleId,
        execution_constraints: {
          allow_edits: true,
          run_validation: true,
        },
      },
      ctx.store,
    );
    if (result.status !== 'success' || !result.execution_report_id) {
      throw new Error(`execution stage: dispatch failed — ${result.message}`);
    }
    return { output_artifact_id: result.execution_report_id };
  },
};

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * The six default-workflow Stage adapters in registration order. Exported so
 * tests and the executor can iterate them, and so the registration helper
 * has a single source of truth.
 */
export const DEFAULT_STAGE_ADAPTERS: readonly Stage[] = [
  restatementStage,
  expansionStage,
  retrievalStage,
  evidenceStage,
  synthesisStage,
  executionStage,
];

/**
 * Register every default-workflow Stage adapter against the given registry.
 *
 * Per `docs/composability.md` "Phase 1 — Scaffolding", the default piorx
 * extension self-registers the six default Stages. Phase 5 introduces a
 * filesystem-discovered third-party path; this helper is the canonical
 * Phase 1 registration call.
 */
export function registerDefaultStages(registry: WorkflowRegistry): void {
  for (const stage of DEFAULT_STAGE_ADAPTERS) {
    registry.registerStage(stage);
  }
}
