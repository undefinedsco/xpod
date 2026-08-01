# Xpod Applet Packages Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the editable AI Connection, Extension SDK, Solid SDK, and Shared UI sources into the Xpod monorepo, replace vendored build artifacts with workspace dependencies, and start the standalone Xpod UI from those sources.

**Architecture:** Xpod becomes the source repository for four independently publishable packages under `packages/`. The root Bun workspace builds packages in dependency order, while `ui/` consumes them via `workspace:*`; packages may depend on browser and React libraries but may not import Xpod server modules. Existing `vendor/` artifacts are removed only after package and UI builds prove the workspace path works.

**Tech Stack:** Bun workspaces, TypeScript, React 19, Vitest, Vite, Inrupt Solid OIDC.

---

### Task 1: Lock the package boundary

**Files:**
- Create: `tests/package/applet-packages.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write a failing package-boundary test**

Create assertions that the root declares `packages/*` as a workspace, each package contains editable `src/` and `test/` directories, UI dependencies use `workspace:*`, and no UI dependency points at `vendor/`.

```js
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)))
assert(root.workspaces.includes('packages/*'))

for (const name of ['ai-connection', 'extension-sdk', 'shared-ui', 'solid-sdk']) {
  await stat(new URL(`../../packages/${name}/src`, import.meta.url))
  await stat(new URL(`../../packages/${name}/test`, import.meta.url))
}

const ui = JSON.parse(await readFile(new URL('../../ui/package.json', import.meta.url)))
for (const dependency of [
  '@undefineds.co/ai-connection',
  '@undefineds.co/extension-sdk',
  '@undefineds.co/shared-ui',
  '@undefineds.co/solid-sdk',
]) {
  assert.equal(ui.dependencies[dependency], 'workspace:*')
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/package/applet-packages.test.mjs`

Expected: FAIL because `packages/` is not yet present and UI still resolves `vendor/`.

### Task 2: Import editable package sources

**Files:**
- Create: `packages/ai-connection/{package.json,tsconfig.json,src/**,test/**}`
- Create: `packages/extension-sdk/{package.json,tsconfig.json,README.md,src/**,test/**}`
- Create: `packages/shared-ui/{package.json,tsconfig.json,src/**,test/**}`
- Create: `packages/solid-sdk/{package.json,tsconfig.json,src/**,test/**}`
- Create: `scripts/fix-dist-js-imports.mjs`

- [ ] **Step 1: Import source and tests, excluding generated data**

Copy the tracked package manifests, sources, tests, and documentation from the `codex/applet-packages` Linx worktree. Do not copy `dist/`, `.test-data/`, lockfiles, or `node_modules/`.

- [ ] **Step 2: Convert package scripts and internal dependencies to Bun workspace semantics**

Use build scripts that invoke local tools and internal dependencies without Yarn:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@undefineds.co/extension-sdk": "workspace:*",
    "@undefineds.co/shared-ui": "workspace:*",
    "@undefineds.co/solid-sdk": "workspace:*"
  }
}
```

Keep only dependencies each package actually imports. Preserve all current public export paths.

- [ ] **Step 3: Verify package sources do not import server internals**

Run: `rg -n "from ['\"](src/|@undefineds.co/xpod|\.\./\.\./src)" packages`

Expected: no matches.

### Task 3: Wire the Xpod workspace

**Files:**
- Modify: `package.json`
- Modify: `ui/package.json`
- Modify: `bun.lock`
- Modify: `ui/bun.lock`

- [ ] **Step 1: Declare workspaces and package scripts**

Add the following root contract:

```json
{
  "workspaces": ["packages/*", "ui"],
  "scripts": {
    "build:packages": "bun run --filter '@undefineds.co/solid-sdk' build && bun run --filter '@undefineds.co/shared-ui' build && bun run --filter '@undefineds.co/extension-sdk' build && bun run --filter '@undefineds.co/ai-connection' build",
    "test:packages": "bun run --filter './packages/*' test"
  }
}
```

Retain existing unrelated root scripts and the user's current package edits.

- [ ] **Step 2: Replace UI vendor dependencies**

Set the four internal UI dependencies to `workspace:*` and retain the existing public package names.

- [ ] **Step 3: Install with Bun and regenerate locks**

Run: `bun install`

Expected: the four packages are linked from `packages/`, with no registry lookup for version `0.1.0`.

- [ ] **Step 4: Re-run the package-boundary test**

Run: `node --test tests/package/applet-packages.test.mjs`

Expected: PASS.

### Task 4: Prove each SDK and consumer build

**Files:**
- Modify only files in `packages/**` required by compiler or test failures.

- [ ] **Step 1: Run package tests**

Run: `bun run test:packages`

Expected: all package Vitest suites pass.

- [ ] **Step 2: Build packages in dependency order**

Run: `bun run build:packages`

Expected: all four packages emit `dist/` and preserve declared exports.

- [ ] **Step 3: Build the Xpod UI against workspace packages**

Run: `bun run build:ui`

Expected: TypeScript and Vite build pass without resolving `vendor/`.

- [ ] **Step 4: Run Xpod type and package regression checks**

Run: `bun run build:ts && node --test tests/package/applet-packages.test.mjs`

Expected: both commands pass.

### Task 5: Remove superseded vendor artifacts and launch the product

**Files:**
- Delete: `vendor/@undefineds.co/ai-connection/**`
- Delete: `vendor/@undefineds.co/extension-sdk/**`
- Delete: `vendor/@undefineds.co/shared-ui/**`
- Delete: `vendor/@undefineds.co/solid-sdk/**`
- Modify: `package.json`

- [ ] **Step 1: Remove the four vendored packages**

Delete only the four paths above after Task 4 passes. Remove `vendor` from root package publication files if the directory becomes empty.

- [ ] **Step 2: Verify no source or manifest references vendor packages**

Run: `rg -n "vendor/@undefineds.co|file:../vendor" package.json ui packages src scripts tests`

Expected: no matches.

- [ ] **Step 3: Run the full required regression suite**

Run: `bun run test:integration`

Expected: PASS. If infrastructure is unavailable, record the exact external blocker and retain all passing focused evidence.

- [ ] **Step 4: Start the standalone Xpod settings product**

Run: `bun run settings:dev`

Expected: Vite prints a local URL and `/applets/ai-connection` loads from workspace package sources.

- [ ] **Step 5: Commit only migration-owned files**

Stage explicit `packages/`, manifest, lock, test, and removal paths after checking for secrets and unrelated user changes. Use a Lore commit that records package-boundary verification and any unrun integration checks.
