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
- Account-protected content never redirects the desktop window to `/.account/*`, a raw Pod resource, or an external browser. The modal submits to the same-origin CSS Account controls, stores the resulting Account Session, refreshes Account state, and closes in place.
- The top-left Avatar/identity trigger always opens the user card. When anonymous, that card embeds the same Account credentials view; it does not navigate to an identity-provider page. Its `X`/initials fallback is still an Avatar state, not a second login shortcut.
- The macOS menu-bar `Account…` item opens that same user card over Status Overview. It does not expose a second `/.account/*` navigation path.
- Successful Account login preserves the exact Dashboard route and shell state. Failed login stays in the modal with a safe inline error and retry; pending submission prevents duplicates.
- WebID-protected content renders the reusable Solid provider login surface without changing the current route.
- Local-host content does not show a login form. Unsupported remote mutation is explained by the API capability response.
- The user card presents Account and Solid identity as separate layers. Its single sign-out action coordinates both domains and exposes partial failure instead of claiming success early.

The startup modal is a consequence of the desktop's default Account-protected route, not a global login boundary. A user who navigates to a local-host Network or Settings route does not need an Account Session. Browser-hosted and public-library consumers may choose page, modal, or embedded presentation independently; the forced full-page redirect is removed only from the Xpod desktop composition.

## Desktop startup acceptance

1. A fresh desktop profile opens the Status Overview shell and displays an accessible Account login modal without a click.
2. The modal accepts the local seed account and, on success, disappears while the window URL remains the Status Overview route.
3. No system-browser window opens during Account login, and the Electron window never lands on a raw Pod resource page.
4. Reloading the desktop restores the Account Session and does not show the modal again.
5. The top-left Avatar opens the user card; when anonymous, that card contains the embedded Account credentials view rather than a second navigation-based login action.
6. Network and local Settings remain usable without Account or WebID authorization.

## Security boundary

“No login” applies only to the UI flow. It does not make local configuration a public write API. Desktop and loopback access continue to use host capability checks; remote callers receive read-only capability or a rejected mutation. Raw secrets are never returned to the UI.

## State model

```ts
type XpodAuthState = {
  account: 'loading' | 'anonymous' | 'authenticated' | 'error';
  solid: 'loading' | 'anonymous' | 'authenticated' | 'error';
  host: 'unavailable' | 'read-only' | 'write';
};
```

No derived `isLoggedIn` value may merge these dimensions.
