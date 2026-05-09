/**
 * `runWithAdvisor` — three-mode advisor helper.
 *
 * Per `docs/composability.md` "Phase 2 — PhaseModelConfig + runWithAdvisor"
 * and `docs/advisor-strategy-assessment.md` §7 Phase B, this helper is the
 * single seam every advisor-aware phase calls. It dispatches into one of
 * three modes:
 *
 *   - **inline**  — deterministic pre-call. The advisor runs first, its
 *                   output is prepended to the user message, then the
 *                   executor runs once. Use when the advisor always helps
 *                   and there is no judgment about timing.
 *   - **custom**  — pi-ai tool-loop (the default in piorx today, per the
 *                   advisor doc §6). The executor sees an `advisor` tool;
 *                   when it calls the tool the helper issues a side call
 *                   to the advisor model and feeds the result back. Each
 *                   leg bills cleanly through pi-ai's flat `Usage`.
 *   - **server**  — Anthropic's `advisor_20260301` server tool. Behind the
 *                   canonical-pair validator and the `Anthropic-only` rule.
 *                   The executor splices the advisor block into its body
 *                   and the beta header into its request headers.
 *
 * All three modes produce a uniform `AdvisorTelemetry` record so cost-per-
 * task is reconstructable post-hoc from `.pi/orchestra.log`.
 *
 * Defense-in-depth, mirrored from Claude Code's own integration
 * (advisor doc §4.2, §4.3, §4.6):
 *
 *   1. Always send the `advisor-tool-2026-03-01` beta header on phases that
 *      touch shared history when advisor is enabled — even if this phase
 *      itself does not call the advisor — so message history containing
 *      prior `advisor_tool_result` blocks parses correctly.
 *   2. When the beta header is omitted, advisor blocks are stripped from
 *      the user message (no-op shape today; the seam is documented for
 *      Phase 3 callers that pass a structured message history).
 *   3. Honour `PIORX_DISABLE_ADVISOR=1` as a kill-switch — any non-empty
 *      truthy value forces advisor calls to be skipped and the executor to
 *      run solo, with telemetry recording `disabled_by_env: true`.
 *
 * The executor and advisor seams are abstracted as plain callbacks so
 * tests can run the helper without spinning up pi-ai. The Phase 3+
 * synthesis worker (per `docs/composability.md` "Phase 3") wires the
 * callbacks to pi-ai's `complete()` shape.
 */

import type { AdvisorMode, PhaseModelConfig, PipelinePhaseId } from './config.ts';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Beta header for the `advisor_20260301` server tool. */
export const ADVISOR_BETA_HEADER_NAME = 'anthropic-beta';
/** Beta header value (per advisor doc §3.3). */
export const ADVISOR_BETA_HEADER_VALUE = 'advisor-tool-2026-03-01';

/** Environment variable consulted as the Claude-Code-style kill switch. */
export const ADVISOR_DISABLE_ENV = 'PIORX_DISABLE_ADVISOR';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Per-iteration billing breakdown returned by the advisor leg of a turn.
 * Mirrors Anthropic's `usage.iterations[]` shape from advisor doc §3.4 so
 * post-hoc cost reconstruction is direct: rows with `type: 'advisor_message'`
 * count toward advisor totals; rows with `type: 'message'` count toward the
 * executor.
 */
export interface AdvisorIteration {
  type: 'message' | 'advisor_message';
  input_tokens: number;
  output_tokens: number;
}

/**
 * Uniform telemetry record. Identical shape across all three modes — that
 * uniformity is a load-bearing acceptance criterion of COMP-P2-T2 (the
 * eval harness joins on `phase` + executor model regardless of mode).
 *
 * `advisor_model` is `null` when no advisor was consulted (mode `'none'`
 * or kill-switch tripped). `error_code` carries the advisor doc §3.4 error
 * codes (`max_uses_exceeded`, `too_many_requests`, etc.) when the advisor
 * leg surfaced one; the executor's own errors propagate as thrown
 * exceptions outside this record.
 */
export interface AdvisorTelemetry {
  phase: PipelinePhaseId | string;
  mode: AdvisorMode;
  executor_model: string;
  executor_provider: string;
  advisor_model: string | null;
  advisor_iterations: number;
  advisor_input_tokens: number;
  advisor_output_tokens: number;
  executor_input_tokens: number;
  executor_output_tokens: number;
  duration_ms: number;
  beta_header_sent: boolean;
  disabled_by_env: boolean;
  error_code: string | null;
}

// ---------------------------------------------------------------------------
// Server-mode metadata
// ---------------------------------------------------------------------------

/**
 * Server-mode advisor tool block. Server-mode executors splice this into
 * their `tools[]` array via `StreamOptions.onPayload` (advisor doc §5.3).
 * The shape matches the wire-level format from §3.3 verbatim.
 */
export interface ServerAdvisorTool {
  type: 'advisor_20260301';
  name: 'advisor';
  model: string;
  max_uses?: number;
  caching?: { type: 'ephemeral'; ttl: '5m' | '1h' };
}

/**
 * Build the server-mode advisor tool block from a phase's advisor config.
 */
export function buildServerAdvisorTool(config: PhaseModelConfig): ServerAdvisorTool | null {
  const advisor = config.advisor;
  if (!advisor || advisor.mode !== 'server' || !advisor.model) return null;
  const tool: ServerAdvisorTool = {
    type: 'advisor_20260301',
    name: 'advisor',
    model: advisor.model,
    ...(advisor.maxUses !== undefined ? { max_uses: advisor.maxUses } : {}),
  };
  if (advisor.caching === 'ephemeral-5m') {
    tool.caching = { type: 'ephemeral', ttl: '5m' };
  } else if (advisor.caching === 'ephemeral-1h') {
    tool.caching = { type: 'ephemeral', ttl: '1h' };
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Executor / advisor seams
// ---------------------------------------------------------------------------

/**
 * Per-call extras handed to the executor by the helper. Mode-specific:
 *   - `serverAdvisor` is non-null only in `server` mode.
 *   - `customAdvisorHandler` is non-null only in `custom` mode.
 *   - `headers` includes the advisor beta header when shared-history
 *     phases need it OR when `server` mode is active.
 */
export interface ExecutorRequestExtras {
  serverAdvisor: ServerAdvisorTool | null;
  customAdvisorHandler: AdvisorCallback | null;
  headers: Record<string, string>;
}

export interface ExecutorRequest {
  systemPrompt: string;
  userMessage: string;
  extras: ExecutorRequestExtras;
}

/**
 * Executor's response. `iterations` is the full per-iteration billing
 * breakdown (server mode populates it with both executor and advisor rows;
 * custom mode populates the executor row and the helper appends advisor
 * rows from the side calls). `usage` is a fallback for executors that do
 * not surface iteration breakdowns.
 */
export interface ExecutorResponse {
  text: string;
  iterations?: AdvisorIteration[];
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Optional advisor error code surfaced by the server. */
  advisorErrorCode?: string;
}

export interface AdvisorRequest {
  systemPrompt: string;
  userMessage: string;
}

export interface AdvisorResponse {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Optional advisor error code (custom mode surfaces this directly). */
  errorCode?: string;
}

export type ExecutorCallback = (req: ExecutorRequest) => Promise<ExecutorResponse>;
export type AdvisorCallback = (req: AdvisorRequest) => Promise<AdvisorResponse>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunWithAdvisorRequest {
  systemPrompt: string;
  userMessage: string;
}

export interface RunWithAdvisorOptions {
  /** Phase id; used in telemetry. */
  phase: PipelinePhaseId | string;
  /** Phase model configuration (executor + optional advisor). */
  config: PhaseModelConfig;
  /** Required executor callback. */
  executor: ExecutorCallback;
  /** Required when `config.advisor.mode !== 'none'` and not `server`. */
  advisor?: AdvisorCallback;
  /**
   * True when this phase reads message history that may contain prior
   * `advisor_tool_result` blocks — forces the advisor beta header on the
   * outgoing executor request even when this phase itself does not call
   * the advisor (advisor doc §4.2).
   */
  sharedHistory?: boolean;
  /** Optional telemetry sink. Logged once per call. */
  logEvent?: (message: string, details?: unknown) => Promise<void> | void;
  /** Test seam: override `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: override `Date.now()`. */
  now?: () => number;
}

export interface RunWithAdvisorResult {
  text: string;
  iterations: AdvisorIteration[];
  telemetry: AdvisorTelemetry;
  disabledByEnv: boolean;
}

/**
 * Run an executor turn with optional advisor consultation. Returns the
 * executor's final text plus per-iteration billing telemetry.
 */
export async function runWithAdvisor(
  request: RunWithAdvisorRequest,
  options: RunWithAdvisorOptions,
): Promise<RunWithAdvisorResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const disabledByEnv = isAdvisorDisabledByEnv(env);

  const declaredMode = options.config.advisor?.mode ?? 'none';
  const effectiveMode: AdvisorMode = disabledByEnv ? 'none' : declaredMode;
  const advisorEnabled = effectiveMode !== 'none';

  const headers = buildHeaders(advisorEnabled, options.sharedHistory ?? false);
  const userMessage = stripAdvisorBlocksIfNeeded(request.userMessage, headers);

  let executorResponse: ExecutorResponse;
  const advisorIterations: AdvisorIteration[] = [];
  let advisorErrorCode: string | null = null;

  if (effectiveMode === 'inline') {
    const advisor = requireAdvisor(options, 'inline');
    const inlineResult = await runInlineMode(advisor, request.systemPrompt, userMessage);
    if (inlineResult.iteration) advisorIterations.push(inlineResult.iteration);
    if (inlineResult.errorCode) advisorErrorCode = inlineResult.errorCode;
    executorResponse = await options.executor({
      systemPrompt: request.systemPrompt,
      userMessage: inlineResult.userMessage,
      extras: {
        serverAdvisor: null,
        customAdvisorHandler: null,
        headers,
      },
    });
  } else if (effectiveMode === 'custom') {
    const advisor = requireAdvisor(options, 'custom');
    const wrapped = wrapAdvisorForTelemetry(advisor, advisorIterations, (code) => {
      advisorErrorCode = code;
    });
    executorResponse = await options.executor({
      systemPrompt: request.systemPrompt,
      userMessage,
      extras: {
        serverAdvisor: null,
        customAdvisorHandler: wrapped,
        headers,
      },
    });
  } else if (effectiveMode === 'server') {
    const serverAdvisor = buildServerAdvisorTool(options.config);
    if (!serverAdvisor) {
      throw new Error(
        `runWithAdvisor: server mode requires advisor.model on config (phase=${options.phase})`,
      );
    }
    executorResponse = await options.executor({
      systemPrompt: request.systemPrompt,
      userMessage,
      extras: {
        serverAdvisor,
        customAdvisorHandler: null,
        headers,
      },
    });
  } else {
    executorResponse = await options.executor({
      systemPrompt: request.systemPrompt,
      userMessage,
      extras: {
        serverAdvisor: null,
        customAdvisorHandler: null,
        headers,
      },
    });
  }

  const responseIterations = executorResponse.iterations ?? [];
  const allIterations = [...responseIterations, ...advisorIterations];
  if (executorResponse.advisorErrorCode && !advisorErrorCode) {
    advisorErrorCode = executorResponse.advisorErrorCode;
  }

  const telemetry = buildTelemetry({
    phase: options.phase,
    mode: declaredMode,
    config: options.config,
    iterations: allIterations,
    executorUsage: executorResponse.usage,
    durationMs: now() - startedAt,
    betaHeaderSent: headers[ADVISOR_BETA_HEADER_NAME] === ADVISOR_BETA_HEADER_VALUE,
    disabledByEnv,
    errorCode: advisorErrorCode,
  });

  if (options.logEvent) {
    await options.logEvent('runtime.run_with_advisor', telemetry);
  }

  return {
    text: executorResponse.text,
    iterations: allIterations,
    telemetry,
    disabledByEnv,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Honours `PIORX_DISABLE_ADVISOR`. Truthy values: `1`, `true`, `yes`,
 * `on` (case-insensitive). Empty string and undefined are falsy. Mirrors
 * Claude Code's `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` behaviour.
 */
export function isAdvisorDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env[ADVISOR_DISABLE_ENV];
  if (raw === undefined || raw === '') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildHeaders(advisorEnabled: boolean, sharedHistory: boolean): Record<string, string> {
  if (advisorEnabled || sharedHistory) {
    return { [ADVISOR_BETA_HEADER_NAME]: ADVISOR_BETA_HEADER_VALUE };
  }
  return {};
}

/**
 * Strip embedded advisor markers from a user-message string when the beta
 * header is not present. Today the seam is conservative — it removes any
 * inline `<advisor_tool_result>...</advisor_tool_result>` blocks an upstream
 * caller may have spliced in. Phase 3+ callers that pass structured
 * histories should drop advisor blocks from the message array before
 * calling the executor; this helper is the per-string fallback.
 */
function stripAdvisorBlocksIfNeeded(userMessage: string, headers: Record<string, string>): string {
  if (headers[ADVISOR_BETA_HEADER_NAME] === ADVISOR_BETA_HEADER_VALUE) return userMessage;
  return userMessage.replace(/<advisor_tool_result>[\s\S]*?<\/advisor_tool_result>/g, '');
}

interface InlineModeResult {
  userMessage: string;
  iteration?: AdvisorIteration;
  errorCode?: string;
}

async function runInlineMode(
  advisor: AdvisorCallback,
  systemPrompt: string,
  userMessage: string,
): Promise<InlineModeResult> {
  const advice = await advisor({ systemPrompt, userMessage });
  const iteration = usageToIteration(advice.usage, 'advisor_message');
  const result: InlineModeResult = {
    userMessage: advice.text
      ? `<advisor_plan>\n${advice.text.trim()}\n</advisor_plan>\n\n${userMessage}`
      : userMessage,
  };
  if (iteration) result.iteration = iteration;
  if (advice.errorCode) result.errorCode = advice.errorCode;
  return result;
}

function wrapAdvisorForTelemetry(
  advisor: AdvisorCallback,
  iterations: AdvisorIteration[],
  setErrorCode: (code: string) => void,
): AdvisorCallback {
  return async (req) => {
    const response = await advisor(req);
    const iteration = usageToIteration(response.usage, 'advisor_message');
    if (iteration) iterations.push(iteration);
    if (response.errorCode) setErrorCode(response.errorCode);
    return response;
  };
}

function usageToIteration(
  usage: AdvisorResponse['usage'],
  type: AdvisorIteration['type'],
): AdvisorIteration | undefined {
  if (!usage) return undefined;
  return {
    type,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

function requireAdvisor(options: RunWithAdvisorOptions, mode: AdvisorMode): AdvisorCallback {
  if (!options.advisor) {
    throw new Error(
      `runWithAdvisor: advisor callback is required when mode='${mode}' (phase=${options.phase})`,
    );
  }
  return options.advisor;
}

interface BuildTelemetryArgs {
  phase: PipelinePhaseId | string;
  mode: AdvisorMode;
  config: PhaseModelConfig;
  iterations: AdvisorIteration[];
  executorUsage: { input_tokens?: number; output_tokens?: number } | undefined;
  durationMs: number;
  betaHeaderSent: boolean;
  disabledByEnv: boolean;
  errorCode: string | null;
}

function buildTelemetry(args: BuildTelemetryArgs): AdvisorTelemetry {
  const advisorRows = args.iterations.filter((row) => row.type === 'advisor_message');
  const executorRows = args.iterations.filter((row) => row.type === 'message');

  const executorTokens = sumIterations(executorRows);
  const advisorTokens = sumIterations(advisorRows);

  if (executorRows.length === 0 && args.executorUsage) {
    executorTokens.input += args.executorUsage.input_tokens ?? 0;
    executorTokens.output += args.executorUsage.output_tokens ?? 0;
  }

  return {
    phase: args.phase,
    mode: args.mode,
    executor_model: args.config.executor.model,
    executor_provider: args.config.executor.provider,
    advisor_model: args.config.advisor?.model ?? null,
    advisor_iterations: advisorRows.length,
    advisor_input_tokens: advisorTokens.input,
    advisor_output_tokens: advisorTokens.output,
    executor_input_tokens: executorTokens.input,
    executor_output_tokens: executorTokens.output,
    duration_ms: args.durationMs,
    beta_header_sent: args.betaHeaderSent,
    disabled_by_env: args.disabledByEnv,
    error_code: args.errorCode,
  };
}

function sumIterations(rows: AdvisorIteration[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += row.input_tokens;
    output += row.output_tokens;
  }
  return { input, output };
}

// ---------------------------------------------------------------------------
// piorx:advisor pi-tool seam (COMP-P5-T1)
// ---------------------------------------------------------------------------

/**
 * Effort hint surfaced through the advisor tool result. Mirrors rpiv-advisor's
 * field, which carries the executor's reasoning effort selection so consumers
 * can correlate advisor consultations with the executor side that asked.
 */
export type AdvisorEffort = 'high' | 'medium' | 'low' | null;

/**
 * Stop-reason categories surfaced through `AdvisorToolDetails.stopReason`.
 * `end_turn` covers the canonical success path; `aborted` matches pi-ai's
 * `aborted` stop reason for cancelled calls; `max_tokens` mirrors the
 * provider's truncation signal; `error` is the catch-all for thrown
 * exceptions and advisor-side error codes.
 */
export type AdvisorStopReason = 'end_turn' | 'max_tokens' | 'aborted' | 'error';

/**
 * Wire-compat detail fields returned alongside the advisor tool's `content`.
 *
 * Field order and names match rpiv-advisor's npm-published return shape
 * (`{ advisorModel, effort, usage, stopReason, errorMessage }`) so a consumer
 * that switches between rpiv-advisor and piorx:advisor sees no schema drift.
 *
 * `usage` is `{ inputTokens, outputTokens }` (camelCase) per rpiv-advisor's
 * shape — distinct from `runWithAdvisor`'s `AdvisorTelemetry` which uses
 * snake_case `advisor_input_tokens` / `advisor_output_tokens` for log
 * consumers. Both shapes record the same numbers; the camelCase shape stays
 * on the LLM-tool wire and the snake_case shape stays in `.pi/orchestra.log`.
 */
export interface AdvisorToolDetails {
  advisorModel: string | null;
  effort: AdvisorEffort;
  usage: { inputTokens: number; outputTokens: number } | null;
  stopReason: AdvisorStopReason;
  errorMessage: string | null;
}

/** Single text content block returned to the executor side of the tool call. */
export interface AdvisorToolTextContent {
  type: 'text';
  text: string;
}

/**
 * Wire-compat result of the advisor pi-tool, mirroring rpiv-advisor's
 * zero-arg contract — `{ content, details }`. The shape is preserved on
 * every code path (success, env-disabled, advisor-error, abort) so callers
 * can branch on `details.stopReason` rather than catching exceptions.
 */
export interface AdvisorToolResult {
  content: AdvisorToolTextContent[];
  details: AdvisorToolDetails;
}

export interface AdvisorToolRequest {
  systemPrompt: string;
  userMessage: string;
  /** Identifier of the advisor model the host resolved. */
  advisorModel: string;
  /** Optional effort hint surfaced verbatim on the result. */
  effort?: AdvisorEffort;
}

export interface RunAdvisorToolOptions {
  request: AdvisorToolRequest;
  advisor: AdvisorCallback;
  /** Forwarded from the pi tool execute() seam. */
  signal?: AbortSignal;
  /** Optional telemetry sink. */
  logEvent?: (message: string, details?: unknown) => Promise<void> | void;
  /** Test seam: override `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a single advisor consultation in the rpiv-advisor wire-compat shape.
 *
 * Per `docs/composability.md` "Phase 5 — Skills-as-strategies + filesystem
 * discovery" and COMP-P5-T1, the `piorx:advisor` pi tool surfaces an
 * interactive advisor call from pi's main loop. The wire shape is
 * `{ content, details: { advisorModel, effort, usage, stopReason, errorMessage } }`,
 * matching rpiv-advisor's npm package so a consumer can swap implementations
 * without changing prompt or tool-result handling.
 *
 * Failure modes preserve the result shape rather than throwing:
 *   - `PIORX_DISABLE_ADVISOR` set → `stopReason='error'`,
 *     `errorMessage='advisor disabled via PIORX_DISABLE_ADVISOR'`.
 *   - `signal.aborted` mid-call → `stopReason='aborted'`.
 *   - Advisor callback throws → `stopReason='error'`,
 *     `errorMessage=<error.message>`.
 *   - Advisor callback returns `errorCode` → `stopReason='error'`,
 *     `errorMessage=<error code>`.
 *
 * Telemetry (when `logEvent` is provided) records the same canonical shape
 * across all paths so post-hoc cost reconstruction matches `runWithAdvisor`'s
 * record format.
 */
export async function runAdvisorTool(options: RunAdvisorToolOptions): Promise<AdvisorToolResult> {
  const env = options.env ?? process.env;
  const advisorModel = options.request.advisorModel;
  const effort = options.request.effort ?? null;

  if (isAdvisorDisabledByEnv(env)) {
    const result = makeAdvisorErrorResult({
      advisorModel,
      effort,
      message: `advisor disabled via ${ADVISOR_DISABLE_ENV}`,
    });
    await emitAdvisorToolTelemetry(options.logEvent, result, true);
    return result;
  }

  const signal = options.signal;
  if (signal?.aborted) {
    const result = makeAdvisorErrorResult({
      advisorModel,
      effort,
      message: 'advisor call aborted before dispatch',
      stopReason: 'aborted',
    });
    await emitAdvisorToolTelemetry(options.logEvent, result, false);
    return result;
  }

  try {
    const response = await options.advisor({
      systemPrompt: options.request.systemPrompt,
      userMessage: options.request.userMessage,
    });
    const usage = response.usage
      ? {
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
        }
      : null;
    const stopReason: AdvisorStopReason = response.errorCode ? 'error' : 'end_turn';
    const result: AdvisorToolResult = {
      content: [{ type: 'text', text: response.text }],
      details: {
        advisorModel,
        effort,
        usage,
        stopReason,
        errorMessage: response.errorCode ?? null,
      },
    };
    await emitAdvisorToolTelemetry(options.logEvent, result, false);
    return result;
  } catch (err) {
    const aborted = signal?.aborted ?? false;
    const message = err instanceof Error ? err.message : String(err);
    const result = makeAdvisorErrorResult({
      advisorModel,
      effort,
      message,
      stopReason: aborted ? 'aborted' : 'error',
    });
    await emitAdvisorToolTelemetry(options.logEvent, result, false);
    return result;
  }
}

function makeAdvisorErrorResult(args: {
  advisorModel: string | null;
  effort: AdvisorEffort;
  message: string;
  stopReason?: AdvisorStopReason;
}): AdvisorToolResult {
  return {
    content: [{ type: 'text', text: '' }],
    details: {
      advisorModel: args.advisorModel,
      effort: args.effort,
      usage: null,
      stopReason: args.stopReason ?? 'error',
      errorMessage: args.message,
    },
  };
}

async function emitAdvisorToolTelemetry(
  logEvent: RunAdvisorToolOptions['logEvent'],
  result: AdvisorToolResult,
  disabledByEnv: boolean,
): Promise<void> {
  if (!logEvent) return;
  await logEvent('runtime.advisor_tool', {
    advisor_model: result.details.advisorModel,
    effort: result.details.effort,
    stop_reason: result.details.stopReason,
    error_message: result.details.errorMessage,
    advisor_input_tokens: result.details.usage?.inputTokens ?? 0,
    advisor_output_tokens: result.details.usage?.outputTokens ?? 0,
    disabled_by_env: disabledByEnv,
  });
}
