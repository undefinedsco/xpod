# Matrix over Solid Pod Research

Date: 2026-05-22

## Findings

- I did not find a maintained implementation that uses a Solid Pod directly as a Matrix homeserver storage backend.
- The closest Solid-side prior art is Solid Chat / SolidOS chat data, which stores conversations and messages as RDF resources in Pods.
- Matrix is specified around homeserver HTTP APIs, especially Client-Server endpoints under `/_matrix/client/*`, and federation is a separate protocol surface.
- Therefore the pragmatic first implementation is a Pod-backed Matrix Client-Server adapter in the API service, not a full federating homeserver.

## Implementation Boundary

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

## Modeling Decision

Durable Matrix data must be owned by `@undefineds.co/models` and stored through drizzle-solid:

- Matrix rooms map to Pod-backed chat/thread resources.
- Matrix events map to Pod-backed message resources with Matrix protocol metadata.
- Matrix account/device identity is derived from the authenticated Solid WebID and exposed at the protocol edge.
- API service code is only a protocol adapter: it validates Matrix requests, authenticates through existing API auth, and calls the model-backed store.

Do not store Matrix data as opaque JSON files, parse Turtle manually in API handlers, or introduce a `/.data/matrix` data directory for this adapter. The external route can be Matrix-shaped; durable storage remains human chat/message-shaped.

## Current Server Boundary

The current server is a Client-Server compatibility adapter for same-Pod chat surfaces:

- clients authenticate with existing Xpod/Solid API auth, then call Matrix-shaped endpoints;
- `sync` is polling-friendly and returns a Matrix `next_batch` token;
- room membership state is recorded as `m.room.member` events so clients can distinguish join/invite/leave transitions;
- federation / Server-Server APIs are intentionally out of scope for this MVP.
