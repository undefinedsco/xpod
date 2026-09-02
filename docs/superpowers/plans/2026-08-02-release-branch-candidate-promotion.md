# Release Branch Candidate Promotion Implementation Plan

> **Historical plan:** implementation has evolved to the unified 0.4.0
> contract in [`../../specs/2026-08-02-release-branch-candidate-promotion-design.md`](../specs/2026-08-02-release-branch-candidate-promotion-design.md)
> and [`../../RELEASE.md`](../../RELEASE.md). In particular, RC publishes root
> plus macOS ARM64 native packages to `rc`, verifies installed QLever with
> Node/Bun, then moves `next`; stable uses `stable-staging` before `latest`.
> Do not execute the older job graph or artifact naming examples below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and deploy an isolated Xpod RC for every `release/<version>` commit, then allow a stable tag to promote only the exact commit and image digest that passed RC acceptance.

**Architecture:** CommonJS helpers derive candidate versions and validate redacted acceptance evidence. A candidate workflow publishes npm `next`, builds one immutable container, deploys one logically isolated RC Xpod on shared infrastructure, and records evidence. The stable workflow validates that evidence, publishes npm `latest`, retags the accepted digest without rebuilding, and starts a digest-pinned production rollout with rollback.

**Tech Stack:** GitHub Actions, Bun 1.3.8, Node.js 22, npm, Docker Buildx/GHCR, Kubernetes/Sealos, Vitest.

---

## Task 1: Derive candidate metadata

**Files:**
- Create: `scripts/release-candidate.cjs`
- Create: `tests/scripts/release-candidate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
expect(run('release/0.3.68', '42', '1')).toMatchObject({
  targetVersion: '0.3.68',
  candidateVersion: '0.3.68-rc.42',
});
expect(run('release/0.3.68', '42', '2').candidateVersion).toBe('0.3.68-rc.42.2');
expect(() => run('main', '42', '1')).toThrow(/release\/\<version\>/);
expect(() => run('release/0.3.68-rc.1', '42', '1')).toThrow(/stable SemVer/);
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/scripts/release-candidate.test.ts`

Expected: FAIL because `scripts/release-candidate.cjs` is missing.

- [ ] **Step 3: Implement the metadata CLI**

Export `deriveCandidate({ branch, runNumber, runAttempt, sha })`. Support `--json` and `--apply-root-version`. The latter changes only root `package.json`, then invokes the existing platform-version sync; it must not change `packages/*/package.json`. Reject non-release branches, prerelease branch versions, missing SHAs, and nonnumeric run fields.

- [ ] **Step 4: Verify GREEN**

Run the focused test and invoke the CLI against a temporary manifest copy. Assert the output is `0.3.68-rc.42` and workspace manifests are byte-identical.

- [ ] **Step 5: Commit**

Stage only the helper and test; include the focused command in `Tested:`.

## Task 2: Create promotion-safe acceptance evidence

**Files:**
- Create: `scripts/release-acceptance-manifest.cjs`
- Create: `tests/scripts/release-acceptance-manifest.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
expect(validate(manifest, { tag: 'v0.3.68', sha: 'a'.repeat(40) }))
  .toMatchObject({ imageDigest: 'sha256:' + 'b'.repeat(64) });
expect(() => validate({ ...manifest, sourceSha: 'c'.repeat(40) }, expected))
  .toThrow(/exact candidate commit/);
expect(() => validate({ ...manifest, imageDigest: 'latest' }, expected))
  .toThrow(/sha256 digest/);
expect(JSON.stringify(createManifest(input))).not.toContain('SECRET');
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/scripts/release-acceptance-manifest.test.ts`

Expected: FAIL because the helper is missing.

- [ ] **Step 3: Implement create and validate**

Use this exact public schema:

```ts
type AcceptanceManifest = {
  schemaVersion: 1;
  targetVersion: string;
  candidateVersion: string;
  sourceSha: string;
  sourceBranch: string;
  imageDigest: `sha256:${string}`;
  npmPackage: string;
  npmVersion: string;
  endpoint: string;
  acceptedAt: string;
  checks: Record<string, 'passed'>;
};
```

Validate stable tag, exact SHA, target version, `release/<version>` source branch, digest syntax, RC endpoint, and every required check. Read explicit arguments only; never serialize the process environment.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused test, stage only helper/test, and commit with evidence-validation constraints.

## Task 3: Add one isolated RC Xpod overlay

**Files:**
- Create: `deploy/sealos/rc/namespace.yaml`
- Create: `deploy/sealos/rc/kustomization.yaml`
- Create: `deploy/sealos/rc/patch-config.yaml`
- Create: `tests/scripts/rc-deployment-manifest.test.ts`

- [ ] **Step 1: Write the failing rendering test**

```ts
expect(rendered).toContain('namespace: xpod-rc');
expect(rendered).toContain('https://rc.id.undefineds.co');
expect(rendered).toContain('name: xpod-rc-secret');
expect(rendered).toContain('XPOD_REDIS_PREFIX');
expect(rendered).toContain('XPOD_OBJECT_PREFIX');
expect(rendered).not.toContain('name: xpod-cloud-secret');
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/scripts/rc-deployment-manifest.test.ts`

Expected: FAIL because the overlay does not exist.

- [ ] **Step 3: Implement the overlay**

Reference `deploy/sealos/cloud`, use namespace `xpod-rc`, and patch the Deployment to consume `xpod-rc-config` plus `xpod-rc-secret`. The RC `APP_ENV_FILE` supplies a separate DB/schema principal, Redis prefix, and object prefix while reusing the physical services. Keep one replica during acceptance; scale-to-zero is a workflow action.

- [ ] **Step 4: Verify GREEN and commit**

Run `kubectl kustomize deploy/sealos/rc` into `.test-data/`, run the focused test, then stage only overlay/test.

## Task 4: Publish and accept each release-branch commit

**Files:**
- Create: `.github/workflows/candidate.yml`
- Create: `tests/scripts/candidate-workflow.test.ts`
- Modify: `scripts/publish-release.cjs`
- Create: `tests/scripts/publish-release-tag.test.ts`

- [ ] **Step 1: Write failing publish-tag tests**

Test that `XPOD_PUBLISH_TAG=next` overrides prerelease inference, rejects invalid tags, and leaves stable default behavior unchanged.

- [ ] **Step 2: Write failing workflow tests**

```ts
expect(workflow).toContain("branches: ['release/**']");
expect(workflow).toContain('release-candidate.cjs --apply-root-version');
expect(workflow).toContain('XPOD_PUBLISH_TAG: next');
expect(workflow).toContain('environment: rc');
expect(workflow).toContain('https://rc.id.undefineds.co/service/status');
expect(workflow).toContain('release-acceptance-');
expect(workflow).not.toMatch(/--tag\s+latest/);
```

Also require per-branch concurrency cancellation and digest-pinned deployment.

- [ ] **Step 3: Verify RED**

Run: `bun test tests/scripts/publish-release-tag.test.ts tests/scripts/candidate-workflow.test.ts`

Expected: FAIL because the override and workflow do not exist.

- [ ] **Step 4: Implement the tag override**

Read and validate `XPOD_PUBLISH_TAG`, selecting it before `inferPublishTag(packageJson.version)`. Do not alter behavior when absent.

- [ ] **Step 5: Implement candidate jobs**

```yaml
jobs:
  metadata: {}
  verify-package-tarball: {}
  verify-package-tarball-bun: {}
  publish-npm-next:
    needs: [metadata, verify-package-tarball, verify-package-tarball-bun]
  build-image:
    needs: [metadata, verify-package-tarball, verify-package-tarball-bun]
  deploy-and-accept:
    needs: [metadata, publish-npm-next, build-image]
    environment: rc
```

Build once, push `sha-<full-sha>` and RC tags, record the canonical digest, and never mark `latest`.

- [ ] **Step 6: Implement RC acceptance**

Create `xpod-rc-secret` from the RC Environment's `APP_ENV_FILE`; report required Secret key names/presence only; apply the overlay; set the image by digest; check rollout, public health, OIDC, authenticated Pod read/write, and Node/Bun installation of the published RC; then upload `release-acceptance-${GITHUB_SHA}.json`. Add failure diagnostics and optional scale-to-zero via `XPOD_RC_SCALE_TO_ZERO=true`.

- [ ] **Step 7: Verify GREEN and commit**

Run both focused tests and `bunx actionlint .github/workflows/candidate.yml`. If unavailable, use the repository YAML parser without adding a dependency. Stage only the workflow, helper change, and tests.

## Task 5: Guard formal release and promote the accepted digest

**Files:**
- Modify: `.github/workflows/release.yml`
- Create: `tests/scripts/release-promotion-workflow.test.ts`

- [ ] **Step 1: Write the failing workflow test**

Require exact-SHA acceptance validation, `docker buildx imagetools create`, absence of `docker/build-push-action`, blocking Node/Bun consumer jobs, and production dispatch only after those jobs.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/scripts/release-promotion-workflow.test.ts`

Expected: FAIL because stable tags currently publish without RC evidence and rebuild the image.

- [ ] **Step 3: Add the promotion guard**

Query successful Candidate runs for `github.sha`, download the exact acceptance artifact, validate tag/SHA/version/endpoint/checks/digest, and verify the stable npm version is unused. Fail before any registry mutation. Do not accept a manually supplied digest.

- [ ] **Step 4: Promote without rebuilding**

```bash
docker buildx imagetools create \
  --tag "ghcr.io/undefinedsco/xpod:${TAG_VERSION}" \
  --tag "ghcr.io/undefinedsco/xpod:latest" \
  "ghcr.io/undefinedsco/xpod@${ACCEPTED_IMAGE_DIGEST}"
```

Publish stable npm from the accepted commit and make consumer checks blocking.
Invoke the production deployment as a reusable workflow with the accepted digest
so the release job waits for its result. Create the GitHub Release only after
that reusable deployment returns success.

- [ ] **Step 5: Verify GREEN and commit**

Run promotion and evidence tests plus YAML validation. Stage only workflow/tests.

## Task 6: Pin production and roll back automatically

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `tests/scripts/deploy-workflow-health-gate.test.ts`

- [ ] **Step 1: Extend the test and verify RED**

Require a `workflow_call` entry point with `image-digest` and `version` inputs,
prior-image capture, `kubectl set image`, and `if: failure()` rollback. Keep
`workflow_dispatch` for explicit recovery operations, but remove the asynchronous
`workflow_run` release trigger. Run the focused test and observe failure against
the current mutable-tag deployment.

- [ ] **Step 2: Implement digest deployment**

Validate `^sha256:[0-9a-f]{64}$`, capture the current Deployment image, apply manifests, then run:

```bash
kubectl -n "$SEALOS_NAMESPACE" set image deployment/xpod-cloud \
  "xpod=ghcr.io/undefinedsco/xpod@${IMAGE_DIGEST}"
```

On rollout/public-health failure, restore the exact previous image and await readiness before diagnostics.

- [ ] **Step 3: Verify GREEN and commit**

Run deployment and production-diagnostics tests. Stage only workflow/test.

## Task 7: Document and rehearse the lifecycle

**Files:**
- Modify: `docs/RELEASE.md`
- Modify: `deploy/sealos/cloud/DEPLOY.md`

- [ ] **Step 1: Document one-time RC setup**

```text
GitHub Environment: rc
Secrets: KUBE_CONFIG_DATA, APP_ENV_FILE
Variables: SEALOS_NAMESPACE=xpod-rc, XPOD_RC_SCALE_TO_ZERO=true
DNS: rc.id.undefineds.co
Shared services: isolated DB/schema principal, Redis prefix, object prefix
```

- [ ] **Step 2: Document operator commands**

```bash
git switch -c release/0.3.68
git push -u origin release/0.3.68
# normal commits publish successive RCs
git tag -s v0.3.68 <accepted-sha>
git push origin v0.3.68
```

Document npm immutability, failure recovery, branch deletion, and the ban on debugging with stable tags.

- [ ] **Step 3: Run complete local verification**

Run every new `tests/scripts` suite plus existing deployment diagnostics, `bun run build:ts`, and `bun run test:integration`. Expected: zero failures.

- [ ] **Step 4: Rehearse without a stable tag**

Push the next release branch and verify npm `next`, GHCR digest, RC rollout, public RC health/OIDC, acceptance artifact identity, and an unchanged production image. Missing RC Environment, DNS, or logical storage authority is a hard blocker; do not weaken the gate.

- [ ] **Step 5: Commit documentation and evidence**

Stage only release/deployment docs and record focused tests, typecheck, integration, and RC rehearsal evidence honestly.
