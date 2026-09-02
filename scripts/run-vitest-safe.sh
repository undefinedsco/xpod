#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cleanup() {
  pkill -f "${REPO_ROOT}/node_modules/.bin/vitest" >/dev/null 2>&1 || true
  pkill -f "${REPO_ROOT}/node_modules/vitest/dist/workers/forks.js" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

cd "${REPO_ROOT}"
exec "${REPO_ROOT}/node_modules/.bin/vitest" "$@"
