/**
 * Phase model configuration tests (COMP-P2-T1 acceptance).
 *
 * The runtime config gains a `models` block keyed by phase id; the
 * validator refuses non-canonical executor/advisor pairs by default
 * (advisor doc §3.2 + §4.1 — "API matrix is the authority").
 */

import { describe, expect, test } from 'bun:test';
import {
  CANONICAL_ADVISOR_PAIRS,
  type PhaseModelConfigs,
  isCanonicalAdvisorPair,
  resolvePhaseModelConfig,
  validatePhaseModelConfigs,
} from '../../src/runtime/config.ts';

describe('validatePhaseModelConfigs', () => {
  test('accepts an empty / undefined block', () => {
    expect(validatePhaseModelConfigs(undefined)).toEqual({ ok: true, errors: [] });
    expect(validatePhaseModelConfigs({})).toEqual({ ok: true, errors: [] });
  });

  test('accepts an executor-only block (advisor.mode defaults to none)', () => {
    const configs: PhaseModelConfigs = {
      restatement: { executor: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
      synthesis: { executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
    };
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(true);
  });

  test('accepts every documented canonical executor/advisor pair', () => {
    for (const pair of CANONICAL_ADVISOR_PAIRS) {
      const configs: PhaseModelConfigs = {
        synthesis: {
          executor: { provider: 'anthropic', model: `claude-${pair.executor}` },
          advisor: { mode: 'custom', model: `claude-${pair.advisor}` },
        },
      };
      const result = validatePhaseModelConfigs(configs);
      expect(result.ok).toBe(true);
    }
  });

  test('rejects a non-canonical executor/advisor pair by default', () => {
    const configs: PhaseModelConfigs = {
      synthesis: {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'custom', model: 'claude-sonnet-4-6' },
      },
    };
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/non-canonical executor\/advisor pair/);
  });

  test('accepts a non-canonical pair when allowNonCanonicalPair is true', () => {
    const configs: PhaseModelConfigs = {
      synthesis: {
        executor: { provider: 'openai', model: 'gpt-5-4' },
        advisor: { mode: 'custom', model: 'claude-opus-4-7' },
        allowNonCanonicalPair: true,
      },
    };
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(true);
  });

  test('rejects when an executor field is missing', () => {
    const configs = {
      synthesis: {
        executor: { provider: '', model: 'claude-sonnet-4-6' },
      },
    } as unknown as PhaseModelConfigs;
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/executor\.provider and executor\.model are required/);
  });

  test('rejects an enabled advisor without a model', () => {
    const configs: PhaseModelConfigs = {
      synthesis: {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'custom' },
      },
    };
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/advisor\.model is required/);
  });

  test('rejects a non-positive advisor.maxUses', () => {
    const configs: PhaseModelConfigs = {
      synthesis: {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'custom', model: 'claude-opus-4-7', maxUses: 0 },
      },
    };
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/advisor\.maxUses must be a positive integer/);
  });

  test('rejects an unsupported advisor.caching value', () => {
    const configs = {
      synthesis: {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'custom', model: 'claude-opus-4-7', caching: 'permanent' },
      },
    } as unknown as PhaseModelConfigs;
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/advisor\.caching must be/);
  });

  test('models block can declare an executor for every default-pipeline phase', () => {
    const configs: PhaseModelConfigs = {
      restatement: { executor: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
      expansion: { executor: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
      retrieval: {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'custom', model: 'claude-opus-4-7' },
      },
      synthesis: {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'custom', model: 'claude-opus-4-7' },
      },
      execution: {
        executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        advisor: { mode: 'custom', model: 'claude-opus-4-7' },
      },
    };
    const result = validatePhaseModelConfigs(configs);
    expect(result.ok).toBe(true);
  });
});

describe('isCanonicalAdvisorPair', () => {
  test('matches dated / provider-prefixed model ids via substring', () => {
    expect(isCanonicalAdvisorPair('claude-haiku-4-5-20251001', 'claude-opus-4-7')).toBe(true);
    expect(isCanonicalAdvisorPair('anthropic/claude-sonnet-4-6', 'claude-opus-4-7-20260101')).toBe(
      true,
    );
  });

  test('rejects pairs with the wrong advisor', () => {
    expect(isCanonicalAdvisorPair('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBe(false);
    expect(isCanonicalAdvisorPair('claude-haiku-4-5', 'gpt-5-4')).toBe(false);
  });
});

describe('resolvePhaseModelConfig', () => {
  test('returns the configured per-phase entry, undefined when missing', () => {
    const config = {
      repoRoot: '/tmp/repo',
      piDir: '/tmp/repo/.pi',
      artifactsDir: '/tmp/repo/.pi/artifacts',
      sessionStatePath: '/tmp/repo/.pi/session-state.json',
      models: {
        synthesis: {
          executor: { provider: 'anthropic', model: 'claude-sonnet-4-6' } as const,
        },
      },
    };
    expect(resolvePhaseModelConfig(config, 'synthesis')?.executor.model).toBe('claude-sonnet-4-6');
    expect(resolvePhaseModelConfig(config, 'execution')).toBeUndefined();
  });
});
