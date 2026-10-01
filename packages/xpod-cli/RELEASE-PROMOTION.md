# Xpod CLI release promotion (operator guide)

Ordinary `scripts/build.ts` output is always a **preview candidate**: clean or
dirty, `publicReleaseReady=false`, artifact licenses `pending`,
`validationState` at most `install-verified`. Nothing in the build path clears
the public gate.

Promotion is a **separate, explicit, evidence-bound step**. It takes an existing
candidate plus structured acceptance/review evidence and writes a *separate*
promoted install/archive/summary. The original candidate and every original
notice/source byte are preserved untouched.

```sh
bun packages/xpod-cli/scripts/promote.ts \
  --candidate <install dir | xpod-cli-<version>-<target>.tar.gz> \
  --evidence  <promotion-evidence.json> \
  --out       <output root> \
  [--skip-exec]                     # foreign target: cannot execute here
```

The command:

1. runs the shared post-install verification (`scripts/verify-install.ts`)
   against the candidate (with `--skip-exec` for a non-host target);
2. validates the evidence purely against the candidate manifest
   (`validatePromotionEvidence`);
3. re-verifies the application source kit, native source kit and the **actual
   tested native build receipt** on disk, including `testsPassed === true` and
   the compiler identities named by the evidence;
4. derives the promoted manifest only from complete reviews, then computes
   readiness from `publicGateProblems`;
5. writes `<out>/<platform>/{install, xpod-cli-<version>-<platform>-promoted.tar.gz,
   promotion-summary.json}`.

Missing/invalid evidence fails closed **before any output**: the candidate is
left intact and no public success is claimed. The installed release contains a
sanitized, hash-bound `promotion-record.json`; keep auth secrets and raw private
logs out of the evidence and record.

## Evidence schema (schemaVersion 1)

All hashes are lowercase 64-hex; source/engine commits are 40-hex.

```json
{
  "schemaVersion": 1,
  "candidate": {
    "manifestSha256": "<sha256 of the candidate install/manifest.json bytes>",
    "platform": "darwin-arm64",
    "sourceSHA": "<exact 40-hex commit>",
    "engine": { "engine": "agentfs",
      "repository": "https://github.com/tursodatabase/agentfs",
      "commit": "<40-hex>" }
  },
  "reviews": [
    { "name": "agentfs-pod", "kind": "native-helper",
      "path": "helper/agentfs-pod", "sha256": "<artifact hash>",
      "spdx": null, "status": "verified",
      "provenance": "where the review came from for these exact bytes" }
  ],
  "nativeTest": {
    "target": "darwin-arm64",
    "receiptSha256": "<hash of sources/native-source-build.json>",
    "sourceKitSha256": "<hash of sources/native-source.json>",
    "helperSha256": "<hash of helper/agentfs-pod>",
    "compiler": { "toolchain": "nightly-YYYY-MM-DD",
      "cargoSha256": "<64-hex>", "rustcSha256": "<64-hex>" },
    "testsPassed": true, "testsFailed": 0, "testsIgnored": 0
  },
  "installedAcceptance": {
    "target": "darwin-arm64", "backend": "nfs", "executedOnTarget": true,
    "cliSha256": "<hash of lib/xpodcli.mjs>",
    "launcherSha256": "<hash of bin/xpodcli>",
    "helperSha256": "<hash of helper/agentfs-pod>",
    "reportSha256": "<64-hex>",
    "realMountScenariosPassed": 2, "mountScenariosFailed": 0,
    "informationalSkips": 1,
    "lifecycleProven": true, "cleanedOwnedResources": true
  },
  "gatewayAcceptance": {
    "target": "darwin-arm64", "sourceSHA": "<exact commit>",
    "proofKind": "live-gateway",
    "canonicalPodWrite": true, "storageBindingValidated": true,
    "success": true, "sanitized": true, "reportSha256": "<64-hex>"
  },
  "notes": []
}
```

Rules enforced by the pure validator and the script:

- **Candidate identity**: `external-runtime`, `source.mode=release`, not dirty,
  `dirtyTreeHash=null`, exact `sourceSHA`; `candidate.platform`,
  `candidate.sourceSHA` and `candidate.engine` must match the manifest exactly.
- **Reviews**: every included artifact needs exactly one review whose
  `kind`/`path`/`sha256` match the manifest. Duplicates, unexpected entries,
  missing reviews, changed bytes and empty provenance are rejected. `spdx` may
  be `null` for mixed/assembled artifacts; do **not** blanket-label a mixed
  binary/source as MIT.
- **Complete client**: the candidate must include `agentfs-pod` plus
  `sources/application-source.{json,tar.gz}` and
  `sources/native-source{,-build}.json`/`native-source.tar.gz`.
- **Native test proof**: target must equal the platform; the receipt must be the
  candidate's actual receipt bytes; `testsPassed=true`, `testsFailed=0`;
  compiler identity must match the receipt on disk. A receipt that did not run
  tests is rejected.
- **Installed acceptance**: bound to the actual CLI/launcher/helper hashes and
  platform, `executedOnTarget=true`, at least one real mount scenario passed and
  none failed, real mounting/lifecycle proven, owned resources cleaned. The
  macOS 1 informational skip is the disabled-mode assertion, not a missing
  kernel mount; the two real NFS scenarios must pass.
- **Gateway acceptance**: `proofKind="live-gateway"` only. Fixture/recording
  proof, a missing report hash, wrong target/source provenance, or an
  unsanitized record cannot produce a public candidate. Root collects this via
  the configured RC route; do not search personal credentials or fabricate
  success.

## Tests

`bun test ./tests` (package) covers a valid complete normalized proof at the
pure validator layer plus dirty/wrong source, wrong target/engine, payload
drift, incomplete/duplicate/unexpected reviews, untested/wrong native receipt,
stale mounted artifact hashes, and fixture-only/missing live Gateway proof. It
also asserts `verify-install.ts --public` still blocks an ordinary candidate.
