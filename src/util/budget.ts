/**
 * Budget utilities for the evidence assembler.
 *
 * Pure functions for estimating line counts and token counts from an
 * evidence plan and retrieval index, without reading raw file content.
 */

import type {
  EvidencePlanV1,
  EvidencePlanFile,
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
