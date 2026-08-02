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

describe('stable release promotion workflow', () => {
  it('runs only for stable v tags with minimal top-level permissions and no error-tolerant gates', async () => {
    const workflow = await loadWorkflow();
    const text = await loadWorkflowText();

    expect(workflow.on.push.tags).toEqual([ 'v*' ]);
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(workflow.permissions).toEqual({
      contents: 'read',
    });
    expect(text).not.toContain('continue-on-error');
    expect(text).not.toContain('docker/build-push-action');
    expect(text).not.toContain('docker/metadata-action');
    expect(text).not.toMatch(/\bbuild-and-push\b/);
  });

  it('validates the tag, exact commit, release branch, candidate artifact, digest, and unused npm version before publishing', async () => {
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
    expect(runText).toContain('registry_url="https://registry.npmjs.org/@undefineds.co%2fxpod/${VERSION}"');
    expect(runText).toContain('stable npm version already exists');
    expect(runText).toContain('image_digest=');
    expect(runText).not.toContain('workflow_dispatch');
    expect(runText).not.toContain('INPUT_DIGEST');
  });

  it('publishes npm latest from the exact accepted commit and makes Node and Bun consumers blocking', async () => {
    const workflow = await loadWorkflow();
    const publish = workflow.jobs.publish_npm_latest;

    expect(publish.needs).toBe('promotion_guard');
    expect(publish.env).toMatchObject({
      NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}',
      XPOD_PUBLISH_REGISTRY: 'https://registry.npmjs.org',
      XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      XPOD_ACCEPTED_SHA: '${{ github.sha }}',
    });
    expect(jobRunText(workflow, 'publish_npm_latest')).toContain('git checkout --detach "$XPOD_ACCEPTED_SHA"');
    expect(jobRunText(workflow, 'publish_npm_latest')).toContain('node -e');
    expect(jobRunText(workflow, 'publish_npm_latest')).toContain('packageJson.version !== process.env.RELEASE_VERSION');
    expect(jobRunText(workflow, 'publish_npm_latest')).toContain('node scripts/publish-release.cjs --skip-build');

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

    expect(promote.needs).toBe('promotion_guard');
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
    expect(deploy.with).toEqual({
      version: '${{ needs.promotion_guard.outputs.version }}',
      'image-digest': '${{ needs.promotion_guard.outputs.image_digest }}',
      environment: 'co',
    });
    expect(release.needs).toEqual(expect.arrayContaining([ 'deploy_production_co' ]));
    expect(release.permissions).toEqual({
      contents: 'write',
    });
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
