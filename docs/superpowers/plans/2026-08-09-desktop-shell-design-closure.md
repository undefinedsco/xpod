# Desktop Shell Design Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current preview-only macOS shell into an installable Xpod shell whose tray, routes, runtime lifecycle, account state, and status presentation match the approved shell IA spec.

**Architecture:** Keep Electron as a lightweight host, but move target routing, runtime lifecycle, tray state, and account projection into focused modules with testable pure functions. The packaged shell launches the repository's Xpod CLI/runtime entry when no service is reachable, while preserving an externally managed runtime when one already exists. Canonical route families become `/status/*`, `/network/*`, `/ai-config/*`, and `/settings/*`; old routes remain redirects.

**Tech Stack:** Electron 33, TypeScript, React Router, Bun test/Vitest, electron-builder.

---

### Task 1: Canonical Route Contract

**Files:**
- Create: `ui/src/routes/canonical-routes.ts`
- Modify: `ui/src/dashboard-routes.tsx`
- Modify: `ui/src/settings-routes.tsx`
- Modify: `ui/src/layout/global-navigation.ts`
- Modify: `ui/src/layout/status-navigation.ts`
- Modify: `ui/src/layout/network-navigation.ts`
- Modify: `ui/src/layout/ai-config-navigation.ts`
- Modify: `ui/src/layout/system-settings-navigation.ts`
- Test: `ui/src/routes/canonical-routes.test.ts`
- Test: existing route and layout tests

- [ ] **Step 1: Write failing canonical route and legacy redirect tests**

Assert that Status, Network, AI Config, and Settings generate canonical paths, and that `/dashboard/*` plus legacy `/settings/models|pod|network|services` resolve to explicit redirect targets without changing AI Connections ownership.

- [ ] **Step 2: Run route tests and verify RED**

Run: `bunx vitest run ui/src/routes/canonical-routes.test.ts ui/src/settings-routes.test.tsx ui/src/DashboardApp.test.tsx`

Expected: canonical route assertions fail against the current `/dashboard/*` and mixed `/settings/*` paths.

- [ ] **Step 3: Add the route constants and router aliases**

Define one route contract and update rail/list links to consume it. Keep AI Connections as `/ai-connections`; add redirects from existing URLs.

- [ ] **Step 4: Run route and layout tests and verify GREEN**

Run: `bunx vitest run ui/src/routes/canonical-routes.test.ts ui/src/settings-routes.test.tsx ui/src/DashboardApp.test.tsx ui/src/layout/XpodProductLayout.test.tsx`

Expected: all selected tests pass.

### Task 2: Runtime Lifecycle Boundary

**Files:**
- Create: `desktop/src/runtime-manager.ts`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/package.json`
- Modify: `desktop/tsconfig.json`
- Test: `desktop/test/runtime-manager.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover: reuse a reachable runtime; launch once when stopped; expose `starting/running/failed`; restart only the process owned by the shell; quit leaves externally managed runtime untouched; packaged runtime entry resolution returns an actionable error when unavailable.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `bun test desktop/test/runtime-manager.test.ts`

Expected: tests fail because `runtime-manager.ts` does not exist.

- [ ] **Step 3: Implement the runtime manager**

Use `child_process.spawn`, `/service/status` probing, bounded startup polling, and explicit ownership. Package the required compiled runtime/config/static assets so the DMG does not depend on a source checkout. Route lifecycle errors into tray state rather than silently swallowing them.

- [ ] **Step 4: Run lifecycle tests and verify GREEN**

Run: `bun test desktop/test/runtime-manager.test.ts`

Expected: all lifecycle tests pass without leaving child processes behind.

### Task 3: Tray State, Identity, and Navigation

**Files:**
- Modify: `desktop/src/tray-menu.ts`
- Modify: `desktop/src/main.ts`
- Create: `desktop/src/tray-icon.ts`
- Add/modify: `desktop/assets/trayTemplate*.png`
- Test: `desktop/test/tray-menu.test.ts`
- Test: `desktop/test/tray-icon.test.ts`

- [ ] **Step 1: Write failing tray contract tests**

Assert canonical service routes, canonical workspace routes, no duplicate redesign of AI Connections, signed-in identity rows when available, Switch Account behavior, correct Start versus Restart action, and an icon state mapping for healthy/starting/degraded/failed/stopped.

- [ ] **Step 2: Run tray tests and verify RED**

Run: `bun test desktop/test/tray-menu.test.ts desktop/test/tray-icon.test.ts`

Expected: route, identity, lifecycle action, and icon-state assertions fail.

- [ ] **Step 3: Implement tray projection**

Poll runtime status plus the current authenticated session summary. Build menu rows from the pure model. Navigate service rows to `/status/services/{gateway|solid-server|api-server}` and workspaces to canonical roots. Use state-specific macOS template images while retaining text labels and tooltip evidence.

- [ ] **Step 4: Run tray tests and verify GREEN**

Run: `bun test desktop/test/tray-menu.test.ts desktop/test/tray-icon.test.ts`

Expected: all tray tests pass.

### Task 4: Packaged-App Verification

**Files:**
- Modify: `desktop/package.json`
- Modify: `docs/cli-dev-testing.md`
- Test: packaged DMG and extracted app

- [ ] **Step 1: Build all product surfaces**

Run: `bun run build`

Expected: TypeScript, Components.js, packages, and UI builds succeed.

- [ ] **Step 2: Run desktop and repository tests**

Run: `bun test desktop/test/*.test.ts`

Run: `bun run test:integration`

Expected: desktop tests pass; lite and full integration suites pass.

- [ ] **Step 3: Build and inspect the installer**

Run: `bun run --cwd desktop dist`

Run: `hdiutil verify desktop/release/Xpod-0.1.0-arm64.dmg`

Expected: DMG and ZIP are generated and the disk image checksum is valid.

- [ ] **Step 4: Run a packaged smoke test**

Launch the extracted app against a clean user-data directory, verify runtime startup, canonical Status navigation, tray menu creation, then quit and confirm owned child cleanup according to the chosen lifecycle policy.

- [ ] **Step 5: Document developer-package limitations**

Record Apple Silicon architecture, unsigned/notarized status, install/open instructions, runtime ownership behavior, and the final artifact checksum. Do not claim release readiness without Developer ID signing and notarization.
