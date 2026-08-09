# Xpod Authentication Boundaries Design

**Date:** 2026-08-10

**Status:** Approved

## Decision

Xpod uses three independent authorization contexts. A page selects its boundary from the authority that owns the data it reads or changes; the shell itself is never hidden behind a global login boundary.

| Boundary | Authority | Entry behavior | Consumers |
| --- | --- | --- | --- |
| Account | Xpod/CSS account session | Redirect to the shared account login and return to the requested route | Status dashboard, account-scoped usage and Pod administration |
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
- Account-protected content redirects to `/.account/login/password/` after persisting the exact return route.
- WebID-protected content renders the reusable Solid provider login surface without changing the current route.
- Local-host content does not show a login form. Unsupported remote mutation is explained by the API capability response.
- The user card presents Account and Solid identity as separate layers and offers separate account sign-out and WebID disconnect actions.

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
