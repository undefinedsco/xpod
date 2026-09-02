import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/release.yml');
const cloudDeploymentPath = path.join(repoRoot, 'deploy/sealos/cloud/deployment.yaml');

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
  it('keeps burst headroom for concurrent Gateway, CSS, and API requests', async () => {
    const deployment = parseDocument(await readFile(cloudDeploymentPath, 'utf8')).toJSON() as any;
    const xpod = deployment.spec.template.spec.containers.find((container: any) => container.name === 'xpod');

    expect(xpod.resources).toEqual({
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '4', memory: '2Gi' },
    });
  });

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
      candidate_run_id: expect.stringContaining('candidate_run_id'),
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
      'qlever-local',
      'npm-node',
      'npm-bun',
      'npm-next',
      'desktop',
    ]) {
      expect(runText).toContain(`--required-check ${check}`);
    }
    expect(runText).toContain('CANDIDATE_RUN_ID="$CANDIDATE_RUN_ID" node');
    expect(runText).toContain('candidate_run_id=${process.env.CANDIDATE_RUN_ID}');
    expect(runText).not.toContain('stable npm version already exists');
    expect(runText).not.toContain('registry_url="https://registry.npmjs.org/@undefineds.co%2fxpod/${VERSION}"');
    expect(runText).not.toContain('npm_status=');
    expect(runText).toContain('image_digest=');
    expect(runText).not.toContain('workflow_dispatch');
    expect(runText).not.toContain('INPUT_DIGEST');
  });

  it('publishes stable npm packages to an unadvertised staging tag, verifies consumers, then promotes latest', async () => {
    const workflow = await loadWorkflow();
    const publish = workflow.jobs.publish_npm_staging;
    const publishRunText = jobRunText(workflow, 'publish_npm_staging');
    const publishStep = publish.steps.find((step: any) => step.name === 'Publish stable root package under the staging tag');

    expect(publish.needs).toBe('promotion_guard');
    expect(publish['runs-on']).toBe('macos-15');
    expect(publish.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(publish.env).toMatchObject({
      NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}',
      XPOD_PUBLISH_REGISTRY: 'https://registry.npmjs.org',
      XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      XPOD_PUBLISH_TAG: 'stable-staging',
      XPOD_ACCEPTED_SHA: '${{ github.sha }}',
      CANDIDATE_RUN_ID: '${{ needs.promotion_guard.outputs.candidate_run_id }}',
    });
    expect(publishRunText).toContain('git checkout --detach "$XPOD_ACCEPTED_SHA"');
    expect(publishRunText).toContain('gh run download "$CANDIDATE_RUN_ID"');
    expect(publishRunText).toContain('qlever-local-runtime-darwin-arm64-${XPOD_ACCEPTED_SHA}');
    expect(publishRunText).toContain('node -e');
    expect(publishRunText).toContain('packageJson.version !== process.env.RELEASE_VERSION');
    expect(publishRunText).toContain('publish-platform-packages.cjs --tag=stable-staging --target=darwin-arm64');
    expect(publishRunText).toContain('registry_url="https://registry.npmjs.org/@undefineds.co%2fxpod/${RELEASE_VERSION}"');
    expect(publishRunText).toContain('npm_status=');
    expect(publishRunText).toContain('exists=false');
    expect(publishRunText).toContain('exists=true');
    expect(publishRunText).toContain('failed to verify stable npm version availability');
    expect(publishRunText).toContain('published version mismatch');
    expect(publishRunText).toContain('node scripts/publish-release.cjs --skip-build');
    expect(publishStep.if).toBe("steps.npm_state.outputs.exists == 'false'");

    for (const jobName of [ 'verify_npm_consumer_node', 'verify_npm_consumer_bun' ]) {
      const job = workflow.jobs[jobName];
      expect(job.needs).toEqual(expect.arrayContaining([ 'promotion_guard', 'publish_npm_staging' ]));
      expect(job['continue-on-error']).toBeUndefined();
      expect(job.strategy.matrix.os).toEqual([ 'macos-15' ]);
      expect(job.strategy.matrix['node-version']).toEqual([ 22, 24, 25 ]);
      expect(job.env.RELEASE_VERSION).toBe('${{ needs.promotion_guard.outputs.version }}');
      expect(job.env.XPOD_PACKAGE_SMOKE_INCLUDE_OPTIONAL).toBe('true');
      expect(job.env.XPOD_QLEVER_SEMANTIC_FIXTURE_PATH).toContain('qlever-semantic-conformance.cjs');
      expect(jobRunText(workflow, jobName)).toContain('@undefineds.co/xpod@$RELEASE_VERSION');
      expect(jobRunText(workflow, jobName)).toContain('node scripts/wait-for-npm-package.cjs');
      expect(jobRunText(workflow, jobName)).toContain('scripts/package-smoke-install.cjs');
    }
    expect(jobRunText(workflow, 'verify_npm_consumer_node')).toContain('node scripts/package-consumer-smoke.cjs');
    expect(jobRunText(workflow, 'verify_npm_consumer_bun')).toContain('bun scripts/package-consumer-smoke.cjs');
    expect(workflow.jobs.verify_npm_consumer_bun.env.XPOD_SMOKE_NODE).toBe('bun');

    const promote = workflow.jobs.promote_npm_latest;
    const promoteText = jobRunText(workflow, 'promote_npm_latest');
    expect(promote.needs).toEqual([
      'promotion_guard',
      'verify_npm_consumer_node',
      'verify_npm_consumer_bun',
    ]);
    expect(promoteText).toContain('npm latest dist-tag is newer than release version');
    expect(promoteText).toContain('for package in @undefineds.co/xpod @undefineds.co/xpod-darwin-arm64');
    expect(promoteText).toContain('npm dist-tag add "$package@$RELEASE_VERSION" latest');
  });

  it('repackages the accepted desktop without Apple distribution credentials', async () => {
    const workflow = await loadWorkflow();
    const desktop = workflow.jobs.build_desktop_macos;
    const runText = jobRunText(workflow, 'build_desktop_macos');

    expect(desktop.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    for (const key of [ 'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID' ]) {
      expect(desktop.env[key]).toBeUndefined();
    }
    expect(runText).toContain('bun run dist');
    expect(runText).toContain('CFBundleShortVersionString');
    expect(runText).toContain('Contents/Resources/runtime/qlever/bin/xpod_qlever_local_runtime');
    expect(runText).toContain('Contents/Resources/runtime/qlever/manifest.json');
    expect(runText).not.toContain('Require signed release credentials');
    expect(runText).not.toContain('codesign --verify');
  });

  it('promotes the accepted GHCR digest to stable and latest tags without rebuilding', async () => {
    const workflow = await loadWorkflow();
    const promote = workflow.jobs.promote_image;
    const runText = jobRunText(workflow, 'promote_image');

    expect(promote.needs).toEqual(expect.arrayContaining([
      'promotion_guard',
      'verify_npm_consumer_node',
      'verify_npm_consumer_bun',
      'promote_npm_latest',
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
      'verify_npm_consumer_node',
      'verify_npm_consumer_bun',
      'promote_npm_latest',
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
