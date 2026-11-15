# Partial native notice collection

`darwin-arm64.json` and `linux-arm64.json` preserve the audited normal/build
Cargo inventories. They map package/version, original package-relative notice
path and SHA-256 to `objects/<sha>.txt`. Object bytes are copied unmodified;
identical text is stored once, without combining licenses or rewriting authors.
The two inventories have 481 and 502 notice-file references respectively.
The objects' Git attributes disable line-ending conversion and whitespace
cleanup so checkout preserves their audited byte hashes.

This is a collection of original candidates, not release clearance or proof
that every listed dependency is linked at runtime. Build-only packages can
include notices for other operating systems. Do not infer the whole helper's
license from those notices.

Zero files means the audited source package had no candidate notice text.
Turso and SimSIMD originals are supplemented separately in `licenses/native/`.
AgentFS, agentfs-sdk, genawaiter, genawaiter-macro and pack1 now have pinned
declaration and standard-term supplements in `../declarations/`; a zero-file
candidate here does not mean an undeclared license. First-party helper and
whole-artifact release review remain separate. The collection excludes the
compiled CLI's Bun/TypeScript dependencies and external OS shared libraries.

`runtimeNotices` separately preserves ten original sysroot notice texts for
`nightly-2026-09-30`, compiler commit `5c543b0b8c73c7b72bc8284ced4fb22ead15734d`.
The standard-library attribution collection includes unrelated build/target
materials and is not the helper's exact link graph. Original Unicode and composite
compiler-builtins/libm/LLVM notices remain intact. Builds with a native receipt
require its actual compiler commit/toolchain to match this provenance; missing,
changed or unsafe runtime notice material fails before copying.

Generate Cargo candidates for any of `darwin-arm64`, `darwin-x64`,
`linux-arm64`, or `linux-x64` with
`scripts/collect-native-notices.ts <target> <audited inventory JSON> <actual runtime evidence JSON> <owned output directory>`.
The Cargo inventory must come from that target's actual native workspace.
The runtime evidence explicitly names the same target, compiler commit and
toolchain, and supplies each original runtime file's absolute input path,
source-relative path, provenance source and SHA-256. Input paths are not copied
into the public index. All input bytes are validated before output is written.
The collector never reads another architecture's index as a fallback, and can
create a target collection without a pre-existing index. Existing ARM indexes
remain preserved audited material, not evidence for an x64 build.

Build-time generation belongs in an owned producer output directory, outside
the immutable source checkout. Its target index, referenced content-addressed
objects and original input evidence must be hash-bound to the native receipt
and passed explicitly to packaging; generating files in the checkout while
claiming clean source is not supported. The collector checks separately audited
sysroot material; it does not derive that material from a Cargo dependency tree.
A compiler change requires new runtime evidence before an inventory is published.
The native producer prepares `rust-docs` for its exact fixed toolchain as a
separately closed stage. While the verified staged workspace is still present,
the generator runs frozen Cargo metadata filtered to the actual compiler host,
traverses normal/build dependencies (excluding dev-only packages), and reads
`share/doc/rust/COPYRIGHT-library.html` plus the installed `licenses/` originals.
Missing compiler documentation fails generation. Private metadata/sysroot
command outputs remain under producer `native-notice-inputs/`; the public
provenance contains their hashes, exact command arguments and closed statuses.
Packaging uses `--native-notices <producer output/native-notices>` and verifies
the index/provenance against the actual helper build receipt. Its copied index,
objects and provenance are separately inventoried in the package manifest.
The inventory must match the target and every original hash must match. The
build copies only that target's referenced objects, verifies all hashes before
copying, and records each output hash in the install manifest. Missing or
changed objects fail the build. The public release gate remains blocked.
