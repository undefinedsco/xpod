# Xpod Login State Machine

**Date:** 2026-08-13
**Status (2026-08-30): HISTORICAL — 已降级。** 产品登录以
[`2026-08-30-xpod-auth-authority-boundaries.md`](2026-08-30-xpod-auth-authority-boundaries.md)
为唯一权威：没有 shell 级全局登录门，Account 与 WebID 由各服务路由的
boundary 独立要求。本文描述的四阶段合成机、`LoginModal` 与
`createLoginStore` 适配规则对现行 Xpod 无效，仅保留作 LinX 源迁移历史。

## Why this document exists

Xpod has two independent live sessions and one remembered identity. Previous
implementations let each domain independently trigger navigation or recovery.
That made a renderer close, an application quit, and a server restart look like
the same event even though their session guarantees are different.

LinX provides the product-level source: one store owns the four presentation
phases while its product controller supplies session/provider facts. The LinX
store and login views are migrated into public packages. LinX's controller hook
is intentionally not public because it is coupled to LinX routing, Electron,
Inrupt, providers, and local onboarding. Xpod supplies its own named host
adapter for Account + WebID + exact-Pod facts; that adapter is Xpod code and is
never represented as copied LinX code. Both products use the same four phases:

```text
restoring -> idle -> connecting -> authenticated
                  ^              |
                  +--------------+
```

Errors are context on `idle`; a callback error page is not a fifth product
phase. No Account, WebID, Pod, callback, Electron component, or product-specific
gate may independently invent another product login phase.

## Independent facts

The product phase consumes these facts without merging their authorities:

| Fact | Canonical owner | Runtime values | Meaning |
| --- | --- | --- | --- |
| Account session | CSS Account + Xpod `AuthContext` | initializing, anonymous, authenticated, error | May authorize Account operations and lets CSS reuse Account verification during OIDC. It is not a Solid session. |
| WebID session | Inrupt + `XpodSolidRuntimeProvider` | restoring, anonymous, authenticated, expired, error | Authorizes Solid requests. It does not prove Account ownership. |
| Pod binding | Xpod host | opening, missing, ready, conflict, error | Exact same-origin `(webId, storageUrl)` selected for this product. |
| Remembered identity | Xpod host local storage | absent, present | Public avatar/name/email/WebID/Pod hint. It is never authorization and never contains a token or secret. |

`authenticated` requires all three live facts to agree with the exact remembered
binding when one exists. No derived `isLoggedIn` may collapse only Account and
WebID into a single boolean.

## Product phase reduction

The host reduces one snapshot to one presentation phase:

| Priority | Condition | Phase | Visible result |
| --- | --- | --- | --- |
| 1 | Route needs no product identity | authenticated/bypass | Render the route according to its host policy. |
| 2 | Account + WebID + exact Pod are ready and consistent | authenticated | Mount rail, list and content. |
| 3 | Account initialization, WebID restoration, coordinated logout, or opening a known exact Pod is still running | restoring | Blank themed auth scene; never mount the product shell. |
| 4 | A user-started WebID transaction is in flight | connecting | Compact connecting scene using the remembered identity when available. |
| 5 | Any required live fact is absent, expired, inconsistent, or failed | idle | First-login card or remembered-avatar card, with a safe inline message when useful. |

Two rules are absolute:

1. `Account authenticated + WebID anonymous` reduces to `idle`. It never starts
   OIDC by itself.
2. A recoverable OIDC callback failure (`login_required`,
   `interaction_required`, `consent_required`, `account_selection_required`)
   clears stale active Solid state and reduces to `idle`. It never parks the
   product on `/auth/callback` and never immediately retries itself.

## Events and transitions

| Event | From | To | Required effects |
| --- | --- | --- | --- |
| `BOOT` | — | restoring | Initialize Account and attempt only the host-approved Inrupt restore. |
| `RESTORE_READY` | restoring | authenticated | Verify Account, WebID, and exact Pod before mounting the shell. |
| `RESTORE_INCOMPLETE` | restoring | idle | Preserve remembered identity; clear stale active transaction/session fragments. |
| `LOGIN_CLICKED` | idle | connecting | Create one Xpod transaction and start the fixed current-origin WebID route. |
| `ACCOUNT_REQUIRED` | connecting | connecting | CSS owns its password/recovery pages; Xpod does not create another product login method. |
| `CALLBACK_SUCCEEDED` | connecting/restoring | restoring or authenticated | Validate transaction, WebID, return path and exact Pod; finish composition. |
| `CALLBACK_REAUTH_REQUIRED` | connecting/restoring | idle | Clear stale callback/Inrupt state, return to the protected route, show remembered card. |
| `COMPOSITION_MISMATCH` | any protected phase | idle | Never expose protected content or auto-login. Show the remembered identity and require the explicit switch-account action before coordinated cleanup. |
| `SWITCH_ACCOUNT` | idle/authenticated | restoring, then idle | Logout both live domains and clear remembered identity. |
| `SIGN_OUT` | authenticated | restoring, then idle | Logout both live domains; host policy may retain the remembered identity. |
| `RUNTIME_SESSION_EXPIRED` | authenticated/restoring | idle | Clear active Account/WebID/Pod state, retain remembered identity. |

Only `LOGIN_CLICKED` and an already-valid `BOOT` restoration may begin an OIDC
authorization attempt. React effects may observe and reduce facts; they may not
turn partial Account readiness into a new login attempt.

## Storage ownership

| Data | Storage | Lifetime | Cleared by |
| --- | --- | --- | --- |
| CSS Account cookie/token | Chromium cookie + CSS | Owned by CSS session policy | Coordinated in-product sign-out or switch account |
| Inrupt active session and OIDC metadata | Inrupt-managed browser storage | Owned by Inrupt session policy | Inrupt logout, callback recovery, or switch account |
| Xpod login transaction/callback completion | session storage | One renderer/tab and one transaction | Success, cancel, or recoverable failure |
| Selected exact Pod binding | host storage | Active composition | Sign-out, mismatch, or switch account; the public pair remains duplicated in remembered identity |
| Remembered identity | local storage | Across renderer and application restarts | Explicit switch/forget account only |
| Pending Account email | local storage, public transient hint | Until CSS consumes/replaces it | Successful composition, switch account, or cleanup; may be rehydrated from remembered identity after a user login click |

Xpod must not extend CSS `_session` cookies or Inrupt secrets merely to make a
full application quit look like a window close.

## Desktop lifecycle matrix

| Desktop event | Renderer | Electron/tray | Three services | Active session expectation | Next visible state |
| --- | --- | --- | --- | --- | --- |
| Red close button | Hidden, not destroyed | Kept alive | Kept alive | Account/WebID/Pod composition remains in the same renderer | No visible state transition |
| Dock/menu-bar `Open Xpod` | Same renderer shown/focused | Already alive | Already alive | No restore is started | authenticated, no login flash |
| Tray `Quit Xpod` | Destroyed by Electron exit | Exits | Stop only desktop-owned runtime | Quit is not logout; underlying session persistence follows CSS/Inrupt policy | Next launch restores if still valid, otherwise idle remembered |
| Runtime crashes/restarts | May remain | Remains | Recover/restart | Treat rejected live authority as expired | idle remembered, never raw callback error |
| Application update | Relaunched | Relaunched | Restarted as required | Best-effort restore only; no guarantee stronger than the underlying session | authenticated if exact restore succeeds, otherwise idle remembered |
| Switch account | Remains | Remains | Remain | Clear both live domains and remembered identity | idle first-login |

The red close guarantee does not require copying or extending secrets: the
authenticated renderer itself remains alive. A real application launch still
uses the underlying CSS/Inrupt restore guarantees and falls back to the
remembered card without an automatic retry loop when they are no longer valid.

## LinX source of truth and Xpod adapters

The public implementation is extracted from these LinX behaviors:

- the four product phases live in one controller/store;
- remembered account data is public presentation state, not authentication;
- a remembered account is continued by a user action;
- desktop cold start does not run arbitrary callback restoration from a product route;
- silent-login errors fall back to an interactive idle state;
- the remembered view is avatar + name + one primary action + switch account.

Xpod's adapter differs because one visible WebID entry composes CSS Account,
Inrupt WebID, and an exact local Pod binding. CSS may show its own Account
verification inside the same protocol transaction. That internal page is not a
second Xpod login method and must not leak another state machine into the
product shell. This difference is represented as adapter facts and capability
props, never as a fork of the shared phase logic or LoginModal branch tree.

Historical implementation rule (void for Xpod): the 2026-08-13 draft required
Xpod to render public `LoginModal` through a private adapter and to wrap
`createLoginStore`. Current Xpod does neither. Product Account forms live in
`ui/src/auth`; WebID gates use `SolidAuthBoundary` plus one host login
controller in `XpodAuthProvider`.

## Acceptance matrix

Every release must cover these as independent tests:

1. Fresh profile: blank product document with one WebID card; no rail, Account
   fields, provider chooser, or hidden product shell.
2. First login: one WebID click, optional CSS Account verification, exact Pod
   composition, then protected content.
3. Red close and reopen: tray and all three services remain; no password submit,
   no login flash, same identity and Pod.
4. Explicit Quit and relaunch: restore the still-valid underlying sessions when
   possible; otherwise show the remembered avatar card without a raw callback
   error or an automatic login loop.
5. Account-only residue: show idle remembered/first-login; never auto-start OIDC.
6. WebID-only or missing-Pod residue: never mount protected content and never
   auto-start a second OIDC transaction.
7. Recoverable callback error: clear stale active Solid records and return to
   idle remembered, without callback-error UI or a retry loop.
8. Identity/Pod mismatch: protected content remains unmounted; no automatic
   destructive cleanup runs; one explicit switch-account action performs
   coordinated cleanup and reaches one deterministic idle state.
9. Tray: icon exists, reports Gateway/CSS/API, opens Xpod, and only explicit
   Quit stops a desktop-owned runtime.
