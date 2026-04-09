import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  selectTaskType,
  renderAnalysisReport,
  renderChangeSpec,
  renderSynthesisResult,
  loadAndRenderSynthesis,
} from '../../src/conductor/synthesis.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import type { AnalysisReportV1, ChangeSpecV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Task-type selection heuristic tests
// ---------------------------------------------------------------------------

describe('selectTaskType', () => {
  it('selects analysis-report for explanation intent', () => {
    expect(selectTaskType('Explain how the authentication module works')).toBe('analysis-report');
  });

  it('selects analysis-report for analysis intent', () => {
    expect(selectTaskType('Analyze the performance of the query layer')).toBe('analysis-report');
  });

  it('selects analysis-report for review intent', () => {
    expect(selectTaskType('Review the error handling patterns')).toBe('analysis-report');
  });

  it('selects change-spec for implementation intent', () => {
    expect(selectTaskType('Implement a new caching layer')).toBe('change-spec');
  });

  it('selects change-spec for fix intent', () => {
    expect(selectTaskType('Fix the null pointer bug in user service')).toBe('change-spec');
  });

  it('selects change-spec for refactor intent', () => {
    expect(selectTaskType('Refactor the database connection pool')).toBe('change-spec');
  });

  it('selects change-spec for add intent', () => {
    expect(selectTaskType('Add input validation to the API endpoints')).toBe('change-spec');
  });

  it('defaults to analysis-report when ambiguous', () => {
    expect(selectTaskType('Something about the code')).toBe('analysis-report');
  });

  it('defaults to analysis-report when tied', () => {
    // 'explain' + 'fix' = 1 each, tie defaults to analysis-report
    expect(selectTaskType('Explain how to fix the issue')).toBe('analysis-report');
  });

  it('selects based on dominant signals', () => {
    // Multiple execution signals should win
    expect(selectTaskType('Implement, add, and update the module')).toBe('change-spec');
  });

  it('is case-insensitive', () => {
    expect(selectTaskType('IMPLEMENT the feature')).toBe('change-spec');
    expect(selectTaskType('EXPLAIN the architecture')).toBe('analysis-report');
  });

  it('handles empty intent by defaulting to analysis-report', () => {
    expect(selectTaskType('')).toBe('analysis-report');
  });
});

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

function makeAnalysisReport(): AnalysisReportV1 {
  return {
    artifact_type: 'analysis-report-v1',
    artifact_id: 'analysis_test_001',
    evidence_bundle_id: 'bundle_test_001',
    summary: 'The auth module uses JWT tokens with a custom validator',
    findings: ['Token validation is synchronous', 'No refresh token support'],
    risks: ['Tokens may expire during long operations'],
    recommended_next_steps: ['Add refresh token flow', 'Consider async validation'],
  };
}

function makeChangeSpec(): ChangeSpecV1 {
  return {
    artifact_type: 'change-spec-v1',
    artifact_id: 'change_test_001',
    evidence_bundle_id: 'bundle_test_001',
    change_goal: 'Add refresh token support to auth module',
    summary: 'Two-file change to add refresh token logic',
    edits: [
      {
        path: '/repo/src/auth.ts',
        target: { kind: 'function', name: 'validateToken', start: 10, count: 20 },
        intent: 'Add refresh token check before expiry rejection',
        required_changes: ['Add refresh token validation path'],
        constraints: ['Must not break existing token flow'],
      },
    ],
    tests: ['refresh token accepted', 'expired token still rejected without refresh'],
    acceptance_criteria: ['All existing auth tests pass', 'New refresh flow works'],
  };
}

describe('renderAnalysisReport', () => {
  it('renders summary section', () => {
    const rendered = renderAnalysisReport(makeAnalysisReport());
    expect(rendered.task_type).toBe('analysis-report');
    expect(rendered.title).toBe('Analysis Report');
    expect(rendered.sections[0]!.heading).toBe('Summary');
    expect(rendered.sections[0]!.content).toContain('JWT tokens');
  });

  it('renders findings as numbered list', () => {
    const rendered = renderAnalysisReport(makeAnalysisReport());
    const findings = rendered.sections.find((s) => s.heading === 'Findings');
    expect(findings).toBeDefined();
    expect(findings!.content).toContain('1.');
    expect(findings!.content).toContain('2.');
  });

  it('renders risks section', () => {
    const rendered = renderAnalysisReport(makeAnalysisReport());
    const risks = rendered.sections.find((s) => s.heading === 'Risks');
    expect(risks).toBeDefined();
    expect(risks!.content).toContain('expire');
  });

  it('renders recommended next steps', () => {
    const rendered = renderAnalysisReport(makeAnalysisReport());
    const steps = rendered.sections.find((s) => s.heading === 'Recommended Next Steps');
    expect(steps).toBeDefined();
    expect(steps!.content).toContain('refresh token');
  });

  it('does not include evidence_bundle_id in rendered output', () => {
    const rendered = renderAnalysisReport(makeAnalysisReport());
    const allContent = rendered.sections.map((s) => s.content).join(' ');
    expect(allContent).not.toContain('bundle_test_001');
  });

  it('omits empty sections', () => {
    const report = makeAnalysisReport();
    report.risks = [];
    const rendered = renderAnalysisReport(report);
    expect(rendered.sections.find((s) => s.heading === 'Risks')).toBeUndefined();
  });

  it('preserves artifact_id in rendered result', () => {
    const rendered = renderAnalysisReport(makeAnalysisReport());
    expect(rendered.artifact_id).toBe('analysis_test_001');
  });
});

describe('renderChangeSpec', () => {
  it('renders change goal and summary', () => {
    const rendered = renderChangeSpec(makeChangeSpec());
    expect(rendered.task_type).toBe('change-spec');
    expect(rendered.title).toBe('Change Specification');
    expect(rendered.sections[0]!.heading).toBe('Change Goal');
    expect(rendered.sections[1]!.heading).toBe('Summary');
  });

  it('renders edit paths and intents without raw content', () => {
    const rendered = renderChangeSpec(makeChangeSpec());
    const edits = rendered.sections.find((s) => s.heading === 'Proposed Edits');
    expect(edits).toBeDefined();
    expect(edits!.content).toContain('/repo/src/auth.ts');
    expect(edits!.content).toContain('refresh token check');
    // Must NOT contain raw code, target details, or required_changes internals
    expect(edits!.content).not.toContain('validateToken');
    expect(edits!.content).not.toContain('start');
    expect(edits!.content).not.toContain('count');
  });

  it('renders tests section', () => {
    const rendered = renderChangeSpec(makeChangeSpec());
    const tests = rendered.sections.find((s) => s.heading === 'Tests');
    expect(tests).toBeDefined();
    expect(tests!.content).toContain('refresh token accepted');
  });

  it('renders acceptance criteria', () => {
    const rendered = renderChangeSpec(makeChangeSpec());
    const criteria = rendered.sections.find((s) => s.heading === 'Acceptance Criteria');
    expect(criteria).toBeDefined();
  });

  it('does not include evidence_bundle_id in rendered output', () => {
    const rendered = renderChangeSpec(makeChangeSpec());
    const allContent = rendered.sections.map((s) => s.content).join(' ');
    expect(allContent).not.toContain('bundle_test_001');
  });

  it('preserves artifact_id in rendered result', () => {
    const rendered = renderChangeSpec(makeChangeSpec());
    expect(rendered.artifact_id).toBe('change_test_001');
  });
});

describe('renderSynthesisResult', () => {
  it('dispatches analysis-report-v1 to renderAnalysisReport', () => {
    const result = renderSynthesisResult(makeAnalysisReport());
    expect(result.task_type).toBe('analysis-report');
    expect(result.title).toBe('Analysis Report');
  });

  it('dispatches change-spec-v1 to renderChangeSpec', () => {
    const result = renderSynthesisResult(makeChangeSpec());
    expect(result.task_type).toBe('change-spec');
    expect(result.title).toBe('Change Specification');
  });
});

// ---------------------------------------------------------------------------
// Rendering never exposes raw source through synthesis results
// ---------------------------------------------------------------------------

describe('rendering boundary', () => {
  it('analysis-report rendering contains no raw evidence fields', () => {
    const report = makeAnalysisReport();
    const rendered = renderAnalysisReport(report);
    const allText = JSON.stringify(rendered);
    // Should not contain evidence_bundle_id or any raw_evidence-like fields
    expect(allText).not.toContain('evidence_bundle_id');
    expect(allText).not.toContain('raw_evidence');
    expect(allText).not.toContain('structural_context');
  });

  it('change-spec rendering contains no raw evidence fields', () => {
    const spec = makeChangeSpec();
    const rendered = renderChangeSpec(spec);
    const allText = JSON.stringify(rendered);
    expect(allText).not.toContain('evidence_bundle_id');
    expect(allText).not.toContain('raw_evidence');
    expect(allText).not.toContain('required_changes');
    expect(allText).not.toContain('constraints');
  });
});

// ---------------------------------------------------------------------------
// loadAndRenderSynthesis integration
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `synth-render-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadAndRenderSynthesis', () => {
  it('loads and renders an analysis-report from store', async () => {
    const report = makeAnalysisReport();
    await store.put(report);
    const rendered = await loadAndRenderSynthesis(store, report.artifact_id, 'analysis-report');
    expect(rendered).not.toBeNull();
    expect(rendered!.task_type).toBe('analysis-report');
    expect(rendered!.artifact_id).toBe(report.artifact_id);
  });

  it('loads and renders a change-spec from store', async () => {
    const spec = makeChangeSpec();
    await store.put(spec);
    const rendered = await loadAndRenderSynthesis(store, spec.artifact_id, 'change-spec');
    expect(rendered).not.toBeNull();
    expect(rendered!.task_type).toBe('change-spec');
  });

  it('returns null for missing artifact', async () => {
    const rendered = await loadAndRenderSynthesis(store, 'nonexistent', 'analysis-report');
    expect(rendered).toBeNull();
  });
});
