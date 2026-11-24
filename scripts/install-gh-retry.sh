#!/usr/bin/env bash
# Put scripts/gh-retry-shim.sh in front of the real `gh` for the rest of a GitHub job.
set -euo pipefail

real="$(command -v gh)"
dir="${RUNNER_TEMP:?}/gh-retry-bin"
mkdir -p "$dir"
install -m 755 "$(dirname "$0")/gh-retry-shim.sh" "$dir/gh"
echo "XPOD_REAL_GH=$real" >> "${GITHUB_ENV:?}"
echo "$dir" >> "${GITHUB_PATH:?}"
