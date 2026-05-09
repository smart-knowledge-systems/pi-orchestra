/**
 * Runtime schema validators for all v1 artifact types.
 *
 * Each validator checks the shape of a plain object and returns a structured
 * result with field-level error messages on failure.
 */

import type { ArtifactType, Artifact } from './types.ts';
import { ARTIFACT_TYPES } from './types.ts';

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

function checkString(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (typeof obj[field] !== 'string') {
    errors.push(`${field} must be a string`);
  }
}

function checkBoolean(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (typeof obj[field] !== 'boolean') {
    errors.push(`${field} must be a boolean`);
  }
}

function checkNumber(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (typeof obj[field] !== 'number') {
    errors.push(`${field} must be a number`);
  }
}

function checkStringArray(obj: Record<string, unknown>, field: string, errors: string[]): void {
  const val = obj[field];
  if (!Array.isArray(val)) {
    errors.push(`${field} must be an array`);
    return;
  }
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== 'string') {
      errors.push(`${field}[${i}] must be a string`);
    }
  }
}

function checkArray(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (!Array.isArray(obj[field])) {
    errors.push(`${field} must be an array`);
  }
}

function checkObject(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (typeof obj[field] !== 'object' || obj[field] === null || Array.isArray(obj[field])) {
    errors.push(`${field} must be an object`);
  }
}

function checkNullableString(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (obj[field] !== null && typeof obj[field] !== 'string') {
    errors.push(`${field} must be a string or null`);
  }
}

// ---------------------------------------------------------------------------
// Common base check
// ---------------------------------------------------------------------------

function checkBase(
  obj: Record<string, unknown>,
  expectedType: ArtifactType,
  errors: string[],
): void {
  if (obj.artifact_type !== expectedType) {
    errors.push(`artifact_type must be "${expectedType}"`);
  }
  checkString(obj, 'artifact_id', errors);
}

// ---------------------------------------------------------------------------
// Per-type validators
// ---------------------------------------------------------------------------

const INTENT_FILE_REF_SOURCES = ['inline', 'reference-only', 'disk'] as const;

function validateIntentCapture(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/intent-capture@1', errors);
  checkString(obj, 'user_intent_verbatim', errors);
  checkString(obj, 'cleaned_user_intent', errors);
  checkStringArray(obj, 'tagged_files', errors);
  checkString(obj, 'timestamp', errors);
  if (obj.intent_file_refs !== undefined) {
    if (!Array.isArray(obj.intent_file_refs)) {
      errors.push('intent_file_refs must be an array');
    } else {
      for (let i = 0; i < obj.intent_file_refs.length; i++) {
        const ref = obj.intent_file_refs[i];
        if (typeof ref !== 'object' || ref === null) {
          errors.push(`intent_file_refs[${i}] must be an object`);
          continue;
        }
        const r = ref as Record<string, unknown>;
        if (typeof r.path !== 'string') {
          errors.push(`intent_file_refs[${i}].path must be a string`);
        }
        if (
          typeof r.source !== 'string' ||
          !INTENT_FILE_REF_SOURCES.includes(r.source as (typeof INTENT_FILE_REF_SOURCES)[number])
        ) {
          errors.push(
            `intent_file_refs[${i}].source must be one of ${INTENT_FILE_REF_SOURCES.join(', ')}`,
          );
        }
      }
    }
  }
  return errors.length ? fail(errors) : ok();
}

function validateIntentRestatement(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/intent-restatement@1', errors);
  checkString(obj, 'intent_capture_id', errors);
  checkString(obj, 'user_intent_verbatim', errors);
  checkString(obj, 'restated_intent', errors);
  checkBoolean(obj, 'approved', errors);
  checkBoolean(obj, 'expand_requested', errors);
  checkNumber(obj, 'approval_turns', errors);
  return errors.length ? fail(errors) : ok();
}

function validateExpansionInput(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/expansion-input@1', errors);
  checkString(obj, 'intent_capture_id', errors);
  checkString(obj, 'intent_restatement_id', errors);
  checkString(obj, 'user_intent_verbatim', errors);
  checkString(obj, 'approved_restated_intent', errors);
  checkArray(obj, 'included_files', errors);
  if (Array.isArray(obj.included_files)) {
    for (let i = 0; i < (obj.included_files as unknown[]).length; i++) {
      const f = (obj.included_files as Record<string, unknown>[])[i];
      if (typeof f !== 'object' || f === null) {
        errors.push(`included_files[${i}] must be an object`);
        continue;
      }
      if (typeof f.path !== 'string') errors.push(`included_files[${i}].path must be a string`);
      if (typeof f.reason !== 'string') errors.push(`included_files[${i}].reason must be a string`);
    }
  }
  return errors.length ? fail(errors) : ok();
}

function validateIntentSpec(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/intent-spec@1', errors);
  checkString(obj, 'expansion_input_id', errors);
  checkString(obj, 'user_intent_verbatim', errors);
  checkString(obj, 'approved_restated_intent', errors);
  checkBoolean(obj, 'approved', errors);
  checkObject(obj, 'expanded_spec', errors);
  if (typeof obj.expanded_spec === 'object' && obj.expanded_spec !== null) {
    const spec = obj.expanded_spec as Record<string, unknown>;
    checkString(spec, 'objective', errors);
    checkStringArray(spec, 'deliverables', errors);
    checkStringArray(spec, 'constraints', errors);
    checkStringArray(spec, 'retrieval_focus', errors);
    checkStringArray(spec, 'open_questions', errors);
  }
  return errors.length ? fail(errors) : ok();
}

const RETRIEVAL_SELECTION_TIERS = ['selected', 'reserve'] as const;
const RETRIEVAL_DEFAULT_EVIDENCE_MODES = [
  'exclude',
  'summary',
  'summary+ast',
  'spans',
  'whole_file',
] as const;

function validateRetrievalSymbol(
  sym: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof sym.selected_by_default !== 'boolean') {
    errors.push(`${path}.selected_by_default must be a boolean`);
  }
  if (typeof sym.default_neighbor_lines !== 'number') {
    errors.push(`${path}.default_neighbor_lines must be a number`);
  }
  if (typeof sym.selection_reason !== 'string') {
    errors.push(`${path}.selection_reason must be a string`);
  }
}

function validateRetrievalFile(
  file: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (
    typeof file.selection_tier !== 'string' ||
    !RETRIEVAL_SELECTION_TIERS.includes(
      file.selection_tier as (typeof RETRIEVAL_SELECTION_TIERS)[number],
    )
  ) {
    errors.push(`${path}.selection_tier must be one of ${RETRIEVAL_SELECTION_TIERS.join(', ')}`);
  }
  if (typeof file.selection_reason !== 'string') {
    errors.push(`${path}.selection_reason must be a string`);
  }
  if (
    typeof file.default_evidence_mode !== 'string' ||
    !RETRIEVAL_DEFAULT_EVIDENCE_MODES.includes(
      file.default_evidence_mode as (typeof RETRIEVAL_DEFAULT_EVIDENCE_MODES)[number],
    )
  ) {
    errors.push(
      `${path}.default_evidence_mode must be one of ${RETRIEVAL_DEFAULT_EVIDENCE_MODES.join(', ')}`,
    );
  }
  if (Array.isArray(file.symbols)) {
    for (let i = 0; i < file.symbols.length; i++) {
      const sym = file.symbols[i];
      if (typeof sym === 'object' && sym !== null) {
        validateRetrievalSymbol(sym as Record<string, unknown>, `${path}.symbols[${i}]`, errors);
      }
    }
  }
}

function validateRecommendedEvidence(rec: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(rec.files)) {
    errors.push('recommended_evidence.files must be an array');
  } else {
    for (let i = 0; i < rec.files.length; i++) {
      const f = rec.files[i];
      const fp = `recommended_evidence.files[${i}]`;
      if (typeof f !== 'object' || f === null) {
        errors.push(`${fp} must be an object`);
        continue;
      }
      const fr = f as Record<string, unknown>;
      if (typeof fr.file_id !== 'string') errors.push(`${fp}.file_id must be a string`);
      if (typeof fr.include_ast_skeleton !== 'boolean') {
        errors.push(`${fp}.include_ast_skeleton must be a boolean`);
      }
      if (typeof fr.include_retriever_summary !== 'boolean') {
        errors.push(`${fp}.include_retriever_summary must be a boolean`);
      }
      if (typeof fr.include_entire_file !== 'boolean') {
        errors.push(`${fp}.include_entire_file must be a boolean`);
      }
      if (!Array.isArray(fr.spans)) {
        errors.push(`${fp}.spans must be an array`);
      } else {
        for (let j = 0; j < fr.spans.length; j++) {
          const sp = fr.spans[j];
          const spp = `${fp}.spans[${j}]`;
          if (typeof sp !== 'object' || sp === null) {
            errors.push(`${spp} must be an object`);
            continue;
          }
          const spr = sp as Record<string, unknown>;
          if (typeof spr.symbol_id !== 'string') errors.push(`${spp}.symbol_id must be a string`);
          if (typeof spr.include_span !== 'boolean') {
            errors.push(`${spp}.include_span must be a boolean`);
          }
          if (typeof spr.neighbor_lines !== 'number') {
            errors.push(`${spp}.neighbor_lines must be a number`);
          }
        }
      }
    }
  }
  if (typeof rec.include_cross_file_findings !== 'boolean') {
    errors.push('recommended_evidence.include_cross_file_findings must be a boolean');
  }
  if (typeof rec.include_gaps !== 'boolean') {
    errors.push('recommended_evidence.include_gaps must be a boolean');
  }
  if (typeof rec.include_followup_queries !== 'boolean') {
    errors.push('recommended_evidence.include_followup_queries must be a boolean');
  }
}

function validateRetrievalIndex(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/retrieval-index@1', errors);
  checkString(obj, 'intent_capture_id', errors);
  checkString(obj, 'intent_restatement_id', errors);
  checkNullableString(obj, 'intent_spec_id', errors);
  checkString(obj, 'query', errors);
  checkString(obj, 'confidence', errors);
  checkString(obj, 'strategy_summary', errors);
  checkStringArray(obj, 'scout_terms', errors);
  checkArray(obj, 'files', errors);
  if (Array.isArray(obj.files)) {
    for (let i = 0; i < obj.files.length; i++) {
      const f = obj.files[i];
      if (typeof f === 'object' && f !== null) {
        validateRetrievalFile(f as Record<string, unknown>, `files[${i}]`, errors);
      }
    }
  }
  checkStringArray(obj, 'cross_file_findings', errors);
  checkStringArray(obj, 'gaps', errors);
  checkStringArray(obj, 'followup_queries', errors);
  checkObject(obj, 'recommended_evidence', errors);
  if (typeof obj.recommended_evidence === 'object' && obj.recommended_evidence !== null) {
    validateRecommendedEvidence(obj.recommended_evidence as Record<string, unknown>, errors);
  }
  return errors.length ? fail(errors) : ok();
}

function validateEvidencePlan(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/evidence-plan@1', errors);
  checkObject(obj, 'retrieval_index', errors);
  if (typeof obj.retrieval_index === 'object' && obj.retrieval_index !== null) {
    const ri = obj.retrieval_index as Record<string, unknown>;
    if (ri.artifact_type !== 'piorx/retrieval-index@1') {
      errors.push('retrieval_index.artifact_type must be "piorx/retrieval-index@1"');
    }
    checkString(ri, 'artifact_id', errors);
  }
  checkObject(obj, 'selection', errors);
  checkObject(obj, 'assembly_options', errors);
  checkObject(obj, 'prompt_sections', errors);
  checkObject(obj, 'target_task', errors);
  return errors.length ? fail(errors) : ok();
}

function validateEvidenceBundle(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/evidence-bundle@1', errors);
  checkString(obj, 'evidence_plan_id', errors);
  checkObject(obj, 'intent_context', errors);
  checkObject(obj, 'structural_context', errors);
  checkArray(obj, 'raw_evidence', errors);
  checkObject(obj, 'stats', errors);
  return errors.length ? fail(errors) : ok();
}

function validateAnalysisReport(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/analysis-report@1', errors);
  checkString(obj, 'evidence_bundle_id', errors);
  checkString(obj, 'summary', errors);
  checkStringArray(obj, 'findings', errors);
  checkStringArray(obj, 'risks', errors);
  checkStringArray(obj, 'recommended_next_steps', errors);
  return errors.length ? fail(errors) : ok();
}

function validateChangeSpec(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/change-spec@1', errors);
  checkString(obj, 'evidence_bundle_id', errors);
  checkString(obj, 'change_goal', errors);
  checkString(obj, 'summary', errors);
  checkArray(obj, 'edits', errors);
  checkStringArray(obj, 'tests', errors);
  checkStringArray(obj, 'acceptance_criteria', errors);
  return errors.length ? fail(errors) : ok();
}

function validateExecutionReport(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/execution-report@1', errors);
  checkString(obj, 'change_spec_id', errors);
  checkString(obj, 'status', errors);
  checkStringArray(obj, 'modified_files', errors);
  checkObject(obj, 'validation', errors);
  if (typeof obj.validation === 'object' && obj.validation !== null) {
    const v = obj.validation as Record<string, unknown>;
    checkStringArray(v, 'commands', errors);
    checkBoolean(v, 'passed', errors);
  }
  checkStringArray(obj, 'notes', errors);
  return errors.length ? fail(errors) : ok();
}

function validateRecursiveIntent(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/recursive-intent@1', errors);
  checkString(obj, 'source_artifact_type', errors);
  checkString(obj, 'source_artifact_id', errors);
  checkString(obj, 'new_user_intent_verbatim', errors);
  checkNumber(obj, 'restart_stage', errors);
  return errors.length ? fail(errors) : ok();
}

// ---------------------------------------------------------------------------
// WorkflowSpec — structural validator only.
// ---------------------------------------------------------------------------
//
// Referential checks (every stage id has a matching Stage implementation,
// every input/output is a known artifact_type, every gate id is registered,
// every `extends` parent resolves, sub-workflow operating_mode <= parent's,
// mandatory_controls propagate additively, no cycles, depth cap) layer on
// top of this validator inside `WorkflowRegistry` at boot time. Anything
// that requires a populated registry MUST stay out of this file.

const WORKFLOW_OPERATING_MODES_LOCAL = [
  'advisory',
  'supervised-change',
  'constrained-autonomous',
] as const;

const WORKFLOW_STAGE_FAILURE_HANDLINGS_LOCAL = ['retry', 'tentative', 'halt', 'escalate'] as const;

function validateWorkflowStageControl(
  ctrl: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (ctrl.entry_criteria !== undefined && typeof ctrl.entry_criteria !== 'string') {
    errors.push(`${path}.entry_criteria must be a string`);
  }
  if (ctrl.exit_criteria !== undefined && typeof ctrl.exit_criteria !== 'string') {
    errors.push(`${path}.exit_criteria must be a string`);
  }
  if (ctrl.acceptance_criteria !== undefined && typeof ctrl.acceptance_criteria !== 'string') {
    errors.push(`${path}.acceptance_criteria must be a string`);
  }
  if (ctrl.failure_handling !== undefined) {
    if (
      typeof ctrl.failure_handling !== 'string' ||
      !WORKFLOW_STAGE_FAILURE_HANDLINGS_LOCAL.includes(
        ctrl.failure_handling as (typeof WORKFLOW_STAGE_FAILURE_HANDLINGS_LOCAL)[number],
      )
    ) {
      errors.push(
        `${path}.failure_handling must be one of ${WORKFLOW_STAGE_FAILURE_HANDLINGS_LOCAL.join(', ')}`,
      );
    }
  }
  if (ctrl.evidence_requirements !== undefined) {
    if (!Array.isArray(ctrl.evidence_requirements)) {
      errors.push(`${path}.evidence_requirements must be an array`);
    } else {
      for (let i = 0; i < ctrl.evidence_requirements.length; i++) {
        if (typeof ctrl.evidence_requirements[i] !== 'string') {
          errors.push(`${path}.evidence_requirements[${i}] must be a string`);
        }
      }
    }
  }
}

function validateWorkflowStage(
  stage: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof stage.id !== 'string') errors.push(`${path}.id must be a string`);
  if (typeof stage.name !== 'string') errors.push(`${path}.name must be a string`);
  if (typeof stage.description !== 'string') errors.push(`${path}.description must be a string`);
  if (!Array.isArray(stage.inputs)) {
    errors.push(`${path}.inputs must be an array`);
  } else {
    for (let i = 0; i < stage.inputs.length; i++) {
      if (typeof stage.inputs[i] !== 'string') {
        errors.push(`${path}.inputs[${i}] must be a string`);
      }
    }
  }
  if (typeof stage.output !== 'string') errors.push(`${path}.output must be a string`);
  if (typeof stage.model_class !== 'string') errors.push(`${path}.model_class must be a string`);
  if (stage.gates !== undefined) {
    if (!Array.isArray(stage.gates)) {
      errors.push(`${path}.gates must be an array`);
    } else {
      for (let i = 0; i < stage.gates.length; i++) {
        if (typeof stage.gates[i] !== 'string') {
          errors.push(`${path}.gates[${i}] must be a string`);
        }
      }
    }
  }
  if (stage.control !== undefined) {
    if (
      typeof stage.control !== 'object' ||
      stage.control === null ||
      Array.isArray(stage.control)
    ) {
      errors.push(`${path}.control must be an object`);
    } else {
      validateWorkflowStageControl(
        stage.control as Record<string, unknown>,
        `${path}.control`,
        errors,
      );
    }
  }
  if (stage.workflow_ref !== undefined && typeof stage.workflow_ref !== 'string') {
    errors.push(`${path}.workflow_ref must be a string`);
  }
  if (stage.workflow !== undefined) {
    if (
      typeof stage.workflow !== 'object' ||
      stage.workflow === null ||
      Array.isArray(stage.workflow)
    ) {
      errors.push(`${path}.workflow must be an object`);
    } else {
      validateWorkflowSpecBody(
        stage.workflow as Record<string, unknown>,
        `${path}.workflow`,
        errors,
      );
    }
  }
  if (stage.workflow_ref !== undefined && stage.workflow !== undefined) {
    errors.push(`${path} cannot declare both workflow_ref and inline workflow`);
  }
}

function validateWorkflowEdge(edge: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof edge.from !== 'string') errors.push(`${path}.from must be a string`);
  if (typeof edge.to !== 'string') errors.push(`${path}.to must be a string`);
  if (typeof edge.description !== 'string') errors.push(`${path}.description must be a string`);
  if (edge.when !== undefined) {
    if (typeof edge.when !== 'object' || edge.when === null || Array.isArray(edge.when)) {
      errors.push(`${path}.when must be an object`);
    }
  }
}

function validateWorkflowGovernance(
  gov: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (gov.evidence_requirements !== undefined) {
    if (!Array.isArray(gov.evidence_requirements)) {
      errors.push(`${path}.evidence_requirements must be an array`);
    } else {
      for (let i = 0; i < gov.evidence_requirements.length; i++) {
        if (typeof gov.evidence_requirements[i] !== 'string') {
          errors.push(`${path}.evidence_requirements[${i}] must be a string`);
        }
      }
    }
  }
  if (gov.version_pinning !== undefined && typeof gov.version_pinning !== 'string') {
    errors.push(`${path}.version_pinning must be a string`);
  }
}

function validateWorkflowStageOverrides(
  overrides: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  for (const [stageId, override] of Object.entries(overrides)) {
    const op = `${path}.${stageId}`;
    if (typeof override !== 'object' || override === null || Array.isArray(override)) {
      errors.push(`${op} must be an object`);
      continue;
    }
    const o = override as Record<string, unknown>;
    if (o.name !== undefined && typeof o.name !== 'string')
      errors.push(`${op}.name must be a string`);
    if (o.description !== undefined && typeof o.description !== 'string') {
      errors.push(`${op}.description must be a string`);
    }
    if (o.inputs !== undefined) {
      if (!Array.isArray(o.inputs)) {
        errors.push(`${op}.inputs must be an array`);
      } else {
        for (let i = 0; i < o.inputs.length; i++) {
          if (typeof o.inputs[i] !== 'string') errors.push(`${op}.inputs[${i}] must be a string`);
        }
      }
    }
    if (o.output !== undefined && typeof o.output !== 'string') {
      errors.push(`${op}.output must be a string`);
    }
    if (o.model_class !== undefined && typeof o.model_class !== 'string') {
      errors.push(`${op}.model_class must be a string`);
    }
    if (o.gates !== undefined) {
      if (!Array.isArray(o.gates)) {
        errors.push(`${op}.gates must be an array`);
      } else {
        for (let i = 0; i < o.gates.length; i++) {
          if (typeof o.gates[i] !== 'string') errors.push(`${op}.gates[${i}] must be a string`);
        }
      }
    }
    if (o.control !== undefined) {
      if (typeof o.control !== 'object' || o.control === null || Array.isArray(o.control)) {
        errors.push(`${op}.control must be an object`);
      } else {
        validateWorkflowStageControl(o.control as Record<string, unknown>, `${op}.control`, errors);
      }
    }
    if (o.workflow_ref !== undefined && typeof o.workflow_ref !== 'string') {
      errors.push(`${op}.workflow_ref must be a string`);
    }
    if (o.workflow !== undefined) {
      if (typeof o.workflow !== 'object' || o.workflow === null || Array.isArray(o.workflow)) {
        errors.push(`${op}.workflow must be an object`);
      } else {
        validateWorkflowSpecBody(o.workflow as Record<string, unknown>, `${op}.workflow`, errors);
      }
    }
  }
}

function validateWorkflowSpecBody(
  body: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const prefix = path ? `${path}.` : '';
  if (typeof body.id !== 'string') errors.push(`${prefix}id must be a string`);
  if (typeof body.name !== 'string') errors.push(`${prefix}name must be a string`);
  if (typeof body.description !== 'string') errors.push(`${prefix}description must be a string`);
  if (!Array.isArray(body.goals)) {
    errors.push(`${prefix}goals must be an array`);
  } else {
    for (let i = 0; i < body.goals.length; i++) {
      if (typeof body.goals[i] !== 'string') errors.push(`${prefix}goals[${i}] must be a string`);
    }
  }
  if (
    typeof body.operating_mode !== 'string' ||
    !WORKFLOW_OPERATING_MODES_LOCAL.includes(
      body.operating_mode as (typeof WORKFLOW_OPERATING_MODES_LOCAL)[number],
    )
  ) {
    errors.push(
      `${prefix}operating_mode must be one of ${WORKFLOW_OPERATING_MODES_LOCAL.join(', ')}`,
    );
  }
  if (!Array.isArray(body.mandatory_controls)) {
    errors.push(`${prefix}mandatory_controls must be an array`);
  } else {
    for (let i = 0; i < body.mandatory_controls.length; i++) {
      if (typeof body.mandatory_controls[i] !== 'string') {
        errors.push(`${prefix}mandatory_controls[${i}] must be a string`);
      }
    }
  }
  if (!Array.isArray(body.stages)) {
    errors.push(`${prefix}stages must be an array`);
  } else {
    for (let i = 0; i < body.stages.length; i++) {
      const stage = body.stages[i];
      if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) {
        errors.push(`${prefix}stages[${i}] must be an object`);
        continue;
      }
      validateWorkflowStage(stage as Record<string, unknown>, `${prefix}stages[${i}]`, errors);
    }
  }
  if (!Array.isArray(body.edges)) {
    errors.push(`${prefix}edges must be an array`);
  } else {
    for (let i = 0; i < body.edges.length; i++) {
      const edge = body.edges[i];
      if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) {
        errors.push(`${prefix}edges[${i}] must be an object`);
        continue;
      }
      validateWorkflowEdge(edge as Record<string, unknown>, `${prefix}edges[${i}]`, errors);
    }
  }
  if (typeof body.recursive_promotion_target !== 'string') {
    errors.push(`${prefix}recursive_promotion_target must be a string`);
  }
  if (body.governance !== undefined) {
    if (
      typeof body.governance !== 'object' ||
      body.governance === null ||
      Array.isArray(body.governance)
    ) {
      errors.push(`${prefix}governance must be an object`);
    } else {
      validateWorkflowGovernance(
        body.governance as Record<string, unknown>,
        `${prefix}governance`,
        errors,
      );
    }
  }
  if (body.extends !== undefined && typeof body.extends !== 'string') {
    errors.push(`${prefix}extends must be a string`);
  }
  if (body.stage_overrides !== undefined) {
    if (
      typeof body.stage_overrides !== 'object' ||
      body.stage_overrides === null ||
      Array.isArray(body.stage_overrides)
    ) {
      errors.push(`${prefix}stage_overrides must be an object`);
    } else {
      validateWorkflowStageOverrides(
        body.stage_overrides as Record<string, unknown>,
        `${prefix}stage_overrides`,
        errors,
      );
    }
  }
}

function validateWorkflowSpec(obj: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  checkBase(obj, 'piorx/workflow-spec@1', errors);
  validateWorkflowSpecBody(obj, '', errors);
  return errors.length ? fail(errors) : ok();
}

// ---------------------------------------------------------------------------
// Validator registry
// ---------------------------------------------------------------------------

export const validators: Record<ArtifactType, (obj: Record<string, unknown>) => ValidationResult> =
  {
    'piorx/intent-capture@1': validateIntentCapture,
    'piorx/intent-restatement@1': validateIntentRestatement,
    'piorx/expansion-input@1': validateExpansionInput,
    'piorx/intent-spec@1': validateIntentSpec,
    'piorx/retrieval-index@1': validateRetrievalIndex,
    'piorx/evidence-plan@1': validateEvidencePlan,
    'piorx/evidence-bundle@1': validateEvidenceBundle,
    'piorx/analysis-report@1': validateAnalysisReport,
    'piorx/change-spec@1': validateChangeSpec,
    'piorx/execution-report@1': validateExecutionReport,
    'piorx/recursive-intent@1': validateRecursiveIntent,
    'piorx/workflow-spec@1': validateWorkflowSpec,
  };

/**
 * Validate an artifact object at runtime.
 *
 * Determines the correct validator from `artifact_type` and returns a
 * structured validation result.
 */
export function validateArtifact(obj: unknown): ValidationResult {
  if (typeof obj !== 'object' || obj === null) {
    return fail(['artifact must be a non-null object']);
  }

  const record = obj as Record<string, unknown>;
  const type = record.artifact_type;

  if (typeof type !== 'string') {
    return fail(['artifact_type must be a string']);
  }

  if (!ARTIFACT_TYPES.includes(type as ArtifactType)) {
    return fail([`unknown artifact_type: ${type}`]);
  }

  return validators[type as ArtifactType](record);
}
