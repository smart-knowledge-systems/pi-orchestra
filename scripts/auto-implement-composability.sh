#!/usr/bin/env bash
set -euo pipefail

TASKS_FILE="./composability-tasks.json"
PLAN_FILE="./auto-implement-composability.md"
DESIGN_FILE="./docs/composability.md"
DEV_LOG="./composability-dev-log.txt"
MAX_ITERATIONS="${MAX_ITERATIONS:-100}"
MAX_BUN_CHECK_ATTEMPTS="${MAX_BUN_CHECK_ATTEMPTS:-10}"
DRY_RUN="${DRY_RUN:-0}"

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_file() {
  [ -f "$1" ] || {
    echo "Missing required file: $1" >&2
    exit 1
  }
}

require_cmd jq
require_cmd claude
require_cmd bun
require_cmd git

require_file "$TASKS_FILE"
require_file "$PLAN_FILE"
require_file "$DESIGN_FILE"

touch "$DEV_LOG"

append_log() {
  local header="$1"
  local body="$2"
  {
    printf '\n===== %s | %s =====\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$header"
    printf '%s\n' "$body"
  } >> "$DEV_LOG"
}

log_dry_run() {
  printf '[dry-run] %s\n' "$*"
}

active_count() {
  jq '[.tasks[] | select(.status == "active")] | length' "$TASKS_FILE"
}

remaining_count() {
  jq '[.tasks[] | select(.status == "planned" or .status == "in_progress")] | length' "$TASKS_FILE"
}

candidate_tasks_json() {
  jq '[
    .tasks
    | map(select(.status == "planned" or .status == "in_progress"))
    | sort_by(if .status == "in_progress" then 0 else 1 end, .phase, .sprint, .id)
  ] | .[0]' "$TASKS_FILE"
}

active_tasks_json() {
  jq '[.tasks[] | select(.status == "active")]' "$TASKS_FILE"
}

mark_ids_status() {
  local status="$1"
  shift
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log_dry_run "Would mark task(s) as ${status}: $*"
    return 0
  fi

  local ids_json
  ids_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"

  local tmp
  tmp="$(mktemp)"
  jq --arg status "$status" --argjson ids "$ids_json" '
    .tasks |= map(
      if (.id as $id | $ids | index($id)) != null
      then .status = $status
      else .
      end
    )
  ' "$TASKS_FILE" > "$tmp"
  mv "$tmp" "$TASKS_FILE"
}

extract_known_ids_from_text() {
  local text="$1"
  jq -r '.tasks[].id' "$TASKS_FILE" | while IFS= read -r id; do
    if printf '%s' "$text" | grep -Eq "(^|[^A-Z0-9_-])${id}([^A-Z0-9_-]|$)"; then
      printf '%s\n' "$id"
    fi
  done | awk '!seen[$0]++'
}

select_tasks_with_sonnet() {
  local candidates_json
  candidates_json="$(candidate_tasks_json)"

  local prompt
  prompt=$(cat <<EOF
You are reviewing the backlog for pi-orchestra composability primitives work.

Read these files for context:
- ${DEV_LOG}
- ${PLAN_FILE}
- ${DESIGN_FILE}
- ${TASKS_FILE}

Your job:
- select 1 to 3 related or tightly coupled tasks
- only select tasks whose status is planned or in_progress
- prioritize tasks already marked in_progress
- prefer a small, coherent batch that can be completed together in one implementation pass
- respect phase ordering: do not advance to a later phase until the current phase has no remaining planned/in_progress tasks
- Phase 1 is load-bearing; respect dependency order within Phase 1 especially
- use jq to directly update ${TASKS_FILE} so the selected tasks are marked with status "active"
- after updating the file, respond with ONLY the selected task IDs as valid JSON
- respond with ONLY a JSON array of task IDs, for example: ["COMP-P1-T1","COMP-P1-T2"]
- do not include any explanation outside the JSON array

Candidate tasks:
$candidates_json
EOF
)

  if [ "$DRY_RUN" = "1" ]; then
    log_dry_run "Would call claude sonnet picker with prompt:"
    printf '%s\n' "$prompt"
    return 0
  fi

  claude -p --model sonnet --permission-mode bypassPermissions "$prompt"
}

fallback_select_ids() {
  jq -r '
    .tasks
    | map(select(.status == "planned" or .status == "in_progress"))
    | sort_by(if .status == "in_progress" then 0 else 1 end, .phase, .sprint, .id)
    | .[:3]
    | .[].id
  ' "$TASKS_FILE"
}

get_selected_ids() {
  local response="$1"

  if printf '%s' "$response" | jq -e 'type == "array" and length >= 1 and length <= 3 and all(.[]; type == "string")' >/dev/null 2>&1; then
    printf '%s' "$response" | jq -r '.[]'
    return 0
  fi

  extract_known_ids_from_text "$response"
}

implement_active_tasks_with_opus() {
  local tasks_json
  tasks_json="$(active_tasks_json)"

  local prompt
  prompt=$(cat <<EOF
You are implementing the currently active tasks for pi-orchestra composability primitives work.

Read and follow:
- ${PLAN_FILE} (task-level plan and phase gates)
- ${DESIGN_FILE} (design intent, primitives, conflict-resolution rules — the canonical "why")
- ${TASKS_FILE}
- ${DEV_LOG}

Implement exactly the active tasks below. Use the task definitions directly, including deliverables, dependencies, and acceptance criteria.

Active tasks JSON:
$tasks_json

Requirements:
- implement only what is necessary to complete these active tasks
- keep work aligned with ${PLAN_FILE} and ${DESIGN_FILE}
- on any conflict between the plan and the design doc, the design doc wins; flag the discrepancy in your summary
- stop when these active tasks are complete
- if a task cannot be fully completed, leave the repo in the best coherent partial state and clearly say what remains
- after making changes, summarize what you changed, which files were modified, and any unfinished work
- do not start unrelated later-phase work unless required to complete these tasks
- preserve byte-identical behavior on the existing E2E (tests/interaction/agentic-retrieval-flow.test.ts) for Phase 1 tasks; this is the load-bearing Phase 1 gate
EOF
)

  if [ "$DRY_RUN" = "1" ]; then
    log_dry_run "Would call claude opus to implement active tasks with prompt:"
    printf '%s\n' "$prompt"
    return 0
  fi

  local response
  response="$(claude -p --model opus --permission-mode bypassPermissions "$prompt")"
  append_log "opus implement" "$response"
  printf '%s\n' "$response"
}

run_bun_check_loop() {
  local attempts=0

  if [ "$DRY_RUN" = "1" ]; then
    log_dry_run "Would run: bun format && bun check"
    return 0
  fi

  while true; do
    set +e
    local output
    output="$( { bun format && bun check; } 2>&1 )"
    local status=$?
    set -e

    if [ $status -eq 0 ]; then
      printf '%s\n' "$output"
      return 0
    fi

    attempts=$((attempts + 1))
    append_log "bun failure $attempts" "$output"

    if [ "$attempts" -ge "$MAX_BUN_CHECK_ATTEMPTS" ]; then
      echo "bun validation failed after $attempts attempts; aborting (MAX_BUN_CHECK_ATTEMPTS=$MAX_BUN_CHECK_ATTEMPTS)." >&2
      printf '%s\n' "$output" >&2
      return 1
    fi

    local tasks_json
    tasks_json="$(active_tasks_json)"

    local prompt
    prompt=$(cat <<EOF
The repository currently fails validation.

Read these files for context:
- ${PLAN_FILE}
- ${DESIGN_FILE}
- ${TASKS_FILE}
- ${DEV_LOG}

Active tasks JSON:
$tasks_json

The exact failing output from:
- bun format
- bun check

is below:
$output

Please:
- run bun check oriented fixes in the repository
- fix the issues causing the failure
- keep fixes tightly scoped to the current active tasks and necessary validation repairs
- stop once bun format && bun check pass
- summarize the fixes you made
EOF
)

    local response
    response="$(claude -p --model opus --permission-mode bypassPermissions "$prompt")"
    append_log "opus fix bun check $attempts" "$response"
  done
}

evaluate_task_with_sonnet() {
  local task_json="$1"

  local prompt
  prompt=$(cat <<EOF
Evaluate whether this task is complete.

Read these files for context:
- ${PLAN_FILE}
- ${DESIGN_FILE}
- ${TASKS_FILE}
- ${DEV_LOG}

Task JSON:
$task_json

Instructions:
- verify whether the task acceptance criteria are met in the current repository state
- respond with exactly one word: yes or no
- respond yes only if the acceptance criteria are satisfied now
EOF
)

  if [ "$DRY_RUN" = "1" ]; then
    log_dry_run "Would call claude sonnet evaluator with prompt:"
    printf '%s\n' "$prompt"
    return 0
  fi

  claude -p --model sonnet --permission-mode dontAsk "$prompt"
}

commit_with_haiku() {
  local tasks_json
  tasks_json="$(active_tasks_json)"

  local diff_summary
  diff_summary="$(git status --short && printf '\n--- DIFF ---\n' && git diff --stat && printf '\n--- CACHED DIFF ---\n' && git diff --cached --stat)"

  local prompt
  prompt=$(cat <<EOF
Review the current repository changes and create atomic git commits.

Read for context:
- ${DEV_LOG}
- ${PLAN_FILE}
- ${DESIGN_FILE}
- ${TASKS_FILE}

Active tasks JSON:
$tasks_json

Repository change summary:
$diff_summary

Instructions:
- inspect the actual git diff before committing
- create atomic commits that reflect coherent units of work
- include all completed changes
- do not rewrite history
- if there is nothing to commit, say so briefly
- prefix commit subjects with the relevant scope (e.g. "feat(comp):", "refactor(comp):", "test(comp):", "docs(comp):") consistent with the existing commit style in this repository
- after committing, respond with a short summary of the commit hashes and messages
EOF
)

  if [ "$DRY_RUN" = "1" ]; then
    log_dry_run "Would call claude haiku to create atomic commits with prompt:"
    printf '%s\n' "$prompt"
    return 0
  fi

  claude -p --model haiku --permission-mode bypassPermissions "$prompt"
}

iteration=0
while [ "$iteration" -lt "$MAX_ITERATIONS" ]; do
  iteration=$((iteration + 1))

  if [ "$(remaining_count)" -eq 0 ]; then
    echo "No planned or in_progress tasks remain."
    break
  fi

  current_active_count="$(active_count)"
  if [ "$current_active_count" -gt 0 ]; then
    echo "Found $current_active_count active task(s); continuing with current active batch."
  else
    echo "Selecting active tasks for iteration $iteration..."
    selection_response="$(select_tasks_with_sonnet || true)"

    current_active_count="$(active_count)"
    if [ "$current_active_count" -gt 0 ]; then
      echo "Sonnet picker marked $current_active_count task(s) active directly; continuing with that batch."
    else
      selected_ids="$(get_selected_ids "$selection_response" || true)"
      if [ -z "$selected_ids" ]; then
        selected_ids="$(fallback_select_ids)"
        if [ "$DRY_RUN" = "1" ]; then
          log_dry_run "No model selection response parsed; would fall back to task IDs: $(printf '%s ' $selected_ids)"
        fi
      fi

      ids_to_activate_data="$(printf '%s\n' "$selected_ids" | sed '/^$/d' | head -n 3)"
      if [ -z "$ids_to_activate_data" ]; then
        echo "Could not determine tasks to activate." >&2
        exit 1
      fi

      ids_to_activate_args="$(printf '%s\n' "$ids_to_activate_data" | paste -sd ' ' -)"
      # shellcheck disable=SC2086
      mark_ids_status "active" $ids_to_activate_args
    fi
  fi

  echo "Implementing active tasks..."
  implement_active_tasks_with_opus >/dev/null

  echo "Running bun format && bun check loop..."
  run_bun_check_loop >/dev/null

  echo "Evaluating active tasks..."
  active_ids_data="$(jq -r '.tasks[] | select(.status == "active") | .id' "$TASKS_FILE")"

  if [ -n "$active_ids_data" ]; then
    while IFS= read -r task_id; do
      [ -n "$task_id" ] || continue
      task_json="$(jq --arg id "$task_id" -c '.tasks[] | select(.id == $id)' "$TASKS_FILE")"
      eval_response="$(evaluate_task_with_sonnet "$task_json" || true)"

      if [ "$DRY_RUN" = "1" ]; then
        log_dry_run "Would evaluate task $task_id and update its status based on yes/no response."
      elif printf '%s' "$eval_response" | tr '[:upper:]' '[:lower:]' | grep -Eq '\byes\b'; then
        mark_ids_status "completed" "$task_id"
      else
        mark_ids_status "in_progress" "$task_id"
      fi
    done <<EOF
$active_ids_data
EOF
  fi

  echo "Creating atomic commits..."
  commit_with_haiku || true

done

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run complete. No files or task statuses were modified by script-controlled operations."
fi

echo "Done. Current task status summary:"
jq '{tasks: [.tasks[] | {id, status, title}]}' "$TASKS_FILE"
