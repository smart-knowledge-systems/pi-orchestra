/**
 * Retriever agent-loop tests — Phase 4 (COMP-P4-T3).
 *
 * Covers the four canonical assertions for the new `runRetrieverAgentLoop`
 * (per `docs/composability.md` "Phase 4 gate"):
 *
 *   1. Bounded budgets — turn cap + executor budget. The loop never runs
 *      more turns than `limits.maxRounds`; it never reads more files than
 *      `limits.maxFileReads`; the abort signal trips when caps fire.
 *   2. Stop reasons — the four-way reason set:
 *        - `agent_stopped` when the model calls `submit_recommendation`.
 *        - `round_cap`     when the loop runs out of turns.
 *        - `model_error`   when the executor / streamFn throws.
 *        - `parse_error`   when `submit_recommendation` is called with a
 *                          payload the parser cannot accept.
 *   3. Fallback recommendation — when the loop ends without a valid
 *      `submit_recommendation` call, a deterministic scout-derived
 *      recommendation is synthesized so downstream stages always get a
 *      result.
 *   4. Sanitization — out-of-repo paths in the final recommendation are
 *      dropped with a recorded warning.
 *
 * The tests stub `streamFn` so they exercise the real `agentLoop` from
 * `@mariozechner/pi-agent-core` end-to-end (tool registration, execution,
 * tool-result message construction) without spinning up pi-ai. Each
 * stubbed turn returns one `AssistantMessage` containing pre-baked tool
 * calls; pi-agent-core's loop drives the actual tool execution.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type ToolCall,
} from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';

import { runRetrieverAgentLoop } from '../../src/retriever/agent-loop.ts';
import type { AgentLoopRunInput } from '../../src/retriever/agent-loop.ts';
import { runScout, type ScoutResult } from '../../src/retriever/scout.ts';
import type { AgentLimits } from '../../src/retriever/agent-types.ts';

// ---------------------------------------------------------------------------
// Fixture repo setup
// ---------------------------------------------------------------------------

let tempDir: string;

async function writeRepo(tree: Record<string, string>): Promise<void> {
  for (const [relPath, contents] of Object.entries(tree)) {
    const absolute = resolve(tempDir, relPath);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents, 'utf-8');
  }
}

async function scoutFor(query: string, taggedFiles: string[] = []): Promise<ScoutResult> {
  return runScout({
    repoRoot: tempDir,
    restatedIntent: query,
    retrievalFocus: [],
    taggedFiles,
  });
}

function tinyLimits(overrides?: Partial<AgentLimits>): Partial<AgentLimits> {
  return {
    maxRounds: 2,
    maxActionsPerRound: 2,
    maxFileReads: 4,
    maxLinesPerRead: 50,
    maxBytesPerRead: 4096,
    maxObservationBudgetBytes: 32 * 1024,
    maxContentSearchHits: 8,
    maxPathSearchMatches: 8,
    ...overrides,
  };
}

async function makeInput(
  query: string,
  limits: Partial<AgentLimits>,
  taggedFiles: string[] = [],
): Promise<AgentLoopRunInput> {
  const scout = await scoutFor(query, taggedFiles);
  return {
    repoRoot: tempDir,
    intent: { cleanedIntent: query, restatedIntent: query, taggedFiles },
    scout,
    limits,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'piorx-agentloop-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stub streamFn — emits canned tool calls per turn
// ---------------------------------------------------------------------------

interface CannedTurn {
  /** Tool calls to emit on this turn. Empty array = stop turn (no tool calls). */
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Optional textual content the model says before tool calls. */
  text?: string;
  /** Optional override of stopReason. */
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  /** When true, the streamFn throws — exercises the model_error path. */
  throw?: string;
}

function buildAssistantMessage(turn: CannedTurn): AssistantMessage {
  let nextId = 1;
  const content: AssistantMessage['content'] = [];
  if (turn.text) {
    content.push({ type: 'text', text: turn.text });
  }
  for (const call of turn.toolCalls) {
    const toolCall: ToolCall = {
      type: 'toolCall',
      id: `call_${nextId++}_${call.name}`,
      name: call.name,
      arguments: call.arguments,
    };
    content.push(toolCall);
  }
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages' as any,
    provider: 'anthropic' as any,
    model: 'stub-model',
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: turn.stopReason ?? (turn.toolCalls.length > 0 ? 'toolUse' : 'stop'),
    timestamp: Date.now(),
  };
}

function emitTurn(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  // pi-agent-core only requires `start` + `done` events for the loop to
  // accept the assistant response and proceed to tool execution.
  stream.push({ type: 'start', partial: message });
  stream.push({
    type: 'done',
    reason: message.stopReason as 'stop' | 'length' | 'toolUse',
    message,
  });
}

interface StubStreamFn {
  fn: StreamFn;
  /** Number of times the stream was invoked (one per LLM turn). */
  callCount: () => number;
}

function makeStreamFn(turns: CannedTurn[]): StubStreamFn {
  let invocations = 0;
  const fn: StreamFn = ((_model: any, _context: any, options: any) => {
    invocations += 1;
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      const aborted = buildAssistantMessage({ toolCalls: [], stopReason: 'aborted' });
      aborted.errorMessage = 'aborted by signal';
      queueMicrotask(() => stream.push({ type: 'error', reason: 'aborted', error: aborted }));
      return stream;
    }
    const turn = turns[invocations - 1] ?? turns[turns.length - 1] ?? { toolCalls: [] };
    if (turn.throw) {
      const errorMessage = buildAssistantMessage({ toolCalls: [], stopReason: 'error' });
      errorMessage.errorMessage = turn.throw;
      queueMicrotask(() => stream.push({ type: 'error', reason: 'error', error: errorMessage }));
      return stream;
    }
    queueMicrotask(() => emitTurn(stream, buildAssistantMessage(turn)));
    return stream;
  }) as StreamFn;
  return { fn, callCount: () => invocations };
}

// ---------------------------------------------------------------------------
// Recommendation payload builder (matches AgentFinalRecommendation)
// ---------------------------------------------------------------------------

function makeRecommendationPayload(
  files: Array<{ path: string; tier?: 'selected' | 'reserve' }>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    strategy_summary: overrides.strategy_summary ?? 'narrowed via stub model',
    files: files.map((f) => ({
      path: f.path,
      tier: f.tier ?? 'selected',
      default_evidence_mode: 'spans',
      selection_reason: 'stub-driven',
      include_ast_skeleton: true,
      include_retriever_summary: true,
      include_entire_file: false,
      symbols: [],
    })),
    cross_file_findings: [],
    gaps: [],
    followup_queries: [],
    include_cross_file_findings: false,
    include_gaps: false,
    include_followup_queries: false,
    confidence: 'medium',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Bounded budgets
// ---------------------------------------------------------------------------

describe('runRetrieverAgentLoop bounded budgets', () => {
  test('respects maxRounds — never exceeds the configured turn cap', async () => {
    await writeRepo({
      'src/handler.ts': 'export function handler() { return "hello"; }\n',
    });

    // Every turn the model emits a search_paths call but never calls
    // submit_recommendation. The loop must hit the round cap.
    const turns: CannedTurn[] = Array.from({ length: 5 }, () => ({
      toolCalls: [
        {
          name: 'search_paths',
          arguments: { term: 'handler', reason: 'looking for handlers' },
        },
      ],
    }));
    const { fn, callCount } = makeStreamFn(turns);

    const input = await makeInput('find handler', tinyLimits({ maxRounds: 2 }));
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    expect(result.telemetry.stopReason).toBe('round_cap');
    // The agent runs at most maxRounds + 1 turns (the +1 is the turn
    // whose convertToLlm hook tripped the abort signal).
    expect(callCount()).toBeLessThanOrEqual(3);
    expect(result.recommendation.strategy_summary).toContain('fallback');
  });

  test('honors maxFileReads — read budget is enforced through the executor', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeRepo({
      'src/a.ts': lines,
      'src/b.ts': lines,
      'src/c.ts': lines,
      'src/d.ts': lines,
    });

    // Model asks to read 4 files in turn 1, then submits a recommendation
    // in turn 2. With maxFileReads=2 only the first two reads count;
    // subsequent reads should be reflected in fileReadsExecuted ≤ 2.
    const turns: CannedTurn[] = [
      {
        toolCalls: [
          { name: 'read_file', arguments: { path: 'src/a.ts', mode: 'full', reason: 'inspect' } },
          { name: 'read_file', arguments: { path: 'src/b.ts', mode: 'full', reason: 'inspect' } },
          { name: 'read_file', arguments: { path: 'src/c.ts', mode: 'full', reason: 'inspect' } },
        ],
      },
      {
        toolCalls: [
          {
            name: 'submit_recommendation',
            arguments: {
              recommendation: makeRecommendationPayload([{ path: 'src/a.ts' }]),
            },
          },
        ],
      },
    ];
    const { fn } = makeStreamFn(turns);

    const input = await makeInput('inspect files', tinyLimits({ maxFileReads: 2, maxRounds: 4 }));
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    expect(result.telemetry.fileReadsExecuted).toBeLessThanOrEqual(2);
    expect(result.telemetry.stopReason).toBe('agent_stopped');
  });
});

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

describe('runRetrieverAgentLoop stop reasons', () => {
  test('agent_stopped — submit_recommendation ends the run cleanly', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const turns: CannedTurn[] = [
      {
        toolCalls: [
          {
            name: 'submit_recommendation',
            arguments: {
              recommendation: makeRecommendationPayload([{ path: 'src/a.ts' }], {
                confidence: 'high',
              }),
            },
          },
        ],
      },
    ];
    const { fn } = makeStreamFn(turns);

    const input = await makeInput('a', tinyLimits());
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    expect(result.telemetry.stopReason).toBe('agent_stopped');
    expect(result.recommendation.confidence).toBe('high');
    expect(result.recommendation.files.map((f) => f.path)).toContain('src/a.ts');
    expect(result.recommendation.strategy_summary).not.toContain('fallback');
  });

  test('round_cap — exhausts turn budget without submit_recommendation', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    // Every turn the model just emits a search_paths call.
    const turn: CannedTurn = {
      toolCalls: [
        {
          name: 'search_paths',
          arguments: { term: 'A', reason: 'enumerate' },
        },
      ],
    };
    const { fn } = makeStreamFn([turn, turn, turn, turn, turn]);

    const input = await makeInput('a', tinyLimits({ maxRounds: 2 }));
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    expect(result.telemetry.stopReason).toBe('round_cap');
    expect(result.recommendation.strategy_summary).toContain('fallback');
  });

  test('model_error — streamFn surfaces an error event', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const turns: CannedTurn[] = [{ toolCalls: [], throw: 'upstream LLM failure' }];
    const { fn } = makeStreamFn(turns);

    const input = await makeInput('a', tinyLimits());
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    expect(result.telemetry.stopReason).toBe('model_error');
    expect(result.telemetry.warnings.some((w) => w.includes('upstream LLM failure'))).toBe(true);
    // Fallback kicks in.
    expect(result.recommendation.strategy_summary).toContain('fallback');
  });

  test('parse_error — submit_recommendation called with an invalid payload falls back', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    // First turn: submit a malformed recommendation (no files, no summary).
    // Second turn: stop with no further tool calls.
    const turns: CannedTurn[] = [
      {
        toolCalls: [
          {
            name: 'submit_recommendation',
            arguments: { recommendation: { not_a_real_field: true } },
          },
        ],
      },
      { toolCalls: [], stopReason: 'stop' },
    ];
    const { fn } = makeStreamFn(turns);

    const input = await makeInput('a', tinyLimits({ maxRounds: 3 }));
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    // The malformed recommendation is rejected at the tool boundary (warn
    // recorded), the loop runs to its turn cap, and the deterministic
    // fallback is synthesized.
    expect(result.telemetry.stopReason).toBe('parse_error');
    expect(result.telemetry.warnings.some((w) => w.includes('invalid'))).toBe(true);
    expect(result.recommendation.strategy_summary).toContain('fallback');
  });
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe('runRetrieverAgentLoop sanitization', () => {
  test('out-of-repo paths in submit_recommendation are dropped with a warning', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const turns: CannedTurn[] = [
      {
        toolCalls: [
          {
            name: 'submit_recommendation',
            arguments: {
              recommendation: makeRecommendationPayload([
                { path: '/etc/passwd' },
                { path: 'src/a.ts' },
              ]),
            },
          },
        ],
      },
    ];
    const { fn } = makeStreamFn(turns);

    const input = await makeInput('a', tinyLimits());
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    const paths = result.recommendation.files.map((f) => f.path);
    expect(paths).toContain('src/a.ts');
    expect(paths.some((p) => p.includes('passwd'))).toBe(false);
    expect(result.telemetry.warnings.some((w) => w.includes('out-of-repo'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Advisor as a Tool
// ---------------------------------------------------------------------------

describe('runRetrieverAgentLoop advisor tool', () => {
  test('advisor is registered as a Tool and invocable from the loop', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    let advisorCalls = 0;

    const turns: CannedTurn[] = [
      {
        toolCalls: [
          {
            name: 'advisor',
            arguments: {},
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'submit_recommendation',
            arguments: {
              recommendation: makeRecommendationPayload([{ path: 'src/a.ts' }]),
            },
          },
        ],
      },
    ];
    const { fn } = makeStreamFn(turns);

    const input = await makeInput('a', tinyLimits({ maxRounds: 4 }));
    const result = await runRetrieverAgentLoop(input, {
      streamFn: fn,
      advisor: async () => {
        advisorCalls += 1;
        return {
          content: 'advisor: prefer the spans evidence mode for src/a.ts',
          details: { ok: true, model: 'claude-opus-4-7' },
        };
      },
    });

    expect(advisorCalls).toBe(1);
    expect(result.telemetry.stopReason).toBe('agent_stopped');
    expect(result.recommendation.files.map((f) => f.path)).toContain('src/a.ts');
  });

  test('advisor tool returns a no-op when no advisor callback is wired', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const turns: CannedTurn[] = [
      {
        toolCalls: [{ name: 'advisor', arguments: {} }],
      },
      {
        toolCalls: [
          {
            name: 'submit_recommendation',
            arguments: {
              recommendation: makeRecommendationPayload([{ path: 'src/a.ts' }]),
            },
          },
        ],
      },
    ];
    const { fn } = makeStreamFn(turns);

    const input = await makeInput('a', tinyLimits({ maxRounds: 4 }));
    const result = await runRetrieverAgentLoop(input, { streamFn: fn });

    expect(result.telemetry.stopReason).toBe('agent_stopped');
    expect(result.recommendation.files.map((f) => f.path)).toContain('src/a.ts');
  });
});
