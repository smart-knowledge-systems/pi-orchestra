/**
 * Expansion inclusion protocol tests.
 *
 * Validates tagged-file auto-inclusion, project-doc discovery/prompting,
 * expansion-input persistence, and the approve/revise/reject review loop.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from '../../src/runtime/config.ts';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { StageMachine } from '../../src/conductor/stage-machine.ts';
import { Stage1Controller, type RestateFunction } from '../../src/conductor/stage-1.ts';
import {
  ExpansionController,
  type ExpandFunction,
  type ProjectDocInclusionResponse,
} from '../../src/conductor/expansion.ts';
import {
  PROJECT_DOC_INCLUSION_QUESTION,
  EXPANSION_REVIEW_PROMPT,
} from '../../src/conductor/prompts.ts';
import type { ExpandedSpec, ExpansionInputV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const echoRestate: RestateFunction = ({ cleanedIntent }) => `Restatement: ${cleanedIntent}`;

/** Deterministic expand function that echoes back the intent as a spec. */
const stubExpand: ExpandFunction = async (input: ExpansionInputV1): Promise<ExpandedSpec> => ({
  objective: `Expanded: ${input.user_intent_verbatim}`,
  deliverables: ['deliverable-1'],
  constraints: ['constraint-1'],
  retrieval_focus: ['focus-1'],
  open_questions: [],
});

async function setupWithStage1Complete(options: {
  taggedFiles?: string[];
  expand?: boolean;
  createDocs?: string[];
}) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'expansion-test-'));
  const config = createConfig(tmpDir);
  const store = new ArtifactStore(config);
  const machine = await StageMachine.init(config);

  // Create project docs if requested
  if (options.createDocs) {
    for (const doc of options.createDocs) {
      await writeFile(join(tmpDir, doc), `# ${doc}\nTest content`, 'utf-8');
    }
  }

  // Run Stage 1 to completion
  const stage1 = new Stage1Controller(store, machine, echoRestate);
  const capture = await stage1.captureIntent('Test intent', options.taggedFiles ?? []);
  await stage1.produceRestatement();
  await stage1.submitApproval('Restatement: Test intent', { approved: true });
  const stage1Result = await stage1.finalize('Restatement: Test intent', {
    expand: options.expand ?? true,
  });

  const expansion = new ExpansionController(store, machine, tmpDir, stubExpand);

  return {
    tmpDir,
    config,
    store,
    machine,
    expansion,
    capture: stage1Result.intent_capture,
    restatement: stage1Result.intent_restatement,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Expansion inclusion protocol', () => {
  // -- Project-doc inclusion question ------------------------------------

  describe('checkProjectDocInclusion', () => {
    it('returns null when tagged files exist (auto-inclusion)', async () => {
      const { expansion, capture } = await setupWithStage1Complete({
        taggedFiles: ['src/main.ts'],
        createDocs: ['README.md'],
      });

      const result = expansion.checkProjectDocInclusion(capture.tagged_files);
      expect(result).toBeNull();
    });

    it('returns null when no tagged files and no project docs exist', async () => {
      const { expansion, capture } = await setupWithStage1Complete({
        taggedFiles: [],
        createDocs: [],
      });

      const result = expansion.checkProjectDocInclusion(capture.tagged_files);
      expect(result).toBeNull();
    });

    it('returns inclusion question when no tagged files but docs exist', async () => {
      const { expansion, capture } = await setupWithStage1Complete({
        taggedFiles: [],
        createDocs: ['README.md', 'CLAUDE.md'],
      });

      const result = expansion.checkProjectDocInclusion(capture.tagged_files);
      expect(result).not.toBeNull();
      expect(result!.question).toBe(PROJECT_DOC_INCLUSION_QUESTION);
      expect(result!.available_docs).toHaveLength(2);
      expect(result!.available_docs.map((d) => d.filename)).toEqual(['README.md', 'CLAUDE.md']);
    });

    it('discovers all three project doc types', async () => {
      const { expansion, capture } = await setupWithStage1Complete({
        taggedFiles: [],
        createDocs: ['README.md', 'AGENTS.md', 'CLAUDE.md'],
      });

      const result = expansion.checkProjectDocInclusion(capture.tagged_files);
      expect(result!.available_docs).toHaveLength(3);
      expect(result!.available_docs.map((d) => d.filename)).toEqual([
        'README.md',
        'AGENTS.md',
        'CLAUDE.md',
      ]);
    });
  });

  // -- Expansion input creation ------------------------------------------

  describe('createExpansionInput', () => {
    it('auto-includes all tagged files with reason "user-tagged"', async () => {
      const { expansion, capture, restatement, store } = await setupWithStage1Complete({
        taggedFiles: ['src/auth.ts', 'src/login.ts'],
      });

      const input = await expansion.createExpansionInput(capture, restatement);

      expect(input.artifact_type).toBe('piorx/expansion-input@1');
      expect(input.included_files).toEqual([
        { path: 'src/auth.ts', reason: 'user-tagged' },
        { path: 'src/login.ts', reason: 'user-tagged' },
      ]);

      // Verify persisted
      const loaded = await store.get('piorx/expansion-input@1', input.artifact_id);
      expect(loaded).toEqual(input);
    });

    it('includes selected project docs when no tagged files', async () => {
      const { expansion, capture, restatement, tmpDir } = await setupWithStage1Complete({
        taggedFiles: [],
        createDocs: ['README.md', 'AGENTS.md', 'CLAUDE.md'],
      });

      const response: ProjectDocInclusionResponse = {
        'README.md': true,
        'AGENTS.md': false,
        'CLAUDE.md': true,
      };

      const input = await expansion.createExpansionInput(capture, restatement, response);

      expect(input.included_files).toHaveLength(2);
      expect(input.included_files[0]!.path).toBe(join(tmpDir, 'README.md'));
      expect(input.included_files[0]!.reason).toBe('project-doc-included');
      expect(input.included_files[1]!.path).toBe(join(tmpDir, 'CLAUDE.md'));
      expect(input.included_files[1]!.reason).toBe('project-doc-included');
    });

    it('creates empty included_files when no tagged files and no docs selected', async () => {
      const { expansion, capture, restatement } = await setupWithStage1Complete({
        taggedFiles: [],
      });

      const input = await expansion.createExpansionInput(capture, restatement);
      expect(input.included_files).toEqual([]);
    });

    it('ignores project-doc response when tagged files exist', async () => {
      const { expansion, capture, restatement } = await setupWithStage1Complete({
        taggedFiles: ['src/main.ts'],
        createDocs: ['README.md'],
      });

      // Even if a response is provided, it should be ignored
      const response: ProjectDocInclusionResponse = { 'README.md': true };
      const input = await expansion.createExpansionInput(capture, restatement, response);

      // Only the tagged file, not the project doc
      expect(input.included_files).toEqual([{ path: 'src/main.ts', reason: 'user-tagged' }]);
    });

    it('sets expansion_input_id on session state', async () => {
      const { expansion, capture, restatement, machine } = await setupWithStage1Complete({
        taggedFiles: [],
      });

      const input = await expansion.createExpansionInput(capture, restatement);
      expect(machine.sessionState.artifacts.expansion_input_id).toBe(input.artifact_id);
    });

    it('links to the correct capture and restatement IDs', async () => {
      const { expansion, capture, restatement } = await setupWithStage1Complete({
        taggedFiles: [],
      });

      const input = await expansion.createExpansionInput(capture, restatement);
      expect(input.intent_capture_id).toBe(capture.artifact_id);
      expect(input.intent_restatement_id).toBe(restatement.artifact_id);
      expect(input.user_intent_verbatim).toBe(capture.user_intent_verbatim);
      expect(input.approved_restated_intent).toBe(restatement.restated_intent);
    });
  });

  // -- Expansion run and review ------------------------------------------

  describe('runExpansion', () => {
    it('returns the canonical review message shape', async () => {
      const { expansion, capture, restatement } = await setupWithStage1Complete({
        taggedFiles: [],
      });

      await expansion.createExpansionInput(capture, restatement);
      const review = await expansion.runExpansion();

      expect(review.review_prompt).toBe(EXPANSION_REVIEW_PROMPT);
      expect(review.expanded_spec.objective).toBe('Expanded: Test intent');
      expect(review.expanded_spec.deliverables).toEqual(['deliverable-1']);
      expect(review.expansion_input_id).toMatch(/^expand_in_/);
    });

    it('throws if no expansion input was created', async () => {
      const { expansion } = await setupWithStage1Complete({ taggedFiles: [] });

      await expect(expansion.runExpansion()).rejects.toThrow(
        'Cannot run expansion: no expansion input created yet',
      );
    });
  });

  describe('submitReview', () => {
    async function setupWithReview() {
      const env = await setupWithStage1Complete({ taggedFiles: [] });
      await env.expansion.createExpansionInput(env.capture, env.restatement);
      const review = await env.expansion.runExpansion();
      return { ...env, review };
    }

    it('persists intent-spec-v1 on approve and transitions to retrieval', async () => {
      const { expansion, review, store, machine } = await setupWithReview();

      const result = await expansion.submitReview(review.expanded_spec, {
        action: 'approve',
      });

      expect(result.outcome).toBe('approved');
      if (result.outcome === 'approved') {
        expect(result.result.intent_spec.artifact_type).toBe('piorx/intent-spec@1');
        expect(result.result.intent_spec.approved).toBe(true);
        expect(result.result.intent_spec.expanded_spec.objective).toBe('Expanded: Test intent');

        // Verify persisted
        const loaded = await store.get(
          'piorx/intent-spec@1',
          result.result.intent_spec.artifact_id,
        );
        expect(loaded).toEqual(result.result.intent_spec);
      }

      expect(machine.currentStage).toBe('retrieval');
    });

    it('sets intent_spec_id on session state after approval', async () => {
      const { expansion, review, machine } = await setupWithReview();

      const result = await expansion.submitReview(review.expanded_spec, {
        action: 'approve',
      });

      if (result.outcome === 'approved') {
        expect(machine.sessionState.artifacts.intent_spec_id).toBe(
          result.result.intent_spec.artifact_id,
        );
      }
    });

    it('creates new expansion input on revise and re-runs expansion', async () => {
      const { expansion, review, store, machine } = await setupWithReview();

      const result = await expansion.submitReview(review.expanded_spec, {
        action: 'revise',
        revised_intent: 'Revised test intent',
      });

      expect(result.outcome).toBe('revised');
      if (result.outcome === 'revised') {
        expect(result.message.review_prompt).toBe(EXPANSION_REVIEW_PROMPT);
        expect(result.message.expanded_spec.objective).toBe('Expanded: Revised test intent');
        // New expansion input was created
        expect(result.message.expansion_input_id).not.toBe(review.expansion_input_id);
      }

      // Stage stays at expansion during revision
      expect(machine.currentStage).toBe('expansion');
    });

    it('persists the revised expansion input artifact', async () => {
      const { expansion, review, store } = await setupWithReview();

      const result = await expansion.submitReview(review.expanded_spec, {
        action: 'revise',
        revised_intent: 'Revised test intent',
      });

      if (result.outcome === 'revised') {
        const loaded = await store.get(
          'piorx/expansion-input@1',
          result.message.expansion_input_id,
        );
        expect(loaded).not.toBeNull();
        expect(loaded!.user_intent_verbatim).toBe('Revised test intent');
      }
    });

    it('transitions to retrieval on reject without intent spec', async () => {
      const { expansion, review, machine } = await setupWithReview();

      const result = await expansion.submitReview(review.expanded_spec, {
        action: 'reject',
      });

      expect(result.outcome).toBe('rejected');
      expect(machine.currentStage).toBe('retrieval');
      expect(machine.sessionState.artifacts.intent_spec_id).toBeNull();
    });

    it('throws if no expansion input exists', async () => {
      const { expansion } = await setupWithStage1Complete({ taggedFiles: [] });

      const spec: ExpandedSpec = {
        objective: 'test',
        deliverables: [],
        constraints: [],
        retrieval_focus: [],
        open_questions: [],
      };

      await expect(expansion.submitReview(spec, { action: 'approve' })).rejects.toThrow(
        'Cannot submit review: no expansion input exists',
      );
    });
  });

  // -- Full flow ---------------------------------------------------------

  describe('end-to-end expansion flow', () => {
    it('completes tagged-file flow: auto-include → expand → approve', async () => {
      const { expansion, capture, restatement, store, machine } = await setupWithStage1Complete({
        taggedFiles: ['src/main.ts', 'src/util.ts'],
      });

      // 1. No inclusion question needed
      const question = expansion.checkProjectDocInclusion(capture.tagged_files);
      expect(question).toBeNull();

      // 2. Create expansion input with auto-included files
      const input = await expansion.createExpansionInput(capture, restatement);
      expect(input.included_files).toHaveLength(2);

      // 3. Run expansion
      const review = await expansion.runExpansion();
      expect(review.expanded_spec.objective).toContain('Test intent');

      // 4. Approve
      const result = await expansion.submitReview(review.expanded_spec, {
        action: 'approve',
      });
      expect(result.outcome).toBe('approved');
      expect(machine.currentStage).toBe('retrieval');
    });

    it('completes project-doc flow: discover → ask → include → expand → approve', async () => {
      const { expansion, capture, restatement, machine } = await setupWithStage1Complete({
        taggedFiles: [],
        createDocs: ['README.md', 'CLAUDE.md'],
      });

      // 1. Inclusion question is needed
      const question = expansion.checkProjectDocInclusion(capture.tagged_files);
      expect(question).not.toBeNull();
      expect(question!.available_docs).toHaveLength(2);

      // 2. User selects README.md only
      const docResponse: ProjectDocInclusionResponse = {
        'README.md': true,
        'CLAUDE.md': false,
      };
      const input = await expansion.createExpansionInput(capture, restatement, docResponse);
      expect(input.included_files).toHaveLength(1);
      expect(input.included_files[0]!.reason).toBe('project-doc-included');

      // 3. Run and approve
      const review = await expansion.runExpansion();
      const result = await expansion.submitReview(review.expanded_spec, {
        action: 'approve',
      });
      expect(result.outcome).toBe('approved');
      expect(machine.currentStage).toBe('retrieval');
    });

    it('handles revise → approve cycle', async () => {
      const { expansion, capture, restatement, machine, store } = await setupWithStage1Complete({
        taggedFiles: [],
      });

      await expansion.createExpansionInput(capture, restatement);
      const review1 = await expansion.runExpansion();

      // Revise
      const revised = await expansion.submitReview(review1.expanded_spec, {
        action: 'revise',
        revised_intent: 'Better intent',
      });
      expect(revised.outcome).toBe('revised');

      // Approve the revision
      if (revised.outcome === 'revised') {
        const final = await expansion.submitReview(revised.message.expanded_spec, {
          action: 'approve',
        });
        expect(final.outcome).toBe('approved');
        if (final.outcome === 'approved') {
          expect(final.result.intent_spec.expanded_spec.objective).toBe('Expanded: Better intent');
        }
      }

      expect(machine.currentStage).toBe('retrieval');
    });
  });
});
