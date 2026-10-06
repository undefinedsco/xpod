# 0.4.25 recovery local verification — 2026-10-05

This recovery retains local commit `7efdb3794458e892ba33f672cdee0fa9814048f0`
and its [0.4.24 local results](2026-10-05-release-024-local-verification.md).
The ordinary 0.4.24 push was rejected because the remote branch already belongs
to a different source line at `c47283cbc3f4929af6afdb9f83396dd5553f8f1d`.
No force push, unreviewed merge or tag rewrite occurred. Read-only branch/tag
and registry preflight found 0.4.25 unoccupied. This line continues on
`release/0.4.25`, with root/desktop/native exactly 0.4.25 and the seven shared
recovery patch versions unchanged. The old 0.4.24 gates remain historical.

The final-version diff changes only root/desktop versions, their lock entries
and recovery documentation. The lossless Brotli/runtime budget and ancestor
read-preparation lease fixes are unchanged. All five frozen version-diff files
retained their SHA-256 through both new complete runs. Both unmodified complete
`bun run test:integration` processes actually exited 0:

| Gate | UTC start → end | Actual result |
| --- | --- | --- |
| `sol-recovery025-afterversion-full` | 2026-10-04 17:55:35.868 → 18:04:58.278 | runtime 30 passed; lite 163 passed, 16 skipped; full 63 passed |
| `sol-recovery025-precommit-full` | 2026-10-04 18:07:31.238 → 18:16:21.128 | runtime 30 passed; lite 163 passed, 16 skipped; full 63 passed |

Normal Matrix collaboration passed in 175734ms and 65150ms, including initial
PUT, exact event bodies, parallel backlog, pagination, idempotency and handoff.
No timeout, assertion or automatic retry was changed. Historical 6000ms lease
expirations, native 60000ms stalls and the 0.4.24 asset round-91 failure remain
separate recorded observations; successful final runs do not retroactively
relabel them or independently prove every earlier stall's cause.

Final-version build:ts, typecheck:test, dependency-state, real Bun 1.4.2 compiled
bootstrap and platform publication-budget regressions all actually exited 0
between 18:06:30.754 and 18:07:00.553 UTC. The earlier 21-test hierarchy/legacy
regression remains applicable to its unchanged source. The repository has no
separate lint script; whitespace and staged-source checks are performed before
commit. Temporary evidence and private logs remain under `.test-data/`.

Final immutable-SHA RC acceptance, actual native tarball/body/SOURCE measurements,
public npm staging/clean consumers/latest, same-digest container promotion and
stable desktop publication remain pending. The 180 MiB tarball/240 MiB request
budgets are project policy, not an npm server guarantee. Fixed corresponding
source and 174 docs, native dependencies and exact gitHead/integrity contracts
remain required; preliminary 0.4.24 measurements do not satisfy these final gates.
The signed failed `v0.4.23` tag and its already-published shared versions are
preserved.

Root has neither the hierarchy component nor these recovery packaging changes;
no unsupported API migration was made. The preceding shared ORM correction is
still a fixed 0.3.25 consumption patch, not a published upstream release.
Historical broader unit-suite debt, additional actual Linux bubblewrap evidence
and upgrade of the original installed 0.4.20 desktop remain explicit gaps.
Prior real Gateway and desktop RC evidence belongs to its original source SHA,
not this still-unaccepted final release source.
