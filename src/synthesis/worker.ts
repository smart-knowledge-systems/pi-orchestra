/**
 * Synthesis worker.
 *
 * Produces analysis-report-v1 or change-spec-v1 artifacts from an assembled
 * synthesis prompt. Validates worker output before returning.
 *
 * In this initial implementation the worker uses a deterministic stub that
 * generates structured output from the bundle. Real model calls are deferred.
 */

import type { EvidenceBundleV1, AnalysisReportV1, ChangeSpecV1 } from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import { validateArtifact, type ValidationResult } from '../artifacts/schemas.ts';
import type { SynthesisTaskType } from '../services/synthesis-dispatch.ts';

// ---------------------------------------------------------------------------
// Worker types
// ---------------------------------------------------------------------------

export interface SynthesisWorkerInput {
  task_type: SynthesisTaskType;
  bundle: EvidenceBundleV1;
  prompt_text: string;
  instructions: string;
}

export type SynthesisWorkerOutput = AnalysisReportV1 | ChangeSpecV1;

export class SynthesisValidationError extends Error {
  public readonly validation: ValidationResult;
  constructor(message: string, validation: ValidationResult) {
    super(message);
    this.name = 'SynthesisValidationError';
    this.validation = validation;
  }
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

/**
 * Validate that worker output matches the expected artifact type and schema.
 * Throws SynthesisValidationError on mismatch.
 */
export function validateWorkerOutput(
  output: unknown,
  expectedType: SynthesisTaskType,
): SynthesisWorkerOutput {
  if (typeof output !== 'object' || output === null) {
    throw new SynthesisValidationError('Worker output must be a non-null object', {
      valid: false,
      errors: ['output is not an object'],
    });
  }

  const record = output as Record<string, unknown>;
  const expectedArtifactType =
    expectedType === 'analysis-report' ? 'piorx/analysis-report@1' : 'piorx/change-spec@1';

  if (record.artifact_type !== expectedArtifactType) {
    throw new SynthesisValidationError(
      `Expected artifact_type "${expectedArtifactType}", got "${record.artifact_type}"`,
      { valid: false, errors: [`artifact_type mismatch: expected ${expectedArtifactType}`] },
    );
  }

  const validation = validateArtifact(output);
  if (!validation.valid) {
    throw new SynthesisValidationError(
      `Worker output failed schema validation: ${validation.errors.join('; ')}`,
      validation,
    );
  }

  return output as SynthesisWorkerOutput;
}

// ---------------------------------------------------------------------------
// Stub worker implementation
// ---------------------------------------------------------------------------

/**
 * Run the synthesis worker. Currently a deterministic stub that produces
 * structured output from the bundle contents. Will be replaced with a
 * real model-backed worker in a future phase.
 */
export async function runSynthesisWorker(
  input: SynthesisWorkerInput,
): Promise<SynthesisWorkerOutput> {
  if (input.task_type === 'analysis-report') {
    return buildAnalysisReport(input);
  }
  return buildChangeSpec(input);
}

function buildAnalysisReport(input: SynthesisWorkerInput): AnalysisReportV1 {
  const { bundle } = input;

  const findings: string[] = [];
  for (const file of bundle.structural_context.files) {
    if (file.file_summary) {
      findings.push(`${file.path}: ${file.file_summary}`);
    }
  }
  for (const finding of bundle.structural_context.cross_file_findings) {
    findings.push(finding);
  }

  const risks: string[] = [];
  if (bundle.stats.total_lines > 500) {
    risks.push('Large evidence scope may indicate complex dependencies');
  }

  return {
    artifact_type: 'piorx/analysis-report@1',
    artifact_id: generateArtifactId('piorx/analysis-report@1'),
    evidence_bundle_id: bundle.artifact_id,
    summary: `Analysis of ${bundle.stats.files} file(s) with ${bundle.stats.spans} span(s) based on: ${bundle.intent_context.approved_restated_intent}`,
    findings,
    risks,
    recommended_next_steps: ['Review findings and decide on implementation approach'],
  };
}

function buildChangeSpec(input: SynthesisWorkerInput): ChangeSpecV1 {
  const { bundle } = input;

  const edits = bundle.raw_evidence.map((ev) => ({
    path: ev.path,
    target: {
      kind: ev.kind,
      name: ev.label,
      start: ev.start,
      count: ev.count,
    },
    intent: `Modify ${ev.label} as specified by intent`,
    required_changes: [`Update ${ev.label} in ${ev.path}`],
    constraints: [],
  }));

  return {
    artifact_type: 'piorx/change-spec@1',
    artifact_id: generateArtifactId('piorx/change-spec@1'),
    evidence_bundle_id: bundle.artifact_id,
    change_goal: bundle.intent_context.approved_restated_intent,
    summary: `Change specification targeting ${edits.length} edit(s) across ${bundle.stats.files} file(s)`,
    edits,
    tests: [],
    acceptance_criteria: ['All edits applied successfully', 'Existing tests pass'],
  };
}
