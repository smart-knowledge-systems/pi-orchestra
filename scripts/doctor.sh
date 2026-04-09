#!/usr/bin/env bash
set -euo pipefail

command -v bun >/dev/null 2>&1 || { echo "bun is not installed"; exit 1; }
command -v pi >/dev/null 2>&1 || { echo "pi is not installed yet. Run: npm run install:pi"; exit 1; }

bun_version="$(bun --version 2>&1)"
pi_version="$(pi --version 2>&1)"

if command -v cidx >/dev/null 2>&1; then
  codeindex_cmd="cidx"
elif command -v codeindex >/dev/null 2>&1; then
  codeindex_cmd="codeindex"
else
  codeindex_cmd=""
fi

echo "bun: $bun_version"
echo "pi: $pi_version"
if [ -n "$codeindex_cmd" ]; then
  echo "codeindex: available via $codeindex_cmd"
else
  echo "codeindex: not installed (optional)"
fi
