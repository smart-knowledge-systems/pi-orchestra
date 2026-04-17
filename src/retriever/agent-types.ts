/**
 * Retriever agent protocol.
 *
 * Defines the round contracts, action types, observation shapes, and final
 * recommendation payload for the bounded model-driven retriever agent. The
 * agent reads files through the deterministic executor in `executor.ts`;
 * neither this module nor the agent loop calls out to pi host APIs directly.
 *
 * Typed surface is intentionally strict so the stored retrieval artifact can
 * be derived from agent output without guessing.
 *
 * @module retriever/agent-types
 */

import type { RetrievalDefaultEvidenceMode, RetrievalSelectionTier } from '../artifacts/types.ts';
import type { ScoutResult } from './scout.ts';

// ---------------------------------------------------------------------------
// Actions — requests the agent makes to the deterministic executor.
// ---------------------------------------------------------------------------

export interface ReadFileAction {
  type: 'read_file';
  /** Repo-relative or absolute path. Executor resolves and validates. */
  path: string;
  /** `full` reads from line 1; `window` honours start/count. */
  mode?: 'full' | 'window';
  /** 1-indexed start line when mode is `window`. */
  start?: number;
  /** Number of lines to read when mode is `window`. */
  count?: number;
  reason: string;
}

export interface SearchContentAction {
  type: 'search_content';
  /** Literal substring to search for (case-insensitive). */
  term: string;
  /** Optional directory/path hint to limit the search. */
  path_hint?: string;
  reason: string;
}

export interface SearchPathsAction {
  type: 'search_paths';
  /** Literal substring to match against repo-relative paths. */
  term: string;
  /** Optional directory hint to limit the search. */
  dir_hint?: string;
  reason: string;
}

export interface FollowImportsAction {
  type: 'follow_imports';
  /** Path whose imports should be resolved against the repo. */
  path: string;
  reason: string;
}

export type RetrievalAction =
  | ReadFileAction
  | SearchContentAction
  | SearchPathsAction
  | FollowImportsAction;

export type RetrievalActionType = RetrievalAction['type'];

// ---------------------------------------------------------------------------
// Observations — structural, bounded results returned by the executor.
// ---------------------------------------------------------------------------

export interface ReadFileObservation {
  action: 'read_file';
  path: string;
  /** 1-indexed start line of the observation window. */
  start: number;
  /** Number of lines returned in `lines`. */
  count: number;
  /** File total line count when known. */
  totalLines?: number;
  /** Bounded line slice. Lines are trimmed of trailing whitespace. */
  lines: string[];
  /** True when the requested window was clipped by the executor budget. */
  truncated: boolean;
  reason?: string;
  error?: string;
}

export interface SearchContentHit {
  path: string;
  /** 1-indexed line number. */
  line: number;
  /** Single-line text snippet (trimmed, bounded). */
  text: string;
}

export interface SearchContentObservation {
  action: 'search_content';
  term: string;
  hits: SearchContentHit[];
  truncated: boolean;
  reason?: string;
  error?: string;
}

export interface SearchPathsObservation {
  action: 'search_paths';
  term: string;
  matches: string[];
  truncated: boolean;
  reason?: string;
  error?: string;
}

export interface FollowImportsObservation {
  action: 'follow_imports';
  path: string;
  imports: Array<{
    /** Raw import specifier. */
    source: string;
    /** Repo-relative path if the specifier resolved inside the repo. */
    resolved?: string;
  }>;
  reason?: string;
  error?: string;
}

export type RetrievalObservation =
  | ReadFileObservation
  | SearchContentObservation
  | SearchPathsObservation
  | FollowImportsObservation;

// ---------------------------------------------------------------------------
// Round contract — what the model returns each round.
// ---------------------------------------------------------------------------

export interface AgentSymbolSelection {
  /** Symbol name as observed. */
  name: string;
  /** 1-indexed start line. */
  start: number;
  /** Line span (>= 1). */
  count: number;
  /** Whether the assembler should emit this span by default. */
  selected_by_default: boolean;
  /** Neighbor lines of surrounding context. */
  default_neighbor_lines: number;
  /** Stable short reason for the selection. */
  selection_reason: string;
}

export interface AgentFileSelection {
  /** Repo-relative or absolute path. */
  path: string;
  /** Selection tier. */
  tier: RetrievalSelectionTier;
  /** Default evidence mode (drives assembler planning). */
  default_evidence_mode: RetrievalDefaultEvidenceMode;
  /** Stable short reason the file belongs here. */
  selection_reason: string;
  /** Whether the assembler should include the AST skeleton by default. */
  include_ast_skeleton: boolean;
  /** Whether the assembler should include the retriever summary by default. */
  include_retriever_summary: boolean;
  /** Whether the assembler should include the whole file by default. */
  include_entire_file: boolean;
  /** Per-symbol selections for this file. */
  symbols: AgentSymbolSelection[];
}

export interface AgentFinalRecommendation {
  /** Summary describing how the agent narrowed the search. */
  strategy_summary: string;
  /** Selected + reserve file set with per-file evidence decisions. */
  files: AgentFileSelection[];
  /** Cross-file findings worth surfacing in the evidence bundle. */
  cross_file_findings: string[];
  /** Coverage gaps the agent detected but could not resolve. */
  gaps: string[];
  /** Follow-up queries suggested for a future run. */
  followup_queries: string[];
  /** Whether the evidence bundle should carry cross-file findings. */
  include_cross_file_findings: boolean;
  /** Whether the evidence bundle should carry gaps. */
  include_gaps: boolean;
  /** Whether the evidence bundle should carry follow-up queries. */
  include_followup_queries: boolean;
  /** Overall confidence in the recommendation (`low` | `medium` | `high`). */
  confidence: 'low' | 'medium' | 'high';
}

export type AgentRoundOutput =
  | {
      status: 'continue';
      summary: string;
      actions: RetrievalAction[];
    }
  | {
      status: 'stop';
      summary: string;
      recommendation: AgentFinalRecommendation;
    };

// ---------------------------------------------------------------------------
// Round input — what the agent receives on each call.
// ---------------------------------------------------------------------------

export interface AgentRoundTrace {
  /** 1-indexed round number that produced these entries. */
  round: number;
  /** Actions the agent emitted this round. */
  actions: RetrievalAction[];
  /** Observations the executor returned for those actions. */
  observations: RetrievalObservation[];
  /** The agent's short round summary text. */
  summary?: string;
}

export interface AgentBudgetState {
  /** Zero-indexed: the next round the model will produce. */
  currentRound: number;
  roundsRemaining: number;
  actionsRemainingThisRound: number;
  fileReadsRemaining: number;
  observationBudgetRemainingBytes: number;
}

// ---------------------------------------------------------------------------
// Agent configuration + callback signatures.
// ---------------------------------------------------------------------------

export interface AgentLimits {
  /** Maximum number of model-driven rounds. Default 3. */
  maxRounds: number;
  /** Maximum actions per round. Default 4. */
  maxActionsPerRound: number;
  /** Maximum total file reads across the run. Default 12. */
  maxFileReads: number;
  /** Maximum line slice per read action. Default 200. */
  maxLinesPerRead: number;
  /** Maximum bytes returned from a single read. Default 16384. */
  maxBytesPerRead: number;
  /** Maximum total observation byte budget across all rounds. Default 262144. */
  maxObservationBudgetBytes: number;
  /** Maximum hits returned from a single content search. Default 25. */
  maxContentSearchHits: number;
  /** Maximum path matches returned from a single path search. Default 25. */
  maxPathSearchMatches: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxRounds: 3,
  maxActionsPerRound: 4,
  maxFileReads: 12,
  maxLinesPerRead: 200,
  maxBytesPerRead: 16 * 1024,
  maxObservationBudgetBytes: 256 * 1024,
  maxContentSearchHits: 25,
  maxPathSearchMatches: 25,
};

/**
 * Model callback injected into the agent loop. The agent loop is responsible
 * for prompt assembly and JSON parsing; the callback only performs the raw
 * model call and returns the text response.
 */
export type AgentModelCallback = (input: {
  systemPrompt: string;
  userPrompt: string;
  round: number;
}) => Promise<string>;

// ---------------------------------------------------------------------------
// Agent invocation — inputs and outputs for `runRetrieverAgent`.
// ---------------------------------------------------------------------------

export interface AgentIntent {
  cleanedIntent?: string;
  restatedIntent?: string;
  retrievalFocus?: string[];
  taggedFiles?: string[];
}

export interface AgentRunInput {
  repoRoot: string;
  intent: AgentIntent;
  scout: ScoutResult;
  model: AgentModelCallback;
  limits?: Partial<AgentLimits>;
}

export interface AgentRunTelemetry {
  roundsExecuted: number;
  actionsExecuted: number;
  fileReadsExecuted: number;
  observationBytesUsed: number;
  stopReason: 'agent_stopped' | 'round_cap' | 'action_cap' | 'model_error' | 'parse_error';
  warnings: string[];
}

export interface AgentRunResult {
  recommendation: AgentFinalRecommendation;
  trace: AgentRoundTrace[];
  telemetry: AgentRunTelemetry;
}
