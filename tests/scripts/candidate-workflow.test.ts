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
  it('only runs on release branches with serialized branch-scoped execution and minimal permissions', async () => {
    const workflow = await loadWorkflow();

    expect(workflow.on.push.branches).toEqual([ 'release/**' ]);
    expect(workflow.on.push.tags).toBeUndefined();
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.concurrency).toEqual({
      group: expect.stringContaining('${{ github.ref }}'),
      'cancel-in-progress': false,
    });
    expect(workflow.permissions).toEqual({
      contents: 'read',
    });
    expect(workflow.jobs.build_image.permissions).toEqual({
      contents: 'read',
      packages: 'write',
    });
    expect(workflow.jobs.deploy_and_accept.permissions).toBeUndefined();
    for (const [ jobName, job ] of Object.entries(workflow.jobs)) {
      if (!['build_image', 'publish_qlever_runtime_sdk', 'publish_qlever_local_runtime'].includes(jobName)) {
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

  it('keeps RC service delivery independent from npm packaging and publishing', async () => {
    const workflow = await loadWorkflow();

    for (const jobName of [
      'prepublish_npm_tarball',
      'prepublish_bun_tarball',
      'publish_npm_next',
      'verify_npm_node',
      'verify_npm_bun',
    ]) {
      expect(workflow.jobs[jobName], jobName).toBeUndefined();
    }

    const text = await readFile(workflowPath, 'utf8');
    expect(text).not.toContain('NPM_TOKEN');
    expect(text).not.toContain('publish-release.cjs');
    expect(text).not.toContain('npm publish');
    expect(text).not.toContain('XPOD_PUBLISH_TAG');
    expect(text).not.toContain('@undefineds.co/xpod@');
  });

  it('checks all RC DNS names and assigned namespace access before publishing artifacts', async () => {
    const workflow = await loadWorkflow();
    const preflight = workflow.jobs.rc_prerequisites;
    const runText = jobRunText(workflow, 'rc_prerequisites');

    expect(preflight.needs).toBe('metadata');
    expect(preflight.environment).toBe('rc');
    expect(preflight.env.KUBE_CONFIG_DATA).toBe('${{ secrets.KUBE_CONFIG_DATA }}');
    expect(runText).toContain('printf \'%s\' "$KUBE_CONFIG_DATA" > ~/.kube/config');
    expect(runText).not.toContain('"$KUBE_CONFIG_DATA" | base64 -d');
    expect(preflight.env.SEALOS_NAMESPACE).toBeUndefined();
    expect(runText).toContain("kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}'");
    expect(runText).toContain('require_can_i create deployments');
    expect(runText).toContain('id-rc.undefineds.co');
    expect(runText).toContain('pods-rc.undefineds.co');
    expect(runText).toContain('api-rc.undefineds.co');
    expect(runText).toContain('require_can_i create deployments');
    expect(runText).not.toContain('get secret xpod-rc-tls');
  });

  it('builds exactly one GHCR image with immutable sha and candidate tags and exposes the canonical digest', async () => {
    const workflow = await loadWorkflow();
    const build = workflow.jobs.build_image;
    const runText = jobRunText(workflow, 'build_image');
    const actionStep = build.steps.find((step: any) => step.uses ===
      'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8');

    expect(build.needs).toEqual([ 'metadata', 'rc_prerequisites', 'publish_qlever_local_runtime' ]);
    expect(build.outputs.digest).toContain('digest');
    expect(workflow.jobs.publish_qlever_runtime_sdk.uses).toBe('./.github/workflows/publish-qlever-runtime-sdk.yml');
    expect(workflow.jobs.publish_qlever_runtime_sdk.needs).toEqual([ 'metadata', 'rc_prerequisites' ]);
    expect(workflow.jobs.publish_qlever_runtime_sdk.with.source_commit).toBe('${{ needs.metadata.outputs.sourceSha }}');
    expect(workflow.jobs.publish_qlever_local_runtime.uses).toBe('./.github/workflows/publish-qlever-local-runtime.yml');
    expect(workflow.jobs.publish_qlever_local_runtime.with.prior_sdk_image).toBe('${{ needs.publish_qlever_runtime_sdk.outputs.image }}');
    expect(actionStep.with.target).toBe('server');
    expect(actionStep.with.push).toBe(true);
    expect(actionStep.with.tags).toContain('sha-${{ needs.metadata.outputs.sourceSha }}');
    expect(actionStep.with.tags).toContain('${{ needs.metadata.outputs.candidate }}');
    expect(actionStep.with['build-args']).toContain('XPOD_QLEVER_LOCAL_RUNTIME_IMAGE=${{ needs.publish_qlever_local_runtime.outputs.image }}');
    expect(actionStep.with['cache-from']).toBe('type=gha,scope=xpod-server');
    expect(actionStep.with.tags).not.toContain('latest');
    expect(runText).not.toContain(':latest');
  });

  it('deploys after the image build, uses rc environment secrets, and deploys by digest', async () => {
    const workflow = await loadWorkflow();
    const deploy = workflow.jobs.deploy_and_accept;
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(deploy.environment).toBe('rc');
    expect(deploy.needs).toEqual([ 'metadata', 'build_image' ]);
    expect(deploy.env.KUBE_CONFIG_DATA).toBe('${{ secrets.KUBE_CONFIG_DATA }}');
    expect(runText).toContain('printf \'%s\' "$KUBE_CONFIG_DATA" > ~/.kube/config');
    expect(runText).not.toContain('"$KUBE_CONFIG_DATA" | base64 -d');
    expect(deploy.env.APP_ENV_FILE).toBe('${{ secrets.APP_ENV_FILE }}');
    expect(deploy.env.SEALOS_NAMESPACE).toBeUndefined();
    expect(runText).toContain("kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}'");
    expect(runText).toContain('echo "SEALOS_NAMESPACE=$SEALOS_NAMESPACE" >> "$GITHUB_ENV"');
    expect(deploy.env.XPOD_RUNTIME_SECRET_NAME).toBe('${{ vars.XPOD_RUNTIME_SECRET_NAME }}');
    expect(deploy.env.XPOD_ACCEPTANCE_RUN_DOCKER).toBe('true');
    expect(runText).toContain('node scripts/render-rc-manifests.cjs');
    expect(runText).toContain('--image "ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}"');
    expect(runText).toContain('kubectl apply -f "$rendered_manifest"');
    expect(runText).toContain('kubeconfig namespace');
    expect(runText).toContain('XPOD_RUNTIME_SECRET_NAME is required');
    expect(runText).toContain('must be a valid Kubernetes name');
    expect(runText).not.toContain('SEALOS_NAMESPACE: xpod-rc');
    expect(runText).not.toContain('xpod-rc-secret \\');
    expect(runText).toContain('ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" create secret generic "$XPOD_RUNTIME_SECRET_NAME"');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" create secret generic xpod-rc-postgres-secret');
    expect(runText).toContain('identity_db_url="postgresql://xpod_rc:${pg_password}@${pg_host}:5432/xpod_rc"');
    expect(runText).toContain('sparql_endpoint="postgresql://xpod_rc:${pg_password}@${pg_host}:5432/xpod_rc"');
    expect(runText).toContain('echo "::add-mask::$pg_password"');
    expect(runText).toContain('echo "::add-mask::$identity_db_url"');
    expect(runText).toContain('echo "::add-mask::$sparql_endpoint"');
    expect(runText).toContain('deploy/sealos/rc-postgres');
    expect(runText).toContain('delete deployment/xpod-rc deployment/xpod-rc-inngest deployment/xpod-rc-redis');
    expect(runText).toContain('delete statefulset/xpod-rc-postgres --cascade=foreground --wait=true --ignore-not-found');
    expect(runText).toContain('delete service/xpod-rc-postgres --ignore-not-found');
    expect(runText).not.toContain('delete pvc/data-xpod-rc-postgres-0');
    expect(runText).not.toContain('wait --for=delete pvc/data-xpod-rc-postgres-0');
    expect(runText).not.toContain('delete pvc -l app=xpod-rc-postgres');
    expect(runText).not.toContain('wait --for=delete pod -l app=xpod-rc-postgres --timeout=180s || true');
    expect(runText).not.toContain('wait --for=delete pvc -l app=xpod-rc-postgres');
    expect(runText.indexOf('delete deployment/xpod-rc deployment/xpod-rc-inngest deployment/xpod-rc-redis')).toBeLessThan(
      runText.indexOf('delete statefulset/xpod-rc-postgres'),
    );
    expect(runText).toContain('rollout status statefulset/xpod-rc-postgres');
    expect(runText).toContain("SHOW server_version_num");
    expect(runText).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(runText).toContain("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    expect(runText).toContain('RC database did not activate the vector extension');
    expect(runText.indexOf('CREATE EXTENSION IF NOT EXISTS vector')).toBeGreaterThan(
      runText.indexOf('rollout status statefulset/xpod-rc-postgres'),
    );
    expect(runText.indexOf('CREATE EXTENSION IF NOT EXISTS vector')).toBeLessThan(
      runText.indexOf('kubectl apply -f "$rendered_manifest"'),
    );
    expect(runText).toContain('kubectl rollout status deployment/xpod-rc');
    expect(runText).toContain('kubectl rollout status deployment/xpod-rc-inngest');
    expect(runText).toContain('kubectl rollout status deployment/xpod-rc-redis');
    expect(runText).not.toContain('rollout restart deployment/xpod-rc-inngest');
    expect(runText).not.toContain('set image deployment/xpod-rc');
    expect(runText).not.toContain('patch deployment/xpod-rc');
    expect(runText).not.toContain('kubectl rollout status deployment/xpod-inngest');
    expect(runText).not.toContain('node scripts/update-gateway-rc-configmap.cjs');
    expect(runText).not.toContain('deployment/gateway');
    expect(runText).toContain('https://id-rc.undefineds.co/service/status');
    expect(runText).toContain('https://pods-rc.undefineds.co');
    expect(runText).toContain('https://api-rc.undefineds.co');
    expect(runText).toContain('/.well-known/openid-configuration');
    expect(runText).toContain('https://id-rc.undefineds.co/dashboard/');
    expect(runText).toContain('/settings/');
    expect(runText).toContain('dashboard.html');
    expect(runText).toContain('settings.html');
    expect(runText).toContain('dashboard did not return HTML');
    expect(runText).toContain('settings did not return HTML');
    expect(runText).toContain('https://api-rc.undefineds.co/api/pod/settings/status');
    for (const pair of [
      [ 'xpod-rc-id-tls', 'id-rc.undefineds.co' ],
      [ 'xpod-rc-pods-tls', 'pods-rc.undefineds.co' ],
      [ 'xpod-rc-api-tls', 'api-rc.undefineds.co' ],
    ]) {
      expect(runText).toContain(pair[0]);
      expect(runText).toContain(pair[1]);
    }
    expect(runText).toContain('401');
    expect(runText).not.toContain('/settings/api/providers');
    expect(runText).not.toContain('https://id.undefineds.co');
    expect(runText).not.toContain('xpod-cloud-secret');
    expect(runText).not.toMatch(/XPOD_GATEWAY_INTERNAL_CLIENT_(ID|SECRET).*required/i);
  });

  it('checks RC secret keys and production isolation without echoing secret values', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(runText).toContain('CSS_REDIS_CLIENT=redis://xpod-rc-redis:6379/1');
    expect(runText).toContain("'CSS_REDIS_CLIENT'].includes(key)");
    expect(runText).not.toContain('production Redis is not allowed in RC APP_ENV_FILE');
    for (const key of [
      'CSS_MINIO_ENDPOINT',
      'CSS_MINIO_BUCKET_NAME',
      'CSS_MINIO_ACCESS_KEY',
      'CSS_MINIO_SECRET_KEY',
    ]) {
      expect(runText).toContain(key);
    }
    expect(runText).toContain('RC object-store bucket must be xpod-rc');
    expect(runText).toContain('bun scripts/verify-rc-r2-access.ts --env-file "$env_file"');
    expect(runText).toContain('delete deployment/xpod-rc-minio service/xpod-rc-minio job/xpod-rc-minio-init pvc/xpod-rc-minio secret/xpod-rc-object-store --ignore-not-found');
    expect(runText).not.toContain('create secret generic xpod-rc-object-store');
    expect(runText).not.toContain('rollout status deployment/xpod-rc-minio');
    expect(runText).toContain('XPOD_INNGEST_EVENT_KEY');
    expect(runText).toContain('XPOD_INNGEST_SIGNING_KEY');
    expect(runText).toContain("['CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT', 'CSS_REDIS_CLIENT'].includes(key)");
    expect(runText).not.toContain('production database is not allowed in RC APP_ENV_FILE');
    expect(runText).not.toMatch(/cat\s+["']?\$APP_ENV_FILE/);
    expect(runText).not.toMatch(/grep .*APP_ENV_FILE/);
  });

  it('derives authenticated smoke configuration from the fixed RC seed instead of manual secrets', async () => {
    const workflow = await loadWorkflow();
    const deploy = workflow.jobs.deploy_and_accept;
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(deploy.env.XPOD_ACCEPTANCE_REAL_XPOD).toBe('true');
    expect(deploy.env.XPOD_ACCEPTANCE_RUN_VISUAL).toBe('true');
    expect(deploy.env.XPOD_SETTINGS_E2E_BASE_URL).toBe('https://id-rc.undefineds.co');
    expect(deploy.env.XPOD_RC_SEED_CONFIG).toBe('${{ secrets.XPOD_RC_SEED_CONFIG }}');
    expect(deploy.env.XPOD_SETTINGS_E2E_ALICE_STATE).toBeUndefined();
    expect(deploy.env.XPOD_SETTINGS_E2E_BOB_STATE).toBeUndefined();
    expect(deploy.env.XPOD_SETTINGS_E2E_ALICE_POD_URL).toBeUndefined();
    expect(deploy.env.XPOD_SETTINGS_E2E_TEST_API_KEY).toBeUndefined();
    expect(deploy.env.RC_AUTHENTICATED_SMOKE_COMMAND).toBeUndefined();
    expect(runText).toContain('XPOD_RC_SEED_CONFIG is required');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" create secret generic xpod-rc-seed');
    expect(runText).not.toContain('patch deployment/xpod-rc');
    expect(runText).toContain('scripts/prepare-rc-authenticated-smoke.ts');
    expect(runText).toContain('bunx playwright install --with-deps chromium');
    expect(runText).toContain('--seed-config "${RUNNER_TEMP}/xpod-rc-seed.json"');
    expect(runText).toContain('set -a');
    expect(runText).toContain('${RUNNER_TEMP}/rc-authenticated-smoke.env');
    expect(runText).toContain('bun scripts/accept-xpod-settings.ts --allow-incomplete');
    expect(runText).toContain('xpod-light-settings-acceptance.md');
    expect(runText).toContain('cat "${RUNNER_TEMP}/acceptance/xpod-light-settings-acceptance.md"');
    expect(runText).toContain('node scripts/assert-rc-authenticated-smoke.cjs');
    expect(runText).toContain('xpod-light-settings-acceptance.json');
    expect(runText).not.toContain('RC_AUTHENTICATED_SMOKE_COMMAND');
    expect(runText).not.toContain('secrets.XPOD_SETTINGS_E2E_ALICE_STATE');
    expect(runText).not.toContain('secrets.XPOD_SETTINGS_E2E_BOB_STATE');
    expect(runText).not.toContain('secrets.XPOD_SETTINGS_E2E_TEST_API_KEY');
    expect(runText).not.toContain('vars.XPOD_SETTINGS_E2E_ALICE_POD_URL');
    expect(runText).not.toMatch(/bash\s+-euo pipefail\s+-c|\bbash\s+-c|\bsh\s+-c/);
    expect(runText).toContain('authenticated-pod');
    expect(runText).not.toContain('"authenticated-pod":"passed"');
  });

  it('creates acceptance manifest artifacts with all required checks, diagnostics, and scale-to-zero cleanup', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');
    const upload = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4');

    expect(runText).toContain('node scripts/release-acceptance-manifest.cjs create');
    expect(runText).toContain('--source-ref "${{ needs.metadata.outputs.sourceSha }}"');
    expect(runText).toContain('--xpod-image-digest "ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}"');
    expect(runText).not.toContain('--postgres-image-digest');
    expect(runText).not.toContain('--image-digest');
    for (const check of [
      'image',
      'service-status',
      'oidc',
      'dashboard',
      'protected-route',
      'deployed-digest',
      'direct-pod',
      'postgres',
      'pgvector',
      'public-service',
      'secret-isolation',
      'authenticated-pod',
    ]) {
      expect(runText).toContain(check);
    }
    expect(runText).not.toContain('npm-node');
    expect(runText).not.toContain('npm-bun');
    expect(runText).not.toContain('--npm-package');
    expect(runText).not.toContain('--npm-version');
    expect(upload.with.name).toBe('release-acceptance-${{ github.sha }}');
    expect(upload.if).toBe('success()');

    const diagnostics = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Dump diagnostics');
    expect(diagnostics.if).toBe('failure()');
    expect(diagnostics.run).toContain('kubectl -n "$SEALOS_NAMESPACE" get');
    expect(diagnostics.run).toContain('describe statefulset xpod-rc-postgres');
    expect(diagnostics.run).toContain('describe deployment xpod-rc');
    expect(diagnostics.run).toContain('describe deployment xpod-rc-redis');
    expect(diagnostics.run).toContain('--previous');

    const cleanup = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Scale RC deployments to zero');
    expect(cleanup.if).toContain('always()');
    expect(cleanup.if).toContain("vars.XPOD_RC_SCALE_TO_ZERO == 'true'");
    expect(cleanup.run).toContain('kubectl -n "$SEALOS_NAMESPACE" scale deployment/xpod-rc --replicas=0');
    expect(cleanup.run).toContain('kubectl -n "$SEALOS_NAMESPACE" scale deployment/xpod-rc-inngest --replicas=0');
    expect(cleanup.run).toContain('kubectl -n "$SEALOS_NAMESPACE" scale deployment/xpod-rc-redis --replicas=0');
    expect(cleanup.run).toContain('kubectl -n "$SEALOS_NAMESPACE" scale statefulset/xpod-rc-postgres --replicas=0');
    expect(cleanup.run).not.toContain('deployment/xpod-inngest');
  });

  it('does not contain production deployment shortcuts, mutable latest tags, or continue-on-error release gates', async () => {
    const workflow = await loadWorkflow();
    const text = await readFile(workflowPath, 'utf8');

    expect(text).not.toContain('continue-on-error');
    expect(text).not.toMatch(/:latest\b|value=latest/);
    expect(text).not.toContain('deploy/sealos/cloud');
    expect(text).not.toContain('environment: production');
    expect(allRunText(workflow)).not.toContain('https://id.undefineds.co');
    expect(allRunText(workflow)).not.toContain('https://rc.id.undefineds.co');
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
    expect(runText).not.toContain("jsonpath='{.items[0].metadata.name}'");
    expect(runText).toContain('containerStatus?.ready');
    expect(runText).toContain('metadata.deletionTimestamp');
    expect(runText).not.toContain("image: 'passed'");
  });

  it('keeps public RC surfaces free of private enterprise deployment material', async () => {
    const text = await readFile(workflowPath, 'utf8');

    expect(text).not.toMatch(/ccr\.ccs\.tencentyun\.com|tcr|cloud\.enterprise|xpod-rdf-postgres/i);
    expect(text).not.toContain('TCR_PASSWORD');
    expect(text).not.toContain('POSTGRES_IMAGE_DIGEST');
    expect(text).not.toContain('--require-postgres-image');
  });
});
