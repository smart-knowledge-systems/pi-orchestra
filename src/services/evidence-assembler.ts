/**
 * Evidence assembler service.
 *
 * Deterministic service that resolves an evidence plan against a retrieval
 * index into an evidence bundle. Supports preview and materialize modes.
 *
 * Preview mode: returns stable line/token estimates without reading raw files.
 * Materialize mode: not yet implemented (Phase 4, P4-T5).
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type { EvidencePlanV1, RetrievalIndexV1 } from '../artifacts/types.ts';
import { checkBudget, type BudgetCheckResult } from '../util/budget.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type EvidenceMode = 'preview' | 'materialize';

export interface EvidenceAssemblerInput {
  mode: EvidenceMode;
  retrieval_index_id: string;
  evidence_plan_id: string;
}

export interface EvidencePreviewResult {
  status: 'not_implemented' | 'success' | 'error';
  estimated_lines: number | null;
  estimated_tokens: number | null;
  over_budget_reasons: Array<{ field: string; limit: number; estimated: number }>;
  message: string;
}

export interface EvidenceMaterializeResult {
  status: 'not_implemented' | 'success' | 'error';
  evidence_bundle_id: string | null;
  message: string;
}

export type EvidenceAssemblerResult = EvidencePreviewResult | EvidenceMaterializeResult;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function evidenceAssemble(
  input: EvidenceAssemblerInput,
  store: ArtifactStore,
): Promise<EvidenceAssemblerResult> {
  if (input.mode === 'preview') {
    return previewMode(input, store);
  }
  return {
    status: 'not_implemented',
    evidence_bundle_id: null,
    message: 'Evidence materialization is not yet implemented.',
  };
}

async function previewMode(
  input: EvidenceAssemblerInput,
  store: ArtifactStore,
): Promise<EvidencePreviewResult> {
  // Load the evidence plan
  const plan = await store.get('evidence-plan-v1', input.evidence_plan_id);
  if (!plan) {
    return {
      status: 'error',
      estimated_lines: null,
      estimated_tokens: null,
      over_budget_reasons: [],
      message: `Evidence plan not found: ${input.evidence_plan_id}`,
    };
  }

  // Load the retrieval index
  const index = await store.get('retrieval-index-v1', input.retrieval_index_id);
  if (!index) {
    return {
      status: 'error',
      estimated_lines: null,
      estimated_tokens: null,
      over_budget_reasons: [],
      message: `Retrieval index not found: ${input.retrieval_index_id}`,
    };
  }

  try {
    const budgetCheck = checkBudget(plan, index);
    return {
      status: 'success',
      estimated_lines: budgetCheck.estimate.total_lines,
      estimated_tokens: budgetCheck.estimate.estimated_tokens,
      over_budget_reasons: budgetCheck.over_budget_reasons,
      message: budgetCheck.within_budget
        ? 'Estimate within budget.'
        : `Over budget: ${budgetCheck.over_budget_reasons.map((r) => `${r.field} (${r.estimated} > ${r.limit})`).join(', ')}`,
    };
  } catch (err) {
    return {
      status: 'error',
      estimated_lines: null,
      estimated_tokens: null,
      over_budget_reasons: [],
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
