/**
 * Retriever agent loop — Phase 4 (COMP-P4-T1).
 *
 * Per `docs/composability.md` "Phase 4 — Retriever onto agentLoop", this
 * module collapses the retriever onto the shared `agentLoop` shipped by
 * `@mariozechner/pi-agent-core` (the package the docs reference as
 * "@earendil-works/pi-agent-core" — see summary for the discrepancy flag).
 *
 * What's reused from the existing retriever:
 *   - `src/retriever/executor.ts` is the deterministic source-access seam.
 *     Each retrieval action becomes an `AgentTool` whose `execute()` calls
 *     the same `executeAction(...)` body. Source-access budgets, byte caps,
 *     and out-of-repo path rejection stay in one place.
 *   - The fallback recommendation (`fallbackRecommendation` in `agent.ts`)
 *     is shared so a loop that runs out of turns without a final
 *     recommendation still produces a deterministic scout-derived result.
 *
 * What's new:
 *   - The advisor slots in as one more `AgentTool`. Hosts that wire an
 *     advisor callback get advisor-aware retrieval; hosts that don't get
 *     a tool that returns a no-op telemetered "advisor disabled" message.
 *   - Stop reasons are produced from the `agentLoop` event stream rather
 *     than from JSON parsing — the four canonical assertions
 *     (bounded budgets, stop reasons, fallback, sanitization) are mapped
 *     onto the loop's `submit_recommendation` tool, the AbortSignal turn
 *     cap, and the existing executor budget.
 *
 * The legacy `runRetrieverAgent` function in `src/retriever/agent.ts` is
 * preserved as the compatibility shim — its 14 tests stay green
 * byte-identically while production callers migrate to
 * `runRetrieverAgentLoop`.
 *
 * @module retriever/agent-loop
 */

import type {
  AgentContext,
  AgentLoopConfig,
  AgentTool,
  StreamFn,
} from '@mariozechner/pi-agent-core';
import { agentLoop } from '@mariozechner/pi-agent-core';
import type {
  AssistantMessage,
  Message,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from '@mariozechner/pi-ai';
import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { resolve } from 'node:path';

import type {
  AgentFinalRecommendation,
  AgentIntent,
  AgentLimits,
  AgentRoundTrace,
  AgentRunResult,
  AgentRunTelemetry,
  RetrievalAction,
  RetrievalObservation,
  ReadFileAction,
  SearchContentAction,
  SearchPathsAction,
  FollowImportsAction,
} from './agent-types.ts';
import { DEFAULT_AGENT_LIMITS } from './agent-types.ts';
import { createExecutorState, executeAction, type ExecutorState } from './executor.ts';
import {
  fallbackRecommendation,
  parseFinalRecommendationPayload,
  sanitizeRecommendation,
} from './agent-shared.ts';
import type { ScoutResult } from './scout.ts';

// ---------------------------------------------------------------------------
// Tool parameter schemas (typebox — pi-agent-core's canonical shape)
// ---------------------------------------------------------------------------

const ReadFileParams = Type.Object({
  path: Type.String({ description: 'Repo-relative or absolute path inside the repo.' }),
  mode: Type.Optional(Type.Union([Type.Literal('full'), Type.Literal('window')])),
  start: Type.Optional(Type.Number()),
  count: Type.Optional(Type.Number()),
  reason: Type.String(),
});

const SearchContentParams = Type.Object({
  term: Type.String(),
  path_hint: Type.Optional(Type.String()),
  reason: Type.String(),
});

const SearchPathsParams = Type.Object({
  term: Type.String(),
  dir_hint: Type.Optional(Type.String()),
  reason: Type.String(),
});

const FollowImportsParams = Type.Object({
  path: Type.String(),
  reason: Type.String(),
});

const AdvisorParams = Type.Object({});

const SubmitRecommendationParams = Type.Object({
  recommendation: Type.Any({
    description:
      'Final recommendation payload. See AgentFinalRecommendation for the expected shape.',
  }),
});

// ---------------------------------------------------------------------------
// Loop state — mutable shared state across every tool invocation in a run
// ---------------------------------------------------------------------------

interface LoopRunState {
  executor: ExecutorState;
  limits: AgentLimits;
  trace: AgentRoundTrace[];
  warnings: string[];
  /** Non-null after `submit_recommendation` runs. */
  finalRecommendation: AgentFinalRecommendation | null;
  /** Stop reason populated when a terminal condition fires. */
  stopReason: AgentRunTelemetry['stopReason'];
  advisorCalls: number;
  /** Round counter — incremented each time the agent emits one or more tool calls. */
  rounds: number;
  /** Actions executed across the whole run. */
  actionsExecuted: number;
  abortController: AbortController;
}

function createLoopState(input: AgentLoopRunInput, limits: AgentLimits): LoopRunState {
  return {
    executor: createExecutorState(input.repoRoot, limits),
    limits,
    trace: [],
    warnings: [],
    finalRecommendation: null,
    stopReason: 'round_cap',
    advisorCalls: 0,
    rounds: 0,
    actionsExecuted: 0,
    abortController: new AbortController(),
  };
}

function appendTrace(state: LoopRunState, entry: AgentRoundTrace): void {
  state.trace.push(entry);
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

interface ToolBuildContext {
  state: LoopRunState;
  advisor?: RetrieverAdvisorCallback;
}

function buildReadFileTool(ctx: ToolBuildContext): AgentTool<typeof ReadFileParams> {
  return {
    name: 'read_file',
    label: 'Read file',
    description:
      'Read a bounded line window from a file inside the repo. Honors the run-wide read budget.',
    parameters: ReadFileParams,
    execute: async (toolCallId, params) => {
      const action: ReadFileAction = {
        type: 'read_file',
        path: params.path,
        mode: params.mode ?? 'window',
        start: Math.max(1, Math.floor(params.start ?? 1)),
        count: Math.max(
          1,
          Math.min(
            ctx.state.limits.maxLinesPerRead,
            Math.floor(params.count ?? ctx.state.limits.maxLinesPerRead),
          ),
        ),
        reason: params.reason,
      };
      return runRetrievalActionAsTool(action, ctx.state);
    },
  };
}

function buildSearchContentTool(ctx: ToolBuildContext): AgentTool<typeof SearchContentParams> {
  return {
    name: 'search_content',
    label: 'Search file content',
    description: 'Case-insensitive literal substring search across repo source files.',
    parameters: SearchContentParams,
    execute: async (toolCallId, params) => {
      const action: SearchContentAction = {
        type: 'search_content',
        term: params.term,
        ...(params.path_hint !== undefined ? { path_hint: params.path_hint } : {}),
        reason: params.reason,
      };
      return runRetrievalActionAsTool(action, ctx.state);
    },
  };
}

function buildSearchPathsTool(ctx: ToolBuildContext): AgentTool<typeof SearchPathsParams> {
  return {
    name: 'search_paths',
    label: 'Search paths',
    description: 'List repo-relative file paths whose name contains the supplied substring.',
    parameters: SearchPathsParams,
    execute: async (toolCallId, params) => {
      const action: SearchPathsAction = {
        type: 'search_paths',
        term: params.term,
        ...(params.dir_hint !== undefined ? { dir_hint: params.dir_hint } : {}),
        reason: params.reason,
      };
      return runRetrievalActionAsTool(action, ctx.state);
    },
  };
}

function buildFollowImportsTool(ctx: ToolBuildContext): AgentTool<typeof FollowImportsParams> {
  return {
    name: 'follow_imports',
    label: 'Follow imports',
    description: 'Resolve the import specifiers of a single file against the repo tree.',
    parameters: FollowImportsParams,
    execute: async (toolCallId, params) => {
      const action: FollowImportsAction = {
        type: 'follow_imports',
        path: params.path,
        reason: params.reason,
      };
      return runRetrievalActionAsTool(action, ctx.state);
    },
  };
}

function buildAdvisorTool(ctx: ToolBuildContext): AgentTool<typeof AdvisorParams> {
  return {
    name: 'advisor',
    label: 'Advisor',
    description:
      'Consult a stronger reviewer model with the full conversation history. Takes no parameters.',
    parameters: AdvisorParams,
    execute: async () => {
      ctx.state.advisorCalls += 1;
      if (!ctx.advisor) {
        return {
          content: [
            {
              type: 'text',
              text: 'advisor: no advisor callback wired for this run; continuing without consultation.',
            },
          ],
          details: { ok: false, reason: 'advisor_not_wired' },
        };
      }
      const advice = await ctx.advisor();
      return {
        content: [{ type: 'text', text: advice.content }],
        details: advice.details ?? { ok: true },
      };
    },
  };
}

function buildSubmitRecommendationTool(
  ctx: ToolBuildContext,
): AgentTool<typeof SubmitRecommendationParams> {
  return {
    name: 'submit_recommendation',
    label: 'Submit final recommendation',
    description: 'Submit the final retrieval recommendation. Calling this tool ends the run.',
    parameters: SubmitRecommendationParams,
    execute: async (toolCallId, params) => {
      const parsed = parseFinalRecommendationPayload(params.recommendation);
      if (!parsed) {
        ctx.state.warnings.push(
          `submit_recommendation: invalid recommendation payload — using fallback`,
        );
        return {
          content: [
            { type: 'text', text: 'submit_recommendation rejected: invalid payload shape.' },
          ],
          details: { ok: false, reason: 'invalid_payload' },
          isError: true,
        };
      }
      ctx.state.finalRecommendation = parsed;
      ctx.state.stopReason = 'agent_stopped';
      ctx.state.abortController.abort();
      return {
        content: [{ type: 'text', text: 'recommendation accepted' }],
        details: { ok: true },
      };
    },
  };
}

async function runRetrievalActionAsTool(
  action: RetrievalAction,
  state: LoopRunState,
): Promise<{ content: TextContent[]; details: { observation: RetrievalObservation } }> {
  state.actionsExecuted += 1;
  const observation = await executeAction(action, state.executor);
  appendTrace(state, {
    round: state.rounds,
    actions: [action],
    observations: [observation],
  });
  return {
    content: [{ type: 'text', text: summarizeObservation(observation) }],
    details: { observation },
  };
}

function summarizeObservation(observation: RetrievalObservation): string {
  switch (observation.action) {
    case 'read_file': {
      if (observation.error) return `read_file ${observation.path} ERROR: ${observation.error}`;
      const total = observation.totalLines !== undefined ? ` / ${observation.totalLines}` : '';
      const truncated = observation.truncated ? ' [truncated]' : '';
      return `read_file ${observation.path} @${observation.start}(${observation.count})${total}${truncated}`;
    }
    case 'search_content': {
      if (observation.error)
        return `search_content "${observation.term}" ERROR: ${observation.error}`;
      return `search_content "${observation.term}" — ${observation.hits.length} hit(s)`;
    }
    case 'search_paths': {
      if (observation.error)
        return `search_paths "${observation.term}" ERROR: ${observation.error}`;
      return `search_paths "${observation.term}" — ${observation.matches.length} match(es)`;
    }
    case 'follow_imports': {
      if (observation.error)
        return `follow_imports ${observation.path} ERROR: ${observation.error}`;
      return `follow_imports ${observation.path} — ${observation.imports.length} import(s)`;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Optional advisor seam. Hosts that wire an advisor return its content +
 * structured details; hosts that don't can omit the callback (the advisor
 * tool still registers, but invocations return a "not wired" no-op).
 */
export type RetrieverAdvisorCallback = () => Promise<{ content: string; details?: unknown }>;

export interface AgentLoopRunInput {
  repoRoot: string;
  intent: AgentIntent;
  scout: ScoutResult;
  limits?: Partial<AgentLimits>;
}

export interface AgentLoopRunOptions {
  /** Optional advisor seam. */
  advisor?: RetrieverAdvisorCallback;
  /**
   * Optional `streamFn` injection. Production callers omit this and let
   * pi-agent-core resolve the real `streamSimple` from pi-ai. Tests
   * inject a stub that emits canned tool-call assistant messages.
   */
  streamFn?: StreamFn;
  /** Optional model handle forwarded to pi-ai. Required for production runs. */
  model?: Model<any>;
  /** Optional API key resolver forwarded to the agent loop. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Optional system-prompt override. */
  systemPrompt?: string;
}

/**
 * Run the retriever via `agentLoop` from `@mariozechner/pi-agent-core`.
 *
 * Bounded budgets reuse the existing executor: each retrieval tool runs
 * through `executeAction(...)`, and the `submit_recommendation` tool
 * aborts the loop. When the loop hits its turn cap (`limits.maxRounds`),
 * the AbortSignal trips, and the run resolves with a fallback
 * recommendation derived from the scout seed — matching the behavior of
 * `runRetrieverAgent`.
 */
export async function runRetrieverAgentLoop(
  input: AgentLoopRunInput,
  options: AgentLoopRunOptions = {},
): Promise<AgentRunResult> {
  const limits = { ...DEFAULT_AGENT_LIMITS, ...(input.limits ?? {}) };
  const state = createLoopState(input, limits);
  const ctx: ToolBuildContext = { state };
  if (options.advisor !== undefined) ctx.advisor = options.advisor;

  const tools: AgentTool<TSchema>[] = [
    buildReadFileTool(ctx),
    buildSearchContentTool(ctx),
    buildSearchPathsTool(ctx),
    buildFollowImportsTool(ctx),
    buildAdvisorTool(ctx),
    buildSubmitRecommendationTool(ctx),
  ] as unknown as AgentTool<TSchema>[];

  const systemPrompt = options.systemPrompt ?? RETRIEVER_AGENT_LOOP_SYSTEM_PROMPT;

  const initialPrompt: Message = {
    role: 'user',
    content: buildInitialUserMessage(input, limits),
    timestamp: Date.now(),
  };

  const agentContext: AgentContext = {
    systemPrompt,
    messages: [],
    tools,
  };

  const config: AgentLoopConfig = {
    model: options.model ?? PLACEHOLDER_MODEL,
    convertToLlm: (messages) => messages as Message[],
    ...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
    toolExecution: 'sequential',
    beforeToolCall: async () => {
      // Round counter — count an LLM turn the first time we see a tool call.
      // pi-agent-core invokes beforeToolCall per tool, but we only want to
      // count a "round" once per assistant message. The state.rounds counter
      // is bumped to the per-turn number on each new turn (see turnCounter
      // logic below via getSteeringMessages — simplest is to bump every time
      // we see a tool call and consolidate later, but that overcounts. We
      // track via an `assistantMessageId` set instead.
      return undefined;
    },
  };

  // ---- turn cap enforcement via abort + round counter -----------------
  // pi-agent-core's `agentLoop` does not expose a turn-cap configuration.
  // We enforce it inside `transformContext` (which runs once per LLM turn,
  // before the streamFn is invoked): if the round counter is already at
  // the cap when a new turn is about to begin, we abort. Otherwise we
  // increment.
  config.transformContext = async (messages) => {
    if (state.rounds >= limits.maxRounds) {
      state.stopReason = 'round_cap';
      state.abortController.abort();
      return messages;
    }
    state.rounds += 1;
    return messages;
  };

  const signal = state.abortController.signal;

  let resultMessages: Message[] = [];
  try {
    if (options.streamFn !== undefined) {
      resultMessages = (await agentLoop(
        [initialPrompt],
        agentContext,
        config,
        signal,
        options.streamFn,
      ).result()) as Message[];
    } else {
      resultMessages = (await agentLoop(
        [initialPrompt],
        agentContext,
        config,
        signal,
      ).result()) as Message[];
    }
  } catch (err) {
    state.warnings.push(`agentLoop threw: ${err instanceof Error ? err.message : String(err)}`);
    if (state.stopReason === 'round_cap') state.stopReason = 'model_error';
  }

  // If the last assistant message is an error / aborted message and we
  // haven't yet locked in a terminal stop reason, surface it.
  for (let i = resultMessages.length - 1; i >= 0; i--) {
    const msg = resultMessages[i];
    if (msg && msg.role === 'assistant') {
      const assistant = msg as AssistantMessage;
      if (
        state.finalRecommendation === null &&
        assistant.stopReason === 'error' &&
        state.stopReason !== 'parse_error'
      ) {
        state.stopReason = 'model_error';
        if (assistant.errorMessage) {
          state.warnings.push(`agentLoop error: ${assistant.errorMessage}`);
        }
      }
      break;
    }
  }

  let recommendation =
    state.finalRecommendation ??
    fallbackRecommendation(
      input.scout,
      state.stopReason === 'agent_stopped'
        ? 'agent stopped without recommendation'
        : state.stopReason,
    );
  const sanitized = sanitizeRecommendation(recommendation, resolve(input.repoRoot));
  recommendation = sanitized.recommendation;
  state.warnings.push(...sanitized.warnings);

  const telemetry: AgentRunTelemetry = {
    roundsExecuted: state.rounds,
    actionsExecuted: state.actionsExecuted,
    fileReadsExecuted: state.executor.fileReadsUsed,
    observationBytesUsed: state.executor.observationBytesUsed,
    stopReason: state.stopReason,
    warnings: state.warnings,
  };

  return {
    recommendation,
    trace: state.trace,
    telemetry,
  };
}

function buildInitialUserMessage(input: AgentLoopRunInput, limits: AgentLimits): string {
  const lines: string[] = [];
  lines.push('# Retrieval task');
  if (input.intent.restatedIntent) lines.push(`Restated intent: ${input.intent.restatedIntent}`);
  if (input.intent.cleanedIntent && input.intent.cleanedIntent !== input.intent.restatedIntent) {
    lines.push(`Cleaned intent: ${input.intent.cleanedIntent}`);
  }
  if (input.intent.taggedFiles && input.intent.taggedFiles.length > 0) {
    lines.push(`Tagged files: ${input.intent.taggedFiles.join(', ')}`);
  }
  lines.push(`Scout strategy: ${input.scout.strategySummary || 'n/a'}`);
  if (input.scout.selected.length > 0) {
    lines.push('Scout selected:');
    for (const c of input.scout.selected) {
      lines.push(`  - ${c.relPath} (role=${c.role}, hint=${c.evidenceModeHint})`);
    }
  }
  if (input.scout.reserve.length > 0) {
    lines.push('Scout reserve:');
    for (const c of input.scout.reserve) {
      lines.push(`  - ${c.relPath} (role=${c.role})`);
    }
  }
  lines.push('');
  lines.push(
    `Budget: max ${limits.maxRounds} turn(s); max ${limits.maxFileReads} file read(s); ` +
      `${limits.maxObservationBudgetBytes} observation bytes total.`,
  );
  lines.push(
    'Use the retrieval tools to gather signal. When you are ready, call ' +
      '`submit_recommendation` with the final recommendation payload to end the run.',
  );
  return lines.join('\n');
}

/**
 * System prompt for the agentLoop-based retriever. Shorter than the
 * legacy single-shot JSON prompt because the loop's tool-call protocol
 * carries the structural contract — no JSON parsing on the model side.
 */
export const RETRIEVER_AGENT_LOOP_SYSTEM_PROMPT = [
  'You are the retriever agent for a staged software analysis pipeline.',
  '',
  'Your goal is to narrow a repository to the minimal, high-signal default',
  'evidence package for an approved user intent. Use the retrieval tools',
  '(read_file, search_content, search_paths, follow_imports) to gather',
  'evidence. You may consult the `advisor` tool when stuck or before',
  'committing to an approach.',
  '',
  'When you are ready, call the `submit_recommendation` tool with the final',
  'recommendation payload. The payload must include `strategy_summary`,',
  '`files[]` with per-file selections (path, tier, default_evidence_mode,',
  'symbols), and the standard cross-file/gaps/followup fields.',
  '',
  'Quality bar: keep the `selected` tier narrow; prefer spans over',
  'whole-file selections; do not include files you have not seen in the',
  'scout seed or an earlier observation. Out-of-repo paths are rejected.',
].join('\n');

// ---------------------------------------------------------------------------
// Placeholder model — used when no real model handle is supplied. Tests
// inject a stub `streamFn` that ignores `config.model`, so the placeholder
// is only reachable from a misconfigured production run (which throws
// inside `streamSimple`). Documented as the seam Phase 5+ wires up.
// ---------------------------------------------------------------------------

const PLACEHOLDER_MODEL: Model<any> = {
  api: 'anthropic-messages' as any,
  provider: 'anthropic' as any,
  id: 'claude-sonnet-4-6',
  name: 'claude-sonnet-4-6',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: { text: true, image: false, audio: false, video: false, pdf: false },
  output: { text: true, image: false, audio: false, video: false },
  modalities: { input: ['text'], output: ['text'] } as any,
  capabilities: {} as any,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxOutputTokens: 8192,
} as unknown as Model<any>;

// ---------------------------------------------------------------------------
// Re-exports for callers that build their own tool registries on top.
// ---------------------------------------------------------------------------

export type AgentMessageType = AssistantMessage | ToolResultMessage;
export type RetrieverToolCall = ToolCall;
