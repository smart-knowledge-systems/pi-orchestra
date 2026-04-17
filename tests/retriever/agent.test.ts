/**
 * Tests for the bounded retriever agent loop (AR-P4-T4).
 *
 * Covers:
 *   - Agent stops within configured round/action bounds.
 *   - File-read actions flow through the deterministic executor.
 *   - `follow_imports` observations resolve targets inside the repo.
 *   - Model-error, parse-error, action-cap, and agent-stopped termination.
 *   - Final recommendation can be narrower and better justified than the
 *     scout-only candidate set (false-positive rejection).
 *
 * The tests avoid any pi-host dependency: the model is injected as a plain
 * callback that returns canned JSON per round, keeping the agent loop as the
 * only subject under test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runRetrieverAgent } from '../../src/retriever/agent.ts';
import { runScout } from '../../src/retriever/scout.ts';
import type {
  AgentLimits,
  AgentModelCallback,
  AgentRunInput,
} from '../../src/retriever/agent-types.ts';
import type { ScoutResult } from '../../src/retriever/scout.ts';

// ---------------------------------------------------------------------------
// Fixture repo + scout setup
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

/** Queue-backed model that returns each message in order, ignoring prompt. */
function queueModel(messages: string[]): {
  model: AgentModelCallback;
  calls: Array<{ round: number; userPrompt: string }>;
} {
  const calls: Array<{ round: number; userPrompt: string }> = [];
  let index = 0;
  const model: AgentModelCallback = async ({ round, userPrompt }) => {
    calls.push({ round, userPrompt });
    const message = messages[index] ?? messages[messages.length - 1] ?? '';
    index++;
    return message;
  };
  return { model, calls };
}

async function makeInput(
  query: string,
  model: AgentModelCallback,
  limits: Partial<AgentLimits>,
  taggedFiles: string[] = [],
): Promise<AgentRunInput> {
  const scout = await scoutFor(query, taggedFiles);
  return {
    repoRoot: tempDir,
    intent: { cleanedIntent: query, restatedIntent: query, taggedFiles },
    scout,
    model,
    limits,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'piorx-agent-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Bounded behavior
// ---------------------------------------------------------------------------

describe('runRetrieverAgent bounded behavior', () => {
  test('respects maxRounds — never executes more rounds than allowed', async () => {
    await writeRepo({
      'src/handler.ts': 'export function handler() { return "hello"; }\n',
    });

    const continueResponse = JSON.stringify({
      status: 'continue',
      summary: 'keep looking',
      actions: [
        {
          type: 'search_paths',
          term: 'handler',
          reason: 'find more handlers',
        },
      ],
    });

    // Supply more continue responses than allowed rounds.
    const { model, calls } = queueModel([
      continueResponse,
      continueResponse,
      continueResponse,
      continueResponse,
    ]);

    const input = await makeInput('find handler', model, tinyLimits({ maxRounds: 2 }));
    const result = await runRetrieverAgent(input);

    expect(result.telemetry.roundsExecuted).toBe(2);
    expect(result.telemetry.stopReason).toBe('round_cap');
    expect(calls.length).toBe(2);
    // Fallback recommendation is synthesised from the scout when the loop
    // hits the round cap without a recommendation.
    expect(result.recommendation.strategy_summary).toContain('fallback');
  });

  test('caps actions per round — extra actions are dropped', async () => {
    await writeRepo({
      'src/a.ts': 'export const A = 1;\n',
      'src/b.ts': 'export const B = 2;\n',
      'src/c.ts': 'export const C = 3;\n',
    });

    const manyActions = JSON.stringify({
      status: 'continue',
      summary: 'ask for too many actions',
      actions: [
        { type: 'search_paths', term: 'a', reason: 'look for a' },
        { type: 'search_paths', term: 'b', reason: 'look for b' },
        { type: 'search_paths', term: 'c', reason: 'look for c' },
        { type: 'search_paths', term: 'd', reason: 'look for d' },
      ],
    });
    const stopResponse = JSON.stringify({
      status: 'stop',
      summary: 'done',
      recommendation: {
        strategy_summary: 'narrowed set',
        files: [
          {
            path: 'src/a.ts',
            tier: 'selected',
            default_evidence_mode: 'spans',
            selection_reason: 'primary target',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'medium',
      },
    });

    const { model } = queueModel([manyActions, stopResponse]);
    const input = await makeInput('find a', model, tinyLimits({ maxActionsPerRound: 2 }));
    const result = await runRetrieverAgent(input);

    expect(result.trace[0]!.actions.length).toBe(2);
    expect(result.telemetry.actionsExecuted).toBe(2);
  });

  test('executes read_file action through the executor and surfaces bounded lines', async () => {
    const body = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeRepo({ 'src/sample.ts': body });

    const readAction = JSON.stringify({
      status: 'continue',
      summary: 'inspect sample',
      actions: [
        {
          type: 'read_file',
          path: 'src/sample.ts',
          mode: 'full',
          reason: 'need to see the sample',
        },
      ],
    });
    const stop = JSON.stringify({
      status: 'stop',
      summary: 'seen enough',
      recommendation: {
        strategy_summary: 'just verified the sample',
        files: [
          {
            path: 'src/sample.ts',
            tier: 'selected',
            default_evidence_mode: 'spans',
            selection_reason: 'verified contents',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'medium',
      },
    });

    const { model } = queueModel([readAction, stop]);
    const input = await makeInput('sample', model, tinyLimits());
    const result = await runRetrieverAgent(input);

    expect(result.telemetry.stopReason).toBe('agent_stopped');
    expect(result.telemetry.fileReadsExecuted).toBe(1);
    const obs = result.trace[0]!.observations[0]!;
    expect(obs.action).toBe('read_file');
    if (obs.action !== 'read_file') return;
    expect(obs.path).toBe('src/sample.ts');
    expect(obs.lines.length).toBe(6);
    expect(obs.lines[0]).toBe('line 1');
    expect(obs.lines[5]).toBe('line 6');
    expect(obs.start).toBe(1);
    expect(obs.totalLines).toBe(6);
  });

  test('follow_imports resolves relative import targets inside the repo', async () => {
    await writeRepo({
      'src/main.ts': [
        'import { handler } from "./handler.ts";',
        'import { util } from "./lib/util.ts";',
        'import external from "external-package";',
        'export function main() { handler(util()); }',
      ].join('\n'),
      'src/handler.ts': 'export function handler(v: string) { return v; }\n',
      'src/lib/util.ts': 'export function util() { return "x"; }\n',
    });

    const followAction = JSON.stringify({
      status: 'continue',
      summary: 'follow imports',
      actions: [
        {
          type: 'follow_imports',
          path: 'src/main.ts',
          reason: 'trace dependencies',
        },
      ],
    });
    const stop = JSON.stringify({
      status: 'stop',
      summary: 'done tracing',
      recommendation: {
        strategy_summary: 'traced',
        files: [
          {
            path: 'src/main.ts',
            tier: 'selected',
            default_evidence_mode: 'spans',
            selection_reason: 'entry point',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'medium',
      },
    });

    const { model } = queueModel([followAction, stop]);
    const input = await makeInput('main handler', model, tinyLimits());
    const result = await runRetrieverAgent(input);

    const obs = result.trace[0]!.observations[0]!;
    expect(obs.action).toBe('follow_imports');
    if (obs.action !== 'follow_imports') return;
    expect(obs.path).toBe('src/main.ts');
    const sources = obs.imports.map((i) => i.source);
    expect(sources).toContain('./handler.ts');
    expect(sources).toContain('./lib/util.ts');
    expect(sources).toContain('external-package');
    const resolvedByName = new Map(obs.imports.map((i) => [i.source, i.resolved]));
    expect(resolvedByName.get('./handler.ts')).toBe('src/handler.ts');
    expect(resolvedByName.get('./lib/util.ts')).toBe('src/lib/util.ts');
    // External packages remain unresolved.
    expect(resolvedByName.get('external-package')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stop reasons + error handling
// ---------------------------------------------------------------------------

describe('runRetrieverAgent stop reasons', () => {
  test('stops with agent_stopped when the model returns a valid recommendation', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const stop = JSON.stringify({
      status: 'stop',
      summary: 'finished',
      recommendation: {
        strategy_summary: 'single file target',
        files: [
          {
            path: 'src/a.ts',
            tier: 'selected',
            default_evidence_mode: 'summary',
            selection_reason: 'only interesting file',
            include_ast_skeleton: false,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'high',
      },
    });

    const { model } = queueModel([stop]);
    const input = await makeInput('a', model, tinyLimits());
    const result = await runRetrieverAgent(input);

    expect(result.telemetry.stopReason).toBe('agent_stopped');
    expect(result.recommendation.confidence).toBe('high');
    expect(result.recommendation.files[0]!.path).toBe('src/a.ts');
  });

  test('treats empty continue as action_cap stop', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const emptyContinue = JSON.stringify({
      status: 'continue',
      summary: 'nothing to do',
      actions: [],
    });
    const { model } = queueModel([emptyContinue]);
    const input = await makeInput('a', model, tinyLimits());
    const result = await runRetrieverAgent(input);

    expect(result.telemetry.stopReason).toBe('action_cap');
    // Fallback kicks in because the agent never produced a recommendation.
    expect(result.recommendation.strategy_summary).toContain('fallback');
  });

  test('records model_error when the callback throws', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const model: AgentModelCallback = async () => {
      throw new Error('upstream failure');
    };
    const input = await makeInput('a', model, tinyLimits());
    const result = await runRetrieverAgent(input);

    expect(result.telemetry.stopReason).toBe('model_error');
    expect(result.telemetry.warnings.some((w) => w.includes('upstream failure'))).toBe(true);
  });

  test('records parse_error when the callback returns non-JSON', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const { model } = queueModel(['this is not JSON at all']);
    const input = await makeInput('a', model, tinyLimits());
    const result = await runRetrieverAgent(input);

    expect(result.telemetry.stopReason).toBe('parse_error');
    expect(result.recommendation.strategy_summary).toContain('fallback');
  });
});

// ---------------------------------------------------------------------------
// False-positive rejection + narrower final selection
// ---------------------------------------------------------------------------

describe('runRetrieverAgent narrows scout candidates', () => {
  test('drops false-positive candidates and keeps only justified files', async () => {
    // Two files both match the literal term "handler" in the scout, but only
    // one is actually relevant — the other is a distractor the agent rejects.
    await writeRepo({
      'src/request-handler.ts':
        'export function handleRequest(req: Request) {\n  return new Response("ok");\n}\n',
      'src/unrelated-handler.ts':
        '// unrelated — copy-pasted identifier\nexport const HANDLER = "unrelated";\n',
      'src/lib/util.ts': 'export function util() { return 1; }\n',
    });

    const scout = await scoutFor('investigate the request handler');
    // Scout should see at least one file in its selected tier.
    expect(scout.selected.length).toBeGreaterThan(0);

    const stop = JSON.stringify({
      status: 'stop',
      summary: 'only the request handler is relevant',
      recommendation: {
        strategy_summary:
          'Dropped src/unrelated-handler.ts: it shares the token but is unrelated. Kept src/request-handler.ts because it defines handleRequest.',
        files: [
          {
            path: 'src/request-handler.ts',
            tier: 'selected',
            default_evidence_mode: 'spans',
            selection_reason: 'defines handleRequest',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [
              {
                name: 'handleRequest',
                start: 1,
                count: 3,
                selected_by_default: true,
                default_neighbor_lines: 2,
                selection_reason: 'primary entry point',
              },
            ],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'high',
      },
    });

    const { model } = queueModel([stop]);
    const result = await runRetrieverAgent({
      repoRoot: tempDir,
      intent: { restatedIntent: 'investigate the request handler' },
      scout,
      model,
      limits: tinyLimits(),
    });

    expect(result.telemetry.stopReason).toBe('agent_stopped');
    // Final selection is strictly narrower than the scout's selected tier.
    const selected = result.recommendation.files.filter((f) => f.tier === 'selected');
    expect(selected.length).toBeLessThan(scout.selected.length + scout.reserve.length);
    // The relevant file stayed; the distractor was dropped.
    const paths = result.recommendation.files.map((f) => f.path);
    expect(paths).toContain('src/request-handler.ts');
    expect(paths).not.toContain('src/unrelated-handler.ts');
    // Selection reason is substantive, not an empty placeholder.
    expect(result.recommendation.files[0]!.selection_reason.length).toBeGreaterThan(0);
    // Strategy summary cites why the false positive was dropped.
    expect(result.recommendation.strategy_summary).toContain('unrelated');
  });

  test('sanitizes out-of-repo paths in the final recommendation', async () => {
    await writeRepo({ 'src/a.ts': 'export const A = 1;\n' });

    const stop = JSON.stringify({
      status: 'stop',
      summary: 'done',
      recommendation: {
        strategy_summary: 'final',
        files: [
          {
            path: '/etc/passwd',
            tier: 'selected',
            default_evidence_mode: 'whole_file',
            selection_reason: 'should be rejected',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: true,
            symbols: [],
          },
          {
            path: 'src/a.ts',
            tier: 'selected',
            default_evidence_mode: 'summary',
            selection_reason: 'in-repo file',
            include_ast_skeleton: false,
            include_retriever_summary: true,
            include_entire_file: false,
            symbols: [],
          },
        ],
        cross_file_findings: [],
        gaps: [],
        followup_queries: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
        confidence: 'medium',
      },
    });

    const { model } = queueModel([stop]);
    const input = await makeInput('a', model, tinyLimits());
    const result = await runRetrieverAgent(input);

    const paths = result.recommendation.files.map((f) => f.path);
    expect(paths).toContain('src/a.ts');
    expect(paths.some((p) => p.includes('passwd'))).toBe(false);
    expect(result.telemetry.warnings.some((w) => w.includes('out-of-repo'))).toBe(true);
  });
});
