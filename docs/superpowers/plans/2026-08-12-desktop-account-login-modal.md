# Desktop Account Login Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh Xpod desktop launch show the public Account credentials modal over Status Overview, complete CSS Account login inside Electron, and remain on the same Dashboard route.

**Architecture:** Reuse `@undefineds.co/shared-ui`'s complete `AccountCredentialsSurface`, which owns one controlled `AuthSurface` frame around a frame-free `AccountCredentialsView`. Add one Xpod host controller for CSS password submission and Account-token persistence, then compose the same public surface from the Account route boundary and anonymous Avatar card. Keep Account and WebID sessions independent; local Network and Settings remain unguarded.

**Tech Stack:** TypeScript, React 19, React Router, shared-ui, CSS Account API, Bun/Vitest, Playwright Electron.

**Design source:** `docs/superpowers/specs/2026-08-10-xpod-auth-boundaries-design.md`

---

### Task 1: Finish the requested shared-login branch integration

**Files:**
- Merge source: `codex/ai-provider-pool` at `8ae72d7f`
- Verify: `packages/shared-ui/src/auth-surface.tsx`
- Verify: `packages/shared-ui/src/account-auth.tsx`
- Verify: `packages/shared-ui/test/auth-surface.test.tsx`
- Verify: `packages/shared-ui/test/account-auth.test.tsx`

- [x] **Step 1: Resolve the active merge by responsibility**

Preserve the current rail/list/content IA and incoming public authentication implementation. Resolve source conflicts semantically; regenerate hashed `static/` assets from source instead of hand-merging bundles.

- [x] **Step 2: Prove the public views build and pass**

Run:

```bash
bun run --cwd packages/shared-ui test -- test/auth-surface.test.tsx test/account-auth.test.tsx
bun run --cwd packages/shared-ui build
```

Expected: both focused suites pass and the package exports `AuthSurface`, `AuthSurfaceMode`, `AccountCredentialsView`, `AccountCredentialsSurface`, and their prop contracts.

- [x] **Step 3: Complete the merge commit**

Commit only after `git diff --check` reports no conflict markers or whitespace errors. Use a Lore-format merge message and record the focused verification.

### Task 2: Add one host-owned Account credentials controller

**Files:**
- Create: `ui/src/auth/XpodAccountCredentials.tsx`
- Create: `ui/src/auth/XpodAccountCredentials.test.tsx`
- Reuse: `ui/src/utils/registration-flow.ts`
- Reuse: `ui/src/utils/account-session.ts`

- [x] **Step 1: Write the failing controller tests**

Cover these observable requirements:

```tsx
render(<XpodAccountCredentials surface="modal" onAuthenticated={onAuthenticated} />)
expect(screen.getByRole('dialog', { name: 'Sign in to Xpod' })).toBeTruthy()
fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'test@dev.local' } })
fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test123456' } })
fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!)
await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
expect(window.location.pathname).toBe('/status/overview')
```

The fetch mock must assert same-origin CSS Account password login, `credentials: 'include'`, storage of the returned `CSS-Account-Token`, and `refetchControls()` before `onAuthenticated`. Add 401 and duplicate-submit cases; errors remain inline and no navigation API is called.

- [x] **Step 2: Run the test and confirm it is red**

Run:

```bash
bun run --cwd ui test -- src/auth/XpodAccountCredentials.test.tsx
```

Expected: FAIL because `XpodAccountCredentials` does not exist.

- [x] **Step 3: Implement the controlled host controller**

Create this public host-facing shape:

```ts
export interface XpodAccountCredentialsProps {
  surface: 'modal' | 'embedded'
  onAuthenticated?: () => void
  onClose?: () => void
}
```

Render the public `AccountCredentialsSurface` in login mode and supply only Xpod's host-owned submission controller. Submit through `loginAccountPassword`, call `storeAccountSessionToken`, await `auth.refetchControls()`, verify the refreshed Account session is authenticated, then call `onAuthenticated`. Map 401/403 to `Invalid email or password`, 429 to a retry-later message, and every other error to a safe generic message. Never set `window.location`, call `navigate`, or start Solid OIDC from this controller.

- [x] **Step 4: Run the focused tests**

Run:

```bash
bun run --cwd ui test -- src/auth/XpodAccountCredentials.test.tsx
```

Expected: PASS.

### Task 3: Compose the modal from Account routes and the Avatar card

**Files:**
- Modify: `ui/src/auth/AccountAuthBoundary.tsx`
- Modify: `ui/src/auth/AccountAuthBoundary.test.tsx`
- Modify: `ui/src/layout/XpodUserCard.tsx`
- Modify: `ui/src/layout/XpodUserCard.test.tsx`

- [x] **Step 1: Write failing boundary and Avatar tests**

For an anonymous Account state, assert that `AccountAuthBoundary` immediately renders `role="dialog"` with the credentials fields and does not render a password URL or call `location.assign`. For the Avatar, assert that opening the user card while anonymous exposes the same credentials controller and successful authentication closes it. Preserve authenticated Account/Pod actions and combined logout tests.

- [x] **Step 2: Run the tests and confirm the old navigation behavior fails**

Run:

```bash
bun run --cwd ui test -- src/auth/AccountAuthBoundary.test.tsx src/layout/XpodUserCard.test.tsx
```

Expected: FAIL because the boundary currently renders a login-method view and the Avatar calls `startLogin()`.

- [x] **Step 3: Replace navigation with shared modal composition**

Anonymous `AccountAuthBoundary` renders `<XpodAccountCredentials surface="modal" />`. The anonymous Avatar dialog renders `<XpodAccountCredentials surface="embedded" onAuthenticated={() => setOpen(false)} />`. Account initialization and retryable error states remain deterministic. Do not change WebID-protected route behavior.

- [x] **Step 4: Run the focused tests**

Run the command from Step 2. Expected: PASS.

### Task 4: Make the desktop start on the Account-protected Overview

**Files:**
- Modify: `desktop/src/target-url.ts`
- Modify: `desktop/test/target-url.test.ts`

- [x] **Step 1: Change the existing expectation first**

```ts
expect(resolveDesktopTargetUrl({ argv: ['electron', 'main.js'], env: {} }))
  .toBe('http://127.0.0.1:3000/status/overview')
```

- [x] **Step 2: Run the red test**

Run:

```bash
bun test desktop/test/target-url.test.ts
```

Expected: FAIL with `/network/overview` received.

- [x] **Step 3: Change only the default target**

Set `DEFAULT_DESKTOP_URL` to `http://127.0.0.1:3000/status/overview`. Preserve CLI and environment override precedence.

- [x] **Step 4: Run the test again**

Expected: PASS.

### Task 5: Rebuild and verify the real Electron login loop

**Files:**
- Generated by build: `static/dashboard/**`
- Generated by build: `static/settings/**`
- Verify: `desktop/dist/**`

- [x] **Step 1: Run source verification and regenerate assets**

```bash
bun run --cwd packages/shared-ui build
bun run --cwd ui test -- src/auth/XpodAccountCredentials.test.tsx src/auth/AccountAuthBoundary.test.tsx src/layout/XpodUserCard.test.tsx
bun test desktop/test/target-url.test.ts
bun run build:ui
bun run --cwd desktop build
git diff --check
```

Expected: all commands pass and no unmerged paths remain.

- [x] **Step 2: Run Electron acceptance against the bundled runtime**

Launch Electron through Playwright with `XPOD_RUNTIME_COMMAND=/Users/ganlu/develop/xpod/desktop/runtime/xpod`. Clear only the Electron page's Account session storage, load the default route, and assert:

```text
before submit: URL = http://127.0.0.1:3000/status/overview
before submit: visible dialog = Sign in to Xpod
after submit:  URL = http://127.0.0.1:3000/status/overview
after submit:  login dialog absent
external browser hand-offs = 0
```

Use `test@dev.local / test123456`. Reload once and assert the Account Session restores without showing the modal.

- [x] **Step 3: Run repository regression gates**

```bash
bun run build:ts
bun run test:integration
```

Expected: PASS. If an unrelated pre-existing failure remains, record the exact command, test, and evidence rather than weakening the acceptance.

- [x] **Step 4: Complete the implementation commit**

Stage only the login controller, boundary, Avatar, desktop target, tests, spec/plan, and build-generated files. Inspect `git diff --cached` before committing with the Lore protocol.

### Task 6: Close final review gaps and validate the installable artifact

**Files:**
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/DashboardApp.test.tsx`
- Modify: `ui/src/layout/XpodUserCard.tsx`
- Modify: `ui/src/layout/XpodUserCard.test.tsx`
- Modify: `ui/src/auth/XpodAccountCredentials.test.tsx`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/tray-menu.ts`
- Modify: `desktop/test/tray-menu.test.ts`
- Regenerate: `static/**`
- Package: `desktop/release/Xpod-0.1.0-arm64.dmg`

- [x] **Step 1: Keep the Status workspace mounted under the modal**

Move the Account boundary to the nested Status content outlet so anonymous users retain the Status list and header while the public Account modal overlays the shell. Capture a route-level red/green regression test.

- [x] **Step 2: Keep Account switching out of WebID/OIDC**

The user-card `Use a different account` action coordinates logout, resets the completed logout transaction, keeps the card open, and exposes embedded Account credentials. It must not call `switchAccount`, `startLogin`, runtime login, navigation, or any OIDC path. Replace the tray's direct `/.account/` switch action with an `Account…` route that opens the same user card over Status Overview.

- [x] **Step 3: Lock the no-navigation invariant**

Extend the Account credentials test to prove that successful same-origin password login preserves the Status Overview URL and does not call the WebID login controller.

- [x] **Step 4: Repeat source, Electron, integration, and package verification**

Rebuild generated assets/runtime, exercise the real anonymous/login/reload/Avatar flow against Electron, run the full integration suite, and regenerate the DMG only after all review fixes pass.

### Task 7: Close the local-Xpod trust and desktop bridge gaps

**Files:**
- Modify: `desktop/src/target-url.ts`
- Modify: `desktop/test/target-url.test.ts`
- Modify: `desktop/src/tray-menu.ts`
- Modify: `desktop/test/tray-menu.test.ts`
- Modify: `packages/shared-ui/src/account-auth.tsx`
- Modify: `packages/shared-ui/test/account-auth.test.tsx`
- Create: `ui/src/desktop/XpodDesktopIdentityBridge.tsx`
- Create: `ui/src/desktop/XpodDesktopIdentityBridge.test.tsx`
- Modify: `ui/src/auth/XpodAuthProvider.tsx`
- Modify: `ui/src/auth/XpodAccountCredentials.tsx`
- Modify: `ui/src/auth/AccountAuthBoundary.tsx`
- Modify: `ui/src/auth/AccountAuthBoundary.test.tsx`
- Modify: `ui/src/context/AuthContext.tsx`
- Modify: `ui/src/auth/AuthContext.test.tsx`
- Modify: `ui/src/auth-callback-navigation.ts`
- Modify: `ui/src/auth-callback-navigation.test.ts`
- Modify: `ui/src/auth-callback.tsx`
- Modify: `ui/src/solid/XpodSolidRuntime.ts`
- Modify: `ui/src/solid/XpodSolidRuntimeProvider.tsx`
- Modify: `ui/src/solid/XpodSolidRuntimeProvider.test.tsx`
- Modify: `ui/vite.config.ts`
- Modify: `src/api/auth/CssAccountTokenResolver.ts`
- Modify: `tests/api/auth/CssAccountTokenResolver.test.ts`
- Modify: `src/api/container/common.ts`
- Regenerate: `static/**`
- Package: `desktop/release/Xpod-0.1.0-arm64.dmg`

- [x] **Step 1: Write failing public-surface and local-trust tests**

Prove that the public Account surface renders exactly one Card/dialog frame, the startup modal can be dismissed and reopened without exposing protected content, external `--url`/`XPOD_DESKTOP_URL` values cannot become the desktop trust origin, a cross-origin Account logout control receives no token-bearing request, an external restored OIDC issuer/WebID is cleared, and a CSS cookie whose Account no longer exists cannot create an API Account principal.

- [x] **Step 2: Write the failing tray production-bridge tests**

Prove that `Account…` exists even while anonymous and always targets `/status/overview?account=open`. Mount the real Xpod auth composition with a fake preload bridge and assert authenticated Account/WebID/Pod state reaches `setIdentity`, then assert logout publishes `null`.

- [x] **Step 3: Implement the complete public modal and minimum current-Xpod enforcement**

Compose the Account credentials body and `AuthSurface` once in the public UI package and consume it from Xpod; keep dismissed Status content protected while leaving the rail usable; choose the first safe loopback desktop target in CLI/environment/default precedence; reuse one same-origin Account-control validator for login and logout; reject and clear non-local restored Solid sessions before Pod readiness; validate Account existence after resolving a CSS cookie; and mount one renderer-to-preload identity bridge inside `XpodAuthProvider`.

- [x] **Step 4: Close callback and production login escapes**

Keep every canonical same-origin product route (`/dashboard`, `/status`, `/network`, `/settings`, `/ai-config`, `/ai-connections`) inside the callback document and render the matching app bundle there. Keep the bundled Inrupt diagnostic only as a current-Xpod verifier: its issuer, WebID, Pod URLs, and fetch targets must stay on the current origin. Keep arbitrary WebID-link controls out of Xpod product surfaces without deleting generic CSS/public-library capability.

- [x] **Step 5: Run focused red/green verification**

Run the desktop target/tray suites, Account controller suite, the dedicated previously-excluded Solid runtime-provider suite, CSS token resolver suite, and the renderer bridge suite. Preserve the red failure evidence for each missing behavior, then require every focused command to exit zero after implementation.

- [x] **Step 6: Repeat browser, Electron, integration, build, and package acceptance**

Run the real shared-login Playwright scenarios, verify a fresh Electron window shows the Account modal over Status and never opens an external provider, verify tray Account opens the shared card, run package/root/type/lint/integration gates, rebuild runtime/static assets, regenerate the DMG, and smoke the packaged app before committing.

### Task 8: Serve first-class product routes without legacy rewrites

**Files:**
- Modify: `src/api/handlers/SettingsHandler.ts`
- Modify: `src/shared/xpod-route-policy.ts`
- Modify: `tests/api/handlers/SettingsHandler.test.ts`
- Modify: `tests/api/handlers/xpod-route-policy.test.ts`
- Verify: `tests/e2e/shared-login.spec.ts`

- [x] **Step 1: Lock the canonical route regression**

Change the Settings handler tests so `/ai-config/model-assignments?surface=providers` and `/ai-connections` are served by the Settings SPA while preserving their canonical browser paths. Confirm the old redirect to `/settings/models?surface=...` fails the new expectation.

- [x] **Step 2: Remove the obsolete canonical-to-legacy alias policy**

Register `/settings`, `/ai-config`, and `/ai-connections` as independent static SPA prefixes backed by the same Settings bundle. Keep only genuine legacy Dashboard aliases in the shared server route policy; do not rewrite either first-class AI rail entry to `/settings/models`.

- [x] **Step 3: Re-run the callback acceptance**

Run the focused handler tests and the real browser scenario that starts WebID login at `/ai-config/model-assignments?surface=providers`. Require the callback to remain on that exact path and query, then run the complete shared-login spec.
