# Xpod Authentication Boundaries Design

**Date:** 2026-08-10

**Status:** Approved

## Decision

Xpod uses three independent authorization contexts. A page selects its boundary from the authority that owns the data it reads or changes; the shell itself is never hidden behind a global login boundary.

| Boundary | Authority | Entry behavior | Consumers |
| --- | --- | --- | --- |
| Account | Xpod/CSS account session | Render the shared account login as an in-shell modal over the requested route | Status dashboard, account-scoped usage and Pod administration |
| Local host | Trusted local Xpod runtime capability | No user login; the API remains responsible for localhost/desktop capability enforcement | Network, Runtime, Storage, Cloud, Advanced and service configuration |
| WebID | Solid OIDC session | Render the shared WebID authorization surface in the selected content route | Pod metadata, ACP/ACR, AI Config, AI Connections and applets |

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

- The rail and list remain visible when a content boundary is not satisfied.
- The desktop opens on the Account-protected Status Overview route. When no Account Session can be restored, the shell immediately renders the shared Account credentials view in modal mode over that route.
- The public UI package owns the complete Account credentials surface composition: one `AuthSurface` frame plus an unframed credentials body. Xpod supplies the controlled values and same-origin network controller; it must not stack an Account card inside the modal card or reimplement dialog behavior in the host.
- Account-protected content never redirects the desktop window to `/.account/*`, a raw Pod resource, or an external browser. The modal submits to the same-origin CSS Account controls, stores the resulting Account Session, refreshes Account state, and closes in place.
- The top-left Avatar/identity trigger always opens the user card. When anonymous, that card embeds the same Account credentials view; it does not navigate to an identity-provider page. Its `X`/initials fallback is still an Avatar state, not a second login shortcut.
- The macOS menu-bar `Account…` item opens that same user card over Status Overview. It does not expose a second `/.account/*` navigation path.
- Successful Account login preserves the exact Dashboard route and shell state. Failed login stays in the modal with a safe inline error and retry; pending submission prevents duplicates.
- WebID-protected content renders the reusable Solid provider login surface without changing the current route.
- Local-host content does not show a login form. Unsupported remote mutation is explained by the API capability response.
- The user card presents Account and Solid identity as separate layers. Its single sign-out action coordinates both domains and exposes partial failure instead of claiming success early.

The startup modal is a consequence of the desktop's default Account-protected route, not a global login boundary. A user who navigates to a local-host Network or Settings route does not need an Account Session. Browser-hosted and public-library consumers may choose page, modal, or embedded presentation independently; the forced full-page redirect is removed only from the Xpod desktop composition.

The startup modal is dismissible. Dismissing it never reveals Account-protected Status data: the content outlet shows an anonymous sign-in-required placeholder with a button that reopens the same modal. The rail and list remain interactive so the user can move to Network or another local-host route without signing in.

## Desktop startup acceptance

1. A fresh desktop profile opens the Status Overview shell and displays an accessible Account login modal without a click.
2. The modal accepts the local seed account and, on success, disappears while the window URL remains the Status Overview route.
3. No system-browser window opens during Account login, and the Electron window never lands on a raw Pod resource page.
4. Reloading the desktop restores the Account Session and does not show the modal again.
5. The top-left Avatar opens the user card; when anonymous, that card contains the embedded Account credentials view rather than a second navigation-based login action.
6. Network and local Settings remain usable without Account or WebID authorization.

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
