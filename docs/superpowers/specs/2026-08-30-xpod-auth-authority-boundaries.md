# Xpod Auth Authority Boundaries

> **Status: canonical decision record (2026-08-30).** This document replaces
> the session-composition and unified-login ownership described by older Xpod
> auth documents. Those documents remain historical implementation context,
> but they do not override the authority boundaries below.

## Decision

Xpod does not own a third, composed authentication session.

XpodAuthProvider is deliberately absent. The shell mounts the native CSS
AuthProvider and the Inrupt-backed XpodSolidRuntimeProvider as independent
providers. Pages select the one authority they need; no context merges them.

There are only two user identity authorities:

1. **CSS owns the Account session.** Account login, logout, refresh, cookies or
   native Account tokens, Account controls and `/.account/*` all belong to CSS.
2. **Inrupt owns the WebID session.** Browser OIDC state, PKCE, DPoP key
   material, access/refresh tokens, restoration, authenticated `fetch`, WebID
   and Solid-resource authorization belong to the Inrupt `Session`.

Everything else consumes one of those authorities or requires no user
identity. Xpod adapters may project native state into React, but may not mint,
mirror, merge, translate or infer another session.

`XpodSolidRuntimeProvider` is a projection provider, not a global session
restorer. The shell may mount it once for every rail surface, but only
Pod-backed route boundaries are allowed to call Inrupt restoration. Account-only
routes such as Status/Dashboard and local-only routes such as Network must not
trigger `prompt=none`, `/auth/callback`, or any WebID login card merely because
the provider is present.

The SDK runtime treats successful Inrupt initialization as a once-per-document
operation. Concurrent callers share the same pending initialization, route
boundary remounts reuse the settled snapshot, and only a failed initialization
may be retried. A route remount must never start a second silent authorization.
Projection providers must subscribe and then reconcile the runtime's current
snapshot so a child route cannot complete restoration before its parent starts
listening and leave the UI stuck in `loading`.

```text
                         Xpod Gateway
                    route + canonical URL only
                              |
          +-------------------+-------------------+
          |                                       |
          v                                       v
  Community Solid Server                     Xpod API
  ----------------------                     --------
  Account authority                          Solid request verifier
  OIDC provider                              local-host verifier
  Solid authorization                        service/node/API-key verifiers
  /.account/*                                no Account session
          ^                                       ^
          |                                       |
  CSS Account client                       Inrupt-authenticated request
  (Account pages only)                     or explicitly scoped API credential

  Static Applet / SPA
  -------------------
  receives WebID, Pod and session.fetch from its host
  owns no Account client, session store, auth endpoint or backend service
```

## Authority matrix

| Concern | Authority | State holder | Consumer | Forbidden behavior |
| --- | --- | --- | --- | --- |
| Account login and recovery | CSS | CSS native Account session | Status/Dashboard and CSS Account pages | Xpod API issuing or refreshing Account credentials |
| WebID OIDC login | Inrupt SDK + CSS OIDC endpoints | One Inrupt `Session` per browser host | Pod-backed routes and applets | Inferring WebID readiness from Account readiness |
| Solid Pod authorization | CSS Solid authorization | DPoP/Bearer request from Inrupt | CSS resources and WebID-authenticated API routes | Treating an Account token as a Solid principal |
| Local runtime administration | Local Xpod host | loopback or signed Gateway transport | Network/local Settings | Requiring Account or WebID merely because a page is inside the shell |
| Service and node control | API verifier | service/node credential | provisioning and control-plane routes | Exposing these credentials to browser applets |
| AI Gateway inference | API verifier | user Gateway API Key or Solid request | `/v1/*` inference | Letting a Gateway API Key manage Account or Provider credentials |
| Upstream AI Provider login | Provider connector | credential stored in the user's Pod | AI Connections | Calling this an Xpod Account or WebID session |

## 1. CSS Account boundary

The Account session is already a complete CSS capability. Xpod must not add an
`XpodAccountSession`, a combined Account/WebID session, or a second refresh
state machine.

Allowed Xpod behavior:

- render an Account-oriented page using CSS native controls;
- call same-origin `/.account/*` endpoints;
- carry the current CSS-issued Account token only in a same-origin,
  session-scoped cookie needed by those controls; it must have no persistent
  lifetime and must never be reconstructed from remembered metadata or Web
  Storage;
- map native CSS loading, authenticated, anonymous and error states into Xpod
  presentation;
- keep a non-secret display hint such as the last Account name, provided it is
  never treated as authentication evidence.

Not allowed:

- exchange an Account credential for WebID authority;
- send an Account token to ordinary Xpod API business routes;
- make an Account failure log out or invalidate the Inrupt `Session`;
- use remembered Account metadata as a session or authorization source;
- implement Account login, refresh or logout semantics in Gateway or API.

`AccountAuthBoundary` therefore means “project CSS Account readiness”. It does
not mean “Xpod owns Account authentication”.

## 2. Inrupt WebID boundary

Pod-backed product surfaces use one host-owned Inrupt `Session`.

The browser frontend owns the live SDK object and uses `session.fetch` for Pod
resources and WebID-authenticated API requests. The API backend is stateless:
it verifies the DPoP/Bearer proof on each request and constructs a Solid
principal. It does not keep a second server-side copy of the browser session.

The Xpod layer above Inrupt should only add small host concerns:

- one initialization/restoration guard so React remounts do not construct
  duplicate `Session` objects;
- validated current-origin issuer and callback inputs;
- safe `returnTo` handling;
- WebID profile and storage discovery;
- presentation-friendly loading/error mapping;
- optional optimal-path transport that preserves the canonical signed URL.

The following are not session responsibilities:

- CSS Account readiness;
- local Xpod provisioning or Service Provider registration;
- remembered Account or Pod metadata;
- resource-level 401/403/404/500 responses;
- Gateway or API process health.

A failed Pod read is a failed resource operation. It must not silently change
the Inrupt session to anonymous. Only Inrupt session restoration, redirect
completion, explicit logout or an SDK-authentication event may change WebID
session state.

## 3. Local Pod binding is provisioning, not authentication

The local Service Provider binding is created during Local Xpod provisioning
and written to the WebID profile. After that, normal login discovers the Pod
from the WebID profile and uses it.

Therefore `local-binding-missing` is an integrity/provisioning exception, not a
normal login phase and not a third session state. It may expose a repair action
when provisioning evidence is genuinely absent, but it must not appear on
every login, route transition or temporary resource failure.

The selected Pod may be cached as a performance hint. The cache is never
authorization evidence; the WebID profile and Solid authorization remain
authoritative.

## 4. API boundary

The API Server has multiple independent request credential types, but it owns
no browser login session.

### Browser user APIs

- Pod/AI management APIs accept a WebID-authenticated DPoP/Bearer request.
- The frontend supplies that request through the existing Inrupt
  `session.fetch`.
- The API verifies the request and uses the resulting WebID principal.
- Account tokens are not accepted as a substitute for a WebID principal.

### Non-user APIs

- local Network and runtime administration use loopback/signed local-host
  transport;
- service and node routes use their own scoped credentials;
- `/v1/*` inference may use a Gateway API Key or a Solid request, according to
  the route contract.

These credentials remain separate. `MultiAuthenticator` may dispatch among
independent API credential schemes, but it must not merge them or contain a
general CSS Account authenticator.

## 5. Applet boundary

An applet is a static SPA module. It does not need an applet server.

The deployment may serve its JavaScript, CSS and assets through the existing
Gateway/API static-asset path, but that is file delivery, not an applet-owned
backend or authentication service.

The host mounts an applet only after the required capability is ready and
injects a narrow runtime contract:

```text
webId
pod/storage root
authenticated fetch (Inrupt session.fetch)
host navigation and presentation callbacks
explicit product APIs such as AI Connections, when required
```

An applet must not:

- import Account context, Account token helpers or `/.account/*` controls;
- construct or persist another Inrupt `Session`;
- show an Account login form;
- implement an auth callback or auth server;
- receive Account, refresh, DPoP private-key, service or node credentials;
- decide whether an Account session is valid.

If a provider integration needs a server-side OAuth secret or callback, it is
implemented as a generic host Provider-connector capability in the existing
Xpod API. It is not an applet authentication service.

## 6. Gateway boundary

Gateway is authentication-transparent transport:

- route `/.account/*`, OIDC and Solid protocol requests to CSS;
- route Xpod management/inference APIs to API;
- route static application assets to their host;
- preserve the canonical URL/host used by DPoP signing and verification;
- add only explicit local-host transport attestation where required.

Gateway must not create a session, convert Account credentials into Solid
credentials, infer WebID/Pod ownership, or treat upstream health as login
state.

## 7. Product route ownership

| Surface | Required boundary | Must remain independent from |
| --- | --- | --- |
| Status / Dashboard | CSS Account | WebID session |
| CSS Account pages | CSS Account | Xpod API auth adapters |
| AI Connections | Inrupt WebID + discovered Pod | Account session |
| AI Config | Inrupt WebID + discovered Pod | Account session |
| Pod / Identity Settings | Inrupt WebID + discovered Pod | Account session |
| Network | local-host transport | Account and WebID |
| Storage / Runtime / Cloud / Advanced local Settings | local-host transport | Account and WebID |
| Static applet | host-injected WebID capability | Account and applet-owned services |

The shell may keep both providers mounted so route switches are fast, but it
must not place a combined auth gate around the shell. Each page mounts behind
only its own boundary.

## 8. Failure isolation

| Failure | State that may change | State that must not change |
| --- | --- | --- |
| CSS Account reports anonymous/expired | Account UI only | Inrupt WebID session |
| Inrupt restore or OIDC completion fails | WebID UI only | CSS Account session |
| Pod resource returns 401/403/404/500 | resource operation | Account and WebID session state |
| local Network API fails | Network page | Account and WebID session state |
| Gateway/API process is unavailable | affected request/page health | Account and WebID session state |
| explicit Account logout | CSS Account | the currently live Inrupt session |
| explicit WebID logout | Inrupt Session | Account unless the user separately chose global sign-out |

A product-level “Sign out everywhere” action may invoke both native logout
ports sequentially. That is UI orchestration, not a composed session.

Cold restoration is a separate SDK operation. The Inrupt browser SDK may
restore a prior WebID session by performing a silent OIDC authorization at the
IdP. After an explicit CSS Account logout removes the IdP interaction cookie,
that silent authorization can require the user to authorize WebID again on the
next document load. Xpod must not compensate by preserving an Account token,
minting a session, or coupling the two providers: the live Inrupt session stays
usable until reload/expiry, and the subsequent recovery UI remains WebID-only.

## 9. Current deviations and required code changes

### Delete or narrow

1. **Delete combined-session orchestration.** XpodAuthProvider, useXpodAuth and
   the combined logout coordinator must not exist. Account recovery must not
   clear WebID, and ordinary route login must not require both domains to
   become ready.
2. **Reduce `ui/src/context/AuthContext.tsx` to a CSS Account adapter.** It may
   project native CSS controls but may not own Pod binding, WebID readiness or
   a second refresh protocol.
3. **Remove Account dependencies from
   `ui/src/solid/XpodSolidRuntimeProvider.tsx`.** Inrupt restoration and Pod
   discovery must not query Account bindings or Account client-credential
   controls.
4. **Remove the general `CssAccountTokenAuthenticator` from the Xpod API
   authenticator chain.** Account management stays on CSS. Any route that
   currently depends on this authenticator must be reassigned to Solid,
   local-host, service or node authority before deletion.
5. **Stop using `session.fetch` for local Network APIs.** Network uses ordinary
   host fetch plus the local-host transport contract.
6. **Remove applet-owned login presentation and Account imports.** The host
   `WebIdAuthBoundary` must be ready before mounting AI Connections.
7. **Delete unused Account client-credentials discovery from the Solid runtime.**
   It is Account administration, not WebID session initialization.

### Deferred: Account-level usage

Account-level usage is intentionally not authorized through an Account token
in the Xpod API. The product route stays deferred until its authority and data
projection are designed without reintroducing a general API Account
authenticator. Track that work in
[`2026-08-30-account-usage-authorization-todo.md`](../plans/2026-08-30-account-usage-authorization-todo.md).

### Keep and simplify

1. Keep one Inrupt `Session` runtime per browser host, including SDK-owned
   restoration and refresh.
2. Keep `SolidTokenAuthenticator` as the WebID request verifier for API routes.
3. Keep service/node/invocation/Gateway-key authenticators as independent,
   route-scoped API credentials.
4. Keep Gateway routing and canonical DPoP URL preservation.
5. Keep AI Connections as a static applet consuming host capabilities.
6. Keep local SP/profile repair only as an exceptional provisioning recovery
   path.

### Documentation cleanup

After implementation, point the following documents to this decision and mark
their conflicting session-composition sections historical:

- `docs/xpod-service-auth-boundaries.md`
- `docs/xpod-authentication.md`
- `docs/ai-connections-product-spec.md`
- `docs/superpowers/specs/2026-08-10-shared-account-login-view-design.md`
- `docs/superpowers/specs/2026-08-13-xpod-login-state-machine.md`

## 10. Migration order

1. Add negative dependency and failure-isolation regression tests.
2. Decouple Inrupt runtime from Account context and Account endpoints.
3. Decouple Network/local Settings from Inrupt fetch.
4. Move every Account-authenticated API route to its correct authority and
   remove the API Account authenticator.
5. Remove combined login/session orchestration from route boundaries.
6. Enforce static applet capability injection and remove applet auth UI.
7. Run web acceptance first, then desktop acceptance using the same source and
   runtime services.

## 11. Acceptance contract

The refactor is complete only when all of the following are demonstrated:

- Status can use a valid CSS Account session with no Inrupt session.
- AI Connections can use a valid Inrupt session with no Account adapter
  readiness and never opens an Account login page.
- switching Status -> AI Connections -> Network -> AI Config does not log out,
  create a second session or flash an unrelated login card;
- an Account failure leaves a valid Inrupt session usable;
- explicit Account logout leaves the live Inrupt session usable in the current
  document; a later SDK cold restore may require WebID authorization again;
- a WebID/resource failure leaves a valid Account session usable;
- Network works without Account or WebID headers;
- API management routes accept valid Solid DPoP and reject Account tokens;
- the applet bundle has no Account imports, Account endpoint strings, session
  construction or auth-server route;
- Gateway preserves canonical DPoP verification without translating auth;
- local SP binding is written during provisioning and normal subsequent login
  discovers it without a repair step;
- web dev-server acceptance passes before the same flow is accepted in the
  desktop shell.

The browser authority subset is executable with
`bun run auth:accept:browser`; it uses the real disposable CSS/OIDC fixture,
not mocked Provider state or source-text assertions.
