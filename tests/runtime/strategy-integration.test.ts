/**
 * Strategy + analysis-only workflow integration test (COMP-P5-T4 acceptance).
 *
 * Per `docs/composability.md` "Phase 5 — Skills-as-strategies + filesystem
 * discovery" and `auto-implement-composability.md` COMP-P5-T4, this suite
 * proves the end-to-end Phase 5 contract:
 *
 *   1. **`piorx.analysis-only` workflow validates and runs end-to-end
 *      without invoking execution.** The shipped reference workflow loads,
 *      passes registry validation, walks every declared stage, and ends
 *      at synthesis with a `piorx/analysis-report@1` artifact. No execution
 *      stage runs.
 *
 *   2. **A hand-authored `.piorx/strategies/foo.md` is discovered,
 *      registered, and invocable as a tool from an active synthesis stage.**
 *      Discovery uses the canonical `discoverStrategiesAndRegister` boot
 *      seam from `@piorx/extension-api`; invocation happens inside a
 *      synthesis-stage adapter that resolves the strategy by name from
 *      `piorxRegistry.resolveStrategy(...)` and surfaces its body as a
 *      tool-result-shaped payload before producing the analysis-report.
 *
 *   3. **The default workflow is unaffected by the additional pipeline.**
 *      Both workflow specs register against the same registry without
 *      conflict and pass `registry.validate()` in one pass.
 *
 * The test deliberately uses imports from `@piorx/extension-api` so the
 * acceptance criterion for COMP-P5-T3 ("a sample third-party extension
 * imports from @piorx/extension-api and successfully registers") is also
 * exercised by this suite — registering a workflow + stage + gate +
 * strategy through the published surface alone, with no reach into
 * `src/runtime/*` from the consumer-side imports.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  STRATEGY_KIND,
  WorkflowRegistry,
  discoverStrategiesAndRegister,
  getPiorxRegistry,
  setPiorxRegistry,
  piorxRegistry,
  registerDefaultGates,
  type AdvisorStrategy,
  type GateOp,
  type GateOpValidation,
  type GatePresentation,
  type GateSpec,
  type Pipeline,
  type Stage,
  type StageContext,
  type StageResult,
} from '@piorx/extension-api';

import { ArtifactStore } from '../../src/artifacts/store.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import { createConfig } from '../../src/runtime/config.ts';
import { loadWorkflowFromFile } from '../../src/runtime/workflow-loader.ts';
import { WorkflowExecutor, type StageContextExtras } from '../../src/runtime/workflow-executor.ts';
import { createSessionState, type SessionState } from '../../src/runtime/session-state.ts';
import type {
  AnalysisReportV1,
  EvidenceBundleV1,
  IntentCaptureV1,
  IntentRestatementV1,
  IntentSpecV1,
  RetrievalIndexV1,
} from '../../src/artifacts/types.ts';
import type { StageModelCall } from '../../src/runtime/stage.ts';

// ---------------------------------------------------------------------------
// Constants & paths
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = resolve(import.meta.dir, '../../src/runtime/workflows');
const DEFAULT_WORKFLOW_PATH = join(WORKFLOWS_DIR, 'piorx-default.workflow.md');
const ANALYSIS_ONLY_WORKFLOW_PATH = join(WORKFLOWS_DIR, 'piorx-analysis-only.workflow.md');

const NULL_MODEL: StageModelCall = async () => '';

// ---------------------------------------------------------------------------
// Stub stages — produce real artifacts so the store accepts them
// ---------------------------------------------------------------------------
//
// The integration test builds a complete artifact graph for the analysis-
// only workflow without booting the default heavy adapters. The synthesis
// stub deliberately consults `piorxRegistry.resolveStrategy('foo')` and
// folds the strategy's body into the analysis-report's `summary` so the
// "strategy is invocable as a tool from synthesis" property is verified
// by inspecting the produced artifact.

interface StrategyToolEnvelope {
  readonly strategy_name: string;
  readonly body_excerpt: string;
}

interface AnalysisOnlyContextExtras extends StageContextExtras {
  /** Strategy name the synthesis stub resolves and surfaces as a tool. */
  readonly strategyName: string;
  /** Sink the synthesis stub writes into so the test can assert it ran. */
  readonly toolEnvelopes: StrategyToolEnvelope[];
  /** Resolver — defaults to the process-wide `piorxRegistry`. */
  readonly resolveStrategy?: (name: string) => AdvisorStrategy | undefined;
}

const stubCaptureStage: Stage<never, 'piorx/intent-capture@1'> = {
  id: 'capture',
  inputs: [] as const,
  output: 'piorx/intent-capture@1',
  async run(ctx: StageContext): Promise<StageResult> {
    const id = generateArtifactId('piorx/intent-capture@1');
    const artifact: IntentCaptureV1 = {
      artifact_type: 'piorx/intent-capture@1',
      artifact_id: id,
      user_intent_verbatim: 'verbatim test intent',
      cleaned_user_intent: 'cleaned test intent',
      tagged_files: [],
      timestamp: '2026-05-08T00:00:00Z',
    };
    await ctx.store.put(artifact);
    return { output_artifact_id: id };
  },
};

const stubRestatementStage: Stage<'piorx/intent-capture@1', 'piorx/intent-restatement@1'> = {
  id: 'restatement',
  inputs: ['piorx/intent-capture@1'] as const,
  output: 'piorx/intent-restatement@1',
  async run(ctx: StageContext): Promise<StageResult> {
    const captureId = ctx.session.artifacts.intent_capture_id ?? 'cap';
    const id = generateArtifactId('piorx/intent-restatement@1');
    const artifact: IntentRestatementV1 = {
      artifact_type: 'piorx/intent-restatement@1',
      artifact_id: id,
      intent_capture_id: captureId,
      user_intent_verbatim: 'verbatim test intent',
      restated_intent: 'restated test intent',
      approved: true,
      // expand_requested=false so the workflow takes the
      // `restatement → retrieval` edge directly.
      expand_requested: false,
      approval_turns: 1,
    };
    await ctx.store.put(artifact);
    return { output_artifact_id: id };
  },
};

const stubExpansionStage: Stage<'piorx/intent-restatement@1', 'piorx/intent-spec@1'> = {
  id: 'expansion',
  inputs: ['piorx/intent-restatement@1'] as const,
  output: 'piorx/intent-spec@1',
  async run(ctx: StageContext): Promise<StageResult> {
    const id = generateArtifactId('piorx/intent-spec@1');
    const artifact: IntentSpecV1 = {
      artifact_type: 'piorx/intent-spec@1',
      artifact_id: id,
      expansion_input_id: 'unused-in-test',
      user_intent_verbatim: 'verbatim test intent',
      approved_restated_intent: 'restated test intent',
      expanded_spec: {
        objective: 'analyze',
        deliverables: [],
        constraints: [],
        retrieval_focus: [],
        open_questions: [],
      },
      approved: true,
    };
    await ctx.store.put(artifact);
    return { output_artifact_id: id };
  },
};

const stubRetrievalStage: Stage<'piorx/intent-restatement@1', 'piorx/retrieval-index@1'> = {
  id: 'retrieval',
  inputs: ['piorx/intent-restatement@1'] as const,
  output: 'piorx/retrieval-index@1',
  async run(ctx: StageContext): Promise<StageResult> {
    const id = generateArtifactId('piorx/retrieval-index@1');
    const artifact: RetrievalIndexV1 = {
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: id,
      intent_capture_id: ctx.session.artifacts.intent_capture_id ?? 'cap',
      intent_restatement_id: ctx.session.artifacts.intent_restatement_id ?? 'rest',
      intent_spec_id: ctx.session.artifacts.intent_spec_id,
      query: 'analyze',
      confidence: 'high',
      strategy_summary: 'narrow',
      scout_terms: ['analyze'],
      files: [
        {
          file_id: 'file-1',
          path: 'src/foo.ts',
          why_relevant: 'core',
          file_summary: 'foo',
          ast_skeleton: [],
          recommended_expansion: 'summary',
          expansion_reason: 'core',
          selection_tier: 'selected',
          selection_reason: 'core',
          default_evidence_mode: 'summary',
          symbols: [],
        },
      ],
      cross_file_findings: [],
      gaps: [],
      followup_queries: [],
      recommended_evidence: {
        files: [
          {
            file_id: 'file-1',
            include_ast_skeleton: false,
            include_retriever_summary: true,
            include_entire_file: false,
            spans: [],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    };
    await ctx.store.put(artifact);
    return { output_artifact_id: id };
  },
};

const stubEvidenceStage: Stage<'piorx/retrieval-index@1', 'piorx/evidence-bundle@1'> = {
  id: 'evidence',
  inputs: ['piorx/retrieval-index@1'] as const,
  output: 'piorx/evidence-bundle@1',
  async run(ctx: StageContext): Promise<StageResult> {
    const id = generateArtifactId('piorx/evidence-bundle@1');
    const artifact: EvidenceBundleV1 = {
      artifact_type: 'piorx/evidence-bundle@1',
      artifact_id: id,
      evidence_plan_id: 'plan',
      intent_context: {
        user_intent_verbatim: 'verbatim test intent',
        approved_restated_intent: 'restated test intent',
        intent_spec_id: ctx.session.artifacts.intent_spec_id,
      },
      structural_context: {
        files: [],
        cross_file_findings: [],
      },
      raw_evidence: [],
      stats: {
        files: 0,
        spans: 0,
        full_files: 0,
        total_lines: 0,
        estimated_tokens: 0,
      },
    };
    await ctx.store.put(artifact);
    return { output_artifact_id: id };
  },
};

const stubSynthesisStage: Stage<
  'piorx/evidence-bundle@1' | 'piorx/intent-restatement@1',
  'piorx/analysis-report@1 | piorx/change-spec@1'
> = {
  id: 'synthesis',
  inputs: ['piorx/evidence-bundle@1', 'piorx/intent-restatement@1'] as const,
  output: 'piorx/analysis-report@1 | piorx/change-spec@1',
  async run(ctx: StageContext): Promise<StageResult> {
    // The synthesis stub demonstrates "strategy invocable as a tool from
    // an active synthesis stage": resolve the registered strategy by
    // name, build a tool-result-shaped envelope, and fold an excerpt of
    // its body into the analysis-report so callers can assert the
    // strategy actually fired.
    const services = ctx as StageContext & AnalysisOnlyContextExtras;
    const resolve =
      services.resolveStrategy ?? ((name: string) => piorxRegistry.resolveStrategy(name));
    const strategy = resolve(services.strategyName);
    if (!strategy) {
      throw new Error(`synthesis stub: strategy "${services.strategyName}" not registered`);
    }
    const envelope: StrategyToolEnvelope = {
      strategy_name: strategy.name,
      // Excerpt: first three non-empty body lines, joined. Strategy bodies
      // are markdown that conventionally leads with `# heading` and a
      // blank line, so an empty-line filter keeps the excerpt meaningful.
      body_excerpt: strategy.body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 3)
        .join('\n'),
    };
    services.toolEnvelopes.push(envelope);

    const id = generateArtifactId('piorx/analysis-report@1');
    const artifact: AnalysisReportV1 = {
      artifact_type: 'piorx/analysis-report@1',
      artifact_id: id,
      evidence_bundle_id: ctx.session.artifacts.evidence_bundle_id ?? 'bundle',
      summary: `Analysis applied strategy "${envelope.strategy_name}"`,
      findings: [`Strategy excerpt: ${envelope.body_excerpt}`],
      risks: [],
      recommended_next_steps: [],
    };
    await ctx.store.put(artifact);
    return { output_artifact_id: id };
  },
};

// Stub gates for the four mandatory / declared gate ids the workflows
// reference. Auto-accept by default; the executor's broker calls these.
function passthroughGate(gateId: string): GateSpec {
  return {
    id: gateId,
    async presents(): Promise<GatePresentation> {
      return { summary: `${gateId}: passthrough` };
    },
    validateOverride(_op: GateOp): GateOpValidation {
      return { valid: true, errors: [] };
    },
    async applyOverride(): Promise<void> {
      // Default broker auto-accepts; passthrough does not mutate state.
    },
  };
}

// ---------------------------------------------------------------------------
// Strategy fixtures
// ---------------------------------------------------------------------------

function strategyFile(opts: {
  name: string;
  description: string;
  applicableStages?: string[];
  body?: string;
}): string {
  const lines: string[] = [
    '---',
    `kind: ${STRATEGY_KIND}`,
    `name: ${opts.name}`,
    `description: ${opts.description}`,
  ];
  if (opts.applicableStages) {
    lines.push('applicable_stages:');
    for (const stage of opts.applicableStages) lines.push(`  - ${stage}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(opts.body ?? `# ${opts.name}\n\nStrategy body for ${opts.name}.`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tmpRoot: string;
let store: ArtifactStore;
let projectStrategiesDir: string;
let userStrategiesDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'piorx-strategy-integration-'));
  store = new ArtifactStore(createConfig(tmpRoot));
  projectStrategiesDir = join(tmpRoot, '.piorx', 'strategies');
  userStrategiesDir = join(tmpRoot, 'user-config', 'piorx', 'strategies');
  // Reset the singleton between tests so a stray registration in one test
  // does not leak into the next.
  setPiorxRegistry(null);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  setPiorxRegistry(null);
});

function freshSession(): SessionState {
  return createSessionState();
}

function buildAnalysisOnlyRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.registerWorkflow(loadWorkflowFromFile(ANALYSIS_ONLY_WORKFLOW_PATH));
  registry.registerStage(stubCaptureStage);
  registry.registerStage(stubRestatementStage);
  registry.registerStage(stubExpansionStage);
  registry.registerStage(stubRetrievalStage);
  registry.registerStage(stubEvidenceStage);
  registry.registerStage(stubSynthesisStage);
  // Gates declared by the analysis-only spec: intent.approval (mandatory),
  // expansion.review, evidence.review.
  registry.registerGate('restatement', passthroughGate('intent.approval'));
  registry.registerGate('expansion', passthroughGate('expansion.review'));
  registry.registerGate('evidence', passthroughGate('evidence.review'));
  return registry;
}

// ---------------------------------------------------------------------------
// 1. Analysis-only workflow validates and runs end-to-end without execution
// ---------------------------------------------------------------------------

describe('piorx.analysis-only — workflow shape and traversal', () => {
  test('analysis-only workflow loads, validates, and registers without violations', () => {
    const spec = loadWorkflowFromFile(ANALYSIS_ONLY_WORKFLOW_PATH);
    expect(spec.artifact_type).toBe('piorx/workflow-spec@1');
    expect(spec.id).toBe('piorx/workflow/analysis-only@1');
    expect(spec.operating_mode).toBe('advisory');
    expect(spec.mandatory_controls).toEqual(['intent.approval']);

    // No edge from synthesis — analysis-only has no execution stage.
    const synthEdges = spec.edges.filter((e) => e.from === 'synthesis');
    expect(synthEdges).toHaveLength(0);
    // No execution stage declared.
    const stageIds = spec.stages.map((s) => s.id);
    expect(stageIds).not.toContain('execution');

    const registry = buildAnalysisOnlyRegistry();
    expect(() => registry.validate()).not.toThrow();
  });

  test('Pipeline (workflow) type alias from @piorx/extension-api reflects the loaded spec', () => {
    const spec = loadWorkflowFromFile(ANALYSIS_ONLY_WORKFLOW_PATH);
    // Compile-time assertion through the alias — verifies the shim
    // re-exports the workflow shape under the friendlier name.
    const pipeline: Pipeline = spec;
    expect(pipeline.recursive_promotion_target).toBe('restatement');
  });

  test('runs every declared stage and ends at synthesis with an analysis-report', async () => {
    const registry = buildAnalysisOnlyRegistry();
    // For the analysis-only workflow's first stage (`restatement`) to
    // succeed in the executor, the session must already carry an
    // intent-capture pointer — the stub restatement reads it. Simulate
    // host-side capture by writing the artifact directly to the store.
    const captureId = generateArtifactId('piorx/intent-capture@1');
    await store.put({
      artifact_type: 'piorx/intent-capture@1',
      artifact_id: captureId,
      user_intent_verbatim: 'verbatim test intent',
      cleaned_user_intent: 'cleaned test intent',
      tagged_files: [],
      timestamp: '2026-05-08T00:00:00Z',
    });

    const strategy: AdvisorStrategy = Object.freeze({
      name: 'foo',
      kind: STRATEGY_KIND,
      description: 'integration-test strategy',
      body: '# foo\n\nApply rigorous evidence-walking before drafting.',
      source_path: '<programmatic>',
      scope: 'project',
    });
    registry.registerStrategy(strategy);

    const toolEnvelopes: StrategyToolEnvelope[] = [];
    const session = freshSession();
    session.artifacts.intent_capture_id = captureId;

    const executor = new WorkflowExecutor({
      registry,
      store,
      session,
      model: NULL_MODEL,
      contextExtras: {
        strategyName: 'foo',
        toolEnvelopes,
        resolveStrategy: (name: string) => registry.resolveStrategy(name),
      } satisfies AnalysisOnlyContextExtras,
    });

    const result = await executor.run('piorx/workflow/analysis-only@1');

    expect(result.stage_runs.map((r) => r.stage_id)).toEqual([
      'restatement',
      'retrieval',
      'evidence',
      'synthesis',
    ]);
    expect(result.final_stage_id).toBe('synthesis');
    expect(result.final_artifact_type).toBe('piorx/analysis-report@1');

    // No execution stage ran.
    const ranExecution = result.stage_runs.some((r) => r.stage_id === 'execution');
    expect(ranExecution).toBe(false);

    // Lineage records every stage with the analysis-only workflow id.
    for (const entry of executor.sessionState.lineage) {
      expect(entry.workflow_spec_id).toBe('piorx/workflow/analysis-only@1');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Strategy file is discovered, registered, and invocable from synthesis
// ---------------------------------------------------------------------------

describe('strategy discovery + invocation from synthesis', () => {
  test('a hand-authored .piorx/strategies/foo.md is discovered and surfaced from synthesis', async () => {
    // Drop a strategy file in the project-scope directory.
    await mkdir(projectStrategiesDir, { recursive: true });
    await writeFile(
      join(projectStrategiesDir, 'foo.md'),
      strategyFile({
        name: 'foo',
        description: 'rigorous synthesis strategy',
        applicableStages: ['synthesis'],
        body:
          '# foo\n\n' +
          'Apply rigorous evidence-walking before drafting findings.\n' +
          'Cite each finding with the spans the evidence bundle exposes.',
      }),
      'utf-8',
    );

    const registry = buildAnalysisOnlyRegistry();
    // Wire the singleton so `piorxRegistry.resolveStrategy('foo')` (called
    // from the synthesis stub when no `resolveStrategy` override is
    // supplied) resolves through the same registry the executor uses.
    setPiorxRegistry(registry);

    const config = createConfig(tmpRoot);
    const result = discoverStrategiesAndRegister(registry, config, {
      projectDir: projectStrategiesDir,
      userDir: userStrategiesDir,
    });
    expect(result.diagnostics).toHaveLength(0);
    expect(result.registered.map((s) => s.name)).toEqual(['foo']);
    expect(registry.resolveStrategy('foo')?.scope).toBe('project');

    // Verify the same strategy is reachable through the singleton proxy
    // re-exported from `@piorx/extension-api`.
    expect(piorxRegistry.resolveStrategy('foo')?.name).toBe('foo');
    expect(getPiorxRegistry()).toBe(registry);

    // Run the analysis-only workflow with the synthesis stub configured to
    // resolve through the singleton (no `resolveStrategy` override). The
    // stub will fail loudly if the strategy is not registered.
    const captureId = generateArtifactId('piorx/intent-capture@1');
    await store.put({
      artifact_type: 'piorx/intent-capture@1',
      artifact_id: captureId,
      user_intent_verbatim: 'verbatim test intent',
      cleaned_user_intent: 'cleaned test intent',
      tagged_files: [],
      timestamp: '2026-05-08T00:00:00Z',
    });

    const toolEnvelopes: StrategyToolEnvelope[] = [];
    const session = freshSession();
    session.artifacts.intent_capture_id = captureId;
    const executor = new WorkflowExecutor({
      registry,
      store,
      session,
      model: NULL_MODEL,
      contextExtras: {
        strategyName: 'foo',
        toolEnvelopes,
        // No resolveStrategy override — exercises the
        // piorxRegistry.resolveStrategy path explicitly.
      } satisfies AnalysisOnlyContextExtras,
    });

    const runResult = await executor.run('piorx/workflow/analysis-only@1');
    expect(runResult.final_artifact_type).toBe('piorx/analysis-report@1');
    expect(toolEnvelopes).toHaveLength(1);
    expect(toolEnvelopes[0]?.strategy_name).toBe('foo');
    expect(toolEnvelopes[0]?.body_excerpt).toContain('rigorous evidence-walking');

    // The analysis-report carries the strategy name — proof that the
    // synthesis stage's tool-style invocation propagated to the artifact.
    const finalReport = (await store.get(
      'piorx/analysis-report@1',
      runResult.final_artifact_id,
    )) as AnalysisReportV1 | null;
    expect(finalReport?.summary).toContain('foo');
    expect(finalReport?.findings.join(' ')).toContain('rigorous evidence-walking');
  });
});

// ---------------------------------------------------------------------------
// 3. Default workflow is unaffected by the additional pipeline
// ---------------------------------------------------------------------------

describe('default + analysis-only co-registration', () => {
  test('both workflows register against one registry and pass validation in one pass', () => {
    const registry = new WorkflowRegistry();
    const defaultSpec = loadWorkflowFromFile(DEFAULT_WORKFLOW_PATH);
    const analysisOnlySpec = loadWorkflowFromFile(ANALYSIS_ONLY_WORKFLOW_PATH);
    registry.registerWorkflow(defaultSpec);
    registry.registerWorkflow(analysisOnlySpec);

    // Register the same fat adapters once — both workflows share the
    // stage-id contract for restatement / expansion / retrieval / evidence
    // / synthesis, so a single registration covers both.
    registry.registerStage(stubCaptureStage);
    registry.registerStage(stubRestatementStage);
    registry.registerStage(stubExpansionStage);
    registry.registerStage(stubRetrievalStage);
    registry.registerStage(stubEvidenceStage);
    registry.registerStage(stubSynthesisStage);

    // Add the execution stub so the default workflow's `execution` stage
    // resolves; the analysis-only workflow does not declare it.
    registry.registerStage({
      id: 'execution',
      inputs: ['piorx/change-spec@1'] as const,
      output: 'piorx/execution-report@1',
      async run(): Promise<StageResult> {
        return { output_artifact_id: 'noop' };
      },
    });

    // Default-workflow gates: intent.approval, expansion.review,
    // evidence.review (re-uses the canonical implementation),
    // synthesis.confirm-task-type, execution.allow_edits.
    registerDefaultGates(registry); // registers evidence.review
    registry.registerGate('restatement', passthroughGate('intent.approval'));
    registry.registerGate('expansion', passthroughGate('expansion.review'));
    registry.registerGate('synthesis', passthroughGate('synthesis.confirm-task-type'));
    registry.registerGate('execution', passthroughGate('execution.allow_edits'));

    expect(() => registry.validate()).not.toThrow();
    expect(registry.resolveWorkflow('piorx/workflow/default@1').id).toBe(
      'piorx/workflow/default@1',
    );
    expect(registry.resolveWorkflow('piorx/workflow/analysis-only@1').id).toBe(
      'piorx/workflow/analysis-only@1',
    );
  });
});
