/**
 * WorkflowExecutor tests (COMP-P1-T13 acceptance).
 *
 * Covers the seams the executor stands up in `src/runtime/workflow-executor.ts`:
 *
 *   - Default-spec validation: the shipped `piorx-default.workflow.md`
 *     loads and validates as `piorx/workflow-spec@1`.
 *   - Edge resolution: linear edges fire in declaration order; the executor
 *     walks the workflow's edge list end-to-end.
 *   - Conditional-edge firing on synthesis output type: an `eq` predicate
 *     keyed on `$.synth.artifact_type` routes a `change-spec` output to a
 *     downstream stage and ends the workflow on `analysis-report`.
 *   - Predicate operators: both `eq` and `neq` evaluate as documented.
 *   - Gate ordering: registered gates fire after the stage in registration
 *     order; the executor's lineage records each gate decision.
 *   - Gate outcome routing: `rejected_governance` and `rejected_technical`
 *     each throw a `WorkflowExecutorError` with the gate's reason and the
 *     four-way outcome attached.
 *   - Default broker auto-accepts: a workflow with declared gates but no
 *     custom broker still completes happily.
 *   - Lineage: entries carry `stage_id`, `workflow_spec_id`, and `role`.
 *   - Evidence override path: `evidence.review.applyOverride` wraps the
 *     existing `applyEvidenceOverrides` batch logic, producing a byte-
 *     identical evidence plan modulo the fresh `artifact_id`.
 *   - Registry boot-time drift detection: when a Stage's input/output
 *     disagrees with the workflow spec, `registry.validate()` surfaces the
 *     violation (the Phase 1 conformance contract).
 *   - Recursive promotion: `executor.run(workflowId, { startStageId })` re-
 *     enters the workflow at the spec's `recursive_promotion_target` with
 *     no hard-coded stage references.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import { createConfig } from '../../src/runtime/config.ts';
import {
  createSessionState,
  type SessionState,
  type LineageRole,
} from '../../src/runtime/session-state.ts';
import { WorkflowRegistry } from '../../src/runtime/registry.ts';
import {
  WorkflowExecutor,
  WorkflowExecutorError,
  type GateBroker,
} from '../../src/runtime/workflow-executor.ts';
import { loadWorkflowFromFile } from '../../src/runtime/workflow-loader.ts';
import type { Stage, StageContext, StageModelCall, StageResult } from '../../src/runtime/stage.ts';
import type {
  GateOp,
  GateOpValidation,
  GateOutcome,
  GatePresentation,
  GateSpec,
} from '../../src/runtime/gate.ts';
import {
  applyEvidenceOverrides,
  evidenceReviewGate,
  type EvidenceOverride,
} from '../../src/conductor/evidence-overrides.ts';
import {
  DEFAULT_STAGE_ADAPTERS,
  registerDefaultStages,
} from '../../src/conductor/stage-adapters.ts';
import type {
  AnalysisReportV1,
  ChangeSpecV1,
  EvidencePlanV1,
  ExecutionReportV1,
  IntentCaptureV1,
  IntentRestatementV1,
  RecommendedEvidenceFile,
  RetrievalFile,
  RetrievalIndexV1,
  WorkflowSpecV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_PATH = resolve(
  import.meta.dir,
  '../../src/runtime/workflows/piorx-default.workflow.md',
);

const NULL_MODEL: StageModelCall = async () => '';

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'piorx-exec-test-'));
  store = new ArtifactStore(createConfig(tmpDir));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function freshSession(): SessionState {
  return createSessionState();
}

// ---------------------------------------------------------------------------
// Synthetic Stage builders — produce real artifacts so the store accepts them
// ---------------------------------------------------------------------------

function captureStage(): Stage {
  return {
    id: 'capture',
    inputs: [],
    output: 'piorx/intent-capture@1',
    async run(ctx: StageContext): Promise<StageResult> {
      const id = generateArtifactId('piorx/intent-capture@1');
      const artifact: IntentCaptureV1 = {
        artifact_type: 'piorx/intent-capture@1',
        artifact_id: id,
        user_intent_verbatim: 'verbatim test',
        cleaned_user_intent: 'cleaned test',
        tagged_files: [],
        timestamp: '2026-05-08T00:00:00Z',
      };
      await ctx.store.put(artifact);
      return { output_artifact_id: id };
    },
  };
}

function restateStage(opts: { expandRequested?: boolean } = {}): Stage {
  return {
    id: 'restate',
    inputs: ['piorx/intent-capture@1'],
    output: 'piorx/intent-restatement@1',
    async run(ctx: StageContext): Promise<StageResult> {
      const captureId = ctx.session.artifacts.intent_capture_id ?? 'cap';
      const id = generateArtifactId('piorx/intent-restatement@1');
      const artifact: IntentRestatementV1 = {
        artifact_type: 'piorx/intent-restatement@1',
        artifact_id: id,
        intent_capture_id: captureId,
        user_intent_verbatim: 'verbatim',
        restated_intent: 'restated',
        approved: true,
        expand_requested: opts.expandRequested ?? false,
        approval_turns: 1,
      };
      await ctx.store.put(artifact);
      return { output_artifact_id: id };
    },
  };
}

function synthStage(produces: 'analysis-report' | 'change-spec'): Stage {
  return {
    id: 'synth',
    inputs: ['piorx/intent-restatement@1'],
    output: 'piorx/analysis-report@1 | piorx/change-spec@1',
    async run(ctx: StageContext): Promise<StageResult> {
      if (produces === 'analysis-report') {
        const id = generateArtifactId('piorx/analysis-report@1');
        const artifact: AnalysisReportV1 = {
          artifact_type: 'piorx/analysis-report@1',
          artifact_id: id,
          evidence_bundle_id: 'bundle',
          summary: 'analysis',
          findings: ['finding'],
          risks: [],
          recommended_next_steps: [],
        };
        await ctx.store.put(artifact);
        return { output_artifact_id: id };
      }
      const id = generateArtifactId('piorx/change-spec@1');
      const artifact: ChangeSpecV1 = {
        artifact_type: 'piorx/change-spec@1',
        artifact_id: id,
        evidence_bundle_id: 'bundle',
        change_goal: 'goal',
        summary: 'change',
        edits: [],
        tests: [],
        acceptance_criteria: [],
      };
      await ctx.store.put(artifact);
      return { output_artifact_id: id };
    },
  };
}

function executeStage(): Stage {
  return {
    id: 'execute',
    inputs: ['piorx/change-spec@1'],
    output: 'piorx/execution-report@1',
    async run(ctx: StageContext): Promise<StageResult> {
      const synthId = ctx.session.artifacts.synthesis_id ?? 'spec';
      const id = generateArtifactId('piorx/execution-report@1');
      const artifact: ExecutionReportV1 = {
        artifact_type: 'piorx/execution-report@1',
        artifact_id: id,
        change_spec_id: synthId,
        status: 'completed',
        modified_files: [],
        validation: { commands: [], passed: true },
        notes: [],
      };
      await ctx.store.put(artifact);
      return { output_artifact_id: id };
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic workflow specs — exercise edges + gates without booting the
// default workflow's six heavy adapters.
// ---------------------------------------------------------------------------

function buildSpec(overrides: Partial<WorkflowSpecV1> = {}): WorkflowSpecV1 {
  const base: WorkflowSpecV1 = {
    artifact_type: 'piorx/workflow-spec@1',
    artifact_id: generateArtifactId('piorx/workflow-spec@1'),
    id: 'test/workflow/exec@1',
    name: 'Test workflow',
    description: 'synthetic workflow for executor tests',
    goals: ['exercise executor'],
    operating_mode: 'supervised-change',
    mandatory_controls: [],
    stages: [
      {
        id: 'capture',
        name: 'Capture',
        description: 'capture intent',
        inputs: [],
        output: 'piorx/intent-capture@1',
        model_class: 'noop',
      },
      {
        id: 'restate',
        name: 'Restate',
        description: 'restate intent',
        inputs: ['piorx/intent-capture@1'],
        output: 'piorx/intent-restatement@1',
        model_class: 'noop',
      },
      {
        id: 'synth',
        name: 'Synth',
        description: 'produce analysis or change',
        inputs: ['piorx/intent-restatement@1'],
        output: 'piorx/analysis-report@1 | piorx/change-spec@1',
        model_class: 'noop',
      },
      {
        id: 'execute',
        name: 'Execute',
        description: 'apply change',
        inputs: ['piorx/change-spec@1'],
        output: 'piorx/execution-report@1',
        model_class: 'noop',
      },
    ],
    edges: [
      { from: 'capture', to: 'restate', description: 'unconditional' },
      { from: 'restate', to: 'synth', description: 'unconditional' },
      {
        from: 'synth',
        to: 'execute',
        description: 'only when synthesis emits a change-spec',
        when: { eq: ['$.synth.artifact_type', 'piorx/change-spec@1'] },
      },
    ],
    recursive_promotion_target: 'capture',
  };
  return { ...base, ...overrides };
}

function buildExecutor(args: {
  registry: WorkflowRegistry;
  session?: SessionState;
  gateBroker?: GateBroker;
  role?: LineageRole;
}): { executor: WorkflowExecutor; session: SessionState } {
  const session = args.session ?? freshSession();
  const executor = new WorkflowExecutor({
    registry: args.registry,
    store,
    session,
    model: NULL_MODEL,
    ...(args.gateBroker ? { gateBroker: args.gateBroker } : {}),
    ...(args.role ? { role: args.role } : {}),
  });
  return { executor, session };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowExecutor — default-spec validation', () => {
  test('default workflow loads and validates as piorx/workflow-spec@1', () => {
    const spec = loadWorkflowFromFile(DEFAULT_WORKFLOW_PATH);
    expect(spec.artifact_type).toBe('piorx/workflow-spec@1');
    expect(spec.id).toBe('piorx/workflow/default@1');
    const registry = new WorkflowRegistry();
    expect(() => registry.registerWorkflow(spec)).not.toThrow();
    registerDefaultStages(registry);
    for (const adapter of DEFAULT_STAGE_ADAPTERS) {
      expect(registry.resolveStage(adapter.id)).toBe(adapter);
    }
  });
});

describe('WorkflowExecutor — edges and stage walk', () => {
  test('walks the linear edge list end-to-end and records every stage', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    registry.registerStage(synthStage('analysis-report'));
    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/workflow/exec@1');

    expect(result.stage_runs.map((r) => r.stage_id)).toEqual(['capture', 'restate', 'synth']);
    expect(result.final_stage_id).toBe('synth');
    expect(result.final_artifact_type).toBe('piorx/analysis-report@1');
  });

  test('conditional edge fires on synthesis output type=change-spec → execute runs', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    registry.registerStage(synthStage('change-spec'));
    registry.registerStage(executeStage());
    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/workflow/exec@1');

    expect(result.stage_runs.map((r) => r.stage_id)).toEqual([
      'capture',
      'restate',
      'synth',
      'execute',
    ]);
    expect(result.final_stage_id).toBe('execute');
    expect(result.final_artifact_type).toBe('piorx/execution-report@1');
  });

  test('conditional edge does not fire on synthesis output type=analysis-report → workflow ends', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    registry.registerStage(synthStage('analysis-report'));
    // Register execute stage too — it should not be invoked because the
    // conditional edge does not fire.
    registry.registerStage(executeStage());
    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/workflow/exec@1');

    expect(result.stage_runs.map((r) => r.stage_id)).toEqual(['capture', 'restate', 'synth']);
    expect(result.final_stage_id).toBe('synth');
  });

  test('neq predicate routes when values differ', async () => {
    const spec = buildSpec({
      edges: [
        { from: 'capture', to: 'restate', description: 'unconditional' },
        {
          from: 'restate',
          to: 'synth',
          description: 'only when restatement is approved',
          when: { neq: ['$.restate.approved', false] },
        },
      ],
      stages: buildSpec().stages.slice(0, 3), // capture + restate + synth only
    });
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(spec);
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    registry.registerStage(synthStage('analysis-report'));
    const { executor } = buildExecutor({ registry });
    const result = await executor.run(spec.id);
    expect(result.stage_runs.map((r) => r.stage_id)).toEqual(['capture', 'restate', 'synth']);
  });
});

describe('WorkflowExecutor — error surfaces', () => {
  test('throws when no Stage adapter is registered for a declared stage', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    // restate adapter intentionally not registered.
    const { executor } = buildExecutor({ registry });
    await expect(executor.run('test/workflow/exec@1')).rejects.toBeInstanceOf(
      WorkflowExecutorError,
    );
  });

  test('throws when startStageId does not match any declared stage', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    const { executor } = buildExecutor({ registry });
    await expect(
      executor.run('test/workflow/exec@1', { startStageId: 'no-such-stage' }),
    ).rejects.toThrow(/startStageId/);
  });
});

describe('WorkflowExecutor — gates', () => {
  function makeRecordingGate(id: string, sink: string[]): GateSpec {
    return {
      id,
      async presents(): Promise<GatePresentation> {
        return { summary: `${id} review` };
      },
      validateOverride(_op: GateOp): GateOpValidation {
        return { valid: true, errors: [] };
      },
      async applyOverride(): Promise<void> {
        sink.push(id);
      },
    };
  }

  test('gates fire after the stage in registration order; lineage records each decision', async () => {
    const order: string[] = [];
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(
      buildSpec({
        stages: [
          {
            id: 'capture',
            name: 'Capture',
            description: 'capture',
            inputs: [],
            output: 'piorx/intent-capture@1',
            model_class: 'noop',
            gates: ['gate.first', 'gate.second'],
          },
        ],
        edges: [],
      }),
    );
    registry.registerStage(captureStage());
    registry.registerGate('capture', makeRecordingGate('gate.first', order));
    registry.registerGate('capture', makeRecordingGate('gate.second', order));

    const broker: GateBroker = async (gate, ctx) => {
      await gate.applyOverride({ op: 'noop' } as GateOp, ctx);
      return { kind: 'accepted', applied: [{ op: 'noop' } as GateOp] };
    };
    const { executor } = buildExecutor({ registry, gateBroker: broker });
    await executor.run('test/workflow/exec@1');

    expect(order).toEqual(['gate.first', 'gate.second']);
    const captureLineage = executor.sessionState.lineage.find((l) => l.stage_id === 'capture');
    expect(captureLineage?.gate_decisions?.map((d) => d.gate_id)).toEqual([
      'gate.first',
      'gate.second',
    ]);
    expect(captureLineage?.gate_decisions?.every((d) => d.kind === 'accepted')).toBe(true);
  });

  test('rejected_governance outcome surfaces a WorkflowExecutorError with the gate reason and outcome', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(
      buildSpec({
        stages: [
          {
            id: 'capture',
            name: 'Capture',
            description: 'capture',
            inputs: [],
            output: 'piorx/intent-capture@1',
            model_class: 'noop',
            gates: ['policy.gate'],
          },
        ],
        edges: [],
      }),
    );
    registry.registerStage(captureStage());
    registry.registerGate('capture', {
      id: 'policy.gate',
      async presents(): Promise<GatePresentation> {
        return { summary: 'policy gate' };
      },
      validateOverride(): GateOpValidation {
        return { valid: true, errors: [] };
      },
      async applyOverride(): Promise<void> {},
    });

    const broker: GateBroker = async () => ({
      kind: 'rejected_governance',
      reason: 'policy violated',
    });
    const { executor } = buildExecutor({ registry, gateBroker: broker });
    let caught: WorkflowExecutorError | undefined;
    try {
      await executor.run('test/workflow/exec@1');
    } catch (err) {
      caught = err as WorkflowExecutorError;
    }
    expect(caught).toBeInstanceOf(WorkflowExecutorError);
    expect(caught?.message).toContain('policy violated');
    expect(caught?.outcome?.kind).toBe('rejected_governance');
  });

  test('rejected_technical outcome surfaces a distinct routing label', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(
      buildSpec({
        stages: [
          {
            id: 'capture',
            name: 'Capture',
            description: 'capture',
            inputs: [],
            output: 'piorx/intent-capture@1',
            model_class: 'noop',
            gates: ['parser.gate'],
          },
        ],
        edges: [],
      }),
    );
    registry.registerStage(captureStage());
    registry.registerGate('capture', {
      id: 'parser.gate',
      async presents(): Promise<GatePresentation> {
        return { summary: 'parser gate' };
      },
      validateOverride(): GateOpValidation {
        return { valid: true, errors: [] };
      },
      async applyOverride(): Promise<void> {},
    });
    const broker: GateBroker = async () => ({
      kind: 'rejected_technical',
      reason: 'parse failure',
    });
    const { executor } = buildExecutor({ registry, gateBroker: broker });
    let caught: WorkflowExecutorError | undefined;
    try {
      await executor.run('test/workflow/exec@1');
    } catch (err) {
      caught = err as WorkflowExecutorError;
    }
    expect(caught?.outcome?.kind).toBe('rejected_technical');
    expect(caught?.message).toContain('parse failure');
  });

  test('default broker auto-accepts so a workflow with declared gates still completes', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(
      buildSpec({
        stages: [
          {
            id: 'capture',
            name: 'Capture',
            description: 'capture',
            inputs: [],
            output: 'piorx/intent-capture@1',
            model_class: 'noop',
            gates: ['ambient.gate'],
          },
        ],
        edges: [],
      }),
    );
    registry.registerStage(captureStage());
    registry.registerGate('capture', {
      id: 'ambient.gate',
      async presents(): Promise<GatePresentation> {
        return { summary: 'ambient' };
      },
      validateOverride(): GateOpValidation {
        return { valid: true, errors: [] };
      },
      async applyOverride(): Promise<void> {},
    });
    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/workflow/exec@1');
    expect(result.final_stage_id).toBe('capture');
    const lineage = executor.sessionState.lineage.find((l) => l.stage_id === 'capture');
    // Default broker auto-accepts — but the gate is declared, so the
    // executor still records its decision in lineage.
    expect(lineage?.gate_decisions?.[0]?.kind).toBe('accepted');
  });
});

describe('WorkflowExecutor — lineage', () => {
  test('lineage entries carry stage_id, workflow_spec_id, and role', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    registry.registerStage(synthStage('analysis-report'));
    const { executor } = buildExecutor({ registry, role: 'reviewer' });
    await executor.run('test/workflow/exec@1');

    const lineage = executor.sessionState.lineage;
    expect(lineage.length).toBe(3);
    for (const entry of lineage) {
      expect(entry.workflow_spec_id).toBe('test/workflow/exec@1');
      expect(entry.role).toBe('reviewer');
      expect(typeof entry.stage_id).toBe('string');
    }
    expect(lineage.map((e) => e.stage_id)).toEqual(['capture', 'restate', 'synth']);
  });
});

describe('WorkflowExecutor — recursive promotion', () => {
  test('startStageId honors the spec recursive_promotion_target without hard-coded stage ids', async () => {
    const spec = buildSpec({
      // Promote target = `restate` so a recursive entry skips `capture`.
      recursive_promotion_target: 'restate',
    });
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(spec);
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    registry.registerStage(synthStage('analysis-report'));

    // First run: pre-populate the intent-capture pointer so `restate` finds it.
    const { executor: bootstrap } = buildExecutor({ registry });
    await bootstrap.run(spec.id);

    // Second run: recursive promotion enters at the spec's target. Carry
    // the bootstrap's mutated session (intent-capture pointer is set) but
    // clear lineage so the new run's entries are easy to inspect.
    const recursiveSession = { ...bootstrap.sessionState, lineage: [] };
    const recursive = new WorkflowExecutor({
      registry,
      store,
      session: recursiveSession,
      model: NULL_MODEL,
    });
    const result = await recursive.run(spec.id, {
      startStageId: spec.recursive_promotion_target,
    });
    expect(result.stage_runs[0]?.stage_id).toBe('restate');
    // Workflow proceeds through synth (analysis-report ends the workflow).
    expect(result.final_stage_id).toBe('synth');
  });
});

describe('WorkflowExecutor — evidence override path produces byte-identical bundles', () => {
  function buildRetrievalIndex(): RetrievalIndexV1 {
    const file: RetrievalFile = {
      file_id: 'file-1',
      path: 'src/foo.ts',
      why_relevant: 'core logic',
      file_summary: 'foo',
      ast_skeleton: [],
      recommended_expansion: 'spans',
      expansion_reason: 'core',
      selection_tier: 'reserve',
      selection_reason: 'reserve candidate',
      default_evidence_mode: 'summary',
      symbols: [
        {
          symbol_id: 'sym-1',
          kind: 'function',
          name: 'doIt',
          start: 1,
          count: 5,
          summary: 'does it',
          role_in_system: 'core',
          depends_on: [],
          used_by: [],
          relevance: 'high',
          change_likelihood: 'low',
          expansion_priority: 'high',
          recommended_expansion: 'span',
          expansion_reason: 'core',
          selected_by_default: true,
          default_neighbor_lines: 2,
          selection_reason: 'core',
        },
      ],
    };
    const recFile: RecommendedEvidenceFile = {
      file_id: 'file-1',
      include_ast_skeleton: false,
      include_retriever_summary: true,
      include_entire_file: false,
      spans: [{ symbol_id: 'sym-1', include_span: true, neighbor_lines: 2 }],
    };
    return {
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: generateArtifactId('piorx/retrieval-index@1'),
      intent_capture_id: 'cap',
      intent_restatement_id: 'restate',
      intent_spec_id: null,
      query: 'do it',
      confidence: 'high',
      strategy_summary: 'narrow',
      scout_terms: ['doIt'],
      files: [file],
      cross_file_findings: [],
      gaps: [],
      followup_queries: [],
      recommended_evidence: {
        files: [recFile],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    };
  }

  function buildPlan(indexId: string): EvidencePlanV1 {
    return {
      artifact_type: 'piorx/evidence-plan@1',
      artifact_id: generateArtifactId('piorx/evidence-plan@1'),
      retrieval_index: {
        artifact_type: 'piorx/retrieval-index@1',
        artifact_id: indexId,
      },
      selection: {
        files: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
      assembly_options: {
        max_total_lines: 1000,
        max_estimated_tokens: 2000,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'union',
      },
      prompt_sections: {
        include_intent_context: true,
        include_structural_context: true,
        include_raw_evidence: true,
      },
      target_task: { type: 'analysis', task_label: 'analyze' },
    };
  }

  test('evidence.review.applyOverride wraps the existing batch logic per-op (byte-identical plan modulo artifact_id)', async () => {
    const index = buildRetrievalIndex();
    await store.put(index);
    const plan = buildPlan(index.artifact_id);
    await store.put(plan);

    // Reference: apply through the existing batch helper directly.
    const referenceResult = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'file-1', mode: 'spans' }],
    });

    // Through the gate: build a session pointing at the plan + index, then
    // run `evidenceReviewGate.applyOverride` which should produce a fresh
    // plan with the same selection/options shape.
    const session = freshSession();
    session.artifacts.evidence_plan_id = plan.artifact_id;
    session.artifacts.retrieval_index_id = index.artifact_id;

    const stageCtx: StageContext = {
      store,
      session,
      appendLineage: () => {},
      model: NULL_MODEL,
    };
    const op: EvidenceOverride = { op: 'promote_file', file_id: 'file-1', mode: 'spans' };
    const validation = evidenceReviewGate.validateOverride(op, stageCtx);
    expect(validation.valid).toBe(true);
    await evidenceReviewGate.applyOverride(op, stageCtx);

    // Find the gate-applied plan in the store (newest after the seed plan).
    const allPlans = await store.listByType('piorx/evidence-plan@1');
    const gatePlan = allPlans.find((p) => p.artifact_id !== plan.artifact_id);
    expect(gatePlan).toBeDefined();
    if (!gatePlan) return;

    // Compare the load-bearing plan body (everything except `artifact_id`,
    // which is intentionally fresh).
    const stripIds = (p: EvidencePlanV1): Omit<EvidencePlanV1, 'artifact_id'> => {
      const { artifact_id: _id, ...rest } = p;
      void _id;
      return rest;
    };
    expect(stripIds(gatePlan)).toEqual(stripIds(referenceResult.plan));
  });
});

describe('WorkflowExecutor — registry boot-time drift detection', () => {
  test('registry.validate() rejects a Stage whose output disagrees with the spec', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    // Drifted synth: declares a single output instead of the union the spec
    // asks for. Registry's referential pass surfaces the violation.
    const drifted: Stage = {
      id: 'synth',
      inputs: ['piorx/intent-restatement@1'],
      output: 'piorx/analysis-report@1',
      async run(): Promise<StageResult> {
        return { output_artifact_id: 'noop' };
      },
    };
    registry.registerStage(drifted);
    expect(() => registry.validate()).toThrow(/synth/);
  });

  test('registry.validate() rejects a Stage whose declared inputs disagree with the spec', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    const driftedRestate: Stage = {
      id: 'restate',
      // Spec declares ['piorx/intent-capture@1']; this drops the input.
      inputs: [],
      output: 'piorx/intent-restatement@1',
      async run(): Promise<StageResult> {
        return { output_artifact_id: 'noop' };
      },
    };
    registry.registerStage(driftedRestate);
    registry.registerStage(synthStage('analysis-report'));
    expect(() => registry.validate()).toThrow(/restate/);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — sub-workflow descent + __exit__
// ---------------------------------------------------------------------------

describe('WorkflowExecutor — sub-workflow descent (workflow_ref + inline workflow:)', () => {
  /**
   * Build a host spec whose sole stage delegates to a sub-workflow. The
   * `attach` function configures whether the parent stage carries
   * `workflow_ref` or an inline `workflow:` body, plus optional gates on
   * either the parent stage or the sub-stage. Parent gates run after the
   * sub-workflow returns; sub-workflow gates run during descent.
   */
  function buildHostSpecWithSubWorkflow(args: {
    parentGates?: string[];
    subGates?: string[];
    workflowRef?: string;
    inline?: boolean;
  }): WorkflowSpecV1 {
    const subBody = {
      id: 'test/sub-workflow@1',
      name: 'Sub-workflow',
      description: 'inline sub-workflow used by the host stage',
      goals: ['exercise sub-workflow descent'],
      operating_mode: 'supervised-change' as const,
      mandatory_controls: [],
      stages: [
        {
          id: 'inner-capture',
          name: 'Inner Capture',
          description: 'capture inside sub',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
          ...(args.subGates ? { gates: args.subGates } : {}),
        },
      ],
      edges: [],
      recursive_promotion_target: 'inner-capture',
    };
    return {
      artifact_type: 'piorx/workflow-spec@1',
      artifact_id: generateArtifactId('piorx/workflow-spec@1'),
      id: 'test/host-with-sub@1',
      name: 'Host with sub-workflow',
      description: 'host workflow whose stage delegates to a sub-workflow',
      goals: ['delegate to sub-workflow'],
      operating_mode: 'supervised-change',
      mandatory_controls: [],
      stages: [
        {
          id: 'wrap',
          name: 'Wrap',
          description: 'wraps a sub-workflow',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
          ...(args.parentGates ? { gates: args.parentGates } : {}),
          ...(args.workflowRef
            ? { workflow_ref: args.workflowRef }
            : args.inline
              ? { workflow: subBody }
              : {}),
        },
      ],
      edges: [],
      recursive_promotion_target: 'wrap',
    };
  }

  test('inline workflow: descends and surfaces the sub-workflow final artifact as the parent stage output', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildHostSpecWithSubWorkflow({ inline: true }));
    // Inner Stage adapter — the sub-workflow's only stage produces the
    // intent-capture artifact that bubbles up as the host stage's output.
    registry.registerStage({ ...captureStage(), id: 'inner-capture' });

    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/host-with-sub@1');

    expect(result.stage_runs.map((r) => r.stage_id)).toEqual(['wrap']);
    expect(result.final_stage_id).toBe('wrap');
    expect(result.final_artifact_type).toBe('piorx/intent-capture@1');
    // Lineage records the parent stage entry at the top level, with the
    // sub-workflow's stage entry nested under `sub_lineage` so an audit
    // walker can reconstruct the parent/child hierarchy (COMP-P7-T3).
    const lineage = executor.sessionState.lineage;
    expect(lineage.map((e) => e.stage_id)).toEqual(['wrap']);
    const parentEntry = lineage[0];
    expect(parentEntry?.workflow_spec_id).toBe('test/host-with-sub@1');
    const subEntry = parentEntry?.sub_lineage?.find((e) => e.stage_id === 'inner-capture');
    expect(subEntry?.workflow_spec_id).toBe('test/sub-workflow@1');
  });

  test('workflow_ref descends through the registry and produces the same final artifact', async () => {
    const registry = new WorkflowRegistry();
    // Register the referenced sub-workflow as a top-level workflow first so
    // workflow_ref resolves through the registry.
    const subSpec: WorkflowSpecV1 = {
      artifact_type: 'piorx/workflow-spec@1',
      artifact_id: generateArtifactId('piorx/workflow-spec@1'),
      id: 'test/sub-workflow@1',
      name: 'Registered sub-workflow',
      description: 'registered sub-workflow used through workflow_ref',
      goals: ['exercise workflow_ref descent'],
      operating_mode: 'supervised-change',
      mandatory_controls: [],
      stages: [
        {
          id: 'inner-capture',
          name: 'Inner Capture',
          description: 'capture inside referenced sub',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
        },
      ],
      edges: [],
      recursive_promotion_target: 'inner-capture',
    };
    registry.registerWorkflow(subSpec);
    registry.registerWorkflow(buildHostSpecWithSubWorkflow({ workflowRef: 'test/sub-workflow@1' }));
    registry.registerStage({ ...captureStage(), id: 'inner-capture' });

    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/host-with-sub@1');
    expect(result.final_stage_id).toBe('wrap');
    expect(result.final_artifact_type).toBe('piorx/intent-capture@1');
    const lineage = executor.sessionState.lineage;
    expect(lineage.map((e) => e.stage_id)).toEqual(['wrap']);
    const parentEntry = lineage[0];
    expect(parentEntry?.workflow_spec_id).toBe('test/host-with-sub@1');
    const subEntry = parentEntry?.sub_lineage?.find((e) => e.stage_id === 'inner-capture');
    expect(subEntry?.workflow_spec_id).toBe('test/sub-workflow@1');
  });

  test('sub-workflow gates run during descent; parent gates run after the sub-workflow returns', async () => {
    const order: string[] = [];
    function makeGate(id: string): GateSpec {
      return {
        id,
        async presents(): Promise<GatePresentation> {
          return { summary: `${id} review` };
        },
        validateOverride(): GateOpValidation {
          return { valid: true, errors: [] };
        },
        async applyOverride(): Promise<void> {},
      };
    }
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(
      buildHostSpecWithSubWorkflow({
        parentGates: ['parent.gate'],
        subGates: ['sub.gate'],
        inline: true,
      }),
    );
    registry.registerStage({ ...captureStage(), id: 'inner-capture' });
    registry.registerGate('inner-capture', makeGate('sub.gate'));
    registry.registerGate('wrap', makeGate('parent.gate'));

    const broker: GateBroker = async (gate) => {
      order.push(gate.id);
      return { kind: 'accepted' };
    };
    const { executor } = buildExecutor({ registry, gateBroker: broker });
    await executor.run('test/host-with-sub@1');
    expect(order).toEqual(['sub.gate', 'parent.gate']);
  });

  test('registry.validate() does not require a Stage implementation for stages declaring a sub-workflow', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildHostSpecWithSubWorkflow({ inline: true }));
    // Register the sub-stage adapter only. The parent `wrap` stage has NO
    // adapter — descent into the inline workflow takes the place of
    // `Stage.run()`, so the registry should not flag the missing impl.
    registry.registerStage({ ...captureStage(), id: 'inner-capture' });
    expect(() => registry.validate()).not.toThrow();
  });

  test('registry.validate() still flags missing impls for non-sub-workflow stages', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildSpec());
    registry.registerStage(captureStage());
    // Restate, synth adapters intentionally omitted — validate should
    // surface "no Stage implementation registered" for them.
    expect(() => registry.validate()).toThrow(/no Stage implementation registered/);
  });
});

describe('WorkflowExecutor — __exit__ virtual edge target', () => {
  test('an edge with to: __exit__ ends the workflow at the originating stage', async () => {
    const spec = buildSpec({
      stages: [
        {
          id: 'capture',
          name: 'Capture',
          description: 'capture',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
        },
        {
          id: 'restate',
          name: 'Restate',
          description: 'restate',
          inputs: ['piorx/intent-capture@1'],
          output: 'piorx/intent-restatement@1',
          model_class: 'noop',
        },
        {
          id: 'synth',
          name: 'Synth',
          description: 'never reached',
          inputs: ['piorx/intent-restatement@1'],
          output: 'piorx/analysis-report@1 | piorx/change-spec@1',
          model_class: 'noop',
        },
      ],
      edges: [
        { from: 'capture', to: 'restate', description: 'unconditional' },
        { from: 'restate', to: '__exit__', description: 'early-exit at restate' },
      ],
    });
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(spec);
    registry.registerStage(captureStage());
    registry.registerStage(restateStage());
    // Register synth too so a regression that ignores __exit__ would walk
    // into it instead of stopping cleanly.
    registry.registerStage(synthStage('analysis-report'));

    const { executor } = buildExecutor({ registry });
    const result = await executor.run(spec.id);
    expect(result.stage_runs.map((r) => r.stage_id)).toEqual(['capture', 'restate']);
    // The originating stage's output is the workflow's final artifact.
    expect(result.final_stage_id).toBe('restate');
    expect(result.final_artifact_type).toBe('piorx/intent-restatement@1');
  });
});

// ---------------------------------------------------------------------------
// COMP-P7-T3 — sub-workflow stage-id namespacing + lineage sub-tree
// ---------------------------------------------------------------------------

describe('WorkflowExecutor — sub-workflow stage-id namespacing (COMP-P7-T3)', () => {
  /**
   * Build a host spec where the parent stage `capture` has a sub-workflow
   * whose only stage is also called `capture`. Without namespacing, the
   * sub-workflow's `capture` would resolve to the top-level `captureStage`
   * adapter — the test below proves the registry resolves it under the
   * namespaced id `capture.capture` and uses the dedicated sub adapter.
   */
  function buildCollidingSpec(): WorkflowSpecV1 {
    const subBody = {
      id: 'test/colliding-sub@1',
      name: 'Colliding Sub',
      description: 'sub-workflow whose stage id collides with the parent',
      goals: ['exercise collision avoidance'],
      operating_mode: 'supervised-change' as const,
      mandatory_controls: [],
      stages: [
        {
          id: 'capture',
          name: 'Inner capture',
          description: 'sub-stage whose id collides with the parent',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
        },
      ],
      edges: [],
      recursive_promotion_target: 'capture',
    };
    return {
      artifact_type: 'piorx/workflow-spec@1',
      artifact_id: generateArtifactId('piorx/workflow-spec@1'),
      id: 'test/colliding-host@1',
      name: 'Colliding host',
      description: 'parent whose stage id collides with the sub-workflow stage id',
      goals: ['exercise collision avoidance'],
      operating_mode: 'supervised-change',
      mandatory_controls: [],
      stages: [
        {
          id: 'capture',
          name: 'Outer capture',
          description: 'parent stage that descends into a sub-workflow',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
          workflow: subBody,
        },
      ],
      edges: [],
      recursive_promotion_target: 'capture',
    };
  }

  test('sub-workflow stages register under namespaced ids without colliding with parent stages', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildCollidingSpec());

    // Two distinct adapters with the SAME logical id but different roles.
    // The sub adapter is registered under the namespaced id `capture.capture`.
    let topLevelInvocations = 0;
    let subWorkflowInvocations = 0;
    const topAdapter: Stage = {
      ...captureStage(),
      id: 'capture',
      async run(ctx: StageContext): Promise<StageResult> {
        topLevelInvocations += 1;
        return captureStage().run(ctx);
      },
    };
    const subAdapter: Stage = {
      ...captureStage(),
      id: 'capture.capture',
      async run(ctx: StageContext): Promise<StageResult> {
        subWorkflowInvocations += 1;
        return captureStage().run(ctx);
      },
    };
    registry.registerStage(topAdapter);
    registry.registerStage(subAdapter);

    const { executor } = buildExecutor({ registry });
    await executor.run('test/colliding-host@1');

    // The PARENT stage descends into the sub-workflow (it does NOT call its
    // own Stage.run); only the sub adapter should fire under the namespaced id.
    expect(topLevelInvocations).toBe(0);
    expect(subWorkflowInvocations).toBe(1);
    // The registry resolves both ids independently.
    expect(registry.resolveStage('capture')).toBe(topAdapter);
    expect(registry.resolveStage('capture', 'capture')).toBe(subAdapter);
  });

  test('namespaced lookup falls back to bare id when no namespaced adapter is registered', () => {
    const registry = new WorkflowRegistry();
    const adapter = captureStage();
    registry.registerStage(adapter);
    // No `capture.capture` adapter registered; lookup falls back to bare.
    expect(registry.resolveStage('capture', 'capture')).toBe(adapter);
  });

  test('audit walker can reconstruct the parent/child workflow hierarchy from lineage alone', async () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(buildCollidingSpec());
    registry.registerStage({ ...captureStage(), id: 'capture' });
    registry.registerStage({ ...captureStage(), id: 'capture.capture' });
    const { executor } = buildExecutor({ registry });
    await executor.run('test/colliding-host@1');

    interface HierarchyNode {
      stage_id: string;
      workflow_spec_id: string | undefined;
      children: HierarchyNode[];
    }
    function walk(entries: readonly LineageEntryLike[]): HierarchyNode[] {
      return entries.map((entry) => ({
        stage_id: entry.stage_id ?? entry.stage,
        workflow_spec_id: entry.workflow_spec_id,
        children: entry.sub_lineage ? walk(entry.sub_lineage) : [],
      }));
    }

    const tree = walk(executor.sessionState.lineage);
    expect(tree).toEqual([
      {
        stage_id: 'capture',
        workflow_spec_id: 'test/colliding-host@1',
        children: [
          {
            stage_id: 'capture',
            workflow_spec_id: 'test/colliding-sub@1',
            children: [],
          },
        ],
      },
    ]);
  });
});

// Local mirror of LineageEntry-shaped fields used by the audit-walker test.
// Keeps the test independent of `import type`-only changes to the canonical
// LineageEntry while still exercising the sub_lineage tree shape.
interface LineageEntryLike {
  stage: string;
  stage_id?: string;
  workflow_spec_id?: string;
  sub_lineage?: LineageEntryLike[];
}

// ---------------------------------------------------------------------------
// COMP-P7-T4 — end-to-end coverage for sub-workflow execution
// ---------------------------------------------------------------------------

describe('WorkflowExecutor — sub-workflow E2E (COMP-P7-T4)', () => {
  function buildSubWorkflowSpec(args: {
    id: string;
    stages: WorkflowSpecV1['stages'];
    edges?: WorkflowSpecV1['edges'];
    recursive_promotion_target: string;
  }): WorkflowSpecV1 {
    return {
      artifact_type: 'piorx/workflow-spec@1',
      artifact_id: generateArtifactId('piorx/workflow-spec@1'),
      id: args.id,
      name: 'E2E sub-workflow',
      description: 'sub-workflow used by COMP-P7-T4 end-to-end coverage',
      goals: ['exercise sub-workflow descent end-to-end'],
      operating_mode: 'supervised-change',
      mandatory_controls: [],
      stages: args.stages,
      edges: args.edges ?? [],
      recursive_promotion_target: args.recursive_promotion_target,
    };
  }

  function buildHostSpec(args: {
    id: string;
    parentStage: { workflow_ref?: string; workflow?: WorkflowSpecV1 };
    output: string;
  }): WorkflowSpecV1 {
    return {
      artifact_type: 'piorx/workflow-spec@1',
      artifact_id: generateArtifactId('piorx/workflow-spec@1'),
      id: args.id,
      name: 'E2E host',
      description: 'host workflow used by COMP-P7-T4 end-to-end coverage',
      goals: ['delegate to sub-workflow'],
      operating_mode: 'supervised-change',
      mandatory_controls: [],
      stages: [
        {
          id: 'host',
          name: 'Host stage',
          description: 'parent stage that delegates to the sub-workflow',
          inputs: [],
          output: args.output,
          model_class: 'noop',
          ...(args.parentStage.workflow_ref ? { workflow_ref: args.parentStage.workflow_ref } : {}),
          ...(args.parentStage.workflow
            ? // Strip the artifact-base fields when embedding inline. The
              // executor's `materializeInlineSpec` re-attaches them.
              {
                workflow: {
                  id: args.parentStage.workflow.id,
                  name: args.parentStage.workflow.name,
                  description: args.parentStage.workflow.description,
                  goals: args.parentStage.workflow.goals,
                  operating_mode: args.parentStage.workflow.operating_mode,
                  mandatory_controls: args.parentStage.workflow.mandatory_controls,
                  stages: args.parentStage.workflow.stages,
                  edges: args.parentStage.workflow.edges,
                  recursive_promotion_target: args.parentStage.workflow.recursive_promotion_target,
                },
              }
            : {}),
        },
      ],
      edges: [],
      recursive_promotion_target: 'host',
    };
  }

  test('inline workflow: produces the sub-workflow final artifact end-to-end', async () => {
    const subSpec = buildSubWorkflowSpec({
      id: 'test/e2e-inline-sub@1',
      stages: [
        {
          id: 'inner',
          name: 'inner',
          description: 'inner stage',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
        },
      ],
      recursive_promotion_target: 'inner',
    });
    const hostSpec = buildHostSpec({
      id: 'test/e2e-inline-host@1',
      parentStage: { workflow: subSpec },
      output: 'piorx/intent-capture@1',
    });
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(hostSpec);
    registry.registerStage({ ...captureStage(), id: 'host.inner' });

    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/e2e-inline-host@1');
    expect(result.final_stage_id).toBe('host');
    expect(result.final_artifact_type).toBe('piorx/intent-capture@1');
    // The final artifact id is what the sub-workflow produced — the parent
    // stage simply surfaces it.
    const finalArtifact = await store.get('piorx/intent-capture@1', result.final_artifact_id);
    expect(finalArtifact?.artifact_id).toBe(result.final_artifact_id);
  });

  test('workflow_ref: produces identical behavior to inline descent', async () => {
    const subSpec = buildSubWorkflowSpec({
      id: 'test/e2e-ref-sub@1',
      stages: [
        {
          id: 'inner',
          name: 'inner',
          description: 'inner stage',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
        },
      ],
      recursive_promotion_target: 'inner',
    });
    const hostSpec = buildHostSpec({
      id: 'test/e2e-ref-host@1',
      parentStage: { workflow_ref: 'test/e2e-ref-sub@1' },
      output: 'piorx/intent-capture@1',
    });
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(subSpec);
    registry.registerWorkflow(hostSpec);
    // Bare-id Stage adapter — workflow_ref descent's namespaced lookup falls
    // back to the bare id when no `host.inner` adapter is registered, so a
    // registered top-level workflow can be referenced unchanged.
    registry.registerStage({ ...captureStage(), id: 'inner' });

    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/e2e-ref-host@1');
    expect(result.final_stage_id).toBe('host');
    expect(result.final_artifact_type).toBe('piorx/intent-capture@1');
  });

  test('__exit__ early-exit inside a sub-workflow surfaces the early-exit stage output as the final artifact', async () => {
    // Sub-workflow with two stages: `inner-a` produces an intent-capture and
    // immediately routes to __exit__, so `inner-b` is never reached. The
    // early-exit stage's output becomes the sub-workflow's final artifact,
    // which the parent stage then surfaces as its own output.
    const subSpec = buildSubWorkflowSpec({
      id: 'test/e2e-exit-sub@1',
      stages: [
        {
          id: 'inner-a',
          name: 'inner a',
          description: 'early-exit stage',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
        },
        {
          id: 'inner-b',
          name: 'inner b',
          description: 'never reached',
          inputs: ['piorx/intent-capture@1'],
          output: 'piorx/intent-restatement@1',
          model_class: 'noop',
        },
      ],
      edges: [{ from: 'inner-a', to: '__exit__', description: 'early-exit at inner-a' }],
      recursive_promotion_target: 'inner-a',
    });
    const hostSpec = buildHostSpec({
      id: 'test/e2e-exit-host@1',
      parentStage: { workflow: subSpec },
      output: 'piorx/intent-capture@1',
    });
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(hostSpec);
    registry.registerStage({ ...captureStage(), id: 'host.inner-a' });
    // Register `inner-b` adapter too so a regression that ignores __exit__
    // would walk into it (and likely fail when its restate adapter doesn't
    // align with the host stage's declared output type).
    registry.registerStage({
      ...restateStage(),
      id: 'host.inner-b',
    });

    const { executor } = buildExecutor({ registry });
    const result = await executor.run('test/e2e-exit-host@1');
    expect(result.final_stage_id).toBe('host');
    // Sub-workflow exits at inner-a, so the final artifact is intent-capture
    // (not intent-restatement). The parent stage surfaces it.
    expect(result.final_artifact_type).toBe('piorx/intent-capture@1');

    // sub_lineage records only `inner-a` — `inner-b` never ran.
    const lineage = executor.sessionState.lineage;
    expect(lineage.length).toBe(1);
    expect(lineage[0]?.sub_lineage?.map((e) => e.stage_id)).toEqual(['inner-a']);
  });

  test('lineage assertion: sub-workflow stage runs appear as a sub-tree of the parent stage entry', async () => {
    const subSpec = buildSubWorkflowSpec({
      id: 'test/e2e-tree-sub@1',
      stages: [
        {
          id: 'inner',
          name: 'inner',
          description: 'inner stage',
          inputs: [],
          output: 'piorx/intent-capture@1',
          model_class: 'noop',
        },
      ],
      recursive_promotion_target: 'inner',
    });
    const hostSpec = buildHostSpec({
      id: 'test/e2e-tree-host@1',
      parentStage: { workflow: subSpec },
      output: 'piorx/intent-capture@1',
    });
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(hostSpec);
    registry.registerStage({ ...captureStage(), id: 'host.inner' });

    const { executor } = buildExecutor({ registry });
    await executor.run('test/e2e-tree-host@1');

    const lineage = executor.sessionState.lineage;
    // Parent appears at top level; sub-stage appears NESTED, not flat.
    expect(lineage.map((e) => e.stage_id)).toEqual(['host']);
    const parent = lineage[0];
    expect(parent?.workflow_spec_id).toBe('test/e2e-tree-host@1');
    expect(parent?.sub_lineage?.map((e) => e.stage_id)).toEqual(['inner']);
    expect(parent?.sub_lineage?.[0]?.workflow_spec_id).toBe('test/e2e-tree-sub@1');
  });
});
