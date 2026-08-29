# Account-level usage authorization TODO

> **Status: deferred.** This item is outside the 2026-08-30 auth-authority
> refactor and must not block removal of API Account-token authentication.

## Problem

Status may eventually show Account-level usage, while the Xpod API no longer
accepts CSS Account tokens as a general browser principal. Reintroducing a
CSS Account token authenticator would collapse the CSS Account and Xpod API
boundaries again.

## Required design work

- Decide whether Account usage is rendered directly by a CSS Account control,
  projected into a read-only CSS-owned endpoint, or aggregated by an explicit
  service capability.
- Define the minimum fields, privacy boundary, cache policy and failure
  behavior.
- Prove the route cannot read Pod data or mutate Account state.
- Keep Pod-level usage on WebID/Solid authorization.
- Add route-level tests showing Account usage works without an Inrupt session
  and that its credential cannot authorize other Xpod API routes.

## Non-goals

- No general Account principal in `src/api/auth/AuthContext.ts`.
- No Account authenticator in the Xpod API MultiAuthenticator.
- No Account token forwarding from applets, AI Connections or AI Config.
- No inferred WebID or Pod authority from an authenticated Account.

Until this is designed and accepted, the Account usage UI remains unavailable
or explicitly marked unsupported rather than falling back to another
credential type.
