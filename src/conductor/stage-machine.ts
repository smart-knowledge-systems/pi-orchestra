/**
 * Minimal conductor stage-machine skeleton.
 *
 * Owns the current stage and provides transition helpers that enforce
 * valid stage ordering. Does NOT read raw repository files — the
 * conductor boundary is preserved by design.
 *
 * Full workflow logic (model calls, dispatches) is deferred to later phases.
 */

import type { PiOrchestraConfig } from '../runtime/config.ts';
import {
  type SessionState,
  type Stage,
  loadOrCreateSessionState,
  saveSessionState,
  transitionStage,
  setArtifactPointer,
  resetSession,
} from '../runtime/session-state.ts';

// ---------------------------------------------------------------------------
// Valid stage transitions
// ---------------------------------------------------------------------------

/**
 * Defines which stages can follow a given stage.
 *
 * The conductor may only move forward through the pipeline or reset
 * to idle (for recursive restarts).
 */
const VALID_TRANSITIONS: Record<Stage, readonly Stage[]> = {
  idle: ['restatement'],
  restatement: ['expansion', 'retrieval'],
  expansion: ['retrieval'],
  retrieval: ['evidence'],
  evidence: ['synthesis'],
  synthesis: ['execution', 'idle'],
  execution: ['idle'],
};

export class InvalidTransitionError extends Error {
  constructor(from: Stage, to: Stage) {
    super(`Invalid stage transition: "${from}" -> "${to}"`);
    this.name = 'InvalidTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Stage machine
// ---------------------------------------------------------------------------

export class StageMachine {
  private state: SessionState;

  private constructor(
    private readonly config: PiOrchestraConfig,
    state: SessionState,
  ) {
    this.state = state;
  }

  /** Initialize (or resume) the stage machine from persisted session state. */
  static async init(config: PiOrchestraConfig): Promise<StageMachine> {
    const state = await loadOrCreateSessionState(config);
    return new StageMachine(config, state);
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
    return VALID_TRANSITIONS[this.state.current_stage].includes(to);
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
