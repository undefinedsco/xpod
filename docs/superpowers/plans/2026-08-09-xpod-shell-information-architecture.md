# Xpod Shell Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split Dashboard/Settings navigation with one global Xpod rail, preserve the completed AI Connections applet, add Pod-backed AI Config, reorganize Status/Network/Settings lists, add the user card, and make the macOS tray report Gateway, Solid Server, and API Server.

**Architecture:** Keep the current `/dashboard` and `/settings` build products during migration, but render one shared host rail with absolute canonical links so both products have identical global navigation. Reuse `ModelsPage` and `@undefineds.co/ai-connections` unchanged as the AI Connections workspace. Add focused list/content shells per workspace, a Pod-backed AI Config API boundary, and a testable pure tray-menu model consumed by Electron.

**Tech Stack:** React 19, React Router 7, TypeScript, `@undefineds.co/extension-sdk` layouts, `@undefineds.co/shared-ui`, Solid authenticated fetch, Vitest/JSDOM, Electron 33, Bun.

---

## File structure

- `ui/src/layout/global-navigation.ts`: canonical global rail metadata shared by both products.
- `ui/src/layout/XpodProductLayout.tsx`: shared global rail renderer and user-card trigger.
- `ui/src/layout/XpodUserCard.tsx`: authenticated identity/Pod popover.
- `ui/src/layout/status-navigation.ts`: flat grouped Status list metadata.
- `ui/src/layout/network-navigation.ts`: Network list metadata.
- `ui/src/layout/ai-config-navigation.ts`: AI Config list metadata.
- `ui/src/layout/system-settings-navigation.ts`: low-frequency Settings list metadata.
- `ui/src/pages/settings/AiConfigPage.tsx`: AI Config two-pane host.
- `ui/src/pages/settings/ai-config/*`: focused content pages for assignments, document processing, search/indexing, and lifecycle.
- `ui/src/api/ai-config.ts`: typed authenticated AI Config client.
- `src/api/handlers/AiConfigHandler.ts`: authenticated Pod-level AI Config HTTP boundary.
- `desktop/src/tray-menu.ts`: pure three-service status aggregation and native-menu template construction.
- `desktop/src/main.ts`: Electron lifecycle and tray integration only.

## Task 1: One global rail and preserved AI Connections

**Files:**
- Create: `ui/src/layout/global-navigation.ts`
- Modify: `ui/src/layout/XpodProductLayout.tsx`
- Modify: `ui/src/layout/XpodDashboardLayout.tsx`
- Modify: `ui/src/layout/XpodSettingsLayout.tsx`
- Modify: `ui/src/layout/XpodProductLayout.test.tsx`
- Modify: `ui/src/layout/XpodSettingsLayout.test.tsx`

- [ ] Write a failing navigation test expecting this fixed order: Status, Network, AI Connections, AI Config, Settings.
- [ ] Run `bun run test -- ui/src/layout/XpodProductLayout.test.tsx ui/src/layout/XpodSettingsLayout.test.tsx` and confirm the old product-specific rail fails the expectation.
- [ ] Add global metadata with absolute links: `/dashboard/overview`, `/dashboard/network`, `/settings/models`, `/settings/ai-config`, and `/settings/system`.
- [ ] Render the same metadata in Dashboard and Settings; remove the X product-switch button and product-specific rail arrays.
- [ ] Keep `/settings/models` mounted through the current `ModelsPage` and `useMountedAiConnectionsApplet`; do not edit `packages/ai-connections` behavior.
- [ ] Re-run the focused navigation tests and confirm they pass.

## Task 2: User main card

**Files:**
- Create: `ui/src/layout/XpodUserCard.tsx`
- Create: `ui/src/layout/XpodUserCard.test.tsx`
- Modify: `ui/src/layout/XpodProductLayout.tsx`
- Modify: `ui/src/solid/XpodSolidRuntime.ts`

- [ ] Write failing tests for authenticated, unauthenticated, and Pod-unavailable card states.
- [ ] Verify the tests fail because the card does not exist.
- [ ] Implement the bottom-pinned avatar trigger and accessible popover with display identity, shortened WebID, Pod URL, connection state, Open Pod, Copy WebID, switch-account entry, and sign out.
- [ ] Ensure the card contains no usage, network, runtime, or AI configuration summaries.
- [ ] Run the user-card and layout tests.

## Task 3: Flat Status list and content routing

**Files:**
- Create: `ui/src/layout/status-navigation.ts`
- Create: `ui/src/pages/status/StatusWorkspace.tsx`
- Create: `ui/src/pages/status/StatusWorkspace.test.tsx`
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/pages/admin/StatusPage.tsx`
- Modify: `ui/src/pages/admin/LogsPage.tsx`
- Modify: `ui/src/pages/admin/RdfPage.tsx`
- Modify: `ui/src/pages/settings/PodPage.tsx`

- [ ] Write failing metadata and route tests for the grouped, flat Status list: Overview; Gateway, Solid Server, API Server; Logs; Index Overview, RDF, FTS, Vector, Retrieval Points, Cache, Slow Queries, Benchmark; Usage Overview, Storage, Bandwidth, AI Usage, Index Storage.
- [ ] Verify failures against the current Overview/Runtime/Logs/RDF/Usage rail.
- [ ] Implement a single Status workspace using `TwoPaneLayout`; every list row selects content directly and no content pane creates a fourth navigation layer.
- [ ] Adapt existing Status, Logs, RDF, and Pod usage components into focused content surfaces without duplicating data-fetching ownership.
- [ ] Add contextual failure banners to the relevant content page; do not add a Needs Attention destination.
- [ ] Run focused Status tests.

## Task 4: Unified Network workspace

**Files:**
- Create: `ui/src/layout/network-navigation.ts`
- Modify: `ui/src/pages/settings/NetworkPage.tsx`
- Modify: `ui/src/pages/settings/NetworkPage.test.tsx`
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/settings-routes.tsx`

- [ ] Write failing tests for Overview, Endpoints, Addresses, Domain & DNS, HTTPS, Tunnel Profiles, P2P, and Diagnostics list items.
- [ ] Verify the current card-only list fails.
- [ ] Refactor Network into selectable rows and focused content while keeping one status fetch owner.
- [ ] Visually separate observed state from saved configuration in DNS, HTTPS, and Tunnel content.
- [ ] Point both legacy Dashboard and Settings Network paths to the same workspace and preserve redirects.
- [ ] Run Network tests.

## Task 5: AI Config data contract and Pod persistence

**Files:**
- Create: `src/api/handlers/AiConfigHandler.ts`
- Create: `src/api/ai-config/AiConfigService.ts`
- Create: `src/api/ai-config/types.ts`
- Create: `tests/api/handlers/AiConfigHandler.test.ts`
- Modify: `src/api/container/routes.ts`
- Modify: `src/api/container/types.ts`
- Modify: `src/api/container/index.ts`
- Modify: `src/api/ApiServer.ts`

- [ ] Write failing handler tests for authenticated read, authenticated update, validation rejection, capability reporting, and cross-Pod denial.
- [ ] Define a versioned config containing task-model assignments, document-processing policy, search/indexing switches and backend choices, and index-lifecycle policy.
- [ ] Persist the config in the authenticated user's Pod through the repository's established drizzle-solid/model boundary; do not add server environment variables for user AI settings.
- [ ] Return runtime support separately from desired Pod configuration so unsupported controls can be explained without mutating user intent.
- [ ] Register routes and run handler tests.

## Task 6: AI Config workspace

**Files:**
- Create: `ui/src/api/ai-config.ts`
- Create: `ui/src/layout/ai-config-navigation.ts`
- Create: `ui/src/pages/settings/AiConfigPage.tsx`
- Create: `ui/src/pages/settings/AiConfigPage.test.tsx`
- Create: `ui/src/pages/settings/ai-config/ModelAssignmentsPanel.tsx`
- Create: `ui/src/pages/settings/ai-config/DocumentProcessingPanel.tsx`
- Create: `ui/src/pages/settings/ai-config/SearchIndexingPanel.tsx`
- Create: `ui/src/pages/settings/ai-config/IndexLifecyclePanel.tsx`
- Modify: `ui/src/settings-routes.tsx`

- [ ] Write failing route, list, loading, error, dirty, saving, unsupported-capability, and restart/rebuild-choice tests.
- [ ] Implement the typed authenticated client.
- [ ] Implement the four direct list items: Model Assignments, Document Processing, Search & Indexing, and Index Lifecycle.
- [ ] Reference existing provider/model data exposed by the current AI Connections backend; do not duplicate credentials or connection editing.
- [ ] Make Auto the default backend choice and reveal FTS5/PostgreSQL FTS or VEC/pgvector only in manual mode and only when reported.
- [ ] Implement Save Configuration and Save and Schedule Rebuild as distinct actions.
- [ ] Run AI Config UI tests.

## Task 7: Low-frequency Settings workspace

**Files:**
- Create: `ui/src/layout/system-settings-navigation.ts`
- Create: `ui/src/pages/settings/SystemSettingsPage.tsx`
- Create: `ui/src/pages/settings/SystemSettingsPage.test.tsx`
- Modify: `ui/src/pages/settings/PodPage.tsx`
- Modify: `ui/src/pages/admin/SettingsPage.tsx`
- Modify: `ui/src/settings-routes.tsx`

- [ ] Write failing tests for Pod, Identity & Access, Storage, Runtime, Cloud, and Advanced list items.
- [ ] Implement the two-pane Settings workspace and reuse existing Pod/runtime configuration forms as focused content.
- [ ] Keep measured usage in Status and remove it from Settings content.
- [ ] Hide Cloud when runtime capabilities say it is unavailable.
- [ ] Run Settings tests.

## Task 8: Three-service macOS tray

**Files:**
- Create: `desktop/src/tray-menu.ts`
- Create: `desktop/src/tray-menu.test.ts`
- Modify: `desktop/src/main.ts`
- Replace: `desktop/assets/tray.png`
- Replace: `desktop/assets/tray@2x.png`
- Create: `desktop/assets/trayTemplate.png`
- Create: `desktop/assets/trayTemplate@2x.png`

- [ ] Write failing pure tests for healthy, starting, degraded, failed, and stopped aggregation across exactly `gateway`, `css`, and `api`.
- [ ] Write failing menu tests for the service rows, global workspace links, contextual log action, launch-at-login checkbox, and whole-runtime lifecycle action.
- [ ] Implement the pure status/menu model and consume it from Electron.
- [ ] Fetch/poll the runtime status endpoint, retain the last successful snapshot as stale during refresh, and update tooltip/menu atomically.
- [ ] Mark the monochrome images as macOS template images and remove the purple tile treatment.
- [ ] Keep single click for the native menu and make Open Xpod show/focus the existing window.
- [ ] Run desktop build and tray tests.

## Task 9: Route migration and static products

**Files:**
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/settings-routes.tsx`
- Modify: `ui/src/DashboardApp.test.tsx`
- Modify: `ui/src/settings-routes.test.tsx`
- Modify: `src/api/handlers/StaticSpaHandler.ts`
- Modify: `tests/api/handlers/StaticSpaHandler.test.ts`
- Modify: `desktop/src/main.ts`

- [ ] Write failing redirect tests for old Dashboard and Settings paths.
- [ ] Add canonical route redirects without breaking static asset paths or BrowserRouter basenames.
- [ ] Change the desktop default URL from `/settings/models` to the canonical Status route.
- [ ] Run route and static SPA tests.

## Task 10: Visual, accessibility, and repository verification

**Files:**
- Modify: `ui/src/index.css`
- Modify: affected tests from Tasks 1–9
- Modify: `docs/superpowers/specs/2026-08-09-xpod-shell-information-architecture-design.md` only if implementation evidence requires a clarified decision

- [ ] Verify keyboard navigation, accessible rail labels/tooltips, active state independent of color, list selection, dialog/popover focus, and live-region behavior.
- [ ] Build all packages and UI with `bun run build`.
- [ ] Run focused package/UI/API tests.
- [ ] Run `bun run test:integration` as the required full regression suite.
- [ ] Run the desktop smoke and inspect the macOS light/dark tray icon when a graphical session is available.
- [ ] Review `git diff --check`, changed-file scope, and generated static assets.

## Implementation constraints

- Preserve all pre-existing dirty-tree edits and generated assets not owned by this plan.
- Do not rewrite `packages/ai-connections`; mount and consume the current applet.
- Do not introduce a new dependency.
- Do not persist user AI provider or AI Config secrets in environment variables.
- Do not add a fourth navigation layer inside content.
- Do not expose independent tray restart actions until service dependency behavior is designed and tested.
