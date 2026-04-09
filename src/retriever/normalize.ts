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
import type { RetrievalIndexV1, RetrievalFile, RetrievalSymbol } from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import { validateArtifact } from '../artifacts/schemas.ts';

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
}

export interface RawRetrievalFile {
  file_id?: string;
  path: string;
  why_relevant: string;
  file_summary: string;
  ast_skeleton?: string[];
  recommended_expansion?: string;
  expansion_reason?: string;
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
  };
}

function normalizeFile(raw: RawRetrievalFile, repoRoot: string): RetrievalFile {
  // Deliberately omit raw.raw_content — it must never appear in the
  // conductor-visible artifact.
  return {
    file_id: raw.file_id ?? nextFileId(),
    path: absolutePath(raw.path, repoRoot),
    why_relevant: raw.why_relevant,
    file_summary: raw.file_summary,
    ast_skeleton: raw.ast_skeleton ?? [],
    recommended_expansion: raw.recommended_expansion ?? 'none',
    expansion_reason: raw.expansion_reason ?? '',
    symbols: (raw.symbols ?? []).map(normalizeSymbol),
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

  const artifact: RetrievalIndexV1 = {
    artifact_type: 'retrieval-index-v1',
    artifact_id: generateArtifactId('retrieval-index-v1'),
    intent_capture_id: intentCaptureId,
    intent_restatement_id: intentRestatementId,
    intent_spec_id: intentSpecId,
    query: raw.query,
    confidence: raw.confidence ?? 'medium',
    files: raw.files.map((f) => normalizeFile(f, repoRoot)),
    cross_file_findings: raw.cross_file_findings ?? [],
    gaps: raw.gaps ?? [],
    followup_queries: raw.followup_queries ?? [],
  };

  const validation = validateArtifact(artifact);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  return { success: true, artifact };
}
