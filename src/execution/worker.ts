/**
 * Execution worker — Phase 4 (COMP-P4-T2).
 *
 * Applies (or simulates) changes from a `change-spec@1` and produces an
 * `execution-report@1`. Per `docs/composability.md` "Phase 4 — execution
 * worker, real", this stage uses the same `runWithAdvisor`-shaped Stage
 * pattern as Phase 3 synthesis:
 *
 *   - Optional `llm: ExecutionLLMOptions` seam. When wired the worker
 *     drives `runWithAdvisor` with `output_config.format` derived from
 *     the existing `validateExecutionReport` schema (no parallel schema
 *     authoring) and parses the model's JSON response into a structurally-
 *     valid `execution-report@1` artifact.
 *   - When the seam is absent the deterministic stub fallback runs
 *     verbatim — preserving the byte-identical Phase 1 / 2 / 3 E2E
 *     regression (`tests/interaction/agentic-retrieval-flow.test.ts`)
 *     and the existing safety + report tests.
 *
 * Safety constraints (the `execution.allow_edits` mandatory control):
 *   - Execution is blocked unless `allow_edits` is explicitly true.
 *   - `run_validation` defaults to true when not specified.
 *   - The safety gate fires BEFORE any LLM call, so a model that
 *     hallucinates an executable plan never reaches the report stage
 *     when `allow_edits` is false.
 *
 * Deterministic fields (`artifact_type`, `artifact_id`, `change_spec_id`,
 * `modified_files`) are stamped from the input change-spec post-parse, so
 * the model can author the report's `notes`, `validation`, and `status`
 * but cannot mis-reference the spec or mint adversarial artifact ids.
 */

import type { ChangeSpecV1, ExecutionReportV1 } from '../artifacts/types.ts';
import { generateArtifactId } from '../artifacts/ids.ts';
import { validateArtifact, type ValidationResult } from '../artifacts/schemas.ts';
import type { ExecutionConstraints } from '../services/execution-dispatch.ts';
import {
  runWithAdvisor,
  type AdvisorCallback,
  type AdvisorTelemetry,
  type ExecutorCallback,
} from '../runtime/run-with-advisor.ts';
import type { PhaseModelConfig, PipelinePhaseId } from '../runtime/config.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExecutionBlockedError extends Error {
  constructor(reason: string) {
    super(`Execution blocked: ${reason}`);
    this.name = 'ExecutionBlockedError';
  }
}

export class ExecutionValidationError extends Error {
  public readonly validation: ValidationResult | undefined;
  constructor(message: string, validation?: ValidationResult) {
    super(message);
    this.name = 'ExecutionValidationError';
    this.validation = validation;
  }
}

// ---------------------------------------------------------------------------
// Worker input
// ---------------------------------------------------------------------------

export interface ExecutionWorkerInput {
  change_spec: ChangeSpecV1;
  constraints: ExecutionConstraints;
  /**
   * When provided, the worker calls `runWithAdvisor` against the supplied
   * executor (and optional advisor) callbacks. When absent the worker
   * falls back to the deterministic stub — preserving the Phase 1/2/3
   * byte-identical regression while Phase 4 callers wire in the real
   * LLM seam through the execution stage adapter.
   */
  llm?: ExecutionLLMOptions;
}

export interface ExecutionLLMOptions {
  /** Phase id forwarded into telemetry; defaults to `'execution'`. */
  phase?: PipelinePhaseId | string;
  /** Phase model configuration (executor + optional advisor). */
  config: PhaseModelConfig;
  /** Required executor callback. */
  executor: ExecutorCallback;
  /** Required when `config.advisor.mode` is `'inline'` or `'custom'`. */
  advisor?: AdvisorCallback;
  /**
   * Optional system prompt prefix. Phase 4 callers stamp the
   * `ADVISOR_TOOL_INSTRUCTIONS` block here when advisor is enabled (see
   * `src/synthesis/prompt.ts`). When omitted the system prompt defaults
   * to a short, deterministic execution directive.
   */
  systemPrompt?: string;
  /**
   * Telemetry sink. Receives the uniform `runtime.run_with_advisor`
   * record `runWithAdvisor` emits.
   */
  logEvent?: (message: string, details?: unknown) => Promise<void> | void;
  /** Test seam: override `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: override `Date.now()`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Safety enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce execution safety constraints.
 * Throws ExecutionBlockedError if constraints are not met.
 */
export function enforceConstraints(constraints: ExecutionConstraints): void {
  if (constraints.allow_edits !== true) {
    throw new ExecutionBlockedError('allow_edits must be explicitly true to execute changes');
  }
}

/**
 * Resolve execution constraints with defaults.
 * `run_validation` defaults to true if not explicitly set.
 */
export function resolveConstraints(
  constraints: Partial<ExecutionConstraints> & { allow_edits: boolean },
): ExecutionConstraints {
  return {
    allow_edits: constraints.allow_edits,
    run_validation: constraints.run_validation ?? true,
  };
}

// ---------------------------------------------------------------------------
// Output format — derived from validateExecutionReport in
// src/artifacts/schemas.ts. Hands the model an explicit JSON Schema
// describing the report shape; deterministic fields are stamped post-parse
// so the model can author body content but cannot mis-reference the spec
// or mint adversarial artifact ids.
// ---------------------------------------------------------------------------

export interface JsonSchemaFragment {
  type: string;
  properties?: Record<string, JsonSchemaFragment>;
  required?: string[];
  items?: JsonSchemaFragment;
  additionalProperties?: boolean;
  const?: string;
  description?: string;
}

export function executionOutputFormat(): JsonSchemaFragment {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'artifact_type',
      'artifact_id',
      'change_spec_id',
      'status',
      'modified_files',
      'validation',
      'notes',
    ],
    properties: {
      artifact_type: { type: 'string', const: 'piorx/execution-report@1' },
      artifact_id: { type: 'string' },
      change_spec_id: { type: 'string' },
      status: { type: 'string' },
      modified_files: { type: 'array', items: { type: 'string' } },
      validation: {
        type: 'object',
        additionalProperties: false,
        required: ['commands', 'passed'],
        properties: {
          commands: { type: 'array', items: { type: 'string' } },
          passed: { type: 'string' },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
  };
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the execution worker.
 *
 * When `input.llm` is supplied the worker drives the LLM through
 * `runWithAdvisor` and parses the resulting JSON. Otherwise it falls back
 * to the deterministic stub that produces an in-shape report from the
 * change spec — the path the existing safety + report tests and the
 * Phase 1/2/3 E2E exercise unchanged.
 *
 * The safety gate (`enforceConstraints`) fires BEFORE any LLM call.
 */
export async function runExecutionWorker(input: ExecutionWorkerInput): Promise<ExecutionReportV1> {
  // Safety gate — must pass before any work, including the LLM call.
  // Mandatory-control: extensions cannot weaken this gate; weakening it
  // would be rejected by the registry at boot.
  enforceConstraints(input.constraints);

  if (input.llm) {
    return runLLMExecutionWorker(input);
  }
  return buildStubExecutionReport(input);
}

// ---------------------------------------------------------------------------
// LLM-driven path (advisor-aware)
// ---------------------------------------------------------------------------

async function runLLMExecutionWorker(input: ExecutionWorkerInput): Promise<ExecutionReportV1> {
  const llm = input.llm!;
  const schema = executionOutputFormat();
  const userMessage = composeUserMessage(input.change_spec, input.constraints, schema);
  const advisorEnabled = isAdvisorEnabled(llm.config);
  const systemPrompt = llm.systemPrompt ?? defaultSystemPrompt(advisorEnabled);

  const result = await runWithAdvisor(
    { systemPrompt, userMessage },
    {
      phase: llm.phase ?? 'execution',
      config: llm.config,
      executor: llm.executor,
      ...(llm.advisor !== undefined ? { advisor: llm.advisor } : {}),
      ...(llm.logEvent !== undefined ? { logEvent: llm.logEvent } : {}),
      ...(llm.env !== undefined ? { env: llm.env } : {}),
      ...(llm.now !== undefined ? { now: llm.now } : {}),
    },
  );

  const parsed = parseModelJson(result.text);
  const stamped = stampDeterministicFields(parsed, input.change_spec);
  const validation = validateArtifact(stamped);
  if (!validation.valid) {
    throw new ExecutionValidationError(
      `LLM execution report failed validation: ${validation.errors.join('; ')}`,
      validation,
    );
  }
  return stamped as ExecutionReportV1;
}

function isAdvisorEnabled(config: PhaseModelConfig): boolean {
  return config.advisor !== undefined && config.advisor.mode !== 'none';
}

function composeUserMessage(
  changeSpec: ChangeSpecV1,
  constraints: ExecutionConstraints,
  schema: JsonSchemaFragment,
): string {
  return [
    '# Execution Task',
    '',
    `**Change spec id:** ${changeSpec.artifact_id}`,
    `**Change goal:** ${changeSpec.change_goal}`,
    '',
    `**Edits:** ${changeSpec.edits.length} file(s)`,
    ...changeSpec.edits.map((e) => `- ${e.path}: ${e.intent}`),
    '',
    `**Tests declared in spec:** ${changeSpec.tests.length}`,
    ...changeSpec.tests.map((t) => `- ${t}`),
    '',
    `**Run validation:** ${constraints.run_validation}`,
    '',
    'Produce an execution report describing the outcome of applying the spec.',
    'Populate `status`, `validation.commands`, `validation.passed` (as a string',
    '"true" or "false" — see schema), and `notes`.',
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

function defaultSystemPrompt(advisorEnabled: boolean): string {
  const directive =
    'You are piorx execution. Produce a single JSON object that satisfies the supplied JSON Schema. ' +
    'Respond with JSON only — no commentary, no surrounding markdown fences.';
  if (!advisorEnabled) return directive;
  // Phase 4 mirrors the synthesis pattern: when advisor is enabled, the
  // calling stage adapter prepends `ADVISOR_TOOL_INSTRUCTIONS` via
  // `llm.systemPrompt`. The default here is the bare directive so an
  // advisor-on call without a custom prompt still produces valid JSON.
  return directive;
}

function parseModelJson(text: string): unknown {
  const trimmed = stripCodeFence(text.trim());
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExecutionValidationError(`Worker output is not valid JSON: ${message}`);
  }
}

function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) return fenceMatch[1];
  return text;
}

/**
 * Overwrite the deterministic fields the model is not authorized to
 * author: `artifact_type`, `artifact_id`, `change_spec_id`, and
 * `modified_files` (sourced from the change spec). The model authors
 * `status`, `validation`, and `notes`.
 *
 * `validation.passed` is normalized: the schema asks for a string
 * because some providers struggle to emit booleans inside structured
 * output, but the artifact validator expects a boolean. We coerce here.
 */
function stampDeterministicFields(output: unknown, changeSpec: ChangeSpecV1): ExecutionReportV1 {
  if (typeof output !== 'object' || output === null) {
    throw new ExecutionValidationError('LLM execution report must be a non-null object');
  }
  const record = output as Record<string, unknown>;
  record.artifact_type = 'piorx/execution-report@1';
  record.artifact_id = generateArtifactId('piorx/execution-report@1');
  record.change_spec_id = changeSpec.artifact_id;
  record.modified_files = changeSpec.edits.map((edit) => edit.path);

  const validation = (record.validation ?? {}) as Record<string, unknown>;
  if (typeof validation.passed !== 'boolean') {
    validation.passed =
      validation.passed === true || validation.passed === 'true' || validation.passed === 1;
  }
  if (!Array.isArray(validation.commands)) {
    validation.commands = [];
  }
  record.validation = validation;

  if (!Array.isArray(record.notes)) record.notes = [];
  if (typeof record.status !== 'string' || !record.status) {
    record.status = 'completed';
  }
  return record as unknown as ExecutionReportV1;
}

// ---------------------------------------------------------------------------
// Deterministic stub (Phase 1/2/3 fallback path)
// ---------------------------------------------------------------------------

function buildStubExecutionReport(input: ExecutionWorkerInput): ExecutionReportV1 {
  const { change_spec, constraints } = input;

  // Collect modified file paths from the change spec edits
  const modifiedFiles = change_spec.edits.map((edit) => edit.path);

  // Determine validation commands from tests in the change spec
  const validationCommands = constraints.run_validation
    ? change_spec.tests.length > 0
      ? change_spec.tests.map((t) => `test: ${t}`)
      : ['npm test']
    : [];

  // In stub mode, validation always passes
  const validationPassed = constraints.run_validation;

  const report: ExecutionReportV1 = {
    artifact_type: 'piorx/execution-report@1',
    artifact_id: generateArtifactId('piorx/execution-report@1'),
    change_spec_id: change_spec.artifact_id,
    status: validationPassed ? 'completed' : 'completed_with_warnings',
    modified_files: modifiedFiles,
    validation: {
      commands: validationCommands,
      passed: validationPassed,
    },
    notes: [
      `Applied ${change_spec.edits.length} edit(s) from change spec`,
      ...(constraints.run_validation
        ? [`Ran ${validationCommands.length} validation command(s)`]
        : ['Validation skipped per constraints']),
    ],
  };

  // Validate the report before returning
  const validation = validateArtifact(report);
  if (!validation.valid) {
    throw new ExecutionValidationError(
      `Generated execution report failed validation: ${validation.errors.join('; ')}`,
      validation,
    );
  }

  return report;
}

// Re-export so consumers can type the telemetry record they receive via
// `ExecutionLLMOptions.logEvent`.
export type { AdvisorTelemetry };
