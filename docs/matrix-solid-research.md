# Matrix over Solid Pod Research

Research date: 2026-05-22

Implementation boundary updated: 2026-09-23. The current contract and acceptance
gates are in [Matrix collaboration design](matrix-collaboration-design.md); the
research findings below are historical observations, not a fresh ecosystem survey.

## Findings

- I did not find a maintained implementation that uses a Solid Pod directly as a Matrix homeserver storage backend.
- The closest Solid-side prior art is Solid Chat / SolidOS chat data, which stores conversations and messages as RDF resources in Pods.
- Matrix is specified around homeserver HTTP APIs, especially Client-Server endpoints under `/_matrix/client/*`, and federation is a separate protocol surface.
- Therefore the pragmatic first implementation is a Pod-backed Matrix Client-Server adapter in the API service, not a full federating homeserver.

## Implementation Boundary

Matrix support is a compatibility adapter, not the primary Xpod chat protocol.
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

Durable Matrix data must be owned by `@undefineds.co/models` and stored through drizzle-solid:

- Matrix rooms map to Pod-backed chat/thread resources.
- Matrix events map to Pod-backed message resources with Matrix protocol metadata.
- Matrix account/device identity is derived from the authenticated Solid WebID and exposed at the protocol edge.
- API service code is only a protocol adapter: it validates Matrix requests, authenticates through existing API auth, and calls the model-backed store.

Do not store Matrix data as opaque JSON files, parse Turtle manually in API handlers, or introduce a `/.data/matrix` data directory for this adapter. The external route can be Matrix-shaped; durable storage remains human chat/message-shaped.

## Reconciler Boundary

Matrix remains a Client-Server API shape over the shared chat model. Message
facts, Delivery and Run records live in the Pod; the SQL journal holds operational
transaction receipts and event sequence references, not another message store.

`ReconcilerService`, `WakeAgentQueue`, and `AgentWakeRuntimeService` are separate
services. The current Pod-backed `AgentWakeRuntimeBackend` implementation lives in
`PodMatrixStore`: it validates room grants and receipts, loads input, persists
execution records, and commits assistant output. Moving that implementation to a
separate backend is a maintenance option, not a second execution model.

The shared responsibilities are described in
[`reconciler-wake-runtime.md`](reconciler-wake-runtime.md). The implemented grant,
lease, explicit handoff, failure-recovery, and migration rules are defined in
[`matrix-collaboration-design.md`](matrix-collaboration-design.md).

## Current Server Boundary

The current server is a Client-Server compatibility adapter for same-Pod chat surfaces:

- clients authenticate with existing Xpod/Solid API auth, then call Matrix-shaped endpoints;
- `sync` supports bounded long polling and returns a journal sequence `next_batch` token;
- room membership state is recorded as `m.room.member` events so clients can distinguish join/invite/leave transitions;
- execution requires explicit room grants in addition to Solid ACL and membership;
- claim/renew/complete/fail allow external runtimes to execute and explicitly hand off work;
- federation / Server-Server APIs remain out of scope.

See the [executable collaboration example](examples/matrix-collaboration.md) for
the HTTP/Pod acceptance path. Its deterministic runtimes do not validate real LLM
or tool execution.
