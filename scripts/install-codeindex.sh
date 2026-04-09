#!/usr/bin/env bash
set -euo pipefail

if command -v cidx >/dev/null 2>&1 || command -v codeindex >/dev/null 2>&1; then
  echo "> codeindex already installed"
  exit 0
fi

echo "> Installing codeindex globally via bun..."
bun add -g codeindex

echo "> Done. Verify with: cidx --help or codeindex --help"
