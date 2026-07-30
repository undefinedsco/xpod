# Xpod Lightweight Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Xpod independently usable through a lightweight settings application with Models, Pod, Network, and Services, backed by the real Solid session, Pod data, AI Gateway, and host capabilities.

**Architecture:** Publishable `@undefineds.co` packages in the Linx monorepo own the shared SDK, UI tokens, Solid runtime, and AI Connection applet. Xpod's existing `ui/` becomes a host that supplies one Solid session plus Xpod management capabilities and renders the shared applet beside native Pod/Network/Services applets. The existing Pod AI Gateway plan remains the authoritative backend plan and is completed before the UI is called product-ready.

**Tech Stack:** React 19, TypeScript 5.9/6, Vite, Bun, Inrupt Solid OIDC, drizzle-solid, `@undefineds.co/models`, Extension SDK, Vitest, Playwright, Xpod API Server.

---

## Repository and delivery map

This delivery has three independently committed lanes:

- `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway`
  - Make `@undefineds.co/shared-ui`, `@undefineds.co/solid-sdk`, `@undefineds.co/extension-sdk`, and `@undefineds.co/ai-connection` publishable.
  - Finish AI Connection's production host capability contract.
- `/Users/ganlu/develop/.worktrees/xpod-light-settings`
  - Complete `docs/superpowers/plans/2026-07-23-pod-ai-gateway.md`.
  - Implement the lightweight settings host and Xpod capabilities.
- `/Users/ganlu/develop/models` in an isolated worktree created by the Gateway plan
  - Complete the shared credential, access-key, and quota resources defined by Gateway Tasks 1–2.

Do not import source through absolute `file:` dependencies. Xpod must consume packed package artifacts exactly as a registry consumer would. During local development, use `npm pack`/`bun pm pack` artifacts stored under `.test-data/package-tarballs/`; production manifests use normal semver versions.

## Completion order

1. Package the already reviewed shared SDK.
2. Execute all unchecked tasks in `2026-07-23-pod-ai-gateway.md`.
3. Build the Xpod settings host and native applets.
4. Mount AI Connection against real Xpod capabilities.
5. Prove the product with browser, Pod, protocol, client, and full regression tests.

### Task 1: Make the shared applet packages registry-consumable

**Files:**
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/solid-sdk/package.json`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/shared-ui/package.json`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/extension-sdk/package.json`
- Modify: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/packages/ai-connection-extension/package.json`
- Modify: imports under the four packages from `@linx/solid-sdk` to `@undefineds.co/solid-sdk`
- Create: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/scripts/pack-applet-sdk.mjs`
- Create: `/Users/ganlu/develop/.worktrees/linx-pod-ai-gateway/tests/package/applet-packages.test.mjs`

- [ ] **Step 1: Add a failing packed-consumer test**

Create a temporary project, pack all four packages, install only the tarballs plus React, and compile this consumer:

```ts
import { defineAppletLayout } from '@undefineds.co/extension-sdk';
import { AppLayout, AuthBoundary, TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { createAiConnectionExtension } from '@undefineds.co/ai-connection';
import { SolidRuntimeProvider } from '@undefineds.co/solid-sdk/react';

void defineAppletLayout({ type: 'two-pane' });
void AppLayout;
void AuthBoundary;
void TwoPaneLayout;
void createAiConnectionExtension;
void SolidRuntimeProvider;
```

- [ ] **Step 2: Run the consumer test and record the failure**

Run:

```bash
cd /Users/ganlu/develop/.worktrees/linx-pod-ai-gateway
node --test tests/package/applet-packages.test.mjs
```

Expected: FAIL because packages are private, exports point at source, and `@linx/solid-sdk` is not available to an external consumer.

- [ ] **Step 3: Normalize package identity and build output**

Rename `@linx/solid-sdk` to `@undefineds.co/solid-sdk`. Set `private: false`, add `files: ["dist", "README.md"]`, and point `exports` at built JavaScript and declarations. Keep React as a peer dependency:

```json
{
  "name": "@undefineds.co/extension-sdk",
  "version": "0.1.0",
  "files": ["dist", "README.md"],
  "peerDependencies": { "react": "^19.2.0" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./react": { "types": "./dist/react.d.ts", "import": "./dist/react.js" },
    "./web": { "types": "./dist/web.d.ts", "import": "./dist/web.js" }
  }
}
```

Use equivalent explicit exports for each package. Do not expose repository source paths.

- [ ] **Step 4: Build and pack**

Run:

```bash
yarn workspace @undefineds.co/solid-sdk build
yarn workspace @undefineds.co/shared-ui build
yarn workspace @undefineds.co/extension-sdk build
yarn workspace @undefineds.co/ai-connection build
node scripts/pack-applet-sdk.mjs
```

Expected: four tarballs under `.test-data/package-tarballs/`, with no source-only or workspace-only dependency.

- [ ] **Step 5: Re-run package tests**

Run:

```bash
node --test tests/package/applet-packages.test.mjs
yarn workspace @undefineds.co/extension-sdk test
yarn workspace @undefineds.co/ai-connection test
```

Expected: PASS.

- [ ] **Step 6: Commit only the packaging lane**

Use a Lore commit explaining why package names and exports are now host-neutral.

### Task 2: Complete the Pod AI Gateway backend plan

**Files:**
- Execute every unchecked file and test listed in:
  - `/Users/ganlu/develop/.worktrees/xpod-light-settings/docs/superpowers/plans/2026-07-23-pod-ai-gateway.md`
- Update the checklist in that plan as each task is verified.

- [ ] **Step 1: Audit the 15 Gateway tasks against current repositories**

For each task, record `done`, `partial`, or `missing` from code and tests. A task is not `done` merely because the design or plan exists.

- [ ] **Step 2: Execute Gateway Tasks 1–2**

Implement shared `@undefineds.co/models` Credential, Gateway Access Key, and Quota Snapshot resources with exact-ID and Pod integration tests.

- [ ] **Step 3: Execute Gateway Tasks 3–8**

Implement protocol frontends, envelope encryption, principal/authentication, Pod repositories, Gateway keys, and model routing. Run each focused test command from the Gateway plan after its red/green cycle.

- [ ] **Step 4: Execute Gateway Tasks 9–12**

Implement five provider runtime adapters, the approved Connect matrix, quota adapters, and `/v1/models`, `/v1/responses`, `/v1/messages`, `/v1/chat/completions`.

- [ ] **Step 5: Execute Gateway Tasks 13–14**

Implement Linx/Xpod management capability and Codex, Claude Code, Pi, CodeBuddy configuration adapters with backup, plan, apply, verify, restore, and symlink safety.

- [ ] **Step 6: Execute Gateway Task 15**

Run protocol fixtures, Pod isolation/encryption, provider contracts, client configuration tests, full Xpod integration, and the real Codex streaming/tool-call gate. Store only redacted evidence in `.test-data/ai-gateway-acceptance/`.

- [ ] **Step 7: Commit each Gateway task independently**

Follow the commit boundary and exact verification command already specified in the Gateway plan. Do not collapse the backend into one unreviewable commit.

### Task 3: Install the packed SDK into Xpod UI

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/bun.lock`
- Modify: `ui/tsconfig.app.json`
- Modify: `ui/vite.config.ts`
- Create: `tests/ui/packaged-sdk-consumer.test.ts`

- [ ] **Step 1: Write a failing consumer boundary test**

Assert `ui/package.json` uses semver package names and contains no `file:/Users/`, workspace root, or Linx source import:

```ts
expect(pkg.dependencies['@undefineds.co/extension-sdk']).toMatch(/^\^?0\./);
expect(JSON.stringify(pkg)).not.toContain('/Users/');
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
bun run test -- tests/ui/packaged-sdk-consumer.test.ts
```

Expected: FAIL because the dependencies do not exist.

- [ ] **Step 3: Install local packed artifacts for development**

Use the tarballs from Task 1 to resolve and lock the exact package contents, then normalize `ui/package.json` back to semver before commit. Configure Vite to consume ESM output, not Linx source.

- [ ] **Step 4: Build UI**

Run:

```bash
cd ui
bun run build:dashboard
```

Expected: PASS without unresolved `@linx/*` imports or duplicate React.

- [ ] **Step 5: Commit manifest, lockfile, and consumer test**

Do not commit `.test-data/package-tarballs`.

### Task 4: Replace the admin shell with the SDK AppLayout

**Files:**
- Create: `ui/src/layout/XpodSettingsLayout.tsx`
- Create: `ui/src/layout/settings-navigation.ts`
- Modify: `ui/src/DashboardApp.tsx`
- Modify: `ui/src/pages/admin/AdminLayout.tsx`
- Modify: `ui/src/index.css`
- Test: `ui/src/layout/XpodSettingsLayout.test.tsx`
- Test: `ui/src/DashboardApp.test.tsx`

- [ ] **Step 1: Write failing route and landmark tests**

Assert the four primary links, header search, one `main` landmark, and route redirects:

```tsx
expect(screen.getByRole('link', { name: 'Models' })).toHaveAttribute('href', '/dashboard/models');
expect(screen.getByRole('link', { name: 'Pod' })).toBeVisible();
expect(screen.getByRole('link', { name: 'Network' })).toBeVisible();
expect(screen.getByRole('link', { name: 'Services' })).toBeVisible();
expect(screen.getAllByRole('main')).toHaveLength(1);
```

- [ ] **Step 2: Run the tests**

Run:

```bash
cd ui
bunx vitest run src/layout/XpodSettingsLayout.test.tsx src/DashboardApp.test.tsx
```

Expected: FAIL because the new layout and routes are missing.

- [ ] **Step 3: Implement host navigation**

Render SDK `AppLayout` with an Xpod product label, a header search input, and four settings entries. `AdminLayout` becomes a compatibility wrapper or is deleted after all legacy routes move. Route `/dashboard` to `/dashboard/models`.

- [ ] **Step 4: Preserve legacy URLs**

Redirect:

- `/dashboard/status` → `/dashboard/services`
- `/dashboard/logs` → `/dashboard/services/logs`
- `/dashboard/rdf` → `/dashboard/services/rdf`
- `/dashboard/settings` → `/dashboard/services/runtime`

- [ ] **Step 5: Run component and dashboard builds**

Run:

```bash
cd ui
bunx vitest run src/layout/XpodSettingsLayout.test.tsx src/DashboardApp.test.tsx
bun run build:dashboard
```

Expected: PASS.

- [ ] **Step 6: Commit the host shell**

Stage only layout, routes, styles, and their tests.

### Task 5: Consolidate Xpod into one Solid runtime

**Files:**
- Create: `ui/src/solid/XpodSolidRuntimeProvider.tsx`
- Create: `ui/src/solid/useXpodSolidRuntime.ts`
- Modify: `ui/src/context/AuthContext.tsx`
- Modify: `ui/src/dashboard.tsx`
- Create: `ui/src/pages/settings/SettingsAuthBoundary.tsx`
- Test: `ui/src/solid/XpodSolidRuntimeProvider.test.tsx`
- Test: `ui/src/pages/settings/SettingsAuthBoundary.test.tsx`

- [ ] **Step 1: Write failing singleton-session tests**

Mock Inrupt `Session` construction and assert one instance survives route changes. Assert redirect handling runs once and `useXpodSolidRuntime()` exposes:

```ts
{
  state: 'loading' | 'anonymous' | 'authenticated' | 'error',
  webId?: string,
  issuer?: string,
  podUrl?: string,
  fetch?: typeof fetch,
  login(issuer: string): Promise<void>,
  logout(): Promise<void>
}
```

- [ ] **Step 2: Run the focused tests**

Expected: FAIL because Dashboard currently uses account controls rather than the shared Solid runtime.

- [ ] **Step 3: Implement one provider**

Create one browser `Session`, call `handleIncomingRedirect` once, derive WebID and Pod from session/profile, and map state into SDK `AuthBoundary`. Keep existing account-control auth only for account-management routes outside the settings app.

- [ ] **Step 4: Remove duplicate runtime hooks**

Settings applets consume only `useXpodSolidRuntime`. Do not expose a separate `useSession` hook and do not persist browser Bearer/DPoP as a server fallback.

- [ ] **Step 5: Verify redirect, expiry, and logout**

Run focused tests covering anonymous login, redirect recovery, authenticated fetch, token refresh error mapping, and logout.

- [ ] **Step 6: Commit the session boundary**

Record the single-session invariant in the Lore `Directive` trailer.

### Task 6: Mount the real AI Connection applet

**Files:**
- Create: `ui/src/extensions/ai-connection-host.tsx`
- Create: `ui/src/pages/settings/ModelsPage.tsx`
- Create: `ui/src/api/ai-connection.ts`
- Modify: `ui/src/DashboardApp.tsx`
- Test: `ui/src/extensions/ai-connection-host.test.tsx`
- Test: `ui/src/pages/settings/ModelsPage.test.tsx`
- Test: `tests/ui/ai-connection-api-contract.test.ts`

- [ ] **Step 1: Add failing capability and UI tests**

Assert five providers, independent `configured`/`connected` status, browser/API-key actions, quota `unsupported`, structured errors, and no product mock data.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cd ui
bunx vitest run src/extensions/ai-connection-host.test.tsx src/pages/settings/ModelsPage.test.tsx
cd ..
bun run test -- tests/ui/ai-connection-api-contract.test.ts
```

- [ ] **Step 3: Implement the Xpod host capabilities**

Build `WebExtensionHost` from the one Solid runtime:

```ts
const host = {
  session: runtime,
  pod: { fetch: runtime.fetch, webId: runtime.webId, podUrl: runtime.podUrl },
  navigation: { openExternal, history },
  aiConnection: createXpodAiConnectionCapability(apiClient),
  aiClientConfiguration: createXpodClientConfigurationCapability(apiClient),
};
```

The page mounts `createAiConnectionExtension()` through `mountApplet()` and renders its descriptor with SDK layouts. Do not reproduce provider forms in Xpod.

- [ ] **Step 4: Connect to real management routes**

Map list/save/delete/connect/status/quota/models/Gateway-key calls to the Gateway management API delivered by Task 2. Parse all errors as JSON `GatewayError`; reject HTML 500 bodies as a contract failure.

- [ ] **Step 5: Verify API Key persistence**

With an authenticated test Pod, save a provider API key, reload the page, verify the credential returns masked metadata only, then delete it and verify the resource is gone. Inspect Pod serialization and assert the plaintext does not occur.

- [ ] **Step 6: Verify browser Connect states**

For OpenAI, Anthropic, Kimi, and Bailian, test start → pending → complete/expired/not_configured. For DeepSeek, assert browser Connect is `unsupported` and API Key remains enabled.

- [ ] **Step 7: Commit Models integration**

Stage only the host capability, Models page, API client, and tests.

### Task 7: Implement the Pod settings applet

**Files:**
- Create: `ui/src/pages/settings/PodPage.tsx`
- Create: `ui/src/api/pod-settings.ts`
- Create: `ui/src/pages/settings/components/IdentityCard.tsx`
- Create: `ui/src/pages/settings/components/PodUsageCard.tsx`
- Test: `ui/src/pages/settings/PodPage.test.tsx`
- Test: `tests/ui/pod-settings-api.test.ts`

- [ ] **Step 1: Write failing real-data tests**

Assert the page renders WebID, Pod URL, issuer, session state, storage usage/limit, AI settings container health, and last sync from capability responses.

- [ ] **Step 2: Implement read-only status first**

Use authenticated fetch and existing quota/usage APIs. Resolve the Pod URL from the runtime/profile, never from a local/cloud branch.

- [ ] **Step 3: Add actions**

Add `Open Pod`, `Refresh`, `Log out`, and `Log in again`. Destructive Pod data operations are outside this page.

- [ ] **Step 4: Test unsupported and partial data**

Missing usage capability renders `unsupported`; it must not invent zero usage.

- [ ] **Step 5: Run tests/build and commit**

Run the focused UI/API tests and `bun run build:dashboard`.

### Task 8: Implement the Network settings applet

**Files:**
- Create: `src/api/handlers/NetworkSettingsHandler.ts`
- Modify: `src/api/container/routes.ts`
- Create: `ui/src/api/network-settings.ts`
- Create: `ui/src/pages/settings/NetworkPage.tsx`
- Test: `tests/api/handlers/NetworkSettingsHandler.test.ts`
- Test: `ui/src/pages/settings/NetworkPage.test.tsx`

- [ ] **Step 1: Write a failing capability-shaped API test**

Require a response that self-describes operations:

```ts
{
  endpoint: string,
  addresses: { local: string[], lan: string[], public: string[] },
  tls: { supported: boolean, status: string, expiresAt?: string },
  dns: { supported: boolean, status: string },
  tunnel: { supported: boolean, status: string },
  actions: { diagnose: true, renewCertificate: boolean }
}
```

- [ ] **Step 2: Implement the read model**

Compose existing reachability, detector, DNS, tunnel, and certificate services. Do not return `deployment` for UI branching.

- [ ] **Step 3: Add diagnose action**

Return structured per-check results and redact credentials, tokens, internal connection strings, and filesystem secrets.

- [ ] **Step 4: Render the Network page**

Show only actions enabled by the response. Use explicit unsupported states.

- [ ] **Step 5: Run handler/UI tests and commit**

Run the focused tests plus `bun run build:ts` and Dashboard build.

### Task 9: Implement the Services settings applet

**Files:**
- Create: `ui/src/pages/settings/ServicesPage.tsx`
- Create: `ui/src/pages/settings/services-navigation.ts`
- Modify: `ui/src/pages/admin/StatusPage.tsx`
- Modify: `ui/src/pages/admin/LogsPage.tsx`
- Modify: `ui/src/pages/admin/RdfPage.tsx`
- Modify: `ui/src/pages/admin/SettingsPage.tsx`
- Test: `ui/src/pages/settings/ServicesPage.test.tsx`

- [ ] **Step 1: Write failing navigation and action tests**

Assert Runtime, Logs, RDF, and Configuration are reachable inside Services, existing data APIs still load, and lifecycle actions appear only when capability says supported.

- [ ] **Step 2: Compose existing pages**

Move the current pages under Services routes without duplicating their fetch logic. Remove their old shell assumptions and nested `main` landmarks.

- [ ] **Step 3: Preserve polling cleanup**

Use one status poll owned by the Services subtree; assert intervals and pending requests are cleaned up on route exit.

- [ ] **Step 4: Run tests/build and commit**

Verify legacy redirects from Task 4 and all existing admin page tests.

### Task 10: Connect coding-client configuration

**Files:**
- Create: `src/api/handlers/AiClientConfigurationHandler.ts`
- Create: `src/api/service/AiClientConfigurationService.ts`
- Modify: `src/api/container/routes.ts`
- Create: `tests/api/handlers/AiClientConfigurationHandler.test.ts`
- Modify: `ui/src/api/ai-connection.ts`
- Test: `ui/src/pages/settings/ModelsPage.client-config.test.tsx`

- [ ] **Step 1: Write failing plan/apply/verify/restore tests**

Cover Codex, Claude Code, Pi, and CodeBuddy. Fixtures must contain existing unrelated configuration and prove it is preserved.

- [ ] **Step 2: Implement plan as a pure operation**

`plan` returns target files/stores, redacted changes, conflicts, backup location, and whether explicit replacement confirmation is required. It performs no writes.

- [ ] **Step 3: Implement apply with backup and rollback**

Reject unsafe symlinks, write only Xpod-managed fields, use the Gateway Key rather than Provider Credential, and restore on verification failure.

- [ ] **Step 4: Implement verify and restore**

Verify endpoint, `/v1/models`, and a minimal authenticated request. Restore removes only Xpod-managed fields.

- [ ] **Step 5: Wire Models UI**

Show detected/not-installed, preview, apply progress, verified, failed-and-restored, and manual instructions when the Xpod host lacks filesystem capability.

- [ ] **Step 6: Run handler/UI tests and commit**

Run all four client fixtures and security tests.

### Task 11: Add lightweight-host runtime and independent launch

**Files:**
- Modify: `package.json`
- Modify: `scripts/dev-start.sh`
- Create: `scripts/open-settings.mjs`
- Create: `tests/ui/settings-launch.test.ts`
- Modify: `docs/cli-dev-testing.md`

- [ ] **Step 1: Add a failing launch smoke**

Start the normal local Xpod runtime on an isolated test-data root, wait for `/dashboard/models`, and assert the settings HTML references the current built bundle.

- [ ] **Step 2: Add explicit commands**

Add:

```json
{
  "settings:dev": "cd ui && bun run dev:dashboard",
  "settings:open": "node scripts/open-settings.mjs",
  "settings:test": "bun run test -- tests/ui/settings-launch.test.ts"
}
```

`settings:open` uses the platform open command through a small tested adapter and never starts a second Xpod service.

- [ ] **Step 3: Verify packaged static serving**

Build Xpod, start it, open `/dashboard/models`, and confirm Models/Pod/Network/Services load from the bundled static directory.

- [ ] **Step 4: Document desktop-host boundary**

Document that a tray wrapper may call `settings:open` and provide `openExternal`/client-config capabilities; the web host remains fully usable without a second application.

- [ ] **Step 5: Commit launch support**

### Task 12: Product-level integration and visual verification

**Files:**
- Create: `tests/integration/XpodSettings.integration.test.ts`
- Create: `tests/e2e/xpod-settings.spec.ts`
- Create: `scripts/accept-xpod-settings.ts`
- Create: `docs/acceptance/xpod-light-settings.md`

- [ ] **Step 1: Add end-to-end fixtures without product mocks**

Start an isolated real Xpod, create two WebIDs/Pods, and use test-only upstream Provider servers at the adapter HTTP boundary. Do not intercept UI fetches with canned product JSON.

- [ ] **Step 2: Verify Solid and Pod isolation**

Log in as WebID A, create an API-key credential, reload, and confirm it persists. Log in as WebID B and confirm A's provider and Gateway Key are absent. Inspect A's Pod and assert the plaintext key is absent.

- [ ] **Step 3: Verify all four settings modules**

Exercise Models, Pod, Network, and Services at desktop and narrow widths. Capture screenshots and compare layout geometry, header search position, colors, spacing, hidden panes, focus, and back navigation with the SDK test host.

- [ ] **Step 4: Verify Connect matrix and quota**

Run contract-backed flows for OpenAI, Anthropic, Kimi, and Bailian; assert DeepSeek browser Connect unsupported; verify available/stale/unsupported quota states.

- [ ] **Step 5: Verify Gateway protocols and clients**

Run `/v1/models`, Responses, Messages, and Chat Completions, including SSE, tool call, usage, cancellation, and standardized errors. Apply and restore Codex, Claude Code, Pi, and CodeBuddy fixtures.

- [ ] **Step 6: Run the real Codex acceptance**

With a user-supplied valid Provider credential already stored through the UI and a created Gateway Key, run real Codex against Xpod for one streaming answer and one tool call. Save only redacted command/result metadata.

- [ ] **Step 7: Run complete regression**

Run:

```bash
bun run build:ts
bun run build:components
bun run build:ui
bun run test
bun run test:integration
cd ui && bun run lint && bun run build:all
```

In the Linx worktree run all four package builds/tests plus the extension test host. In the models worktree run its full build and integration suite.

- [ ] **Step 8: Write the acceptance record**

For every requirement in the July 23 Gateway spec and July 30 lightweight settings spec, link the exact test, command output, screenshot, or redacted runtime artifact. Mark missing external OAuth registration or real credential evidence as not complete rather than substituting mocks.

- [ ] **Step 9: Final review and cohesive commits**

Run a spec-compliance review and a code-quality/security review. Fix all blocking findings, repeat full regression, and only then present merge/push options.
