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

These bytes exist so historical/synthetic contract tests can keep describing the
frozen CLI17 generation without reading the mutable checkout version. They do
NOT qualify any current source: an unreviewed CURRENT package version still
fails the production trust policy, which compares against its own catalogue.

Regeneration is intentionally NOT automated: replacing them would silently
rewrite frozen history.
