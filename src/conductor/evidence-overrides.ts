/**
 * Narrow, deterministic override helpers for retriever-authored evidence plans.
 *
 * Overrides are applied on top of a plan produced by
 * `createRecommendedEvidencePlan`. Each operation is validated against the
 * retrieval artifact so unknown files or symbols fail loudly. The override API
 * is intentionally narrow — it is a patch layer for edge cases, not a
 * replacement for retriever planning.
 *
 * Two mode semantics are load-bearing and match the evidence assembler, which
 * materializes raw spans from `planFile.spans.filter(s => s.include_span)`
 * regardless of file-level summary / AST / whole-file flags:
 *
 * - `promote_file` with `mode: 'spans'` seeds concrete spans from retrieval
 *   metadata (`recommended_evidence.files[file_id].spans`, falling back to
 *   `file.symbols` entries flagged `selected_by_default`). If neither source
 *   yields a span, the override throws rather than producing a spanless entry.
 * - `set_file_mode` with `summary` or `summary+ast` clears stale span
 *   selections on the plan file so flag changes stay in sync with emitted
 *   evidence, and `exclude` removes the file from `selection.files` entirely.
 *
 * COMP-P1-T10 promotes the `EvidenceOverride` discriminated union to the
 * first concrete `GateOp` (`src/runtime/gate.ts`) and exports
 * `evidenceReviewGate: GateSpec<EvidenceOverride>` — the canonical reference
 * implementation of a piorx gate. The semantic batch-apply behavior is
 * unchanged; the gate exposes the same logic per-op for the runtime
 * executor's gate broker (`src/runtime/workflow-executor.ts`) and runs
 * after the `evidence` stage when registered against a `WorkflowRegistry`.
 */

import type {
  EvidencePlanV1,
  EvidencePlanFile,
  EvidencePlanSpan,
  EvidencePlanSelection,
  RetrievalIndexV1,
  RetrievalFile,
  RetrievalDefaultEvidenceMode,
} from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import type { GateOp, GateOpValidation, GatePresentation, GateSpec } from '../runtime/gate.ts';
import type { StageContext } from '../runtime/stage.ts';

// ---------------------------------------------------------------------------
// Effective mode derivation
// ---------------------------------------------------------------------------

/**
 * Derive the effective RetrievalDefaultEvidenceMode for a plan file from its
 * current include flags and spans. Used so conductor summaries reflect the
 * adjusted plan rather than the retriever's original default.
 */
export function deriveEffectiveFileMode(file: EvidencePlanFile): RetrievalDefaultEvidenceMode {
  if (file.include_entire_file) return 'whole_file';
  const hasActiveSpan = file.spans.some((s) => s.include_span);
  if (hasActiveSpan) return 'spans';
  if (file.include_ast_skeleton && file.include_retriever_summary) return 'summary+ast';
  if (file.include_retriever_summary) return 'summary';
  return 'exclude';
}

// ---------------------------------------------------------------------------
// Override operations
// ---------------------------------------------------------------------------

export type EvidenceOverride =
  | {
      op: 'promote_file';
      file_id: string;
      mode?: RetrievalDefaultEvidenceMode;
    }
  | {
      op: 'demote_file';
      file_id: string;
    }
  | {
      op: 'set_file_mode';
      file_id: string;
      mode: RetrievalDefaultEvidenceMode;
    }
  | {
      op: 'include_symbol';
      file_id: string;
      symbol_id: string;
      neighbor_lines?: number;
    }
  | {
      op: 'exclude_symbol';
      file_id: string;
      symbol_id: string;
    }
  | {
      op: 'set_neighbor_lines';
      file_id: string;
      symbol_id: string;
      neighbor_lines: number;
    }
  | { op: 'toggle_cross_file_findings'; value: boolean }
  | { op: 'toggle_gaps'; value: boolean }
  | { op: 'toggle_followup_queries'; value: boolean };

export interface ApplyEvidenceOverridesOptions {
  /** The retriever-authored default plan (from createRecommendedEvidencePlan). */
  plan: EvidencePlanV1;
  /** The retrieval artifact that authored the plan — used for validation. */
  retrieval_index: RetrievalIndexV1;
  /** Ordered list of narrow override operations. */
  overrides: EvidenceOverride[];
}

export interface ApplyEvidenceOverridesResult {
  /** A fresh evidence-plan-v1 with the overrides applied. */
  plan: EvidencePlanV1;
  /** One human-readable line per applied override. */
  applied: string[];
}

// ---------------------------------------------------------------------------
// Mode → include flags
// ---------------------------------------------------------------------------

interface IncludeFlags {
  include_ast_skeleton: boolean;
  include_retriever_summary: boolean;
  include_entire_file: boolean;
}

/**
 * Translate a retrieval default_evidence_mode into the three plan-level
 * include flags. Shared vocabulary with the retrieval artifact so override
 * semantics match recommended_evidence semantics.
 */
export function modeToIncludeFlags(mode: RetrievalDefaultEvidenceMode): IncludeFlags {
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
      return {
        include_ast_skeleton: false,
        include_retriever_summary: false,
        include_entire_file: false,
      };
    default:
      throw new Error(
        `invalid mode "${String(mode)}" — expected one of: exclude, summary, summary+ast, spans, whole_file`,
      );
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireIndexFile(index: RetrievalIndexV1, file_id: string): RetrievalFile {
  const match = index.files.find((f) => f.file_id === file_id);
  if (!match) {
    throw new Error(
      `evidence override references unknown file_id "${file_id}" — not present in retrieval-index-v1`,
    );
  }
  return match;
}

function requireIndexSymbol(file: RetrievalFile, symbol_id: string): void {
  if (!file.symbols.some((s) => s.symbol_id === symbol_id)) {
    throw new Error(
      `evidence override references unknown symbol_id "${symbol_id}" on file "${file.file_id}"`,
    );
  }
}

function requirePositiveNeighborLines(value: number, opLabel: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`evidence override ${opLabel} requires a non-negative neighbor_lines value`);
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Attempt to seed concrete default spans for a file being promoted in
 * mode='spans'. First prefers an entry in `recommended_evidence` (unusual for
 * reserve files but possible for re-promotion of a previously demoted
 * selected-tier file), then falls back to symbols flagged
 * `selected_by_default`. Returns `[]` when no concrete span seed is available
 * — the caller decides how to report that.
 */
function seedSpansFromRetrieval(index: RetrievalIndexV1, file: RetrievalFile): EvidencePlanSpan[] {
  const recFile = index.recommended_evidence.files.find((f) => f.file_id === file.file_id);
  if (recFile) {
    const seeded = recFile.spans
      .filter((s) => s.include_span)
      .map((s) => ({
        symbol_id: s.symbol_id,
        include_span: true,
        neighbor_lines: Math.max(0, Math.floor(s.neighbor_lines)),
      }));
    if (seeded.length > 0) return seeded;
  }
  return file.symbols
    .filter((s) => s.selected_by_default)
    .map((s) => ({
      symbol_id: s.symbol_id,
      include_span: true,
      neighbor_lines: Math.max(0, Math.floor(s.default_neighbor_lines)),
    }));
}

function findPlanFileIndex(files: EvidencePlanFile[], file_id: string): number {
  return files.findIndex((f) => f.file_id === file_id);
}

function findSpanIndex(spans: EvidencePlanSpan[], symbol_id: string): number {
  return spans.findIndex((s) => s.symbol_id === symbol_id);
}

// ---------------------------------------------------------------------------
// Deep clone (plain data — no prototypes, no functions)
// ---------------------------------------------------------------------------

function clonePlan(plan: EvidencePlanV1): EvidencePlanV1 {
  return {
    artifact_type: plan.artifact_type,
    artifact_id: plan.artifact_id,
    retrieval_index: { ...plan.retrieval_index },
    selection: cloneSelection(plan.selection),
    assembly_options: { ...plan.assembly_options },
    prompt_sections: { ...plan.prompt_sections },
    target_task: { ...plan.target_task },
  };
}

function cloneSelection(selection: EvidencePlanSelection): EvidencePlanSelection {
  return {
    files: selection.files.map((f) => ({
      file_id: f.file_id,
      include_ast_skeleton: f.include_ast_skeleton,
      include_retriever_summary: f.include_retriever_summary,
      include_entire_file: f.include_entire_file,
      spans: f.spans.map((s) => ({ ...s })),
    })),
    include_cross_file_findings: selection.include_cross_file_findings,
    include_gaps: selection.include_gaps,
    include_followup_queries: selection.include_followup_queries,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a list of narrow overrides to a retriever-authored evidence plan.
 *
 * The input `plan` is not mutated. A new plan object is returned with a fresh
 * `artifact_id` so callers can persist the adjusted plan separately from the
 * retriever-authored default. Every file and symbol reference in an override
 * must exist in the retrieval artifact — invalid references throw.
 *
 * Overrides are applied in order, so later overrides can refine the state
 * produced by earlier ones (e.g. `promote_file` then `include_symbol`).
 */
export function applyEvidenceOverrides(
  options: ApplyEvidenceOverridesOptions,
): ApplyEvidenceOverridesResult {
  const { retrieval_index, overrides } = options;
  const working = clonePlan(options.plan);
  const applied: string[] = [];

  for (const override of overrides) {
    switch (override.op) {
      case 'promote_file': {
        const indexFile = requireIndexFile(retrieval_index, override.file_id);
        if (findPlanFileIndex(working.selection.files, override.file_id) !== -1) {
          throw new Error(`promote_file: file_id "${override.file_id}" is already in the plan`);
        }
        const mode: RetrievalDefaultEvidenceMode =
          override.mode ??
          (indexFile.default_evidence_mode === 'exclude'
            ? 'summary'
            : indexFile.default_evidence_mode);
        const seededSpans =
          mode === 'spans' ? seedSpansFromRetrieval(retrieval_index, indexFile) : [];
        if (mode === 'spans' && seededSpans.length === 0) {
          throw new Error(
            `promote_file: mode='spans' requires default spans in retrieval metadata for file "${override.file_id}", but none are available. ` +
              `Promote with mode='summary+ast' and follow with include_symbol operations, or pick a different mode.`,
          );
        }
        const flags = modeToIncludeFlags(mode);
        working.selection.files.push({
          file_id: indexFile.file_id,
          include_ast_skeleton: flags.include_ast_skeleton,
          include_retriever_summary: flags.include_retriever_summary,
          include_entire_file: flags.include_entire_file,
          spans: seededSpans,
        });
        applied.push(
          seededSpans.length > 0
            ? `promote_file ${override.file_id} mode=${mode} spans=${seededSpans.length}`
            : `promote_file ${override.file_id} mode=${mode}`,
        );
        break;
      }

      case 'demote_file': {
        requireIndexFile(retrieval_index, override.file_id);
        const idx = findPlanFileIndex(working.selection.files, override.file_id);
        if (idx === -1) {
          throw new Error(`demote_file: file_id "${override.file_id}" is not in the plan`);
        }
        working.selection.files.splice(idx, 1);
        applied.push(`demote_file ${override.file_id}`);
        break;
      }

      case 'set_file_mode': {
        requireIndexFile(retrieval_index, override.file_id);
        const idx = findPlanFileIndex(working.selection.files, override.file_id);
        if (idx === -1) {
          throw new Error(
            `set_file_mode: file_id "${override.file_id}" is not in the plan — promote it first`,
          );
        }
        if (override.mode === 'exclude') {
          working.selection.files.splice(idx, 1);
          applied.push(`set_file_mode ${override.file_id} mode=exclude (removed from plan)`);
          break;
        }
        const flags = modeToIncludeFlags(override.mode);
        const planFile = working.selection.files[idx]!;
        planFile.include_ast_skeleton = flags.include_ast_skeleton;
        planFile.include_retriever_summary = flags.include_retriever_summary;
        planFile.include_entire_file = flags.include_entire_file;
        // Clear stale span selections when the new mode does not materialize
        // raw spans. 'spans' keeps them; 'whole_file' reads the entire file and
        // the assembler ignores span entries in that mode, so leaving them is
        // harmless and lets the conductor flip back without losing state.
        if (override.mode === 'summary' || override.mode === 'summary+ast') {
          planFile.spans = [];
        }
        applied.push(`set_file_mode ${override.file_id} mode=${override.mode}`);
        break;
      }

      case 'include_symbol': {
        const indexFile = requireIndexFile(retrieval_index, override.file_id);
        requireIndexSymbol(indexFile, override.symbol_id);
        const fileIdx = findPlanFileIndex(working.selection.files, override.file_id);
        if (fileIdx === -1) {
          throw new Error(
            `include_symbol: file_id "${override.file_id}" is not in the plan — promote it first`,
          );
        }
        const neighborLines =
          override.neighbor_lines === undefined
            ? 0
            : requirePositiveNeighborLines(override.neighbor_lines, 'include_symbol');
        const planFile = working.selection.files[fileIdx]!;
        const spanIdx = findSpanIndex(planFile.spans, override.symbol_id);
        if (spanIdx === -1) {
          planFile.spans.push({
            symbol_id: override.symbol_id,
            include_span: true,
            neighbor_lines: neighborLines,
          });
        } else {
          const existing = planFile.spans[spanIdx]!;
          existing.include_span = true;
          if (override.neighbor_lines !== undefined) {
            existing.neighbor_lines = neighborLines;
          }
        }
        applied.push(
          `include_symbol ${override.file_id}:${override.symbol_id} neighbor_lines=${neighborLines}`,
        );
        break;
      }

      case 'exclude_symbol': {
        const indexFile = requireIndexFile(retrieval_index, override.file_id);
        requireIndexSymbol(indexFile, override.symbol_id);
        const fileIdx = findPlanFileIndex(working.selection.files, override.file_id);
        if (fileIdx === -1) {
          throw new Error(`exclude_symbol: file_id "${override.file_id}" is not in the plan`);
        }
        const planFile = working.selection.files[fileIdx]!;
        const spanIdx = findSpanIndex(planFile.spans, override.symbol_id);
        if (spanIdx === -1) {
          throw new Error(
            `exclude_symbol: symbol_id "${override.symbol_id}" is not in the plan for file "${override.file_id}"`,
          );
        }
        planFile.spans.splice(spanIdx, 1);
        applied.push(`exclude_symbol ${override.file_id}:${override.symbol_id}`);
        break;
      }

      case 'set_neighbor_lines': {
        const indexFile = requireIndexFile(retrieval_index, override.file_id);
        requireIndexSymbol(indexFile, override.symbol_id);
        const fileIdx = findPlanFileIndex(working.selection.files, override.file_id);
        if (fileIdx === -1) {
          throw new Error(`set_neighbor_lines: file_id "${override.file_id}" is not in the plan`);
        }
        const planFile = working.selection.files[fileIdx]!;
        const spanIdx = findSpanIndex(planFile.spans, override.symbol_id);
        if (spanIdx === -1) {
          throw new Error(
            `set_neighbor_lines: symbol_id "${override.symbol_id}" is not in the plan for file "${override.file_id}" — include it first`,
          );
        }
        const neighborLines = requirePositiveNeighborLines(
          override.neighbor_lines,
          'set_neighbor_lines',
        );
        planFile.spans[spanIdx]!.neighbor_lines = neighborLines;
        applied.push(
          `set_neighbor_lines ${override.file_id}:${override.symbol_id} neighbor_lines=${neighborLines}`,
        );
        break;
      }

      case 'toggle_cross_file_findings': {
        working.selection.include_cross_file_findings = override.value;
        applied.push(`toggle_cross_file_findings ${override.value}`);
        break;
      }

      case 'toggle_gaps': {
        working.selection.include_gaps = override.value;
        applied.push(`toggle_gaps ${override.value}`);
        break;
      }

      case 'toggle_followup_queries': {
        working.selection.include_followup_queries = override.value;
        applied.push(`toggle_followup_queries ${override.value}`);
        break;
      }
    }
  }

  return {
    plan: {
      ...working,
      artifact_id: generateArtifactId('piorx/evidence-plan@1'),
    },
    applied,
  };
}

// ---------------------------------------------------------------------------
// Gate primitive — evidence.review
// ---------------------------------------------------------------------------
//
// Per `docs/composability.md` "Phase 1 — Scaffolding" and COMP-P1-T10, the
// `EvidenceOverride` discriminated union is the first concrete `GateOp`
// implementation. Each member of the union already carries the `op`
// discriminator that `GateOp` requires, so the type satisfies the interface
// without any structural change:
//
//     type EvidenceOverride = { op: 'promote_file'; ... } | ...;
//     // structurally compatible with `GateOp` from `src/runtime/gate.ts`.
//
// `EvidenceOverride satisfies GateOp` is checked at compile-time below to
// surface drift if a future override member loses its `op` discriminator.
//
// `evidenceReviewGate` registers against the `evidence` stage id via
// `WorkflowRegistry.registerGate('evidence', evidenceReviewGate)`. The
// executor (`src/runtime/workflow-executor.ts`) walks gates in registration
// order after each stage; the broker drives the user-facing review surface
// produced by `presents()`, validates proposed ops via `validateOverride`,
// and applies accepted ops via `applyOverride`.
//
// The gate's `applyOverride` deliberately wraps the existing batch-apply
// logic: it loads the current plan + retrieval-index from the store, calls
// `applyEvidenceOverrides({ plan, retrieval_index, overrides: [op] })`, and
// persists the resulting plan with a fresh artifact_id. The session-state
// `evidence_plan_id` slot update is the broker's responsibility — the
// `GateSpec` contract returns `void`, so the broker observes the new plan
// id through the store after `applyOverride` resolves.

// Compile-time conformance check: `EvidenceOverride` is a `GateOp`. If a
// future union member drops the `op` discriminator the type-check fails
// loudly at this line rather than silently breaking gate composition.
const _evidenceOverrideIsGateOp: GateOp = null as unknown as EvidenceOverride;
void _evidenceOverrideIsGateOp;

/**
 * Re-export `EvidenceOverride` as the canonical alias used by extension
 * authors who consume the gate primitive. The shape is unchanged — this is
 * a documentation handle for "this union is the first concrete `GateOp`."
 */
export type EvidenceReviewOp = EvidenceOverride;

/**
 * `evidence.review` — the canonical reference `GateSpec`.
 *
 * Registered against the `evidence` stage id; runs after the deterministic
 * evidence assembler produces an evidence-bundle from the retriever-
 * authored default plan. Composes through `WorkflowRegistry.registerGate`
 * and is invoked by the runtime executor in registration order.
 */
export const evidenceReviewGate: GateSpec<EvidenceOverride> = {
  id: 'evidence.review',

  async presents(ctx: StageContext): Promise<GatePresentation> {
    const planId = ctx.session.artifacts.evidence_plan_id;
    if (!planId) {
      return {
        summary: 'evidence.review: no evidence-plan in session — nothing to review yet.',
      };
    }
    const plan = await ctx.store.get('piorx/evidence-plan@1', planId);
    const indexId = ctx.session.artifacts.retrieval_index_id;
    const index = indexId ? await ctx.store.get('piorx/retrieval-index@1', indexId) : null;

    const fileCount = plan?.selection.files.length ?? 0;
    const spanCount =
      plan?.selection.files.reduce(
        (total, file) => total + file.spans.filter((s) => s.include_span).length,
        0,
      ) ?? 0;

    return {
      summary: `evidence-plan ${planId}: ${fileCount} files, ${spanCount} selected spans`,
      details: {
        plan,
        retrieval_index: index,
      },
    };
  },

  validateOverride(op: EvidenceOverride, ctx: StageContext): GateOpValidation {
    const errors: string[] = [];

    // The three toggle ops do not reference a file; they are valid as long
    // as the session has a plan to mutate.
    const isToggle =
      op.op === 'toggle_cross_file_findings' ||
      op.op === 'toggle_gaps' ||
      op.op === 'toggle_followup_queries';

    if (!ctx.session.artifacts.evidence_plan_id) {
      errors.push('evidence.review: no evidence-plan in session to apply override against');
    }
    if (!isToggle && !ctx.session.artifacts.retrieval_index_id) {
      errors.push('evidence.review: no retrieval-index in session to validate override against');
    }
    if (!isToggle) {
      if (!('file_id' in op) || typeof op.file_id !== 'string' || op.file_id.length === 0) {
        errors.push('evidence.review: override is missing required file_id');
      }
    }
    return { valid: errors.length === 0, errors };
  },

  async applyOverride(op: EvidenceOverride, ctx: StageContext): Promise<void> {
    const planId = ctx.session.artifacts.evidence_plan_id;
    const indexId = ctx.session.artifacts.retrieval_index_id;
    if (!planId || !indexId) {
      throw new Error(
        'evidence.review.applyOverride: requires evidence_plan_id and retrieval_index_id in session',
      );
    }
    const plan = await ctx.store.get('piorx/evidence-plan@1', planId);
    const index = await ctx.store.get('piorx/retrieval-index@1', indexId);
    if (!plan) {
      throw new Error(
        `evidence.review.applyOverride: failed to load evidence-plan "${planId}" from store`,
      );
    }
    if (!index) {
      throw new Error(
        `evidence.review.applyOverride: failed to load retrieval-index "${indexId}" from store`,
      );
    }
    const result = applyEvidenceOverrides({
      plan,
      retrieval_index: index,
      overrides: [op],
    });
    await ctx.store.put(result.plan);
    // Note: the session-state `evidence_plan_id` slot update is the broker's
    // responsibility (the GateSpec contract returns `void`). The broker
    // observes the new plan id through the store after `applyOverride`
    // resolves and pivots the slot through its session-state mutator.
  },
};
