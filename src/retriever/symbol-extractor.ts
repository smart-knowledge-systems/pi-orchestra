/**
 * Symbol and span metadata extractor.
 *
 * Extracts function/class/interface/type/const symbol ranges from source
 * file content. All line numbers are 1-indexed. Paths must be absolute
 * (the caller is responsible for providing absolute paths).
 *
 * Also produces a lightweight AST skeleton of top-level declarations.
 *
 * Current implementation: regex-based conservative extraction. Robust
 * language-aware AST parsing is deferred to a later phase.
 *
 * @module retriever/symbol-extractor
 */

import { isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedSymbol {
  /** Unique symbol ID within the file (assigned by caller or auto-generated). */
  symbol_id: string;
  /** Symbol kind: function, class, interface, type, const. */
  kind: string;
  /** Symbol name. */
  name: string;
  /** 1-indexed start line. */
  start: number;
  /** Number of lines the symbol spans. */
  count: number;
}

export interface ExtractionResult {
  /** Absolute file path. */
  path: string;
  /** Extracted symbols with 1-indexed line ranges. */
  symbols: ExtractedSymbol[];
  /** Lightweight AST skeleton of top-level declarations. */
  astSkeleton: string[];
}

// ---------------------------------------------------------------------------
// Symbol patterns — conservative regex approach
// ---------------------------------------------------------------------------

const SYMBOL_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'function', pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm },
  { kind: 'class', pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm },
  { kind: 'interface', pattern: /^(?:export\s+)?interface\s+(\w+)/gm },
  { kind: 'type', pattern: /^(?:export\s+)?type\s+(\w+)\s*=/gm },
  { kind: 'const', pattern: /^(?:export\s+)?const\s+(\w+)\s*[:=]/gm },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the 1-indexed line number for a character offset in content.
 */
function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Estimate the end line of a symbol starting at `startLine` (0-indexed
 * into `lines` array). Uses brace-depth tracking for block symbols and
 * semicolon detection for single-line declarations.
 */
function estimateEndLine(lines: string[], startIdx: number, kind: string): number {
  let braceDepth = 0;
  let foundOpen = false;
  let endIdx = startIdx;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const ch of line) {
      if (ch === '{') {
        braceDepth++;
        foundOpen = true;
      }
      if (ch === '}') braceDepth--;
    }
    endIdx = i;
    if (foundOpen && braceDepth <= 0) break;
    // Single-line declarations (const, type) end at first semicolon
    if (!foundOpen && (kind === 'const' || kind === 'type') && line.includes(';')) break;
  }

  return endIdx;
}

// ---------------------------------------------------------------------------
// AST skeleton generation
// ---------------------------------------------------------------------------

const SKELETON_PATTERNS: RegExp[] = [
  /^(?:export\s+)?(?:async\s+)?function\s+/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+/,
  /^(?:export\s+)?interface\s+/,
  /^(?:export\s+)?type\s+\w+\s*=/,
  /^(?:export\s+)?const\s+\w+\s*[:=]/,
  /^(?:export\s+)?(?:let|var)\s+\w+/,
  /^import\s+/,
  /^export\s+\{/,
  /^export\s+default\s+/,
];

/**
 * Generate a lightweight AST skeleton from file lines.
 *
 * Includes only top-level declarations, imports, and exports.
 * Long lines are truncated to 120 characters.
 */
export function generateAstSkeleton(lines: string[]): string[] {
  const skeleton: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (SKELETON_PATTERNS.some((p) => p.test(trimmed))) {
      skeleton.push(trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed);
    }
  }
  return skeleton;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

let symbolCounter = 0;

/** Reset internal counter (for testing determinism). */
export function resetSymbolCounter(): void {
  symbolCounter = 0;
}

/**
 * Extract symbols and AST skeleton from file content.
 *
 * @param absolutePath — Must be an absolute file path.
 * @param content — Raw file content as a string.
 * @returns ExtractionResult with 1-indexed line numbers and absolute path.
 * @throws Error if path is not absolute.
 */
export function extractSymbols(absolutePath: string, content: string): ExtractionResult {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`Path must be absolute, got: ${absolutePath}`);
  }

  const lines = content.split('\n');
  const symbols: ExtractedSymbol[] = [];

  for (const { kind, pattern } of SYMBOL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1]!;
      const startLine = lineNumberAt(content, match.index);
      const startIdx = startLine - 1; // 0-indexed for array access
      const endIdx = estimateEndLine(lines, startIdx, kind);
      const count = Math.max(1, endIdx - startIdx + 1);

      symbols.push({
        symbol_id: `sym_${++symbolCounter}`,
        kind,
        name,
        start: startLine,
        count,
      });
    }
  }

  // Dedupe by name+start
  const seen = new Set<string>();
  const deduped = symbols.filter((s) => {
    const key = `${s.name}:${s.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    path: absolutePath,
    symbols: deduped,
    astSkeleton: generateAstSkeleton(lines),
  };
}
