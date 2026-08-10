# Xpod Image Build Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a smaller default Xpod server image and a separate full agent-runner target, then build and distribute the QLever cutover image through gz-local CCR.

**Architecture:** One development dependency stage compiles all application artifacts. Two production dependency stages feed explicit `server` and `agent-runner` runtime targets; the default server omits optional Agent SDKs, while the runner retains them. BuildKit caches Bun packages and CI layers, and UI builds from the root workspace installation.

**Tech Stack:** Docker BuildKit, Bun 1.3.8 workspaces, Node 22 Alpine, Vitest, GitHub Actions, Kaniko/CCR for the production cutover.

---

### Task 1: Lock the image contract

**Files:**
- Create: `tests/scripts/docker-image-build-contract.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write a failing Vitest contract test**

Read `Dockerfile` and `package.json`; assert that `server` is the last stage, `server-deps` uses `--production --omit optional`, `agent-deps` uses `--production`, BuildKit cache mounts exist, and `build:ui` contains no `bun install`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun run test:run tests/scripts/docker-image-build-contract.test.ts`

Expected: FAIL because the Dockerfile has one runtime target and `build:ui` reinstalls dependencies.

### Task 2: Split and cache the Docker build

**Files:**
- Modify: `Dockerfile`
- Modify: `package.json`

- [ ] **Step 1: Add manifest-only dependency layers**

Copy the four `packages/*/package.json` manifests and `ui/package.json` before the cached development install. Copy source only after this layer.

- [ ] **Step 2: Build UI from the root workspace install**

Change `build:ui` to `bun run --cwd ui build:all` so it does not resolve the dependency tree again.

- [ ] **Step 3: Add production dependency targets**

Create `server-deps` with `bun install --production --omit optional --omit peer --frozen-lockfile` and `agent-deps` with `bun install --production --frozen-lockfile`. Mount `/root/.bun/install/cache` as a BuildKit cache in every install step.

- [ ] **Step 4: Add explicit runtime targets**

Create shared runtime content, then `agent-runner` and final `server` stages. Both copy the same compiled output; each copies only its corresponding production `node_modules`.

- [ ] **Step 5: Run the contract test**

Run: `bun run test:run tests/scripts/docker-image-build-contract.test.ts`

Expected: PASS.

### Task 3: Verify application builds outside Docker

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run TypeScript and Components.js checks**

Run: `bun run build:ts && bun run build:components && node scripts/check-components-runtime-metadata.cjs`

Expected: exit 0.

- [ ] **Step 2: Run workspace and UI builds**

Run: `bun run build:packages && bun run build:ui`

Expected: exit 0 without a nested install.

### Task 4: Verify Docker targets incrementally

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Build the server dependency target**

Run: `docker build --target server-deps -t xpod:server-deps-test .`

Expected: exit 0 and no optional Claude/Zed package directories in `/app/node_modules`.

- [ ] **Step 2: Build the server runtime**

Run: `docker build --target server -t xpod:qlever-cutover .`

Expected: exit 0; `node dist/main.js --help` loads without a missing-module error.

- [ ] **Step 3: Build the agent-runner runtime**

Run: `docker build --target agent-runner -t xpod:agent-runner-test .`

Expected: exit 0 and the Claude/Zed packages exist in `/app/node_modules`.

- [ ] **Step 4: Record sizes and timings**

Run: `docker image inspect xpod:qlever-cutover xpod:agent-runner-test --format '{{.RepoTags}} {{.Size}}'`

Expected: the server image is materially smaller than the agent-runner image.

### Task 5: Complete the QLever startup gate

**Files:**
- Modify: `src/storage/indexing/PostgresDerivedIndexJournal.ts`
- Modify: the existing CSS initialization configuration under `config/`
- Test: the existing journal and production cutover tests

- [ ] **Step 1: Add a failing initialization test**

Assert that CSS initialization calls the journal's public `initialize()` before health becomes ready and creates `derived_index_change_journal` without waiting for the first write.

- [ ] **Step 2: Implement the standard CSS Initializable contract**

Make the journal use its existing idempotent open/create-table logic from `initialize()` and register the component in the existing initializer chain. Do not add a fallback or parallel schema path.

- [ ] **Step 3: Run focused storage and cutover tests**

Run the journal unit test, QLever adapter tests, production cutover script tests and configuration contract tests.

Expected: all pass.

### Task 6: Run full verification and create the immutable image

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run complete integration verification**

Run: `bun run test:integration`

Expected: exit 0.

- [ ] **Step 2: Squash the cohesive changes**

Stage only reviewed files, inspect `git diff --cached`, and amend/create one Lore-compliant squash commit with exact tested/not-tested trailers.

- [ ] **Step 3: Build and push from gz to CCR**

Build the final `server` target with registry cache and push `ccr.ccs.tencentyun.com/undefineds/xpod` by immutable digest. Record build, upload, size and digest evidence.

- [ ] **Step 4: Pull and smoke the exact digest**

Create a disposable gz Pod using `repository@sha256`, verify startup, then delete the disposable resources.

### Task 7: Cut over production

**Files:**
- Use: `.github/workflows/qlever-production-cutover.yml`
- Use: production Kubernetes resources in namespace `ns-1yl0rye9`

- [ ] **Step 1: Execute the no-migration cutover gate**

Supply the verified PG17/QLever and Xpod server digests. Require PostgreSQL readiness, QLever readiness, journal table existence, SPARQL ASK and application health before promotion.

- [ ] **Step 2: Promote production workloads**

Replace PostgreSQL 16 with the verified PostgreSQL 17/QLever image and replace Xpod deployments with the verified server digest. Do not copy old data.

- [ ] **Step 3: Verify public and internal behavior**

Verify CSS/API health, restart counts, QLever query path, PG-native FTS configuration, journal consumption, and representative RDF read/write/query behavior.

- [ ] **Step 4: Remove temporary cutover resources**

Delete only the explicitly named canary/build resources after successful promotion and retain immutable digests in the handoff evidence.
