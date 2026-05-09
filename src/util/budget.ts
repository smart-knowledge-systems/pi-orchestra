/**
 * Budget utilities for the evidence assembler.
 *
 * Pure functions for estimating line counts and token counts from an
 * evidence plan and retrieval index, without reading raw file content.
 */

import type {
  EvidencePlanV1,
  EvidencePlanFile,
  AssemblyOptions,
  RetrievalIndexV1,
  RetrievalFile,
} from '../artifacts/types.ts';
import {
  resolveSymbolToSpan,
  expandNeighborLines,
  mergeOverlappingSpans,
  SpanResolutionError,
  type ResolvedSpan,
} from './spans.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough estimate: ~4 characters per token for code. */
const CHARS_PER_TOKEN = 4;

/** Average characters per line of code (used for line-based token estimates). */
const AVG_CHARS_PER_LINE = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEstimate {
  file_id: string;
  path: string;
  skeleton_lines: number;
  summary_lines: number;
  span_lines: number;
  total_lines: number;
}

export interface BudgetEstimate {
  file_estimates: FileEstimate[];
  cross_file_lines: number;
  gaps_lines: number;
  followup_lines: number;
  total_lines: number;
  estimated_tokens: number;
}

export interface OverBudgetReason {
  field: 'max_total_lines' | 'max_estimated_tokens';
  limit: number;
  estimated: number;
}

export interface BudgetCheckResult {
  within_budget: boolean;
  estimate: BudgetEstimate;
  over_budget_reasons: OverBudgetReason[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findRetrievalFile(index: RetrievalIndexV1, fileId: string): RetrievalFile | null {
  return index.files.find((f) => f.file_id === fileId) ?? null;
}

/**
 * Estimate token count from line count using average line length heuristic.
 */
export function estimateTokensFromLines(lines: number): number {
  return Math.ceil((lines * AVG_CHARS_PER_LINE) / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Per-file estimation
// ---------------------------------------------------------------------------

function estimateFileLines(
  planFile: EvidencePlanFile,
  index: RetrievalIndexV1,
  dedupe: boolean,
): FileEstimate {
  const rFile = findRetrievalFile(index, planFile.file_id);
  if (!rFile) {
    throw new SpanResolutionError(`Unknown file_id: ${planFile.file_id}`);
  }

  let skeletonLines = 0;
  if (planFile.include_ast_skeleton) {
    skeletonLines = rFile.ast_skeleton.length;
  }

  let summaryLines = 0;
  if (planFile.include_retriever_summary) {
    // Summary is a single text block; estimate its line count
    summaryLines = rFile.file_summary ? rFile.file_summary.split('\n').length : 0;
  }

  let spanLines = 0;
  if (planFile.include_entire_file) {
    // We cannot know the exact line count without reading the file.
    // Use symbol information as a rough proxy: the max end line across symbols,
    // or a default estimate.
    if (rFile.symbols.length > 0) {
      const maxEnd = Math.max(...rFile.symbols.map((s) => s.start + s.count - 1));
      spanLines = maxEnd;
    } else {
      // No symbols — use a conservative estimate
      spanLines = 100;
    }
  } else {
    // Resolve individual spans from the plan
    const enabledSpans = planFile.spans.filter((s) => s.include_span);
    if (enabledSpans.length > 0) {
      const resolved: ResolvedSpan[] = enabledSpans.map((s) => {
        const base = resolveSymbolToSpan(index, planFile.file_id, s.symbol_id);
        return expandNeighborLines(base, s.neighbor_lines);
      });

      const finalSpans = dedupe ? mergeOverlappingSpans(resolved) : resolved;
      spanLines = finalSpans.reduce((sum, sp) => sum + sp.count, 0);
    }
  }

  return {
    file_id: planFile.file_id,
    path: rFile.path,
    skeleton_lines: skeletonLines,
    summary_lines: summaryLines,
    span_lines: spanLines,
    total_lines: skeletonLines + summaryLines + spanLines,
  };
}

// ---------------------------------------------------------------------------
// Full estimate
// ---------------------------------------------------------------------------

/**
 * Estimate the total line and token budget for an evidence plan,
 * without reading raw file content.
 *
 * Uses only retrieval-index metadata (symbol ranges, AST skeleton lengths,
 * summary text) to produce deterministic estimates.
 */
export function estimateBudget(plan: EvidencePlanV1, index: RetrievalIndexV1): BudgetEstimate {
  const dedupe = plan.assembly_options.dedupe_overlapping_spans;

  const fileEstimates = plan.selection.files.map((f) => estimateFileLines(f, index, dedupe));

  let crossFileLines = 0;
  if (plan.selection.include_cross_file_findings) {
    crossFileLines = index.cross_file_findings.length;
  }

  let gapsLines = 0;
  if (plan.selection.include_gaps) {
    gapsLines = index.gaps.length;
  }

  let followupLines = 0;
  if (plan.selection.include_followup_queries) {
    followupLines = index.followup_queries.length;
  }

  const totalLines =
    fileEstimates.reduce((sum, f) => sum + f.total_lines, 0) +
    crossFileLines +
    gapsLines +
    followupLines;

  return {
    file_estimates: fileEstimates,
    cross_file_lines: crossFileLines,
    gaps_lines: gapsLines,
    followup_lines: followupLines,
    total_lines: totalLines,
    estimated_tokens: estimateTokensFromLines(totalLines),
  };
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

/**
 * Check whether an evidence plan fits within its declared budget.
 *
 * Returns structured reasons for any over-budget condition.
 * Never silently prunes — callers must decide how to respond.
 */
export function checkBudget(plan: EvidencePlanV1, index: RetrievalIndexV1): BudgetCheckResult {
  const estimate = estimateBudget(plan, index);
  const reasons: OverBudgetReason[] = [];

  if (estimate.total_lines > plan.assembly_options.max_total_lines) {
    reasons.push({
      field: 'max_total_lines',
      limit: plan.assembly_options.max_total_lines,
      estimated: estimate.total_lines,
    });
  }

  if (estimate.estimated_tokens > plan.assembly_options.max_estimated_tokens) {
    reasons.push({
      field: 'max_estimated_tokens',
      limit: plan.assembly_options.max_estimated_tokens,
      estimated: estimate.estimated_tokens,
    });
  }

  return {
    within_budget: reasons.length === 0,
    estimate,
    over_budget_reasons: reasons,
  };
}

// ---------------------------------------------------------------------------
// Retriever-authored default scope estimation
// ---------------------------------------------------------------------------

const DEFAULT_ASSEMBLY_OPTIONS_FOR_RECOMMENDATION: AssemblyOptions = {
  max_total_lines: 2000,
  max_estimated_tokens: 20000,
  dedupe_overlapping_spans: true,
  span_merge_strategy: 'merge_if_overlapping',
};

/**
 * Estimate the budget for the retriever-authored default evidence scope
 * embedded in a retrieval-index-v1.
 *
 * Mirrors `createRecommendedEvidencePlan`'s scope selection without going
 * through the conductor plan helper: reserve-tier files are excluded, per-file
 * include flags and per-symbol neighbor_lines come straight from
 * `recommended_evidence`, and cross-file/gap/followup inclusion flags are
 * taken from the retriever's recommendation. This gives budget-aware callers
 * (previews, conductor summaries) a number grounded in the narrower default
 * scope rather than the old summary-for-all heuristic.
 */
export function estimateRecommendedBudget(
  index: RetrievalIndexV1,
  assembly_options?: Partial<AssemblyOptions>,
): BudgetEstimate {
  const recommended = index.recommended_evidence;
  const planFiles: EvidencePlanFile[] = recommended.files.map((rec) => ({
    file_id: rec.file_id,
    include_ast_skeleton: rec.include_ast_skeleton,
    include_retriever_summary: rec.include_retriever_summary,
    include_entire_file: rec.include_entire_file,
    spans: rec.spans.map((span) => ({
      symbol_id: span.symbol_id,
      include_span: span.include_span,
      neighbor_lines: Math.max(0, Math.floor(span.neighbor_lines)),
    })),
  }));

  const syntheticPlan: EvidencePlanV1 = {
    artifact_type: 'piorx/evidence-plan@1',
    artifact_id: 'plan_recommended_preview',
    retrieval_index: {
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: index.artifact_id,
    },
    selection: {
      files: planFiles,
      include_cross_file_findings: recommended.include_cross_file_findings,
      include_gaps: recommended.include_gaps,
      include_followup_queries: recommended.include_followup_queries,
    },
    assembly_options: {
      ...DEFAULT_ASSEMBLY_OPTIONS_FOR_RECOMMENDATION,
      ...assembly_options,
    },
    prompt_sections: {
      include_intent_context: true,
      include_structural_context: true,
      include_raw_evidence: true,
    },
    target_task: { type: 'analysis-report', task_label: 'recommended-scope budget estimate' },
  };

  return estimateBudget(syntheticPlan, index);
}
