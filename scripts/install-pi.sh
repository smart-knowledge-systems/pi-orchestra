#!/usr/bin/env bash
set -euo pipefail

echo "> Installing pi globally via bun..."
bun add -g @mariozechner/pi-coding-agent

echo "> Done. Verify with: pi --version"
