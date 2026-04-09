/**
 * Canonical artifact type definitions for pi-orchestra v1.
 *
 * Every artifact shares the `artifact_type` discriminant field and a unique `artifact_id`.
 * Types are derived directly from docs/specification/01-artifacts-and-schemas.md.
 */

// ---------------------------------------------------------------------------
// Artifact type string literals
// ---------------------------------------------------------------------------

export const ARTIFACT_TYPES = [
  'intent-capture-v1',
  'intent-restatement-v1',
  'expansion-input-v1',
  'intent-spec-v1',
  'retrieval-index-v1',
  'evidence-plan-v1',
  'evidence-bundle-v1',
  'analysis-report-v1',
  'change-spec-v1',
  'execution-report-v1',
  'recursive-intent-v1',
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

// ---------------------------------------------------------------------------
// Shared base
// ---------------------------------------------------------------------------

export interface ArtifactBase {
  artifact_type: ArtifactType;
  artifact_id: string;
}

// ---------------------------------------------------------------------------
// 1. intent-capture-v1
// ---------------------------------------------------------------------------

export interface IntentCaptureV1 extends ArtifactBase {
  artifact_type: 'intent-capture-v1';
  user_intent_verbatim: string;
  tagged_files: string[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// 2. intent-restatement-v1
// ---------------------------------------------------------------------------

export interface IntentRestatementV1 extends ArtifactBase {
  artifact_type: 'intent-restatement-v1';
  intent_capture_id: string;
  user_intent_verbatim: string;
  restated_intent: string;
  approved: boolean;
  expand_requested: boolean;
  approval_turns: number;
}

// ---------------------------------------------------------------------------
// 3. expansion-input-v1
// ---------------------------------------------------------------------------

export interface ExpansionIncludedFile {
  path: string;
  reason: string;
}

export interface ExpansionInputV1 extends ArtifactBase {
  artifact_type: 'expansion-input-v1';
  intent_capture_id: string;
  intent_restatement_id: string;
  user_intent_verbatim: string;
  approved_restated_intent: string;
  included_files: ExpansionIncludedFile[];
}

// ---------------------------------------------------------------------------
// 4. intent-spec-v1
// ---------------------------------------------------------------------------

export interface ExpandedSpec {
  objective: string;
  deliverables: string[];
  constraints: string[];
  retrieval_focus: string[];
  open_questions: string[];
}

export interface IntentSpecV1 extends ArtifactBase {
  artifact_type: 'intent-spec-v1';
  expansion_input_id: string;
  user_intent_verbatim: string;
  approved_restated_intent: string;
  expanded_spec: ExpandedSpec;
  approved: boolean;
}

// ---------------------------------------------------------------------------
// 5. retrieval-index-v1
// ---------------------------------------------------------------------------

export interface RetrievalSymbol {
  symbol_id: string;
  kind: string;
  name: string;
  start: number;
  count: number;
  summary: string;
  role_in_system: string;
  depends_on: string[];
  used_by: string[];
  relevance: string;
  change_likelihood: string;
  expansion_priority: string;
  recommended_expansion: string;
  expansion_reason: string;
}

export interface RetrievalFile {
  file_id: string;
  path: string;
  why_relevant: string;
  file_summary: string;
  ast_skeleton: string[];
  recommended_expansion: string;
  expansion_reason: string;
  symbols: RetrievalSymbol[];
}

export interface RetrievalIndexV1 extends ArtifactBase {
  artifact_type: 'retrieval-index-v1';
  intent_capture_id: string;
  intent_restatement_id: string;
  intent_spec_id: string | null;
  query: string;
  confidence: string;
  files: RetrievalFile[];
  cross_file_findings: string[];
  gaps: string[];
  followup_queries: string[];
}

// ---------------------------------------------------------------------------
// 6. evidence-plan-v1
// ---------------------------------------------------------------------------

export interface EvidencePlanSpan {
  symbol_id: string;
  include_span: boolean;
  neighbor_lines: number;
}

export interface EvidencePlanFile {
  file_id: string;
  include_ast_skeleton: boolean;
  include_retriever_summary: boolean;
  include_entire_file: boolean;
  spans: EvidencePlanSpan[];
}

export interface EvidencePlanSelection {
  files: EvidencePlanFile[];
  include_cross_file_findings: boolean;
  include_gaps: boolean;
  include_followup_queries: boolean;
}

export interface AssemblyOptions {
  max_total_lines: number;
  max_estimated_tokens: number;
  dedupe_overlapping_spans: boolean;
  span_merge_strategy: string;
}

export interface PromptSections {
  include_intent_context: boolean;
  include_structural_context: boolean;
  include_raw_evidence: boolean;
}

export interface TargetTask {
  type: string;
  task_label: string;
}

export interface EvidencePlanV1 extends ArtifactBase {
  artifact_type: 'evidence-plan-v1';
  retrieval_index: {
    artifact_type: 'retrieval-index-v1';
    artifact_id: string;
  };
  selection: EvidencePlanSelection;
  assembly_options: AssemblyOptions;
  prompt_sections: PromptSections;
  target_task: TargetTask;
}

// ---------------------------------------------------------------------------
// 7. evidence-bundle-v1
// ---------------------------------------------------------------------------

export interface BundleStructuralSymbol {
  name: string;
  start: number;
  count: number;
  summary: string;
}

export interface BundleStructuralFile {
  path: string;
  file_summary: string;
  ast_skeleton: string[];
  symbols: BundleStructuralSymbol[];
}

export interface BundleRawEvidence {
  path: string;
  kind: string;
  label: string;
  start: number;
  count: number;
  content: string;
}

export interface BundleStats {
  files: number;
  spans: number;
  full_files: number;
  total_lines: number;
  estimated_tokens: number;
}

export interface EvidenceBundleV1 extends ArtifactBase {
  artifact_type: 'evidence-bundle-v1';
  evidence_plan_id: string;
  intent_context: {
    user_intent_verbatim: string;
    approved_restated_intent: string;
    intent_spec_id: string | null;
  };
  structural_context: {
    files: BundleStructuralFile[];
    cross_file_findings: string[];
  };
  raw_evidence: BundleRawEvidence[];
  stats: BundleStats;
}

// ---------------------------------------------------------------------------
// 8. analysis-report-v1
// ---------------------------------------------------------------------------

export interface AnalysisReportV1 extends ArtifactBase {
  artifact_type: 'analysis-report-v1';
  evidence_bundle_id: string;
  summary: string;
  findings: string[];
  risks: string[];
  recommended_next_steps: string[];
}

// ---------------------------------------------------------------------------
// 9. change-spec-v1
// ---------------------------------------------------------------------------

export interface ChangeSpecEdit {
  path: string;
  target: {
    kind: string;
    name: string;
    start: number;
    count: number;
  };
  intent: string;
  required_changes: string[];
  constraints: string[];
}

export interface ChangeSpecV1 extends ArtifactBase {
  artifact_type: 'change-spec-v1';
  evidence_bundle_id: string;
  change_goal: string;
  summary: string;
  edits: ChangeSpecEdit[];
  tests: string[];
  acceptance_criteria: string[];
}

// ---------------------------------------------------------------------------
// 10. execution-report-v1
// ---------------------------------------------------------------------------

export interface ExecutionReportV1 extends ArtifactBase {
  artifact_type: 'execution-report-v1';
  change_spec_id: string;
  status: string;
  modified_files: string[];
  validation: {
    commands: string[];
    passed: boolean;
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// 11. recursive-intent-v1
// ---------------------------------------------------------------------------

export interface RecursiveIntentV1 extends ArtifactBase {
  artifact_type: 'recursive-intent-v1';
  source_artifact_type: string;
  source_artifact_id: string;
  new_user_intent_verbatim: string;
  restart_stage: number;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type Artifact =
  | IntentCaptureV1
  | IntentRestatementV1
  | ExpansionInputV1
  | IntentSpecV1
  | RetrievalIndexV1
  | EvidencePlanV1
  | EvidenceBundleV1
  | AnalysisReportV1
  | ChangeSpecV1
  | ExecutionReportV1
  | RecursiveIntentV1;

// ---------------------------------------------------------------------------
// Typed lookup helper
// ---------------------------------------------------------------------------

export type ArtifactOfType<T extends ArtifactType> = Extract<Artifact, { artifact_type: T }>;
