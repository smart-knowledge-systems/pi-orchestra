/**
 * Conductor synthesis helpers.
 *
 * Provides task-type heuristic selection (explanation -> analysis-report,
 * execution handoff -> change-spec) and a user-facing result renderer
 * that never exposes raw bundle content.
 */

import type { ArtifactStore } from '../artifacts/store.ts';
import type { AnalysisReportV1, ChangeSpecV1 } from '../artifacts/types.ts';
import type { SynthesisTaskType } from '../services/synthesis-dispatch.ts';
import type { StageMachine } from './stage-machine.ts';

// ---------------------------------------------------------------------------
// Task-type heuristic selection
// ---------------------------------------------------------------------------

/**
 * Intent signals that suggest the user wants an explanation or analysis
 * rather than code changes.
 */
const EXPLANATION_SIGNALS = [
  'explain',
  'analyze',
  'understand',
  'describe',
  'summarize',
  'review',
  'audit',
  'investigate',
  'how does',
  'what does',
  'why does',
  'what is',
  'overview',
  'documentation',
  'report',
  'assessment',
] as const;

/**
 * Intent signals that suggest the user wants executable code changes.
 */
const EXECUTION_SIGNALS = [
  'implement',
  'fix',
  'refactor',
  'add',
  'remove',
  'change',
  'update',
  'modify',
  'create',
  'delete',
  'rename',
  'move',
  'migrate',
  'upgrade',
  'replace',
  'rewrite',
  'build',
] as const;

/**
 * Select a synthesis task type based on the approved restated intent.
 *
 * Uses keyword heuristics to decide between analysis-report and change-spec.
 * Defaults to analysis-report when signals are ambiguous.
 */
export function selectTaskType(approvedRestatedIntent: string): SynthesisTaskType {
  const lower = approvedRestatedIntent.toLowerCase();

  let explanationScore = 0;
  let executionScore = 0;

  for (const signal of EXPLANATION_SIGNALS) {
    if (lower.includes(signal)) {
      explanationScore++;
    }
  }

  for (const signal of EXECUTION_SIGNALS) {
    if (lower.includes(signal)) {
      executionScore++;
    }
  }

  // Execution wins only with a strictly higher score
  if (executionScore > explanationScore) {
    return 'change-spec';
  }

  // Default to analysis-report when tied or explanation wins
  return 'analysis-report';
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/**
 * Rendered synthesis result for user-facing display.
 * Never includes raw evidence or bundle internals.
 */
export interface RenderedSynthesisResult {
  task_type: SynthesisTaskType;
  artifact_id: string;
  title: string;
  sections: RenderedSection[];
}

export interface RenderedSection {
  heading: string;
  content: string;
}

/**
 * Render an analysis-report-v1 for user display.
 * Excludes any raw evidence or bundle content.
 */
export function renderAnalysisReport(report: AnalysisReportV1): RenderedSynthesisResult {
  const sections: RenderedSection[] = [{ heading: 'Summary', content: report.summary }];

  if (report.findings.length > 0) {
    sections.push({
      heading: 'Findings',
      content: report.findings.map((f, i) => `${i + 1}. ${f}`).join('\n'),
    });
  }

  if (report.risks.length > 0) {
    sections.push({
      heading: 'Risks',
      content: report.risks.map((r, i) => `${i + 1}. ${r}`).join('\n'),
    });
  }

  if (report.recommended_next_steps.length > 0) {
    sections.push({
      heading: 'Recommended Next Steps',
      content: report.recommended_next_steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    });
  }

  return {
    task_type: 'analysis-report',
    artifact_id: report.artifact_id,
    title: 'Analysis Report',
    sections,
  };
}

/**
 * Render a change-spec-v1 for user display.
 * Excludes raw evidence — shows only edit intents, paths, and criteria.
 */
export function renderChangeSpec(spec: ChangeSpecV1): RenderedSynthesisResult {
  const sections: RenderedSection[] = [
    { heading: 'Change Goal', content: spec.change_goal },
    { heading: 'Summary', content: spec.summary },
  ];

  if (spec.edits.length > 0) {
    const editLines = spec.edits.map((e, i) => `${i + 1}. ${e.path} — ${e.intent}`);
    sections.push({
      heading: 'Proposed Edits',
      content: editLines.join('\n'),
    });
  }

  if (spec.tests.length > 0) {
    sections.push({
      heading: 'Tests',
      content: spec.tests.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    });
  }

  if (spec.acceptance_criteria.length > 0) {
    sections.push({
      heading: 'Acceptance Criteria',
      content: spec.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    });
  }

  return {
    task_type: 'change-spec',
    artifact_id: spec.artifact_id,
    title: 'Change Specification',
    sections,
  };
}

/**
 * Render a synthesis artifact for user display, dispatching by type.
 */
export function renderSynthesisResult(
  artifact: AnalysisReportV1 | ChangeSpecV1,
): RenderedSynthesisResult {
  if (artifact.artifact_type === 'analysis-report-v1') {
    return renderAnalysisReport(artifact);
  }
  return renderChangeSpec(artifact);
}

/**
 * Load and render a synthesis result from the store.
 * Returns null if the artifact is not found.
 */
export async function loadAndRenderSynthesis(
  store: ArtifactStore,
  artifactId: string,
  taskType: SynthesisTaskType,
): Promise<RenderedSynthesisResult | null> {
  const type =
    taskType === 'analysis-report' ? ('analysis-report-v1' as const) : ('change-spec-v1' as const);
  const artifact = await store.get(type, artifactId);
  if (!artifact) return null;
  return renderSynthesisResult(artifact as AnalysisReportV1 | ChangeSpecV1);
}
