# Product acquisition metadata freshness

The Bun compatibility lanes require a successful same-run normal JS producer,
its exact run attempt and head SHA, the artifact digest and its creation within
the producer's execution window. Availability of an artifact or a successful
workflow dependency alone never substitutes for these checks.

In run `39794337491` on source `50f821d1`, Windows Node24/25 and Linux Node22
Bun lanes received a `queued` producer status from the attempt jobs endpoint and
correctly refused it. Subsequent producer metadata records successful completion
at `2026-10-22T14:18:28Z`; the artifact was created at `14:18:15Z`, while the Linux
consumer refusal occurred at `14:24:15Z`. These observations demonstrate stale
producer state at consumption time. The exact cache or backend propagation layer
responsible has not been independently identified.

The shared acquisition transport requests metadata with `Cache-Control: no-cache`
and `Pragma: no-cache`, requiring revalidation instead of accepting cached open
state. It preserves the canonical endpoints, original response bytes and hashes,
existing per-request timeouts, metadata byte bounds, and all terminal-success,
identity, digest, and timestamp checks. An actually open producer remains a
failure. This introduces no configurable grace period or alternate acceptance
path. Artifact body and signed redirect handling retain their existing policy.

The acquisition tests simulate a stale run or job response when revalidation is
absent and supply terminal originals only to the revalidated request. Existing
queued, running, failed, wrong-attempt, wrong-source, expired, and wrong-digest
cases continue to refuse. The complete 18-lane Node/Bun Linux/macOS/Windows matrix
must still pass for the exact reviewed commit before release.

The same source's CSS preview run `39794338020` failed in `validate_run` before
its build. A later fresh response matches every recorded immutable context field.
The failing raw response was not in the diagnostics artifact, so its exact
mismatched field is unproven. CSS metadata downloads now request the same
revalidation headers through their existing bounded Python downloader; original
native job success, artifact digest and current-run identity checks are unchanged.
The CSS regression exercises the actual acquisition entry point with a stale
response unless revalidation is requested, and still refuses fresh queued state.

The CSS phase verifier declares the changed producer as an additional exact
parent/producer version. Opt-in supervisor validation retains the prior producer
and its reviewed materials tuples as well as the new producer; it does not accept
arbitrary reviewed CSS versions or mixed/unreviewed originals. Historical
complete source groups remain independently selectable.
