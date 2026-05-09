/**
 * Phase-8 end-to-end regression test for the agentic retrieval pipeline.
 *
 * Walks the conductor through:
 *   Stage 1 (intent-file context) → retrieval dispatch (scout-only fallback) →
 *   createRecommendedEvidencePlan → evidence assembly.
 *
 * Proves the invariants the new architecture guarantees:
 *   - Stage 1 can use user-supplied file context without broadening the
 *     conductor's general repo access. The inline file body stays in the
 *     cleaned intent / restatement-context only; it never reaches the
 *     retriever or the stored retrieval artifact.
 *   - The retriever-authored default evidence package is narrower than the
 *     pre-agentic "summary + AST for every file" heuristic baseline. Reserve
 *     files never enter the plan without an explicit conductor promotion.
 *   - The assembler materializes only the selected raw evidence: no reserve
 *     file bodies, no off-plan files, and deterministic content from the
 *     retrieval artifact plus repo disk state.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createConfig,
  type PhaseModelConfigs,
  type PipelinePhaseId,
  validatePhaseModelConfigs,
} from '../../src/runtime/config.ts';
import type { AdvisorCallback, ExecutorCallback } from '../../src/runtime/run-with-advisor.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { StageMachine } from '../../src/conductor/stage-machine.ts';
import { Stage1Controller, type RestateFunction } from '../../src/conductor/stage-1.ts';
import { buildRestatementContext, toIntentFileRefs } from '../../src/util/intent-files.ts';
import { retrievalDispatch } from '../../src/services/retrieval-dispatch.ts';
import {
  createEvidencePlan,
  createRecommendedEvidencePlan,
} from '../../src/conductor/evidence-plan.ts';
import {
  evidenceAssemble,
  type EvidenceMaterializeResult,
} from '../../src/services/evidence-assembler.ts';
import type { EvidenceBundleV1, RetrievalIndexV1 } from '../../src/artifacts/types.ts';
import type { PiOrchestraConfig } from '../../src/runtime/config.ts';
import type { AgentModelCallback } from '../../src/retriever/agent-types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL_RESOLVER_SRC = `// model-resolver.ts
import { hasConfiguredAuth } from './model-registry';

export function restoreModelFromSession(session: unknown): string {
  if (!session) return 'default-model';
  if (!hasConfiguredAuth(session)) return 'fallback-model';
  return 'session-model';
}

export function findInitialModel(): string {
  return 'initial-model';
}
`;

const MODEL_REGISTRY_SRC = `// model-registry.ts
export function hasConfiguredAuth(session: unknown): boolean {
  return session !== null && typeof session === 'object';
}

export function listRegisteredModels(): string[] {
  return ['session-model', 'fallback-model', 'default-model'];
}
`;

function makeTaggedIntent(): string {
  return [
    'I want to understand how restoreModelFromSession works.',
    '',
    '<file name="src/core/model-resolver.ts">',
    MODEL_RESOLVER_SRC,
    '</file>',
  ].join('\n');
}

interface RestateSpy extends RestateFunction {
  readonly calls: Array<{ cleanedIntent: string; contextBlock?: string }>;
}

function makeRestateSpy(): RestateSpy {
  const calls: RestateSpy['calls'] = [];
  const fn = ((input) => {
    calls.push({ cleanedIntent: input.cleanedIntent, contextBlock: input.contextBlock });
    return `Restatement: ${input.cleanedIntent.split('\n')[0]}`;
  }) as RestateSpy;
  Object.defineProperty(fn, 'calls', { value: calls, enumerable: true });
  return fn;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempDir: string;
let config: PiOrchestraConfig;
let store: ArtifactStore;
let machine: StageMachine;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'piorx-ar-flow-'));
  const repoDir = join(tempDir, 'repo');
  const coreDir = join(repoDir, 'src/core');
  await mkdir(coreDir, { recursive: true });
  await writeFile(join(coreDir, 'model-resolver.ts'), MODEL_RESOLVER_SRC, 'utf-8');
  await writeFile(join(coreDir, 'model-registry.ts'), MODEL_REGISTRY_SRC, 'utf-8');

  config = createConfig(tempDir);
  config.repoRoot = repoDir;
  store = new ArtifactStore(config);
  machine = await StageMachine.init(config);
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/**
 * Run Stage 1 with an intent that embeds an inline file block and return
 * the resulting artifact ids. The restate spy is returned so tests can
 * assert the cleaned intent reached the callback.
 */
async function runStage1WithIntentFile(intent: string) {
  const ctx = await buildRestatementContext(intent, config.repoRoot);
  const restateSpy = makeRestateSpy();
  const controller = new Stage1Controller(store, machine, restateSpy);
  const capture = await controller.captureIntent(intent, ctx.taggedFiles, {
    cleanedIntent: ctx.cleanedIntent,
    intentFileRefs: toIntentFileRefs(ctx.files),
    restatementContext: ctx.contextBlock,
  });
  const msg = await controller.produceRestatement();
  await controller.submitApproval(msg.restated_intent, { approved: true });
  const finalized = await controller.finalize(msg.restated_intent, { expand: false });
  return { capture, ctx, restateSpy, finalized };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentic retrieval flow — Stage 1 through evidence assembly', () => {
  test('Stage 1 intent-file context reaches the restate callback and stays inside Stage 1', async () => {
    const intent = makeTaggedIntent();
    const { capture, ctx, restateSpy } = await runStage1WithIntentFile(intent);

    // Cleaned intent stripped the inline body and left a reference marker.
    expect(ctx.cleanedIntent).not.toContain('restoreModelFromSession(session: unknown)');
    expect(ctx.cleanedIntent).toContain('[Included file: src/core/model-resolver.ts]');
    // Context block carries the bounded file body for the restate call.
    expect(ctx.contextBlock).toContain('restoreModelFromSession');
    expect(ctx.taggedFiles).toEqual(['src/core/model-resolver.ts']);
    expect(ctx.files[0]!.source).toBe('inline');

    // Persisted capture keeps verbatim + cleaned forms and file refs.
    expect(capture.user_intent_verbatim).toBe(intent);
    expect(capture.cleaned_user_intent).toBe(ctx.cleanedIntent);
    expect(capture.tagged_files).toEqual(['src/core/model-resolver.ts']);
    expect(capture.intent_file_refs).toEqual([
      { path: 'src/core/model-resolver.ts', source: 'inline' },
    ]);

    // The restate function sees cleaned intent + context block — never the
    // raw verbatim input. No general file-read tool was consulted.
    expect(restateSpy.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of restateSpy.calls) {
      expect(call.cleanedIntent).toBe(ctx.cleanedIntent);
      expect(call.cleanedIntent).not.toContain('restoreModelFromSession(session: unknown)');
      expect(call.contextBlock).toContain('restoreModelFromSession');
    }
  });

  test('retrieval authors a default plan narrower than a legacy summary-everything baseline', async () => {
    const intent = makeTaggedIntent();
    const { capture, finalized } = await runStage1WithIntentFile(intent);

    // Scout-only dispatch (no model callback). The retriever authors the
    // default plan from deterministic scout signals.
    const dispatchResult = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: finalized.intent_restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
    );
    expect(dispatchResult.status).toBe('success');
    expect(dispatchResult.retrieval_index_id).not.toBeNull();

    const index = (await store.get(
      'piorx/retrieval-index@1',
      dispatchResult.retrieval_index_id!,
    )) as RetrievalIndexV1;
    expect(index).not.toBeNull();

    // Structural-only: no raw source bodies on the stored artifact. AST
    // skeletons may include function signatures, but statement-level body
    // content must stay inside the retrieval boundary.
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain('raw_content');
    expect(serialized).not.toContain("return 'default-model'");
    expect(serialized).not.toContain("return 'fallback-model'");
    expect(serialized).not.toContain('session !== null && typeof session');

    // The retriever-authored default plan embeds recommended_evidence.
    const recommendedPlan = createRecommendedEvidencePlan(index);
    const selectedPaths = new Set(
      index.files.filter((f) => f.selection_tier === 'selected').map((f) => f.path),
    );
    expect(recommendedPlan.selection.files.length).toBeGreaterThan(0);
    for (const planFile of recommendedPlan.selection.files) {
      const file = index.files.find((f) => f.file_id === planFile.file_id);
      expect(file).toBeDefined();
      expect(file!.selection_tier).toBe('selected');
      expect(file!.default_evidence_mode).not.toBe('exclude');
      expect(selectedPaths.has(file!.path)).toBe(true);
    }

    // Legacy baseline: summary+AST for every index file — the pre-agentic
    // heuristic default before the retriever authored its own scope.
    const legacyPlan = createEvidencePlan({
      retrieval_index: index,
      file_controls: index.files.map((f) => ({
        file_id: f.file_id,
        include_retriever_summary: true,
        include_ast_skeleton: true,
      })),
    });

    // Narrowness invariant: the retriever-authored plan cannot include more
    // files than the legacy-everything baseline.
    expect(recommendedPlan.selection.files.length).toBeLessThanOrEqual(
      legacyPlan.selection.files.length,
    );

    // If the retriever marked any files as reserve or excluded, the
    // recommended plan is strictly narrower than the legacy baseline, and
    // those files never appear in the default plan.
    const reserveOrExcluded = index.files.filter(
      (f) => f.selection_tier === 'reserve' || f.default_evidence_mode === 'exclude',
    );
    if (reserveOrExcluded.length > 0) {
      expect(recommendedPlan.selection.files.length).toBeLessThan(
        legacyPlan.selection.files.length,
      );
      const planIds = new Set(recommendedPlan.selection.files.map((f) => f.file_id));
      for (const f of reserveOrExcluded) {
        expect(planIds.has(f.file_id)).toBe(false);
      }
    }
  });

  test('assembler materializes only the retriever-selected evidence', async () => {
    const intent = makeTaggedIntent();
    const { capture, finalized } = await runStage1WithIntentFile(intent);

    const dispatchResult = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: finalized.intent_restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
    );
    expect(dispatchResult.status).toBe('success');
    const index = (await store.get(
      'piorx/retrieval-index@1',
      dispatchResult.retrieval_index_id!,
    )) as RetrievalIndexV1;

    const plan = createRecommendedEvidencePlan(index);
    await store.put(plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;
    expect(result.status).toBe('success');

    const bundle = (await store.get(
      'piorx/evidence-bundle@1',
      result.evidence_bundle_id!,
    )) as EvidenceBundleV1;

    // Bundle files line up with the plan — no widening.
    const planFileIds = new Set(plan.selection.files.map((f) => f.file_id));
    const bundlePaths = new Set(bundle.structural_context.files.map((f) => f.path));
    const planPaths = new Set(
      index.files.filter((f) => planFileIds.has(f.file_id)).map((f) => f.path),
    );
    expect(bundlePaths).toEqual(planPaths);

    // Reserve files never appear in the bundle.
    for (const reserveFile of index.files.filter((f) => f.selection_tier === 'reserve')) {
      expect(bundlePaths.has(reserveFile.path)).toBe(false);
      for (const ev of bundle.raw_evidence) {
        expect(ev.path).not.toBe(reserveFile.path);
      }
    }

    // Raw evidence only materializes selected span/full-file entries that
    // the plan requested.
    for (const ev of bundle.raw_evidence) {
      expect(planPaths.has(ev.path)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Agent-driven dispatch — AR-P8-T3
// ---------------------------------------------------------------------------

describe('agentic retrieval flow — agent-driven retriever path', () => {
  /**
   * Write a handful of distractor files alongside the Stage 1 fixture so
   * the scout's selected tier can plausibly hold more than one candidate.
   * The stubbed agent will then narrow the recommendation back down to a
   * single file, and the test asserts that narrowing survives the stored
   * artifact and the recommended evidence plan.
   */
  async function writeDistractorFiles(repoRoot: string): Promise<void> {
    const libDir = join(repoRoot, 'src/lib');
    await mkdir(libDir, { recursive: true });
    await writeFile(
      join(libDir, 'session-store.ts'),
      [
        '// session-store.ts — unrelated helper referencing the same terms',
        'export function saveSession(session: unknown): void {',
        '  void session;',
        '}',
        '',
        'export function findModel(): string {',
        "  return 'noop';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(libDir, 'model-config.ts'),
      [
        '// model-config.ts — looks relevant by name but is not the target',
        "export const DEFAULT_MODEL = 'default-model';",
        "export const FALLBACK_MODEL = 'fallback-model';",
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  test('retrievalDispatch with a stubbed retrieverAgentModel narrows the plan to the agent recommendation', async () => {
    const repoDir = join(tempDir, 'repo');
    await writeDistractorFiles(repoDir);

    const intent = makeTaggedIntent();
    const { capture, finalized } = await runStage1WithIntentFile(intent);

    // Scout-only baseline: no model callback means retrieval falls back to
    // the deterministic scout output.
    const scoutDispatch = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: finalized.intent_restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
    );
    expect(scoutDispatch.status).toBe('success');
    expect(scoutDispatch.message).not.toContain('agent rounds=');
    const scoutIndex = (await store.get(
      'piorx/retrieval-index@1',
      scoutDispatch.retrieval_index_id!,
    )) as RetrievalIndexV1;
    const scoutPlan = createRecommendedEvidencePlan(scoutIndex);

    // Agent-driven path: supply a stubbed model that returns a narrower
    // single-file recommendation in the very first round.
    const agentResponse = JSON.stringify({
      status: 'stop',
      summary: 'agent narrowed to the tagged file',
      recommendation: {
        strategy_summary:
          'Agent confirmed src/core/model-resolver.ts defines restoreModelFromSession ' +
          'and rejected src/lib/* candidates as unrelated.',
        files: [
          {
            path: 'src/core/model-resolver.ts',
            tier: 'selected',
            default_evidence_mode: 'spans',
            selection_reason: 'defines restoreModelFromSession',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [
              {
                name: 'restoreModelFromSession',
                start: 3,
                count: 5,
                selected_by_default: true,
                default_neighbor_lines: 1,
                selection_reason: 'primary target span',
              },
            ],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'high',
      },
    });

    const modelCalls: Array<{ round: number; systemPromptLen: number }> = [];
    const retrieverAgentModel: AgentModelCallback = async ({ round, systemPrompt }) => {
      modelCalls.push({ round, systemPromptLen: systemPrompt.length });
      return agentResponse;
    };

    const agentDispatch = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: finalized.intent_restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
      { retrieverAgentModel },
    );

    expect(agentDispatch.status).toBe('success');
    // Dispatch message carries agent telemetry, proving the model callback
    // ran (scout-only dispatch has no such suffix).
    expect(agentDispatch.message).toContain('agent rounds=1');
    expect(agentDispatch.message).toContain('stop=agent_stopped');
    expect(modelCalls.length).toBe(1);
    expect(modelCalls[0]!.round).toBe(1);
    expect(modelCalls[0]!.systemPromptLen).toBeGreaterThan(0);

    const agentIndex = (await store.get(
      'piorx/retrieval-index@1',
      agentDispatch.retrieval_index_id!,
    )) as RetrievalIndexV1;

    // Stored artifact reflects the agent's narrower selection, not the
    // scout's: exactly one selected file, exactly the tagged target.
    const agentSelected = agentIndex.files.filter((f) => f.selection_tier === 'selected');
    expect(agentSelected.length).toBe(1);
    expect(agentSelected[0]!.path.endsWith('/src/core/model-resolver.ts')).toBe(true);
    expect(agentSelected[0]!.default_evidence_mode).toBe('spans');
    expect(agentSelected[0]!.selection_reason).toContain('restoreModelFromSession');
    expect(agentIndex.strategy_summary).toContain('Agent confirmed');
    expect(agentIndex.confidence).toBe('high');

    // The distractor files must not be promoted into the selected tier on
    // the agent-driven path. They may appear structurally (reserve or via
    // scout-authored leftovers) but never as selected.
    const selectedPaths = agentSelected.map((f) => f.path);
    for (const p of selectedPaths) {
      expect(p.endsWith('/src/lib/session-store.ts')).toBe(false);
      expect(p.endsWith('/src/lib/model-config.ts')).toBe(false);
    }

    // Recommended evidence plan mirrors the agent's narrower scope: one
    // file, one span, the agent-chosen neighbor_lines.
    const agentPlan = createRecommendedEvidencePlan(agentIndex);
    expect(agentPlan.selection.files.length).toBe(1);
    const planFile = agentPlan.selection.files[0]!;
    const planTargetId = agentSelected[0]!.file_id;
    expect(planFile.file_id).toBe(planTargetId);
    expect(planFile.include_ast_skeleton).toBe(true);
    expect(planFile.include_retriever_summary).toBe(true);
    expect(planFile.include_entire_file).toBe(false);
    expect(planFile.spans.length).toBe(1);
    expect(planFile.spans[0]!.include_span).toBe(true);
    expect(planFile.spans[0]!.neighbor_lines).toBe(1);

    // Agent-driven plan cannot be wider than scout-only plan. When scout
    // chose more than one file, the agent-driven plan is strictly narrower.
    expect(agentPlan.selection.files.length).toBeLessThanOrEqual(scoutPlan.selection.files.length);
    if (scoutPlan.selection.files.length > 1) {
      expect(agentPlan.selection.files.length).toBeLessThan(scoutPlan.selection.files.length);
    }

    // Structural-only guarantees must still hold: no raw bodies leak into
    // the stored artifact even though the retrieval boundary now crossed a
    // model round.
    const serialized = JSON.stringify(agentIndex);
    expect(serialized).not.toContain('raw_content');
    expect(serialized).not.toContain("return 'default-model'");
    expect(serialized).not.toContain("return 'fallback-model'");
    expect(serialized).not.toContain('session !== null && typeof session');
  });

  test('agent-driven bundle materializes only the agent-selected evidence', async () => {
    const repoDir = join(tempDir, 'repo');
    await writeDistractorFiles(repoDir);

    const intent = makeTaggedIntent();
    const { capture, finalized } = await runStage1WithIntentFile(intent);

    const agentResponse = JSON.stringify({
      status: 'stop',
      summary: 'narrowed',
      recommendation: {
        strategy_summary: 'Agent narrowed to tagged target only',
        files: [
          {
            path: 'src/core/model-resolver.ts',
            tier: 'selected',
            default_evidence_mode: 'spans',
            selection_reason: 'primary entry point',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [
              {
                name: 'restoreModelFromSession',
                start: 3,
                count: 5,
                selected_by_default: true,
                default_neighbor_lines: 1,
                selection_reason: 'agent-selected span',
              },
            ],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'high',
      },
    });

    const retrieverAgentModel: AgentModelCallback = async () => agentResponse;

    const dispatchResult = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: finalized.intent_restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
      { retrieverAgentModel },
    );
    expect(dispatchResult.status).toBe('success');
    const index = (await store.get(
      'piorx/retrieval-index@1',
      dispatchResult.retrieval_index_id!,
    )) as RetrievalIndexV1;

    const plan = createRecommendedEvidencePlan(index);
    await store.put(plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;
    expect(result.status).toBe('success');

    const bundle = (await store.get(
      'piorx/evidence-bundle@1',
      result.evidence_bundle_id!,
    )) as EvidenceBundleV1;

    const bundlePaths = bundle.structural_context.files.map((f) => f.path);
    expect(bundlePaths.length).toBe(1);
    expect(bundlePaths[0]!.endsWith('/src/core/model-resolver.ts')).toBe(true);

    // Distractors stay out of the materialized bundle on the agent path.
    for (const p of bundlePaths) {
      expect(p.endsWith('/src/lib/session-store.ts')).toBe(false);
      expect(p.endsWith('/src/lib/model-config.ts')).toBe(false);
    }
    for (const ev of bundle.raw_evidence) {
      expect(ev.path.endsWith('/src/core/model-resolver.ts')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// COMP-P2-T4 — Phase 2 gate: advisor=none for every phase preserves the E2E.
//
// Wires `config.models` with advisor.mode='none' for every PipelinePhaseId
// and re-runs the canonical Stage 1 → retrieval → evidence flow. Today the
// production callers exercised by this E2E do not invoke `runWithAdvisor`
// directly (the helper is staged for Phase 3+), so wiring a non-trivial
// `config.models` block is a defense-in-depth assertion that the runtime
// kernel does not silently behave differently when models is populated.
// ---------------------------------------------------------------------------

describe('agentic retrieval flow — Phase 2 gate (advisor=none everywhere)', () => {
  const ALL_PIPELINE_PHASES: PipelinePhaseId[] = [
    'restatement',
    'expansion',
    'retrieval',
    'synthesis',
    'execution',
  ];

  function buildAdvisorNoneConfigs(): PhaseModelConfigs {
    const block: PhaseModelConfigs = {};
    for (const phase of ALL_PIPELINE_PHASES) {
      block[phase] = {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'none' },
      };
    }
    return block;
  }

  test('default pipeline produces the same evidence bundle with advisor=none wired across every phase', async () => {
    config.models = buildAdvisorNoneConfigs();
    const validation = validatePhaseModelConfigs(config.models);
    expect(validation.ok).toBe(true);

    const intent = makeTaggedIntent();
    const { capture, finalized } = await runStage1WithIntentFile(intent);

    const dispatchResult = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: finalized.intent_restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
    );
    expect(dispatchResult.status).toBe('success');
    const index = (await store.get(
      'piorx/retrieval-index@1',
      dispatchResult.retrieval_index_id!,
    )) as RetrievalIndexV1;

    const plan = createRecommendedEvidencePlan(index);
    await store.put(plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;
    expect(result.status).toBe('success');

    const bundle = (await store.get(
      'piorx/evidence-bundle@1',
      result.evidence_bundle_id!,
    )) as EvidenceBundleV1;

    // Same shape invariants as the baseline E2E: bundle paths align with
    // the plan; reserve files stay out of raw_evidence.
    const planFileIds = new Set(plan.selection.files.map((f) => f.file_id));
    const bundlePaths = new Set(bundle.structural_context.files.map((f) => f.path));
    const planPaths = new Set(
      index.files.filter((f) => planFileIds.has(f.file_id)).map((f) => f.path),
    );
    expect(bundlePaths).toEqual(planPaths);
    for (const ev of bundle.raw_evidence) {
      expect(planPaths.has(ev.path)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// COMP-P3-T3 — Phase 3 gate: synthesis worker with stubbed advisor.
//
// Adds a synthesis run on top of the canonical retrieval bundle, exercising
// the LLM-driven path (`runWithAdvisor` + `runSynthesisWorker`'s `llm`
// seam) with a stubbed advisor model. Asserts:
//
//   1. Existing E2E (advisor disabled) still passes byte-identically — the
//      describe blocks above continue to run and pass.
//   2. With advisor enabled (mode='custom'), the executor's iterations
//      include the advisor consultation, telemetry records
//      `advisor_iterations: 1` in `.pi/orchestra.log`, and the produced
//      synthesis artifact is byte-identical (modulo artifact_id) to a
//      `mode='none'` run with the same stub model — proving the advisor
//      seam does not perturb output when the model is stubbed.
// ---------------------------------------------------------------------------

describe('agentic retrieval flow — Phase 3 gate (advisor=custom against stubbed advisor)', () => {
  const ANALYSIS_OUTPUT = JSON.stringify({
    artifact_type: 'piorx/analysis-report@1',
    artifact_id: 'placeholder',
    evidence_bundle_id: 'placeholder',
    summary: 'Phase 3 gate stubbed analysis',
    findings: ['restoreModelFromSession returns a fallback when auth is missing'],
    risks: [],
    recommended_next_steps: ['Add an integration test for the auth-missing branch'],
  });

  async function buildBundleFromCanonicalFlow(): Promise<EvidenceBundleV1> {
    const intent = makeTaggedIntent();
    const { capture, finalized } = await runStage1WithIntentFile(intent);
    const dispatchResult = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: finalized.intent_restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
    );
    const index = (await store.get(
      'piorx/retrieval-index@1',
      dispatchResult.retrieval_index_id!,
    )) as RetrievalIndexV1;
    const plan = createRecommendedEvidencePlan(index);
    await store.put(plan);
    const materialized = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;
    return (await store.get(
      'piorx/evidence-bundle@1',
      materialized.evidence_bundle_id!,
    )) as EvidenceBundleV1;
  }

  async function synthesizeWithMode(bundle: EvidenceBundleV1, advisorMode: 'none' | 'custom') {
    const { runSynthesisWorker } = await import('../../src/synthesis/worker.ts');
    const { assembleSynthesisPrompt } = await import('../../src/synthesis/prompt.ts');
    const prompt = assembleSynthesisPrompt(bundle, {
      sections: ['intent_context', 'structural_context', 'raw_evidence'],
      instructions: 'Be precise.',
      task_type: 'analysis-report',
    });

    const events: Array<{ message: string; details: unknown }> = [];
    const executor: ExecutorCallback = async (req) => {
      if (advisorMode === 'custom' && req.extras.customAdvisorHandler) {
        await req.extras.customAdvisorHandler({
          systemPrompt: 'advisor-system',
          userMessage: 'advisor-user',
        });
      }
      return {
        text: ANALYSIS_OUTPUT,
        iterations: [{ type: 'message', input_tokens: 100, output_tokens: 50 }],
      };
    };

    const advisor: AdvisorCallback = async () => ({
      text: 'Phase 3 stubbed advisor suggestion',
      usage: { input_tokens: 30, output_tokens: 10 },
    });

    const advisorConfig =
      advisorMode === 'none'
        ? { mode: 'none' as const }
        : { mode: 'custom' as const, model: 'claude-opus-4-7' };

    const output = await runSynthesisWorker({
      task_type: 'analysis-report',
      bundle,
      prompt_text: prompt.text,
      instructions: 'Be precise.',
      llm: {
        config: {
          executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          advisor: advisorConfig,
        },
        executor,
        ...(advisorMode === 'custom' ? { advisor } : {}),
        logEvent: (message, details) => {
          events.push({ message, details });
        },
      },
    });

    return { output, events };
  }

  test('synthesis output is byte-identical across advisor=none and advisor=custom', async () => {
    const bundle = await buildBundleFromCanonicalFlow();
    const noneRun = await synthesizeWithMode(bundle, 'none');
    const customRun = await synthesizeWithMode(bundle, 'custom');

    const stripId = (artifact: Record<string, unknown>) => ({
      ...artifact,
      artifact_id: 'normalized',
    });
    expect(stripId(customRun.output as unknown as Record<string, unknown>)).toEqual(
      stripId(noneRun.output as unknown as Record<string, unknown>),
    );
    // The bundle id reference is preserved in both modes — the worker stamps
    // it deterministically from the input bundle, not from the model.
    expect(customRun.output.evidence_bundle_id).toBe(bundle.artifact_id);
    expect(noneRun.output.evidence_bundle_id).toBe(bundle.artifact_id);
  });

  test('advisor=custom records advisor_iterations telemetry while synthesis succeeds', async () => {
    const bundle = await buildBundleFromCanonicalFlow();
    const { output, events } = await synthesizeWithMode(bundle, 'custom');

    expect(output.artifact_type).toBe('piorx/analysis-report@1');

    const telemetry = events.find((e) => e.message === 'runtime.run_with_advisor')
      ?.details as Record<string, unknown>;
    expect(telemetry).toBeDefined();
    expect(telemetry.mode).toBe('custom');
    expect(telemetry.advisor_iterations).toBe(1);
    expect(telemetry.advisor_model).toBe('claude-opus-4-7');
    expect(telemetry.beta_header_sent).toBe(true);
    expect(telemetry.disabled_by_env).toBe(false);
  });

  test('advisor=none produces telemetry with advisor_iterations=0 and no advisor model', async () => {
    const bundle = await buildBundleFromCanonicalFlow();
    const { events } = await synthesizeWithMode(bundle, 'none');
    const telemetry = events.find((e) => e.message === 'runtime.run_with_advisor')
      ?.details as Record<string, unknown>;
    expect(telemetry).toBeDefined();
    expect(telemetry.mode).toBe('none');
    expect(telemetry.advisor_iterations).toBe(0);
    expect(telemetry.advisor_model).toBeNull();
    expect(telemetry.beta_header_sent).toBe(false);
  });
});
