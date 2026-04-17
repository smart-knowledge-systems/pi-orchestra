import { describe, it, expect } from 'bun:test';
import {
  createEvidencePlan,
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
