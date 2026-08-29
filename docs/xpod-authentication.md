# Xpod authentication and composition

This document describes the browser contract for the two products served by
Xpod. It is about session ownership and routing; it does not define RDF
schemas, Pod models, or deployment secrets.

## Three supported profiles

Xpod keeps the Account session and the Solid/WebID session separate, while the
host composes them when a route needs both:

| Profile | Account session | Solid/WebID session | Typical consumer |
| --- | --- | --- | --- |
| Account-only | Required | Not required | Dashboard/Status routes and CSS account management routes |
| WebID-only | Not required | Required | AI Connections, AI Config, and Pod-backed Settings routes |
| Account-assisted | Required | Required, with an explicit `(webId, storageUrl)` binding | Host flows that genuinely compose both domains (for example binding reconciliation); no single Xpod route requires both |

Route-level ownership follows
[`xpod-service-auth-boundaries.md`](xpod-service-auth-boundaries.md); the two
sessions are never inferred from one another.

The Account service never becomes an applet's Solid runtime, and an applet
must not create a second Account or OIDC client. `SolidAuthBoundary` exposes
the host-owned WebID state and actions without exposing credentials.

## Route authorization

Each protected route is gated by its own boundary and mounts its layout only
after that boundary is ready; unrelated services remain usable when one domain
fails. A successful Account login does not imply that a Pod is open, and each
request still uses only its required authority.

| Route | Anonymous | Account | WebID | Selected Pod binding |
| --- | --- | --- | --- | --- |
| Status / Dashboard (`/status`, `/dashboard/*`) | No | Yes | No | No |
| Network (`/network`) and local-only Settings (Storage, Runtime, Cloud, Advanced) | Yes | Optional | No | No |
| AI Connections / AI Config and Pod-backed Settings | No | No | Yes | Yes |

The same identity control appears in both products. It reports Account,
WebID, Pod, and combined status; it is not a second login or logout surface.
Xpod's one login flow normally leaves the Account session available as well,
but Pod-backed Settings authorizes its data only through the WebID session and
the selected Pod binding.

## One current-origin browser flow

1. The user enters a safe Dashboard or Settings route. If restoration does not
   complete, the route's own boundary asks for exactly the session it owns:
   Account-gated routes show the Xpod-owned Account form (email + password);
   WebID-gated routes show one WebID action with no Account credential fields
   or provider chooser.
2. That action creates one opaque transaction containing the requested route
   and, when known, its exact storage binding, then starts OIDC. CSS may verify
   its own Account internally. The browser performs
   the normal authorization-code + PKCE exchange; the test and production
   paths do not install tokens or pre-authenticated storage state.
3. The provider returns to the fixed same-origin path
   `/auth/callback?transaction=<opaque-id>&code=…&state=…`. The transaction id
   is a host correlation key, not an OIDC state replacement.
4. The callback consumes the transaction, validates the WebID and exact
   binding to the current Xpod storage provider, and returns to the original
   safe route. Query values are not copied into a new issuer/provider
   selection.

Inrupt owns OIDC state, nonce, PKCE, and token exchange semantics. Xpod owns
the transaction id, route allow-list, and `(webId, storageUrl)` binding. The
callback is always the current Xpod origin; Cloud/local issuer choosers and
external WebIDs/Pods are not part of this surface.

For a managed Local Xpod, Cloud is the IdP and the current Local Xpod is the
already-determined storage provider. Login never chooses between a Cloud Pod
and a Local Pod, and it never creates a Pod. The Local provisioning workflow
must create and bind the Local Pod before login. If the authenticated WebID
does not advertise a storage URL under the Local Xpod canonical public URL,
the callback reports an incomplete Local binding and links to provisioning
repair; it must not fall back to another Pod.

## Three-service routing

The browser sees one origin even though the local process has three logical
services:

| Browser path | Gateway route | Final owner | Responsibility |
| --- | --- | --- | --- |
| `/`, `/dashboard/*`, `/settings/*`, `/auth/callback` | API route | API Server | Serves the product bundles and fixed client-side callback; the browser host owns navigation and transaction composition |
| `/.account/*`, OIDC authorize/consent/token routes, Pod LDP/SPARQL | CSS route | CSS | Account controls, authorization-code flow, and Solid protocol/session endpoints |
| `/api/*` | API route | API Server | Management and business APIs; it does not own Account login or browser OIDC state |

The Gateway is the single public ingress and forwards to CSS or the API Server;
it does not become a fourth runtime service or authentication owner. Applets
call host capabilities rather than reaching around the boundary.

## Explicit Pod bindings and multiple Pods

Every Pod-backed operation uses the pair `(webId, storageUrl)`. A single
Account with one binding can restore that exact pair. With multiple bindings,
the host restores a previously remembered valid pair or asks the user to
choose one. It never picks the first response, first array entry, or a profile
storage value implicitly. A stale or mismatched pair is rejected and surfaces
an actionable recovery state; it is not silently replaced.

Creating the first Pod belongs to Local provisioning, before the browser login
flow. The login flow only consumes the resulting binding. Account-only routes
can still complete while provisioning is being repaired, but Pod-backed routes
remain unavailable until the current Local binding exists.

## Unified logout

Xpod's host owns one logout transaction that clears the Account and WebID
domains and then verifies both are anonymous. If one domain fails, the UI
shows the failed step and retries only that step; a partial success is never
reported as complete. Clearing local binding/runtime state happens only after
the corresponding domain is confirmed.

Public SDK consumers may still expose their own single-domain logout method
when they do not compose Account and WebID. That is a separate contract and
must not add a second visible logout path to Xpod.

## External hosts

Electron and Linx are external host contracts. They may provide the same
host-owned Account/WebID capabilities and route composition, but this
repository does not claim to package Electron or migrate Linx. Those hosts
must preserve the current-origin callback, explicit binding, and no-token
boundary when they integrate later.

## Credential boundary

Browser acceptance and applet contracts do not accept access tokens, Account
tokens, refresh tokens, DPoP material, or callback state injection. User AI
credentials are a separate Pod capability and are not authentication-session
credentials.
