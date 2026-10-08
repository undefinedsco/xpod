#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
work_dir="$repo_root/.test-data/agentfs-linux-build"
mkdir -p "$work_dir"
docker run --rm --name xpod-agentfs-build-"$$" \
  -v "$repo_root:/src:ro" -v "$work_dir:/work" \
  -v "$work_dir/cargo-registry:/usr/local/cargo/registry" -v "$work_dir/cargo-git:/usr/local/cargo/git" \
  rust@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e \
  bash /src/tools/agentfs-pod/build-linux-container.sh
