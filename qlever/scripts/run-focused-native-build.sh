#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "run-focused-native-build: $*" >&2
  exit 64
}

require_absolute_directory() {
  local value=$1
  local label=$2
  [[ "$value" == /* && "$value" != "/" ]] \
    || fail "$label must be an absolute non-root path"
}

require_digest_ref() {
  local value=$1
  local label=$2
  [[ "$value" =~ ^.+@sha256:[0-9a-f]{64}$ ]] \
    || fail "$label must be an immutable @sha256 image ref"
}

[[ "$(uname -s)" == "Linux" ]] \
  || fail "native compilation is restricted to a remote Linux worker"

workspace_root=${XPOD_QLEVER_WORKSPACE_ROOT:?XPOD_QLEVER_WORKSPACE_ROOT is required}
qlever_source_dir=${XPOD_QLEVER_SOURCE_DIR:-/opt/qlever-sdk/source}
qlever_build_dir=${XPOD_QLEVER_BUILD_DIR:-/opt/qlever-sdk/build}
local_build_dir=${XPOD_QLEVER_LOCAL_BUILD_DIR:?XPOD_QLEVER_LOCAL_BUILD_DIR is required}
artifact_dir=${XPOD_QLEVER_LOCAL_ARTIFACT_DIR:?XPOD_QLEVER_LOCAL_ARTIFACT_DIR is required}
output_dir=${XPOD_QLEVER_BUILD_OUTPUT_DIR:?XPOD_QLEVER_BUILD_OUTPUT_DIR is required}
build_jobs=${XPOD_QLEVER_BUILD_JOBS:-8}
prior_sdk_image=${XPOD_QLEVER_PRIOR_SDK_IMAGE:?XPOD_QLEVER_PRIOR_SDK_IMAGE is required}

for path_and_label in \
  "$workspace_root:XPOD_QLEVER_WORKSPACE_ROOT" \
  "$qlever_source_dir:XPOD_QLEVER_SOURCE_DIR" \
  "$qlever_build_dir:XPOD_QLEVER_BUILD_DIR" \
  "$local_build_dir:XPOD_QLEVER_LOCAL_BUILD_DIR" \
  "$artifact_dir:XPOD_QLEVER_LOCAL_ARTIFACT_DIR" \
  "$output_dir:XPOD_QLEVER_BUILD_OUTPUT_DIR"
do
  require_absolute_directory "${path_and_label%%:*}" "${path_and_label#*:}"
done
[[ "$build_jobs" =~ ^[1-9][0-9]*$ ]] \
  || fail "XPOD_QLEVER_BUILD_JOBS must be a positive integer"
require_digest_ref "$prior_sdk_image" XPOD_QLEVER_PRIOR_SDK_IMAGE

case "$artifact_dir/" in
  "$output_dir/"*) ;;
  *) fail "XPOD_QLEVER_LOCAL_ARTIFACT_DIR must be inside XPOD_QLEVER_BUILD_OUTPUT_DIR" ;;
esac
[[ "$artifact_dir" != "$output_dir" ]] \
  || fail "XPOD_QLEVER_LOCAL_ARTIFACT_DIR must be below XPOD_QLEVER_BUILD_OUTPUT_DIR"

local_runtime_source="$workspace_root/qlever/qlever_local_runtime"
lock_file="$workspace_root/qlever/qlever.lock.json"
artifact_verifier="$workspace_root/qlever/scripts/verify-local-runtime-artifacts.py"
overlay_manifest_tool="$workspace_root/qlever/scripts/runtime-overlay-manifest.py"
build_log="$output_dir/build.log"

run_build() {
  trap 'echo "focused native build failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

  test -f "$local_runtime_source/CMakeLists.txt"
  test -f "$lock_file"
  test -f "$artifact_verifier"
  test -f "$overlay_manifest_tool"
  test -f "$qlever_build_dir/compile_commands.json"
  test -f "$qlever_build_dir/.xpod-build-identity"
  test -f "$qlever_build_dir/.xpod-overlay-identity"

  export DEBIAN_FRONTEND=noninteractive
  if ! test -f /usr/include/sqlite3.h; then
    command -v apt-get >/dev/null \
      || fail "libsqlite3-dev is missing and apt-get is unavailable"
    apt-get -o Acquire::Retries=5 update
    apt-get install -y --no-install-recommends libsqlite3-dev
    rm -rf /var/lib/apt/lists/*
  fi

  local expected_identity
  expected_identity=$(python3 -c \
    'import json,sys; lock=json.load(open(sys.argv[1], encoding="utf-8")); print("{}:{}".format(lock["commit"], lock["patchSeriesSha256"]), end="")' \
    "$lock_file")
  test "$(cat "$qlever_build_dir/.xpod-build-identity")" = "$expected_identity"

  local overlay_manifest_current
  overlay_manifest_current=$(mktemp)
  python3 "$overlay_manifest_tool" \
    --qlever-root "$workspace_root/qlever" >"$overlay_manifest_current"
  local current_overlay_identity
  current_overlay_identity=$(sha256sum "$overlay_manifest_current" | cut -d' ' -f1)
  rm -f "$overlay_manifest_current"
  local prior_overlay_identity
  prior_overlay_identity=$(tr -d '\r\n' <"$qlever_build_dir/.xpod-overlay-identity")
  if [[ "$prior_overlay_identity" != "$current_overlay_identity" ]]; then
    fail "prior SDK overlay identity mismatch; rebuild the runtime SDK incrementally before focused local runtime build"
  fi

  local dependency_includes
  dependency_includes=$(python3 -c \
    'import json,shlex,sys; commands=json.load(open(sys.argv[1], encoding="utf-8")); tokens=[token for entry in commands for token in (entry.get("arguments") or shlex.split(entry.get("command", "")))]; separated=[tokens[index + 1] for index, token in enumerate(tokens[:-1]) if token in {"-I", "-isystem", "-iquote", "-idirafter"}]; joined=[token[2:] for token in tokens if token.startswith("-I") and len(token) > 2] + [token[len("-isystem"):] for token in tokens if token.startswith("-isystem") and len(token) > len("-isystem")]; print(";".join(dict.fromkeys(path for path in separated + joined if path.startswith("/opt/qlever-sdk/"))))' \
    "$qlever_build_dir/compile_commands.json")

  rm -rf "$artifact_dir"
  mkdir -p "$local_build_dir" "$artifact_dir" "$output_dir/logs"
  CC=clang-19 CXX=clang++-19 cmake \
    -S "$local_runtime_source" \
    -B "$local_build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$artifact_dir" \
    -DXPOD_QLEVER_SOURCE_DIR="$qlever_source_dir" \
    -DXPOD_QLEVER_BUILD_DIR="$qlever_build_dir" \
    -DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS="$dependency_includes" \
    -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld \
    -DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=lld
  cmake --build "$local_build_dir" \
    --target xpod_qlever_local_runtime \
    -- -j"$build_jobs"
  cmake --install "$local_build_dir"

  test -x "$artifact_dir/bin/xpod_qlever_local_runtime"
  test ! -e "$artifact_dir/lib/libxpod_qlever_adapter.so"
  test ! -e "$artifact_dir/lib/libxpod_rdf_sqlite_backend.so"
  find "$artifact_dir" -type f \( -perm -111 -o -name '*.so' \) -print0 \
    | xargs -0 -r ldd | tee "$output_dir/logs/ldd.log"
  if grep -q 'not found' "$output_dir/logs/ldd.log"; then
    fail "ldd found missing runtime dependencies"
  fi

  python3 "$artifact_verifier" \
    --prefix "$artifact_dir" \
    --lock "$lock_file" \
    --prior-sdk-image "$prior_sdk_image" \
    --smoke-database "$output_dir/runtime-smoke.sqlite"
  test -f "$artifact_dir/manifest.json"
  echo XPOD_FOCUSED_NATIVE_BUILD_DONE
}

mkdir -p "$output_dir"
set +e
(
  set -Eeuo pipefail
  run_build
) >"$build_log" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  tail -n 200 "$build_log"
else
  tail -n 200 "$build_log" >&2
  exit "$status"
fi
