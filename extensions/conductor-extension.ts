/**
 * Conductor extension entrypoint.
 *
 * Bootstraps the pi-orchestra runtime and routes user intent into the
 * default workflow runner (`src/conductor/default-pipeline.ts`). The
 * extension is intentionally thin: per `docs/composability.md` "Phase 1 —
 * Refactor", the inline six-stage pipeline that lived here previously has
 * been replaced by a single call into the workflow executor over the
 * loaded `piorx/workflow/default@1` spec. Per-stage UI flows live on the
 * stage adapters; orchestration follows the spec's edges.
 *
 * The conductor still does not read raw repo files directly. Raw file
 * access, when needed, happens inside deterministic runtime services such
 * as retrieval and evidence assembly.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { complete, type UserMessage } from '@mariozechner/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { runDefaultPipeline } from '../src/conductor/default-pipeline.ts';
import { StageMachine } from '../src/conductor/stage-machine.ts';
import {
  createConfig,
  resolvePhaseModelConfig,
  type PhaseExecutor,
  type PiOrchestraConfig,
  type PipelinePhaseId,
} from '../src/runtime/config.ts';
import type { AgentModelCallback } from '../src/retriever/agent-types.ts';

type OrchestraRuntime = {
  config: PiOrchestraConfig;
  store: ArtifactStore;
  machineReady: Promise<StageMachine>;
  bootedAt: string;
  logPath: string;
};

const runtime = createRuntime(process.cwd());

function createRuntime(repoRoot: string): OrchestraRuntime {
  const config = createConfig(repoRoot);
  return {
    config,
    store: new ArtifactStore(config),
    machineReady: StageMachine.init(config),
    bootedAt: new Date().toISOString(),
    logPath: resolve(config.piDir, 'orchestra.log'),
  };
}

async function logEvent(message: string, details?: unknown): Promise<void> {
  const payload =
    details && typeof details === 'object'
      ? { ts: new Date().toISOString(), message, ...(details as Record<string, unknown>) }
      : { ts: new Date().toISOString(), message, details };
  const line = JSON.stringify(payload);
  await mkdir(dirname(runtime.logPath), { recursive: true });
  await appendFile(runtime.logPath, `${line}\n`, 'utf-8');
}

async function getMachine(): Promise<StageMachine> {
  return runtime.machineReady;
}

/**
 * Tracks which phases have already received a `ctx.model` deprecation
 * warning so the log is informative once per process lifetime per phase
 * rather than on every model call.
 */
const ctxModelDeprecationWarned = new Set<string>();

/**
 * Resolve the executor `Model<Api>` for the given phase.
 *
 * Per `docs/composability.md` "Phase 2 — `getModelText` takes a phase
 * parameter", we look up `runtime.config.models[phase].executor` first.
 * When no per-phase executor is configured (or the phase is omitted), we
 * fall back to `ctx.model` and emit a deprecation warning the first time
 * each phase trips the fallback path. The fallback is documented as
 * intentionally surviving "one minor version" so existing hosts keep
 * working while they migrate to per-phase configuration.
 */
type ResolvedModel = NonNullable<ExtensionContext['model']>;

function resolveExecutorModel(
  ctx: ExtensionContext,
  phase: PipelinePhaseId | string | undefined,
): ResolvedModel {
  if (phase) {
    const phaseConfig = resolvePhaseModelConfig(runtime.config, phase as PipelinePhaseId);
    const executor: PhaseExecutor | undefined = phaseConfig?.executor;
    if (executor) {
      const found = ctx.modelRegistry.find(executor.provider, executor.model);
      if (found) return found;
      throw new Error(
        `Conductor model call: phase "${phase}" requested executor ` +
          `${executor.provider}/${executor.model} but the model registry does not know it`,
      );
    }
  }

  if (!ctx.model) {
    throw new Error('No model selected for conductor model call');
  }

  const fallbackKey = phase ?? '__no_phase__';
  if (!ctxModelDeprecationWarned.has(fallbackKey)) {
    ctxModelDeprecationWarned.add(fallbackKey);
    const detail = phase
      ? `phase "${phase}" has no models[${phase}].executor entry`
      : 'caller did not pass a phase id';
    void logEvent('runtime.ctx_model_deprecated', {
      phase: phase ?? null,
      detail,
      message:
        `[piorx] ctx.model fallback used for ${detail}; ` +
        `populate runtime.config.models[<phase>].executor (Phase 2). ` +
        `This fallback survives one minor version per docs/composability.md.`,
    });
  }
  return ctx.model;
}

async function getModelText(
  systemPrompt: string,
  userText: string,
  ctx: ExtensionContext,
  phase?: PipelinePhaseId | string,
) {
  const model = resolveExecutorModel(ctx, phase);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }

  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: userText }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    {
      systemPrompt,
      messages: [userMessage],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
    },
  );

  if (response.stopReason === 'aborted') {
    throw new Error('Conductor model call was aborted');
  }

  const text = response.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Conductor model call returned empty text');
  }

  return text;
}

/**
 * Model callback injected into the retriever agent loop. The callback lives
 * at the extension edge so `src/retriever/**` never imports pi host APIs.
 *
 * Pinned to `'retrieval'` per COMP-P2-T3 so the runtime resolves the
 * configured retrieval executor (and emits the deprecation warning when no
 * `models.retrieval.executor` is configured) instead of silently using
 * `ctx.model`.
 */
function makeRetrieverAgentModel(ctx: ExtensionContext): AgentModelCallback {
  return async ({ systemPrompt, userPrompt }) =>
    getModelText(systemPrompt, userPrompt, ctx, 'retrieval');
}

/**
 * Bridge from pi's `ExtensionContext.ui` to the slim `PipelineUI` shape the
 * stage adapters consume. Keeps the pipeline runner free of pi host types
 * while preserving the same UI semantics.
 */
function makePipelineUI(ctx: ExtensionContext) {
  return {
    confirm: (title: string, message: string) => ctx.ui.confirm(title, message),
    input: (title: string, placeholder?: string) => ctx.ui.input(title, placeholder),
    notify: (message: string, level: 'info' | 'warning' | 'error' = 'info') =>
      ctx.ui.notify(message, level),
    setStatus: (key: string, text: string | undefined) => ctx.ui.setStatus(key, text),
  };
}

async function runPipelineFromIntent(initialIntent: string, ctx: ExtensionContext): Promise<void> {
  const machine = await getMachine();
  if (!ctx.hasUI) {
    return;
  }
  if (machine.currentStage !== 'idle') {
    throw new Error(`Pipeline can only start from idle, got ${machine.currentStage}`);
  }
  await runDefaultPipeline({
    initialIntent,
    store: runtime.store,
    config: runtime.config,
    ui: makePipelineUI(ctx),
    logEvent,
    getModelText: (systemPrompt, userText, phase) =>
      getModelText(systemPrompt, userText, ctx, phase),
    retrieverAgentModel: makeRetrieverAgentModel(ctx),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  // Refresh the host's stage-machine snapshot so subsequent
  // `currentStage` reads reflect the executor's session-state writes.
  runtime.machineReady = StageMachine.init(runtime.config);
  const refreshed = await runtime.machineReady;
  ctx.ui.setStatus('orchestra', `stage=${refreshed.currentStage}`);
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    try {
      const machine = await getMachine();
      await logEvent('session_start', {
        reason: event.reason,
        repoRoot: runtime.config.repoRoot,
        currentStage: machine.currentStage,
      });
      if (ctx.hasUI) {
        ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
        ctx.ui.notify(
          `pi-orchestra loaded (${event.reason}) from ${runtime.config.repoRoot}`,
          'info',
        );
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.setStatus('orchestra', 'boot-error');
        ctx.ui.notify(
          `pi-orchestra failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    }
  });

  pi.registerCommand('orchestra-status', {
    description: 'Show pi-orchestra runtime and stage status',
    handler: async (_args, ctx) => {
      try {
        const machine = await getMachine();
        const lines = [
          'pi-orchestra status',
          `repoRoot: ${runtime.config.repoRoot}`,
          `piDir: ${runtime.config.piDir}`,
          `bootedAt: ${runtime.bootedAt}`,
          `currentStage: ${machine.currentStage}`,
          `sessionStatePath: ${runtime.config.sessionStatePath}`,
          `logPath: ${runtime.logPath}`,
        ];
        ctx.ui.notify(lines.join('\n'), 'info');
      } catch (error) {
        ctx.ui.notify(
          `pi-orchestra status unavailable: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('orchestra-log', {
    description: 'Show pi-orchestra log path',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pi-orchestra log: ${runtime.logPath}`, 'info');
    },
  });

  pi.registerCommand('orchestra-reset', {
    description: 'Reset pi-orchestra session state back to idle',
    handler: async (_args, ctx) => {
      const machine = await getMachine();
      await machine.reset();
      if (ctx.hasUI) {
        ctx.ui.setStatus('orchestra', `stage=${machine.currentStage}`);
      }
      ctx.ui.notify('pi-orchestra session state reset to idle', 'info');
    },
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') {
      return { action: 'continue' };
    }

    const text = event.text.trim();
    if (!text || text.startsWith('/')) {
      return { action: 'continue' };
    }

    try {
      const machine = await getMachine();
      await logEvent('input.received', {
        source: event.source,
        text,
        currentStage: machine.currentStage,
      });

      if (machine.currentStage !== 'idle') {
        await logEvent('input.passthrough', {
          reason: 'non-idle-stage',
          currentStage: machine.currentStage,
        });
        return { action: 'continue' };
      }

      await runPipelineFromIntent(text, ctx);
      return { action: 'handled' };
    } catch (error) {
      await logEvent('pipeline.error', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-orchestra input interception failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
      return { action: 'continue' };
    }
  });
}
