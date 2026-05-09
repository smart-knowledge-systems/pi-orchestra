/**
 * Minimal conductor stage-machine skeleton.
 *
 * Owns the current stage and provides transition helpers that enforce
 * valid stage ordering. Does NOT read raw repository files — the
 * conductor boundary is preserved by design.
 *
 * Transition validity is derived from the active workflow spec's edge
 * list (`docs/composability.md` "Phase 1 — Refactor": stage-machine
 * becomes a runtime validator over the loaded spec, not a hand-authored
 * whitelist). Adding an edge in the workflow markdown changes legal
 * transitions without code edits.
 */

import { resolve } from 'node:path';
import type { WorkflowSpecV1 } from '../artifacts/types.ts';
import type { PiOrchestraConfig } from '../runtime/config.ts';
import { loadWorkflowFromFile } from '../runtime/workflow-loader.ts';
import {
  STAGES,
  type SessionState,
  type Stage,
  loadOrCreateSessionState,
  saveSessionState,
  transitionStage,
  setArtifactPointer,
  resetSession,
} from '../runtime/session-state.ts';

// ---------------------------------------------------------------------------
// Workflow-spec-driven transition derivation
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_PATH = resolve(
  import.meta.dir,
  '../runtime/workflows/piorx-default.workflow.md',
);

const KNOWN_SESSION_STAGES = new Set<string>(STAGES);

let cachedDefaultSpec: WorkflowSpecV1 | undefined;

function loadDefaultWorkflowSpec(): WorkflowSpecV1 {
  if (!cachedDefaultSpec) {
    cachedDefaultSpec = loadWorkflowFromFile(DEFAULT_WORKFLOW_PATH);
  }
  return cachedDefaultSpec;
}

function isKnownSessionStage(id: string): id is Stage {
  return KNOWN_SESSION_STAGES.has(id);
}

/**
 * Build the legal-transition table for the loaded workflow spec.
 *
 * Rules:
 *   1. From `idle`, the workflow may enter the spec's first declared stage.
 *   2. Every spec edge contributes `transitions[edge.from] += edge.to`.
 *   3. Any stage whose outgoing edges are all conditional (or has no
 *      outgoing edges at all) may also fall through to `idle` — that
 *      models "workflow ends here" (e.g. synthesis producing an
 *      analysis-report, execution producing its report).
 *
 * Stages outside the session-state `Stage` enum are silently skipped so
 * an extension that introduces a non-default stage id (Phase 5
 * territory) does not break the session-state schema.
 */
export function deriveTransitionsFromWorkflowSpec(
  spec: WorkflowSpecV1,
): Record<Stage, readonly Stage[]> {
  const transitions: Record<Stage, Stage[]> = {
    idle: [],
    restatement: [],
    expansion: [],
    retrieval: [],
    evidence: [],
    synthesis: [],
    execution: [],
  };

  const firstStage = spec.stages[0]?.id;
  if (firstStage && isKnownSessionStage(firstStage)) {
    transitions.idle.push(firstStage);
  }

  for (const edge of spec.edges) {
    if (!isKnownSessionStage(edge.from) || !isKnownSessionStage(edge.to)) continue;
    if (!transitions[edge.from].includes(edge.to)) {
      transitions[edge.from].push(edge.to);
    }
  }

  for (const stageSpec of spec.stages) {
    if (!isKnownSessionStage(stageSpec.id)) continue;
    const outgoing = spec.edges.filter((e) => e.from === stageSpec.id);
    const hasUnconditional = outgoing.some((e) => !e.when || Object.keys(e.when).length === 0);
    if (!hasUnconditional && !transitions[stageSpec.id].includes('idle')) {
      transitions[stageSpec.id].push('idle');
    }
  }

  return transitions;
}

export class InvalidTransitionError extends Error {
  constructor(from: Stage, to: Stage) {
    super(`Invalid stage transition: "${from}" -> "${to}"`);
    this.name = 'InvalidTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Stage machine
// ---------------------------------------------------------------------------

export interface StageMachineInitOptions {
  /**
   * Workflow spec used to derive legal transitions. Defaults to the
   * shipped piorx default workflow markdown.
   */
  workflowSpec?: WorkflowSpecV1;
}

export class StageMachine {
  private state: SessionState;
  private readonly transitions: Record<Stage, readonly Stage[]>;

  private constructor(
    private readonly config: PiOrchestraConfig,
    state: SessionState,
    transitions: Record<Stage, readonly Stage[]>,
  ) {
    this.state = state;
    this.transitions = transitions;
  }

  /** Initialize (or resume) the stage machine from persisted session state. */
  static async init(
    config: PiOrchestraConfig,
    options: StageMachineInitOptions = {},
  ): Promise<StageMachine> {
    const state = await loadOrCreateSessionState(config);
    const spec = options.workflowSpec ?? loadDefaultWorkflowSpec();
    const transitions = deriveTransitionsFromWorkflowSpec(spec);
    return new StageMachine(config, state, transitions);
  }

  /** Return the current stage. */
  get currentStage(): Stage {
    return this.state.current_stage;
  }

  /** Return a readonly snapshot of the full session state. */
  get sessionState(): Readonly<SessionState> {
    return this.state;
  }

  /** Check whether a transition to the given stage is valid. */
  canTransition(to: Stage): boolean {
    return this.transitions[this.state.current_stage].includes(to);
  }

  /**
   * Transition to a new stage, optionally recording an artifact ID.
   *
   * Throws `InvalidTransitionError` if the transition is not allowed.
   * Persists the updated state to disk.
   */
  async transition(to: Stage, artifactId?: string): Promise<void> {
    if (!this.canTransition(to)) {
      throw new InvalidTransitionError(this.state.current_stage, to);
    }
    this.state = transitionStage(this.state, to, artifactId);
    await saveSessionState(this.config, this.state);
  }

  /**
   * Set an artifact pointer on the session state and persist.
   */
  async setArtifact(key: keyof SessionState['artifacts'], id: string): Promise<void> {
    this.state = setArtifactPointer(this.state, key, id);
    await saveSessionState(this.config, this.state);
  }

  /**
   * Reset the session for a recursive restart.
   *
   * Clears artifact pointers, moves to idle, preserves lineage.
   */
  async reset(): Promise<void> {
    this.state = resetSession(this.state);
    await saveSessionState(this.config, this.state);
  }
}
