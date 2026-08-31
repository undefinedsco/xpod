#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "build-macos-local-runtime: $*" >&2
  exit 64
}

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS is required"
[[ "$(uname -m)" == "arm64" ]] || fail "macOS arm64 is required"

workspace_root=${XPOD_QLEVER_WORKSPACE_ROOT:?XPOD_QLEVER_WORKSPACE_ROOT is required}
work_root=${XPOD_QLEVER_PLATFORM_BUILD_ROOT:?XPOD_QLEVER_PLATFORM_BUILD_ROOT is required}
archive_path=${XPOD_QLEVER_PLATFORM_RUNTIME_ARCHIVE:?XPOD_QLEVER_PLATFORM_RUNTIME_ARCHIVE is required}
build_jobs=${XPOD_QLEVER_BUILD_JOBS:-3}

[[ "$workspace_root" == /* && "$workspace_root" != "/" ]] || fail "workspace root must be an absolute non-root path"
[[ "$work_root" == /* && "$work_root" != "/" ]] || fail "build root must be an absolute non-root path"
[[ "$archive_path" == /* && "$archive_path" == *.tar.gz ]] || fail "runtime archive must be an absolute .tar.gz path"
[[ "$build_jobs" =~ ^[1-9][0-9]*$ ]] || fail "build jobs must be a positive integer"

for command in brew cmake ninja git python3 dylibbundler codesign otool sw_vers tar; do
  command -v "$command" >/dev/null || fail "$command is required"
done

qlever_root="$workspace_root/qlever"
lock_file="$qlever_root/qlever.lock.json"
source_dir="$work_root/source"
qlever_build_dir="$work_root/qlever-build"
local_build_dir="$work_root/local-build"
artifact_dir="$work_root/artifact"
smoke_database="$work_root/runtime-smoke.sqlite"

repository=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repository"])' "$lock_file")
commit=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$lock_file")

rm -rf "$source_dir" "$artifact_dir" "$local_build_dir"
mkdir -p "$work_root" "$artifact_dir" "$(dirname "$archive_path")"
git clone --filter=blob:none --no-checkout "$repository" "$source_dir"
git -C "$source_dir" checkout --detach "$commit"
python3 "$qlever_root/scripts/apply-patches.py" --source "$source_dir"

brew_bin=$(command -v brew)
brew_prefix=$(cd "$(dirname "$brew_bin")/.." && pwd -P)
icu_prefix="$brew_prefix/opt/icu4c"
sqlite_prefix="$brew_prefix/opt/sqlite"
[[ -d "$icu_prefix" ]] || fail "Homebrew icu4c prefix is missing: $icu_prefix"
[[ -d "$sqlite_prefix" ]] || fail "Homebrew sqlite prefix is missing: $sqlite_prefix"
builder_macos_version=$(sw_vers -productVersion)
[[ "$builder_macos_version" =~ ^[0-9]+\.[0-9]+([.][0-9]+)?$ ]] || fail "invalid macOS version: $builder_macos_version"
deployment_target="${builder_macos_version%%.*}.0"
adapter_flags="-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1 -I$qlever_root/qlever_adapter/src -I$qlever_root/qlever_adapter/include -I$qlever_root/rdf_protocol/include"

cmake \
  -S "$source_dir" \
  -B "$qlever_build_dir" \
  -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$deployment_target" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DCMAKE_PREFIX_PATH="$brew_prefix;$icu_prefix;$sqlite_prefix" \
  -DICU_ROOT="$icu_prefix" \
  -DCHEAPER_COMPILATION=ON \
  -DRANGES_NATIVE=OFF \
  -DUSE_PRECOMPILED_HEADERS=OFF \
  -DUSE_IO_URING=OFF \
  -DUSE_PARALLEL=false \
  -DCOMPILER_SUPPORTS_MARCH_NATIVE=FALSE \
  -DCMAKE_CXX_FLAGS="$adapter_flags"
server_link_file="$qlever_build_dir/CMakeFiles/qlever-server.dir/link.txt"
server_link_command=$(ninja -C "$qlever_build_dir" -t commands qlever-server | tail -n 1)
[[ "$server_link_command" == *"CMakeFiles/qlever-server.dir/src/ServerMain.cpp.o"* ]] ||
  fail "Ninja did not expose the qlever-server link command"
[[ "$server_link_command" == *" -o qlever-server "* ]] ||
  fail "Ninja qlever-server link command has an unexpected output"
printf '%s\n' "$server_link_command" > "$server_link_file"
cmake --build "$qlever_build_dir" --target qlever-server -- -j"$build_jobs"
test -x "$qlever_build_dir/qlever-server"

dependency_includes=$(python3 - "$qlever_build_dir/compile_commands.json" <<'PY'
import json
import os
import shlex
import sys

commands = json.load(open(sys.argv[1], encoding="utf-8"))
paths = []
for entry in commands:
    tokens = entry.get("arguments") or shlex.split(entry.get("command", ""))
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in {"-I", "-isystem", "-iquote", "-idirafter"} and index + 1 < len(tokens):
            paths.append(tokens[index + 1])
            index += 2
            continue
        for prefix in ("-I", "-isystem", "-iquote", "-idirafter"):
            if token.startswith(prefix) and len(token) > len(prefix):
                paths.append(token[len(prefix):])
                break
        index += 1
print(";".join(dict.fromkeys(os.path.abspath(path) for path in paths if os.path.isabs(path))))
PY
)

cmake \
  -S "$qlever_root/qlever_local_runtime" \
  -B "$local_build_dir" \
  -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$deployment_target" \
  -DCMAKE_INSTALL_PREFIX="$artifact_dir" \
  -DCMAKE_PREFIX_PATH="$brew_prefix;$icu_prefix;$sqlite_prefix" \
  -DSQLite3_ROOT="$sqlite_prefix" \
  -DXPOD_QLEVER_SOURCE_DIR="$source_dir" \
  -DXPOD_QLEVER_BUILD_DIR="$qlever_build_dir" \
  -DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS="$dependency_includes"
cmake --build "$local_build_dir" --target xpod_qlever_local_runtime -- -j"$build_jobs"
cmake --install "$local_build_dir"

runtime_path="$artifact_dir/bin/xpod_qlever_local_runtime"
test -x "$runtime_path"
mkdir -p "$artifact_dir/lib"
dylibbundler -od -b \
  -x "$runtime_path" \
  -d "$artifact_dir/lib" \
  -p '@loader_path/../lib/'
find "$artifact_dir/lib" -type f -exec codesign --force --sign - {} \;
codesign --force --sign - "$runtime_path"
otool -L "$runtime_path" | tee "$work_root/otool.log"
while IFS= read -r library; do
  otool -L "$library" >> "$work_root/otool.log"
done < <(find "$artifact_dir/lib" -type f -print)
if grep -E '/opt/homebrew|/usr/local' "$work_root/otool.log"; then
  fail "bundled runtime still references a Homebrew path"
fi

python3 "$qlever_root/scripts/verify-local-runtime-artifacts.py" \
  --prefix "$artifact_dir" \
  --lock "$lock_file" \
  --build-source macos-arm64 \
  --smoke-database "$smoke_database"
test -f "$artifact_dir/manifest.json"

rm -f "$archive_path"
tar -czf "$archive_path" -C "$artifact_dir" .
test -s "$archive_path"
echo "XPOD_QLEVER_MACOS_RUNTIME_ARCHIVE=$archive_path"
