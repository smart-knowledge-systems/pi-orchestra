/**
 * Retriever worker — orchestrates retrieval from the deterministic scout
 * through the bounded model-driven retriever agent (when a model callback
 * is supplied).
 *
 * Sequence:
 *   1. Run the scout (deterministic) to narrow the candidate set.
 *   2. If a model callback is provided, hand the scout seed to the
 *      retriever agent and let it read files / follow leads through the
 *      deterministic executor.
 *   3. Convert scout + agent output into the loose `RawRetrievalOutput`
 *      shape the normalizer consumes.
 *
 * This boundary can still read raw source files (through the scout and
 * executor). The conductor must not import this module. Raw bodies never
 * leave this file.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { RetrievalDefaultEvidenceMode, RetrievalSelectionTier } from '../artifacts/types.ts';
import type {
  AgentFileSelection,
  AgentFinalRecommendation,
  AgentLimits,
  AgentModelCallback,
  AgentRunResult,
  AgentSymbolSelection,
} from './agent-types.ts';
import { runRetrieverAgent } from './agent.ts';
import { runScout, type ScoutCandidate, type ScoutFileRole, type ScoutResult } from './scout.ts';
import type { RawRetrievalFile, RawRetrievalOutput, RawRetrievalSymbol } from './normalize.ts';

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
  /**
   * Optional model callback. When supplied the worker runs the bounded
   * retriever agent after the scout. When omitted the worker falls back to
   * the deterministic scout-only output (useful in tests and pipelines
   * that do not yet wire a model).
   */
  model?: AgentModelCallback;
  /** Optional overrides for the agent's bounded limits. */
  agentLimits?: Partial<AgentLimits>;
}

export interface RetrieverWorkerResult {
  raw: RawRetrievalOutput;
  scout: ScoutResult;
  agent: AgentRunResult | null;
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
// Agent → raw output adapter
// ---------------------------------------------------------------------------

function normalizeRelPath(repoRoot: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  return rel === '' ? '.' : rel;
}

function buildScoutLookup(scout: ScoutResult): Map<string, ScoutCandidate> {
  const lookup = new Map<string, ScoutCandidate>();
  for (const c of [...scout.selected, ...scout.reserve]) {
    lookup.set(c.relPath, c);
  }
  return lookup;
}

function fileModeFromAgentFile(file: AgentFileSelection): { fileMode: string; reason: string } {
  if (file.include_entire_file) {
    return {
      fileMode: 'file',
      reason: file.selection_reason || 'retriever agent selected whole-file context',
    };
  }
  if (file.default_evidence_mode === 'spans' || file.symbols.some((s) => s.selected_by_default)) {
    return {
      fileMode: 'span',
      reason: file.selection_reason || 'retriever agent selected symbol spans',
    };
  }
  return roleToRecommendation(file.default_evidence_mode);
}

function agentSymbolToRaw(
  agentSym: AgentSymbolSelection,
  baseSymbol: RawRetrievalSymbol | undefined,
): RawRetrievalSymbol {
  if (baseSymbol) {
    return {
      ...baseSymbol,
      start: Math.max(1, agentSym.start),
      count: Math.max(1, agentSym.count),
      recommended_expansion: agentSym.selected_by_default
        ? 'span'
        : baseSymbol.recommended_expansion,
      expansion_reason: agentSym.selection_reason || baseSymbol.expansion_reason,
    };
  }
  return {
    kind: 'symbol',
    name: agentSym.name,
    start: Math.max(1, agentSym.start),
    count: Math.max(1, agentSym.count),
    summary: agentSym.selection_reason,
    role_in_system: 'retriever-agent-selected symbol',
    depends_on: [],
    used_by: [],
    relevance: agentSym.selected_by_default ? 'high' : 'medium',
    change_likelihood: 'unknown',
    expansion_priority: agentSym.selected_by_default ? 'high' : 'medium',
    recommended_expansion: agentSym.selected_by_default ? 'span' : 'none',
    expansion_reason: agentSym.selection_reason,
  };
}

function agentFileToRawFile(
  file: AgentFileSelection,
  scoutLookup: Map<string, ScoutCandidate>,
  repoRoot: string,
): RawRetrievalFile {
  const relPath = normalizeRelPath(repoRoot, file.path);
  const scout = scoutLookup.get(relPath);
  const { fileMode, reason } = fileModeFromAgentFile(file);

  const baseSymbols = scout
    ? scout.topSymbols.map((s) => symbolToRaw(s, scout.imports, scout.role))
    : [];
  const baseByName = new Map<string, RawRetrievalSymbol>();
  for (const sym of baseSymbols) baseByName.set(sym.name, sym);

  const agentSymbols = file.symbols.map((sym) => agentSymbolToRaw(sym, baseByName.get(sym.name)));

  // Any scout symbols the agent did not mention remain available as context
  // at the structural level but are not marked as selected.
  const includedNames = new Set(agentSymbols.map((s) => s.name));
  const leftoverSymbols = baseSymbols.filter((s) => !includedNames.has(s.name));

  const absolute = isAbsolute(file.path) ? resolve(file.path) : resolve(repoRoot, file.path);
  const whyRelevant =
    file.tier === 'reserve'
      ? `reserve candidate (agent): ${file.selection_reason || 'agent marked for optional promotion'}`
      : file.selection_reason ||
        (scout ? scout.rationale : 'retriever agent selected for evidence package');

  return {
    path: absolute,
    why_relevant: whyRelevant,
    file_summary: scout ? scout.summary : `${relPath} — retriever-agent selection`,
    ast_skeleton: scout ? scout.astSkeleton : [],
    recommended_expansion: fileMode,
    expansion_reason: reason,
    selection_tier: file.tier,
    selection_reason:
      file.selection_reason ||
      (scout ? `${scout.role} · ${scout.rationale}` : 'retriever agent selection'),
    default_evidence_mode: file.default_evidence_mode,
    symbols: [...agentSymbols, ...leftoverSymbols],
  };
}

function confidenceFromAgent(recommendation: AgentFinalRecommendation, scout: ScoutResult): string {
  if (recommendation.files.length === 0) return confidenceFromScout(scout);
  return recommendation.confidence;
}

function agentToRawOutput(
  query: string,
  scout: ScoutResult,
  agentResult: AgentRunResult,
  repoRoot: string,
): RawRetrievalOutput {
  const lookup = buildScoutLookup(scout);
  const files = agentResult.recommendation.files.map((file) =>
    agentFileToRawFile(file, lookup, repoRoot),
  );

  return {
    query,
    confidence: confidenceFromAgent(agentResult.recommendation, scout),
    files,
    cross_file_findings:
      agentResult.recommendation.cross_file_findings.length > 0
        ? agentResult.recommendation.cross_file_findings
        : scout.crossFileHints,
    gaps: agentResult.recommendation.gaps.length > 0 ? agentResult.recommendation.gaps : scout.gaps,
    followup_queries: agentResult.recommendation.followup_queries,
    strategy_summary: agentResult.recommendation.strategy_summary || scout.strategySummary,
    scout_terms: scout.scoutTerms,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the retriever worker against the repository.
 *
 * When `input.model` is supplied, the worker runs the bounded retriever
 * agent after the scout and adapts the agent's final recommendation to
 * the normalization contract. When no model is supplied the worker falls
 * back to the deterministic scout-only adapter.
 */
export async function runRetrieverWorker(input: RetrieverWorkerInput): Promise<RawRetrievalOutput> {
  const result = await runRetrieverWorkerDetailed(input);
  return result.raw;
}

/**
 * Detailed variant that returns the raw output alongside the scout and
 * (when available) agent results. Used by dispatch and by tests that need
 * to inspect agent trace / telemetry.
 */
export async function runRetrieverWorkerDetailed(
  input: RetrieverWorkerInput,
): Promise<RetrieverWorkerResult> {
  const scout =
    input.scout ??
    (await runScout({
      repoRoot: input.repoRoot,
      cleanedIntent: input.cleanedIntent,
      restatedIntent: input.restatedIntent,
      retrievalFocus: input.retrievalFocus,
      taggedFiles: input.taggedFiles,
    }));

  if (!input.model) {
    return { raw: scoutToRawOutput(input.query, scout), scout, agent: null };
  }

  const agent = await runRetrieverAgent({
    repoRoot: input.repoRoot,
    intent: {
      cleanedIntent: input.cleanedIntent,
      restatedIntent: input.restatedIntent,
      retrievalFocus: input.retrievalFocus,
      taggedFiles: input.taggedFiles,
    },
    scout,
    model: input.model,
    limits: input.agentLimits,
  });

  const raw =
    agent.recommendation.files.length === 0
      ? scoutToRawOutput(input.query, scout)
      : agentToRawOutput(input.query, scout, agent, resolve(input.repoRoot));

  return { raw, scout, agent };
}

// Re-export for tests and diagnostics.
export { relative };
