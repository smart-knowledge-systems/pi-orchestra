# Artifacts and Schemas

This document defines the canonical artifacts exchanged between orchestration stages.

## Naming

All artifacts are versioned with `-v1` suffixes.

## 1. `intent-capture-v1`

Captured from the user before any restatement.

```json
{
  "artifact_type": "intent-capture-v1",
  "artifact_id": "intent_001",
  "user_intent_verbatim": "I want to understand how model restore works and maybe change it.",
  "tagged_files": ["docs/models.md", "src/core/model-resolver.ts"],
  "timestamp": "2026-04-09T00:00:00Z"
}
```

### Fields

- `artifact_type`: fixed string
- `artifact_id`: unique ID
- `user_intent_verbatim`: exact user text
- `tagged_files`: files explicitly tagged in the user input
- `timestamp`: capture time

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

Full retriever output. This is passed to the evidence assembler unchanged.

```json
{
  "artifact_type": "retrieval-index-v1",
  "artifact_id": "retrieval_001",
  "intent_capture_id": "intent_001",
  "intent_restatement_id": "restatement_001",
  "intent_spec_id": "spec_001",
  "query": "Understand model restore flow and modification boundaries",
  "confidence": "high",
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
          "expansion_reason": "Likely contains the exact restore decision logic"
        }
      ]
    }
  ],
  "cross_file_findings": ["Restore behavior depends on registry availability and auth"],
  "gaps": ["Need auth resolution details from model-registry.ts"],
  "followup_queries": ["model registry auth configured availability"]
}
```

### Notes

- The conductor may read all of this artifact.
- The conductor may not use this artifact to read raw code; it may only use it to make evidence-selection decisions.

---

## 6. `evidence-plan-v1`

Produced by the conductor. It embeds the **full retriever response unchanged** and declares how the evidence assembler should resolve it.

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

### Key rule

The conductor must pass the full retriever response unchanged. The evidence assembler is responsible for deterministic resolution and formatting.

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
