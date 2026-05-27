# Matrix over Solid Pod Research

Date: 2026-05-22

## Findings

- I did not find a maintained implementation that uses a Solid Pod directly as a Matrix homeserver storage backend.
- The closest Solid-side prior art is Solid Chat / SolidOS chat data, which stores conversations and messages as RDF resources in Pods.
- Matrix is specified around homeserver HTTP APIs, especially Client-Server endpoints under `/_matrix/client/*`, and federation is a separate protocol surface.
- Therefore the pragmatic first implementation is a Pod-backed Matrix Client-Server adapter in the API service, not a full federating homeserver.

## Implementation Boundary

Initial Matrix support should expose a minimal Client-Server subset:

- `GET /_matrix/client/versions`
- login discovery / password-or-token login compatibility endpoints
- `POST /_matrix/client/v3/createRoom`
- `PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId`
- `GET /_matrix/client/v3/sync`
- `GET /_matrix/client/v3/rooms/:roomId/messages`
- basic room state/event lookup endpoints

Federation, E2EE key APIs, typing, receipts, push rules, presence, account data, device lists, and media APIs are follow-up protocol surfaces.

## Modeling Decision

Durable Matrix data must be owned by `@undefineds.co/models` and stored through drizzle-solid:

- Matrix rooms map to Pod-backed room resources.
- Matrix events map to Pod-backed event resources.
- Matrix account/device/session data maps to Pod-backed account resources.
- API service code is only a protocol adapter: it validates Matrix requests, authenticates through existing API auth, and calls the model-backed store.

Do not store Matrix data as opaque JSON files or parse Turtle manually in API handlers.
