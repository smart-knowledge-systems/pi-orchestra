/**
 * Normalize raw retriever worker output into a valid retrieval-index-v1 artifact.
 *
 * Responsibilities:
 *   - Ensure all file paths are absolute
 *   - Ensure all line numbers are 1-indexed (minimum value 1)
 *   - Strip any raw full-file content from conductor-visible fields
 *   - Generate stable file_id / symbol_id when missing
 *   - Validate the resulting artifact shape
 */

import { resolve, isAbsolute } from 'node:path';
import type {
  RecommendedEvidenceFile,
  RecommendedEvidenceSpan,
  RetrievalDefaultEvidenceMode,
  RetrievalFile,
  RetrievalIndexV1,
  RetrievalRecommendedEvidence,
  RetrievalSelectionTier,
  RetrievalSymbol,
} from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import { validateArtifact } from '../artifacts/schemas.ts';

const SELECTION_TIERS: readonly RetrievalSelectionTier[] = ['selected', 'reserve'];
const DEFAULT_EVIDENCE_MODES: readonly RetrievalDefaultEvidenceMode[] = [
  'exclude',
  'summary',
  'summary+ast',
  'spans',
  'whole_file',
];

function coerceTier(value: unknown): RetrievalSelectionTier {
  return SELECTION_TIERS.includes(value as RetrievalSelectionTier)
    ? (value as RetrievalSelectionTier)
    : 'selected';
}

function coerceEvidenceMode(value: unknown): RetrievalDefaultEvidenceMode {
  return DEFAULT_EVIDENCE_MODES.includes(value as RetrievalDefaultEvidenceMode)
    ? (value as RetrievalDefaultEvidenceMode)
    : 'summary';
}

// ---------------------------------------------------------------------------
// Raw worker output types — what the retriever worker produces before
// normalization. These are intentionally loose.
// ---------------------------------------------------------------------------

export interface RawRetrievalSymbol {
  symbol_id?: string;
  kind: string;
  name: string;
  start: number;
  count: number;
  summary?: string;
  role_in_system?: string;
  depends_on?: string[];
  used_by?: string[];
  relevance?: string;
  change_likelihood?: string;
  expansion_priority?: string;
  recommended_expansion?: string;
  expansion_reason?: string;
  /** Whether this span should appear in the default evidence bundle. */
  selected_by_default?: boolean;
  /** Default neighbor-line padding for this span. */
  default_neighbor_lines?: number;
  /** Short reason for the per-symbol default-evidence decision. */
  selection_reason?: string;
}

export interface RawRetrievalFile {
  file_id?: string;
  path: string;
  why_relevant: string;
  file_summary: string;
  ast_skeleton?: string[];
  recommended_expansion?: string;
  expansion_reason?: string;
  selection_tier?: RetrievalSelectionTier;
  selection_reason?: string;
  default_evidence_mode?: RetrievalDefaultEvidenceMode;
  /** Default include flag for the structural AST skeleton. */
  include_ast_skeleton?: boolean;
  /** Default include flag for the retriever-authored summary. */
  include_retriever_summary?: boolean;
  /** Default include flag for the whole-file body (use sparingly). */
  include_entire_file?: boolean;
  symbols?: RawRetrievalSymbol[];
  /** raw_content is explicitly NOT propagated to the normalized artifact. */
  raw_content?: string;
}

export interface RawRetrievalOutput {
  query: string;
  confidence?: string;
  files: RawRetrievalFile[];
  cross_file_findings?: string[];
  gaps?: string[];
  followup_queries?: string[];
  strategy_summary?: string;
  scout_terms?: string[];
  /** Whether the default evidence bundle should carry cross-file findings. */
  include_cross_file_findings?: boolean;
  /** Whether the default evidence bundle should carry gaps. */
  include_gaps?: boolean;
  /** Whether the default evidence bundle should carry follow-up queries. */
  include_followup_queries?: boolean;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Ensure a line number is at least 1 (1-indexed).
 */
function clampLine(n: number): number {
  return Math.max(1, Math.floor(n));
}

/**
 * Ensure a path is absolute. If relative, resolve against repoRoot.
 */
function absolutePath(p: string, repoRoot: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

let fileCounter = 0;
let symbolCounter = 0;

function nextFileId(): string {
  return `f${++fileCounter}`;
}

function nextSymbolId(): string {
  return `s${++symbolCounter}`;
}

/** Reset internal counters (for testing). */
export function resetNormalizeCounters(): void {
  fileCounter = 0;
  symbolCounter = 0;
}

function normalizeSymbol(raw: RawRetrievalSymbol): RetrievalSymbol {
  return {
    symbol_id: raw.symbol_id ?? nextSymbolId(),
    kind: raw.kind,
    name: raw.name,
    start: clampLine(raw.start),
    count: Math.max(1, Math.floor(raw.count)),
    summary: raw.summary ?? '',
    role_in_system: raw.role_in_system ?? '',
    depends_on: raw.depends_on ?? [],
    used_by: raw.used_by ?? [],
    relevance: raw.relevance ?? 'medium',
    change_likelihood: raw.change_likelihood ?? 'unknown',
    expansion_priority: raw.expansion_priority ?? 'medium',
    recommended_expansion: raw.recommended_expansion ?? 'none',
    expansion_reason: raw.expansion_reason ?? '',
    selected_by_default: raw.selected_by_default === true,
    default_neighbor_lines: Math.max(0, Math.floor(raw.default_neighbor_lines ?? 0)),
    selection_reason: raw.selection_reason ?? '',
  };
}

/**
 * Derive the per-file default include flags from the declared evidence
 * mode when the raw input does not provide explicit overrides. The mode
 * is the authoritative signal; flags only fine-tune it.
 */
function defaultIncludeFlags(mode: RetrievalDefaultEvidenceMode): {
  include_ast_skeleton: boolean;
  include_retriever_summary: boolean;
  include_entire_file: boolean;
} {
  switch (mode) {
    case 'whole_file':
      return {
        include_ast_skeleton: true,
        include_retriever_summary: true,
        include_entire_file: true,
      };
    case 'spans':
    case 'summary+ast':
      return {
        include_ast_skeleton: true,
        include_retriever_summary: true,
        include_entire_file: false,
      };
    case 'summary':
      return {
        include_ast_skeleton: false,
        include_retriever_summary: true,
        include_entire_file: false,
      };
    case 'exclude':
    default:
      return {
        include_ast_skeleton: false,
        include_retriever_summary: false,
        include_entire_file: false,
      };
  }
}

interface NormalizedFile {
  file: RetrievalFile;
  includeFlags: {
    include_ast_skeleton: boolean;
    include_retriever_summary: boolean;
    include_entire_file: boolean;
  };
}

function normalizeFile(raw: RawRetrievalFile, repoRoot: string): NormalizedFile {
  // Deliberately omit raw.raw_content — it must never appear in the
  // conductor-visible artifact.
  const mode = coerceEvidenceMode(raw.default_evidence_mode);
  const flagDefaults = defaultIncludeFlags(mode);
  const file: RetrievalFile = {
    file_id: raw.file_id ?? nextFileId(),
    path: absolutePath(raw.path, repoRoot),
    why_relevant: raw.why_relevant,
    file_summary: raw.file_summary,
    ast_skeleton: raw.ast_skeleton ?? [],
    recommended_expansion: raw.recommended_expansion ?? 'none',
    expansion_reason: raw.expansion_reason ?? '',
    selection_tier: coerceTier(raw.selection_tier),
    selection_reason: raw.selection_reason ?? '',
    default_evidence_mode: mode,
    symbols: (raw.symbols ?? []).map(normalizeSymbol),
  };

  return {
    file,
    includeFlags: {
      include_ast_skeleton:
        typeof raw.include_ast_skeleton === 'boolean'
          ? raw.include_ast_skeleton
          : flagDefaults.include_ast_skeleton,
      include_retriever_summary:
        typeof raw.include_retriever_summary === 'boolean'
          ? raw.include_retriever_summary
          : flagDefaults.include_retriever_summary,
      include_entire_file:
        typeof raw.include_entire_file === 'boolean'
          ? raw.include_entire_file
          : flagDefaults.include_entire_file,
    },
  };
}

/**
 * Build the `recommended_evidence` payload from normalized selected-tier
 * files. The retriever authors the default evidence scope; this step just
 * makes it explicit on the stored artifact. Reserve-tier files and
 * `exclude`-mode files are deliberately absent — they require an explicit
 * conductor override to enter the plan.
 */
function buildRecommendedEvidence(
  files: NormalizedFile[],
  raw: RawRetrievalOutput,
  crossFileFindings: string[],
  gaps: string[],
): RetrievalRecommendedEvidence {
  const recFiles: RecommendedEvidenceFile[] = [];
  for (const entry of files) {
    const { file, includeFlags } = entry;
    if (file.selection_tier !== 'selected') continue;
    if (file.default_evidence_mode === 'exclude') continue;

    const spans: RecommendedEvidenceSpan[] = [];
    for (const symbol of file.symbols) {
      if (!symbol.selected_by_default) continue;
      spans.push({
        symbol_id: symbol.symbol_id,
        include_span: true,
        neighbor_lines: Math.max(0, Math.floor(symbol.default_neighbor_lines)),
      });
    }

    recFiles.push({
      file_id: file.file_id,
      include_ast_skeleton: includeFlags.include_ast_skeleton,
      include_retriever_summary: includeFlags.include_retriever_summary,
      include_entire_file: includeFlags.include_entire_file,
      spans,
    });
  }

  return {
    files: recFiles,
    include_cross_file_findings:
      typeof raw.include_cross_file_findings === 'boolean'
        ? raw.include_cross_file_findings
        : crossFileFindings.length > 0,
    include_gaps: typeof raw.include_gaps === 'boolean' ? raw.include_gaps : gaps.length > 0,
    include_followup_queries:
      typeof raw.include_followup_queries === 'boolean' ? raw.include_followup_queries : false,
  };
}

export interface NormalizeInput {
  raw: RawRetrievalOutput;
  repoRoot: string;
  intentCaptureId: string;
  intentRestatementId: string;
  intentSpecId: string | null;
}

export type NormalizeResult =
  | { success: true; artifact: RetrievalIndexV1 }
  | { success: false; errors: string[] };

/**
 * Normalize raw retriever output into a valid `retrieval-index-v1` artifact.
 *
 * Returns a discriminated result so the caller can decide how to handle
 * validation failures.
 */
export function normalizeRetrievalOutput(input: NormalizeInput): NormalizeResult {
  const { raw, repoRoot, intentCaptureId, intentRestatementId, intentSpecId } = input;

  resetNormalizeCounters();

  const normalizedFiles = raw.files.map((f) => normalizeFile(f, repoRoot));
  const crossFileFindings = raw.cross_file_findings ?? [];
  const gaps = raw.gaps ?? [];
  const followupQueries = raw.followup_queries ?? [];

  const artifact: RetrievalIndexV1 = {
    artifact_type: 'piorx/retrieval-index@1',
    artifact_id: generateArtifactId('piorx/retrieval-index@1'),
    intent_capture_id: intentCaptureId,
    intent_restatement_id: intentRestatementId,
    intent_spec_id: intentSpecId,
    query: raw.query,
    confidence: raw.confidence ?? 'medium',
    strategy_summary: raw.strategy_summary ?? '',
    scout_terms: raw.scout_terms ?? [],
    files: normalizedFiles.map((n) => n.file),
    cross_file_findings: crossFileFindings,
    gaps,
    followup_queries: followupQueries,
    recommended_evidence: buildRecommendedEvidence(normalizedFiles, raw, crossFileFindings, gaps),
  };

  const validation = validateArtifact(artifact);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  return { success: true, artifact };
}
