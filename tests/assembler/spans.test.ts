import { describe, it, expect } from 'bun:test';
import {
  resolveSymbolToSpan,
  expandNeighborLines,
  mergeOverlappingSpans,
  batchResolveSpans,
  SpanResolutionError,
  type ResolvedSpan,
} from '../../src/util/spans.ts';
import type { RetrievalIndexV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIndex(overrides?: Partial<RetrievalIndexV1>): RetrievalIndexV1 {
  return {
    artifact_type: 'retrieval-index-v1',
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
        file_summary: 'main entry',
        ast_skeleton: ['function main()'],
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
            name: 'helper',
            start: 35,
            count: 10,
            summary: 'helper fn',
            role_in_system: 'utility',
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
        file_summary: 'utils',
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
    cross_file_findings: [],
    gaps: [],
    followup_queries: [],
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
// resolveSymbolToSpan
// ---------------------------------------------------------------------------

describe('resolveSymbolToSpan', () => {
  const index = makeIndex();

  it('resolves a known symbol', () => {
    const span = resolveSymbolToSpan(index, 'f1', 's1');
    expect(span).toEqual({
      file_id: 'f1',
      path: '/repo/src/main.ts',
      start: 10,
      count: 20,
    });
  });

  it('resolves a symbol in a different file', () => {
    const span = resolveSymbolToSpan(index, 'f2', 's3');
    expect(span).toEqual({
      file_id: 'f2',
      path: '/repo/src/utils.ts',
      start: 5,
      count: 8,
    });
  });

  it('throws SpanResolutionError for unknown file_id', () => {
    expect(() => resolveSymbolToSpan(index, 'f_unknown', 's1')).toThrow(SpanResolutionError);
    expect(() => resolveSymbolToSpan(index, 'f_unknown', 's1')).toThrow('Unknown file_id');
  });

  it('throws SpanResolutionError for unknown symbol_id', () => {
    expect(() => resolveSymbolToSpan(index, 'f1', 's_unknown')).toThrow(SpanResolutionError);
    expect(() => resolveSymbolToSpan(index, 'f1', 's_unknown')).toThrow('Unknown symbol_id');
  });

  it('throws for symbol in wrong file', () => {
    // s3 belongs to f2, not f1
    expect(() => resolveSymbolToSpan(index, 'f1', 's3')).toThrow(SpanResolutionError);
  });
});

// ---------------------------------------------------------------------------
// expandNeighborLines
// ---------------------------------------------------------------------------

describe('expandNeighborLines', () => {
  const base: ResolvedSpan = { file_id: 'f1', path: '/repo/src/main.ts', start: 10, count: 5 };

  it('returns a copy when neighborLines is 0', () => {
    const result = expandNeighborLines(base, 0);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  it('expands by neighbor lines in both directions', () => {
    const result = expandNeighborLines(base, 3);
    // start: 10 - 3 = 7, end: 14 + 3 = 17, count: 17 - 7 + 1 = 11
    expect(result.start).toBe(7);
    expect(result.count).toBe(11);
  });

  it('clamps start to minimum of 1', () => {
    const nearTop: ResolvedSpan = { file_id: 'f1', path: '/p', start: 2, count: 3 };
    const result = expandNeighborLines(nearTop, 5);
    expect(result.start).toBe(1);
    // original end = 4, new end = 4 + 5 = 9, count = 9 - 1 + 1 = 9
    expect(result.count).toBe(9);
  });

  it('handles negative neighborLines as no-op', () => {
    const result = expandNeighborLines(base, -2);
    expect(result).toEqual(base);
  });

  it('preserves file_id and path', () => {
    const result = expandNeighborLines(base, 3);
    expect(result.file_id).toBe('f1');
    expect(result.path).toBe('/repo/src/main.ts');
  });
});

// ---------------------------------------------------------------------------
// mergeOverlappingSpans
// ---------------------------------------------------------------------------

describe('mergeOverlappingSpans', () => {
  it('returns empty array for empty input', () => {
    expect(mergeOverlappingSpans([])).toEqual([]);
  });

  it('returns a copy of a single span', () => {
    const span: ResolvedSpan = { file_id: 'f1', path: '/p', start: 5, count: 10 };
    const result = mergeOverlappingSpans([span]);
    expect(result).toEqual([span]);
    expect(result[0]).not.toBe(span);
  });

  it('merges two overlapping spans in the same file', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f1', path: '/p', start: 5, count: 10 }, // 5-14
      { file_id: 'f1', path: '/p', start: 12, count: 8 }, // 12-19
    ];
    const result = mergeOverlappingSpans(spans);
    expect(result).toEqual([{ file_id: 'f1', path: '/p', start: 5, count: 15 }]); // 5-19
  });

  it('merges adjacent spans (touching)', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f1', path: '/p', start: 5, count: 5 }, // 5-9
      { file_id: 'f1', path: '/p', start: 10, count: 5 }, // 10-14
    ];
    const result = mergeOverlappingSpans(spans);
    expect(result).toEqual([{ file_id: 'f1', path: '/p', start: 5, count: 10 }]); // 5-14
  });

  it('does NOT merge non-adjacent spans', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f1', path: '/p', start: 5, count: 3 }, // 5-7
      { file_id: 'f1', path: '/p', start: 10, count: 3 }, // 10-12
    ];
    const result = mergeOverlappingSpans(spans);
    expect(result).toHaveLength(2);
  });

  it('does NOT merge spans from different files', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f1', path: '/a', start: 5, count: 10 },
      { file_id: 'f2', path: '/b', start: 5, count: 10 },
    ];
    const result = mergeOverlappingSpans(spans);
    expect(result).toHaveLength(2);
  });

  it('handles contained spans (one inside another)', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f1', path: '/p', start: 5, count: 20 }, // 5-24
      { file_id: 'f1', path: '/p', start: 10, count: 5 }, // 10-14 (inside)
    ];
    const result = mergeOverlappingSpans(spans);
    expect(result).toEqual([{ file_id: 'f1', path: '/p', start: 5, count: 20 }]);
  });

  it('is deterministic regardless of input order', () => {
    const spans1: ResolvedSpan[] = [
      { file_id: 'f1', path: '/p', start: 15, count: 5 },
      { file_id: 'f1', path: '/p', start: 5, count: 12 },
      { file_id: 'f2', path: '/q', start: 1, count: 3 },
    ];
    const spans2: ResolvedSpan[] = [
      { file_id: 'f2', path: '/q', start: 1, count: 3 },
      { file_id: 'f1', path: '/p', start: 5, count: 12 },
      { file_id: 'f1', path: '/p', start: 15, count: 5 },
    ];
    const result1 = mergeOverlappingSpans(spans1);
    const result2 = mergeOverlappingSpans(spans2);
    expect(result1).toEqual(result2);
  });

  it('merges a chain of overlapping spans into one', () => {
    const spans: ResolvedSpan[] = [
      { file_id: 'f1', path: '/p', start: 1, count: 5 }, // 1-5
      { file_id: 'f1', path: '/p', start: 4, count: 5 }, // 4-8
      { file_id: 'f1', path: '/p', start: 7, count: 5 }, // 7-11
    ];
    const result = mergeOverlappingSpans(spans);
    expect(result).toEqual([{ file_id: 'f1', path: '/p', start: 1, count: 11 }]); // 1-11
  });
});

// ---------------------------------------------------------------------------
// batchResolveSpans
// ---------------------------------------------------------------------------

describe('batchResolveSpans', () => {
  const index = makeIndex();

  it('resolves multiple symbols without merge', () => {
    const result = batchResolveSpans(index, [
      { file_id: 'f1', symbol_id: 's1', neighbor_lines: 0 },
      { file_id: 'f1', symbol_id: 's2', neighbor_lines: 0 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.start).toBe(10);
    expect(result[1]!.start).toBe(35);
  });

  it('applies neighbor expansion per request', () => {
    const result = batchResolveSpans(index, [
      { file_id: 'f1', symbol_id: 's1', neighbor_lines: 2 },
    ]);
    expect(result[0]!.start).toBe(8); // 10 - 2
  });

  it('merges overlapping spans when merge is true', () => {
    // s1: 10-29, s2: 35-44. With 5 neighbor lines:
    // s1 expanded: 5-34, s2 expanded: 30-49 => overlap => 5-49
    const result = batchResolveSpans(
      index,
      [
        { file_id: 'f1', symbol_id: 's1', neighbor_lines: 5 },
        { file_id: 'f1', symbol_id: 's2', neighbor_lines: 5 },
      ],
      { merge: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.start).toBe(5);
  });

  it('throws for unknown file_id in batch', () => {
    expect(() =>
      batchResolveSpans(index, [{ file_id: 'bad', symbol_id: 's1', neighbor_lines: 0 }]),
    ).toThrow(SpanResolutionError);
  });

  it('throws for unknown symbol_id in batch', () => {
    expect(() =>
      batchResolveSpans(index, [{ file_id: 'f1', symbol_id: 'bad', neighbor_lines: 0 }]),
    ).toThrow(SpanResolutionError);
  });

  it('handles cross-file spans without merging across files', () => {
    const result = batchResolveSpans(
      index,
      [
        { file_id: 'f1', symbol_id: 's1', neighbor_lines: 0 },
        { file_id: 'f2', symbol_id: 's3', neighbor_lines: 0 },
      ],
      { merge: true },
    );
    expect(result).toHaveLength(2);
  });
});
