import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evidenceAssemble,
  type EvidenceMaterializeResult,
} from '../../src/services/evidence-assembler.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import {
  createEvidencePlan,
  createRecommendedEvidencePlan,
} from '../../src/conductor/evidence-plan.ts';
import { applyEvidenceOverrides } from '../../src/conductor/evidence-overrides.ts';
import type {
  RetrievalIndexV1,
  EvidencePlanV1,
  IntentCaptureV1,
  IntentRestatementV1,
  EvidenceBundleV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Temp directory and store setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;
let repoDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `assembler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  repoDir = join(tmpDir, 'repo');
  await mkdir(repoDir, { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MAIN_TS_CONTENT = `// main.ts
import { init } from './init';

const config = { port: 3000 };

function main() {
  console.log('Starting server...');
  init(config);
  console.log('Server started on port', config.port);
}

function helper() {
  return 42;
}

export { main, helper };
`;

const UTILS_TS_CONTENT = `// utils.ts
export function formatDate(d: Date): string {
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}
`;

async function setupRepoFiles() {
  const srcDir = join(repoDir, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'main.ts'), MAIN_TS_CONTENT, 'utf-8');
  await writeFile(join(srcDir, 'utils.ts'), UTILS_TS_CONTENT, 'utf-8');
}

function makeIndex(): RetrievalIndexV1 {
  return {
    artifact_type: 'piorx/retrieval-index@1',
    artifact_id: 'ri_test',
    intent_capture_id: 'ic_test',
    intent_restatement_id: 'ir_test',
    intent_spec_id: null,
    query: 'understand server startup',
    confidence: 'high',
    strategy_summary: '',
    scout_terms: [],
    files: [
      {
        file_id: 'f1',
        path: join(repoDir, 'src/main.ts'),
        why_relevant: 'entry point',
        file_summary: 'Main application entry point',
        ast_skeleton: ['function main()', 'function helper()'],
        recommended_expansion: 'span',
        expansion_reason: 'contains startup logic',
        selection_tier: 'selected',
        selection_reason: '',
        default_evidence_mode: 'summary',
        symbols: [
          {
            symbol_id: 's1',
            kind: 'function',
            name: 'main',
            start: 6,
            count: 5,
            summary: 'starts the server',
            role_in_system: 'entrypoint',
            depends_on: [],
            used_by: [],
            relevance: 'high',
            change_likelihood: 'medium',
            expansion_priority: 'high',
            recommended_expansion: 'span',
            expansion_reason: 'startup logic',
            selected_by_default: false,
            default_neighbor_lines: 0,
            selection_reason: '',
          },
          {
            symbol_id: 's2',
            kind: 'function',
            name: 'helper',
            start: 12,
            count: 3,
            summary: 'returns 42',
            role_in_system: 'utility',
            depends_on: [],
            used_by: [],
            relevance: 'low',
            change_likelihood: 'low',
            expansion_priority: 'low',
            recommended_expansion: 'none',
            expansion_reason: '',
            selected_by_default: false,
            default_neighbor_lines: 0,
            selection_reason: '',
          },
        ],
      },
      {
        file_id: 'f2',
        path: join(repoDir, 'src/utils.ts'),
        why_relevant: 'utility helpers',
        file_summary: 'Shared utility functions',
        ast_skeleton: ['function formatDate()', 'function parseDate()'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'selected',
        selection_reason: '',
        default_evidence_mode: 'summary',
        symbols: [
          {
            symbol_id: 's3',
            kind: 'function',
            name: 'formatDate',
            start: 2,
            count: 3,
            summary: 'formats dates',
            role_in_system: 'utility',
            depends_on: [],
            used_by: [],
            relevance: 'low',
            change_likelihood: 'low',
            expansion_priority: 'low',
            recommended_expansion: 'none',
            expansion_reason: '',
            selected_by_default: false,
            default_neighbor_lines: 0,
            selection_reason: '',
          },
        ],
      },
    ],
    cross_file_findings: ['main imports init module'],
    gaps: ['Missing init module details'],
    followup_queries: ['init module implementation'],
    recommended_evidence: {
      files: [],
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    },
  };
}

function makePlan(index: RetrievalIndexV1, overrides?: Partial<EvidencePlanV1>): EvidencePlanV1 {
  return {
    artifact_type: 'piorx/evidence-plan@1',
    artifact_id: 'plan_test',
    retrieval_index: {
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: index.artifact_id,
    },
    selection: {
      files: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 0 }],
        },
      ],
      include_cross_file_findings: true,
      include_gaps: false,
      include_followup_queries: false,
    },
    assembly_options: {
      max_total_lines: 2000,
      max_estimated_tokens: 20000,
      dedupe_overlapping_spans: true,
      span_merge_strategy: 'merge_if_overlapping',
    },
    prompt_sections: {
      include_intent_context: true,
      include_structural_context: true,
      include_raw_evidence: true,
    },
    target_task: {
      type: 'analysis-report',
      task_label: 'analyze startup',
    },
    ...overrides,
  };
}

async function seedArtifacts(index: RetrievalIndexV1, plan: EvidencePlanV1) {
  const capture: IntentCaptureV1 = {
    artifact_type: 'piorx/intent-capture@1',
    artifact_id: 'ic_test',
    user_intent_verbatim: 'I want to understand server startup.',
    cleaned_user_intent: 'I want to understand server startup.',
    tagged_files: [],
    timestamp: '2026-04-09T00:00:00Z',
  };
  const restatement: IntentRestatementV1 = {
    artifact_type: 'piorx/intent-restatement@1',
    artifact_id: 'ir_test',
    intent_capture_id: 'ic_test',
    user_intent_verbatim: 'I want to understand server startup.',
    restated_intent: 'You want to understand how the server starts up.',
    approved: true,
    expand_requested: false,
    approval_turns: 1,
  };
  await store.put(capture);
  await store.put(restatement);
  await store.put(index);
  await store.put(plan);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evidence assembler — materialize mode', () => {
  it('produces a valid evidence-bundle-v1', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('success');
    expect(result.evidence_bundle_id).toBeTruthy();

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle).not.toBeNull();
    const validation = validateArtifact(bundle!);
    expect(validation.valid).toBe(true);
  });

  it('same plan + retrieval + repo produces byte-identical bundle', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const r1 = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const r2 = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const b1 = await store.get('piorx/evidence-bundle@1', r1.evidence_bundle_id!);
    const b2 = await store.get('piorx/evidence-bundle@1', r2.evidence_bundle_id!);

    // Compare everything except artifact_id (which is unique per call)
    const normalize = (b: EvidenceBundleV1) => {
      const { artifact_id, ...rest } = b;
      return rest;
    };
    expect(JSON.stringify(normalize(b1!))).toBe(JSON.stringify(normalize(b2!)));
  });

  it('includes intent context from stored artifacts', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.intent_context.user_intent_verbatim).toBe(
      'I want to understand server startup.',
    );
    expect(bundle!.intent_context.approved_restated_intent).toBe(
      'You want to understand how the server starts up.',
    );
    expect(bundle!.intent_context.intent_spec_id).toBeNull();
  });

  it('includes AST skeleton when requested', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    const f1Struct = bundle!.structural_context.files[0]!;
    expect(f1Struct.ast_skeleton).toEqual(['function main()', 'function helper()']);
  });

  it('includes retriever summary when requested', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.structural_context.files[0]!.file_summary).toBe('Main application entry point');
  });

  it('resolves span content from disk', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.raw_evidence.length).toBeGreaterThan(0);
    const span = bundle!.raw_evidence[0]!;
    expect(span.kind).toBe('span');
    expect(span.start).toBe(6);
    expect(span.content).toContain('main');
  });

  it('includes cross-file findings when selected', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.structural_context.cross_file_findings).toEqual(['main imports init module']);
  });

  it('excludes cross-file findings when not selected', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        ...makePlan(index).selection,
        include_cross_file_findings: false,
      },
    });
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.structural_context.cross_file_findings).toEqual([]);
  });

  it('refuses unknown file_id in plan', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'f_nonexistent',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('error');
    expect(result.message).toContain('Unknown file_id');
  });

  it('refuses unknown symbol_id in plan spans', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 'nonexistent', include_span: true, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('error');
    expect(result.message).toContain('Unknown symbol_id');
  });

  it('bundle contents match plan — no widening', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    // Only request f1 with s1 span — f2 should not appear in raw evidence
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    // Only f1 should be in structural context (plan only lists f1)
    expect(bundle!.structural_context.files).toHaveLength(1);
    expect(bundle!.structural_context.files[0]!.path).toContain('main.ts');

    // Raw evidence should only contain f1 spans
    for (const ev of bundle!.raw_evidence) {
      expect(ev.path).toContain('main.ts');
    }
  });

  it('handles include_entire_file', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'f2',
            include_ast_skeleton: false,
            include_retriever_summary: true,
            include_entire_file: true,
            spans: [],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('success');
    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.raw_evidence).toHaveLength(1);
    expect(bundle!.raw_evidence[0]!.kind).toBe('full_file');
    expect(bundle!.raw_evidence[0]!.content).toContain('formatDate');
    expect(bundle!.stats.full_files).toBe(1);
  });

  it('returns error for missing plan', async () => {
    const result = (await evidenceAssemble(
      { mode: 'materialize', retrieval_index_id: 'ri_x', evidence_plan_id: 'plan_x' },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('error');
    expect(result.message).toContain('Evidence plan not found');
  });

  it('returns error for missing retrieval index', async () => {
    const index = makeIndex();
    const plan = makePlan(index);
    await store.put(plan);

    const result = (await evidenceAssemble(
      { mode: 'materialize', retrieval_index_id: 'ri_missing', evidence_plan_id: plan.artifact_id },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('error');
    expect(result.message).toContain('Retrieval index not found');
  });

  it('returns error when plan references wrong index', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      retrieval_index: { artifact_type: 'piorx/retrieval-index@1', artifact_id: 'ri_wrong' },
    });
    await store.put(index);
    await store.put(plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('error');
    expect(result.message).toContain('does not match');
  });

  it('computes stats correctly', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.stats.files).toBe(1);
    expect(bundle!.stats.spans).toBeGreaterThan(0);
    expect(bundle!.stats.full_files).toBe(0);
    expect(bundle!.stats.total_lines).toBeGreaterThan(0);
    expect(bundle!.stats.estimated_tokens).toBeGreaterThan(0);
  });

  it('materializes a retriever-authored default plan from createRecommendedEvidencePlan', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    // Put f2 into reserve so summary-for-all would include it but the
    // recommendation-derived plan should not.
    index.files[1]!.selection_tier = 'reserve';
    index.files[1]!.default_evidence_mode = 'exclude';
    // f1 is the only recommended file, with one selected symbol span.
    index.recommended_evidence = {
      files: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 1 }],
        },
      ],
      include_cross_file_findings: true,
      include_gaps: false,
      include_followup_queries: false,
    };
    index.files[0]!.symbols[0]!.selected_by_default = true;
    index.files[0]!.symbols[0]!.default_neighbor_lines = 1;

    const plan = createRecommendedEvidencePlan(index);
    await seedArtifacts(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('success');
    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle).not.toBeNull();
    // Reserve file must not appear in the materialized bundle.
    expect(bundle!.structural_context.files).toHaveLength(1);
    expect(bundle!.structural_context.files[0]!.path).toContain('main.ts');
    for (const ev of bundle!.raw_evidence) {
      expect(ev.path).toContain('main.ts');
    }
  });

  it('retriever-authored default plan is narrower than the legacy summary-everything baseline', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    // Mark f2 reserve-only so the retriever excludes it from the default plan,
    // but the legacy "summary for every file" heuristic still includes it.
    index.files[1]!.selection_tier = 'reserve';
    index.files[1]!.default_evidence_mode = 'exclude';
    index.recommended_evidence = {
      files: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 0 }],
        },
      ],
      include_cross_file_findings: true,
      include_gaps: false,
      include_followup_queries: false,
    };
    index.files[0]!.symbols[0]!.selected_by_default = true;
    index.files[0]!.symbols[0]!.default_neighbor_lines = 0;

    const recommendedPlan = createRecommendedEvidencePlan(index);

    // Legacy baseline: summary+AST for every index file, the pre-agentic
    // heuristic default before the retriever authored its own scope.
    const legacyPlan = createEvidencePlan({
      retrieval_index: index,
      file_controls: index.files.map((f) => ({
        file_id: f.file_id,
        include_retriever_summary: true,
        include_ast_skeleton: true,
      })),
    });

    // Narrowness invariant at the plan level.
    expect(recommendedPlan.selection.files.length).toBeLessThan(legacyPlan.selection.files.length);
    const recommendedIds = new Set(recommendedPlan.selection.files.map((f) => f.file_id));
    expect(recommendedIds.has('f2')).toBe(false);

    // And at the materialized-bundle level: the retriever-authored default
    // produces a strictly smaller bundle than the legacy baseline.
    await seedArtifacts(index, recommendedPlan);
    const legacyPlanStored: EvidencePlanV1 = { ...legacyPlan, artifact_id: 'plan_legacy_test' };
    await store.put(legacyPlanStored);

    const recommendedResult = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: recommendedPlan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;
    const legacyResult = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: legacyPlanStored.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;
    expect(recommendedResult.status).toBe('success');
    expect(legacyResult.status).toBe('success');

    const recommendedBundle = await store.get(
      'piorx/evidence-bundle@1',
      recommendedResult.evidence_bundle_id!,
    );
    const legacyBundle = await store.get(
      'piorx/evidence-bundle@1',
      legacyResult.evidence_bundle_id!,
    );
    expect(recommendedBundle!.structural_context.files.length).toBeLessThan(
      legacyBundle!.structural_context.files.length,
    );
    for (const f of recommendedBundle!.structural_context.files) {
      expect(f.path).toContain('main.ts');
    }
  });
});

describe('evidence assembler — override semantics regression', () => {
  it('set_file_mode to summary on a file with existing spans materializes no raw span evidence', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    // Retriever-authored default: f1 in spans mode with s1 active.
    index.files[0]!.default_evidence_mode = 'spans';
    index.files[0]!.symbols[0]!.selected_by_default = true;
    index.recommended_evidence = {
      files: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 0 }],
        },
      ],
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    };

    const basePlan = createRecommendedEvidencePlan(index);
    expect(basePlan.selection.files[0]!.spans.length).toBeGreaterThan(0);

    const { plan: adjusted } = applyEvidenceOverrides({
      plan: basePlan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'summary' }],
    });
    await seedArtifacts(index, adjusted);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: adjusted.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('success');
    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    expect(bundle!.raw_evidence.filter((e) => e.kind === 'span')).toHaveLength(0);
    expect(bundle!.raw_evidence).toHaveLength(0);
    expect(bundle!.stats.spans).toBe(0);
    expect(bundle!.structural_context.files[0]!.file_summary).toBe('Main application entry point');
    expect(bundle!.structural_context.files[0]!.ast_skeleton).toEqual([]);
  });

  it('set_file_mode to exclude on a file with existing spans removes the file from the bundle entirely', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    // Promote both files into the default plan so we can assert f1 drops out.
    index.files[0]!.default_evidence_mode = 'spans';
    index.files[0]!.symbols[0]!.selected_by_default = true;
    index.recommended_evidence = {
      files: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 0 }],
        },
        {
          file_id: 'f2',
          include_ast_skeleton: false,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [],
        },
      ],
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    };

    const basePlan = createRecommendedEvidencePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan: basePlan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'exclude' }],
    });
    await seedArtifacts(index, adjusted);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: adjusted.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('success');
    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    const paths = bundle!.structural_context.files.map((f) => f.path);
    for (const p of paths) {
      expect(p).not.toContain('main.ts');
    }
    for (const ev of bundle!.raw_evidence) {
      expect(ev.path).not.toContain('main.ts');
    }
    expect(bundle!.structural_context.files).toHaveLength(1);
    expect(bundle!.structural_context.files[0]!.path).toContain('utils.ts');
  });

  it('promote_file mode=spans seeds concrete span evidence from retrieval metadata', async () => {
    await setupRepoFiles();
    const index = makeIndex();
    // Reserve f2 so the default plan doesn't include it, then promote it in
    // spans mode. selected_by_default on s3 seeds the concrete span.
    index.files[1]!.selection_tier = 'reserve';
    index.files[1]!.default_evidence_mode = 'exclude';
    index.files[1]!.symbols[0]!.selected_by_default = true;
    index.files[1]!.symbols[0]!.default_neighbor_lines = 1;
    index.recommended_evidence = {
      files: [],
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    };

    const basePlan = createRecommendedEvidencePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan: basePlan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'f2', mode: 'spans' }],
    });
    await seedArtifacts(index, adjusted);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: adjusted.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('success');
    const bundle = await store.get('piorx/evidence-bundle@1', result.evidence_bundle_id!);
    const utilsSpans = bundle!.raw_evidence.filter(
      (e) => e.kind === 'span' && e.path.includes('utils.ts'),
    );
    expect(utilsSpans.length).toBeGreaterThan(0);
    expect(utilsSpans[0]!.content).toContain('formatDate');
  });
});
