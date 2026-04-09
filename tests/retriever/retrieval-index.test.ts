/**
 * Tests for retrieval dispatch, worker, and normalization (P3-T1).
 *
 * Covers:
 *   - Normalization produces valid retrieval-index-v1
 *   - Paths are absolute and line numbers are 1-indexed
 *   - No raw full-file payload in conductor-visible fields
 *   - Schema validation of normalized output
 *   - Integration: dispatch creates stored artifact and returns its ID
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { createConfig } from '../../src/runtime/config.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import {
  normalizeRetrievalOutput,
  resetNormalizeCounters,
  type RawRetrievalOutput,
} from '../../src/retriever/normalize.ts';
import { runRetrieverWorker } from '../../src/retriever/worker.ts';
import { retrievalDispatch } from '../../src/services/retrieval-dispatch.ts';
import type {
  IntentCaptureV1,
  IntentRestatementV1,
  RetrievalIndexV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

async function setup(): Promise<{ config: ReturnType<typeof createConfig>; store: ArtifactStore }> {
  tempDir = await mkdtemp(join(tmpdir(), 'piorx-retrieval-test-'));
  const config = createConfig(tempDir);
  const store = new ArtifactStore(config);
  return { config, store };
}

async function teardown(): Promise<void> {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function makeRawOutput(overrides?: Partial<RawRetrievalOutput>): RawRetrievalOutput {
  return {
    query: 'find the model restore logic',
    confidence: 'high',
    files: [
      {
        path: 'src/core/model-resolver.ts',
        why_relevant: 'Contains restore logic',
        file_summary: 'Model resolution module',
        ast_skeleton: ['function resolveModel()', 'function restoreFromSession()'],
        recommended_expansion: 'span',
        expansion_reason: 'Contains key restore function',
        symbols: [
          {
            kind: 'function',
            name: 'restoreFromSession',
            start: 42,
            count: 30,
            summary: 'Restores saved model from session',
            relevance: 'high',
          },
        ],
      },
    ],
    cross_file_findings: ['Restore depends on registry'],
    gaps: ['Need auth details from registry module'],
    followup_queries: ['model registry auth'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Normalization tests
// ---------------------------------------------------------------------------

describe('normalizeRetrievalOutput', () => {
  beforeEach(() => resetNormalizeCounters());

  test('produces a valid retrieval-index-v1 artifact', () => {
    const result = normalizeRetrievalOutput({
      raw: makeRawOutput(),
      repoRoot: '/repo',
      intentCaptureId: 'intent_001',
      intentRestatementId: 'restatement_001',
      intentSpecId: 'spec_001',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const validation = validateArtifact(result.artifact);
    expect(validation.valid).toBe(true);
    expect(result.artifact.artifact_type).toBe('retrieval-index-v1');
  });

  test('converts relative paths to absolute paths', () => {
    const result = normalizeRetrievalOutput({
      raw: makeRawOutput(),
      repoRoot: '/my/repo',
      intentCaptureId: 'intent_001',
      intentRestatementId: 'restatement_001',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    for (const file of result.artifact.files) {
      expect(isAbsolute(file.path)).toBe(true);
    }
    // The relative path 'src/core/model-resolver.ts' should be resolved
    expect(result.artifact.files[0]!.path).toBe('/my/repo/src/core/model-resolver.ts');
  });

  test('preserves already-absolute paths', () => {
    const raw = makeRawOutput({
      files: [
        {
          path: '/absolute/path/file.ts',
          why_relevant: 'test',
          file_summary: 'test file',
          symbols: [],
        },
      ],
    });

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/other/root',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.artifact.files[0]!.path).toBe('/absolute/path/file.ts');
  });

  test('enforces 1-indexed line numbers (clamps start to minimum 1)', () => {
    const raw = makeRawOutput({
      files: [
        {
          path: 'file.ts',
          why_relevant: 'test',
          file_summary: 'test',
          symbols: [
            {
              kind: 'function',
              name: 'zero_start',
              start: 0,
              count: 5,
            },
            {
              kind: 'function',
              name: 'negative_start',
              start: -3,
              count: 10,
            },
            {
              kind: 'function',
              name: 'normal_start',
              start: 15,
              count: 20,
            },
          ],
        },
      ],
    });

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/repo',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const symbols = result.artifact.files[0]!.symbols;
    expect(symbols[0]!.start).toBe(1); // clamped from 0
    expect(symbols[1]!.start).toBe(1); // clamped from -3
    expect(symbols[2]!.start).toBe(15); // unchanged
  });

  test('strips raw_content from files — no raw payload in output', () => {
    const raw = makeRawOutput({
      files: [
        {
          path: 'leaky.ts',
          why_relevant: 'test',
          file_summary: 'should not leak',
          raw_content: 'const SECRET = "do-not-leak";\nfunction foo() { return 42; }',
          symbols: [],
        },
      ],
    });

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/repo',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // The artifact should not contain raw_content anywhere
    const serialized = JSON.stringify(result.artifact);
    expect(serialized).not.toContain('raw_content');
    expect(serialized).not.toContain('do-not-leak');
  });

  test('assigns file_id and symbol_id when missing', () => {
    const raw = makeRawOutput({
      files: [
        {
          path: 'a.ts',
          why_relevant: 'test',
          file_summary: 'test',
          symbols: [{ kind: 'function', name: 'foo', start: 1, count: 5 }],
        },
        {
          path: 'b.ts',
          why_relevant: 'test',
          file_summary: 'test',
          symbols: [],
        },
      ],
    });

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/repo',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.artifact.files[0]!.file_id).toBe('f1');
    expect(result.artifact.files[1]!.file_id).toBe('f2');
    expect(result.artifact.files[0]!.symbols[0]!.symbol_id).toBe('s1');
  });

  test('preserves explicit file_id and symbol_id', () => {
    const raw = makeRawOutput({
      files: [
        {
          file_id: 'custom_file',
          path: 'x.ts',
          why_relevant: 'test',
          file_summary: 'test',
          symbols: [
            { symbol_id: 'custom_sym', kind: 'function', name: 'bar', start: 10, count: 5 },
          ],
        },
      ],
    });

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/repo',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.artifact.files[0]!.file_id).toBe('custom_file');
    expect(result.artifact.files[0]!.symbols[0]!.symbol_id).toBe('custom_sym');
  });

  test('defaults optional fields when missing', () => {
    const raw: RawRetrievalOutput = {
      query: 'test query',
      files: [
        {
          path: 'minimal.ts',
          why_relevant: 'test',
          file_summary: 'minimal file',
        },
      ],
    };

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/repo',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.artifact.confidence).toBe('medium');
    expect(result.artifact.cross_file_findings).toEqual([]);
    expect(result.artifact.gaps).toEqual([]);
    expect(result.artifact.followup_queries).toEqual([]);
    expect(result.artifact.files[0]!.ast_skeleton).toEqual([]);
    expect(result.artifact.files[0]!.symbols).toEqual([]);
  });

  test('sets intent_spec_id to null when not provided', () => {
    const result = normalizeRetrievalOutput({
      raw: makeRawOutput(),
      repoRoot: '/repo',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.artifact.intent_spec_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retriever worker tests
// ---------------------------------------------------------------------------

describe('runRetrieverWorker', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'piorx-worker-test-'));
  });

  afterEach(async () => {
    await teardown();
  });

  test('discovers and scores source files', async () => {
    // Create a small repo with source files
    const srcDir = resolve(tempDir, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      resolve(srcDir, 'model.ts'),
      'export function restoreModel() {\n  return "restored";\n}\n',
    );
    await writeFile(resolve(srcDir, 'utils.ts'), 'export function helper() {\n  return true;\n}\n');

    const result = await runRetrieverWorker({
      repoRoot: tempDir,
      query: 'restore model',
    });

    expect(result.query).toBe('restore model');
    expect(result.files.length).toBeGreaterThan(0);

    // model.ts should be ranked higher since it matches "restore" and "model"
    const modelFile = result.files.find((f) => f.path.includes('model.ts'));
    expect(modelFile).toBeDefined();
    expect(isAbsolute(modelFile!.path)).toBe(true);
  });

  test('extracts symbols from source files', async () => {
    await writeFile(
      resolve(tempDir, 'code.ts'),
      [
        'export function myFunction() {',
        '  return 42;',
        '}',
        '',
        'export class MyClass {',
        '  value = 1;',
        '}',
        '',
        'export interface MyInterface {',
        '  name: string;',
        '}',
      ].join('\n'),
    );

    const result = await runRetrieverWorker({
      repoRoot: tempDir,
      query: 'myFunction MyClass',
    });

    expect(result.files.length).toBeGreaterThan(0);
    const file = result.files[0]!;
    const symbolNames = (file.symbols ?? []).map((s) => s.name);
    expect(symbolNames).toContain('myFunction');
    expect(symbolNames).toContain('MyClass');
  });

  test('skips node_modules and .git directories', async () => {
    const nmDir = resolve(tempDir, 'node_modules', 'pkg');
    const gitDir = resolve(tempDir, '.git', 'objects');
    await mkdir(nmDir, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(resolve(nmDir, 'index.ts'), 'export const x = 1;');
    await writeFile(resolve(gitDir, 'data.ts'), 'export const y = 2;');
    await writeFile(resolve(tempDir, 'app.ts'), 'export const target = "found";');

    const result = await runRetrieverWorker({
      repoRoot: tempDir,
      query: 'target found',
    });

    const paths = result.files.map((f) => f.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  test('does not include raw_content in output', async () => {
    await writeFile(resolve(tempDir, 'secret.ts'), 'const SECRET = "never-leak-this";');

    const result = await runRetrieverWorker({
      repoRoot: tempDir,
      query: 'secret leak',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('raw_content');
  });

  test('returns gaps when no files match', async () => {
    // Empty repo — no source files
    const result = await runRetrieverWorker({
      repoRoot: tempDir,
      query: 'nonexistent concept xyz',
    });

    expect(result.files).toHaveLength(0);
    expect(result.gaps!.length).toBeGreaterThan(0);
    expect(result.confidence).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Integration: retrieval dispatch end-to-end
// ---------------------------------------------------------------------------

describe('retrievalDispatch integration', () => {
  let config: ReturnType<typeof createConfig>;
  let store: ArtifactStore;

  beforeEach(async () => {
    const s = await setup();
    config = s.config;
    store = s.store;

    // Create a source file in the temp repo
    const srcDir = resolve(tempDir, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      resolve(srcDir, 'handler.ts'),
      ['export function handleRequest(req: Request) {', '  return new Response("ok");', '}'].join(
        '\n',
      ),
    );
  });

  afterEach(async () => {
    await teardown();
  });

  test('creates stored retrieval-index-v1 from approved intent', async () => {
    // Set up prerequisite artifacts
    const capture: IntentCaptureV1 = {
      artifact_type: 'intent-capture-v1',
      artifact_id: generateArtifactId('intent-capture-v1'),
      user_intent_verbatim: 'How does the request handler work?',
      tagged_files: [],
      timestamp: new Date().toISOString(),
    };
    await store.put(capture);

    const restatement: IntentRestatementV1 = {
      artifact_type: 'intent-restatement-v1',
      artifact_id: generateArtifactId('intent-restatement-v1'),
      intent_capture_id: capture.artifact_id,
      user_intent_verbatim: capture.user_intent_verbatim,
      restated_intent: 'Understand the request handler implementation',
      approved: true,
      expand_requested: false,
      approval_turns: 1,
    };
    await store.put(restatement);

    // Dispatch retrieval
    const result = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: restatement.artifact_id,
        intent_spec_id: null,
      },
      store,
      config,
    );

    expect(result.status).toBe('success');
    expect(result.retrieval_index_id).not.toBeNull();

    // Verify the stored artifact
    const stored = await store.get('retrieval-index-v1', result.retrieval_index_id!);
    expect(stored).not.toBeNull();
    expect(stored!.artifact_type).toBe('retrieval-index-v1');
    expect(stored!.intent_capture_id).toBe(capture.artifact_id);
    expect(stored!.intent_restatement_id).toBe(restatement.artifact_id);

    // Validate schema
    const validation = validateArtifact(stored!);
    expect(validation.valid).toBe(true);

    // All paths must be absolute
    for (const file of stored!.files) {
      expect(isAbsolute(file.path)).toBe(true);
    }

    // All line numbers must be >= 1
    for (const file of stored!.files) {
      for (const sym of file.symbols) {
        expect(sym.start).toBeGreaterThanOrEqual(1);
        expect(sym.count).toBeGreaterThanOrEqual(1);
      }
    }

    // No raw full-file content in the artifact
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('raw_content');
  });

  test('returns error when intent capture is missing', async () => {
    const result = await retrievalDispatch(
      {
        intent_capture_id: 'nonexistent',
        intent_restatement_id: 'also_nonexistent',
        intent_spec_id: null,
      },
      store,
      config,
    );

    expect(result.status).toBe('error');
    expect(result.retrieval_index_id).toBeNull();
  });

  test('returns error when restatement is missing', async () => {
    const capture: IntentCaptureV1 = {
      artifact_type: 'intent-capture-v1',
      artifact_id: generateArtifactId('intent-capture-v1'),
      user_intent_verbatim: 'test',
      tagged_files: [],
      timestamp: new Date().toISOString(),
    };
    await store.put(capture);

    const result = await retrievalDispatch(
      {
        intent_capture_id: capture.artifact_id,
        intent_restatement_id: 'nonexistent',
        intent_spec_id: null,
      },
      store,
      config,
    );

    expect(result.status).toBe('error');
    expect(result.retrieval_index_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Golden test: conductor-safe fields contain no raw source
// ---------------------------------------------------------------------------

describe('conductor boundary enforcement', () => {
  test('retrieval artifact fields meant for conductor contain no raw source', () => {
    resetNormalizeCounters();

    const raw = makeRawOutput({
      files: [
        {
          path: 'src/secret.ts',
          why_relevant: 'Contains the logic',
          file_summary: 'Secret module',
          ast_skeleton: ['function doSecret()'],
          raw_content: [
            'import { db } from "./db";',
            'const API_KEY = "sk-secret-12345";',
            'export function doSecret() {',
            '  return db.query("SELECT * FROM users");',
            '}',
          ].join('\n'),
          symbols: [
            {
              kind: 'function',
              name: 'doSecret',
              start: 3,
              count: 3,
              summary: 'Performs secret operation',
            },
          ],
        },
      ],
    });

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/repo',
      intentCaptureId: 'i1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const artifact = result.artifact;
    const serialized = JSON.stringify(artifact);

    // None of the raw source lines should appear in the artifact
    expect(serialized).not.toContain('sk-secret-12345');
    expect(serialized).not.toContain('SELECT * FROM users');
    expect(serialized).not.toContain('import { db }');
    expect(serialized).not.toContain('raw_content');

    // But structural info should be present
    expect(artifact.files[0]!.file_summary).toBe('Secret module');
    expect(artifact.files[0]!.ast_skeleton).toContain('function doSecret()');
    expect(artifact.files[0]!.symbols[0]!.name).toBe('doSecret');
    expect(artifact.files[0]!.symbols[0]!.summary).toBe('Performs secret operation');
  });
});
