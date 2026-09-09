#!/usr/bin/env bash
set -Eeuo pipefail

component_root=${XPOD_RDF_COMPONENT_ROOT:-/components}
qlever_root="$component_root/qlever"
source_dir=${XPOD_QLEVER_SOURCE_DIR:-/opt/qlever-sdk/source}
build_dir=${XPOD_QLEVER_BUILD_DIR:-/opt/qlever-sdk/build}
jobs=${XPOD_QLEVER_BUILD_JOBS:-4}
incremental_sdk=${XPOD_QLEVER_INCREMENTAL_SDK:-0}
prior_validation_marker=${XPOD_QLEVER_PRIOR_VALIDATION_MARKER:-}

repository=$(python3 -c 'import json; print(json.load(open("/components/qlever/qlever.lock.json"))["repository"])')
commit=$(python3 -c 'import json; print(json.load(open("/components/qlever/qlever.lock.json"))["commit"])')
patch_series_sha=$(python3 -c 'import json; print(json.load(open("/components/qlever/qlever.lock.json"))["patchSeriesSha256"])')
build_identity="$commit:$patch_series_sha"
build_identity_file="$build_dir/.xpod-build-identity"
source_manifest_file="$build_dir/.xpod-source-manifest"
source_manifest_pending="$build_dir/.xpod-source-manifest.pending"
toolchain_identity_file="$build_dir/.xpod-toolchain-identity"
build_contract_file="$build_dir/.xpod-build-contract.json"
build_contract_pending="$build_dir/.xpod-build-contract.json.pending"

build_contract=$(python3 - "$source_dir" "$build_dir" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

source_dir, build_dir = sys.argv[1:3]
os_release = Path(os.environ.get("XPOD_QLEVER_OS_RELEASE_FILE", "/etc/os-release"))
pretty_name = ""
for line in os_release.read_text().splitlines():
    if line.startswith("PRETTY_NAME="):
        pretty_name = line.split("=", 1)[1].strip('"')
        break
if not pretty_name:
    raise SystemExit("missing PRETTY_NAME in os-release")

def version(command):
    return subprocess.check_output(command, text=True).splitlines()[0]

payload = {
    "schemaVersion": 1,
    "component": "qlever-runtime-sdk",
    "base": {
        "osReleasePrettyName": pretty_name,
    },
    "toolchain": {
        "clang": version(["clang-19", "--version"]),
        "clangxx": version(["clang++-19", "--version"]),
        "cmake": version(["cmake", "--version"]),
    },
    "cmake": {
        "source": source_dir,
        "build": build_dir,
        "buildType": "Release",
        "positionIndependentCode": "ON",
        "flags": {
            "CHEAPER_COMPILATION": "ON",
            "RANGES_NATIVE": "OFF",
            "USE_PRECOMPILED_HEADERS": "OFF",
            "USE_IO_URING": "OFF",
        },
    },
}
print(json.dumps(payload, sort_keys=True, indent=2))
PY
)
toolchain_identity=$(printf '%s' "$build_contract" | python3 -c 'import hashlib, json, sys; print(hashlib.sha256(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")).encode()).hexdigest())')

mkdir -p "$build_dir"
if [[ "$incremental_sdk" == "1" ]]; then
  patched_source_dir=$(mktemp -d)
  cleanup_patched_source() {
    rm -rf "$patched_source_dir"
  }
  trap cleanup_patched_source EXIT
  git clone --filter=blob:none --no-checkout "$repository" "$patched_source_dir"
  git -C "$patched_source_dir" checkout --detach "$commit"
  python3 "$qlever_root/scripts/apply-patches.py" --source "$patched_source_dir"
  python3 "$qlever_root/scripts/sync-patched-source.py" \
    --patched-source "$patched_source_dir" \
    --target-source "$source_dir" \
    --manifest-out "$source_manifest_pending" \
    --prior-validation-marker "$prior_validation_marker"
else
  if [[ -d "$source_dir/.git" ]]; then
    git -C "$source_dir" remote set-url origin "$repository"
    git -C "$source_dir" fetch --depth=1 origin "$commit"
    git -C "$source_dir" reset --hard "$commit"
    git -C "$source_dir" clean -fdx
  else
    find "$source_dir" -mindepth 1 -delete 2>/dev/null || true
    git clone --filter=blob:none --no-checkout "$repository" "$source_dir"
    git -C "$source_dir" checkout --detach "$commit"
  fi
  python3 "$qlever_root/scripts/apply-patches.py" --source "$source_dir"
  source_epoch=$(git -C "$source_dir" show -s --format=%ct "$commit")
  find "$source_dir" -path "$source_dir/.git" -prune -o -type f \
    -exec touch -d "@$source_epoch" {} +
  python3 "$qlever_root/scripts/sync-patched-source.py" \
    --patched-source "$source_dir" \
    --target-source "$source_dir" \
    --manifest-out "$source_manifest_pending"
fi

overlay_manifest_file="$build_dir/.xpod-overlay-manifest"
overlay_manifest_current=$(mktemp)
python3 "$qlever_root/scripts/runtime-overlay-manifest.py" \
  --qlever-root "$qlever_root" >"$overlay_manifest_current"
overlay_source_sha=$(sha256sum "$overlay_manifest_current" | cut -d' ' -f1)
overlay_identity_file="$build_dir/.xpod-overlay-identity"
runtime_overlay_inputs_changed=0
if [[ $(cat "$overlay_identity_file" 2>/dev/null || true) != "$overlay_source_sha" ]]; then
  while read -r source_sha relative_path; do
    previous_sha=""
    if [[ -f "$overlay_manifest_file" ]]; then
      previous_sha=$(awk -v path="$relative_path" '$2 == path { print $1 }' \
        "$overlay_manifest_file")
    fi
    if [[ "$previous_sha" != "$source_sha" ]]; then
      touch "$qlever_root/$relative_path"
      runtime_overlay_inputs_changed=1
    fi
  done <"$overlay_manifest_current"
  cp "$overlay_manifest_current" "$overlay_manifest_file"
  printf '%s' "$overlay_source_sha" >"$overlay_identity_file"
fi
rm -f "$overlay_manifest_current"

adapter_flags="-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1 -I$qlever_root/qlever_adapter/src -I$qlever_root/qlever_adapter/include -I$qlever_root/rdf_protocol/include"
if [[ ! -f "$build_identity_file" ]] ||
   [[ $(cat "$build_identity_file") != "$build_identity" ]] ||
   [[ ! -f "$toolchain_identity_file" ]] ||
   [[ $(cat "$toolchain_identity_file") != "$toolchain_identity" ]]; then
  CC=clang-19 CXX=clang++-19 cmake \
    -S "$source_dir" \
    -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    -DCMAKE_CXX_COMPILER_LAUNCHER= \
    -DCHEAPER_COMPILATION=ON \
    -DRANGES_NATIVE=OFF \
    -DUSE_PRECOMPILED_HEADERS=OFF \
    -DUSE_IO_URING=OFF \
    -DCMAKE_CXX_FLAGS="$adapter_flags"
  cmake --build "$build_dir" --target qlever-server -- -j"$jobs"
  printf '%s\n' "$build_contract" >"$build_contract_pending"
  mv "$source_manifest_pending" "$source_manifest_file"
  mv "$build_contract_pending" "$build_contract_file"
  printf '%s' "$build_identity" >"$build_identity_file"
  printf '%s' "$toolchain_identity" >"$toolchain_identity_file"
elif [[ "$runtime_overlay_inputs_changed" == "1" ]]; then
  cmake --build "$build_dir" --target qlever-server -- -j"$jobs"
fi

test -f "$build_dir/CMakeFiles/qlever-server.dir/link.txt"
