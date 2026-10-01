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

Regenerate Cargo candidates with `scripts/collect-native-notices.ts <target> <audited inventory>`.
The collector preserves and checks separately audited sysroot material; it does
not derive that material from a Cargo dependency tree. A compiler change requires
new runtime evidence before either inventory can be published.
The inventory must match the target and every original hash must match. The
build copies only that target's referenced objects, verifies all hashes before
copying, and records each output hash in the install manifest. Missing or
changed objects fail the build. The public release gate remains blocked.
