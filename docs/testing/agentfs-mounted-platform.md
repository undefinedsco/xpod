# AgentFS mounted platform acceptance

## Owned FUSE lifecycle contract

The owned FUSE entry publishes readiness only after its actual Session is
created. Its unique filesystem source name derives from the same private owner
nonce; target, source and kernel mount identity must match before binding.
A matching generic FUSE label is insufficient to claim this invocation's mount.

The owned entry preserves its Session without the upstream path-based Drop
cleanup. Unknown or changed kernel identity retains the daemon and lease and
rejects unmount. Successful control completion requires the actual unmount
child's successful close and bound kernel absence; the daemon also waits for
its real blocking Session loop to return. Its actual process exit releases the
retained FUSE descriptor. Native policy tests and source review do not replace
the real installed-module mounted acceptance.

## Installed module failure diagnostics

The installed-module mounted chain records its primary failure separately from
`module-chain-cleanup.safe.json`. `module-chain-failure.safe.json` contains only
the backend, a fixed operation stage, an approved error code, the exception's
SHA-256 and `primaryFailureObserved`. The exporter rejects invalid enum values,
non-hex hashes and non-boolean success claims; it drops unrelated fields.
Messages, stacks, raw logs, credentials and argv remain private.

A cleanup failure cannot turn a failed chain into a pass or replace its primary
exception: both causes are retained when cleanup also fails. Kernel absence and
successful unmount child closure alone do not prove daemon absence. Unknown
native identity leaves the mounted chain unaccepted. Ordinary tests that skip
the actual mount case do not validate this mounted contract.

## mini mounted gate passed (2026-10-07)

[Run 37611622913](https://github.com/undefinedsco/xpod/actions/runs/37611622913)
completed successfully with harness `afac65595545771ebdb001200a7f6000f9143bf0`
and the unchanged native product `48a71dceddf4ab40eddc52a5bb04c54474eeb030`.
Linux FUSE reports 15 passed / 2 skipped; Darwin system NFS reports
14 passed / 3 skipped (including the Linux-only procfs test). All six required
mounted cases passed on both platforms. Downloaded evidence was independently
checked for archive/helper identities, raw/report hashes, actual producer
closure, absent owned process groups and Linux same-container cleanup.
Both journals reached verified 64/512/1024 MiB reads, conditional in-place
copy-up and commit, with nonempty RSS samples below the unchanged ceiling.
Linux large-file matrix completed in about 27 seconds; its read/copy-up RSS
peaks were 44576/48672, 49056/51116 and 52740/42740 KiB respectively.
The procfs-only sampler eliminated the prior same-process fork interference
without changing the helper, transfer budget, file sizes or RSS thresholds.

This admits only the frozen native/install + mounted platform gate described
here. It is not Pro Public16/Private17, a GZ PG17 restore, real OAuth/DPoP/Pod,
Gateway/Models/Chat/Tasks, desktop or release promotion evidence. Those remain
separate required gates. Earlier failures below remain evidence of their runs.

## mini continuation candidate (2026-10-07)

The current product pin is `48a71dceddf4ab40eddc52a5bb04c54474eeb030`, from
[native run 37592276758](https://github.com/undefinedsco/xpod/actions/runs/37592276758).
Both downloaded artifact ZIPs passed the independent `verify_reuse_archive`
gate, including raw hashes, stage closure, source snapshots, packages and helper
digests. Each helper reports 98 passed / 2 existing ignored / 0 filtered;
Darwin has 13 closed stages and Linux has 20, including Bookworm Node22/noBun
loader admission. Their source-kit SHA256 is identical. This does not prove
actual mounting. The mounted workflow now pins these exact artifacts; the
separate mini harness branch is `codex/solidfs-mounted-mini-20261007`, dispatched
explicitly without moving other development branches. Historical failures and
earlier product bindings below remain evidence of their own runs.

Mounted run [37605017722](https://github.com/undefinedsco/xpod/actions/runs/37605017722)
used harness `f407bf815e72c157637659548cc76f7e7191812b`. Darwin completed
12 cases with 2 skips; all six required mounted cases passed, with closed
producer/owned-group receipts and independently checked raw/report hashes.
Linux stopped before releasing the mounted consumer: Docker reported the exact
requested capability as `CAP_SYS_ADMIN`, while the observer expected only
`SYS_ADMIN`. Its raw inspect shows network none, unprivileged execution,
AppArmor unconfined and default seccomp mode 2; owned-container removal and
absence were verified. This is not a Linux mount pass. The observer now accepts
only these two equivalent single-capability spellings, with negative regression
cases still rejecting additional, missing or unrelated capabilities. Product
archives and security settings remain unchanged; a fresh mounted run is required.

Run [37605718068](https://github.com/undefinedsco/xpod/actions/runs/37605718068)
used harness `e4d36cd1d0df47d97bb5ddb22f50b92c60464e0c`. Darwin again passed
12 cases, with all required cases and independently verified raw/report hashes.
Linux's same-container security binding passed, then the suite reported
11 passed / 1 failed / 2 skipped. The 64 MiB stream/copy-up/commit passed;
512 MiB Range reads completed, but in-place copy-up failed with EIO after the
572-second whole-file budget. The helper recorded 115539968 received and fully
written bytes, with a chunk-stage HTTP timeout. Producer closure, raw hash and
owned-container absence were independently checked. This does not admit Linux.
The next harness adds bounded disk-stream counters (actual bytes/chunks read,
maximum read gap, source end and response finish/close) to the server journal.
The old `responseBytes` is a declared length, not observed transfer completion.
No helper, transfer deadline, size or RSS acceptance threshold changes here.

Diagnostic run [37607806527](https://github.com/undefinedsco/xpod/actions/runs/37607806527)
again failed Linux 512 MiB copy-up. The server read 86114304 bytes in 1314
chunks, then recorded a 571827 ms maximum read gap; source end and response
finish were false. The helper received/wrote 86048768 bytes before its
572001 ms timeout. These counters narrow the stall to an unfinished server
stream, but do not yet distinguish reader scheduling from socket backpressure.
The next diagnostic captures bounded Linux thread wait points for only the test
process/helper plus Node active-resource type counts. No argv or credentials
are captured; no product or acceptance policy is changed.

Run [37609620312](https://github.com/undefinedsco/xpod/actions/runs/37609620312)
again failed 512 MiB copy-up. Its bounded thread evidence shows the Node main
thread in `anon_pipe_read`, with all four libuv workers idle; only three samples
were collected across the long timeout, disproving the worker-pool saturation
hypothesis. The pinned upstream FUSE write handler synchronously `block_on`s
`pwrite`, so fork/exec descriptor closure can wait for a queued FUSE flush while
the same Node parent must serve the HTTP response. Linux RSS/thread sampling now
reads `/proc` directly, without spawning while mounted descriptors are active.
This tests the sampler-induced deadlock hypothesis; actual mounted acceptance
is still required before claiming the failure fixed. Budgets and product pins
remain unchanged.

Actual mounted (OS-level) acceptance for the frozen product archive, separate
from the source-bound native unit/install CI. The native compiler workflow
(`agentfs-native-acceptance.yml`) only runs on `codex/agentfs-native-acceptance`,
so this harness lives on its own development branch
`codex/agentfs-mounted-platform-acceptance` and pushing it triggers
`.github/workflows/agentfs-mounted-platform-acceptance.yml` without recompiling
the frozen `c7e9aadbf` product.

Status as of 2026-10-05: diagnostic harness `3db4d4f326a485c1203aa1f8f61daa907fe6bbec`
passed two original, unfiltered integration runs on unchanged source/runtime
materials. Actual dual-platform [run 37234188908](https://github.com/undefinedsco/xpod/actions/runs/37234188908)
failed on both platforms. Linux foreground-helper stderr reports
`fusermount3: mount failed: Permission denied`; the exact capability/device/LSM
cause remains unproved. macOS fails the beforeAll kernel-mount observation with
`unknown`, before starting the NFS scenes; five required cases remain pending.
Do not turn unknown into absent or call this an NFS permission error. Environment
and observer fixes remain necessary. Native/install success and gated test skips
do not satisfy mounted acceptance.

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
4. The driver must record the actual child close, a closed `0600` raw log with SHA, and a
   `mounted-linux.receipt.json`. Cleanup removes only the owned container CID.
   Pending, spawn error and signal termination remain distinct failure facts;
   a timeout must also retire owned test descendants and verify mount absence.

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
