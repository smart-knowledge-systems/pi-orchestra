/**
 * Tests for symbol and span metadata extractor (P3-T3).
 *
 * Covers:
 *   - Deterministic output on a fixture repo slice
 *   - All paths are absolute and line numbers are 1-indexed
 *   - Symbol start/count are unit-tested
 *   - AST skeleton generation is unit-tested
 *   - Rejects relative paths
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractSymbols,
  generateAstSkeleton,
  resetSymbolCounter,
} from '../../src/retriever/symbol-extractor.ts';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_PATH = resolve(__dirname, '../fixtures/retriever/sample-source.ts');
const FIXTURE_CONTENT = readFileSync(FIXTURE_PATH, 'utf-8');
const FIXTURE_ABS_PATH = FIXTURE_PATH; // already absolute

// ---------------------------------------------------------------------------
// extractSymbols
// ---------------------------------------------------------------------------

describe('extractSymbols', () => {
  beforeEach(() => resetSymbolCounter());

  test('extracts all expected symbols from fixture', () => {
    const result = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    const names = result.symbols.map((s) => s.name);

    expect(names).toContain('MAX_RETRIES');
    expect(names).toContain('UserId');
    expect(names).toContain('UserConfig');
    expect(names).toContain('createUser');
    expect(names).toContain('fetchUser');
    expect(names).toContain('UserService');
    expect(names).toContain('BaseRepository');
  });

  test('assigns correct symbol kinds', () => {
    const result = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    const byName = new Map(result.symbols.map((s) => [s.name, s]));

    expect(byName.get('MAX_RETRIES')?.kind).toBe('const');
    expect(byName.get('UserId')?.kind).toBe('type');
    expect(byName.get('UserConfig')?.kind).toBe('interface');
    expect(byName.get('createUser')?.kind).toBe('function');
    expect(byName.get('fetchUser')?.kind).toBe('function');
    expect(byName.get('UserService')?.kind).toBe('class');
    expect(byName.get('BaseRepository')?.kind).toBe('class');
  });

  test('all line numbers are 1-indexed (>= 1)', () => {
    const result = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    for (const sym of result.symbols) {
      expect(sym.start).toBeGreaterThanOrEqual(1);
      expect(sym.count).toBeGreaterThanOrEqual(1);
    }
  });

  test('path in result is absolute', () => {
    const result = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    expect(result.path).toBe(FIXTURE_ABS_PATH);
    expect(result.path.startsWith('/')).toBe(true);
  });

  test('throws on relative path', () => {
    expect(() => extractSymbols('relative/path.ts', FIXTURE_CONTENT)).toThrow(
      'Path must be absolute',
    );
  });

  test('symbol_id is assigned uniquely', () => {
    const result = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    const ids = result.symbols.map((s) => s.symbol_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('symbol start/count covers actual function body', () => {
    const result = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    const createUser = result.symbols.find((s) => s.name === 'createUser');
    expect(createUser).toBeDefined();

    // createUser is a short function — start should be on its declaration line
    const lines = FIXTURE_CONTENT.split('\n');
    const declLine = lines.findIndex((l) => l.includes('function createUser'));
    expect(createUser!.start).toBe(declLine + 1); // 1-indexed
    expect(createUser!.count).toBeGreaterThanOrEqual(2); // at least decl + body
  });

  test('class symbol spans multiple lines', () => {
    const result = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    const userService = result.symbols.find((s) => s.name === 'UserService');
    expect(userService).toBeDefined();
    expect(userService!.count).toBeGreaterThanOrEqual(5); // class with methods
  });

  test('deterministic output — same input produces same symbols', () => {
    resetSymbolCounter();
    const result1 = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);
    resetSymbolCounter();
    const result2 = extractSymbols(FIXTURE_ABS_PATH, FIXTURE_CONTENT);

    expect(result1.symbols.length).toBe(result2.symbols.length);
    for (let i = 0; i < result1.symbols.length; i++) {
      expect(result1.symbols[i]).toEqual(result2.symbols[i]);
    }
    expect(result1.astSkeleton).toEqual(result2.astSkeleton);
  });

  test('handles empty content', () => {
    const result = extractSymbols('/empty/file.ts', '');
    expect(result.symbols).toEqual([]);
    expect(result.astSkeleton).toEqual([]);
    expect(result.path).toBe('/empty/file.ts');
  });

  test('handles content with no symbols', () => {
    const result = extractSymbols('/no-syms/file.ts', '// just a comment\n// another comment\n');
    expect(result.symbols).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generateAstSkeleton
// ---------------------------------------------------------------------------

describe('generateAstSkeleton', () => {
  test('includes imports, exports, and declarations', () => {
    const lines = FIXTURE_CONTENT.split('\n');
    const skeleton = generateAstSkeleton(lines);

    // Should include the import line
    expect(skeleton.some((l) => l.startsWith('import'))).toBe(true);
    // Should include function declarations
    expect(skeleton.some((l) => l.includes('function createUser'))).toBe(true);
    expect(skeleton.some((l) => l.includes('function fetchUser'))).toBe(true);
    // Should include class declarations
    expect(skeleton.some((l) => l.includes('class UserService'))).toBe(true);
    expect(skeleton.some((l) => l.includes('class BaseRepository'))).toBe(true);
    // Should include interface and type
    expect(skeleton.some((l) => l.includes('interface UserConfig'))).toBe(true);
    expect(skeleton.some((l) => l.includes('type UserId'))).toBe(true);
    // Should include const
    expect(skeleton.some((l) => l.includes('const MAX_RETRIES'))).toBe(true);
  });

  test('does not include method bodies or implementation lines', () => {
    const lines = FIXTURE_CONTENT.split('\n');
    const skeleton = generateAstSkeleton(lines);

    // Method bodies and implementation details should not appear
    expect(skeleton.some((l) => l.includes("return { id: 'user_001' }"))).toBe(false);
    expect(skeleton.some((l) => l.includes('this.users.set'))).toBe(false);
  });

  test('truncates long lines to 120 characters', () => {
    const longLine = 'export const VERY_LONG_NAME = ' + 'a'.repeat(200);
    const skeleton = generateAstSkeleton([longLine]);
    expect(skeleton.length).toBe(1);
    expect(skeleton[0]!.length).toBe(120);
    expect(skeleton[0]!.endsWith('...')).toBe(true);
  });

  test('returns empty array for content with no declarations', () => {
    const skeleton = generateAstSkeleton(['// comment', '/* block */', '']);
    expect(skeleton).toEqual([]);
  });
});
