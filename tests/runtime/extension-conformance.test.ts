/**
 * Extension-conformance test (COMP-P1-T14 acceptance).
 *
 * Per `docs/composability.md` "Phase 1 — Scaffolding":
 *
 *   `tests/runtime/extension-conformance.test.ts` — verify a synthetic
 *   extension that attempts to (a) remove a `mandatory_controls` gate,
 *   (b) weaken a gate's outcome routing, or (c) overlap a stage id with
 *   weaker access policy is rejected at boot with a clear diagnostic.
 *
 * Each test below targets one of those three classes. The diagnostic
 * messages produced by `WorkflowRegistryError` must clearly identify which
 * rule the extension violated so an extension author can fix the offending
 * registration without reverse-engineering the registry.
 *
 * The registry is the load-bearing seam — `docs/composability.md` calls out
 * "platform policy prevails over workflow configuration on conflict" — so
 * these tests are the platform-policy integration contract, not redundant
 * coverage of `tests/runtime/registry.test.ts` (which covers the registry's
 * internal structure). They assert the extension-author-visible behavior:
 * what fails, and what the diagnostic says.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { WorkflowRegistry, WorkflowRegistryError } from '../../src/runtime/registry.ts';
import { loadWorkflowFromFile } from '../../src/runtime/workflow-loader.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import type { Stage, StageResult } from '../../src/runtime/stage.ts';
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

function buildExtension(parentId: string, overrides: Partial<WorkflowSpecV1>): WorkflowSpecV1 {
  const base = loadDefaultWorkflow();
  return {
    ...base,
    id: 'piorx/workflow/conformance-extension@1',
    artifact_id: generateArtifactId('piorx/workflow-spec@1'),
    extends: parentId,
    ...overrides,
  };
}

function expectViolations(fn: () => void, patterns: RegExp[]): WorkflowRegistryError {
  let caught: WorkflowRegistryError | undefined;
  try {
    fn();
  } catch (err) {
    caught = err as WorkflowRegistryError;
  }
  expect(caught).toBeInstanceOf(WorkflowRegistryError);
  if (!caught) throw new Error('unreachable');
  const messageBundle = `${caught.message}\n${caught.violations.join('\n')}`;
  for (const pattern of patterns) {
    expect(
      pattern.test(messageBundle),
      `expected diagnostic to match ${pattern}, got:\n${messageBundle}`,
    ).toBe(true);
  }
  return caught;
}

// ---------------------------------------------------------------------------
// (a) Extension removes a mandatory_controls gate
// ---------------------------------------------------------------------------

describe('extension-conformance — removing a mandatory_controls gate is rejected at boot', () => {
  test('extension that drops execution.allow_edits from mandatory_controls is rejected', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtension('piorx/workflow/default@1', {
      // intent.approval is kept; execution.allow_edits is removed.
      mandatory_controls: ['intent.approval'],
    });
    expectViolations(
      () => registry.registerWorkflow(child),
      [/removes parent mandatory_control/i, /execution\.allow_edits/],
    );
  });

  test('extension that drops intent.approval from mandatory_controls is rejected', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtension('piorx/workflow/default@1', {
      mandatory_controls: ['execution.allow_edits'],
    });
    expectViolations(
      () => registry.registerWorkflow(child),
      [/removes parent mandatory_control/i, /intent\.approval/],
    );
  });

  test('extension that drops the mandatory_control gate via stage_overrides is rejected', () => {
    // Different vector for the same class: the mandatory_controls list
    // stays intact, but the stage_overrides drops the gate from the
    // execution stage — that disconnects the mandatory control from any
    // declared stage and is the same governance violation.
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtension('piorx/workflow/default@1', {
      stage_overrides: {
        execution: {
          gates: [],
        },
      },
    });
    expectViolations(
      () => registry.registerWorkflow(child),
      [/drops parent gate/i, /execution\.allow_edits/],
    );
  });
});

// ---------------------------------------------------------------------------
// (b) Extension weakens a gate's outcome routing (failure_handling lenience)
// ---------------------------------------------------------------------------

describe('extension-conformance — weakening a gate outcome routing is rejected at boot', () => {
  test('extension that downgrades execution failure_handling halt → retry is rejected', () => {
    // The four-way GateOutcome routes through the stage's failure_handling:
    // `halt` is the strictest disposition (no retry, no continuation), and
    // weakening it to `retry` would silently re-attempt a governance
    // rejection — exactly what the design doc forbids
    // (docs/composability.md "3. Gate": governance rejections are never
    // silently retried).
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtension('piorx/workflow/default@1', {
      stage_overrides: {
        execution: {
          control: { failure_handling: 'retry' },
        },
      },
    });
    expectViolations(
      () => registry.registerWorkflow(child),
      [/weakens parent/i, /failure_handling/, /execution/],
    );
  });

  test('extension that downgrades restatement failure_handling halt → tentative is rejected', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtension('piorx/workflow/default@1', {
      stage_overrides: {
        restatement: {
          control: { failure_handling: 'tentative' },
        },
      },
    });
    expectViolations(() => registry.registerWorkflow(child), [/weakens parent/i, /restatement/]);
  });
});

// ---------------------------------------------------------------------------
// (c) Extension overlaps a stage id with weaker access policy
// ---------------------------------------------------------------------------

describe('extension-conformance — overlapping a stage id with weaker access policy is rejected', () => {
  test('Stage adapter re-registration with strictly weaker failure_handling is rejected at registerStage', () => {
    const registry = new WorkflowRegistry();
    // Register a strict adapter first.
    registry.registerStage({
      id: 'execution',
      inputs: ['piorx/change-spec@1'],
      output: 'piorx/execution-report@1',
      control: { failure_handling: 'halt' },
      async run(): Promise<StageResult> {
        return { output_artifact_id: 'noop' };
      },
    } as Stage);
    // Now an extension attempts to replace it with a weaker adapter that
    // would silently retry on failure — the registry rejects it at
    // registration time.
    let caught: WorkflowRegistryError | undefined;
    try {
      registry.registerStage({
        id: 'execution',
        inputs: ['piorx/change-spec@1'],
        output: 'piorx/execution-report@1',
        control: { failure_handling: 'retry' },
        async run(): Promise<StageResult> {
          return { output_artifact_id: 'noop' };
        },
      } as Stage);
    } catch (err) {
      caught = err as WorkflowRegistryError;
    }
    expect(caught).toBeInstanceOf(WorkflowRegistryError);
    expect(caught?.message ?? '').toMatch(/cannot replace with weaker/i);
    expect(caught?.message ?? '').toMatch(/execution/);
  });

  test('GateSpec re-registration with the same id on the same stage is rejected', () => {
    // The registry's gate-id uniqueness rule is the platform's defense
    // against an extension shadowing a parent's GateSpec with a weaker
    // implementation: there is no second registration that would let the
    // extension's gate run instead of the platform's.
    const registry = new WorkflowRegistry();
    registry.registerGate('execution', {
      id: 'execution.allow_edits',
      async presents() {
        return { summary: 'execution review' };
      },
      validateOverride() {
        return { valid: true, errors: [] };
      },
      async applyOverride() {},
    });
    let caught: WorkflowRegistryError | undefined;
    try {
      registry.registerGate('execution', {
        id: 'execution.allow_edits',
        async presents() {
          return { summary: 'extension override' };
        },
        validateOverride() {
          return { valid: true, errors: [] };
        },
        async applyOverride() {},
      });
    } catch (err) {
      caught = err as WorkflowRegistryError;
    }
    expect(caught).toBeInstanceOf(WorkflowRegistryError);
    expect(caught?.message ?? '').toMatch(/already registered/i);
    expect(caught?.message ?? '').toMatch(/execution\.allow_edits/);
  });

  test('extension that elevates operating_mode is rejected (authority cannot be smuggled upward)', () => {
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(loadDefaultWorkflow());
    const child = buildExtension('piorx/workflow/default@1', {
      operating_mode: 'constrained-autonomous',
    });
    expectViolations(
      () => registry.registerWorkflow(child),
      [/operating_mode/, /constrained-autonomous/],
    );
  });
});
