# Xpod Shell Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split Dashboard/Settings navigation with one global Xpod rail, preserve the completed AI Connections applet, add Pod-backed AI Config, reorganize Status/Network/Settings lists, add the user card, and make the macOS tray report Gateway, Solid Server, and API Server.

**Architecture:** Keep the Dashboard and Settings build products as static hosts, but render one shared host rail with canonical route families: `/status/*`, `/network/*`, `/ai-connections`, `/ai-config/*`, and `/settings/*`. Legacy `/dashboard/*` and old `/settings/models|pod|network|services` paths remain explicit redirects. Reuse `ModelsPage` and `@undefineds.co/ai-connections` as the AI Connections workspace, add focused list/content shells per workspace, keep Pod-backed AI Config behind its own API boundary, and consume a testable pure tray-menu model from Electron.

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

- [x] Write a failing navigation test expecting this fixed order: Status, Network, AI Connections, AI Config, Settings.
- [x] Run `bun run test -- ui/src/layout/XpodProductLayout.test.tsx ui/src/layout/XpodSettingsLayout.test.tsx` and confirm the old product-specific rail fails the expectation.
- [x] Add global metadata with canonical absolute links: `/status/overview`, `/network`, `/ai-connections`, `/ai-config/model-assignments`, and `/settings/pod`.
- [x] Render the same metadata in Dashboard and Settings; remove the X product-switch button and product-specific rail arrays.
- [x] Mount the existing `ModelsPage` and `useMountedAiConnectionsApplet` at `/ai-connections`; keep `/settings/models` only as a compatibility redirect.
- [x] Re-run the focused navigation tests and confirm they pass.

## Task 2: User main card

**Files:**
- Create: `ui/src/layout/XpodUserCard.tsx`
- Create: `ui/src/layout/XpodUserCard.test.tsx`
- Modify: `ui/src/layout/XpodProductLayout.tsx`
- Modify: `ui/src/solid/XpodSolidRuntime.ts`

- [x] Write failing tests for authenticated, unauthenticated, and Pod-unavailable card states.
- [x] Verify the tests fail because the card does not exist.
- [x] Implement the bottom-pinned avatar trigger and accessible popover with display identity, shortened WebID, Pod URL, connection state, Open Pod, Copy WebID, switch-account entry, and sign out.
- [x] Ensure the card contains no usage, network, runtime, or AI configuration summaries.
- [x] Run the user-card and layout tests.

## Task 3: Flat Status list and content routing

**Files:**
- Create: `ui/src/layout/status-navigation.ts`
- Create: `ui/src/pages/status/StatusWorkspace.tsx`
- Test: `ui/src/layout/status-navigation.test.ts`
- Test: `ui/src/pages/status/IndexSubjectPanel.test.tsx`
- Test: `ui/src/pages/status/usage-projection.test.ts`
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/pages/admin/StatusPage.tsx`
- Modify: `ui/src/pages/admin/LogsPage.tsx`
- Modify: `ui/src/pages/admin/RdfPage.tsx`
- Modify: `ui/src/pages/settings/PodPage.tsx`

- [x] Write failing metadata and route tests for the grouped, flat Status list: Overview; Gateway, Solid Server, API Server; Logs; Index Overview, RDF, FTS, Vector, Retrieval Points, Cache, Slow Queries, Benchmark; Usage Overview, Storage, Bandwidth, AI Usage, Index Storage.
- [x] Verify failures against the current Overview/Runtime/Logs/RDF/Usage rail.
- [x] Implement a single Status workspace using `TwoPaneLayout`; every list row selects content directly and no content pane creates a fourth navigation layer.
- [x] Adapt existing Status, Logs, RDF, and Pod usage components into focused content surfaces without duplicating data-fetching ownership.
- [x] Add contextual failure banners to the relevant content page; do not add a Needs Attention destination.
- [x] Run focused Status tests.

## Task 4: Unified Network workspace

**Files:**
- Create: `ui/src/layout/network-navigation.ts`
- Modify: `ui/src/pages/settings/NetworkPage.tsx`
- Modify: `ui/src/pages/settings/NetworkPage.test.tsx`
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/settings-routes.tsx`

- [x] Write failing tests for Overview, Endpoints, Addresses, Domain & DNS, HTTPS, Tunnel Profiles, P2P, and Diagnostics list items.
- [x] Verify the current card-only list fails.
- [x] Refactor Network into selectable rows and focused content while keeping one status fetch owner.
- [x] Visually separate observed state from saved configuration in DNS, HTTPS, and Tunnel content.
- [x] Point both legacy Dashboard and Settings Network paths to the same workspace and preserve redirects.
- [x] Run Network tests, including the real Gateway/AuthMiddleware loopback path and remote-anonymous denial.

## Task 5: AI Config data contract and Pod persistence

**Files:**
- Create: `src/api/handlers/AiConfigHandler.ts`
- Create: `src/api/ai-config/AiConfigStore.ts`
- Create: `src/api/ai-config/XpodAiConfigSchema.ts`
- Create: `src/api/ai-config/AiConfigLifecycleService.ts`
- Create: `src/api/ai-config/PodSearchIndexRebuilder.ts`
- Create: `tests/api/handlers/AiConfigHandler.test.ts`
- Modify: `src/api/container/routes.ts`
- Modify: `src/api/container/types.ts`
- Modify: `src/api/container/index.ts`
- Modify: `src/api/ApiServer.ts`

- [x] Write failing handler tests for authenticated read, authenticated update, validation rejection, capability reporting, and cross-Pod denial.
- [x] Define a versioned config containing task-model assignments, document-processing policy, search/indexing switches and backend choices, and index-lifecycle policy.
- [x] Persist the config in the authenticated user's Pod through the repository's established drizzle-solid/model boundary; do not add server environment variables for user AI settings.
- [x] Return runtime support separately from desired Pod configuration so unsupported controls can be explained without mutating user intent.
- [x] Register routes and run handler tests.

## Task 6: AI Config workspace

**Files:**
- Create: `ui/src/api/ai-config.ts`
- Create: `ui/src/layout/ai-config-navigation.ts`
- Create: `ui/src/pages/settings/AiConfigPage.tsx`
- Test: `ui/src/pages/settings/ai-config/AiConfigContext.test.ts`
- Test: `ui/src/pages/settings/ai-config/SearchIndexingPanel.test.ts`
- Test: `ui/src/pages/settings/ai-config/form-state.test.ts`
- Create: `ui/src/pages/settings/ai-config/ModelAssignmentsPanel.tsx`
- Create: `ui/src/pages/settings/ai-config/DocumentProcessingPanel.tsx`
- Create: `ui/src/pages/settings/ai-config/SearchIndexingPanel.tsx`
- Create: `ui/src/pages/settings/ai-config/IndexLifecyclePanel.tsx`
- Modify: `ui/src/settings-routes.tsx`

- [x] Write failing route, list, loading, error, dirty, saving, unsupported-capability, and restart/rebuild-choice tests across the context, form-state, navigation, and focused panel suites.
- [x] Implement the typed authenticated client.
- [x] Implement the four direct list items: Model Assignments, Document Processing, Search & Indexing, and Index Lifecycle.
- [x] Reference existing provider/model data exposed by the current AI Connections backend; do not duplicate credentials or connection editing.
- [x] Make Auto the default backend choice and reveal FTS5/PostgreSQL FTS or VEC/pgvector only in manual mode and only when reported.
- [x] Implement Save Configuration and Save and Schedule Rebuild as distinct actions.
- [x] Run AI Config UI tests.

## Task 7: Low-frequency Settings workspace

**Files:**
- Create: `ui/src/layout/system-settings-navigation.ts`
- Create: `ui/src/pages/settings/SystemSettingsPage.tsx`
- Test: `ui/src/layout/system-settings-navigation.test.ts`
- Test: `ui/src/pages/settings/settings-projection.test.ts`
- Modify: `ui/src/pages/settings/PodPage.tsx`
- Modify: `ui/src/pages/admin/SettingsPage.tsx`
- Modify: `ui/src/settings-routes.tsx`

- [x] Write failing tests for Pod, Identity & Access, Storage, Runtime, Cloud, and Advanced list items.
- [x] Implement the two-pane Settings workspace and reuse existing Pod/runtime configuration forms as focused content.
- [x] Keep measured usage in Status and remove it from Settings content.
- [x] Hide Cloud when runtime capabilities say it is unavailable.
- [x] Run Settings tests.

## Task 8: Three-service macOS tray

**Files:**
- Create: `desktop/src/tray-menu.ts`
- Create: `desktop/test/tray-menu.test.ts`
- Create: `desktop/src/tray-icon.ts`
- Create: `desktop/test/tray-icon.test.ts`
- Modify: `desktop/src/main.ts`
- Replace: `desktop/assets/tray.png`
- Replace: `desktop/assets/tray@2x.png`
- Create: `desktop/assets/tray-{healthy|starting|degraded|failed|stopped}Template*.png`

- [x] Write failing pure tests for healthy, starting, degraded, failed, and stopped aggregation across exactly `gateway`, `css`, and `api`.
- [x] Write failing menu tests for the service rows, global workspace links, contextual log action, launch-at-login checkbox, and whole-runtime lifecycle action.
- [x] Implement the pure status/menu model and consume it from Electron.
- [x] Fetch/poll the runtime status endpoint, retain the last successful snapshot as stale during refresh, and update tooltip/menu atomically.
- [x] Mark the monochrome images as macOS template images and remove the purple tile treatment.
- [x] Keep single click for the native menu and make Open Xpod show/focus the existing window.
- [x] Run desktop build and tray tests; verify the native macOS menu reports all three services.

## Task 9: Route migration and static products

**Files:**
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/settings-routes.tsx`
- Modify: `ui/src/DashboardApp.test.tsx`
- Modify: `ui/src/settings-routes.test.tsx`
- Modify: `src/api/handlers/StaticSpaHandler.ts`
- Modify: `tests/api/handlers/StaticSpaHandler.test.ts`
- Modify: `desktop/src/main.ts`

- [x] Write failing redirect tests for old Dashboard and Settings paths.
- [x] Add canonical route redirects without breaking static asset paths or BrowserRouter basenames.
- [x] Change the desktop first-launch URL from `/settings/models` to the anonymous local `/network/overview` surface. Status remains canonical at `/status/overview` and intentionally uses the Account boundary.
- [x] Change `settings:open` from emitting `/settings/models` to the canonical `/ai-connections` URL; retain the old path only as a redirect.
- [x] Run route and static SPA tests.

## Task 10: Visual, accessibility, and repository verification

**Files:**
- Modify: `ui/src/index.css`
- Modify: affected tests from Tasks 1–9
- Modify: `docs/superpowers/specs/2026-08-09-xpod-shell-information-architecture-design.md` only if implementation evidence requires a clarified decision

- [x] Verify keyboard navigation, accessible rail labels/tooltips, active state independent of color, list selection, dialog/popover focus, and live-region behavior.
- [x] Build all packages and UI with `bun run build`.
- [x] Run focused package/UI/API tests.
- [x] Run `bun run test:integration` as the required full regression suite.
- [x] Run the packaged desktop smoke in a graphical macOS session and verify native template-image tray behavior.
- [x] Review `git diff --check`, changed-file scope, and generated static assets.

## Final acceptance evidence

- Repository Vitest: 408 files (372 passed, 36 skipped), 3,606 tests (3,339 passed, 267 skipped), zero failures.
- Package suites: 217/217 passed; desktop unit suites: 19/19 passed; Network real-Gateway/auth suites: 17/17 passed.
- `bun run typecheck:test`, `bun run --cwd ui lint`, `bun run build`, and the final `bun run test:integration` all exited successfully.
- The packaged arm64 app opened `/network/overview` without login, exposed the fixed rail order, preserved Account/WebID/local-host boundaries, returned Network status and diagnostics, and created the native three-service menu with Gateway, Solid Server, and API Server at 3/3 healthy.
- A standard LaunchServices launch and AppleScript quit stopped the shell-owned runtime and left ports/processes clean; runtime-manager tests prove externally managed runtimes are preserved.
- `desktop/release/Xpod-0.1.0-arm64.dmg` SHA256: `ce3e892cc887c4c5b28508f2cd7a358e20d65bd22b61cc61d8c9586bff45dfee`; `hdiutil verify` reported valid.
- `desktop/release/Xpod-0.1.0-arm64-mac.zip` SHA256: `a0ec9d2f9ba55ca17822a10491979940830ece67ae4a0a9e498783975f65befb`.
- The development package is unsigned and not notarized because no Apple Developer ID Application identity is installed. This is the only unavailable release-distribution check and is not a functional acceptance gap.

## Implementation constraints

- Preserve all pre-existing dirty-tree edits and generated assets not owned by this plan.
- The shell IA must not duplicate `packages/ai-connections`; it mounts the applet at `/ai-connections`. Independent Provider/Offering work merged in the same integration is governed by its own AI Connections specs.
- Do not introduce a new dependency.
- Do not persist user AI provider or AI Config secrets in environment variables.
- Do not add a fourth navigation layer inside content.
- Do not expose independent tray restart actions until service dependency behavior is designed and tested.
