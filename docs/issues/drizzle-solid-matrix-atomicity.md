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

The following describes the historical Matrix implementation, not the accepted
Solid multiparty target. Its transaction reservations are scheduled for removal
under G11; they cannot be the replacement uniqueness authority.

RDF messages continue to use drizzle-solid; no raw SPARQL or Turtle parsing is
introduced. An operational SQL journal in the existing identity database reserves
protocol transaction ids and assigns stream positions after Pod writes. It stores
only references, timestamps and fingerprints, never a second message body. This
is not a Pod transaction and must not be described as atomic multi-resource commit.
Runtime recovery replays durable message facts; output ids remain idempotent.

## Solid multiparty reproduction, 2026-10-02

Two independent `PodMatrixStore` instances and journals write through authenticated
drizzle-solid HTTP access to the same isolated Xpod Pod. Each of three rounds uses
16 requests with different transaction ids and the same logical `(roomId,eventId)`.
Same-content races preserve one message subject but two protocol JSON values.
Three additional rounds race different bodies on an initially absent key: both
bodies are accepted, and the persisted message has two `sioc:content` values and
two conflicting protocol JSON values. The source hash was stable during the run.

The independent probe exited 1. Raw Turtle snapshots and the structured result
are preserved under `.test-data/solid-multiparty-acceptance/provider-b/root-review/`
in `multi-store-rdf-860ff450-4479-499b-a17f-d0634ad09ba2/`. This uses a disposable
authenticated HTTP Pod; it is not evidence from the user's actual Gateway.

The logical key spans transaction ids and storage dates. A per-store or
module-global mutex cannot establish cross-process uniqueness. A single RDF
subject is insufficient when its scalar properties have competing values.
The required operation must atomically insert or return the first authoritative
event; on a semantic mismatch it must preserve the first event and return a
conflict. It must retain that guarantee after restart and cache reconstruction,
without introducing an exclusive-writer deployment restriction or a replacement
event reservation. Shared daily message documents remain the models-owned layout.

The installed LDP executor also performs HEAD followed by unconditional PATCH/PUT;
the presence of conditional retry logic in a separate executor does not establish
atomicity for this actual path. Server storage primitives and the ORM contract
must be verified together before adopting an ETag or transaction-based repair.

## Proposed Xpod server-boundary repair, 2026-10-02

The gap does not require waiting for an entirely new ORM. The installed public
`insert(...).values(...).toSPARQL()` serializer and
`getDialect().executeOnResource(..., { mode: 'sparql', endpoint })` can supply a
temporary bridge: transform the ORM-generated SPARQL AST into one conditional
INSERT, send it with the existing authenticated ORM transport, then hydrate the
committed winner through the ORM. This is an implementation proposal, not a
verified atomic guarantee. Do not use the older `executeSPARQL` PATCH retry path,
hand-write RDF serialization, or silently discard conflicts.

The server must put condition evaluation, delta preparation, authority-file
commit and query-index visibility in one critical section. Subgraph updates
currently bypass ordinary ResourceStore locks, and exact document locks do not
conflict with a parent room lock. A shared generic hierarchical locker can make
ordinary LDP writes and scoped SPARQL updates coordinate for multiple independent
API processes reaching one authoritative CSS. This does not require an exclusive
API writer. The cross-date guard derives canonical identity from models-generated
IRIs and schema metadata; it must not copy date templates or invent RDF predicates.

Timeouts must not release a still-running writer. Crash recovery must retain a
complete authority file and rebuild its query projection before another condition
is evaluated. Multiple CSS backends sharing authority need separate evidence:
the current Redis locker has owner/expiry/lifecycle deficiencies and cannot be
assumed to provide fencing. Independent private file mirrors are not silently
treated as one consistent authority.

Acceptance remains actual concurrent HTTP/ORM/RDF writes, including independent
processes, initially absent competing keys, midnight races, ordinary LDP overlap,
interruption, lost responses and index reconstruction. No event reservation is
introduced, and no passing storage result has yet been established for this repair.

A root probe has now verified the installed serializer, AST transformation,
embedded UPDATE compilation and public endpoint transport with a dummy local
fetch. Finite inventories containing the Chat anchor compile, including when
the candidate's day document does not yet exist. An empty `VALUES` list is
rejected by the embedded compiler; retain this failure behavior and recover or
reject an unavailable index instead of dropping the identity condition. This
probe does not prove authenticated HTTP, concurrent storage or crash safety.

The independent-process reproduction also fails: two separate Bun processes,
each with its own store, journal and DPoP session, perform three same-content
and three initially absent competing-content rounds against one HTTP Pod.
Every same-content round accepts all 16 calls but persists two protocol JSON
values; every competing-content round accepts both bodies with 9 successes and
7 conflicts, persisting two content values and two protocol JSON values.
The command exits 1 with unchanged measured source hashes. Its raw Turtle and
results are preserved in `root-review/process-rdf-3aafc3e5-3986-436f-97a1-b47cf07bea7c/`
under the same ignored acceptance evidence directory.

## Partial repair and strict-read gap, 2026-10-02

The historical negative reproductions above remain valid observations of their
recorded source checkpoints. A later independent root run passes the six bounded
same-day rounds with two separate Bun processes, stores, journals and authenticated
HTTP sessions: each same-content round accepts all 16 requests and returns one
committed value; each competing-content round accepts eight requests and rejects
eight, retaining one content and protocol value. Its evidence is
`root-review/process-rdf-eeed65dc-5bf0-4cf8-91c1-16e4fe501e0c/result.json` in the
ignored acceptance directory. This establishes partial concurrency progress;
it does not establish the complete cross-date, authorization, crash-recovery,
Cloud Redis or actual-Gateway acceptance criteria.

Two additional installed-ORM contracts affect this bridge:

- The public sidecar POST does not perform the HTTP-cache invalidation performed
  by ordinary LDP insertion. The public API is
  `await db.getDialect().getSPARQLExecutor().invalidateHttpCache()` on the same
  database before winner confirmation. The optional URL form also attempts global
  invalidation; supplying a day-document URL alone does not establish selective
  invalidation. Unsupported engines may do nothing and invalidation failures can
  be swallowed, so a resolved call is not sufficient evidence of fresh hydration.
- Public `findById`/`findByIri` first reads the exact authority document. Inline
  metadata references can then require query hydration. There is no exported
  schema-aware Turtle/Quads decoder, and installed scalar mapping can select the
  first value instead of rejecting competing RDF values. A decoded row therefore
  cannot prove protected scalar cardinality or complete authority provenance.

The original across-date/restart integration failed at its new-journal replay,
which reused the same context and ORM instance. A repaired bundle using public
cache invalidation and immediate cross-day winner recovery passes that test.
This does not isolate cache invalidation as the sole cause: compare raw authority,
reused-database hydration and a fresh database when diagnosing future failures.
Do not repeatedly poll a losing candidate day that correctly remains absent.

Before any temporary raw authority-read guard, this issue records the concrete
need for strict validation that the public decoder cannot currently express.
The guard is a read-only postcondition of the public authenticated conditional
write, not a replacement CRUD layer. Its predicates, types, scalar/array rules
and canonical identities must derive from shared models. It must validate the
exact Message and parent, verified author identity, metadata relationship,
protocol predicate, required event fields and every protected scalar's uniqueness
before accepting either direct or ORM-hydrated confirmation. Count all RDF terms
before filtering term types; otherwise an invalid competing term disappears.
Never confirm arbitrary literals, substitute missing fields, silently downgrade
a failed conditional write, or use private dependency imports.

Root probes using the public ORM serializer and the actual adapter confirmation
method accept the proper typed-shape control but currently also accept six invalid
variants: competing content values, a mismatching maker, a wrong parent, a competing
literal metadata edge, a competing named-node protocol value, and a missing event
type. Evidence is
`root-review/committed-winner-shape-ef28e8ad-6ba3-418d-a5ea-4978ff773cb3-result.json`.
This is dummy-transport evidence of an adapter gap, not an authenticated exploit
or proof that every public ORM query has the same behavior. Strict confirmation
must pass those controls and actual authenticated storage tests before acceptance.

The server's finite-graph rewrite also needs a serialization round trip. A real
Parser/helper/Generator/Parser probe currently loses bare-existence VALUES; a
nested rewrite changes the truth of an actual Comunica ASK over the same local
RDF dataset. Evidence is
`root-review/r15-serialized-scope-284d5918-ebae-4302-820b-6f48cfe7d314-result.json`.
Normalize an existence operand into its own group and keep nested variables in
that scope. Unsupported new variable-graph shapes may be rejected explicitly;
they must not silently execute a different condition. Stable inventory and local
ACL/ACR authorization checks under the shared commit boundary remain unverified.

All temporary bridges remain subject to the full migration acceptance criteria.
No dependency source, node_modules patch, duplicate modeling definition or new
reservation authority is introduced by this report.

## Confirmation-route follow-up, 2026-10-02

The next root serialization probe passes both previously failing R15 controls:
the generated query retains finite VALUES, and the nested ASK preserves its
original truth. Evidence is
`root-review/r15-serialized-scope-54c995ac-b3f5-4dbc-a93e-0c4a7a3ca1b6-result.json`.
This proves the bounded rewrite repair, not stable inventory or atomic local
authorization. Exact missing-versus-empty state-key comparison also passes in
both directions; that comparator check is independent of persistence acceptance.

The direct-document confirmation now rejects the six earlier malformed shapes,
but accepting an ORM row before invoking this guard still bypasses its protection.
A fresh root probe exercises both actual confirmation helpers: its normal typed
record passes both paths; the ORM-first path accepts all twelve malformed variants.
The direct path also accepts a numeric optional `state_key` and competing modeled
`createdAt` values. Evidence is
`root-review/committed-winner-routes-a3426872-b338-4476-b645-f9f054843b9b-result.json`,
against stable adapter source `4fce5ea7aa9057c05d00f4f64a6f08b859b7243bb5b30ab98895804b0d6898b9`.

This probe uses public serializer output, dummy HTTP responses and an explicitly
projected decoded row retaining first scalar values and the actual variant protocol
JSON. It does not execute the public ORM hydrator or prove an authenticated exploit.
Its scope is the adapter's early-return bypass and strict postcondition behavior.
Every confirmation route, including a recovered winner in another day's document,
must verify the same protected authority before returning success. Fixing only a
fallback reader leaves the normal ORM path unprotected; rejecting all positive
records would also fail the required first-winner and replay behavior.

## Current bounded concurrency evidence, 2026-10-02

The next root run passes all 26 direct-document and ORM-confirmation controls,
including both normal records and twelve malformed shapes through both paths.
Evidence is
`root-review/committed-winner-routes-6075265b-4602-4f05-99eb-52931131c094-result.json`.
This resolves the recorded early-return controls at its measured source snapshot;
its dummy transport and projected-row scope remains as described above.

An additional independent root run now passes six authenticated HTTP/RDF rounds
with two separate Bun processes whose candidate timestamps straddle UTC midnight.
Each of three same-content rounds returns success for all sixteen transaction ids;
each of three initially absent competing-content rounds returns eight successes
and eight conflicts. Both candidate date documents are inspected after each round:
together they contain one exact typed Message subject, one content value and one
protocol value, and successful calls agree on the first full resource IRI and time.
Evidence is
`root-review/midnight-process-rdf-94d3a2c3-8b5c-4285-910f-09b90d9c5b15/result.json`.
All five measured source hashes remain unchanged during this run. It uses a
disposable HTTP fixture, not the actual user Gateway; lost responses, interruption,
index reconstruction, current authorization, Cloud Redis and the remaining full
migration criteria still require their own evidence. The earlier watchdog result
remains an inconclusive run, not a duplicate-write finding.

## Modeled-fact consistency still required, 2026-10-02

A bounded root lost-response run also passes: the authenticated conditional POST
returns a real 204, the client wrapper rejects that response once, and an independent
GET proves the first RDF record exists before retry. A separate Bun process with
its own session, store and empty journal retries from the next date; eight new
transactions retain the first full IRI, timestamp and content. A mismatching
transaction receives a conflict, and both date documents together retain one
record. Evidence is
`root-review/lost-response-rdf-f9967e4b-e86e-432d-bfe8-5895c7c8e5d3/result.json`.
This is client-side response-loss injection after a real commit on a disposable
HTTP fixture, not a real network outage, arbitrary process crash or actual-Gateway
acceptance. All five measured source files are stable during the run.

The shared strict-read guard still needs its declared complete modeled-fact
contract. A root probe retains all 26 earlier passing route controls and a legal
two-mentions array, but both routes accept seven additional malformed variants:
missing RDF creation time, a named-node creation time, an invalid datetime literal,
a time disagreeing with the protocol event, a single RDF content value disagreeing
with the protocol body, competing rich-content scalars and a second inverse Chat
relationship. Evidence is
`root-review/committed-winner-full-facts-974a3281-3b62-4719-9130-432e4ab3844a-result.json`.
The measured adapter hash remains
`8984c80e0f5cf9c92543cc328dff1185d12e51fec79986ee3e77d6bfd2441786`.

Use public column `dataType` and `isInverse()` declarations to distinguish arrays
and relation direction; a hand-maintained scalar-name whitelist is incomplete.
Validate required datetime terms and their actual value against the event time.
Use the existing Matrix-to-Message content conversion to check consistency, including
state events. These are properties of the same stored record; they do not introduce
a signature requirement for unsigned local first-writer records. The probe retains
its dummy transport and projected-row scope, and full authenticated acceptance
remains required after the repair.

## Fixture authorization qualification, 2026-10-02

The concurrency, midnight and response-loss runs above use participant credentials
and real HTTP/RDF persistence, but the shared `XpodTestStack` helper sets `open: true`
unless explicitly overridden. Runtime bootstrap selects `allow-all` for that mode.
Those bounded results therefore establish concurrency and replay behavior without
establishing server ACL/ACP enforcement. They are not permission-revocation, current
grant, O1/G02/G05 or actual-Gateway G12 evidence. Historical result files remain
immutable; the scope qualification is recorded separately in
`root-review/concurrency-fixture-auth-scope-qualification.json`.

A separate response-loss probe explicitly selects `open: false`, `authMode: 'acl'`
and `apiOpen: false`. It requires an anonymous GET of the committed authority
record to be denied while the participant's independent authenticated GET succeeds.
Its completion and replay outcome must be inspected before claiming ACL-enforced
acceptance; explicit runtime configuration alone is insufficient evidence.

## Modeled-fact guard repair, 2026-10-02

The seven remaining malformed modeled facts are now rejected on both confirmation
routes, while the valid typed record and a lawful two-mentions array remain accepted.
The guard derives predicates, scalar-versus-array cardinality and relation direction
from the installed public models column metadata (`dataType`, `isInverse()`), uses the
existing Matrix-to-Message content conversion for content consistency, and requires a
single parseable `createdAt` literal whose instant equals the protocol event time.
The decoded ORM row is no longer trusted as a winner by itself; every confirmation
route validates the RDF authority document. Evidence from the public serializer plus
dummy transport is
`root-review/committed-winner-full-facts-97870459-d0e9-463f-95e0-ea2975dd6fbc-result.json`
(42/42 independent root controls at stable source `6335654817a2f6e2e422fc1e067f8446af49a600eb6652bf9f58800768169c67`). This is
still dummy-transport evidence: it does not execute the public ORM hydrator, prove an
authenticated exploit, or replace real HTTP/authorization/Gateway acceptance.


## ACL-enforced response-loss and runtime restart evidence, 2026-10-02

The explicitly closed ACL fixture now passes the response-loss controls: a
participant's independent authority GET succeeds, an anonymous GET is denied,
the real conditional POST returns 204 before its response is discarded, and
before retry the first RDF record is already committed. A separate process with
a new session, store and empty journal preserves that record across the date
boundary; a conflicting retry is rejected. Evidence is
`root-review/lost-response-acl-rdf-2d7b3259-ec6d-44cd-a86f-ed210a537479/result.json`
(eight controls, actual exit 0, unchanged measured source hashes).

A second closed-ACL run stops the entire owned runtime after this commit and
verifies that its Gateway is no longer reachable. It restarts using the same
persistent runtime directory, canonical base URL and credentials, independently
reads the original RDF before retry, and then verifies eight cross-date retries
from a separate process plus a conflicting transaction. All ten controls pass;
evidence is
`root-review/restart-lost-response-acl-rdf-aed22c2b-d0c2-43df-99da-eb33ad42c479/result.json`.
The measured source files are unchanged during the run. This is a graceful owned
runtime restart and an injected client transport failure after a real commit;
it does not prove arbitrary forced-crash windows, wiped-index reconstruction,
permission-revocation races, Cloud Redis, ACP or the actual user Gateway.


## Forced owned-process crash after committed response loss, 2026-10-02

The closed-ACL fixture also passes a forced whole-runtime process failure after
the successful commit. The acceptance orchestrator hosts the disposable Xpod
runtime in a separate owned process, freezes only that process and its verified
descendants, and terminates them with SIGKILL. The recorded host exit signal is
SIGKILL, all captured owned processes are gone, and the Gateway is unreachable
before restart. No unrelated runtime or real user data is modified.

After restart with the same persistent runtime directory, canonical URL and
credentials, an independent authenticated read finds the first record before
retry, and an anonymous read is still denied. Eight retries from a separate
process, session, store and empty journal across the date boundary preserve the
first identity, timestamp and body; a conflicting retry returns a conflict and
the two daily authority documents together contain only the original record.
All thirteen controls pass, with actual exit 0 and stable measured sources.
Evidence is
`root-review/crash-lost-response-acl-rdf-92f9b4ab-84f2-49e5-b08f-117e76ac6a8f/result.json`
(adapter source `eec2c08ad327ae34decefc545a848e3c82ddd64849c10282477d8cc180e9094d`).

This proves restart and replay after a completed conditional write. It does not
prove crash safety during a partially written authority document, wiped-index
reconstruction, grant revocation races, ACP, Cloud Redis or actual-Gateway G12.
