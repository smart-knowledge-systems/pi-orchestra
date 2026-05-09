/**
 * Synthesis prompt assembly.
 *
 * Assembles deterministic prompt sections from a stored evidence-bundle-v1
 * without free-form context mixing. Only requested bundle sections are
 * included; the prompt never reaches back into raw source outside the bundle.
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
