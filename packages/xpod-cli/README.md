# @undefineds.co/xpod-cli (preview packaging)

Standalone, client-only Xpod CLI. Command display name **Xpod CLI**, binary
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
  manifest.json        source/engine/hash/validation identity
  manifest.local.json  present for dirty local previews
xpod-cli-<version>-<target>.tar.gz
build-summary.json
```

The CLI and native helper are separate artifacts; they are not fused into one
executable.

## Manifest and public gate

`src/manifest.ts` defines the schema:
`sourceSHA`, `dirtyTreeHash`, `selectedEnginePin`, `platform`, `version`,
`artifacts[].sha256`, `validationState`, plus source mode/channel.

- A dirty working tree produces a **local preview** manifest
  (`channel: local-preview`, `source.mode: local-preview`, `dirtyTreeHash` set)
  that identifies the source content.
- A public release requires an exact commit and a clean tree.
- `publicGateProblems()` explicitly blocks: local/dirty source, missing root
  LICENSE, pending SDK/CLI/artifact licenses, omitted artifacts, and any
  `validationState` below `full-verified`. It never auto-assigns MIT to an
  unknown license.

## License status (actual, unverified)

- AgentFS SDK (`sdk/rust/Cargo.toml`): `license = "MIT"` (verified field).
- AgentFS whole-project pinned README: declares MIT; CLI Cargo.toml lacks its own field. The remaining pending item is full copyright/notice provenance, not absence of a project declaration.
- AgentFS repository root: no LICENSE/COPYING text; own notice provenance remains pending. The pinned vendored fuser MIT and nfsserve BSD-3-Clause texts are bundled unmodified and individually hashed.
- rclone (MIT) is a research backend only and is **not** bundled.

The preview manifest therefore stays below `full-verified` and the public gate
blocks. This is intentional until the license question is resolved explicitly.

## Installed acceptance

The same script used by the build hook is the post-install acceptance command:

```sh
bun scripts/verify-install.ts --dir <install dir>
bun scripts/verify-install.ts --archive <tar.gz>
bun scripts/verify-install.ts --archive <tar.gz> --public   # release gate
```

It extracts the archive into a fresh temp dir, runs the extracted binary from a
neutral cwd and re-checks manifest hashes, `--version`, `--help`,
`agent-fs status`, placeholder/check-masquerade and (optionally) the public
gate. A bundled helper must actually run `--version` and `--help`; file presence
alone is insufficient. Source-TS resolution is not accepted as install proof.
