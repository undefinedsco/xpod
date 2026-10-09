#!/usr/bin/env bash
# Runs the whole Linux acceptance inside the pinned Bookworm GNU image.
#
# The Ubuntu ARM runner only hosts Docker; every export/rebuild/test/package/
# install/admission below executes against Debian 12 / glibc 2.36 / OpenSSL 3,
# so the produced helper targets the supported Bookworm baseline instead of the
# runner's glibc 2.39. No ELF patching, loader weakening or minimum-OS raise.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# The mounted checkout is owned by the runner user; running as container root
# must be allowed to inspect it.
git config --global --add safe.directory "$repo"

. /etc/os-release
[ "$ID" = debian ] && [ "$VERSION_CODENAME" = bookworm ] || { echo "Bookworm interior expected, got $ID $VERSION_CODENAME" >&2; exit 1; }
libc=$(getconf GNU_LIBC_VERSION)
[ "$libc" = "glibc 2.36" ] || { echo "Bookworm interior glibc expected, got $libc" >&2; exit 1; }
case "${NATIVE_TARGET:?NATIVE_TARGET required}" in
  linux-arm64)
    machine=aarch64; node_arch=arm64
    node_sha256=e660365729b434af422bcd2e8e14228637ecf24a1de2cd7c916ad48f2a0521e1 ;;
  linux-x64)
    machine=x86_64; node_arch=x64
    node_sha256=680d3f30b24a7ff24b98db5e96f294c0070f8f9078df658da1bce1b9c9873c88 ;;
  *) echo 'Unsupported Bookworm native target' >&2; exit 1 ;;
esac
[ "$(uname -m)" = "$machine" ] || { echo 'Bookworm target architecture mismatch' >&2; exit 1; }

# Plain HTTP repository traffic can be truncated by host network proxies; keep
# signature verification and the same Debian sources via TLS.
sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources
apt-get -o Acquire::Retries=3 update -qq
DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y -qq --no-install-recommends \
  pkg-config liblzma-dev libssl-dev build-essential ca-certificates git unzip xz-utils python3 curl

# Pinned official Node 22.21.1 for the noBun loader admission.
node_version=22.21.1
node_dir=/opt/node-v${node_version}-linux-${node_arch}
if [ ! -x "$node_dir/bin/node" ]; then
  curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz"
  printf '%s  %s\n' "$node_sha256" /tmp/node.tar.xz | sha256sum -c -
  mkdir -p /opt
  tar -xJf /tmp/node.tar.xz -C /opt
  rm -f /tmp/node.tar.xz
fi
export PATH="$node_dir/bin:$PATH"
[ "$(node -p process.arch)" = "$node_arch" ] || { echo "Pinned Node architecture drift" >&2; exit 1; }
[ "$(node --version)" = "v${node_version}" ] || { echo "Pinned Node identity drift" >&2; exit 1; }

cd "$repo"
PYTHONDONTWRITEBYTECODE=1 python3 tests/scripts/agentfs_native_ci_test.py -v
exec env PYTHONDONTWRITEBYTECODE=1 python3 scripts/agentfs-native-ci/accept.py
