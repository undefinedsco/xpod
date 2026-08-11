# Xpod authentication and composition

This document describes the browser contract for the two products served by
Xpod. It is about session ownership and routing; it does not define RDF
schemas, Pod models, or deployment secrets.

## Three supported profiles

Xpod keeps the Account session and the Solid/WebID session separate, while the
host composes them when a route needs both:

| Profile | Account session | Solid/WebID session | Typical consumer |
| --- | --- | --- | --- |
| Account-only | Required | Not required | Dashboard, account management |
| WebID-only | Not required | Required | A public Solid applet or identity-only host |
| Account-assisted | Required | Required, with an explicit `(webId, storageUrl)` binding | Pod-backed Settings |

The Account service never becomes an applet's Solid runtime, and an applet
must not create a second Account or OIDC client. `SolidAuthBoundary` exposes
the host-owned WebID state and actions without exposing credentials.

## Route authorization

The host chooses the route policy before rendering the surface. A successful
Account login does not imply that a Pod is open.

| Route | Anonymous | Account | WebID | Selected Pod binding |
| --- | --- | --- | --- | --- |
| Dashboard (`/dashboard/*`) | No | Yes | No | No |
| Local Settings (`/settings/network`, `/settings/services`) | Yes | Optional | No | No |
| Pod-backed Settings (`/settings/models`, Pod data) | No | Optional; not used for route authorization | Yes | Yes |

The same identity control appears in both products. It reports Account,
WebID, Pod, and combined status; it is not a second login or logout surface.
Xpod's one login flow normally leaves the Account session available as well,
but Pod-backed Settings authorizes its data only through the WebID session and
the selected Pod binding.

## One current-origin browser flow

1. The user enters a safe Dashboard or Settings route. The Xpod host creates
   one opaque transaction containing the requested route and, when known, its
   exact storage binding.
2. The host starts the Account/OIDC authorization flow. The browser performs
   the normal authorization-code + PKCE exchange; the test and production
   paths do not install tokens or pre-authenticated storage state.
3. The provider returns to the fixed same-origin path
   `/auth/callback?transaction=<opaque-id>&code=…&state=…`. The transaction id
   is a host correlation key, not an OIDC state replacement.
4. The callback consumes the transaction, validates the WebID and exact
   binding, and returns to the original safe route. Query values are not
   copied into a new issuer/provider selection.

Inrupt owns OIDC state, nonce, PKCE, and token exchange semantics. Xpod owns
the transaction id, route allow-list, and `(webId, storageUrl)` binding. The
callback is always the current Xpod origin; Cloud/local issuer choosers and
external WebIDs/Pods are not part of this surface.

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

Creating the first Pod is part of the Account-assisted flow: the host waits
for the binding to exist before consenting to a Pod-backed route. Account-only
routes can still complete while that binding is being created.

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
