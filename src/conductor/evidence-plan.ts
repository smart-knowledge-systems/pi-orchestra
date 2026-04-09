/**
 * Evidence plan authoring helpers for the conductor.
 *
 * Produces a valid evidence-plan-v1 from a retrieval-index-v1. The plan embeds
 * the full retrieval index unchanged and declares per-file inclusion controls,
 * cross-file/gap/followup selections, and assembly_options.
 */

import type {
  RetrievalIndexV1,
  EvidencePlanV1,
  EvidencePlanFile,
  EvidencePlanSpan,
  EvidencePlanSelection,
  AssemblyOptions,
  PromptSections,
  TargetTask,
} from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';

// ---------------------------------------------------------------------------
// Per-file inclusion control input
// ---------------------------------------------------------------------------

export interface FileInclusionControl {
  file_id: string;
  include_ast_skeleton?: boolean;
  include_retriever_summary?: boolean;
  include_entire_file?: boolean;
  spans?: Array<{
    symbol_id: string;
    include_span?: boolean;
    neighbor_lines?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Plan creation options
// ---------------------------------------------------------------------------

export interface CreateEvidencePlanOptions {
  /** The full retrieval index to embed unchanged. */
  retrieval_index: RetrievalIndexV1;

  /** Per-file inclusion controls. Files not listed default to summary-only. */
  file_controls?: FileInclusionControl[];

  /** Whether to include cross-file findings in the plan. Default: true. */
  include_cross_file_findings?: boolean;
  /** Whether to include gaps. Default: false. */
  include_gaps?: boolean;
  /** Whether to include followup queries. Default: false. */
  include_followup_queries?: boolean;

  /** Assembly options override. Sensible defaults are applied if omitted. */
  assembly_options?: Partial<AssemblyOptions>;

  /** Prompt section toggles. Default: all true. */
  prompt_sections?: Partial<PromptSections>;

  /** Target task metadata. Default: analysis-report. */
  target_task?: Partial<TargetTask>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ASSEMBLY_OPTIONS: AssemblyOptions = {
  max_total_lines: 2000,
  max_estimated_tokens: 20000,
  dedupe_overlapping_spans: true,
  span_merge_strategy: 'merge_if_overlapping',
};

const DEFAULT_PROMPT_SECTIONS: PromptSections = {
  include_intent_context: true,
  include_structural_context: true,
  include_raw_evidence: true,
};

const DEFAULT_TARGET_TASK: TargetTask = {
  type: 'analysis-report',
  task_label: 'analyze codebase',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an EvidencePlanFile from a FileInclusionControl, defaulting to
 * summary-only if no controls are specified for the file.
 */
function buildPlanFile(index: RetrievalIndexV1, control: FileInclusionControl): EvidencePlanFile {
  // Validate file_id exists in the index
  const indexFile = index.files.find((f) => f.file_id === control.file_id);
  if (!indexFile) {
    throw new Error(`Unknown file_id in plan controls: ${control.file_id}`);
  }

  const spans: EvidencePlanSpan[] = (control.spans ?? []).map((s) => {
    // Validate symbol_id exists
    const sym = indexFile.symbols.find((sym) => sym.symbol_id === s.symbol_id);
    if (!sym) {
      throw new Error(`Unknown symbol_id "${s.symbol_id}" for file "${control.file_id}"`);
    }
    return {
      symbol_id: s.symbol_id,
      include_span: s.include_span ?? true,
      neighbor_lines: s.neighbor_lines ?? 0,
    };
  });

  return {
    file_id: control.file_id,
    include_ast_skeleton: control.include_ast_skeleton ?? false,
    include_retriever_summary: control.include_retriever_summary ?? true,
    include_entire_file: control.include_entire_file ?? false,
    spans,
  };
}

/**
 * Build a default summary-only plan file for an index file that has no
 * explicit controls.
 */
function defaultPlanFile(fileId: string): EvidencePlanFile {
  return {
    file_id: fileId,
    include_ast_skeleton: false,
    include_retriever_summary: true,
    include_entire_file: false,
    spans: [],
  };
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Create a valid evidence-plan-v1 from a retrieval-index-v1.
 *
 * The retrieval index is embedded as-is (byte-equal to the source).
 * Per-file inclusion controls, cross-file/gap/followup selections,
 * and assembly_options are declared by the caller.
 */
export function createEvidencePlan(options: CreateEvidencePlanOptions): EvidencePlanV1 {
  const { retrieval_index } = options;

  // Build file controls: merge explicit controls with defaults for unlisted files
  const controlMap = new Map<string, FileInclusionControl>();
  for (const fc of options.file_controls ?? []) {
    // Validate that the file_id exists in the index
    if (!retrieval_index.files.some((f) => f.file_id === fc.file_id)) {
      throw new Error(`Unknown file_id in plan controls: ${fc.file_id}`);
    }
    controlMap.set(fc.file_id, fc);
  }

  const planFiles: EvidencePlanFile[] = retrieval_index.files.map((indexFile) => {
    const control = controlMap.get(indexFile.file_id);
    if (control) {
      return buildPlanFile(retrieval_index, control);
    }
    return defaultPlanFile(indexFile.file_id);
  });

  const selection: EvidencePlanSelection = {
    files: planFiles,
    include_cross_file_findings: options.include_cross_file_findings ?? true,
    include_gaps: options.include_gaps ?? false,
    include_followup_queries: options.include_followup_queries ?? false,
  };

  const assembly_options: AssemblyOptions = {
    ...DEFAULT_ASSEMBLY_OPTIONS,
    ...options.assembly_options,
  };

  const prompt_sections: PromptSections = {
    ...DEFAULT_PROMPT_SECTIONS,
    ...options.prompt_sections,
  };

  const target_task: TargetTask = {
    ...DEFAULT_TARGET_TASK,
    ...options.target_task,
  };

  return {
    artifact_type: 'evidence-plan-v1',
    artifact_id: generateArtifactId('evidence-plan-v1'),
    retrieval_index: {
      artifact_type: 'retrieval-index-v1',
      artifact_id: retrieval_index.artifact_id,
    },
    selection,
    assembly_options,
    prompt_sections,
    target_task,
  };
}

/**
 * Verify that the plan's embedded retrieval index reference matches the
 * stored retrieval index exactly (byte-equal check on artifact_id and type).
 */
export function verifyEmbeddedIndex(plan: EvidencePlanV1, storedIndex: RetrievalIndexV1): boolean {
  return (
    plan.retrieval_index.artifact_type === storedIndex.artifact_type &&
    plan.retrieval_index.artifact_id === storedIndex.artifact_id
  );
}
