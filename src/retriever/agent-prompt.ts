/**
 * Retriever agent prompts.
 *
 * The retriever agent is bounded: it must respond with a single JSON object
 * that either requests more deterministic actions or emits a final
 * recommendation. This module builds the system prompt and the per-round
 * user prompts, including scout seed data, prior traces, and remaining
 * budget hints.
 *
 * Prompt assembly is deterministic. It does not reach outside the retrieval
 * boundary — the executor observations it embeds were already trimmed to
 * bounded size upstream.
 *
 * @module retriever/agent-prompt
 */

import type {
  AgentBudgetState,
  AgentIntent,
  AgentLimits,
  AgentRoundTrace,
  RetrievalAction,
  RetrievalObservation,
} from './agent-types.ts';
import type { ScoutCandidate, ScoutResult } from './scout.ts';

const MAX_OBSERVATION_LINES = 40;
const MAX_TRACE_ROUNDS = 2;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const RETRIEVER_AGENT_SYSTEM_PROMPT = `You are the retriever agent for a staged software analysis pipeline.

Your goal is to narrow a repository down to the minimal, high-signal default
evidence package for an approved user intent. You receive deterministic scout
output and may request a small, bounded set of additional actions (file reads,
content searches, path searches, import resolution) before emitting a final
recommendation.

Hard rules:
- Respond with a SINGLE JSON object. No markdown, no prose, no code fences.
- Each round must set "status" to "continue" or "stop".
- "continue" rounds must include "summary" and "actions".
- "stop" rounds must include "summary" and "recommendation" — never both actions and a recommendation.
- Every action must include a short, specific "reason".
- Do not invent files you have not seen in the scout seed or an earlier observation.
- Do not request raw file content as the final output; the recommendation is structural only.
- Prefer few targeted actions over broad scans. Budget is strict.

Action schema (inside the "actions" array):
- { "type": "read_file", "path": "<repo-relative>", "mode": "window"|"full", "start": <1-indexed>, "count": <lines>, "reason": "..." }
- { "type": "search_content", "term": "<string>", "path_hint": "<optional>", "reason": "..." }
- { "type": "search_paths", "term": "<string>", "dir_hint": "<optional>", "reason": "..." }
- { "type": "follow_imports", "path": "<repo-relative>", "reason": "..." }

Final recommendation schema (inside "recommendation"):
{
  "strategy_summary": "<how you narrowed>",
  "confidence": "low"|"medium"|"high",
  "files": [
    {
      "path": "<repo-relative>",
      "tier": "selected"|"reserve",
      "default_evidence_mode": "exclude"|"summary"|"summary+ast"|"spans"|"whole_file",
      "selection_reason": "<short reason>",
      "include_ast_skeleton": true|false,
      "include_retriever_summary": true|false,
      "include_entire_file": true|false,
      "symbols": [
        {
          "name": "<symbol>",
          "start": <1-indexed>,
          "count": <lines>,
          "selected_by_default": true|false,
          "default_neighbor_lines": <int>,
          "selection_reason": "<short reason>"
        }
      ]
    }
  ],
  "cross_file_findings": ["..."],
  "gaps": ["..."],
  "followup_queries": ["..."],
  "include_cross_file_findings": true|false,
  "include_gaps": true|false,
  "include_followup_queries": true|false
}

Quality bar:
- Keep the "selected" tier narrow. Files that are merely related belong in "reserve".
- Prefer "spans" or "summary+ast" over "whole_file" unless the file is short and central.
- Set "selected_by_default" only for symbols the analyst would almost certainly want to see.
- If you already have enough signal after round 1, stop there — extra rounds are not free.`;

// ---------------------------------------------------------------------------
// Seed / trace formatting
// ---------------------------------------------------------------------------

function formatList(label: string, items: readonly string[], max = 8): string | null {
  const trimmed = items.filter((item) => item && item.trim().length > 0);
  if (trimmed.length === 0) return null;
  const shown = trimmed.slice(0, max);
  const remainder = trimmed.length > max ? ` (+${trimmed.length - max} more)` : '';
  return `${label}: ${shown.join(', ')}${remainder}`;
}

function formatCandidate(candidate: ScoutCandidate): string {
  const symbols =
    candidate.topSymbols.length === 0
      ? 'no scored symbols'
      : candidate.topSymbols
          .slice(0, 4)
          .map((s) => `${s.kind} ${s.name}@${s.start}(${s.count})`)
          .join(', ');
  const mode = candidate.evidenceModeHint;
  return [
    `- [${candidate.tier}] ${candidate.relPath} (${candidate.lineCount} lines, role=${candidate.role}, hint=${mode})`,
    `    rationale: ${candidate.rationale}`,
    `    symbols: ${symbols}`,
  ].join('\n');
}

function formatScoutSeed(scout: ScoutResult): string {
  const sections: string[] = [];

  sections.push('Scout strategy: ' + (scout.strategySummary || 'n/a'));
  const topTerms = scout.terms
    .slice(0, 8)
    .map((t) => `${t.term}(${t.weight}/${t.kinds.join('+')})`)
    .join(', ');
  sections.push('Top scout terms: ' + (topTerms || 'none'));

  if (scout.selected.length > 0) {
    sections.push('Scout selected candidates:\n' + scout.selected.map(formatCandidate).join('\n'));
  } else {
    sections.push('Scout selected candidates: none');
  }

  if (scout.reserve.length > 0) {
    sections.push('Scout reserve candidates:\n' + scout.reserve.map(formatCandidate).join('\n'));
  }

  const crossFile = formatList('Cross-file hints', scout.crossFileHints);
  if (crossFile) sections.push(crossFile);
  const gaps = formatList('Scout gaps', scout.gaps);
  if (gaps) sections.push(gaps);

  return sections.join('\n\n');
}

function formatIntent(intent: AgentIntent): string {
  const parts: string[] = [];
  if (intent.restatedIntent) parts.push(`Restated intent: ${intent.restatedIntent}`);
  if (intent.cleanedIntent && intent.cleanedIntent !== intent.restatedIntent) {
    parts.push(`Cleaned intent: ${intent.cleanedIntent}`);
  }
  const focus = formatList('Retrieval focus', intent.retrievalFocus ?? []);
  if (focus) parts.push(focus);
  const tagged = formatList('Tagged files', intent.taggedFiles ?? []);
  if (tagged) parts.push(tagged);
  if (parts.length === 0) parts.push('Intent: (none provided)');
  return parts.join('\n');
}

function formatBudget(budget: AgentBudgetState, limits: AgentLimits): string {
  return [
    `Budget this turn:`,
    `  round ${budget.currentRound} of max ${limits.maxRounds}`,
    `  actions remaining this round: ${budget.actionsRemainingThisRound}`,
    `  file reads remaining total: ${budget.fileReadsRemaining}`,
    `  observation bytes remaining: ${budget.observationBudgetRemainingBytes}`,
  ].join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function formatAction(action: RetrievalAction): string {
  switch (action.type) {
    case 'read_file':
      return `read_file ${action.path}${
        action.mode === 'window' && action.start !== undefined
          ? ` @${action.start}(${action.count ?? '?'})`
          : ''
      } — ${truncate(action.reason, 140)}`;
    case 'search_content':
      return `search_content "${action.term}"${
        action.path_hint ? ` in ${action.path_hint}` : ''
      } — ${truncate(action.reason, 140)}`;
    case 'search_paths':
      return `search_paths "${action.term}"${
        action.dir_hint ? ` in ${action.dir_hint}` : ''
      } — ${truncate(action.reason, 140)}`;
    case 'follow_imports':
      return `follow_imports ${action.path} — ${truncate(action.reason, 140)}`;
  }
}

function formatObservation(observation: RetrievalObservation): string {
  switch (observation.action) {
    case 'read_file': {
      const header = `read_file ${observation.path} @${observation.start}(${observation.count})${
        observation.totalLines !== undefined ? ` / ${observation.totalLines}` : ''
      }${observation.truncated ? ' [truncated]' : ''}`;
      if (observation.error) return `${header} ERROR: ${observation.error}`;
      const body = observation.lines
        .slice(0, MAX_OBSERVATION_LINES)
        .map((line, idx) => `  ${observation.start + idx}: ${truncate(line, 160)}`)
        .join('\n');
      const suffix =
        observation.lines.length > MAX_OBSERVATION_LINES
          ? `\n  … +${observation.lines.length - MAX_OBSERVATION_LINES} more lines omitted`
          : '';
      return `${header}\n${body}${suffix}`;
    }
    case 'search_content': {
      const header = `search_content "${observation.term}" — ${observation.hits.length} hit(s)${
        observation.truncated ? ' [truncated]' : ''
      }`;
      if (observation.error) return `${header} ERROR: ${observation.error}`;
      if (observation.hits.length === 0) return `${header}`;
      const body = observation.hits
        .slice(0, 12)
        .map((hit) => `  ${hit.path}:${hit.line} ${truncate(hit.text, 160)}`)
        .join('\n');
      return `${header}\n${body}`;
    }
    case 'search_paths': {
      const header = `search_paths "${observation.term}" — ${observation.matches.length} match(es)${
        observation.truncated ? ' [truncated]' : ''
      }`;
      if (observation.error) return `${header} ERROR: ${observation.error}`;
      if (observation.matches.length === 0) return `${header}`;
      const body = observation.matches
        .slice(0, 16)
        .map((path) => `  ${path}`)
        .join('\n');
      return `${header}\n${body}`;
    }
    case 'follow_imports': {
      const header = `follow_imports ${observation.path} — ${observation.imports.length} import(s)`;
      if (observation.error) return `${header} ERROR: ${observation.error}`;
      if (observation.imports.length === 0) return `${header}`;
      const body = observation.imports
        .slice(0, 16)
        .map((imp) =>
          imp.resolved ? `  ${imp.source} → ${imp.resolved}` : `  ${imp.source} (unresolved)`,
        )
        .join('\n');
      return `${header}\n${body}`;
    }
  }
}

function formatTrace(trace: AgentRoundTrace[]): string {
  const recent = trace.slice(-MAX_TRACE_ROUNDS);
  if (recent.length === 0) return '';
  const sections = recent.map((entry) => {
    const header = `Round ${entry.round}${entry.summary ? ` summary: ${entry.summary}` : ''}`;
    const actions = entry.actions.map(formatAction).join('\n');
    const observations = entry.observations.map(formatObservation).join('\n\n');
    return [
      header,
      actions ? `Actions:\n${actions}` : 'Actions: (none)',
      observations ? `Observations:\n${observations}` : 'Observations: (none)',
    ].join('\n');
  });
  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Public prompt builders
// ---------------------------------------------------------------------------

export interface InitialPromptInput {
  intent: AgentIntent;
  scout: ScoutResult;
  limits: AgentLimits;
  budget: AgentBudgetState;
}

export function buildInitialRoundPrompt(input: InitialPromptInput): string {
  const sections = [
    'Task: narrow the repository into a default evidence package.',
    formatIntent(input.intent),
    formatScoutSeed(input.scout),
    formatBudget(input.budget, input.limits),
    [
      'Instructions for this round:',
      '- You may emit up to ' + input.limits.maxActionsPerRound + ' actions.',
      '- If the scout seed already tells you enough, respond with status "stop" and a final recommendation.',
      '- Otherwise, respond with status "continue" and targeted actions.',
      '- Return only a JSON object. No commentary.',
    ].join('\n'),
  ];
  return sections.join('\n\n');
}

export interface SubsequentPromptInput {
  intent: AgentIntent;
  scout: ScoutResult;
  limits: AgentLimits;
  budget: AgentBudgetState;
  trace: AgentRoundTrace[];
  forceStop?: boolean;
}

export function buildSubsequentRoundPrompt(input: SubsequentPromptInput): string {
  const stopDirective = input.forceStop
    ? 'This is the FINAL round. You must respond with status "stop" and a final recommendation. Do not emit more actions.'
    : 'Decide whether you have enough signal. If so, respond with status "stop" and a final recommendation. Otherwise emit additional actions (up to ' +
      input.limits.maxActionsPerRound +
      ').';

  const sections = [
    'Continuing the retrieval investigation.',
    formatIntent(input.intent),
    formatScoutSeed(input.scout),
    formatTrace(input.trace),
    formatBudget(input.budget, input.limits),
    stopDirective,
    'Return only a JSON object. No commentary.',
  ];
  return sections.join('\n\n');
}
