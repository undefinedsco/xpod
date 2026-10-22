# SDK observer budget diagnostics

The observer retains its existing byte, record, shard, process and deadline limits. A diagnostic never grants source admission or replaces the original failure.

On a byte-budget rejection, `SDK_EXECUTION_BYTE_BOUND` reports successful claim bytes in four disjoint categories: raw wire records, capture bodies, standard output/error, and provider/other originals. Their sum equals the charged domain ledger. A successful claim can precede a failed physical write, so these counters describe admitted charges, not confirmed disk writes. Referenced observation bytes remain separate and must not be added to physical storage totals.

The failure-only content census inspects the newest 8192 existing observations and at most 4096 physical references, filtered by phase. It reports matching observations, truncation and a lower bound on identical complete-body storage. It does not establish reuse eligibility or savings for the complete run. The surrounding pre-existing observation summary can still traverse the full retained list; the 8192 limit applies only to this census.

`SDK_GENERATED_RESERVATION_BOUND` reports the rejected reservation, current ledger, existing reserve and available write context. Write context is installed before the generated-write baseline reservation, using already-observed identity, size, offset and count. No new body or `/proc` reads are introduced. JSON is bounded to 4000 bytes; failure to serialize or print preserves the original rejection. Non-write operations can lack write context. Existing failure paths terminate the observer; recovery or reuse after a failed operation would require explicit context cleanup and new tests.

A small actual Linux FD experiment demonstrates quadratic retained full-snapshot cost for repeated generated appends. It does not establish that this pattern dominates a failed full SDK build. These diagnostics improve attribution; they do not fix or waive budget exhaustion.

The associated source-path constant extraction only removes repeated literals from the controller policy. Historical recipe JSON is preserved, and changed source bytes receive new SDK/controller recipes. Source limits are unchanged. Regression tests verify historical hashes, current physical files, exact recipe selection and refusal when mandatory originals are absent or mixed.
