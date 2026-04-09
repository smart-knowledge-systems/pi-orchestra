#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "> Installing pi globally..."
bash ./scripts/install-pi.sh

if command -v cidx >/dev/null 2>&1 || command -v codeindex >/dev/null 2>&1; then
  echo "> codeindex already installed"
else
  echo "> Installing codeindex globally..."
  bash ./scripts/install-codeindex.sh
fi

echo "> Linking local piorx wrapper..."
npm run link

echo "> Running environment checks..."
bash ./scripts/doctor.sh

echo "> Running smoke test..."
bash ./scripts/smoke.sh

echo "> Setup complete. Run: piorx"
