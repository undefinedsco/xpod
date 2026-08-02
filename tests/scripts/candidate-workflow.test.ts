import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/candidate.yml');

type Workflow = Record<string, any>;

async function loadWorkflow(): Promise<Workflow> {
  const text = await readFile(workflowPath, 'utf8');
  return parseDocument(text).toJSON() as Workflow;
}

function stepRuns(job: any): string[] {
  return (job.steps ?? [])
    .map((step: any) => step.run)
    .filter((run: unknown): run is string => typeof run === 'string');
}

function allRunText(workflow: Workflow): string {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job: any) => stepRuns(job))
    .join('\n');
}

function jobRunText(workflow: Workflow, jobName: string): string {
  return stepRuns(workflow.jobs[jobName]).join('\n');
}

function allRuns(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job: any) => stepRuns(job));
}

describe('release candidate workflow', () => {
  it('only runs on release branches with branch-scoped cancellation and minimal permissions', async () => {
    const workflow = await loadWorkflow();

    expect(workflow.on.push.branches).toEqual([ 'release/**' ]);
    expect(workflow.on.push.tags).toBeUndefined();
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.concurrency).toEqual({
      group: expect.stringContaining('${{ github.ref }}'),
      'cancel-in-progress': true,
    });
    expect(workflow.permissions).toEqual({
      contents: 'read',
    });
    expect(workflow.jobs.build_image.permissions).toEqual({
      contents: 'read',
      packages: 'write',
    });
    expect(workflow.jobs.publish_npm_next.permissions).toBeUndefined();
    expect(workflow.jobs.deploy_and_accept.permissions).toBeUndefined();
    for (const [ jobName, job ] of Object.entries(workflow.jobs)) {
      if (jobName !== 'build_image') {
        expect((job as any).permissions?.packages, jobName).toBeUndefined();
      }
    }
  });

  it('does not interpolate untrusted refs directly inside shell commands', async () => {
    const workflow = await loadWorkflow();

    for (const run of allRuns(workflow)) {
      expect(run).not.toContain('${{ github.ref_name }}');
    }
  });

  it('derives candidate metadata with release-candidate.cjs and exposes the expected job outputs', async () => {
    const workflow = await loadWorkflow();
    const metadata = workflow.jobs.metadata;
    const runText = jobRunText(workflow, 'metadata');

    expect(metadata.outputs).toMatchObject({
      target: expect.stringContaining('target'),
      candidate: expect.stringContaining('candidate'),
      shaTag: expect.stringContaining('shaTag'),
      sourceSha: expect.stringContaining('sourceSha'),
    });
    expect(runText).toContain('node scripts/release-candidate.cjs');
    expect(runText).toContain('--branch');
    expect(runText).toContain('--run-number');
    expect(runText).toContain('--run-attempt');
    expect(runText).toContain('--sha');
    expect(runText).toContain('--json');
  });

  it('blocks publishing on release-equivalent Node and Bun prepublish matrices without continue-on-error', async () => {
    const workflow = await loadWorkflow();
    const nodeJob = workflow.jobs.prepublish_npm_tarball;
    const bunJob = workflow.jobs.prepublish_bun_tarball;

    expect(nodeJob.needs).toContain('metadata');
    expect(nodeJob['continue-on-error']).toBeUndefined();
    expect(nodeJob.strategy.matrix.os).toEqual(expect.arrayContaining([ 'ubuntu-latest', 'macos-latest' ]));
    expect(nodeJob.strategy.matrix['node-version']).toEqual([ 22, 24, 25 ]);
    expect(jobRunText(workflow, 'prepublish_npm_tarball')).toContain('--apply-root-version');
    expect(jobRunText(workflow, 'prepublish_npm_tarball')).toContain('bun run build');
    expect(jobRunText(workflow, 'prepublish_npm_tarball')).toContain('node scripts/run-npm-pack.cjs');
    expect(jobRunText(workflow, 'prepublish_npm_tarball')).toContain('node scripts/package-smoke-install.cjs');
    expect(jobRunText(workflow, 'prepublish_npm_tarball')).toContain('node scripts/package-consumer-smoke.cjs');

    expect(bunJob.needs).toContain('metadata');
    expect(bunJob['continue-on-error']).toBeUndefined();
    expect(bunJob.strategy.matrix.os).toEqual(expect.arrayContaining([ 'ubuntu-latest', 'macos-latest' ]));
    expect(bunJob.strategy.matrix['node-version']).toEqual([ 22, 24, 25 ]);
    expect(jobRunText(workflow, 'prepublish_bun_tarball')).toContain('bun scripts/package-consumer-smoke.cjs');
  });

  it('publishes npm with tag next and verifies published Node and Bun consumers before acceptance', async () => {
    const workflow = await loadWorkflow();
    const publish = workflow.jobs.publish_npm_next;

    expect(publish.needs).toEqual(expect.arrayContaining([ 'prepublish_npm_tarball', 'prepublish_bun_tarball' ]));
    expect(publish.env.XPOD_PUBLISH_TAG).toBe('next');
    expect(publish.env.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
    expect(jobRunText(workflow, 'publish_npm_next')).toContain('node scripts/publish-release.cjs --skip-build');

    expect(workflow.jobs.verify_npm_node.needs).toBe('publish_npm_next');
    expect(workflow.jobs.verify_npm_bun.needs).toBe('publish_npm_next');
    expect(jobRunText(workflow, 'verify_npm_node')).toContain('@undefineds.co/xpod@${{ needs.publish_npm_next.outputs.candidate-version }}');
    expect(jobRunText(workflow, 'verify_npm_node')).toContain('node scripts/package-consumer-smoke.cjs');
    expect(jobRunText(workflow, 'verify_npm_bun')).toContain('bun scripts/package-consumer-smoke.cjs');
  });

  it('builds exactly one GHCR image with immutable sha and candidate tags and exposes the canonical digest', async () => {
    const workflow = await loadWorkflow();
    const build = workflow.jobs.build_image;
    const runText = jobRunText(workflow, 'build_image');
    const actionStep = build.steps.find((step: any) => step.uses === 'docker/build-push-action@v6');

    expect(build.needs).toEqual(expect.arrayContaining([ 'prepublish_npm_tarball', 'prepublish_bun_tarball' ]));
    expect(build.outputs.digest).toContain('digest');
    expect(actionStep.with.push).toBe(true);
    expect(actionStep.with.tags).toContain('sha-${{ needs.metadata.outputs.sourceSha }}');
    expect(actionStep.with.tags).toContain('${{ needs.metadata.outputs.candidate }}');
    expect(actionStep.with.tags).not.toContain('latest');
    expect(runText).not.toContain(':latest');
  });

  it('deploys only after published consumers and image build, uses rc environment secrets, and deploys by digest', async () => {
    const workflow = await loadWorkflow();
    const deploy = workflow.jobs.deploy_and_accept;
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(deploy.environment).toBe('rc');
    expect(deploy.needs).toEqual(expect.arrayContaining([
      'build_image',
      'verify_npm_node',
      'verify_npm_bun',
    ]));
    expect(deploy.env.KUBE_CONFIG_DATA).toBe('${{ secrets.KUBE_CONFIG_DATA }}');
    expect(deploy.env.APP_ENV_FILE).toBe('${{ secrets.APP_ENV_FILE }}');
    expect(deploy.env.SEALOS_NAMESPACE).toBe('${{ vars.SEALOS_NAMESPACE }}');
    expect(deploy.env.XPOD_RUNTIME_SECRET_NAME).toBe('${{ vars.XPOD_RUNTIME_SECRET_NAME }}');
    expect(runText).toContain('node scripts/render-rc-manifests.cjs');
    expect(runText).toContain('kubectl apply -f "$rendered_manifest"');
    expect(runText).toContain('SEALOS_NAMESPACE is required');
    expect(runText).toContain('XPOD_RUNTIME_SECRET_NAME is required');
    expect(runText).toContain('must be a valid Kubernetes name');
    expect(runText).not.toContain('SEALOS_NAMESPACE: xpod-rc');
    expect(runText).not.toContain('xpod-rc-secret \\');
    expect(runText).toContain('ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" create secret generic "$XPOD_RUNTIME_SECRET_NAME"');
    expect(runText).toContain('kubectl rollout status deployment/xpod-rc');
    expect(runText).toContain('kubectl rollout status deployment/xpod-inngest');
    expect(runText).toContain('https://rc.id.undefineds.co/service/status');
    expect(runText).toContain('/.well-known/openid-configuration');
    expect(runText).toContain('https://rc.id.undefineds.co/dashboard/');
    expect(runText).toContain('/settings/');
    expect(runText).toContain('dashboard.html');
    expect(runText).toContain('settings.html');
    expect(runText).toContain('dashboard did not return HTML');
    expect(runText).toContain('settings did not return HTML');
    expect(runText).toContain('401');
    expect(runText).not.toContain('https://id.undefineds.co');
    expect(runText).not.toContain('xpod-cloud-secret');
    expect(runText).not.toMatch(/XPOD_GATEWAY_INTERNAL_CLIENT_(ID|SECRET).*required/i);
  });

  it('checks RC secret keys and production isolation without echoing secret values', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(runText).toContain('CSS_IDENTITY_DB_URL');
    expect(runText).toContain('CSS_REDIS_CLIENT');
    expect(runText).toContain('RC Redis DB must use a non-default database index');
    expect(runText).toContain('RC Redis URL must include an explicit nonzero DB index');
    expect(runText).toContain('production Redis is not allowed in RC APP_ENV_FILE');
    expect(runText).toContain('CSS_MINIO_BUCKET_NAME');
    expect(runText).toContain('XPOD_INNGEST_EVENT_KEY');
    expect(runText).toContain('XPOD_INNGEST_SIGNING_KEY');
    expect(runText).toContain('production domain');
    expect(runText).toContain('production bucket');
    expect(runText).toContain('production database');
    expect(runText).not.toMatch(/cat\s+["']?\$APP_ENV_FILE/);
    expect(runText).not.toMatch(/grep .*APP_ENV_FILE/);
  });

  it('requires authenticated smoke configuration instead of manufacturing a passed result', async () => {
    const workflow = await loadWorkflow();
    const deploy = workflow.jobs.deploy_and_accept;
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(deploy.env.XPOD_ACCEPTANCE_REAL_XPOD).toBe('true');
    expect(deploy.env.XPOD_SETTINGS_E2E_BASE_URL).toBe('https://rc.id.undefineds.co');
    expect(deploy.env.XPOD_SETTINGS_E2E_ALICE_STATE).toBe('${{ secrets.XPOD_SETTINGS_E2E_ALICE_STATE }}');
    expect(deploy.env.XPOD_SETTINGS_E2E_BOB_STATE).toBe('${{ secrets.XPOD_SETTINGS_E2E_BOB_STATE }}');
    expect(deploy.env.XPOD_SETTINGS_E2E_ALICE_POD_URL).toBe('${{ vars.XPOD_SETTINGS_E2E_ALICE_POD_URL }}');
    expect(deploy.env.XPOD_SETTINGS_E2E_TEST_API_KEY).toBe('${{ secrets.XPOD_SETTINGS_E2E_TEST_API_KEY }}');
    expect(deploy.env.RC_AUTHENTICATED_SMOKE_COMMAND).toBeUndefined();
    expect(runText).toContain('bun scripts/accept-xpod-settings.ts --allow-incomplete');
    expect(runText).toContain('node scripts/assert-rc-authenticated-smoke.cjs');
    expect(runText).toContain('xpod-light-settings-acceptance.json');
    expect(runText).not.toContain('RC_AUTHENTICATED_SMOKE_COMMAND');
    expect(runText).not.toMatch(/bash\s+-euo pipefail\s+-c|\bbash\s+-c|\bsh\s+-c/);
    expect(runText).toContain('authenticated-pod');
    expect(runText).not.toContain('"authenticated-pod":"passed"');
  });

  it('creates acceptance manifest artifacts with all required checks, diagnostics, and scale-to-zero cleanup', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');
    const upload = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4');

    expect(runText).toContain('node scripts/release-acceptance-manifest.cjs create');
    for (const check of [
      'image',
      'npm-node',
      'npm-bun',
      'service-status',
      'oidc',
      'dashboard',
      'protected-route',
      'deployed-digest',
      'direct-pod',
      'public-service',
      'secret-isolation',
      'authenticated-pod',
    ]) {
      expect(runText).toContain(check);
    }
    expect(upload.with.name).toBe('release-acceptance-${{ github.sha }}');
    expect(upload.if).toBe('success()');

    const diagnostics = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Dump diagnostics');
    expect(diagnostics.if).toBe('failure()');
    expect(diagnostics.run).toContain('kubectl -n "$SEALOS_NAMESPACE" get');
    expect(diagnostics.run).toContain('describe deployment xpod-rc');
    expect(diagnostics.run).toContain('--previous');

    const cleanup = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Scale RC deployments to zero');
    expect(cleanup.if).toContain('always()');
    expect(cleanup.if).toContain("vars.XPOD_RC_SCALE_TO_ZERO == 'true'");
    expect(cleanup.run).toContain('kubectl -n "$SEALOS_NAMESPACE" scale deployment/xpod-rc --replicas=0');
    expect(cleanup.run).toContain('kubectl -n "$SEALOS_NAMESPACE" scale deployment/xpod-inngest --replicas=0');
  });

  it('does not contain production deployment shortcuts, mutable latest tags, or continue-on-error release gates', async () => {
    const workflow = await loadWorkflow();
    const text = await readFile(workflowPath, 'utf8');

    expect(text).not.toContain('continue-on-error');
    expect(text).not.toMatch(/:latest\b|value=latest/);
    expect(text).not.toContain('deploy/sealos/cloud');
    expect(text).not.toContain('environment: production');
    expect(allRunText(workflow)).not.toContain('https://id.undefineds.co');
  });

  it('binds deployment acceptance to the exact digest and direct pod health before public checks', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" get deployment xpod-rc');
    expect(runText).toContain('ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}');
    expect(runText).toContain('imageID');
    expect(runText).toContain('direct-pod');
    expect(runText).toContain('public-service');
    expect(runText).toContain('deployed-digest');
    expect(runText).toContain('127.0.0.1:3000/service/status');
    expect(runText).not.toContain("image: 'passed'");
  });
});
