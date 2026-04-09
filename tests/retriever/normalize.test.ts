/**
 * Golden tests for retrieval normalization (P3-T4).
 *
 * Covers:
 *   - Normalized artifact contains no raw file content
 *   - Schema validation passes for normalized retrieval-index-v1
 *   - artifact_inspect refuses raw bundle payloads
 *   - artifact_inspect returns text-safe retrieval data
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../../src/runtime/config.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { validateArtifact } from '../../src/artifacts/schemas.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import {
  normalizeRetrievalOutput,
  resetNormalizeCounters,
  type RawRetrievalOutput,
} from '../../src/retriever/normalize.ts';
import { artifactInspect } from '../../src/services/artifact-inspect.ts';
import type { RetrievalIndexV1, EvidenceBundleV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), 'piorx-normalize-golden-'));
  const config = createConfig(tempDir);
  const store = new ArtifactStore(config);
  return { config, store };
}

async function teardown() {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Golden test: normalized artifact contains no raw file content
// ---------------------------------------------------------------------------

describe('normalization golden tests', () => {
  beforeEach(() => resetNormalizeCounters());

  test('normalized artifact contains no raw file content', () => {
    const raw: RawRetrievalOutput = {
      query: 'find database connection logic',
      confidence: 'high',
      files: [
        {
          path: 'src/db/connection.ts',
          why_relevant: 'Database connection module',
          file_summary: 'Manages database connections and pooling',
          ast_skeleton: ['function connect()', 'class ConnectionPool'],
          raw_content: [
            'import pg from "pg";',
            'const DB_PASSWORD = "super-secret-password";',
            'export function connect(url: string) {',
            '  return new pg.Pool({ connectionString: url });',
            '}',
            'export class ConnectionPool {',
            '  private pool: pg.Pool;',
            '  constructor(url: string) { this.pool = connect(url); }',
            '}',
          ].join('\n'),
          symbols: [
            {
              kind: 'function',
              name: 'connect',
              start: 3,
              count: 3,
              summary: 'Creates a connection',
            },
            {
              kind: 'class',
              name: 'ConnectionPool',
              start: 6,
              count: 4,
              summary: 'Connection pool manager',
            },
          ],
        },
        {
          path: 'src/db/migrations.ts',
          why_relevant: 'Migration runner',
          file_summary: 'Runs database migrations',
          raw_content: 'export async function runMigrations() { /* ... */ }',
          symbols: [{ kind: 'function', name: 'runMigrations', start: 1, count: 1 }],
        },
      ],
      cross_file_findings: ['Connection is shared across migration and query modules'],
      gaps: ['Redis caching layer not found'],
      followup_queries: ['redis cache configuration'],
    };

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/project',
      intentCaptureId: 'cap_001',
      intentRestatementId: 'rst_001',
      intentSpecId: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const artifact = result.artifact;
    const serialized = JSON.stringify(artifact);

    // No raw content should appear
    expect(serialized).not.toContain('raw_content');
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('pg.Pool');
    expect(serialized).not.toContain('connectionString');
    expect(serialized).not.toContain('import pg');
    expect(serialized).not.toContain('runMigrations() { /* ... */ }');

    // Structural data should be present
    expect(artifact.files[0]!.file_summary).toBe('Manages database connections and pooling');
    expect(artifact.files[0]!.ast_skeleton).toContain('function connect()');
    expect(artifact.files[0]!.symbols[0]!.name).toBe('connect');
    expect(artifact.files[0]!.symbols[0]!.summary).toBe('Creates a connection');
    expect(artifact.cross_file_findings).toContain(
      'Connection is shared across migration and query modules',
    );
    expect(artifact.gaps).toContain('Redis caching layer not found');
    expect(artifact.followup_queries).toContain('redis cache configuration');
  });

  test('schema validation passes for normalized retrieval-index-v1', () => {
    const raw: RawRetrievalOutput = {
      query: 'auth middleware',
      files: [
        {
          path: 'src/auth.ts',
          why_relevant: 'Auth middleware',
          file_summary: 'Authentication middleware',
          symbols: [{ kind: 'function', name: 'authenticate', start: 5, count: 10 }],
        },
      ],
    };

    const result = normalizeRetrievalOutput({
      raw,
      repoRoot: '/repo',
      intentCaptureId: 'cap_002',
      intentRestatementId: 'rst_002',
      intentSpecId: 'spec_002',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const validation = validateArtifact(result.artifact);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// artifact_inspect tests
// ---------------------------------------------------------------------------

describe('artifact_inspect', () => {
  let store: ArtifactStore;

  beforeEach(async () => {
    const s = await setup();
    store = s.store;
  });

  afterEach(async () => {
    await teardown();
  });

  test('refuses raw bundle payloads (evidence-bundle-v1)', async () => {
    const result = await artifactInspect(store, 'evidence-bundle-v1', 'any_id');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('refuses raw bundle payloads');
    expect(result.error).toContain('evidence-bundle-v1');
  });

  test('returns text-safe inspection for retrieval-index-v1', async () => {
    // Create and store a retrieval-index-v1
    resetNormalizeCounters();
    const raw: RawRetrievalOutput = {
      query: 'test query',
      confidence: 'high',
      files: [
        {
          path: '/abs/path/file.ts',
          why_relevant: 'Relevant',
          file_summary: 'Test file',
          ast_skeleton: ['function foo()'],
          symbols: [{ kind: 'function', name: 'foo', start: 1, count: 5, summary: 'Foo function' }],
        },
      ],
      gaps: ['some gap'],
      followup_queries: ['followup'],
      cross_file_findings: ['finding'],
    };

    const normalized = normalizeRetrievalOutput({
      raw,
      repoRoot: '/abs',
      intentCaptureId: 'c1',
      intentRestatementId: 'r1',
      intentSpecId: null,
    });
    expect(normalized.success).toBe(true);
    if (!normalized.success) return;

    await store.put(normalized.artifact);

    const result = await artifactInspect(
      store,
      'retrieval-index-v1',
      normalized.artifact.artifact_id,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const inspection = result.inspection;
    expect(inspection.artifact_id).toBe(normalized.artifact.artifact_id);
    expect(inspection.query).toBe('test query');
    expect(inspection.confidence).toBe('high');
    expect(inspection.file_count).toBe(1);
    expect(inspection.files[0]!.file_id).toBeTruthy();
    expect(inspection.files[0]!.path).toBe('/abs/path/file.ts');
    expect(inspection.files[0]!.symbols[0]!.name).toBe('foo');
    expect(inspection.gaps).toContain('some gap');
    expect(inspection.followup_queries).toContain('followup');

    // Verify no raw content leaks through inspection
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain('raw_content');
  });

  test('returns error for missing artifact', async () => {
    const result = await artifactInspect(store, 'retrieval-index-v1', 'nonexistent');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('not found');
  });
});
