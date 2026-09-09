# Xpod Single Login Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (installed here as subagent-driven-development, recommended) or superpowers:executing-plans (installed here as executing-plans) to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver one current-origin Xpod sign-in path that composes independent CSS Account and Inrupt WebID sessions, while keeping the public packages usable as Account-only, WebID-only, or host-composed capabilities.

**Architecture:** Keep Account and WebID as separate typed/runtime domains. Public packages provide canonical data contracts, presentation, and an applet boundary without imposing Xpod policy. Xpod owns the current-origin route, host transaction, explicit local Pod selection, fixed callback, route readiness, and coordinated logout. Dashboard and Settings remain API-served bundles behind the Gateway; CSS continues to own Account, OIDC, consent, and Pod endpoints.

**Tech Stack:** TypeScript, React 19, React Router, @inrupt/solid-client-authn-browser, drizzle-solid, Bun, Vitest, Testing Library, Playwright, Vite, Xpod Gateway/API/CSS.

**Design source:** docs/superpowers/specs/2026-08-10-shared-account-login-view-design.md

---

## Execution order

Tasks 1 and 2 may run in parallel because shared-ui must not depend on solid-sdk. Task 3 depends on both. Tasks 4 through 9 are ordered because the Xpod callback, storage choice, route policy, and logout all consume the preceding contracts. Task 10 is the release gate.

Do not add a fourth runtime service. Do not move Account/OIDC endpoints into the API Server. Do not expose Account tokens, DPoP material, refresh tokens, or CSS controls through extension-sdk.
Do not add dependencies for this migration; use the existing React, Inrupt, Testing Library, and focus/menu primitives.

### Task 1: Define WebID and optional-storage contracts in solid-sdk

**Files:**
- Create: packages/solid-sdk/src/webid-auth.ts
- Create: packages/solid-sdk/src/storage-selection.ts
- Modify: packages/solid-sdk/src/session.ts
- Modify: packages/solid-sdk/src/pod-runtime.ts
- Modify: packages/solid-sdk/src/react.ts
- Modify: packages/solid-sdk/src/index.ts
- Modify: packages/solid-sdk/package.json
- Create: packages/solid-sdk/test/webid-auth.test.ts
- Create: packages/solid-sdk/test/storage-selection.test.ts
- Create: packages/solid-sdk/test/react.test.tsx
- Modify: packages/solid-sdk/test/session.test.ts
- Modify: packages/solid-sdk/test/pod-runtime.test.ts

- [x] **Step 1: Write failing contract tests**

Cover all of the following before implementation:

- a route with identityProvider and no storageProvider is valid;
- a route with distinct identityProvider and storageProvider is valid;
- a transaction has its own opaque id and can omit selectedStorage;
- unsafe returnTo values are rejected: absolute URLs, protocol-relative URLs, backslashes, encoded traversal, and paths outside the host application allow-list;
- authorizationParameters cannot override state, redirect_uri, client_id, response_type, code_challenge, or code_challenge_method;
- identity-only completion never creates StorageSelectionState;
- storage-capable reconciliation accepts an exact storageUrl plus webId pair and rejects a same-WebID/different-storage or same-storage/different-WebID substitution;
- one candidate becomes ready, several candidates become selecting, no candidates become empty, a stale remembered binding is discarded, and incompatible duplicates become conflict;
- SESSION_EXPIRED maps to an expired snapshot/state rather than a generic error;
- login-attempt start, cancel, retry, and logout are separate typed actions, and a host may omit cancel/retry when its authorization surface cannot provide them;
- concurrent initialize calls still use one Inrupt Session and one redirect restoration;
- SolidRuntimeValue compiles and renders with session only and with session plus Pod runtime.
- PodRuntime.open accepts an explicit podUrl, skips discovery in that branch, keys ready/pending work by webId plus podUrl, and never returns another Pod cached only by WebID;
- legacy callers that omit podUrl still use adapter discovery and retain existing single-flight/abort behavior.

Use these canonical public shapes:

~~~ts
export interface LoginEndpointDescriptor {
  url: string
  label: string
}

export interface WebIdLoginRouteDescriptor {
  id: string
  label: string
  description?: string
  badge?: {
    label: string
    tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
  }
  identityProvider: LoginEndpointDescriptor
  storageProvider?: LoginEndpointDescriptor
  availability: 'ready' | 'starting' | 'unavailable'
  unavailableReason?: string
}

export interface RememberedWebIdLogin {
  displayName: string
  avatarUrl?: string
  webId?: string
  routeId: string
}

export interface StorageBinding {
  storageUrl: string
  webId: string
  label?: string
}

export interface WebIdLoginTransaction {
  id: string
  route: WebIdLoginRouteDescriptor
  selectedStorage?: StorageBinding
  authorizationSurface: 'redirect' | 'popup' | 'embedded' | 'external'
  prompt?: 'login' | 'consent' | 'select_account'
  discovery: 'standard' | 'strict'
  authorizationParameters?: Readonly<Record<string, string>>
  returnTo?: string
}
~~~

- [x] **Step 2: Run the red tests**

Run:

~~~bash
bun run --cwd packages/solid-sdk test --   test/webid-auth.test.ts   test/storage-selection.test.ts   test/session.test.ts   test/react.test.tsx   test/pod-runtime.test.ts
~~~

Expected: new imports or assertions fail for missing canonical contracts; existing session and Pod runtime tests remain green except assertions intentionally changed for expired and optional Pod behavior.

- [x] **Step 3: Implement pure route, transaction, and return-path validation**

Export pure helpers from webid-auth.ts. Keep Inrupt's OIDC state private: Inrupt consumes and validates state through handleIncomingRedirect; the host transaction id is a separate single-use value transported in the registered callback URL.

Required helper surface:

~~~ts
export function normalizeWebIdLoginRoute(
  input: WebIdLoginRouteDescriptor,
): WebIdLoginRouteDescriptor

export function normalizeWebIdLoginTransaction(
  input: WebIdLoginTransaction,
): WebIdLoginTransaction

export function normalizeApplicationReturnTo(
  value: string | undefined,
  allowedPrefixes: readonly string[],
): string | undefined
~~~

Normalization must return copies, normalize endpoint URLs, reject credentials/fragments, and never silently reinterpret a route id as an issuer URL.

Also export a protocol-level WebIdLoginActions contract for start, optional cancel/retry, and logout. The contract may delegate to a host adapter; it must not pretend that an Inrupt full-page redirect can be cancelled after navigation begins.

- [x] **Step 4: Implement storage selection and reconciliation as a separate capability**

storage-selection.ts owns StorageSelectionState plus pure selection helpers. It must not import React, browser storage, Account controls, or Xpod code. Absence of the capability is represented by not constructing state, never by forcing empty.

Keep createPodRuntime focused on opening a caller-selected/discovered Pod. Do not add Xpod's last-selection policy to the package.

Extend PodRuntime.open with an optional explicit Pod URL:

~~~ts
open(args: {
  webId: string
  podUrl?: string
  fetch: PodRuntimeFetch
}): Promise<OpenPodRuntime<Database>>
~~~

When podUrl is present, normalize it, skip adapter.discoverPod, and use the composite webId/podUrl key for cache, pending, clear, and stale-generation checks. A second explicit Pod for the same WebID must not reuse or abort the wrong database. When podUrl is absent, preserve the existing discovery path for compatibility.

- [x] **Step 5: Classify expiry and make the React Pod runtime optional**

Add an expired session snapshot and preserve single-flight restoration. Change SolidRuntimeValue so pod and currentPod are optional. Existing Pod-enabled consumers remain source-compatible.

The minimum React shape is:

~~~ts
export interface SolidRuntimeValue<TDatabase = unknown> {
  session: SolidSessionRuntime
  pod?: PodRuntime<TDatabase>
  currentPod?: OpenPodRuntime<TDatabase>
}
~~~

Do not instantiate a fake unavailable Pod for identity-only consumers.

- [x] **Step 6: Export stable package subpaths**

Export the new contracts from the root and add package exports for ./webid-auth and ./storage-selection. Never edit dist by hand; package build regenerates it.

- [x] **Step 7: Verify and commit the solid-sdk slice**

Run:

~~~bash
bun run --cwd packages/solid-sdk test
bun run --cwd packages/solid-sdk build
bun run build:packages
~~~

Expected: all solid-sdk tests pass, the new subpaths resolve from dist, and the aggregate package build exits zero.

Commit only this task's files with an intent line such as “Keep WebID authentication independent from optional Pod selection” and record the exact test commands in Tested trailers.

### Task 2: Build canonical shared auth presentation without protocol dependencies

**Files:**
- Create: packages/shared-ui/src/auth-surface.tsx
- Create: packages/shared-ui/src/account-auth.tsx
- Create: packages/shared-ui/src/webid-auth.tsx
- Create: packages/shared-ui/src/oidc-consent.tsx
- Create: packages/shared-ui/src/storage-bootstrap.tsx
- Modify: packages/shared-ui/src/login.tsx
- Modify: packages/shared-ui/src/connect.tsx
- Modify: packages/shared-ui/src/index.ts
- Create: packages/shared-ui/test/auth-surface.test.tsx
- Create: packages/shared-ui/test/account-auth.test.tsx
- Create: packages/shared-ui/test/webid-auth.test.tsx
- Create: packages/shared-ui/test/oidc-consent.test.tsx
- Create: packages/shared-ui/test/storage-bootstrap.test.tsx
- Modify: packages/shared-ui/test/components.test.tsx
- Modify: packages/shared-ui/test/connect.test.tsx

- [x] **Step 1: Write interaction-first failing tests**

Use jsdom and Testing Library, not static-markup substring checks, for the canonical views. Cover:

- AuthSurface page, modal, and embedded modes;
- modal title, focus trap, Escape policy, and focus restoration;
- page and embedded modes without dialog or aria-modal semantics;
- login and registration autocomplete attributes, Enter submission, confirmation mismatch, username availability, suggestions, pending disablement, and live errors;
- recovery and reset success/error states;
- one WebID route action whose callback receives routeId, not an issuer string;
- remembered, restoring, connecting, expired, retry, cancel, storage-conflict, and failure states with no visible action lacking a callback;
- consent WebID/storage choice semantics, remember-client state, approve/deny pending behavior, and optional edit/switch Account actions;
- storage creation, waiting, ready, conflict, and error presentation;
- bounded scrolling for long registration/consent content.
- a complete host-supplied copy object changes product name, labels, descriptions, actions, and errors without falling back to Xpod, undefineds, Cloud, Local, or one built-in language.

- [x] **Step 2: Run the red shared-ui tests**

Run:

~~~bash
bun run --cwd packages/shared-ui test --   test/auth-surface.test.tsx   test/account-auth.test.tsx   test/webid-auth.test.tsx   test/oidc-consent.test.tsx   test/storage-bootstrap.test.tsx
~~~

Expected: the canonical files and exports do not yet exist.

- [x] **Step 3: Implement AuthSurface and canonical AccountAuthState**

AccountAuthState is a shared-ui presentation contract, not a controller. Views receive safe public validation messages, pending flags, controlled values, callbacks, and typed copy. Export per-view copy interfaces (or one composed AuthCopy interface) so required labels cannot silently become undefined.

~~~ts
export type AuthSurfaceMode = 'page' | 'modal' | 'embedded'

export type AccountAuthState =
  | { status: 'initializing' }
  | { status: 'anonymous'; mode: 'login' | 'register' | 'recovery' | 'reset' }
  | { status: 'submitting'; mode: 'login' | 'register' | 'recovery' | 'reset' }
  | { status: 'authenticated' }
  | {
      status: 'error'
      mode: 'login' | 'register' | 'recovery' | 'reset'
      message: string
    }
~~~

Implement AccountCredentialsView, AccountLoginMethodListView, PasswordRecoveryView, and PasswordResetView with public Button, Input, Label, Card, ScrollArea, and theme tokens.

- [x] **Step 4: Implement WebID, consent, and storage views as pure view props**

shared-ui must not import solid-sdk. Define presentation-only option props using strings and public badge tones. extension-sdk and Xpod perform the mapping from canonical protocol types.

WebIdLoginRouteView returns routeId. OidcConsentView returns selected option ids and controlled remember-client state. StorageBootstrapView reports user intent only; it does not provision storage.

- [x] **Step 5: Preserve compatibility exports while removing canonical hard-coding**

Retain LoginCardShell, LoginAccountView, LoginProviderListView, LoginSpaceSelectionView, ConnectSurface, and SolidConnectForm as compatibility wrappers. New code must use canonical names.

Canonical components must not hard-code undefineds, Cloud, Local, Xpod, one language, or host Tailwind literals. Copy comes from typed props. LoginSpaceSelectionView remains legacy and is not used by Xpod after Task 7.

- [x] **Step 6: Verify accessibility and package isolation**

Run:

~~~bash
bun run --cwd packages/shared-ui test
bun run --cwd packages/shared-ui build
bun run build:packages
~~~

Expected: all shared-ui tests pass and shared-ui/package.json has no solid-sdk, Inrupt, Account-controller, or Xpod dependency.

Commit only this task's files with an intent line such as “Let every host reuse one accessible authentication surface” and include accessibility tests in the Tested trailer.

### Task 3: Add a composable SolidAuthBoundary to extension-sdk

**Files:**
- Create: packages/extension-sdk/src/react/solid-auth-boundary.tsx
- Modify: packages/extension-sdk/src/react/auth-boundary.tsx
- Modify: packages/extension-sdk/src/react.ts
- Modify: packages/extension-sdk/src/web.ts
- Modify: packages/extension-sdk/src/testing.ts
- Modify: packages/extension-sdk/src/index.ts
- Modify: packages/extension-sdk/README.md
- Modify: packages/ai-connections/src/controller.tsx
- Modify: packages/ai-connections/test/controller.test.tsx
- Modify: packages/ai-connections/test/interactions.test.tsx
- Create: packages/extension-sdk/test/solid-auth-boundary.test.tsx
- Create: packages/extension-sdk/test/auth-composition.test.tsx
- Modify: packages/extension-sdk/test/auth-boundary.test.tsx
- Modify: packages/extension-sdk/test/solid-capability.test.ts
- Modify: packages/extension-sdk/test/web-permissions.test.ts
- Modify: tests/ui/packaged-sdk-consumer.test.ts
- Modify: tests/package/applet-packages.test.mjs

- [x] **Step 1: Write failing boundary and composition tests**

Test every WebIdAuthState variant and optional StorageSelectionState. Assert retry, cancel, switch, and conflict actions render only when a callback is supplied.

Add compile/render probes for:

1. Account-only: imports shared-ui Account views, creates no Solid runtime.
2. WebID-only: creates SolidSessionRuntime, supplies no Account controller and no pod property.
3. Account-assisted WebID: composes independent AccountAuthState and WebIdAuthState without a merged token/state union.

Update packaged-sdk-consumer.test.ts so built-package probes import the public subpaths and theme, rather than using pod: null as never.

Add AI Connections regressions proving a WebID-only host with no pod capability enters its deterministic unavailable/not-ready state and never dereferences host.solid.pod. A storage-capable ready host must retain current behavior.

- [x] **Step 2: Run the red extension tests**

Run:

~~~bash
bun run --cwd packages/extension-sdk test --   test/solid-auth-boundary.test.tsx   test/auth-composition.test.tsx   test/auth-boundary.test.tsx   test/solid-capability.test.ts   test/web-permissions.test.ts
bun test tests/ui/packaged-sdk-consumer.test.ts tests/package/applet-packages.test.mjs
~~~

Expected: SolidAuthBoundary and optional Pod contracts are missing.

- [x] **Step 3: Implement SolidAuthBoundary using solid-sdk types**

The boundary maps protocol state to shared-ui view props and calls only host-owned actions.

~~~ts
export interface SolidAuthBoundaryProps {
  state: WebIdAuthState
  storageState?: StorageSelectionState
  routes: readonly WebIdLoginRouteDescriptor[]
  onLogin: (routeId: string) => void | Promise<void>
  onRetry?: (routeId: string) => void | Promise<void>
  onCancel?: () => void | Promise<void>
  onSwitchAccount?: () => void | Promise<void>
  children: ReactNode
}
~~~

Do not implement Account login. Do not accept issuer-or-provider strings. Do not display a retry button when no retry route/action exists.

- [x] **Step 4: Make applet Pod capability genuinely optional**

Change WebExtensionSolidCapability.pod to optional and update createMockWebExtensionHost so its default is WebID-only. Add an explicit storage-capable mock helper or override for tests that need a Pod.

Keep session.fetch, session snapshot, host.solid.requireLogin(), WebID, and optional Pod state. Never expose login tokens, Account controls, or a Session object to applets.

Update AI Connections to branch on absence of the capability before reading status. Missing pod means this Pod-backed applet is unavailable in that host; it is not equivalent to anonymous and must not crash or fabricate a Pod.

- [x] **Step 5: Keep legacy AuthBoundary as an adapter**

Retain AuthBoundary and LoginView for source compatibility, but map their supported states into SolidAuthBoundary. Mark issuer-string/provider-list behavior as legacy in README. No new Xpod code may import them.

- [x] **Step 6: Verify package composition**

Run:

~~~bash
bun run --cwd packages/extension-sdk test
bun run --cwd packages/ai-connections test
bun run test:packages
bun run build:packages
bun test tests/ui/packaged-sdk-consumer.test.ts tests/package/applet-packages.test.mjs
~~~

Expected: all three composition profiles build from package exports and no unused auth domain is instantiated.

Commit only this task's files with an intent line such as “Make authentication capabilities composable for every extension host.”

### Task 4: Introduce the Xpod host coordinator and one current-origin login transaction

**Files:**
- Create: ui/src/auth/XpodAuthProvider.tsx
- Create: ui/src/auth/XpodLoginController.tsx
- Create: ui/src/auth/AccountAuthBoundary.tsx
- Create: ui/src/auth/xpod-login-transaction.ts
- Create: ui/src/auth/xpod-login-route.ts
- Create: ui/src/auth/useXpodAuth.ts
- Modify: ui/src/context/AuthContext.tsx
- Modify: ui/src/context/AuthContextValue.ts
- Modify: ui/src/solid/XpodSolidRuntime.ts
- Modify: ui/src/solid/XpodSolidRuntimeProvider.tsx
- Create: ui/src/auth/XpodAuthProvider.test.tsx
- Create: ui/src/auth/XpodLoginController.test.tsx
- Create: ui/src/auth/AccountAuthBoundary.test.tsx
- Create: ui/src/auth/xpod-login-transaction.test.ts
- Modify: ui/src/solid/XpodSolidRuntimeProvider.test.tsx

- [x] **Step 1: Write failing host-policy tests**

Cover:

- exactly one WebIdLoginRouteDescriptor is produced;
- identityProvider.url and storageProvider.url both resolve to window.location.origin;
- no cloud route, custom issuer, provider chooser, add-provider action, or external Pod input exists;
- every Xpod sign-in affordance calls the same startLogin function;
- startLogin creates a cryptographically opaque host transaction id, stores only public route/returnTo/storage selection data, and redirects Inrupt to /auth/callback?transaction=<id>;
- the sessionStorage-backed transaction store permits exactly one unexpired pending Xpod redirect transaction per tab, exposes readSinglePending and updateSelectedStorage only for that id, and rejects a concurrent start deterministically;
- the transaction store rejects unknown, expired, replayed, malformed, cross-origin, mismatched, and already-consumed ids;
- Inrupt's state query parameter is never read or written by Xpod transaction code;
- Dashboard Account readiness can be authenticated while WebID is anonymous;
- an authenticated WebID with an anonymous Account does not authorize Dashboard; the one-click login path application-logs out that stale WebID session before starting a fresh local transaction;
- Pod-backed readiness requires authenticated WebID plus a reconciled selected local binding;
- local Settings readiness is always true;
- Account controls 401/403 clears the local Account token, while a transient 502 produces a retryable Account error rather than permanently freezing the app.

- [x] **Step 2: Run the red Xpod auth tests**

Run:

~~~bash
bun run test --   ui/src/auth/XpodAuthProvider.test.tsx   ui/src/auth/XpodLoginController.test.tsx   ui/src/auth/AccountAuthBoundary.test.tsx   ui/src/auth/xpod-login-transaction.test.ts   ui/src/solid/XpodSolidRuntimeProvider.test.tsx
~~~

Expected: new host controller symbols are missing and current runtime still accepts arbitrary issuers/current-page callbacks.

- [x] **Step 3: Make AuthContext a reusable Account controller**

Keep CSS controls and Account network effects Xpod-local. Expose canonical AccountAuthState, isLoggedIn, retry/refetch, logout request, and the sanitized public identity needed by the shell. Do not combine it with WebIdAuthState and do not export raw Account authorization outside Xpod.

AccountAuthBoundary renders shared-ui Account states and starts the same Xpod startLogin transaction; it must not navigate directly to the password URL.

- [x] **Step 4: Implement the fixed Xpod route and single-use transaction store**

xpod-login-route.ts constructs the only route from current origin. xpod-login-transaction.ts stores a versioned, expiring, single-use record in sessionStorage under an Xpod-owned prefix. The callback URL carries only the opaque transaction id.

Xpod's redirect policy is single-active per tab:

~~~ts
export interface XpodLoginTransactionStore {
  begin(transaction: WebIdLoginTransaction): void
  readSinglePending(): WebIdLoginTransaction | undefined
  updateSelectedStorage(id: string, binding: StorageBinding): void
  consume(id: string): WebIdLoginTransaction
  cancel(id: string): void
}
~~~

begin rejects a second live transaction. readSinglePending never consumes. updateSelectedStorage requires the live id and an exact local binding. consume removes the active pointer and record atomically. Expired/malformed records are cleared before returning an error. This is Xpod host policy only; generic public consumers may choose another transaction coordinator.

Use the fixed policy:

~~~ts
const route: WebIdLoginRouteDescriptor = {
  id: 'xpod-current-origin',
  label: 'Xpod',
  identityProvider: { url: location.origin, label: location.host },
  storageProvider: { url: location.origin, label: location.host },
  availability: 'ready',
}
~~~

Do not store tokens or Inrupt internals. Permit only application-relative return paths rooted at /dashboard, /status, /network, /settings, /ai-config, or /ai-connections.

- [x] **Step 5: Compose the independent runtimes in XpodAuthProvider**

XpodAuthProvider may instantiate both domains because Xpod uses the Account-assisted profile. It exposes derived route-readiness helpers and host actions, never a merged credential. If Account is anonymous while an old WebID session is authenticated, startLogin first clears that application WebID session and its selected binding, then starts the one local transaction; it must not present a second action or treat the old WebID as Account proof.

Change XpodSolidRuntimeValue.login so Xpod callers pass a validated WebIdLoginTransaction, not an arbitrary issuer string. Use one XpodSolidRuntimeCore per browser host and preserve Inrupt single-flight restoration.

- [x] **Step 6: Verify the host coordinator**

Run:

~~~bash
bun run test --   ui/src/auth/XpodAuthProvider.test.tsx   ui/src/auth/XpodLoginController.test.tsx   ui/src/auth/AccountAuthBoundary.test.tsx   ui/src/auth/xpod-login-transaction.test.ts   ui/src/solid/XpodSolidRuntimeProvider.test.tsx
bun run --cwd ui lint
~~~

Expected: no chooser copy remains in the canonical Xpod login path, and the focused tests pass without browser storage injection of auth tokens.

Commit only this task's files with an intent line such as “Give Xpod one local login path without merging its two sessions.”

### Task 5: Serve and complete a fixed same-origin application callback

**Files:**
- Create: ui/auth-callback.html
- Create: ui/src/auth-callback.tsx
- Create: ui/src/solid/XpodOidcCallbackApp.tsx
- Create: src/api/handlers/AuthCallbackHandler.ts
- Modify: src/api/container/routes.ts
- Modify: src/runtime/Proxy.ts
- Modify: ui/vite.config.ts
- Modify: ui/package.json
- Modify: package.json
- Create: tests/api/handlers/AuthCallbackHandler.test.ts
- Create: tests/gateway/auth-surface-routing.test.ts
- Create: tests/e2e/auth-callback-protocol.spec.ts
- Modify: tests/ui/web-products-build-contract.test.ts
- Create: tests/package/web-products-package.test.mjs
- Modify: ui/src/solid/XpodSolidRuntimeProvider.test.tsx

- [x] **Step 1: Write failing routing, asset, and callback tests**

Assert:

- exact-path GET and HEAD /auth/callback retain the full OIDC query and serve the callback entry from API Server;
- /auth/callback/assets/* is also served by API Server so the isolated Vite entry can load without falling through to CSS;
- /dashboard, /status, and /network are API web-product paths;
- /settings, /ai-config, and /ai-connections are API web-product paths;
- /.account/*, OIDC authorization/token/consent paths, and representative local Pod paths still go to CSS;
- the callback route is not handled by registerStaticSpaRoutes prefix redirect behavior;
- callback build output exists and the package contains it;
- callback calls Inrupt handleIncomingRedirect with the full current URL before consuming the host transaction;
- failed Inrupt state validation does not consume the host transaction;
- success consumes the transaction once, validates the fixed current-origin route and safe returnTo, reconciles selectedStorage when present, and uses location.replace to return;
- missing/replayed transaction, missing Xpod storage selection, WebID/binding mismatch, unsafe returnTo, and Pod-open failure render deterministic public failure actions.

- [x] **Step 2: Run the red callback tests**

Run:

~~~bash
bun test   tests/api/handlers/AuthCallbackHandler.test.ts   tests/gateway/auth-surface-routing.test.ts   tests/ui/web-products-build-contract.test.ts   tests/package/web-products-package.test.mjs
bun run test -- ui/src/solid/XpodSolidRuntimeProvider.test.tsx
~~~

Expected: /auth/callback currently falls through to CSS and no callback asset exists.

- [x] **Step 3: Add a dedicated exact callback handler**

AuthCallbackHandler serves one immutable callback HTML entry for exact GET/HEAD requests, including requests with query strings, plus files below the callback's scoped assets directory. Mount it from registerHealthRoutes beside Dashboard and Settings static assets.

The API handler serves assets only. It must not exchange authorization codes, hold a client secret, create an Account session, or implement an OIDC endpoint.

- [x] **Step 4: Add the Vite callback target and Gateway routing**

Build the callback as its own static/auth-callback target with base /auth/callback/. Extend build:all and root build:ui. Route the six product paths, exact callback, and /auth/callback/assets/* to API while preserving CSS as the default. Gateway matching must parse the request pathname so /auth/callback?code=...&state=... matches without stripping or rewriting its query.

Do not introduce a new process, port, supervisor child, or service.

- [x] **Step 5: Implement callback completion in the existing host runtime**

XpodOidcCallbackApp uses the same Solid runtime/session adapter contract as Dashboard and Settings. A full-page redirect creates a new JavaScript document, so object identity cannot cross the redirect: each document creates at most one adapter, and the callback adapter restores the same logical Inrupt browser session from Inrupt-managed state. It lets Inrupt validate state, then consumes the Xpod transaction id. It requires selectedStorage for Xpod, verifies the authenticated WebID exactly, opens that selected Pod, and replaces the URL with the normalized returnTo.

Do not call discoverPodUrlFromWebId, do not construct two adapters in one document, and do not claim that one JavaScript object survives navigation.

- [x] **Step 6: Verify callback topology and build output**

Run:

~~~bash
bun test   tests/api/handlers/AuthCallbackHandler.test.ts   tests/gateway/auth-surface-routing.test.ts   tests/ui/web-products-build-contract.test.ts   tests/package/web-products-package.test.mjs
bun run build:packages
bun run build:ui
bun run build:ts
test -f static/auth-callback/auth-callback.html
~~~

Expected: callback and all web products are API assets, Account/OIDC/Pod examples remain CSS-routed, and TypeScript exits zero.

- [x] **Step 7: Prove callback query registration before later auth work**

Use the real XpodTestStack and browserSolidOidc helper to start one current-origin login. Observe the dynamic client registration/authorization traffic without injecting state. Assert the registered redirect URI contains /auth/callback?transaction=<opaque-id>, CSS accepts it, and the authorization response returns to /auth/callback with the same transaction parameter plus Inrupt-owned code/state parameters.

The test may stop at the deterministic missing-selected-storage failure because Task 6 has not yet enriched the transaction. Its purpose is to fail early if CSS or Inrupt rejects or strips a query-bearing redirect URI.

Run:

~~~bash
bunx playwright test tests/e2e/auth-callback-protocol.spec.ts --project=chromium --trace=on
~~~

Expected: the redirect URI is accepted and its host transaction parameter survives the real protocol round trip.

Commit only this task's files with an intent line such as “Keep the browser callback same-origin without creating another auth service.”

### Task 6: Make local Pod selection explicit through consent and bootstrap

**Files:**
- Create: src/identity/AccountStorageBindingsHandler.ts
- Modify: src/index.ts
- Modify: config/xpod.base.json
- Create: tests/identity/AccountStorageBindingsHandler.test.ts
- Modify: tests/identity/ScopedPickWebIdHandler.test.ts
- Create: ui/src/auth/account-storage-bindings.ts
- Create: ui/src/auth/xpod-storage-selection.ts
- Modify: ui/src/context/AuthContextValue.ts
- Modify: ui/src/pages/AccountPage.tsx
- Modify: ui/src/pages/ConsentPage.tsx
- Modify: ui/src/pages/ConsentPage.utils.ts
- Modify: ui/src/pages/FirstPodPage.tsx
- Modify: ui/src/components/FirstPodCreator.tsx
- Modify: ui/src/utils/consent-first-pod.ts
- Modify: ui/src/solid/XpodSolidRuntime.ts
- Modify: ui/src/solid/XpodSolidRuntimeProvider.tsx
- Create: ui/src/auth/account-storage-bindings.test.ts
- Create: ui/src/auth/xpod-storage-selection.test.ts
- Modify: tests/ui/consent-page.test.ts
- Modify: tests/ui/consent-first-pod.test.ts
- Modify: ui/src/solid/XpodSolidRuntimeProvider.test.tsx

- [x] **Step 1: Write failing binding and selection tests**

Use deterministic CSS Account control responses for:

- one Account with two Pods and three WebIDs;
- CSS Account controls advertise one bindings route whose response contains exact webId/storageUrl pairs from PodStore.findPods plus PodStore.getOwners;
- the existing scoped pick-WebID response entries are consumed as exact pairs during consent rather than rebuilding pairs from separate arrays;
- exact StorageBinding rows preserving storageUrl and webId together;
- one eligible binding auto-selected;
- multiple eligible bindings restore the last still-valid choice;
- stale remembered choice moves to selecting, never the first array item;
- no binding moves to empty and enables first-storage creation;
- duplicate/incompatible pairings move to conflict;
- forbidden or failed enumeration moves to error;
- consent cannot approve before selection is ready;
- first-storage creation waits for the new WebID/storage binding before approval;
- consent reads the one live per-tab transaction through readSinglePending and, when present, updates only that id; no pending Xpod record leaves a direct third-party CSS consent flow unchanged, while a later Xpod callback without its required record fails deterministically;
- callback opens exactly the selected storage and never storageUrls[0].

- [x] **Step 2: Run the red storage tests**

Run:

~~~bash
bun run test --   ui/src/auth/account-storage-bindings.test.ts   ui/src/auth/xpod-storage-selection.test.ts   tests/ui/consent-page.test.ts   tests/ui/consent-first-pod.test.ts   ui/src/solid/XpodSolidRuntimeProvider.test.tsx
bun test tests/identity/AccountStorageBindingsHandler.test.ts tests/identity/ScopedPickWebIdHandler.test.ts
~~~

Expected: current consent/runtime assertions reveal ids[0] and storageUrls[0] fallback behavior.

- [x] **Step 3: Expose exact Account bindings through CSS controls**

Add an authorized RelativePathInteractionRoute with relativePath bindings/ under the existing AccountIdRoute and advertise it as controls.account.bindings. The concrete account id remains route-derived by CSS. AccountStorageBindingsHandler uses the injected CSS PodStore: for each Pod returned by findPods(accountId), pair its baseUrl with each owner returned by getOwners(pod.id). Filter to the configured current Xpod storage root and return deduplicated StorageBinding rows. Preserve the existing account pod/webId controls.

Wire the component in config/xpod.base.json and export it from src/index.ts; regenerate component metadata through the normal build. The handler must reject an absent Account session and must not accept an account id from request JSON/query input.

For consent, consume the existing ScopedPickWebIdHandler response entries, which already preserve webId plus storageUrl. Keep the legacy webIds array only for compatibility; canonical selection uses entries.

- [x] **Step 4: Consume exact bindings in Xpod**

account-storage-bindings.ts calls controls.account.bindings with stored Account headers, validates same-origin URLs, and returns the exact public pairs. It must not reconstruct associations by taking independent account.webId/account.pod lists or by assuming every Account WebID owns every Pod.

Do not split the binding into unrelated webIds and pods arrays for selection. AccountPage may derive display lists, but the authoritative selection remains the pair. Profile storage discovery is not a canonical fallback; an unavailable exact-binding control enters error.

- [x] **Step 5: Bind consent to the single active host transaction**

Because Xpod supports one full-page redirect login per tab, ConsentPage calls readSinglePending after loading Account/OIDC state. It never consumes the record. On approve, after an exact StorageBinding reaches ready and before navigating to the CSS consent redirect, it calls updateSelectedStorage with that pending id. Direct CSS Account/consent flows belonging to another client and having no Xpod pending transaction continue as identity-provider flows, but they do not claim Xpod callback readiness.

A second live Xpod transaction is rejected at begin, so ConsentPage never guesses among records. Cancel/deny clears only the matching pending record after CSS returns a deterministic cancellation location. Callback consume still requires the id present in its URL to equal the active record.

- [x] **Step 6: Implement deterministic selection and remembered state**

Persist only the last selected public binding key for the Account domain. Revalidate it against fresh Account enumeration before reuse. Never fallback to candidates[0] when several candidates exist.

The consent view limits WebID choices to the selected local binding. Storage bootstrap creates local storage through existing controller helpers, polls for the binding, then records selectedStorage in the matching host transaction.

- [x] **Step 7: Remove implicit Pod discovery from Xpod runtime**

Delete discoverPodUrlFromWebId or restrict it to legacy tests with no canonical caller. The canonical Xpod path opens runtime.pod with the transaction's reconciled selectedStorage.storageUrl. A WebID-only public host remains valid without storage.

- [x] **Step 8: Verify all multi-Pod branches**

Run:

~~~bash
bun run test --   ui/src/auth/account-storage-bindings.test.ts   ui/src/auth/xpod-storage-selection.test.ts   tests/ui/consent-page.test.ts   tests/ui/consent-first-pod.test.ts   ui/src/solid/XpodSolidRuntimeProvider.test.tsx
bun test tests/identity/AccountStorageBindingsHandler.test.ts tests/identity/ScopedPickWebIdHandler.test.ts
bun run build:components
bun run --cwd ui lint
~~~

Expected: focused tests pass and a repository search finds no canonical storageUrls[0] or ids[0] selection in Xpod auth/consent code.

Commit only this task's files with an intent line such as “Preserve the user's chosen Pod instead of guessing the first binding.”

### Task 7: Migrate the CSS identity SPA to public views

**Files:**
- Modify: ui/src/App.tsx
- Modify: ui/src/pages/LoginSelectPage.tsx
- Modify: ui/src/pages/WelcomePage.tsx
- Modify: ui/src/pages/ForgotPasswordPage.tsx
- Modify: ui/src/pages/ResetPasswordPage.tsx
- Modify: ui/src/pages/ConsentPage.tsx
- Modify: ui/src/pages/FirstPodPage.tsx
- Modify: ui/src/components/LoadingScreen.tsx
- Modify: ui/src/components/ErrorScreen.tsx
- Modify: ui/src/components/CardWrapper.tsx
- Modify: ui/src/components/ProtectedRoute.tsx
- Modify: ui/src/auth-legacy-helpers.test.ts
- Modify: tests/ui/account-session.test.ts
- Modify: tests/ui/registration-flow.test.ts
- Modify: tests/ui/consent-page.test.ts
- Modify: tests/ui/consent-first-pod.test.ts
- Create: ui/src/pages/AuthPages.test.tsx

- [x] **Step 1: Write failing page-controller tests**

For every identity route, assert the page renders the canonical shared-ui component and keeps Xpod-only side effects in the controller:

- /.account/login/ renders advertised Account methods or immediately follows the sole method; it never renders Cloud/local/external provider choices;
- password login and registration preserve duplicate-email recovery, username debounce, suggestions, Pod provisioning, safe errors, and pending guards;
- forgot/reset preserve token and success behavior;
- consent preserves CSS client validation, WebID/storage selection, remember-client, approve, deny, and actual-pending-only cancellation;
- first Pod preserves provisioning and readiness polling;
- ProtectedRoute remains an Account-domain guard for direct CSS identity-provider routes, follows the advertised Account login control, and renders no product/provider chooser; it does not create an app-side WebID session;
- no route has private auth-card geometry or duplicate hard-coded visual tokens.

- [x] **Step 2: Run the red page tests**

Run:

~~~bash
bun run test --   ui/src/pages/AuthPages.test.tsx   ui/src/auth-legacy-helpers.test.ts   tests/ui/account-session.test.ts   tests/ui/registration-flow.test.ts   tests/ui/consent-page.test.ts   tests/ui/consent-first-pod.test.ts
~~~

Expected: current pages still own private form/card JSX and LoginSelectPage enumerates provider-like choices.

- [x] **Step 3: Convert pages into thin controllers**

Use AuthSurface plus AccountCredentialsView, AccountLoginMethodListView, PasswordRecoveryView, PasswordResetView, OidcConsentView, StorageBootstrapView, and public restoring/failure views.

Keep registration-flow, provisioning, Account controls, stored Account token handling, and CSS consent submission in Xpod. Map server codes to safe field/form messages before passing props.

- [x] **Step 4: Remove superseded private auth markup**

Delete CardWrapper and bespoke form/card markup only after all routes render canonical views and tests pass. If LoadingScreen or ErrorScreen remains for non-auth pages, make it a public-view wrapper rather than duplicating geometry.

Do not modify CSS Account/OIDC route ownership in config/xpod.base.json, config/local.json, or config/xpod.json.

- [x] **Step 5: Verify the identity SPA**

Run:

~~~bash
bun run test --   ui/src/pages/AuthPages.test.tsx   ui/src/auth-legacy-helpers.test.ts   tests/ui/account-session.test.ts   tests/ui/registration-flow.test.ts   tests/ui/consent-page.test.ts   tests/ui/consent-first-pod.test.ts
bun run --cwd ui build:app
bun run --cwd ui lint
~~~

Expected: behavior tests pass, the app bundle builds, and canonical identity pages contain no host-specific auth card implementation.

Commit only this task's files with an intent line such as “Share one authentication presentation across CSS identity routes.”

### Task 8: Apply Account, anonymous-local, and WebID route policies

**Files:**
- Modify: src/api/handlers/DashboardHandler.ts
- Modify: src/api/handlers/SettingsHandler.ts
- Modify: tests/api/handlers/DashboardHandler.test.ts
- Modify: tests/api/handlers/SettingsHandler.test.ts
- Modify: ui/src/DashboardApp.tsx
- Modify: ui/src/SettingsApp.tsx
- Modify: ui/src/dashboard-routes.tsx
- Modify: ui/src/settings-routes.tsx
- Modify: ui/src/solid/SettingsAuthBoundary.tsx
- Modify: ui/src/pages/settings/NetworkPage.tsx
- Modify: ui/src/api/network-settings.ts
- Modify: ui/src/pages/settings/ServicesPage.tsx
- Modify: ui/src/pages/settings/PodPage.tsx
- Create: ui/src/pages/dashboard/UsagePage.tsx
- Modify: ui/src/layout/settings-navigation.ts
- Modify: ui/src/DashboardApp.test.tsx
- Modify: ui/src/settings-routes.test.tsx
- Modify: ui/src/pages/settings/NetworkPage.test.tsx
- Modify: ui/src/pages/settings/ServicesPage.test.tsx
- Modify: ui/src/pages/settings/PodPage.test.tsx
- Modify: tests/ui/dashboard-pages-contract.test.ts
- Modify: tests/ui/settings-launch.test.ts

- [x] **Step 1: Write failing authorization-matrix tests**

Lock this matrix:

| Surface | Anonymous | Required authority |
| --- | --- | --- |
| Dashboard overview/runtime/logs/rdf/network/usage | Sign-in surface | Account session |
| Settings services/network and local Xpod configuration | Render | None |
| Settings models/Pod, AI Config, AI Connections | Sign-in surface | WebID session plus selected local binding |

Also assert:

- authenticated Account plus anonymous WebID renders Dashboard;
- authenticated WebID plus anonymous Account does not authorize Dashboard;
- local Settings renders even if Account control discovery or Solid restoration fails;
- Pod-backed routes use SolidAuthBoundary with exactly the current-origin route;
- NetworkPage calls current-origin API with ordinary credentials policy and never constructs URLs from runtime.podUrl;
- Dashboard usage obtains Account-level data rather than opening a Pod through Inrupt.
- product aliases use explicit API redirects: /status to /dashboard/overview, /network to /dashboard/network, /ai-config to /settings/models?surface=ai-config, and /ai-connections to /settings/models?surface=ai-connections; existing safe query parameters are preserved after the required surface parameter.

- [x] **Step 2: Run the red route tests**

Run:

~~~bash
bun run test --   ui/src/DashboardApp.test.tsx   ui/src/settings-routes.test.tsx   ui/src/pages/settings/NetworkPage.test.tsx   ui/src/pages/settings/ServicesPage.test.tsx   ui/src/pages/settings/PodPage.test.tsx   tests/ui/dashboard-pages-contract.test.ts   tests/ui/settings-launch.test.ts
bun test tests/api/handlers/DashboardHandler.test.ts tests/api/handlers/SettingsHandler.test.ts
~~~

Expected: Dashboard currently renders the Solid chooser and every Settings route is currently guarded.

- [x] **Step 3: Mount the composed host without coupling route readiness**

Wrap Dashboard and Settings with XpodAuthProvider. Dashboard routes use AccountAuthBoundary. Settings local routes render directly; only Pod-backed routes use the canonical SolidAuthBoundary adapter.

SettingsAuthBoundary becomes a thin Xpod mapping layer with one route and no Cloud/local/provider/add-provider props. Rename it to WebIdAuthBoundary if that improves clarity, retaining a compatibility export only while consumers migrate.

- [x] **Step 4: Decouple local operations from Pod auth**

network-settings.ts uses same-origin /api/network/settings/* URLs and the local API authorization policy, not runtime.podUrl. Services already uses local API endpoints and must remain anonymous-readable where handlers allow it.

Replace Dashboard's PodPage usage branch with UsagePage backed by Account/API data. Keep the Settings Pod page WebID-bound.

- [x] **Step 5: Align top-level product aliases**

Register public GET/HEAD 302 aliases in DashboardHandler and SettingsHandler:

| Entry alias | Canonical route |
| --- | --- |
| /status | /dashboard/overview |
| /network | /dashboard/network |
| /ai-config | /settings/models?surface=ai-config |
| /ai-connections | /settings/models?surface=ai-connections |

Merge existing safe query parameters into the canonical target and never copy a fragment or absolute target. This keeps the existing BrowserRouter basenames valid and avoids an API-served blank page. The surface parameter preserves the two AI entry intents without making this authentication plan own their independent content work.

Use one exported alias/return-path normalization helper so API handler tests, client navigation, and callback returnTo validation agree. Gateway routing for these aliases was added in Task 5; Account/OIDC/Pod paths remain CSS defaults.

- [x] **Step 6: Verify the route matrix**

Run:

~~~bash
bun run test --   ui/src/DashboardApp.test.tsx   ui/src/settings-routes.test.tsx   ui/src/pages/settings/NetworkPage.test.tsx   ui/src/pages/settings/ServicesPage.test.tsx   ui/src/pages/settings/PodPage.test.tsx   tests/ui/dashboard-pages-contract.test.ts   tests/ui/settings-launch.test.ts
bun test tests/api/handlers/DashboardHandler.test.ts tests/api/handlers/SettingsHandler.test.ts
bun run --cwd ui build:dashboard
bun run --cwd ui build:settings
bun run --cwd ui lint
~~~

Expected: every matrix row is covered and both bundles build.

Commit only this task's files with an intent line such as “Authorize each product surface with the session that owns its data.”

### Task 9: Put the identity card at top-left and coordinate two-domain logout

**Files:**
- Create: ui/src/auth/xpod-logout.ts
- Create: ui/src/layout/XpodUserCard.tsx
- Modify: ui/src/App.tsx
- Modify: ui/src/auth/XpodAuthProvider.tsx
- Modify: ui/src/layout/XpodProductLayout.tsx
- Modify: ui/src/layout/XpodDashboardLayout.tsx
- Modify: ui/src/layout/XpodSettingsLayout.tsx
- Modify: ui/src/pages/AccountPage.tsx
- Modify: ui/src/pages/ConsentPage.tsx
- Modify: ui/src/solid/XpodSolidRuntime.ts
- Modify: ui/src/solid/XpodSolidRuntimeProvider.tsx
- Create: ui/src/auth/xpod-logout.test.ts
- Create: ui/src/layout/XpodUserCard.test.tsx
- Modify: ui/src/layout/XpodProductLayout.test.tsx
- Modify: ui/src/layout/XpodSettingsLayout.test.tsx

- [x] **Step 1: Write failing shell and logout tests**

Assert:

- one Avatar/UserCard button is the first top-left rail control;
- the purple X tile and bottom duplicate person icon do not exist;
- anonymous Avatar starts the same Xpod login controller;
- authenticated card shows public Account identity and selected Pod/WebID status without exposing secrets;
- one visible logout action starts both independent steps;
- WebID logout and Account logout record pending, complete, or error separately;
- each step is idempotent and retry reruns only unfinished/error domains;
- success is reported only after Solid snapshot is anonymous and refreshed CSS controls no longer advertise account.logout;
- WebID success clears remembered WebID/selected Pod state; Account success clears Account token/identity state;
- partial failure hides authenticated actions, shows deterministic retry, and persists no token/secret retry metadata;
- switch Account completes the same logout transaction before starting the one local login path.
- the CSS identity SPA can invoke the same host logout coordinator for consent-time Account switching without constructing a second Solid session.

Use a host-only state machine:

~~~ts
export type LogoutDomainState = 'pending' | 'complete' | 'error'

export type XpodLogoutState =
  | { status: 'idle' }
  | {
      status: 'running' | 'error'
      account: LogoutDomainState
      webId: LogoutDomainState
    }
  | {
      status: 'complete'
      account: 'complete'
      webId: 'complete'
    }
~~~

- [x] **Step 2: Run the red shell/logout tests**

Run:

~~~bash
bun run test --   ui/src/auth/xpod-logout.test.ts   ui/src/layout/XpodUserCard.test.tsx   ui/src/layout/XpodProductLayout.test.tsx   ui/src/layout/XpodSettingsLayout.test.tsx
~~~

Expected: no XpodUserCard exists and Account/WebID logout are currently separate.

- [x] **Step 3: Implement independent idempotent logout steps**

The WebID step performs application logout on the existing Inrupt runtime and verifies an anonymous snapshot. The Account step POSTs the CSS logout control with existing stored Account headers, refetches controls, then clears Account state only after anonymous verification.

Retain per-domain public completion/error evidence only. Do not persist bearer tokens, DPoP material, refresh tokens, CSS controls, or raw exception bodies.

- [x] **Step 4: Integrate one top-left user card**

XpodProductLayout renders XpodUserCard at the top-left. The card owns Dashboard/Settings switching, login, selected identity/storage summary, logout, partial-failure retry, and switch Account. Navigation icons remain below it.

Wrap the CSS identity SPA with the same Xpod host coordinator so ConsentPage can switch accounts through the coordinated transaction. The coordinator may restore the one logical browser Solid session, but Account-only route readiness must not depend on that restoration.

Use the shared Avatar, Button, menu/dialog primitives, and unified corner radius tokens. Ensure keyboard and screen-reader behavior.

- [x] **Step 5: Route all old logout/switch actions through the coordinator**

AccountPage, ConsentPage switch-account, Pod settings, and shell logout call the host transaction. Remove direct one-domain product logout buttons where they would create a second visible path. Public single-domain package consumers keep their own domain logout methods.

- [x] **Step 6: Verify shell lifecycle**

Run:

~~~bash
bun run test --   ui/src/auth/xpod-logout.test.ts   ui/src/layout/XpodUserCard.test.tsx   ui/src/layout/XpodProductLayout.test.tsx   ui/src/layout/XpodSettingsLayout.test.tsx
bun run --cwd ui lint
bun run build:ui
~~~

Expected: one top-left identity entry is present in both products and every logout branch is deterministic.

Commit only this task's files with an intent line such as “Make one identity control own Xpod's complete session lifecycle.”

### Task 10: Prove package, browser, and three-service acceptance

**Files:**
- Create: tests/e2e/shared-login.spec.ts
- Modify: tests/helpers/browserSolidOidc.ts
- Modify: tests/helpers/xpodSettingsFixtureServer.ts
- Create: docs/xpod-authentication.md
- Modify: packages/extension-sdk/README.md

**Note:** Modify playwright.config.ts only if the existing webServer/project cannot run the new spec; otherwise leave it untouched. Modify the approved design spec only when implementation evidence disproves a factual statement; do not rewrite product decisions during execution.

- [x] **Step 1: Add real-browser single-login scenarios**

Use one BrowserContext per scenario and the existing XpodTestStack/completeOidcLogin harness. Do not inject access tokens, Account tokens, Inrupt storage, selected Pod state, or callback state.

Cover:

1. Dashboard-first: enter credentials once, complete consent/callback, Dashboard renders, then Pod-backed Settings opens without another password prompt.
2. Settings-first: enter credentials once, complete consent/callback, selected Pod opens, then Dashboard sees the existing Account session.
3. Existing Account with one Pod auto-selects that binding.
4. Existing Account with multiple Pods restores a valid remembered binding or displays an explicit chooser; stale selection never chooses the first response implicitly.
5. New Account creates first storage and waits for its binding before consent.
6. Dashboard requires Account only, local Settings is anonymous, Pod-backed Settings requires WebID plus selected binding.
7. Every login passes through exact /auth/callback and returns to the original safe route.
8. consent denial, cancel/dismiss, lost transaction, invalid OIDC state, unsafe returnTo, storage conflict, and expired WebID have deterministic recovery.
9. one logout leaves both domains anonymous; injected failure in either logout step produces a retry that completes only the failed domain.
10. no Cloud/local chooser, custom issuer, external WebID, external Pod, second user icon, or second login/logout path is visible.

- [x] **Step 2: Run focused browser acceptance**

Run:

~~~bash
bun run build:packages
bun run build:ui
bunx playwright test tests/e2e/shared-login.spec.ts   --project=chromium   --trace=on
~~~

Expected: all scenarios pass against the real local Account/OIDC/PKCE/code/token flow.

- [x] **Step 3: Document runtime ownership and public composition**

docs/xpod-authentication.md must include:

- the Account-only, WebID-only, and Account-assisted profiles;
- Dashboard/Settings authorization matrix;
- the one current-origin Xpod flow;
- the fixed callback and host transaction id versus Inrupt-owned OIDC state;
- the three-service routing table;
- explicit Pod binding and multi-Pod behavior;
- unified Xpod logout versus public single-domain logout;
- Electron/Linx as an external host contract not built or claimed by this repository.

Do not duplicate schema/modeling rules or secrets.

- [x] **Step 4: Run the full release gate**

Run sequentially from the worktree root:

~~~bash
git diff --check
bun run test:packages
bun run build:packages
bun run --cwd ui lint
bun run build:ui
bun run build:ts
bun run typecheck:test
bun run test
bun run test:integration
bunx playwright test tests/e2e/shared-login.spec.ts --project=chromium
~~~

Expected: every command exits zero. Existing deprecation warnings may be recorded, but there must be no known auth, routing, build, type, or browser acceptance failure.

- [x] **Step 5: Perform final source and security audits**

Run:

~~~bash
rg -n "storageUrls\[0\]|ids\[0\]|id\.undefineds\.co|onAddProvider|LoginSpaceSelectionView" ui/src packages/extension-sdk/src
rg -n "accountToken|cssControls|clientSecret|refreshToken|accessToken|DPoP" packages/shared-ui/src packages/extension-sdk/src/react/solid-auth-boundary.tsx packages/extension-sdk/src/testing.ts
~~~

Review each hit. Expected:

- no canonical Xpod auth/consent path implicitly selects the first storage/WebID or exposes Cloud/external-provider UI;
- no shared-ui or new SolidAuthBoundary/testing contract exposes tokens, secrets, or CSS Account controls; existing AI-provider credential payload types are a separate capability and are not treated as login-session credentials;
- any retained legacy compatibility hit is documented and unused by Xpod.

- [x] **Step 6: Request independent code review before integration**

The reviewer must verify spec coverage, package dependency direction, no fourth service, callback query preservation, Inrupt state ownership, Account/WebID separation, explicit multi-Pod selection, route matrix, partial logout retry, accessibility, and browser evidence.

Commit the final tests/docs with an intent line such as “Prove one Xpod login path across both independent session domains,” then follow the repository's finishing-a-development-branch workflow.

## Completion criteria

The plan is complete only when all twelve acceptance criteria in the design spec have direct automated evidence, the full integration suite and real browser spec pass, and no unresolved action, placeholder callback, visible no-op, implicit first-Pod fallback, or mixed-session success state remains.

The Xpod repository proves the browser and packaged static assets. It does not claim Electron packaging or Linx migration; those remain external/later work by design.
