/**
 * `runWithAdvisor` tests (COMP-P2-T2 acceptance).
 *
 * Covers the three modes (`inline`, `custom`, `server`), uniform telemetry
 * shape, the kill-switch (`PIORX_DISABLE_ADVISOR`), and beta-header
 * defense-in-depth (advisor doc §4.2 / §4.3 / §4.6).
 */

import { describe, expect, test } from 'bun:test';
import type { PhaseModelConfig } from '../../src/runtime/config.ts';
import {
  ADVISOR_BETA_HEADER_NAME,
  ADVISOR_BETA_HEADER_VALUE,
  ADVISOR_DISABLE_ENV,
  type AdvisorCallback,
  type AdvisorTelemetry,
  type ExecutorCallback,
  type ExecutorRequest,
  isAdvisorDisabledByEnv,
  runWithAdvisor,
} from '../../src/runtime/run-with-advisor.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function executorConfig(overrides: Partial<PhaseModelConfig> = {}): PhaseModelConfig {
  return {
    executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ...overrides,
  };
}

function makeStubExecutor(): {
  callback: ExecutorCallback;
  calls: ExecutorRequest[];
  setResponse(response: {
    text?: string;
    iterations?: Array<{ type: 'message' | 'advisor_message'; input: number; output: number }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    advisorErrorCode?: string;
  }): void;
} {
  const calls: ExecutorRequest[] = [];
  type IterationPlan = { type: 'message' | 'advisor_message'; input: number; output: number };
  let plan: {
    text: string;
    iterations: IterationPlan[];
    usage: { input_tokens?: number; output_tokens?: number } | undefined;
    advisorErrorCode: string | undefined;
  } = {
    text: 'executor-response',
    iterations: [{ type: 'message', input: 100, output: 50 }],
    usage: undefined,
    advisorErrorCode: undefined,
  };
  return {
    calls,
    setResponse(response) {
      plan = {
        text: response.text ?? plan.text,
        iterations: response.iterations ?? plan.iterations,
        usage: response.usage,
        advisorErrorCode: response.advisorErrorCode,
      };
    },
    callback: async (req) => {
      calls.push(req);
      // Custom-mode: simulate the executor calling the advisor tool once.
      if (req.extras.customAdvisorHandler) {
        await req.extras.customAdvisorHandler({
          systemPrompt: 'advisor-system',
          userMessage: 'advisor-user',
        });
      }
      const response: Awaited<ReturnType<ExecutorCallback>> = {
        text: plan.text,
        iterations: plan.iterations.map((row) => ({
          type: row.type,
          input_tokens: row.input,
          output_tokens: row.output,
        })),
      };
      if (plan.usage) response.usage = plan.usage;
      if (plan.advisorErrorCode) response.advisorErrorCode = plan.advisorErrorCode;
      return response;
    },
  };
}

function makeStubAdvisor(): {
  callback: AdvisorCallback;
  calls: Array<{ systemPrompt: string; userMessage: string }>;
  setResponse(response: {
    text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    errorCode?: string;
  }): void;
} {
  const calls: Array<{ systemPrompt: string; userMessage: string }> = [];
  let plan = {
    text: 'advisor-text',
    usage: { input_tokens: 30, output_tokens: 10 } as
      | { input_tokens?: number; output_tokens?: number }
      | undefined,
    errorCode: undefined as string | undefined,
  };
  return {
    calls,
    setResponse(response) {
      plan = {
        text: response.text ?? plan.text,
        usage: response.usage ?? plan.usage,
        errorCode: response.errorCode,
      };
    },
    callback: async (req) => {
      calls.push(req);
      const response: Awaited<ReturnType<AdvisorCallback>> = { text: plan.text };
      if (plan.usage) response.usage = plan.usage;
      if (plan.errorCode) response.errorCode = plan.errorCode;
      return response;
    },
  };
}

const TELEMETRY_KEYS: Array<keyof AdvisorTelemetry> = [
  'phase',
  'mode',
  'executor_model',
  'executor_provider',
  'advisor_model',
  'advisor_iterations',
  'advisor_input_tokens',
  'advisor_output_tokens',
  'executor_input_tokens',
  'executor_output_tokens',
  'duration_ms',
  'beta_header_sent',
  'disabled_by_env',
  'error_code',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWithAdvisor — kill switch', () => {
  test('isAdvisorDisabledByEnv recognizes truthy values', () => {
    expect(isAdvisorDisabledByEnv({ [ADVISOR_DISABLE_ENV]: '1' })).toBe(true);
    expect(isAdvisorDisabledByEnv({ [ADVISOR_DISABLE_ENV]: 'true' })).toBe(true);
    expect(isAdvisorDisabledByEnv({ [ADVISOR_DISABLE_ENV]: 'YES' })).toBe(true);
    expect(isAdvisorDisabledByEnv({ [ADVISOR_DISABLE_ENV]: 'on' })).toBe(true);
  });

  test('isAdvisorDisabledByEnv treats absent / empty / falsy as off', () => {
    expect(isAdvisorDisabledByEnv({})).toBe(false);
    expect(isAdvisorDisabledByEnv({ [ADVISOR_DISABLE_ENV]: '' })).toBe(false);
    expect(isAdvisorDisabledByEnv({ [ADVISOR_DISABLE_ENV]: '0' })).toBe(false);
    expect(isAdvisorDisabledByEnv({ [ADVISOR_DISABLE_ENV]: 'false' })).toBe(false);
  });

  test('PIORX_DISABLE_ADVISOR=1 forces all advisor calls to be skipped', async () => {
    const executor = makeStubExecutor();
    const advisor = makeStubAdvisor();
    const config = executorConfig({
      advisor: { mode: 'custom', model: 'claude-opus-4-7' },
    });

    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'hi' },
      {
        phase: 'synthesis',
        config,
        executor: executor.callback,
        advisor: advisor.callback,
        env: { [ADVISOR_DISABLE_ENV]: '1' },
      },
    );

    expect(advisor.calls).toHaveLength(0);
    expect(result.disabledByEnv).toBe(true);
    expect(result.telemetry.disabled_by_env).toBe(true);
    expect(result.telemetry.beta_header_sent).toBe(false);
    // executor still ran solo
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.extras.customAdvisorHandler).toBeNull();
    expect(executor.calls[0]?.extras.serverAdvisor).toBeNull();
  });
});

describe('runWithAdvisor — telemetry uniformity', () => {
  test('all three modes emit a record with the same shape', async () => {
    const records: AdvisorTelemetry[] = [];

    for (const mode of ['inline', 'custom', 'server'] as const) {
      const executor = makeStubExecutor();
      const advisor = makeStubAdvisor();
      const config = executorConfig({
        advisor: { mode, model: 'claude-opus-4-7' },
      });

      const result = await runWithAdvisor(
        { systemPrompt: 'sys', userMessage: 'hi' },
        {
          phase: 'synthesis',
          config,
          executor: executor.callback,
          advisor: advisor.callback,
          now: () => records.length, // deterministic, monotonic
        },
      );
      records.push(result.telemetry);
    }

    expect(records).toHaveLength(3);
    for (const record of records) {
      const keys = Object.keys(record).sort();
      expect(keys).toEqual([...TELEMETRY_KEYS].sort());
      expect(record.executor_model).toBe('claude-sonnet-4-6');
      expect(record.executor_provider).toBe('anthropic');
      expect(record.advisor_model).toBe('claude-opus-4-7');
      expect(record.disabled_by_env).toBe(false);
      expect(record.error_code).toBeNull();
    }
    expect(records.map((r) => r.mode)).toEqual(['inline', 'custom', 'server']);
  });

  test('mode=none records advisor_model: null and beta_header_sent: false', async () => {
    const executor = makeStubExecutor();
    const config = executorConfig();
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'hi' },
      { phase: 'restatement', config, executor: executor.callback },
    );
    expect(result.telemetry.mode).toBe('none');
    expect(result.telemetry.advisor_model).toBeNull();
    expect(result.telemetry.beta_header_sent).toBe(false);
    expect(result.telemetry.advisor_iterations).toBe(0);
  });

  test('logEvent receives the telemetry record once per call', async () => {
    const executor = makeStubExecutor();
    const events: Array<{ message: string; details: unknown }> = [];
    const config = executorConfig({ advisor: { mode: 'custom', model: 'claude-opus-4-7' } });
    await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'hi' },
      {
        phase: 'synthesis',
        config,
        executor: executor.callback,
        advisor: makeStubAdvisor().callback,
        logEvent: (message, details) => {
          events.push({ message, details });
        },
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe('runtime.run_with_advisor');
  });
});

describe('runWithAdvisor — mode dispatch', () => {
  test('inline mode runs the advisor first and prepends the plan', async () => {
    const executor = makeStubExecutor();
    const advisor = makeStubAdvisor();
    advisor.setResponse({ text: 'do A then B', usage: { input_tokens: 5, output_tokens: 7 } });

    const config = executorConfig({ advisor: { mode: 'inline', model: 'claude-opus-4-7' } });
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      {
        phase: 'expansion',
        config,
        executor: executor.callback,
        advisor: advisor.callback,
      },
    );

    expect(advisor.calls).toHaveLength(1);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.userMessage).toContain('<advisor_plan>');
    expect(executor.calls[0]?.userMessage).toContain('do A then B');
    expect(executor.calls[0]?.userMessage).toContain('task');
    expect(executor.calls[0]?.extras.customAdvisorHandler).toBeNull();
    expect(executor.calls[0]?.extras.serverAdvisor).toBeNull();
    expect(result.telemetry.advisor_iterations).toBe(1);
    expect(result.telemetry.advisor_input_tokens).toBe(5);
    expect(result.telemetry.advisor_output_tokens).toBe(7);
  });

  test('custom mode wraps the advisor as a tool callback', async () => {
    const executor = makeStubExecutor();
    const advisor = makeStubAdvisor();
    advisor.setResponse({ text: 'plan', usage: { input_tokens: 12, output_tokens: 4 } });

    const config = executorConfig({ advisor: { mode: 'custom', model: 'claude-opus-4-7' } });
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'work' },
      {
        phase: 'synthesis',
        config,
        executor: executor.callback,
        advisor: advisor.callback,
      },
    );

    // executor stub's makeStubExecutor invokes the handler exactly once
    expect(advisor.calls).toHaveLength(1);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.extras.customAdvisorHandler).not.toBeNull();
    expect(executor.calls[0]?.extras.serverAdvisor).toBeNull();
    expect(executor.calls[0]?.userMessage).toBe('work');
    // Custom mode routes the advisor's usage into the iteration list.
    expect(result.telemetry.advisor_iterations).toBe(1);
    expect(result.telemetry.advisor_input_tokens).toBe(12);
    expect(result.telemetry.advisor_output_tokens).toBe(4);
  });

  test('server mode forwards a server-tool block and the beta header', async () => {
    const executor = makeStubExecutor();
    executor.setResponse({
      text: 'done',
      iterations: [
        { type: 'message', input: 200, output: 80 },
        { type: 'advisor_message', input: 50, output: 20 },
        { type: 'advisor_message', input: 30, output: 15 },
      ],
    });

    const config = executorConfig({
      advisor: {
        mode: 'server',
        model: 'claude-opus-4-7',
        maxUses: 3,
        caching: 'ephemeral-5m',
      },
    });
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      {
        phase: 'synthesis',
        config,
        executor: executor.callback,
        // No advisor callback required in server mode.
      },
    );

    expect(executor.calls).toHaveLength(1);
    const extras = executor.calls[0]!.extras;
    expect(extras.serverAdvisor).toEqual({
      type: 'advisor_20260301',
      name: 'advisor',
      model: 'claude-opus-4-7',
      max_uses: 3,
      caching: { type: 'ephemeral', ttl: '5m' },
    });
    expect(extras.headers[ADVISOR_BETA_HEADER_NAME]).toBe(ADVISOR_BETA_HEADER_VALUE);
    // Server-mode telemetry pulls advisor rows out of executor iterations.
    expect(result.telemetry.advisor_iterations).toBe(2);
    expect(result.telemetry.advisor_input_tokens).toBe(80);
    expect(result.telemetry.advisor_output_tokens).toBe(35);
    expect(result.telemetry.executor_input_tokens).toBe(200);
    expect(result.telemetry.executor_output_tokens).toBe(80);
  });

  test('server mode without advisor.model raises before calling the executor', async () => {
    const executor = makeStubExecutor();
    const config: PhaseModelConfig = {
      executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      advisor: { mode: 'server' },
    };
    await expect(
      runWithAdvisor(
        { systemPrompt: 'sys', userMessage: 'task' },
        { phase: 'synthesis', config, executor: executor.callback },
      ),
    ).rejects.toThrow(/server mode requires advisor\.model/);
    expect(executor.calls).toHaveLength(0);
  });

  test('custom / inline modes throw when advisor callback is missing', async () => {
    const executor = makeStubExecutor();
    for (const mode of ['custom', 'inline'] as const) {
      const config = executorConfig({ advisor: { mode, model: 'claude-opus-4-7' } });
      await expect(
        runWithAdvisor(
          { systemPrompt: 'sys', userMessage: 'task' },
          { phase: 'synthesis', config, executor: executor.callback },
        ),
      ).rejects.toThrow(/advisor callback is required/);
    }
  });
});

describe('runWithAdvisor — defense-in-depth', () => {
  test('beta header is added when advisor is enabled, omitted when not', async () => {
    const executor = makeStubExecutor();
    const advisor = makeStubAdvisor();
    const enabledConfig = executorConfig({
      advisor: { mode: 'custom', model: 'claude-opus-4-7' },
    });
    await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      {
        phase: 'synthesis',
        config: enabledConfig,
        executor: executor.callback,
        advisor: advisor.callback,
      },
    );
    expect(executor.calls[0]?.extras.headers[ADVISOR_BETA_HEADER_NAME]).toBe(
      ADVISOR_BETA_HEADER_VALUE,
    );

    const executor2 = makeStubExecutor();
    const noneConfig = executorConfig();
    await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      { phase: 'restatement', config: noneConfig, executor: executor2.callback },
    );
    expect(executor2.calls[0]?.extras.headers[ADVISOR_BETA_HEADER_NAME]).toBeUndefined();
  });

  test('shared-history phases force the beta header even with advisor=none', async () => {
    const executor = makeStubExecutor();
    const config = executorConfig();
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      {
        phase: 'restatement',
        config,
        executor: executor.callback,
        sharedHistory: true,
      },
    );
    expect(executor.calls[0]?.extras.headers[ADVISOR_BETA_HEADER_NAME]).toBe(
      ADVISOR_BETA_HEADER_VALUE,
    );
    expect(result.telemetry.beta_header_sent).toBe(true);
  });

  test('advisor blocks are stripped from user message when beta is not sent', async () => {
    const executor = makeStubExecutor();
    const userMessage =
      'before <advisor_tool_result>secret</advisor_tool_result> middle <advisor_tool_result>x</advisor_tool_result> after';
    const config = executorConfig();
    await runWithAdvisor(
      { systemPrompt: 'sys', userMessage },
      { phase: 'restatement', config, executor: executor.callback },
    );
    expect(executor.calls[0]?.userMessage).toBe('before  middle  after');
  });

  test('advisor blocks survive when beta is sent', async () => {
    const executor = makeStubExecutor();
    const advisor = makeStubAdvisor();
    const userMessage = 'turn <advisor_tool_result>plan</advisor_tool_result> end';
    const config = executorConfig({ advisor: { mode: 'custom', model: 'claude-opus-4-7' } });
    await runWithAdvisor(
      { systemPrompt: 'sys', userMessage },
      {
        phase: 'synthesis',
        config,
        executor: executor.callback,
        advisor: advisor.callback,
      },
    );
    expect(executor.calls[0]?.userMessage).toBe(userMessage);
  });

  test('disabled-by-env wins over an enabled advisor config', async () => {
    const executor = makeStubExecutor();
    const advisor = makeStubAdvisor();
    const config = executorConfig({ advisor: { mode: 'server', model: 'claude-opus-4-7' } });
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      {
        phase: 'synthesis',
        config,
        executor: executor.callback,
        advisor: advisor.callback,
        env: { [ADVISOR_DISABLE_ENV]: 'true' },
      },
    );
    expect(executor.calls[0]?.extras.serverAdvisor).toBeNull();
    expect(executor.calls[0]?.extras.headers[ADVISOR_BETA_HEADER_NAME]).toBeUndefined();
    expect(result.disabledByEnv).toBe(true);
  });
});

describe('runWithAdvisor — error surfacing', () => {
  test('advisor error code surfaces in telemetry (custom mode)', async () => {
    const executor = makeStubExecutor();
    const advisor = makeStubAdvisor();
    advisor.setResponse({ text: '', errorCode: 'max_uses_exceeded' });

    const config = executorConfig({
      advisor: { mode: 'custom', model: 'claude-opus-4-7', maxUses: 1 },
    });
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      {
        phase: 'synthesis',
        config,
        executor: executor.callback,
        advisor: advisor.callback,
      },
    );
    expect(result.telemetry.error_code).toBe('max_uses_exceeded');
  });

  test('advisor error code surfaces in telemetry (server mode)', async () => {
    const executor = makeStubExecutor();
    executor.setResponse({
      text: 'done',
      iterations: [{ type: 'message', input: 100, output: 50 }],
      advisorErrorCode: 'overloaded',
    });

    const config = executorConfig({
      advisor: { mode: 'server', model: 'claude-opus-4-7' },
    });
    const result = await runWithAdvisor(
      { systemPrompt: 'sys', userMessage: 'task' },
      { phase: 'synthesis', config, executor: executor.callback },
    );
    expect(result.telemetry.error_code).toBe('overloaded');
  });
});
