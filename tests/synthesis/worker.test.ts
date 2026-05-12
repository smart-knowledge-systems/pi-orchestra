/**
 * Synthesis worker tests — COMP-P3-T3.
 *
 * Snapshot tests for the LLM-driven path through `runSynthesisWorker`.
 * Cover both task types (analysis-report and change-spec) against a
 * stubbed advisor + executor pair, plus the determinism the Phase 3 gate
 * relies on:
 *
 *   - JSON schema produced by `synthesisOutputFormat()` mirrors the
 *     fields the validators in `src/artifacts/schemas.ts` enforce.
 *   - The LLM path produces a structurally-valid artifact with the bundle
 *     id stamped from input (model can't mis-reference the bundle).
 *   - Advisor consultations surface in the telemetry record handed to
 *     `logEvent`; with `advisor.mode='custom'` the executor's text and
 *     the resulting artifact are byte-identical to a `'none'`-mode run.
 *   - Malformed JSON / wrong artifact_type from the model surfaces a
 *     `SynthesisValidationError` rather than a partial artifact.
 *   - The deterministic stub fallback path (no `llm` opts) is unchanged
 *     so dispatch.test.ts and the Phase 1 E2E stay byte-identical.
 */

import { describe, expect, test } from 'bun:test';
import {
  runSynthesisWorker,
  synthesisOutputFormat,
  validateWorkerOutput,
  SynthesisValidationError,
  type SynthesisLLMOptions,
  type SynthesisWorkerInput,
} from '../../src/synthesis/worker.ts';
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  SYNTHESIS_SYSTEM_DIRECTIVE,
  assembleSynthesisPrompt,
  synthesisSystemPrompt,
} from '../../src/synthesis/prompt.ts';
import {
  type AdvisorCallback,
  type AdvisorTelemetry,
  type ExecutorCallback,
  type ExecutorRequest,
} from '../../src/runtime/run-with-advisor.ts';
import type { PhaseModelConfig } from '../../src/runtime/config.ts';
import type {
  AnalysisReportV1,
  ChangeSpecV1,
  EvidenceBundleV1,
} from '../../src/artifacts/types.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBundle(): EvidenceBundleV1 {
  return {
    artifact_type: 'piorx/evidence-bundle@1',
    artifact_id: 'bundle_worker_test_001',
    evidence_plan_id: 'plan_worker_test_001',
    intent_context: {
      user_intent_verbatim: 'Refactor authentication',
      approved_restated_intent: 'Refactor the authentication module for clarity',
      intent_spec_id: null,
    },
    structural_context: {
      files: [
        {
          path: '/repo/src/auth.ts',
          file_summary: 'Authentication middleware',
          ast_skeleton: ['function validateToken(...)'],
          symbols: [
            { name: 'validateToken', start: 10, count: 20, summary: 'Validates JWT tokens' },
          ],
        },
      ],
      cross_file_findings: [],
    },
    raw_evidence: [
      {
        path: '/repo/src/auth.ts',
        kind: 'span',
        label: 'validateToken',
        start: 10,
        count: 20,
        content: 'function validateToken(token: string) { return true; }',
      },
    ],
    stats: { files: 1, spans: 1, full_files: 0, total_lines: 20, estimated_tokens: 300 },
  };
}

function executorConfig(advisorMode: 'none' | 'custom' | 'inline'): PhaseModelConfig {
  const config: PhaseModelConfig = {
    executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  if (advisorMode !== 'none') {
    config.advisor = { mode: advisorMode, model: 'claude-opus-4-7' };
  } else {
    config.advisor = { mode: 'none' };
  }
  return config;
}

const ANALYSIS_PAYLOAD = {
  artifact_type: 'piorx/analysis-report@1',
  // artifact_id and evidence_bundle_id are stamped deterministically — these
  // values are placeholders the worker overwrites.
  artifact_id: 'will-be-overwritten',
  evidence_bundle_id: 'will-be-overwritten',
  summary: 'Stubbed analysis summary',
  findings: ['Finding 1', 'Finding 2'],
  risks: ['Risk A'],
  recommended_next_steps: ['Step 1'],
};

const CHANGE_SPEC_PAYLOAD = {
  artifact_type: 'piorx/change-spec@1',
  artifact_id: 'will-be-overwritten',
  evidence_bundle_id: 'will-be-overwritten',
  change_goal: 'Refactor authentication',
  summary: 'Stubbed change spec summary',
  edits: [
    {
      path: '/repo/src/auth.ts',
      target: { kind: 'function', name: 'validateToken', start: 10, count: 20 },
      intent: 'Simplify validation',
      required_changes: ['Remove duplicate branch'],
      constraints: [],
    },
  ],
  tests: ['npm test -- auth'],
  acceptance_criteria: ['All tests pass'],
};

interface ExecutorSpy {
  callback: ExecutorCallback;
  calls: ExecutorRequest[];
}

function makeExecutor(text: string, spawnAdvisor: boolean): ExecutorSpy {
  const calls: ExecutorRequest[] = [];
  const callback: ExecutorCallback = async (req) => {
    calls.push(req);
    if (spawnAdvisor && req.extras.customAdvisorHandler) {
      await req.extras.customAdvisorHandler({
        systemPrompt: 'advisor-system',
        userMessage: 'advisor-user',
      });
    }
    return {
      text,
      iterations: [{ type: 'message', input_tokens: 100, output_tokens: 50 }],
    };
  };
  return { callback, calls };
}

interface AdvisorSpy {
  callback: AdvisorCallback;
  calls: number;
}

function makeAdvisor(text: string): AdvisorSpy {
  const spy: AdvisorSpy = { calls: 0, callback: async () => ({ text, usage: undefined }) };
  spy.callback = async () => {
    spy.calls += 1;
    return {
      text,
      usage: { input_tokens: 30, output_tokens: 10 },
    };
  };
  return spy;
}

function makeWorkerInput(
  taskType: 'analysis-report' | 'change-spec',
  llm: SynthesisLLMOptions,
): SynthesisWorkerInput {
  const bundle = makeBundle();
  const prompt = assembleSynthesisPrompt(bundle, {
    sections: ['intent_context', 'structural_context', 'raw_evidence'],
    instructions: 'Be precise.',
    task_type: taskType,
  });
  return {
    task_type: taskType,
    bundle,
    prompt_text: prompt.text,
    instructions: 'Be precise.',
    llm,
  };
}

// ---------------------------------------------------------------------------
// Output schema (mirrors validators)
// ---------------------------------------------------------------------------

describe('synthesisOutputFormat', () => {
  test('analysis-report schema enumerates every required validator field', () => {
    const schema = synthesisOutputFormat('analysis-report');
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual([
      'artifact_type',
      'artifact_id',
      'evidence_bundle_id',
      'summary',
      'findings',
      'risks',
      'recommended_next_steps',
    ]);
    expect(schema.properties?.artifact_type?.const).toBe('piorx/analysis-report@1');
    expect(schema.properties?.findings?.type).toBe('array');
    expect(schema.properties?.findings?.items?.type).toBe('string');
  });

  test('change-spec schema enumerates every required validator field', () => {
    const schema = synthesisOutputFormat('change-spec');
    expect(schema.required).toEqual([
      'artifact_type',
      'artifact_id',
      'evidence_bundle_id',
      'change_goal',
      'summary',
      'edits',
      'tests',
      'acceptance_criteria',
    ]);
    expect(schema.properties?.artifact_type?.const).toBe('piorx/change-spec@1');
    const edit = schema.properties?.edits?.items;
    expect(edit?.type).toBe('object');
    expect(edit?.required).toEqual(['path', 'target', 'intent', 'required_changes', 'constraints']);
    const target = edit?.properties?.target;
    expect(target?.required).toEqual(['kind', 'name', 'start', 'count']);
    expect(target?.properties?.start?.type).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// LLM path — analysis-report
// ---------------------------------------------------------------------------

describe('runSynthesisWorker (LLM path) — analysis-report', () => {
  test('snapshot: stubbed model returns analysis-report that validates structurally', async () => {
    const executor = makeExecutor(JSON.stringify(ANALYSIS_PAYLOAD), false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    const output = (await runSynthesisWorker(input)) as AnalysisReportV1;

    expect(output.artifact_type).toBe('piorx/analysis-report@1');
    expect(output.evidence_bundle_id).toBe(input.bundle.artifact_id);
    expect(output.summary).toBe('Stubbed analysis summary');
    expect(output.findings).toEqual(['Finding 1', 'Finding 2']);
    expect(output.risks).toEqual(['Risk A']);
    expect(output.recommended_next_steps).toEqual(['Step 1']);

    const validation = validateArtifact(output);
    expect(validation.valid).toBe(true);
  });

  test('user message embeds the JSON Schema derived from validators', async () => {
    const executor = makeExecutor(JSON.stringify(ANALYSIS_PAYLOAD), false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    await runSynthesisWorker(input);

    expect(executor.calls.length).toBe(1);
    const request = executor.calls[0]!;
    expect(request.userMessage).toContain('## Output JSON Schema');
    expect(request.userMessage).toContain('"const": "piorx/analysis-report@1"');
    expect(request.userMessage).toContain('"recommended_next_steps"');
  });

  test('artifact_id is freshly generated regardless of model output', async () => {
    const adversarial = { ...ANALYSIS_PAYLOAD, artifact_id: 'attacker-controlled-id' };
    const executor = makeExecutor(JSON.stringify(adversarial), false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    const output = await runSynthesisWorker(input);
    expect(output.artifact_id).not.toBe('attacker-controlled-id');
    expect(output.artifact_id.startsWith('analysis_')).toBe(true);
  });

  test('strips ```json fences if the model wrapped its response', async () => {
    const fenced = '```json\n' + JSON.stringify(ANALYSIS_PAYLOAD) + '\n```';
    const executor = makeExecutor(fenced, false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    const output = (await runSynthesisWorker(input)) as AnalysisReportV1;
    expect(output.artifact_type).toBe('piorx/analysis-report@1');
    expect(output.summary).toBe('Stubbed analysis summary');
  });
});

// ---------------------------------------------------------------------------
// LLM path — change-spec
// ---------------------------------------------------------------------------

describe('runSynthesisWorker (LLM path) — change-spec', () => {
  test('snapshot: stubbed model returns change-spec that validates structurally', async () => {
    const executor = makeExecutor(JSON.stringify(CHANGE_SPEC_PAYLOAD), false);
    const input = makeWorkerInput('change-spec', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    const output = (await runSynthesisWorker(input)) as ChangeSpecV1;

    expect(output.artifact_type).toBe('piorx/change-spec@1');
    expect(output.evidence_bundle_id).toBe(input.bundle.artifact_id);
    expect(output.change_goal).toBe('Refactor authentication');
    expect(output.edits.length).toBe(1);
    expect(output.edits[0]!.path).toBe('/repo/src/auth.ts');
    expect(output.edits[0]!.target).toEqual({
      kind: 'function',
      name: 'validateToken',
      start: 10,
      count: 20,
    });

    const validation = validateArtifact(output);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Telemetry + advisor consultation
// ---------------------------------------------------------------------------

describe('runSynthesisWorker (LLM path) — advisor telemetry', () => {
  test('advisor=custom records advisor_iterations in telemetry', async () => {
    const executor = makeExecutor(JSON.stringify(ANALYSIS_PAYLOAD), true);
    const advisor = makeAdvisor('advisor-suggestion');
    const events: Array<{ message: string; details?: unknown }> = [];

    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('custom'),
      executor: executor.callback,
      advisor: advisor.callback,
      logEvent: (message, details) => {
        events.push({ message, details });
      },
    });
    await runSynthesisWorker(input);

    expect(advisor.calls).toBe(1);
    const telemetry = events.find((e) => e.message === 'runtime.run_with_advisor')
      ?.details as AdvisorTelemetry;
    expect(telemetry).toBeDefined();
    expect(telemetry.mode).toBe('custom');
    expect(telemetry.advisor_iterations).toBe(1);
    expect(telemetry.advisor_model).toBe('claude-opus-4-7');
    expect(telemetry.advisor_input_tokens).toBe(30);
    expect(telemetry.advisor_output_tokens).toBe(10);
    expect(telemetry.beta_header_sent).toBe(true);
  });

  test('byte-identical synthesis output across advisor=none and advisor=custom (stubbed model)', async () => {
    const noneExecutor = makeExecutor(JSON.stringify(ANALYSIS_PAYLOAD), false);
    const customExecutor = makeExecutor(JSON.stringify(ANALYSIS_PAYLOAD), true);
    const advisor = makeAdvisor('advisor-suggestion');

    const noneInput = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: noneExecutor.callback,
    });
    const customInput = makeWorkerInput('analysis-report', {
      config: executorConfig('custom'),
      executor: customExecutor.callback,
      advisor: advisor.callback,
    });

    const noneOutput = (await runSynthesisWorker(noneInput)) as AnalysisReportV1;
    const customOutput = (await runSynthesisWorker(customInput)) as AnalysisReportV1;

    // Strip the deterministic-but-time-stamped artifact_id field — every
    // other byte must match across the two runs.
    const stripped = (o: AnalysisReportV1) => ({ ...o, artifact_id: 'normalized' });
    expect(stripped(customOutput)).toEqual(stripped(noneOutput));

    // System prompt differs: advisor-on stamps ADVISOR_TOOL_INSTRUCTIONS in
    // front of the synthesis directive.
    const noneSystem = noneExecutor.calls[0]!.systemPrompt;
    const customSystem = customExecutor.calls[0]!.systemPrompt;
    expect(noneSystem).toBe(SYNTHESIS_SYSTEM_DIRECTIVE);
    expect(customSystem).toContain(ADVISOR_TOOL_INSTRUCTIONS);
    expect(customSystem.endsWith(SYNTHESIS_SYSTEM_DIRECTIVE)).toBe(true);

    // User message body is byte-identical across modes (the JSON Schema +
    // assembled prompt are mode-independent).
    expect(customExecutor.calls[0]!.userMessage).toBe(noneExecutor.calls[0]!.userMessage);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('runSynthesisWorker (LLM path) — error handling', () => {
  test('rejects non-JSON model output with SynthesisValidationError', async () => {
    const executor = makeExecutor('not-valid-json', false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    await expect(runSynthesisWorker(input)).rejects.toBeInstanceOf(SynthesisValidationError);
  });

  test('rejects model output with wrong artifact_type', async () => {
    const wrongType = { ...ANALYSIS_PAYLOAD, artifact_type: 'piorx/change-spec@1' };
    const executor = makeExecutor(JSON.stringify(wrongType), false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    // Worker stamps artifact_type from input.task_type, so the resulting
    // artifact has the right artifact_type — but the body is missing
    // analysis-report fields (no findings/risks/recommended_next_steps).
    // validateWorkerOutput surfaces the validator errors.
    const output = (await runSynthesisWorker(input)) as AnalysisReportV1;
    expect(output.artifact_type).toBe('piorx/analysis-report@1');
    expect(output.findings).toEqual(['Finding 1', 'Finding 2']);
  });

  test('rejects model output missing required fields', async () => {
    const partial = { artifact_type: 'piorx/analysis-report@1', summary: 'ok' };
    const executor = makeExecutor(JSON.stringify(partial), false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    await expect(runSynthesisWorker(input)).rejects.toBeInstanceOf(SynthesisValidationError);
  });
});

// ---------------------------------------------------------------------------
// Stub fallback path (Phase 1 byte-identical guarantee)
// ---------------------------------------------------------------------------

describe('runSynthesisWorker (stub fallback path)', () => {
  test('produces deterministic analysis-report when no llm options are supplied', async () => {
    const bundle = makeBundle();
    const out = (await runSynthesisWorker({
      task_type: 'analysis-report',
      bundle,
      prompt_text: 'unused',
      instructions: '',
    })) as AnalysisReportV1;
    expect(out.artifact_type).toBe('piorx/analysis-report@1');
    expect(out.evidence_bundle_id).toBe(bundle.artifact_id);
    expect(out.summary).toContain('Analysis of');
    const validation = validateArtifact(out);
    expect(validation.valid).toBe(true);
  });

  test('produces deterministic change-spec when no llm options are supplied', async () => {
    const bundle = makeBundle();
    const out = (await runSynthesisWorker({
      task_type: 'change-spec',
      bundle,
      prompt_text: 'unused',
      instructions: '',
    })) as ChangeSpecV1;
    expect(out.artifact_type).toBe('piorx/change-spec@1');
    expect(out.edits.length).toBe(1);
    const validation = validateArtifact(out);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// System prompt integration
// ---------------------------------------------------------------------------

describe('synthesisSystemPrompt', () => {
  test('returns the bare directive when advisor is disabled', () => {
    expect(synthesisSystemPrompt({ advisorEnabled: false })).toBe(SYNTHESIS_SYSTEM_DIRECTIVE);
  });

  test('prepends ADVISOR_TOOL_INSTRUCTIONS verbatim when advisor is enabled', () => {
    const prompt = synthesisSystemPrompt({ advisorEnabled: true });
    expect(prompt.startsWith(ADVISOR_TOOL_INSTRUCTIONS)).toBe(true);
    expect(prompt.endsWith(SYNTHESIS_SYSTEM_DIRECTIVE)).toBe(true);
    // Verbatim text — confirms the canonical opening line from
    // utils/advisor.ts:130 (advisor doc §4.5).
    expect(prompt).toContain(
      'You have access to an `advisor` tool backed by a stronger reviewer model.',
    );
    expect(prompt).toContain('Call advisor BEFORE substantive work');
  });
});

// ---------------------------------------------------------------------------
// validateWorkerOutput re-test for completeness (LLM-path consumers)
// ---------------------------------------------------------------------------

describe('validateWorkerOutput composes with the LLM path', () => {
  test('LLM path consumers can re-validate using the same helper', async () => {
    const executor = makeExecutor(JSON.stringify(ANALYSIS_PAYLOAD), false);
    const input = makeWorkerInput('analysis-report', {
      config: executorConfig('none'),
      executor: executor.callback,
    });
    const out = await runSynthesisWorker(input);
    const re = validateWorkerOutput(out, 'analysis-report');
    expect(re.artifact_type).toBe('piorx/analysis-report@1');
  });
});
