/**
 * WorkflowRegistry tests (COMP-P1-T5 acceptance).
 *
 * Covers:
 *   - Boot-time referential validation against the shipped default
 *     workflow (`src/runtime/workflows/piorx-default.workflow.md`) +
 *     stage adapters from `src/conductor/stage-adapters.ts`.
 *   - Drift detection when a Stage's input/output disagrees with the
 *     workflow spec.
 *   - Extension conformance — extensions cannot remove or weaken a
 *     `mandatory_controls` gate, cannot drop parent gates via
 *     `stage_overrides`, and cannot weaken `failure_handling` of an
 *     overridden stage.
 *   - Sub-workflow conformance — nested `operating_mode` must be
 *     `<= parent`, `mandatory_controls` propagate downward additively,
 *     cycles are rejected, max nesting depth is enforced.
 *
 * Workflow-executor (T7) and broader runtime tests (T13/T14) layer on top
 * of this seam in later tasks.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type {
  GateOp,
  GateOpValidation,
  GatePresentation,
  GateSpec,
} from '../../src/runtime/gate.ts';
import { WorkflowRegistry, WorkflowRegistryError } from '../../src/runtime/registry.ts';
import { loadWorkflowFromFile } from '../../src/runtime/workflow-loader.ts';
import {
  DEFAULT_STAGE_ADAPTERS,
  registerDefaultStages,
} from '../../src/conductor/stage-adapters.ts';
import type { Stage } from '../../src/runtime/stage.ts';
import type { WorkflowSpecV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_PATH = resolve(
  import.meta.dir,
  '../../src/runtime/workflows/piorx-default.workflow.md',
);

function loadDefaultWorkflow(): WorkflowSpecV1 {
  return loadWorkflowFromFile(DEFAULT_WORKFLOW_PATH);
}

function makeStubGate(id: string): GateSpec {
  return {
    id,
    async presents(): Promise<GatePresentation> {
      return { summary: `${id} review` };
    },
    validateOverride(_op: GateOp): GateOpValidation {
      return { valid: true, errors: [] };
    },
    async applyOverride(): Promise<void> {
      // no-op; conformance test only checks registration
    },
  };
}

function registerAllDefaultGates(registry: WorkflowRegistry): void {
  registry.registerGate('restatement', makeStubGate('intent.approval'));
  registry.registerGate('expansion', makeStubGate('expansion.review'));
  registry.registerGate('evidence', makeStubGate('evidence.review'));
  registry.registerGate('synthesis', makeStubGate('synthesis.confirm-task-type'));
  registry.registerGate('execution', makeStubGate('execution.allow_edits'));
}

// ---------------------------------------------------------------------------
// Boot-time validation against the shipped default workflow
// ---------------------------------------------------------------------------

describe('WorkflowRegistry — default workflow boot validation', () => {
  test('default workflow loads and validates structurally', () => {
    const spec = loadDefaultWorkflow();
    expect(spec.artifact_type).toBe('piorx/workflow-spec@1');
    expect(spec.id).toBe('piorx/workflow/default@1');
    expect(spec.operating_mode).toBe('supervised-change');
    expect(spec.mandatory_controls).toEqual(['intent.approval', 'execution.allow_edits']);
    expect(spec.stages.map((s) => s.id)).toEqual([
      'restatement',
      'expansion',
      'retrieval',
      'evidence',
      'synthesis',
      'execution',
    ]);
  });

  test('every stage adapter resolves by id', () => {
    const registry = new WorkflowRegistry();
    registerDefaultStages(registry);
    for (const adapter of DEFAULT_STAGE_ADAPTERS) {
      const resolved = registry.resolveStage(adapter.id);
      expect(resolved).toBe(adapter);
    }
  });

  test('registry.validate() succeeds with default workflow + adapters + gates', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    registerDefaultStages(registry);
    registerAllDefaultGates(registry);
    expect(() => registry.validate()).not.toThrow();
  });

  test('mandatory_controls gate has a registered GateSpec', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    registerDefaultStages(registry);
    registry.registerGate('expansion', makeStubGate('expansion.review'));
    registry.registerGate('evidence', makeStubGate('evidence.review'));
    registry.registerGate('synthesis', makeStubGate('synthesis.confirm-task-type'));
    // Intentionally omit intent.approval — a mandatory_control.
    registry.registerGate('execution', makeStubGate('execution.allow_edits'));
    expect(() => registry.validate()).toThrow(WorkflowRegistryError);
    try {
      registry.validate();
    } catch (err) {
      const error = err as WorkflowRegistryError;
      expect(error.violations.some((v) => v.includes('intent.approval'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Drift detection — Stage input/output disagrees with workflow spec
// ---------------------------------------------------------------------------

describe('WorkflowRegistry — drift detection', () => {
  test('Stage with wrong output triggers a violation', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    // Register a counterfeit "synthesis" stage whose output is one type
    // (analysis-report-only) instead of the union the spec declares.
    const driftedSynthesis: Stage = {
      id: 'synthesis',
      inputs: ['piorx/evidence-bundle@1', 'piorx/intent-restatement@1'],
      output: 'piorx/analysis-report@1', // wrong: spec declares the union
      async run() {
        return { output_artifact_id: 'noop' };
      },
    };
    // Register the rest legitimately
    for (const adapter of DEFAULT_STAGE_ADAPTERS) {
      if (adapter.id === 'synthesis') continue;
      registry.registerStage(adapter);
    }
    registry.registerStage(driftedSynthesis);
    registerAllDefaultGates(registry);

    expect(() => registry.validate()).toThrow(WorkflowRegistryError);
    try {
      registry.validate();
    } catch (err) {
      const error = err as WorkflowRegistryError;
      expect(error.violations.some((v) => v.includes('output') && v.includes('synthesis'))).toBe(
        true,
      );
    }
  });

  test('Stage with wrong inputs triggers a violation', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    // Only the retrieval adapter is wrong; everything else is legitimate.
    const driftedRetrieval: Stage = {
      id: 'retrieval',
      inputs: ['piorx/intent-capture@1'], // wrong: spec declares restatement
      output: 'piorx/retrieval-index@1',
      async run() {
        return { output_artifact_id: 'noop' };
      },
    };
    for (const adapter of DEFAULT_STAGE_ADAPTERS) {
      if (adapter.id === 'retrieval') continue;
      registry.registerStage(adapter);
    }
    registry.registerStage(driftedRetrieval);
    registerAllDefaultGates(registry);

    expect(() => registry.validate()).toThrow(WorkflowRegistryError);
    try {
      registry.validate();
    } catch (err) {
      const error = err as WorkflowRegistryError;
      expect(error.violations.some((v) => v.includes('input') && v.includes('retrieval'))).toBe(
        true,
      );
    }
  });

  test('Stage with unknown artifact type is rejected at registration', () => {
    const registry = new WorkflowRegistry();
    const stage: Stage = {
      id: 'bogus',
      inputs: ['piorx/not-a-real-type@1'],
      output: 'piorx/intent-capture@1',
      async run() {
        return { output_artifact_id: 'noop' };
      },
    };
    expect(() => registry.registerStage(stage)).toThrow(/not a known ArtifactType/);
  });
});

// ---------------------------------------------------------------------------
// Extension conformance — `extends` + `stage_overrides`
// ---------------------------------------------------------------------------

function buildExtensionSpec(parentId: string, overrides: Partial<WorkflowSpecV1>): WorkflowSpecV1 {
  const base = loadDefaultWorkflow();
  return {
    ...base,
    id: 'piorx/workflow/test-extension@1',
    artifact_id: `${base.artifact_id}-extension`,
    extends: parentId,
    ...overrides,
  };
}

describe('WorkflowRegistry — extension conformance', () => {
  test('extension that drops a parent mandatory_control is rejected', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtensionSpec('piorx/workflow/default@1', {
      mandatory_controls: ['intent.approval'], // dropped execution.allow_edits
    });
    expect(() => registry.registerWorkflow(child)).toThrow(/execution\.allow_edits/);
  });

  test('extension that elevates operating_mode is rejected', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtensionSpec('piorx/workflow/default@1', {
      operating_mode: 'constrained-autonomous',
    });
    expect(() => registry.registerWorkflow(child)).toThrow(/operating_mode/);
  });

  test('stage_overrides that drops a parent gate is rejected', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtensionSpec('piorx/workflow/default@1', {
      stage_overrides: {
        execution: {
          gates: [], // drops execution.allow_edits
        },
      },
    });
    expect(() => registry.registerWorkflow(child)).toThrow(/drops parent gate/);
  });

  test('stage_overrides that weakens failure_handling is rejected', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtensionSpec('piorx/workflow/default@1', {
      stage_overrides: {
        execution: {
          control: { failure_handling: 'retry' }, // halt -> retry weakens
        },
      },
    });
    expect(() => registry.registerWorkflow(child)).toThrow(/weakens parent/);
  });

  test('extension that adds a mandatory_control is accepted', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtensionSpec('piorx/workflow/default@1', {
      mandatory_controls: ['intent.approval', 'execution.allow_edits', 'expansion.review'],
    });
    expect(() => registry.registerWorkflow(child)).not.toThrow();
  });

  test('extension that lowers operating_mode is accepted', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtensionSpec('piorx/workflow/default@1', {
      operating_mode: 'advisory',
      mandatory_controls: ['intent.approval', 'execution.allow_edits'],
    });
    expect(() => registry.registerWorkflow(child)).not.toThrow();
  });

  test('extension that points at an unregistered parent is rejected', () => {
    const registry = new WorkflowRegistry();
    const child = buildExtensionSpec('piorx/workflow/missing@1', {});
    expect(() => registry.registerWorkflow(child)).toThrow(/no such workflow is registered/);
  });
});

// ---------------------------------------------------------------------------
// Sub-workflow conformance — operating_mode, mandatory_controls,
// cycles, depth cap.
// ---------------------------------------------------------------------------

function buildHostSpecWithSubWorkflow(
  sub: WorkflowSpecV1['stages'][number]['workflow'],
): WorkflowSpecV1 {
  const base = loadDefaultWorkflow();
  // Replace the synthesis stage's workflow inline with the sub-workflow.
  return {
    ...base,
    id: 'piorx/workflow/sub-test@1',
    artifact_id: `${base.artifact_id}-sub-test`,
    stages: base.stages.map((s) => (s.id === 'synthesis' ? { ...s, workflow: sub } : s)),
  };
}

function buildSubWorkflow(
  overrides: Partial<NonNullable<WorkflowSpecV1['stages'][number]['workflow']>> = {},
): NonNullable<WorkflowSpecV1['stages'][number]['workflow']> {
  return {
    id: 'piorx/workflow/sub-default@1',
    name: 'sub workflow',
    description: 'a synthetic sub-workflow used only in tests',
    goals: ['exercise sub-workflow conformance'],
    operating_mode: 'supervised-change',
    mandatory_controls: ['intent.approval', 'execution.allow_edits'],
    stages: [
      {
        id: 'sub.dummy',
        name: 'dummy',
        description: 'placeholder sub stage',
        inputs: ['piorx/evidence-bundle@1'],
        output: 'piorx/analysis-report@1',
        model_class: 'llm',
      },
    ],
    edges: [],
    recursive_promotion_target: 'sub.dummy',
    ...overrides,
  };
}

describe('WorkflowRegistry — sub-workflow conformance', () => {
  test('sub-workflow with elevated operating_mode is rejected', () => {
    const registry = new WorkflowRegistry();
    const sub = buildSubWorkflow({ operating_mode: 'constrained-autonomous' });
    const host = buildHostSpecWithSubWorkflow(sub);
    expect(() => registry.registerWorkflow(host)).toThrow(/sub-workflow operating_mode/);
  });

  test('sub-workflow that drops parent mandatory_controls is rejected', () => {
    const registry = new WorkflowRegistry();
    const sub = buildSubWorkflow({
      mandatory_controls: ['intent.approval'], // drops execution.allow_edits
    });
    const host = buildHostSpecWithSubWorkflow(sub);
    expect(() => registry.registerWorkflow(host)).toThrow(/drops parent mandatory_control/);
  });

  test('sub-workflow with the same id as the parent (cycle) is rejected', () => {
    const registry = new WorkflowRegistry();
    const sub = buildSubWorkflow({ id: 'piorx/workflow/cycle-host@1' });
    const host: WorkflowSpecV1 = {
      ...buildHostSpecWithSubWorkflow(sub),
      id: 'piorx/workflow/cycle-host@1',
    };
    expect(() => registry.registerWorkflow(host)).toThrow(/cycle/);
  });

  test('nesting deeper than maxNestingDepth is rejected', () => {
    const registry = new WorkflowRegistry({ maxNestingDepth: 1 });
    // Build a 2-level deep sub-workflow chain
    const innerSub = buildSubWorkflow({ id: 'piorx/workflow/inner@1' });
    const outerSub = buildSubWorkflow({
      id: 'piorx/workflow/outer@1',
      stages: [
        {
          id: 'sub.outer',
          name: 'outer',
          description: 'sub at depth 1',
          inputs: ['piorx/evidence-bundle@1'],
          output: 'piorx/analysis-report@1',
          model_class: 'llm',
          workflow: innerSub,
        },
      ],
      recursive_promotion_target: 'sub.outer',
    });
    const host = buildHostSpecWithSubWorkflow(outerSub);
    expect(() => registry.registerWorkflow(host)).toThrow(/nesting/);
  });

  test('sub-workflow with the same operating_mode and additive controls is accepted', () => {
    const registry = new WorkflowRegistry();
    const sub = buildSubWorkflow({
      operating_mode: 'supervised-change',
      mandatory_controls: ['intent.approval', 'execution.allow_edits', 'sub.review'],
    });
    const host = buildHostSpecWithSubWorkflow(sub);
    expect(() => registry.registerWorkflow(host)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// workflow_ref conformance — referenced-workflow resolution + authority +
// mandatory-control propagation. Mirrors the checks for inline
// `workflow:` blocks (sub-workflow conformance) but operates on the
// registered-workflow graph rather than the inline-spec tree.
// ---------------------------------------------------------------------------

function buildHostSpecWithWorkflowRef(refId: string): WorkflowSpecV1 {
  const base = loadDefaultWorkflow();
  return {
    ...base,
    id: 'piorx/workflow/ref-host@1',
    artifact_id: `${base.artifact_id}-ref-host`,
    stages: base.stages.map((s) => (s.id === 'synthesis' ? { ...s, workflow_ref: refId } : s)),
  };
}

function buildReferencedWorkflow(overrides: Partial<WorkflowSpecV1> = {}): WorkflowSpecV1 {
  // Default referenced workflow is self-consistent: its mandatory_controls
  // are declared on `sub.dummy.gates` and matched by stub gate registrations
  // in setupRefTestRegistry. Tests override only the fields they care about
  // (operating_mode, mandatory_controls) and inherit the rest.
  const baseControls = ['intent.approval', 'execution.allow_edits'];
  const merged: WorkflowSpecV1 = {
    artifact_type: 'piorx/workflow-spec@1',
    artifact_id: 'wf-spec-ref-test',
    id: 'piorx/workflow/ref-target@1',
    name: 'workflow_ref target',
    description: 'a synthetic referenced workflow used only in tests',
    goals: ['exercise workflow_ref conformance'],
    operating_mode: 'supervised-change',
    mandatory_controls: baseControls,
    stages: [
      {
        id: 'sub.dummy',
        name: 'dummy',
        description: 'placeholder sub stage',
        inputs: ['piorx/evidence-bundle@1'],
        output: 'piorx/analysis-report@1',
        model_class: 'llm',
        gates: baseControls,
      },
    ],
    edges: [],
    recursive_promotion_target: 'sub.dummy',
    ...overrides,
  };
  // Whenever the caller overrides `mandatory_controls` we re-derive
  // `sub.dummy.gates` so the controls remain declared on a stage. Tests
  // that intentionally drop a control test the workflow_ref validator,
  // not the underlying check that mandatory_controls exist at all.
  if (overrides.mandatory_controls) {
    merged.stages = [
      {
        ...merged.stages[0]!,
        gates: overrides.mandatory_controls,
      },
    ];
  }
  return merged;
}

const stubSubStage: Stage = {
  id: 'sub.dummy',
  inputs: ['piorx/evidence-bundle@1'],
  output: 'piorx/analysis-report@1',
  async run(): Promise<{ output_artifact_id: string }> {
    return { output_artifact_id: 'unused-in-validation' };
  },
};

function setupRefTestRegistry(opts: {
  host: WorkflowSpecV1;
  referenced?: WorkflowSpecV1;
}): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.registerWorkflow(opts.host);
  if (opts.referenced) registry.registerWorkflow(opts.referenced);
  registerDefaultStages(registry);
  registry.registerStage(stubSubStage);
  registerAllDefaultGates(registry);
  // Register gate stubs against sub.dummy for every gate the referenced
  // workflow declares so its own checkWorkflowReferences passes
  // independent of the workflow_ref check we're exercising.
  if (opts.referenced) {
    const subStage = opts.referenced.stages.find((s) => s.id === 'sub.dummy');
    const subGates = subStage?.gates ?? [];
    for (const gateId of subGates) {
      registry.registerGate('sub.dummy', makeStubGate(gateId));
    }
  }
  return registry;
}

describe('WorkflowRegistry — workflow_ref conformance', () => {
  test('workflow_ref to an unregistered workflow is rejected at validate()', () => {
    const host = buildHostSpecWithWorkflowRef('piorx/workflow/does-not-exist@1');
    const registry = setupRefTestRegistry({ host });
    try {
      registry.validate();
      throw new Error('expected validate() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowRegistryError);
      const message = (err as WorkflowRegistryError).message;
      expect(message).toMatch(/workflow_ref "piorx\/workflow\/does-not-exist@1" is not registered/);
    }
  });

  test('workflow_ref to a referenced workflow with elevated operating_mode is rejected', () => {
    const referenced = buildReferencedWorkflow({
      operating_mode: 'constrained-autonomous',
    });
    const host = buildHostSpecWithWorkflowRef(referenced.id);
    const registry = setupRefTestRegistry({ host, referenced });
    try {
      registry.validate();
      throw new Error('expected validate() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowRegistryError);
      const message = (err as WorkflowRegistryError).message;
      expect(message).toMatch(
        /referenced workflow "piorx\/workflow\/ref-target@1" operating_mode "constrained-autonomous" exceeds parent's "supervised-change"/,
      );
    }
  });

  test('workflow_ref to a referenced workflow that drops parent mandatory_controls is rejected', () => {
    const referenced = buildReferencedWorkflow({
      mandatory_controls: ['intent.approval'], // drops execution.allow_edits
    });
    const host = buildHostSpecWithWorkflowRef(referenced.id);
    const registry = setupRefTestRegistry({ host, referenced });
    try {
      registry.validate();
      throw new Error('expected validate() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowRegistryError);
      const message = (err as WorkflowRegistryError).message;
      expect(message).toMatch(
        /referenced workflow "piorx\/workflow\/ref-target@1" drops parent mandatory_control "execution.allow_edits"/,
      );
    }
  });

  test('workflow_ref to a referenced workflow with same operating_mode and additive controls is accepted', () => {
    const referenced = buildReferencedWorkflow({
      operating_mode: 'supervised-change',
      mandatory_controls: ['intent.approval', 'execution.allow_edits', 'sub.extra'],
    });
    const host = buildHostSpecWithWorkflowRef(referenced.id);
    const registry = setupRefTestRegistry({ host, referenced });
    expect(() => registry.validate()).not.toThrow();
  });

  test('workflow_ref to a referenced workflow with lower operating_mode is accepted', () => {
    const referenced = buildReferencedWorkflow({
      operating_mode: 'advisory',
    });
    const host = buildHostSpecWithWorkflowRef(referenced.id);
    const registry = setupRefTestRegistry({ host, referenced });
    expect(() => registry.validate()).not.toThrow();
  });

  test('workflow_ref nested inside an inline workflow that targets an ancestor is rejected at validate()', () => {
    // Greptile-flagged mixed-mode cycle: top-level workflow A declares a
    // stage with an INLINE workflow B; B's stage declares `workflow_ref:
    // A`. The visited-set cycle guards on either form alone would miss
    // this — `checkSubWorkflows` doesn't look at workflow_ref entries,
    // and the top-level workflow_ref pass doesn't recurse into inline
    // blocks. The validator must walk the full spec tree.
    const referencedBackToHost = 'piorx/workflow/ref-host@1';
    const innerSub = buildSubWorkflow({
      id: 'piorx/workflow/inner-cycle@1',
      stages: [
        {
          id: 'inner.ref-back',
          name: 'inner ref back',
          description: 'inline-nested stage that workflow_refs an ancestor',
          inputs: ['piorx/evidence-bundle@1'],
          output: 'piorx/analysis-report@1',
          model_class: 'llm',
          workflow_ref: referencedBackToHost,
        },
      ],
      recursive_promotion_target: 'inner.ref-back',
    });
    // Build the host so it (a) inlines `innerSub` on a stage and (b) is
    // registered under the id `innerSub`'s ref points back at.
    const base = loadDefaultWorkflow();
    const host: WorkflowSpecV1 = {
      ...base,
      id: referencedBackToHost,
      artifact_id: `${base.artifact_id}-inline-cycle-host`,
      stages: base.stages.map((s) => (s.id === 'synthesis' ? { ...s, workflow: innerSub } : s)),
    };
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(host);
    // Register the bare stages the host's non-inlined stages still need
    // for `checkWorkflowReferences` to reach the inline tree-walk pass.
    registerDefaultStages(registry);
    registerAllDefaultGates(registry);
    try {
      registry.validate();
      throw new Error('expected validate() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowRegistryError);
      const message = (err as WorkflowRegistryError).message;
      expect(message).toMatch(/workflow_ref cycle detected/);
      expect(message).toMatch(/piorx\/workflow\/ref-host@1/);
    }
  });

  test('workflow_ref cycle (mutual cross-reference) is rejected at validate()', () => {
    // Two registered workflows whose `workflow_ref` stages point at each
    // other pass every other check but would stack-overflow the executor
    // in `runSubWorkflowStage → runSpec → runSubWorkflowStage` if descent
    // were permitted at runtime. Inline `workflow:` blocks get this
    // visited-set guard via `checkSubWorkflows`; `workflow_ref` needs the
    // equivalent at boot or the runtime can never trust the spec graph.
    const referenced = buildReferencedWorkflow({
      // The referenced workflow's sub.dummy stage references back at the
      // host, closing the cycle.
      stages: [
        {
          id: 'sub.dummy',
          name: 'dummy',
          description: 'placeholder sub stage that loops back',
          inputs: ['piorx/evidence-bundle@1'],
          output: 'piorx/analysis-report@1',
          model_class: 'llm',
          gates: ['intent.approval', 'execution.allow_edits'],
          workflow_ref: 'piorx/workflow/ref-host@1',
        },
      ],
    });
    const host = buildHostSpecWithWorkflowRef(referenced.id);
    const registry = setupRefTestRegistry({ host, referenced });
    try {
      registry.validate();
      throw new Error('expected validate() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowRegistryError);
      const message = (err as WorkflowRegistryError).message;
      expect(message).toMatch(/workflow_ref cycle detected/);
      expect(message).toMatch(/piorx\/workflow\/ref-host@1/);
    }
  });
});
