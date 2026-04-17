/**
 * Deterministic retrieval action executor.
 *
 * The retriever agent emits structured actions; this module executes them
 * inside strict repository and byte/line bounds and returns structural
 * observations the agent can feed back into the next round. The executor
 * stays inside the retrieval boundary: its raw file reads never escape.
 *
 * Responsibilities:
 *   - validate that paths stay inside the configured repo root
 *   - read files with bounded window and byte limits
 *   - perform case-insensitive literal content search with hit caps
 *   - list repo-relative paths matching a substring
 *   - resolve an import specifier list against the repo tree
 *
 * The executor is intentionally dumb: it does not score, rank, or rewrite.
 *
 * @module retriever/executor
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type {
  AgentLimits,
  FollowImportsObservation,
  ReadFileAction,
  ReadFileObservation,
  RetrievalAction,
  RetrievalObservation,
  SearchContentAction,
  SearchContentHit,
  SearchContentObservation,
  SearchPathsAction,
  SearchPathsObservation,
} from './agent-types.ts';

// ---------------------------------------------------------------------------
// Executor configuration
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 512 * 1024;
const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVER_BYTES_PER_FILE = 256 * 1024;

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

// ---------------------------------------------------------------------------
// Executor state
// ---------------------------------------------------------------------------

export interface ExecutorState {
  readonly repoRoot: string;
  readonly limits: AgentLimits;
  fileReadsUsed: number;
  observationBytesUsed: number;
  /** Cached sorted list of repo-relative source paths, populated lazily. */
  cachedIndex: string[] | null;
}

export function createExecutorState(repoRoot: string, limits: AgentLimits): ExecutorState {
  return {
    repoRoot: resolve(repoRoot),
    limits,
    fileReadsUsed: 0,
    observationBytesUsed: 0,
    cachedIndex: null,
  };
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

interface ResolvedPath {
  absolute: string;
  relative: string;
}

function resolveInsideRepo(repoRoot: string, requested: string): ResolvedPath | null {
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(repoRoot, requested);
  const rel = relative(repoRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return { absolute, relative: rel === '' ? '.' : rel };
}

// ---------------------------------------------------------------------------
// Repo indexing
// ---------------------------------------------------------------------------

async function indexRepo(repoRoot: string): Promise<string[]> {
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
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(relative(repoRoot, fullPath));
        }
      }
    }
  }

  await walk(repoRoot, 0);
  results.sort();
  return results;
}

async function ensureIndex(state: ExecutorState): Promise<string[]> {
  if (!state.cachedIndex) {
    state.cachedIndex = await indexRepo(state.repoRoot);
  }
  return state.cachedIndex;
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

function estimateObservationBytes(lines: string[]): number {
  let total = 0;
  for (const line of lines) total += line.length + 1;
  return total;
}

function chargeBudget(state: ExecutorState, bytes: number): number {
  const remaining = Math.max(
    0,
    state.limits.maxObservationBudgetBytes - state.observationBytesUsed,
  );
  const charge = Math.min(bytes, remaining);
  state.observationBytesUsed += charge;
  return charge;
}

function observationBudgetRemaining(state: ExecutorState): number {
  return Math.max(0, state.limits.maxObservationBudgetBytes - state.observationBytesUsed);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

async function executeReadFile(
  action: ReadFileAction,
  state: ExecutorState,
): Promise<ReadFileObservation> {
  if (state.fileReadsUsed >= state.limits.maxFileReads) {
    return {
      action: 'read_file',
      path: action.path,
      start: Math.max(1, Math.floor(action.start ?? 1)),
      count: 0,
      lines: [],
      truncated: true,
      reason: action.reason,
      error: 'file read budget exhausted',
    };
  }

  const resolved = resolveInsideRepo(state.repoRoot, action.path);
  if (!resolved) {
    return {
      action: 'read_file',
      path: action.path,
      start: 1,
      count: 0,
      lines: [],
      truncated: false,
      reason: action.reason,
      error: 'path is outside the repository root',
    };
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.absolute);
  } catch {
    return {
      action: 'read_file',
      path: resolved.relative,
      start: 1,
      count: 0,
      lines: [],
      truncated: false,
      reason: action.reason,
      error: 'file not found',
    };
  }
  if (!fileStat.isFile()) {
    return {
      action: 'read_file',
      path: resolved.relative,
      start: 1,
      count: 0,
      lines: [],
      truncated: false,
      reason: action.reason,
      error: 'path is not a regular file',
    };
  }
  if (fileStat.size > MAX_FILE_SIZE) {
    return {
      action: 'read_file',
      path: resolved.relative,
      start: 1,
      count: 0,
      lines: [],
      truncated: true,
      reason: action.reason,
      error: `file is larger than executor limit (${MAX_FILE_SIZE} bytes)`,
    };
  }

  state.fileReadsUsed++;

  let content: string;
  try {
    content = await readFile(resolved.absolute, 'utf-8');
  } catch (error) {
    return {
      action: 'read_file',
      path: resolved.relative,
      start: 1,
      count: 0,
      lines: [],
      truncated: false,
      reason: action.reason,
      error: error instanceof Error ? error.message : 'read failed',
    };
  }

  const allLines = content.split('\n');
  const totalLines = allLines.length;

  const windowMode = action.mode === 'full' ? 'full' : 'window';
  const requestedStart = windowMode === 'full' ? 1 : Math.max(1, Math.floor(action.start ?? 1));
  const requestedCount =
    windowMode === 'full'
      ? totalLines
      : Math.max(1, Math.floor(action.count ?? state.limits.maxLinesPerRead));

  const startIdx = Math.min(Math.max(0, requestedStart - 1), Math.max(0, totalLines - 1));
  const maxLines = Math.min(state.limits.maxLinesPerRead, requestedCount);
  let sliceEnd = Math.min(totalLines, startIdx + maxLines);
  let window = allLines.slice(startIdx, sliceEnd);
  let truncated = window.length < requestedCount || sliceEnd < startIdx + requestedCount;

  // Byte cap within a single read.
  const maxBytes = Math.min(state.limits.maxBytesPerRead, observationBudgetRemaining(state));
  let runningBytes = 0;
  const clipped: string[] = [];
  for (const line of window) {
    const trimmed = line.replace(/\s+$/g, '');
    const len = trimmed.length + 1;
    if (runningBytes + len > maxBytes) {
      truncated = true;
      break;
    }
    clipped.push(trimmed);
    runningBytes += len;
  }
  if (clipped.length < window.length) {
    sliceEnd = startIdx + clipped.length;
    window = clipped;
  } else {
    window = clipped;
  }

  chargeBudget(state, runningBytes);

  return {
    action: 'read_file',
    path: resolved.relative,
    start: startIdx + 1,
    count: window.length,
    totalLines,
    lines: window,
    truncated,
    reason: action.reason,
  };
}

// ---------------------------------------------------------------------------
// search_content
// ---------------------------------------------------------------------------

function matchesHint(path: string, hint: string | undefined): boolean {
  if (!hint) return true;
  const lower = path.toLowerCase();
  const needle = hint.toLowerCase().replace(/^\.?\/+/, '');
  if (!needle) return true;
  return lower.includes(needle);
}

async function executeSearchContent(
  action: SearchContentAction,
  state: ExecutorState,
): Promise<SearchContentObservation> {
  const term = action.term.trim();
  if (!term) {
    return {
      action: 'search_content',
      term: action.term,
      hits: [],
      truncated: false,
      reason: action.reason,
      error: 'empty search term',
    };
  }

  const lowerTerm = term.toLowerCase();
  const index = await ensureIndex(state);
  const hits: SearchContentHit[] = [];
  let truncated = false;
  let bytesUsed = 0;
  const maxBytes = observationBudgetRemaining(state);
  let filesScanned = 0;

  for (const relPath of index) {
    if (!matchesHint(relPath, action.path_hint)) continue;
    if (hits.length >= state.limits.maxContentSearchHits) {
      truncated = true;
      break;
    }
    if (bytesUsed >= maxBytes) {
      truncated = true;
      break;
    }
    // Guard against accidentally scanning a huge portion of the tree.
    filesScanned++;
    if (filesScanned > 400) {
      truncated = true;
      break;
    }
    const absolute = resolve(state.repoRoot, relPath);
    let fileStat;
    try {
      fileStat = await stat(absolute);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    if (fileStat.size > MAX_DISCOVER_BYTES_PER_FILE) continue;

    let content: string;
    try {
      content = await readFile(absolute, 'utf-8');
    } catch {
      continue;
    }

    const lower = content.toLowerCase();
    let fromIndex = 0;
    let hitInFile = 0;
    while (fromIndex < lower.length && hits.length < state.limits.maxContentSearchHits) {
      const idx = lower.indexOf(lowerTerm, fromIndex);
      if (idx === -1) break;
      const lineNumber = content.slice(0, idx).split('\n').length;
      const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
      const lineEnd = content.indexOf('\n', idx);
      const snippet = content
        .slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
        .trim()
        .slice(0, 200);
      hits.push({ path: relPath, line: lineNumber, text: snippet });
      bytesUsed += snippet.length + relPath.length + 8;
      fromIndex = idx + lowerTerm.length;
      hitInFile++;
      if (hitInFile >= 4) break;
    }
  }

  chargeBudget(state, bytesUsed);
  if (bytesUsed >= maxBytes) truncated = true;

  return {
    action: 'search_content',
    term: action.term,
    hits,
    truncated,
    reason: action.reason,
  };
}

// ---------------------------------------------------------------------------
// search_paths
// ---------------------------------------------------------------------------

async function executeSearchPaths(
  action: SearchPathsAction,
  state: ExecutorState,
): Promise<SearchPathsObservation> {
  const term = action.term.trim().toLowerCase();
  if (!term) {
    return {
      action: 'search_paths',
      term: action.term,
      matches: [],
      truncated: false,
      reason: action.reason,
      error: 'empty search term',
    };
  }

  const dirHint = action.dir_hint ? action.dir_hint.toLowerCase().replace(/^\.?\/+/, '') : '';
  const index = await ensureIndex(state);
  const matches: string[] = [];
  let truncated = false;
  for (const relPath of index) {
    const lower = relPath.toLowerCase();
    if (dirHint && !lower.includes(dirHint)) continue;
    if (!lower.includes(term)) continue;
    matches.push(relPath);
    if (matches.length >= state.limits.maxPathSearchMatches) {
      truncated = true;
      break;
    }
  }

  chargeBudget(
    state,
    matches.reduce((acc, p) => acc + p.length + 1, 0),
  );

  return {
    action: 'search_paths',
    term: action.term,
    matches,
    truncated,
    reason: action.reason,
  };
}

// ---------------------------------------------------------------------------
// follow_imports
// ---------------------------------------------------------------------------

function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const fromPattern = /from\s+['"]([^'"]+)['"]/g;
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const importPattern = /import\s+['"]([^'"]+)['"]/g;
  for (const pattern of [fromPattern, requirePattern, importPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1];
      if (spec) specifiers.add(spec);
    }
  }
  return [...specifiers];
}

function resolveImportTarget(
  repoRoot: string,
  fromRelPath: string,
  specifier: string,
  index: string[],
): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return undefined;
  }
  const baseDir = resolve(repoRoot, fromRelPath, '..');
  const absoluteGuess = resolve(baseDir, specifier);
  const relGuess = relative(repoRoot, absoluteGuess);
  if (relGuess.startsWith('..') || isAbsolute(relGuess)) return undefined;

  // Direct match
  if (index.includes(relGuess)) return relGuess;

  // Candidate with common extensions
  const candidates = [
    `${relGuess}.ts`,
    `${relGuess}.tsx`,
    `${relGuess}.js`,
    `${relGuess}.jsx`,
    `${relGuess}.mjs`,
    `${relGuess}.cjs`,
    `${relGuess}/index.ts`,
    `${relGuess}/index.tsx`,
    `${relGuess}/index.js`,
  ];
  for (const candidate of candidates) {
    if (index.includes(candidate)) return candidate;
  }
  return undefined;
}

async function executeFollowImports(
  action: { type: 'follow_imports'; path: string; reason: string },
  state: ExecutorState,
): Promise<FollowImportsObservation> {
  const resolved = resolveInsideRepo(state.repoRoot, action.path);
  if (!resolved) {
    return {
      action: 'follow_imports',
      path: action.path,
      imports: [],
      reason: action.reason,
      error: 'path is outside the repository root',
    };
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.absolute);
  } catch {
    return {
      action: 'follow_imports',
      path: resolved.relative,
      imports: [],
      reason: action.reason,
      error: 'file not found',
    };
  }
  if (!fileStat.isFile() || fileStat.size > MAX_FILE_SIZE) {
    return {
      action: 'follow_imports',
      path: resolved.relative,
      imports: [],
      reason: action.reason,
      error: 'path is not a readable source file',
    };
  }

  let content: string;
  try {
    content = await readFile(resolved.absolute, 'utf-8');
  } catch (error) {
    return {
      action: 'follow_imports',
      path: resolved.relative,
      imports: [],
      reason: action.reason,
      error: error instanceof Error ? error.message : 'read failed',
    };
  }

  const index = await ensureIndex(state);
  const specifiers = extractImportSpecifiers(content).slice(0, 32);

  const imports = specifiers.map((source) => {
    const resolvedTarget = resolveImportTarget(state.repoRoot, resolved.relative, source, index);
    return resolvedTarget ? { source, resolved: resolvedTarget } : { source };
  });

  chargeBudget(
    state,
    imports.reduce((acc, imp) => acc + imp.source.length + (imp.resolved?.length ?? 0) + 8, 0),
  );

  return {
    action: 'follow_imports',
    path: resolved.relative,
    imports,
    reason: action.reason,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Execute a single retrieval action and return a bounded observation.
 *
 * The executor mutates `state` in place to track reads and byte budget
 * consumption across a run.
 */
export async function executeAction(
  action: RetrievalAction,
  state: ExecutorState,
): Promise<RetrievalObservation> {
  switch (action.type) {
    case 'read_file':
      return executeReadFile(action, state);
    case 'search_content':
      return executeSearchContent(action, state);
    case 'search_paths':
      return executeSearchPaths(action, state);
    case 'follow_imports':
      return executeFollowImports(action, state);
  }
}

/**
 * Execute a sequence of actions in order, returning observations in the
 * same order. Stops early only on budget exhaustion, which the caller can
 * detect from observation.truncated / observation.error.
 */
export async function executeActions(
  actions: RetrievalAction[],
  state: ExecutorState,
): Promise<RetrievalObservation[]> {
  const observations: RetrievalObservation[] = [];
  for (const action of actions) {
    observations.push(await executeAction(action, state));
    if (observationBudgetRemaining(state) === 0) break;
  }
  // Lightweight tracking of estimated bytes so prompt budgets stay honest
  // even when observation lines have already been trimmed internally.
  for (const obs of observations) {
    if (obs.action === 'read_file') {
      const extra = estimateObservationBytes(obs.lines);
      void extra;
    }
  }
  return observations;
}
