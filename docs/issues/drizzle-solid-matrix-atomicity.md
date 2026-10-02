# drizzle-solid 0.3.24: transactions do not provide atomic message append

Observed during Matrix collaboration implementation, 2026-09-22.

## Reproduction and cause

Run two `db.transaction(async tx => { read; insert; })` calls against one Pod.
The installed `dist/core/pod-session.js` transaction method simply invokes the
callback; it has no commit, rollback or isolation. `sparql-executor.js` retries
an ETag-conflicting PATCH with a refreshed ETag without re-running the read/decision,
and has an unconditional fallback. This cannot implement compare-and-set or a
unique protocol transaction reservation. A process mutex cannot repair this for
multiple API workers.

## Required upstream contract

Expose explicit conditional writes with conflicts returned to the caller, and a
document-scoped mutation primitive which re-runs the decision on conflict. Do not
advertise multi-document atomicity where the Solid server cannot supply it.
Tests must cover two clients racing, process interruption and rejected stale writes.

## Xpod containment

RDF messages continue to use drizzle-solid; no raw SPARQL or Turtle parsing is
introduced. An operational SQL journal in the existing identity database reserves
protocol transaction ids and assigns stream positions after Pod writes. It stores
only references, timestamps and fingerprints, never a second message body. This
is not a Pod transaction and must not be described as atomic multi-resource commit.
Runtime recovery replays durable message facts; output ids remain idempotent.
