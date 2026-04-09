/**
 * Stub service: evidence assembler.
 *
 * Deterministic service that resolves an evidence plan against a retrieval
 * index into an evidence bundle. Supports preview and materialize modes.
 * Returns not-implemented until Phase 4.
 */

import type { ArtifactStore } from '../artifacts/store.ts';

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
  message: string;
}

export interface EvidenceMaterializeResult {
  status: 'not_implemented' | 'success' | 'error';
  evidence_bundle_id: string | null;
  message: string;
}

export type EvidenceAssemblerResult = EvidencePreviewResult | EvidenceMaterializeResult;

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

export async function evidenceAssemble(
  input: EvidenceAssemblerInput,
  _store: ArtifactStore,
): Promise<EvidenceAssemblerResult> {
  if (input.mode === 'preview') {
    return {
      status: 'not_implemented',
      estimated_lines: null,
      estimated_tokens: null,
      message: 'Evidence preview is not yet implemented.',
    };
  }
  return {
    status: 'not_implemented',
    evidence_bundle_id: null,
    message: 'Evidence materialization is not yet implemented.',
  };
}
