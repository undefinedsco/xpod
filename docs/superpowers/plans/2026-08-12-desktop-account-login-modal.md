# Desktop Account Login Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh Xpod desktop launch show the public Account credentials modal over Status Overview, complete CSS Account login inside Electron, and remain on the same Dashboard route.

**Architecture:** Reuse `@undefineds.co/shared-ui`'s controlled `AuthSurface` and `AccountCredentialsView`. Add one Xpod host controller for CSS password submission and Account-token persistence, then compose it from the Account route boundary and anonymous Avatar card. Keep Account and WebID sessions independent; local Network and Settings remain unguarded.

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

Expected: both focused suites pass and the package exports `AuthSurface`, `AuthSurfaceMode`, `AccountCredentialsView`, and their prop contracts.

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

Render `AuthSurface` plus `AccountCredentialsView` in login mode. Submit through `loginAccountPassword`, call `storeAccountSessionToken`, await `auth.refetchControls()`, then call `onAuthenticated`. Map 401/403 to `Invalid email or password`, 429 to a retry-later message, and every other error to a safe generic message. Never set `window.location`, call `navigate`, or start Solid OIDC from this controller.

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
