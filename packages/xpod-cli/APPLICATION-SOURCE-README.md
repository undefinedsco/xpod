# Xpod CLI application source kit

`source-kit.json` binds this snapshot to the original CLI SHA-256, source
identity, target, compiler provenance and same-invocation JavaScript inputs.
The kit preserves staged first-party source, full selected installed packages
including nested versions and patched bytes, package manifests, lockfile,
build scripts and the preview's original notices under `licenses/`.
It does not contain the Bun/JSC/toolchain or native-helper source/build closure.
It is application material, not whole-artifact release clearance.

Invoke installed Bun as the build tool. Its runtime is not embedded:

```sh
/path/to/bun packages/xpod-cli/scripts/rebuild-application.ts --verify-only
/path/to/bun packages/xpod-cli/scripts/rebuild-application.ts
```

The recipe verifies all preserved bytes and copies only those files into a
temporary staging directory, without installing dependencies or consulting the
original checkout. The shared recipe uses `--target=node --format=esm`, without
`--compile` or native runtime downloads. The JavaScript can be rebuilt on another
platform; the kit's target identifies the associated native-helper distribution.
Bundler provenance is recorded, not required to remain byte-identical.

`NODE_ENV`, `NODE_OPTIONS` and `BUN_OPTIONS` are removed for compilation; no
environment defines are configured. Other environment transport/loader settings
are inherited. No credential values are recorded. The exact executable version,
hash, arguments, rebuilt input hashes and new CLI hash are saved in
`.test-data/rebuild/receipt.json`; the payload is `.test-data/rebuild/xpodcli.mjs`.
The staging directory is deleted so it cannot supply a hidden native helper.

The input index preserves external-import names. Node/Bun builtin imports
require the compatible runtime; relative source and package exports retain
their original layout. This kit does not supply a native helper or user
credentials/configuration. Use the separately provided helper when mounting.

Hashes describe the preserved snapshot, not additional license restrictions.
Applicable component licenses govern modifications and use. Standard templates
are labeled as such; they are not invented upstream copyright notices.
Passing this application rebuild does not prove native-helper or whole-artifact
publication readiness. No Bun/JSC runtime is part of the current CLI payload.
