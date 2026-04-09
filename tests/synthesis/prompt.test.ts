import { describe, it, expect } from 'bun:test';
import {
  assembleSynthesisPrompt,
  type SynthesisPromptOptions,
} from '../../src/synthesis/prompt.ts';
import type { EvidenceBundleV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Fixture bundle
// ---------------------------------------------------------------------------

const FIXTURE_BUNDLE: EvidenceBundleV1 = {
  artifact_type: 'evidence-bundle-v1',
  artifact_id: 'bundle_test_001',
  evidence_plan_id: 'plan_test_001',
  intent_context: {
    user_intent_verbatim: 'Refactor the auth module',
    approved_restated_intent: 'Refactor the authentication module for clarity',
    intent_spec_id: 'spec_test_001',
  },
  structural_context: {
    files: [
      {
        path: '/repo/src/auth.ts',
        file_summary: 'Authentication middleware and token validation',
        ast_skeleton: ['function validateToken(...)', 'class AuthService'],
        symbols: [
          {
            name: 'validateToken',
            start: 10,
            count: 20,
            summary: 'Validates JWT tokens',
          },
        ],
      },
      {
        path: '/repo/src/session.ts',
        file_summary: 'Session management utilities',
        ast_skeleton: ['function createSession(...)'],
        symbols: [],
      },
    ],
    cross_file_findings: ['Auth and session are tightly coupled'],
  },
  raw_evidence: [
    {
      path: '/repo/src/auth.ts',
      kind: 'span',
      label: 'validateToken',
      start: 10,
      count: 20,
      content: 'function validateToken(token: string) {\n  // validation logic\n  return true;\n}',
    },
  ],
  stats: {
    files: 2,
    spans: 1,
    full_files: 0,
    total_lines: 30,
    estimated_tokens: 450,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assembleSynthesisPrompt', () => {
  it('includes only requested sections', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(result.included_sections).toEqual(['intent_context']);
    expect(result.text).toContain('## Intent Context');
    expect(result.text).not.toContain('## Structural Context');
    expect(result.text).not.toContain('## Raw Evidence');
  });

  it('includes all sections when all are requested', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context', 'structural_context', 'raw_evidence'],
      instructions: 'Focus on security',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(result.included_sections).toEqual([
      'intent_context',
      'structural_context',
      'raw_evidence',
    ]);
    expect(result.text).toContain('## Intent Context');
    expect(result.text).toContain('## Structural Context');
    expect(result.text).toContain('## Raw Evidence');
  });

  it('includes no sections when none are requested', () => {
    const opts: SynthesisPromptOptions = {
      sections: [],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(result.included_sections).toEqual([]);
    expect(result.text).not.toContain('## Intent Context');
    expect(result.text).not.toContain('## Structural Context');
    expect(result.text).not.toContain('## Raw Evidence');
    // Still has header and output directive
    expect(result.text).toContain('# Synthesis Task');
    expect(result.text).toContain('## Output Format');
  });

  it('renders intent context correctly', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(result.text).toContain('**User intent:** Refactor the auth module');
    expect(result.text).toContain(
      '**Restated intent:** Refactor the authentication module for clarity',
    );
    expect(result.text).toContain('**Intent spec:** spec_test_001');
  });

  it('omits intent spec line when null', () => {
    const bundle: EvidenceBundleV1 = {
      ...FIXTURE_BUNDLE,
      intent_context: {
        ...FIXTURE_BUNDLE.intent_context,
        intent_spec_id: null,
      },
    };
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(bundle, opts);
    expect(result.text).not.toContain('**Intent spec:**');
  });

  it('renders structural context with files, skeletons, symbols, and cross-file findings', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['structural_context'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(result.text).toContain('### /repo/src/auth.ts');
    expect(result.text).toContain('Authentication middleware and token validation');
    expect(result.text).toContain('**AST Skeleton:**');
    expect(result.text).toContain('- function validateToken(...)');
    expect(result.text).toContain('**Symbols:**');
    expect(result.text).toContain('`validateToken`');
    expect(result.text).toContain('Validates JWT tokens');
    expect(result.text).toContain('### /repo/src/session.ts');
    expect(result.text).toContain('### Cross-file findings');
    expect(result.text).toContain('Auth and session are tightly coupled');
  });

  it('renders raw evidence with code fences', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['raw_evidence'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(result.text).toContain('### /repo/src/auth.ts — validateToken');
    expect(result.text).toContain('```');
    expect(result.text).toContain('function validateToken(token: string)');
  });

  it('uses analysis-report output directive', () => {
    const opts: SynthesisPromptOptions = {
      sections: [],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);
    expect(result.text).toContain('analysis-report-v1');
    expect(result.text).toContain('findings');
    expect(result.text).toContain('risks');
  });

  it('uses change-spec output directive', () => {
    const opts: SynthesisPromptOptions = {
      sections: [],
      instructions: '',
      task_type: 'change-spec',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);
    expect(result.text).toContain('change-spec-v1');
    expect(result.text).toContain('edits');
    expect(result.text).toContain('acceptance_criteria');
  });

  it('appends additional instructions when provided', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context'],
      instructions: 'Focus on security implications',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(result.text).toContain('## Additional Instructions');
    expect(result.text).toContain('Focus on security implications');
  });

  it('omits additional instructions section when empty', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);
    expect(result.text).not.toContain('## Additional Instructions');
  });

  it('includes bundle and plan IDs in the header', () => {
    const opts: SynthesisPromptOptions = {
      sections: [],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);
    expect(result.text).toContain('**Bundle ID:** bundle_test_001');
    expect(result.text).toContain('**Plan ID:** plan_test_001');
  });

  it('maintains section order regardless of input order', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['raw_evidence', 'intent_context'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    const intentIdx = result.text.indexOf('## Intent Context');
    const evidenceIdx = result.text.indexOf('## Raw Evidence');
    expect(intentIdx).toBeLessThan(evidenceIdx);
    expect(result.included_sections).toEqual(['intent_context', 'raw_evidence']);
  });

  it('is deterministic across multiple calls', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context', 'structural_context', 'raw_evidence'],
      instructions: 'Be thorough',
      task_type: 'analysis-report',
    };
    const r1 = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);
    const r2 = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);
    const r3 = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    expect(r1.text).toBe(r2.text);
    expect(r2.text).toBe(r3.text);
  });

  it('prompt shape snapshot — analysis-report with all sections', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context', 'structural_context', 'raw_evidence'],
      instructions: 'Focus on security',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    // Verify canonical structure: header → intent → structural → evidence → output format → instructions
    const markers = [
      '# Synthesis Task',
      '## Intent Context',
      '## Structural Context',
      '## Raw Evidence',
      '## Output Format',
      '## Additional Instructions',
    ];
    let lastIdx = -1;
    for (const marker of markers) {
      const idx = result.text.indexOf(marker);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('never references files outside the bundle', () => {
    const opts: SynthesisPromptOptions = {
      sections: ['intent_context', 'structural_context', 'raw_evidence'],
      instructions: '',
      task_type: 'analysis-report',
    };
    const result = assembleSynthesisPrompt(FIXTURE_BUNDLE, opts);

    // Prompt should only mention paths that exist in the bundle
    const bundlePaths = [
      ...FIXTURE_BUNDLE.structural_context.files.map((f) => f.path),
      ...FIXTURE_BUNDLE.raw_evidence.map((e) => e.path),
    ];
    const uniquePaths = [...new Set(bundlePaths)];

    // Check that any /repo/ path in the output is from the bundle
    const pathMatches = result.text.match(/\/repo\/[^\s)]+/g) ?? [];
    for (const match of pathMatches) {
      // Strip trailing punctuation
      const clean = match.replace(/[,;:]+$/, '');
      expect(uniquePaths.some((p) => clean.startsWith(p))).toBe(true);
    }
  });
});
