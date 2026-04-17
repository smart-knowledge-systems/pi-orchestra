/**
 * Evidence assembler service.
 *
 * Deterministic service that resolves an evidence plan against a retrieval
 * index into an evidence bundle. Supports preview and materialize modes.
 *
 * Preview mode: returns stable line/token estimates without reading raw files.
 * Materialize mode: reads the authoritative retrieval artifact plus repo disk
 * state and emits a valid evidence-bundle-v1 with canonical sections.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ArtifactStore } from '../artifacts/store.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import type {
  EvidencePlanV1,
  EvidencePlanFile,
  RetrievalIndexV1,
  RetrievalFile,
  EvidenceBundleV1,
  BundleStructuralFile,
  BundleStructuralSymbol,
  BundleRawEvidence,
  BundleStats,
} from '../artifacts/types.ts';
import { checkBudget } from '../util/budget.ts';
import {
  resolveSymbolToSpan,
  expandNeighborLines,
  mergeOverlappingSpans,
  SpanResolutionError,
  type ResolvedSpan,
} from '../util/spans.ts';

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
  return materializeMode(input, store);
}

// ---------------------------------------------------------------------------
// Preview mode
// ---------------------------------------------------------------------------

async function previewMode(
  input: EvidenceAssemblerInput,
  store: ArtifactStore,
): Promise<EvidencePreviewResult> {
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

// ---------------------------------------------------------------------------
// Materialize mode
// ---------------------------------------------------------------------------

async function materializeMode(
  input: EvidenceAssemblerInput,
  store: ArtifactStore,
): Promise<EvidenceMaterializeResult> {
  // Load plan
  const plan = await store.get('evidence-plan-v1', input.evidence_plan_id);
  if (!plan) {
    return {
      status: 'error',
      evidence_bundle_id: null,
      message: `Evidence plan not found: ${input.evidence_plan_id}`,
    };
  }

  // Load authoritative retrieval index
  const index = await store.get('retrieval-index-v1', input.retrieval_index_id);
  if (!index) {
    return {
      status: 'error',
      evidence_bundle_id: null,
      message: `Retrieval index not found: ${input.retrieval_index_id}`,
    };
  }

  // Verify plan references the correct retrieval index
  if (plan.retrieval_index.artifact_id !== index.artifact_id) {
    return {
      status: 'error',
      evidence_bundle_id: null,
      message: `Plan retrieval_index.artifact_id (${plan.retrieval_index.artifact_id}) does not match provided index (${index.artifact_id})`,
    };
  }

  try {
    // Build intent context from the retrieval index's source artifacts
    const intentCapture = await store.get('intent-capture-v1', index.intent_capture_id);
    const intentRestatement = await store.get('intent-restatement-v1', index.intent_restatement_id);

    const intent_context = {
      user_intent_verbatim: intentCapture?.user_intent_verbatim ?? '',
      approved_restated_intent: intentRestatement?.restated_intent ?? '',
      intent_spec_id: index.intent_spec_id,
    };

    // Build structural context and raw evidence
    const structuralFiles: BundleStructuralFile[] = [];
    const rawEvidence: BundleRawEvidence[] = [];
    let totalLines = 0;
    let totalSpans = 0;
    let totalFullFiles = 0;

    for (const planFile of plan.selection.files) {
      const indexFile = index.files.find((f) => f.file_id === planFile.file_id);
      if (!indexFile) {
        throw new SpanResolutionError(`Unknown file_id in plan: ${planFile.file_id}`);
      }

      const structFile = buildStructuralFile(planFile, indexFile);
      structuralFiles.push(structFile);

      // Resolve raw evidence from disk
      const fileEvidence = await resolveFileEvidence(planFile, indexFile, index, plan);
      rawEvidence.push(...fileEvidence.evidence);
      totalLines += fileEvidence.lines;
      totalSpans += fileEvidence.spans;
      if (planFile.include_entire_file) totalFullFiles++;
    }

    // Cross-file findings
    const cross_file_findings: string[] = plan.selection.include_cross_file_findings
      ? [...index.cross_file_findings]
      : [];

    // Assembly notes
    const assemblyNotes: string[] = [];
    if (plan.selection.include_gaps && index.gaps.length > 0) {
      assemblyNotes.push(`Gaps: ${index.gaps.join('; ')}`);
    }
    if (plan.selection.include_followup_queries && index.followup_queries.length > 0) {
      assemblyNotes.push(`Followup queries: ${index.followup_queries.join('; ')}`);
    }

    // Count cross-file and notes lines
    totalLines += cross_file_findings.length;
    for (const note of assemblyNotes) {
      totalLines += note.split('\n').length;
    }

    const stats: BundleStats = {
      files: structuralFiles.length,
      spans: totalSpans,
      full_files: totalFullFiles,
      total_lines: totalLines,
      estimated_tokens: Math.ceil((totalLines * 60) / 4),
    };

    const bundle: EvidenceBundleV1 = {
      artifact_type: 'evidence-bundle-v1',
      artifact_id: generateArtifactId('evidence-bundle-v1'),
      evidence_plan_id: plan.artifact_id,
      intent_context,
      structural_context: {
        files: structuralFiles,
        cross_file_findings,
      },
      raw_evidence: rawEvidence,
      stats,
    };

    await store.put(bundle);

    return {
      status: 'success',
      evidence_bundle_id: bundle.artifact_id,
      message: 'Evidence bundle materialized successfully.',
    };
  } catch (err) {
    return {
      status: 'error',
      evidence_bundle_id: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Structural file builder
// ---------------------------------------------------------------------------

function buildStructuralFile(
  planFile: EvidencePlanFile,
  indexFile: RetrievalFile,
): BundleStructuralFile {
  const ast_skeleton: string[] = planFile.include_ast_skeleton ? [...indexFile.ast_skeleton] : [];

  const file_summary = planFile.include_retriever_summary ? indexFile.file_summary : '';

  const symbols: BundleStructuralSymbol[] = [];
  // Include symbol summaries for spans that are included
  for (const planSpan of planFile.spans) {
    if (!planSpan.include_span) continue;
    const sym = indexFile.symbols.find((s) => s.symbol_id === planSpan.symbol_id);
    if (!sym) {
      throw new SpanResolutionError(
        `Unknown symbol_id "${planSpan.symbol_id}" in file "${planFile.file_id}"`,
      );
    }
    symbols.push({
      name: sym.name,
      start: sym.start,
      count: sym.count,
      summary: sym.summary,
    });
  }

  return {
    path: indexFile.path,
    file_summary,
    ast_skeleton,
    symbols,
  };
}

// ---------------------------------------------------------------------------
// Raw evidence resolver
// ---------------------------------------------------------------------------

interface FileEvidenceResult {
  evidence: BundleRawEvidence[];
  lines: number;
  spans: number;
}

async function resolveFileEvidence(
  planFile: EvidencePlanFile,
  indexFile: RetrievalFile,
  index: RetrievalIndexV1,
  plan: EvidencePlanV1,
): Promise<FileEvidenceResult> {
  const evidence: BundleRawEvidence[] = [];
  let totalLines = 0;
  let spanCount = 0;

  if (planFile.include_entire_file) {
    // Read entire file from disk
    const content = await readFileFromDisk(indexFile.path);
    const lines = content.split('\n');
    evidence.push({
      path: indexFile.path,
      kind: 'full_file',
      label: indexFile.path.split('/').pop() ?? indexFile.path,
      start: 1,
      count: lines.length,
      content,
    });
    totalLines += lines.length;
    spanCount++;
  } else {
    // Raw spans materialize purely from planFile.spans with include_span=true.
    // File-level summary / AST flags do not suppress them, so override ops
    // that change the file mode must also clear spans (see
    // src/conductor/evidence-overrides.ts — set_file_mode and promote_file).
    const enabledSpans = planFile.spans.filter((s) => s.include_span);
    if (enabledSpans.length > 0) {
      let resolved: ResolvedSpan[] = enabledSpans.map((s) => {
        const span = resolveSymbolToSpan(index, planFile.file_id, s.symbol_id);
        return expandNeighborLines(span, s.neighbor_lines);
      });

      if (plan.assembly_options.dedupe_overlapping_spans) {
        resolved = mergeOverlappingSpans(resolved);
      }

      // Read file content for each resolved span
      const fileContent = await readFileFromDisk(indexFile.path);
      const fileLines = fileContent.split('\n');

      for (const span of resolved) {
        const startIdx = span.start - 1; // Convert 1-indexed to 0-indexed
        const endIdx = Math.min(startIdx + span.count, fileLines.length);
        const spanLines = fileLines.slice(startIdx, endIdx);
        const actualCount = spanLines.length;

        // Find the symbol name for labeling
        const matchingSym = indexFile.symbols.find(
          (sym) => sym.start <= span.start && sym.start + sym.count >= span.start,
        );

        evidence.push({
          path: indexFile.path,
          kind: 'span',
          label: matchingSym?.name ?? `lines ${span.start}-${span.start + actualCount - 1}`,
          start: span.start,
          count: actualCount,
          content: spanLines.join('\n'),
        });
        totalLines += actualCount;
        spanCount++;
      }
    }
  }

  return { evidence, lines: totalLines, spans: spanCount };
}

async function readFileFromDisk(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found on disk: ${filePath}`);
  }
  return readFile(filePath, 'utf-8');
}
