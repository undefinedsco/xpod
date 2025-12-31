#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/w3c/sparql11-test-suite.git}"
TARGET_DIR="${TARGET_DIR:-third_party/w3c-sparql11-test-suite}"

if [ -d "${TARGET_DIR}" ]; then
  echo "Already exists: ${TARGET_DIR}"
  exit 0
fi

mkdir -p "$(dirname "${TARGET_DIR}")"
git clone --depth 1 "${REPO_URL}" "${TARGET_DIR}"
echo "Fetched W3C SPARQL 1.1 Query Test Suite into ${TARGET_DIR}"
