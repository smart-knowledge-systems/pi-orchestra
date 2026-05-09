import { describe, it, expect } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateArtifact, validators } from '../../src/artifacts/schemas.ts';
import { ARTIFACT_TYPES, type ArtifactType } from '../../src/artifacts/types.ts';

const FIXTURES_DIR = resolve(import.meta.dir, '../fixtures/sample-artifacts');

// ---------------------------------------------------------------------------
// Happy-path: every spec fixture validates successfully
// ---------------------------------------------------------------------------

describe('schema validation — happy path fixtures', () => {
  for (const type of ARTIFACT_TYPES) {
    it(`validates ${type} fixture`, async () => {
      const filePath = resolve(FIXTURES_DIR, `${type}.json`);
      const data = await Bun.file(filePath).json();
      const result = validateArtifact(data);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Every v1 artifact type has a registered validator
// ---------------------------------------------------------------------------

describe('validator registry completeness', () => {
  it('has a validator for every artifact type', () => {
    for (const type of ARTIFACT_TYPES) {
      expect(typeof validators[type]).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid artifact shapes fail with clear errors
// ---------------------------------------------------------------------------

describe('schema validation — invalid shapes', () => {
  it('rejects null', () => {
    const result = validateArtifact(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('artifact must be a non-null object');
  });

  it('rejects non-object', () => {
    const result = validateArtifact('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects missing artifact_type', () => {
    const result = validateArtifact({ artifact_id: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('artifact_type must be a string');
  });

  it('rejects unknown artifact_type', () => {
    const result = validateArtifact({ artifact_type: 'unknown-v99', artifact_id: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown artifact_type/);
  });

  it('rejects intent-capture-v1 missing required fields', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/intent-capture@1',
      artifact_id: 'test',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('user_intent_verbatim must be a string');
    expect(result.errors).toContain('cleaned_user_intent must be a string');
    expect(result.errors).toContain('tagged_files must be an array');
    expect(result.errors).toContain('timestamp must be a string');
  });

  it('rejects intent-capture-v1 with bad intent_file_refs entries', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/intent-capture@1',
      artifact_id: 'test',
      user_intent_verbatim: 'x',
      cleaned_user_intent: 'x',
      tagged_files: [],
      timestamp: '2026-04-17T00:00:00Z',
      intent_file_refs: [
        { path: 'a', source: 'bogus' },
        { path: 123, source: 'inline' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('intent_file_refs[0].source'))).toBe(true);
    expect(result.errors).toContain('intent_file_refs[1].path must be a string');
  });

  it('rejects intent-restatement-v1 with wrong field types', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/intent-restatement@1',
      artifact_id: 'test',
      intent_capture_id: 'x',
      user_intent_verbatim: 'x',
      restated_intent: 'x',
      approved: 'yes', // should be boolean
      expand_requested: true,
      approval_turns: 'one', // should be number
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('approved must be a boolean');
    expect(result.errors).toContain('approval_turns must be a number');
  });

  it('rejects expansion-input-v1 with invalid included_files entries', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/expansion-input@1',
      artifact_id: 'test',
      intent_capture_id: 'x',
      intent_restatement_id: 'x',
      user_intent_verbatim: 'x',
      approved_restated_intent: 'x',
      included_files: [{ path: 123, reason: 'tagged' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('included_files[0].path must be a string');
  });

  it('rejects intent-spec-v1 with missing expanded_spec fields', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/intent-spec@1',
      artifact_id: 'test',
      expansion_input_id: 'x',
      user_intent_verbatim: 'x',
      approved_restated_intent: 'x',
      expanded_spec: { objective: 'ok' },
      approved: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('deliverables must be an array');
  });

  it('rejects retrieval-index-v1 with wrong intent_spec_id type', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: 'test',
      intent_capture_id: 'x',
      intent_restatement_id: 'x',
      intent_spec_id: 42, // should be string or null
      query: 'q',
      confidence: 'high',
      strategy_summary: 's',
      scout_terms: [],
      files: [],
      cross_file_findings: [],
      gaps: [],
      followup_queries: [],
      recommended_evidence: {
        files: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('intent_spec_id must be a string or null');
  });

  it('rejects retrieval-index-v1 missing strategy metadata and recommended_evidence', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: 'test',
      intent_capture_id: 'x',
      intent_restatement_id: 'x',
      intent_spec_id: null,
      query: 'q',
      confidence: 'high',
      files: [],
      cross_file_findings: [],
      gaps: [],
      followup_queries: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('strategy_summary must be a string');
    expect(result.errors).toContain('scout_terms must be an array');
    expect(result.errors).toContain('recommended_evidence must be an object');
  });

  it('rejects retrieval-index-v1 file with invalid selection_tier and default_evidence_mode', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: 'test',
      intent_capture_id: 'x',
      intent_restatement_id: 'x',
      intent_spec_id: null,
      query: 'q',
      confidence: 'high',
      strategy_summary: 's',
      scout_terms: [],
      files: [
        {
          file_id: 'f1',
          path: '/abs/x.ts',
          why_relevant: 'y',
          file_summary: 'z',
          ast_skeleton: [],
          recommended_expansion: 'none',
          expansion_reason: '',
          selection_tier: 'maybe',
          selection_reason: '',
          default_evidence_mode: 'nope',
          symbols: [
            {
              symbol_id: 's1',
              kind: 'function',
              name: 'foo',
              start: 1,
              count: 1,
              summary: '',
              role_in_system: '',
              depends_on: [],
              used_by: [],
              relevance: 'high',
              change_likelihood: 'low',
              expansion_priority: 'medium',
              recommended_expansion: 'none',
              expansion_reason: '',
              selected_by_default: 'yes',
              default_neighbor_lines: '4',
              selection_reason: 42,
            },
          ],
        },
      ],
      cross_file_findings: [],
      gaps: [],
      followup_queries: [],
      recommended_evidence: {
        files: [],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('files[0].selection_tier'))).toBe(true);
    expect(result.errors.some((e) => e.includes('files[0].default_evidence_mode'))).toBe(true);
    expect(result.errors).toContain('files[0].symbols[0].selected_by_default must be a boolean');
    expect(result.errors).toContain('files[0].symbols[0].default_neighbor_lines must be a number');
    expect(result.errors).toContain('files[0].symbols[0].selection_reason must be a string');
  });

  it('rejects retrieval-index-v1 with malformed recommended_evidence spans', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/retrieval-index@1',
      artifact_id: 'test',
      intent_capture_id: 'x',
      intent_restatement_id: 'x',
      intent_spec_id: null,
      query: 'q',
      confidence: 'high',
      strategy_summary: 's',
      scout_terms: [],
      files: [],
      cross_file_findings: [],
      gaps: [],
      followup_queries: [],
      recommended_evidence: {
        files: [
          {
            file_id: 'f1',
            include_ast_skeleton: true,
            include_retriever_summary: true,
            include_entire_file: false,
            spans: [
              {
                symbol_id: 's1',
                include_span: 'yes',
                neighbor_lines: 'four',
              },
            ],
          },
        ],
        include_cross_file_findings: 'no',
        include_gaps: false,
        include_followup_queries: false,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'recommended_evidence.files[0].spans[0].include_span must be a boolean',
    );
    expect(result.errors).toContain(
      'recommended_evidence.files[0].spans[0].neighbor_lines must be a number',
    );
    expect(result.errors).toContain(
      'recommended_evidence.include_cross_file_findings must be a boolean',
    );
  });

  it('rejects evidence-plan-v1 with wrong retrieval_index.artifact_type', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/evidence-plan@1',
      artifact_id: 'test',
      retrieval_index: { artifact_type: 'wrong', artifact_id: 'x' },
      selection: {},
      assembly_options: {},
      prompt_sections: {},
      target_task: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'retrieval_index.artifact_type must be "piorx/retrieval-index@1"',
    );
  });

  it('rejects execution-report-v1 with invalid validation block', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/execution-report@1',
      artifact_id: 'test',
      change_spec_id: 'x',
      status: 'completed',
      modified_files: [],
      validation: { commands: [], passed: 'yes' },
      notes: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('passed must be a boolean');
  });

  it('rejects recursive-intent-v1 with non-number restart_stage', () => {
    const result = validateArtifact({
      artifact_type: 'piorx/recursive-intent@1',
      artifact_id: 'test',
      source_artifact_type: 'piorx/analysis-report@1',
      source_artifact_id: 'x',
      new_user_intent_verbatim: 'x',
      restart_stage: 'one',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('restart_stage must be a number');
  });
});

// ---------------------------------------------------------------------------
// WorkflowSpecV1 — structural validator
// ---------------------------------------------------------------------------

describe('schema validation — workflow-spec', () => {
  function makeWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      artifact_type: 'piorx/workflow-spec@1',
      artifact_id: 'workflow_test',
      id: 'piorx/workflow/test@1',
      name: 'Test workflow',
      description: 'A workflow used in validator tests.',
      goals: ['Goal A'],
      operating_mode: 'supervised-change',
      mandatory_controls: ['intent.approval'],
      stages: [
        {
          id: 'restatement',
          name: 'Restatement',
          description: 'Capture intent and produce a restatement.',
          inputs: ['piorx/intent-capture@1'],
          output: 'piorx/intent-restatement@1',
          model_class: 'deterministic',
        },
      ],
      edges: [],
      recursive_promotion_target: 'restatement',
      ...overrides,
    };
  }

  it('accepts a minimal well-formed workflow spec', () => {
    const result = validateArtifact(makeWorkflow());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an unknown operating_mode', () => {
    const result = validateArtifact(makeWorkflow({ operating_mode: 'free-for-all' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('operating_mode'))).toBe(true);
  });

  it('rejects a non-string recursive_promotion_target', () => {
    const result = validateArtifact(makeWorkflow({ recursive_promotion_target: 42 }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('recursive_promotion_target must be a string');
  });

  it('rejects stages with non-string inputs entries', () => {
    const bad = makeWorkflow({
      stages: [
        {
          id: 'restatement',
          name: 'Restatement',
          description: 'x',
          inputs: ['piorx/intent-capture@1', 123],
          output: 'piorx/intent-restatement@1',
          model_class: 'deterministic',
        },
      ],
    });
    const result = validateArtifact(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('stages[0].inputs[1]'))).toBe(true);
  });

  it('rejects edges with non-object when predicate', () => {
    const bad = makeWorkflow({
      edges: [{ from: 'a', to: 'b', description: 'x', when: 'not-an-object' }],
    });
    const result = validateArtifact(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('edges[0].when'))).toBe(true);
  });

  it('rejects unknown failure_handling on stage control', () => {
    const bad = makeWorkflow({
      stages: [
        {
          id: 'restatement',
          name: 'Restatement',
          description: 'x',
          inputs: ['piorx/intent-capture@1'],
          output: 'piorx/intent-restatement@1',
          model_class: 'deterministic',
          control: { failure_handling: 'panic' },
        },
      ],
    });
    const result = validateArtifact(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('failure_handling'))).toBe(true);
  });

  it('accepts representable extends + stage_overrides without semantic enforcement', () => {
    const result = validateArtifact(
      makeWorkflow({
        extends: 'piorx/workflow/default@1',
        stage_overrides: {
          synthesis: { model_class: 'llm-with-advisor', gates: ['synthesis.advisor-review'] },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts representable workflow_ref on a stage without semantic enforcement', () => {
    const result = validateArtifact(
      makeWorkflow({
        stages: [
          {
            id: 'composite',
            name: 'Composite stage',
            description: 'Delegates to a sub-workflow.',
            inputs: ['piorx/intent-capture@1'],
            output: 'piorx/intent-restatement@1',
            model_class: 'composite',
            workflow_ref: 'piorx/workflow/restatement-only@1',
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects stages declaring both workflow_ref and inline workflow', () => {
    const bad = makeWorkflow({
      stages: [
        {
          id: 'composite',
          name: 'Composite',
          description: 'x',
          inputs: ['piorx/intent-capture@1'],
          output: 'piorx/intent-restatement@1',
          model_class: 'composite',
          workflow_ref: 'piorx/workflow/foo@1',
          workflow: makeWorkflow(),
        },
      ],
    });
    const result = validateArtifact(bad);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('cannot declare both workflow_ref and inline workflow')),
    ).toBe(true);
  });

  it('accepts a representable inline sub-workflow', () => {
    const inline = {
      id: 'piorx/workflow/sub@1',
      name: 'Sub-workflow',
      description: 'Nested.',
      goals: [],
      operating_mode: 'advisory',
      mandatory_controls: [],
      stages: [
        {
          id: 'restatement',
          name: 'Restatement',
          description: 'x',
          inputs: ['piorx/intent-capture@1'],
          output: 'piorx/intent-restatement@1',
          model_class: 'deterministic',
        },
      ],
      edges: [],
      recursive_promotion_target: 'restatement',
    };
    const result = validateArtifact(
      makeWorkflow({
        stages: [
          {
            id: 'composite',
            name: 'Composite',
            description: 'x',
            inputs: ['piorx/intent-capture@1'],
            output: 'piorx/intent-restatement@1',
            model_class: 'composite',
            workflow: inline,
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });
});
