/**
 * Retriever system prompt and prompt assembly.
 *
 * The retriever worker operates behind a boundary the conductor cannot cross.
 * This module defines the system prompt and assembles the user-facing query
 * prompt from intent artifacts. The conductor must NOT import this module.
 *
 * Curated search terms are sourced from the deterministic scout in
 * `./scout.ts`, so the prompt and the scout share the same intent-shaped
 * term model (focus > tagged > restatement > intent) and the same
 * stop-word handling.
 *
 * @module retriever/prompt
 */

import { buildScoutTerms } from './scout.ts';

// ---------------------------------------------------------------------------
// System prompt — instructs the retriever worker's behavior
// ---------------------------------------------------------------------------

export const RETRIEVER_SYSTEM_PROMPT = `You are a code retrieval worker. Your job is to search a repository and produce structured metadata about relevant files and symbols.

Rules:
- Search the repository for files relevant to the user's intent.
- For each relevant file, produce: path, why it is relevant, a short summary, an AST skeleton of top-level declarations, and symbol metadata (kind, name, start line, line count).
- All file paths must be absolute.
- All line numbers must be 1-indexed.
- Do NOT return raw file content. Only return structural summaries and symbol metadata.
- Score file relevance based on keyword matches in file paths and content.
- Report gaps when coverage is low or uncertain.
- Suggest followup queries when the initial search is insufficient.
- Assign a confidence level (low, medium, high) to the overall retrieval.`;

// ---------------------------------------------------------------------------
// Prompt assembly — builds the query prompt from intent artifacts
// ---------------------------------------------------------------------------

export interface PromptAssemblyInput {
  /**
   * The user's intent text. Callers should pass the cleaned intent (with
   * inline <file> blocks stripped) so the retriever prompt is not diluted
   * by large file bodies embedded in the original message.
   */
  userIntentVerbatim: string;
  /** The approved restated intent. */
  restatedIntent: string;
  /** Optional retrieval focus hints from the intent spec. */
  retrievalFocus?: string[];
  /** Optional tagged files from the intent capture. */
  taggedFiles?: string[];
  /**
   * Optional curated terms pre-computed by the scout. When supplied the
   * prompt reuses them verbatim rather than recomputing; this keeps scout
   * output and prompt content in lockstep.
   */
  scoutTerms?: string[];
}

export interface AssembledPrompt {
  /** The system prompt for the retriever worker. */
  systemPrompt: string;
  /** Human-readable retrieval brief. */
  query: string;
  /** Retrieval focus hints passed through for the worker. */
  retrievalFocus: string[];
  /** Curated search terms derived from the intent, focus, and tagged files. */
  searchTerms: string[];
  /** Tagged files passed through explicitly for worker-side boosting. */
  taggedFiles: string[];
}

/**
 * Assemble the retriever prompt from intent artifacts.
 *
 * Combines the restated intent with optional retrieval focus hints and
 * tagged file context to produce a query the retriever worker can act on.
 */
export function assembleRetrieverPrompt(input: PromptAssemblyInput): AssembledPrompt {
  const retrievalFocus = input.retrievalFocus ?? [];
  const taggedFiles = input.taggedFiles ?? [];

  const searchTerms =
    input.scoutTerms && input.scoutTerms.length > 0
      ? [...input.scoutTerms]
      : buildScoutTerms({
          cleanedIntent: input.userIntentVerbatim,
          restatedIntent: input.restatedIntent,
          retrievalFocus,
          taggedFiles,
        }).map((t) => t.term);

  const querySections = [
    `Objective: ${input.restatedIntent}`,
    retrievalFocus.length > 0 ? `Focus areas: ${retrievalFocus.join(', ')}` : null,
    taggedFiles.length > 0 ? `Tagged files: ${taggedFiles.join(', ')}` : null,
    searchTerms.length > 0 ? `Curated search terms: ${searchTerms.join(', ')}` : null,
  ].filter((value): value is string => value !== null);

  return {
    systemPrompt: RETRIEVER_SYSTEM_PROMPT,
    query: querySections.join('\n'),
    retrievalFocus,
    searchTerms,
    taggedFiles,
  };
}
