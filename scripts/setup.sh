#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "> Installing pi globally..."
bash ./scripts/install-pi.sh

echo "> Linking local piorx wrapper..."
npm run link

echo "> Running environment checks..."
bash ./scripts/doctor.sh

echo "> Setup complete. Run: piorx"
