/**
 * Runtime configuration for pi-orchestra.
 *
 * Provides the base directory for artifact storage and session state, plus
 * per-phase model + advisor configuration consumed by the workflow runtime
 * and `runWithAdvisor` (`src/runtime/run-with-advisor.ts`).
 *
 * Per docs/composability.md "Phase 2 — PhaseModelConfig + runWithAdvisor"
 * and docs/advisor-strategy-assessment.md §3.2/§4.1, every Stage declares
 * its phase id; the runtime resolves the executor (and optional advisor)
 * from `models[phase]`, replacing the legacy `ctx.model` bottleneck.
 */

import { resolve } from 'node:path';

export interface PiOrchestraConfig {
  /** Root of the target repository. */
  repoRoot: string;
  /** Base directory for all pi-orchestra data (default: <repoRoot>/.pi). */
  piDir: string;
  /** Directory for artifact JSON files. */
  artifactsDir: string;
  /** Path to the session state file. */
  sessionStatePath: string;
  /**
   * Per-phase model + advisor configuration. Optional so existing callers
   * that build a config via `createConfig(repoRoot)` continue to work
   * without supplying model wiring; the workflow runtime falls back to
   * `ctx.model` (with a deprecation warning) when a phase's executor is
   * unset.
   */
  models?: PhaseModelConfigs;
}

/**
 * Build a config rooted at the given repository path.
 *
 * All derived paths are deterministic from the repo root.
 */
export function createConfig(repoRoot: string): PiOrchestraConfig {
  const piDir = resolve(repoRoot, '.pi');
  const artifactsDir = resolve(piDir, 'artifacts');
  const sessionStatePath = resolve(piDir, 'session-state.json');
  return { repoRoot, piDir, artifactsDir, sessionStatePath };
}

// ---------------------------------------------------------------------------
// Phase model configuration — Phase 2 (advisor doc §7 Phase A).
// ---------------------------------------------------------------------------

/**
 * Default-pipeline phase ids that may carry a model configuration. Mirrors
 * the LLM-driven stages declared by `piorx-default.workflow.md`. The
 * deterministic stages (`evidence`) are intentionally omitted — their
 * implementations do not call the executor seam.
 */
export type PipelinePhaseId = 'restatement' | 'expansion' | 'retrieval' | 'synthesis' | 'execution';

/**
 * Advisor execution mode.
 *
 *   - `none`   — no advisor consultation; the executor runs solo.
 *   - `inline` — deterministic pre-call. The advisor is consulted before the
 *                executor and its plan is prepended to the user message.
 *   - `custom` — pi-ai tool-loop. Default in piorx today; preserves
 *                per-side-call billing through pi-ai's flat `Usage`.
 *   - `server` — Anthropic's `advisor_20260301` server tool. Behind the
 *                canonical-pair validator (Anthropic-only on both legs).
 */
export type AdvisorMode = 'none' | 'inline' | 'custom' | 'server';

/** Cache-retention strategy for the advisor side of the conversation. */
export type AdvisorCaching = 'ephemeral-5m' | 'ephemeral-1h' | null;

/**
 * Per-phase advisor configuration. `mode === 'none'` is the safe default
 * that preserves Phase 1 behaviour byte-identically.
 */
export interface AdvisorConfig {
  mode: AdvisorMode;
  /**
   * Advisor model id. Only consulted when `mode !== 'none'`. Validated
   * against the canonical executor/advisor pair matrix per §3.2 + §4.1
   * unless the executor enables `allowNonCanonicalPair`.
   */
  model?: string;
  /** Optional cap on advisor invocations per executor turn. */
  maxUses?: number;
  /**
   * Cache-control hint forwarded to the advisor leg of the conversation.
   * `null` (or omission) leaves caching unconfigured.
   */
  caching?: AdvisorCaching;
}

/**
 * Per-phase model configuration. The executor is resolved by piorx, not by
 * the host, so each Stage can declare its own (potentially distinct) model.
 */
export interface PhaseModelConfig {
  /** Required executor for the phase. */
  executor: PhaseExecutor;
  /** Optional advisor wiring; defaults to `{ mode: 'none' }` when unset. */
  advisor?: AdvisorConfig;
  /**
   * Escape hatch for off-matrix executor/advisor pairs. The validator
   * normally refuses pairs not listed in `CANONICAL_ADVISOR_PAIRS`; setting
   * this to `true` accepts the pair after the host has confirmed (via the
   * §10 probes) that the API will not 400. Logged in telemetry.
   */
  allowNonCanonicalPair?: boolean;
}

/**
 * Executor identity. Only the `provider` + `model` pair is load-bearing;
 * the remaining options (effort, thinking) are forwarded to the underlying
 * pi-ai call when supported by the provider.
 */
export interface PhaseExecutor {
  provider: string;
  model: string;
}

/** Lookup map of every default-pipeline phase to its model configuration. */
export type PhaseModelConfigs = Partial<Record<PipelinePhaseId, PhaseModelConfig>>;

// ---------------------------------------------------------------------------
// Validator — refuses non-canonical executor/advisor pairs by default.
// ---------------------------------------------------------------------------

/**
 * Canonical executor/advisor pair matrix. Sourced from the public Anthropic
 * docs (advisor doc §3.2): only Opus 4.7 is documented as advisor; the
 * executors are Haiku 4.5, Sonnet 4.6, Opus 4.6, and Opus 4.7. The
 * validator refuses any other pair unless `allowNonCanonicalPair` is set.
 *
 * Match keys are model-id substrings (lower-cased). Substring matching
 * tolerates provider-prefixed ids (e.g. `claude-haiku-4-5-20251001`).
 */
export const CANONICAL_ADVISOR_PAIRS: ReadonlyArray<{ executor: string; advisor: string }> = [
  { executor: 'haiku-4-5', advisor: 'opus-4-7' },
  { executor: 'sonnet-4-6', advisor: 'opus-4-7' },
  { executor: 'opus-4-6', advisor: 'opus-4-7' },
  { executor: 'opus-4-7', advisor: 'opus-4-7' },
];

/** Outcome of validating a `PhaseModelConfigs` block. */
export interface PhaseModelConfigValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a per-phase model configuration block.
 *
 * Rules:
 *   1. Every supplied phase must declare an `executor` with a non-empty
 *      `provider` and `model`.
 *   2. When `advisor.mode !== 'none'`, an advisor `model` must be declared.
 *   3. The executor + advisor pair must appear in `CANONICAL_ADVISOR_PAIRS`
 *      unless `allowNonCanonicalPair === true`.
 *   4. `advisor.maxUses`, when present, must be a positive integer.
 *   5. `advisor.caching`, when present, must be one of the documented
 *      retention strategies.
 *
 * Phases omitted from the block are skipped — the runtime resolves them
 * from `ctx.model` with a deprecation warning per COMP-P2-T3.
 */
export function validatePhaseModelConfigs(
  configs: PhaseModelConfigs | undefined,
): PhaseModelConfigValidation {
  const errors: string[] = [];
  if (!configs) return { ok: true, errors };

  for (const [phase, config] of Object.entries(configs)) {
    if (!config) continue;
    const executor = config.executor;
    if (!executor || !executor.provider?.trim() || !executor.model?.trim()) {
      errors.push(`models.${phase}: executor.provider and executor.model are required`);
      continue;
    }

    const advisor = config.advisor;
    if (!advisor || advisor.mode === 'none') continue;

    if (!advisor.model?.trim()) {
      errors.push(`models.${phase}: advisor.model is required when advisor.mode !== 'none'`);
      continue;
    }

    if (advisor.maxUses !== undefined) {
      if (!Number.isInteger(advisor.maxUses) || advisor.maxUses < 1) {
        errors.push(`models.${phase}: advisor.maxUses must be a positive integer`);
      }
    }

    if (advisor.caching !== undefined && advisor.caching !== null) {
      if (advisor.caching !== 'ephemeral-5m' && advisor.caching !== 'ephemeral-1h') {
        errors.push(
          `models.${phase}: advisor.caching must be 'ephemeral-5m' | 'ephemeral-1h' | null`,
        );
      }
    }

    if (!config.allowNonCanonicalPair && !isCanonicalAdvisorPair(executor.model, advisor.model)) {
      errors.push(
        `models.${phase}: non-canonical executor/advisor pair (${executor.model} / ${advisor.model}); ` +
          `set allowNonCanonicalPair=true after probing per advisor doc §10`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * True when the `executorModel` + `advisorModel` ids match a documented
 * canonical pair (per advisor doc §3.2). Substring match against the pair
 * matrix tolerates dated/provider-prefixed model ids.
 */
export function isCanonicalAdvisorPair(executorModel: string, advisorModel: string): boolean {
  const exec = executorModel.toLowerCase();
  const adv = advisorModel.toLowerCase();
  return CANONICAL_ADVISOR_PAIRS.some(
    (pair) => exec.includes(pair.executor) && adv.includes(pair.advisor),
  );
}

/**
 * Resolve the model configuration for a given phase. Returns `undefined`
 * when the phase is unconfigured — the runtime falls back to `ctx.model`
 * (with a deprecation warning) per COMP-P2-T3.
 */
export function resolvePhaseModelConfig(
  config: PiOrchestraConfig,
  phase: PipelinePhaseId,
): PhaseModelConfig | undefined {
  return config.models?.[phase];
}
