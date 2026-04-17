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
 * @module retriever/agent
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type {
  AgentBudgetState,
  AgentFileSelection,
  AgentFinalRecommendation,
  AgentLimits,
  AgentModelCallback,
  AgentRoundOutput,
  AgentRoundTrace,
  AgentRunInput,
  AgentRunResult,
  AgentRunTelemetry,
  AgentSymbolSelection,
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
import type { ScoutCandidate, ScoutResult } from './scout.ts';
import type { RetrievalDefaultEvidenceMode, RetrievalSelectionTier } from '../artifacts/types.ts';

const SELECTION_TIERS: readonly RetrievalSelectionTier[] = ['selected', 'reserve'];
const DEFAULT_EVIDENCE_MODES: readonly RetrievalDefaultEvidenceMode[] = [
  'exclude',
  'summary',
  'summary+ast',
  'spans',
  'whole_file',
];
const CONFIDENCE_VALUES: readonly AgentFinalRecommendation['confidence'][] = [
  'low',
  'medium',
  'high',
];

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

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
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

function parseSymbolSelection(raw: unknown): AgentSymbolSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return null;
  const start = Math.max(1, asInt(obj.start, 1));
  const count = Math.max(1, asInt(obj.count, 1));
  return {
    name,
    start,
    count,
    selected_by_default: asBool(obj.selected_by_default, false),
    default_neighbor_lines: Math.max(0, asInt(obj.default_neighbor_lines, 0)),
    selection_reason: typeof obj.selection_reason === 'string' ? obj.selection_reason.trim() : '',
  };
}

function parseFileSelection(raw: unknown): AgentFileSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const path = typeof obj.path === 'string' ? obj.path.trim() : '';
  if (!path) return null;
  const tier = pickEnum(obj.tier, SELECTION_TIERS, 'selected');
  const default_evidence_mode = pickEnum(
    obj.default_evidence_mode,
    DEFAULT_EVIDENCE_MODES,
    'summary',
  );
  const symbols = Array.isArray(obj.symbols)
    ? obj.symbols.map(parseSymbolSelection).filter((s): s is AgentSymbolSelection => s !== null)
    : [];
  return {
    path,
    tier,
    default_evidence_mode,
    selection_reason: typeof obj.selection_reason === 'string' ? obj.selection_reason.trim() : '',
    include_ast_skeleton: asBool(obj.include_ast_skeleton, default_evidence_mode !== 'exclude'),
    include_retriever_summary: asBool(
      obj.include_retriever_summary,
      default_evidence_mode !== 'exclude',
    ),
    include_entire_file: asBool(obj.include_entire_file, default_evidence_mode === 'whole_file'),
    symbols,
  };
}

function parseRecommendation(raw: unknown): AgentFinalRecommendation | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const strategy_summary =
    typeof obj.strategy_summary === 'string' ? obj.strategy_summary.trim() : '';
  const filesRaw = Array.isArray(obj.files) ? obj.files : [];
  const files = filesRaw
    .map(parseFileSelection)
    .filter((file): file is AgentFileSelection => file !== null);
  if (!strategy_summary && files.length === 0) return null;
  return {
    strategy_summary,
    files,
    cross_file_findings: asStringArray(obj.cross_file_findings),
    gaps: asStringArray(obj.gaps),
    followup_queries: asStringArray(obj.followup_queries),
    include_cross_file_findings: asBool(obj.include_cross_file_findings, false),
    include_gaps: asBool(obj.include_gaps, false),
    include_followup_queries: asBool(obj.include_followup_queries, false),
    confidence: pickEnum(obj.confidence, CONFIDENCE_VALUES, 'medium'),
  };
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
  const recommendation = parseRecommendation(obj.recommendation);
  if (!recommendation) {
    return { output: null, error: 'stop round missing valid recommendation' };
  }
  return { output: { status: 'stop', summary, recommendation } };
}

// ---------------------------------------------------------------------------
// Fallback recommendation synthesis
// ---------------------------------------------------------------------------

function candidateToFileSelection(
  candidate: ScoutCandidate,
  tier: RetrievalSelectionTier,
): AgentFileSelection {
  const mode = candidate.evidenceModeHint;
  const symbols = candidate.topSymbols.slice(0, 3).map<AgentSymbolSelection>((sym) => ({
    name: sym.name,
    start: sym.start,
    count: sym.count,
    selected_by_default: tier === 'selected' && mode === 'spans',
    default_neighbor_lines: tier === 'selected' && mode === 'spans' ? 3 : 0,
    selection_reason: sym.reason,
  }));
  return {
    path: candidate.relPath,
    tier,
    default_evidence_mode: mode,
    selection_reason: `${candidate.role} · ${candidate.rationale}`,
    include_ast_skeleton: mode !== 'exclude',
    include_retriever_summary: mode !== 'exclude',
    include_entire_file: mode === 'whole_file',
    symbols,
  };
}

function fallbackRecommendation(scout: ScoutResult, note: string): AgentFinalRecommendation {
  const files: AgentFileSelection[] = [
    ...scout.selected.map((c) => candidateToFileSelection(c, 'selected')),
    ...scout.reserve.map((c) => candidateToFileSelection(c, 'reserve')),
  ];
  return {
    strategy_summary: `${scout.strategySummary} — fallback: ${note}`,
    files,
    cross_file_findings: scout.crossFileHints,
    gaps: scout.gaps,
    followup_queries: scout.terms
      .filter((t) => t.kinds.includes('focus') || t.weight >= 4)
      .slice(0, 4)
      .map((t) => `investigate ${t.term}-related callsites or configuration`),
    include_cross_file_findings: scout.crossFileHints.length > 0,
    include_gaps: scout.gaps.length > 0,
    include_followup_queries: false,
    confidence: files.length >= 3 ? 'medium' : 'low',
  };
}

// ---------------------------------------------------------------------------
// Post-processing — ensure every referenced path stays inside the repo root
// and paths end up repo-relative.
// ---------------------------------------------------------------------------

function normalizePath(repoRoot: string, path: string): string | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel === '' ? '.' : rel;
}

function sanitizeRecommendation(
  recommendation: AgentFinalRecommendation,
  repoRoot: string,
): { recommendation: AgentFinalRecommendation; warnings: string[] } {
  const warnings: string[] = [];
  const files: AgentFileSelection[] = [];
  const seen = new Set<string>();
  for (const file of recommendation.files) {
    const normalized = normalizePath(repoRoot, file.path);
    if (!normalized) {
      warnings.push(`dropping out-of-repo path: ${file.path}`);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    files.push({ ...file, path: normalized });
  }
  return {
    recommendation: { ...recommendation, files },
    warnings,
  };
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
