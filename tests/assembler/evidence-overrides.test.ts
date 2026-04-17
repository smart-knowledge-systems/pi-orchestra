import { describe, it, expect } from 'bun:test';
import {
  applyEvidenceOverrides,
  deriveEffectiveFileMode,
  modeToIncludeFlags,
  type EvidenceOverride,
} from '../../src/conductor/evidence-overrides.ts';
import { createRecommendedEvidencePlan } from '../../src/conductor/evidence-plan.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import type { RetrievalIndexV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Fixture: selected f1 (summary+ast, default span s1/neighbor=4) + reserve f_reserve
// ---------------------------------------------------------------------------

function makeIndex(): RetrievalIndexV1 {
  return {
    artifact_type: 'retrieval-index-v1',
    artifact_id: 'ri_override_123',
    intent_capture_id: 'ic_1',
    intent_restatement_id: 'ir_1',
    intent_spec_id: null,
    query: 'override test',
    confidence: 'high',
    strategy_summary: 'test strategy',
    scout_terms: ['override'],
    files: [
      {
        file_id: 'f1',
        path: '/repo/src/main.ts',
        why_relevant: 'entry point',
        file_summary: 'Main entry.',
        ast_skeleton: ['function main()', 'function init()'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'selected',
        selection_reason: 'primary entry',
        default_evidence_mode: 'summary+ast',
        symbols: [
          {
            symbol_id: 's1',
            kind: 'function',
            name: 'main',
            start: 10,
            count: 20,
            summary: 'entry',
            role_in_system: 'entrypoint',
            depends_on: [],
            used_by: [],
            relevance: 'high',
            change_likelihood: 'low',
            expansion_priority: 'high',
            recommended_expansion: 'span',
            expansion_reason: '',
            selected_by_default: true,
            default_neighbor_lines: 4,
            selection_reason: 'primary',
          },
          {
            symbol_id: 's2',
            kind: 'function',
            name: 'init',
            start: 35,
            count: 15,
            summary: 'init',
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
        file_id: 'f_reserve',
        path: '/repo/src/archive.ts',
        why_relevant: 'legacy utility',
        file_summary: 'Archive.',
        ast_skeleton: ['function legacyHelper()'],
        recommended_expansion: 'none',
        expansion_reason: '',
        selection_tier: 'reserve',
        selection_reason: 'near-threshold',
        default_evidence_mode: 'summary',
        symbols: [
          {
            symbol_id: 's_reserve',
            kind: 'function',
            name: 'legacyHelper',
            start: 2,
            count: 5,
            summary: 'legacy',
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
    cross_file_findings: [],
    gaps: [],
    followup_queries: [],
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
      include_followup_queries: false,
    },
  };
}

function makePlan(index: RetrievalIndexV1) {
  return createRecommendedEvidencePlan(index);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('modeToIncludeFlags', () => {
  it('maps every retrieval mode to a coherent flag triple', () => {
    expect(modeToIncludeFlags('whole_file')).toEqual({
      include_ast_skeleton: true,
      include_retriever_summary: true,
      include_entire_file: true,
    });
    expect(modeToIncludeFlags('spans')).toEqual({
      include_ast_skeleton: true,
      include_retriever_summary: true,
      include_entire_file: false,
    });
    expect(modeToIncludeFlags('summary+ast')).toEqual({
      include_ast_skeleton: true,
      include_retriever_summary: true,
      include_entire_file: false,
    });
    expect(modeToIncludeFlags('summary')).toEqual({
      include_ast_skeleton: false,
      include_retriever_summary: true,
      include_entire_file: false,
    });
    expect(modeToIncludeFlags('exclude')).toEqual({
      include_ast_skeleton: false,
      include_retriever_summary: false,
      include_entire_file: false,
    });
  });
});

describe('applyEvidenceOverrides — success paths', () => {
  it('returns a fresh plan artifact_id distinct from the input', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'toggle_gaps', value: true }],
    });
    expect(adjusted.artifact_id).not.toBe(plan.artifact_id);
    expect(adjusted.artifact_id).toMatch(/^plan_/);
  });

  it('does not mutate the input plan', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const originalJson = JSON.stringify(plan);
    applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'demote_file', file_id: 'f1' }],
    });
    expect(JSON.stringify(plan)).toBe(originalJson);
  });

  it('preserves unrelated plan fields exactly (change-only diff)', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'toggle_gaps', value: true }],
    });
    expect(adjusted.selection.files).toEqual(plan.selection.files);
    expect(adjusted.assembly_options).toEqual(plan.assembly_options);
    expect(adjusted.prompt_sections).toEqual(plan.prompt_sections);
    expect(adjusted.target_task).toEqual(plan.target_task);
    expect(adjusted.retrieval_index).toEqual(plan.retrieval_index);
    // Only gaps flipped.
    expect(adjusted.selection.include_gaps).toBe(true);
    expect(adjusted.selection.include_cross_file_findings).toBe(
      plan.selection.include_cross_file_findings,
    );
  });

  it('promotes a reserve file with its default mode and preserves existing plan files', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'f_reserve' }],
    });
    expect(adjusted.selection.files.map((f) => f.file_id)).toEqual(['f1', 'f_reserve']);
    const promoted = adjusted.selection.files[1]!;
    expect(promoted.include_retriever_summary).toBe(true);
    expect(promoted.include_ast_skeleton).toBe(false);
    expect(promoted.include_entire_file).toBe(false);
    expect(promoted.spans).toEqual([]);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatch(/promote_file f_reserve/);
  });

  it('promotes a reserve file with an explicit mode override (whole_file)', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'f_reserve', mode: 'whole_file' }],
    });
    const promoted = adjusted.selection.files.find((f) => f.file_id === 'f_reserve')!;
    expect(promoted.include_entire_file).toBe(true);
    expect(promoted.include_ast_skeleton).toBe(true);
    expect(promoted.include_retriever_summary).toBe(true);
  });

  it('promotes an exclude-mode reserve file with a sensible summary fallback', () => {
    const index = makeIndex();
    index.files[1]!.default_evidence_mode = 'exclude';
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'f_reserve' }],
    });
    const promoted = adjusted.selection.files.find((f) => f.file_id === 'f_reserve')!;
    expect(promoted.include_retriever_summary).toBe(true);
    expect(promoted.include_ast_skeleton).toBe(false);
    expect(promoted.include_entire_file).toBe(false);
  });

  it('demotes a selected file (removes it from the plan)', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'demote_file', file_id: 'f1' }],
    });
    expect(adjusted.selection.files).toHaveLength(0);
    expect(applied).toEqual(['demote_file f1']);
  });

  it('applies set_file_mode to an existing plan file', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'whole_file' }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.include_entire_file).toBe(true);
    expect(f1.include_ast_skeleton).toBe(true);
    expect(f1.include_retriever_summary).toBe(true);
    // Spans untouched.
    expect(f1.spans).toEqual(plan.selection.files[0]!.spans);
  });

  it('includes a new symbol span on an existing plan file', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'include_symbol', file_id: 'f1', symbol_id: 's2', neighbor_lines: 2 }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.spans).toHaveLength(2);
    const s2 = f1.spans.find((s) => s.symbol_id === 's2')!;
    expect(s2).toEqual({ symbol_id: 's2', include_span: true, neighbor_lines: 2 });
    // Pre-existing span unchanged.
    const s1 = f1.spans.find((s) => s.symbol_id === 's1')!;
    expect(s1).toEqual({ symbol_id: 's1', include_span: true, neighbor_lines: 4 });
  });

  it('include_symbol on an already-included span re-enables and updates neighbor_lines', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'include_symbol', file_id: 'f1', symbol_id: 's1', neighbor_lines: 7 }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.spans).toHaveLength(1);
    expect(f1.spans[0]).toEqual({ symbol_id: 's1', include_span: true, neighbor_lines: 7 });
  });

  it('excludes an existing span by removing it from the plan file', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'exclude_symbol', file_id: 'f1', symbol_id: 's1' }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.spans).toEqual([]);
    expect(applied).toEqual(['exclude_symbol f1:s1']);
  });

  it('tunes neighbor_lines on an existing span', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'set_neighbor_lines', file_id: 'f1', symbol_id: 's1', neighbor_lines: 12 }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.spans[0]).toEqual({ symbol_id: 's1', include_span: true, neighbor_lines: 12 });
  });

  it('coerces fractional/negative neighbor_lines sensibly (clamp + floor)', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'include_symbol', file_id: 'f1', symbol_id: 's2', neighbor_lines: 3.9 }],
    });
    const s2 = adjusted.selection.files[0]!.spans.find((s) => s.symbol_id === 's2')!;
    expect(s2.neighbor_lines).toBe(3);
  });

  it('toggle_cross_file_findings / toggle_gaps / toggle_followup_queries flip selection flags', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [
        { op: 'toggle_cross_file_findings', value: false },
        { op: 'toggle_gaps', value: true },
        { op: 'toggle_followup_queries', value: true },
      ],
    });
    expect(adjusted.selection.include_cross_file_findings).toBe(false);
    expect(adjusted.selection.include_gaps).toBe(true);
    expect(adjusted.selection.include_followup_queries).toBe(true);
  });

  it('applies multiple overrides deterministically in order (promote then include)', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const overrides: EvidenceOverride[] = [
      { op: 'promote_file', file_id: 'f_reserve', mode: 'summary+ast' },
      { op: 'include_symbol', file_id: 'f_reserve', symbol_id: 's_reserve', neighbor_lines: 1 },
    ];
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides,
    });
    const reserve = adjusted.selection.files.find((f) => f.file_id === 'f_reserve')!;
    expect(reserve.include_ast_skeleton).toBe(true);
    expect(reserve.spans).toEqual([
      { symbol_id: 's_reserve', include_span: true, neighbor_lines: 1 },
    ]);
    expect(applied).toHaveLength(2);
  });

  it('round-trips through schema validation after overrides', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [
        { op: 'promote_file', file_id: 'f_reserve', mode: 'summary+ast' },
        { op: 'include_symbol', file_id: 'f_reserve', symbol_id: 's_reserve', neighbor_lines: 2 },
        { op: 'set_neighbor_lines', file_id: 'f1', symbol_id: 's1', neighbor_lines: 6 },
      ],
    });
    const result = validateArtifact(adjusted);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('no-op override list returns a fresh plan but structurally identical selection', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [],
    });
    expect(applied).toEqual([]);
    expect(adjusted.selection).toEqual(plan.selection);
    expect(adjusted.artifact_id).not.toBe(plan.artifact_id);
  });
});

describe('applyEvidenceOverrides — invalid references fail loudly', () => {
  it('promote_file rejects unknown file_id', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'promote_file', file_id: 'f_nonexistent' }],
      }),
    ).toThrow(/unknown file_id "f_nonexistent"/);
  });

  it('promote_file rejects a file already in the plan', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'promote_file', file_id: 'f1' }],
      }),
    ).toThrow(/already in the plan/);
  });

  it('demote_file rejects a file not in the plan', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'demote_file', file_id: 'f_reserve' }],
      }),
    ).toThrow(/not in the plan/);
  });

  it('demote_file rejects an unknown file_id', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'demote_file', file_id: 'f_nonexistent' }],
      }),
    ).toThrow(/unknown file_id "f_nonexistent"/);
  });

  it('set_file_mode rejects a file not in the plan', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'set_file_mode', file_id: 'f_reserve', mode: 'spans' }],
      }),
    ).toThrow(/not in the plan/);
  });

  it('include_symbol rejects unknown file_id', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'include_symbol', file_id: 'f_missing', symbol_id: 's1' }],
      }),
    ).toThrow(/unknown file_id "f_missing"/);
  });

  it('include_symbol rejects unknown symbol_id', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'include_symbol', file_id: 'f1', symbol_id: 's_nonexistent' }],
      }),
    ).toThrow(/unknown symbol_id "s_nonexistent"/);
  });

  it('include_symbol rejects a file that is not in the plan', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'include_symbol', file_id: 'f_reserve', symbol_id: 's_reserve' }],
      }),
    ).toThrow(/not in the plan/);
  });

  it('include_symbol rejects negative neighbor_lines', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'include_symbol', file_id: 'f1', symbol_id: 's2', neighbor_lines: -1 }],
      }),
    ).toThrow(/non-negative neighbor_lines/);
  });

  it('exclude_symbol rejects a symbol not currently in the plan', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'exclude_symbol', file_id: 'f1', symbol_id: 's2' }],
      }),
    ).toThrow(/not in the plan for file "f1"/);
  });

  it('set_neighbor_lines rejects a symbol that has no span entry', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [
          { op: 'set_neighbor_lines', file_id: 'f1', symbol_id: 's2', neighbor_lines: 5 },
        ],
      }),
    ).toThrow(/include it first/);
  });

  it('set_neighbor_lines rejects negative values', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [
          { op: 'set_neighbor_lines', file_id: 'f1', symbol_id: 's1', neighbor_lines: -3 },
        ],
      }),
    ).toThrow(/non-negative neighbor_lines/);
  });

  it('rejects the entire override list on the first invalid op (original plan untouched)', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const before = JSON.stringify(plan);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [
          { op: 'toggle_gaps', value: true },
          { op: 'promote_file', file_id: 'f_missing' },
        ],
      }),
    ).toThrow(/unknown file_id "f_missing"/);
    // Input plan must still be byte-identical.
    expect(JSON.stringify(plan)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Only intended changes are reflected
// ---------------------------------------------------------------------------

describe('applyEvidenceOverrides — change isolation', () => {
  it('promote_file + include_symbol does not affect the pre-existing file', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [
        { op: 'promote_file', file_id: 'f_reserve', mode: 'summary+ast' },
        {
          op: 'include_symbol',
          file_id: 'f_reserve',
          symbol_id: 's_reserve',
          neighbor_lines: 2,
        },
      ],
    });
    const f1Before = plan.selection.files.find((f) => f.file_id === 'f1')!;
    const f1After = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1After).toEqual(f1Before);
    // Top-level flags unchanged.
    expect(adjusted.selection.include_cross_file_findings).toBe(
      plan.selection.include_cross_file_findings,
    );
    expect(adjusted.selection.include_gaps).toBe(plan.selection.include_gaps);
    expect(adjusted.selection.include_followup_queries).toBe(
      plan.selection.include_followup_queries,
    );
  });

  it('set_neighbor_lines only touches the targeted span', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    // First include s2 so we can tune it without touching s1.
    const prepared = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'include_symbol', file_id: 'f1', symbol_id: 's2', neighbor_lines: 3 }],
    }).plan;
    const { plan: tuned } = applyEvidenceOverrides({
      plan: prepared,
      retrieval_index: index,
      overrides: [{ op: 'set_neighbor_lines', file_id: 'f1', symbol_id: 's2', neighbor_lines: 9 }],
    });
    const f1 = tuned.selection.files.find((f) => f.file_id === 'f1')!;
    const s1 = f1.spans.find((s) => s.symbol_id === 's1')!;
    const s2 = f1.spans.find((s) => s.symbol_id === 's2')!;
    expect(s1).toEqual({ symbol_id: 's1', include_span: true, neighbor_lines: 4 });
    expect(s2.neighbor_lines).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// set_file_mode suppresses stale span evidence (AR-P7-T4)
// ---------------------------------------------------------------------------

describe('applyEvidenceOverrides — set_file_mode suppresses stale spans', () => {
  it('set_file_mode to summary clears previously selected raw spans', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    // The default plan has f1 with an active span on s1.
    expect(plan.selection.files[0]!.spans).toHaveLength(1);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'summary' }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.spans).toEqual([]);
    expect(f1.include_ast_skeleton).toBe(false);
    expect(f1.include_retriever_summary).toBe(true);
    expect(f1.include_entire_file).toBe(false);
  });

  it('set_file_mode to summary+ast clears previously selected raw spans', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'summary+ast' }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.spans).toEqual([]);
    expect(f1.include_ast_skeleton).toBe(true);
    expect(f1.include_retriever_summary).toBe(true);
  });

  it('set_file_mode to spans preserves existing spans', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'spans' }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.spans).toEqual(plan.selection.files[0]!.spans);
  });

  it('set_file_mode to whole_file preserves span entries (assembler ignores them)', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'whole_file' }],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    expect(f1.include_entire_file).toBe(true);
    expect(f1.spans).toEqual(plan.selection.files[0]!.spans);
  });

  it('set_file_mode to exclude removes the file from the plan entirely', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'set_file_mode', file_id: 'f1', mode: 'exclude' }],
    });
    expect(adjusted.selection.files.find((f) => f.file_id === 'f1')).toBeUndefined();
    expect(applied[0]).toMatch(/set_file_mode f1 mode=exclude/);
  });

  it('subsequent include_symbol after set_file_mode to exclude fails because file was removed', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [
          { op: 'set_file_mode', file_id: 'f1', mode: 'exclude' },
          { op: 'include_symbol', file_id: 'f1', symbol_id: 's1' },
        ],
      }),
    ).toThrow(/not in the plan/);
  });

  it('set_file_mode to summary then include_symbol re-adds only the explicitly intended span', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [
        { op: 'set_file_mode', file_id: 'f1', mode: 'summary' },
        { op: 'include_symbol', file_id: 'f1', symbol_id: 's2', neighbor_lines: 1 },
      ],
    });
    const f1 = adjusted.selection.files.find((f) => f.file_id === 'f1')!;
    // s1 (previously a default span) is gone; s2 is the only active span.
    expect(f1.spans.map((s) => s.symbol_id)).toEqual(['s2']);
  });
});

// ---------------------------------------------------------------------------
// promote_file mode=spans seeding + fail-loudly (AR-P7-T5)
// ---------------------------------------------------------------------------

describe('applyEvidenceOverrides — promote_file mode=spans behavior', () => {
  it('throws when mode=spans has no default spans in retrieval metadata', () => {
    const index = makeIndex();
    const plan = makePlan(index);
    // f_reserve has one symbol with selected_by_default=false and no
    // recommended_evidence entry, so there are no concrete spans to seed.
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'promote_file', file_id: 'f_reserve', mode: 'spans' }],
      }),
    ).toThrow(/mode='spans' requires default spans/);
  });

  it('seeds spans from selected_by_default symbols when promoting with mode=spans', () => {
    const index = makeIndex();
    // Mark the reserve symbol as a default-span candidate.
    index.files[1]!.symbols[0]!.selected_by_default = true;
    index.files[1]!.symbols[0]!.default_neighbor_lines = 2;
    const plan = makePlan(index);
    const { plan: adjusted, applied } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'f_reserve', mode: 'spans' }],
    });
    const reserve = adjusted.selection.files.find((f) => f.file_id === 'f_reserve')!;
    expect(reserve.spans).toEqual([
      { symbol_id: 's_reserve', include_span: true, neighbor_lines: 2 },
    ]);
    expect(reserve.include_ast_skeleton).toBe(true);
    expect(reserve.include_retriever_summary).toBe(true);
    expect(applied[0]).toMatch(/spans=1/);
  });

  it('seeds spans from recommended_evidence entry when promoting with mode=spans', () => {
    const index = makeIndex();
    // After a demote/re-promote flow a selected-tier file may still have an
    // entry in recommended_evidence even though it has been removed from the
    // plan by a prior demote in the override list.
    index.recommended_evidence.files.push({
      file_id: 'f_reserve',
      include_ast_skeleton: true,
      include_retriever_summary: true,
      include_entire_file: false,
      spans: [{ symbol_id: 's_reserve', include_span: true, neighbor_lines: 3 }],
    });
    const plan = makePlan(index);
    // The plan now already has f_reserve in its selection via
    // recommended_evidence, so demote first, then re-promote with spans mode.
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [
        { op: 'demote_file', file_id: 'f_reserve' },
        { op: 'promote_file', file_id: 'f_reserve', mode: 'spans' },
      ],
    });
    const reserve = adjusted.selection.files.find((f) => f.file_id === 'f_reserve')!;
    expect(reserve.spans).toEqual([
      { symbol_id: 's_reserve', include_span: true, neighbor_lines: 3 },
    ]);
  });

  it('does not seed spans when promote_file uses a non-spans mode', () => {
    const index = makeIndex();
    index.files[1]!.symbols[0]!.selected_by_default = true;
    index.files[1]!.symbols[0]!.default_neighbor_lines = 2;
    const plan = makePlan(index);
    const { plan: adjusted } = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [{ op: 'promote_file', file_id: 'f_reserve', mode: 'summary+ast' }],
    });
    const reserve = adjusted.selection.files.find((f) => f.file_id === 'f_reserve')!;
    expect(reserve.spans).toEqual([]);
  });

  it('throws when the resolved default is spans but no seed is available', () => {
    const index = makeIndex();
    // Reserve file's retrieval default is 'spans' but it has no seed data.
    index.files[1]!.default_evidence_mode = 'spans';
    const plan = makePlan(index);
    expect(() =>
      applyEvidenceOverrides({
        plan,
        retrieval_index: index,
        overrides: [{ op: 'promote_file', file_id: 'f_reserve' }],
      }),
    ).toThrow(/mode='spans' requires default spans/);
  });
});

// ---------------------------------------------------------------------------
// deriveEffectiveFileMode (AR-P7-T6)
// ---------------------------------------------------------------------------

describe('deriveEffectiveFileMode', () => {
  it('returns whole_file when include_entire_file is true', () => {
    expect(
      deriveEffectiveFileMode({
        file_id: 'x',
        include_ast_skeleton: false,
        include_retriever_summary: false,
        include_entire_file: true,
        spans: [],
      }),
    ).toBe('whole_file');
  });

  it('returns spans when at least one span is active', () => {
    expect(
      deriveEffectiveFileMode({
        file_id: 'x',
        include_ast_skeleton: true,
        include_retriever_summary: true,
        include_entire_file: false,
        spans: [{ symbol_id: 's', include_span: true, neighbor_lines: 0 }],
      }),
    ).toBe('spans');
  });

  it('returns summary+ast when flags indicate both but no active spans', () => {
    expect(
      deriveEffectiveFileMode({
        file_id: 'x',
        include_ast_skeleton: true,
        include_retriever_summary: true,
        include_entire_file: false,
        spans: [],
      }),
    ).toBe('summary+ast');
  });

  it('returns summary when only retriever summary flag is set', () => {
    expect(
      deriveEffectiveFileMode({
        file_id: 'x',
        include_ast_skeleton: false,
        include_retriever_summary: true,
        include_entire_file: false,
        spans: [],
      }),
    ).toBe('summary');
  });

  it('returns exclude when no flags are set and no spans', () => {
    expect(
      deriveEffectiveFileMode({
        file_id: 'x',
        include_ast_skeleton: false,
        include_retriever_summary: false,
        include_entire_file: false,
        spans: [],
      }),
    ).toBe('exclude');
  });

  it('ignores spans with include_span=false when deriving mode', () => {
    expect(
      deriveEffectiveFileMode({
        file_id: 'x',
        include_ast_skeleton: true,
        include_retriever_summary: true,
        include_entire_file: false,
        spans: [{ symbol_id: 's', include_span: false, neighbor_lines: 0 }],
      }),
    ).toBe('summary+ast');
  });
});
