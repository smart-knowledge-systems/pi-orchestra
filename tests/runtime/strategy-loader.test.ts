/**
 * Strategy loader tests (COMP-P5-T2 acceptance).
 *
 * Covers the three Phase 5 acceptance criteria for filesystem strategy
 * discovery:
 *
 *   1. Strategies in `~/.config/piorx/strategies/` and `.piorx/strategies/`
 *      are discovered at boot.
 *   2. Project scope wins over user scope by name (first-name-wins,
 *      matching pi's tool / command resolution idiom).
 *   3. Strategy frontmatter is schema-validated; invalid strategies are
 *      rejected with a diagnostic rather than silently dropped.
 *
 * Plus the registry-side wiring in `discoverStrategiesAndRegister` so a
 * boot-time call discovers, registers, and surfaces diagnostics in one
 * pass.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkflowRegistry,
  WorkflowRegistryError,
  discoverStrategiesAndRegister,
} from '../../src/runtime/registry.ts';
import {
  STRATEGY_KIND,
  discoverStrategies,
  loadStrategyFromFile,
  parseStrategyMarkdown,
  type AdvisorStrategy,
} from '../../src/runtime/strategy-loader.ts';
import { createConfig } from '../../src/runtime/config.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface StrategyFixture {
  fileName: string;
  body: string;
}

function strategyFile(opts: {
  name: string;
  description?: string;
  applicableStages?: string[];
  applicablePhases?: string[];
  modelClass?: string;
  body?: string;
}): string {
  const lines: string[] = [
    '---',
    `kind: ${STRATEGY_KIND}`,
    `name: ${opts.name}`,
    `description: ${opts.description ?? 'A short description'}`,
  ];
  if (opts.applicableStages) {
    lines.push('applicable_stages:');
    for (const stage of opts.applicableStages) lines.push(`  - ${stage}`);
  }
  if (opts.applicablePhases) {
    lines.push('applicable_phases:');
    for (const phase of opts.applicablePhases) lines.push(`  - ${phase}`);
  }
  if (opts.modelClass) {
    lines.push(`model_class: ${opts.modelClass}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(opts.body ?? `# ${opts.name}\n\nStrategy body for ${opts.name}.`);
  return `${lines.join('\n')}\n`;
}

async function writeStrategyDir(baseDir: string, fixtures: StrategyFixture[]): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  for (const fixture of fixtures) {
    await writeFile(join(baseDir, fixture.fileName), fixture.body, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseStrategyMarkdown — frontmatter validation', () => {
  test('parses a complete strategy with all optional fields', () => {
    const text = strategyFile({
      name: 'rigorous-review',
      description: 'Slow, evidence-heavy review for synthesis',
      applicableStages: ['synthesis'],
      applicablePhases: ['synthesis'],
      modelClass: 'llm-with-advisor',
      body: '# Rigorous review\n\nWalk every claim against the evidence bundle.',
    });
    const strategy = parseStrategyMarkdown(text, '/strategies/rigorous-review.md', 'project');
    expect(strategy.name).toBe('rigorous-review');
    expect(strategy.kind).toBe(STRATEGY_KIND);
    expect(strategy.description).toBe('Slow, evidence-heavy review for synthesis');
    expect(strategy.applicable_stages).toEqual(['synthesis']);
    expect(strategy.applicable_phases).toEqual(['synthesis']);
    expect(strategy.model_class).toBe('llm-with-advisor');
    expect(strategy.body).toContain('Walk every claim');
    expect(strategy.source_path).toBe('/strategies/rigorous-review.md');
    expect(strategy.scope).toBe('project');
  });

  test('parses a minimal strategy (only required fields)', () => {
    const text = strategyFile({ name: 'fast', description: 'Quick path' });
    const strategy = parseStrategyMarkdown(text, '/strategies/fast.md', 'user');
    expect(strategy.name).toBe('fast');
    expect(strategy.applicable_stages).toBeUndefined();
    expect(strategy.applicable_phases).toBeUndefined();
    expect(strategy.model_class).toBeUndefined();
  });

  test('rejects missing kind discriminator', () => {
    const text = `---
name: bare
description: missing kind
---

body
`;
    expect(() => parseStrategyMarkdown(text, '/x.md', 'user')).toThrow(
      /expected kind "piorx\/advisor-strategy@1"/,
    );
  });

  test('rejects unknown kind discriminator', () => {
    const text = `---
kind: piorx/workflow-spec@1
name: misclassified
description: workflow spec, not a strategy
---

body
`;
    expect(() => parseStrategyMarkdown(text, '/x.md', 'user')).toThrow(
      /expected kind "piorx\/advisor-strategy@1"/,
    );
  });

  test('rejects missing name', () => {
    const text = `---
kind: ${STRATEGY_KIND}
description: no name
---

body
`;
    expect(() => parseStrategyMarkdown(text, '/x.md', 'user')).toThrow(/name is required/);
  });

  test('rejects empty description', () => {
    const text = `---
kind: ${STRATEGY_KIND}
name: empty
description: ''
---

body
`;
    expect(() => parseStrategyMarkdown(text, '/x.md', 'user')).toThrow(/description is required/);
  });

  test('rejects unknown frontmatter keys', () => {
    const text = `---
kind: ${STRATEGY_KIND}
name: novel
description: has an unknown key
mystery_field: oops
---

body
`;
    expect(() => parseStrategyMarkdown(text, '/x.md', 'user')).toThrow(
      /unknown frontmatter key "mystery_field"/,
    );
  });

  test('rejects missing leading frontmatter fence', () => {
    const text = `# Just a heading\n\nNo frontmatter here.\n`;
    expect(() => parseStrategyMarkdown(text, '/x.md', 'user')).toThrow(
      /missing leading "---" frontmatter fence/,
    );
  });

  test('rejects missing closing frontmatter fence', () => {
    const text = `---\nkind: ${STRATEGY_KIND}\nname: x\ndescription: y\n`;
    expect(() => parseStrategyMarkdown(text, '/x.md', 'user')).toThrow(
      /missing closing "---" frontmatter fence/,
    );
  });
});

describe('loadStrategyFromFile', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'piorx-strategy-load-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('reads and parses an on-disk strategy file', async () => {
    const path = join(tmp, 's.md');
    await writeFile(path, strategyFile({ name: 's', description: 'd' }), 'utf-8');
    const strategy = loadStrategyFromFile(path, 'project');
    expect(strategy.name).toBe('s');
    expect(strategy.source_path).toBe(path);
    expect(strategy.scope).toBe('project');
  });
});

describe('discoverStrategies — two-scope discovery', () => {
  let tmp: string;
  let projectDir: string;
  let userDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'piorx-strategy-discover-'));
    projectDir = join(tmp, 'project', '.piorx', 'strategies');
    userDir = join(tmp, 'user', '.config', 'piorx', 'strategies');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('discovers strategies from both scopes', async () => {
    await writeStrategyDir(projectDir, [
      { fileName: 'p1.md', body: strategyFile({ name: 'p1', description: 'project one' }) },
    ]);
    await writeStrategyDir(userDir, [
      { fileName: 'u1.md', body: strategyFile({ name: 'u1', description: 'user one' }) },
    ]);
    const config = createConfig(join(tmp, 'project'));
    const result = discoverStrategies(config, { projectDir, userDir });
    expect(result.diagnostics).toHaveLength(0);
    expect(result.strategies.map((s) => s.name).sort()).toEqual(['p1', 'u1']);
    const byName = new Map(result.strategies.map((s) => [s.name, s] as const));
    expect(byName.get('p1')?.scope).toBe('project');
    expect(byName.get('u1')?.scope).toBe('user');
  });

  test('project scope wins over user scope on name conflict', async () => {
    await writeStrategyDir(projectDir, [
      {
        fileName: 'shared.md',
        body: strategyFile({ name: 'shared', description: 'project version' }),
      },
    ]);
    await writeStrategyDir(userDir, [
      {
        fileName: 'shared.md',
        body: strategyFile({ name: 'shared', description: 'user version' }),
      },
    ]);
    const config = createConfig(join(tmp, 'project'));
    const result = discoverStrategies(config, { projectDir, userDir });
    expect(result.strategies).toHaveLength(1);
    const winner = result.strategies[0]!;
    expect(winner.scope).toBe('project');
    expect(winner.description).toBe('project version');
    expect(result.diagnostics).toHaveLength(1);
    const shadowDiag = result.diagnostics[0]!;
    expect(shadowDiag.scope).toBe('user');
    expect(shadowDiag.message).toContain('shadowed by project-scope file');
  });

  test('invalid strategies surface as diagnostics, valid ones still load', async () => {
    await writeStrategyDir(projectDir, [
      { fileName: 'good.md', body: strategyFile({ name: 'good', description: 'fine' }) },
      { fileName: 'bad.md', body: '# no frontmatter at all\n' },
    ]);
    const config = createConfig(join(tmp, 'project'));
    const result = discoverStrategies(config, { projectDir, userDir });
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]!.name).toBe('good');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.source_path).toContain('bad.md');
    expect(result.diagnostics[0]!.message).toContain('frontmatter');
  });

  test('missing scope directories are tolerated (no error)', () => {
    const config = createConfig(join(tmp, 'project'));
    const result = discoverStrategies(config, {
      projectDir: join(tmp, 'does-not-exist-project'),
      userDir: join(tmp, 'does-not-exist-user'),
    });
    expect(result.strategies).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('non-markdown files in the directory are ignored', async () => {
    await writeStrategyDir(projectDir, [
      { fileName: 'real.md', body: strategyFile({ name: 'real', description: 'real' }) },
      { fileName: 'README.txt', body: 'not a strategy\n' },
      { fileName: 'config.json', body: '{}\n' },
    ]);
    const config = createConfig(join(tmp, 'project'));
    const result = discoverStrategies(config, { projectDir, userDir });
    expect(result.strategies.map((s) => s.name)).toEqual(['real']);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe('WorkflowRegistry — strategy registration', () => {
  test('registerStrategy + resolveStrategy round-trip', () => {
    const registry = new WorkflowRegistry();
    const strategy: AdvisorStrategy = Object.freeze({
      name: 'one',
      kind: STRATEGY_KIND,
      description: 'desc',
      body: 'body',
      source_path: '/x/one.md',
      scope: 'project',
    });
    registry.registerStrategy(strategy);
    expect(registry.resolveStrategy('one')).toBe(strategy);
    expect(registry.resolveStrategy('two')).toBeUndefined();
    expect(registry.listStrategies().map((s) => s.name)).toEqual(['one']);
  });

  test('registerStrategy rejects duplicate name with WorkflowRegistryError', () => {
    const registry = new WorkflowRegistry();
    const a: AdvisorStrategy = Object.freeze({
      name: 'dup',
      kind: STRATEGY_KIND,
      description: 'a',
      body: '',
      source_path: '/p/a.md',
      scope: 'project',
    });
    const b: AdvisorStrategy = Object.freeze({
      name: 'dup',
      kind: STRATEGY_KIND,
      description: 'b',
      body: '',
      source_path: '/u/b.md',
      scope: 'user',
    });
    registry.registerStrategy(a);
    expect(() => registry.registerStrategy(b)).toThrow(WorkflowRegistryError);
    try {
      registry.registerStrategy(b);
    } catch (err) {
      const error = err as WorkflowRegistryError;
      expect(error.violations[0]).toContain('already registered');
      expect(error.violations[0]).toContain('/p/a.md');
      expect(error.violations[0]).toContain('/u/b.md');
    }
  });
});

describe('discoverStrategiesAndRegister — boot-time integration', () => {
  let tmp: string;
  let projectDir: string;
  let userDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'piorx-strategy-boot-'));
    projectDir = join(tmp, 'project', '.piorx', 'strategies');
    userDir = join(tmp, 'user', '.config', 'piorx', 'strategies');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('registers every valid strategy and propagates diagnostics from invalid ones', async () => {
    await writeStrategyDir(projectDir, [
      {
        fileName: 'careful.md',
        body: strategyFile({
          name: 'careful',
          description: 'project-scope strategy',
          applicableStages: ['synthesis'],
        }),
      },
      { fileName: 'broken.md', body: '---\nname: x\n' }, // missing closing fence
    ]);
    await writeStrategyDir(userDir, [
      { fileName: 'fast.md', body: strategyFile({ name: 'fast', description: 'user fast' }) },
    ]);

    const config = createConfig(join(tmp, 'project'));
    const registry = new WorkflowRegistry();
    const result = discoverStrategiesAndRegister(registry, config, {
      projectDir,
      userDir,
    });

    expect(result.registered.map((s) => s.name).sort()).toEqual(['careful', 'fast']);
    expect(registry.resolveStrategy('careful')?.scope).toBe('project');
    expect(registry.resolveStrategy('fast')?.scope).toBe('user');
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    const brokenDiag = result.diagnostics.find((d) => d.source_path.endsWith('broken.md'));
    expect(brokenDiag).toBeDefined();
    expect(brokenDiag?.message).toContain('frontmatter');
  });

  test('project-scope shadowing yields one registered strategy and one diagnostic', async () => {
    await writeStrategyDir(projectDir, [
      {
        fileName: 'shared.md',
        body: strategyFile({ name: 'shared', description: 'project edition' }),
      },
    ]);
    await writeStrategyDir(userDir, [
      {
        fileName: 'shared.md',
        body: strategyFile({ name: 'shared', description: 'user edition' }),
      },
    ]);
    const config = createConfig(join(tmp, 'project'));
    const registry = new WorkflowRegistry();
    const result = discoverStrategiesAndRegister(registry, config, {
      projectDir,
      userDir,
    });
    expect(result.registered).toHaveLength(1);
    expect(registry.resolveStrategy('shared')?.scope).toBe('project');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.scope).toBe('user');
    expect(result.diagnostics[0]!.message).toContain('shadowed');
  });

  test('a programmatic register before discovery surfaces a diagnostic for the colliding file', async () => {
    await writeStrategyDir(projectDir, [
      { fileName: 'pre.md', body: strategyFile({ name: 'pre', description: 'on disk' }) },
    ]);
    const config = createConfig(join(tmp, 'project'));
    const registry = new WorkflowRegistry();
    registry.registerStrategy(
      Object.freeze({
        name: 'pre',
        kind: STRATEGY_KIND,
        description: 'programmatic',
        body: '',
        source_path: '<programmatic>',
        scope: 'project',
      }),
    );
    const result = discoverStrategiesAndRegister(registry, config, {
      projectDir,
      userDir,
    });
    expect(result.registered).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.source_path).toContain('pre.md');
  });
});
