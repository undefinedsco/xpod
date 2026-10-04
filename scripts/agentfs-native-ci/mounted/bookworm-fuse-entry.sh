#!/usr/bin/env bash
# Disposable Bookworm container entry for actual Linux Node22 noBun FUSE
# acceptance of the frozen product archive. Runs inside an owned container that
# only receives /dev/fuse + SYS_ADMIN + the mounted harness/product/evidence.
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 70; }

# 1. Real capability probe: a missing device is an actual failure, never a pass.
[ -e /dev/fuse ] || fail '{"stage":"fuse-device","errorClass":"missing-device"}'
grep -qw fuse /proc/filesystems || fail '{"stage":"fuse-device","errorClass":"kernel-fuse-absent"}'

# 2. Use the exact Node 22.21.1 runtime prepared by the network-allowed prep
#    stage into the owned prep volume; acceptance itself has no network.
NODE_VERSION=v22.21.1
node_home="${XPOD_MOUNTED_PREP:-/prep}/node22"
[ -x "${node_home}/bin/node" ] || fail '{"stage":"node-prep","errorClass":"prepared-node-missing"}'
export PATH="${node_home}/bin:${PATH}"
[ "$("${node_home}/bin/node" --version)" = "${NODE_VERSION}" ] || fail '{"stage":"node-prep","errorClass":"version-mismatch"}'

# 3. Acceptance stage: Node22 noBun from the actual consumer PATH.
if command -v bun >/dev/null 2>&1; then fail '{"stage":"node22-noBun","errorClass":"bun-present-in-path"}'; fi
export XPOD_MOUNTED_NODE="${node_home}/bin/node"

# 4. Run the tracked, source-bound mounted acceptance driver under Node22.
export XPOD_MOUNTED_WORKSPACE="${XPOD_MOUNTED_WORKSPACE:-/workspace}"
cd "${XPOD_MOUNTED_WORKSPACE}"
exec "${node_home}/bin/node" --experimental-strip-types \
  "${XPOD_MOUNTED_WORKSPACE}/scripts/agentfs-native-ci/mounted/platform-admission.ts"
