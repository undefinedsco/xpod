# AgentFS Pod native source kit

This kit includes the original fixed AgentFS Git archive, its full patched
source tree, both tracked patches, original helper manifest/lock, transformed
working manifest/lock, full Cargo-vendored dependency trees and checksums,
original notices (including Xpod's `licenses/xpod/LICENSE`) and a rebuild script. Source replacement is for unchanged
registry bytes; our two AgentFS patches use separate local path dependencies.
The working lock removes only those two Git source identities. Registry package
versions and checksums are preserved. Full crates include their C/assembly trees;
do not strip ring, libgit2, SimSIMD or libaegis native subdirectories.

With Bun, rustup and the recorded nightly already installed, run from the kit:

```sh
bun packages/xpod-cli/scripts/rebuild-native.ts --verify-only
bun packages/xpod-cli/scripts/rebuild-native.ts --out /path/to/output --test
```

The script verifies every file, stages only declared bytes outside the checkout,
uses explicit installed cargo/rustc paths and an empty Cargo home, and builds
with `--release --frozen` (locked and offline). It does not install tools or
dependencies. The receipt binds source-kit hash, actual helper hash, target,
compiler identities and whether helper regressions ran. Logs and build objects
remain in the chosen output directory; temporary sources/Cargo home are removed.
No byte-identical rebuild claim is made: upstream build metadata includes time
and Git-version fallback. No outer checkout Git metadata is used.

The toolchain, target standard libraries, C compiler/linker, SDK/sysroot and
system dependencies are external prerequisites. macOS needs its compiler/SDK;
Linux needs pkg-config, OpenSSL development materials, liblzma and gcc_s.
The kit does not include those system sources or runtime shared libraries.
Cargo's offline flag does not sandbox build-script networking; a separately
recorded network-disabled container run is needed for that stronger claim.

Bundled component licenses govern modification/use. Hashes identify the snapshot
and are not additional license restrictions. This kit does not cover Bun/JSC or
clear the complete CLI/helper distribution for public release.
