# cli17-accepted-419 fixture provenance

**The directory name encodes the COMMIT PREFIX, not an RC number.** These bytes
come from commit `4194795915ac5f956cd593131647ece7049be24d`, which was the
**RC425** candidate (workflow run `43656228778`, version `0.4.31-rc.425`).
It is **not** RC419.

Status of these bytes: **accepted source bytes**, not a published release asset.
Stable `v0.4.31` had not been published when the capture was taken.

Captured at development time from the public repository:

```
git show 4194795915ac5f956cd593131647ece7049be24d:package.json
git show 4194795915ac5f956cd593131647ece7049be24d:bun.lock
git show 4194795915ac5f956cd593131647ece7049be24d:desktop/package.json
git show 4194795915ac5f956cd593131647ece7049be24d:tests/scripts/candidate-producer-attempt-binding.test.ts
git show 4194795915ac5f956cd593131647ece7049be24d:tests/scripts/candidate-producer-attempt.tiny.test.ts
git show 4194795915ac5f956cd593131647ece7049be24d:tests/scripts/controller-helper-admission.test.ts
```

All THREE captured paths, with the hashes that the CLI17 catalogue pins
(`scripts/lib/independent-admission/source-rules.ts`). That catalogue is the
single operative authority; the values are restated here for audit only:

| file | sha256 |
| --- | --- |
| `package.json` | `5b22bfea56abce62244dcb9930446a68d91cfd684b31c99c770081eaa24536c1` |
| `bun.lock` | `b7fa5ccb7ea73679a345aeafafa0dfe2a03c119d721d31abab3c02e82a483808` |
| `desktop/package.json` | `a09bb65633addabdcd0ed8bd43e2dcbe8817949a21d6363f394007bf05e0057b` |

Public repository data; no secrets.

Three test-source originals are also captured as `.original.txt` data. Existing
catalogue rows own these tests' historical bytes: editing the live tests must not
rewrite those rows. The data is never executed or discovered as an extra test.
These hashes document existing catalogue values; they add no admission rule.

| original repository path | sha256 |
| --- | --- |
| `tests/scripts/candidate-producer-attempt-binding.test.ts` | `38395665f84e0ea065457e2bb032ee2b4536518073375bf04066453bfb2dbc28` |
| `tests/scripts/candidate-producer-attempt.tiny.test.ts` | `e68b1c080b7cc5c8ce209eed3067898960f145708693efd0b18e80271d08d662` |
| `tests/scripts/controller-helper-admission.test.ts` | `b11b2861601c850488a7e0629e59c9738f39242f660c387d59637bcd60f6a889` |

These bytes exist so historical/synthetic contract tests can keep describing the
frozen CLI17 generation without reading the mutable checkout version. They do
NOT qualify any current source: an unreviewed CURRENT package version still
fails the production trust policy, which compares against its own catalogue.

Regeneration is intentionally NOT automated: replacing them would silently
rewrite frozen history.

The accepted generation remains fixed when later versions, including `0.4.32`,
change checkout metadata. The notice phase-plan test runs unchanged verifier
sources in a temporary historical input tree and removes it afterwards; it does
not qualify the current checkout or alter production verification.
