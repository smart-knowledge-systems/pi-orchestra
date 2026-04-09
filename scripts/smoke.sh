#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -rf .pi

output="$(piorx -p --offline "smoke test" 2>&1)"
printf '%s\n' "$output"

if [ ! -f .pi/session-state.json ]; then
  echo "Smoke test failed: .pi/session-state.json was not created" >&2
  exit 1
fi

echo "> Smoke test passed"
