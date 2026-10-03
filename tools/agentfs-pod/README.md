# AgentFS Pod filesystem

Native Xpod CLI helper implementing upstream AgentFS `FileSystem` / `File` over authenticated Pod HTTP. Upstream is pinned to `0a014ebd4918615baff589ed17486e557e7c6a23` in [tursodatabase/agentfs](https://github.com/tursodatabase/agentfs). The helper is a client artifact, separate from the Xpod service image.

## Platforms

- macOS: userspace NFS on a high loopback port, without macFUSE or system nfsd. OS mount permissions still apply. Mount options include `noac,actimeo=0,nobrowse`.
- Linux: upstream FUSE. `patches/fuse-revalidation.patch` changes three settings: zero attribute TTL and direct-I/O for opened/created files. Requires `/dev/fuse`, mount utilities and mount permissions.
- Both target builds apply `patches/nfs-directory-cookie.patch`: directory pages
  use ordered inode cookies so deleting the preceding entry cannot hide the
  rest of the directory. These small pinned patches are applied in isolated
  build trees; the mount adapters otherwise reuse upstream.
- macOS ARM64 NFS and Linux ARM64 container FUSE have been exercised. NAS hardware, Windows and other architectures are unverified.

## Session contract

- Enumeration/stat fetch metadata. Clean reads use HTTP ranges; clean bodies are not persistently duplicated. Bounded remote clean caching is future work.
- Mount mutations persist in one native session manifest and dirty blobs, becoming visible locally immediately. Only explicit `commit` writes the Pod.
- First-edit ETag, including absence for new files, survives restart and subsequent edits. Creates use `If-None-Match: *`; existing resources use `If-Match`. Conflicts preserve local content without refreshing the baseline to overwrite a newer remote version.
- Cross-process file locking reloads state per operation. Commit holds the lock throughout submission; edits wait rather than changing the submitted revision. HTTP timeout is 60 seconds per request.
- Copy-up and uploads stream; dirty reads seek. Missing blobs and malformed journals fail, never becoming empty uploads.
- Rename installs the destination before deleting the source, with durable intermediate receipts. HTTP rename is not remotely atomic.
- Unknown HTTP outcomes preserve dirty data and an in-flight marker; automatic replay is refused. `recover` reads the Pod without mutation: exact version-bound bytes/media type/resource kind confirm the desired state, an unchanged original baseline allows conditional retry, and conflicts/errors preserve the journal. Containers require an unanchored LDP `rel=type` proof. It never refreshes the baseline or merges conflicts.
- Directory create/delete is supported. Directory rename, symlinks and hard links are unsupported. Superseded dirty blobs can remain until commit GC.

## Build

AgentFS uses unstable Rust APIs. Patched macOS build/test from repository root:

```sh
bash tools/agentfs-pod/build-macos.sh
bash tools/agentfs-pod/build-macos.sh test
```

Patched Linux ARM64 helper:

```sh
sh tools/agentfs-pod/build-linux.sh
```

Linux builds use a pinned Rust Docker image, nightly `2026-09-30`, pinned upstream and the tracked patch in `.test-data/agentfs-linux-build`. They leave the macOS target and root Cargo lockfile unchanged and record output hashes. The build image is not a client runtime dependency.

macOS uses the same nightly, fixed pin and lock in `.test-data/agentfs-macos-build`,
then copies the release helper to the standard `tools/agentfs-pod/target/release`
discovery path. Use the build scripts for patched builds/tests; plain Cargo with
the root manifest resolves the unpatched upstream and the cookie regression fails.

## CLI usage

```sh
xpodcli agent-fs mount --pod-root https://pod.example/alice/ \
  --session-dir ~/.xpod/alice-session --mountpoint ~/pod
xpodcli agent-fs status --session-dir ~/.xpod/alice-session --json
xpodcli agent-fs commit --pod-root https://pod.example/alice/ \
  --session-dir ~/.xpod/alice-session
xpodcli agent-fs recover --pod-root https://pod.example/alice/ \
  --session-dir ~/.xpod/alice-session --json
xpodcli agent-fs unmount --session-dir ~/.xpod/alice-session --mountpoint ~/pod
```

The CLI owns credential refresh. Its loopback proxy delivers a random capability to the helper, bound to a canonical Pod root and authenticated WebID. `XPOD_AGENTFS_TOKEN` is retained for fixtures, not the product credential store. Successful unmount closes the proxy through its capability rather than a potentially reused PID.

## Verification and release limits

See [MVP acceptance](../../docs/agent-directory-mvp-acceptance.md). Native regressions use `cargo test`; actual mounts use opt-in `tests/agentfs-pod/nativeOverlayScenario.test.ts` and `scripts/accept-agentfs-pod.linux.mjs`. Fixture success does not prove the current public Gateway or actual account. License-source verification and public distribution remain pending.
