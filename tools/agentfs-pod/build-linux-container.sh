#!/usr/bin/env bash
set -euo pipefail
pin=0a014ebd4918615baff589ed17486e557e7c6a23
export RUSTUP_HOME=/work/rustup CARGO_TARGET_DIR=/work/target
# Plain HTTP repository traffic can be truncated by the host network proxy.
# Keep signature verification enabled and use the same Debian sources via TLS.
sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources
apt-get -o Acquire::Retries=3 update -qq
apt-get -o Acquire::Retries=3 install -y -qq --no-install-recommends pkg-config liblzma-dev build-essential ca-certificates git
rustup toolchain install nightly-2026-09-30 --profile minimal
bash /src/tools/agentfs-pod/prepare-upstream.sh /work/upstream
mkdir -p /work/helper
cp /src/tools/agentfs-pod/Cargo.toml /src/tools/agentfs-pod/Cargo.lock /work/helper/
cp -R /src/tools/agentfs-pod/src /work/helper/
cd /work/helper
# The local patch changes only the two AgentFS package source identities.
# Preserve every version/checksum from the authoritative lock and reject any
# other resolver change instead of silently producing a different dependency set.
sed -i "\|^source = \"git+https://github.com/tursodatabase/agentfs?rev=${pin}#${pin}\"$|d" Cargo.lock
cargo +nightly-2026-09-30 build --locked --release \
  --config 'patch."https://github.com/tursodatabase/agentfs".agentfs.path="/work/upstream/cli"' \
  --config 'patch."https://github.com/tursodatabase/agentfs".agentfs-sdk.path="/work/upstream/sdk/rust"'
sha256sum /work/target/release/agentfs-pod /src/tools/agentfs-pod/patches/*.patch > /work/build-sha256.txt
