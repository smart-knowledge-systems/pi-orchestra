/**
 * Retriever worker — orchestrates retrieval from the deterministic scout
 * through (eventually) a bounded model-driven agent.
 *
 * In Phase 3 the worker is a thin adapter that runs the scout and converts
 * its structural candidate set into the raw-output shape consumed by the
 * normalizer. In later phases an agent loop will sit between the scout and
 * this adapter to refine selection and author the default evidence scope.
 *
 * This boundary can still read raw source files through the scout. The
 * conductor must not import this module. Raw bodies never leave this file.
 */

import { relative } from 'node:path';
import type { RetrievalDefaultEvidenceMode, RetrievalSelectionTier } from '../artifacts/types.ts';
import { runScout, type ScoutCandidate, type ScoutResult, type ScoutFileRole } from './scout.ts';
import type { RawRetrievalOutput, RawRetrievalFile, RawRetrievalSymbol } from './normalize.ts';

// ---------------------------------------------------------------------------
// Worker input
// ---------------------------------------------------------------------------

export interface RetrieverWorkerInput {
  repoRoot: string;
  /** Human-readable retrieval brief stored on the artifact. */
  query: string;
  /** Cleaned user intent (not the raw, file-embedded input). */
  cleanedIntent?: string;
  /** Approved restated intent. */
  restatedIntent?: string;
  /** Optional retrieval focus hints from the intent spec. */
  retrievalFocus?: string[];
  /** User-tagged files carried through explicitly. */
  taggedFiles?: string[];
  /**
   * Pre-computed scout result. When provided, the worker reuses it rather
   * than running the scout again — keeping dispatch in control of ordering.
   */
  scout?: ScoutResult;
}

// ---------------------------------------------------------------------------
// Scout → raw output adapter
// ---------------------------------------------------------------------------

function confidenceFromScout(scout: ScoutResult): string {
  if (scout.selected.length === 0) return 'low';
  const topScore = scout.selected[0]?.score ?? 0;
  if (scout.selected.length >= 4 && topScore >= 20) return 'high';
  return 'medium';
}

function describePriority(score: number): 'high' | 'medium' | 'low' {
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

function describeRelevance(score: number): 'high' | 'medium' | 'low' {
  if (score >= 14) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}

function roleToRecommendation(mode: RetrievalDefaultEvidenceMode): {
  fileMode: string;
  reason: string;
} {
  switch (mode) {
    case 'whole_file':
      return {
        fileMode: 'file',
        reason: 'Short, high-signal file; whole-file context recommended',
      };
    case 'spans':
      return {
        fileMode: 'span',
        reason: 'Specific symbols align with curated terms; spans recommended',
      };
    case 'summary+ast':
      return {
        fileMode: 'none',
        reason: 'Summary plus AST skeleton is likely sufficient',
      };
    case 'exclude':
      return {
        fileMode: 'none',
        reason: 'Reserve candidate; only include on explicit promotion',
      };
    case 'summary':
    default:
      return {
        fileMode: 'none',
        reason: 'Structural summary is likely sufficient',
      };
  }
}

function symbolToRaw(
  sym: ScoutCandidate['topSymbols'][number],
  imports: string[],
  role: ScoutFileRole,
): RawRetrievalSymbol {
  const expansion = sym.score >= 10 ? 'span' : sym.score >= 6 ? 'span' : 'none';
  return {
    kind: sym.kind,
    name: sym.name,
    start: sym.start,
    count: sym.count,
    summary: sym.reason,
    role_in_system:
      sym.kind === 'class'
        ? 'type boundary or stateful unit'
        : sym.kind === 'interface' || sym.kind === 'type'
          ? 'structural contract'
          : 'behavior entrypoint or helper',
    depends_on: imports.slice(0, 4),
    used_by: [],
    relevance: describeRelevance(sym.score),
    change_likelihood:
      role === 'tagged' && sym.score >= 6
        ? 'high'
        : sym.score >= 10
          ? 'high'
          : sym.score >= 5
            ? 'medium'
            : 'low',
    expansion_priority: describePriority(sym.score),
    recommended_expansion: expansion,
    expansion_reason:
      sym.score >= 6
        ? 'Symbol name or body aligns with curated retrieval terms'
        : 'Symbol appears peripheral to the current objective',
  };
}

function candidateToRawFile(
  candidate: ScoutCandidate,
  tier: RetrievalSelectionTier,
): RawRetrievalFile {
  const { fileMode, reason } = roleToRecommendation(candidate.evidenceModeHint);
  const symbols = candidate.topSymbols.map((sym) =>
    symbolToRaw(sym, candidate.imports, candidate.role),
  );

  const whyRelevant =
    tier === 'reserve' ? `reserve candidate: ${candidate.rationale}` : candidate.rationale;

  return {
    path: candidate.path,
    why_relevant: whyRelevant,
    file_summary: candidate.summary,
    ast_skeleton: candidate.astSkeleton,
    recommended_expansion: fileMode,
    expansion_reason: reason,
    selection_tier: tier,
    selection_reason: `${candidate.role} · ${candidate.rationale}`,
    default_evidence_mode: candidate.evidenceModeHint,
    symbols,
  };
}

export function scoutToRawOutput(query: string, scout: ScoutResult): RawRetrievalOutput {
  const files: RawRetrievalFile[] = [
    ...scout.selected.map((c) => candidateToRawFile(c, 'selected')),
    ...scout.reserve.map((c) => candidateToRawFile(c, 'reserve')),
  ];

  return {
    query,
    confidence: confidenceFromScout(scout),
    files,
    cross_file_findings: scout.crossFileHints,
    gaps: scout.gaps,
    followup_queries: scout.terms
      .filter((t) => t.kinds.includes('focus') || t.weight >= 4)
      .slice(0, 4)
      .map((t) => `investigate ${t.term}-related callsites or configuration`),
    strategy_summary: scout.strategySummary,
    scout_terms: scout.scoutTerms,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the retriever worker against the repository.
 *
 * Currently: run the scout (or reuse a pre-computed one) and adapt its
 * output to the normalization contract. Future phases will interpose a
 * bounded retriever agent between the scout and the adapter.
 */
export async function runRetrieverWorker(input: RetrieverWorkerInput): Promise<RawRetrievalOutput> {
  const scout =
    input.scout ??
    (await runScout({
      repoRoot: input.repoRoot,
      cleanedIntent: input.cleanedIntent,
      restatedIntent: input.restatedIntent,
      retrievalFocus: input.retrievalFocus,
      taggedFiles: input.taggedFiles,
    }));

  return scoutToRawOutput(input.query, scout);
}

// Re-export for tests and diagnostics.
export { relative };
