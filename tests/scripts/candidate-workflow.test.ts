import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('allows measured cold image pulls without extending application health probes', async () => {
    const workflow = await loadWorkflow();
    const deployment = parseDocument(await readFile(
      path.join(repoRoot, 'deploy/sealos/rc/deployment.yaml'), 'utf8',
    )).toJSON();
    const container = deployment.spec.template.spec.containers.find((entry: any) => entry.name === 'xpod');
    const applicationStartupSeconds = container.startupProbe.periodSeconds * container.startupProbe.failureThreshold;
    // RC node14 needed 28m12s to pull the exact image, then executed successfully.
    expect(deployment.spec.progressDeadlineSeconds).toBeGreaterThan(28 * 60 + 12 + applicationStartupSeconds);
    const rolloutTimeout = jobRunText(workflow, 'deploy_and_accept')
      .match(/rollout status deployment\/xpod-rc[^\n]*--timeout=(\d+)s/);
    expect(Number(rolloutTimeout?.[1])).toBeGreaterThan(deployment.spec.progressDeadlineSeconds);
    expect(applicationStartupSeconds).toBe(300);
    expect(container.startupProbe.httpGet.path).toBe('/service/status');
    expect(container.readinessProbe.httpGet.path).toBe('/service/status');
  });

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
    expect(workflow.jobs.deploy_and_accept.permissions).toEqual({
      contents: 'read',
      packages: 'read',
    });
    const packageJobs = new Set([
      'build_image',
      'deploy_and_accept',
      'publish_qlever_runtime_sdk',
      'publish_qlever_local_runtime',
    ]);
    for (const [ jobName, job ] of Object.entries(workflow.jobs)) {
      if (!packageJobs.has(jobName)) {
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

  it('keeps RC validation independent from npm publishing', async () => {
    const workflow = await loadWorkflow();

    const text = await readFile(workflowPath, 'utf8');
    expect(workflow.jobs.publish_npm_rc).toBeUndefined();
    expect(workflow.jobs.verify_npm_node).toBeUndefined();
    expect(workflow.jobs.verify_npm_bun).toBeUndefined();
    expect(text).not.toContain('NPM_TOKEN');
    expect(text).not.toContain('registry.npmjs.org');
    expect(text).not.toContain('npm publish');
    expect(text).not.toContain('npm dist-tag');
    expect(text).not.toMatch(/:latest\b|value=latest/);
  });

  it('checks all RC DNS names and assigned namespace access before publishing artifacts', async () => {
    const workflow = await loadWorkflow();
    const preflight = workflow.jobs.rc_prerequisites;
    const runText = jobRunText(workflow, 'rc_prerequisites');

    expect(preflight.needs).toBe('metadata');
    expect(preflight.environment).toBe('rc');
    expect(preflight.env.KUBE_CONFIG_DATA).toBe('${{ secrets.KUBE_CONFIG_DATA }}');
    expect(preflight.env.SEALOS_NAMESPACE).toBe('${{ vars.SEALOS_NAMESPACE }}');
    expect(preflight.env.CSC_LINK).toBeUndefined();
    expect(preflight.env.APPLE_ID).toBeUndefined();
    expect(runText).not.toContain('MACOS_CERTIFICATE');
    expect(runText).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');
    expect(runText).toContain('undefineds-gz-rc-id.sealosgzg.site');
    expect(runText).toContain('undefineds-gz-rc-pods.sealosgzg.site');
    expect(runText).toContain('undefineds-gz-rc-api.sealosgzg.site');
    expect(runText).toContain('auth can-i create deployments');
    expect(runText).not.toContain('get secret xpod-rc-tls');
  });

  it('builds and verifies the macOS desktop without Apple distribution credentials', async () => {
    const workflow = await loadWorkflow();
    const desktop = workflow.jobs.build_desktop_rc;
    const runText = jobRunText(workflow, 'build_desktop_rc');
    const desktopManifest = JSON.parse(await readFile(path.join(repoRoot, 'desktop/package.json'), 'utf8'));

    expect(desktop.name).toBe('Build macOS RC desktop');
    expect(desktop.needs).toEqual([ 'metadata', 'build_qlever_macos_runtime' ]);
    expect(desktop.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    for (const key of [ 'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID' ]) {
      expect(desktop.env[key]).toBeUndefined();
    }
    expect(runText).toContain('bun run dist');
    expect(desktopManifest.scripts.dist).toContain('electron-builder --mac --publish never');
    expect(runText).toContain('CFBundleShortVersionString');
    expect(runText).toContain('Contents/Resources/runtime/qlever/bin/xpod_qlever_local_runtime');
    expect(runText).toContain('Contents/Resources/runtime/qlever/manifest.json');
    expect(runText).not.toContain('Require signed release credentials');
    expect(runText).not.toContain('codesign --verify');
  });

  it('builds exactly one GHCR image with immutable sha and candidate tags and exposes the canonical digest', async () => {
    const workflow = await loadWorkflow();
    const build = workflow.jobs.build_image;
    const runText = jobRunText(workflow, 'build_image');
    const actionStep = build.steps.find((step: any) => step.uses === 'docker/build-push-action@v6');

    expect(build.needs).toEqual([ 'metadata', 'rc_prerequisites', 'publish_qlever_local_runtime' ]);
    expect(build.outputs.digest).toContain('digest');
    expect(actionStep.with.push).toBe(true);
    expect(actionStep.with.tags).toContain('sha-${{ needs.metadata.outputs.sourceSha }}');
    expect(actionStep.with.tags).toContain('${{ needs.metadata.outputs.candidate }}');
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
    expect(deploy.env.APP_ENV_FILE).toBe('${{ secrets.APP_ENV_FILE }}');
    expect(deploy.env.SEALOS_NAMESPACE).toBe('${{ vars.SEALOS_NAMESPACE }}');
    expect(deploy.env.XPOD_RUNTIME_SECRET_NAME).toBe('${{ vars.XPOD_RUNTIME_SECRET_NAME }}');
    expect(deploy.concurrency).toEqual({
      group: 'xpod-shared-rc-service',
      'cancel-in-progress': false,
    });
    expect(runText).toContain('bun scripts/render-rc-manifests.cjs');
    expect(runText).not.toContain('--overlay deploy/sealos/rc-postgres');
    expect(runText).toContain('kubectl apply -f "$rendered_manifest"');
    expect(runText.match(/kubectl apply -f \"\$rendered_manifest\"/g)).toHaveLength(1);
    expect(runText).toContain('SEALOS_NAMESPACE is required');
    expect(runText).toContain('XPOD_RUNTIME_SECRET_NAME is required');
    expect(runText).toContain('must be a valid Kubernetes name');
    expect(runText).toContain('--image "ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}"');
    expect(runText).toContain('--seed-secret-name "$XPOD_RC_SEED_SECRET_NAME"');
    expect(runText).toContain('--current-deployment');
    expect(runText).toContain('scripts/verify-gz-rc-prerequisites.cjs create-run-secrets');
    expect(runText).toContain('scripts/verify-gz-rc-prerequisites.cjs preflight');
    expect(runText).not.toMatch(/delete (deployment|statefulset|pvc)|CREATE EXTENSION|rollout restart/);
    expect(runText).toContain('kubectl rollout status deployment/xpod-rc');
    expect(runText).toContain('https://undefineds-gz-rc-id.sealosgzg.site/service/status');
    expect(runText).toContain('https://undefineds-gz-rc-pods.sealosgzg.site');
    expect(runText).toContain('https://undefineds-gz-rc-api.sealosgzg.site');
    expect(runText).toContain('/.well-known/openid-configuration');
    expect(runText).toContain('https://undefineds-gz-rc-id.sealosgzg.site/dashboard/');
    expect(runText).toContain('/settings/');
    expect(runText).toContain('dashboard.html');
    expect(runText).toContain('settings.html');
    expect(runText).toContain('dashboard did not return HTML');
    expect(runText).toContain('settings did not return HTML');
    expect(runText).toContain('https://undefineds-gz-rc-api.sealosgzg.site/api/pod/settings/status');
    expect(runText).not.toContain('get secret "$XPOD_RUNTIME_SECRET_NAME"');
    expect(runText).toContain('curl --silent --show-error --max-time 15 --output /dev/null "https://$host/service/status"');
    expect(runText).toContain('401');
    expect(runText).not.toContain('/settings/api/providers');
    expect(runText).not.toContain('https://id.undefineds.co');
    expect(runText).not.toContain('xpod-cloud-secret');
    expect(runText).not.toMatch(/XPOD_GATEWAY_INTERNAL_CLIENT_(ID|SECRET).*required/i);
  });

  it('checks RC secret keys and production isolation without echoing secret values', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(runText).toContain("'CSS_IDENTITY_DB_URL'");
    expect(runText).toContain("'CSS_SPARQL_ENDPOINT'");
    expect(runText).not.toContain('pg_password=');
    expect(runText).not.toContain('sanitized.push');
    expect(runText).toContain('CSS_REDIS_CLIENT');
    expect(runText).toContain('RC Redis DB must use a non-default database index');
    expect(runText).toContain('RC Redis URL must include an explicit nonzero DB index');
    expect(runText).toContain('production Redis is not allowed in RC APP_ENV_FILE');
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
    expect(runText).not.toContain('delete deployment/xpod-rc-minio');
    expect(runText).not.toContain('create secret generic xpod-rc-object-store');
    expect(runText).not.toContain('rollout status deployment/xpod-rc-minio');
    expect(runText).toContain('XPOD_INNGEST_EVENT_KEY');
    expect(runText).toContain('XPOD_INNGEST_SIGNING_KEY');
    expect(runText).toContain('XPOD_GATEWAY_LOCATOR_SECRET');
    expect(runText).not.toContain('--from-literal=POSTGRES_DB');
    expect(runText).not.toContain('--from-literal=POSTGRES_USER');
    expect(runText).not.toContain('must match the isolated RC PostgreSQL service identity');
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
    expect(deploy.env.XPOD_SETTINGS_E2E_BASE_URL).toBe('https://undefineds-gz-rc-id.sealosgzg.site');
    expect(deploy.env.XPOD_LIVE_PROVIDER_API_KEY_CONFIG).toBe('${{ secrets.XPOD_LIVE_PROVIDER_API_KEY_CONFIG }}');
    expect(deploy.env.XPOD_AI_PROXY_URL).toBe('${{ secrets.XPOD_AI_PROXY_URL }}');
    expect(deploy.env.XPOD_RC_SEED_CONFIG).toBe('${{ secrets.XPOD_RC_SEED_CONFIG }}');
    expect(deploy.env.XPOD_SETTINGS_E2E_ALICE_STATE).toBeUndefined();
    expect(deploy.env.XPOD_SETTINGS_E2E_BOB_STATE).toBeUndefined();
    expect(deploy.env.XPOD_SETTINGS_E2E_ALICE_POD_URL).toBeUndefined();
    expect(deploy.env.XPOD_SETTINGS_E2E_TEST_API_KEY).toBeUndefined();
    expect(deploy.env.RC_AUTHENTICATED_SMOKE_COMMAND).toBeUndefined();
    expect(runText).toContain('XPOD_RC_SEED_CONFIG is required');
    expect(deploy.env.XPOD_RC_SEED_SECRET_NAME).toContain('xpod-rc-seed-');
    expect(runText).toContain('scripts/verify-gz-rc-prerequisites.cjs create-run-secrets');
    expect(runText).toContain('--seed-secret-name "$XPOD_RC_SEED_SECRET_NAME"');
    expect(runText).toContain('scripts/prepare-rc-authenticated-smoke.ts');
    expect(runText).toContain('scripts/materialize-rc-seed-config.ts');
    expect(runText).toContain('--suffix "rc-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
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
    expect(runText).not.toContain('XPOD_SETTINGS_E2E_TEST_API_KEY=');
    expect(runText).not.toContain('XPOD_SETTINGS_E2E_ALICE_POD_URL=');
    expect(runText).not.toMatch(/bash\s+-euo pipefail\s+-c|\bbash\s+-c|\bsh\s+-c/);
    expect(runText).toContain('authenticated-pod');
    expect(runText).not.toContain('"authenticated-pod":"passed"');
  });

  it('runs live Gateway AI acceptance against the deployed RC instead of treating UI smoke as complete', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(runText).toContain('XPOD_LIVE_PROVIDER_API_KEY_CONFIG secret is required');
    expect(runText).toContain('docker run --detach --name "$local_name"');
    expect(runText).toContain('local_name_file="${RUNNER_TEMP}/live-gateway-local-container-name"');
    expect(runText).toContain('printf \'%s\\n\' "$local_name" > "$local_name_file"');
    expect(runText).toContain('ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}');
    expect(runText).toContain('--publish 127.0.0.1::5737');
    expect(runText).toContain('--env XPOD_EDITION=local');
    expect(runText).toContain('--env SOLID_OIDC_ISSUER=https://undefineds-gz-rc-id.sealosgzg.site/');
    expect(runText).toContain('docker port "$local_name" 5737/tcp');
    expect(runText).not.toContain('port-forward deployment/xpod-rc 3000:3000');
    expect(runText).toContain('XPOD_LIVE_PROVIDER_KEY_FILE="$provider_file"');
    expect(runText).toContain('XPOD_BASE_URL="$gateway"');
    expect(runText).not.toContain('XPOD_LIVE_GATEWAY_URL');
    expect(runText).not.toContain('XPOD_LIVE_BASE_URL');
    expect(runText).toContain('XPOD_LIVE_CLOUD_IDP="https://undefineds-gz-rc-id.sealosgzg.site/"');
    expect(runText).not.toContain('XPOD_LIVE_EXPECTED_POD_HOST_SUFFIX');
    expect(runText).toContain('bun run ai-connections:accept:live');
    expect(runText).toContain('live-gateway-login-chat-local.json');
    for (const check of [
      'pod-read-write',
      'gateway-key',
      'ai-connections',
      'models',
      'chat',
    ]) {
      expect(runText).toContain(check);
    }
    expect(runText).toContain('live-gateway-checks.json');
    expect(runText).not.toContain('allow-incomplete --chat');
  });

  it('uploads diagnostic Task evidence on failure without relaxing the actual acceptance gate', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs.deploy_and_accept.steps;
    const project = steps.find((step: any) => step.name === 'Project safe Task approval evidence');
    const upload = steps.find((step: any) => step.name === 'Upload safe Task approval evidence');
    expect(project).toBeDefined();
    expect(project.if).toBe('always()');
    expect(upload.if).toBe('always()');
    expect(upload.uses).toBe('actions/upload-artifact@v4');
    expect(upload.with).toMatchObject({
      name: 'task-approval-evidence-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '${{ runner.temp }}/task-approval-evidence.json',
      'if-no-files-found': 'warn',
    });
    const live = steps.find((step: any) => step.name === 'Live Gateway login and Chat acceptance');
    expect(live['continue-on-error']).toBeUndefined();
    expect(live.run).toContain('XPOD_LIVE_TASK_APPROVAL=1');
    expect(live.run).toContain("['task-approval', 'taskApproval']");
    expect(live.run).toContain('layer?.ok !== true');
  });

  async function projectTaskEvidence(contents?: string) {
    const workflow = await loadWorkflow();
    const step = workflow.jobs.deploy_and_accept.steps.find((entry: any) => entry.name === 'Project safe Task approval evidence');
    expect(step).toBeDefined();
    const script = step.run.match(/bun - <<'BUN'\n([\s\S]*?)\nBUN/)[1];
    const parent = path.join(repoRoot, '.test-data', 'task-evidence-contract');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'case-'));
    try {
      const input = path.join(directory, '.test-data', 'acceptance');
      await mkdir(input, { recursive: true });
      if (contents !== undefined) await writeFile(path.join(input, 'live-gateway-login-chat-local.json'), contents);
      const output = execFileSync('bun', ['-e', script], {
        cwd: directory, encoding: 'utf8',
        env: { ...process.env, GITHUB_WORKSPACE: repoRoot, RUNNER_TEMP: directory, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' },
      });
      const evidence = await readFile(path.join(directory, 'task-approval-evidence.json'), 'utf8').catch(() => undefined);
      return { output, evidence };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('executes the projection with a strict allowlist, retaining all three Task cases but no identifiers or free text', async () => {
    const secret = 'synthetic-private-value';
    const result = await projectTaskEvidence(JSON.stringify({
      webId: secret, gateway: secret, modelIds: [secret], apiKey: secret,
      taskApproval: {
        ok: true, failure: secret,
        cases: ['approved', 'rejected', 'stopped'].map(kind => ({
          kind, ok: true, queuedAck: true, approvalPending: true, sessionPaused: true,
          sessionCompleted: true, sameRun: true, stableAfterDuplicateOrStop: true,
          decision: kind === 'stopped' ? secret : kind,
          terminalStatus: kind === 'approved' ? 'completed' : 'cancelled',
          taskId: secret, runId: secret, error: secret, toolArguments: secret,
          markerMatches: kind === 'approved', markerAbsent: kind !== 'approved', duplicateResume: kind !== 'stopped',
        })).concat([{ kind: secret, ok: true }] as any),
        cleanup: { ok: true, tasksPaused: 3, runsStopped: 0, sessionsTerminal: 3, grantRevoked: true, credential: secret },
      },
    }));
    expect(result.evidence).toBeDefined();
    expect(result.evidence).not.toContain(secret);
    expect(result.output).not.toContain(secret);
    const evidence = JSON.parse(result.evidence!);
    expect(evidence).toMatchObject({ schemaVersion: 1, sourceSha: 'a'.repeat(40), runId: '123', runAttempt: '2', ok: true, failurePresent: true });
    expect(evidence.cases.map((row: any) => row.kind)).toEqual(['approved', 'rejected', 'stopped']);
    expect(evidence.cases[0]).toMatchObject({ terminalStatus: 'completed', markerMatches: true, duplicateResume: true });
    expect(evidence.cases[2]).toMatchObject({ terminalStatus: 'cancelled', markerAbsent: true, stableAfterDuplicateOrStop: true });
    expect(evidence.cases[2].decision).toBeUndefined();
    expect(evidence.cleanup).toEqual({ ok: true, tasksPaused: 3, runsStopped: 0, sessionsTerminal: 3, grantRevoked: true });
  });

  it('projects producer diagnostics with a second strict allowlist', async () => {
    const secret = 'SYNTHETIC_CREDENTIAL_MARKER';
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false, cases: [
      { kind: 'approved', ok: false, producerFailure: { status: 'failed', errorPresent: true, errorLength: 99,
        errorClass: 'service_access_missing', httpStatus: 403, error: secret, stack: secret, body: secret, url: secret } },
      { kind: 'rejected', ok: false, producerFailure: { status: secret, errorPresent: secret, errorLength: -1,
        errorClass: secret, httpStatus: 200, error: secret } },
    ], cleanup: { ok: true } } }));
    expect(result.output + result.evidence).not.toContain(secret);
    const cases = JSON.parse(result.evidence!).cases;
    expect(cases[0].producerFailure).toEqual({ status: 'failed', errorPresent: true, errorLength: 99,
      errorClass: 'service_access_missing', httpStatus: 403 });
    expect(cases[1].producerFailure).toBeUndefined();
  });

  it.each([
    ['status', 'private'], ['errorClass', 'private'], ['errorPresent', 'private'],
    ['errorLength', -1], ['errorLength', 1.5], ['errorLength', 1000001],
  ])('rejects invalid producer diagnostic %s', async (field, value) => {
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { cases: [
      { kind: 'approved', producerFailure: { status: 'failed', errorClass: 'unknown', errorPresent: true,
        errorLength: 10, [field]: value } },
    ] } }));
    expect(JSON.parse(result.evidence!).cases[0].producerFailure).toBeUndefined();
    expect(result.output + result.evidence).not.toContain('private');
  });
  it.each([200, 600, 403.5, '403'])('omits invalid producer HTTP status %s', async httpStatus => {
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { cases: [
      { kind: 'approved', producerFailure: { status: 'failed', errorClass: 'unknown', errorPresent: true,
        errorLength: 10, httpStatus } },
    ] } }));
    expect(JSON.parse(result.evidence!).cases[0].producerFailure).toEqual({
      status: 'failed', errorClass: 'unknown', errorPresent: true, errorLength: 10,
    });
  });

  it('keeps only exact failure enums and rejects unsafe or successful-case diagnostics', async () => {
    const workflow = await loadWorkflow();
    const script = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Project safe Task approval evidence').run;
    expect(script).toContain("'src/api/tasks/TaskRunFailureDiagnostic.ts'");
    expect(script).toContain('projectTaskRunFailureDiagnostic(row.failureDiagnostic');
    expect(script).not.toContain('const failureCodes');
    expect(script).not.toContain('const failureStages');
    const diagnostic = { code: 'TASK_RUNTIME_ERROR', stage: 'start_backend', status: 'failed' };
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false, cases: [
      { kind: 'approved', ok: false, failureDiagnostic: { ...diagnostic, body: 'private-secret https://private.example' } },
      { kind: 'rejected', ok: false, failureDiagnostic: { ...diagnostic, code: 'private-secret' } },
      { kind: 'stopped', ok: true, failureDiagnostic: diagnostic },
    ], cleanup: {} } }));
    const cases = JSON.parse(result.evidence!).cases;
    expect(cases[0].failureDiagnostic).toEqual(diagnostic);
    expect(cases[1].failureDiagnostic).toBeUndefined();
    expect(cases[2].failureDiagnostic).toBeUndefined();
    expect(result.evidence).not.toContain('private-secret');
  });

  it('omits invalid field types instead of copying arbitrary payloads into evidence', async () => {
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: {
      ok: 'private payload', failure: false,
      cases: [{ kind: 'approved', ok: false, queuedAck: 'private payload', decision: 'private payload', terminalStatus: 'private payload' }],
      cleanup: { ok: false, grantRevoked: 'private payload', tasksPaused: -1, runsStopped: 'private payload', sessionsTerminal: 1.5 },
    } }));
    expect(result.evidence).not.toContain('private payload');
    expect(JSON.parse(result.evidence!)).toMatchObject({
      ok: false, failurePresent: false, cases: [{ kind: 'approved', ok: false }], cleanup: { ok: false },
    });
    expect(JSON.parse(result.evidence!).cleanup).toEqual({ ok: false });
  });

  it.each([undefined, '{private malformed input'])('warns safely when Task evidence is missing or unreadable (%s)', async contents => {
    const result = await projectTaskEvidence(contents);
    expect(result.evidence).toBeUndefined();
    expect(result.output).toContain('::warning::');
    expect(result.output).not.toContain('private malformed input');
  });

  it('separates service checks from unified promotion evidence and records every blocking delivery check', async () => {
    const workflow = await loadWorkflow();
    const serviceText = jobRunText(workflow, 'deploy_and_accept');
    const serviceUpload = workflow.jobs.deploy_and_accept.steps.find((step: any) =>
      step.uses === 'actions/upload-artifact@v4');
    const finalize = workflow.jobs.finalize_acceptance;
    const finalizeText = jobRunText(workflow, 'finalize_acceptance');
    const finalUpload = finalize.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4');

    expect(serviceText).not.toContain('release-acceptance-manifest.cjs create');
    // The desktop job builds the app; it cannot see the service acceptance artifact or the
    // image digest, so only the job that downloads them may freeze the manifest.
    expect(jobRunText(workflow, 'build_desktop_rc')).not.toContain('release-acceptance-manifest.cjs create');
    expect(jobRunText(workflow, 'build_desktop_rc')).not.toContain('release-acceptance-${{ github.sha }}');

    const desktopUpload = workflow.jobs.build_desktop_rc.steps.find((step: any) =>
      step.uses === 'actions/upload-artifact@v4' && step.with?.name?.startsWith('xpod-desktop-macos-'));
    expect(desktopUpload.with.name).toBe('xpod-desktop-macos-${{ needs.metadata.outputs.candidate }}');
    expect(desktopUpload.with.path).toContain('desktop/release/*.zip');
    expect(desktopUpload.with.path).toContain('desktop/release/*.dmg');
    expect(desktopUpload.with['if-no-files-found']).toBe('error');

    expect(serviceUpload.with.name).toBe('release-service-acceptance-${{ github.sha }}');
    expect(serviceUpload.with.path).toBe('${{ runner.temp }}/checks.json');
    expect(finalize.needs).toEqual([
      'metadata',
      'build_image',
      'deploy_and_accept',
      'build_desktop_rc',
    ]);
    expect(finalizeText).toContain('node scripts/release-acceptance-manifest.cjs create');
    for (const check of [
      'image',
      'service-status',
      'oidc',
      'dashboard',
      'protected-route',
      'deployed-digest',
      'direct-pod',
      'postgres-17',
      'postgres-prepared-clone',
      'vector',
      'public-service',
      'secret-isolation',
      'authenticated-pod',
      'pod-read-write',
      'gateway-key',
      'ai-connections',
      'models',
      'chat',
      'qlever-local',
      'desktop',
    ]) {
      expect(`${serviceText}\n${finalizeText}`).toContain(check);
    }
    // qlever-local and package-consumers must be verified from downloaded,
    // source-bound evidence, never echoed as literals.
    expect(finalizeText).toContain('scripts/release-gate-evidence.cjs verify-qlever-local');
    expect(finalizeText).toContain('scripts/release-gate-evidence.cjs verify-package-consumers');
    expect(finalizeText).toContain('qlever-local-check.json');
    expect(finalizeText).toContain('package-consumer-check.json');
    expect(finalizeText).not.toMatch(/['"]qlever-local['"]\s*:\s*['"]passed['"]/);
    expect(finalizeText).not.toMatch(/['"]package-consumers['"]\s*:\s*['"]passed['"]/);
    const finalizeArtifacts = finalize.steps
      .filter((step: any) => step.uses === 'actions/download-artifact@v4')
      .map((step: any) => step.with.name);
    expect(finalizeArtifacts).toEqual(expect.arrayContaining([
      'qlever-local-runtime-darwin-arm64-${{ github.sha }}',
      'package-consumer-acceptance-${{ github.sha }}',
    ]));
    const desktopRunText = jobRunText(workflow, 'build_desktop_rc');
    expect(desktopRunText).toContain('scripts/release-gate-evidence.cjs create-package-consumers');
    const packageUpload = workflow.jobs.build_desktop_rc.steps.find((step: any) =>
      step.uses === 'actions/upload-artifact@v4' && step.with?.name === 'package-consumer-acceptance-${{ github.sha }}');
    expect(packageUpload.with['if-no-files-found']).toBe('error');
    expect(packageUpload.with.path).toContain('package-consumer-evidence.json');
    expect(finalizeText).not.toContain('npm');
    expect(finalUpload.with.name).toBe('release-acceptance-${{ github.sha }}');
    expect(finalUpload.with.path).toBe('${{ runner.temp }}/release-acceptance.json');

    const diagnostics = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Dump diagnostics');
    expect(diagnostics.if).toBe('failure()');
    expect(diagnostics.run).toContain('kubectl -n "$SEALOS_NAMESPACE" get');
    expect(diagnostics.run).toContain('describe deployment xpod-rc');
    expect(diagnostics.run).not.toContain('xpod-rc-postgres');
    expect(diagnostics.run).toContain('--previous');
    expect(diagnostics.run).toContain('live-gateway-local-container-name');
    expect(diagnostics.run).toContain('docker inspect "$local_name"');
    expect(diagnostics.run).toContain('docker logs "$local_name"');
    const cleanup = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Scale RC deployments to zero');
    expect(cleanup.if).toContain('always()');
    expect(cleanup.if).toContain("vars.XPOD_RC_SCALE_TO_ZERO == 'true'");
    expect(cleanup.run).toContain('scripts/verify-gz-rc-prerequisites.cjs scale-owned-rc');
    expect(cleanup.run).not.toContain('scale statefulset');
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
});


describe('native RC predeployment admission', () => {
  it('binds service OCI labels and compiles before exact native pair comparison', async () => {
    const workflow = await loadWorkflow();
    const build = workflow.jobs.build_image.steps.find((step: any) => step.name === 'Build and push RC image');
    expect(build.with.labels).toContain('org.opencontainers.image.source=https://github.com/undefinedsco/xpod');
    expect(build.with.labels).toContain('org.opencontainers.image.revision=${{ needs.metadata.outputs.sourceSha }}');
    const steps = workflow.jobs.deploy_and_accept.steps;
    const index = (name: string) => steps.findIndex((step: any) => step.name === name);
    const compile = index('Compile current source before comparing installed runner bytes');
    const pair = index('Preflight immutable native images before any RC mutation');
    const private17 = index('Require independent exact-pair Private17 admission before RC mutation');
    const namespace = index('Preflight exact PostgreSQL image pull in the assigned namespace');
    const rotation = index('Create runtime secrets');
    expect(compile).toBeGreaterThan(-1);
    expect(pair).toBeGreaterThan(compile);
    expect(private17).toBeGreaterThan(pair);
    expect(namespace).toBeGreaterThan(private17);
    expect(rotation).toBeGreaterThan(namespace);
    expect(steps[compile].run).toBe('bun run build:ts');
    expect(steps[pair].run).toContain('--source-sha "$NATIVE_SOURCE_SHA" --runner-sha256 "$runner_sha"');
    expect(steps[pair].run).toContain('umask 077');
    expect(steps[pair].run).toContain('trap cleanup_native_registry EXIT');
    expect(steps[pair].run).toContain('--select-registry-authority');
    expect(steps[pair].run).toContain('get secret "$pg_workload_authority"');
    expect(steps[pair].run).not.toContain('tcr-creds');
    expect(steps[pair].run).toContain('--install-registry-config');
    expect(steps[pair].run).not.toMatch(/docker login|create secret|registry-mirror/);
    expect(steps[private17].run).toContain('--verify-private17-admission');
    expect(steps[private17].run).toContain('--admission-sha256');
    expect(steps[private17].run).toContain('RC mutation refused');
    expect(steps[private17].run).not.toMatch(/checkout|PAT|GITHUB_TOKEN/);
  });

  it('requires fresh UID/imageID and UID-preconditioned owned Job cleanup', async () => {
    const workflow = await loadWorkflow();
    const step = workflow.jobs.deploy_and_accept.steps.find((entry: any) => entry.name === 'Preflight exact PostgreSQL image pull in the assigned namespace');
    expect(step.run).toContain('kubectl create -f');
    expect(step.run).not.toContain('kubectl apply');
    expect(step.run).toContain('job_created=true');
    expect(step.run).toContain('preconditions:{uid:job.metadata.uid}');
    expect(step.run).toContain('--validate-pull-job');
    expect(step.run).toContain('--job-uid "$job_uid"');
    expect(step.run).toContain('--select-registry-authority');
    expect(step.run).toContain('--authority-name "$pg_authority"');
    expect(step.run).toContain('job.spec.template.spec.imagePullSecrets=[{name:process.env.PREFLIGHT_AUTHORITY}]');
    expect(step.run).not.toContain('tcr-creds');
    expect(step.run).toContain('if [ "$original_exit" -eq 0 ]; then original_exit=70; fi');
    expect(step.run).not.toContain('|| true');
    const run = jobRunText(workflow, 'deploy_and_accept');
    expect(run).toContain('private17-admission-check.json');
    expect(run).toContain("nativePair.ownedCleanup !== 'verified-absent'");
    expect(run).toContain("private17.database === nativePair.database");
  });
});


const fakeNamespaceKubectl = `#!/usr/bin/env python3
import sys,os,json,pathlib
args=sys.argv[1:]; root=pathlib.Path(os.environ['FAKE_KUBE_STATE']); mode=os.environ['FAKE_KUBE_MODE']; jobfile=root/'job.json'; podfile=root/'pod.json'
with (root/'calls.jsonl').open('a') as out: out.write(json.dumps(args)+'\\n')
if args[:2]==['config','view']:
 print(json.dumps({'clusters':[{'cluster':{'server':'https://gzg.sealos.run:6443'}}],'contexts':[{'context':{'namespace':'ns-iknkxtc8'}}]}));sys.exit()
if args[0]=='create':
 job=json.loads(pathlib.Path(args[args.index('-f')+1]).read_text()); job['metadata']['uid']='created-uid'; job['status']={'conditions':[{'type':'Complete','status':'True'}]}
 if mode=='foreign-create':
  job['metadata']['uid']='foreign-uid'; job['metadata']['annotations']={'xpod.undefineds.co/preflight-owner':'foreign'}; jobfile.write_text(json.dumps(job)); print('foreign-create-refused',file=sys.stderr); sys.exit(18)
 jobfile.write_text(json.dumps(job)); pod={'metadata':{'uid':'created-pod-uid','ownerReferences':[{'uid':'created-uid','kind':'Job','controller':True}]},'status':{'phase':'Succeeded','containerStatuses':[{'name':'postgres-preflight','imageID':'docker-pullable://'+job['spec']['template']['spec']['containers'][0]['image'],'state':{'terminated':{'exitCode':0}}}]}}; podfile.write_text(json.dumps(pod))
 if mode=='ack-loss': print('ack-lost',file=sys.stderr); sys.exit(27)
 print(json.dumps(job))
elif 'get' in args:
 kind=args[args.index('get')+1]
 if kind=='statefulset': print(json.dumps({'kind':'StatefulSet','metadata':{'name':'xpod-rdf-postgres','namespace':'assigned-rc'},'spec':{'template':{'spec':{'imagePullSecrets':[{'name':'xpod-rdf-ghcr'}],'containers':[{'name':'postgres','image':'ghcr.io/undefinedsco/xpod-rdf-postgres@sha256:156b6ef3a27d5ee43b8aa54c16583b288cfb33e47e532aaa1f377515f187fed5'}]}}}}))
 if kind=='job':
  if jobfile.exists():
   job=json.loads(jobfile.read_text())
   if mode=='replaced': job['metadata']['uid']='foreign-uid'; jobfile.write_text(json.dumps(job))
   print(json.dumps(job))
 elif kind=='pods': print(json.dumps({'items':[json.loads(podfile.read_text())] if podfile.exists() else []}))
elif 'wait' in args:
 if '--for=condition=complete' in args and mode=='primary-failed': print('actual-primary-42',file=sys.stderr); sys.exit(42)
 if '--for=delete' in args and (jobfile.exists() or podfile.exists()): sys.exit(24)
elif args[0]=='delete' and '--raw' in args:
 options=json.loads(pathlib.Path(args[args.index('-f')+1]).read_text()); job=json.loads(jobfile.read_text())
 if mode=='raw-race': job['metadata']['uid']='foreign-uid'; jobfile.write_text(json.dumps(job))
 if options['preconditions']['uid']!=job['metadata']['uid']: print('PRIVATE_409_BODY',file=sys.stderr); sys.exit(39)
 if os.environ['FAKE_KUBE_CLEANUP_EXIT']!='0': print('PRIVATE_CLEANUP_BODY',file=sys.stderr); sys.exit(23)
 jobfile.unlink(); podfile.unlink()
else: print('unsupported-fake-call',file=sys.stderr); sys.exit(80)
`;

describe('actual namespace preflight shell with fake Kubernetes', () => {
  it.each([
    ['success', 0, 0], ['primary-failed', 23, 42], ['success', 23, 70],
    ['foreign-create', 0, 18], ['replaced', 0, 1], ['raw-race', 0, 70], ['ack-loss', 0, 27],
  ] as const)('%s / cleanup %s returns %s without deleting foreign Jobs', async (mode, cleanupExit, expectedExit) => {
    const workflow = await loadWorkflow();
    const step = workflow.jobs.deploy_and_accept.steps.find((entry: any) => entry.name === 'Preflight exact PostgreSQL image pull in the assigned namespace');
    const base = path.join(repoRoot, '.test-data/native-namespace-producer-test'); mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'run-')); chmodSync(dir, 0o700);
    const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const temp = path.join(dir, 'temp');
    for (const sub of [bin, state, temp]) mkdirSync(sub, { mode: 0o700 });
    writeFileSync(path.join(bin, 'kubectl'), fakeNamespaceKubectl, { mode: 0o700 });
    writeFileSync(path.join(temp, 'prepared-pg-workload.json'), JSON.stringify({kind:'StatefulSet', metadata:{name:'prepared-clone',namespace:'ns-iknkxtc8'},spec:{template:{spec:{imagePullSecrets:[{name:'xpod-rdf-ghcr'}],containers:[{name:'postgres',image:'ghcr.io/undefinedsco/xpod-rdf-postgres@sha256:156b6ef3a27d5ee43b8aa54c16583b288cfb33e47e532aaa1f377515f187fed5'}]}}}}));
    try {
      const start = Date.now();
      const result = spawnSync('bash', ['-c', step.run], { cwd: repoRoot, encoding: 'utf8', timeout: 25_000, env: {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: temp,
        SEALOS_NAMESPACE: 'ns-iknkxtc8', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
        FAKE_KUBE_STATE: state, FAKE_KUBE_MODE: mode, FAKE_KUBE_CLEANUP_EXIT: String(cleanupExit),
      } });
      const evidenceDir = process.env.XPOD_NATIVE_TEST_EVIDENCE_DIR;
      const raw = `${result.stdout}\n${result.stderr}`;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(evidenceDir, `namespace-${mode}-${cleanupExit}.log`), raw, { mode: 0o600 });
        writeFileSync(path.join(evidenceDir, `namespace-${mode}-${cleanupExit}.receipt.json`), JSON.stringify({
          command: ['bash', '-c', step.run], pid: result.pid, actualExit: result.status, signal: result.signal,
          wallMs: Date.now() - start, closedLogSHA256: createHash('sha256').update(raw).digest('hex'),
          calls: readFileSync(path.join(state, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
        }, null, 2), { mode: 0o600 });
      }
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(expectedExit);
      expect(raw).not.toContain('PRIVATE_409_BODY'); expect(raw).not.toContain('PRIVATE_CLEANUP_BODY');
      const calls = readFileSync(path.join(state, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      const deletes = calls.filter(call => call[0] === 'delete');
      if (mode === 'success' && cleanupExit === 0) {
        expect(() => readFileSync(path.join(state, 'job.json'))).toThrow();
        expect(() => readFileSync(path.join(state, 'pod.json'))).toThrow();
        expect(JSON.parse(readFileSync(path.join(temp, 'namespace-native-pull-check.json'), 'utf8')).status).toBe('ok');
      }
      if (mode === 'ack-loss') {
        expect(deletes).toHaveLength(1);
        expect(() => readFileSync(path.join(state, 'job.json'))).toThrow();
        expect(() => readFileSync(path.join(state, 'pod.json'))).toThrow();
      }
      if (mode === 'foreign-create' || mode === 'replaced') {
        expect(deletes).toHaveLength(0); expect(JSON.parse(readFileSync(path.join(state, 'job.json'), 'utf8')).metadata.uid).toBe('foreign-uid');
      }
      if (mode === 'raw-race') {
        expect(deletes).toHaveLength(1); expect(deletes[0]).toContain('--raw');
        expect(JSON.parse(readFileSync(path.join(state, 'job.json'), 'utf8')).metadata.uid).toBe('foreign-uid');
      }
      if (cleanupExit !== 0 || mode === 'replaced' || mode === 'raw-race') expect(raw).toContain('owned-cleanup-failed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('source-bound private17 Release mutation guard', () => {
  it.each(['missing-authority', 'missing-build-output'])('closes before runtime rotation when %s', async mode => {
    const workflow = await loadWorkflow();
    const gate = workflow.jobs.deploy_and_accept.steps.find((entry: any) => entry.name === 'Require independent exact-pair Private17 admission before RC mutation');
    const base = path.join(repoRoot, '.test-data/private17-predeploy-guard-test'); mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'run-')); chmodSync(dir, 0o700);
    try {
      const result = spawnSync('bash', ['-c', `${gate.run}\nprintf entered > "$RUNNER_TEMP/rotation-entered"`], {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir,
          PRIVATE17_ADMISSION_SHA256: mode === 'missing-authority' ? '' : 'a'.repeat(64),
          NATIVE_SOURCE_SHA: '', NATIVE_SERVICE_IMAGE: '' },
      });
      expect(result.status).toBe(1); expect(result.signal).toBeNull();
      expect(result.stderr).toContain('RC mutation refused');
      expect(() => readFileSync(path.join(dir, 'rotation-entered'))).toThrow();
      const evidenceDir = process.env.XPOD_NATIVE_TEST_EVIDENCE_DIR;
      if (evidenceDir) {
        const raw = `${result.stdout}\n${result.stderr}`;
        writeFileSync(path.join(evidenceDir, `private17-${mode}.log`), raw, { mode: 0o600 });
        writeFileSync(path.join(evidenceDir, `private17-${mode}.receipt.json`), JSON.stringify({
          pid: result.pid, actualExit: result.status, signal: result.signal,
          closedLogSHA256: createHash('sha256').update(raw).digest('hex'), rotationEntered: false,
        }, null, 2), { mode: 0o600 });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('public Release transport contract', () => {
  it('keeps original build needs, existing read-only identity and no private fixture acquisition', async () => {
    const workflow = await loadWorkflow(); const job = workflow.jobs.deploy_and_accept;
    const gate = job.steps.find((entry: any) => entry.name === 'Require independent exact-pair Private17 admission before RC mutation');
    expect(job.needs).toEqual(['metadata', 'build_image']); expect(job.permissions.contents).toBe('read');
    expect(gate.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(gate.env.PRIVATE17_ADMISSION_SHA256).toBe('${{ vars.XPOD_PRIVATE17_ADMISSION_SHA256 }}');
    expect(gate.run).toContain('--acquire-private17-admission'); expect(gate.run).toContain('mktemp -d');
    expect(gate.run).toContain('trap cleanup_private17_proof EXIT'); expect(gate.run).toContain('private17-admission.json');
    expect(gate.run).not.toMatch(/private-root|fixture|PAT|checkout|clobber|skip-existing|archive|latest/);
    expect(gate.run).not.toMatch(/build:ts|docker build|apply-root-version/);
  });
  it.each(['missing-release', 'stale-authority'])('refuses rotation and removes owned proof directory for %s', async mode => {
    const workflow = await loadWorkflow();
    const gate = workflow.jobs.deploy_and_accept.steps.find((entry: any) => entry.name === 'Require independent exact-pair Private17 admission before RC mutation');
    const base = path.join(repoRoot, '.test-data/private17-predeploy-guard-test'); mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(base, 'release-')); chmodSync(dir, 0o700); const bin = path.join(dir, 'bin'); mkdirSync(bin, { mode: 0o700 });
    writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env python3
import sys
sys.stdout.write('{"transport":"PRIVATE_SENTINEL"}')
sys.stderr.write('PRIVATE_DOWNLOAD_ERROR')
sys.exit(${mode === 'missing-release' ? 27 : 0})
`, { mode: 0o700 });
    writeFileSync(path.join(dir, 'native-runner.sha256'), 'd'.repeat(64), { mode: 0o600 });
    try {
      const result = spawnSync('bash', ['-c', `${gate.run}\nprintf entered > "$RUNNER_TEMP/rotation-entered"`], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          RUNNER_TEMP: dir, PRIVATE17_ADMISSION_SHA256: 'a'.repeat(64), NATIVE_SOURCE_SHA: 'c'.repeat(40),
          NATIVE_SERVICE_IMAGE: `ghcr.io/undefinedsco/xpod@sha256:${'b'.repeat(64)}` },
      });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(mode === 'missing-release' ? 27 : 1);
      expect(`${result.stdout} ${result.stderr}`).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_DOWNLOAD_ERROR/);
      expect(() => readFileSync(path.join(dir, 'rotation-entered'))).toThrow();
      const remaining = await (await import('node:fs/promises')).readdir(dir);
      expect(remaining.some(name => name.startsWith('private17-proof'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('GZ-only RC data and shared-resource protection', () => {
  it('rejects any other cluster or namespace before deployment', async () => {
    const helper = require('../../scripts/verify-gz-rc-prerequisites.cjs');
    expect(() => helper.validateBoundary('https://gzg.sealos.run:6443', 'ns-iknkxtc8')).not.toThrow();
    for (const [server, namespace] of [
      ['https://sgp.sealos.run:6443', 'ns-iknkxtc8'],
      ['https://gzg.sealos.run:6443', 'other-ns'],
    ]) expect(() => helper.validateBoundary(server, namespace)).toThrow();
  });

  it('never resets data or mutates shared Gateway and Inngest during an RC rollout', async () => {
    const workflow = await loadWorkflow();
    const run = jobRunText(workflow, 'deploy_and_accept');
    expect(run).not.toMatch(/delete (?:deployment|statefulset|service|pvc|secret)\//);
    expect(run).not.toContain('openssl rand -hex');
    expect(run).not.toContain('--overlay deploy/sealos/rc-postgres');
    expect(run).not.toContain('CREATE EXTENSION');
    expect(run).not.toContain('update-gateway-rc-configmap');
    expect(run).not.toContain('patch-shared-inngest-rc');
    expect(run).not.toContain('rollout restart deployment/gateway');
    expect(run).not.toContain('get secret "$XPOD_RUNTIME_SECRET_NAME" -o json');
    expect(run).toContain('scripts/verify-gz-rc-prerequisites.cjs preflight');
    expect(run).toContain('scripts/verify-gz-rc-prerequisites.cjs cleanup-run-secrets');
  });

  it('preserves the supplied prepared database authority and refuses the old shared PG16 source', () => {
    const helper = require('../../scripts/verify-gz-rc-prerequisites.cjs');
    const env = { CSS_IDENTITY_DB_URL: 'postgresql://xpod_rc:PRIVATE@prepared-clone.ns-iknkxtc8.svc:5432/xpod_rc',
      CSS_SPARQL_ENDPOINT: 'postgresql://xpod_rc:PRIVATE@prepared-clone.ns-iknkxtc8.svc:5432/xpod_rc' };
    expect(helper.preparedDatabase(env)).toMatchObject({ service: 'prepared-clone', database: 'xpod_rc' });
    expect(env.CSS_IDENTITY_DB_URL).toContain('PRIVATE');
    expect(() => helper.preparedDatabase({ ...env, CSS_SPARQL_ENDPOINT: env.CSS_SPARQL_ENDPOINT.replace('prepared-clone', 'foreign') })).toThrow();
    for (const service of ['undefineds-gz-postgresql-postgresql', 'xpod-rdf-postgres-rc', 'xpod-rc-postgres']) {
      const dsn = env.CSS_IDENTITY_DB_URL.replace('prepared-clone', service);
      expect(() => helper.preparedDatabase({ CSS_IDENTITY_DB_URL: dsn, CSS_SPARQL_ENDPOINT: dsn })).toThrow();
    }
  });

  it('uses the unified Bun CLI while retaining the native cloud.qlever configuration', async () => {
    const deployment = parseDocument(await readFile(path.join(repoRoot, 'deploy/sealos/rc/deployment.yaml'), 'utf8')).toJSON();
    const xpod = deployment.spec.template.spec.containers.find((entry: any) => entry.name === 'xpod');
    expect(xpod.command).toEqual(['bun']);
    expect(xpod.args).toEqual(['--no-env-file', 'dist/cli/index.js', 'start', '--mode', 'cloud', '--config',
      'config/cloud.qlever.json', '--port', '3000', '--host', '0.0.0.0']);
    const workflow = await loadWorkflow();
    expect(jobRunText(workflow, 'deploy_and_accept')).not.toContain('-- node -e');
  });

  it('has no legacy RC host in candidate or promotion endpoint authority', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const manifest = await readFile(path.join(repoRoot, 'scripts/release-acceptance-manifest.cjs'), 'utf8');
    expect(workflow).not.toMatch(/(?:id|pods|api)-rc\.undefineds\.co/);
    expect(manifest).not.toContain('https://id-rc.undefineds.co');
    expect(workflow).toContain('https://undefineds-gz-rc-id.sealosgzg.site');
  });
});

const gzHelper = () => require('../../scripts/verify-gz-rc-prerequisites.cjs');
function gzObject(kind: string, name: string, extra: Record<string, any> = {}): any {
  return {kind,metadata:{name,namespace:'ns-iknkxtc8',uid:`${name}-uid`,resourceVersion:'42'},...extra};
}
function gzRouteFixture(): any {
  const hosts = gzHelper().GZ_HOSTS;
  const gateway = gzObject('ConfigMap','gateway',{data:{nginx:hosts.map((host: string,index: number) => `server { listen ${[8082,8083,8081][index]}; server_name ${host}; location / { proxy_pass http://xpod-rc:80; proxy_set_header Host $host; proxy_set_header X-Forwarded-Host $host; proxy_set_header X-Forwarded-Proto https; } }`).join('\n')}});
  const ingresses = {items:hosts.map((host: string,index: number) => gzObject('Ingress',`rc-${index}`,{spec:{tls:[{hosts:[host],secretName:`tls-${index}`}],rules:[{host,http:{paths:[{path:'/',pathType:'Prefix',backend:{service:{name:'gateway',port:{number:[8082,8083,8081][index]}}}}]}}]}}))};
  const inngest = gzObject('Deployment','xpod-inngest',{spec:{template:{spec:{containers:[{name:'inngest',args:['--sdk-url','http://production/api/inngest','--sdk-url','http://xpod-rc/api/inngest'],env:[{name:'XPOD_RC_INNGEST_EVENT_KEY',valueFrom:{secretKeyRef:{name:'existing-rc-key',key:'XPOD_INNGEST_EVENT_KEY'}}}]}]}}}});
  return {gateway,ingresses,inngest};
}
describe('prepared GZ resource admission facts', () => {
  it('checks existing shared routes without changing any bytes or clients', () => {
    const input = gzRouteFixture(); const before = JSON.stringify(input);
    expect(gzHelper().verifySharedRoutes(input.gateway,input.ingresses)).toHaveLength(4);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(['legacy-host','duplicate-host','wrong-upstream','foreign-namespace','deleting','wrong-ingress'])('refuses %s before shared writes or Secret creation', mode => {
    const input = gzRouteFixture();
    if(mode==='legacy-host') input.gateway.data.nginx=input.gateway.data.nginx.replace('undefineds-gz-rc-id.sealosgzg.site','id-rc.undefineds.co');
    if(mode==='duplicate-host') input.gateway.data.nginx+=input.gateway.data.nginx;
    if(mode==='wrong-upstream') input.gateway.data.nginx=input.gateway.data.nginx.replaceAll('xpod-rc:80','xpod-cn:80');
    if(mode==='missing-forwarding') input.gateway.data.nginx=input.gateway.data.nginx.replaceAll('proxy_set_header X-Forwarded-Proto https;','');
    if(mode==='foreign-namespace') input.gateway.metadata.namespace='other-ns';
    if(mode==='deleting') input.gateway.metadata.deletionTimestamp='now';
    if(mode==='wrong-ingress') input.ingresses.items[0].spec.rules[0].http.paths[0].backend.service.name='xpod-cn';
    if(mode==='missing-inngest') input.inngest.spec.template.spec.containers[0].args=[];
    expect(() => gzHelper().verifySharedRoutes(input.gateway,input.ingresses,input.inngest)).toThrow();
  });
  it('accepts declared GZ routes without inventing inline-header or shared Inngest prerequisites',()=>{
    const input=gzRouteFixture();input.gateway.data.nginx=input.gateway.data.nginx.replaceAll(/proxy_set_header [^;]+;/g,'');
    expect(gzHelper().verifySharedRoutes(input.gateway,input.ingresses)).toHaveLength(4);
  });
  it.each([160004,180000])('refuses incompatible database major %s', version => {
    expect(() => gzHelper().verifyDatabaseFacts({version,extensions:['vector','xpod_rdf','xpod_qlever'],native:{abiVersion:1,ready:true}})).toThrow();
  });
  it('requires both native extensions, vector and ready ABI 1', () => {
    const facts={version:170000,extensions:['vector','xpod_rdf','xpod_qlever'],native:{abiVersion:1,ready:true}};
    expect(() => gzHelper().verifyDatabaseFacts(facts)).not.toThrow();
    for(const name of facts.extensions) expect(() => gzHelper().verifyDatabaseFacts({...facts,extensions:facts.extensions.filter(x=>x!==name)})).toThrow();
    expect(() => gzHelper().verifyDatabaseFacts({...facts,native:{abiVersion:2,ready:true}})).toThrow();
  });
  it('binds prepared clone provenance, workload owner and actual PG156 imageID', () => {
    const h=gzHelper(); const service=gzObject('Service','clone');
    const workload=gzObject('StatefulSet','clone');
    workload.metadata.labels={'xpod.undefineds.co/rc-database':'prepared-pg17'};
    workload.metadata.annotations={'xpod.undefineds.co/rc-clone-source':h.SOURCE_DATABASE,'xpod.undefineds.co/rc-clone-archive-sha256':'a'.repeat(64)};
    const pod=gzObject('Pod','clone-0',{spec:{containers:[{name:'postgres',image:h.PG_IMAGE}]},status:{phase:'Running',conditions:[{type:'Ready',status:'True'}],containerStatuses:[{name:'postgres',ready:true,imageID:`docker-pullable://${h.PG_IMAGE}`}]}});
    pod.metadata.ownerReferences=[{controller:true,uid:workload.metadata.uid,name:'clone',kind:'StatefulSet'}];
    expect(h.verifyPreparedPod(service,{items:[pod]},workload)).toBe(pod);
    for(const change of [
      () => {pod.status.containerStatuses[0].imageID='sha256:'+'b'.repeat(64);},
      () => {pod.metadata.ownerReferences[0].uid='foreign';},
      () => {delete workload.metadata.annotations['xpod.undefineds.co/rc-clone-archive-sha256'];},
    ]) {
      const old=JSON.stringify({pod,workload});change();expect(() => h.verifyPreparedPod(service,{items:[pod]},workload)).toThrow();
      const restored=JSON.parse(old);Object.assign(pod,restored.pod);Object.assign(workload,restored.workload);
    }
  });
});

const fakeRunSecretKubectl=`#!/usr/bin/env python3
import sys,os,json,pathlib
args=sys.argv[1:];root=pathlib.Path(os.environ['FAKE_SECRET_STATE']);mode=os.environ['FAKE_SECRET_MODE']
with (root/'calls.jsonl').open('a') as out:out.write(json.dumps(args)+'\\n')
if args[:2]==['config','view']:
 print(json.dumps({'clusters':[{'cluster':{'server':'https://gzg.sealos.run:6443'}}],'contexts':[{'context':{'namespace':'ns-iknkxtc8'}}]}));sys.exit()
if 'create' in args:
 obj=json.load(sys.stdin);name=obj['metadata']['name'];obj['metadata']['uid']=name+'-birth';(root/(name+'.json')).write_text(json.dumps(obj))
 if mode=='ack-loss':print('PRIVATE_ACK',file=sys.stderr);sys.exit(17)
 print(obj['metadata']['uid']);sys.exit()
if 'get' in args:
 kind=args[args.index('get')+1]
 if kind in ['pods','deployments']:
  refs=[{'spec':{'secretRef':{'name':'xpod-rc-secret-123-1'}}}] if mode=='referenced' else []
  print(json.dumps({'items':refs}));sys.exit()
 name=args[args.index('get')+2];file=root/(name+'.json')
 if not file.exists():sys.exit()
 obj=json.loads(file.read_text())
 if mode=='replaced':obj['metadata']['uid']='foreign'
 print(json.dumps(obj['metadata']));sys.exit()
if args[0]=='delete':
 options=json.load(sys.stdin);name=args[args.index('--raw')+1].rsplit('/',1)[1];file=root/(name+'.json');obj=json.loads(file.read_text())
 if mode=='raw-race':print('PRIVATE_409',file=sys.stderr);sys.exit(39)
 if options['preconditions']['uid']!=obj['metadata']['uid']:sys.exit(40)
 file.unlink();sys.exit()
if 'wait' in args:sys.exit()
print('PRIVATE_UNSUPPORTED',file=sys.stderr);sys.exit(80)
`;
describe('actual versioned RC Secret CLI with fake Kubernetes', () => {
  it.each(['success','referenced','replaced','raw-race','ack-loss'])('protects birth ownership in %s', mode => {
    const parent=path.join(repoRoot,'.test-data/gz-run-secrets');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-'));const bin=path.join(dir,'bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'kubectl'),fakeRunSecretKubectl,{mode:0o700});
    writeFileSync(path.join(dir,'xpod-rc.env'),'CSS_IDENTITY_DB_URL=PRIVATE\n');writeFileSync(path.join(dir,'xpod-rc-seed.json'),'[{"password":"PRIVATE"}]');
    const env={...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,RUNNER_TEMP:dir,GITHUB_ENV:path.join(dir,'github-env'),SEALOS_NAMESPACE:'ns-iknkxtc8',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',XPOD_RUNTIME_SECRET_NAME:'xpod-rc-secret',FAKE_SECRET_STATE:dir,FAKE_SECRET_MODE:mode};
    try {
      const create=spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs','create-run-secrets'],{cwd:repoRoot,env,encoding:'utf8',timeout:10000});
      expect(create.signal).toBeNull();expect(create.status).toBe(mode==='ack-loss'?1:0);
      const cleanup=spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs','cleanup-run-secrets'],{cwd:repoRoot,env,encoding:'utf8',timeout:10000});
      expect(cleanup.signal).toBeNull();expect(cleanup.status).toBe(['replaced','raw-race'].includes(mode)?1:0);
      expect(create.stdout+create.stderr+cleanup.stdout+cleanup.stderr).not.toContain('PRIVATE');
      const calls=readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x) as string[]);
      const deletes=calls.filter(x=>x[0]==='delete');
      if(mode==='success') {expect(deletes).toHaveLength(2);expect(() => readFileSync(path.join(dir,'xpod-rc-secret-123-1.json'))).toThrow();}
      if(['replaced','ack-loss'].includes(mode)) expect(deletes).toHaveLength(0);
      if(mode==='referenced') {expect(deletes).toHaveLength(1);expect(JSON.parse(readFileSync(path.join(dir,'rc-run-secrets.json'),'utf8')).secrets[0].cleanup).toBe('retained-while-referenced');}
      if(mode==='raw-race') {expect(deletes).toHaveLength(1);expect(readFileSync(path.join(dir,'xpod-rc-secret-123-1.json'),'utf8')).toContain('birth');}
      expect(calls.filter(x=>x.includes('get')&&x.includes('secret')).every(x=>x.includes('jsonpath={.metadata}') || x.includes('jsonpath={.metadata.uid}'))).toBe(true);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});


describe('private prepared workload projection', () => {
  it('retains registry references without environment values or arbitrary annotations', () => {
    const input = gzObject('StatefulSet', 'prepared-clone', {spec:{template:{spec:{
      containers:[{name:'postgres',image:gzHelper().PG_IMAGE,env:[{name:'PASSWORD',value:'PRIVATE_ENV'}]}],
      imagePullSecrets:[{name:'existing-pull'}],
    }}}});
    input.metadata.annotations = {private:'PRIVATE_ANNOTATION'};
    const projection = gzHelper().preparedWorkloadProjection(input);
    expect(projection).toEqual({kind:'StatefulSet',metadata:{name:'prepared-clone',namespace:'ns-iknkxtc8',uid:'prepared-clone-uid',resourceVersion:'42'},
      spec:{template:{spec:{containers:[{name:'postgres',image:gzHelper().PG_IMAGE}],imagePullSecrets:[{name:'existing-pull'}]}}}});
    expect(JSON.stringify(projection)).not.toContain('PRIVATE');
  });
});
const fakePortForward = `#!/usr/bin/env python3
import os,sys,time,signal
mode=os.environ['FAKE_FORWARD_MODE']
if mode=='early-exit':print('PRIVATE_ERROR',file=sys.stderr);sys.exit(37)
if mode=='never-ready':time.sleep(20);sys.exit()
if mode=='cleanup-nonzero':signal.signal(signal.SIGTERM,lambda *_:sys.exit(37))
print('Forwarding from 127.0.0.1:23456 -> 5432',flush=True)
if mode=='ready-exit':time.sleep(.02);sys.exit(41)
if mode=='descendant':
 child=os.fork()
 if child==0:
  signal.signal(signal.SIGTERM,signal.SIG_IGN)
  time.sleep(20);sys.exit()
while True:time.sleep(.1)
`;
describe('actual owned port-forward lifecycle', () => {
  it.each(['success','spawn-error','early-exit','never-ready','ready-exit','cleanup-nonzero','consumer-failure','consumer-timeout','descendant'])('closes pipes and owned process group in %s', mode => {
    const parent=path.join(repoRoot,'.test-data/gz-port-forward');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-'));const bin=path.join(dir,'bin');mkdirSync(bin);
    if(mode!=='spawn-error')writeFileSync(path.join(bin,'kubectl'),fakePortForward,{mode:0o700});
    const launcher=path.join(dir,'launch.cjs');
    writeFileSync(launcher,`const h=require(${JSON.stringify(path.join(repoRoot,'scripts/verify-gz-rc-prerequisites.cjs'))});
      const mode=process.env.FAKE_FORWARD_MODE;
      h.withPortForward({metadata:{name:'owned-pod',uid:'owned-pod-uid'}},5432,async port=>{
        if(port!=='23456')throw Error('unexpected port');
        if(mode==='consumer-failure')throw Error('PRIVATE_CONSUMER');
        if(mode==='consumer-timeout'||mode==='ready-exit')await new Promise(resolve=>setTimeout(resolve,100));
        return 'checked';
      },{readyMs:2000,checkMs:mode==='consumer-timeout'?20:1000,stopMs:500}).then(result=>console.log(result),()=>{process.exitCode=1;});`);
    try {
      const env={...process.env,PATH:mode==='spawn-error'?bin:`${bin}${path.delimiter}${process.env.PATH}`,RUNNER_TEMP:dir,GITHUB_SHA:'0e260a49ce28cb7b5cf8ee0bc4342d893cb742a8',FAKE_FORWARD_MODE:mode};
      const result=spawnSync(process.execPath,[launcher],{cwd:repoRoot,env,encoding:'utf8',timeout:10000});
      expect(result.signal).toBeNull();expect(result.status).toBe(['success','descendant'].includes(mode)?0:1);
      expect(result.stdout+result.stderr).not.toContain('PRIVATE');
      const files=require('node:fs').readdirSync(dir) as string[];
      const receipt=JSON.parse(readFileSync(path.join(dir,files.find(file=>file.endsWith('.receipt.json'))!),'utf8'));
      const raw=readFileSync(path.join(dir,files.find(file=>file.endsWith('.raw.log'))!));
      expect(receipt).toMatchObject({sourceSha:'0e260a49ce28cb7b5cf8ee0bc4342d893cb742a8',podUID:'owned-pod-uid',actualWait:true,rawClosedBeforeHash:true,ownedGroupAbsentAfterWait:true,
        rawSHA256:createHash('sha256').update(raw).digest('hex')});
      if(mode==='spawn-error')expect(receipt.spawnError).toBe('ENOENT');
      else {expect(receipt.pid).toBe(receipt.pgid);expect(receipt.pid).toBeGreaterThan(0);}
      if(mode==='early-exit')expect(receipt.exit).toBe(37);
      if(mode==='cleanup-nonzero')expect(receipt).toMatchObject({exit:37,checkPassed:true,prematureExit:false});
      if(mode==='ready-exit')expect(receipt).toMatchObject({exit:41,prematureExit:true});
      if(mode==='never-ready')expect(receipt.readyTimeout).toBe(true);
      if(mode==='consumer-timeout')expect(receipt.checkTimeout).toBe(true);
      if(mode==='descendant')expect(receipt.forcedStop).toBe(true);
      if(mode==='success')expect(receipt.signal).toBe('SIGTERM');
      const evidence=process.env.XPOD_NATIVE_TEST_EVIDENCE_DIR;
      if(evidence){mkdirSync(evidence,{recursive:true,mode:0o700});writeFileSync(path.join(evidence,`forward-${mode}.raw.log`),raw,{mode:0o600});writeFileSync(path.join(evidence,`forward-${mode}.receipt.json`),JSON.stringify(receipt,null,2),{mode:0o600});}
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});

describe('run-owned managed RC executor', () => {
  it('reuses managed production protocol with isolated run name, callback and Secret', () => {
    const owner={nonce:'run-nonce',secrets:[{name:'runtime-123-1',uid:'runtime-uid'},{name:'seed-123-1',uid:'seed-uid'}]};
    const objects=gzHelper().buildManagedExecutor(owner,'123-1');
    expect(objects.map((entry:any)=>entry.kind)).toEqual(['Service','Deployment']);
    for(const object of objects)expect(object.metadata).toMatchObject({name:'xpod-rc-inngest-123-1',namespace:'ns-iknkxtc8',annotations:{'xpod.undefineds.co/rc-run-owner':'run-nonce'}});
    const deployment=objects[1],container=deployment.spec.template.spec.containers[0];
    expect(container.image).toBe('inngest/inngest:v1.19.4');expect(container.command).toEqual(['inngest']);
    expect(container.args[0]).toBe('start');expect(container.args).not.toContain('dev');
    expect(container.args[container.args.indexOf('--sdk-url')+1]).toBe('http://xpod-rc/api/inngest');
    expect(container.envFrom).toEqual([{secretRef:{name:'runtime-123-1'}}]);
    expect(container.args).toContain('$(CSS_IDENTITY_DB_URL)');expect(container.args).toContain('$(CSS_REDIS_CLIENT)');
    expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
  });
  it('refuses invalid or overlong run identity before executor birth',()=>{
    for(const id of ['prod','123-../other','9'.repeat(70)+'-1'])expect(()=>gzHelper().buildManagedExecutor({nonce:'n',secrets:[{name:'s'}]},id)).toThrow();
  });
});

const fakeExecutorKubectl=`#!/usr/bin/env python3
import sys,os,json,pathlib
args=sys.argv[1:];root=pathlib.Path(os.environ['FAKE_EXEC_STATE']);mode=os.environ['FAKE_EXEC_MODE'];name='xpod-rc-inngest-123-1'
with (root/'calls.jsonl').open('a') as out:out.write(json.dumps(args)+'\\n')
def file(kind,name):return root/(kind+'-'+name+'.json')
if args[:2]==['config','view']:
 print(json.dumps({'clusters':[{'cluster':{'server':'https://gzg.sealos.run:6443'}}],'contexts':[{'context':{'namespace':'ns-iknkxtc8'}}]}));sys.exit()
if 'create' in args:
 obj=json.load(sys.stdin);kind=obj['kind'].lower();obj['metadata']['uid']=kind+'-birth';obj['metadata']['resourceVersion']='1'
 if kind=='deployment':obj['status']={'availableReplicas':1}
 file(kind,obj['metadata']['name']).write_text(json.dumps(obj))
 if mode=='ack-'+kind:print('PRIVATE_ACK',file=sys.stderr);sys.exit(17)
 print(obj['metadata']['uid']);sys.exit()
if 'get' in args:
 kind=args[args.index('get')+1]
 if kind in ['pods','deployments']:
  objects=[json.loads(f.read_text()) for f in root.glob('deployment-*.json')] if kind=='deployments' else []
  if mode in ['referenced','previous-referenced']:objects.append({'spec':{'env':[{'name':'XPOD_INNGEST_BASE_URL','value':'http://'+('xpod-rc-inngest-122-1' if mode=='previous-referenced' else name)+':8288'}],**({'seed':{'secretName':'seed-old'}} if mode=='previous-referenced' else {})}})
  print(json.dumps({'items':objects}));sys.exit()
 target=args[args.index('get')+2]
 if mode=='history-read-error' and target=='runtime-old':sys.exit(55)
 if target=='xpod-rc' and not file(kind,target).exists():print(json.dumps({'kind':'Deployment','metadata':{'name':'xpod-rc','namespace':'ns-iknkxtc8','uid':'rc-uid','resourceVersion':'1'}}));sys.exit()
 f=file(kind,target)
 if mode=='collision' and kind=='service' and not f.exists():f.write_text(json.dumps({'metadata':{'uid':'foreign','annotations':{'xpod.undefineds.co/rc-run-owner':'foreign'}}}))
 if not f.exists():sys.exit()
 obj=json.loads(f.read_text())
 if mode==kind+'-replaced':obj['metadata']['uid']='foreign';f.write_text(json.dumps(obj))
 output=args[args.index('-o')+1]
 print(obj['metadata']['uid'] if output=='jsonpath={.metadata.uid}' else json.dumps(obj['metadata'] if output=='jsonpath={.metadata}' else obj));sys.exit()
if 'rollout' in args:
 if mode=='rollout-failed':print('PRIVATE_ROLLOUT',file=sys.stderr);sys.exit(44)
 print('deployment ready');sys.exit()
if args[0]=='delete':
 raw=args[args.index('--raw')+1];plural,target=raw.rsplit('/',2)[-2:];kind={'deployments':'deployment','services':'service','secrets':'secret'}[plural];f=file(kind,target);obj=json.loads(f.read_text());options=json.load(sys.stdin)
 if mode=='raw-race':obj['metadata']['uid']='foreign';f.write_text(json.dumps(obj))
 if obj['metadata']['uid']!=options['preconditions']['uid']:print('PRIVATE_409',file=sys.stderr);sys.exit(39)
 if options['propagationPolicy']!='Foreground':sys.exit(40)
 f.unlink();sys.exit()
if 'wait' in args:sys.exit()
print('PRIVATE_UNSUPPORTED',file=sys.stderr);sys.exit(80)
`;
describe('actual managed executor birth and cleanup CLI',()=>{
  it.each(['success','collision','ack-service','ack-deployment','service-replaced','deployment-replaced','rollout-failed','referenced','raw-race'])('protects actual owned resources in %s',mode=>{
    const parent=path.join(repoRoot,'.test-data/gz-executor-birth');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-'));const bin=path.join(dir,'bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'kubectl'),fakeExecutorKubectl,{mode:0o700});
    const sourceSha='0e260a49ce28cb7b5cf8ee0bc4342d893cb742a8';
    const record={sourceSha,nonce:'run-nonce',secrets:[{name:'runtime-123-1',uid:'runtime-uid'},{name:'seed-123-1',uid:'seed-uid'}]};
    writeFileSync(path.join(dir,'rc-run-secrets.json'),JSON.stringify(record));
    writeFileSync(path.join(dir,'gz-rc-prerequisites.json'),JSON.stringify({status:'ok',namespace:'ns-iknkxtc8',sourceSha}));
    const env={...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,RUNNER_TEMP:dir,SEALOS_NAMESPACE:'ns-iknkxtc8',GITHUB_SHA:sourceSha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',FAKE_EXEC_STATE:dir,FAKE_EXEC_MODE:mode};
    const execute=(command:string)=>spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs',command],{cwd:repoRoot,env,encoding:'utf8',timeout:10000});
    try {
      const birth=execute('create-run-executor');expect(birth.signal).toBeNull();expect(birth.status).toBe(['success','referenced','raw-race'].includes(mode)?0:1);
      const cleanup=execute('cleanup-run-executor');expect(cleanup.signal).toBeNull();expect(cleanup.status).toBe(['ack-service','ack-deployment','service-replaced','deployment-replaced','raw-race'].includes(mode)?1:0);
      expect(birth.stdout+birth.stderr+cleanup.stdout+cleanup.stderr).not.toContain('PRIVATE');
      const owner=JSON.parse(readFileSync(path.join(dir,'rc-run-secrets.json'),'utf8'));
      const calls=readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);
      const deletes=calls.filter(call=>call[0]==='delete');
      expect(calls.some(call=>['apply','replace','exec'].some(value=>call.includes(value)))).toBe(false);
      if(mode==='collision'){expect(calls.filter(call=>call.includes('create'))).toHaveLength(0);expect(deletes).toHaveLength(0);}
      if(['success','rollout-failed'].includes(mode)){expect(deletes).toHaveLength(2);expect(owner.executor.cleanup).toBe('verified-absent');}
      if(mode==='referenced'){expect(deletes).toHaveLength(0);expect(owner.executor.cleanup).toBe('retained-while-referenced');}
      if(['ack-service','ack-deployment','service-replaced','deployment-replaced'].includes(mode))expect(deletes).toHaveLength(0);
      if(mode==='raw-race')expect(deletes).toHaveLength(1);
      for(const call of deletes)expect(call[call.indexOf('--raw')+1]).toContain('/ns-iknkxtc8/');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});


describe('prior accepted managed run cleanup',()=>{
  it.each(['success','previous-referenced','foreign-uid'])('protects previous run objects in %s',mode=>{
    const parent=path.join(repoRoot,'.test-data/gz-previous-executor');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-'));const bin=path.join(dir,'bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'kubectl'),fakeExecutorKubectl,{mode:0o700});
    const previous={nonce:'old-owner',secrets:[{name:'runtime-old',uid:'runtime-old-uid'},{name:'seed-old',uid:'seed-old-uid'}],
      executor:{name:'xpod-rc-inngest-122-1',deploymentUID:'deployment-old-uid',serviceUID:'service-old-uid',status:'ready'}};
    writeFileSync(path.join(dir,'rc-run-secrets.json'),JSON.stringify({nonce:'new-owner',secrets:[],previous}));
    for(const [kind,name,uid] of [['deployment',previous.executor.name,previous.executor.deploymentUID],['service',previous.executor.name,previous.executor.serviceUID],
      ...previous.secrets.map(secret=>['secret',secret.name,secret.uid])]) {
      writeFileSync(path.join(dir,`${kind}-${name}.json`),JSON.stringify({metadata:{name,uid:mode==='foreign-uid'&&kind==='deployment'?'foreign':uid,annotations:{'xpod.undefineds.co/rc-run-owner':previous.nonce}},
        spec:kind==='deployment'?{containers:[{envFrom:[{secretRef:{name:'runtime-old'}}]}]}:{}}));
    }
    try {
      const result=spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs','cleanup-previous-run'],{cwd:repoRoot,env:{...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP:dir,SEALOS_NAMESPACE:'ns-iknkxtc8',FAKE_EXEC_STATE:dir,FAKE_EXEC_MODE:mode},encoding:'utf8',timeout:10000});
      expect(result.signal).toBeNull();expect(result.status).toBe(mode==='foreign-uid'?1:0);
      const calls=readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);
      expect(calls.filter(call=>call[0]==='delete')).toHaveLength(mode==='success'?4:0);
      if(mode==='success')expect(JSON.parse(readFileSync(path.join(dir,'rc-run-secrets.json'),'utf8')).previous.executor.cleanup).toBe('verified-absent');
      if(mode==='previous-referenced')expect(JSON.parse(readFileSync(path.join(dir,'rc-run-secrets.json'),'utf8')).previous.executor.cleanup).toBe('retained-while-referenced');
      expect(result.stdout+result.stderr).not.toContain('PRIVATE');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('waits for this run executor birth before one guarded app apply and reclaims old objects only after acceptance',async()=>{
    const workflow=await loadWorkflow(),steps=workflow.jobs.deploy_and_accept.steps;
    const index=(name:string)=>steps.findIndex((entry:any)=>entry.name===name);
    expect(index('Create and verify this run owned managed executor')).toBeGreaterThan(index('Create runtime secrets'));
    expect(index('Deploy RC image by digest')).toBeGreaterThan(index('Create and verify this run owned managed executor'));
    expect(steps[index('Deploy RC image by digest')].run).toContain('--run-ownership');
    expect(steps.find((entry:any)=>entry.run?.includes('cleanup-previous-run')).if).toBe('success()');
    expect(steps.find((entry:any)=>entry.run?.includes('cleanup-run-executor')).if).toBe('always()');
  });
});


describe('prepared database write and storage authority regressions',()=>{
  const dsn='postgresql://rc:secret@clone.ns-iknkxtc8.svc:5432/xpod_rc';
  const env={CSS_IDENTITY_DB_URL:dsn,CSS_SPARQL_ENDPOINT:dsn};
  it.each(['host=foreign','port=1234','user=foreign','password=foreign','database=foreign','sslmode=disable'])('rejects pg parser query authority %s',query=>{
    const parsed=new (require('pg').Client)({connectionString:dsn+'?'+query}).connectionParameters;
    if(query==='host=foreign')expect(parsed.host).toBe('foreign');
    if(query==='port=1234')expect(parsed.port).toBe(1234);
    expect(()=>gzHelper().preparedDatabase({...env,CSS_IDENTITY_DB_URL:dsn+'?'+query,CSS_SPARQL_ENDPOINT:dsn+'?'+query})).toThrow();
  });
  it('uses explicit port-forward connection parameters and decodes credentials once',()=>{
    const database=gzHelper().preparedDatabase({...env,CSS_IDENTITY_DB_URL:dsn.replace('secret','s%40cret'),CSS_SPARQL_ENDPOINT:dsn.replace('secret','s%40cret')});
    const options=gzHelper().preparedPgClientOptions(database,'23456');
    expect(options.connectionString).toBeUndefined();
    const params=new (require('pg').Client)(options).connectionParameters;
    expect(params).toMatchObject({host:'127.0.0.1',port:23456,user:'rc',password:'s@cret',database:'xpod_rc'});
  });
  it('binds the actual Task credential write consumer to the admitted clone',async()=>{
    const {resolveTaskCredentialDatabaseUrl}=await import('../../src/api/tasks/TaskCredentialDatabase');
    expect(resolveTaskCredentialDatabaseUrl({configuredUrl:'postgres://rc:secret@foreign/xpod_rc',identityDatabaseUrl:dsn})).toContain('foreign');
    expect(()=>gzHelper().preparedDatabase({...env,CSS_TASK_DB_URL:'postgres://rc:secret@foreign/xpod_rc'})).toThrow();
    expect(()=>gzHelper().preparedDatabase({...env,CSS_TASK_DB_URL:dsn+'?host=foreign'})).toThrow();
    expect(()=>gzHelper().preparedDatabase({...env,CSS_TASK_DB_URL:dsn})).not.toThrow();
  });
  it.each(['emptyDir','hostPath','no-mount','source-pvc','source-pv','old-pvc','unbound','wrong-pv-claim','pgdata-env-ref'])('rejects unprotected data storage %s',mode=>{
    const f=preparedStorageFixture();
    if(mode==='emptyDir')f.pod.spec.volumes=[{name:'data',emptyDir:{}}];
    if(mode==='hostPath')f.pod.spec.volumes=[{name:'data',hostPath:{path:'/data'}}];
    if(mode==='no-mount')f.pod.spec.containers[0].volumeMounts=[];
    if(mode==='source-pvc')f.forbidden.push(f.pvc.metadata.uid);
    if(mode==='old-pvc')f.forbidden.push(f.pvc.metadata.uid);
    if(mode==='unbound')f.pvc.status.phase='Pending';
    if(mode==='wrong-pv-claim')f.pv.spec.claimRef.uid='foreign';
    if(mode==='pgdata-env-ref')f.pod.spec.containers[0].env=[{name:'PGDATA',valueFrom:{configMapKeyRef:{name:'other',key:'path'}}}];
    expect(()=>gzHelper().verifyPreparedStorage(f.pod,[f.pvc],[f.pv],f.forbidden,mode==='source-pv'?[f.pv.metadata.uid]:[])).toThrow();
  });
  it.each(['wrong-port','wrong-target','wrong-pod','not-ready','extra-pod'])('binds the runtime database Service to the actual ready Pod: %s',mode=>{
    const f=preparedStorageFixture();
    if(mode==='wrong-port')f.service.spec.ports[0].port=6432;
    if(mode==='wrong-target')f.service.spec.ports[0].targetPort=6432;
    if(mode==='wrong-pod')f.endpoints.subsets[0].addresses[0].targetRef.uid='foreign';
    if(mode==='not-ready'){f.endpoints.subsets[0].notReadyAddresses=f.endpoints.subsets[0].addresses;f.endpoints.subsets[0].addresses=[];}
    if(mode==='extra-pod')f.endpoints.subsets[0].addresses.push({targetRef:{kind:'Pod',uid:'foreign'}});
    expect(()=>gzHelper().verifyPreparedEndpoints(f.service,f.pod,f.endpoints)).toThrow();
  });
  it.each(['missing','mutable','wrong-source','wrong-pvc','wrong-pv','wrong-image','unclosed-dump','restore-failed','owners-unverified','data-unverified'])('refuses incomplete full restore evidence: %s',mode=>{
    const f=preparedStorageFixture();const admission=structuredClone(f.admission),cm=gzObject('ConfigMap','clone-restore');cm.immutable=true;cm.data={'admission.json':JSON.stringify(admission)};
    if(mode==='missing')cm.data={};if(mode==='mutable')cm.immutable=false;
    if(mode==='wrong-source')admission.source.podUID='foreign';if(mode==='wrong-pvc')admission.target.pvcUID='foreign';
    if(mode==='wrong-pv')admission.target.pvUID='foreign';if(mode==='wrong-image')admission.target.actualImageID='sha256:'+'b'.repeat(64);
    if(mode==='unclosed-dump')admission.dump.rawClosedBeforeHash=false;if(mode==='restore-failed')admission.restore.exit=1;
    if(mode==='owners-unverified')admission.validation.ownersAndACL=false;if(mode==='data-unverified')admission.validation.allUserObjectsAndData=false;
    if(mode!=='missing')cm.data={'admission.json':JSON.stringify(admission)};
    expect(()=>gzHelper().verifyRestoreAdmission(cm,f.workload,f.pod,f.storage,f.source)).toThrow();
  });
  it('admits only a fresh cross-bound restore record, volume and endpoint identity',()=>{
    const f=preparedStorageFixture(),cm=gzObject('ConfigMap','clone-restore');cm.immutable=true;cm.data={'admission.json':JSON.stringify(f.admission)};
    expect(gzHelper().verifyPreparedStorage(f.pod,[f.pvc],[f.pv],f.forbidden)).toEqual(f.storage);
    expect(()=>gzHelper().verifyPreparedEndpoints(f.service,f.pod,f.endpoints)).not.toThrow();
    expect(gzHelper().verifyRestoreAdmission(cm,f.workload,f.pod,f.storage,f.source)).toMatchObject({archive:{sha256:'a'.repeat(64)}});
  });
});
function preparedStorageFixture():any {
  const h=gzHelper(),digest=h.PG_IMAGE.split('@')[1];
  const workload=gzObject('StatefulSet','clone');workload.metadata.annotations={'xpod.undefineds.co/rc-clone-archive-sha256':'a'.repeat(64),'xpod.undefineds.co/rc-clone-restore-admission':'clone-restore'};
  const pod=gzObject('Pod','clone-0',{spec:{containers:[{name:'postgres',image:h.PG_IMAGE,env:[{name:'PGDATA',value:'/var/lib/postgresql/data/pgdata'}],ports:[{name:'postgres',containerPort:5432}],volumeMounts:[{name:'data',mountPath:'/var/lib/postgresql/data'}]}],volumes:[{name:'data',persistentVolumeClaim:{claimName:'clone-data'}}]},status:{containerStatuses:[{name:'postgres',ready:true,imageID:'docker-pullable://'+h.PG_IMAGE}]}});
  const pvc=gzObject('PersistentVolumeClaim','clone-data',{spec:{volumeName:'clone-pv'},status:{phase:'Bound'}});
  const pv={kind:'PersistentVolume',metadata:{name:'clone-pv',uid:'clone-pv-uid',resourceVersion:'1'},spec:{claimRef:{name:'clone-data',namespace:h.GZ_NAMESPACE,uid:pvc.metadata.uid}},status:{phase:'Bound'}};
  const service=gzObject('Service','clone',{spec:{selector:{app:'clone'},ports:[{port:5432,targetPort:'postgres',protocol:'TCP'}]}});
  const endpoints=gzObject('Endpoints','clone',{subsets:[{ports:[{port:5432,protocol:'TCP'}],addresses:[{targetRef:{kind:'Pod',uid:pod.metadata.uid}}]}]});
  const storage={pgdata:'/var/lib/postgresql/data/pgdata',pvcName:pvc.metadata.name,pvcUID:pvc.metadata.uid,pvName:pv.metadata.name,pvUID:pv.metadata.uid};
  const source={service:h.SOURCE_DATABASE,podUID:'source-pod-uid',pvcUIDs:['source-pvc-uid']};
  const closed={exit:0,actualWait:true,rawClosedBeforeHash:true,ownedGroupAbsentAfterWait:true,rawSHA256:'c'.repeat(64)};
  const admission={server:h.GZ_SERVER,namespace:h.GZ_NAMESPACE,source,archive:{bytes:1234,sha256:'a'.repeat(64)},dump:{...closed},restore:{...closed},target:{workloadUID:workload.metadata.uid,podUID:pod.metadata.uid,pvcUID:pvc.metadata.uid,pvUID:pv.metadata.uid,dataDirectory:storage.pgdata,specImage:h.PG_IMAGE,actualImageID:pod.status.containerStatuses[0].imageID,canonicalSourceImage:h.PG_IMAGE},validation:{ownersAndACL:true,allUserObjectsAndData:true,extensionCompatibility:true}};
  return {workload,pod,pvc,pv,service,endpoints,storage,source,admission,forbidden:['source-pvc-uid','old-rc-pvc-uid']};
}


describe('three actual run ownership transitions',()=>{
  it('keeps A after B applies but fails acceptance, then C safely reclaims both identities',()=>{
    const parent=path.join(repoRoot,'.test-data/gz-three-run-history');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-')),bin=path.join(dir,'bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'kubectl'),fakeExecutorKubectl,{mode:0o700});
    const sourceSha=spawnSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).stdout.trim();
    const rc=gzObject('Deployment','xpod-rc');
    const base={...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,RUNNER_TEMP:dir,SEALOS_NAMESPACE:'ns-iknkxtc8',GITHUB_SHA:sourceSha,GITHUB_RUN_ATTEMPT:'1',FAKE_EXEC_STATE:dir,FAKE_EXEC_MODE:'success'};
    writeFileSync(path.join(dir,'gz-rc-prerequisites.json'),JSON.stringify({status:'ok',namespace:'ns-iknkxtc8',sourceSha}));
    const execute=(command:string,id:string)=>spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs',command],{cwd:repoRoot,env:{...base,GITHUB_RUN_ID:id},encoding:'utf8',timeout:45000});
    try {
      for(const id of ['121','122','123']) {
        const record={sourceSha,nonce:`owner-${id}`,secrets:[{name:`runtime-${id}`,uid:`runtime-${id}-uid`},{name:`seed-${id}`,uid:`seed-${id}-uid`}]};
        for(const secret of record.secrets)writeFileSync(path.join(dir,`secret-${secret.name}.json`),JSON.stringify({metadata:{name:secret.name,uid:secret.uid,annotations:{[gzHelper().OWNER]:record.nonce}}}));
        writeFileSync(path.join(dir,'rc-run-secrets.json'),JSON.stringify(record));
        expect(execute('create-run-executor',id).status).toBe(0);
        const born=JSON.parse(readFileSync(path.join(dir,'rc-run-secrets.json'),'utf8'));
        // This is the exact projection used by the final manifest renderer; each app apply persists it.
        rc.metadata.annotations={[gzHelper().OWNER]:born.nonce,[gzHelper().OWNERSHIP]:JSON.stringify(gzHelper().ownershipForDeployment(born))};
        rc.spec={template:{spec:{containers:[{env:[{name:'XPOD_INNGEST_BASE_URL',value:`http://${born.executor.name}:8288`}],envFrom:[{secretRef:{name:record.secrets[0].name}}]}],volumes:[{secret:{secretName:record.secrets[1].name}}]}}};
        writeFileSync(path.join(dir,'deployment-xpod-rc.json'),JSON.stringify(rc));
        if(id==='122') { // failed acceptance cleanup must preserve the now referenced B and earlier A.
          expect(execute('cleanup-run-executor',id).status).toBe(0);
          expect(readFileSync(path.join(dir,'deployment-xpod-rc-inngest-121-1.json'),'utf8')).toContain('owner-121');
        }
      }
      const retained=JSON.parse(rc.metadata.annotations[gzHelper().OWNERSHIP]);
      expect(retained.previous.nonce).toBe('owner-122');expect(retained.previous.previous.nonce).toBe('owner-121');
      expect(execute('cleanup-previous-run','123').status).toBe(0);
      const calls=readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);
      expect(calls.filter(call=>call[0]==='delete')).toHaveLength(8);
      for(const id of ['121','122'])for(const file of [`deployment-xpod-rc-inngest-${id}-1`,`service-xpod-rc-inngest-${id}-1`,`secret-runtime-${id}`,`secret-seed-${id}`])expect(()=>readFileSync(path.join(dir,file+'.json'))).toThrow();
      expect(readFileSync(path.join(dir,'deployment-xpod-rc-inngest-123-1.json'),'utf8')).toContain('owner-123');
      expect(readFileSync(path.join(dir,'secret-runtime-123.json'),'utf8')).toContain('owner-123');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

describe('reclaimed run ownership convergence',()=>{
  it('carries only unreclaimed history across repeated successes and a failed acceptance',()=>{
    const parent=path.join(repoRoot,'.test-data/gz-pruned-run-history');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-')),bin=path.join(dir,'bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'kubectl'),fakeExecutorKubectl,{mode:0o700});
    const sourceSha=spawnSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).stdout.trim();
    const rc=gzObject('Deployment','xpod-rc');
    const base={...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,RUNNER_TEMP:dir,SEALOS_NAMESPACE:'ns-iknkxtc8',GITHUB_SHA:sourceSha,GITHUB_RUN_ATTEMPT:'1',FAKE_EXEC_STATE:dir,FAKE_EXEC_MODE:'success'};
    writeFileSync(path.join(dir,'gz-rc-prerequisites.json'),JSON.stringify({status:'ok',namespace:'ns-iknkxtc8',sourceSha}));
    const execute=(command:string,id:string)=>spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs',command],{cwd:repoRoot,env:{...base,GITHUB_RUN_ID:id},encoding:'utf8',timeout:45000});
    const depth=(record:any):number=>record?1+depth(record.previous):0;
    try {
      for(const id of ['201','202','203','204','205','206']) {
        const record={sourceSha,nonce:`owner-${id}`,secrets:[{name:`runtime-${id}`,uid:`runtime-${id}-uid`},{name:`seed-${id}`,uid:`seed-${id}-uid`}]};
        for(const secret of record.secrets)writeFileSync(path.join(dir,`secret-${secret.name}.json`),JSON.stringify({metadata:{name:secret.name,uid:secret.uid,annotations:{[gzHelper().OWNER]:record.nonce}}}));
        writeFileSync(path.join(dir,'rc-run-secrets.json'),JSON.stringify(record));
        expect(execute('create-run-executor',id).status).toBe(0);
        const born=JSON.parse(readFileSync(path.join(dir,'rc-run-secrets.json'),'utf8'));
        // 203 remains published but fails acceptance; the next run must retain it and 202.
        expect(depth(born.previous)).toBe(id==='201'?0:id==='204'?2:1);
        rc.metadata.annotations={[gzHelper().OWNER]:born.nonce,[gzHelper().OWNERSHIP]:JSON.stringify(gzHelper().ownershipForDeployment(born))};
        rc.spec={template:{spec:{containers:[{env:[{name:'XPOD_INNGEST_BASE_URL',value:`http://${born.executor.name}:8288`}],envFrom:[{secretRef:{name:record.secrets[0].name}}]}],volumes:[{secret:{secretName:record.secrets[1].name}}]}}};
        writeFileSync(path.join(dir,'deployment-xpod-rc.json'),JSON.stringify(rc));
        if(id==='203') {
          expect(execute('cleanup-run-executor',id).status).toBe(0);
          expect(readFileSync(path.join(dir,'deployment-xpod-rc-inngest-202-1.json'),'utf8')).toContain('owner-202');
        } else expect(execute('cleanup-previous-run',id).status).toBe(0);
      }
      expect(depth(JSON.parse(rc.metadata.annotations[gzHelper().OWNERSHIP]))).toBe(2);
      expect(readFileSync(path.join(dir,'deployment-xpod-rc-inngest-206-1.json'),'utf8')).toContain('owner-206');
    } finally {rmSync(dir,{recursive:true,force:true});}
  },120000);
});


describe('unresolved ownership history retention',()=>{
  it.each(['present','foreign','unknown-uid','history-read-error'])('retains or refuses uncertain predecessor reads: %s',mode=>{
    const parent=path.join(repoRoot,'.test-data/gz-history-uncertain');mkdirSync(parent,{recursive:true});
    const dir=mkdtempSync(path.join(parent,'case-')),bin=path.join(dir,'bin');mkdirSync(bin);
    writeFileSync(path.join(bin,'kubectl'),fakeExecutorKubectl,{mode:0o700});
    const sourceSha=spawnSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).stdout.trim();
    const previous={nonce:'old-owner',secrets:[{name:'runtime-old',uid:'runtime-old-uid'}],executor:{name:'xpod-rc-inngest-200-1',status:'ready',deploymentUID:'old-deploy-uid',serviceUID:'old-service-uid'}};
    const rc=gzObject('Deployment','xpod-rc');rc.metadata.annotations={[gzHelper().OWNER]:previous.nonce,[gzHelper().OWNERSHIP]:JSON.stringify(previous)};
    writeFileSync(path.join(dir,'deployment-xpod-rc.json'),JSON.stringify(rc));
    if(mode!=='history-read-error')writeFileSync(path.join(dir,'secret-runtime-old.json'),JSON.stringify({metadata:mode==='unknown-uid'?{name:'runtime-old'}:{uid:mode==='foreign'?'foreign-uid':'runtime-old-uid'}}));
    writeFileSync(path.join(dir,'gz-rc-prerequisites.json'),JSON.stringify({status:'ok',namespace:'ns-iknkxtc8',sourceSha}));
    writeFileSync(path.join(dir,'rc-run-secrets.json'),JSON.stringify({sourceSha,nonce:'new-owner',secrets:[{name:'runtime-new',uid:'new-runtime-uid'},{name:'seed-new',uid:'new-seed-uid'}]}));
    try{
      const result=spawnSync('bun',['scripts/verify-gz-rc-prerequisites.cjs','create-run-executor'],{cwd:repoRoot,env:{...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,RUNNER_TEMP:dir,SEALOS_NAMESPACE:'ns-iknkxtc8',GITHUB_SHA:sourceSha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',FAKE_EXEC_STATE:dir,FAKE_EXEC_MODE:mode},encoding:'utf8',timeout:45000});
      const calls=readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);
      expect(calls.some(call=>call[0]==='delete')).toBe(false);
      if(mode==='history-read-error'){expect(result.status).not.toBe(0);expect(calls.some(call=>call.includes('create'))).toBe(false);}
      else{expect(result.status).toBe(0);expect(JSON.parse(readFileSync(path.join(dir,'rc-run-secrets.json'),'utf8')).previous.nonce).toBe('old-owner');}
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
