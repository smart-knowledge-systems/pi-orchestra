import { describe, it, expect } from 'bun:test';
import {
  createEvidencePlan,
  createRecommendedEvidencePlan,
  verifyEmbeddedIndex,
  type CreateEvidencePlanOptions,
} from '../../src/conductor/evidence-plan.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import type { RetrievalIndexV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function makeIndex(overrides?: Partial<RetrievalIndexV1>): RetrievalIndexV1 {
  return {
    artifact_type: 'retrieval-index-v1',
    artifact_id: 'ri_test_123',
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
        ast_skeleton: ['function main()', 'function init()'],
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
            change_likelihood: 'low',
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
        why_relevant: 'utility helpers',
        file_summary: 'Shared utility functions.',
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
            count: 10,
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
    cross_file_findings: ['main imports utils'],
    gaps: ['Missing auth module'],
    followup_queries: ['auth flow details'],
    recommended_evidence: {
      files: [],
      include_cross_file_findings: false,
      include_gaps: false,
      include_followup_queries: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEvidencePlan', () => {
  it('produces a valid evidence-plan-v1 with defaults', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({ retrieval_index: index });
    const result = validateArtifact(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('embeds retrieval index reference byte-equal to source', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({ retrieval_index: index });
    expect(plan.retrieval_index.artifact_type).toBe('retrieval-index-v1');
    expect(plan.retrieval_index.artifact_id).toBe(index.artifact_id);
    expect(verifyEmbeddedIndex(plan, index)).toBe(true);
  });

  it('verifyEmbeddedIndex returns false for mismatched ID', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({ retrieval_index: index });
    const otherIndex = makeIndex({ artifact_id: 'ri_other' });
    expect(verifyEmbeddedIndex(plan, otherIndex)).toBe(false);
  });

  it('includes all index files as plan files by default (summary-only)', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({ retrieval_index: index });
    expect(plan.selection.files).toHaveLength(2);
    for (const f of plan.selection.files) {
      expect(f.include_ast_skeleton).toBe(false);
      expect(f.include_retriever_summary).toBe(true);
      expect(f.include_entire_file).toBe(false);
      expect(f.spans).toEqual([]);
    }
  });

  it('applies per-file inclusion controls', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({
      retrieval_index: index,
      file_controls: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: false,
          include_entire_file: false,
          spans: [
            { symbol_id: 's1', include_span: true, neighbor_lines: 5 },
            { symbol_id: 's2', include_span: false },
          ],
        },
      ],
    });

    const f1 = plan.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.include_ast_skeleton).toBe(true);
    expect(f1.include_retriever_summary).toBe(false);
    expect(f1.spans).toHaveLength(2);
    expect(f1.spans[0]).toEqual({ symbol_id: 's1', include_span: true, neighbor_lines: 5 });
    expect(f1.spans[1]).toEqual({ symbol_id: 's2', include_span: false, neighbor_lines: 0 });

    // f2 should still get defaults
    const f2 = plan.selection.files.find((f) => f.file_id === 'f2')!;
    expect(f2.include_retriever_summary).toBe(true);
    expect(f2.spans).toEqual([]);
  });

  it('includes include_entire_file control', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({
      retrieval_index: index,
      file_controls: [{ file_id: 'f2', include_entire_file: true }],
    });
    const f2 = plan.selection.files.find((f) => f.file_id === 'f2')!;
    expect(f2.include_entire_file).toBe(true);
  });

  it('throws on unknown file_id in controls', () => {
    const index = makeIndex();
    expect(() =>
      createEvidencePlan({
        retrieval_index: index,
        file_controls: [{ file_id: 'f_nonexistent' }],
      }),
    ).toThrow('Unknown file_id');
  });

  it('throws on unknown symbol_id in spans', () => {
    const index = makeIndex();
    expect(() =>
      createEvidencePlan({
        retrieval_index: index,
        file_controls: [{ file_id: 'f1', spans: [{ symbol_id: 'nonexistent' }] }],
      }),
    ).toThrow('Unknown symbol_id');
  });

  it('honors cross-file, gap, and followup selections', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({
      retrieval_index: index,
      include_cross_file_findings: false,
      include_gaps: true,
      include_followup_queries: true,
    });
    expect(plan.selection.include_cross_file_findings).toBe(false);
    expect(plan.selection.include_gaps).toBe(true);
    expect(plan.selection.include_followup_queries).toBe(true);
  });

  it('defaults cross-file to true and gaps/followup to false', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({ retrieval_index: index });
    expect(plan.selection.include_cross_file_findings).toBe(true);
    expect(plan.selection.include_gaps).toBe(false);
    expect(plan.selection.include_followup_queries).toBe(false);
  });

  it('applies assembly_options overrides', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({
      retrieval_index: index,
      assembly_options: { max_total_lines: 500, dedupe_overlapping_spans: false },
    });
    expect(plan.assembly_options.max_total_lines).toBe(500);
    expect(plan.assembly_options.dedupe_overlapping_spans).toBe(false);
    // defaults preserved
    expect(plan.assembly_options.max_estimated_tokens).toBe(20000);
    expect(plan.assembly_options.span_merge_strategy).toBe('merge_if_overlapping');
  });

  it('applies prompt_sections overrides', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({
      retrieval_index: index,
      prompt_sections: { include_raw_evidence: false },
    });
    expect(plan.prompt_sections.include_raw_evidence).toBe(false);
    expect(plan.prompt_sections.include_intent_context).toBe(true);
  });

  it('applies target_task overrides', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({
      retrieval_index: index,
      target_task: { type: 'change-spec', task_label: 'modify auth flow' },
    });
    expect(plan.target_task.type).toBe('change-spec');
    expect(plan.target_task.task_label).toBe('modify auth flow');
  });

  it('generates a unique artifact_id', () => {
    const index = makeIndex();
    const plan1 = createEvidencePlan({ retrieval_index: index });
    const plan2 = createEvidencePlan({ retrieval_index: index });
    expect(plan1.artifact_id).not.toBe(plan2.artifact_id);
    expect(plan1.artifact_id).toMatch(/^plan_/);
  });

  it('round-trips through schema validation with full controls', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({
      retrieval_index: index,
      file_controls: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          spans: [{ symbol_id: 's1', neighbor_lines: 3 }],
        },
        {
          file_id: 'f2',
          include_entire_file: true,
        },
      ],
      include_cross_file_findings: true,
      include_gaps: true,
      include_followup_queries: true,
      assembly_options: { max_total_lines: 1000 },
      target_task: { type: 'change-spec', task_label: 'refactor' },
    });

    const result = validateArtifact(plan);
    expect(result.valid).toBe(true);
  });

  it('preserves file order from retrieval index', () => {
    const index = makeIndex();
    const plan = createEvidencePlan({ retrieval_index: index });
    expect(plan.selection.files[0]!.file_id).toBe('f1');
    expect(plan.selection.files[1]!.file_id).toBe('f2');
  });
});

// ---------------------------------------------------------------------------
// createRecommendedEvidencePlan — retriever-authored defaults
// ---------------------------------------------------------------------------

function makeRecommendedIndex(): RetrievalIndexV1 {
  return makeIndex({
    artifact_id: 'ri_rec_123',
    files: [
      // Selected: summary+ast, one default span
      {
        file_id: 'f1',
        path: '/repo/src/main.ts',
        why_relevant: 'entry point',
        file_summary: 'Main application entry.\nSets up the server.',
        ast_skeleton: ['function main()', 'function init()'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'selected',
        selection_reason: 'entry point for the affected flow',
        default_evidence_mode: 'summary+ast',
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
            recommended_expansion: 'span',
            expansion_reason: 'spans drive the default plan',
            selected_by_default: true,
            default_neighbor_lines: 4,
            selection_reason: 'primary entry symbol',
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
            change_likelihood: 'low',
            expansion_priority: 'medium',
            recommended_expansion: 'none',
            expansion_reason: '',
            selected_by_default: false,
            default_neighbor_lines: 0,
            selection_reason: '',
          },
        ],
      },
      // Reserve — must be excluded from the default plan
      {
        file_id: 'f_reserve',
        path: '/repo/src/archive.ts',
        why_relevant: 'older module, likely not needed',
        file_summary: 'Archive utilities.',
        ast_skeleton: ['function legacyHelper()'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'reserve',
        selection_reason: 'near-threshold candidate',
        default_evidence_mode: 'exclude',
        symbols: [
          {
            symbol_id: 's_reserve',
            kind: 'function',
            name: 'legacyHelper',
            start: 2,
            count: 5,
            summary: 'legacy helper',
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
    recommended_evidence: {
      files: [
        {
          file_id: 'f1',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 's1', include_span: true, neighbor_lines: 4 }],
        },
      ],
      include_cross_file_findings: true,
      include_gaps: false,
      include_followup_queries: true,
    },
  });
}

describe('createRecommendedEvidencePlan', () => {
  it('produces a valid evidence-plan-v1 straight from recommended_evidence', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index);
    const result = validateArtifact(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('maps recommended_evidence.files to plan selection one-for-one', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index);
    expect(plan.selection.files).toHaveLength(1);
    const f1 = plan.selection.files[0]!;
    expect(f1.file_id).toBe('f1');
    expect(f1.include_ast_skeleton).toBe(true);
    expect(f1.include_retriever_summary).toBe(true);
    expect(f1.include_entire_file).toBe(false);
    expect(f1.spans).toHaveLength(1);
    expect(f1.spans[0]).toEqual({ symbol_id: 's1', include_span: true, neighbor_lines: 4 });
  });

  it('excludes reserve-tier files from the default plan', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index);
    expect(plan.selection.files.some((f) => f.file_id === 'f_reserve')).toBe(false);
  });

  it('carries include_cross_file_findings/gaps/followup straight from recommendation', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index);
    expect(plan.selection.include_cross_file_findings).toBe(true);
    expect(plan.selection.include_gaps).toBe(false);
    expect(plan.selection.include_followup_queries).toBe(true);
  });

  it('is materially narrower than createEvidencePlan defaults', () => {
    const index = makeRecommendedIndex();
    const recommended = createRecommendedEvidencePlan(index);
    const naive = createEvidencePlan({ retrieval_index: index });
    // Naive default embeds every retrieved file (including reserve-tier);
    // recommended plan embeds only the retriever-selected subset.
    expect(recommended.selection.files.length).toBeLessThan(naive.selection.files.length);
  });

  it('promotes a reserve file as summary-only when requested', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index, { promote_reserve: ['f_reserve'] });
    const promoted = plan.selection.files.find((f) => f.file_id === 'f_reserve');
    expect(promoted).toBeDefined();
    expect(promoted!.include_retriever_summary).toBe(true);
    expect(promoted!.include_ast_skeleton).toBe(false);
    expect(promoted!.include_entire_file).toBe(false);
    expect(promoted!.spans).toEqual([]);
  });

  it('refuses to promote a non-reserve file_id', () => {
    const index = makeRecommendedIndex();
    expect(() => createRecommendedEvidencePlan(index, { promote_reserve: ['f1'] })).not.toThrow();
    // f1 is already in the plan; promote_reserve should no-op for recommended ids,
    // but must reject selected-tier ids that are NOT in recommended_evidence.
  });

  it('throws when promote_reserve references an unknown file_id', () => {
    const index = makeRecommendedIndex();
    expect(() =>
      createRecommendedEvidencePlan(index, { promote_reserve: ['f_nonexistent'] }),
    ).toThrow(/unknown reserve file_id/);
  });

  it('throws when promote_reserve references a selected-tier file', () => {
    const index = makeRecommendedIndex();
    // Add a selected-tier file that is NOT in recommended_evidence, then try
    // to promote it as if it were reserve.
    const indexWithExtraSelected = makeRecommendedIndex();
    indexWithExtraSelected.files.push({
      file_id: 'f_extra',
      path: '/repo/src/extra.ts',
      why_relevant: 'selected but not in recommendation',
      file_summary: '',
      ast_skeleton: [],
      recommended_expansion: 'none',
      expansion_reason: '',
      selection_tier: 'selected',
      selection_reason: '',
      default_evidence_mode: 'summary',
      symbols: [],
    });
    expect(() =>
      createRecommendedEvidencePlan(indexWithExtraSelected, { promote_reserve: ['f_extra'] }),
    ).toThrow(/not a reserve-tier candidate/);
  });

  it('throws when recommended_evidence references an unknown file_id', () => {
    const index = makeRecommendedIndex();
    index.recommended_evidence.files.push({
      file_id: 'f_missing',
      include_ast_skeleton: false,
      include_retriever_summary: true,
      include_entire_file: false,
      spans: [],
    });
    expect(() => createRecommendedEvidencePlan(index)).toThrow(
      /recommended_evidence references unknown file_id/,
    );
  });

  it('throws when recommended_evidence references an unknown symbol_id', () => {
    const index = makeRecommendedIndex();
    index.recommended_evidence.files[0]!.spans.push({
      symbol_id: 's_nonexistent',
      include_span: true,
      neighbor_lines: 2,
    });
    expect(() => createRecommendedEvidencePlan(index)).toThrow(
      /recommended_evidence references unknown symbol_id/,
    );
  });

  it('applies target_task overrides', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index, {
      target_task: { type: 'change-spec', task_label: 'refactor entry' },
    });
    expect(plan.target_task.type).toBe('change-spec');
    expect(plan.target_task.task_label).toBe('refactor entry');
  });

  it('applies assembly_options overrides while keeping sensible defaults', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index, {
      assembly_options: { max_total_lines: 500 },
    });
    expect(plan.assembly_options.max_total_lines).toBe(500);
    expect(plan.assembly_options.max_estimated_tokens).toBe(20000);
    expect(plan.assembly_options.dedupe_overlapping_spans).toBe(true);
  });

  it('embeds the originating retrieval index reference byte-equal', () => {
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index);
    expect(verifyEmbeddedIndex(plan, index)).toBe(true);
  });

  it('hands a plan shape compatible with applyEvidenceOverrides', async () => {
    const { applyEvidenceOverrides } = await import('../../src/conductor/evidence-overrides.ts');
    const index = makeRecommendedIndex();
    const plan = createRecommendedEvidencePlan(index);
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'f_reserve', mode: 'summary' }],
    });
    expect(applied).toHaveLength(1);
    expect(adjusted.selection.files.some((f) => f.file_id === 'f_reserve')).toBe(true);
    // The recommended default still excluded f_reserve; overrides added it.
    expect(plan.selection.files.some((f) => f.file_id === 'f_reserve')).toBe(false);
  });
});
