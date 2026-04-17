# Artifacts and Schemas

This document defines the canonical artifacts exchanged between orchestration stages.

## Naming

All artifacts are versioned with `-v1` suffixes.

## 1. `intent-capture-v1`

Captured from the user before any restatement. If the raw intent included inline `<file name="...">...</file>` blocks, Stage 1 strips those blocks out of the cleaned intent and records a `intent_file_refs` entry per file.

```json
{
  "artifact_type": "intent-capture-v1",
  "artifact_id": "intent_001",
  "user_intent_verbatim": "I want to understand how model restore works and maybe change it. <file name=\"src/core/model-resolver.ts\">...</file>",
  "cleaned_user_intent": "I want to understand how model restore works and maybe change it.\n[Included file: src/core/model-resolver.ts]",
  "tagged_files": ["src/core/model-resolver.ts"],
  "intent_file_refs": [{ "path": "src/core/model-resolver.ts", "source": "inline" }],
  "timestamp": "2026-04-09T00:00:00Z"
}
```

### Fields

- `artifact_type`: fixed string
- `artifact_id`: unique ID
- `user_intent_verbatim`: exact user text (including inline file blocks, if any)
- `cleaned_user_intent`: text with inline file bodies stripped; downstream stages should use this
- `tagged_files`: files explicitly tagged or embedded in the user input
- `intent_file_refs` (optional): per-file provenance records — `source` is `"inline"` (body embedded in the message), `"disk"` (referenced by path and read from disk during restatement context build), or `"reference-only"` (neither inline nor readable, but preserved for retrieval boosting)
- `timestamp`: capture time

### Rules

- Only files explicitly referenced in the initial user input may be read during Stage 1. There is no general conductor-side file-reading capability.
- Downstream stages (expansion, retrieval prompt assembly) use `cleaned_user_intent`, not `user_intent_verbatim`, so large inline file bodies do not leak into retrieval prompts.

---

## 2. `intent-restatement-v1`

Produced by the conductor and approved by the user.

```json
{
  "artifact_type": "intent-restatement-v1",
  "artifact_id": "restatement_001",
  "intent_capture_id": "intent_001",
  "user_intent_verbatim": "I want to understand how model restore works and maybe change it.",
  "restated_intent": "You want to understand the current model-restore flow and possibly prepare for modifying it.",
  "approved": true,
  "expand_requested": true,
  "approval_turns": 1
}
```

### Fields

- `intent_capture_id`: parent artifact
- `restated_intent`: simple restatement only, not an expansion
- `approved`: whether the user confirmed correctness
- `expand_requested`: whether the user wants Stage 2 expansion
- `approval_turns`: number of approval-loop turns required

---

## 3. `expansion-input-v1`

Deterministic payload sent to the expansion model/batch.

```json
{
  "artifact_type": "expansion-input-v1",
  "artifact_id": "expand_in_001",
  "intent_capture_id": "intent_001",
  "intent_restatement_id": "restatement_001",
  "user_intent_verbatim": "I want to understand how model restore works and maybe change it.",
  "approved_restated_intent": "You want to understand the current model-restore flow and possibly prepare for modifying it.",
  "included_files": [
    {
      "path": "docs/models.md",
      "reason": "user-tagged"
    },
    {
      "path": "AGENTS.md",
      "reason": "user-approved project doc"
    }
  ]
}
```

### Inclusion rules

- All user-tagged files must be included.
- If there are no tagged files and project docs exist (`README.md`, `AGENTS.md`, `CLAUDE.md`), the user must be asked whether any/all should be included.

---

## 4. `intent-spec-v1`

Produced by the slow-cheap expansion stage and approved by the user.

```json
{
  "artifact_type": "intent-spec-v1",
  "artifact_id": "spec_001",
  "expansion_input_id": "expand_in_001",
  "user_intent_verbatim": "I want to understand how model restore works and maybe change it.",
  "approved_restated_intent": "You want to understand the current model-restore flow and possibly prepare for modifying it.",
  "expanded_spec": {
    "objective": "Understand session model restore behavior and identify safe modification points",
    "deliverables": [
      "architecture explanation",
      "relevant files and symbols",
      "modification boundaries",
      "risks and fallback behavior"
    ],
    "constraints": ["do not change code yet", "focus on restore and fallback behavior"],
    "retrieval_focus": [
      "restore entrypoints",
      "fallback logic",
      "auth checks",
      "default provider/model selection"
    ],
    "open_questions": ["should unknown custom model ids be preserved?"]
  },
  "approved": true
}
```

---

## 5. `retrieval-index-v1`

Normalized retriever output. **Structural-only** — no raw file bodies appear anywhere in this artifact. It carries selection tiers, strategy metadata, and the retriever-authored default evidence recommendation.

```json
{
  "artifact_type": "retrieval-index-v1",
  "artifact_id": "retrieval_001",
  "intent_capture_id": "intent_001",
  "intent_restatement_id": "restatement_001",
  "intent_spec_id": "spec_001",
  "query": "Understand model restore flow and modification boundaries",
  "confidence": "high",
  "strategy_summary": "scout terms: restore(8), fallback(6); selected=3/8 reserve=2/4; tagged-boosted=1",
  "scout_terms": ["restore", "fallback", "session", "provider"],
  "files": [
    {
      "file_id": "f1",
      "path": "/abs/path/src/core/model-resolver.ts",
      "why_relevant": "Contains restore and fallback logic",
      "file_summary": "Model resolution and restore fallback behavior",
      "ast_skeleton": [
        "const defaultModelPerProvider",
        "function resolveCliModel(...)",
        "function findInitialModel(...)",
        "function restoreModelFromSession(...)"
      ],
      "recommended_expansion": "span",
      "expansion_reason": "Fallback logic is concentrated in one function",
      "selection_tier": "selected",
      "selection_reason": "tagged · path match on model-resolver; relevant symbols: restoreModelFromSession",
      "default_evidence_mode": "spans",
      "symbols": [
        {
          "symbol_id": "s1",
          "kind": "function",
          "name": "restoreModelFromSession",
          "start": 420,
          "count": 70,
          "summary": "Restores a saved model or falls back when unavailable",
          "role_in_system": "session restore entrypoint",
          "depends_on": ["modelRegistry.find", "modelRegistry.hasConfiguredAuth"],
          "used_by": ["session startup restore flow"],
          "relevance": "high",
          "change_likelihood": "high",
          "expansion_priority": "high",
          "recommended_expansion": "span",
          "expansion_reason": "Likely contains the exact restore decision logic",
          "selected_by_default": true,
          "default_neighbor_lines": 3,
          "selection_reason": "retriever agent identified as the restore decision point"
        }
      ]
    },
    {
      "file_id": "f2",
      "path": "/abs/path/src/core/model-registry.ts",
      "why_relevant": "Auth-check helper used by restore",
      "file_summary": "Model registry lookup + auth check",
      "ast_skeleton": ["function hasConfiguredAuth(...)", "function find(...)"],
      "recommended_expansion": "none",
      "expansion_reason": "Peripheral to current objective",
      "selection_tier": "reserve",
      "selection_reason": "implementation · weak keyword match only",
      "default_evidence_mode": "exclude",
      "symbols": []
    }
  ],
  "cross_file_findings": ["Restore behavior depends on registry availability and auth"],
  "gaps": ["Need auth resolution details from model-registry.ts"],
  "followup_queries": ["model registry auth configured availability"],
  "recommended_evidence": {
    "files": [
      {
        "file_id": "f1",
        "include_ast_skeleton": true,
        "include_retriever_summary": true,
        "include_entire_file": false,
        "spans": [{ "symbol_id": "s1", "include_span": true, "neighbor_lines": 3 }]
      }
    ],
    "include_cross_file_findings": true,
    "include_gaps": false,
    "include_followup_queries": false
  }
}
```

### Key fields

- `strategy_summary` — one-line description of how the scout narrowed the repo.
- `scout_terms` — curated terms the scout used (ordered by weight).
- `selection_tier` on each file — `"selected"` (in the default plan) or `"reserve"` (near-threshold; excluded from the default plan unless the conductor promotes it).
- `default_evidence_mode` on each file — retriever-authored hint: `exclude | summary | summary+ast | spans | whole_file`.
- Each symbol carries `selected_by_default`, `default_neighbor_lines`, `selection_reason`.
- `recommended_evidence` — the retriever-authored default plan. `createRecommendedEvidencePlan` copies this straight into `evidence-plan-v1`.

### Rules

- The conductor may read all of this artifact.
- The artifact is structural-only: `raw_content`, file bodies, or any other raw source must not appear. Validators reject artifacts that contain raw content.
- The conductor must not use this artifact to reconstruct source — it only exposes summaries, skeletons, and span metadata.
- The retriever authors `recommended_evidence`; the conductor's default Stage 4 behavior is to use it as-is.

---

## 6. `evidence-plan-v1`

The default plan is **authored by the retriever** and assembled by the conductor through `createRecommendedEvidencePlan`: `recommended_evidence` is copied byte-for-byte into `selection`, and the three include flags flow through unchanged. Reserve-tier files are excluded from the default plan unless the conductor explicitly promotes them via a narrow override.

The plan embeds the retriever response reference unchanged and declares how the evidence assembler should resolve it.

```json
{
  "artifact_type": "evidence-plan-v1",
  "artifact_id": "plan_001",
  "retrieval_index": {
    "artifact_type": "retrieval-index-v1",
    "artifact_id": "retrieval_001"
  },
  "selection": {
    "files": [
      {
        "file_id": "f1",
        "include_ast_skeleton": true,
        "include_retriever_summary": true,
        "include_entire_file": false,
        "spans": [
          {
            "symbol_id": "s1",
            "include_span": true,
            "neighbor_lines": 8
          }
        ]
      }
    ],
    "include_cross_file_findings": true,
    "include_gaps": false,
    "include_followup_queries": false
  },
  "assembly_options": {
    "max_total_lines": 1200,
    "max_estimated_tokens": 12000,
    "dedupe_overlapping_spans": true,
    "span_merge_strategy": "merge_if_overlapping"
  },
  "prompt_sections": {
    "include_intent_context": true,
    "include_structural_context": true,
    "include_raw_evidence": true
  },
  "target_task": {
    "type": "change-spec",
    "task_label": "prepare modification handoff"
  }
}
```

### Key rules

- The conductor must pass the full retriever response unchanged. The evidence assembler is responsible for deterministic resolution and formatting.
- The conductor's default path is `createRecommendedEvidencePlan(retrieval_index)` — no file-level heuristics, no summary-for-all fallback.
- Conductor overrides are narrow and deterministic. Valid operations: `promote_file`, `demote_file`, `set_file_mode`, `include_symbol`, `exclude_symbol`, `set_neighbor_lines`, `toggle_cross_file_findings`, `toggle_gaps`, `toggle_followup_queries`. Overrides validate every file_id / symbol_id against the retrieval artifact and throw loudly on invalid references.

---

## 7. `evidence-bundle-v1`

Produced deterministically by the evidence assembler.

```json
{
  "artifact_type": "evidence-bundle-v1",
  "artifact_id": "bundle_001",
  "evidence_plan_id": "plan_001",
  "intent_context": {
    "user_intent_verbatim": "I want to understand how model restore works and maybe change it.",
    "approved_restated_intent": "You want to understand the current model-restore flow and possibly prepare for modifying it.",
    "intent_spec_id": "spec_001"
  },
  "structural_context": {
    "files": [
      {
        "path": "/abs/path/src/core/model-resolver.ts",
        "file_summary": "Model resolution and restore fallback behavior",
        "ast_skeleton": ["const defaultModelPerProvider", "function restoreModelFromSession(...)"],
        "symbols": [
          {
            "name": "restoreModelFromSession",
            "start": 420,
            "count": 70,
            "summary": "Restores a saved model or falls back when unavailable"
          }
        ]
      }
    ],
    "cross_file_findings": ["Restore behavior depends on registry availability and auth"]
  },
  "raw_evidence": [
    {
      "path": "/abs/path/src/core/model-resolver.ts",
      "kind": "span",
      "label": "restoreModelFromSession",
      "start": 412,
      "count": 86,
      "content": "..."
    }
  ],
  "stats": {
    "files": 1,
    "spans": 1,
    "full_files": 0,
    "total_lines": 86,
    "estimated_tokens": 1800
  }
}
```

### Bundle construction rules

- Structural context is included per `evidence-plan-v1`.
- Raw evidence is included per `evidence-plan-v1`.
- The assembler may merge overlapping spans only if instructed.
- The assembler may not add judgment or choose new files beyond the plan.

---

## 8. `analysis-report-v1`

For explanatory and planning outputs.

```json
{
  "artifact_type": "analysis-report-v1",
  "artifact_id": "analysis_001",
  "evidence_bundle_id": "bundle_001",
  "summary": "Model restore first attempts exact restoration and then falls back when auth or availability checks fail.",
  "findings": [
    "restoreModelFromSession is the restore entrypoint",
    "fallback selection depends on provider availability and auth"
  ],
  "risks": ["changing fallback semantics may affect session continuity"],
  "recommended_next_steps": ["inspect model-registry auth path", "prepare a focused change spec"]
}
```

---

## 9. `change-spec-v1`

For execution-oriented synthesis outputs.

```json
{
  "artifact_type": "change-spec-v1",
  "artifact_id": "change_001",
  "evidence_bundle_id": "bundle_001",
  "change_goal": "Preserve valid custom model ids during session restore when provider auth exists",
  "summary": "Adjust restore flow to allow custom model restoration under known providers without changing other fallback behavior.",
  "edits": [
    {
      "path": "/abs/path/src/core/model-resolver.ts",
      "target": {
        "kind": "function",
        "name": "restoreModelFromSession",
        "start": 420,
        "count": 70
      },
      "intent": "Permit custom model restoration under known providers when auth is configured",
      "required_changes": [
        "Check provider availability before rejecting unknown model IDs",
        "Construct a custom-model fallback object when appropriate",
        "Preserve existing behavior for missing auth"
      ],
      "constraints": [
        "Do not alter CLI model resolution",
        "Do not change default provider model selection"
      ]
    }
  ],
  "tests": [
    "restore known model with auth",
    "restore unknown custom model under known provider with auth",
    "fallback when auth is absent"
  ],
  "acceptance_criteria": [
    "session restore succeeds for valid custom provider/model combinations",
    "existing built-in restore behavior remains unchanged"
  ]
}
```

---

## 10. `execution-report-v1`

Produced by the local execution agent.

```json
{
  "artifact_type": "execution-report-v1",
  "artifact_id": "exec_001",
  "change_spec_id": "change_001",
  "status": "completed",
  "modified_files": [
    "/abs/path/src/core/model-resolver.ts",
    "/abs/path/test/model-resolver.test.ts"
  ],
  "validation": {
    "commands": ["npm test -- model-resolver"],
    "passed": true
  },
  "notes": ["Adjusted restore logic and added regression tests"]
}
```

---

## 11. `recursive-intent-v1`

Allows synthesis output to become a new user intent and restart Stage 1.

```json
{
  "artifact_type": "recursive-intent-v1",
  "artifact_id": "recur_001",
  "source_artifact_type": "analysis-report-v1",
  "source_artifact_id": "analysis_001",
  "new_user_intent_verbatim": "Using the previous analysis, prepare a concrete change specification for the restore flow.",
  "restart_stage": 1
}
```

### Rule

Whenever a synthesis output becomes a new intent, the pipeline must restart at **Stage 1**, not skip directly to retrieval.
