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

import { createConfig } from '../../src/runtime/config.ts';
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
      'retrieval-index-v1',
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
      'retrieval-index-v1',
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
      'evidence-bundle-v1',
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
