# Xpod CLI application source kit

`source-kit.json` binds this snapshot to the original CLI SHA-256, source
identity, target, compiler provenance and same-invocation JavaScript inputs.
The kit preserves staged first-party source, full selected installed packages
including nested versions and patched bytes, package manifests, lockfile,
build scripts and the binary preview's original notices under `licenses/`.
It does not contain the Bun/JSC/toolchain or native-helper source/build closure.
It is application material, not whole-artifact release clearance.

On the kit's target platform, invoke the compatible Bun you want to embed:

```sh
/path/to/modified-bun packages/xpod-cli/scripts/rebuild-application.ts --verify-only
/path/to/modified-bun packages/xpod-cli/scripts/rebuild-application.ts
```

The recipe verifies all preserved bytes and copies only those files into a
temporary staging directory, without installing dependencies or consulting the
original checkout. Same-platform `--compile` omits `--target`: the invoked Bun
executable is used, rather than selecting a downloadable runtime. Cross-target
rebuilds are refused. Compiler provenance is recorded, not required to remain
byte-identical: a modified compatible Bun is allowed.

`NODE_ENV`, `NODE_OPTIONS` and `BUN_OPTIONS` are removed for compilation; no
environment defines are configured. Other environment transport/loader settings
are inherited. No credential values are recorded. The exact executable version,
hash, arguments, rebuilt input hashes and new CLI hash are saved in
`.test-data/rebuild/receipt.json`; the executable is `.test-data/rebuild/xpodcli`.
The staging directory is deleted so it cannot supply a hidden native helper.

The input index preserves external-import names. Node/Bun builtin imports
require the compatible runtime; relative source and package exports retain
their original layout. This kit does not supply a native helper or user
credentials/configuration. Use the separately provided helper when mounting.

Hashes describe the preserved snapshot, not additional license restrictions.
Applicable component licenses govern modifications and use. Standard templates
are labeled as such; they are not invented upstream copyright notices.
Passing this application rebuild does not prove modified JSC/library rebuilds,
LGPL corresponding-source completeness, or whole-binary publication readiness.
