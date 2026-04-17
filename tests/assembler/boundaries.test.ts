/**
 * Boundary tests for the evidence assembler.
 *
 * Covers budget enforcement, neighbor/overlap behavior, and negative
 * selection boundary cases from the Phase 4 contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evidenceAssemble,
  type EvidenceMaterializeResult,
  type EvidencePreviewResult,
} from '../../src/services/evidence-assembler.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import { checkBudget } from '../../src/util/budget.ts';
import {
  expandNeighborLines,
  mergeOverlappingSpans,
  resolveSymbolToSpan,
  SpanResolutionError,
  type ResolvedSpan,
} from '../../src/util/spans.ts';
import type {
  RetrievalIndexV1,
  EvidencePlanV1,
  IntentCaptureV1,
  IntentRestatementV1,
  EvidenceBundleV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;
let repoDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `bnd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  repoDir = join(tmpDir, 'repo');
  await mkdir(join(repoDir, 'src'), { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function generateLargeFile(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join('\n');
}

async function setupFiles() {
  await writeFile(join(repoDir, 'src/large.ts'), generateLargeFile(100), 'utf-8');
  await writeFile(join(repoDir, 'src/small.ts'), 'const x = 1;\nconst y = 2;\n', 'utf-8');
}

function makeIndex(): RetrievalIndexV1 {
  return {
    artifact_type: 'retrieval-index-v1',
    artifact_id: 'ri_bnd',
    intent_capture_id: 'ic_bnd',
    intent_restatement_id: 'ir_bnd',
    intent_spec_id: null,
    query: 'boundary test',
    confidence: 'high',
    strategy_summary: '',
    scout_terms: [],
    files: [
      {
        file_id: 'fl',
        path: join(repoDir, 'src/large.ts'),
        why_relevant: 'large file',
        file_summary: 'A large file with many lines',
        ast_skeleton: ['// generated file'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'selected',
        selection_reason: '',
        default_evidence_mode: 'summary',
        symbols: [
          {
            symbol_id: 'sl1',
            kind: 'const',
            name: 'blockA',
            start: 10,
            count: 20,
            summary: 'block A',
            role_in_system: 'test',
            depends_on: [],
            used_by: [],
            relevance: 'high',
            change_likelihood: 'low',
            expansion_priority: 'high',
            recommended_expansion: 'none',
            expansion_reason: '',
            selected_by_default: false,
            default_neighbor_lines: 0,
            selection_reason: '',
          },
          {
            symbol_id: 'sl2',
            kind: 'const',
            name: 'blockB',
            start: 25,
            count: 10,
            summary: 'block B',
            role_in_system: 'test',
            depends_on: [],
            used_by: [],
            relevance: 'medium',
            change_likelihood: 'low',
            expansion_priority: 'medium',
            recommended_expansion: 'none',
            expansion_reason: '',
            selected_by_default: false,
            default_neighbor_lines: 0,
            selection_reason: '',
          },
          {
            symbol_id: 'sl3',
            kind: 'const',
            name: 'blockC',
            start: 60,
            count: 15,
            summary: 'block C',
            role_in_system: 'test',
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
        file_id: 'fs',
        path: join(repoDir, 'src/small.ts'),
        why_relevant: 'small file',
        file_summary: 'Two constants',
        ast_skeleton: ['const x', 'const y'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'selected',
        selection_reason: '',
        default_evidence_mode: 'summary',
        symbols: [
          {
            symbol_id: 'ss1',
            kind: 'const',
            name: 'x',
            start: 1,
            count: 1,
            summary: 'x constant',
            role_in_system: 'test',
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
    cross_file_findings: ['large and small are independent'],
    gaps: [],
    followup_queries: [],
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
    artifact_type: 'evidence-plan-v1',
    artifact_id: 'plan_bnd',
    retrieval_index: { artifact_type: 'retrieval-index-v1', artifact_id: index.artifact_id },
    selection: {
      files: [
        {
          file_id: 'fl',
          include_ast_skeleton: false,
          include_retriever_summary: false,
          include_entire_file: false,
          spans: [{ symbol_id: 'sl1', include_span: true, neighbor_lines: 0 }],
        },
      ],
      include_cross_file_findings: false,
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
    target_task: { type: 'analysis-report', task_label: 'boundary test' },
    ...overrides,
  };
}

async function seedAll(index: RetrievalIndexV1, plan: EvidencePlanV1) {
  const capture: IntentCaptureV1 = {
    artifact_type: 'intent-capture-v1',
    artifact_id: 'ic_bnd',
    user_intent_verbatim: 'boundary test',
    cleaned_user_intent: 'boundary test',
    tagged_files: [],
    timestamp: '2026-04-09T00:00:00Z',
  };
  const restatement: IntentRestatementV1 = {
    artifact_type: 'intent-restatement-v1',
    artifact_id: 'ir_bnd',
    intent_capture_id: 'ic_bnd',
    user_intent_verbatim: 'boundary test',
    restated_intent: 'boundary test restated',
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
// Budget enforcement
// ---------------------------------------------------------------------------

describe('budget enforcement', () => {
  it('preview surfaces over-budget reasons for max_total_lines', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      assembly_options: {
        max_total_lines: 5, // Very low budget
        max_estimated_tokens: 100000,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
      selection: {
        files: [
          {
            file_id: 'fl',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 'sl1', include_span: true, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'preview',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidencePreviewResult;

    expect(result.status).toBe('success');
    expect(result.over_budget_reasons.length).toBeGreaterThan(0);
    expect(result.over_budget_reasons.some((r) => r.field === 'max_total_lines')).toBe(true);
  });

  it('preview surfaces over-budget for max_estimated_tokens', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      assembly_options: {
        max_total_lines: 100000,
        max_estimated_tokens: 1, // Very low token budget
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'preview',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidencePreviewResult;

    expect(result.status).toBe('success');
    expect(result.over_budget_reasons.some((r) => r.field === 'max_estimated_tokens')).toBe(true);
  });

  it('checkBudget never silently prunes — returns structured reasons', () => {
    const index = makeIndex();
    const plan = makePlan(index, {
      assembly_options: {
        max_total_lines: 1,
        max_estimated_tokens: 1,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
    });
    const result = checkBudget(plan, index);
    expect(result.within_budget).toBe(false);
    expect(result.over_budget_reasons.length).toBeGreaterThan(0);
    for (const r of result.over_budget_reasons) {
      expect(r).toHaveProperty('field');
      expect(r).toHaveProperty('limit');
      expect(r).toHaveProperty('estimated');
    }
  });
});

// ---------------------------------------------------------------------------
// Neighbor-line expansion
// ---------------------------------------------------------------------------

describe('neighbor-line expansion boundaries', () => {
  it('neighbor_lines=0 returns exact span', () => {
    const span: ResolvedSpan = { file_id: 'f', path: '/f', start: 10, count: 5 };
    const expanded = expandNeighborLines(span, 0);
    expect(expanded.start).toBe(10);
    expect(expanded.count).toBe(5);
  });

  it('clamps start to minimum 1', () => {
    const span: ResolvedSpan = { file_id: 'f', path: '/f', start: 2, count: 3 };
    const expanded = expandNeighborLines(span, 10);
    expect(expanded.start).toBe(1);
  });

  it('expands symmetrically', () => {
    const span: ResolvedSpan = { file_id: 'f', path: '/f', start: 20, count: 5 };
    const expanded = expandNeighborLines(span, 3);
    expect(expanded.start).toBe(17);
    expect(expanded.count).toBe(11); // 5 + 3 + 3
  });

  it('materializes neighbor lines from actual file content', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'fl',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 'sl1', include_span: true, neighbor_lines: 3 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('evidence-bundle-v1', result.evidence_bundle_id!);
    const ev = bundle!.raw_evidence[0]!;
    // Original span: start=10, count=20. With neighbor=3: start=7, count=26
    expect(ev.start).toBe(7);
    expect(ev.count).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// Overlap merging
// ---------------------------------------------------------------------------

describe('overlap merge boundaries', () => {
  it('adjacent spans are merged', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f', path: '/f', start: 1, count: 5 },
      { file_id: 'f', path: '/f', start: 6, count: 5 },
    ];
    const merged = mergeOverlappingSpans(spans);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.start).toBe(1);
    expect(merged[0]!.count).toBe(10);
  });

  it('overlapping spans are merged', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f', path: '/f', start: 1, count: 8 },
      { file_id: 'f', path: '/f', start: 5, count: 10 },
    ];
    const merged = mergeOverlappingSpans(spans);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.start).toBe(1);
    expect(merged[0]!.count).toBe(14);
  });

  it('non-overlapping spans in same file stay separate', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f', path: '/f', start: 1, count: 3 },
      { file_id: 'f', path: '/f', start: 10, count: 3 },
    ];
    const merged = mergeOverlappingSpans(spans);
    expect(merged).toHaveLength(2);
  });

  it('spans in different files never merge', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f1', path: '/f1', start: 1, count: 10 },
      { file_id: 'f2', path: '/f2', start: 1, count: 10 },
    ];
    const merged = mergeOverlappingSpans(spans);
    expect(merged).toHaveLength(2);
  });

  it('dedupe_overlapping_spans=false keeps separate spans in bundle', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      assembly_options: {
        max_total_lines: 2000,
        max_estimated_tokens: 20000,
        dedupe_overlapping_spans: false,
        span_merge_strategy: 'merge_if_overlapping',
      },
      selection: {
        files: [
          {
            file_id: 'fl',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [
              { symbol_id: 'sl1', include_span: true, neighbor_lines: 5 },
              { symbol_id: 'sl2', include_span: true, neighbor_lines: 5 },
            ],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('evidence-bundle-v1', result.evidence_bundle_id!);
    // Without dedup, we expect 2 separate evidence entries
    expect(bundle!.raw_evidence).toHaveLength(2);
  });

  it('dedupe_overlapping_spans=true merges overlapping spans in bundle', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      assembly_options: {
        max_total_lines: 2000,
        max_estimated_tokens: 20000,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
      selection: {
        files: [
          {
            file_id: 'fl',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [
              { symbol_id: 'sl1', include_span: true, neighbor_lines: 5 },
              { symbol_id: 'sl2', include_span: true, neighbor_lines: 5 },
            ],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('evidence-bundle-v1', result.evidence_bundle_id!);
    // sl1 (10-29)+5 = 5-34 and sl2 (25-34)+5 = 20-39 overlap => merged to one
    expect(bundle!.raw_evidence).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Negative selection boundaries
// ---------------------------------------------------------------------------

describe('negative selection boundaries', () => {
  it('disabled spans (include_span=false) produce no raw evidence', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'fl',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 'sl1', include_span: false, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('evidence-bundle-v1', result.evidence_bundle_id!);
    expect(bundle!.raw_evidence).toHaveLength(0);
  });

  it('empty spans array produces no raw evidence', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'fl',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            spans: [],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('evidence-bundle-v1', result.evidence_bundle_id!);
    expect(bundle!.raw_evidence).toHaveLength(0);
    // But structural context should still have skeleton and summary
    expect(bundle!.structural_context.files[0]!.ast_skeleton.length).toBeGreaterThan(0);
    expect(bundle!.structural_context.files[0]!.file_summary).toBeTruthy();
  });

  it('assembler does not include content not in plan', async () => {
    await setupFiles();
    const index = makeIndex();
    // Only include fs (small.ts) — fl (large.ts) should not appear
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'fs',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            spans: [{ symbol_id: 'ss1', include_span: true, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('evidence-bundle-v1', result.evidence_bundle_id!);
    // Only small.ts should be present
    expect(bundle!.structural_context.files).toHaveLength(1);
    expect(bundle!.structural_context.files[0]!.path).toContain('small.ts');
    for (const ev of bundle!.raw_evidence) {
      expect(ev.path).toContain('small.ts');
    }
  });

  it('resolveSymbolToSpan throws on unknown file_id', () => {
    const index = makeIndex();
    expect(() => resolveSymbolToSpan(index, 'unknown_file', 'sl1')).toThrow(SpanResolutionError);
  });

  it('resolveSymbolToSpan throws on unknown symbol_id', () => {
    const index = makeIndex();
    expect(() => resolveSymbolToSpan(index, 'fl', 'unknown_sym')).toThrow(SpanResolutionError);
  });

  it('file not found on disk returns error', async () => {
    // Don't set up files — they won't exist
    const index = makeIndex();
    const plan = makePlan(index);
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    expect(result.status).toBe('error');
    expect(result.message).toContain('File not found');
  });

  it('cross-file findings excluded when not selected', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index, {
      selection: {
        files: [
          {
            file_id: 'fl',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 'sl1', include_span: true, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    await seedAll(index, plan);

    const result = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const bundle = await store.get('evidence-bundle-v1', result.evidence_bundle_id!);
    expect(bundle!.structural_context.cross_file_findings).toEqual([]);
  });
});
