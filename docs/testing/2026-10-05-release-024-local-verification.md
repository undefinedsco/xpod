# 0.4.24 recovery local verification — 2026-10-05

This record covers the frozen 0.4.24 recovery diff above source
`b87b0a2614e32aed28c7085fb2961fd8a3f08fdc`. It does not accept a new RC or
claim stable publication. Those require a new immutable source SHA, the exact
acceptance artifact, all mandatory checks, actual platform packaging and public
publication.

The signed `v0.4.23` tag remains unchanged. Its RC passed, but stable run
[37212086744](https://github.com/undefinedsco/xpod/actions/runs/37212086744)
failed at native npm publication with E413. Seven shared packages were published;
root/native npm latest, container promotion, production deployment and stable
desktop were skipped. The recovery advances root/desktop/native to 0.4.24,
shared-ui/extension-sdk/solid-sdk to 0.1.2 and the other four shared packages to
0.1.1, preserving exact accepted gitHead and registry integrity requirements.

The private single-file runtime archive now uses lossless built-in Brotli q9.
The fixed corresponding source archive, its checksum and 174 embedded docs,
QLever/ICU dependencies, licenses and source offer are retained. Platform
construction records measured pack metadata before rejecting budgets; 180 MiB
packed and 240 MiB base64 publication body with 64 KiB metadata reserve are
project budgets, not an asserted npm server limit. Preliminary real tarball and
loopback npm request measurements passed those budgets, and cold/warm Bun 1.4.2
and Node 22 native conformance passed. Final-SHA packaging, request-body and
SOURCE/native consumer measurements must be repeated before stable publication;
preliminary uncommitted measurements are not final acceptance evidence.

Normal Matrix initial PUT and sync failures exposed ancestor read leases expiring
at their original 6000ms limit while preparing representations or waiting on
inner locks. The hierarchy adapter now renews only during that preparation;
CSS stream consumption renewal and original idle-response expiry remain intact.
A real CSS expiring-lock regression was RED, then the hierarchy/legacy suites
passed 21 tests including failure, late acquisition and stream cleanup paths.
Another historical backlog run recorded four native QLever requests reaching
60000ms. That distinct observation is retained; the lease fix alone does not
establish the cause of those native stalls. See the
[lease issue](../issues/2026-10-05-hierarchy-read-preparation-lease.md).

Two unmodified complete `bun run test:integration` gates on the frozen recovery
source actually exited 0, recorded by the unified runner:

| Gate | UTC start → end | Actual result |
| --- | --- | --- |
| `sol-recovery024-readlease-afterfix-full` | 2026-10-04 17:18:45.984 → 17:26:10.179 | runtime 30 passed; lite 163 passed, 16 skipped; full 63 passed |
| `sol-recovery024-readlease-precommit-full2` | 2026-10-04 17:33:35.055 → 17:47:20.677 | runtime 30 passed; lite 163 passed, 16 skipped; full 63 passed |

Normal Matrix collaboration passed in 54328ms and 129126ms, respectively,
including initial PUT, idempotency, scripted agents, parallel backlog, exact
63-event bodies, pagination and claim/handoff. Build:ts, typecheck:test,
dependency-state and publication budget regressions each actually exited 0.
Compiled bootstrap tests cover cold/warm byte and mode equality, argv handling,
archive checksum mismatch and corrupt Brotli. They do not add per-file warm-cache
integrity guarantees. The repository has no separate lint script; whitespace
validation is performed before commit.

The intervening `sol-recovery024-readlease-precommit-full` actually exited 1
before Matrix: Gateway asset transport round 91 exceeded its original 4s budget.
Three unchanged bounded repeats and three private phase-observation repeats then
all exited 0. Each observed repeat received 3600 complete exact bodies; 2400
upstream proxy responses ended and closed, with zero unfinished responses.
Maximum body duration was 25.5–248.1ms and event-loop delay 6.1–182.5ms. These
repeats found no reproducible new causal defect; they do not replace the two
complete gates. No timeout, iteration count, assertion, product fallback or
automatic test retry was added. Earlier normal Matrix and complete failures
remain preserved in private evidence rather than being relabeled successful.

Root has neither the hierarchy component nor its tests; this recovery does not
migrate packaging or unsupported APIs into that older checkout. The preceding
0.3.25 drizzle-solid patch remains a fixed-version consumption bridge; its
shared-repository source change is not yet committed or published upstream.
Historical broader unit-suite debt (14 failures in eight files) is not claimed
resolved. Additional actual Linux bubblewrap evidence remains not-tested; mock
sandbox assertions are not OS isolation acceptance. The original installed
0.4.20 desktop and existing user Gateway are not upgraded-instance evidence.
All final RC, public package, container and desktop claims remain separate gates.
