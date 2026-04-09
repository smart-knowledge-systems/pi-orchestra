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
      artifact_type: 'intent-capture-v1',
      artifact_id: 'test',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('user_intent_verbatim must be a string');
    expect(result.errors).toContain('tagged_files must be an array');
    expect(result.errors).toContain('timestamp must be a string');
  });

  it('rejects intent-restatement-v1 with wrong field types', () => {
    const result = validateArtifact({
      artifact_type: 'intent-restatement-v1',
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
      artifact_type: 'expansion-input-v1',
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
      artifact_type: 'intent-spec-v1',
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
      artifact_type: 'retrieval-index-v1',
      artifact_id: 'test',
      intent_capture_id: 'x',
      intent_restatement_id: 'x',
      intent_spec_id: 42, // should be string or null
      query: 'q',
      confidence: 'high',
      files: [],
      cross_file_findings: [],
      gaps: [],
      followup_queries: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('intent_spec_id must be a string or null');
  });

  it('rejects evidence-plan-v1 with wrong retrieval_index.artifact_type', () => {
    const result = validateArtifact({
      artifact_type: 'evidence-plan-v1',
      artifact_id: 'test',
      retrieval_index: { artifact_type: 'wrong', artifact_id: 'x' },
      selection: {},
      assembly_options: {},
      prompt_sections: {},
      target_task: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('retrieval_index.artifact_type must be "retrieval-index-v1"');
  });

  it('rejects execution-report-v1 with invalid validation block', () => {
    const result = validateArtifact({
      artifact_type: 'execution-report-v1',
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
      artifact_type: 'recursive-intent-v1',
      artifact_id: 'test',
      source_artifact_type: 'analysis-report-v1',
      source_artifact_id: 'x',
      new_user_intent_verbatim: 'x',
      restart_stage: 'one',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('restart_stage must be a number');
  });
});
