/**
 * Span utilities for the evidence assembler.
 *
 * Pure functions — no I/O. Operates on retrieval-index-v1 metadata to resolve
 * symbol-to-span mappings, expand neighbor lines, and merge overlapping spans
 * deterministically.
 */

import type { RetrievalIndexV1, RetrievalFile, RetrievalSymbol } from '../artifacts/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved span: a contiguous line range within a file. */
export interface ResolvedSpan {
  file_id: string;
  path: string;
  start: number; // 1-indexed
  count: number; // number of lines
}

/** Error thrown when a file or symbol ID cannot be found in the index. */
export class SpanResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpanResolutionError';
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function findFile(index: RetrievalIndexV1, fileId: string): RetrievalFile {
  const file = index.files.find((f) => f.file_id === fileId);
  if (!file) {
    throw new SpanResolutionError(`Unknown file_id: ${fileId}`);
  }
  return file;
}

function findSymbol(file: RetrievalFile, symbolId: string): RetrievalSymbol {
  const sym = file.symbols.find((s) => s.symbol_id === symbolId);
  if (!sym) {
    throw new SpanResolutionError(
      `Unknown symbol_id: ${symbolId} in file ${file.file_id} (${file.path})`,
    );
  }
  return sym;
}

// ---------------------------------------------------------------------------
// Symbol-to-span resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a symbol ID within a file to a span.
 * Both file_id and symbol_id must exist in the index; otherwise throws.
 */
export function resolveSymbolToSpan(
  index: RetrievalIndexV1,
  fileId: string,
  symbolId: string,
): ResolvedSpan {
  const file = findFile(index, fileId);
  const sym = findSymbol(file, symbolId);
  return {
    file_id: file.file_id,
    path: file.path,
    start: sym.start,
    count: sym.count,
  };
}

// ---------------------------------------------------------------------------
// Neighbor-line expansion
// ---------------------------------------------------------------------------

/**
 * Expand a span by `neighborLines` in each direction.
 * Start is clamped to a minimum of 1. Count is adjusted so end never
 * decreases relative to the original span.
 */
export function expandNeighborLines(span: ResolvedSpan, neighborLines: number): ResolvedSpan {
  if (neighborLines <= 0) return { ...span };

  const originalEnd = span.start + span.count - 1;
  const newStart = Math.max(1, span.start - neighborLines);
  const newEnd = originalEnd + neighborLines;
  return {
    file_id: span.file_id,
    path: span.path,
    start: newStart,
    count: newEnd - newStart + 1,
  };
}

// ---------------------------------------------------------------------------
// Deterministic overlap merge
// ---------------------------------------------------------------------------

/**
 * Sort spans deterministically: by file_id, then by start, then by count (descending).
 * Returns a new sorted array.
 */
function sortSpans(spans: ResolvedSpan[]): ResolvedSpan[] {
  return [...spans].sort((a, b) => {
    if (a.file_id !== b.file_id) return a.file_id < b.file_id ? -1 : 1;
    if (a.start !== b.start) return a.start - b.start;
    return b.count - a.count; // larger span first when same start
  });
}

/**
 * Merge overlapping or adjacent spans within the same file.
 *
 * The merge is deterministic: spans are first sorted by (file_id, start, count desc),
 * then merged in a single pass. Spans in different files are never merged.
 *
 * Returns a new array of merged spans.
 */
export function mergeOverlappingSpans(spans: ResolvedSpan[]): ResolvedSpan[] {
  if (spans.length === 0) return [];

  const sorted = sortSpans(spans);
  const merged: ResolvedSpan[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;

    // Different file — cannot merge
    if (current.file_id !== last.file_id) {
      merged.push({ ...current });
      continue;
    }

    const lastEnd = last.start + last.count - 1;
    const currentEnd = current.start + current.count - 1;

    // Overlapping or adjacent (end >= start - 1 means they touch)
    if (current.start <= lastEnd + 1) {
      const newEnd = Math.max(lastEnd, currentEnd);
      last.count = newEnd - last.start + 1;
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Batch resolution: resolve + expand + optionally merge
// ---------------------------------------------------------------------------

export interface SpanRequest {
  file_id: string;
  symbol_id: string;
  neighbor_lines: number;
}

export interface BatchResolveOptions {
  merge: boolean;
}

/**
 * Resolve multiple symbol-to-span requests against a retrieval index,
 * expand each by its neighbor lines, and optionally merge overlaps.
 *
 * Throws SpanResolutionError if any file_id or symbol_id is unknown.
 */
export function batchResolveSpans(
  index: RetrievalIndexV1,
  requests: SpanRequest[],
  options: BatchResolveOptions = { merge: false },
): ResolvedSpan[] {
  const resolved = requests.map((req) => {
    const span = resolveSymbolToSpan(index, req.file_id, req.symbol_id);
    return expandNeighborLines(span, req.neighbor_lines);
  });

  if (options.merge) {
    return mergeOverlappingSpans(resolved);
  }
  return resolved;
}
