# Batch API Support Assessment for pi-orchestra

## Summary

**pi-orchestra does not currently implement provider-native batch API calls.**

The current codebase uses:

- direct synchronous model calls for conductor restatement/expansion
- local retrieval logic
- deterministic evidence assembly
- a stubbed synthesis worker rather than a real model backend

The architecture/specification mentions batch-capable expansion and synthesis as intended execution modes, but the implementation has not yet added batch job submission, polling, persistence, or result ingestion.

## Current State

### Implemented today

- **Direct model calls** via `complete(...)`
  - `extensions/conductor-extension.ts`
  - used by `getModelText()`, `restateWithModel()`, and `expandWithModel()`
- **Retrieval dispatch** is local and synchronous
  - `src/services/retrieval-dispatch.ts`
  - `src/retriever/worker.ts`
- **Synthesis** is currently a deterministic stub
  - `src/synthesis/worker.ts`
  - comment says real model-backed worker is deferred

### Evidence from docs

- `docs/specification/00-overview.md`
  - refers to a “slow-cheap model/batch” for expansion and a “model or batch” for synthesis
- `docs/specification/02-pi-architecture.md`
  - lists “subagents / batch tools” and describes expansion/synthesis as batch or async tasks
- `implementation-phase-1.md`
  - explicitly defers “async queueing / batch execution complexity”

## Conclusion

### Spec status

Batch support is **part of the intended architecture**.

### Implementation status

Batch support is **not currently implemented**.

---

# What would be needed to implement it

## 1. Introduce a model job abstraction

Today the system assumes request/response execution.

Add an abstraction that supports both immediate and asynchronous execution, for example:

```ts
type ModelJobRunner = {
  runImmediate(request: ModelRequest): Promise<ModelResponse>;
  submitBatch(requests: ModelRequest[]): Promise<BatchSubmitResult>;
  getBatchStatus(batchId: string): Promise<BatchStatusResult>;
  getBatchResults(batchId: string): Promise<BatchResult[]>;
};
```

Likely new files:

- `src/models/job-runner.ts`
- `src/models/batch-provider.ts`
- `src/models/providers/openai-batch.ts`

## 2. Add persisted batch job tracking

Because provider batch APIs are asynchronous, orchestra must persist job state.

Recommended new artifact or state types:

- `model-batch-job-v1`
- optional `model-request-v1`

Track at least:

- provider name
- batch id
- individual request ids / custom ids
- current status
- created/submitted/completed timestamps
- related orchestra stage
- output artifact ids
- error details

## 3. Make stages batch-capable

Best candidates:

- **Stage 2 expansion**
- **Stage 6 synthesis**

Poor candidates:

- **Stage 1 restatement** — interactive, latency-sensitive
- **Stage 3 retrieval** — local worker, not remote model work
- **Stage 5 evidence assembly** — deterministic local service
- **Stage 7 execution** — local agent/tool flow

## 4. Support queued/waiting states in orchestration

The current stage flow assumes completion in one pass.

You would need support for states such as:

- queued
- processing
- waiting-for-batch
- completed
- failed

This likely affects:

- `extensions/conductor-extension.ts`
- `src/conductor/stage-machine.ts`
- session state persistence

## 5. Add provider-specific adapters

For a real provider batch API implementation, the adapter should handle:

- building request payloads or JSONL
- submitting jobs
- polling job status
- fetching outputs
- mapping results back by `custom_id`
- normalizing provider errors

## 6. Validate and ingest results deterministically

Once batch outputs are retrieved:

- parse result payloads
- validate JSON shape
- validate artifact schema
- persist orchestra artifacts
- transition the stage machine forward only after successful ingestion

This is especially important for:

- `intent-spec-v1`
- `analysis-report-v1`
- `change-spec-v1`

---

# Suggested implementation plan

## Phase 1: immediate model service abstraction

Refactor current direct `complete(...)` usage behind a single service layer.

Primary target:

- `extensions/conductor-extension.ts`

Goal:

- preserve current behavior
- create one entry point for future batch-capable model execution

## Phase 2: real synthesis backend in immediate mode

Replace the stub synthesis worker with an actual model-backed implementation first.

Targets:

- `src/synthesis/worker.ts`
- `src/services/synthesis-dispatch.ts`

Goal:

- prove model request/response path
- keep validation/storage contracts stable

## Phase 3: add batch job artifacts and polling

Implement durable job records and resume-safe polling.

Targets:

- artifact store/types/schemas
- session state
- new batch provider module

Goal:

- support async completion and restart-safe orchestration

## Phase 4: batch-capable synthesis dispatch

Extend synthesis dispatch to return either immediate success or queued status.

Example contract:

```ts
type SynthesisDispatchResult =
  | { status: 'success'; synthesis_artifact_id: string; message: string }
  | { status: 'queued'; batch_job_id: string; message: string }
  | { status: 'error'; synthesis_artifact_id: null; message: string };
```

## Phase 5: batch expansion support

After synthesis works, add the same pattern to expansion.

Targets:

- `expandWithModel()`
- expansion controller orchestration

## Phase 6: conductor UX and recovery

Add clear runtime UX for:

- batch submitted
- waiting for completion
- batch completed
- batch failed
- retry/fallback paths

---

# Concrete files likely to change

## Existing files

- `extensions/conductor-extension.ts`
- `src/conductor/stage-machine.ts`
- `src/runtime/session-state.ts`
- `src/services/synthesis-dispatch.ts`
- `src/synthesis/worker.ts`
- possibly `src/conductor/expansion.ts`

## New files

- `src/models/job-runner.ts`
- `src/models/batch-provider.ts`
- `src/models/providers/openai-batch.ts`
- `src/artifacts/types.ts` additions for batch job artifacts
- `src/artifacts/schemas.ts` additions for batch job validation

---

# Recommended scope order

1. **Immediate-mode synthesis using a real model**
2. **Batch-capable synthesis dispatch**
3. **Persisted batch job artifacts and polling**
4. **Expansion batch support**
5. **Conductor waiting/resume UX**

This sequence minimizes risk and keeps interactive restatement simple.

---

# Bottom line

**No, pi-orchestra does not currently include batch API calls.**

To implement them, the project needs:

- a batch-capable model execution layer
- persistent batch job tracking
- provider adapter(s)
- polling/result ingestion
- queued/waiting orchestration support
- schema-validated artifact creation after completion
