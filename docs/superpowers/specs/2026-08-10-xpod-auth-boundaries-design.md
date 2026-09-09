# Xpod Authentication Boundaries Design

**Date:** 2026-08-10

**Status:** Superseded. The authority separation below remains valid, but the
route gating model is now defined by
[`docs/xpod-service-auth-boundaries.md`](../../xpod-service-auth-boundaries.md)
(2026-08-21): each service route owns its boundary; there is no shell-wide
login gate. (Intermediate revisions: unified-login note 2026-08-12 in
`2026-08-10-shared-account-login-view-design.md`, itself now superseded.)

> **Void:** every gate/viewport passage in the body below — the
> "non-dismissible login gate", "does not mount the shell", and all
> `280 × 400` native auth viewport requirements — is withdrawn. Account and
> WebID surfaces are in-shell overlays that must not resize the native window.
> Do not cite the body of this document as implementation authority.

## Decision

Xpod keeps three independent authorization contexts. The desktop product now
coordinates their readiness behind one non-dismissible login gate and does not
mount the shell before the Account + WebID + selected Pod lifecycle is ready.
Each request still selects authority from the data it reads or changes.

| Boundary | Authority | Entry behavior | Consumers |
| --- | --- | --- | --- |
| Account | Xpod/CSS account session | Participate in the global compact login gate before the product shell mounts | Status dashboard, account-scoped usage and Pod administration |
| Local host | Trusted local Xpod runtime capability | No user login; the API remains responsible for localhost/desktop capability enforcement | Network, Runtime, Storage, Cloud, Advanced and service configuration |
| WebID | Solid OIDC session | Continue automatically through the same current-origin login path before the product shell mounts | Pod metadata, ACP/ACR, AI Config, AI Connections and applets |

Account and WebID sessions remain independent. An account may expose linked WebIDs, but an account session never counts as Solid authorization and cannot supply an authenticated Pod fetch.

## Route policy

```text
Account
  /status/*
  legacy /dashboard status and usage routes

Local host
  /network/*
  /settings/storage
  /settings/runtime
  /settings/cloud
  /settings/advanced
  legacy /settings/network and /settings/services

WebID
  /settings/pod
  /settings/identity-access
  /ai-config/*
  /ai-connections/*
  applet Pod-data routes
```

## UI behavior

- Before the desktop product gate is ready, rail, list and content are not mounted.
- The desktop targets Status Overview, but does not mount its shell until the unified product gate is ready. When the composition cannot be restored, the native window switches to a `280 × 400` auth viewport and the compact shared WebID entry fills it directly. There is no gray document scrim or second card frame inside a larger window.
- The public UI package owns the frame-free single-WebID presentation inside one `AuthSurface`. Xpod supplies the fixed current-origin controller; it must not embed Account email/password fields or a provider chooser in that product card.
- Protected content starts the same-origin OIDC path. If CSS requires Account verification, it owns that internal `/.account/*` step; Xpod neither duplicates it nor treats it as a second product login method.
- The top-left Avatar/identity trigger exists only after authentication and opens the consumer user card. Anonymous startup has no rail or avatar-triggered second login surface.
- The macOS menu-bar `Account…` item opens that same user card over Status Overview. It does not expose a second `/.account/*` navigation path.
- Successful composed login preserves the exact product route. Failed login stays in the one WebID surface with a safe inline error and retry; pending submission prevents duplicates.
- WebID-protected content renders the reusable Solid provider login surface without changing the current route.
- Local-host content does not show a login form. Unsupported remote mutation is explained by the API capability response.
- The user card presents Account and Solid identity as separate layers. Its single sign-out action coordinates both domains and exposes partial failure instead of claiming success early.
- The public component may render provider selection for hosts that supply it. Xpod supplies only its current same-origin route and disables provider selection, add-provider, editable issuer, external WebID and external Pod controls.
- The compact surface follows the LinX visual state contract: product mark only on first login; remembered and re-authentication states use the user's avatar, name and Xpod binding. Electron makes the `280 × 400` native content viewport the sole outer card; browser hosts retain the overlay card. Neither form has a nested frame or inner scrollbar.

The Xpod desktop startup card is a global product gate and is not dismissible.
After one WebID action, CSS may verify its own Account and the WebID/Pod stages advance
within the same protocol flow. Public-library consumers
remain free to compose page, modal, embedded, dismissible or single-session
surfaces; this locked behavior belongs to the Xpod host only.

## Desktop startup acceptance

1. A fresh desktop profile opens a `280 × 400` native auth window whose content is one accessible WebID login action, without Account fields, gray backdrop, nested card, provider chooser, or mounted Status Overview shell.
2. That action starts the fixed current-origin OIDC flow; CSS may show its own Account verification route, then restores Account, WebID and exact Pod without a second product Continue/consent card.
3. The Electron window never lands on a raw Pod resource page or an external provider picker.
4. Reloading restores a still-valid composition without user input. Closing the
   window hides the existing LinX-style tray BrowserWindow; reopening shows the
   same renderer and must not start restoration again. Explicit Quit Xpod stops
   the owned runtime but does not implicitly perform in-product sign-out.
   The detailed lifecycle and fallback rules are normative in
   `2026-08-13-xpod-login-state-machine.md`.
5. The top-left Avatar opens the user card only after authentication; anonymous startup exposes no second avatar or navigation-based login action.
6. No workspace navigation or local-setting content is mounted before the unified product gate is ready.

## Security boundary

“No login” applies only to the UI flow. It does not make local configuration a public write API. Desktop and loopback access continue to use host capability checks; remote callers receive read-only capability or a rejected mutation. Raw secrets are never returned to the UI.

The packaged desktop treats its loopback Xpod runtime as the trust root. Command-line and environment URL overrides may select another loopback port or shell route for development and acceptance, but they must never promote an external origin into the current Xpod identity provider. Every Account control that carries credentials or an Account token must resolve to the current origin and fail closed otherwise. An existing Inrupt session is reusable only when its issuer and WebID are local to the current Xpod; stale or external-provider sessions are cleared before any Pod-backed route becomes ready, and both public runtime fetch entry points remain blocked until that cleanup has made the underlying session anonymous.

The Xpod product bundles expose no editable issuer field, provider chooser, external WebID-link field, or arbitrary Pod URL login utility. Generic CSS identity-provider routes and public libraries may retain those protocol capabilities for other hosts, but Xpod rail, modal, user card and callback do not link to or embed them. A bundled interoperability verifier, when present, locks issuer, restored WebID, Pod home and resource requests to the current Xpod origin; an arbitrary-provider verifier belongs only in an explicit development build.

The renderer publishes only the sanitized current Account/WebID/Pod summary through the preload bridge. The tray always exposes `Account…` as the same in-shell user-card entry, while the signed-in label and `Open Pod` target appear only after that bridge reports a current local identity. API authentication accepts a CSS Account token only while the referenced Account still exists in the current identity store.

## State model

```ts
type XpodAuthState = {
  account: 'loading' | 'anonymous' | 'authenticated' | 'error';
  solid: 'loading' | 'anonymous' | 'authenticated' | 'error';
  host: 'unavailable' | 'read-only' | 'write';
};
```

No derived `isLoggedIn` value may merge these dimensions.
