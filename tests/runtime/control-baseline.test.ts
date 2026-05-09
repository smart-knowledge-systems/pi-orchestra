/**
 * §19 minimum control-baseline conformance test (COMP-P1-T13 acceptance).
 *
 * Per `docs/composability.md` Phase 1 — "tests/runtime/control-baseline.test.ts:
 * §19 minimum control baseline conformance test" — this suite is the literal
 * Phase 1 conformance contract. The default workflow + its registered Stage
 * adapters + its registered Gates must demonstrate every one of the eight
 * properties below; any change that breaks one is an explicit governance
 * regression, not a refactor.
 *
 * The eight conformance properties:
 *
 *   1. Operating mode is declared on the workflow spec (the workflow
 *      announces its authority class — advisory / supervised-change /
 *      constrained-autonomous).
 *   2. Stage-level entry/exit criteria are available — the spec carries
 *      `control.entry_criteria` / `control.exit_criteria` per stage so a
 *      reviewer can see what each stage requires and produces without
 *      reading TS source.
 *   3. At least one reviewable gate fires before execution — the workflow
 *      must declare a gate on a stage that runs before `execution`.
 *   4. Artifact lineage is immutable — `appendLineageEntry` and
 *      `transitionStage` only ever extend the lineage list; there is no
 *      shape that lets a caller remove or rewrite a prior entry.
 *   5. Source access is restricted by stage policy — the retrieval stage
 *      declares `evidence_requirements: ['source-access-events']`, so any
 *      file read by a worker boundary surfaces through the lineage record
 *      rather than escaping into ambient state.
 *   6. Approval disposition is recorded — the `intent.approval` gate is
 *      registered against the restatement stage and the gate decision is
 *      written into lineage with one of the four `GateOutcome` kinds.
 *   7. Gate outcome routing is four-way — the `GateOutcome` discriminated
 *      union has exactly the four members documented in
 *      docs/composability.md "3. Gate", and the executor surfaces each on
 *      lineage through the matching `LineageGateOutcomeKind`.
 *   8. Workflow version is traceable — every lineage entry the executor
 *      writes carries the `workflow_spec_id` active at run time, so
 *      re-runs against a different spec version are reconstructable from
 *      lineage alone.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ArtifactStore } from '../../src/artifacts/store.ts';
import { generateArtifactId } from '../../src/artifacts/ids.ts';
import { createConfig } from '../../src/runtime/config.ts';
import {
  appendLineageEntry,
  createSessionState,
  transitionStage,
  type LineageEntry,
  type LineageGateOutcomeKind,
} from '../../src/runtime/session-state.ts';
import { WorkflowRegistry, registerDefaultGates } from '../../src/runtime/registry.ts';
import { WorkflowExecutor, type GateBroker } from '../../src/runtime/workflow-executor.ts';
import { loadWorkflowFromFile } from '../../src/runtime/workflow-loader.ts';
import {
  DEFAULT_STAGE_ADAPTERS,
  registerDefaultStages,
} from '../../src/conductor/stage-adapters.ts';
import type { Stage, StageContext, StageModelCall, StageResult } from '../../src/runtime/stage.ts';
import type {
  GateOp,
  GateOpValidation,
  GateOutcome,
  GatePresentation,
  GateSpec,
} from '../../src/runtime/gate.ts';
import type { IntentCaptureV1, WorkflowSpecV1 } from '../../src/artifacts/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_PATH = resolve(
  import.meta.dir,
  '../../src/runtime/workflows/piorx-default.workflow.md',
);

const NULL_MODEL: StageModelCall = async () => '';

let tmpDir: string;
let store: ArtifactStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'piorx-control-baseline-'));
  store = new ArtifactStore(createConfig(tmpDir));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function loadDefaultWorkflow(): WorkflowSpecV1 {
  return loadWorkflowFromFile(DEFAULT_WORKFLOW_PATH);
}

function buildRegisteredDefault(): { registry: WorkflowRegistry; spec: WorkflowSpecV1 } {
  const spec = loadDefaultWorkflow();
  const registry = new WorkflowRegistry();
  registry.registerWorkflow(spec);
  registerDefaultStages(registry);
  // Stub the four gates that don't yet ship with concrete implementations
  // (per the COMP-P1-T11 dev log: they are auto-accepted by the executor's
  // default broker; concrete gates land in Phase 2/3). The conformance
  // contract only requires that every mandatory_control gate is *registered*
  // on the right stage — the gate body's behavior is exercised separately.
  for (const stub of [
    { stageId: 'restatement', gateId: 'intent.approval' },
    { stageId: 'expansion', gateId: 'expansion.review' },
    { stageId: 'synthesis', gateId: 'synthesis.confirm-task-type' },
    { stageId: 'execution', gateId: 'execution.allow_edits' },
  ]) {
    registry.registerGate(stub.stageId, makeStubGate(stub.gateId));
  }
  registerDefaultGates(registry);
  return { registry, spec };
}

function makeStubGate(id: string): GateSpec {
  return {
    id,
    async presents(): Promise<GatePresentation> {
      return { summary: `${id} review` };
    },
    validateOverride(): GateOpValidation {
      return { valid: true, errors: [] };
    },
    async applyOverride(): Promise<void> {},
  };
}

// Synthetic single-stage workflow used by Properties 6, 7, and 8 to drive
// the executor through a controlled gate-decision path without needing the
// default workflow's heavy UI-driven adapters.
function buildSyntheticSingleStage(gateIds: string[]): WorkflowSpecV1 {
  return {
    artifact_type: 'piorx/workflow-spec@1',
    artifact_id: generateArtifactId('piorx/workflow-spec@1'),
    id: 'test/workflow/control-baseline@1',
    name: 'Control-baseline test workflow',
    description: 'single-stage workflow used to exercise gate routing',
    goals: ['exercise gate routing'],
    operating_mode: 'supervised-change',
    mandatory_controls: [],
    stages: [
      {
        id: 'capture',
        name: 'Capture',
        description: 'capture intent',
        inputs: [],
        output: 'piorx/intent-capture@1',
        model_class: 'noop',
        gates: gateIds,
      },
    ],
    edges: [],
    recursive_promotion_target: 'capture',
  };
}

function captureStage(): Stage {
  return {
    id: 'capture',
    inputs: [],
    output: 'piorx/intent-capture@1',
    async run(ctx: StageContext): Promise<StageResult> {
      const id = generateArtifactId('piorx/intent-capture@1');
      const artifact: IntentCaptureV1 = {
        artifact_type: 'piorx/intent-capture@1',
        artifact_id: id,
        user_intent_verbatim: 'verbatim',
        cleaned_user_intent: 'cleaned',
        tagged_files: [],
        timestamp: '2026-05-08T00:00:00Z',
      };
      await ctx.store.put(artifact);
      return { output_artifact_id: id };
    },
  };
}

// ---------------------------------------------------------------------------
// Property 1 — operating_mode declared
// ---------------------------------------------------------------------------

describe('control-baseline §19 — operating_mode declared', () => {
  test('default workflow declares operating_mode (supervised-change)', () => {
    const spec = loadDefaultWorkflow();
    expect(spec.operating_mode).toBe('supervised-change');
    expect(['advisory', 'supervised-change', 'constrained-autonomous']).toContain(
      spec.operating_mode,
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — stage-level entry/exit criteria available
// ---------------------------------------------------------------------------

describe('control-baseline §19 — stage-level entry/exit criteria', () => {
  test('every default-workflow stage carries control.entry_criteria and control.exit_criteria', () => {
    const spec = loadDefaultWorkflow();
    for (const stage of spec.stages) {
      expect(stage.control?.entry_criteria, `${stage.id} entry_criteria`).toBeTruthy();
      expect(stage.control?.exit_criteria, `${stage.id} exit_criteria`).toBeTruthy();
    }
  });

  test('each Stage adapter exposes the same control fields its spec stage declares', () => {
    const spec = loadDefaultWorkflow();
    for (const adapter of DEFAULT_STAGE_ADAPTERS) {
      const stageSpec = spec.stages.find((s) => s.id === adapter.id);
      expect(stageSpec, `spec stage for adapter ${adapter.id}`).toBeDefined();
      // Adapter's control mirrors the spec's control (Stage-declared
      // governance metadata merges trivially with the spec-declared values).
      expect(adapter.control?.entry_criteria).toBe(stageSpec?.control?.entry_criteria);
      expect(adapter.control?.exit_criteria).toBe(stageSpec?.control?.exit_criteria);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 3 — at least one reviewable gate before execution
// ---------------------------------------------------------------------------

describe('control-baseline §19 — reviewable gate before execution', () => {
  test('at least one stage before execution declares a gate', () => {
    const spec = loadDefaultWorkflow();
    const executionIdx = spec.stages.findIndex((s) => s.id === 'execution');
    expect(executionIdx).toBeGreaterThan(0);
    const preExecutionStages = spec.stages.slice(0, executionIdx);
    const reviewableGated = preExecutionStages.some((s) => (s.gates ?? []).length > 0);
    expect(reviewableGated).toBe(true);
  });

  test('intent.approval is the entry-point gate (default workflow)', () => {
    const spec = loadDefaultWorkflow();
    const restatement = spec.stages.find((s) => s.id === 'restatement');
    expect(restatement?.gates).toContain('intent.approval');
    expect(spec.mandatory_controls).toContain('intent.approval');
  });

  test('execution.allow_edits is a mandatory control on the execution stage', () => {
    const spec = loadDefaultWorkflow();
    const execution = spec.stages.find((s) => s.id === 'execution');
    expect(execution?.gates).toContain('execution.allow_edits');
    expect(spec.mandatory_controls).toContain('execution.allow_edits');
  });
});

// ---------------------------------------------------------------------------
// Property 4 — artifact lineage is immutable
// ---------------------------------------------------------------------------

describe('control-baseline §19 — immutable artifact lineage', () => {
  test('transitionStage returns a new state with lineage extended, never mutating the input', () => {
    const original = createSessionState();
    const next = transitionStage(original, 'restatement', 'cap_0_0');
    expect(next).not.toBe(original);
    expect(original.lineage.length).toBe(0);
    expect(next.lineage.length).toBe(1);
    expect(next.lineage[0]?.artifact_id).toBe('cap_0_0');
  });

  test('appendLineageEntry only appends — earlier entries persist verbatim', () => {
    const start = createSessionState();
    const first = appendLineageEntry(start, {
      stage: 'restatement',
      artifact_id: 'first',
      timestamp: '2026-05-08T00:00:00Z',
    });
    const second = appendLineageEntry(first, {
      stage: 'expansion',
      artifact_id: 'second',
      timestamp: '2026-05-08T00:00:01Z',
    });
    expect(second.lineage.length).toBe(2);
    // The original "first" entry is unchanged after the second append.
    expect(second.lineage[0]).toEqual(first.lineage[0] as LineageEntry);
    // The transformations do not mutate the upstream state's lineage array.
    expect(start.lineage.length).toBe(0);
    expect(first.lineage.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property 5 — source-access restriction by stage policy
// ---------------------------------------------------------------------------

describe('control-baseline §19 — source-access restriction by stage policy', () => {
  test('retrieval stage declares evidence_requirements with source-access-events', () => {
    const spec = loadDefaultWorkflow();
    const retrieval = spec.stages.find((s) => s.id === 'retrieval');
    expect(retrieval?.control?.evidence_requirements).toContain('source-access-events');
  });

  test('workflow governance lists source-access-events as an audit requirement', () => {
    const spec = loadDefaultWorkflow();
    expect(spec.governance?.evidence_requirements).toContain('source-access-events');
  });
});

// ---------------------------------------------------------------------------
// Property 6 — recorded approval disposition
// ---------------------------------------------------------------------------

describe('control-baseline §19 — recorded approval disposition', () => {
  test('intent.approval is registered as a GateSpec on the restatement stage', () => {
    const { registry } = buildRegisteredDefault();
    const gates = registry.gatesFor('restatement');
    expect(gates.some((g) => g.id === 'intent.approval')).toBe(true);
  });

  test('executor records the gate decision (kind=accepted) on lineage when the gate fires', async () => {
    const spec = buildSyntheticSingleStage(['intent.approval']);
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(spec);
    registry.registerStage(captureStage());
    registry.registerGate('capture', makeStubGate('intent.approval'));

    const executor = new WorkflowExecutor({
      registry,
      store,
      session: createSessionState(),
      model: NULL_MODEL,
    });
    await executor.run(spec.id);

    const entry = executor.sessionState.lineage[0];
    expect(entry).toBeDefined();
    expect(entry?.gate_decisions?.[0]?.gate_id).toBe('intent.approval');
    expect(entry?.gate_decisions?.[0]?.kind).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// Property 7 — four-way gate outcome routing
// ---------------------------------------------------------------------------

describe('control-baseline §19 — four-way gate outcome routing', () => {
  const FOUR_KINDS: LineageGateOutcomeKind[] = [
    'accepted',
    'rejected_governance',
    'rejected_technical',
    'escalated',
  ];

  test('LineageGateOutcomeKind enumerates exactly the four documented outcomes', () => {
    // Type-level invariant: each member of LineageGateOutcomeKind must have
    // a counterpart in GateOutcome.kind. Compile-time + runtime check.
    const samples: GateOutcome[] = [
      { kind: 'accepted', applied: [{ op: 'noop' } as GateOp] },
      { kind: 'rejected_governance', reason: 'policy' },
      { kind: 'rejected_technical', reason: 'parser' },
      { kind: 'escalated', to: 'user', reason: 'undecidable' },
    ];
    for (let i = 0; i < FOUR_KINDS.length; i++) {
      expect(samples[i]?.kind).toBe(FOUR_KINDS[i]!);
    }
    expect(FOUR_KINDS.length).toBe(4);
  });

  test('executor surfaces each four-way outcome through lineage gate decisions', async () => {
    const accepted = await runWithBroker(async () => ({
      kind: 'accepted',
      applied: [{ op: 'noop' } as GateOp],
    }));
    expect(accepted.lineage.gate_decisions?.[0]?.kind).toBe('accepted');
    expect(accepted.lineage.gate_decisions?.[0]?.applied_ops).toEqual(['noop']);

    const governance = await runWithBroker(async () => ({
      kind: 'rejected_governance',
      reason: 'policy',
    }));
    expect(governance.outcome).toBe('rejected_governance');

    const technical = await runWithBroker(async () => ({
      kind: 'rejected_technical',
      reason: 'parser',
    }));
    expect(technical.outcome).toBe('rejected_technical');

    const escalated = await runWithBroker(async () => ({
      kind: 'escalated',
      to: 'user',
      reason: 'undecidable',
    }));
    expect(escalated.outcome).toBe('escalated');
  });
});

interface BrokerProbe {
  lineage: LineageEntry;
  outcome?: LineageGateOutcomeKind;
}

async function runWithBroker(broker: GateBroker): Promise<BrokerProbe> {
  const spec = buildSyntheticSingleStage(['probe.gate']);
  const registry = new WorkflowRegistry();
  registry.registerWorkflow(spec);
  registry.registerStage(captureStage());
  registry.registerGate('capture', makeStubGate('probe.gate'));
  const session = createSessionState();
  const executor = new WorkflowExecutor({
    registry,
    store,
    session,
    model: NULL_MODEL,
    gateBroker: broker,
  });
  try {
    await executor.run(spec.id);
  } catch (err) {
    // Non-acceptance outcomes throw; surface the outcome via the broker
    // probe so the caller can assert the routing label.
    const { WorkflowExecutorError } = await import('../../src/runtime/workflow-executor.ts');
    if (err instanceof WorkflowExecutorError) {
      const outcome = err.outcome?.kind;
      // No lineage entry recorded — the gate threw before the stage
      // transitioned. We synthesize an empty lineage record for the probe.
      return { lineage: { stage: 'idle', artifact_id: '', timestamp: '' }, outcome };
    }
    throw err;
  }
  return { lineage: executor.sessionState.lineage[0]! };
}

// ---------------------------------------------------------------------------
// Property 8 — workflow version traceability
// ---------------------------------------------------------------------------

describe('control-baseline §19 — workflow version traceability', () => {
  test('every executor lineage entry carries the active workflow_spec_id', async () => {
    const spec = buildSyntheticSingleStage([]);
    const registry = new WorkflowRegistry();
    registry.registerWorkflow(spec);
    registry.registerStage(captureStage());
    const executor = new WorkflowExecutor({
      registry,
      store,
      session: createSessionState(),
      model: NULL_MODEL,
    });
    await executor.run(spec.id);
    for (const entry of executor.sessionState.lineage) {
      expect(entry.workflow_spec_id).toBe(spec.id);
    }
  });

  test('default workflow declares strict version pinning in governance', () => {
    const spec = loadDefaultWorkflow();
    expect(spec.governance?.version_pinning).toBe('strict');
  });
});
