# Shared Account Login View Design

## Goal

Replace Xpod's bespoke `WelcomePage` presentation with the public Linx-style login UI so account login looks and behaves consistently wherever the Solid OIDC flow is opened.

## Decision

The reusable account form belongs in `@undefineds.co/shared-ui`. Xpod consumes it directly; it must not copy Linx markup or introduce an Xpod-only visual wrapper.

`WelcomePage` remains the controller for Xpod/CSS-specific behavior:

- account password login;
- registration and username availability;
- first-Pod provisioning;
- pending OIDC consent, cancellation, and return-to navigation.

The public view owns presentation only:

- the existing `LoginCardShell` layout and theme tokens;
- login and registration fields;
- loading, validation, error, suggestion, mode-switch, forgot-password, and cancel controls;
- accessible labels and disabled states.

## Component contract

Add `LoginCredentialsView` to `packages/shared-ui/src/login.tsx` and export it through the existing shared-ui barrel. It is a controlled component: field values, validation messages, busy state, and callbacks are supplied by the host. It performs no fetches, storage writes, Solid session work, or navigation.

The view supports two modes:

- `login`: email and password, forgot-password action, optional OIDC cancel action;
- `register`: username, email, password, confirmation, username availability feedback and selectable suggestions.

`WelcomePage` renders `LoginCardShell` plus `LoginCredentialsView`. It removes its product-marketing panel and all local form styling, while preserving the existing controller logic and routes.

## Error and state behavior

- Form errors render through the shared login error treatment.
- Field-specific email and username messages stay adjacent to their fields.
- Submission is disabled while login, registration, username validation, or OIDC cancellation is active.
- Toggling login/register clears stale field errors and registration suggestions, matching current behavior.
- A logged-in session keeps the current first-Pod/consent redirect behavior.

## Verification

- Shared-ui rendering tests lock the login and registration contracts, error states, suggestions, button labels, and disabled state.
- Xpod page tests verify the public component is used without changing login/register/OIDC controller behavior.
- Package build, UI typecheck/build, lint, targeted tests, and the repository integration suite run before completion.
- Browser acceptance opens the real `/.account/login/password/` route and confirms the Linx-style compact card is rendered.

## Out of scope

- Changing CSS account or OIDC endpoints.
- Changing password recovery/reset pages.
- Changing provider selection in `AuthBoundary`.
- Copying Linx application-local JSX into Xpod.
