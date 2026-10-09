# @undefineds.co/xpod-cli

默认 npm 产物安装 `xpod`：认证、原始 Pod HTTP 客户端及模块管理独立构建，CSS/API/AFS 按需下载。规范与当前模块发布边界见 [模块分发规范](../../docs/module-distribution.md)。

```sh
bun run typecheck
bun run test
bun run build
bun pm pack
./dist/bin/xpod --help
./dist/bin/xpod module list
```

默认包不带服务、UI 或 native helper。`xpod afs` 首次使用下载匹配的平台模块，`xpod module install afs --version <version>` 显式更新；平台模块尚未发布时返回 unavailable。单独发布 CLI 不会自动发布服务或修改服务版本。

## 旧预览产物（迁移期）

默认 `test` 和 `verify` 只检查独立 CLI；`test:preview` 与 `verify:preview` 保留旧预览兼容门禁。下文只描述显式 `build:preview` 的旧客户端/helper 预览。新 npm 入口为 `src/npm-entry.ts`；旧 `src/entry.ts` 不在默认发行构建中。

Client-only build profile of Xpod. Xpod is the overall product; CLI and App are
its user surfaces, with CSS, API and AFS as optional capability modules. This
preview packages auth and AFS client capabilities; AgentFS is the internal AFS
engine. Unified optional server-module startup is still a design, not an
implemented feature. Command display name **Xpod CLI**, binary
`xpodcli`, candidate package `@undefineds.co/xpod-cli`, candidate version
`0.1.0-preview.1`.

Current delivery uses an external runtime: installed **Bun >=1.3.8**, or
**Node.js >=22.13** when Bun is absent. It bundles Node-compatible ESM and the
native AgentFS helper, with no Bun/Node executable or JavaScriptCore libraries.
The launcher selects once; a failing command is never retried under another
runtime. Older embedded-runtime previews are historical artifacts.

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
bun scripts/build.ts --target darwin-arm64 --helper /path/to/agentfs-pod \
  --native-sources /path/to/native-source --native-receipt /path/to/receipt.json
```

If no real helper is available, full mode **fails closed** (exit 3). A
diagnostic check binary, an empty file or a script is never substituted.
Full packaging also requires a verified source kit and matching receipt; a
same-architecture helper with unknown compiler provenance cannot inherit the
fixed Rust runtime attribution.

`XPOD_CLI_DISABLE_REPO_HELPER=1` disables the `tools/agentfs-pod/target/*`
auto-discovery so the fail-closed path can be exercised without touching
another worker's build output.

Cross targets (e.g. `--target linux-arm64`) are marked `unverified` by the
packaging script until tested on the target OS. The helper binary header
must match the requested OS/architecture; an explicit missing helper
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

Packaging has separate generated-prefix evidence for Bun 1.3.8, 1.3.12 and
CI's Bun 1.4.2. The 1.4.2 record binds its official source commit and the
1867-byte prefix emitted by the actual compiler; earlier records remain intact.
Each compiler has its own hash-bound generated JavaScript prefix/source notices;
an unknown compiler version or changed prefix fails the build. This restriction
is on artifact production, not the installed CLI's external runtime requirements.
Native source receipts additionally bind the fixed Rust compiler/sysroot notice
provenance. Neither compiler executable is included in the installed client.

Output under `.test-data/agent-directory-workers/xpod-cli-package/out/<target>/`:

```
install/
  bin/xpodcli          external-runtime launcher
  bin/xpodcli-env      link to the same launcher
  lib/xpodcli.mjs      Node-compatible ESM client payload
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

The installed entry is `bin/xpodcli` (a shell launcher), with portable code at
`lib/xpodcli.mjs` and the native helper at `helper/agentfs-pod`. The JavaScript
payload is architecture independent; only the helper needs native header checks.
The runtime must already be installed; the launcher does not install software.

Each bundle writes a Bun metafile outside the install archive and derives
`licenses/javascript/index.json` before deleting the staging tree. The index
records input hashes, nested package versions, declared licenses, missing
originals and external import names, bound to the compiled CLI's SHA-256.
Available root/explicit license-directory texts are copied byte-for-byte into
content-addressed objects and included in the install manifest. Zero-output
inputs remain visible as conservative candidates. No build-machine absolute
paths are included in the installed index.

This collection is not a complete file-level license audit. External Bun/Node
are prerequisites rather than distributed executable contents. Historical embedded
ARM64 builds identified 15 package instances and
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

The script stages only verified files and does not install dependencies. Bun
is used as a bundler; its executable is not embedded. The original bundler hash
is provenance. Bundle options/environment handling are shared with the package builder;
the receipt records actual rebuilt input hashes and compiler/output identities.
The temporary staging directory is removed to prevent checkout helper discovery.

Installation verification rejects missing sources or notices, duplicate archive
members, links, changed bytes and mismatched CLI/source/target binding. An outer
archive hash alone does not prove the source material is complete.

This kit covers the application side. Native helper source/build material remains
separate. Old Bun/JSC research applies to historical embedded previews; it is
not evidence that a runtime is bundled by the current profile. A successful
application rebuild does not clear native/JavaScript release review.
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

## Evidence-bound promotion

Builds stop at a pending candidate; publication is a separate, explicit step.
`scripts/promote.ts` takes an existing candidate plus structured
acceptance/review evidence and writes a **separate** promoted install/archive.
It binds the candidate manifest hash and every reviewed artifact hash, requires
the actual tested native receipt, installed target acceptance and live
Xpod Gateway/canonical Pod acceptance, reuses post-install/source/hash
verification, then derives license statuses and `full-verified` only from
complete evidence and computes readiness from `publicGateProblems`. The
explicit `--installed-report`/`--gateway-report` files are hashed and their
required facts re-checked; a missing/stale file or any output overlapping the
candidate is rejected. The original candidate and its bytes are never modified;
invalid evidence fails closed before output. It does not make ordinary builds
release-ready and no flag is hand-edited. See [RELEASE-PROMOTION.md](RELEASE-PROMOTION.md).

## License status (actual, unverified)

- Xpod-owned code: root MIT `LICENSE` copied verbatim to `licenses/xpod/LICENSE`, hash-bound by the manifest and preserved in application source material.
- AgentFS SDK (`sdk/rust/Cargo.toml`): `license = "MIT"` (verified field).
- AgentFS whole-project pinned README declares MIT; CLI Cargo.toml lacks its own field. The README and SDK manifest are bundled verbatim with selected standard MIT terms and source hashes.
- AgentFS repository root has no LICENSE/COPYING text. This is informational, not a filename-based release requirement. [Declaration supplements](licenses/native/declarations/README.md) also cover three pinned registry crates; literal standard-template placeholders are not invented copyright claims. Vendored original notices remain bundled and individually hashed.
- rclone (MIT) is a research backend only and is **not** bundled.

The preview manifest therefore stays below `full-verified` and the public gate
blocks while whole-artifact obligations for the JavaScript bundle and native helper
remain pending. Installed Bun/Node runtimes are not distributed in this package.

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
