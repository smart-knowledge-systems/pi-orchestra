/**
 * Shared retriever-agent helpers.
 *
 * Pure helpers reused by both the legacy `runRetrieverAgent` (the
 * compatibility-shim path in `agent.ts`) and the new `runRetrieverAgentLoop`
 * built on top of `@mariozechner/pi-agent-core` (Phase 4, COMP-P4-T1).
 *
 * Keeping these in a shared module preserves byte-identical behavior for
 * the existing 14 tests while letting the new loop reuse the same
 * sanitization, fallback-recommendation, and recommendation-payload
 * parsing logic.
 *
 * @module retriever/agent-shared
 */

import { isAbsolute, relative, resolve } from 'node:path';

import type {
  AgentFileSelection,
  AgentFinalRecommendation,
  AgentSymbolSelection,
} from './agent-types.ts';
import type { ScoutCandidate, ScoutResult } from './scout.ts';
import type { RetrievalDefaultEvidenceMode, RetrievalSelectionTier } from '../artifacts/types.ts';

const SELECTION_TIERS: readonly RetrievalSelectionTier[] = ['selected', 'reserve'];
const DEFAULT_EVIDENCE_MODES: readonly RetrievalDefaultEvidenceMode[] = [
  'exclude',
  'summary',
  'summary+ast',
  'spans',
  'whole_file',
];
const CONFIDENCE_VALUES: readonly AgentFinalRecommendation['confidence'][] = [
  'low',
  'medium',
  'high',
];

// ---------------------------------------------------------------------------
// Light-weight value coercions
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
    .filter((item) => item.length > 0);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Final-recommendation payload parsing
// ---------------------------------------------------------------------------

function parseSymbolSelection(raw: unknown): AgentSymbolSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return null;
  const start = Math.max(1, asInt(obj.start, 1));
  const count = Math.max(1, asInt(obj.count, 1));
  return {
    name,
    start,
    count,
    selected_by_default: asBool(obj.selected_by_default, false),
    default_neighbor_lines: Math.max(0, asInt(obj.default_neighbor_lines, 0)),
    selection_reason: typeof obj.selection_reason === 'string' ? obj.selection_reason.trim() : '',
  };
}

function parseFileSelection(raw: unknown): AgentFileSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const path = typeof obj.path === 'string' ? obj.path.trim() : '';
  if (!path) return null;
  const tier = pickEnum(obj.tier, SELECTION_TIERS, 'selected');
  const default_evidence_mode = pickEnum(
    obj.default_evidence_mode,
    DEFAULT_EVIDENCE_MODES,
    'summary',
  );
  const symbols = Array.isArray(obj.symbols)
    ? obj.symbols.map(parseSymbolSelection).filter((s): s is AgentSymbolSelection => s !== null)
    : [];
  return {
    path,
    tier,
    default_evidence_mode,
    selection_reason: typeof obj.selection_reason === 'string' ? obj.selection_reason.trim() : '',
    include_ast_skeleton: asBool(obj.include_ast_skeleton, default_evidence_mode !== 'exclude'),
    include_retriever_summary: asBool(
      obj.include_retriever_summary,
      default_evidence_mode !== 'exclude',
    ),
    include_entire_file: asBool(obj.include_entire_file, default_evidence_mode === 'whole_file'),
    symbols,
  };
}

/**
 * Parse a final-recommendation payload (supplied as the argument to the
 * `submit_recommendation` tool, or extracted from a JSON-parsed model
 * response). Returns null if the payload is missing both a strategy
 * summary and any files — i.e. is unusable.
 */
export function parseFinalRecommendationPayload(raw: unknown): AgentFinalRecommendation | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const strategy_summary =
    typeof obj.strategy_summary === 'string' ? obj.strategy_summary.trim() : '';
  const filesRaw = Array.isArray(obj.files) ? obj.files : [];
  const files = filesRaw
    .map(parseFileSelection)
    .filter((file): file is AgentFileSelection => file !== null);
  if (!strategy_summary && files.length === 0) return null;
  return {
    strategy_summary,
    files,
    cross_file_findings: asStringArray(obj.cross_file_findings),
    gaps: asStringArray(obj.gaps),
    followup_queries: asStringArray(obj.followup_queries),
    include_cross_file_findings: asBool(obj.include_cross_file_findings, false),
    include_gaps: asBool(obj.include_gaps, false),
    include_followup_queries: asBool(obj.include_followup_queries, false),
    confidence: pickEnum(obj.confidence, CONFIDENCE_VALUES, 'medium'),
  };
}

// ---------------------------------------------------------------------------
// Fallback recommendation synthesis (scout-derived)
// ---------------------------------------------------------------------------

function candidateToFileSelection(
  candidate: ScoutCandidate,
  tier: RetrievalSelectionTier,
): AgentFileSelection {
  const mode = candidate.evidenceModeHint;
  const symbols = candidate.topSymbols.slice(0, 3).map<AgentSymbolSelection>((sym) => ({
    name: sym.name,
    start: sym.start,
    count: sym.count,
    selected_by_default: tier === 'selected' && mode === 'spans',
    default_neighbor_lines: tier === 'selected' && mode === 'spans' ? 3 : 0,
    selection_reason: sym.reason,
  }));
  return {
    path: candidate.relPath,
    tier,
    default_evidence_mode: mode,
    selection_reason: `${candidate.role} · ${candidate.rationale}`,
    include_ast_skeleton: mode !== 'exclude',
    include_retriever_summary: mode !== 'exclude',
    include_entire_file: mode === 'whole_file',
    symbols,
  };
}

export function fallbackRecommendation(scout: ScoutResult, note: string): AgentFinalRecommendation {
  const files: AgentFileSelection[] = [
    ...scout.selected.map((c) => candidateToFileSelection(c, 'selected')),
    ...scout.reserve.map((c) => candidateToFileSelection(c, 'reserve')),
  ];
  return {
    strategy_summary: `${scout.strategySummary} — fallback: ${note}`,
    files,
    cross_file_findings: scout.crossFileHints,
    gaps: scout.gaps,
    followup_queries: scout.terms
      .filter((t) => t.kinds.includes('focus') || t.weight >= 4)
      .slice(0, 4)
      .map((t) => `investigate ${t.term}-related callsites or configuration`),
    include_cross_file_findings: scout.crossFileHints.length > 0,
    include_gaps: scout.gaps.length > 0,
    include_followup_queries: false,
    confidence: files.length >= 3 ? 'medium' : 'low',
  };
}

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

function normalizePath(repoRoot: string, path: string): string | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel === '' ? '.' : rel;
}

export function sanitizeRecommendation(
  recommendation: AgentFinalRecommendation,
  repoRoot: string,
): { recommendation: AgentFinalRecommendation; warnings: string[] } {
  const warnings: string[] = [];
  const files: AgentFileSelection[] = [];
  const seen = new Set<string>();
  for (const file of recommendation.files) {
    const normalized = normalizePath(repoRoot, file.path);
    if (!normalized) {
      warnings.push(`dropping out-of-repo path: ${file.path}`);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    files.push({ ...file, path: normalized });
  }
  return {
    recommendation: { ...recommendation, files },
    warnings,
  };
}
