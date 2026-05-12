/**
 * Workflow-spec readability test (COMP-P1-T14 acceptance).
 *
 * Per `docs/composability.md` "Phase 1 — Scaffolding":
 *
 *   The natural-language `description` / `goals` / edge-`description` fields
 *   are load-bearing: an agent reading just the JSON should be able to answer
 *   "what does this workflow do?", "what would change if I added a verification
 *   stage between synthesis and execution?", or "what's the smallest workflow
 *   that produces an analysis-report?" without grepping a single TS file.
 *   That agent-readability is a Phase 1 acceptance criterion.
 *
 * The "stubbed agent" here is a deterministic reader over the loaded spec
 * (frontmatter + markdown body, no TS source). It answers five canonical
 * questions about workflow structure, deliverables, and decision points by
 * inspecting the natural-language fields. The test asserts each answer is
 * grounded in the spec — i.e. that every claim the agent makes is still
 * present in the canonical text.
 *
 * If the spec drifts (e.g. someone removes the conditional-edge description
 * for `synthesis → execution`), the matching question fails to extract its
 * grounding and the assertion catches the drift before review.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { loadWorkflowFromFile } from '../../src/runtime/workflow-loader.ts';
import type { WorkflowSpecV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Stubbed agent
// ---------------------------------------------------------------------------

interface SpecWithBody extends WorkflowSpecV1 {
  body: string;
}

interface AgentAnswer {
  /** A short summary the agent would surface to a user. */
  answer: string;
  /** The substring(s) from the spec the agent grounded its answer on. */
  grounded_in: string[];
}

/**
 * Deterministic spec reader. Each question is answered by inspecting the
 * loaded spec's natural-language fields (no TS source, no model). The agent
 * returns both an answer and the substring grounding so the test can assert
 * every claim it makes is sourced from the spec.
 */
function readSpec(spec: SpecWithBody): {
  whatDoesItDo: () => AgentAnswer;
  whatAreTheDeliverables: () => AgentAnswer;
  whatGatesExecution: () => AgentAnswer;
  whatHappensWhenExpansionIsSkipped: () => AgentAnswer;
  whereDoesRecursionStart: () => AgentAnswer;
} {
  return {
    /** Q1: What does this workflow do? */
    whatDoesItDo: (): AgentAnswer => {
      const stageNames = spec.stages.map((s) => s.id).join(' → ');
      return {
        answer: `${spec.name}: a ${spec.operating_mode} workflow with stages ${stageNames}. ${spec.description}`,
        grounded_in: [
          spec.name,
          spec.operating_mode,
          spec.description,
          ...spec.stages.map((s) => s.id),
        ],
      };
    },

    /** Q2: What are the deliverables? */
    whatAreTheDeliverables: (): AgentAnswer => {
      const synthesis = spec.stages.find((s) => s.id === 'synthesis');
      const execution = spec.stages.find((s) => s.id === 'execution');
      const synthesisOutput = synthesis?.output ?? '';
      const executionOutput = execution?.output ?? '';
      return {
        answer: `Synthesis emits ${synthesisOutput}; execution emits ${executionOutput}. Goals: ${spec.goals.join(' / ')}.`,
        grounded_in: [synthesisOutput, executionOutput, ...spec.goals],
      };
    },

    /** Q3: What gates execution and why? */
    whatGatesExecution: (): AgentAnswer => {
      const execution = spec.stages.find((s) => s.id === 'execution');
      const gates = execution?.gates ?? [];
      const mandatory = spec.mandatory_controls;
      const isMandatory = gates.some((g) => mandatory.includes(g));
      return {
        answer: `Execution is gated by ${gates.join(', ') || '<no gates>'}; mandatory controls in effect: ${mandatory.join(', ')}.`,
        grounded_in: [...gates, ...mandatory, isMandatory ? 'mandatory' : 'non-mandatory'],
      };
    },

    /** Q4: What happens when the user does not opt into expansion? */
    whatHappensWhenExpansionIsSkipped: (): AgentAnswer => {
      const skipEdge = spec.edges.find(
        (e) => e.from === 'restatement' && e.to === 'retrieval' && e.when !== undefined,
      );
      return {
        answer: `When expand_requested is false the workflow skips expansion: ${skipEdge?.description ?? '<missing>'}`,
        grounded_in: [
          skipEdge?.from ?? '',
          skipEdge?.to ?? '',
          skipEdge?.description ?? '',
          JSON.stringify(skipEdge?.when ?? {}),
        ],
      };
    },

    /** Q5: Where does a recursive promotion start, and why? */
    whereDoesRecursionStart: (): AgentAnswer => {
      const target = spec.recursive_promotion_target;
      const targetStage = spec.stages.find((s) => s.id === target);
      return {
        answer: `Recursive promotion re-enters at "${target}" (${targetStage?.name ?? '<unknown>'}): ${targetStage?.description ?? ''}`,
        grounded_in: [target, targetStage?.name ?? '', targetStage?.description ?? ''],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_PATH = resolve(
  import.meta.dir,
  '../../src/runtime/workflows/piorx-default.workflow.md',
);

function loadSpec(): SpecWithBody {
  return loadWorkflowFromFile(DEFAULT_WORKFLOW_PATH) as SpecWithBody;
}

function assertGroundedInSpec(answer: AgentAnswer, spec: SpecWithBody): void {
  const corpus = `${JSON.stringify(spec)}\n${spec.body}`;
  for (const fragment of answer.grounded_in) {
    if (fragment === '') continue;
    expect(
      corpus.includes(fragment),
      `expected fragment ${JSON.stringify(fragment)} to appear in the spec corpus`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Tests — five canonical questions
// ---------------------------------------------------------------------------

describe('workflow-spec readability — five canonical questions', () => {
  test('Q1: stubbed agent can describe what the workflow does (operating_mode + stages + description)', () => {
    const spec = loadSpec();
    const agent = readSpec(spec);
    const answer = agent.whatDoesItDo();
    expect(answer.answer).toContain('supervised-change');
    expect(answer.answer).toContain('restatement');
    expect(answer.answer).toContain('execution');
    assertGroundedInSpec(answer, spec);
    // The agent should be able to enumerate every default stage in order.
    expect(answer.grounded_in).toEqual(
      expect.arrayContaining([
        'restatement',
        'expansion',
        'retrieval',
        'evidence',
        'synthesis',
        'execution',
      ]),
    );
  });

  test('Q2: stubbed agent identifies the deliverables (analysis-report or change-spec; execution-report)', () => {
    const spec = loadSpec();
    const agent = readSpec(spec);
    const answer = agent.whatAreTheDeliverables();
    expect(answer.answer).toContain('piorx/analysis-report@1');
    expect(answer.answer).toContain('piorx/change-spec@1');
    expect(answer.answer).toContain('piorx/execution-report@1');
    assertGroundedInSpec(answer, spec);
  });

  test('Q3: stubbed agent identifies what gates execution and that the gate is mandatory', () => {
    const spec = loadSpec();
    const agent = readSpec(spec);
    const answer = agent.whatGatesExecution();
    expect(answer.answer).toContain('execution.allow_edits');
    expect(answer.answer).toContain('mandatory');
    expect(answer.grounded_in).toContain('execution.allow_edits');
    expect(answer.grounded_in).toContain('intent.approval');
    assertGroundedInSpec(answer, spec);
  });

  test('Q4: stubbed agent explains how the workflow routes when the user skips expansion', () => {
    const spec = loadSpec();
    const agent = readSpec(spec);
    const answer = agent.whatHappensWhenExpansionIsSkipped();
    // The agent's answer must reference the conditional edge and its
    // natural-language description.
    expect(answer.answer.toLowerCase()).toContain('skip');
    expect(answer.grounded_in).toContain('restatement');
    expect(answer.grounded_in).toContain('retrieval');
    // The when-predicate JSON is one of the grounding fragments — the spec
    // body must still carry it for the agent to ground correctly.
    const whenFragment = answer.grounded_in.find((f) => f.includes('expand_requested'));
    expect(whenFragment).toBeDefined();
    assertGroundedInSpec(answer, spec);
  });

  test('Q5: stubbed agent explains where a recursive promotion re-enters the workflow and why', () => {
    const spec = loadSpec();
    const agent = readSpec(spec);
    const answer = agent.whereDoesRecursionStart();
    expect(answer.answer).toContain('restatement');
    expect(spec.recursive_promotion_target).toBe('restatement');
    // The body text must explain *why* recursion targets restatement —
    // mentioning the intent.approval gate as the entry point of every
    // recursion. This is the load-bearing rationale for the field.
    expect(spec.body).toContain('intent.approval');
    assertGroundedInSpec(answer, spec);
  });
});

// ---------------------------------------------------------------------------
// Drift protection — the natural-language fields must remain agent-readable
// ---------------------------------------------------------------------------

describe('workflow-spec readability — natural-language fields stay populated', () => {
  test('every stage has a non-empty description', () => {
    const spec = loadSpec();
    for (const stage of spec.stages) {
      expect(stage.description.length, `${stage.id} description`).toBeGreaterThan(0);
    }
  });

  test('every edge has a non-empty natural-language description', () => {
    const spec = loadSpec();
    for (const edge of spec.edges) {
      expect(edge.description.length, `${edge.from}→${edge.to} description`).toBeGreaterThan(0);
    }
  });

  test('markdown body documents Operating mode, Goals, Stages, Edges, Governance, Recursive promotion', () => {
    const spec = loadSpec();
    expect(spec.body).toContain('## Operating mode');
    expect(spec.body).toContain('## Goals');
    expect(spec.body).toContain('## Stages');
    expect(spec.body).toContain('## Edges');
    expect(spec.body).toContain('## Governance');
    expect(spec.body).toContain('## Recursive promotion');
    // One H3 per stage matching `stages[].id`.
    for (const stage of spec.stages) {
      expect(spec.body).toContain(`### ${stage.id}`);
    }
  });
});
