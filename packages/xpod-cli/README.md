# @undefineds.co/xpod-cli (preview packaging)

Client-only build profile of Xpod. Xpod is the overall product; CLI and App are
its user surfaces, with CSS, API and AFS as optional capability modules. This
preview packages auth and AFS client capabilities; AgentFS is the internal AFS
engine. Unified optional server-module startup is still a design, not an
implemented feature. Command display name **Xpod CLI**, binary
`xpodcli`, candidate package `@undefineds.co/xpod-cli`, candidate version
`0.1.0-preview.1`.

This package currently builds **reviewable preview artifacts**. Public release
is a separate gated step, pending complete notices, clean source identity and
real Gateway acceptance. It does not include the Xpod server runtime, UI,
Agent SDK, control-server commands or a second credential store.

## Client surface

`src/main.ts` reuses the existing command registrations:

- `auth` (`src/cli/commands/auth`)
- `login` (`src/cli/commands/login`)
- `agent-fs` (`src/cli/commands/agent-fs`, including `rg`, `install`, `mount`,
  `unmount`, `proxy`, `commit`, `recover`, `status`)

Control-server commands (`start`, `stop`, `logs`, `server`, `account`,
`backup`, `restore`, `doctor`) are **not** registered; the installed-acceptance
check asserts this from `--help`.

## Build

```sh
# CLI only (dev): no native helper; never a full install pass
bun scripts/build.ts --cli-only --target darwin-arm64

# Full candidate: requires a REAL AgentFS helper
bun scripts/build.ts --target darwin-arm64 --helper /path/to/agentfs-pod
# or: XPOD_AGENTFS_HELPER=/path/to/agentfs-pod bun scripts/build.ts --target darwin-arm64
```

If no real helper is available, full mode **fails closed** (exit 3). A
diagnostic check binary, an empty file or a script is never substituted.

`XPOD_CLI_DISABLE_REPO_HELPER=1` disables the `tools/agentfs-pod/target/*`
auto-discovery so the fail-closed path can be exercised without touching
another worker's build output.

Cross targets (e.g. `--target linux-arm64`) are marked `unverified` by the
packaging script until tested on the target OS. Both CLI and helper binary
headers must match the requested OS/architecture; an explicit missing helper
cannot fall back to a host binary. The separately run Linux ARM64 container
harness tests the installed CLI, real FUSE mounts, auth proxy, dirty restart,
commit, lost receipt recovery and conflicts. NAS hardware and x64 remain unverified.

The Linux release helper is dynamically linked to glibc and OpenSSL 3 through
Turso's native-tls dependency. A minimal Debian container without `libssl3`
cannot launch it. Install verification runs the helper's version/help commands
and reports loader failures; it does not silently install system libraries.
Linux FUSE also requires `/dev/fuse` and mount permission. macOS uses its system
NFS client and does not require an additional FUSE driver.

## Artifacts

Output under `.test-data/agent-directory-workers/xpod-cli-package/out/<target>/`:

```
install/
  bin/xpodcli          compiled standalone CLI
  bin/xpodcli-env      launcher; sets the EXISTING XPOD_AGENTFS_HELPER key only
  helper/agentfs-pod   native helper (separate artifact; when available)
  config/minimal.json  minimal install config
  NOTICES.md           license status incl. pending entries
  licenses/agentfs/    unmodified fuser/nfsserve license texts (manifest hashes)
  licenses/native/     pinned Turso/SimSIMD texts; Linux also libaegis
  licenses/native/collection/  target-specific audited notice originals + hashes
  licenses/javascript/  exact compile input index + original package notice candidates
  sources/application-source.json  source-kit inventory bound to CLI/source identity
  sources/application-source.tar.gz  application/dependency bytes, notices and rebuild recipe
  manifest.json        source/engine/hash/validation identity
  manifest.local.json  present for dirty local previews
xpod-cli-<version>-<target>.tar.gz
build-summary.json
```

The CLI and native helper are separate artifacts; they are not fused into one
executable.

Each compile writes a Bun metafile outside the install archive and derives
`licenses/javascript/index.json` before deleting the staging tree. The index
records input hashes, nested package versions, declared licenses, missing
originals and external import names, bound to the compiled CLI's SHA-256.
Available root/explicit license-directory texts are copied byte-for-byte into
content-addressed objects and included in the install manifest. Zero-output
inputs remain visible as conservative candidates. No build-machine absolute
paths are included in the installed index.

This collection is not a complete file-level license audit and excludes Bun's
embedded runtime. The current ARM64 builds identify 15 package instances and
12 unique original notice candidates. Inrupt 3.1.1 supplements are bound by
name/version to the publisher metadata gitHead, original notice SHA-256 and
archive integrity. Broader source/runtime audit gaps remain pending, including
in CLI-only builds. Details: [JavaScript notice evidence](../../docs/xpod-cli-javascript-notices.md).

## Application rebuild materials

Every build, including CLI-only builds, includes the actual staged application
source and selected installed dependency trees. Nested versions, package
resolution metadata and local patched bytes are preserved, with the lockfile,
original notices and rebuild script. This avoids substituting unpatched upstream
packages for the inputs that produced the CLI. The inventory records every file's
size/hash, exact compile inputs, target, original compiler and source identity.

Extract `sources/application-source.tar.gz` into an independent directory and run:

```sh
cd application-source
/path/to/compatible-bun packages/xpod-cli/scripts/rebuild-application.ts --verify-only
/path/to/compatible-bun packages/xpod-cli/scripts/rebuild-application.ts
```

Rebuild on the kit's target platform. The script stages only verified files,
does not install dependencies, and embeds the invoked Bun executable. The original
compiler hash is provenance, not a restriction against using a compatible modified
runtime. Compile options/environment handling are shared with the package builder;
the receipt records actual rebuilt input hashes and compiler/output identities.
The temporary staging directory is removed to prevent checkout helper discovery.

Installation verification rejects missing sources or notices, duplicate archive
members, links, changed bytes and mismatched CLI/source/target binding. An outer
archive hash alone does not prove the source material is complete.

This kit covers the application side. Bun/JSC/toolchain and native helper source
and build closure remain separate. A successful application rebuild does not
claim a modified LGPL library has been rebuilt/relinked or clear public release.
See [the kit instructions](APPLICATION-SOURCE-README.md).

## Native helper rebuild materials

The optional native kit preserves the fixed upstream Git archive, full patched
AgentFS tree, both patches, original helper manifest/lock, working path-dependency
manifest/lock, all locked Cargo crate trees/checksums and original notices. Only
the two AgentFS Git source identities are replaced; registry versions/checksums
stay unchanged. C/assembly source subdirectories are included.

Export from an existing upstream Git checkout, using an installed recorded
nightly toolchain, then rebuild on the target platform:

```sh
bun packages/xpod-cli/scripts/export-native.ts --upstream /path/to/agentfs-git --out /path/to/native-source --offline
cd /path/to/native-source
bun packages/xpod-cli/scripts/rebuild-native.ts --out /path/to/native-build --test
```

Package from the Xpod checkout with the rebuilt helper and its matching receipt:

```sh
bun packages/xpod-cli/scripts/build.ts --helper /path/to/native-build/agentfs-pod --native-sources /path/to/native-source --native-receipt /path/to/native-build/receipt.json
```

The source/receipt arguments must be supplied together. Installation verifies
every native archive member, applied patches, the exact lock transformation,
complete vendor checksum coverage and receipt binding to helper/engine/target.
Rebuild stages only verified files, uses an empty Cargo home and frozen offline
resolution, clears external Git overrides and selects explicit installed
cargo/rustc binaries. It neither installs dependencies nor uses a parent checkout.

The kit excludes compiler/SDK/sysroot/system libraries and Bun/JSC. Cargo's
offline mode does not sandbox arbitrary build-script networking; that requires
a separately verified network-disabled build. A source kit and build receipt
do not raise the public release status. See [native kit instructions](NATIVE-SOURCE-README.md).

## Manifest and public gate

`src/manifest.ts` defines the schema:
`sourceSHA`, `dirtyTreeHash`, `selectedEnginePin`, `platform`, `version`,
`artifacts[].sha256`, `validationState`, plus source mode/channel.

- A dirty working tree produces a **local preview** manifest
  (`channel: local-preview`, `source.mode: local-preview`, `dirtyTreeHash` set)
  that identifies the source content.
- A public release requires an exact commit and a clean tree.
- `publicGateProblems()` explicitly blocks: local/dirty source, absent or
  mismatched hash-bound engine license evidence, pending SDK/CLI/artifact licenses, omitted artifacts, and any
  `validationState` below `full-verified`. It never auto-assigns MIT to an
  unknown license.

## License status (actual, unverified)

- AgentFS SDK (`sdk/rust/Cargo.toml`): `license = "MIT"` (verified field).
- AgentFS whole-project pinned README declares MIT; CLI Cargo.toml lacks its own field. The README and SDK manifest are bundled verbatim with selected standard MIT terms and source hashes.
- AgentFS repository root has no LICENSE/COPYING text. This is informational, not a filename-based release requirement. [Declaration supplements](licenses/native/declarations/README.md) also cover three pinned registry crates; literal standard-template placeholders are not invented copyright claims. Vendored original notices remain bundled and individually hashed.
- rclone (MIT) is a research backend only and is **not** bundled.

The preview manifest therefore stays below `full-verified` and the public gate
blocks while whole-artifact obligations, particularly the embedded Bun runtime
and corresponding rebuild material, remain pending.

## Installed acceptance

The same script used by the build hook is the post-install acceptance command:

```sh
bun scripts/verify-install.ts --dir <install dir>
bun scripts/verify-install.ts --archive <tar.gz>
bun scripts/verify-install.ts --archive <tar.gz> --public   # release gate
```

It extracts the archive into a fresh temp dir, runs the extracted binary from a
neutral cwd and re-checks manifest hashes, source-bound engine declaration
material and complete object coverage, application source archive bodies and
CLI/source identity binding, `--version`, `--help`,
`agent-fs status`, placeholder/check-masquerade and (optionally) the public
gate. A bundled helper must actually run `--version` and `--help`; file presence
alone is insufficient. Source-TS resolution is not accepted as install proof.
