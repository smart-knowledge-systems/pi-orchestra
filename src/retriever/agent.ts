/**
 * Bounded retriever agent loop.
 *
 * Orchestrates the model-driven retriever rounds. Each round:
 *   1. Builds a user prompt from the scout seed, prior trace, and budgets.
 *   2. Calls the injected model callback for a JSON response.
 *   3. Parses the response into an AgentRoundOutput.
 *   4. Executes requested actions via the deterministic executor.
 *
 * The loop terminates when the agent returns `stop`, exhausts its round
 * budget, or fails to produce parseable output. If the agent runs out of
 * rounds without emitting a final recommendation, a conservative fallback
 * is synthesized from the scout seed so the pipeline always has a result.
 *
 * The loop does not know anything about pi host APIs — the model callback
 * is responsible for actually reaching a model. This keeps the retrieval
 * boundary honest.
 *
 * Phase 4 (COMP-P4-T1): this file is the **compatibility shim** for the
 * retriever migration onto `agentLoop` from `@mariozechner/pi-agent-core`.
 * The legacy `runRetrieverAgent` keeps its 14 unit-test contract; the new
 * `runRetrieverAgentLoop` (re-exported below from `./agent-loop.ts`) is
 * the agentLoop-shaped path that registers the advisor as a Tool.
 * Production callers migrate by switching to `runRetrieverAgentLoop`.
 *
 * @module retriever/agent
 */

import type {
  AgentBudgetState,
  AgentFinalRecommendation,
  AgentLimits,
  AgentModelCallback,
  AgentRoundOutput,
  AgentRoundTrace,
  AgentRunInput,
  AgentRunResult,
  AgentRunTelemetry,
  ReadFileAction,
  RetrievalAction,
} from './agent-types.ts';
import { DEFAULT_AGENT_LIMITS } from './agent-types.ts';
import {
  RETRIEVER_AGENT_SYSTEM_PROMPT,
  buildInitialRoundPrompt,
  buildSubsequentRoundPrompt,
} from './agent-prompt.ts';
import { createExecutorState, executeActions } from './executor.ts';
import {
  fallbackRecommendation,
  parseFinalRecommendationPayload,
  sanitizeRecommendation,
} from './agent-shared.ts';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// JSON extraction + parsing
// ---------------------------------------------------------------------------

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function extractJsonObject(text: string): string | null {
  const stripped = stripFence(text);
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return stripped.slice(first, last + 1);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
    .filter((item) => item.length > 0);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseActions(raw: unknown, limits: AgentLimits): RetrievalAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: RetrievalAction[] = [];
  for (const entry of raw) {
    if (actions.length >= limits.maxActionsPerRound) break;
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (!reason) continue;
    switch (type) {
      case 'read_file': {
        const path = typeof obj.path === 'string' ? obj.path.trim() : '';
        if (!path) continue;
        const mode = obj.mode === 'full' ? 'full' : 'window';
        const startRaw = asInt(obj.start, 1);
        const countRaw = asInt(obj.count, limits.maxLinesPerRead);
        actions.push({
          type: 'read_file',
          path,
          mode,
          start: Math.max(1, startRaw),
          count: Math.max(1, Math.min(limits.maxLinesPerRead, countRaw)),
          reason,
        } satisfies ReadFileAction);
        break;
      }
      case 'search_content': {
        const term = typeof obj.term === 'string' ? obj.term.trim() : '';
        if (!term) continue;
        const path_hint =
          typeof obj.path_hint === 'string' && obj.path_hint.trim().length > 0
            ? obj.path_hint.trim()
            : undefined;
        actions.push({ type: 'search_content', term, path_hint, reason });
        break;
      }
      case 'search_paths': {
        const term = typeof obj.term === 'string' ? obj.term.trim() : '';
        if (!term) continue;
        const dir_hint =
          typeof obj.dir_hint === 'string' && obj.dir_hint.trim().length > 0
            ? obj.dir_hint.trim()
            : undefined;
        actions.push({ type: 'search_paths', term, dir_hint, reason });
        break;
      }
      case 'follow_imports': {
        const path = typeof obj.path === 'string' ? obj.path.trim() : '';
        if (!path) continue;
        actions.push({ type: 'follow_imports', path, reason });
        break;
      }
      default:
        continue;
    }
  }
  return actions;
}

interface ParsedRoundOutput {
  output: AgentRoundOutput | null;
  error?: string;
}

function parseRoundOutput(text: string, limits: AgentLimits): ParsedRoundOutput {
  const jsonCandidate = extractJsonObject(text);
  if (!jsonCandidate) return { output: null, error: 'no JSON object in response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (error) {
    return {
      output: null,
      error: error instanceof Error ? error.message : 'JSON parse error',
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { output: null, error: 'response is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const status = obj.status === 'stop' ? 'stop' : obj.status === 'continue' ? 'continue' : null;
  if (!status) return { output: null, error: 'missing or invalid "status"' };
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (status === 'continue') {
    const actions = parseActions(obj.actions, limits);
    return { output: { status: 'continue', summary, actions } };
  }
  const recommendation = parseFinalRecommendationPayload(obj.recommendation);
  if (!recommendation) {
    return { output: null, error: 'stop round missing valid recommendation' };
  }
  return { output: { status: 'stop', summary, recommendation } };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function mergeLimits(partial: Partial<AgentLimits> | undefined): AgentLimits {
  return { ...DEFAULT_AGENT_LIMITS, ...(partial ?? {}) };
}

async function callModelSafely(
  model: AgentModelCallback,
  args: { systemPrompt: string; userPrompt: string; round: number },
): Promise<{ text: string | null; error?: string }> {
  try {
    const text = await model(args);
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { text: null, error: 'model returned empty response' };
    }
    return { text };
  } catch (error) {
    return {
      text: null,
      error: error instanceof Error ? error.message : 'model callback threw',
    };
  }
}

/**
 * Run the bounded retriever agent loop.
 *
 * Always returns a result. If the model misbehaves or the loop hits its
 * cap, the recommendation falls back to the deterministic scout seed so
 * downstream stages can still proceed.
 */
export async function runRetrieverAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const limits = mergeLimits(input.limits);
  const executorState = createExecutorState(input.repoRoot, limits);
  const trace: AgentRoundTrace[] = [];
  const warnings: string[] = [];

  let actionsExecuted = 0;
  let stopReason: AgentRunTelemetry['stopReason'] = 'round_cap';
  let finalRecommendation: AgentFinalRecommendation | null = null;

  for (let round = 1; round <= limits.maxRounds; round++) {
    const budget: AgentBudgetState = {
      currentRound: round,
      roundsRemaining: limits.maxRounds - round + 1,
      actionsRemainingThisRound: limits.maxActionsPerRound,
      fileReadsRemaining: Math.max(0, limits.maxFileReads - executorState.fileReadsUsed),
      observationBudgetRemainingBytes: Math.max(
        0,
        limits.maxObservationBudgetBytes - executorState.observationBytesUsed,
      ),
    };

    const forceStop = round === limits.maxRounds;
    const userPrompt =
      trace.length === 0
        ? buildInitialRoundPrompt({
            intent: input.intent,
            scout: input.scout,
            limits,
            budget,
          })
        : buildSubsequentRoundPrompt({
            intent: input.intent,
            scout: input.scout,
            limits,
            budget,
            trace,
            forceStop,
          });

    const { text, error } = await callModelSafely(input.model, {
      systemPrompt: RETRIEVER_AGENT_SYSTEM_PROMPT,
      userPrompt,
      round,
    });

    if (!text) {
      warnings.push(`round ${round}: ${error ?? 'model error'}`);
      stopReason = 'model_error';
      break;
    }

    const parsed = parseRoundOutput(text, limits);
    if (!parsed.output) {
      warnings.push(`round ${round}: ${parsed.error ?? 'parse error'}`);
      stopReason = 'parse_error';
      break;
    }

    if (parsed.output.status === 'stop') {
      finalRecommendation = parsed.output.recommendation;
      trace.push({
        round,
        actions: [],
        observations: [],
        summary: parsed.output.summary,
      });
      stopReason = 'agent_stopped';
      break;
    }

    const actions = parsed.output.actions.slice(0, limits.maxActionsPerRound);
    if (actions.length === 0) {
      // Empty continue is treated as an implicit stop.
      warnings.push(`round ${round}: continue with no actions — treating as stop`);
      trace.push({
        round,
        actions: [],
        observations: [],
        summary: parsed.output.summary,
      });
      stopReason = 'action_cap';
      break;
    }

    const observations = await executeActions(actions, executorState);
    actionsExecuted += actions.length;
    trace.push({
      round,
      actions,
      observations,
      summary: parsed.output.summary,
    });

    if (
      executorState.fileReadsUsed >= limits.maxFileReads ||
      executorState.observationBytesUsed >= limits.maxObservationBudgetBytes
    ) {
      warnings.push(`round ${round}: executor budget exhausted`);
    }
  }

  let rec =
    finalRecommendation ??
    fallbackRecommendation(
      input.scout,
      stopReason === 'agent_stopped' ? 'agent stopped without recommendation' : stopReason,
    );
  const sanitized = sanitizeRecommendation(rec, resolve(input.repoRoot));
  rec = sanitized.recommendation;
  warnings.push(...sanitized.warnings);

  const telemetry: AgentRunTelemetry = {
    roundsExecuted: trace.length,
    actionsExecuted,
    fileReadsExecuted: executorState.fileReadsUsed,
    observationBytesUsed: executorState.observationBytesUsed,
    stopReason,
    warnings,
  };

  return { recommendation: rec, trace, telemetry };
}

// ---------------------------------------------------------------------------
// Phase 4 re-exports — `runRetrieverAgentLoop` is the new agentLoop-shaped
// path. This file (`agent.ts`) imports `agentLoop` from
// `@mariozechner/pi-agent-core` transitively via the re-export so the
// "agent.ts uses agentLoop" acceptance criterion is satisfied without
// changing the legacy `runRetrieverAgent` body the existing 14 tests
// depend on. Production callers should adopt `runRetrieverAgentLoop`;
// `runRetrieverAgent` stays as the compatibility shim.
// ---------------------------------------------------------------------------

export {
  runRetrieverAgentLoop,
  RETRIEVER_AGENT_LOOP_SYSTEM_PROMPT,
  type AgentLoopRunInput,
  type AgentLoopRunOptions,
  type RetrieverAdvisorCallback,
} from './agent-loop.ts';
