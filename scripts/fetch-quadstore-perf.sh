#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/quadstorejs/quadstore-perf.git}"
TARGET_DIR="${TARGET_DIR:-third_party/quadstore-perf}"

if [ -d "${TARGET_DIR}" ]; then
  echo "Already exists: ${TARGET_DIR}"
  exit 0
fi

mkdir -p "$(dirname "${TARGET_DIR}")"
git clone --depth 1 "${REPO_URL}" "${TARGET_DIR}"
echo "Fetched quadstore-perf into ${TARGET_DIR}"
