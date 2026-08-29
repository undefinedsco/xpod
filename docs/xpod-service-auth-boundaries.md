# Xpod service authentication boundaries

> **Documentation status: Canonical technical companion.** This file defines
> route-level technical authentication boundaries. It does not authorize a
> second user-visible login flow inside AI Connections. The product login
> transaction and exact local-Pod experience are defined by
> [`docs/ai-connections-product-spec.md`](ai-connections-product-spec.md).

Xpod's rail opens distinct service pages. Authentication is owned by each
service route, not by one shell-wide login gate.

```text
XpodShell
├── Status / Dashboard        AccountAuthBoundary
├── Network                   no identity boundary
├── AI Connections            WebIdAuthBoundary
├── AI Config                 WebIdAuthBoundary
└── Settings
    ├── Pod                   WebIdAuthBoundary
    ├── Identity & Access     WebIdAuthBoundary
    ├── Storage               local host, no identity boundary
    ├── Runtime               local host, no identity boundary
    ├── Cloud                 local host, no identity boundary
    └── Advanced              local host, no identity boundary
```

Account and WebID sessions remain independent technical states. Providers may
live above the route tree to preserve session lifetime while navigating, but
they do not gate the whole shell and one session must never be inferred from
the other.

Independence does **not** mean two user-visible sign-ins. Xpod exposes one
product login action. That action starts the current-origin WebID/OIDC
transaction through `useXpodAuth().startLogin()`:

1. the identity provider establishes or restores the Account session;
2. the same transaction obtains consent for the exact WebID and Pod binding;
3. `/auth/callback` restores the WebID session and opens that Pod;
4. rail navigation reuses both long-lived providers.

The Xpod document must not render its own email/password form before this
redirect. Password entry belongs to the identity-provider document and is only
one step inside the single transaction. A pre-existing Account-only session
may still authorize Status, and a pre-existing WebID-only session may still
authorize an appropriate public identity surface, but a fresh Xpod login must
not deliberately create either partial state.

## Ownership

- Xpod owns the product login launcher, Account state, Account management and
  recovery views, CSS Account controls, Account token persistence, copy, and
  error mapping. The CSS identity-provider document owns the password form
  shown inside an OIDC transaction.
- `shared-ui` owns only the visual primitives Xpod consumes, such as
  `AuthSurface`, buttons, inputs, cards, avatars, loading, and error
  presentation. Xpod does not consume any Account login view or Account state
  contract from it. (`LoginModal` / `LoginView` and their store contracts stay
  in `shared-ui` strictly as LinX product surfaces — see "Unused LinX
  surfaces" below.)
- `solid-sdk` owns protocol-neutral WebID session state and login transaction
  contracts.
- `extension-sdk` owns `SolidAuthBoundary`, which maps host-owned WebID state
  to presentation and callbacks without creating or persisting a session.
- Xpod's WebID adapter always supplies the current Xpod route. Xpod does not
  expose provider creation or arbitrary issuer input.
- LinX may expose a provider registry. A local-Xpod provider belongs to LinX's
  plugin/integration layer and may detect or start Xpod before creating a
  WebID session; it is not part of Xpod or `shared-ui`.

## Rendering invariant

A protected service mounts its layout only after its own boundary is ready.
Unrelated services remain usable:

- Account failure does not hide Network or local Settings.
- WebID failure does not hide Dashboard when its Account session is valid.
- Switching between AI Connections, AI Config, and Pod Settings reuses the
  long-lived Solid runtime and must not flash an anonymous login state.
- Closing the desktop window does not log out either session or stop the Xpod
  background process; only the explicit tray quit action stops the host.

## Host adapters

- One `createXpodLoginController` lives in `XpodAuthProvider`. Route
  boundaries and extension hosts reuse `useXpodAuth().startLogin` /
  `retryLogin` / `cancelLogin`; they must not construct a second controller.
- `AccountAuthBoundary` checks Account readiness for Status, but its anonymous
  action also calls that same controller. It must not render
  `XpodAccountCredentials` or post directly to `/.account/login/password/`.
- `WebIdAuthBoundary` checks WebID and exact-Pod readiness for Pod-backed
  pages. When the composed login is already complete it renders immediately;
  it must not offer a second login after a Status-first login.
- Desktop window mode is `workspace`. Account and WebID surfaces are in-shell
  overlays and must not resize the native window.
- `/.account/*`, including `LoginSelectPage`, belongs to the CSS
  identity-provider document. It is not the product login controller.

## Unused LinX surfaces

Xpod does not render `LoginModal` / `LoginView` and does not drive
`createLoginStore`. Those remain LinX product surfaces hosted in `shared-ui`
and `solid-sdk` for source migration. Xpod remembered identity is
`xpod.remembered-login.v1`, never `linx-remembered-account`.

Historical documents that described a shell-wide four-phase login gate are not
authoritative:

- [`docs/superpowers/specs/2026-08-10-shared-account-login-view-design.md`](superpowers/specs/2026-08-10-shared-account-login-view-design.md)
- [`docs/superpowers/specs/2026-08-13-xpod-login-state-machine.md`](superpowers/specs/2026-08-13-xpod-login-state-machine.md)

## Acceptance matrix

| Route | Required state | Must not require |
| --- | --- | --- |
| `/status/*`, `/dashboard/*` | Account session | WebID session |
| `/network/*` | local runtime | Account or WebID |
| `/ai-connections/*` | WebID + exact Pod binding | Account session |
| `/ai-config/*` | WebID + exact Pod binding | Account session |
| `/settings/pod`, `/settings/identity-access` | WebID + exact Pod binding | Account session |
| `/settings/storage`, `/settings/runtime`, `/settings/cloud`, `/settings/advanced` | local runtime | Account or WebID |

The table describes authorization readiness, not separate login products. All
anonymous protected routes use the same Xpod login controller and the same
OIDC callback.
