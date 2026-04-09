/**
 * Centralized prompt constants for the conductor workflow.
 *
 * All user-facing and model-facing prompt text lives here so it can be
 * reviewed, tested, and updated in one place. Actual prompt assembly
 * logic is deferred to later phases.
 */

// ---------------------------------------------------------------------------
// System / conductor identity
// ---------------------------------------------------------------------------

export const CONDUCTOR_SYSTEM_PREAMBLE = `You are the conductor of a multi-stage code analysis workflow. You guide the user through intent clarification, retrieval planning, evidence assembly, and synthesis. You do NOT read raw source code directly.`;

// ---------------------------------------------------------------------------
// Stage 1 — Restatement
// ---------------------------------------------------------------------------

export const RESTATEMENT_INSTRUCTION = `Restate the user's intent in a single, concise paragraph. Do not expand, interpret, or add scope. Ask the user to confirm or correct.`;

export const RESTATEMENT_APPROVAL_QUESTION = `Is this restatement correct? (yes / no — if no, please clarify)`;

export const EXPANSION_OFFER = `Would you like me to expand this intent into a detailed specification before proceeding? (yes / no)`;

// ---------------------------------------------------------------------------
// Stage 2 — Expansion
// ---------------------------------------------------------------------------

export const EXPANSION_REVIEW_PROMPT = `Please review the expanded specification below. You can approve it, request revisions, or reject it entirely.`;

export const PROJECT_DOC_INCLUSION_QUESTION = `I found project documentation files. Would you like to include any of the following in the expansion context?`;

// ---------------------------------------------------------------------------
// Stage 3 — Retrieval
// ---------------------------------------------------------------------------

export const RETRIEVAL_STARTING = `Starting repository retrieval based on the approved intent...`;

export const RETRIEVAL_COMPLETE = `Retrieval complete. Reviewing structural findings before planning evidence assembly.`;

// ---------------------------------------------------------------------------
// Stage 4 — Evidence
// ---------------------------------------------------------------------------

export const EVIDENCE_PLAN_PREVIEW = `Here is the evidence assembly plan. Review the estimated scope before I materialize the full evidence bundle.`;

export const EVIDENCE_READY = `Evidence bundle assembled. Proceeding to synthesis.`;

// ---------------------------------------------------------------------------
// Stage 5 — Synthesis
// ---------------------------------------------------------------------------

export const SYNTHESIS_STARTING = `Synthesizing analysis from the evidence bundle...`;

export const SYNTHESIS_COMPLETE = `Synthesis complete. Here are the results.`;

// ---------------------------------------------------------------------------
// Stage 6 — Execution
// ---------------------------------------------------------------------------

export const EXECUTION_OFFER = `Would you like me to execute the proposed changes? (yes / no)`;

export const EXECUTION_COMPLETE = `Execution complete. Review the report below.`;

// ---------------------------------------------------------------------------
// Recursive restart
// ---------------------------------------------------------------------------

export const RECURSIVE_RESTART_OFFER = `This output could serve as a new intent for a follow-up analysis. Would you like to restart with it? (yes / no)`;
