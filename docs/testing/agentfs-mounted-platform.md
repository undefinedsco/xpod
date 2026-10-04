# AgentFS mounted platform acceptance

Actual mounted (OS-level) acceptance for the frozen product archive, separate
from the source-bound native unit/install CI. The native compiler workflow
(`agentfs-native-acceptance.yml`) only runs on `codex/agentfs-native-acceptance`,
so this harness lives on its own development branch
`codex/agentfs-mounted-platform-acceptance` and pushing it triggers
`.github/workflows/agentfs-mounted-platform-acceptance.yml` without recompiling
the frozen `c7e9aadbf` product.

## Product vs harness binding

- **Product SHA** `c7e9aadbf87302908e766411f4ea1fea6d0a54bf`, consumed from the
  already-accepted run `37213350112`:
  - Linux artifact `11308595244`, zip `cdecb456…`, archive `93226994…`,
    helper `6704866f…`, Bookworm `rust@sha256:93ce27a8…`.
  - Darwin artifact `11307598254`, zip `32230726…`, archive `49b7b502…`,
    helper `84d665a4…`.
- **Harness SHA** is this branch's checkout (`git rev-parse HEAD`) and is
  recorded separately in `harness-facts.json` and in the driver receipt. The
  workflow checks out the harness SHA to run the tracked driver; it never
  rebuilds the product.

## Linux (real FUSE, Node22 noBun)

`ubuntu-24.04-arm` runner, inside a disposable owned Bookworm container with
`--device /dev/fuse --cap-add SYS_ADMIN` and `--network none` for the
acceptance stage (network is allowed only for the apt/Node prep stage):

1. Probe `/dev/fuse` and `/proc/filesystems fuse`; a missing device is an
   actual failure, never a pass.
2. Install exact Node `v22.21.1`; assert no `bun` is on `PATH` for acceptance.
3. Run `scripts/agentfs-native-ci/mounted/platform-admission.ts`, which verifies
   the product archive/helper digests, extracts the frozen archive, then runs the
   tracked harness `tests/agentfs-pod/nativeMountedPlatformMatrix.test.ts` under
   Node22 with `XPOD_AGENTFS_HELPER`, `XPOD_AGENTFS_TEST_CLI`,
   `XPOD_MOUNTED_BACKEND=fuse`, `XPOD_AGENTFS_RUN_OVERLAY=1`.
4. The driver records a real Popen wait, a closed `0600` raw log with SHA, and a
   `mounted-linux.receipt.json`. Cleanup removes only the owned container CID.

## macOS (system NFS, no macFUSE install)

`macos-14` runner runs the same driver with `XPOD_MOUNTED_BACKEND=nfs` against
the frozen Darwin helper over the system NFS path (no macFUSE install). Actual
prerequisite/permission failures are recorded as failures, never as passes.

## Matrix (tracked, no relaxation)

- Original `runMountAcceptance`: mount readiness, readdir/stat/read, seek range,
  large-file seek, dirty-before-commit, rename, commit visibility to search,
  external-update invalidation.
- Large files: 64/512/1024 MiB full-body SHA-256, ranged read bytes and copy-up.
- Fault: actual helper SIGKILL after an in-flight copy-up, same-session reopen,
  orphan partial-seed GC, retention of the uncommitted complete body, and the
  conditional `412` ETag baseline (commit must fail instead of overwriting).

Green CI/install units are not OS-mount acceptance; only a real mounted run on
an actual device/host counts.
