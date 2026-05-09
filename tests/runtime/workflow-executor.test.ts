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
