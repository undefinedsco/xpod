# RC R2 Object Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the RC deployment use the dedicated Cloudflare R2 `xpod-rc` bucket from `APP_ENV_FILE` and remove the temporary in-cluster MinIO stack.

**Architecture:** `xpod-rc-secret`, rendered from the GitHub `rc` Environment's `APP_ENV_FILE`, remains the only object-storage configuration source. The RC overlay no longer creates or references MinIO resources. The candidate workflow validates the existing `CSS_MINIO_*` compatibility variables, rolls out Xpod against R2, verifies the effective endpoint without exposing credentials, then removes obsolete RC MinIO resources.

**Tech Stack:** GitHub Actions, Kubernetes/Kustomize, Bun, Vitest, Cloudflare R2 through the existing MinIO S3-compatible client.

---

### Task 1: Lock the R2-only deployment contract

**Files:**
- Modify: `tests/scripts/rc-deployment-manifest.test.ts`
- Modify: `tests/scripts/candidate-workflow.test.ts`

- [x] **Step 1: Replace MinIO resource expectations with absence assertions**

Update the rendered-manifest test to assert that no object has a name beginning with `xpod-rc-minio`, no `PersistentVolumeClaim` is rendered, and the Xpod container has no explicit `CSS_MINIO_*` entries.

- [x] **Step 2: Require R2 validation and cleanup in the workflow test**

Assert that the workflow requires these exact keys without printing values:

```text
CSS_MINIO_ENDPOINT
CSS_MINIO_BUCKET_NAME
CSS_MINIO_ACCESS_KEY
CSS_MINIO_SECRET_KEY
```

Assert that it checks the bucket is `xpod-rc`, contains `kubectl delete` for the four legacy MinIO resource kinds, and no longer creates `xpod-rc-object-store` or waits for `xpod-rc-minio`.

- [x] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
bunx vitest run tests/scripts/rc-deployment-manifest.test.ts tests/scripts/candidate-workflow.test.ts
```

Expected: failures identify the existing MinIO manifest, environment overrides, and workflow lifecycle steps.

### Task 2: Remove RC MinIO and consume R2 configuration

**Files:**
- Delete: `deploy/sealos/rc/object-store.yaml`
- Modify: `deploy/sealos/rc/kustomization.yaml`
- Modify: `deploy/sealos/rc/deployment.yaml`
- Modify: `.github/workflows/candidate.yml`
- Modify: `deploy/sealos/rc/README.md`

- [x] **Step 1: Remove the object-store resource from the overlay**

Delete `object-store.yaml` and its kustomization resource entry. Remove the four explicit `CSS_MINIO_*` entries from the Xpod container so `envFrom.secretRef.name: xpod-rc-secret` supplies them.

- [x] **Step 2: Validate the R2 contract before applying secrets**

Extend the existing Node parser for `${RUNNER_TEMP}/xpod-rc.env` to require all four `CSS_MINIO_*` keys and throw if `CSS_MINIO_BUCKET_NAME !== 'xpod-rc'`. Do not log parsed values.

- [x] **Step 3: Remove MinIO creation and readiness checks**

Delete creation of `xpod-rc-object-store`, `rollout status deployment/xpod-rc-minio`, and the MinIO initialization Job wait. Preserve the Xpod rollout and public/authenticated checks.

- [x] **Step 4: Verify the effective Xpod configuration and clean legacy resources**

After Xpod is healthy, inspect only the container environment variable sources to prove the four keys come from `xpod-rc-secret`; do not decode them. Then run an idempotent deletion:

```bash
kubectl -n "$SEALOS_NAMESPACE" delete deployment/xpod-rc-minio service/xpod-rc-minio job/xpod-rc-minio-init pvc/xpod-rc-minio secret/xpod-rc-object-store --ignore-not-found
```

- [x] **Step 5: Update the RC deployment documentation**

State that RC uses Cloudflare R2 bucket `xpod-rc` through `APP_ENV_FILE`, that production is untouched, and that the historical `CSS_MINIO_*` names are retained only for compatibility in this release.

- [x] **Step 6: Run focused tests and manifest validation**

Run:

```bash
bunx vitest run tests/scripts/rc-deployment-manifest.test.ts tests/scripts/candidate-workflow.test.ts
node scripts/render-rc-manifests.cjs --overlay deploy/sealos/rc --output /tmp/xpod-rc-rendered.yaml --namespace ns-1yl0rye9 --secret-name xpod-rc-secret
kubectl apply --dry-run=server --validate=false -f /tmp/xpod-rc-rendered.yaml
```

Expected: tests pass; server dry-run succeeds; rendered resources contain no MinIO workload, Service, Job, PVC, or credential Secret.

### Task 3: Deploy and prove R2-backed Pod isolation

**Files:**
- Modify only if a verified failure requires it: `.github/workflows/candidate.yml`, acceptance scripts, or product code implicated by the redacted report.

- [ ] **Step 1: Commit and push the R2 deployment change**

Use a Lore-format commit recording the managed R2 constraint, focused tests, server dry-run, and that production was not changed. Push `release/0.3.71` to trigger the RC workflow.

- [ ] **Step 2: Monitor the candidate workflow through authenticated acceptance**

Verify package matrices, image-by-digest deployment, TLS, public routes, OIDC, dashboard, protected-route rejection, and the authenticated Pod smoke all pass.

- [ ] **Step 3: Verify live cluster state**

Confirm `Deployment/xpod-rc` is Ready; no `xpod-rc-minio` Deployment, Service, Job, PVC, or object-store Secret remains; and Xpod logs show the configured R2 hostname without displaying keys.

- [ ] **Step 4: Verify the acceptance artifact**

Download the release acceptance artifact and confirm `authenticated-pod`, public service, OIDC, image digest, and npm checks are all `passed`. Confirm the Alice/Bob test wrote, reloaded, and removed a provider record and Bob's provider count did not change.

- [ ] **Step 5: Run the required full local regression before completion**

Run:

```bash
bun run build:ts
bun run test:integration
```

Expected: both exit zero. If integration depends on Docker, retain the complete output as evidence rather than replacing it with focused tests.

- [ ] **Step 6: Report remaining risks honestly**

Report the live RC URLs, R2 bucket name, workflow and artifact links, tests, and Nginx gateway block. Explicitly note that `CSS_S3_*` naming migration is deferred until production replacement and that pgvector remains unavailable if the shared database image still lacks the extension.
