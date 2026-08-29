# Shared Account and WebID Login Design

> **Status (2026-08-30): SUPERSEDED — 已废弃。** 路由级认证边界以
> [`2026-08-30-xpod-auth-authority-boundaries.md`](2026-08-30-xpod-auth-authority-boundaries.md) 为唯一权威：
> 不再有 shell 级全局登录门，Account/WebID 由各服务路由的 boundary 自行要求；
> Account 状态与视图归 Xpod 产品代码，`shared-ui` 只保留视觉原语，WebID 契约归
> solid-sdk/extension-sdk。本文档仅保留作历史参考，任何与边界文档冲突的条款一律无效。

> **Void (2026-08-22):** The 2026-08-12 desktop note that required one global
> LinX-style login gate, a blank-document startup card, and "the product card
> never collects Account email or password" is withdrawn. Route-level Account
> and WebID boundaries, Xpod-owned Account forms, and desktop hide-on-close
> vs Quit follow
> [`2026-08-30-xpod-auth-authority-boundaries.md`](2026-08-30-xpod-auth-authority-boundaries.md).

## Goal

Extract the already-shipped LinX login experience into the public Xpod
packages, then make both products consume that one implementation. LinX is the
behavioral and visual source of truth for the four-state login machine,
remembered-account card, restoring/connecting scenes, provider capability
switches, and recovery semantics. Xpod adapts its Account + WebID + exact Pod
facts to that implementation; it must not re-create the phase machine or
branching login JSX in `ui/src/auth`.

This is a source migration, not a visual reimplementation. The canonical
source is LinX commit `bc7fa6d0a032b9502d814ad78e5d1fc54b1318ca`.
Migrated view/store code may be parameterized only where product data genuinely
differs: brand, explicitly optional provider affordances, persistence keys,
Pod reconciliation, and desktop host geometry. A host adapter may translate
facts and invoke protocol operations, but must not be described as migrated
LinX code unless it is traceable to an actual LinX source file.

The design distinguishes two authentication domains:

1. **Account login** authenticates a person to an account-capable identity provider so they can register, manage the account, create storage, and approve authorization requests. Xpod uses CSS for this domain.
2. **WebID login** is the application-side Solid OIDC flow that gives an application an Inrupt-managed Solid session for one selected WebID.

They share product styling and composable views. They do not share a session object, token, state union, or network controller.

The reusable package contracts remain data-driven, but Xpod applies a stricter local product policy in this phase: it exposes one login path bound to the current same-origin Xpod and does not expose an identity-provider chooser, custom issuer, external WebID, or external Pod.

## Xpod protocol flow

```text
User opens any Xpod desktop product surface while not fully authenticated
  -> Xpod renders one compact shared WebID login dialog on a blank themed document, with no product shell mounted
  -> the user invokes the host's single current-origin WebID/OIDC route
  -> CSS establishes or restores its internal Account session as part of the IdP interaction
  -> CSS may reuse the existing Account session
  -> CSS limits WebID/Pod selection to exact local Account bindings
  -> one exact binding is persisted and consented automatically
  -> multiple bindings stay in the same login flow and require an explicit choice
  -> the application callback restores one host-owned Inrupt Solid session
  -> only then does Xpod mount rail, list and content
```

This is one user-visible login path that can establish or restore two independent sessions. The Account session is issued and owned by CSS; Dashboard consumes its state and CSS account controls. The Solid session is owned by the application host, managed through Inrupt, and consumed by Pod-backed Settings and applets. Neither session is converted into the other, and each product surface authorizes only through the session required by that surface. Account tokens, bearer tokens, DPoP material, and refresh tokens are never exposed through the applet SDK.

If the Account session already exists when any protected surface starts the login path, CSS reuses it and must not ask for the password again. Otherwise the CSS identity-provider step establishes the Account session before the OIDC flow returns. Direct Account, password-recovery, and registration URLs are identity-provider implementation routes, not additional Xpod product login choices and are never embedded in the product gate.

Dashboard and Settings use the same host login gate. This does not merge the
sessions or their authorization semantics: Dashboard data still authorizes
through the Account session and Pod data still authorizes through the Inrupt
WebID session. “One login” is a product orchestration and presentation rule,
not a conversion of an Account token into a Solid session.

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

The four UI build targets (`app`, `dashboard`, `settings`, and `authCallback`) share the same canonical authentication, theme, account-card, product-gate, and callback implementations. A target may choose a different root route or asset graph, but it must not fork login-card JSX, auth-gate behavior, avatar account-card behavior, theme bootstrap, or callback session restoration. Acceptance builds and tests must rebuild all four targets together so a callback document cannot resume into stale product UI.

Product surfaces use the sessions as follows:

| Surface | Authorization requirement | Data authority |
| --- | --- | --- |
| Dashboard | Product gate ready; Dashboard requests use Account authority | CSS Account API for the account's local Pods; API Server for local service status and operations |
| Local Xpod Settings | Product gate ready; local requests use host authority | Local API Server configuration endpoints |
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

This boundary is typed rather than storage-specific. Shared views own the shape and behavior of a remembered identity card, such as `displayName`, optional `avatarUrl`, `bindingLabel`, pending/error state, and user actions. A host maps its own account/profile data into that contract. Session-aware public controllers may depend on host-supplied `restore`, `signIn`, and `signOut` adapters, but neither the views nor those controller contracts know whether the implementation uses a CSS database, a Solid Pod, browser storage, Keychain, or memory. Xpod supplies an adapter that composes Account and WebID sessions; a single-session product can supply only its one adapter without adopting Xpod's persistence model.

The public surface includes:

- `AuthSurface`, with `page`, `modal`, and `embedded` presentation modes using one card geometry and token set;
- `AccountCredentialsView`, supporting password login and registration;
- `AccountLoginMethodListView`, rendering the login methods advertised by the identity provider;
- `PasswordRecoveryView` and `PasswordResetView`;
- `WebIdLoginRouteView`, rendering one controlled host-supplied route without hard-coded local/cloud branches; hosts may compose zero, one, or many route views and may separately supply an add-route action, while Xpod supplies exactly one current-origin route and no chooser or add-route action;
- existing restoring, connecting, remembered-login, failure, optional storage-conflict, and error views;
- `OidcConsentView`, rendering client identity, WebID selection, remember-client, approve, and deny actions, plus optional host-supplied edit-account or switch-account actions when the host composes the Account capability;
- `StorageBootstrapView`, rendering first-storage creation and readiness states.

Provider choice is a host capability, not an unavoidable part of the shared
card. A host may supply zero, one, or many provider routes and may expose an
add-provider action. Xpod supplies exactly one same-origin route and sets the
provider chooser, add-provider action, editable issuer, external WebID, and
external Pod capabilities to unavailable. Hiding these controls in Xpod must
not remove them from the public package or prevent another consumer from using
them.

### Compact login visual contract

Xpod's compact presentation follows the accepted LinX login card rather than
inventing a second product style:

- in a browser document, the overlay uses a `black/50` scrim and contains
  exactly one `280 × 400` warm card;
- in the Electron product, the native BrowserWindow content viewport itself is
  `280 × 400`; `AuthSurface host="window"` fills it directly and draws no
  scrim, outer padding, nested border, nested corner radius, or card shadow;
- both hosts use one focus treatment and clipped overflow and must not show an
  inner scrollbar at the supported compact size;
- the product mark appears only for a genuinely first-time anonymous login;
- when a non-secret identity has been remembered, the lead content is the
  user's avatar, display name, and Xpod binding label, followed by one primary
  continue or re-authenticate action and one weak switch-account action;
- re-authentication keeps that remembered user lead above the credentials
  fields instead of replacing it with the Xpod mark;
- avatar rendering prefers the supplied avatar URL, then the user's initial,
  and uses the LinX app-tile shape (`18%` corner radius), not a circular SaaS
  avatar.

Shared views receive this identity and capability data through props. They do
not know where the host persists the identity or sessions. Xpod maps its
composed Account + WebID + Pod record into those props; a single-session host
may map only its own identity and session.

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

### LinX source migration

The existing LinX implementation is split by responsibility rather than
reimplemented:

- the four phases and remembered-account store contract are migrated from
  `packages/stores/src/login.ts` into a public, host-configurable login machine;
- the branch ordering and shared visual states are migrated from
  `LoginModal.tsx` and `LoginCardShell.tsx` into `@undefineds.co/shared-ui`;
- transaction, error normalization, restore, and storage-reconciliation logic
  that is independent of LinX routes moves into `@undefineds.co/solid-sdk`;
- LinX local onboarding, tunnel repair, Electron authorization-sheet plumbing,
  provider discovery, and app routing remain LinX adapters;
- Xpod Account/WebID/Pod composition, CSS Account controls, callback routing,
  and tray/runtime ownership remain Xpod adapters.

After extraction, LinX and Xpod import the same public state machine and shared
login surface. Keeping a private copy in either product is a release blocker.

The canonical source-to-package mapping is explicit:

| LinX source | Public target | Allowed changes |
| --- | --- | --- |
| `packages/stores/src/login.ts` | `packages/solid-sdk/src/login-store.ts` | Host-configurable storage/key factory only; state, actions, migrate and partialize remain LinX-owned. |
| `apps/web/src/modules/login/LoginModal.tsx` | `packages/shared-ui/src/login/LoginModal.tsx` | Import paths, brand slot, explicitly optional provider affordances, and host callbacks only; branch order, default DOM, copy and classes remain source-owned. |
| `LoginCardShell.tsx` | `packages/shared-ui/src/login/LoginCardShell.tsx` | Electron window-host class seams only. |
| `types.ts`, `provider-model.ts`, `presentation.ts`, `LocalReachabilitySummary.tsx` | matching files under `packages/shared-ui/src/login/` | Import-path and public host-type adjustments only. |
| `apps/web/src/lib/user-facing-errors.ts` and login re-export | `packages/shared-ui/src/user-facing-errors.ts` and `login/error-messages.ts` | Exact source copy plus import-path adjustment; product-neutralization is a separate future change, not part of source migration. |
| `apps/web/src/modules/login/controller.tsx` | remains a LinX host controller | It is not copied into the public SDK because it directly depends on LinX router, Inrupt hooks, Electron authorization, provider discovery, local onboarding and micro-app routing. |

Xpod production code imports the migrated `LoginModal` through a thin private
presentation adapter and uses the migrated `createLoginStore` directly. Its
branding/capability adapter and Account + WebID + exact-Pod phase/protocol
adapter both remain under `ui/src/auth`; neither may be exported from a public
package or named as a migrated LinX controller.
`LoginFlow` is a deprecated shape-conversion wrapper for existing consumers; it
must contain no branch tree, reducer, or protocol behavior. The Xpod gate must
not define its own `LoginState` reduction or set the store phase directly.

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

interface RememberedXpodHostLogin {
  account: {
    email: string
    id?: string
    displayName?: string
    username?: string
  }
  webId: string
  storageBinding: StorageBinding
  routeId: 'xpod-current-origin'
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

`WebIdAuthState` deliberately describes only the WebID session. `storageProvider`, `selectedStorage`, and `StorageSelectionState` are optional, separate capabilities for hosts that select or reconcile storage. A WebID-only identity consumer is not forced to declare a Pod or create storage state, and an Account-only consumer does not instantiate `SolidSessionRuntime` at all. `RememberedXpodHostLogin` is Xpod-specific host state, not a shared WebID model: it records the non-secret Account display identity plus exact WebID/Pod binding that the host already reconciled.

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
- The Xpod product gate identifies that action as WebID login and never renders Account credential fields. A CSS Account password page may appear only after the OIDC redirect, as an internal identity-provider verification step.
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

- Before the product shell mounts, every protected product surface is gated by the same Xpod local login controller and global login page/scene. There is no separate Account-login button and WebID-login button.
- The Xpod host login is one product session composed from two independently restorable auth domains: the CSS Account session and the Inrupt WebID session, plus one exact local Pod binding. The public shared-ui state remains usable by Account-only or WebID-only products; it does not assume this Xpod composition.
- All protected Xpod desktop routes wait for the full host composition before mounting, even though their requests continue to use different authorities. This prevents an Account-only Status shell from appearing before the WebID/Pod session finishes.
- Xpod remembers only a non-secret host identity record: sanitized Account identity and email, exact WebID, exact selected Pod binding, and the fixed current-origin route id. Account cookies, Inrupt session material, tokens, passwords, and client secrets are never copied into that record.
- The host enters `restoring` while it checks both auth domains. It reaches `authenticated` only after the Account, WebID, and selected Pod match the remembered composition. A mismatch never overwrites the remembered record and never mounts the product shell; it enters one deterministic switch-account recovery state that clears both auth domains.
- Xpod's product gate uses the compact modal presentation for confirmed-anonymous and authentication-failure states, but mounts it on a blank themed document rather than over the workspace. While Account, WebID, or Pod state is only restoring, it renders a blank themed pending scene with no credential card. Rail, list, content and the avatar card remain unmounted throughout startup, so route changes cannot flash a login dialog over an already-mounted shell.
- After authentication, the top-left Avatar opens the consumer account card only; it does not expose a second login form.
- The Xpod desktop product gate mounts routes only when Account, WebID and the selected exact local Pod binding are all ready. After mounting, Dashboard requests use Account authority, local Settings requests use host authority, and Pod-backed Settings requests use WebID authority.
- An existing Account session skips password entry when the same login path is invoked for Pod-backed Settings. An existing WebID session does not replace the Account session required by Dashboard.
- One visible logout action starts one host-owned logout transaction that records per-domain `pending`, `complete`, or `error` outcomes. It clears the Inrupt session and requests CSS Account logout through independent idempotent steps, then verifies both auth domains are anonymous before reporting success.
- Remembered identity and Pod-selection state is removed after the corresponding domain is verified anonymous. A partial failure retains only the opaque completion/error evidence needed to retry the unfinished step; it never persists tokens or secrets as retry metadata.
- A partial logout failure enters a deterministic logout-error state with an idempotent retry. The UI hides authenticated actions while the transaction is unresolved and must not claim success or present a mixed identity after clearing only one domain.
- Switching Account uses the same unified logout transaction before starting the one local login path again.

These rules apply to the Xpod host composition only. Account-only consumers may expose only Account logout, and WebID-only consumers may expose only Solid-session logout; public packages do not synthesize a combined logout transaction.

## Xpod desktop login lifecycle acceptance matrix

Desktop acceptance distinguishes window visibility, renderer lifetime, browser storage lifetime, host-composed login lifetime, and service runtime lifetime. Closing the main window is not a full app quit. Match LinX and normal macOS tray behavior: the close event is prevented and the existing BrowserWindow is hidden. Gateway, CSS, API, Electron, and the authenticated renderer all remain alive. Reopening from the tray, Dock, or a second-instance activation shows and focuses that same BrowserWindow, so it must not run a second restore or login transaction.

| Scenario | Setup | Expected product behavior | Required evidence |
| --- | --- | --- | --- |
| Anonymous first desktop startup | No Account cookie, no Inrupt session, no selected Pod state | Resize the native content viewport to `280 × 400` and render the compact login surface as the entire window content. Do not render a document scrim or a card inside a larger window. Rail, list, content, avatar card, and any product shell are not mounted. | Native bounds plus DOM/screenshot prove the dialog fills the viewport at `(0, 0)`, has no nested radius/border/shadow, contains one visible login path, and exposes no provider/custom issuer/external Pod controls. |
| First Status access | User invokes the WebID action from Status/Dashboard path | The one OIDC path establishes/restores Account, WebID and the exact Pod before mounting Status. Status requests then use Account authority. | Network trace shows one WebID/OIDC transaction and, if CSS must verify the user, one internal Account credential submission; no product shell or second product login action appears before full readiness. |
| First full Account + WebID path | Same-origin Xpod has exactly one eligible local Pod/WebID binding | One visible path establishes Account, starts current-origin WebID/OIDC, auto-selects the exact binding, completes consent, and returns to the original protected route. | Trace shows one password submission, one OIDC authorization/token completion, no second Continue/Authorize card, and final route readiness from live Account + WebID session checks. |
| Same BrowserWindow reload | Authenticated product window reloads the current protected route | Account, WebID, and Pod state restore silently. No credential page, callback page, or product-shell flash appears. | Reload test records stable protected-route DOM after restoration and no new Account credential submission. |
| Main-window close | User closes the main window with the window close control | Prevent close and hide the current BrowserWindow; owned Gateway, CSS, API, Electron and renderer remain alive behind the tray/status item. | Process check proves owned services still listen; the existing window is hidden, not destroyed; tray/status item remains available. |
| Tray reopen, Dock reopen, or second-instance activation | Main window is hidden and services remain running | Show and focus the same BrowserWindow at the same protected route without re-running login or restoration. | End-to-end test records the renderer PID/session, hides and reopens the window, and proves both remain unchanged with zero extra Account credential or WebID transactions. |
| Explicit Quit | User chooses Quit from app menu/tray or equivalent explicit app quit | Xpod stops windows and any runtime it owns, but does not equate process lifetime with logout. Profile-persistent Account and Inrupt session material remain owned by their respective libraries. A later launch silently restores the still-valid composition; only an explicit in-product sign-out clears both domains. | Process check proves owned Gateway/CSS/API are stopped; the same `userData` restart reaches the protected route without another password or WebID prompt while the sessions remain valid. Invalid/expired server state falls through to the single WebID recovery entry. |
| Backend process restart while browser profile remains | Gateway/CSS/API restart or fixture server is replaced | If server-side Account/OIDC session material is invalidated, Xpod explains that the local service restarted and asks the user to sign in again through the one login page. It must not show a raw callback page or multiple dialogs. | Restart test documents whether cookies/session ids still validate, then verifies either silent restore or a friendly single-login recovery with sanitized copy. |
| Account session expired, WebID still present | CSS Account API reports anonymous/expired while Inrupt state still exists | Dashboard-protected surfaces require the unified login path to refresh Account. Pod-backed surfaces may not claim Dashboard readiness from WebID alone. | Route test simulates/observes Account expiry and proves Dashboard is gated while WebID-backed state is not converted into Account authority. |
| WebID session expired, Account still present | Inrupt restore fails or Solid fetch requires reauthentication while Account remains valid | The same login path starts current-origin WebID/OIDC without asking for the password again. | Trace shows no Account credential submission, one WebID/OIDC recovery path, and final selected Pod reconciliation. |
| Account and WebID both expired | Both auth domains restore anonymous/expired | Show the single compact login dialog and rebuild both sessions through one visible path. If a remembered identity is available, retain its avatar, name and binding label during re-authentication. | DOM proves one login dialog and the remembered identity lead; trace proves one Account credential submission and one WebID/OIDC completion. |
| Remembered composite mismatch | Restored Account, WebID, or selected Pod differs from the remembered host identity | Do not combine domains and do not rewrite the remembered record. Keep the product shell unmounted and offer one switch-account recovery action that coordinates both logout domains. | Test proves Alice's remembered record cannot be overwritten or admitted by Bob's Account/WebID/Pod state and that recovery invokes the combined logout coordinator. |
| Callback interrupted, missing transaction, replayed, cancelled, timed out, or unsafe | Callback URL is missing host transaction, uses a stale/replayed code, has user denial, exceeds TTL, or carries an unsafe return path | Show one branded friendly recovery page with sanitized copy and one deterministic restart action. Do not mount the product shell and do not show raw English protocol text. | Static callback and real browser tests cover each classification and assert no token redemption for known completed replay, safe return handling, and no shell behind the recovery page. |
| Network or identity-service unavailable | Account API, OIDC issuer, token endpoint, or Pod endpoint is unreachable or returns a protocol failure | Show one recoverable error state in the active login page/callback page. Retry is idempotent and duplicate clicks are disabled while pending. | Tests assert sanitized error copy, one retry action, duplicate-submission prevention, and no leaked protocol exception text. |
| Duplicate user action | User double-clicks login, retry, consent, logout, or callback restart | Only one in-flight transaction is created or retried. Later clicks are ignored or disabled until the pending request resolves. | Interaction tests count requests/transactions and prove disabled/pending state. |
| Multiple Pods | Account has more than one eligible exact local Pod/WebID binding | Stay in the same login path and present an explicit Pod chooser. The last valid selected Pod may be restored; stale remembered state does not silently select the first result. | Test proves explicit choice or valid remembered selection, and no implicit `storageUrls[0]` fallback. |
| No eligible Pod | Account has no eligible local Pod/WebID binding | Use storage bootstrap or a clear no-Pod recovery state according to host policy; OIDC consent does not start before storage selection is `ready`. | Test proves no consent request before storage readiness and a deterministic bootstrap/retry path. |
| Unified logout and partial retry | User signs out, with either Account logout or WebID logout failing | Authenticated actions hide while logout is unresolved. Successful domain cleanup is retained; failed domain gets an idempotent retry without token/secret retry metadata. | Test proves both domains become anonymous on success, and partial failure exposes only deterministic retry state. |

Successful UI markers alone are not acceptance evidence. A test cannot pass only because a heading, toast, route path, or locally stored completion marker says login is complete. Protected-route acceptance must be backed by live Account authority checks for Account surfaces, live WebID authenticated fetch checks for Pod-backed surfaces, and exact selected-Pod reconciliation. Callback completion markers may prevent stale-code replay, but they never prove that the current Account or WebID session is valid.

## Surface, accessibility, and localization

- `AuthSurface` uses one tokenized card implementation across page, modal, and embedded hosts.
- Xpod startup uses the compact modal semantics as its global login scene. In Electron it uses the public `window` host geometry so the surface is the native window content, not a card inside a document; in browsers it remains a regular compact modal. It never mounts over rail/list/content. Page, modal and embedded modes remain public-library capabilities for other hosts.
- Modal mode traps focus, restores focus, supports Escape according to host policy, and has a real accessible title.
- Page and embedded modes do not claim modal semantics.
- Registration and long consent content use a viewport-bounded scrolling body and remain usable with a mobile software keyboard.
- Segmented or selectable controls expose checked/selected state to assistive technology.
- Xpod product branding is supplied by its adapter. The source-migrated LinX
  default branch/copy stays unchanged until both products adopt a separately
  specified copy contract; source migration must not silently rewrite it.

## Xpod migration scope

Xpod migrates these surfaces in the same phase:

- the single current-origin login controller used by every Xpod sign-in affordance;
- the desktop-wide Xpod product gate that coordinates Account, WebID and exact Pod readiness without exposing separate route-level login cards;
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
- anonymous startup renders one compact accessible login dialog with no product workspace shell mounted behind it;
- first login shows the Xpod mark, while remembered and re-authentication states show the user's avatar, name and Xpod binding instead of the product mark;
- Xpod host policy disables provider selection and add-provider controls even though the public package continues to support hosts with zero, one or many provider routes;
- login from Dashboard or any Settings surface completes Account, current-Xpod WebID and exact Pod readiness with one password submission and no second Continue/Authorize action;
- Dashboard Account-session authorization, host-authorized local Settings, and Pod-backed Settings WebID-session authorization after the unified desktop gate;
- Account-level enumeration of all local Pod/WebID bindings, deterministic last-Pod restoration, explicit multi-Pod selection, and no implicit first-storage fallback;
- distinct identity and storage endpoints;
- expired-session reauthentication without constructing a second Inrupt Session;
- login cancellation, lost consent transaction, invalid callback state, unsafe return path, and storage conflict;
- desktop lifecycle coverage for main-window hide, tray/Dock/second-instance show of the same renderer, and explicit Quit stopping owned runtime;
- backend restart, Account expiry, WebID expiry, callback interruption/replay/cancellation/timeout, network/identity-service failure, duplicate submissions, multi-Pod/no-Pod selection, unified logout, and partial retry scenarios from the desktop login lifecycle matrix;
- one logout action that leaves both Account and WebID auth domains anonymous, including deterministic partial-failure retry;
- same-origin Gateway routing that serves Dashboard and Settings through the API Server while keeping Account, OIDC, and Pod endpoints on CSS;
- real browser acceptance through Xpod routes, without storage-state injection or browser token fallback;
- protected-route readiness proven by live Account/WebID authorization and selected-Pod reconciliation, not only by UI text, route path, or callback completion marker;
- package builds, UI builds, lint, focused tests, and the complete integration suite.

## Deferred work

- Migrating LinX-only local onboarding, tunnel repair, or desktop authorization-sheet internals into Xpod;
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
12. Desktop close keeps owned Gateway/CSS/API available behind the tray/status item and hides the existing BrowserWindow; tray, Dock, or second-instance reopen shows the same renderer without another restore or login.
13. Explicit Quit stops owned runtime without clearing valid browser sessions; backend restart or invalidated server session state produces a friendly single-WebID recovery instead of raw callback/protocol output.
14. Protected-route success is accepted only with live authorization evidence for the required session domain and exact selected-Pod reconciliation; UI markers, headings, paths, and callback completion records alone are insufficient.
15. LinX and Xpod consume the same migrated four-state machine and shared login
    surface; neither product keeps a private copy of the shared branch JSX or
    presentation phase logic.
16. Xpod's compact login presentation matches the LinX card contract: one
    `280 × 400` card, no inner scrollbar, no duplicated frame, and remembered
    identity content replacing the product mark after first login.
