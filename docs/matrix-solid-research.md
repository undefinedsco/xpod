# Matrix over Solid Pod Research

Research date: 2026-05-22

Target boundary corrected: 2026-09-26. The target is Matrix distributed room and
event semantics with participant data persisted in their respective Pods. See
[Matrix collaboration design](matrix-collaboration-design.md) and the
[decision register](matrix-collaboration-decisions.md). The research findings
below are historical observations, not a fresh ecosystem survey or evidence that
the distributed target has been implemented.

## Findings

- I did not find a maintained implementation that uses a Solid Pod directly as a Matrix homeserver storage backend.
- The closest Solid-side prior art is Solid Chat / SolidOS chat data, which stores conversations and messages as RDF resources in Pods.
- Matrix is specified around homeserver HTTP APIs, especially Client-Server endpoints under `/_matrix/client/*`, and federation is a separate protocol surface.
- The initial implementation was a Pod-backed Client-Server adapter. That staged implementation does not exclude federation from the product target.

## Target and Current Implementation

The target preserves Matrix protocol room/event identity, event authentication,
room-version state resolution and Server-Server synchronization. Xpod provides
protocol processing and persists participant data in their respective Pods.
Homeserver federation, per-participant Pod persistence, and Client-Server sync
are separate responsibilities with separate durable progress and recovery rules.
The current implementation is a limited compatibility adapter.
First-party Xpod clients should use Xpod-owned API surfaces (`/api/...` or
`/v1/...` depending on the product API). Matrix clients and SDKs need the
standard Matrix Client-Server paths, so the adapter exposes those paths exactly
instead of wrapping them in `/api` or `/matrix`.

The current adapter exposes a limited Client-Server subset:

- `GET /.well-known/matrix/client`
- `GET /_matrix/client/versions`
- login discovery with `flows: []`; Matrix-native POST login is unsupported
- `GET /_matrix/client/v3/account/whoami`
- `POST /_matrix/client/v3/createRoom`
- `GET /_matrix/client/v3/joined_rooms`
- `POST /_matrix/client/v3/join/:roomIdOrAlias`
- `POST /_matrix/client/v3/rooms/:roomId/join`
- `POST /_matrix/client/v3/rooms/:roomId/invite`
- `POST /_matrix/client/v3/rooms/:roomId/leave`
- `PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId`
- `PUT /_matrix/client/v3/rooms/:roomId/state/:eventType`
- `PUT /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey`
- `GET /_matrix/client/v3/sync`
- `GET /_matrix/client/v3/rooms/:roomId/messages`
- basic room members/state/event lookup endpoints

Federation, E2EE key APIs, typing, receipts, push rules, presence, account data,
device lists, and media APIs are outside the current supported subset. There is
no commitment that every standard Matrix client works with Solid authentication.

### Route namespace decision

- `/.well-known/matrix/client` is a public discovery document. It only tells
  Matrix clients where the homeserver API base URL is.
- `/_matrix/client/...` is the Matrix protocol namespace. It must stay at this
  shape for Matrix client compatibility.
- Do not expose a prefixed Matrix route such as `/matrix/_matrix/...`; it is not
  a Matrix-standard client URL and makes compatibility worse.
- Do not make `/_matrix/...` a Pod storage path. The API server / gateway must
  intercept this namespace before requests reach the Solid resource store.
- Native Xpod clients should not infer product behavior from Matrix-shaped
  paths. They should use the first-party chat/message API projection and the
  owner-only `reconcilerOwner: client | server` metadata supplied by the backend.

## Modeling Decision

Shared schemas belong to `@undefineds.co/models`; Pod RDF persistence uses
drizzle-solid. Messages, synchronization logs, transaction deduplication records
and necessary execution receipts must be durable in Pods. SQL journal state is
legacy migration input, not the target authority.

- Preserve complete protocol events and the information needed for signature,
  hash, event-authorization and room-state validation. Chat/thread/message
  projections must not replace or rewrite signed protocol event content.
- One protocol event keeps the same event_id across Pods, according to its room
  version. A Pod resource URI describes a persistent storage location, not a
  browser cache; it must not redefine the event identity. This distinction does
  not require an additional mirror layer beyond participant Pod persistence or a separate mapping table.
- Identity binding between Matrix users/servers and Solid WebIDs, and the
  service's authority to write each participant Pod, are explicit contracts.
  Current WebID-derived adapter identities are implementation history, not
  evidence of federation interoperability.
- Models own schemas and resource layouts; API handlers must not parse Turtle
  manually or invent parallel schemas. The exact shared schema for full events
  remains an implementation task, not a reason to discard protocol fields.

## Reconciler Boundary

In the current single-Pod adapter, message facts, Delivery and Run records live
in the Pod while the legacy SQL journal holds operational transaction receipts
and event sequence references. The target moves required durable journal and
receipt facts into Pods; local acceleration state must be rebuildable.

Distributed receipt of an event does not itself grant execution authority.
Agent triggers need a stable logical identity independent of a replica's Pod URI,
plus explicit execution ownership and takeover rules. A shared Redis queue alone
does not coordinate independent deployments.

`ReconcilerService`, `WakeAgentQueue`, and `AgentWakeRuntimeService` are separate
services. The current Pod-backed `AgentWakeRuntimeBackend` implementation lives in
`PodMatrixStore`: it validates room grants and receipts, loads input, persists
execution records, and commits assistant output. Moving that implementation to a
separate backend is a maintenance option, not a second execution model.

The shared responsibilities are described in
[`reconciler-wake-runtime.md`](reconciler-wake-runtime.md). The distinction between current grant/lease/handoff behavior and required
distributed recovery and migration rules is tracked in
[`matrix-collaboration-design.md`](matrix-collaboration-design.md).

## Current Server Boundary

The current server is a Client-Server compatibility adapter for same-Pod chat surfaces:

- clients authenticate with existing Xpod/Solid API auth, then call Matrix-shaped endpoints;
- `sync` supports bounded long polling and returns a journal sequence `next_batch` token;
- room membership state is recorded as `m.room.member` events so clients can distinguish join/invite/leave transitions;
- execution requires explicit room grants in addition to Solid ACL and membership;
- claim/renew/complete/fail allow external runtimes to execute and explicitly hand off work;
- federation / Server-Server APIs are not implemented in this baseline; they remain required target capabilities.

See the [executable collaboration example](examples/matrix-collaboration.md) for
the HTTP/Pod acceptance path. Its deterministic runtimes do not validate real LLM
or tool execution.


## Distributed Acceptance Gap

The [executable example](examples/matrix-collaboration.md) and historical
[acceptance results](matrix-collaboration-acceptance.md) exercise one deployment,
one WebID and one Pod with deterministic runtimes. They do not establish
federation or multi-Pod correctness.

Target acceptance requires two independent deployments, identities and Pods;
stable room/event identity across replicas; disconnected retransmission,
deduplication, out-of-order delivery and missing-event recovery; event
authentication and room-version state resolution; and proof that replication does
not independently trigger the same Agent work. These gates remain unexecuted.
