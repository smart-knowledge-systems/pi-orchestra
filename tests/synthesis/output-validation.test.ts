import { describe, it, expect } from 'bun:test';
import { validateWorkerOutput, SynthesisValidationError } from '../../src/synthesis/worker.ts';

// ---------------------------------------------------------------------------
// Valid fixtures
// ---------------------------------------------------------------------------

function validAnalysisReport() {
  return {
    artifact_type: 'analysis-report-v1',
    artifact_id: 'analysis_test_001',
    evidence_bundle_id: 'bundle_001',
    summary: 'Analysis complete',
    findings: ['Found X', 'Found Y'],
    risks: ['Risk A'],
    recommended_next_steps: ['Step 1'],
  };
}

function validChangeSpec() {
  return {
    artifact_type: 'change-spec-v1',
    artifact_id: 'change_test_001',
    evidence_bundle_id: 'bundle_001',
    change_goal: 'Refactor auth',
    summary: 'Change specification',
    edits: [
      {
        path: '/repo/src/auth.ts',
        target: { kind: 'function', name: 'validate', start: 10, count: 20 },
        intent: 'Simplify validation',
        required_changes: ['Remove unused branch'],
        constraints: [],
      },
    ],
    tests: ['Test auth flow'],
    acceptance_criteria: ['All tests pass'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateWorkerOutput', () => {
  it('accepts valid analysis-report-v1', () => {
    const output = validateWorkerOutput(validAnalysisReport(), 'analysis-report');
    expect(output.artifact_type).toBe('analysis-report-v1');
  });

  it('accepts valid change-spec-v1', () => {
    const output = validateWorkerOutput(validChangeSpec(), 'change-spec');
    expect(output.artifact_type).toBe('change-spec-v1');
  });

  it('rejects null output', () => {
    expect(() => validateWorkerOutput(null, 'analysis-report')).toThrow(SynthesisValidationError);
  });

  it('rejects non-object output', () => {
    expect(() => validateWorkerOutput('string', 'analysis-report')).toThrow(
      SynthesisValidationError,
    );
  });

  it('rejects wrong artifact_type for analysis-report', () => {
    const output = { ...validChangeSpec() };
    try {
      validateWorkerOutput(output, 'analysis-report');
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisValidationError);
      expect((err as SynthesisValidationError).message).toContain('analysis-report-v1');
    }
  });

  it('rejects wrong artifact_type for change-spec', () => {
    const output = { ...validAnalysisReport() };
    try {
      validateWorkerOutput(output, 'change-spec');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisValidationError);
      expect((err as SynthesisValidationError).message).toContain('change-spec-v1');
    }
  });

  it('rejects analysis-report missing required fields', () => {
    const output = {
      artifact_type: 'analysis-report-v1',
      artifact_id: 'analysis_bad',
      // missing evidence_bundle_id, summary, findings, risks, recommended_next_steps
    };
    try {
      validateWorkerOutput(output, 'analysis-report');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisValidationError);
      const sve = err as SynthesisValidationError;
      expect(sve.validation.valid).toBe(false);
      expect(sve.validation.errors.length).toBeGreaterThan(0);
      expect(sve.message).toContain('schema validation');
    }
  });

  it('rejects change-spec missing required fields', () => {
    const output = {
      artifact_type: 'change-spec-v1',
      artifact_id: 'change_bad',
      // missing fields
    };
    try {
      validateWorkerOutput(output, 'change-spec');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisValidationError);
      const sve = err as SynthesisValidationError;
      expect(sve.validation.valid).toBe(false);
      expect(sve.validation.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects analysis-report with non-string findings', () => {
    const output = {
      ...validAnalysisReport(),
      findings: [123, true],
    };
    try {
      validateWorkerOutput(output, 'analysis-report');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisValidationError);
      expect(
        (err as SynthesisValidationError).validation.errors.some((e) => e.includes('findings')),
      ).toBe(true);
    }
  });

  it('provides clear error message for malformed output', () => {
    try {
      validateWorkerOutput({ artifact_type: 'analysis-report-v1' }, 'analysis-report');
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisValidationError);
      const sve = err as SynthesisValidationError;
      expect(sve.message).toContain('schema validation');
      // Errors should mention specific missing fields
      expect(sve.validation.errors.some((e) => e.includes('artifact_id'))).toBe(true);
    }
  });

  it('SynthesisValidationError exposes validation result', () => {
    try {
      validateWorkerOutput(null, 'analysis-report');
    } catch (err) {
      expect(err).toBeInstanceOf(SynthesisValidationError);
      const sve = err as SynthesisValidationError;
      expect(sve.validation).toBeDefined();
      expect(sve.validation.valid).toBe(false);
      expect(sve.validation.errors.length).toBeGreaterThan(0);
      expect(sve.name).toBe('SynthesisValidationError');
    }
  });
});
