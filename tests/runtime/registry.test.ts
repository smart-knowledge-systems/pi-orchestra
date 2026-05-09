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
