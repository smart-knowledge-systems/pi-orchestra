/**
 * Synthesis worker — COMP-P3-T1.
 *
 * Per `docs/composability.md` "Phase 3 — First real LLM-driven Stage", the
 * synthesis worker is the canonical example of a Stage backed by
 * `runWithAdvisor`. When the host wires an executor callback (and optional
 * advisor callback) the worker drives the LLM with `output_config.format`
 * derived mechanically from the existing artifact validators in
 * `src/artifacts/schemas.ts`, parses the model's JSON response, and routes
 * it through `validateWorkerOutput` so structurally-invalid outputs surface
 * a `SynthesisValidationError` rather than reaching the artifact store.
 *
 * The deterministic stub remains as the fallback path. When no LLM seam is
 * supplied the worker still produces an in-shape `analysis-report@1` /
 * `change-spec@1` from the bundle — that is the behavior the existing
 * `tests/synthesis/dispatch.test.ts` and the Phase 1 E2E
 * (`tests/interaction/agentic-retrieval-flow.test.ts`) already lock down.
 * Keeping that path is load-bearing for the Phase 1 byte-identical gate.
 *
 * "Output format derived from validators": `synthesisOutputFormat()` reads
 * the same shape the validators in `src/artifacts/schemas.ts` already
 * enforce (`validateAnalysisReport` / `validateChangeSpec`) and emits a
 * JSON Schema describing it. There is no parallel schema authoring — if a
 * validator gains a field, the helper here is updated alongside it. The
 * helper output is what the worker hands to the executor (today: appended
 * to the user message; runWithAdvisor's executor seam is text-only and the
 * structured-output channel is provider-specific Phase 5+ wiring).
 */

import type { EvidenceBundleV1, AnalysisReportV1, ChangeSpecV1 } from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import { validateArtifact, type ValidationResult } from '../artifacts/schemas.ts';
import type { SynthesisTaskType } from '../services/synthesis-dispatch.ts';
import {
  runWithAdvisor,
  type AdvisorCallback,
  type AdvisorTelemetry,
  type ExecutorCallback,
} from '../runtime/run-with-advisor.ts';
import type { PhaseModelConfig, PipelinePhaseId } from '../runtime/config.ts';
import { synthesisSystemPrompt } from './prompt.ts';

// ---------------------------------------------------------------------------
// Worker types
// ---------------------------------------------------------------------------

export interface SynthesisWorkerInput {
  task_type: SynthesisTaskType;
  bundle: EvidenceBundleV1;
  prompt_text: string;
  instructions: string;
  /**
   * When provided, the worker calls `runWithAdvisor` against the supplied
   * executor (and optional advisor) callbacks. When absent the worker falls
   * back to the deterministic stub — preserving the Phase 1 byte-identical
   * regression while Phase 3 callers (the synthesis stage adapter) wire in
   * the real LLM seam.
   */
  llm?: SynthesisLLMOptions;
}

export interface SynthesisLLMOptions {
  /** Phase id forwarded into telemetry; defaults to `'synthesis'`. */
  phase?: PipelinePhaseId | string;
  /** Phase model configuration (executor + optional advisor). */
  config: PhaseModelConfig;
  /** Required executor callback. */
  executor: ExecutorCallback;
  /** Required when `config.advisor.mode` is `'inline'` or `'custom'`. */
  advisor?: AdvisorCallback;
  /**
   * Optional system prompt prefix. Phase 3 callers stamp the
   * `ADVISOR_TOOL_INSTRUCTIONS` block here when advisor is enabled (see
   * `src/synthesis/prompt.ts`). When omitted the system prompt defaults to
   * a short, deterministic synthesis directive.
   */
  systemPrompt?: string;
  /**
   * Telemetry sink. Receives the uniform `runtime.run_with_advisor` record
   * `runWithAdvisor` emits — that record is the source of truth for the
   * `advisor_iterations` telemetry asserted by the Phase 3 gate test.
   */
  logEvent?: (message: string, details?: unknown) => Promise<void> | void;
  /** Test seam: override `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: override `Date.now()`. */
  now?: () => number;
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
// Output format — derived from src/artifacts/schemas.ts validators.
// ---------------------------------------------------------------------------

/**
 * JSON-Schema fragment describing the structured output expected for a
 * given synthesis task type. The shapes mirror what `validateAnalysisReport`
 * / `validateChangeSpec` (in `src/artifacts/schemas.ts`) already enforce —
 * any divergence between the validator and this helper is a bug. The
 * worker hands this schema to the executor through the prompt body so the
 * model has an explicit structural contract; later phases may forward it
 * through provider-specific structured-output channels (`output_config`,
 * tool-result schemas, etc.) without changing the shape here.
 */
export interface JsonSchemaFragment {
  type: string;
  properties?: Record<string, JsonSchemaFragment>;
  required?: string[];
  items?: JsonSchemaFragment;
  additionalProperties?: boolean;
  const?: string;
  description?: string;
}

export function synthesisOutputFormat(taskType: SynthesisTaskType): JsonSchemaFragment {
  if (taskType === 'analysis-report') return analysisReportSchema();
  return changeSpecSchema();
}

function analysisReportSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'artifact_type',
      'artifact_id',
      'evidence_bundle_id',
      'summary',
      'findings',
      'risks',
      'recommended_next_steps',
    ],
    properties: {
      artifact_type: { type: 'string', const: 'piorx/analysis-report@1' },
      artifact_id: { type: 'string' },
      evidence_bundle_id: { type: 'string' },
      summary: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      recommended_next_steps: { type: 'array', items: { type: 'string' } },
    },
  };
}

function changeSpecSchema(): JsonSchemaFragment {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'artifact_type',
      'artifact_id',
      'evidence_bundle_id',
      'change_goal',
      'summary',
      'edits',
      'tests',
      'acceptance_criteria',
    ],
    properties: {
      artifact_type: { type: 'string', const: 'piorx/change-spec@1' },
      artifact_id: { type: 'string' },
      evidence_bundle_id: { type: 'string' },
      change_goal: { type: 'string' },
      summary: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'target', 'intent', 'required_changes', 'constraints'],
          properties: {
            path: { type: 'string' },
            target: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'name', 'start', 'count'],
              properties: {
                kind: { type: 'string' },
                name: { type: 'string' },
                start: { type: 'number' },
                count: { type: 'number' },
              },
            },
            intent: { type: 'string' },
            required_changes: { type: 'array', items: { type: 'string' } },
            constraints: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      tests: { type: 'array', items: { type: 'string' } },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
    },
  };
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the synthesis worker.
 *
 * When `input.llm` is supplied the worker drives the LLM through
 * `runWithAdvisor` and parses the resulting JSON. Otherwise it falls back
 * to a deterministic stub that produces an in-shape artifact from the
 * bundle contents — the path the existing dispatch tests and the Phase 1
 * E2E exercise unchanged.
 */
export async function runSynthesisWorker(
  input: SynthesisWorkerInput,
): Promise<SynthesisWorkerOutput> {
  if (input.llm) {
    return runLLMSynthesisWorker(input);
  }
  if (input.task_type === 'analysis-report') {
    return buildAnalysisReport(input);
  }
  return buildChangeSpec(input);
}

// ---------------------------------------------------------------------------
// LLM-driven path (advisor-aware)
// ---------------------------------------------------------------------------

async function runLLMSynthesisWorker(input: SynthesisWorkerInput): Promise<SynthesisWorkerOutput> {
  const llm = input.llm!;
  const schema = synthesisOutputFormat(input.task_type);
  const userMessage = composeUserMessage(input.prompt_text, schema);
  const advisorEnabled = isAdvisorEnabled(llm.config);
  const systemPrompt = llm.systemPrompt ?? synthesisSystemPrompt({ advisorEnabled });

  const result = await runWithAdvisor(
    { systemPrompt, userMessage },
    {
      phase: llm.phase ?? 'synthesis',
      config: llm.config,
      executor: llm.executor,
      ...(llm.advisor !== undefined ? { advisor: llm.advisor } : {}),
      ...(llm.logEvent !== undefined ? { logEvent: llm.logEvent } : {}),
      ...(llm.env !== undefined ? { env: llm.env } : {}),
      ...(llm.now !== undefined ? { now: llm.now } : {}),
    },
  );

  const parsed = parseModelJson(result.text);
  const stamped = stampDeterministicFields(parsed, input.task_type, input.bundle.artifact_id);
  return validateWorkerOutput(stamped, input.task_type);
}

function isAdvisorEnabled(config: PhaseModelConfig): boolean {
  return config.advisor !== undefined && config.advisor.mode !== 'none';
}

function composeUserMessage(promptText: string, schema: JsonSchemaFragment): string {
  return [
    promptText.trimEnd(),
    '',
    '## Output JSON Schema',
    '',
    'Return a single JSON object that conforms to this schema:',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
  ].join('\n');
}

function parseModelJson(text: string): unknown {
  const trimmed = stripCodeFence(text.trim());
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SynthesisValidationError(`Worker output is not valid JSON: ${message}`, {
      valid: false,
      errors: ['output is not valid JSON'],
    });
  }
}

/**
 * Strip a single leading/trailing fenced code block if the model wrapped its
 * JSON in `\`\`\`json … \`\`\``. Conservative — only when the entire payload
 * is a single fenced block.
 */
function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) return fenceMatch[1];
  return text;
}

/**
 * Overwrite the artifact_id (piorx-controlled) and pin the artifact_type +
 * evidence_bundle_id to the bundle the worker was invoked against. The
 * model's text supplies the rest of the body; deterministic fields are
 * authoritative regardless of what the model returned.
 */
function stampDeterministicFields(
  output: unknown,
  taskType: SynthesisTaskType,
  bundleId: string,
): unknown {
  if (typeof output !== 'object' || output === null) return output;
  const record = output as Record<string, unknown>;
  const expectedArtifactType =
    taskType === 'analysis-report' ? 'piorx/analysis-report@1' : 'piorx/change-spec@1';
  record.artifact_type = expectedArtifactType;
  record.artifact_id = generateArtifactId(expectedArtifactType);
  record.evidence_bundle_id = bundleId;
  return record;
}

// ---------------------------------------------------------------------------
// Deterministic stub (Phase 1 fallback path)
// ---------------------------------------------------------------------------

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

// Re-export so consumers can type the telemetry record they receive via
// `SynthesisLLMOptions.logEvent`.
export type { AdvisorTelemetry };
