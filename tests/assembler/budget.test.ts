import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  estimateBudget,
  estimateRecommendedBudget,
  estimateTokensFromLines,
  checkBudget,
} from '../../src/util/budget.ts';
import { SpanResolutionError } from '../../src/util/spans.ts';
import { evidenceAssemble } from '../../src/services/evidence-assembler.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import type { EvidencePlanV1, RetrievalIndexV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeIndex(overrides?: Partial<RetrievalIndexV1>): RetrievalIndexV1 {
  return {
    artifact_type: 'piorx/retrieval-index@1',
    artifact_id: 'ri_test',
    intent_capture_id: 'ic_1',
    intent_restatement_id: 'ir_1',
    intent_spec_id: null,
    query: 'test query',
    confidence: 'high',
    strategy_summary: '',
    scout_terms: [],
    files: [
      {
        file_id: 'f1',
        path: '/repo/src/main.ts',
        why_relevant: 'entry point',
        file_summary: 'Main application entry.\nSets up the server.',
        ast_skeleton: ['function main()', 'function init()', 'const config = ...'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'selected',
        selection_reason: '',
        default_evidence_mode: 'summary',
        symbols: [
          {
            symbol_id: 's1',
            kind: 'function',
            name: 'main',
            start: 10,
            count: 20,
            summary: 'entry point',
            role_in_system: 'entrypoint',
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
            symbol_id: 's2',
            kind: 'function',
            name: 'init',
            start: 35,
            count: 15,
            summary: 'initializer',
            role_in_system: 'setup',
            depends_on: [],
            used_by: ['s1'],
            relevance: 'medium',
            change_likelihood: 'medium',
            expansion_priority: 'medium',
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
        path: '/repo/src/utils.ts',
        why_relevant: 'utility functions',
        file_summary: 'Utilities',
        ast_skeleton: ['function formatDate()'],
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
            start: 5,
            count: 8,
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
    cross_file_findings: ['main.ts imports from utils.ts', 'Shared config pattern'],
    gaps: ['No test files found'],
    followup_queries: ['Search for test setup', 'Check for CI config'],
    recommended_evidence: {
      files: [],
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    },
    ...overrides,
  };
}

function makePlan(overrides?: Partial<EvidencePlanV1>): EvidencePlanV1 {
  return {
    artifact_type: 'piorx/evidence-plan@1',
    artifact_id: 'plan_test',
    retrieval_index: {
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: 'ri_test',
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
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    },
    assembly_options: {
      max_total_lines: 1000,
      max_estimated_tokens: 10000,
      dedupe_overlapping_spans: true,
      span_merge_strategy: 'merge_if_overlapping',
    },
    prompt_sections: {
      include_intent_context: true,
      include_structural_context: true,
      include_raw_evidence: true,
    },
    target_task: { type: 'analysis-report', task_label: 'test' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// estimateTokensFromLines
// ---------------------------------------------------------------------------

describe('estimateTokensFromLines', () => {
  it('produces a positive integer for positive lines', () => {
    const tokens = estimateTokensFromLines(100);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it('returns 0 for 0 lines', () => {
    expect(estimateTokensFromLines(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateBudget
// ---------------------------------------------------------------------------

describe('estimateBudget', () => {
  const index = makeIndex();

  it('estimates skeleton lines from AST skeleton length', () => {
    const plan = makePlan();
    const est = estimateBudget(plan, index);
    const f1 = est.file_estimates.find((f) => f.file_id === 'f1')!;
    // AST skeleton has 3 entries
    expect(f1.skeleton_lines).toBe(3);
  });

  it('estimates summary lines from summary text', () => {
    const plan = makePlan();
    const est = estimateBudget(plan, index);
    const f1 = est.file_estimates.find((f) => f.file_id === 'f1')!;
    // Summary is 2 lines ("Main application entry.\nSets up the server.")
    expect(f1.summary_lines).toBe(2);
  });

  it('estimates span lines from symbol start/count', () => {
    const plan = makePlan();
    const est = estimateBudget(plan, index);
    const f1 = est.file_estimates.find((f) => f.file_id === 'f1')!;
    // s1: start=10, count=20, no neighbor expansion
    expect(f1.span_lines).toBe(20);
  });

  it('applies neighbor line expansion to span estimates', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 3 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    const est = estimateBudget(plan, index);
    const f1 = est.file_estimates.find((f) => f.file_id === 'f1')!;
    // s1: start=10, count=20. With 3 neighbor: start=7, end=32, count=26
    expect(f1.span_lines).toBe(26);
  });

  it('deduplicates overlapping spans when dedupe is true', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [
              { symbol_id: 's1', include_span: true, neighbor_lines: 10 },
              { symbol_id: 's2', include_span: true, neighbor_lines: 10 },
            ],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
      assembly_options: {
        max_total_lines: 5000,
        max_estimated_tokens: 50000,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
    });
    const est = estimateBudget(plan, index);
    const f1 = est.file_estimates.find((f) => f.file_id === 'f1')!;
    // Without merge: s1 expanded (1-39=39 lines) + s2 expanded (25-59=35 lines) = 74
    // With merge: 1-59 = 59 lines
    expect(f1.span_lines).toBeLessThan(74); // merged
    expect(f1.span_lines).toBe(59);
  });

  it('does not deduplicate when dedupe is false', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [
              { symbol_id: 's1', include_span: true, neighbor_lines: 10 },
              { symbol_id: 's2', include_span: true, neighbor_lines: 10 },
            ],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
      assembly_options: {
        max_total_lines: 5000,
        max_estimated_tokens: 50000,
        dedupe_overlapping_spans: false,
        span_merge_strategy: 'none',
      },
    });
    const est = estimateBudget(plan, index);
    const f1 = est.file_estimates.find((f) => f.file_id === 'f1')!;
    // s1: start=1 (clamped), end=39, count=39
    // s2: start=25, end=59, count=35
    expect(f1.span_lines).toBe(39 + 35);
  });

  it('skips disabled spans (include_span=false)', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 's1', include_span: false, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    const est = estimateBudget(plan, index);
    expect(est.total_lines).toBe(0);
  });

  it('includes cross_file_findings lines when enabled', () => {
    const plan = makePlan({
      selection: {
        files: [],
        include_cross_file_findings: true,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    const est = estimateBudget(plan, index);
    expect(est.cross_file_lines).toBe(2); // 2 findings in fixture
  });

  it('includes gaps and followup lines when enabled', () => {
    const plan = makePlan({
      selection: {
        files: [],
        include_cross_file_findings: false,
        include_gaps: true,
        include_followup_queries: true,
      },
    });
    const est = estimateBudget(plan, index);
    expect(est.gaps_lines).toBe(1);
    expect(est.followup_lines).toBe(2);
  });

  it('sums everything into total_lines', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: true,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: true,
        include_gaps: true,
        include_followup_queries: true,
      },
    });
    const est = estimateBudget(plan, index);
    // skeleton=3, span=20, cross=2, gaps=1, followup=2 = 28
    expect(est.total_lines).toBe(28);
    expect(est.estimated_tokens).toBe(estimateTokensFromLines(28));
  });

  it('throws SpanResolutionError for unknown file_id', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f_unknown',
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
    expect(() => estimateBudget(plan, index)).toThrow(SpanResolutionError);
  });

  it('throws SpanResolutionError for unknown symbol_id in span', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [{ symbol_id: 's_bad', include_span: true, neighbor_lines: 0 }],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    expect(() => estimateBudget(plan, index)).toThrow(SpanResolutionError);
  });

  it('is deterministic across multiple calls', () => {
    const plan = makePlan();
    const est1 = estimateBudget(plan, index);
    const est2 = estimateBudget(plan, index);
    expect(est1).toEqual(est2);
  });

  it('estimates entire file using symbol ranges as proxy', () => {
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: true,
            spans: [],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    const est = estimateBudget(plan, index);
    const f1 = est.file_estimates.find((f) => f.file_id === 'f1')!;
    // Max symbol end = max(10+20-1, 35+15-1) = max(29, 49) = 49
    expect(f1.span_lines).toBe(49);
  });
});

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// estimateRecommendedBudget — retriever-authored default scope
// ---------------------------------------------------------------------------

describe('estimateRecommendedBudget', () => {
  function makeNarrowRecommendationIndex(): RetrievalIndexV1 {
    const base = makeIndex();
    // Mark f2 as reserve so summary-for-all would include it but the
    // retriever-authored default would not.
    base.files[1]!.selection_tier = 'reserve';
    base.files[1]!.default_evidence_mode = 'exclude';
    base.recommended_evidence = {
      files: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 2 }],
        },
      ],
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    };
    return base;
  }

  it('uses recommended_evidence.files and the recommended include flags', () => {
    const index = makeNarrowRecommendationIndex();
    const est = estimateRecommendedBudget(index);
    expect(est.file_estimates).toHaveLength(1);
    expect(est.file_estimates[0]!.file_id).toBe('f1');
    // Summary + ast skeleton plus expanded span
    expect(est.file_estimates[0]!.summary_lines).toBeGreaterThan(0);
    expect(est.file_estimates[0]!.skeleton_lines).toBe(3);
    // s1 spans lines 10..29 (20 lines); neighbor_lines=2 expands to 8..31 = 24 lines.
    expect(est.file_estimates[0]!.span_lines).toBe(24);
    // Cross-file/gaps/followup are off by recommendation
    expect(est.cross_file_lines).toBe(0);
    expect(est.gaps_lines).toBe(0);
    expect(est.followup_lines).toBe(0);
  });

  it('is materially narrower than a summary-for-all default across all retrieved files', () => {
    const index = makeNarrowRecommendationIndex();

    // Simulate the legacy summary-for-all default: every retrieved file gets
    // summary + ast skeleton + first-two-symbol spans.
    const legacyPlan: EvidencePlanV1 = {
      artifact_type: 'piorx/evidence-plan@1',
      artifact_id: 'plan_legacy',
      retrieval_index: {
        artifact_type: 'piorx/retrieval-index@1',
        artifact_id: index.artifact_id,
      },
      selection: {
        files: index.files.map((file) => ({
          file_id: file.file_id,
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: file.symbols.slice(0, 2).map((symbol) => ({
            symbol_id: symbol.symbol_id,
            include_span: true,
            neighbor_lines: 3,
          })),
        })),
        include_cross_file_findings: true,
        include_gaps: true,
        include_followup_queries: true,
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
      target_task: { type: 'analysis-report', task_label: 'legacy' },
    };
    const legacy = estimateBudget(legacyPlan, index);
    const recommended = estimateRecommendedBudget(index);

    expect(recommended.total_lines).toBeLessThan(legacy.total_lines);
    expect(recommended.estimated_tokens).toBeLessThan(legacy.estimated_tokens);
    expect(recommended.file_estimates.length).toBeLessThan(legacy.file_estimates.length);
  });

  it('respects assembly_options overrides', () => {
    const index = makeNarrowRecommendationIndex();
    const est = estimateRecommendedBudget(index, { max_total_lines: 42 });
    // The helper uses the provided overrides inside the synthetic plan; total
    // lines still reflect the recommendation scope, not the override.
    expect(est.total_lines).toBeGreaterThan(0);
    expect(est.total_lines).not.toBe(42);
  });

  it('is deterministic across calls', () => {
    const index = makeNarrowRecommendationIndex();
    const e1 = estimateRecommendedBudget(index);
    const e2 = estimateRecommendedBudget(index);
    expect(e1).toEqual(e2);
  });

  it('returns zero lines for an empty recommended_evidence', () => {
    const index = makeIndex(); // empty recommended_evidence by default
    const est = estimateRecommendedBudget(index);
    expect(est.total_lines).toBe(0);
    expect(est.file_estimates).toHaveLength(0);
  });
});

describe('checkBudget', () => {
  const index = makeIndex();

  it('reports within_budget when estimates fit', () => {
    const plan = makePlan(); // defaults: max_total_lines=1000, max_estimated_tokens=10000
    const result = checkBudget(plan, index);
    expect(result.within_budget).toBe(true);
    expect(result.over_budget_reasons).toHaveLength(0);
  });

  it('reports over_budget with structured reasons for lines', () => {
    const plan = makePlan({
      assembly_options: {
        max_total_lines: 5, // way too small
        max_estimated_tokens: 100000,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
    });
    const result = checkBudget(plan, index);
    expect(result.within_budget).toBe(false);
    expect(result.over_budget_reasons.length).toBeGreaterThanOrEqual(1);
    const lineReason = result.over_budget_reasons.find((r) => r.field === 'max_total_lines');
    expect(lineReason).toBeDefined();
    expect(lineReason!.limit).toBe(5);
    expect(lineReason!.estimated).toBeGreaterThan(5);
  });

  it('reports over_budget with structured reasons for tokens', () => {
    const plan = makePlan({
      assembly_options: {
        max_total_lines: 100000,
        max_estimated_tokens: 1, // way too small
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
    });
    const result = checkBudget(plan, index);
    expect(result.within_budget).toBe(false);
    const tokenReason = result.over_budget_reasons.find((r) => r.field === 'max_estimated_tokens');
    expect(tokenReason).toBeDefined();
  });

  it('can report both line and token over-budget simultaneously', () => {
    const plan = makePlan({
      assembly_options: {
        max_total_lines: 1,
        max_estimated_tokens: 1,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
    });
    const result = checkBudget(plan, index);
    expect(result.over_budget_reasons).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// evidenceAssemble preview integration
// ---------------------------------------------------------------------------

describe('evidenceAssemble preview mode', () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `pi-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    const config = createConfig(tmpDir);
    store = new ArtifactStore(config);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns success with estimates for valid plan and index', async () => {
    const index = makeIndex();
    const plan = makePlan();
    await store.put(index);
    await store.put(plan);

    const result = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_test' },
      store,
    );
    expect(result.status).toBe('success');
    expect('estimated_lines' in result && result.estimated_lines).toBeGreaterThan(0);
    expect('estimated_tokens' in result && result.estimated_tokens).toBeGreaterThan(0);
  });

  it('is deterministic across runs', async () => {
    const index = makeIndex();
    const plan = makePlan();
    await store.put(index);
    await store.put(plan);

    const r1 = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_test' },
      store,
    );
    const r2 = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_test' },
      store,
    );
    expect(r1).toEqual(r2);
  });

  it('does not read raw file content (preview uses only index metadata)', async () => {
    // The repo paths referenced in the index don't exist on disk.
    // Preview should still succeed because it uses only index metadata.
    const index = makeIndex();
    const plan = makePlan();
    await store.put(index);
    await store.put(plan);

    const result = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_test' },
      store,
    );
    expect(result.status).toBe('success');
  });

  it('surfaces over-budget reasons in preview result', async () => {
    const index = makeIndex();
    const plan = makePlan({
      assembly_options: {
        max_total_lines: 1,
        max_estimated_tokens: 1,
        dedupe_overlapping_spans: true,
        span_merge_strategy: 'merge_if_overlapping',
      },
    });
    await store.put(index);
    await store.put(plan);

    const result = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_test' },
      store,
    );
    expect(result.status).toBe('success');
    expect('over_budget_reasons' in result).toBe(true);
    const preview = result as any;
    expect(preview.over_budget_reasons.length).toBeGreaterThan(0);
    expect(preview.message).toContain('Over budget');
  });

  it('returns error for missing plan', async () => {
    const index = makeIndex();
    await store.put(index);

    const result = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_missing' },
      store,
    );
    expect(result.status).toBe('error');
  });

  it('returns error for missing retrieval index', async () => {
    const plan = makePlan();
    await store.put(plan);

    const result = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_missing', evidence_plan_id: 'plan_test' },
      store,
    );
    expect(result.status).toBe('error');
  });

  it('returns error for unknown file_id in plan', async () => {
    const index = makeIndex();
    const plan = makePlan({
      selection: {
        files: [
          {
            file_id: 'f_nonexistent',
            include_ast_skeleton: true,
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
    await store.put(index);
    await store.put(plan);

    const result = await evidenceAssemble(
      { mode: 'preview', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_test' },
      store,
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('Unknown file_id');
  });

  it('materialize mode returns error for missing plan', async () => {
    const result = await evidenceAssemble(
      { mode: 'materialize', retrieval_index_id: 'ri_test', evidence_plan_id: 'plan_test' },
      store,
    );
    expect(result.status).toBe('error');
  });
});
