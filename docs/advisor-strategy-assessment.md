# The Advisor Strategy — piorx Assessment

**Author:** research artifact for piorx maintainer
**Date:** 2026-05-08
**Last verified:** 2026-05-08 (deep fact-check pass against pi-mono live source, piorx repo, and Anthropic public docs + third-party reports)
**Companion docs:** `docs/batch-api-assessment.md`, `docs/auto-implement-and-conductor.md`, `docs/piorx-specification.md`

---

## 1. TL;DR

The Advisor Strategy is two things: a **pattern** (executor model consults a stronger advisor when it hits a hard decision) and an **API** (`advisor_20260301`, Anthropic-only, server-side, single-request). They are decoupled. piorx should adopt **both** — the API where the executor is a Claude model and the round-trip win matters, the pattern (as a custom pi-ai tool) everywhere else.

**Verdict:**

- **Synthesis** — highest-ROI integration. Build the real worker with executor + advisor + structured outputs in one shot. Default to **`custom` mode** in piorx today (the host SDK pi-ai drops `usage.iterations[]`, so `server` mode forfeits per-iteration billing detail until pi-ai is patched).
- **Execution** — second-highest. Long-horizon agentic. Same pairing if Sonnet executor; `custom` mode unlocks GPT-as-executor with Anthropic-as-advisor without forfeiting the pattern.
- **Retriever** — much smaller refactor than first sketched. `agentLoop` from `@mariozechner/pi-agent-core` (already installed transitively) replaces the custom JSON-protocol loop; advisor slots in as one more tool. The 4-action JSON dispatcher (≈500 LOC across `agent.ts`/`agent-prompt.ts`) collapses to ≈200 LOC.
- **Conductor / restatement / expansion** — don't bother. Single-turn or pure routing. Use Haiku alone. Optionally use `inline` advisor for expansion.
- **Optional bonus** — **`pi.registerTool('advisor')`** exposes the advisor in the user's interactive piorx chat session, independent of phase workers. Half-day add-on once `runWithAdvisor` exists.

**Three assumptions that did not survive contact with reality:**

1. *"Sonnet as advisor isn't supported."* The public docs page says Opus 4.7 only. Claude Code's own production validator at `utils/advisor.ts:89-106` accepts both `opus-4-6` and `sonnet-4-6` in both roles. The truth is uncertain — probe before designing around either assumption.
2. *"Cross-vendor execution forfeits the advisor."* False — that's only true for `server` mode. The `custom` mode (advisor as a pi-ai tool callback) works with any executor and any advisor, including across vendors.
3. *"`server` mode is the cleanest path."* In Anthropic-only contexts, yes. **In piorx today, `custom` is cleaner.** pi-ai's `convertTools` strips unknown tool fields (no `type: 'advisor_20260301'` passthrough) and pi-ai's `Usage` shape drops Anthropic's `usage.iterations[]`. Server mode in piorx requires both `StreamOptions.onPayload` body splicing and `StreamOptions.headers` for the beta — and even then, advisor-token telemetry is lost. Custom mode bills naturally through pi-ai's flat `Usage` per side-call.

---

## 2. Pattern vs API — the conceptual unlock

| | The **pattern** | The **API** (`advisor_20260301`) |
|---|---|---|
| What | Executor consults a stronger model when stuck; advisor sees executor's transcript; returns short plan; executor continues | Anthropic's server-side implementation of the pattern |
| Models | Any executor + any advisor (cross-vendor OK) | Claude executor + Claude advisor (per Claude Code's validator: Opus 4.6, Opus 4.7, Sonnet 4.6 in both roles; per the docs: Opus 4.7 advisor only) |
| Round trips | Host orchestrates: 1 call to executor + 1 call to advisor per consult | 1 single API call total, server-side sub-inference |
| Implementation | Custom tool registered on executor; tool handler issues a separate `complete()` to advisor | Tool config in `tools` array + beta header |
| Token billing | Wherever you point each leg | Anthropic-internal, per-iteration breakdown |
| Vendor lock | None | Anthropic both sides |

So a piorx phase has **three** advisor delivery modes:

- **`server`** — `advisor_20260301`. Cleanest, single-request, but Anthropic-only on both ends.
- **`custom`** — pi-ai tool callback. Executor emits a `toolCall` named `advisor`; piorx's dispatch service handles it by issuing a separate `complete()` to whatever advisor model is configured. Returns the result as a `toolResult`. Executor continues.
- **`inline`** — deterministic pre-call. Run the advisor *before* invoking the executor; prepend the plan to the executor's user message. No tool dance, no executor judgment about timing — an always-on plan-first treatment. Cheap when you know the advisor always helps.

---

## 3. The Advisor API — complete mechanics

Sources of truth: [`platform.claude.com/docs/.../advisor-tool`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool), [`claude.com/blog/the-advisor-strategy`](https://claude.com/blog/the-advisor-strategy).

### 3.1 What it actually is

A new Anthropic **server-side tool** that lets a fast/cheap **executor model** call into a stronger **advisor model** mid-generation, all inside one `/v1/messages` request. The executor decides *when* to ask for advice; the server constructs the advisor's view from the executor's full transcript automatically. The advisor returns a short plan/critique (typically 400–700 text tokens, 1,400–1,800 with thinking), the executor continues, and the loop closes inside a single API call.

Pattern fit per Anthropic: *"long-horizon agentic workloads (coding agents, computer use, multi-step research pipelines) where most turns are mechanical but having an excellent plan is crucial."*

### 3.2 Model pairs (per public docs)

The docs page lists only this matrix:

| Executor | Advisor |
|---|---|
| Haiku 4.5 | Opus 4.7 |
| Sonnet 4.6 | Opus 4.7 |
| Opus 4.6 | Opus 4.7 |
| Opus 4.7 | Opus 4.7 |

Invalid pairs return `400 invalid_request_error`.

**However** — Claude Code's production validator is wider (see §4.1). The truth is one curl away.

### 3.3 API shape (verbatim)

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "tools": [
    {
      "type": "advisor_20260301",
      "name": "advisor",
      "model": "claude-opus-4-7",
      "max_uses": 3,
      "caching": { "type": "ephemeral", "ttl": "5m" }
    }
  ],
  "messages": [...]
}
```

Beta header: `anthropic-beta: advisor-tool-2026-03-01`. Python SDK: `client.beta.messages.create(..., betas=["advisor-tool-2026-03-01"])`.

### 3.4 Wire-level behavior worth knowing

- Executor emits `server_tool_use{ name:"advisor", input:{} }` — **the executor never supplies content for the advisor**. The server builds the advisor's view from the transcript.
- Result returns as `advisor_tool_result`, with content variant either `advisor_result{text}` or `advisor_redacted_result{encrypted_content}` depending on advisor model. **Round-trip the block verbatim on follow-up turns.**
- **The advisor never calls tools and never produces user-facing output.** Its thinking blocks are dropped before the result reaches the executor.
- **Streaming pauses while the advisor runs** (only SSE pings during the gap). Result lands in one `content_block_start`, no deltas.
- **Token accounting is per-iteration** (`usage.iterations[]`, with `type: "advisor_message" | "message"`). Top-level `usage.output_tokens` sums *executor* iterations only.
- **`max_tokens` does not bound advisor output.** Advisor tokens are independent.
- **Errors don't fail the request.** Returned as `advisor_tool_result_error` with `error_code` ∈ `{max_uses_exceeded, too_many_requests, overloaded, prompt_too_long, execution_time_exceeded, unavailable}`. Executor sees the error and continues.
- **Conversation persistence rule:** if message history contains `advisor_tool_result` blocks, dropping the advisor tool from `tools` on subsequent turns returns `400`.
- **Conversation-level cap mechanics.** No built-in budget. Count client-side. When you hit the cap you must do **both**: (a) remove the advisor tool from `tools[]`, **and** (b) strip historical `advisor_tool_result` blocks from messages. Doing only one returns `400 invalid_request_error`.
- **Caching has two independent layers.** Executor-side: the `advisor_tool_result` block is normal cacheable content. Advisor-side: set `caching` on the tool definition for the advisor's *own* transcript. Break-even ≈ 3 advisor calls per conversation.
- **Caching gotcha — `clear_thinking`.** If the executor's request uses `clear_thinking` with `keep` ≠ `"all"`, the advisor-side prompt cache **misses on every call**. Cost-only impact (no quality regression), but defaults matter — leave `keep: "all"` unless there's a specific reason not to.
- **Partial compatibility — `clear_tool_uses`.** Not fully compatible with the advisor tool yet; verify behavior before relying on it in advisor-enabled phases.
- **`pause_turn` interaction.** A dangling advisor call can end the turn with `stop_reason: "pause_turn"`. piorx doesn't use `pause_turn` today, but if execution-worker grows long-horizon agentic, this matters.
- **Compatible with batch processing**, web search, code execution, MCP connectors, and custom tools — all in the same `tools` array.
- **piorx-specific gotcha:** the per-iteration billing breakdown (`usage.iterations[]`) is **dropped by pi-ai's flat `Usage` type** (see §5.3 below). Server-mode advisor still works through pi-ai via `onPayload`, but you only see one merged token total. Use `custom` mode if you need clean per-iteration cost telemetry today.

### 3.5 Cost / quality numbers Anthropic published

| Pair | Workload | Δ score vs solo executor | Δ cost |
|---|---|---|---|
| Sonnet 4.6 + Opus 4.7 advisor | SWE-bench Multilingual | **+2.7 pp** | **−11.9%** |
| Haiku 4.5 + Opus 4.7 advisor | BrowseComp | 41.2% (vs 19.7% Haiku solo) | −85% vs Sonnet solo |

Anthropic explicitly: *"Results are task-dependent. Evaluate on your own workload."*

### 3.6 Best-practice prompting

Two timings dominate the cost/quality curve on coding tasks:

1. **Early call** after a few exploratory reads, before committing to an interpretation.
2. **Final call** before declaring done — and the deliverable should be persisted *before* the call, since the call takes time and the session might end during it.

Anthropic ships a built-in tool description that nudges the executor toward those timings. They also note that prepending *"The advisor should respond in under 100 words and use enumerated steps, not explanations."* to the executor system prompt cuts advisor output tokens by **35–45%** empirically, with no observed quality drop.

**Effort pairing.** Anthropic's published guidance: *"For coding tasks, pairing a Sonnet executor at medium effort with an Opus advisor achieves intelligence comparable to Sonnet at default effort, at lower cost."* Directly relevant to piorx's synthesis worker, where every cost lever matters and Sonnet-medium + Opus-advisor is a credible default.

**Use Claude Code's `ADVISOR_TOOL_INSTRUCTIONS` verbatim** for piorx synthesis/execution — see §4.5.

---

## 4. Production patterns from Claude Code's own integration

Searched `~/code/public/claude-code` for advisor mentions. Claude Code itself ships a real, production-quality integration. What the public docs leave implicit, the Claude Code source spells out.

### 4.1 The validator is wider than the published docs

`utils/advisor.ts:89-106`:

```ts
export function modelSupportsAdvisor(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('opus-4-6') || m.includes('sonnet-4-6') || process.env.USER_TYPE === 'ant'
}
export function isValidAdvisorModel(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('opus-4-6') || m.includes('sonnet-4-6') || process.env.USER_TYPE === 'ant'
}
```

**Both roles accept `opus-4-6` and `sonnet-4-6`.** The public docs page lists Opus 4.7 only as advisor. Either:

- the docs are conservative and the production validator is permissive (Sonnet 4.6 *is* a valid advisor, just undocumented), or
- the validator is loose and the API will 400 at the server.

**Updated bias (2026-05-08):** evidence has shifted toward "validator is loose, API matrix is canonical." GitHub issue [anthropics/claude-code#46148](https://github.com/anthropics/claude-code/issues/46148) — *"Advisor tool: Haiku 4.5 executor rejected by CLI despite API docs listing it as valid pair"* — documents the **inverse drift** in the same validator (it rejects a pair the docs allow). When the same validator drifts in both directions, the API matrix is the authority.

**Implication for piorx:** still probe before committing — but **expect the API to 400 on Sonnet-as-advisor**. Probe #1 in §10 stays load-bearing; reorder so the result drives the model picker in Phase A's config validator (refuse non-canonical pairs by default; allow override behind a flag once probed-positive).

### 4.2 Always send the beta header when advisor is enabled, for *every* phase that touches shared history

`services/api/claude.ts:1073-1078`:

```ts
// Always send the advisor beta header when advisor is enabled, so
// non-agentic queries (compact, side_question, extract_memories, etc.)
// can parse advisor server_tool_use blocks already in the conversation history.
if (isAdvisorEnabled()) {
  betas.push(ADVISOR_BETA_HEADER)
}
```

The advisor *tool* is only added on agentic queries (`isAgenticQuery && isAdvisorEnabled()`), but the beta *header* is always sent. Reason: any phase that re-reads history containing prior `advisor_tool_result` blocks needs the beta to parse them, even if that phase isn't agentic.

**piorx implication:** if synthesis or execution have advisor blocks in their stored output, every phase that re-reads that history (recursive-intent promotion, conductor-side rendering of artifacts, etc.) needs the beta header on its own API calls.

### 4.3 Inverse safety — strip advisor blocks when beta not present

`services/api/claude.ts:1303-1306`:

```ts
// Strip advisor blocks — the API rejects them without the beta header.
if (!betas.includes(ADVISOR_BETA_HEADER)) {
  messagesForAPI = stripAdvisorBlocks(messagesForAPI)
}
```

`utils/messages.ts:5463-5464` notes the failure mode: *"the API rejects with e.g. 'advisor tool use without corresponding advisor_tool_result'"*. piorx should either (a) always send the beta when any phase has touched advisor (rule 4.2) **or** (b) strip the blocks. Both, ideally — defense in depth.

### 4.4 Cache-stability placement

`services/api/claude.ts:1386-1395`:

```ts
if (advisorModel) {
  // Server tools must be in the tools array by API contract. Appended after
  // toolSchemas (which carries the cache_control marker) so toggling /advisor
  // only churns the small suffix, not the cached prefix.
  extraToolSchemas.push({
    type: 'advisor_20260301',
    name: 'advisor',
    model: advisorModel,
  } as unknown as BetaToolUnion)
}
```

**Critical:** the advisor tool config goes *after* the cache-marker'd tool schemas. Toggling advisor on/off doesn't bust the cached prefix (Claude Code comments elsewhere mention "~50-70K tokens" of churn avoided per session). Same applies to piorx if it ever wires prompt caching: append the advisor block to `tools[]`, don't prepend.

### 4.5 Production system prompt — verbatim

`utils/advisor.ts:130-145` ships `ADVISOR_TOOL_INSTRUCTIONS`. Use this as-is for advisor-enabled phases:

```text
# Advisor Tool

You have access to an `advisor` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.
```

For `custom` mode, the same prompt works — just s/advisor/the_advisor_tool_we_register/.

### 4.6 First-party gating, sticky latches, escape hatch

- `shouldIncludeFirstPartyOnlyBetas()` — Bedrock and Vertex 400 on the advisor beta header (`utils/advisor.ts:64-67`). If piorx ever runs against Bedrock/Vertex via pi-ai (it lists both as supported providers), advisor must be disabled there.
- **Sticky-on latches** for dynamic beta headers (`claude.ts:1405-1412`): once first sent in a session, keep sending. Mid-session toggles bust the server-side cache. piorx's session model would benefit from the same pattern.
- **Escape hatch:** `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` env var. piorx should have an analog (`PIORX_DISABLE_ADVISOR`) for emergencies.

### 4.7 Telemetry shape

Events: `tengu_advisor_tool_call`, `tengu_advisor_tool_interrupted`, with `advisor_model` field. Cost extraction: `getAdvisorUsage(usage)` filters `usage.iterations[]` for `type === 'advisor_message'` (`utils/advisor.ts:115-128`).

piorx should mirror this in `.pi/orchestra.log` so cost-per-task can be reconstructed post-hoc.

---

## 5. piorx today — model wiring, opacity boundaries, where models actually run

### 5.1 The single-model bottleneck

Every conductor-side LLM call routes through one helper at `extensions/conductor-extension.ts:86`:

```ts
async function getModelText(systemPrompt: string, userText: string, ctx: ExtensionContext) {
  if (!ctx.model) throw new Error('No model selected for conductor model call');
  ...
  const response = await complete(ctx.model, { systemPrompt, messages: [userMessage] }, { apiKey, headers, signal });
  ...
}
```

`ctx.model` is whatever pi was launched with — there is **no per-stage selection**. It's used by:

- `restateWithModel` (Stage 1, line 380)
- `expandWithModel` (Stage 2, line 403)
- `makeRetrieverAgentModel(ctx)` → injected into the retriever agent loop (line 391, consumed by `src/retriever/agent.ts`)

Every `complete()` is single-turn (`messages: [userMessage]`). The retriever agent is "multi-turn" only in the sense that `src/retriever/agent.ts` runs N rounds and serializes prior trace into the next user prompt — it's *not* using native Messages API tool use or `messages: [...]` history.

### 5.2 The opacity boundary, summarized

From `docs/conductor-overview.md` and `docs/piorx-specification.md` §1.4:

- **Conductor:** structurally source-blind (no file reads). Exception: Stage 1's `<file>`-tag parser via `src/util/intent-files.ts`.
- **Retriever:** scout (deterministic, no model) + agent (model-driven, bounded loop, repo-root-sandboxed file reads). 3 rounds × 4 actions × 12 file reads × 256 KiB observation budget.
- **Assembler** (`src/services/evidence-assembler.ts`): deterministic — same plan + index + repo state → byte-identical bundle.
- **Synthesis worker** (`src/synthesis/worker.ts`): **stub.** Generates artifacts deterministically from the bundle.
- **Execution worker** (`src/execution/worker.ts`): **stub.** Generates a fake report; no real edits or commands.

### 5.3 pi-ai / pi-coding-agent — verified surface (the host SDK reality)

Investigated `node_modules/@mariozechner/{pi-ai,pi-coding-agent,pi-agent-core}` (installed v0.67.6, what piorx ships against today) and the live source at `~/code/sks/pi-mono/packages/{ai,coding-agent,agent}` (renamed to `@earendil-works/*` v0.74.0+, what piorx will pull from when it upgrades — the rename has fully landed; `package.json:2` for all three packages reads `@earendil-works/pi-{ai,coding-agent,agent-core}` as of 2026-05-08). The API shape is identical across both versions; the rename + version bump does not change the recommendation. Citations below name the live `@earendil-works/*` paths because that's the durable surface; the installed `@mariozechner/*` paths are a temporary legacy.

**What pi-ai gives you for free (custom-mode advisor — no host changes):**

- `Context.tools?: Tool[]` — pi-ai's `complete()` accepts tools. (`packages/ai/src/types.ts:333-337`)
- `Tool` shape — `{ name, description, parameters: TSchema }`. **No `type` field.** (`packages/ai/src/types.ts:325-331`)
- Full multi-turn tool-use protocol: `ToolCall` (line 246-252), `ToolResultMessage` (line 292-300), `Message` (line 302). pi-ai handles the round-trip — emit assistant `toolCall`, push back a `toolResult` message, call `complete()` again.
- TypeBox is an internal pi-ai dep — installed and ready, just `import { Type } from "typebox"` in piorx.

**What pi-ai actively breaks for server-mode advisor:**

1. **`convertTools()` strips unknown fields** — `packages/ai/src/providers/anthropic.ts:1146-1169` (installed: `dist/providers/anthropic.js:741-748`). The mapping is hardcoded:
   ```ts
   tools.map((tool, index) => ({
     name: ...,
     description: tool.description,
     ...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
     input_schema: { type: "object", properties: ..., required: ... },
     ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
   }));
   ```
   No `type: tool.type` passthrough. Putting `{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-7' }` in `Context.tools[]` produces `{ name: 'advisor', description: undefined, input_schema: {...} }` on the wire — a regular custom tool, not a server tool. **Server-mode advisor via `Context.tools[]` alone is impossible.**

2. **`Usage` is flat — no `iterations[]`** — `packages/ai/src/types.ts:254-267`:
   ```ts
   interface Usage {
     input: number; output: number; cacheRead: number; cacheWrite: number;
     totalTokens: number; cost: { input, output, cacheRead, cacheWrite, total };
   }
   ```
   Anthropic's `usage.iterations[]` (with `type: "advisor_message"` rows) is collapsed into the executor's totals at `providers/anthropic.ts:497-506` and `:631-648`. Per-iteration billing breakdown is **lost** at the pi-ai boundary, regardless of how the advisor block reaches the wire.

**Escape hatches that do work for server mode:**

- `StreamOptions.onPayload?: (payload, model) => unknown | undefined` — `packages/ai/src/types.ts:109`. Fires *after* `buildParams`, *before* `client.messages.create` (`providers/anthropic.ts:477-481`). Returned value replaces the body. **This is where you splice in `tools: [..., { type: 'advisor_20260301', name: 'advisor', model: '...' }]`.**
- `StreamOptions.headers?: Record<string, string>` — `packages/ai/src/types.ts:116-120`. Merged with provider defaults; can override. **This is where the `anthropic-beta: advisor-tool-2026-03-01` header goes.** It cannot live in `onPayload` — beta headers attach to the HTTP request, not the body, and `onPayload` only mutates the body.
- `pi.registerProvider(name, { streamSimple, ... })` — full custom provider. Heaviest hammer; only worth it if `onPayload` proves brittle across pi-ai versions.

### 5.4 Pi extension hooks (verified) — and the two-scope distinction

Read `packages/coding-agent/src/core/extensions/types.ts` (1567 lines). Hooks relevant to advisor:

| Hook | Signature | Use for advisor |
|---|---|---|
| `pi.on("before_provider_request", ...)` | `{ payload: unknown }` → return new payload | Inject `advisor_20260301` block + bump tool config in pi's **main agent loop** payload |
| `pi.on("after_provider_response", ...)` | `{ status, headers }` (no body) | Emergency telemetry only; cannot recover dropped iterations |
| `pi.on("context", ...)` | `{ messages: AgentMessage[] }` → `{ messages? }` | `stripAdvisorBlocks` pattern (defense in depth — Claude Code §4.3) |
| `pi.on("before_agent_start", ...)` | `{ prompt, systemPrompt, ... }` → `{ systemPrompt? }` | Inject `ADVISOR_TOOL_INSTRUCTIONS` into system prompt for main-loop sessions |
| `pi.on("tool_call", ...)` | tool call event → `{ block?, reason? }` | Observe/intercept advisor invocations |
| `pi.on("tool_result", ...)` | tool result event → `{ content?, details?, isError? }` | Post-process advisor responses |
| `pi.registerTool(toolDef)` | `ToolDefinition` with TypeBox schema | Register an `advisor` tool in the **main loop** so the user's interactive chat session sees it |
| `pi.registerProvider(name, config)` | `{ streamSimple?, ... }` | Custom provider override (heaviest path) |
| `pi.registerFlag(name, options)` | `--advisor-mode=...`, `--advisor-model=...` | CLI surface |

**The scope distinction that matters:**

| Scope | API | Used by | Right for |
|---|---|---|---|
| **Main-loop** | `pi.registerTool(...)` + `pi.on("before_provider_request", ...)` | The user's interactive piorx chat session — pi's primary agent loop | A user-visible `advisor` tool, plus `server`-mode payload injection for chat sessions |
| **Per-call (phase-internal)** | `Context.tools` + `StreamOptions.onPayload` / `headers` in piorx's own `complete()`/`agentLoop` calls | piorx phase code (`getModelText`, synthesis worker, retriever agent) | Phase-internal advisor — what enables "advisor as the entire phase" |

Critically: **`before_provider_request` only fires for pi's main-loop API calls.** It does NOT intercept piorx's internal `complete()` calls inside phase workers — those go straight through pi-ai's `streamSimple`. The hook is wired through the **pi-coding-agent extension runtime** (`packages/coding-agent/src/core/extensions/types.ts:611-614` defines the event; the dispatch is in the extension manager, not the pi-ai provider), so calling pi-ai directly bypasses it entirely. Phase-internal advisor configuration must live in the per-call options passed to `complete()`/`agentLoop`.

### 5.5 `agentLoop` is already in piorx's installed deps

`@mariozechner/pi-agent-core` v0.67.6 is installed transitively and exports `agentLoop` (`node_modules/@mariozechner/pi-agent-core/dist/agent-loop.d.ts`); the same export is at `@earendil-works/pi-agent-core` v0.74.0+ in the live pi-mono source (`~/code/sks/pi-mono/packages/agent/src/agent-loop.ts`, 695 LOC):

```ts
export declare function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>;
```

Source at `~/code/sks/pi-mono/packages/agent/src/agent-loop.ts` (695 lines). Provides:

- Streaming, multi-turn tool-calling agent loop with parallel/sequential execution.
- Lifecycle hooks via `AgentLoopConfig`: `transformContext`, `convertToLlm`, `beforeToolCall`, `afterToolCall`, `getApiKey`, `shouldStopAfterTurn`, `getSteeringMessages`, `getFollowUpMessages`.
- Event stream (`agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `tool_execution_*`, `turn_end`, `agent_end`).
- Abort signal handling, partial message tracking, streaming-while-tool-executing.
- Tool execution honors per-tool `executionMode: "sequential" | "parallel"`.

**This is exactly what the retriever's bounded agent reinvents** in JSON over single-turn `complete()` calls (`src/retriever/agent.ts` + `src/retriever/agent-prompt.ts`). The retriever currently builds a JSON prompt manually, parses JSON for `actions[]` and `recommendation`, executes actions via `src/retriever/executor.ts`, and serializes prior trace into the next user prompt. All of that machinery is `agentLoop` with:

- `tools = [readFile, searchContent, searchPaths, followImports]` (TypeBox-schema'd, sandboxed `execute()` reusing the existing `executor.ts`),
- `shouldStopAfterTurn` enforcing the bounded budgets (rounds, file reads, observation bytes),
- and adding `advisor` to `tools` in custom mode.

No new dependency. The retriever rewrite collapses ≈500 LOC of `agent.ts` + `agent-prompt.ts` into ≈200 LOC.

### 5.6 Implication for advisor integration

- Conductor & assembler are not LLM-driven — advisor doesn't apply.
- Retriever is LLM-driven but uses a **custom JSON-over-single-turn-`complete()`** protocol. **The right move is to rewrite onto `agentLoop` and add advisor as a tool.** Two-stage if you want to ship sooner: (1) bolt advisor onto the existing JSON loop as a 5th action; (2) rewrite onto `agentLoop`. Stage 1 has no architectural value other than time-to-first-eval.
- Synthesis & execution are the natural hosts for advisor — both are currently stubs (`src/synthesis/worker.ts:88-95`, `src/execution/worker.ts:84-130`), so building the real version is the right moment to wire it in.
- **Default to `custom` mode in piorx today.** It works with no host changes, preserves per-iteration billing detail (each side-call bills naturally through pi-ai's flat `Usage`), and is cross-vendor compatible. `server` mode is reachable but requires both `onPayload` body splicing AND `StreamOptions.headers` for the beta, AND it forfeits per-iteration billing detail until pi-ai is patched. Reach for `server` mode in piorx only when (a) you've upstreamed a `Usage.iterations` patch to pi-ai, or (b) you genuinely don't care about advisor token-level cost attribution.
- **pi-mono has zero advisor code.** `grep -rn "(advisor|advisor_20260301|advisor-tool)"` across `~/code/sks/pi-mono` returns nothing. piorx is the first project in this stack to integrate. You set the conventions; there's no upstream API to align with.

---

## 6. Mapping advisor onto piorx — per-phase recommendation

| Phase | Executor (rec) | Advisor mode | Advisor model | `max_uses` | Notes |
|---|---|---|---|---|---|
| Conductor (state, gating) | Haiku 4.5 | none | — | — | Pure routing/heuristic. No reasoning lift to capture. |
| Stage 1 restatement | Haiku 4.5 | none | — | — | Single-turn. |
| Expansion | Haiku 4.5 | optional `inline` | Sonnet 4.6 | n/a | Always-on plan-first, prepended to user message. Cheaper than tool dance for a single-shot phase. Pair with `output_config.format`. |
| Retriever agent | Sonnet 4.6 (canonical) or Haiku 4.5 (cost floor) | `custom` (default — preserves per-side-call billing) | Opus 4.7 | 2–3 | Rewrite onto `agentLoop` (already installed via `pi-agent-core`); advisor slots in as one more `Tool`. ≈500 LOC → ≈200 LOC. `server` mode is reachable via `onPayload`+`headers` but forfeits per-iteration billing in pi-ai today. |
| Synthesis | Sonnet 4.6 (consider `medium` effort — see §3.6 effort-pairing) | `custom` (default in piorx today); `server` only after pi-ai's `Usage.iterations` is patched | Opus 4.7 | 1 (analysis-report), 2 (change-spec) | **Highest ROI.** Pair with `output_config.format`. Custom mode each side-call bills naturally through pi-ai's flat `Usage` — no telemetry loss. |
| Execution | Sonnet 4.6 (advisor available) **or** GPT-5.4 (custom-mode advisor still possible) | `custom` is universal — works for both Sonnet and GPT executors | Opus 4.7 (or Sonnet 4.6) | 2–3 | `custom` mode unlocks GPT-as-executor + Anthropic-as-advisor. The pattern wins even without the API. |
| Interactive piorx chat (bonus) | whatever pi was launched with | `custom` via `pi.registerTool('advisor', ...)` | Opus 4.7 | n/a (model-decided) | Half-day add-on once `runWithAdvisor` exists. Exposes the advisor in the user's interactive chat session. Independent of phase workers. |

### 6.1 Reality-check vs the user's original hypothesis

| Hypothesis | Status | Adjustment |
|---|---|---|
| "Small/fast as conductor and retriever" | ✓ for conductor; mixed for retriever | Conductor: Haiku alone is right. Retriever: Haiku + Opus advisor is the *cost-optimized* config; Sonnet + Opus advisor is the *quality-optimized* one. Sonnet+Opus is what the docs recommend for coding-shape work. |
| "Opus (or even sonnet) as advisor/synthesizer" | Plausible | Sonnet-as-advisor passes Claude Code's validator. Probe before designing around it. |
| "GPT-5.4 or sonnet-4-6 as agentic execution" | ✓ both work now | Sonnet uses `custom` (or `server`) advisor; GPT uses `custom` advisor over Anthropic. **No phase forfeits the pattern.** |
| "Advisor as a tool call early in a phase, or as the entire phase" | ✓ both are right | "Early call after exploratory reads" is what `server`/`custom` both do. "As the entire phase" is the right mental model for synthesis/execution. |
| "`server` is the cleanest path in piorx" | ✗ not today | Ruled out by post-research investigation. pi-ai's `convertTools` strips unknown fields and pi-ai's flat `Usage` collapses `iterations[]`. `custom` mode is cleaner in piorx today. Reconsider after pi-ai is patched. |

---

## 7. Implementation plan

### Phase A — per-phase model config + mode taxonomy (prerequisite)

`src/runtime/config.ts` currently only carries paths. Extend:

```ts
export type AdvisorMode = 'none' | 'inline' | 'custom' | 'server';

export interface AdvisorConfig {
  mode: AdvisorMode;
  model: string;                              // any model id; validator decides if pairing is OK
  maxUses?: number;
  caching?: 'ephemeral-5m' | 'ephemeral-1h' | null;
  contextStrategy?: 'full-transcript' | 'phase-curated';   // for custom mode
}

export interface PhaseModelConfig {
  executor: { provider: 'anthropic' | 'openai' | string; model: string };
  advisor?: AdvisorConfig;
}

export interface PiOrchestraConfig {
  ...existing path fields...
  models: {
    conductor: PhaseModelConfig;       // restatement, gating, rendering
    expansion: PhaseModelConfig;
    retriever: PhaseModelConfig;
    synthesis: PhaseModelConfig;
    execution: PhaseModelConfig;
  };
}
```

**`contextStrategy` rationale (custom mode only):** `full-transcript` mirrors server-mode semantics — the advisor sees everything the executor saw, no surprises. `phase-curated` is for phases where the transcript carries large incidental payloads (evidence-bundles in synthesis can run hundreds of KiB; sending the full bundle through to the advisor costs tokens at the advisor's rate). Default `full-transcript`; opt into `phase-curated` only when an advisor `prompt_too_long` error is observed or when the advisor's per-call cost outpaces the executor's by >10× and a curated slice is provably sufficient.

The config validator should also refuse non-canonical executor/advisor pairs by default (Opus 4.7 advisor only, per the docs) and require an explicit override flag for off-matrix pairs — the §10 probes determine which off-matrix pairs are actually accepted at the API.

Refactor `getModelText(systemPrompt, userText, ctx)` → `getModelText(systemPrompt, userText, ctx, phase)` and resolve the executor from `runtime.config.models[phase]`. Keep the `ctx.model` fallback for one minor version.

This unblocks everything else and is testable on its own. **Eval:** existing 498 tests stay green.

### Phase B — `runWithAdvisor` shared helper

**Default-mode rule (load-bearing):** until either (a) per-iteration billing is patched into pi-ai's `Usage`, or (b) the phase explicitly opts out of fine-grained advisor cost telemetry, **default `mode: 'custom'`** for any phase. Codify this default in `runWithAdvisor` itself so opting into `server` is a deliberate config decision visible at code review.

Single helper that knows the three modes:

```ts
async function runWithAdvisor<T>(
  phase: PhaseModelConfig,
  request: { systemPrompt: string; userMessage: string; tools?: Tool[]; outputFormat?: JSONSchema },
  ctx: ExtensionContext,
): Promise<{ response: AssistantMessage; advisorIterations: AdvisorIteration[] }>
```

Internally:

- **`custom`** (default in piorx today) — register an `advisor` `Tool` in `request.tools`, then run a tool-use loop: when assistant emits a `ToolCall` with `name === 'advisor'`, build the advisor's view (full transcript by default, or phase-curated if configured), make a side-call to the advisor model via `complete(phase.advisor.model, ...)`, push a `ToolResultMessage`, continue. **Each leg bills cleanly through pi-ai's flat `Usage`.** No `onPayload` plumbing required. Works cross-vendor.
- **`server`** — **the advisor block cannot live in `Context.tools[]`** even with declaration merging on the `Tool` type — pi-ai's `convertTools()` (`providers/anthropic.ts:1146-1169`) reads only `{ name, description, parameters }` and silently drops everything else, so a `{ type: 'advisor_20260301', ... }` entry would reach the wire as a regular custom tool. The integration point is therefore exclusively (i) `StreamOptions.onPayload` to splice the advisor tool block into the body, and (ii) `StreamOptions.headers` for `anthropic-beta: advisor-tool-2026-03-01` (the beta header cannot live in the body). Append the tool block *after* user-supplied tools so cache markers stay stable (§4.4). **Caveat:** pi-ai's flat `Usage` collapses `usage.iterations[]` into the executor totals at `providers/anthropic.ts:497-506` and `:631-648`, so per-iteration billing telemetry is lost until pi-ai is patched. Use this mode when (a) Anthropic-only round-trip optimization matters more than per-iteration cost attribution, or (b) the patch has landed.
- **`inline`** — make the advisor call first, prepend the result to `request.userMessage`, then a single executor call.

All three paths emit a uniform telemetry record: executor model, advisor model, advisor token counts, mode, latency, error code if any. Logged to `.pi/orchestra.log`. For `server` mode under unpatched pi-ai, the advisor token fields will be 0 (transparent loss, not silent corruption).

Defense-in-depth from Claude Code (§4.2, §4.3):

- Always send the beta header when advisor is enabled for *any* phase that touches shared history (server mode only — custom mode does not need the beta).
- When beta is not enabled, strip advisor blocks from messages before sending.
- Honor `PIORX_DISABLE_ADVISOR` env var as a kill switch.

### Phase C — synthesis worker, real (highest-ROI)

`src/synthesis/worker.ts:88-95` is currently:

```ts
export async function runSynthesisWorker(input: SynthesisWorkerInput): Promise<SynthesisWorkerOutput> {
  if (input.task_type === 'analysis-report') return buildAnalysisReport(input);
  return buildChangeSpec(input);
}
```

Replace with:

1. Translate `analysis-report-v1` and `change-spec-v1` runtime validators (`src/artifacts/schemas.ts`) into JSON Schema for `output_config.format`. Mechanical.
2. Replace stub with `runWithAdvisor()`:
   - executor model from `config.models.synthesis.executor`
   - advisor config from `config.models.synthesis.advisor` (default: `{ mode: 'server', model: 'claude-opus-4-7', maxUses: 1 for analysis-report / 2 for change-spec }`)
   - structured-output format
   - existing `assembleSynthesisPrompt(...)` output as user message
   - prepended `ADVISOR_TOOL_INSTRUCTIONS` (verbatim from §4.5) + the conciseness directive
3. Keep `validateWorkerOutput` as defense-in-depth but remove the JSON-extraction fallback path — structured outputs makes "malformed JSON" impossible at the boundary (per `docs/piorx-specification.md` §3.2).
4. Capture `usage.iterations[]` and log to `.pi/orchestra.log` per §4.7.

Why this order: the worker is a stub today; you're paying the build cost anyway. Plan-then-write is the textbook advisor fit. Anthropic's published gains (+2.7pp / -11.9% on SWE-bench) are on workloads of exactly this shape.

### Phase D — eval harness (parallelizable with C)

Capture 5–10 representative `evidence-bundle-v1` artifacts (already on disk under `.pi/artifacts/evidence-bundles/` after any real session). For each, run synthesis under N configurations:

| Config | Executor | Advisor mode | Advisor |
|---|---|---|---|
| Stub baseline (current) | — | — | — |
| Sonnet solo | claude-sonnet-4-6 | none | — |
| Haiku solo | claude-haiku-4-5 | none | — |
| Opus solo | claude-opus-4-7 | none | — |
| Sonnet + server-mode advisor (canonical) | claude-sonnet-4-6 | server | claude-opus-4-7, max_uses=2 |
| Haiku + server-mode advisor (cost floor) | claude-haiku-4-5 | server | claude-opus-4-7, max_uses=2 |
| Sonnet + custom-mode advisor (parity check) | claude-sonnet-4-6 | custom | claude-opus-4-7, max_uses=2 |

Score on:

- **(a)** schema validity rate
- **(b)** factual grounding (cite-back: every `findings` / `required_changes` line traceable to a span in the bundle)
- **(c)** cost per task (dollars from `usage.iterations`)
- **(d)** human eval on 3 samples per config

Anthropic's published gains are the order-of-magnitude expectation; piorx's deterministic-evidence input may shift the curve materially.

**Structural priors from third-party reports** (use as sanity checks, not targets — if the eval numbers are wildly inconsistent with these, suspect the harness, not the strategy):

- **Builder.io** reports ~80% cost reduction at near-Opus quality on multi-step coding tasks with `max_uses=3` as the empirical sweet spot. Maps directly to "Sonnet + Opus advisor" rows above.
- **Azuki Azusa** documents a real-world refactor where Sonnet+Opus-advisor caught three TypeScript issues (type-alias drift, scope leak, missing cleanup) that Sonnet-solo missed — a direct analog of `change-spec-v1` synthesis. Use this as the failure-mode probe in the human-eval sub-stage: if Sonnet-solo and Sonnet+advisor produce identical specs on a bundle that has a known TypeScript subtlety, the advisor isn't pulling its weight (or the bundle is too sanitized for the advisor to find anything).

### Phase E — retriever, rewrite onto `agentLoop` (smaller than first sketched)

`@mariozechner/pi-agent-core` v0.67.6 is **already installed** transitively via piorx's existing dependencies (see §5.5). It exports `agentLoop(prompts, context, config, signal?, streamFn?)` — a streaming, multi-turn, native-tool-use agent loop with parallel/sequential tool execution, abort handling, and lifecycle hooks. **No new dependency.**

The retriever's current architecture is a JSON-protocol re-implementation of exactly that:

- `src/retriever/agent.ts` runs N rounds, parses JSON for `actions[]` and `recommendation`, executes via `src/retriever/executor.ts`, serializes prior trace into the next user prompt.
- `src/retriever/agent-prompt.ts` builds the JSON prompt by hand.

Together ≈500 LOC. After rewrite onto `agentLoop`, ≈200 LOC:

- `tools = [readFile, searchContent, searchPaths, followImports]` — TypeBox-schema'd, sandboxed `execute()` reusing the existing `executor.ts` plus an `advise` tool in `custom` mode.
- `shouldStopAfterTurn` enforces the bounded budgets (`AgentLimits`: rounds, file reads, observation bytes).
- Streaming, abort, partial-message tracking come for free.
- The fallback synthesis path (`fallbackRecommendation` in `src/retriever/agent.ts`) becomes unreachable in the success case but stays as a parse-error safety net.

This is the only sequencing decision: defer until Phase C lands so the advisor integration in synthesis is the validation surface for `runWithAdvisor`. Once C is green, E is straightforward — the retriever's existing eval (rounds, file reads, observation bytes) is unchanged at the budget level.

If a stop-gap is needed before Phase C: bolt a `custom`-mode `advise` action onto the existing JSON loop as a 5th action. **It has no architectural value** other than time-to-first-eval. Skip unless the eval harness specifically needs retriever-with-advisor data before C is built.

### Phase F — execution worker (when product priority lines up)

Mirror C's structure: real model call, structured outputs for `execution-report-v1`, advisor with `max_uses: 2–3`, advisor-side caching enabled (long-horizon). The safety gate (`enforceConstraints` in `src/execution/worker.ts:52-56`) stays in front of any tool call.

If the executor is GPT (cross-vendor diversity), wire `custom`-mode advisor over Anthropic instead of `server`-mode.

### Phase G — interactive-session advisor (`pi.registerTool('advisor', ...)`) — half-day add-on

Once `runWithAdvisor` exists, exposing the advisor in the user's interactive piorx chat session is mostly cosmetic plumbing. Pattern:

```ts
pi.registerTool({
  name: 'advisor',
  description: ADVISOR_TOOL_INSTRUCTIONS,           // verbatim from §4.5
  parameters: Type.Object({}),                      // no-args by design
  execute: async (_args, { signal }) => {
    const transcript = await getMainLoopTranscript();   // pi-coding-agent surface
    const advice = await complete(advisorModel, {
      systemPrompt: 'You are an advisor. Respond in under 100 words, enumerated steps only.',
      messages: serializeTranscriptForAdvisor(transcript),
    }, { apiKey, signal });
    return { type: 'text', text: extractText(advice) };
  },
});

pi.registerFlag('advisor-mode', { type: 'string', default: 'custom' });
pi.registerFlag('advisor-model', { type: 'string', default: 'claude-opus-4-7' });
```

This is **independent of phase workers** — main-loop pi sees the advisor as a normal tool; the user can ask "use the advisor" naturally.

For `server`-mode parity in main-loop chat, additionally add a `pi.on('before_provider_request', ...)` hook that splices the `advisor_20260301` block into `payload.tools` — but that hook fires **only for main-loop API calls**, not for piorx's phase-internal `complete()` calls (per §5.4, the scope distinction). Phase workers must continue to handle their own advisor wiring via per-call options.

Defer Phase G until C lands so the half-day investment trails the foundation rather than blocking it.

---

## 8. Where the wins are concentrated — ranking

Ranked by ROI per engineering hour:

1. **Synthesis** (Phase C) — highest. Stub → real with advisor + structured outputs in one shot.
2. **Eval harness** (Phase D) — highest leverage per LOC. Tells you whether the next decision is "ship more advisor" or "scale back."
3. **Execution worker** (Phase F) — second-highest functional gain. Long-horizon agentic, textbook fit.
4. **Retriever rewrite** (Phase E) — third. Material cost/quality gain on the search-style workload (per BrowseComp data: Haiku+Opus-advisor at 41.2% vs 19.7% Haiku solo) but bigger refactor.
5. **Expansion `inline` advisor** — small win, only if you hit quality issues there.

Don't bother:

- Conductor / state machine: not LLM-reasoning.
- Stage 1 restatement: single-turn.
- Expansion: structured outputs is the real win; advisor is optional.

---

## 9. Risks, unknowns, validation milestones

### 9.1 Hard unknowns (resolve before committing)

1. ~~**Does pi-ai's `complete()` round-trip server-side `tools[]` + `betas[]` through the Anthropic provider?**~~ **Resolved.** `convertTools` at `providers/anthropic.ts:1146-1169` strips unknown fields — `Context.tools[]` cannot carry `type: 'advisor_20260301'`. `StreamOptions.onPayload` (`types.ts:109`, fires post-`buildParams` at `anthropic.ts:477-481`) does support body splicing. `StreamOptions.headers` (`types.ts:116-120`) supports the beta. Pi-ai's flat `Usage` (`types.ts:254-267`) collapses Anthropic's `usage.iterations[]` into the executor totals — this is the load-bearing limitation for `server` mode in piorx today.
2. **Is Sonnet 4.6 actually a valid advisor model at the Anthropic API server?** Claude Code's validator says yes; the public docs say Opus 4.7 only. **Prior shift (per §4.1):** GitHub issue [anthropics/claude-code#46148](https://github.com/anthropics/claude-code/issues/46148) shows the validator drifting in *both* directions vs the API matrix, so the API matrix is the authority. Predict 400; still curl-validate before committing.
3. **Token budget at the advisor for full evidence bundles.** Bundles can be hundreds of KiB. `prompt_too_long` is a real error code; chunked synthesis or summary-first synthesis becomes load-bearing if real bundles are too large.
4. **Does `output_config.format` interact cleanly with the advisor tool?** Not explicitly documented in the parts of the docs surveyed. Probe before basing the synthesis design on it.

### 9.2 Soft risks

- **Anthropic's published gains were on benchmarks, not your workload.** Plan for the eval harness to surface a smaller delta — or an inverted one — and decide what threshold makes the integration worth shipping.
- **Vendor coupling.** Adopting `server` mode hard-wires the affected phase to Anthropic. piorx today is provider-agnostic at the host level. `custom` mode preserves agnosticism — use it deliberately when cross-vendor matters.
- **Beta API churn risk.** `advisor_20260301` is beta. Build the integration so the tool definition and beta-header logic live in *one* place (`runWithAdvisor`) and is feature-flagged, not threaded through every dispatch service.
- **Non-determinism.** piorx's design philosophy is deterministic-by-default downstream of the assembler — same plan + index + repo state → byte-identical evidence-bundle. Synthesis is currently a deterministic stub. **Replacing the stub with a real model + advisor breaks byte-identical output for that phase**, which is the right trade for the quality lift but should be acknowledged: any reproducibility-bench, golden-output test, or replay-determinism assertion that touches synthesis output needs an explicit relaxation. Decide deliberately rather than stumble into it. (See MindStudio's writeup, §11.4, for the empirical observation that Opus reruns produce non-trivially different advice on the same input.)

### 9.3 Validation milestones

- **M1** — per-phase model config lands; existing tests still pass with default = current `ctx.model` for every phase. Eval: 498 tests still green.
- **M2** — synthesis worker calls Sonnet 4.6 with structured outputs (no advisor yet). Eval: schema validity ≥ stub, latency within tolerance.
- **M3** — synthesis worker adds `custom`-mode advisor (default). Eval: cost per task vs M2; quality on the eval harness; per-side-call billing visible in `.pi/orchestra.log`.
- **M4** — synthesis worker adds `server`-mode advisor via `onPayload`+`headers`. Eval: cost/quality should land within ~10% of `custom` mode on identical inputs. Confirms the `Usage.iterations` loss is the only meaningful difference.
- **M5** — retriever rewrite onto `agentLoop` with `custom`-mode advisor. Eval: `tests/retriever/agent.test.ts` re-targeted at the new loop with a real-API smoke run; bounded budgets unchanged.
- **M6** — execution worker built on the same template. Eval: end-to-end runs on saved change-specs.
- **M7** (optional) — interactive-session `pi.registerTool('advisor', ...)`. Eval: manual smoke test in piorx chat.

---

## 10. Pre-commitment probes (do these first, ~half-day total)

Before any committed work, two small experiments. (The third probe from earlier drafts — "does pi-ai round-trip server-mode tools through the Anthropic provider?" — has been resolved by direct source inspection; see §5.3.)

1. **Pair validation curl.**
   ```bash
   curl https://api.anthropic.com/v1/messages \
     -H "anthropic-beta: advisor-tool-2026-03-01" \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{
       "model": "claude-haiku-4-5",
       "max_tokens": 256,
       "tools": [{"type":"advisor_20260301","name":"advisor","model":"claude-sonnet-4-6"}],
       "messages": [{"role":"user","content":"plan a recursive-descent parser"}]
     }'
   ```
   If it succeeds, Sonnet-as-advisor is real and the docs are conservative. Document the truth in piorx's config validator.

2. **`custom`-mode advisor smoke test.** One-off script: Sonnet executor + Opus advisor on a saved evidence bundle, custom-tool path through `complete()`'s native `Tool[]` surface. Confirms latency, error handling, per-side-call billing telemetry. **This is the canonical path piorx will ship on**, so a smoke test here de-risks Phase C directly. ~2 hours.

   Optional third probe — only if `server` mode is on the near-term roadmap: a 1-hour script that issues a `complete()` with `StreamOptions.onPayload` splicing the advisor tool block into `payload.tools` and `StreamOptions.headers` adding the beta. Confirm the wire-level body matches expectations and the advisor block round-trips. Skip until pi-ai's `Usage.iterations` is patched, since `server` mode is not the first integration target.

### 10.5 Post-probe decision tree

Map probe outcomes to mode selection per phase. This makes Phase A's config validator and Phase B's `runWithAdvisor` defaults *deterministic functions of probe results*, not committee decisions:

| Probe outcome | Synthesis | Retriever (post-rewrite) | Execution |
|---|---|---|---|
| **Probe 1 — Sonnet-advisor invalid (predicted)** | `custom` + Opus 4.7 advisor | `custom` + Opus 4.7 advisor | `custom` + Opus 4.7 advisor (works for Sonnet or GPT executor) |
| **Probe 1 — Sonnet-advisor valid (surprise)** | `custom` + Sonnet 4.6 advisor for cost-sensitive runs; keep Opus 4.7 as default | unchanged (Opus advisor preferred) | unchanged |
| **Probe 2 — `custom` smoke test fails** | Block all phase work until root-caused — pi-ai's `Tool` surface is the canonical path; if it's broken, the integration is broken | same | same |
| **Probe 2 — `custom` smoke test green** | Ship Phase C on `custom` | Ship Phase E on `custom` | Ship Phase F on `custom` |
| **Optional probe 3 — `onPayload` brittle across pi-ai versions** | Defer `server` mode indefinitely; revisit only if pi-ai patches `Usage.iterations` *and* the brittleness is fixed | unchanged | unchanged |
| **Optional probe 3 — `onPayload` solid + pi-ai `Usage.iterations` patch lands** | Optionally migrate synthesis to `server` for round-trip optimization; A/B vs `custom` (M4 in §9.3) | optional `server` migration | optional `server` migration |
| **Token-budget probe (informal, during M3) — bundles `prompt_too_long` at advisor** | `contextStrategy: 'phase-curated'` becomes load-bearing; alternatively switch to summary-first synthesis where the executor pre-condenses before calling advisor | n/a (retriever inputs are bounded by §5.2 limits already) | unchanged |

This is the operational answer to §6.1's "✗ not today" cell on `server` mode: the answer is *conditional* — `custom` until probes 2 and 3 both come back green and pi-ai is patched, then optional migration.

---

## 11. Appendix — concrete artifacts

### 11.1 Tool block (drop-in for `server`-mode synthesis)

```ts
const advisorTool = config.advisor && config.advisor.mode === 'server' ? {
  type: 'advisor_20260301',
  name: 'advisor',
  model: config.advisor.model,            // 'claude-opus-4-7' canonical
  max_uses: config.advisor.maxUses ?? 2,
  ...(config.advisor.caching === 'ephemeral-5m'
    ? { caching: { type: 'ephemeral', ttl: '5m' } }
    : config.advisor.caching === 'ephemeral-1h'
    ? { caching: { type: 'ephemeral', ttl: '1h' } }
    : {}),
} : null;
```

### 11.2 Cost telemetry sketch

After each model call, append to `.pi/orchestra.log`:

```ts
await logEvent('model.usage', {
  phase,                                      // 'synthesis' | 'retriever' | ...
  artifact_id,                                // produced artifact, if any
  advisor_mode: config.advisor?.mode ?? 'none',
  iterations: response.usage?.iterations ?? [],
  top_input_tokens: response.usage?.input_tokens ?? 0,
  top_output_tokens: response.usage?.output_tokens ?? 0,
});
```

The eval harness reads this back and joins on `phase` + `artifact_id` to compute cost-per-task. Don't pre-aggregate — keep the iteration array intact for post-hoc rate-table changes.

### 11.3 `custom`-mode tool registration sketch

```ts
import { Type } from '@sinclair/typebox';

const ADVISOR_TOOL: Tool = {
  name: 'advisor',
  description: 'Consult a stronger reviewer model. Takes no parameters; full transcript is forwarded automatically.',
  parameters: Type.Object({}),
};

async function runCustomModeLoop(
  phase: PhaseModelConfig,
  ctx: ExtensionContext,
  request: { systemPrompt: string; userMessage: string },
): Promise<AssistantMessage> {
  const messages: Message[] = [{ role: 'user', content: request.userMessage, timestamp: Date.now() }];
  for (;;) {
    const resp = await complete(phase.executor.model, {
      systemPrompt: request.systemPrompt,
      messages,
      tools: [ADVISOR_TOOL],
    }, { /* auth */ });

    messages.push(resp);
    if (resp.stopReason !== 'toolUse') return resp;

    for (const part of resp.content) {
      if (part.type !== 'toolCall' || part.name !== 'advisor') continue;
      const advice = await complete(phase.advisor!.model, {
        systemPrompt: 'You are an advisor. Respond in under 100 words, enumerated steps only.',
        messages: serializeTranscriptForAdvisor(messages),    // full or phase-curated
      }, { /* auth */ });
      messages.push({
        role: 'toolResult', toolCallId: part.id, toolName: 'advisor',
        content: [{ type: 'text', text: extractText(advice) }],
        isError: false, timestamp: Date.now(),
      });
    }
  }
}
```

### 11.4 Third-party reports and ecosystem signal

Independent commentary worth weighing alongside Anthropic's own benchmarks. None of these are load-bearing for the recommendation, but they're useful priors for the eval harness (§7 Phase D) and a sanity check on the strategic direction:

- [**Builder.io — The Claude Advisor Pattern**](https://www.builder.io/blog/the-claude-advisor-pattern) — frames the pattern as ~80% cost reduction at near-Opus quality on multi-step coding tasks, with `max_uses=3` as the empirical sweet spot. Maps to piorx's "Sonnet + Opus advisor" synthesis configuration.
- [**Azuki Azusa — claude-advisor-tool**](https://azukiazusa.dev/en/blog/claude-advisor-tool/) — concrete refactor case study where Sonnet+Opus-advisor caught three TypeScript issues (type-alias drift, scope leak, missing cleanup) that Sonnet-solo missed. Direct analog of piorx's `change-spec-v1` synthesis job; cite as the failure-mode probe in the human-eval sub-stage of Phase D.
- [**MindStudio — Claude Code Advisor Strategy explainer**](https://www.mindstudio.ai/blog/claude-code-advisor-strategy-opus-sonnet-haiku) — flags the **non-determinism caveat**: Opus may advise differently on identical reruns. Source for the reproducibility risk in §9.2.
- [**LiteLLM — Anthropic advisor tool docs**](https://docs.litellm.ai/docs/completion/anthropic_advisor_tool) — ecosystem signal that the pattern has SDK-level support outside Anthropic's own clients, lowering long-term beta-churn risk.
- [**anthropics/claude-code#46148**](https://github.com/anthropics/claude-code/issues/46148) — *"Advisor tool: Haiku 4.5 executor rejected by CLI despite API docs listing it as valid pair."* The validator-vs-API discrepancy (referenced in §4.1, §9.1) — primary evidence that the API matrix is the authority.

---

## 12. Bottom line

The pattern and the API are decoupled. piorx should adopt both — but the mode hierarchy is reversed from a naive Anthropic-first reading:

- **`custom` mode** is the **default** for piorx today. It works with no host changes, preserves per-side-call billing through pi-ai's flat `Usage`, is cross-vendor compatible, and is supported by pi-ai's existing `Tool[]` / `ToolCall` / `ToolResultMessage` surface (no body splicing, no header injection).
- **`server` mode** is reachable via `StreamOptions.onPayload` + `StreamOptions.headers`, but pi-ai's flat `Usage` collapses Anthropic's `usage.iterations[]` into the executor totals — per-iteration billing detail is lost. Worth using when (a) the round-trip win matters more than per-iteration cost attribution, or (b) pi-ai has been patched to surface `Usage.iterations`.
- **`inline` mode** when the advisor always helps and there's no judgment to be made about timing.

The user's hypothesis stands, with one expansion: cross-vendor execution does not forfeit the pattern. GPT-5.4-as-executor + Sonnet/Opus-as-advisor is fully implementable today on top of pi-ai's existing surface.

Land per-phase model config and `runWithAdvisor` first. Build the real synthesis worker with `custom`-mode advisor + structured outputs second. Eval. Then decide whether the retriever rewrite onto `agentLoop` (already in installed deps) and the execution worker get the same treatment based on numbers, not intuition. The `pi.registerTool('advisor', ...)` interactive-session bonus is a half-day add-on once `runWithAdvisor` exists.

---

## Sources

**Anthropic primary**

- [Advisor tool — Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
- [The Advisor Strategy — claude.com blog](https://claude.com/blog/the-advisor-strategy)
- [Beta headers — Claude API Docs](https://docs.anthropic.com/en/api/beta-headers)
- [Pricing — Claude API Docs](https://platform.claude.com/docs/en/about-claude/pricing)

**Third-party reports and ecosystem signal** (see also §11.4)

- [Builder.io — The Claude Advisor Pattern](https://www.builder.io/blog/the-claude-advisor-pattern) — ~80% cost reduction at near-Opus quality; `max_uses=3` sweet spot
- [Azuki Azusa — claude-advisor-tool](https://azukiazusa.dev/en/blog/claude-advisor-tool/) — refactor case study; TypeScript subtleties caught by Opus advisor
- [MindStudio — Claude Code Advisor Strategy explainer](https://www.mindstudio.ai/blog/claude-code-advisor-strategy-opus-sonnet-haiku) — non-determinism caveat
- [LiteLLM — Anthropic advisor tool](https://docs.litellm.ai/docs/completion/anthropic_advisor_tool) — SDK-level support outside Anthropic's own clients
- [GitHub: anthropics/claude-code#46148](https://github.com/anthropics/claude-code/issues/46148) — validator vs API matrix discrepancy

**Source code (read directly during this assessment)**

- Claude Code source (production reference implementation):
  - `~/code/public/claude-code/constants/betas.ts:31`
  - `~/code/public/claude-code/utils/advisor.ts:1-145`
  - `~/code/public/claude-code/services/api/claude.ts:1060-1395`
  - `~/code/public/claude-code/utils/messages.ts:5463-5464`
- piorx source:
  - `extensions/conductor-extension.ts:86-130` (`getModelText`)
  - `extensions/conductor-extension.ts:391-393` (`makeRetrieverAgentModel`)
  - `src/synthesis/worker.ts:88-152` (current stub)
  - `src/execution/worker.ts:84-130` (current stub)
  - `src/retriever/agent.ts:395-517` (bounded loop)
  - `node_modules/@mariozechner/pi-ai/dist/types.d.ts` (host SDK surface, installed v0.67.6)
  - `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` (extension API)
  - `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.d.ts` (already-installed agentLoop)
  - `docs/piorx-specification.md` (as-built spec)
  - `docs/conductor-overview.md` (workflow narrative)
- pi-mono source (live reference; renamed `@earendil-works/*` v0.74.0 — same shape as installed `@mariozechner/*` v0.67.6):
  - `~/code/sks/pi-mono/packages/coding-agent/src/core/extensions/types.ts:611-614` (`BeforeProviderRequestEvent`)
  - `~/code/sks/pi-mono/packages/coding-agent/src/core/extensions/types.ts:426-473` (`ToolDefinition`)
  - `~/code/sks/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1089-1133` (`pi.on(...)` and `pi.registerTool` overloads)
  - `~/code/sks/pi-mono/packages/ai/src/types.ts:325-337` (`Tool` and `Context` shapes)
  - `~/code/sks/pi-mono/packages/ai/src/types.ts:109,116-120` (`StreamOptions.onPayload` and `.headers`)
  - `~/code/sks/pi-mono/packages/ai/src/types.ts:254-267` (flat `Usage` — load-bearing limitation for `server` mode)
  - `~/code/sks/pi-mono/packages/ai/src/providers/anthropic.ts:1146-1169` (`convertTools` strips unknown fields)
  - `~/code/sks/pi-mono/packages/ai/src/providers/anthropic.ts:477-481` (`onPayload` invocation site)
  - `~/code/sks/pi-mono/packages/ai/src/providers/anthropic.ts:497-506,631-648` (Anthropic `usage.iterations[]` collapse)
  - `~/code/sks/pi-mono/packages/agent/src/agent-loop.ts:1-695` (`agentLoop`, `AgentLoopConfig` hooks, event stream)
