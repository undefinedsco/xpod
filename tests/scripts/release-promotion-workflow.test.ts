import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/release.yml');

type Workflow = Record<string, any>;

async function loadWorkflowText(): Promise<string> {
  return readFile(workflowPath, 'utf8');
}

async function loadWorkflow(): Promise<Workflow> {
  return parseDocument(await loadWorkflowText()).toJSON() as Workflow;
}

function stepRuns(job: any): string[] {
  return (job.steps ?? [])
    .map((step: any) => step.run)
    .filter((run: unknown): run is string => typeof run === 'string');
}

function jobRunText(workflow: Workflow, jobName: string): string {
  return stepRuns(workflow.jobs[jobName]).join('\n');
}

function allRunText(workflow: Workflow): string {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job: any) => stepRuns(job))
    .join('\n');
}

function stepIndex(job: any, name: string): number {
  return (job.steps ?? []).findIndex((step: any) => step.name === name);
}

describe('stable release promotion workflow', () => {
  it('runs only for stable v tags with minimal top-level permissions and no error-tolerant gates', async () => {
    const workflow = await loadWorkflow();
    const text = await loadWorkflowText();

    expect(workflow.on.push.tags).toEqual([ 'v*' ]);
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(workflow.permissions).toEqual({
      contents: 'read',
    });
    expect(workflow.concurrency).toEqual({
      group: 'stable-release-${{ github.repository }}-${{ github.workflow }}',
      'cancel-in-progress': false,
    });
    expect(workflow.concurrency.group).not.toContain('github.ref');
    expect(workflow.concurrency.group).not.toContain('github.ref_name');
    expect(workflow.concurrency.group).not.toContain('github.sha');
    expect(text).not.toContain('continue-on-error');
    expect(text).not.toContain('docker/build-push-action');
    expect(text).not.toContain('docker/metadata-action');
    expect(text).not.toMatch(/\bbuild-and-push\b/);
  });

  it('validates the tag, exact commit, release branch, candidate artifact, and digest without blocking npm reruns', async () => {
    const workflow = await loadWorkflow();
    const guard = workflow.jobs.promotion_guard;
    const runText = jobRunText(workflow, 'promotion_guard');

    expect(guard['runs-on']).toBe('ubuntu-latest');
    expect(guard.permissions).toEqual({
      actions: 'read',
      contents: 'read',
    });
    expect(guard.outputs).toMatchObject({
      version: expect.stringContaining('version'),
      image_digest: expect.stringContaining('image_digest'),
      source_branch: expect.stringContaining('source_branch'),
    });
    expect(guard.env).toMatchObject({
      TAG_NAME: '${{ github.ref_name }}',
      TAG_SHA: '${{ github.sha }}',
      GH_TOKEN: '${{ github.token }}',
    });
    expect(runText).toContain("TAG_REGEX='^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(runText).toContain('git branch --remote --contains "$TAG_SHA"');
    expect(runText).toContain('release/$VERSION');
    expect(runText).toContain('gh run list');
    expect(runText).toContain('Release Candidate');
    expect(runText).toContain('--commit "$TAG_SHA"');
    expect(runText).toContain('--status success');
    expect(runText).toContain('release-acceptance-${TAG_SHA}');
    expect(runText).toContain('gh run download "$CANDIDATE_RUN_ID"');
    expect(runText).toContain('node scripts/release-acceptance-manifest.cjs validate');
    expect(runText).toContain('--tag "$TAG_NAME"');
    expect(runText).toContain('--source-sha "$TAG_SHA"');
    for (const check of [
      'image',
      'service-status',
      'oidc',
      'dashboard',
      'protected-route',
      'deployed-digest',
      'direct-pod',
      'public-service',
      'secret-isolation',
      'authenticated-pod',
      'pod-read-write',
      'gateway-key',
      'ai-connections',
      'models',
      'chat',
    ]) {
      expect(runText).toContain(`--required-check ${check}`);
    }
    expect(runText).not.toContain('--required-check npm-node');
    expect(runText).not.toContain('--required-check npm-bun');
    expect(runText).not.toContain('stable npm version already exists');
    expect(runText).not.toContain('registry_url="https://registry.npmjs.org/@undefineds.co%2fxpod/${VERSION}"');
    expect(runText).not.toContain('npm_status=');
    expect(runText).toContain('image_digest=');
    expect(runText).not.toContain('workflow_dispatch');
    expect(runText).not.toContain('INPUT_DIGEST');
  });

  it('publishes npm latest idempotently from the exact accepted commit and makes Node and Bun consumers blocking', async () => {
    const workflow = await loadWorkflow();
    const publish = workflow.jobs.publish_npm_latest;
    const publishRunText = jobRunText(workflow, 'publish_npm_latest');
    const publishStep = publish.steps.find((step: any) => step.name === 'Publish stable package to npm latest');
    const latestGuardRun = publish.steps.find((step: any) => step.name === 'Guard npm latest before publish')?.run ?? '';
    const ensureLatestRun = publish.steps.find((step: any) => step.name === 'Ensure npm latest dist-tag')?.run ?? '';

    expect(publish.needs).toBe('promotion_guard');
    expect(publish.env).toMatchObject({
      NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}',
      XPOD_PUBLISH_REGISTRY: 'https://registry.npmjs.org',
      XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      XPOD_ACCEPTED_SHA: '${{ github.sha }}',
    });
    expect(publish.env.XPOD_PUBLISH_TAG).toBeUndefined();
    expect(publishRunText).toContain('git checkout --detach "$XPOD_ACCEPTED_SHA"');
    expect(publishRunText).toContain('node -e');
    expect(publishRunText).toContain('packageJson.version !== process.env.RELEASE_VERSION');
    expect(publishRunText).toContain('registry_url="https://registry.npmjs.org/@undefineds.co%2fxpod/${RELEASE_VERSION}"');
    expect(publishRunText).toContain('npm_status=');
    expect(publishRunText).toContain('exists=false');
    expect(publishRunText).toContain('exists=true');
    expect(publishRunText).toContain('failed to verify stable npm version availability');
    expect(publishRunText).toContain('published version mismatch');
    expect(publishRunText).toContain('node scripts/publish-release.cjs --skip-build');
    expect(publishStep.if).toBe("steps.npm_state.outputs.exists == 'false'");
    expect(stepIndex(publish, 'Guard npm latest before publish')).toBeGreaterThan(-1);
    expect(stepIndex(publish, 'Guard npm latest before publish')).toBeLessThan(stepIndex(publish, 'Publish stable package to npm latest'));
    expect(latestGuardRun).toContain('function parseStableVersion');
    expect(latestGuardRun).toMatch(/const match = \/\^\(0\|\[1-9\]\\d\*\)\\\.\(0\|\[1-9\]\\d\*\)\\\.\(0\|\[1-9\]\\d\*\)\$\/\.exec\(value\);/);
    expect(latestGuardRun).toContain('function compareStable');
    expect(latestGuardRun).toContain('compareStable(latestVersion, releaseVersion) > 0');
    expect(latestGuardRun).toContain('npm latest dist-tag is newer than release version');
    expect(latestGuardRun).not.toContain('npm dist-tag add');
    expect(latestGuardRun).not.toContain('node scripts/publish-release.cjs');
    expect(publishRunText).toContain('npm view "@undefineds.co/xpod" dist-tags.latest --json');
    expect(publishRunText).toContain('npm dist-tag add "@undefineds.co/xpod@$RELEASE_VERSION" latest');
    expect(publishRunText).toContain('npm latest dist-tag points to unexpected version');
    expect(publishRunText).toContain('npm latest dist-tag did not verify');
    expect(ensureLatestRun).toContain('for attempt in $(seq 1 12)');
    expect(ensureLatestRun).toContain('sleep 5');

    for (const jobName of [ 'verify_npm_consumer_node', 'verify_npm_consumer_bun' ]) {
      const job = workflow.jobs[jobName];
      expect(job.needs).toEqual(expect.arrayContaining([ 'promotion_guard', 'publish_npm_latest' ]));
      expect(job['continue-on-error']).toBeUndefined();
      expect(job.strategy.matrix.os).toEqual(expect.arrayContaining([ 'ubuntu-latest', 'macos-latest' ]));
      expect(job.strategy.matrix['node-version']).toEqual([ 22, 24, 25 ]);
      expect(job.env.RELEASE_VERSION).toBe('${{ needs.promotion_guard.outputs.version }}');
      expect(jobRunText(workflow, jobName)).toContain('@undefineds.co/xpod@$RELEASE_VERSION');
      expect(jobRunText(workflow, jobName)).toContain('node scripts/wait-for-npm-package.cjs');
      expect(jobRunText(workflow, jobName)).toContain('scripts/package-smoke-install.cjs');
    }
    expect(jobRunText(workflow, 'verify_npm_consumer_node')).toContain('node scripts/package-consumer-smoke.cjs');
    expect(jobRunText(workflow, 'verify_npm_consumer_bun')).toContain('bun scripts/package-consumer-smoke.cjs');
  });

  it('promotes the accepted GHCR digest to stable and latest tags without rebuilding', async () => {
    const workflow = await loadWorkflow();
    const promote = workflow.jobs.promote_image;
    const runText = jobRunText(workflow, 'promote_image');

    expect(promote.needs).toEqual(expect.arrayContaining([
      'promotion_guard',
      'publish_npm_latest',
      'verify_npm_consumer_node',
      'verify_npm_consumer_bun',
    ]));
    expect(promote.permissions).toEqual({
      contents: 'read',
      packages: 'write',
    });
    expect(promote.env).toMatchObject({
      TAG_VERSION: '${{ needs.promotion_guard.outputs.version }}',
      ACCEPTED_IMAGE_DIGEST: '${{ needs.promotion_guard.outputs.image_digest }}',
    });
    expect(runText).toContain('docker buildx imagetools create');
    expect(runText).toContain('--tag "ghcr.io/undefinedsco/xpod:${TAG_VERSION}"');
    expect(runText).toContain('--tag "ghcr.io/undefinedsco/xpod:latest"');
    expect(runText).toContain('"ghcr.io/undefinedsco/xpod@${ACCEPTED_IMAGE_DIGEST}"');
    expect(runText).toContain('docker buildx imagetools inspect "ghcr.io/undefinedsco/xpod:${TAG_VERSION}"');
    expect(runText).toContain('docker buildx imagetools inspect "ghcr.io/undefinedsco/xpod:latest"');
    expect(runText).not.toMatch(/docker\s+build(?!x)/);
  });

  it('waits for production deploy before creating the GitHub Release', async () => {
    const workflow = await loadWorkflow();
    const deploy = workflow.jobs.deploy_production_co;
    const release = workflow.jobs.create_github_release;

    expect(deploy.needs).toEqual(expect.arrayContaining([
      'promotion_guard',
      'publish_npm_latest',
      'verify_npm_consumer_node',
      'verify_npm_consumer_bun',
      'promote_image',
    ]));
    expect(deploy.uses).toBe('./.github/workflows/deploy.yml');
    expect(deploy.permissions).toEqual({
      contents: 'read',
      packages: 'read',
    });
    expect(deploy.with).toEqual({
      version: '${{ needs.promotion_guard.outputs.version }}',
      'image-digest': '${{ needs.promotion_guard.outputs.image_digest }}',
      environment: 'co',
    });
    expect(release.needs).toEqual(expect.arrayContaining([ 'deploy_production_co' ]));
    expect(release.permissions).toEqual({
      contents: 'write',
    });
    expect(release.env.GH_REPO).toBe('${{ github.repository }}');
    expect(jobRunText(workflow, 'create_github_release')).toContain('gh release view "$TAG_NAME"');
    expect(jobRunText(workflow, 'create_github_release')).toContain('gh release edit "$TAG_NAME"');
    expect(jobRunText(workflow, 'create_github_release')).toContain('gh release create "$TAG_NAME"');
    expect(jobRunText(workflow, 'create_github_release')).toContain('--verify-tag');
  });

  it('injects dynamic inputs through env instead of shell-interpolating GitHub expressions', async () => {
    const workflow = await loadWorkflow();
    const runText = allRunText(workflow);

    expect(runText).not.toContain('${{ github.ref_name }}');
    expect(runText).not.toContain('${{ github.sha }}');
    expect(runText).not.toContain('${{ needs.promotion_guard.outputs.version }}');
    expect(runText).not.toContain('${{ needs.promotion_guard.outputs.image_digest }}');
  });
});
