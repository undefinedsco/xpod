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
  it('requires real Task approval evidence from the live Gateway acceptance', async () => {
    const candidate = parseDocument(await readFile(path.join(repoRoot, '.github/workflows/candidate.yml'), 'utf8')).toJSON() as Workflow;
    const live = jobRunText(candidate, 'deploy_and_accept');
    expect(live).toContain('XPOD_LIVE_TASK_APPROVAL=1');
    expect(live).toContain("['task-approval', 'taskApproval']");
    expect(live).toContain('layer?.ok !== true');
    expect(jobRunText(candidate, 'finalize_acceptance')).not.toMatch(/['"]task-approval['"]\s*:\s*['"]passed['"]/);
  });

  it('checks the complete root tarball before publishing any native package', async () => {
    const workflow = await loadWorkflow();
    const job = workflow.jobs.publish_npm_staging;
    const index = stepIndex(job, 'Verify root package before publishing');
    expect(index).toBeGreaterThan(stepIndex(job, 'Build package'));
    expect(index).toBeLessThan(stepIndex(job, 'Publish stable native package under the staging tag'));
    const step = job.steps[index];
    expect(step.env.XPOD_INCLUDE_PLATFORM_PACKAGES).toBe('true');
    expect(step.run).toContain('scripts/run-npm-pack.cjs');
    expect(step.run).toContain('scripts/check-pack-json.cjs');
    expect(step.run).not.toContain('npm publish');
    expect(step.if).toBeUndefined();
  });

  it('hands the packaged desktop to the release job and creates the release in exactly one place', async () => {
    const workflow = await loadWorkflow();
    const build = workflow.jobs.build_desktop_macos;
    const publish = workflow.jobs.create_github_release;
    const artifactName = 'xpod-desktop-macos-${{ needs.promotion_guard.outputs.version }}';

    // The desktop job also uploads allowlisted acceptance evidence; bind the assertion
    // to the packaged payload artifact that the release job downloads.
    const upload = build.steps.find(
      (step: any) => step.uses === 'actions/upload-artifact@v4' && step.with?.name === artifactName,
    );
    expect(upload?.with?.name).toBe(artifactName);
    expect(upload?.with?.path).toContain('desktop/release/*.dmg');
    expect(upload?.with?.path).toContain('desktop/release/*.zip');
    expect(upload?.with?.path).toContain('desktop/release/*.blockmap');
    // The desktop reads its update feed from the release assets; a release without this manifest
    // ships an app that can never find an update.
    expect(upload?.with?.path).toContain('desktop/release/latest-mac.yml');
    expect(jobRunText(workflow, 'create_github_release')).toContain("latest-mac.yml");
    expect(upload?.with?.['if-no-files-found']).toBe('error');

    const download = publish.steps.find((step: any) => step.uses === 'actions/download-artifact@v4');
    expect(download?.with?.name).toBe(artifactName);
    expect(download?.with?.path).toBe('${{ runner.temp }}/desktop-release');

    // The builder only produces the bytes; publishing them belongs to the job that runs
    // after production deploys, so a release is never created twice or from an empty tree.
    expect(jobRunText(workflow, 'build_desktop_macos')).not.toContain('gh release create');
    expect(jobRunText(workflow, 'create_github_release')).toContain('gh release upload');
  });

  it('checks the same package boundary in the required RC desktop job after the full runtime build', async () => {
    const candidate = parseDocument(await readFile(path.join(repoRoot, '.github/workflows/candidate.yml'), 'utf8')).toJSON() as Workflow;
    const job = candidate.jobs.build_desktop_rc;
    const index = stepIndex(job, 'Verify root npm package boundary');
    expect(index).toBeGreaterThan(stepIndex(job, 'Build desktop with the accepted native runtime'));
    expect(job.steps[index].env.XPOD_INCLUDE_PLATFORM_PACKAGES).toBe('true');
    expect(job.steps[index].run).toContain('scripts/run-npm-pack.cjs');
    expect(job.steps[index].run).toContain('scripts/check-pack-json.cjs');
    expect(job.steps[index].if).toBeUndefined();
    expect(candidate.jobs.finalize_acceptance.needs).toContain('build_desktop_rc');
    const consumers = stepIndex(job, 'Verify packed Node and Bun consumers before publication');
    expect(consumers).toBeGreaterThan(index);
    expect(job.steps[consumers].if).toBeUndefined();
    expect(job.steps[consumers].run).toContain('node scripts/check-package-registry-consumer.cjs');
    expect(job.steps[consumers].run).toContain('"${RUNNER_TEMP}/xpod-packed-node" .test-data/npm-consumer-cache');
    expect(job.steps[consumers].run).toContain('"${RUNNER_TEMP}/xpod-packed-bun" .test-data/bun-consumer-cache bun');
    const finalizeText = jobRunText(candidate, 'finalize_acceptance');
    // The gate must read verified, downloaded evidence rather than a literal.
    expect(finalizeText).toContain('scripts/release-gate-evidence.cjs verify-package-consumers');
    expect(finalizeText).toContain('package-consumer-check.json');
    expect(finalizeText).toContain("packageConsumerChecks['package-consumers']");
    expect(finalizeText).not.toMatch(/['"]package-consumers['"]\s*:\s*['"]passed['"]/);
    expect(finalizeText).not.toMatch(/['"]qlever-local['"]\s*:\s*['"]passed['"]/);
  });
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
    expect(runText).toContain("'+refs/heads/staging:refs/remotes/origin/staging'");
    expect(runText).toContain('git merge-base --is-ancestor "$TAG_SHA" origin/staging');
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
      'package-consumers',
      'models',
      'chat',
      'task-approval',
      'qlever-local',
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
    expect(publishRunText).toContain('build-platform-package.cjs --target=darwin-arm64');
    expect(publishRunText).toContain('npm publish dist/npm/darwin-arm64 --registry');
    expect(publishRunText.indexOf('build-platform-package.cjs')).toBeLessThan(publishRunText.indexOf('if npm view'));
    expect(publishRunText).toContain('--access public --tag stable-staging');
    expect(publishRunText).toContain('registry_url="https://registry.npmjs.org/@undefineds.co%2fxpod/${RELEASE_VERSION}"');
    expect(publishRunText).toContain('npm_status=');
    expect(publishRunText).toContain('exists=false');
    expect(publishRunText).toContain('exists=true');
    expect(publishRunText).toContain('failed to verify stable npm version availability');
    expect(publishRunText).toContain('published version mismatch');
    expect(publishRunText).toContain('node scripts/publish-release.cjs --skip-build');
    expect(publishRunText).toContain(
      'wait-for-npm-package.cjs "@undefineds.co/xpod@$RELEASE_VERSION" 180 10000',
    );
    expect(publishRunText.indexOf('publish-release.cjs --skip-build'))
      .toBeLessThan(publishRunText.indexOf('wait-for-npm-package.cjs'));
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
      expect(jobRunText(workflow, jobName)).not.toContain('wait-for-npm-package.cjs');
      expect(jobRunText(workflow, jobName)).toContain('scripts/package-smoke-install.cjs');
    }
    expect(jobRunText(workflow, 'verify_npm_consumer_node')).toContain('node scripts/package-consumer-smoke.cjs');
    expect(jobRunText(workflow, 'verify_npm_consumer_bun')).toContain('bun scripts/package-consumer-smoke.cjs');
    expect(workflow.jobs.verify_npm_consumer_bun.env.XPOD_SMOKE_NODE).toBe('bun');

    const promote = workflow.jobs.promote_npm_latest;
    const promoteText = jobRunText(workflow, 'promote_npm_latest');
    expect(promote.needs).toEqual([
      'shared_packages',
      'promotion_guard',
      'verify_npm_consumer_node',
      'verify_npm_consumer_bun',
    ]);
    expect(promoteText).toContain('npm latest dist-tag is newer than release version');
    // The promotion job validates every package before any tag mutation, so it
    // builds the target list first and then loops over the array.
    expect(promoteText).toContain('packages=(@undefineds.co/xpod @undefineds.co/xpod-darwin-arm64)');
    expect(promoteText).toContain('for package in "${packages[@]}"; do');
    expect(promoteText).toContain('npm dist-tag add "$package@$RELEASE_VERSION" latest');
  });

  it('gates shared applets on exact accepted SHA before root latest promotion', async () => {
    const workflow = await loadWorkflow();
    const shared = workflow.jobs.shared_packages;
    expect(shared.needs).toBe('promotion_guard');
    expect(shared.uses).toBe('./.github/workflows/packages-release.yml');
    expect(shared.with).toEqual({ 'accepted-sha': '${{ github.sha }}' });
    expect(shared.if).toBeUndefined();
    expect(shared['continue-on-error']).toBeUndefined();
    expect(workflow.jobs.promote_npm_latest.needs).toContain('shared_packages');
    expect(workflow.jobs.promote_npm_latest.if).toBeUndefined();

    const reusable = parseDocument(await readFile(path.join(repoRoot, '.github/workflows/packages-release.yml'), 'utf8')).toJSON() as Workflow;
    expect(Object.keys(reusable.on)).toEqual([ 'workflow_call' ]);
    expect(reusable.on.workflow_call.inputs['accepted-sha']).toEqual({ required: true, type: 'string' });
    const publish = reusable.jobs.publish;
    const checkout = publish.steps.find((step: any) => step.uses === 'actions/checkout@v4');
    expect(checkout.with.ref).toBe('${{ inputs.accepted-sha }}');
    const stageIndex = stepIndex(publish, 'Stage, verify clean consumers, and promote shared packages');
    const buildIndex = publish.steps.findIndex((step: any) => step.run === 'bun run build:packages');
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(stageIndex).toBeGreaterThan(buildIndex);
    expect(stageIndex).toBeGreaterThan(stepIndex(publish, 'Verify publication contracts'));
    expect(publish.steps[stageIndex]).toMatchObject({
      run: 'node scripts/publish-workspace-packages.cjs',
      env: { XPOD_ACCEPTED_SHA: '${{ inputs.accepted-sha }}' },
    });
    expect(publish.steps[stageIndex].if).toBeUndefined();
    expect(publish['continue-on-error']).toBeUndefined();
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
