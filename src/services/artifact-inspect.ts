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
  EvidenceBundleV1,
} from '../artifacts/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The text-safe view of a retrieval-index-v1 for the conductor. */
export interface RetrievalIndexInspection {
  artifact_id: string;
  query: string;
  confidence: string;
  file_count: number;
  files: Array<{
    file_id: string;
    path: string;
    why_relevant: string;
    file_summary: string;
    ast_skeleton: string[];
    symbol_count: number;
    symbols: Array<{
      symbol_id: string;
      kind: string;
      name: string;
      start: number;
      count: number;
      summary: string;
    }>;
  }>;
  cross_file_findings: string[];
  gaps: string[];
  followup_queries: string[];
}

export type InspectResult =
  | { success: true; inspection: RetrievalIndexInspection }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Blocked artifact types — conductor must not see raw content
// ---------------------------------------------------------------------------

const BLOCKED_TYPES: ReadonlySet<ArtifactType> = new Set(['evidence-bundle-v1']);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Inspect a retrieval-index-v1 artifact in a text-safe way.
 *
 * Returns structural metadata only — no raw file content.
 */
function inspectRetrievalIndex(artifact: RetrievalIndexV1): RetrievalIndexInspection {
  return {
    artifact_id: artifact.artifact_id,
    query: artifact.query,
    confidence: artifact.confidence,
    file_count: artifact.files.length,
    files: artifact.files.map((f) => ({
      file_id: f.file_id,
      path: f.path,
      why_relevant: f.why_relevant,
      file_summary: f.file_summary,
      ast_skeleton: f.ast_skeleton,
      symbol_count: f.symbols.length,
      symbols: f.symbols.map((s) => ({
        symbol_id: s.symbol_id,
        kind: s.kind,
        name: s.name,
        start: s.start,
        count: s.count,
        summary: s.summary,
      })),
    })),
    cross_file_findings: artifact.cross_file_findings,
    gaps: artifact.gaps,
    followup_queries: artifact.followup_queries,
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

  if (artifactType === 'retrieval-index-v1') {
    const artifact = await store.get('retrieval-index-v1', artifactId);
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
