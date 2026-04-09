#!/usr/bin/env bash
set -euo pipefail

command -v bun >/dev/null 2>&1 || { echo "bun is not installed"; exit 1; }
command -v pi >/dev/null 2>&1 || { echo "pi is not installed yet. Run: npm run install:pi"; exit 1; }

echo "bun: $(bun --version)"
echo "pi: $(pi --version)"
