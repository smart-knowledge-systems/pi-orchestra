/**
 * Text-safe artifact inspection API for the conductor.
 *
 * The conductor may inspect stored artifacts through this API, which
 * returns only text-safe structural fields. It explicitly refuses to
 * return raw bundle payloads (evidence-bundle-v1 raw_evidence content).
 *
 * @module services/artifact-inspect
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type {
  ArtifactType,
  Artifact,
  RetrievalIndexV1,
  RetrievalRecommendedEvidence,
  RetrievalSelectionTier,
  RetrievalDefaultEvidenceMode,
  EvidenceBundleV1,
} from '../artifacts/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A text-safe symbol entry in the retrieval inspection payload. */
export interface RetrievalIndexInspectionSymbol {
  symbol_id: string;
  kind: string;
  name: string;
  start: number;
  count: number;
  summary: string;
  selected_by_default: boolean;
  default_neighbor_lines: number;
  selection_reason: string;
}

/** A text-safe file entry in the retrieval inspection payload. */
export interface RetrievalIndexInspectionFile {
  file_id: string;
  path: string;
  why_relevant: string;
  file_summary: string;
  ast_skeleton: string[];
  symbol_count: number;
  selection_tier: RetrievalSelectionTier;
  selection_reason: string;
  default_evidence_mode: RetrievalDefaultEvidenceMode;
  symbols: RetrievalIndexInspectionSymbol[];
}

/** The text-safe view of a retrieval-index-v1 for the conductor. */
export interface RetrievalIndexInspection {
  artifact_id: string;
  query: string;
  confidence: string;
  strategy_summary: string;
  scout_terms: string[];
  file_count: number;
  selected_file_count: number;
  reserve_file_count: number;
  files: RetrievalIndexInspectionFile[];
  cross_file_findings: string[];
  gaps: string[];
  followup_queries: string[];
  recommended_evidence: RetrievalRecommendedEvidence;
}

export type InspectResult =
  | { success: true; inspection: RetrievalIndexInspection }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Blocked artifact types — conductor must not see raw content
// ---------------------------------------------------------------------------

const BLOCKED_TYPES: ReadonlySet<ArtifactType> = new Set(['piorx/evidence-bundle@1']);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Inspect a retrieval-index-v1 artifact in a text-safe way.
 *
 * Returns structural metadata only — no raw file content.
 */
function inspectRetrievalIndex(artifact: RetrievalIndexV1): RetrievalIndexInspection {
  let selectedCount = 0;
  let reserveCount = 0;
  const files: RetrievalIndexInspectionFile[] = artifact.files.map((f) => {
    if (f.selection_tier === 'reserve') reserveCount++;
    else selectedCount++;
    return {
      file_id: f.file_id,
      path: f.path,
      why_relevant: f.why_relevant,
      file_summary: f.file_summary,
      ast_skeleton: f.ast_skeleton,
      symbol_count: f.symbols.length,
      selection_tier: f.selection_tier,
      selection_reason: f.selection_reason,
      default_evidence_mode: f.default_evidence_mode,
      symbols: f.symbols.map((s) => ({
        symbol_id: s.symbol_id,
        kind: s.kind,
        name: s.name,
        start: s.start,
        count: s.count,
        summary: s.summary,
        selected_by_default: s.selected_by_default,
        default_neighbor_lines: s.default_neighbor_lines,
        selection_reason: s.selection_reason,
      })),
    };
  });

  return {
    artifact_id: artifact.artifact_id,
    query: artifact.query,
    confidence: artifact.confidence,
    strategy_summary: artifact.strategy_summary,
    scout_terms: artifact.scout_terms,
    file_count: artifact.files.length,
    selected_file_count: selectedCount,
    reserve_file_count: reserveCount,
    files,
    cross_file_findings: artifact.cross_file_findings,
    gaps: artifact.gaps,
    followup_queries: artifact.followup_queries,
    recommended_evidence: artifact.recommended_evidence,
  };
}

/**
 * Inspect an artifact by ID in a conductor-safe manner.
 *
 * - Returns text-safe structural data for supported types.
 * - Refuses to return raw bundle payloads.
 * - Returns an error result if the artifact is not found or type is blocked.
 */
export async function artifactInspect(
  store: ArtifactStore,
  artifactType: ArtifactType,
  artifactId: string,
): Promise<InspectResult> {
  if (BLOCKED_TYPES.has(artifactType)) {
    return {
      success: false,
      error: `artifact_inspect refuses raw bundle payloads: type "${artifactType}" is not inspectable by the conductor`,
    };
  }

  if (artifactType === 'piorx/retrieval-index@1') {
    const artifact = await store.get('piorx/retrieval-index@1', artifactId);
    if (!artifact) {
      return { success: false, error: `Artifact ${artifactId} not found` };
    }
    return { success: true, inspection: inspectRetrievalIndex(artifact) };
  }

  return {
    success: false,
    error: `artifact_inspect does not yet support type "${artifactType}"`,
  };
}
