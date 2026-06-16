# Matrix over Solid Pod Research

Date: 2026-05-22

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

Initial Matrix support should expose a minimal Client-Server subset:

- `GET /.well-known/matrix/client`
- `GET /_matrix/client/versions`
- login discovery / password-or-token login compatibility endpoints
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

Federation, E2EE key APIs, typing, receipts, push rules, presence, account data, device lists, and media APIs are follow-up protocol surfaces.

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

Matrix remains only a Client-Server API shape over the shared chat model. When
Matrix appends a human message, the durable write should go through the same
message append path used by other chat surfaces. Any future Agent wake-up logic
belongs behind `ReconcilerService`, not inside `PodMatrixStore` or Matrix route
handlers.

The agreed boundary is documented in [`reconciler-wake-runtime.md`](reconciler-wake-runtime.md): Matrix/ChatKit adapters write `Message` facts,
`ReconcilerService` decides which Agent URI(s) to wake, `Wake` only enqueues a
minimal `(thread, triggerMessage, agent)` job, and Agent Runtime decides
where LLM calls and tool calls execute.

## Current Server Boundary

The current server is a Client-Server compatibility adapter for same-Pod chat surfaces:

- clients authenticate with existing Xpod/Solid API auth, then call Matrix-shaped endpoints;
- `sync` is polling-friendly and returns a Matrix `next_batch` token;
- room membership state is recorded as `m.room.member` events so clients can distinguish join/invite/leave transitions;
- federation / Server-Server APIs are intentionally out of scope for this MVP.
