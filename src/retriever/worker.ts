/**
 * Retriever worker — inspects the repository and produces raw retrieval output.
 *
 * This worker is a separate boundary from the conductor. It MAY read raw
 * source files and use search powers. Its output is normalized before being
 * surfaced to the conductor, ensuring no raw full-file payloads leak.
 *
 * Current implementation: heuristic but more agentic than a pure bag-of-words
 * pass. It crafts focused search terms, boosts user-tagged files, reasons about
 * symbol-level relevance, and emits expansion recommendations the conductor can
 * use to keep evidence bundles narrow.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
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
const MAX_FILES = 12;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'what',
  'with',
]);

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
        const ext = extname(entry.name).toLowerCase();
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
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      const linesBefore = content.slice(0, match.index).split('\n');
      const startLine = linesBefore.length;

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
        endLine = i + 1;
        if (foundOpen && braceDepth <= 0) break;
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
      skeleton.push(trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed);
    }
  }
  return skeleton;
}

// ---------------------------------------------------------------------------
// Intent-aware heuristics
// ---------------------------------------------------------------------------

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function splitCamelCase(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9_./-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function tokenize(value: string): string[] {
  return splitCamelCase(value)
    .flatMap((part) => part.split(/[\/._-]+/))
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3 && !STOPWORDS.has(part));
}

function describeScore(score: number): 'high' | 'medium' | 'low' {
  if (score >= 14) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}

function describePriority(score: number): 'high' | 'medium' | 'low' {
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

function summarizeSnippet(lines: string[], start: number, count: number): string {
  const from = Math.max(0, start - 1);
  const to = Math.min(lines.length, from + Math.min(count, 8));
  const snippet = lines
    .slice(from, to)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
  return snippet;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function scoreSymbol(symbol: ExtractedSymbol, lines: string[], queryTerms: string[]): number {
  const symbolTerms = tokenize(symbol.name);
  const window = summarizeSnippet(lines, symbol.start, symbol.count).toLowerCase();

  let score = 0;
  for (const term of queryTerms) {
    if (symbol.name.toLowerCase().includes(term)) score += 5;
    if (symbolTerms.includes(term)) score += 3;
    score += Math.min(2, countOccurrences(window, term));
  }

  if (symbol.kind === 'class' || symbol.kind === 'function') score += 1;
  return score;
}

function buildFileSummary(
  relPath: string,
  lines: string[],
  symbols: ExtractedSymbol[],
  imports: string[],
): string {
  const summaryParts = [`${relPath} — ${lines.length} lines`, `${symbols.length} symbol(s)`];
  if (imports.length > 0) {
    summaryParts.push(`${imports.length} import(s)`);
  }
  return summaryParts.join(', ');
}

function extractImports(lines: string[]): string[] {
  const imports: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match =
      trimmed.match(/from\s+['"]([^'"]+)['"]/) ?? trimmed.match(/require\(['"]([^'"]+)['"]\)/);
    if (match?.[1]) {
      imports.push(match[1]);
    }
  }
  return unique(imports);
}

function scoreFileRelevance(
  relPath: string,
  lines: string[],
  queryTerms: string[],
  taggedFiles: string[],
  symbolScores: Array<{ name: string; score: number }>,
): {
  score: number;
  reasons: string[];
} {
  const lowerContent = lines.join('\n').toLowerCase();
  const lowerPath = relPath.toLowerCase();
  const baseName = basename(relPath).toLowerCase();
  const taggedLower = taggedFiles.map((file) => file.toLowerCase());
  const reasons: string[] = [];

  let score = 0;

  const exactTag = taggedLower.find((file) => lowerPath === file || lowerPath.endsWith(file));
  if (exactTag) {
    score += 18;
    reasons.push(`user tagged file match (${exactTag})`);
  }

  for (const term of queryTerms) {
    let termScore = 0;
    if (lowerPath.includes(term)) termScore += 6;
    if (baseName.includes(term)) termScore += 3;
    termScore += Math.min(4, countOccurrences(lowerContent, term));
    if (termScore > 0) {
      score += termScore;
    }
  }

  const topSymbols = symbolScores.filter((symbol) => symbol.score >= 6).slice(0, 3);
  if (topSymbols.length > 0) {
    const symbolContribution = topSymbols.reduce(
      (sum, symbol) => sum + Math.min(6, symbol.score),
      0,
    );
    score += symbolContribution;
    reasons.push(`relevant symbols: ${topSymbols.map((symbol) => symbol.name).join(', ')}`);
  }

  if (reasons.length === 0 && score > 0) {
    reasons.push(`matched ${Math.min(queryTerms.length, 4)} curated search terms`);
  }

  return { score, reasons };
}

function buildCrossFileFindings(files: Array<{ relPath: string; imports: string[] }>): string[] {
  const byBaseName = new Map<string, string>();
  for (const file of files) {
    byBaseName.set(basename(file.relPath, extname(file.relPath)), file.relPath);
  }

  const findings: string[] = [];
  for (const file of files) {
    for (const imp of file.imports) {
      const normalized = imp.replace(/^\.\//, '').replace(/^\.\.\//, '');
      const targetBase = basename(normalized, extname(normalized));
      const target = byBaseName.get(targetBase);
      if (target && target !== file.relPath) {
        findings.push(`${file.relPath} appears connected to ${target} via import ${imp}`);
      }
    }
  }

  return unique(findings).slice(0, 8);
}

function buildFollowupQueries(queryTerms: string[], files: RawRetrievalFile[]): string[] {
  const covered = new Set<string>();
  for (const file of files) {
    const haystack =
      `${file.path} ${file.why_relevant} ${file.file_summary} ${file.symbols?.map((symbol) => symbol.name).join(' ') ?? ''}`.toLowerCase();
    for (const term of queryTerms) {
      if (haystack.includes(term)) {
        covered.add(term);
      }
    }
  }

  const missing = queryTerms.filter((term) => !covered.has(term));
  return unique(
    missing.slice(0, 4).map((term) => `look for ${term}-related callsites or configuration`),
  );
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export interface RetrieverWorkerInput {
  repoRoot: string;
  query: string;
  /** Optional retrieval focus hints from the intent spec. */
  retrievalFocus?: string[];
  /** Curated search terms assembled from intent artifacts. */
  searchTerms?: string[];
  /** User-tagged files carried through explicitly. */
  taggedFiles?: string[];
}

/**
 * Run the retriever worker against the repository.
 *
 * This is the only function that reads raw source files. Its output is
 * normalized by `normalizeRetrievalOutput` before being stored or
 * surfaced to the conductor.
 */
export async function runRetrieverWorker(input: RetrieverWorkerInput): Promise<RawRetrievalOutput> {
  const { repoRoot, query, retrievalFocus, searchTerms, taggedFiles } = input;

  const queryTerms = unique([
    ...(searchTerms ?? []),
    ...tokenize(query),
    ...(retrievalFocus ?? []).flatMap(tokenize),
    ...(taggedFiles ?? []).flatMap(tokenize),
  ]).slice(0, 32);

  const allFiles = await discoverFiles(repoRoot);
  const scored: Array<{
    path: string;
    relPath: string;
    lines: string[];
    score: number;
    reasons: string[];
    imports: string[];
    symbols: ExtractedSymbol[];
    symbolScores: Array<{ symbol: ExtractedSymbol; score: number }>;
  }> = [];

  for (const filePath of allFiles) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE) continue;

      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const relPath = relative(repoRoot, filePath);
      const symbols = extractSymbols(lines);
      const symbolScores = symbols.map((symbol) => ({
        symbol,
        score: scoreSymbol(symbol, lines, queryTerms),
      }));
      const imports = extractImports(lines);
      const scoredFile = scoreFileRelevance(
        relPath,
        lines,
        queryTerms,
        taggedFiles ?? [],
        symbolScores.map(({ symbol, score }) => ({ name: symbol.name, score })),
      );

      if (scoredFile.score > 0) {
        scored.push({
          path: filePath,
          relPath,
          lines,
          score: scoredFile.score,
          reasons: scoredFile.reasons,
          imports,
          symbols,
          symbolScores,
        });
      }
    } catch {
      continue;
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.relPath.localeCompare(b.relPath);
  });
  const topFiles = scored.slice(0, MAX_FILES);

  const files: RawRetrievalFile[] = topFiles.map((entry) => {
    const topSymbolScore =
      entry.symbolScores.length > 0 ? Math.max(...entry.symbolScores.map((item) => item.score)) : 0;
    const recommendedExpansion =
      topSymbolScore >= 8
        ? 'span'
        : entry.symbols.length === 0 && entry.score >= 14
          ? 'file'
          : 'none';
    const expansionReason =
      recommendedExpansion === 'span'
        ? 'Contains high-signal symbols aligned with the retrieval objective'
        : recommendedExpansion === 'file'
          ? 'High file-level relevance but no extractable symbols; include the whole file if needed'
          : 'Structural summary is likely sufficient';

    return {
      path: entry.path,
      why_relevant:
        entry.reasons.join('; ') ||
        `matched curated search terms: ${queryTerms.slice(0, 4).join(', ')}`,
      file_summary: buildFileSummary(entry.relPath, entry.lines, entry.symbols, entry.imports),
      ast_skeleton: generateAstSkeleton(entry.lines),
      recommended_expansion: recommendedExpansion,
      expansion_reason: expansionReason,
      symbols: entry.symbolScores
        .sort((a, b) => b.score - a.score || a.symbol.start - b.symbol.start)
        .map<RawRetrievalSymbol>(({ symbol, score }) => ({
          kind: symbol.kind,
          name: symbol.name,
          start: symbol.start,
          count: symbol.count,
          summary:
            summarizeSnippet(entry.lines, symbol.start, symbol.count) ||
            `${symbol.kind} ${symbol.name}`,
          role_in_system:
            symbol.kind === 'class'
              ? 'type boundary or stateful unit'
              : 'behavior entrypoint or helper',
          depends_on: entry.imports.slice(0, 4),
          used_by: [],
          relevance: describeScore(score),
          change_likelihood: score >= 10 ? 'high' : score >= 5 ? 'medium' : 'low',
          expansion_priority: describePriority(score),
          recommended_expansion: score >= 7 ? 'span' : 'none',
          expansion_reason:
            score >= 7
              ? 'Symbol name or local body aligns strongly with curated retrieval terms'
              : 'Symbol appears peripheral to the current objective',
        })),
    };
  });

  const gaps: string[] = [];
  if (files.length === 0) {
    gaps.push('No files matched the curated retrieval terms');
  } else if (files.length < 3) {
    gaps.push(
      'Few files matched — retrieval may need broader architectural terms or additional tagged files',
    );
  }

  const coveredTagged = new Set(files.map((file) => relative(repoRoot, file.path).toLowerCase()));
  for (const tagged of taggedFiles ?? []) {
    const lower = tagged.toLowerCase();
    const matched = [...coveredTagged].some((file) => file === lower || file.endsWith(lower));
    if (!matched) {
      gaps.push(`Tagged file not surfaced in top retrieval results: ${tagged}`);
    }
  }

  let confidence = 'medium';
  if (files.length === 0) confidence = 'low';
  else if (topFiles.length >= 4 && topFiles[0] && topFiles[0].score >= 20) confidence = 'high';

  return {
    query,
    confidence,
    files,
    cross_file_findings: buildCrossFileFindings(topFiles),
    gaps: unique(gaps),
    followup_queries: buildFollowupQueries(queryTerms, files),
  };
}
