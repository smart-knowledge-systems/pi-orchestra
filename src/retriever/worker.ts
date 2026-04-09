/**
 * Retriever worker — inspects the repository and produces raw retrieval output.
 *
 * This worker is a separate boundary from the conductor. It MAY read raw
 * source files and use search powers. Its output is normalized before being
 * surfaced to the conductor, ensuring no raw full-file payloads leak.
 *
 * Current implementation: conservative first pass using lexical file search,
 * basic function/class symbol extraction, and file summaries. Semantic
 * retrieval and robust AST parsing are deferred.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { RawRetrievalOutput, RawRetrievalFile, RawRetrievalSymbol } from './normalize.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Extensions considered source files for retrieval. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.txt',
  '.sh',
  '.bash',
  '.zsh',
]);

/** Directories to skip during traversal. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.pi',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.next',
  '.nuxt',
  '.svelte-kit',
]);

/** Maximum file size in bytes to read (256 KB). */
const MAX_FILE_SIZE = 256 * 1024;

/** Maximum number of files to include in retrieval output. */
const MAX_FILES = 30;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function discoverFiles(dir: string, maxDepth = 5): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dir, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Symbol extraction — conservative regex-based approach
// ---------------------------------------------------------------------------

interface ExtractedSymbol {
  kind: string;
  name: string;
  start: number;
  count: number;
}

const SYMBOL_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'function', pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm },
  { kind: 'class', pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm },
  { kind: 'interface', pattern: /^(?:export\s+)?interface\s+(\w+)/gm },
  { kind: 'type', pattern: /^(?:export\s+)?type\s+(\w+)\s*=/gm },
  { kind: 'const', pattern: /^(?:export\s+)?const\s+(\w+)\s*[:=]/gm },
];

function extractSymbols(lines: string[]): ExtractedSymbol[] {
  const content = lines.join('\n');
  const symbols: ExtractedSymbol[] = [];

  for (const { kind, pattern } of SYMBOL_PATTERNS) {
    // Reset lastIndex for each use
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      // Calculate 1-indexed line number from character offset
      const linesBefore = content.slice(0, match.index).split('\n');
      const startLine = linesBefore.length; // already 1-indexed since split of non-empty gives count

      // Estimate symbol span — find the next blank line or end-of-scope
      let endLine = startLine;
      let braceDepth = 0;
      let foundOpen = false;
      for (let i = startLine - 1; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const ch of line) {
          if (ch === '{') {
            braceDepth++;
            foundOpen = true;
          }
          if (ch === '}') braceDepth--;
        }
        endLine = i + 1; // 1-indexed
        if (foundOpen && braceDepth <= 0) break;
        // For single-line declarations (const, type), stop at first semicolon
        if (!foundOpen && (kind === 'const' || kind === 'type') && line.includes(';')) break;
      }

      symbols.push({
        kind,
        name: name!,
        start: startLine,
        count: Math.max(1, endLine - startLine + 1),
      });
    }
  }

  // Dedupe by name+start
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.name}:${s.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// AST skeleton generation — lightweight line-based approach
// ---------------------------------------------------------------------------

function generateAstSkeleton(lines: string[]): string[] {
  const skeleton: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Include top-level declarations
    if (
      /^(?:export\s+)?(?:async\s+)?function\s+/.test(trimmed) ||
      /^(?:export\s+)?(?:abstract\s+)?class\s+/.test(trimmed) ||
      /^(?:export\s+)?interface\s+/.test(trimmed) ||
      /^(?:export\s+)?type\s+\w+\s*=/.test(trimmed) ||
      /^(?:export\s+)?const\s+\w+\s*[:=]/.test(trimmed) ||
      /^(?:export\s+)?(?:let|var)\s+\w+/.test(trimmed) ||
      /^import\s+/.test(trimmed) ||
      /^export\s+\{/.test(trimmed) ||
      /^export\s+default\s+/.test(trimmed)
    ) {
      // Truncate long lines for skeleton
      skeleton.push(trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed);
    }
  }
  return skeleton;
}

// ---------------------------------------------------------------------------
// Relevance scoring — keyword-based for the conservative first pass
// ---------------------------------------------------------------------------

function scoreFileRelevance(filePath: string, lines: string[], queryTerms: string[]): number {
  const lowerContent = lines.join('\n').toLowerCase();
  const lowerPath = filePath.toLowerCase();

  let score = 0;
  for (const term of queryTerms) {
    const lower = term.toLowerCase();
    // Path match is high signal
    if (lowerPath.includes(lower)) score += 3;
    // Content match
    const matches = lowerContent.split(lower).length - 1;
    score += Math.min(matches, 5); // cap per-term contribution
  }
  return score;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export interface RetrieverWorkerInput {
  repoRoot: string;
  query: string;
  /** Optional retrieval focus hints from the intent spec. */
  retrievalFocus?: string[];
}

/**
 * Run the retriever worker against the repository.
 *
 * This is the only function that reads raw source files. Its output is
 * normalized by `normalizeRetrievalOutput` before being stored or
 * surfaced to the conductor.
 */
export async function runRetrieverWorker(input: RetrieverWorkerInput): Promise<RawRetrievalOutput> {
  const { repoRoot, query, retrievalFocus } = input;

  // Build query terms from the query string and retrieval focus hints
  const queryTerms = [...query.split(/\s+/).filter((t) => t.length > 2), ...(retrievalFocus ?? [])];

  // Discover source files
  const allFiles = await discoverFiles(repoRoot);

  // Score and rank files by relevance
  const scored: Array<{ path: string; lines: string[]; score: number }> = [];

  for (const filePath of allFiles) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE) continue;

      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const score = scoreFileRelevance(filePath, lines, queryTerms);

      if (score > 0) {
        scored.push({ path: filePath, lines, score });
      }
    } catch {
      continue;
    }
  }

  // Sort by score descending and take top N
  scored.sort((a, b) => b.score - a.score);
  const topFiles = scored.slice(0, MAX_FILES);

  // Build raw retrieval files
  const files: RawRetrievalFile[] = topFiles.map((entry) => {
    const symbols = extractSymbols(entry.lines);
    const relPath = relative(repoRoot, entry.path);

    return {
      path: entry.path, // absolute path
      why_relevant: `Matched ${entry.score} query term(s) for: ${queryTerms.slice(0, 3).join(', ')}`,
      file_summary: `${relPath} — ${entry.lines.length} lines, ${symbols.length} symbols`,
      ast_skeleton: generateAstSkeleton(entry.lines),
      recommended_expansion: symbols.length > 0 ? 'span' : 'none',
      expansion_reason:
        symbols.length > 0 ? `Contains ${symbols.length} extractable symbol(s)` : '',
      symbols: symbols.map<RawRetrievalSymbol>((s) => ({
        kind: s.kind,
        name: s.name,
        start: s.start,
        count: s.count,
        summary: `${s.kind} ${s.name}`,
        relevance: 'medium',
      })),
      // raw_content is intentionally NOT set — we never propagate it
    };
  });

  // Identify gaps
  const gaps: string[] = [];
  if (topFiles.length === 0) {
    gaps.push('No files matched the query terms');
  } else if (topFiles.length < 3) {
    gaps.push('Few files matched — query may need refinement');
  }

  // Determine confidence
  let confidence = 'medium';
  if (topFiles.length === 0) confidence = 'low';
  else if (topFiles.length >= 5 && topFiles[0]!.score >= 5) confidence = 'high';

  return {
    query,
    confidence,
    files,
    cross_file_findings: [],
    gaps,
    followup_queries: [],
  };
}
