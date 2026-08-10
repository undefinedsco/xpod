# Shared Account and WebID Login Design

## Goal

Build the complete public login presentation and typed contracts in the Xpod monorepo, then migrate Xpod to consume them. Linx remains unchanged in this phase and will migrate after the Xpod implementation is accepted.

The design distinguishes two authentication domains:

1. **Account login** authenticates a person to an Xpod identity provider so they can register, manage the account, create storage, and approve authorization requests.
2. **WebID login** is the application-side Solid OIDC flow that gives an application an Inrupt-managed Solid session for one selected WebID.

They share product styling and composable views. They do not share a session object, token, state union, or network controller.

## Protocol flow

```text
Application selects a WebID login route
  -> Solid OIDC redirects to the selected identity provider
  -> identity provider performs Account login when required
  -> identity provider presents WebID selection and OIDC consent
  -> application callback restores one host-owned Inrupt Solid session
```

The Account session belongs only to the identity-provider pages. The Solid session belongs to the application host and is shared by every applet in that host. Account tokens, bearer tokens, DPoP material, and refresh tokens are never exposed through the applet SDK.

## Package ownership

### `@undefineds.co/shared-ui`

Own controlled presentation components and theme tokens. Components receive values, public validation messages, pending state, and callbacks. They do not fetch, navigate, create sessions, or persist credentials.

The public surface includes:

- `AuthSurface`, with `page`, `modal`, and `embedded` presentation modes using one card geometry and token set;
- `AccountCredentialsView`, supporting password login and registration;
- `AccountLoginMethodListView`, rendering the login methods advertised by the identity provider;
- `PasswordRecoveryView` and `PasswordResetView`;
- `WebIdLoginRouteView`, rendering self-describing login routes without hard-coded local/cloud branches;
- existing restoring, connecting, remembered-account, failure, storage-conflict, and error views;
- `OidcConsentView`, rendering client identity, WebID selection, remember-client, approve, deny, edit-account, and switch-account actions;
- `StorageBootstrapView`, rendering first-storage creation and readiness states.

Existing public exports remain available during migration, but new Xpod code uses the canonical names. Shared views use public `Button`, `Input`, `Label`, and theme tokens rather than host-specific Tailwind literals.

### `@undefineds.co/solid-sdk`

Own WebID-login protocol and runtime contracts above Inrupt:

- one `SolidSessionRuntime` per application host;
- a typed `WebIdLoginRouteDescriptor` separating identity and storage endpoints;
- a typed `WebIdLoginTransaction` for issuer, selected storage, authorization surface, prompt, and return context;
- session restoration, expiry classification, login start, logout, and cancellation hooks;
- storage reconciliation utilities used before opening a Pod.

The route descriptor is data-driven. It does not contain a deployment enum and does not require an applet to know whether a route is local, cloud, standalone, or custom.

### `@undefineds.co/extension-sdk`

Own the applet-facing boundary:

- `SolidAuthBoundary` maps the host's Solid session and login-attempt state into shared-ui views;
- `host.solid.requireLogin()` starts the host-owned WebID login flow;
- applets receive WebID, Pod state, and authenticated fetch only.

The boundary does not implement Account login and does not expose identity-provider controls or credentials.

### Xpod host and identity SPA

Xpod remains responsible for controllers and side effects:

- CSS account-control discovery and Account session handling;
- password login, registration, username availability, recovery, and reset requests;
- first-storage provisioning and readiness checks;
- OIDC WebID selection, consent submission, denial, and redirect handling;
- return-path persistence and routing;
- construction of WebID login route descriptors for Dashboard and Settings.

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
  storageProvider: LoginEndpointDescriptor
  availability: 'ready' | 'starting' | 'unavailable'
  unavailableReason?: string
}

interface RememberedAccount {
  displayName: string
  avatarUrl?: string
  webId?: string
  routeId: string
}

interface WebIdLoginTransaction {
  route: WebIdLoginRouteDescriptor
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
  | { status: 'restoring'; account?: RememberedAccount }
  | { status: 'anonymous'; account?: RememberedAccount }
  | { status: 'connecting'; route: WebIdLoginRouteDescriptor }
  | { status: 'authenticated'; webId: string }
  | { status: 'expired'; account?: RememberedAccount }
  | { status: 'error'; message: string; retryRouteId?: string }
```

`AccountAuthState` and its form/view prop types are canonical shared-ui contracts. `WebIdLoginRouteDescriptor`, `RememberedAccount`, `WebIdLoginTransaction`, and `WebIdAuthState` are canonical solid-sdk contracts and are re-exported where extension-sdk consumers need them. Equivalent unions must not be redefined in Xpod or extension-sdk.

UI selection returns the route id. It never overloads one string to mean both an issuer URL and a provider id.

## Account login behavior

- Login fields use email and current-password autocomplete semantics.
- Registration adds username, password confirmation, asynchronous username availability, and selectable suggestions.
- Recovery and reset use the same surface, error treatment, success treatment, and action footer.
- Server error codes are mapped by the Xpod controller to safe field or form messages before reaching shared-ui.
- Submission, username checks, and cancellation prevent duplicate actions.
- OIDC cancellation is shown only when an authorization request is actually pending; initialization is not treated as authentication-in-progress.
- Password-manager compatibility, keyboard submission, focus movement to errors, and screen-reader live regions are required.

## WebID login behavior

- Known login routes are displayed from descriptors. The component has no built-in local/cloud labels or selection branches.
- Custom issuer entry is an explicit secondary action and applies host-supplied URL policy.
- Restoring, connecting, expired, retry, cancel, remembered-account, account-switch, and storage-conflict states have wired actions; no visible button may have a missing callback.
- The selected identity endpoint may differ from the selected storage endpoint.
- Async route selection disables duplicate submission and surfaces only sanitized errors.
- Successful login returns through the host's existing return-path mechanism and opens the Pod associated with the authenticated WebID.

## OIDC consent and storage bootstrap

- `OidcConsentView` is presentation only. Xpod validates and submits the authorization request through CSS account controls.
- Registered OIDC redirect URIs may be cross-origin. Redirect trust is enforced by the identity-provider protocol layer rather than an incorrect same-origin UI restriction.
- WebID choices are limited to the selected storage scope. A Cloud account WebID is not evidence that a Local storage Pod exists.
- If the selected storage has no eligible WebID, Xpod uses `StorageBootstrapView` to create it and waits for the WebID/storage binding before continuing consent.
- Consent denial, popup/embedded dismissal, lost transaction, timeout, and account switching return deterministic public states.

## Surface, accessibility, and localization

- `AuthSurface` uses one tokenized card implementation across page, modal, and embedded hosts.
- Modal mode traps focus, restores focus, supports Escape according to host policy, and has a real accessible title.
- Page and embedded modes do not claim modal semantics.
- Registration and long consent content use a viewport-bounded scrolling body and remain usable with a mobile software keyboard.
- Segmented or selectable controls expose checked/selected state to assistive technology.
- Product name, labels, descriptions, errors, and action copy are supplied through a typed copy object; shared components do not hard-code `undefineds`, cloud, local, or one language.

## Xpod migration scope

Xpod migrates these surfaces in the same phase:

- Settings and Dashboard anonymous WebID login boundary;
- `LoginSelectPage`;
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
- solid-sdk tests cover route descriptors, transaction normalization, one-session restoration, expiry, cancellation, and identity/storage separation;
- extension-sdk tests cover every `SolidAuthBoundary` state and prohibit no-op visible actions;
- packaged-consumer tests import the built package entry points and theme.

### Xpod tests

- Account login, registration, duplicate-email recovery, username availability, forgot/reset password, and logout;
- existing-account WebID login, first-storage registration, WebID selection, consent approve/deny, account switch, and return-path restoration;
- distinct identity and storage endpoints;
- expired-session reauthentication without constructing a second Inrupt Session;
- custom issuer validation, login cancellation, lost consent transaction, and storage conflict;
- real browser acceptance through Xpod routes, without storage-state injection or browser token fallback;
- package builds, UI builds, lint, focused tests, and the complete integration suite.

## Deferred work

- Migrating Linx to the public implementation;
- passkeys/WebAuthn, MFA, recovery codes, social or enterprise login;
- remembered multi-account lists and device/session management;
- changing the CSS account-session transport. The current browser-readable account token requires a separate backend/security design and must not be generalized into the public SDK.

## Acceptance criteria

1. Xpod renders no private account/WebID login card when an equivalent public view exists.
2. Account login and WebID login remain separate typed domains with separate session ownership.
3. Dashboard, Settings, and identity-provider pages share the same public visual contract.
4. Login route data expresses identity and storage endpoints without deployment-mode branching.
5. Every action is connected, every pending state prevents duplicates, and every error has a deterministic recovery path.
6. Linx continues to work unchanged and has a documented later migration path.
