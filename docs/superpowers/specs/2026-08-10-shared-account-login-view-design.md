# Shared Account and WebID Login Design

> **Xpod desktop composition note (2026-08-12):** The later approved
> `2026-08-10-xpod-auth-boundaries-design.md` supersedes this document's
> Dashboard-first OIDC orchestration. Dashboard/Status now opens a direct
> same-origin Account credentials modal. Pod-backed Settings starts the
> separate current-origin WebID session. The public package boundaries and
> single-session host profiles below remain authoritative; the old claim that
> every Xpod sign-in affordance starts WebID/OIDC does not.

## Goal

Build the complete public login presentation and typed contracts in the Xpod monorepo, then migrate Xpod to consume them. Linx remains unchanged in this phase and will migrate after the Xpod implementation is accepted.

The design distinguishes two authentication domains:

1. **Account login** authenticates a person to an account-capable identity provider so they can register, manage the account, create storage, and approve authorization requests. Xpod uses CSS for this domain.
2. **WebID login** is the application-side Solid OIDC flow that gives an application an Inrupt-managed Solid session for one selected WebID.

They share product styling and composable views. They do not share a session object, token, state union, or network controller.

The reusable package contracts remain data-driven, but Xpod applies a stricter local product policy in this phase: it exposes one login path bound to the current same-origin Xpod and does not expose an identity-provider chooser, custom issuer, external WebID, or external Pod.

## Xpod protocol flow

```text
User opens Dashboard/Status while Account-anonymous
  -> Xpod opens the shared same-origin Account credentials modal in-shell
  -> CSS establishes the Account session without starting OIDC

User opens a Pod-backed Settings surface while WebID-anonymous
  -> Xpod starts its single current-origin WebID/OIDC route
  -> CSS may reuse the existing Account session
  -> CSS limits WebID selection to the local account and local storage
  -> CSS presents OIDC consent when required
  -> the application callback restores one host-owned Inrupt Solid session
```

This is one user-visible login path that can establish or restore two independent sessions. The Account session is issued and owned by CSS; Dashboard consumes its state and CSS account controls. The Solid session is owned by the application host, managed through Inrupt, and consumed by Pod-backed Settings and applets. Neither session is converted into the other, and each product surface authorizes only through the session required by that surface. Account tokens, bearer tokens, DPoP material, and refresh tokens are never exposed through the applet SDK.

If the Account session already exists when Pod-backed Settings starts the login path, CSS reuses it and must not ask for the password again. If Pod-backed Settings starts the path first, the CSS Account login step establishes the Account session before the OIDC flow returns. Direct Account, password-recovery, and registration URLs are identity-provider implementation routes, not additional Xpod product login choices.

Dashboard never starts a WebID/OIDC transaction. It authenticates only the Account domain through the current-origin Account modal. Pod-backed Settings owns the separate WebID route; CSS may reuse the Account session so that this second protocol transaction does not require entering the Account password again. This is still one provider policy (the current Xpod), but it is deliberately two independent session domains.

## Xpod surface and service boundaries

Xpod keeps the existing three-service runtime. Dashboard and Settings are separate static application bundles, not separate services:

```text
Browser or Electron -> same-origin Gateway
  /dashboard, /status, /network                 -> API Server -> Dashboard bundle
  /settings, /ai-config, /ai-connections       -> API Server -> Settings bundle
  /<registered-app-callback>                    -> API Server -> host-side Inrupt callback
  /.account/*                                   -> CSS -> Account and OIDC endpoints
  /<local-pod>/*                                -> CSS -> Solid Pod data
```

The API Server may serve the Dashboard, Settings, and registered application callback assets, but it must not implement a parallel Account or OIDC login endpoint. The callback is a client-side host route that restores Inrupt state. Passwords, Account login/logout, Account controls, OIDC authorization and token endpoints, WebID selection, consent, and Solid data authorization remain CSS responsibilities reached through the same-origin Gateway.

Product surfaces use the sessions as follows:

| Surface | Authorization requirement | Data authority |
| --- | --- | --- |
| Dashboard | Account session | CSS Account API for the account's local Pods; API Server for local service status and operations |
| Local Xpod Settings | None | Local API Server configuration endpoints |
| Pod-backed Settings, AI Config, and AI Connections | WebID session | The selected local Pod through the host-owned authenticated fetch |

All sign-in affordances call the same Xpod local login controller. The route boundary decides which session must be authenticated before rendering; it does not create an alternative login path.

## Public composition profiles

The public packages provide independent capabilities. They must not require every host to create both authentication domains or adopt Xpod's product flow.

| Host profile | Public capabilities used | Required sessions |
| --- | --- | --- |
| Account-only | Account views and host-owned Account controller | Account session only |
| WebID-only | `SolidSessionRuntime`, WebID views, and `SolidAuthBoundary` | WebID/Inrupt session only |
| Account-assisted WebID | Both independent capabilities plus a host-owned coordinator | One or both sessions according to the host's route policy |

Xpod uses the Account-assisted WebID profile and owns its single-path orchestration. Another host may use only one session, expose several WebID routes, or provide a different login surface without constructing or depending on the unused runtime domain. Public types do not combine Account and WebID state, public controllers do not convert their credentials, and neither domain's package has a runtime dependency on the other.

Unified sign-in, route readiness, Account/WebID reconciliation, and combined logout are Xpod host policies. They are not mandatory behavior in `shared-ui`, `solid-sdk`, or `extension-sdk`.

## Package ownership

### `@undefineds.co/shared-ui`

Own controlled presentation components and theme tokens. Components receive values, public validation messages, pending state, and callbacks. They do not fetch, navigate, create sessions, or persist credentials.

The public surface includes:

- `AuthSurface`, with `page`, `modal`, and `embedded` presentation modes using one card geometry and token set;
- `AccountCredentialsView`, supporting password login and registration;
- `AccountLoginMethodListView`, rendering the login methods advertised by the identity provider;
- `PasswordRecoveryView` and `PasswordResetView`;
- `WebIdLoginRouteView`, rendering one controlled host-supplied route without hard-coded local/cloud branches; hosts may compose zero, one, or many route views and may separately supply an add-route action, while Xpod supplies exactly one current-origin route and no chooser or add-route action;
- existing restoring, connecting, remembered-login, failure, optional storage-conflict, and error views;
- `OidcConsentView`, rendering client identity, WebID selection, remember-client, approve, and deny actions, plus optional host-supplied edit-account or switch-account actions when the host composes the Account capability;
- `StorageBootstrapView`, rendering first-storage creation and readiness states.

Existing public exports remain available during migration, but new Xpod code uses the canonical names. Shared views use public `Button`, `Input`, `Label`, and theme tokens rather than host-specific Tailwind literals.

### `@undefineds.co/solid-sdk`

Own WebID-login protocol and runtime contracts above Inrupt:

- at most one logical `SolidSessionRuntime` per WebID-enabled application host, with restoration delegated to its session adapter; Xpod restores from Inrupt browser state when a same-origin bundle reloads, while Account-only hosts instantiate no Solid runtime;
- a typed `WebIdLoginRouteDescriptor` separating the required identity endpoint from an optional storage endpoint;
- a typed `WebIdLoginTransaction` for issuer, optional selected storage, authorization surface, prompt, and return context;
- session restoration, expiry classification, login start, logout, and cancellation hooks;
- storage reconciliation utilities used before opening a Pod.

The route descriptor is data-driven. It does not contain a deployment enum and does not require an applet to know how the host was deployed. Package generality does not imply an Xpod provider choice: Xpod constructs exactly one descriptor whose identity and storage endpoints belong to the current local Xpod.

### `@undefineds.co/extension-sdk`

Own the applet-facing boundary:

- `SolidAuthBoundary` maps the host's Solid session and login-attempt state into shared-ui views;
- `host.solid.requireLogin()` starts the host-owned WebID login flow;
- applets receive WebID and authenticated fetch, plus Pod state only when the host provides the optional storage capability.

The boundary does not implement Account login and does not expose identity-provider controls or credentials.

### Xpod host and identity SPA

Xpod remains responsible for controllers and side effects:

- CSS account-control discovery and Account session handling;
- password login, registration, username availability, recovery, and reset requests;
- first-storage provisioning and readiness checks;
- OIDC WebID selection, consent submission, denial, and redirect handling;
- return-path persistence and routing;
- construction of the single current-origin WebID login route used by every Xpod sign-in affordance;

Xpod pages become thin controllers that render public views. They contain no independent auth-card markup or visual tokens.

### Linx

Linx does not change in this phase. Its desktop startup, embedded authorization window, local connectivity, repair, and tunnel behavior remain app-local. A later migration will adapt those capabilities to the public descriptors and views and then delete Linx's duplicate login JSX.

## Typed domains

Account authentication and WebID authentication use different state contracts.

```ts
interface LoginEndpointDescriptor {
  url: string
  label: string
}

interface WebIdLoginRouteDescriptor {
  id: string
  label: string
  description?: string
  badge?: { label: string; tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }
  identityProvider: LoginEndpointDescriptor
  storageProvider?: LoginEndpointDescriptor
  availability: 'ready' | 'starting' | 'unavailable'
  unavailableReason?: string
}

interface RememberedWebIdLogin {
  displayName: string
  avatarUrl?: string
  webId?: string
  routeId: string
}

interface StorageBinding {
  storageUrl: string
  webId: string
  label?: string
}

interface WebIdLoginTransaction {
  id: string
  route: WebIdLoginRouteDescriptor
  selectedStorage?: StorageBinding
  authorizationSurface: 'redirect' | 'popup' | 'embedded' | 'external'
  prompt?: 'login' | 'consent' | 'select_account'
  discovery: 'standard' | 'strict'
  authorizationParameters?: Readonly<Record<string, string>>
  returnTo?: string
}

type AccountAuthState =
  | { status: 'initializing' }
  | { status: 'anonymous'; mode: 'login' | 'register' | 'recovery' | 'reset' }
  | { status: 'submitting'; mode: 'login' | 'register' | 'recovery' | 'reset' }
  | { status: 'authenticated' }
  | { status: 'error'; mode: 'login' | 'register' | 'recovery' | 'reset'; message: string }

type WebIdAuthState =
  | { status: 'restoring'; remembered?: RememberedWebIdLogin }
  | { status: 'anonymous'; remembered?: RememberedWebIdLogin }
  | { status: 'connecting'; route: WebIdLoginRouteDescriptor }
  | { status: 'authenticated'; webId: string }
  | { status: 'expired'; remembered?: RememberedWebIdLogin }
  | { status: 'error'; message: string; retryRouteId?: string }

type StorageSelectionState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'selecting'; candidates: readonly StorageBinding[] }
  | { status: 'creating' }
  | { status: 'waiting_for_binding' }
  | { status: 'ready'; selected: StorageBinding }
  | { status: 'conflict'; message: string }
  | { status: 'error'; message: string }
```

`AccountAuthState` and its form/view prop types are canonical shared-ui contracts. `WebIdLoginRouteDescriptor`, `RememberedWebIdLogin`, `StorageBinding`, `WebIdLoginTransaction`, `WebIdAuthState`, and `StorageSelectionState` are canonical solid-sdk contracts and are re-exported where extension-sdk consumers need them. Equivalent unions must not be redefined in Xpod or extension-sdk.

`WebIdAuthState` deliberately describes only the WebID session. `storageProvider`, `selectedStorage`, and `StorageSelectionState` are optional, separate capabilities for hosts that select or reconcile storage. A WebID-only identity consumer is not forced to declare a Pod or create storage state, and an Account-only consumer does not instantiate `SolidSessionRuntime` at all.

`StorageSelectionState.empty` means the host enabled storage selection but found no eligible binding. A host with no storage capability does not instantiate `StorageSelectionState`; it is not represented as `empty`.

Generic UI selection returns a route id and never overloads one string to mean both an issuer URL and a provider id. Xpod bypasses route selection because its host policy supplies one current-origin route.

## Account login behavior

- Login fields use email and current-password autocomplete semantics.
- Registration adds username, password confirmation, asynchronous username availability, and selectable suggestions.
- Recovery and reset use the same surface, error treatment, success treatment, and action footer.
- Server error codes are mapped by the Xpod controller to safe field or form messages before reaching shared-ui.
- Submission, username checks, and cancellation prevent duplicate actions.
- OIDC cancellation is shown only when an authorization request is actually pending; initialization is not treated as authentication-in-progress.
- Password-manager compatibility, keyboard submission, focus movement to errors, and screen-reader live regions are required.

## WebID login behavior

- Generic consumers may compose zero, one, or many route descriptors without built-in local/cloud branches. Optional custom-route UI exists only when the host supplies a validated add-route callback.
- Xpod renders one sign-in action for its current-origin route, does not render a route list, and supplies no add-route callback.
- Xpod exposes no custom issuer entry, provider chooser, external WebID, or external Pod. Exposing those capabilities in Xpod is outside this phase; other public-library consumers may supply them through host policy.
- Restoring, connecting, expired, retry, cancel, remembered-login, and optional storage-conflict states have wired actions; Account switching is supplied only by a host that composes the Account capability. No visible button may have a missing callback.
- The descriptor keeps identity and optional storage endpoints distinct. Xpod requires both and resolves them to the current local Xpod; identity-only consumers may omit storage.
- Async login start or route selection disables duplicate submission and surfaces only sanitized errors.
- The generic callback lets Inrupt consume and validate the OIDC `state`, then consumes the host transaction selected by an opaque transaction id carried in the registered callback URL. It validates the host-selected route and safe return context and restores the existing host-owned Inrupt runtime. It reconciles storage only when the transaction contains `selectedStorage`; identity-only transactions complete without storage state. Public code must not read, rewrite, or depend on Inrupt's private OIDC state storage.
- Callback completion updates WebID session state only. It never reads, writes, infers, or converts a CSS Account token, and it never constructs a second Inrupt session.
- Successful login returns through the host's return-path mechanism. Opening storage is an optional host action rather than a precondition of WebID authentication.

## Xpod OIDC consent and storage bootstrap

- `OidcConsentView` is presentation only. Xpod validates and submits the authorization request through CSS account controls.
- Redirect trust remains enforced by the identity-provider protocol layer. Xpod's built-in route uses its registered same-origin callback and provides no arbitrary redirect or issuer input.
- The Xpod callback additionally validates the fixed current-origin route, consumes the single-use host transaction id from its callback URL, validates the application-relative `returnTo`, requires the selected local Pod binding, reconciles it with the authenticated WebID, and opens that Pod. A missing selected binding is invalid for Xpod but remains valid for a generic identity-only consumer.
- Xpod permits one unexpired full-page login transaction per browser tab. The same-origin identity SPA may read that one pending public transaction without consuming it and records the exact selected binding before following the CSS consent redirect. A concurrent start, missing pending transaction, id mismatch, expiry, or replay fails deterministically. This single-active rule is Xpod host policy, not a public-package restriction.
- Dashboard obtains every exact local Pod/WebID binding for the Account through a CSS Account control backed by the Account's Pod ownership facts. OIDC consent consumes the exact `webId` plus `storageUrl` entries returned by the scoped CSS WebID picker. Neither surface reconstructs bindings by zipping separate Pod and WebID arrays. Pod-backed Settings receives one explicit binding; it must not silently select `storageUrls[0]`.
- When exactly one eligible binding exists, Xpod selects it. When several exist, Xpod restores the last valid selection or presents a Pod chooser. A missing or stale remembered selection never falls back to the first returned storage implicitly.
- WebID choices are limited to the selected local Pod binding.
- If the selected storage has no eligible WebID, Xpod uses `StorageBootstrapView` to create it and waits for the WebID/storage binding before continuing consent.
- Consent denial, popup/embedded dismissal, lost transaction, timeout, and account switching return deterministic public states.

The storage selection state proceeds through `loading`, `empty` or `selecting`, optional `creating` and `waiting_for_binding`, and finally `ready`. Conflicting bindings enter `conflict`; transport or protocol failures enter `error`. OIDC consent cannot begin before the state is `ready`.

For Xpod, no local binding enters `empty` and permits storage bootstrap. A stale remembered binding is discarded and transitions to `selecting` when other candidates exist or `empty` when none exist. Multiple incompatible bindings enter `conflict`; forbidden or failed Account enumeration enters `error`. Identity-only consumers skip this state machine entirely.

## Xpod unified login and logout lifecycle

- The top-left Avatar and every protected-route sign-in action call the same Xpod local login controller. There is no separate Account-login button and WebID-login button.
- Dashboard considers its route ready when the Account session is authenticated. Local Settings is always route-ready. Pod-backed Settings considers its route ready only when the WebID session and selected local Pod binding are authenticated.
- An existing Account session skips password entry when the same login path is invoked for Pod-backed Settings. An existing WebID session does not replace the Account session required by Dashboard.
- One visible logout action starts one host-owned logout transaction that records per-domain `pending`, `complete`, or `error` outcomes. It clears the Inrupt session and requests CSS Account logout through independent idempotent steps, then verifies both auth domains are anonymous before reporting success.
- Remembered identity and Pod-selection state is removed after the corresponding domain is verified anonymous. A partial failure retains only the opaque completion/error evidence needed to retry the unfinished step; it never persists tokens or secrets as retry metadata.
- A partial logout failure enters a deterministic logout-error state with an idempotent retry. The UI hides authenticated actions while the transaction is unresolved and must not claim success or present a mixed identity after clearing only one domain.
- Switching Account uses the same unified logout transaction before starting the one local login path again.

These rules apply to the Xpod host composition only. Account-only consumers may expose only Account logout, and WebID-only consumers may expose only Solid-session logout; public packages do not synthesize a combined logout transaction.

## Surface, accessibility, and localization

- `AuthSurface` uses one tokenized card implementation across page, modal, and embedded hosts.
- Modal mode traps focus, restores focus, supports Escape according to host policy, and has a real accessible title.
- Page and embedded modes do not claim modal semantics.
- Registration and long consent content use a viewport-bounded scrolling body and remain usable with a mobile software keyboard.
- Segmented or selectable controls expose checked/selected state to assistive technology.
- Product name, labels, descriptions, errors, and action copy are supplied through a typed copy object; shared components do not hard-code `undefineds`, cloud, local, or one language.

## Xpod migration scope

Xpod migrates these surfaces in the same phase:

- the single current-origin login controller used by every Xpod sign-in affordance;
- Dashboard's Account-session boundary;
- Pod-backed Settings' WebID-session boundary, while local Settings remains login-free;
- the legacy `LoginSelectPage` route, which becomes the single current-origin login controller shell and renders no provider selection;
- `WelcomePage` login and registration modes;
- `ForgotPasswordPage`;
- `ResetPasswordPage`;
- `ConsentPage`;
- `FirstPodPage` and its shared storage-creation presentation;
- global account initialization, failure, and loading presentation.

The existing controller helpers for registration, provisioning, consent, and return-to behavior remain in Xpod unless protocol logic is explicitly moved to solid-sdk. The migration must remove superseded Xpod auth-card markup after its replacement passes tests.

## Verification

### Package tests

- shared-ui interaction tests cover every Account and WebID view, pending state, errors, keyboard actions, accessible names, focus, modal behavior, and responsive overflow;
- solid-sdk tests cover identity-only and identity-plus-storage route descriptors, transaction normalization, one-session restoration, expiry, cancellation, and identity/storage separation;
- extension-sdk tests cover every `SolidAuthBoundary` state and prohibit no-op visible actions;
- composition tests prove Account-only consumers need no Solid runtime, WebID-only consumers need no Account controller, and composing both does not merge their states or credentials;
- packaged-consumer tests import the built package entry points and theme.

### Xpod tests

- Account login, registration, duplicate-email recovery, username availability, forgot/reset password, and logout;
- existing-account WebID login, first-storage registration, WebID selection, consent approve/deny, account switch, and return-path restoration;
- one visible login path with exactly one current-origin route and no provider chooser, custom issuer, external WebID, or external Pod;
- Dashboard-first login followed by Pod-backed Settings without a second password prompt, and direct Pod-backed Settings login that leaves the Account session available to Dashboard;
- Dashboard Account-session authorization, anonymous local Settings, and Pod-backed Settings WebID-session authorization;
- Account-level enumeration of all local Pod/WebID bindings, deterministic last-Pod restoration, explicit multi-Pod selection, and no implicit first-storage fallback;
- distinct identity and storage endpoints;
- expired-session reauthentication without constructing a second Inrupt Session;
- login cancellation, lost consent transaction, invalid callback state, unsafe return path, and storage conflict;
- one logout action that leaves both Account and WebID auth domains anonymous, including deterministic partial-failure retry;
- same-origin Gateway routing that serves Dashboard and Settings through the API Server while keeping Account, OIDC, and Pod endpoints on CSS;
- real browser acceptance through Xpod routes, without storage-state injection or browser token fallback;
- package builds, UI builds, lint, focused tests, and the complete integration suite.

## Deferred work

- Migrating Linx to the public implementation;
- exposing external identity providers, external WebIDs or Pods, custom issuer entry, or a provider chooser in Xpod;
- passkeys/WebAuthn, MFA, recovery codes, social or enterprise login;
- remembered multi-account lists and device/session management;
- changing the CSS account-session transport. The current browser-readable account token requires a separate backend/security design and must not be generalized into the public SDK.

## Acceptance criteria

1. Xpod renders no private account/WebID login card when an equivalent public view exists.
2. Account login and WebID login remain separate typed domains with separate session ownership.
3. Public packages support Account-only, WebID-only, and host-composed use without requiring or instantiating an unused session domain.
4. Xpod exposes one login path bound to the current same-origin Xpod and renders no provider chooser, custom issuer, external WebID, or external Pod option.
5. The one Xpod login path may establish both sessions, but Dashboard authorizes through Account Session, Pod-backed Settings authorizes through WebID Session, and local Settings requires no login.
6. Dashboard lists all local Pod/WebID bindings through CSS Account controls; Pod-backed Settings uses an explicit selected binding and never an implicit first-storage fallback.
7. Dashboard and Settings assets remain API Server surfaces, while Account, OIDC, and Pod endpoints remain CSS surfaces behind the same-origin Gateway; no new service is introduced.
8. One visible Xpod logout action transitions both Account and WebID auth domains to anonymous or exposes a deterministic retryable failure; single-domain consumers keep their own logout behavior.
9. Dashboard, Settings, and identity-provider pages share the same public visual contract.
10. Login route data expresses identity and storage endpoints without deployment-mode branching.
11. Every action is connected, every pending state prevents duplicates, and every error has a deterministic recovery path.
12. Linx continues to work unchanged and has a documented later migration path.
