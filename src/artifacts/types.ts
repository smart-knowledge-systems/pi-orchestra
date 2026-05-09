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
  'piorx/intent-capture@1',
  'piorx/intent-restatement@1',
  'piorx/expansion-input@1',
  'piorx/intent-spec@1',
  'piorx/retrieval-index@1',
  'piorx/evidence-plan@1',
  'piorx/evidence-bundle@1',
  'piorx/analysis-report@1',
  'piorx/change-spec@1',
  'piorx/execution-report@1',
  'piorx/recursive-intent@1',
  'piorx/workflow-spec@1',
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

export type IntentFileRefSource = 'inline' | 'reference-only' | 'disk';

export interface IntentFileRef {
  path: string;
  source: IntentFileRefSource;
}

export interface IntentCaptureV1 extends ArtifactBase {
  artifact_type: 'piorx/intent-capture@1';
  user_intent_verbatim: string;
  cleaned_user_intent: string;
  tagged_files: string[];
  intent_file_refs?: IntentFileRef[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// 2. intent-restatement-v1
// ---------------------------------------------------------------------------

export interface IntentRestatementV1 extends ArtifactBase {
  artifact_type: 'piorx/intent-restatement@1';
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
  artifact_type: 'piorx/expansion-input@1';
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
  artifact_type: 'piorx/intent-spec@1';
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
  selected_by_default: boolean;
  default_neighbor_lines: number;
  selection_reason: string;
}

export type RetrievalSelectionTier = 'selected' | 'reserve';

export type RetrievalDefaultEvidenceMode =
  | 'exclude'
  | 'summary'
  | 'summary+ast'
  | 'spans'
  | 'whole_file';

export interface RetrievalFile {
  file_id: string;
  path: string;
  why_relevant: string;
  file_summary: string;
  ast_skeleton: string[];
  recommended_expansion: string;
  expansion_reason: string;
  selection_tier: RetrievalSelectionTier;
  selection_reason: string;
  default_evidence_mode: RetrievalDefaultEvidenceMode;
  symbols: RetrievalSymbol[];
}

export interface RecommendedEvidenceSpan {
  symbol_id: string;
  include_span: boolean;
  neighbor_lines: number;
}

export interface RecommendedEvidenceFile {
  file_id: string;
  include_ast_skeleton: boolean;
  include_retriever_summary: boolean;
  include_entire_file: boolean;
  spans: RecommendedEvidenceSpan[];
}

export interface RetrievalRecommendedEvidence {
  files: RecommendedEvidenceFile[];
  include_cross_file_findings: boolean;
  include_gaps: boolean;
  include_followup_queries: boolean;
}

export interface RetrievalIndexV1 extends ArtifactBase {
  artifact_type: 'piorx/retrieval-index@1';
  intent_capture_id: string;
  intent_restatement_id: string;
  intent_spec_id: string | null;
  query: string;
  confidence: string;
  strategy_summary: string;
  scout_terms: string[];
  files: RetrievalFile[];
  cross_file_findings: string[];
  gaps: string[];
  followup_queries: string[];
  recommended_evidence: RetrievalRecommendedEvidence;
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
  artifact_type: 'piorx/evidence-plan@1';
  retrieval_index: {
    artifact_type: 'piorx/retrieval-index@1';
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
  artifact_type: 'piorx/evidence-bundle@1';
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
  artifact_type: 'piorx/analysis-report@1';
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
  artifact_type: 'piorx/change-spec@1';
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
  artifact_type: 'piorx/execution-report@1';
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
  artifact_type: 'piorx/recursive-intent@1';
  source_artifact_type: string;
  source_artifact_id: string;
  new_user_intent_verbatim: string;
  restart_stage: number;
}

// ---------------------------------------------------------------------------
// 12. workflow-spec-v1
// ---------------------------------------------------------------------------

export type WorkflowOperatingMode = 'advisory' | 'supervised-change' | 'constrained-autonomous';

export const WORKFLOW_OPERATING_MODES: readonly WorkflowOperatingMode[] = [
  'advisory',
  'supervised-change',
  'constrained-autonomous',
] as const;

export type WorkflowStageFailureHandling = 'retry' | 'tentative' | 'halt' | 'escalate';

export const WORKFLOW_STAGE_FAILURE_HANDLINGS: readonly WorkflowStageFailureHandling[] = [
  'retry',
  'tentative',
  'halt',
  'escalate',
] as const;

export interface WorkflowStageControl {
  entry_criteria?: string;
  exit_criteria?: string;
  acceptance_criteria?: string;
  failure_handling?: WorkflowStageFailureHandling;
  evidence_requirements?: string[];
}

export interface WorkflowStageSpec {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  output: string;
  model_class: string;
  gates?: string[];
  control?: WorkflowStageControl;
  workflow_ref?: string;
  workflow?: WorkflowSpecBody;
}

export interface WorkflowEdgeSpec {
  from: string;
  to: string;
  description: string;
  when?: Record<string, unknown>;
}

export interface WorkflowGovernance {
  evidence_requirements?: string[];
  version_pinning?: string;
  [key: string]: unknown;
}

export interface WorkflowStageOverride {
  name?: string;
  description?: string;
  inputs?: string[];
  output?: string;
  model_class?: string;
  gates?: string[];
  control?: WorkflowStageControl;
  workflow_ref?: string;
  workflow?: WorkflowSpecBody;
}

/**
 * The shape of a workflow definition without the artifact-base fields.
 *
 * Used for inline sub-workflows nested inside a `WorkflowStageSpec.workflow`
 * field, where the surrounding artifact already carries `artifact_type` and
 * `artifact_id`.
 */
export interface WorkflowSpecBody {
  id: string;
  name: string;
  description: string;
  goals: string[];
  operating_mode: WorkflowOperatingMode;
  mandatory_controls: string[];
  stages: WorkflowStageSpec[];
  edges: WorkflowEdgeSpec[];
  recursive_promotion_target: string;
  governance?: WorkflowGovernance;
  extends?: string;
  stage_overrides?: Record<string, WorkflowStageOverride>;
}

export interface WorkflowSpecV1 extends ArtifactBase, WorkflowSpecBody {
  artifact_type: 'piorx/workflow-spec@1';
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
  | RecursiveIntentV1
  | WorkflowSpecV1;

// ---------------------------------------------------------------------------
// Typed lookup helper
// ---------------------------------------------------------------------------

export type ArtifactOfType<T extends ArtifactType> = Extract<Artifact, { artifact_type: T }>;
