/**
 * Synthesis dispatch service.
 *
 * Takes an evidence bundle and intent artifacts, assembles a deterministic
 * prompt, runs the synthesis worker, validates the output, and stores the
 * resulting analysis-report-v1 or change-spec-v1 artifact.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import { assembleSynthesisPrompt, type SynthesisSection } from '../synthesis/prompt.ts';
import {
  runSynthesisWorker,
  validateWorkerOutput,
  SynthesisValidationError,
} from '../synthesis/worker.ts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type SynthesisTaskType = 'analysis-report' | 'change-spec';

export interface SynthesisDispatchInput {
  task_type: SynthesisTaskType;
  intent_capture_id: string;
  intent_restatement_id: string;
  intent_spec_id: string | null;
  evidence_bundle_id: string;
  instructions: string;
}

export interface SynthesisDispatchResult {
  status: 'success' | 'error';
  synthesis_artifact_id: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Default sections by task type
// ---------------------------------------------------------------------------

const DEFAULT_SECTIONS: Record<SynthesisTaskType, SynthesisSection[]> = {
  'analysis-report': ['intent_context', 'structural_context', 'raw_evidence'],
  'change-spec': ['intent_context', 'structural_context', 'raw_evidence'],
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function synthesisDispatch(
  input: SynthesisDispatchInput,
  store: ArtifactStore,
): Promise<SynthesisDispatchResult> {
  // Load the evidence bundle
  const bundle = await store.get('piorx/evidence-bundle@1', input.evidence_bundle_id);
  if (!bundle) {
    return {
      status: 'error',
      synthesis_artifact_id: null,
      message: `Evidence bundle not found: ${input.evidence_bundle_id}`,
    };
  }

  // Assemble the prompt from bundle sections
  const sections = DEFAULT_SECTIONS[input.task_type];
  const assembled = assembleSynthesisPrompt(bundle, {
    sections,
    instructions: input.instructions,
    task_type: input.task_type,
  });

  try {
    // Run the synthesis worker
    const rawOutput = await runSynthesisWorker({
      task_type: input.task_type,
      bundle,
      prompt_text: assembled.text,
      instructions: input.instructions,
    });

    // Validate worker output before storing
    const validated = validateWorkerOutput(rawOutput, input.task_type);

    // Store the validated artifact
    await store.put(validated);

    return {
      status: 'success',
      synthesis_artifact_id: validated.artifact_id,
      message: `Synthesis artifact created: ${validated.artifact_type}`,
    };
  } catch (err) {
    if (err instanceof SynthesisValidationError) {
      return {
        status: 'error',
        synthesis_artifact_id: null,
        message: `Synthesis output validation failed: ${err.message}`,
      };
    }
    return {
      status: 'error',
      synthesis_artifact_id: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
