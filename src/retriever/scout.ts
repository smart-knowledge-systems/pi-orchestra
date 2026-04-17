/**
 * Deterministic retrieval scout.
 *
 * The scout runs before any model-driven retrieval agent work. It turns the
 * approved intent artifacts (cleaned intent, restatement, retrieval focus,
 * tagged files) into a narrow candidate set so the later agent receives
 * high-signal seeds instead of having to scan the repository itself.
 *
 * Design principles:
 *   - Deterministic: same repo + same inputs produce identical output.
 *     File traversal is sorted, scoring is weighted by provenance, and
 *     ordering tie-breaks are explicit.
 *   - Narrow: at most SCOUT_SELECTED_LIMIT selected and SCOUT_RESERVE_LIMIT
 *     reserve candidates.
 *   - Intent-shaped: terms are weighted by origin (retrieval focus > tagged
 *     files > restatement > cleaned intent) rather than being a bag of all
 *     words from the request.
 *   - Structural-only: no raw file bodies leave the scout boundary. Only
 *     summaries, AST skeletons, and symbol metadata propagate upward.
 *
 * The scout is intentionally file-reading inside its own boundary. Its
 * output is safe to surface to the conductor via `retrieval-index-v1`
 * once normalized.
 *
 * @module retriever/scout
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import type { RetrievalDefaultEvidenceMode, RetrievalSelectionTier } from '../artifacts/types.ts';
import { extractSymbols as extractFileSymbols } from './symbol-extractor.ts';

// ---------------------------------------------------------------------------
// Public limits
// ---------------------------------------------------------------------------

export const SCOUT_SELECTED_LIMIT = 8;
export const SCOUT_RESERVE_LIMIT = 4;

/** Minimum composite score required for a selected candidate. */
const SELECTED_MIN_SCORE = 4;

/** Minimum composite score required for a reserve candidate. */
const RESERVE_MIN_SCORE = 1;

// ---------------------------------------------------------------------------
// Internal configuration
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 256 * 1024;
const MAX_SCAN_DEPTH = 5;
const MAX_TERMS = 24;
const MAX_CONTENT_SAMPLE_BYTES = 128 * 1024;

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
  'i',
  'in',
  'into',
  'is',
  'it',
  'make',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'should',
  'that',
  'the',
  'their',
  'this',
  'to',
  'use',
  'want',
  'we',
  'what',
  'with',
  'would',
]);

// ---------------------------------------------------------------------------
// Term generation — intent-shaped, deterministic, weighted by provenance.
// ---------------------------------------------------------------------------

/** Origin of a scout search term. Higher-weight origins win ordering ties. */
export type ScoutTermKind = 'focus' | 'tag' | 'restatement' | 'intent';

const TERM_KIND_WEIGHT: Record<ScoutTermKind, number> = {
  focus: 4,
  tag: 3,
  restatement: 2,
  intent: 1,
};

export interface ScoutTerm {
  /** Normalized lowercase term. */
  term: string;
  /** Total weight across all originating sources. */
  weight: number;
  /** Sorted list of origins that contributed this term. */
  kinds: ScoutTermKind[];
}

export interface ScoutTermInput {
  cleanedIntent?: string;
  restatedIntent?: string;
  retrievalFocus?: string[];
  taggedFiles?: string[];
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

/**
 * Build curated search terms from the approved intent artifacts.
 *
 * Terms are deduplicated and weighted by origin. A term that appears in
 * retrieval focus contributes more than one only seen in the cleaned
 * intent, so guidance from upstream expansion wins over noise from the
 * raw request. Ordering is deterministic: descending weight, then
 * alphabetical.
 */
export function buildScoutTerms(input: ScoutTermInput): ScoutTerm[] {
  const accum = new Map<string, { weight: number; kinds: Set<ScoutTermKind> }>();

  const add = (terms: Iterable<string>, kind: ScoutTermKind): void => {
    for (const raw of terms) {
      const term = raw.trim().toLowerCase();
      if (!term || term.length < 3) continue;
      if (STOPWORDS.has(term)) continue;
      const entry = accum.get(term) ?? { weight: 0, kinds: new Set<ScoutTermKind>() };
      entry.weight += TERM_KIND_WEIGHT[kind];
      entry.kinds.add(kind);
      accum.set(term, entry);
    }
  };

  for (const focus of input.retrievalFocus ?? []) {
    const tokens = tokenize(focus);
    add(tokens, 'focus');
    const canonical = focus.trim().toLowerCase();
    // Only add the canonical string when it carries more information than the
    // tokens alone (compound identifier like "log-config" or "auth_token").
    if (
      canonical.length >= 3 &&
      canonical.length < 48 &&
      !tokens.includes(canonical) &&
      /[-_.]/.test(canonical)
    ) {
      add([canonical], 'focus');
    }
  }

  for (const tag of input.taggedFiles ?? []) {
    const tokens = tokenize(tag);
    add(tokens, 'tag');
    const base = basename(tag).toLowerCase();
    // Same compound-identifier rule for file basenames like "auth-config.ts".
    if (base.length >= 3 && !tokens.includes(base) && /[-_.]/.test(base)) {
      add([base], 'tag');
    }
  }

  if (input.restatedIntent) add(tokenize(input.restatedIntent), 'restatement');
  if (input.cleanedIntent) add(tokenize(input.cleanedIntent), 'intent');

  return [...accum.entries()]
    .map(([term, info]) => ({
      term,
      weight: info.weight,
      kinds: [...info.kinds].sort(),
    }))
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.term.localeCompare(b.term);
    })
    .slice(0, MAX_TERMS);
}

// ---------------------------------------------------------------------------
// Candidate and result shapes
// ---------------------------------------------------------------------------

/**
 * Coarse role of a scout candidate, used by the later agent and the evidence
 * planner as a hint. Precise classification is intentionally left to the
 * agent; the scout just labels the most common obvious buckets.
 */
export type ScoutFileRole =
  | 'tagged'
  | 'entry-point'
  | 'config'
  | 'doc'
  | 'test'
  | 'implementation'
  | 'unknown';

export interface ScoutSymbolHint {
  kind: string;
  name: string;
  /** 1-indexed start line. */
  start: number;
  /** Line span count (>= 1). */
  count: number;
  /** Heuristic symbol score (higher = more relevant to the curated terms). */
  score: number;
  /** Short, stable reason the scout flagged this symbol. */
  reason: string;
}

export interface ScoutCandidate {
  /** Absolute file path. */
  path: string;
  /** Repo-relative path (for stable rationales/tests). */
  relPath: string;
  /** Selection tier — `selected` is the default-evidence set; `reserve` is near-threshold. */
  tier: RetrievalSelectionTier;
  /** Composite heuristic score. */
  score: number;
  /** Stable rationale string for the conductor to surface. */
  rationale: string;
  /** Coarse role hint. */
  role: ScoutFileRole;
  /** Default-evidence mode hint for the evidence planner. */
  evidenceModeHint: RetrievalDefaultEvidenceMode;
  /** Top symbol hints within the file. */
  topSymbols: ScoutSymbolHint[];
  /** Import paths discovered in the file (raw import strings, deduped). */
  imports: string[];
  /** AST skeleton (top-level declarations), trimmed for prompt budgets. */
  astSkeleton: string[];
  /** One-line structural summary. */
  summary: string;
  /** File line count. */
  lineCount: number;
}

export interface ScoutResult {
  /** Weighted scout terms. */
  terms: ScoutTerm[];
  /** Plain ordered term strings for downstream callers. */
  scoutTerms: string[];
  /** Default-evidence candidate set (narrow). */
  selected: ScoutCandidate[];
  /** Near-threshold candidates the agent may still promote. */
  reserve: ScoutCandidate[];
  /** Import-based cross-file hints, bounded and deduped. */
  crossFileHints: string[];
  /** Known coverage gaps the agent should investigate. */
  gaps: string[];
  /** Strategy summary describing how the scout narrowed the repo. */
  strategySummary: string;
}

export interface ScoutInput extends ScoutTermInput {
  repoRoot: string;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function discoverFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) results.push(fullPath);
      }
    }
  }

  await walk(dir, 0);
  // Deterministic order regardless of filesystem iteration order.
  results.sort();
  return results;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

function extractImports(lines: string[]): string[] {
  const imports = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const match =
      trimmed.match(/from\s+['"]([^'"]+)['"]/) ?? trimmed.match(/require\(['"]([^'"]+)['"]\)/);
    if (match?.[1]) imports.add(match[1]);
  }
  return [...imports];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  // split-based count is fine here; needles are short curated terms.
  return haystack.split(needle).length - 1;
}

function snippet(lines: string[], start: number, count: number, limit = 140): string {
  const from = Math.max(0, start - 1);
  const to = Math.min(lines.length, from + Math.min(count, 8));
  return lines
    .slice(from, to)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

interface SymbolScoringInput {
  symbols: ReturnType<typeof extractFileSymbols>['symbols'];
  lines: string[];
  terms: ScoutTerm[];
}

function scoreSymbols(input: SymbolScoringInput): ScoutSymbolHint[] {
  const hints: ScoutSymbolHint[] = [];
  for (const sym of input.symbols) {
    const nameLower = sym.name.toLowerCase();
    const nameTokens = new Set(tokenize(sym.name));
    const body = snippet(input.lines, sym.start, sym.count).toLowerCase();

    let score = 0;
    const matched: string[] = [];
    for (const t of input.terms) {
      let termScore = 0;
      if (nameLower === t.term) termScore += t.weight * 5;
      else if (nameLower.includes(t.term)) termScore += t.weight * 3;
      if (nameTokens.has(t.term)) termScore += t.weight * 2;
      termScore += Math.min(2, countOccurrences(body, t.term)) * t.weight;
      if (termScore > 0) {
        score += termScore;
        if (matched.length < 3) matched.push(t.term);
      }
    }

    if (sym.kind === 'class' || sym.kind === 'function') score += 1;

    if (score > 0) {
      hints.push({
        kind: sym.kind,
        name: sym.name,
        start: sym.start,
        count: sym.count,
        score,
        reason:
          matched.length > 0
            ? `name/body aligns with ${matched.join(', ')}`
            : `${sym.kind} on a high-signal file`,
      });
    }
  }

  hints.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.start - b.start;
  });
  return hints;
}

// ---------------------------------------------------------------------------
// File scoring
// ---------------------------------------------------------------------------

interface FileScoring {
  score: number;
  reasons: string[];
  pathHits: string[];
  taggedMatch: string | null;
}

function matchesTaggedPath(
  lowerRel: string,
  lowerAbs: string,
  taggedLower: string[],
): string | null {
  for (const tagged of taggedLower) {
    if (!tagged) continue;
    if (lowerRel === tagged) return tagged;
    if (lowerAbs === tagged) return tagged;
    if (lowerRel.endsWith(`/${tagged}`) || lowerAbs.endsWith(`/${tagged}`)) return tagged;
    if (lowerRel.endsWith(tagged) && tagged.includes('/')) return tagged;
  }
  return null;
}

function scoreFile(args: {
  relPath: string;
  absPath: string;
  lowerContent: string;
  terms: ScoutTerm[];
  taggedLower: string[];
  symbolHints: ScoutSymbolHint[];
}): FileScoring {
  const { relPath, absPath, lowerContent, terms, taggedLower, symbolHints } = args;
  const lowerRel = relPath.toLowerCase();
  const lowerAbs = absPath.toLowerCase();
  const baseLower = basename(relPath).toLowerCase();

  const reasons: string[] = [];
  const pathHits: string[] = [];
  let score = 0;

  const taggedMatch = matchesTaggedPath(lowerRel, lowerAbs, taggedLower);
  if (taggedMatch) {
    score += 50;
    reasons.push(`user-tagged file (${taggedMatch})`);
  }

  for (const t of terms) {
    let termScore = 0;
    if (baseLower === t.term) termScore += t.weight * 8;
    else if (baseLower.includes(t.term)) termScore += t.weight * 4;
    if (lowerRel.includes(t.term)) {
      termScore += t.weight * 2;
      pathHits.push(t.term);
    }
    termScore += Math.min(3, countOccurrences(lowerContent, t.term)) * t.weight;
    if (termScore > 0) score += termScore;
  }

  // Symbol contribution — bounded so a single hot symbol can't dominate.
  const topSymbols = symbolHints.slice(0, 3);
  if (topSymbols.length > 0) {
    const contribution = topSymbols.reduce((acc, s) => acc + Math.min(8, s.score), 0);
    score += contribution;
    reasons.push(`relevant symbols: ${topSymbols.map((s) => s.name).join(', ')}`);
  }

  if (pathHits.length > 0 && !reasons.some((r) => r.startsWith('path match'))) {
    const uniquePathHits = [...new Set(pathHits)].slice(0, 4);
    reasons.push(`path match on ${uniquePathHits.join(', ')}`);
  }

  if (reasons.length === 0 && score > 0) {
    reasons.push('weak keyword match only');
  }

  return { score, reasons, pathHits: [...new Set(pathHits)], taggedMatch };
}

// ---------------------------------------------------------------------------
// Role + evidence-mode inference
// ---------------------------------------------------------------------------

function inferRole(relPath: string, tagged: boolean): ScoutFileRole {
  if (tagged) return 'tagged';
  const lower = relPath.toLowerCase();
  const ext = extname(lower);
  const base = basename(lower, ext);

  if (/(?:^|\/)(tests?|__tests__|spec)\//.test(lower)) return 'test';
  if (/\.(test|spec)\.(t|j)sx?$/.test(lower)) return 'test';
  if (ext === '.md' || ext === '.txt') return 'doc';
  if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || base === '.env') {
    return 'config';
  }
  if (
    base === 'index' ||
    base === 'main' ||
    /(?:^|\/)(bin|cli|entrypoint|entry)\//.test(lower) ||
    /extensions?\//.test(lower)
  ) {
    return 'entry-point';
  }
  return 'implementation';
}

function inferEvidenceMode(
  role: ScoutFileRole,
  lineCount: number,
  score: number,
  topSymbolScore: number,
): RetrievalDefaultEvidenceMode {
  // Tagged files are worth spans by default — the user explicitly pointed here.
  if (role === 'tagged') {
    if (lineCount <= 60) return 'whole_file';
    return topSymbolScore >= 6 ? 'spans' : 'summary+ast';
  }

  if (role === 'doc' || role === 'config') return 'summary';

  if (topSymbolScore >= 10) return 'spans';
  if (lineCount <= 40 && score >= 14) return 'whole_file';
  if (topSymbolScore >= 6) return 'spans';
  if (score >= 14) return 'summary+ast';
  return 'summary';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

interface ScoredFile {
  absPath: string;
  relPath: string;
  lines: string[];
  content: string;
  score: number;
  reasons: string[];
  pathHits: string[];
  taggedMatch: string | null;
  topSymbols: ScoutSymbolHint[];
  imports: string[];
  astSkeleton: string[];
}

async function analyseFile(
  absPath: string,
  repoRoot: string,
  terms: ScoutTerm[],
  taggedLower: string[],
): Promise<ScoredFile | null> {
  let fileStat;
  try {
    fileStat = await stat(absPath);
  } catch {
    return null;
  }
  if (fileStat.size > MAX_FILE_SIZE) return null;

  let content: string;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch {
    return null;
  }

  const sample =
    content.length > MAX_CONTENT_SAMPLE_BYTES
      ? content.slice(0, MAX_CONTENT_SAMPLE_BYTES)
      : content;
  const lines = sample.split('\n');
  const relPath = relative(repoRoot, absPath);

  const extraction = extractFileSymbols(absPath, sample);
  const symbolHints = scoreSymbols({ symbols: extraction.symbols, lines, terms });

  const scoring = scoreFile({
    relPath,
    absPath,
    lowerContent: sample.toLowerCase(),
    terms,
    taggedLower,
    symbolHints,
  });

  if (scoring.score <= 0 && !scoring.taggedMatch) return null;

  return {
    absPath,
    relPath,
    lines,
    content: sample,
    score: scoring.score,
    reasons: scoring.reasons,
    pathHits: scoring.pathHits,
    taggedMatch: scoring.taggedMatch,
    topSymbols: symbolHints.slice(0, 5),
    imports: extractImports(lines),
    astSkeleton: extraction.astSkeleton.slice(0, 12),
  };
}

function buildCandidate(file: ScoredFile, tier: RetrievalSelectionTier): ScoutCandidate {
  const role = inferRole(file.relPath, file.taggedMatch !== null);
  const topSymbolScore = file.topSymbols[0]?.score ?? 0;
  const evidenceModeHint = inferEvidenceMode(role, file.lines.length, file.score, topSymbolScore);

  const summary = `${file.relPath} — ${file.lines.length} lines, ${file.topSymbols.length} scored symbol(s)`;
  const rationale =
    file.reasons.length > 0 ? file.reasons.join('; ') : 'matched curated scout terms';

  return {
    path: file.absPath,
    relPath: file.relPath,
    tier,
    score: file.score,
    rationale,
    role,
    evidenceModeHint,
    topSymbols: file.topSymbols,
    imports: file.imports,
    astSkeleton: file.astSkeleton,
    summary,
    lineCount: file.lines.length,
  };
}

function buildCrossFileHints(files: ScoredFile[]): string[] {
  const byBase = new Map<string, string>();
  for (const f of files) {
    byBase.set(basename(f.relPath, extname(f.relPath)), f.relPath);
  }
  const hints = new Set<string>();
  for (const f of files) {
    for (const imp of f.imports) {
      const normalized = imp.replace(/^\.+\//, '');
      const target = byBase.get(basename(normalized, extname(normalized)));
      if (target && target !== f.relPath) {
        hints.add(`${f.relPath} imports ${imp} → candidate ${target}`);
      }
    }
  }
  return [...hints].sort().slice(0, 8);
}

function buildGaps(files: ScoredFile[], terms: ScoutTerm[], taggedFiles: string[]): string[] {
  const gaps: string[] = [];
  if (files.length === 0) {
    gaps.push('No files matched the curated scout terms');
  } else if (files.length < 3) {
    gaps.push(
      'Few files matched — scout may need broader architectural terms or additional tagged files',
    );
  }

  const covered = new Set<string>();
  const haystack = files.map((f) => `${f.relPath} ${f.content.toLowerCase()}`).join('\n');
  for (const t of terms) {
    if (haystack.includes(t.term)) covered.add(t.term);
  }
  const missing = terms.filter((t) => !covered.has(t.term)).slice(0, 3);
  for (const t of missing) {
    gaps.push(`term "${t.term}" (kinds: ${t.kinds.join('+')}) not located in any candidate file`);
  }

  const coveredPaths = files.map((f) => f.relPath.toLowerCase());
  for (const tagged of taggedFiles) {
    const lower = tagged.toLowerCase();
    const matched = coveredPaths.some(
      (p) => p === lower || p.endsWith(`/${lower}`) || p.endsWith(lower),
    );
    if (!matched) gaps.push(`tagged file not surfaced: ${tagged}`);
  }

  return [...new Set(gaps)];
}

function buildStrategySummary(
  terms: ScoutTerm[],
  selected: ScoutCandidate[],
  reserve: ScoutCandidate[],
  taggedCount: number,
): string {
  const topTerms = terms
    .slice(0, 5)
    .map((t) => `${t.term}(${t.weight})`)
    .join(', ');
  const parts = [
    `scout terms: ${topTerms || 'none'}`,
    `selected=${selected.length}/${SCOUT_SELECTED_LIMIT}`,
    `reserve=${reserve.length}/${SCOUT_RESERVE_LIMIT}`,
  ];
  if (taggedCount > 0) parts.push(`tagged-boosted=${taggedCount}`);
  return parts.join('; ');
}

/**
 * Run the deterministic scout against a repository.
 *
 * Returns a narrow candidate set plus curated terms, cross-file hints, and
 * gaps. The result is structural-only — raw file bodies stay inside this
 * function. The retriever agent (Phase 4) will read files through a
 * separate bounded executor.
 */
export async function runScout(input: ScoutInput): Promise<ScoutResult> {
  const terms = buildScoutTerms(input);
  const taggedFiles = input.taggedFiles ?? [];
  const taggedLower = taggedFiles.map((t) => t.toLowerCase());

  const allFiles = await discoverFiles(input.repoRoot);
  const scored: ScoredFile[] = [];

  // Sequential rather than parallel for deterministic counter behavior in the
  // symbol extractor (it allocates ids from a module-local counter). The file
  // list is already bounded and sorted.
  for (const abs of allFiles) {
    const entry = await analyseFile(abs, input.repoRoot, terms, taggedLower);
    if (entry) scored.push(entry);
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.relPath.localeCompare(b.relPath);
  });

  const selectedRaw: ScoredFile[] = [];
  const reserveRaw: ScoredFile[] = [];
  for (const entry of scored) {
    if (
      selectedRaw.length < SCOUT_SELECTED_LIMIT &&
      (entry.score >= SELECTED_MIN_SCORE || entry.taggedMatch !== null)
    ) {
      selectedRaw.push(entry);
    } else if (reserveRaw.length < SCOUT_RESERVE_LIMIT && entry.score >= RESERVE_MIN_SCORE) {
      reserveRaw.push(entry);
    }
    if (selectedRaw.length >= SCOUT_SELECTED_LIMIT && reserveRaw.length >= SCOUT_RESERVE_LIMIT) {
      break;
    }
  }

  const selected = selectedRaw.map((f) => buildCandidate(f, 'selected'));
  const reserve = reserveRaw.map((f) => buildCandidate(f, 'reserve'));

  const taggedBoosted = selected.filter((c) => c.role === 'tagged').length;

  return {
    terms,
    scoutTerms: terms.map((t) => t.term),
    selected,
    reserve,
    crossFileHints: buildCrossFileHints([...selectedRaw, ...reserveRaw]),
    gaps: buildGaps([...selectedRaw, ...reserveRaw], terms, taggedFiles),
    strategySummary: buildStrategySummary(terms, selected, reserve, taggedBoosted),
  };
}
