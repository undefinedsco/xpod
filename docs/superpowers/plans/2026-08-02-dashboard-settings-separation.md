# Dashboard and Settings Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship independent `/dashboard/*` status and `/settings/*` configuration products that share Xpod layout, Solid session, and UI components without duplicate canonical routes.

**Architecture:** Keep one UI workspace with two Vite entry documents and two React route trees. Extract the API server's SPA static-file behavior into a prefix-agnostic registrar, mount Dashboard and Settings separately, and migrate pages according to the read-only-status versus writable-configuration boundary. Build all three shipped web targets (`app`, `dashboard`, `settings`) from the root command.

**Tech Stack:** TypeScript, React 19, React Router, Vite, Bun test runner, Xpod API server, `@undefineds.co/extension-sdk` layouts, Solid OIDC runtime.

---

## File Structure

- `src/api/handlers/StaticSpaHandler.ts`: shared safe static-SPA serving and legacy redirect registration.
- `src/api/handlers/DashboardHandler.ts`: thin `/dashboard` registration over the shared handler.
- `src/api/handlers/SettingsHandler.ts`: thin `/settings` registration over the shared handler.
- `src/api/container/routes.ts`: mount both product directories.
- `src/runtime/Proxy.ts`: route both URL prefixes to the API server.
- `ui/dashboard.html`, `ui/settings.html`: independent Vite entry documents.
- `ui/src/DashboardApp.tsx`, `ui/src/SettingsApp.tsx`: independent router basenames and route trees.
- `ui/src/dashboard-routes.tsx`, `ui/src/settings-routes.tsx`: canonical route ownership.
- `ui/src/layout/XpodProductLayout.tsx`: shared 60px product rail implementation parameterized by navigation.
- `ui/src/layout/dashboard-navigation.ts`, `ui/src/layout/settings-navigation.ts`: distinct product navigation metadata.
- Existing settings/status pages remain focused components and are moved between route trees rather than copied.

### Task 1: Introduce a reusable static SPA mount

**Files:**
- Create: `src/api/handlers/StaticSpaHandler.ts`
- Create: `tests/api/handlers/StaticSpaHandler.test.ts`
- Modify: `src/api/handlers/DashboardHandler.ts`

- [ ] **Step 1: Write failing tests for a prefix-agnostic SPA handler**

Add tests that register a temporary SPA at `/settings` and assert:

```ts
expect(await request('/settings')).toMatchObject({ status: 302, location: '/settings/' });
expect(await request('/settings/models')).toMatchObject({ status: 200, body: settingsHtml });
expect(await request('/settings/assets/main.js')).toMatchObject({
  status: 200,
  contentType: 'application/javascript',
});
expect(await head('/settings/models')).toMatchObject({ status: 200, body: '' });
expect(await request('/settings/../secret')).toMatchObject({ status: 403 });
```

Also retain Dashboard assertions to prove `/dashboard/*` behavior does not regress.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
bun test tests/api/handlers/StaticSpaHandler.test.ts
```

Expected: FAIL because `registerStaticSpaRoutes` does not exist.

- [ ] **Step 3: Implement the shared handler**

Create this public contract:

```ts
export interface StaticSpaRouteOptions {
  prefix: `/${string}`;
  staticDir: string;
  entryFiles: readonly string[];
  label: string;
}

export function registerStaticSpaRoutes(
  server: ApiServer,
  options: StaticSpaRouteOptions,
): void;
```

Move MIME detection, HTML no-cache headers, immutable asset caching, path traversal protection, SPA fallback, GET, and HEAD behavior out of `DashboardHandler.ts`. Keep `registerDashboardRoutes` as a compatibility wrapper:

```ts
registerStaticSpaRoutes(server, {
  prefix: '/dashboard',
  staticDir: options.staticDir,
  entryFiles: ['dashboard.html', 'index.html'],
  label: 'Dashboard',
});
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
bun test tests/api/handlers/StaticSpaHandler.test.ts
bun run build:ts
```

Expected: all focused tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/api/handlers/StaticSpaHandler.ts tests/api/handlers/StaticSpaHandler.test.ts src/api/handlers/DashboardHandler.ts
git commit -m "♻️ Share static SPA route handling"
```

### Task 2: Mount Settings as an independent server product

**Files:**
- Create: `src/api/handlers/SettingsHandler.ts`
- Create: `tests/api/handlers/SettingsHandler.test.ts`
- Modify: `src/api/container/routes.ts`
- Modify: `src/runtime/Proxy.ts`
- Modify: `tests/gateway/service-endpoints.test.ts`

- [ ] **Step 1: Write failing Settings mount and proxy tests**

Assert the Settings wrapper calls the shared registrar with:

```ts
{
  prefix: '/settings',
  entryFiles: ['settings.html', 'index.html'],
  label: 'Settings',
}
```

Add proxy cases proving `/settings`, `/settings/`, `/settings/models`, and `/settings/assets/main.js` target the API service exactly like `/dashboard/*`.

- [ ] **Step 2: Run tests and verify red**

Run the Settings handler and proxy test files. Expected: FAIL because the route and proxy prefix are absent.

- [ ] **Step 3: Implement the Settings mount**

Register `static/settings` in `src/api/container/routes.ts`. Update the proxy predicate to a named helper:

```ts
function isApiWebProductPath(url: string): boolean {
  return url === '/dashboard'
    || url.startsWith('/dashboard/')
    || url === '/settings'
    || url.startsWith('/settings/');
}
```

Do not add authentication at the static-file layer; page-level Solid auth remains in React.

- [ ] **Step 4: Run focused tests and `bun run build:ts`**

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/handlers/SettingsHandler.ts tests/api/handlers/SettingsHandler.test.ts src/api/container/routes.ts src/runtime/Proxy.ts tests/gateway/service-endpoints.test.ts
git commit -m "🛣️ Mount the Settings product independently"
```

### Task 3: Add the Settings build target and prevent stale products

**Files:**
- Create: `ui/settings.html`
- Create: `ui/src/settings.tsx`
- Modify: `ui/vite.config.ts`
- Modify: `ui/package.json`
- Modify: `package.json`
- Modify: build-script tests if present

- [ ] **Step 1: Add a failing configuration test**

Extract or export the target configuration so a test can assert:

```ts
expect(buildTargets.settings).toEqual({
  base: '/settings/',
  outDir: '../static/settings',
  input: 'settings.html',
});
```

Assert `build:all` invokes `build:app`, `build:dashboard`, and `build:settings` in that order.

- [ ] **Step 2: Run the test and verify red**

Expected: FAIL because `settings` and `build:settings` are missing.

- [ ] **Step 3: Implement the entry and build target**

`ui/settings.html` contains a root node and imports `/src/settings.tsx`. `settings.tsx` renders `SettingsApp` under `StrictMode`. Add:

```json
"build:settings": "tsc -b && BUILD_TARGET=settings vite build",
"build:all": "bun run build:app && bun run build:dashboard && bun run build:settings"
```

Keep root `build:ui` invoking `ui`'s `build:all`.

- [ ] **Step 4: Build all UI products**

Run:

```bash
bun run build:ui
test -f static/app/index.html
test -f static/dashboard/dashboard.html
test -f static/settings/settings.html
```

Expected: all builds and file checks exit 0.

- [ ] **Step 5: Commit source/configuration files only**

Do not stage unrelated or previously dirty generated assets.

```bash
git add ui/settings.html ui/src/settings.tsx ui/vite.config.ts ui/package.json package.json
git commit -m "📦 Build Settings as a first-class web product"
```

### Task 4: Split Dashboard and Settings route ownership

**Files:**
- Create: `ui/src/SettingsApp.tsx`
- Create: `ui/src/SettingsApp.test.tsx`
- Create: `ui/src/settings-routes.tsx`
- Create: `ui/src/settings-routes.test.tsx`
- Modify: `ui/src/DashboardApp.tsx`
- Modify: `ui/src/DashboardApp.test.tsx`
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/layout/settings-navigation.ts`
- Create: `ui/src/layout/dashboard-navigation.ts`

- [ ] **Step 1: Write failing canonical-route tests**

Settings assertions:

```ts
expect(renderSettings('/')).toNavigateTo('/settings/models');
expect(renderSettings('/models')).toShow('AI Connection');
expect(renderSettings('/pod')).toShow('Pod');
expect(renderSettings('/network')).toShow('Network settings');
expect(renderSettings('/services')).toShow('Services settings');
```

Dashboard assertions:

```ts
expect(renderDashboard('/')).toNavigateTo('/dashboard/overview');
expect(renderDashboard('/runtime')).toShow('Runtime');
expect(renderDashboard('/logs')).toShow('Logs');
expect(renderDashboard('/rdf')).toShow('RDF');
expect(renderDashboard('/network')).toShow('Network status');
expect(renderDashboard('/usage')).toShow('Usage');
```

Assert Dashboard no longer directly renders Models or writable Pod/Services settings.

- [ ] **Step 2: Run route tests and verify red**

Run:

```bash
cd ui && bun test src/SettingsApp.test.tsx src/settings-routes.test.tsx src/DashboardApp.test.tsx
```

Expected: Settings modules are missing and Dashboard still owns configuration pages.

- [ ] **Step 3: Implement independent app roots and route trees**

`DashboardApp` uses `<BrowserRouter basename="/dashboard">`; `SettingsApp` uses `<BrowserRouter basename="/settings">`. Both import the same Solid runtime provider exactly once. Move Models, Pod configuration, and writable service routes into `settings-routes.tsx`; keep status/log/RDF routes in `dashboard-routes.tsx`.

Unknown paths navigate to the product default with `replace`. Use absolute browser URLs only for cross-product navigation; internal routes remain basename-relative.

- [ ] **Step 4: Run route tests and UI typecheck**

Run:

```bash
cd ui && bun test src/SettingsApp.test.tsx src/settings-routes.test.tsx src/DashboardApp.test.tsx
cd ui && bun run typecheck
```

If `typecheck` is not a script, run `cd ui && bunx tsc -b --pretty false`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/SettingsApp.tsx ui/src/SettingsApp.test.tsx ui/src/settings-routes.tsx ui/src/settings-routes.test.tsx ui/src/DashboardApp.tsx ui/src/DashboardApp.test.tsx ui/src/dashboard-routes.tsx ui/src/layout/settings-navigation.ts ui/src/layout/dashboard-navigation.ts
git commit -m "🧭 Give Dashboard and Settings canonical routes"
```

### Task 5: Share the product shell while separating navigation

**Files:**
- Create: `ui/src/layout/XpodProductLayout.tsx`
- Create: `ui/src/layout/XpodProductLayout.test.tsx`
- Modify: `ui/src/layout/XpodSettingsLayout.tsx`
- Create or modify: `ui/src/layout/XpodDashboardLayout.tsx`
- Modify: layout tests

- [ ] **Step 1: Write failing shell tests**

Assert both layouts render the same SDK geometry and different navigation labels:

```ts
expect(settings).toHaveGridColumns('60px minmax(0, 1fr)');
expect(dashboard).toHaveGridColumns('60px minmax(0, 1fr)');
expect(settings).toContainLinks(['Models', 'Pod', 'Network', 'Services']);
expect(dashboard).toContainLinks(['Overview', 'Runtime', 'Logs', 'RDF', 'Network', 'Usage']);
```

Assert both rails expose a cross-product link and do not instantiate another Solid provider.

- [ ] **Step 2: Run layout tests and verify red**

Expected: Dashboard-specific layout/navigation does not exist.

- [ ] **Step 3: Implement the shared shell**

Create a focused component:

```ts
interface XpodProductLayoutProps {
  product: 'dashboard' | 'settings';
  items: readonly ProductNavigationItem[];
  switchHref: '/dashboard/overview' | '/settings/models';
}
```

It owns only the 60px rail, active links, accessible labels, product switch, and `<Outlet />`. Applet list/main panes remain owned by the routed page through Extension SDK layouts.

- [ ] **Step 4: Run layout and route tests**

Expected: all pass with one `<main>` landmark at the page workspace boundary.

- [ ] **Step 5: Commit**

```bash
git add ui/src/layout/XpodProductLayout.tsx ui/src/layout/XpodProductLayout.test.tsx ui/src/layout/XpodSettingsLayout.tsx ui/src/layout/XpodDashboardLayout.tsx ui/src/layout/*test.tsx
git commit -m "🎛️ Share the Xpod shell across status and settings"
```

### Task 6: Split mixed status/configuration pages and add cross-links

**Files:**
- Modify: `ui/src/pages/settings/PodPage.tsx`
- Modify: `ui/src/pages/settings/NetworkPage.tsx`
- Modify: `ui/src/pages/settings/ServicesPage.tsx`
- Create or modify Dashboard pages for Overview, Network status, Runtime, and Usage under `ui/src/pages/dashboard/`
- Modify corresponding page tests

- [ ] **Step 1: Lock the ownership boundary with failing tests**

Tests must prove:

- Settings Network contains editable configuration but not diagnostics results.
- Dashboard Network contains diagnostics/status and a link to `/settings/network`.
- Settings Services contains writable configuration and links to `/dashboard/runtime`.
- Dashboard Runtime contains health/status and links to `/settings/services`.
- Settings Pod contains identity/association configuration.
- Dashboard Usage contains storage, bandwidth, model remaining quota, and a link to `/settings/pod` where appropriate.

- [ ] **Step 2: Run page tests and verify red**

Run only the affected page test files. Expected: failures show currently mixed responsibilities.

- [ ] **Step 3: Move components without copying data access**

Extract shared API hooks or presentational cards only when both products genuinely consume the same status payload. Each network/status request must still have one owner, one abort lifecycle, and stale-response protection. Do not introduce placeholder data or local/cloud branches.

- [ ] **Step 4: Run affected tests and the complete UI suite**

Run:

```bash
cd ui && bun test src/pages/settings src/pages/dashboard
cd ui && bun test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

Stage only the affected pages, shared hooks, and tests, then commit:

```bash
git commit -m "🧩 Separate status views from writable settings"
```

### Task 7: Preserve legacy links and Solid OIDC return paths

**Files:**
- Modify: `src/api/handlers/DashboardHandler.ts` or legacy redirect registration module
- Modify: `ui/src/auth-legacy-helpers.ts`
- Modify: `ui/src/auth-legacy-helpers.test.ts`
- Modify: `scripts/open-settings.mjs`
- Modify: script tests
- Modify: `docs/cli-dev-testing.md`

- [ ] **Step 1: Write failing redirect and return-path tests**

Assert exact redirects:

```ts
/dashboard/models?provider=kimi -> /settings/models?provider=kimi
/dashboard/pod -> /settings/pod
/dashboard/settings -> /settings/services
/dashboard/status -> /dashboard/overview
```

Assert OIDC return paths accept and restore both `/dashboard/*` and `/settings/*`, while rejecting off-origin URLs. Assert the open-settings script normalizes a supplied origin to `/settings/models`.

- [ ] **Step 2: Run focused tests and verify red**

Expected: current helpers and launcher still use `/dashboard/models`.

- [ ] **Step 3: Implement compatibility and documentation**

Use HTTP redirects for routes that changed products; do not render Settings from the Dashboard SPA. Preserve the incoming query string. Update CLI documentation and examples to use `/settings/models`, while documenting `/dashboard/overview` as the status entry.

- [ ] **Step 4: Run focused tests and smoke both entry URLs**

Run:

```bash
curl -I http://localhost:3000/dashboard/models
curl -I http://localhost:3000/settings/models
```

Expected: the first redirects to `/settings/models`; the second returns Settings HTML after the runtime is started.

- [ ] **Step 5: Commit**

```bash
git add src/api/handlers ui/src/auth-legacy-helpers.ts ui/src/auth-legacy-helpers.test.ts scripts/open-settings.mjs docs/cli-dev-testing.md
git commit -m "🔀 Preserve links across the product split"
```

### Task 8: Full verification and browser acceptance

**Files:**
- Modify only files required by failures discovered during verification.

- [ ] **Step 1: Run source and package verification**

```bash
bun run build:packages
bun run test:packages
bun run build:ts
bun run build:ui
```

Expected: all commands exit 0 and all three UI products are generated.

- [ ] **Step 2: Run complete integration regression**

```bash
bun run test:integration
```

Expected: lite and full integration suites pass; configured skips are reported separately from failures.

- [ ] **Step 3: Perform browser geometry and routing acceptance**

At 1280px width, open `/dashboard/overview` and `/settings/models`. Measure computed rectangles:

```ts
{
  primaryRailWidth: 60,
  listPaneWidth: 210,
  listHeaderHeight: 48,
  mainHeaderHeight: 48,
}
```

Confirm Settings Models places Provider search and Add in the list header, uses real Solid/Pod data, and has no global settings search. Confirm Dashboard contains no AI Connection form. Navigate between products and verify the existing session is reused.

- [ ] **Step 4: Check repository scope**

Run `git status --short` and `git diff --check`. Do not stage pre-existing generated assets, backups, credentials, `.env` files, or test data.

- [ ] **Step 5: Commit verification fixes, if any**

Use a Lore-format commit that records exact tests, skips, browser measurements, and any remaining external credential limitation. If verification requires no source changes, do not create an empty commit.
