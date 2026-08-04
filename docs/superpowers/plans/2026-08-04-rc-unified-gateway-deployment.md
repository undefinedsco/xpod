# RC Unified Gateway Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an isolated RC Xpod in the CO Sealos namespace behind the existing unified Nginx Gateway with identity, Pod storage, and API hosts.

**Architecture:** RC owns only `xpod-rc` runtime resources and isolated data configuration. It reuses the production namespace, physical infrastructure, shared Inngest, and unified Gateway, while distinct resource names, Inngest identities, database/schema, Redis DB, and object bucket prevent production mutation.

**Tech Stack:** Kubernetes/Kustomize, Sealos ingress-nginx, Nginx, GitHub Actions, TypeScript/Bun, Inngest.

---

### Task 1: Lock the safe rendered resource graph

**Files:**
- Modify: `tests/scripts/rc-deployment-manifest.test.ts`
- Modify: `tests/scripts/render-rc-manifests.test.ts`
- Modify: `deploy/sealos/rc/*.yaml`

- [ ] Add failing assertions that rendering produces only `xpod-rc` Deployment/Service/ConfigMap and three Gateway-backed Ingresses in the assigned namespace.
- [ ] Assert no Namespace, production `xpod` resource, or private RC Inngest Deployment/Service is rendered.
- [ ] Rename the RC Service to `xpod-rc`, remove namespace and private Inngest resources, and set the three RC hosts.
- [ ] Run `bun test tests/scripts/rc-deployment-manifest.test.ts tests/scripts/render-rc-manifests.test.ts` and require all assertions to pass.

### Task 2: Give shared Inngest collision-safe RC identities

**Files:**
- Modify: `src/api/runs/InngestRunExecutionBackend.ts`
- Modify: `src/api/container/index.ts`
- Modify: `deploy/sealos/cloud/inngest-deployment.yaml`
- Test: relevant `tests/api/runs/*Inngest*` tests

- [ ] Add failing tests proving `XPOD_INNGEST_SOURCE=rc` changes app ID, function ID, event name, event ID, and payload source.
- [ ] Implement a normalized source marker with stable production default and RC-specific identities.
- [ ] Configure shared Inngest to poll both `http://xpod/api/inngest` and `http://xpod-rc/api/inngest` and accept both production and RC Event Keys without changing the shared Signing Key.
- [ ] Run the focused Inngest tests and require them to pass.

### Task 3: Route candidate deployment through the unified Gateway

**Files:**
- Modify: `.github/workflows/candidate.yml`
- Modify: `tests/scripts/candidate-workflow.test.ts`
- Modify: `deploy/sealos/rc/README.md`
- Modify: `docs/RELEASE.md`

- [ ] Add failing workflow tests for the fixed assigned namespace, three DNS hosts, three post-Ingress TLS checks, shared Inngest verification, and RC-only rollout/diagnostics/scale targets.
- [ ] Remove namespace creation and all direct RC-to-public routing assumptions.
- [ ] Render and apply RC resources, then patch the existing Gateway ConfigMap with idempotent host routes and reload Nginx.
- [ ] Run the focused workflow tests and require them to pass.

### Task 4: Verify real Solid storage behavior

**Files:**
- Modify: `scripts/prepare-rc-authenticated-smoke.ts`
- Modify: `scripts/assert-rc-authenticated-smoke.cjs`
- Modify: corresponding tests under `tests/scripts/`

- [ ] Add failing tests requiring OIDC issuer verification, WebID storage discovery, authenticated Pod create/read/update/delete, and authenticated API access through the RC hosts.
- [ ] Implement the minimum acceptance changes and ensure generated credentials remain runtime-only.
- [ ] Run all RC acceptance script tests and require them to pass.

### Task 5: Deploy and collect evidence

**Files:**
- Modify only generated Kubernetes resources and GitHub Actions runtime state; do not commit credentials.

- [ ] Run build, focused release tests, package tests, lite integration, and full integration.
- [ ] Render manifests for `ns-1yl0rye9` and inspect every object before apply.
- [ ] Apply `xpod-rc` resources, update the shared Gateway and Inngest additively, wait for rollout and TLS, then execute public and authenticated acceptance.
- [ ] Record image digest, resource status, endpoint results, Pod CRUD evidence, and any remaining external DNS blocker.
- [ ] Commit with Lore trailers, push `release/0.3.71`, and confirm the candidate workflow result.
