# SDK observer budget diagnostics

The observer retains its existing byte, record, shard, process and deadline limits. A diagnostic never grants source admission or replaces the original failure.

On a byte-budget rejection, `SDK_EXECUTION_BYTE_BOUND` reports successful claim bytes in four disjoint categories: raw wire records, capture bodies, standard output/error, and provider/other originals. Their sum equals the charged domain ledger. A successful claim can precede a failed physical write, so these counters describe admitted charges, not confirmed disk writes. Referenced observation bytes remain separate and must not be added to physical storage totals.

The failure-only content census inspects the newest 8192 existing observations and at most 4096 physical references, filtered by phase. It reports matching observations, truncation and a lower bound on identical complete-body storage. It does not establish reuse eligibility or savings for the complete run. The surrounding pre-existing observation summary can still traverse the full retained list; the 8192 limit applies only to this census.

`SDK_GENERATED_RESERVATION_BOUND` reports the rejected reservation, current ledger, existing reserve and available write context. Write context is installed before the generated-write baseline reservation, using already-observed identity, size, offset and count. No new body or `/proc` reads are introduced. JSON is bounded to 4000 bytes; failure to serialize or print preserves the original rejection. Non-write operations can lack write context. Existing failure paths terminate the observer; recovery or reuse after a failed operation would require explicit context cleanup and new tests.

A small actual Linux FD experiment demonstrates quadratic retained full-snapshot cost for repeated generated appends. It does not establish that this pattern dominates a failed full SDK build. These diagnostics improve attribution; they do not fix or waive budget exhaustion.

The associated source-path constant extraction only removes repeated literals from the controller policy. Historical recipe JSON is preserved, and changed source bytes receive new SDK/controller recipes. Source limits are unchanged. Regression tests verify historical hashes, current physical files, exact recipe selection and refusal when mandatory originals are absent or mixed.

## Lease fast guard and bounded EAGAIN attribution

Private raw records and controller consumer ledgers are not external authority. The observer's generic `check()` now performs only the existing sticky readiness guard (`LeaseSet._ready`: closed, latched SIGIO failure, handler ownership); it does not issue per-FD `F_GETLEASE`/fstat. A complete `check_full()` remains at actual byte-read closing (including the non-outer snapshot path and held-FD digest), lease acquisition/advance/retire/complete, terminal authority close and final phase acceptance. Controlled resume/`PTRACE_SYSCALL` uses the existing cheap sticky guard immediately before each actual resume; the phase-final `complete()`/closing proof rejects the whole run if a lease was lost or metadata changed. The kernel read lease plus sticky SIGIO supplies interval exclusion; the final full sweep supplies the endpoint identity/lease proof. No full sweep is performed merely because a temporary unpublishable tracee is resumed. This is not a TTL, sampling, dirty-cache or deadline extension, and private emit rows are not claimed as accepted results.

A `BlockingIOError` from the mmap-before `lifetime_acquisition` is diagnosed only after the real failure: `SDK_LEASE_ACQUISITION_EAGAIN` reports bounded attempted descriptor flags/identity, the stopped mmap arguments, and matching owned descriptors. It reports no bytes, keys or tokens, does not retry, suppress, unlock or extend a deadline, and preserves the original exception. The exact hosted FD is unknown; this diagnostic does not claim to fix writable-mmap EAGAIN.

## 8 GiB source-material capacity basis

The failed c60 service-trixie SDK run observed 3,517,282,930 bytes already charged at compile target 527/734. The next write was a new 94,912,512-byte `src/index` PCH temporary file. Its generated-write reservation was 190,714,272 bytes, while only 49,133,960 bytes remained. The requested reserve projected 3,707,997,202 bytes against a 3,566,416,890-byte ceiling.

This is a **disk/captured-original logical byte capacity**, not the 4 GiB container memory limit and not a timeout. The 4 GiB `sourceMaterialBytes` value was shared by source/context and execution originals. The measured source/context portion in the failed run was 728,550,406 bytes.

A 5.626 GB linear projection from 527/734 is not an upper bound because the remaining 207 compile targets are non-uniform. The canonical shared source-material ceiling is now **8 GiB (8,589,934,592 bytes)**. This gives finite headroom while keeping every existing ledger, retention, ownership and security boundary. Full fit remains unproven until a real full SDK run passes.

All active SDK source-material boundaries read this one canonical value: `sdk-toolchain-materials.py` (the previously hardcoded ceiling), `sdk-inner-materials.py`, `sdk-image-originals.py`, `sdk-generation-materials.py`, `sdk-upstream-source-materials.py`, and `sdk-kernel-probe-controller.py`. No second configuration quantity or parallel ledger is introduced. Container-memory limits, API producer, AFS and separate native-product contracts remain unchanged.

The archive fields `expandedBytes` (5 GiB), `packedBytes` (805,306,368 bytes) and `freeFloorBytes` (2 GiB) do not bind the SDK source-capture ledger: the SDK source/archive path uses `sourceMaterialBytes` and its existing disk-floor checks. A full SDK run must still exercise the real archive and disk checks; no runner free-space claim is made here.
