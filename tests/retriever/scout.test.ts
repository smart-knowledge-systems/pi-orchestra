/**
 * Tests for the deterministic retrieval scout (AR-P3).
 *
 * Covers:
 *   - buildScoutTerms weights by origin and dedupes deterministically
 *   - runScout produces deterministic selected/reserve candidates
 *   - Tagged files are materially boosted and end up in `selected` with
 *     a `tagged` role hint
 *   - Selected set is bounded (<= SCOUT_SELECTED_LIMIT) and strictly
 *     narrower than the old MAX_FILES=12 heuristic default
 *   - Output is structural-only: no raw file bodies leak
 *   - Rationale and evidence-mode hints are populated
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import {
  buildScoutTerms,
  runScout,
  SCOUT_SELECTED_LIMIT,
  SCOUT_RESERVE_LIMIT,
  type ScoutResult,
} from '../../src/retriever/scout.ts';

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

let tempDir: string;

async function setupRepo(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'piorx-scout-'));
  return tempDir;
}

async function teardownRepo(): Promise<void> {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
}

async function seedStandardRepo(root: string): Promise<void> {
  const src = resolve(root, 'src');
  const tests = resolve(root, 'tests');
  await mkdir(src, { recursive: true });
  await mkdir(tests, { recursive: true });

  await writeFile(
    resolve(src, 'auth-middleware.ts'),
    [
      'import { verify } from "./verify.ts";',
      'export function authMiddleware(req: Request) {',
      '  return verify(req.headers.get("authorization"));',
      '}',
      '',
      'export class AuthContext {',
      '  user: string | null = null;',
      '}',
    ].join('\n'),
  );

  await writeFile(
    resolve(src, 'verify.ts'),
    [
      'export function verify(token: string | null): boolean {',
      '  if (!token) return false;',
      '  return token.startsWith("Bearer ");',
      '}',
    ].join('\n'),
  );

  await writeFile(
    resolve(src, 'logger.ts'),
    'export function log(msg: string) { console.log(msg); }\n',
  );

  await writeFile(
    resolve(src, 'unrelated.ts'),
    'export const PI = 3.14159;\nexport function circumference(r: number) { return 2 * PI * r; }\n',
  );

  await writeFile(
    resolve(tests, 'auth-middleware.test.ts'),
    'import { authMiddleware } from "../src/auth-middleware.ts";\nconsole.log(authMiddleware);\n',
  );

  await writeFile(resolve(root, 'README.md'), '# example repo for scout tests\n');
}

// ---------------------------------------------------------------------------
// buildScoutTerms
// ---------------------------------------------------------------------------

describe('buildScoutTerms', () => {
  test('weights retrieval focus above tagged files above restatement above intent', () => {
    const terms = buildScoutTerms({
      retrievalFocus: ['caching'],
      taggedFiles: ['src/payments.ts'],
      restatedIntent: 'Understand the session handler module',
      cleanedIntent: 'How does the widget work?',
    });
    const byName = new Map(terms.map((t) => [t.term, t]));
    // focus term wins weight
    expect(byName.get('caching')?.weight).toBeGreaterThanOrEqual(4);
    expect(byName.get('payments')?.weight).toBeGreaterThanOrEqual(3);
    expect(byName.get('session')?.weight).toBeGreaterThanOrEqual(2);
    expect(byName.get('widget')?.weight).toBeGreaterThanOrEqual(1);
    expect(byName.get('widget')?.weight ?? 0).toBeLessThan(byName.get('caching')?.weight ?? 0);
  });

  test('dedupes and aggregates when the same term comes from multiple origins', () => {
    const terms = buildScoutTerms({
      retrievalFocus: ['auth'],
      taggedFiles: ['src/auth.ts'],
      restatedIntent: 'the auth boundary',
      cleanedIntent: 'explain auth',
    });
    const auth = terms.find((t) => t.term === 'auth');
    expect(auth).toBeDefined();
    expect(auth!.kinds).toEqual(['focus', 'intent', 'restatement', 'tag']);
    // 4 (focus) + 3 (tag) + 2 (restatement) + 1 (intent)
    expect(auth!.weight).toBe(10);
  });

  test('is not a naive split-all-words strategy — stop words are excluded', () => {
    const terms = buildScoutTerms({
      cleanedIntent: 'please make this work with the thing on our end',
    });
    const names = terms.map((t) => t.term);
    for (const stop of ['please', 'make', 'this', 'with', 'the', 'on', 'our']) {
      expect(names).not.toContain(stop);
    }
    // But the meaningful content terms survive.
    expect(names).toContain('thing');
    expect(names).toContain('work');
  });

  test('is deterministic: same input produces same output', () => {
    const input = {
      retrievalFocus: ['retrieval', 'scout'],
      taggedFiles: ['src/retriever/scout.ts'],
      restatedIntent: 'Understand the scout pipeline',
      cleanedIntent: 'I want to know how scouting works',
    };
    const a = buildScoutTerms(input);
    const b = buildScoutTerms(input);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// runScout
// ---------------------------------------------------------------------------

describe('runScout', () => {
  beforeEach(async () => {
    const root = await setupRepo();
    await seedStandardRepo(root);
  });

  afterEach(async () => {
    await teardownRepo();
  });

  test('returns a narrow, bounded candidate set', async () => {
    const result = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'Explain the auth middleware flow',
      retrievalFocus: ['auth', 'middleware'],
    });

    expect(result.selected.length).toBeLessThanOrEqual(SCOUT_SELECTED_LIMIT);
    expect(result.reserve.length).toBeLessThanOrEqual(SCOUT_RESERVE_LIMIT);
    // Old single-pass heuristic default returned up to 12 files without tiering;
    // the scout-selected set must be strictly narrower.
    expect(result.selected.length).toBeLessThan(12);
  });

  test('is deterministic: same repo + same inputs produce identical output', async () => {
    const input = {
      repoRoot: tempDir,
      restatedIntent: 'Explain the auth middleware flow',
      retrievalFocus: ['auth'],
      taggedFiles: ['src/auth-middleware.ts'],
    };
    const a = await runScout(input);
    const b = await runScout(input);
    expect(a.selected.map((c) => c.relPath)).toEqual(b.selected.map((c) => c.relPath));
    expect(a.reserve.map((c) => c.relPath)).toEqual(b.reserve.map((c) => c.relPath));
    expect(a.scoutTerms).toEqual(b.scoutTerms);
    expect(a.strategySummary).toEqual(b.strategySummary);
  });

  test('materially boosts tagged files into selected with role=tagged', async () => {
    const result = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'something about the widget',
      taggedFiles: ['src/unrelated.ts'],
    });

    const tagged = result.selected.find((c) => c.relPath === 'src/unrelated.ts');
    expect(tagged).toBeDefined();
    expect(tagged!.role).toBe('tagged');
    expect(tagged!.rationale).toContain('user-tagged file');
    // Strongly boosted — ranks first.
    expect(result.selected[0]!.relPath).toBe('src/unrelated.ts');
  });

  test('retrieval focus materially influences selection', async () => {
    const withFocus = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'overall understanding',
      retrievalFocus: ['auth', 'verify'],
    });
    const withoutFocus = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'overall understanding',
    });

    // Focus must steer at least one auth/verify file into the selected set
    // in a way the empty-focus baseline does not.
    const focusSelectedPaths = new Set(withFocus.selected.map((c) => c.relPath));
    expect(focusSelectedPaths.has('src/auth-middleware.ts')).toBe(true);
    expect(focusSelectedPaths.has('src/verify.ts')).toBe(true);

    // And the focus run should score auth-middleware higher than the no-focus baseline.
    const focusScore =
      withFocus.selected.find((c) => c.relPath === 'src/auth-middleware.ts')?.score ?? 0;
    const baselineScore =
      withoutFocus.selected.find((c) => c.relPath === 'src/auth-middleware.ts')?.score ?? 0;
    expect(focusScore).toBeGreaterThan(baselineScore);
  });

  test('each selected candidate has a stable rationale and role hint', async () => {
    const result = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'Explain the auth middleware flow',
      retrievalFocus: ['auth'],
      taggedFiles: ['src/auth-middleware.ts'],
    });
    for (const candidate of result.selected) {
      expect(candidate.rationale.length).toBeGreaterThan(0);
      expect(candidate.role).toBeDefined();
      expect(['exclude', 'summary', 'summary+ast', 'spans', 'whole_file']).toContain(
        candidate.evidenceModeHint,
      );
      expect(isAbsolute(candidate.path)).toBe(true);
    }
  });

  test('selected and reserve tiers are mutually exclusive and correctly labelled', async () => {
    const result = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'Explain the auth middleware flow',
      retrievalFocus: ['auth', 'verify', 'log'],
    });
    for (const c of result.selected) expect(c.tier).toBe('selected');
    for (const c of result.reserve) expect(c.tier).toBe('reserve');
    const selectedPaths = new Set(result.selected.map((c) => c.relPath));
    for (const c of result.reserve) {
      expect(selectedPaths.has(c.relPath)).toBe(false);
    }
  });

  test('output contains no raw file bodies (non-declaration content does not leak)', async () => {
    await writeFile(
      resolve(tempDir, 'src', 'secret.ts'),
      [
        'export function doSecret() {',
        '  return fetch("/api", {',
        '    headers: { Authorization: "Bearer sk-never-leak-this" },',
        '  });',
        '}',
      ].join('\n'),
    );
    const result = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'Explain secret operations',
      retrievalFocus: ['secret'],
    });
    const serialized = JSON.stringify(result);
    // Function-body content (not a top-level declaration) must never appear
    // in scout output. The AST skeleton captures declarations only.
    expect(serialized).not.toContain('sk-never-leak-this');
    expect(serialized).not.toContain('Authorization');
  });

  test('strategy summary describes the narrowing', async () => {
    const result = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'Explain the auth middleware flow',
      retrievalFocus: ['auth'],
      taggedFiles: ['src/auth-middleware.ts'],
    });
    expect(result.strategySummary).toContain('selected=');
    expect(result.strategySummary).toContain('reserve=');
    expect(result.strategySummary).toContain('scout terms:');
    expect(result.strategySummary).toContain('tagged-boosted=');
  });

  test('surfaces import-based cross-file hints', async () => {
    const result = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'Explain the auth middleware flow',
      retrievalFocus: ['auth', 'verify'],
    });
    const hintsJoined = result.crossFileHints.join('\n');
    expect(hintsJoined).toContain('auth-middleware.ts');
    expect(hintsJoined).toContain('verify.ts');
  });
});

// ---------------------------------------------------------------------------
// Narrowing relative to the prior heuristic default
// ---------------------------------------------------------------------------

describe('runScout narrowing', () => {
  beforeEach(async () => {
    const root = await setupRepo();
    // Seed many source files — the old default returned up to 12 of them.
    const src = resolve(root, 'src');
    await mkdir(src, { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(
        resolve(src, `module-${i}.ts`),
        `export function handler_${i}() { return "auth module ${i}"; }\n`,
      );
    }
  });

  afterEach(async () => {
    await teardownRepo();
  });

  test('caps selected set below the 12-file single-pass default', async () => {
    const result: ScoutResult = await runScout({
      repoRoot: tempDir,
      restatedIntent: 'Explore the auth handler modules',
      retrievalFocus: ['auth', 'handler', 'module'],
    });
    expect(result.selected.length).toBeLessThanOrEqual(SCOUT_SELECTED_LIMIT);
    expect(result.selected.length).toBeLessThan(12);
  });
});
