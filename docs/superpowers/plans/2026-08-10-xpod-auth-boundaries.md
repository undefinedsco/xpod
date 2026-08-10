# Xpod Authentication Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Xpod account, local-runtime, and Solid WebID features through independent authorization boundaries.

**Architecture:** Reuse the existing CSS `AuthProvider` for Account state and the existing `XpodSolidRuntimeProvider` for WebID state. Route helpers declare one boundary per content subtree; local-runtime routes render without login and rely on existing API capability enforcement.

**Tech Stack:** React 19, React Router, CSS account controls, Inrupt Solid OIDC, Vitest, Bun test.

---

### Task 1: Account boundary for Status

**Files:**
- Create: `ui/src/auth/AccountBoundary.tsx`
- Create: `ui/src/auth/AccountBoundary.test.tsx`
- Modify: `ui/src/DashboardApp.tsx`
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/DashboardApp.test.tsx`

- [x] Write a failing test proving anonymous Status persists its return route and redirects to `/.account/login/password/`, while authenticated Account state renders Status without requiring WebID.
- [x] Run `bunx vitest run ui/src/auth/AccountBoundary.test.tsx ui/src/DashboardApp.test.tsx` and confirm the missing boundary behavior fails.
- [x] Implement `AccountBoundary` with `useAuth`, `persistReturnTo`, and `Navigate`; mount `AuthProvider` above Dashboard routes; replace the WebID guard on Status only.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Explicit WebID and local-host route helpers

**Files:**
- Create: `ui/src/auth/WebIdBoundary.tsx`
- Create: `ui/src/auth/access-policy.ts`
- Create: `ui/src/auth/access-policy.test.ts`
- Modify: `ui/src/settings-routes.tsx`
- Modify: `ui/src/settings-routes.test.tsx`
- Modify: `ui/src/dashboard-routes.tsx`

- [x] Write failing table-driven tests for `/network/*` and local Settings subjects requiring `local-host`, and Pod/AI subjects requiring `webid`.
- [x] Run the focused tests and confirm current global WebID guarding fails.
- [x] Rename the reusable Solid guard to `WebIdBoundary`, add typed route-policy lookup, remove guards from Network/local Settings routes, and retain WebID guards only around Pod-owned routes.
- [x] Re-run the focused tests and confirm they pass.

### Task 3: Anonymous local Network data path

**Files:**
- Modify: `ui/src/pages/settings/NetworkPage.tsx`
- Modify: `ui/src/pages/settings/NetworkPage.test.tsx`
- Modify: `ui/src/api/network-settings.ts`
- Modify: `src/api/handlers/NetworkSettingsHandler.ts`
- Modify: `tests/api/handlers/NetworkSettingsHandler.test.ts`

- [x] Write failing UI and handler tests proving loopback/local-host Network status works without a WebID and remote mutation remains capability-gated.
- [x] Run both focused suites and confirm they fail for the missing anonymous local path.
- [x] Resolve the Network API from `window.location.origin` when no Pod is selected, use ordinary credentialed fetch for local-host requests, and preserve server-side mutation authorization.
- [x] Re-run the focused tests and confirm they pass.

### Task 4: Separate Account and Solid identity in the user card

**Files:**
- Modify: `ui/src/layout/XpodUserCard.tsx`
- Modify: `ui/src/layout/XpodUserCard.test.tsx`
- Modify: `ui/src/DashboardApp.tsx`
- Modify: `ui/src/SettingsApp.tsx`

- [x] Write failing tests proving Account and Solid state are labelled separately and their logout actions do not clear the other session.
- [x] Run the user-card suite and confirm the combined identity presentation fails.
- [x] Read Account context optionally, render separate Account and Solid sections, and expose separate actions while keeping the card usable in applet/WebID-only hosts.
- [x] Re-run the focused suite and confirm it passes.

### Task 5: Regression and packaging verification

**Files:**
- Modify generated UI assets through existing build scripts only.

- [x] Run `bun run test:packages`.
- [x] Run `(cd ui && bun test)` and the Vitest UI file group.
- [x] Run `bun run build`.
- [x] Run `bun run test:integration`.
- [x] Run `bun test && bun run dist` in `desktop/`, then packaged smoke and `hdiutil verify`.
- [x] Run `git diff --check` and document any unsigned/notarized distribution limitation.

## Final Acceptance Evidence

- Root Vitest: 409 files total, 373 passed and 36 skipped; 3635 tests total, 3368 passed and 267 skipped.
- Desktop tests: 19/19 passed.
- Packages tests: 226/226 passed.
- Network focused tests: 17/17 passed.
- UI lint and typecheck passed.
- Manual/package acceptance verified Account, WebID, and local-host authorization boundaries independently:
  - Status uses the Xpod Account boundary.
  - Network and local runtime surfaces remain reachable through the local-host boundary.
  - Pod-owned and AI model-assignment surfaces retain WebID ownership boundaries.
- Packaged smoke coverage confirmed canonical rail behavior, diagnostic API behavior, native 3/3 tray actions, and quit cleanup.
- Apple Silicon developer artifacts were validated: DMG SHA256 `8ea366581eeee8029c80b20b87e3b3cdd233573eab330a6ec5e7eb7530b2f2e7` with `hdiutil verify` valid, and ZIP SHA256 `db4cacae782b5c48cd93e9c5f090cae52664dfe168c1591c5bf430d348d6a57c`.
- Distribution limitation: artifacts are unsigned and not notarized; do not present them as signed release-ready builds.
