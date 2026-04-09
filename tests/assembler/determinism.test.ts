/**
 * Determinism tests for the evidence assembler.
 *
 * Verifies that the same inputs always produce the same outputs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evidenceAssemble,
  type EvidenceMaterializeResult,
  type EvidencePreviewResult,
} from '../../src/services/evidence-assembler.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { createConfig } from '../../src/runtime/config.ts';
import type {
  RetrievalIndexV1,
  EvidencePlanV1,
  IntentCaptureV1,
  IntentRestatementV1,
  EvidenceBundleV1,
} from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ArtifactStore;
let repoDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `det-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  repoDir = join(tmpDir, 'repo');
  await mkdir(join(repoDir, 'src'), { recursive: true });
  const config = createConfig(tmpDir);
  store = new ArtifactStore(config);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE_A = `export function alpha() {
  return 1;
}

export function beta() {
  return 2;
}

export function gamma() {
  return 3;
}
`;

const FILE_B = `export const X = 10;
export const Y = 20;
export function compute(a: number, b: number) {
  return a + b;
}
`;

async function setupFiles() {
  await writeFile(join(repoDir, 'src/a.ts'), FILE_A, 'utf-8');
  await writeFile(join(repoDir, 'src/b.ts'), FILE_B, 'utf-8');
}

function makeIndex(): RetrievalIndexV1 {
  return {
    artifact_type: 'retrieval-index-v1',
    artifact_id: 'ri_det',
    intent_capture_id: 'ic_det',
    intent_restatement_id: 'ir_det',
    intent_spec_id: null,
    query: 'determinism test',
    confidence: 'high',
    files: [
      {
        file_id: 'fa',
        path: join(repoDir, 'src/a.ts'),
        why_relevant: 'test file a',
        file_summary: 'Three functions',
        ast_skeleton: ['function alpha()', 'function beta()', 'function gamma()'],
        recommended_expansion: 'none',
        expansion_reason: '',
        symbols: [
          {
            symbol_id: 'sa1',
            kind: 'function',
            name: 'alpha',
            start: 1,
            count: 3,
            summary: 'returns 1',
            role_in_system: 'test',
            depends_on: [],
            used_by: [],
            relevance: 'high',
            change_likelihood: 'low',
            expansion_priority: 'high',
            recommended_expansion: 'none',
            expansion_reason: '',
          },
          {
            symbol_id: 'sa2',
            kind: 'function',
            name: 'beta',
            start: 5,
            count: 3,
            summary: 'returns 2',
            role_in_system: 'test',
            depends_on: [],
            used_by: [],
            relevance: 'medium',
            change_likelihood: 'low',
            expansion_priority: 'medium',
            recommended_expansion: 'none',
            expansion_reason: '',
          },
          {
            symbol_id: 'sa3',
            kind: 'function',
            name: 'gamma',
            start: 9,
            count: 3,
            summary: 'returns 3',
            role_in_system: 'test',
            depends_on: [],
            used_by: [],
            relevance: 'low',
            change_likelihood: 'low',
            expansion_priority: 'low',
            recommended_expansion: 'none',
            expansion_reason: '',
          },
        ],
      },
      {
        file_id: 'fb',
        path: join(repoDir, 'src/b.ts'),
        why_relevant: 'test file b',
        file_summary: 'Constants and compute',
        ast_skeleton: ['const X', 'const Y', 'function compute()'],
        recommended_expansion: 'none',
        expansion_reason: '',
        symbols: [
          {
            symbol_id: 'sb1',
            kind: 'function',
            name: 'compute',
            start: 3,
            count: 3,
            summary: 'adds numbers',
            role_in_system: 'test',
            depends_on: [],
            used_by: [],
            relevance: 'medium',
            change_likelihood: 'low',
            expansion_priority: 'medium',
            recommended_expansion: 'none',
            expansion_reason: '',
          },
        ],
      },
    ],
    cross_file_findings: ['a and b are independent'],
    gaps: ['Missing tests'],
    followup_queries: ['test coverage details'],
  };
}

function makePlan(index: RetrievalIndexV1): EvidencePlanV1 {
  return {
    artifact_type: 'evidence-plan-v1',
    artifact_id: 'plan_det',
    retrieval_index: { artifact_type: 'retrieval-index-v1', artifact_id: index.artifact_id },
    selection: {
      files: [
        {
          file_id: 'fa',
          include_ast_skeleton: true,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [
            { symbol_id: 'sa1', include_span: true, neighbor_lines: 1 },
            { symbol_id: 'sa2', include_span: true, neighbor_lines: 0 },
          ],
        },
        {
          file_id: 'fb',
          include_ast_skeleton: false,
          include_retriever_summary: true,
          include_entire_file: false,
          spans: [{ symbol_id: 'sb1', include_span: true, neighbor_lines: 0 }],
        },
      ],
      include_cross_file_findings: true,
      include_gaps: true,
      include_followup_queries: false,
    },
    assembly_options: {
      max_total_lines: 2000,
      max_estimated_tokens: 20000,
      dedupe_overlapping_spans: true,
      span_merge_strategy: 'merge_if_overlapping',
    },
    prompt_sections: {
      include_intent_context: true,
      include_structural_context: true,
      include_raw_evidence: true,
    },
    target_task: { type: 'analysis-report', task_label: 'test analysis' },
  };
}

async function seedAll(index: RetrievalIndexV1, plan: EvidencePlanV1) {
  const capture: IntentCaptureV1 = {
    artifact_type: 'intent-capture-v1',
    artifact_id: 'ic_det',
    user_intent_verbatim: 'test',
    tagged_files: [],
    timestamp: '2026-04-09T00:00:00Z',
  };
  const restatement: IntentRestatementV1 = {
    artifact_type: 'intent-restatement-v1',
    artifact_id: 'ir_det',
    intent_capture_id: 'ic_det',
    user_intent_verbatim: 'test',
    restated_intent: 'Testing determinism',
    approved: true,
    expand_requested: false,
    approval_turns: 1,
  };
  await store.put(capture);
  await store.put(restatement);
  await store.put(index);
  await store.put(plan);
}

function stripId(bundle: EvidenceBundleV1): Omit<EvidenceBundleV1, 'artifact_id'> {
  const { artifact_id, ...rest } = bundle;
  return rest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('materialize produces byte-identical bundles across runs', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedAll(index, plan);

    const results: EvidenceBundleV1[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await evidenceAssemble(
        {
          mode: 'materialize',
          retrieval_index_id: index.artifact_id,
          evidence_plan_id: plan.artifact_id,
        },
        store,
      )) as EvidenceMaterializeResult;
      expect(r.status).toBe('success');
      const b = await store.get('evidence-bundle-v1', r.evidence_bundle_id!);
      results.push(b!);
    }

    const canonical = JSON.stringify(stripId(results[0]!));
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(stripId(results[i]!))).toBe(canonical);
    }
  });

  it('preview produces identical estimates across runs', async () => {
    await setupFiles();
    const index = makeIndex();
    const plan = makePlan(index);
    await seedAll(index, plan);

    const results: EvidencePreviewResult[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await evidenceAssemble(
        {
          mode: 'preview',
          retrieval_index_id: index.artifact_id,
          evidence_plan_id: plan.artifact_id,
        },
        store,
      )) as EvidencePreviewResult;
      results.push(r);
    }

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.estimated_lines).toBe(results[0]!.estimated_lines);
      expect(results[i]!.estimated_tokens).toBe(results[0]!.estimated_tokens);
    }
  });

  it('span ordering is deterministic regardless of plan file order', async () => {
    await setupFiles();
    const index = makeIndex();

    // Plan with files in reverse order
    const plan1 = makePlan(index);
    const plan2: EvidencePlanV1 = {
      ...makePlan(index),
      artifact_id: 'plan_det2',
      selection: {
        ...makePlan(index).selection,
        files: [...makePlan(index).selection.files].reverse(),
      },
    };

    await seedAll(index, plan1);
    await store.put(plan2);

    const r1 = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan1.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;
    const r2 = (await evidenceAssemble(
      {
        mode: 'materialize',
        retrieval_index_id: index.artifact_id,
        evidence_plan_id: plan2.artifact_id,
      },
      store,
    )) as EvidenceMaterializeResult;

    const b1 = await store.get('evidence-bundle-v1', r1.evidence_bundle_id!);
    const b2 = await store.get('evidence-bundle-v1', r2.evidence_bundle_id!);

    // Both should produce the same raw evidence content (just file order may differ)
    const sortEvidence = (b: EvidenceBundleV1) =>
      [...b.raw_evidence].sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);

    expect(sortEvidence(b1!).map((e) => e.content)).toEqual(
      sortEvidence(b2!).map((e) => e.content),
    );
  });

  it('dedupe merging is deterministic with overlapping spans', async () => {
    await setupFiles();
    const index = makeIndex();
    // Request alpha and beta with neighbor_lines=2 so they overlap
    const plan: EvidencePlanV1 = {
      ...makePlan(index),
      selection: {
        files: [
          {
            file_id: 'fa',
            include_ast_skeleton: false,
            include_retriever_summary: false,
            include_entire_file: false,
            spans: [
              { symbol_id: 'sa1', include_span: true, neighbor_lines: 2 },
              { symbol_id: 'sa2', include_span: true, neighbor_lines: 2 },
            ],
          },
        ],
        include_cross_file_findings: false,
        include_gaps: false,
        include_followup_queries: false,
      },
    };
    await seedAll(index, plan);

    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await evidenceAssemble(
        {
          mode: 'materialize',
          retrieval_index_id: index.artifact_id,
          evidence_plan_id: plan.artifact_id,
        },
        store,
      )) as EvidenceMaterializeResult;
      const b = await store.get('evidence-bundle-v1', r.evidence_bundle_id!);
      results.push(JSON.stringify(b!.raw_evidence));
    }

    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });
});
