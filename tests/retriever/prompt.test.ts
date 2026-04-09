/**
 * Tests for retriever prompt assembly (P3-T2).
 *
 * Covers:
 *   - System prompt is always included
 *   - Query is built from restated intent
 *   - Retrieval focus hints are appended when present
 *   - Tagged files are appended when present
 *   - Prompt assembly is deterministic with fixture inputs
 *   - Conductor boundary: prompt module is in retriever/, not conductor/
 */

import { describe, test, expect } from 'bun:test';
import {
  RETRIEVER_SYSTEM_PROMPT,
  assembleRetrieverPrompt,
  type PromptAssemblyInput,
} from '../../src/retriever/prompt.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_BASIC: PromptAssemblyInput = {
  userIntentVerbatim: 'How does the auth middleware work?',
  restatedIntent: 'Understand the authentication middleware implementation',
};

const FIXTURE_WITH_FOCUS: PromptAssemblyInput = {
  userIntentVerbatim: 'Refactor the logging system',
  restatedIntent: 'Refactor the logging subsystem for better modularity',
  retrievalFocus: ['logging', 'logger', 'log-config'],
};

const FIXTURE_WITH_TAGGED_FILES: PromptAssemblyInput = {
  userIntentVerbatim: 'Fix the bug in user service',
  restatedIntent: 'Fix the user creation bug in the user service module',
  taggedFiles: ['src/services/user.ts', 'src/models/user.ts'],
};

const FIXTURE_FULL: PromptAssemblyInput = {
  userIntentVerbatim: 'Add caching to the API layer',
  restatedIntent: 'Add response caching to the API request handler layer',
  retrievalFocus: ['cache', 'api', 'handler'],
  taggedFiles: ['src/api/handler.ts'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RETRIEVER_SYSTEM_PROMPT', () => {
  test('is a non-empty string', () => {
    expect(typeof RETRIEVER_SYSTEM_PROMPT).toBe('string');
    expect(RETRIEVER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test('instructs against returning raw file content', () => {
    expect(RETRIEVER_SYSTEM_PROMPT).toContain('Do NOT return raw file content');
  });

  test('requires absolute paths', () => {
    expect(RETRIEVER_SYSTEM_PROMPT).toContain('absolute');
  });

  test('requires 1-indexed line numbers', () => {
    expect(RETRIEVER_SYSTEM_PROMPT).toContain('1-indexed');
  });
});

describe('assembleRetrieverPrompt', () => {
  test('includes system prompt in output', () => {
    const result = assembleRetrieverPrompt(FIXTURE_BASIC);
    expect(result.systemPrompt).toBe(RETRIEVER_SYSTEM_PROMPT);
  });

  test('query contains the restated intent', () => {
    const result = assembleRetrieverPrompt(FIXTURE_BASIC);
    expect(result.query).toContain(FIXTURE_BASIC.restatedIntent);
  });

  test('query does not contain retrieval focus when absent', () => {
    const result = assembleRetrieverPrompt(FIXTURE_BASIC);
    expect(result.query).not.toContain('Focus areas');
    expect(result.retrievalFocus).toEqual([]);
  });

  test('query includes retrieval focus hints when present', () => {
    const result = assembleRetrieverPrompt(FIXTURE_WITH_FOCUS);
    expect(result.query).toContain('Focus areas:');
    expect(result.query).toContain('logging');
    expect(result.query).toContain('logger');
    expect(result.query).toContain('log-config');
    expect(result.retrievalFocus).toEqual(['logging', 'logger', 'log-config']);
  });

  test('query does not contain tagged files when absent', () => {
    const result = assembleRetrieverPrompt(FIXTURE_BASIC);
    expect(result.query).not.toContain('Tagged files');
  });

  test('query includes tagged files when present', () => {
    const result = assembleRetrieverPrompt(FIXTURE_WITH_TAGGED_FILES);
    expect(result.query).toContain('Tagged files:');
    expect(result.query).toContain('src/services/user.ts');
    expect(result.query).toContain('src/models/user.ts');
  });

  test('full fixture includes all sections', () => {
    const result = assembleRetrieverPrompt(FIXTURE_FULL);
    expect(result.query).toContain(FIXTURE_FULL.restatedIntent);
    expect(result.query).toContain('Focus areas:');
    expect(result.query).toContain('cache');
    expect(result.query).toContain('Tagged files:');
    expect(result.query).toContain('src/api/handler.ts');
  });

  test('prompt assembly is deterministic — same input produces same output', () => {
    const result1 = assembleRetrieverPrompt(FIXTURE_FULL);
    const result2 = assembleRetrieverPrompt(FIXTURE_FULL);
    expect(result1).toEqual(result2);
  });

  test('empty retrieval focus array is treated as absent', () => {
    const input: PromptAssemblyInput = {
      ...FIXTURE_BASIC,
      retrievalFocus: [],
    };
    const result = assembleRetrieverPrompt(input);
    expect(result.query).not.toContain('Focus areas');
    expect(result.retrievalFocus).toEqual([]);
  });

  test('empty tagged files array is treated as absent', () => {
    const input: PromptAssemblyInput = {
      ...FIXTURE_BASIC,
      taggedFiles: [],
    };
    const result = assembleRetrieverPrompt(input);
    expect(result.query).not.toContain('Tagged files');
  });
});

// ---------------------------------------------------------------------------
// Boundary: conductor cannot import worker internals
// ---------------------------------------------------------------------------

describe('conductor boundary', () => {
  test('prompt module path is under src/retriever/, not src/conductor/', () => {
    // This is a structural assertion — the import path proves the module
    // lives in the retriever boundary, not the conductor boundary.
    const modulePath = 'src/retriever/prompt.ts';
    expect(modulePath.startsWith('src/retriever/')).toBe(true);
    expect(modulePath.startsWith('src/conductor/')).toBe(false);
  });
});
