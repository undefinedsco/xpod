#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
work_dir="$repo_root/.test-data/agentfs-macos-build"
pin=0a014ebd4918615baff589ed17486e557e7c6a23
mkdir -p "$work_dir/helper"
bash "$repo_root/tools/agentfs-pod/prepare-upstream.sh" "$work_dir/upstream"
cp "$repo_root/tools/agentfs-pod/Cargo.toml" "$repo_root/tools/agentfs-pod/Cargo.lock" "$work_dir/helper/"
cp -R "$repo_root/tools/agentfs-pod/src" "$work_dir/helper/"
cd "$work_dir/helper"
sed -i '' "\|^source = \"git+https://github.com/tursodatabase/agentfs?rev=${pin}#${pin}\"$|d" Cargo.lock
export CARGO_TARGET_DIR="$work_dir/target" RUSTUP_TOOLCHAIN=nightly-2026-09-30
export RUSTC="$(rustup which --toolchain nightly-2026-09-30 rustc)"
export PATH="$(dirname "$RUSTC"):$PATH"
cargo_action=${1:-build}
if [ "$#" -gt 0 ]; then shift; fi
"$HOME/.cargo/bin/cargo" "$cargo_action" --release --locked "$@" \
  --config "patch.\"https://github.com/tursodatabase/agentfs\".agentfs.path=\"$work_dir/upstream/cli\"" \
  --config "patch.\"https://github.com/tursodatabase/agentfs\".agentfs-sdk.path=\"$work_dir/upstream/sdk/rust\""
if [ "$cargo_action" = build ]; then
  mkdir -p "$repo_root/tools/agentfs-pod/target/release"
  cp "$work_dir/target/release/agentfs-pod" "$repo_root/tools/agentfs-pod/target/release/agentfs-pod"
  shasum -a 256 "$work_dir/target/release/agentfs-pod" "$repo_root/tools/agentfs-pod/patches/"*.patch > "$work_dir/build-sha256.txt"
fi
