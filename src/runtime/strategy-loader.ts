/**
 * Strategy loader — `.piorx/strategies/*.md` discovery (COMP-P5-T2).
 *
 * Per `docs/composability.md` "Phase 5 — Skills-as-strategies + filesystem
 * discovery", piorx exposes its primitives to extension authors through
 * markdown-frontmatter strategy files dropped into one of two scopes:
 *
 *   1. **User scope** — `~/.config/piorx/strategies/*.md`
 *   2. **Project scope** — `<repoRoot>/.piorx/strategies/*.md`
 *
 * The two scopes mirror pi's two-scope discovery for `AGENTS.md` and
 * extensions. Project scope wins over user scope by name on conflict
 * (first-name-wins, matching pi's idiom for tool / command resolution).
 *
 * A strategy file is schema-validated at parse time; invalid strategies are
 * rejected with a diagnostic rather than silently dropped, so an author who
 * mis-types a frontmatter field sees the parser's complaint instead of
 * watching their strategy disappear.
 *
 * The format is intentionally skill-shaped (Claude Code's SKILL.md is the
 * design vocabulary) but pi-flavored: YAML frontmatter for the typed shape,
 * markdown body for the natural-language instructions an agent reads at
 * invocation time. The bounded YAML subset is the same one
 * `workflow-loader.ts` parses — `parseWorkflowFrontmatter` is reused so
 * strategy files and workflow specs share the same parsing rules.
 *
 * Phase 5 acceptance covers discovery and registration; binding a registered
 * strategy as a tool callable from an active stage is a downstream wiring
 * concern (advisor extensions / synthesis worker integration).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parseWorkflowFrontmatter } from './workflow-loader.ts';
import { projectStrategiesDir, userStrategiesDir } from './paths.ts';
import type { PiOrchestraConfig } from './config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const STRATEGY_KIND = 'piorx/advisor-strategy@1' as const;

export type StrategyScope = 'user' | 'project';

/**
 * `AdvisorStrategy` — a registered strategy resolved from disk.
 *
 * The shape is intentionally narrow at Phase 5: a strategy carries the
 * structural identity needed by the registry (`name`, `kind`), enough
 * descriptive metadata for selection (`description`, optional
 * `applicable_stages`, `applicable_phases`), and the natural-language
 * `body` an agent renders at invocation time. Invocation semantics
 * (turning a strategy into a model call or a tool result) are layered on
 * top by extensions and by the synthesis-stage advisor wiring.
 */
export interface AdvisorStrategy {
  /** Stable identifier — registered under this name in the registry. */
  readonly name: string;
  /** Discriminator constant `STRATEGY_KIND`. */
  readonly kind: typeof STRATEGY_KIND;
  /** One-line description used at selection time. */
  readonly description: string;
  /** Optional stage ids the strategy is applicable to. */
  readonly applicable_stages?: readonly string[];
  /** Optional phase ids the strategy is applicable to. */
  readonly applicable_phases?: readonly string[];
  /** Optional `model_class` hint (mirrors workflow-spec stage `model_class`). */
  readonly model_class?: string;
  /** Markdown body of the strategy — read by agents at invocation time. */
  readonly body: string;
  /** Absolute path the strategy was loaded from. */
  readonly source_path: string;
  /** Discovery scope. */
  readonly scope: StrategyScope;
}

/**
 * Diagnostic surfaced when a strategy file fails to parse or validate.
 *
 * The registry caller propagates these to the host so an author sees one
 * actionable message per malformed file rather than a single boot-time
 * abort that hides further failures.
 */
export interface StrategyDiagnostic {
  readonly source_path: string;
  readonly scope: StrategyScope;
  readonly message: string;
}

export interface DiscoveredStrategies {
  readonly strategies: readonly AdvisorStrategy[];
  readonly diagnostics: readonly StrategyDiagnostic[];
}

// ---------------------------------------------------------------------------
// Frontmatter splitting (mirror workflow-loader.ts; not exported there)
// ---------------------------------------------------------------------------

interface SplitMarkdown {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(text: string, sourcePath: string): SplitMarkdown {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`strategy file ${sourcePath}: missing leading "---" frontmatter fence`);
  }
  const closeIdx = normalized.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    throw new Error(`strategy file ${sourcePath}: missing closing "---" frontmatter fence`);
  }
  return {
    frontmatter: normalized.slice(4, closeIdx),
    body: normalized.slice(closeIdx + 5),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_KEYS = new Set([
  'kind',
  'name',
  'description',
  'applicable_stages',
  'applicable_phases',
  'model_class',
]);

function validateStrategyShape(
  parsed: Record<string, unknown>,
):
  | { ok: true; value: Omit<AdvisorStrategy, 'body' | 'source_path' | 'scope'> }
  | { ok: false; error: string } {
  for (const key of Object.keys(parsed)) {
    if (!VALID_KEYS.has(key)) {
      return { ok: false, error: `unknown frontmatter key "${key}"` };
    }
  }

  const kind = parsed.kind;
  if (kind !== STRATEGY_KIND) {
    return {
      ok: false,
      error: `expected kind "${STRATEGY_KIND}", got ${
        typeof kind === 'string' ? `"${kind}"` : String(kind)
      }`,
    };
  }

  const name = parsed.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'name is required and must be a non-empty string' };
  }

  const description = parsed.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return { ok: false, error: 'description is required and must be a non-empty string' };
  }

  const applicableStages = parsed.applicable_stages;
  if (applicableStages !== undefined && !isStringArray(applicableStages)) {
    return {
      ok: false,
      error: 'applicable_stages must be a list of stage ids when present',
    };
  }
  const applicablePhases = parsed.applicable_phases;
  if (applicablePhases !== undefined && !isStringArray(applicablePhases)) {
    return {
      ok: false,
      error: 'applicable_phases must be a list of phase ids when present',
    };
  }
  const modelClass = parsed.model_class;
  if (modelClass !== undefined && (typeof modelClass !== 'string' || modelClass.trim() === '')) {
    return {
      ok: false,
      error: 'model_class must be a non-empty string when present',
    };
  }

  const value: Omit<AdvisorStrategy, 'body' | 'source_path' | 'scope'> = {
    name: name.trim(),
    kind: STRATEGY_KIND,
    description: description.trim(),
  };
  if (applicableStages !== undefined) {
    (value as Record<string, unknown>).applicable_stages = Object.freeze([...applicableStages]);
  }
  if (applicablePhases !== undefined) {
    (value as Record<string, unknown>).applicable_phases = Object.freeze([...applicablePhases]);
  }
  if (modelClass !== undefined) {
    (value as Record<string, unknown>).model_class = modelClass;
  }
  return { ok: true, value };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

// ---------------------------------------------------------------------------
// Public parse / load / discover
// ---------------------------------------------------------------------------

/**
 * Parse a strategy markdown file's contents into a runtime `AdvisorStrategy`.
 *
 * Throws on malformed input — callers wrap thrown errors in
 * `StrategyDiagnostic` rather than aborting boot when discovering a tree of
 * strategy files.
 */
export function parseStrategyMarkdown(
  text: string,
  sourcePath: string,
  scope: StrategyScope,
): AdvisorStrategy {
  const { frontmatter, body } = splitFrontmatter(text, sourcePath);
  const parsed = parseWorkflowFrontmatter(frontmatter);
  const result = validateStrategyShape(parsed);
  if (!result.ok) {
    throw new Error(`strategy file ${sourcePath}: ${result.error}`);
  }
  return Object.freeze({
    ...result.value,
    body,
    source_path: sourcePath,
    scope,
  });
}

/**
 * Read a single strategy file from disk. Caller is responsible for catching
 * thrown errors and surfacing them as `StrategyDiagnostic`s.
 */
export function loadStrategyFromFile(filePath: string, scope: StrategyScope): AdvisorStrategy {
  const text = readFileSync(filePath, 'utf-8');
  return parseStrategyMarkdown(text, filePath, scope);
}

export interface DiscoverStrategiesOptions {
  /** Override the user-scope directory (test seam). */
  userDir?: string;
  /** Override the project-scope directory (test seam). */
  projectDir?: string;
}

/**
 * Discover strategies from the user and project scopes.
 *
 * Project scope wins on name conflict — the first-name-wins idiom matches
 * pi's tool / command resolution semantics. Order of iteration:
 *
 *   1. Project scope (`<repoRoot>/.piorx/strategies/*.md`).
 *   2. User scope (`~/.config/piorx/strategies/*.md`).
 *
 * On a conflict the user-scope strategy is dropped and a diagnostic is
 * recorded so the author sees the shadowed file rather than wondering why
 * their strategy did not load.
 *
 * Files that fail to parse become `StrategyDiagnostic`s; the loader returns
 * the partial set so the host can report multiple problems in one pass.
 */
export function discoverStrategies(
  config: PiOrchestraConfig,
  options: DiscoverStrategiesOptions = {},
): DiscoveredStrategies {
  const projectDir = options.projectDir ?? projectStrategiesDir(config);
  const userDir = options.userDir ?? userStrategiesDir();

  const strategies: AdvisorStrategy[] = [];
  const diagnostics: StrategyDiagnostic[] = [];
  const claimed = new Map<string, AdvisorStrategy>();

  for (const scope of ['project', 'user'] as const) {
    const dir = scope === 'project' ? projectDir : userDir;
    for (const filePath of safeListMarkdownFiles(dir)) {
      let strategy: AdvisorStrategy;
      try {
        strategy = loadStrategyFromFile(filePath, scope);
      } catch (err) {
        diagnostics.push({
          source_path: filePath,
          scope,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const winner = claimed.get(strategy.name);
      if (winner) {
        diagnostics.push({
          source_path: filePath,
          scope,
          message:
            `strategy "${strategy.name}" shadowed by ${winner.scope}-scope file ` +
            `${winner.source_path}; project scope wins on conflict`,
        });
        continue;
      }
      claimed.set(strategy.name, strategy);
      strategies.push(strategy);
    }
  }

  return {
    strategies: Object.freeze([...strategies]),
    diagnostics: Object.freeze([...diagnostics]),
  };
}

/** Re-export of the canonical user-scope strategy directory helper. */
export { userStrategiesDir as defaultUserStrategiesDir } from './paths.ts';
/** Re-export of the canonical project-scope strategy directory helper. */
export { projectStrategiesDir as defaultProjectStrategiesDir } from './paths.ts';

// ---------------------------------------------------------------------------
// Internals — directory walk
// ---------------------------------------------------------------------------

function safeListMarkdownFiles(dir: string): string[] {
  let entries: string[];
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
    entries = readdirSync(dir);
  } catch (err) {
    // ENOENT and ENOTDIR are non-fatal — the host may not have either scope
    // populated. Other errors (permission denied, filesystem corruption)
    // are also tolerated by the boot path; the registry's diagnostic stream
    // is the right place to surface them, but we keep boot resilient.
    void err;
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (basename(entry).startsWith('.')) continue;
    const filePath = resolve(dir, entry);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    files.push(filePath);
  }
  files.sort();
  return files;
}
