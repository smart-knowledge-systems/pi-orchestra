/**
 * Synthesis prompt assembly.
 *
 * Assembles deterministic prompt sections from a stored evidence-bundle-v1
 * without free-form context mixing. Only requested bundle sections are
 * included; the prompt never reaches back into raw source outside the bundle.
 *
 * COMP-P3-T2: when advisor is enabled the synthesis system prompt prepends
 * `ADVISOR_TOOL_INSTRUCTIONS` — Claude Code's production system-prompt block
 * for advisor-aware loops, ported verbatim per `docs/advisor-strategy-
 * assessment.md` §4.5. The block is omitted entirely when advisor is off so
 * the byte-identical Phase 2 path stays untouched.
 */

import type { EvidenceBundleV1 } from '../artifacts/types.ts';

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

export type SynthesisSection = 'intent_context' | 'structural_context' | 'raw_evidence';

export interface SynthesisPromptOptions {
  /** Which bundle sections to include in the prompt. */
  sections: SynthesisSection[];
  /** Additional deterministic instructions appended after evidence. */
  instructions: string;
  /** Task type label for the output format directive. */
  task_type: 'analysis-report' | 'change-spec';
}

export interface AssembledPrompt {
  /** The assembled prompt text ready for the synthesis worker. */
  text: string;
  /** Which sections were actually included. */
  included_sections: SynthesisSection[];
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderIntentContext(bundle: EvidenceBundleV1): string {
  const lines: string[] = [
    '## Intent Context',
    '',
    `**User intent:** ${bundle.intent_context.user_intent_verbatim}`,
    '',
    `**Restated intent:** ${bundle.intent_context.approved_restated_intent}`,
  ];
  if (bundle.intent_context.intent_spec_id) {
    lines.push('', `**Intent spec:** ${bundle.intent_context.intent_spec_id}`);
  }
  return lines.join('\n');
}

function renderStructuralContext(bundle: EvidenceBundleV1): string {
  const lines: string[] = ['## Structural Context', ''];

  for (const file of bundle.structural_context.files) {
    lines.push(`### ${file.path}`);
    if (file.file_summary) {
      lines.push('', file.file_summary);
    }
    if (file.ast_skeleton.length > 0) {
      lines.push('', '**AST Skeleton:**');
      for (const entry of file.ast_skeleton) {
        lines.push(`- ${entry}`);
      }
    }
    if (file.symbols.length > 0) {
      lines.push('', '**Symbols:**');
      for (const sym of file.symbols) {
        lines.push(
          `- \`${sym.name}\` (lines ${sym.start}–${sym.start + sym.count - 1}): ${sym.summary}`,
        );
      }
    }
    lines.push('');
  }

  if (bundle.structural_context.cross_file_findings.length > 0) {
    lines.push('### Cross-file findings');
    for (const finding of bundle.structural_context.cross_file_findings) {
      lines.push(`- ${finding}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderRawEvidence(bundle: EvidenceBundleV1): string {
  const lines: string[] = ['## Raw Evidence', ''];

  for (const ev of bundle.raw_evidence) {
    lines.push(
      `### ${ev.path} — ${ev.label} (${ev.kind}, lines ${ev.start}–${ev.start + ev.count - 1})`,
    );
    lines.push('');
    lines.push('```');
    lines.push(ev.content);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

const SECTION_RENDERERS: Record<SynthesisSection, (bundle: EvidenceBundleV1) => string> = {
  intent_context: renderIntentContext,
  structural_context: renderStructuralContext,
  raw_evidence: renderRawEvidence,
};

// ---------------------------------------------------------------------------
// Output format directives
// ---------------------------------------------------------------------------

const OUTPUT_DIRECTIVES: Record<'analysis-report' | 'change-spec', string> = {
  'analysis-report': [
    '## Output Format',
    '',
    'Produce a JSON object with artifact_type "piorx/analysis-report@1" containing:',
    '- evidence_bundle_id: the bundle ID provided',
    '- summary: a concise summary of your analysis',
    '- findings: an array of key findings',
    '- risks: an array of identified risks',
    '- recommended_next_steps: an array of suggested next actions',
  ].join('\n'),
  'change-spec': [
    '## Output Format',
    '',
    'Produce a JSON object with artifact_type "piorx/change-spec@1" containing:',
    '- evidence_bundle_id: the bundle ID provided',
    '- change_goal: the high-level goal of the change',
    '- summary: a concise summary of the planned changes',
    '- edits: an array of edit objects, each with path, target (kind, name, start, count), intent, required_changes, and constraints',
    '- tests: an array of test descriptions',
    '- acceptance_criteria: an array of acceptance criteria',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a deterministic synthesis prompt from an evidence bundle.
 *
 * Only the sections listed in `options.sections` are included.
 * The prompt never reaches back into raw source outside the bundle.
 */
export function assembleSynthesisPrompt(
  bundle: EvidenceBundleV1,
  options: SynthesisPromptOptions,
): AssembledPrompt {
  const parts: string[] = [];
  const included: SynthesisSection[] = [];

  parts.push('# Synthesis Task');
  parts.push('');
  parts.push(`**Bundle ID:** ${bundle.artifact_id}`);
  parts.push(`**Plan ID:** ${bundle.evidence_plan_id}`);
  parts.push('');

  // Render only requested sections in deterministic order
  const orderedSections: SynthesisSection[] = [
    'intent_context',
    'structural_context',
    'raw_evidence',
  ];
  for (const section of orderedSections) {
    if (options.sections.includes(section)) {
      parts.push(SECTION_RENDERERS[section](bundle));
      included.push(section);
    }
  }

  // Output format directive
  parts.push(OUTPUT_DIRECTIVES[options.task_type]);
  parts.push('');

  // User instructions
  if (options.instructions) {
    parts.push('## Additional Instructions');
    parts.push('');
    parts.push(options.instructions);
    parts.push('');
  }

  return {
    text: parts.join('\n'),
    included_sections: included,
  };
}

// ---------------------------------------------------------------------------
// ADVISOR_TOOL_INSTRUCTIONS — Claude Code's production system-prompt block.
// ---------------------------------------------------------------------------
//
// Verbatim port of the `ADVISOR_TOOL_INSTRUCTIONS` constant Claude Code
// ships in `utils/advisor.ts:130-145` (advisor doc §4.5). Stamped into the
// synthesis system prompt only when advisor is enabled (`mode !== 'none'`)
// so that:
//
//   - The model sees the same instructions Claude Code's reference loop
//     already operates against — keeping piorx's advisor consultations
//     comparable to upstream's.
//   - The byte-identical Phase 2 behavior is preserved when advisor is off:
//     `synthesisSystemPrompt({ advisorEnabled: false })` returns the bare
//     directive with no advisor preamble.
//
// `synthesisSystemPrompt` is the helper the worker (`src/synthesis/worker.ts`)
// calls to assemble the system prompt — callers should NOT concatenate the
// constant manually, so the spacing / sentence-ordering stays uniform across
// every advisor-aware Stage that adopts the same pattern in Phase 4+.

export const ADVISOR_TOOL_INSTRUCTIONS = [
  '# Advisor Tool',
  '',
  "You have access to an `advisor` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.",
  '',
  "Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.",
  '',
  'Also call advisor:',
  "- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
  "- When stuck -- errors recurring, approach not converging, results that don't fit.",
  '- When considering a change of approach.',
  '',
  "On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.",
  '',
  "Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.",
  '',
  'If you\'ve already retrieved data pointing one way and the advisor points another: don\'t silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.',
].join('\n');

/**
 * Base synthesis directive — used both alone (advisor off) and as the
 * trailing block after `ADVISOR_TOOL_INSTRUCTIONS` (advisor on).
 */
export const SYNTHESIS_SYSTEM_DIRECTIVE =
  'You are piorx synthesis. Produce a single JSON object that satisfies the supplied JSON Schema. ' +
  'Respond with JSON only — no commentary, no surrounding markdown fences.';

export interface SynthesisSystemPromptOptions {
  /** True when advisor consultation is wired for this turn. */
  advisorEnabled: boolean;
}

/**
 * Build the system prompt for the synthesis worker.
 *
 * - `advisorEnabled: false` → the bare `SYNTHESIS_SYSTEM_DIRECTIVE` (no
 *   advisor preamble). Byte-identical with the Phase 2 default the worker
 *   would have used otherwise.
 * - `advisorEnabled: true`  → `ADVISOR_TOOL_INSTRUCTIONS` followed by a
 *   blank line and the synthesis directive. The advisor block is the
 *   verbatim Claude Code text; the directive ensures the executor still
 *   knows the JSON-only output contract.
 */
export function synthesisSystemPrompt(options: SynthesisSystemPromptOptions): string {
  if (!options.advisorEnabled) return SYNTHESIS_SYSTEM_DIRECTIVE;
  return `${ADVISOR_TOOL_INSTRUCTIONS}\n\n${SYNTHESIS_SYSTEM_DIRECTIVE}`;
}
