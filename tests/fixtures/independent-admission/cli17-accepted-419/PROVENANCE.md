# cli17-accepted-419 fixture provenance

**The directory name encodes the COMMIT PREFIX, not an RC number.** These bytes
come from commit `4194795915ac5f956cd593131647ece7049be24d`, which was the
**RC425** candidate (workflow run `43656228778`, version `0.4.31-rc.425`).
It is **not** RC419.

Status of these bytes: **accepted source bytes**, not a published release asset.
Stable `v0.4.31` had not been published when the capture was taken.

## EIGHT captures, one reason

Every capture below exists because a FROZEN catalogue row owns that path's bytes,
while the live checkout has legitimately moved on. Nothing else is captured.

Captured at development time from the public repository:

```
git show 4194795915ac5f956cd593131647ece7049be24d:package.json
git show 4194795915ac5f956cd593131647ece7049be24d:bun.lock
git show 4194795915ac5f956cd593131647ece7049be24d:desktop/package.json
git show 4194795915ac5f956cd593131647ece7049be24d:packages/xpod-api/package.json
git show 4194795915ac5f956cd593131647ece7049be24d:tests/scripts/candidate-producer-attempt-binding.test.ts
git show 4194795915ac5f956cd593131647ece7049be24d:tests/scripts/candidate-producer-attempt.tiny.test.ts
git show 4194795915ac5f956cd593131647ece7049be24d:tests/scripts/controller-helper-admission.test.ts
git show 4194795915ac5f956cd593131647ece7049be24d:scripts/workspace-package-payload.cjs
```

### 1-3. Version-bearing manifests

Three manifests move on every version bump. The CLI17 catalogue
(`scripts/lib/independent-admission/source-rules.ts`) is the single operative
authority; the values are restated here for audit only.

| file | sha256 |
| --- | --- |
| `package.json` | `5b22bfea56abce62244dcb9930446a68d91cfd684b31c99c770081eaa24536c1` |
| `bun.lock` | `b7fa5ccb7ea73679a345aeafafa0dfe2a03c119d721d31abab3c02e82a483808` |
| `desktop/package.json` | `a09bb65633addabdcd0ed8bd43e2dcbe8817949a21d6363f394007bf05e0057b` |

### 4-6. Historical TEST-file originals

Frozen rows own these tests' own bytes, so editing the live tests must not
rewrite those rows. Captured as `.original.txt`; never executed, and never
discovered as an extra test.

| original repository path | sha256 |
| --- | --- |
| `tests/scripts/candidate-producer-attempt-binding.test.ts` | `38395665f84e0ea065457e2bb032ee2b4536518073375bf04066453bfb2dbc28` |
| `tests/scripts/candidate-producer-attempt.tiny.test.ts` | `e68b1c080b7cc5c8ce209eed3067898960f145708693efd0b18e80271d08d662` |
| `tests/scripts/controller-helper-admission.test.ts` | `b11b2861601c850488a7e0629e59c9738f39242f660c387d59637bcd60f6a889` |

### 7. Historical PRODUCTION-helper original

`scripts/workspace-package-payload.cjs` is itself a frozen catalogue row
(`058c6f633ed805cf0af2f5f3ebac1cfd1706c8ed106da2f16766dde4a20c145a`), and the
live helper legitimately changed for the RC426 material-provenance fix. Captured
as inert `.original.txt` **data** — it is never imported, required or executed.
It exists so the hermetic notice fixture's copied root carries the bytes the
frozen row actually pins, instead of the updated live helper.

| original repository path | sha256 |
| --- | --- |
| `scripts/workspace-package-payload.cjs` | `058c6f633ed805cf0af2f5f3ebac1cfd1706c8ed106da2f16766dde4a20c145a` |

Proof of capture fidelity (development time, public data):

```
$ git show 4194795915...:scripts/workspace-package-payload.cjs | sha256sum
058c6f633ed805cf0af2f5f3ebac1cfd1706c8ed106da2f16766dde4a20c145a
```

### 8. Historical API dependency manifest

The accepted API catalogue owns the original `packages/xpod-api/package.json`
with SHA-256 `ce111f505757cbb813e70237d7fec59ae496eb1b7f6661d57be1203cd4709a60`.
Historical tests read the accepted bytes after the Pi dependency migration.
The current API manifest and lock are verified independently.

## Scope

Public repository data; no secrets.

These bytes let historical/synthetic contract tests keep describing the frozen
CLI17 generation without reading mutable checkout state. They do **NOT** qualify
any current source: an unreviewed CURRENT version still fails the production
trust policy, which compares against its own catalogue. The updated comparator
is covered separately by its own Node cases.

Regeneration is intentionally NOT automated: replacing them would silently
rewrite frozen history.

The accepted generation remains fixed when later versions, including `0.4.32`,
change checkout metadata. The notice phase-plan test runs unchanged verifier
sources in a temporary historical input tree and removes it afterwards; it does
not qualify the current checkout or alter production verification.
