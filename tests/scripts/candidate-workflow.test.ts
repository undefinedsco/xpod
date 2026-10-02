import { readFile } from 'node:fs/promises';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
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

/**
 * Runs an extracted workflow cleanup region against a stubbed kubectl so the
 * real DROP-verification, ownership, and failure-preservation behavior is
 * exercised, not merely string-matched.
 */
type StubMode =
  | 'ok'
  | 'drop-command-fail'
  | 'drop-not-removed'
  | 'probe-command-fail'
  | 'create-fail'
  | 'workdir-remove-fail'
  | 'identity-ok';

function runCleanupScript(
  region: string,
  body: string,
  stubMode: StubMode,
  logPath?: string,
): SpawnSyncReturns<string> {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'xpod-native-db-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const kubectlStub = path.join(bin, 'kubectl');
  writeFileSync(kubectlStub, `#!/usr/bin/env bash
if [ -n "\${STUB_LOG:-}" ]; then printf '%s\\n' "$*" >> "$STUB_LOG"; fi
case "\${STUB_MODE:-ok}" in
  drop-command-fail)
    if [[ "$*" == *"DROP DATABASE"* ]]; then exit 1; fi
    exit 0
    ;;
  drop-not-removed)
    if [[ "$*" == *"DROP DATABASE"* ]]; then exit 0; fi
    if [[ "$*" == *"pg_database"* ]]; then printf '1\\n'; exit 0; fi
    exit 0
    ;;
  probe-command-fail)
    if [[ "$*" == *"DROP DATABASE"* ]]; then exit 0; fi
    if [[ "$*" == *"pg_database"* ]]; then exit 3; fi
    exit 0
    ;;
  create-fail)
    if [[ "$*" == *"CREATE DATABASE"* ]]; then exit 1; fi
    exit 0
    ;;
  workdir-remove-fail)
    if [[ "$*" == *"rm -rf"* ]]; then exit 1; fi
    exit 0
    ;;
  identity-ok)
    if [[ "$*" == *"metadata.uid"* ]]; then
      if [[ "$*" == *"xpod-rc-postgres-0"* ]]; then printf 'uid-db'; else printf 'uid-a'; fi
      exit 0
    fi
    if [[ "$*" == *"imageID"* ]]; then
      if [[ "$*" == *"xpod-rc-postgres-0"* ]]; then printf 'img-db'; else printf 'img-a'; fi
      exit 0
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
  chmodSync(kubectlStub, 0o755);
  const script = `set -euo pipefail
export SEALOS_NAMESPACE=xpod-rc
export STUB_MODE=${stubMode}
export STUB_LOG=${logPath ?? ''}
pod_name=xpod-rc-test-pod
container_work_dir=/tmp/xpod-rc-native-probe
native_db=xpod_rc_native_probe
${region}
${body}
`;
  try {
    return spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function nativeCleanupRegion(run: string): string {
  const start = run.indexOf('native_db_owned=0');
  const marker = 'trap cleanup_native_conformance EXIT';
  const end = run.indexOf(marker, start) + marker.length;
  return run.slice(start, end);
}

function nativeStepRun(workflow: Workflow): string {
  return workflow.jobs.deploy_and_accept.steps.find((step: any) =>
    step.name === 'Verify native RC database QLever SQL ABI against the exact candidate').run;
}

/**
 * Runs the real credential-install region of the immutable preflight step with
 * stubbed kubectl/docker/bun, so fetch/decode/parse/install/image-gate failures
 * are exercised against the actual workflow shell, not merely string-matched.
 * Returns whether the owned 0700 credential directory survived the run.
 */
function runCredentialGate(
  gateRun: string,
  scenario: {
    secretJson?: string;
    rawKubectlOutput?: string;
    dockerExit?: number;
    bunExit?: number;
    kubectlExit?: number;
    existingGhcrConfig?: string;
    existingGhcrConfigAsDirectory?: boolean;
  },
): { result: SpawnSyncReturns<string>; dirExists: boolean } {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'xpod-tcr-gate-'));
  const bin = path.join(temp, 'bin');
  mkdirSync(bin);
  const home = path.join(temp, 'home');
  mkdirSync(path.join(home, '.docker'), { recursive: true });
  const existingConfigPath = path.join(home, '.docker', 'config.json');
  if (scenario.existingGhcrConfigAsDirectory) {
    mkdirSync(existingConfigPath, { recursive: true });
  } else {
    writeFileSync(existingConfigPath, scenario.existingGhcrConfig ?? JSON.stringify({
      auths: { 'ghcr.io': { auth: 'ghcr-token' } },
    }));
  }
  const secretJson = scenario.secretJson ?? JSON.stringify({
    auths: { 'ccr.ccs.tencentyun.com': { auth: 'tcr-token' } },
  });
  const payload = scenario.rawKubectlOutput ?? Buffer.from(secretJson, 'utf8').toString('base64');
  const payloadFile = path.join(temp, 'kubectl.out');
  writeFileSync(payloadFile, payload);
  writeFileSync(path.join(bin, 'kubectl'), `#!/usr/bin/env bash
if [ "\${KUBECTL_EXIT:-0}" != "0" ]; then exit "\${KUBECTL_EXIT}"; fi
cat "${payloadFile}"
`);
  writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit "${DOCKER_EXIT:-0}"\n');
  writeFileSync(path.join(bin, 'bun'), '#!/usr/bin/env bash\nexit "${BUN_EXIT:-0}"\n');
  for (const name of [ 'kubectl', 'docker', 'bun' ]) chmodSync(path.join(bin, name), 0o755);
  // The workflow text carries ${{ needs.build_image.outputs.digest }}, which is
  // not valid bash; substitute a literal immutable digest placeholder.
  const runnable = gateRun.replace(
    /\$\{\{ needs\.build_image\.outputs\.digest \}\}/g,
    `sha256:${'0'.repeat(64)}`,
  );
  const runnerTemp = path.join(temp, 'runner');
  mkdirSync(runnerTemp, { recursive: true });
  const script = `set -euo pipefail
export SEALOS_NAMESPACE=xpod-rc
export HOME=${home}
export RUNNER_TEMP=${runnerTemp}
${runnable}
`;
  const dirPath = path.join(runnerTemp, 'tcr-preflight-docker-config');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      KUBECTL_EXIT: String(scenario.kubectlExit ?? 0),
      DOCKER_EXIT: String(scenario.dockerExit ?? 0),
      BUN_EXIT: String(scenario.bunExit ?? 0),
    },
  });
  const dirExists = existsSync(dirPath);
  rmSync(temp, { recursive: true, force: true });
  return { result, dirExists };
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
    expect(runText).toContain('id-rc.undefineds.co');
    expect(runText).toContain('pods-rc.undefineds.co');
    expect(runText).toContain('api-rc.undefineds.co');
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
    expect(runText).toContain('node scripts/render-rc-manifests.cjs');
    expect(runText).toContain('--overlay deploy/sealos/rc-postgres');
    expect(runText).toContain('kubectl apply -f "$postgres_manifest"');
    expect(runText).toContain('kubectl apply -f "$rendered_manifest"');
    expect(runText.match(/kubectl apply -f \"\$rendered_manifest\"/g)).toHaveLength(1);
    expect(runText).toContain('SEALOS_NAMESPACE is required');
    expect(runText).toContain('XPOD_RUNTIME_SECRET_NAME is required');
    expect(runText).toContain('must be a valid Kubernetes name');
    expect(runText).not.toContain('SEALOS_NAMESPACE: xpod-rc');
    expect(runText).not.toContain('xpod-rc-secret \\');
    expect(runText).toContain('ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}');
    expect(runText).toContain('--image "ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}"');
    expect(runText).toContain('--seed-secret-name "$XPOD_RC_SEED_SECRET_NAME"');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" create secret generic "$XPOD_RUNTIME_SECRET_NAME"');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" create secret generic xpod-rc-postgres-secret');
    expect(runText).not.toContain('kubectl -n "$SEALOS_NAMESPACE" patch deployment/xpod-rc');
    expect(runText).not.toContain('kubectl -n "$SEALOS_NAMESPACE" set image deployment/xpod-rc');
    expect(runText).not.toContain('kubectl -n "$SEALOS_NAMESPACE" rollout restart deployment/xpod-rc');
    expect(runText).toContain('kubectl rollout status deployment/xpod-rc');
    expect(runText).toContain('kubectl rollout status statefulset/xpod-rc-postgres');
    expect(runText).toContain("SHOW server_version_num");
    expect(runText).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(runText).toContain("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    expect(runText).toContain('delete deployment/xpod-rc --cascade=foreground --wait=true --ignore-not-found');
    expect(runText).toContain('delete statefulset/xpod-rc-postgres --cascade=foreground --wait=true --ignore-not-found');
    expect(runText).toContain('delete pvc/data-xpod-rc-postgres-0 --ignore-not-found');
    expect(runText).not.toContain('delete pvc -l');
    expect(runText.indexOf('delete deployment/xpod-rc --cascade=foreground --wait=true --ignore-not-found'))
      .toBeLessThan(runText.indexOf('delete statefulset/xpod-rc-postgres'));
    expect(runText.indexOf('kubectl apply -f "$postgres_manifest"'))
      .toBeLessThan(runText.indexOf('kubectl apply -f "$rendered_manifest"'));
    expect(runText).not.toContain('kubectl rollout status deployment/xpod-inngest');
    expect(runText).toContain('node scripts/update-gateway-rc-configmap.cjs');
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

    expect(runText).toContain("['CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT'].includes(key)");
    expect(runText).toContain('identity_db_url="postgresql://xpod_rc:${pg_password}@${pg_host}:5432/xpod_rc"');
    expect(runText).toContain('sparql_endpoint="postgresql://xpod_rc:${pg_password}@${pg_host}:5432/xpod_rc"');
    expect(runText).toContain('pg_password="$(openssl rand -hex 32)"');
    expect(runText).toContain('echo "::add-mask::$pg_password"');
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
    expect(runText).toContain('delete deployment/xpod-rc-minio service/xpod-rc-minio job/xpod-rc-minio-init pvc/xpod-rc-minio secret/xpod-rc-object-store --ignore-not-found');
    expect(runText).not.toContain('create secret generic xpod-rc-object-store');
    expect(runText).not.toContain('rollout status deployment/xpod-rc-minio');
    expect(runText).toContain('XPOD_INNGEST_EVENT_KEY');
    expect(runText).toContain('XPOD_INNGEST_SIGNING_KEY');
    expect(runText).toContain('XPOD_GATEWAY_LOCATOR_SECRET');
    expect(runText).toContain('--from-literal=POSTGRES_DB=xpod_rc');
    expect(runText).toContain('--from-literal=POSTGRES_USER=xpod_rc');
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
    expect(deploy.env.XPOD_SETTINGS_E2E_BASE_URL).toBe('https://id-rc.undefineds.co');
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
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" create secret generic "$XPOD_RC_SEED_SECRET_NAME"');
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
    expect(runText).toContain('--env SOLID_OIDC_ISSUER=https://id-rc.undefineds.co/');
    expect(runText).toContain('docker port "$local_name" 5737/tcp');
    expect(runText).not.toContain('port-forward deployment/xpod-rc 3000:3000');
    expect(runText).toContain('XPOD_LIVE_PROVIDER_KEY_FILE="$provider_file"');
    expect(runText).toContain('XPOD_LIVE_GATEWAY_URL="$gateway"');
    expect(runText).toContain('XPOD_LIVE_CLOUD_IDP="https://id-rc.undefineds.co/"');
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
      'postgres-ephemeral',
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
    expect(finalizeText).not.toContain('npm');
    expect(finalUpload.with.name).toBe('release-acceptance-${{ github.sha }}');
    expect(finalUpload.with.path).toBe('${{ runner.temp }}/release-acceptance.json');

    const diagnostics = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Dump diagnostics');
    expect(diagnostics.if).toBe('failure()');
    expect(diagnostics.run).toContain('kubectl -n "$SEALOS_NAMESPACE" get');
    expect(diagnostics.run).toContain('describe deployment xpod-rc');
    expect(diagnostics.run).toContain('describe statefulset xpod-rc-postgres');
    expect(diagnostics.run).toContain('app=xpod-rc-postgres');
    expect(diagnostics.run).toContain('--previous');
    expect(diagnostics.run).toContain('live-gateway-local-container-name');
    expect(diagnostics.run).toContain('docker inspect "$local_name"');
    expect(diagnostics.run).toContain('docker logs "$local_name"');
    const cleanup = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Scale RC deployments to zero');
    expect(cleanup.if).toContain('always()');
    expect(cleanup.if).toContain("vars.XPOD_RC_SCALE_TO_ZERO == 'true'");
    expect(cleanup.run).toContain('kubectl -n "$SEALOS_NAMESPACE" scale deployment/xpod-rc --replicas=0');
    expect(cleanup.run).toContain('scale statefulset/xpod-rc-postgres --replicas=0');
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

  it('bootstraps and gates the native RC QLever SQL ABI against the exact candidate', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');
    const nativeStep = workflow.jobs.deploy_and_accept.steps.find((step: any) =>
      step.name === 'Verify native RC database QLever SQL ABI against the exact candidate');

    expect(nativeStep).toBeDefined();
    // Bootstrap the same extensions the private RC image provisions, then fail closed on ABI/ready.
    expect(runText).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(runText).toContain('CREATE EXTENSION IF NOT EXISTS xpod_rdf');
    expect(runText).toContain('CREATE EXTENSION IF NOT EXISTS xpod_qlever');
    expect(runText).toContain('xpod_rdf.native_sparql_capabilities()');
    expect(runText).toContain('caps.abiVersion!==1||caps.ready!==true');
    // The authority schema is created by the installed runner's own
    // PostgresRdfEngine.initialize; the workflow must not copy DDL or probe for
    // public.rdf_quads before that runner has initialized its own temp database.
    expect(runText).not.toContain('xpod_qlever_prepare_physical_schema()');
    expect(runText).not.toContain("to_regclass('public.rdf_quads')");
    // Bind the gate to the exact candidate image and the pinned public fixture contract.
    expect(nativeStep.run).toContain('${{ needs.build_image.outputs.digest }}');
    expect(nativeStep.run).toContain('597dc09c9b252541e35483cf9d34461a410d4a747808f917948671bd81890e6a');
    expect(nativeStep.run).toContain('sha256sum qlever/tests/fixtures/qlever-semantic-conformance.cjs');
    expect(nativeStep.run).toContain('native conformance runner does not match the source tree');
    expect(nativeStep.run).toContain('dist/acceptance/run-installed-qlever-conformance.js');
    // The fixture is injected temporarily into a unique 0700 in-container
    // directory, never baked into the image and never at a fixed shared path.
    expect(nativeStep.run).toContain('fs.chmodSync(dir,0o700)');
    expect(nativeStep.run).toContain("dir+'/qlever-semantic-conformance.cjs'");
    expect(nativeStep.run).toContain("XPOD_QLEVER_CONFORMANCE_BACKEND='pg'");
    expect(nativeStep.run).toContain("+'/pg-installed-conformance.json'");
    expect(nativeStep.run).toContain('remove_container_work_dir');
    expect(nativeStep.run).not.toContain('/tmp/qlever-semantic-conformance.cjs');
    expect(nativeStep.run).not.toMatch(/\bsh\s+-c|\bbash\s+-c/);
    // The in-container product seam runs on the shipped Bun runtime, not a Node fallback.
    expect(nativeStep.run).toContain('bun -e');
    expect(nativeStep.run).toContain('bun -e "if(!process.env.CSS_SPARQL_ENDPOINT)');
    expect(nativeStep.run).not.toContain('-- node -e');
    // The DSN is derived inside the container from the authoritative endpoint, never duplicated.
    expect(nativeStep.run).toContain("url.pathname='/'+process.env.XPOD_RC_NATIVE_DATABASE");
    expect(runText).not.toMatch(/-e\s+XPOD_QLEVER_PG_DSN=/);
    expect(runText).not.toContain('--from-literal=XPOD_QLEVER_PG_DSN');
    // Capabilities and both imageIDs belong to the separate source-bound evidence file.
    expect(nativeStep.run).toContain('native-conformance-evidence.json');
    expect(nativeStep.run).toContain('serviceImageId');
    expect(nativeStep.run).toContain('postgresImageId');
    expect(runText).toContain('postgres-image-id');
    expect(runText).toContain('de247beacf40af59a9e209e02cf257b0bdb33d9f47a7f77e4eb379635a2488ba');
    expect(runText).toContain('native-sql-abi1');
    // Never print secrets or DSNs.
    expect(nativeStep.run).not.toContain('::add-mask::');
    expect(nativeStep.run).not.toMatch(/echo\s+["']?\$?(?:XPOD_QLEVER_PG_DSN|CSS_SPARQL_ENDPOINT)/);
    expect(nativeStep.run).not.toContain('cat "$CSS_SPARQL_ENDPOINT"');
  });

  it('isolates the public16 native gate in a unique owned database and drops it even on failure', async () => {
    const workflow = await loadWorkflow();
    const run = nativeStepRun(workflow);

    // The RC business database must never be the conformance target.
    expect(run).toContain('native_db="xpod_rc_native_${run_slug}"');
    expect(run).toContain('"$native_db" = "xpod_rc"');
    expect(run).toContain("CREATE DATABASE ${native_db} TEMPLATE template0");
    expect(run).toContain('CREATE EXTENSION IF NOT EXISTS xpod_rdf');
    expect(run).toContain('CREATE EXTENSION IF NOT EXISTS xpod_qlever');
    expect(run).toContain('trap cleanup_native_conformance EXIT');
    expect(run).toContain("DROP DATABASE IF EXISTS ${native_db} WITH (FORCE)");
    // The DROP is verified through pg_database, never silently ignored, and the
    // existence probe checks its own exit so an empty/failed probe is not absent.
    expect(run).toContain("SELECT 1 FROM pg_database WHERE datname = '${native_db}'");
    expect(run).toContain('if ! probe_output=');
    expect(run).toContain('the existence probe command failed');
    expect(run).toContain('native_db_owned=0');
    expect(run).toContain('native_db_owned=1');
    expect(run).toContain('if ! drop_native_db; then');
    // Ownership must be claimed only after CREATE DATABASE succeeded.
    expect(run.indexOf("CREATE DATABASE ${native_db} TEMPLATE template0"))
      .toBeLessThan(run.indexOf('native_db_owned=1'));
    // The isolation must happen on the same exact StatefulSet, not a second cluster.
    expect(run).toContain('exec statefulset/xpod-rc-postgres');
    expect(run).not.toContain('xpod_rc_native_${run_slug} --command');
    // A unique per-run, per-attempt, 0700 in-container work directory holds the
    // fixture and report; no fixed shared /tmp path.
    expect(run).toContain('container_work_dir="/tmp/xpod-rc-native-${run_slug}"');
    expect(run).toContain('fs.chmodSync(dir,0o700)');
    expect(run).toContain('remove_container_work_dir');
    expect(run).not.toContain('/tmp/qlever-semantic-conformance.cjs');
    expect(run).not.toContain("'/tmp/pg-installed-conformance.json'");
    // Before/after identity binding for both Pods.
    expect(run).toContain('service_pod_uid=');
    expect(run).toContain('postgres_pod_uid=');
    expect(run).toContain('assert_rc_identity_unchanged');
    expect(run).toContain('servicePodUid');
    expect(run).toContain('postgresPodUid');
  });

  it('fails the step when the normal temp database DROP does not actually remove it', async () => {
    const workflow = await loadWorkflow();
    const region = nativeCleanupRegion(nativeStepRun(workflow));
    const normalCleanup = [
      'native_db_owned=1',
      'if ! drop_native_db; then',
      '  exit 1',
      'fi',
      'native_db_owned=0',
      'trap - EXIT',
      'echo NORMAL_CLEANUP_OK',
    ].join('\n');

    // The command succeeded but the database is still present: verification fails the step.
    const notRemoved = runCleanupScript(region, normalCleanup, 'drop-not-removed');
    expect(notRemoved.status, notRemoved.stderr).not.toBe(0);
    expect(notRemoved.stdout).not.toContain('NORMAL_CLEANUP_OK');
    expect(notRemoved.stdout).toContain('failed to drop owned native conformance database');

    // The DROP command itself failed: the step must also fail.
    const commandFailed = runCleanupScript(region, normalCleanup, 'drop-command-fail');
    expect(commandFailed.status, commandFailed.stderr).not.toBe(0);
    expect(commandFailed.stdout).toContain('failed to drop owned native conformance database');

    // The existence probe command itself failed: empty output must never be
    // treated as "absent", so the step still fails.
    const probeFailed = runCleanupScript(region, normalCleanup, 'probe-command-fail');
    expect(probeFailed.status, probeFailed.stderr).not.toBe(0);
    expect(probeFailed.stdout).not.toContain('NORMAL_CLEANUP_OK');
    expect(probeFailed.stdout).toContain('the existence probe command failed');

    // The happy path still succeeds.
    const ok = runCleanupScript(region, normalCleanup, 'ok');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('NORMAL_CLEANUP_OK');
  });

  it('never drops a temp database this run did not create', async () => {
    const workflow = await loadWorkflow();
    const region = nativeCleanupRegion(nativeStepRun(workflow));
    const temp = mkdtempSync(path.join(os.tmpdir(), 'xpod-native-create-'));
    const log = path.join(temp, 'kubectl-argv.log');
    try {
      // CREATE DATABASE fails under set -e; ownership stays 0 so the trap must
      // not attempt a DROP of a same-named database this run never created.
      const body = [
        'kubectl -n "$SEALOS_NAMESPACE" exec statefulset/xpod-rc-postgres -- \\',
        '  psql -U xpod_rc -d xpod_rc -v ON_ERROR_STOP=1 \\',
        '    --command "CREATE DATABASE ${native_db} TEMPLATE template0"',
        'echo SHOULD_NOT_REACH',
      ].join('\n');
      const result = runCleanupScript(region, body, 'create-fail', log);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stdout).not.toContain('SHOULD_NOT_REACH');
      const argv = readFileSync(log, 'utf8');
      expect(argv).toContain('CREATE DATABASE');
      expect(argv).not.toContain('DROP DATABASE');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('preserves the original failure exit when temp database cleanup also fails', async () => {
    const workflow = await loadWorkflow();
    const region = nativeCleanupRegion(nativeStepRun(workflow));
    const priorFailure = 'native_db_owned=1\nexit 42';

    const result = runCleanupScript(region, priorFailure, 'drop-command-fail');
    // The earlier failure status is preserved even though cleanup failed.
    expect(result.status).toBe(42);
    expect(result.stdout).toContain('cleanup failed after an earlier failure');
    expect(result.stdout).toContain('original exit status 42 preserved');
  });

  it('fails the step when the temporary in-container directory is not verified removed', async () => {
    const workflow = await loadWorkflow();
    const region = nativeCleanupRegion(nativeStepRun(workflow));
    const body = [
      'container_work_dir_created=1',
      'if ! remove_container_work_dir; then',
      '  echo TEMP_CLEANUP_FAILED',
      '  exit 1',
      'fi',
      'echo SHOULD_NOT_REACH',
    ].join('\n');
    const result = runCleanupScript(region, body, 'workdir-remove-fail');
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).toContain('TEMP_CLEANUP_FAILED');
    expect(result.stdout).not.toContain('SHOULD_NOT_REACH');
    expect(result.stdout).toContain('failed to remove temporary in-container conformance directory');
  });

  it('fails the native sample when a Pod identity changes', async () => {
    const workflow = await loadWorkflow();
    const region = nativeCleanupRegion(nativeStepRun(workflow));
    const body = [
      'service_pod_uid=uid-a',
      'service_image_id=img-a',
      'postgres_pod_uid=uid-db',
      'postgres_image_id=img-db',
      'if ! assert_rc_identity_unchanged; then',
      '  echo IDENTITY_CHANGED',
      '  exit 1',
      'fi',
      'echo IDENTITY_OK',
    ].join('\n');

    // Default stub returns empty UID/imageID, so the identity check fails.
    const changed = runCleanupScript(region, body, 'ok');
    expect(changed.status, changed.stderr).not.toBe(0);
    expect(changed.stdout).toContain('IDENTITY_CHANGED');
    expect(changed.stdout).not.toContain('IDENTITY_OK');

    // Matching identities pass.
    const unchanged = runCleanupScript(region, body, 'identity-ok');
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain('IDENTITY_OK');
  });

  it('keeps the promotion checks schema strict with only "passed" summary values', async () => {
    const workflow = await loadWorkflow();
    const runText = jobRunText(workflow, 'deploy_and_accept');

    // Detailed hashes/capabilities/object values must not leak into the promotion checks.
    expect(runText).not.toContain('"fixture-hash"');
    expect(runText).not.toContain("'native-capabilities':");
    expect(runText).not.toContain("'service-image-id':");

    const start = runText.indexOf('deployment-checks.json');
    const heredocStart = runText.indexOf("<<'JSON'", start);
    const terminator = runText.indexOf('\nJSON', heredocStart);
    const deploymentBlock = runText.slice(heredocStart, terminator);
    const values = [...deploymentBlock.matchAll(/"[^"]+":\s*"([^"]*)"/g)].map((match) => match[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toBe('passed');

    expect(runText).toContain("'native-sql-abi1': 'passed'");
    expect(runText).toContain("'native-qlever-pg-conformance': 'passed'");
    expect(runText).toContain('native-conformance-checks.json');
  });

  it('runs both mandatory predeployment preflights before runtime secrets or RC mutation', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs.deploy_and_accept.steps;
    const stepNames = steps.map((step: any) => step.name);
    const immutableGate = steps.find((step: any) => step.name === 'Preflight immutable native images before any RC mutation');
    const namespaceGate = steps.find((step: any) => step.name === 'Preflight exact PostgreSQL image pull in the assigned namespace');
    const createSecrets = stepNames.indexOf('Create runtime secrets');
    const deployImage = stepNames.indexOf('Deploy RC image by digest');

    expect(immutableGate).toBeDefined();
    expect(namespaceGate).toBeDefined();
    expect(createSecrets).toBeGreaterThanOrEqual(0);
    expect(stepNames.indexOf(immutableGate.name)).toBeLessThan(createSecrets);
    expect(stepNames.indexOf(namespaceGate.name)).toBeLessThan(createSecrets);
    expect(createSecrets).toBeLessThan(deployImage);

    // Immutable image gate: exact candidate + PG digests, existing GHCR login
    // preserved, tcr-creds filtered to ccr.ccs.tencentyun.com only.
    expect(immutableGate.run).toContain('bun scripts/check-qlever-installed-image-conformance.ts');
    expect(immutableGate.run).toContain('--installed-image "ghcr.io/undefinedsco/xpod@${{ needs.build_image.outputs.digest }}"');
    expect(immutableGate.run).toContain('ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:de247beacf40af59a9e209e02cf257b0bdb33d9f47a7f77e4eb379635a2488ba');
    expect(immutableGate.run).toContain('get secret tcr-creds');
    expect(immutableGate.run).toContain("config.auths['ccr.ccs.tencentyun.com']");
    expect(immutableGate.run).toContain("path.join(process.env.HOME || '/root', '.docker', 'config.json')");
    expect(immutableGate.run).toContain('rm -rf "$docker_config_dir"');
    expect(immutableGate.run).not.toMatch(/echo\s+["']?\$?(?:TCR_AUTH|dockerconfigjson)/i);
    // Before the first secret read: umask + owned dir + EXIT cleanup trap.
    expect(immutableGate.run.indexOf('umask 077')).toBeGreaterThanOrEqual(0);
    expect(immutableGate.run.indexOf('umask 077'))
      .toBeLessThan(immutableGate.run.indexOf('get secret tcr-creds'));
    expect(immutableGate.run.indexOf('trap cleanup_docker_config EXIT'))
      .toBeLessThan(immutableGate.run.indexOf('get secret tcr-creds'));
    // No raw secret or all-registry docker config disk intermediate.
    expect(immutableGate.run).not.toContain('tcr_auth_file');
    expect(immutableGate.run).not.toContain('base64 --decode >');
    expect(immutableGate.run).not.toContain('config.auths = config.auths');
    // The parser consumes the secret from stdin, never from a file argument.
    expect(immutableGate.run).toContain("fs.readFileSync(0, 'utf8')");
    expect(immutableGate.run).toContain('node -e "$tcr_config_parser"');

    // Namespace-local gate: exact PG digest via the existing tcr-creds secret,
    // owned Job applied and cleaned up without touching the RC data volume.
    expect(namespaceGate.run).toContain('apply -f deploy/sealos/rc-postgres/pull-preflight.yaml');
    expect(namespaceGate.run).toContain('Complete=True');
    expect(namespaceGate.run).toContain('Failed=True');
    // A stale Complete=True Job must never be reused, and a delete failure must
    // hard stop rather than fall through to a stale result.
    expect(namespaceGate.run).toContain('delete job "$job_name" --ignore-not-found --wait=true');
    expect(namespaceGate.run).toContain('refusing to reuse stale results');
    expect(namespaceGate.run).not.toMatch(/delete job "\$job_name"[^\n]*\|\|\s*true/);
    expect(namespaceGate.run).toContain('job_uid');
    expect(namespaceGate.run).toContain('was replaced while running');
    expect(namespaceGate.run).not.toContain('delete pvc');
  });

  it('forces a real kubelet auth pull for the exact PostgreSQL preflight image', async () => {
    const workflow = await loadWorkflow();
    const namespaceGate = workflow.jobs.deploy_and_accept.steps.find((step: any) =>
      step.name === 'Preflight exact PostgreSQL image pull in the assigned namespace');
    expect(namespaceGate.run).toContain('apply -f deploy/sealos/rc-postgres/pull-preflight.yaml');

    const preflight = parseDocument(await readFile(
      path.join(repoRoot, 'deploy/sealos/rc-postgres/pull-preflight.yaml'), 'utf8',
    )).toJSON();
    const podSpec = preflight.spec.template.spec;
    const container = podSpec.containers.find((entry: any) => entry.name === 'postgres-preflight');
    // IfNotPresent would let a cached layer satisfy the pull, so the registry
    // auth round trip would never be exercised. This Job exists to prove the
    // namespace kubelet can authenticate for the exact immutable digest.
    expect(container.imagePullPolicy).toBe('Always');
    expect(podSpec.imagePullSecrets).toEqual([{ name: 'tcr-creds' }]);
    expect(container.image)
      .toBe('ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:de247beacf40af59a9e209e02cf257b0bdb33d9f47a7f77e4eb379635a2488ba');
    // Non-destructive: no RC data volume and the Job is cleaned up by the workflow.
    expect(podSpec.volumes).toBeUndefined();
    expect(namespaceGate.run).toContain('delete job "$job_name"');
    expect(namespaceGate.run).not.toContain('delete pvc');
  });

  it('rejects stale or replaced PostgreSQL preflight Jobs instead of trusting an old Complete result', () => {
    // Sanity: the real step contains the hard-stop and UID guards.
    const workflowText = readFileSync(workflowPath, 'utf8');
    expect(workflowText).toContain('refusing to reuse stale results');
    expect(workflowText).toContain('was replaced while running');

    const temp = mkdtempSync(path.join(os.tmpdir(), 'xpod-preflight-job-'));
    const bin = path.join(temp, 'bin');
    mkdirSync(bin);
    const applyLog = path.join(temp, 'apply.log');
    const deleteCount = path.join(temp, 'delete.count');
    const uidCount = path.join(temp, 'uid.count');
    const kubectlStub = path.join(bin, 'kubectl');
    writeFileSync(kubectlStub, `#!/usr/bin/env bash
if [[ "$*" == *"apply -f"* ]]; then printf 'APPLY\\n' >> "${applyLog}"; exit 0; fi
if [[ "$*" == *"delete job"* ]]; then
  n=$(cat "${deleteCount}" 2>/dev/null || printf '0'); n=$((n + 1)); printf '%s' "$n" > "${deleteCount}"
  if [ -n "\${FAIL_DELETE_N:-}" ] && [ "$n" = "\${FAIL_DELETE_N}" ]; then exit 1; fi
  exit 0
fi
if [[ "$*" == *"metadata.uid"* ]]; then
  n=$(cat "${uidCount}" 2>/dev/null || printf '0'); n=$((n + 1)); printf '%s' "$n" > "${uidCount}"
  if [ "$n" = "1" ]; then printf '%s' "\${JOB_UID:-uid-new}"; else printf '%s' "\${OBSERVED_UID:-\${JOB_UID:-uid-new}}"; fi
  exit 0
fi
if [[ "$*" == *"status.conditions"* ]]; then printf '%s' "\${CONDITION:-Complete=True}"; exit 0; fi
if [[ "$*" == *"logs"* ]]; then printf 'preflight-logs\\n'; exit 0; fi
exit 0
`);
    chmodSync(kubectlStub, 0o755);
    const runGate = (env: Record<string, string>): SpawnSyncReturns<string> => {
      // Each scenario starts from a fresh stub command ledger.
      rmSync(deleteCount, { force: true });
      rmSync(uidCount, { force: true });
      // Isolate just the "Preflight exact PostgreSQL image pull" step run text.
      const workflow = parseDocument(readFileSync(workflowPath, 'utf8')).toJSON() as Workflow;
      const step = workflow.jobs.deploy_and_accept.steps.find((entry: any) =>
        entry.name === 'Preflight exact PostgreSQL image pull in the assigned namespace');
      const script = `set -euo pipefail\nexport SEALOS_NAMESPACE=xpod-rc\n${step.run}\n`;
      return spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      });
    };
    try {
      // Stale Job delete fails (e.g. missing RBAC): hard stop before apply.
      rmSync(applyLog, { force: true });
      const staleDeleteFailed = runGate({ FAIL_DELETE_N: '1' });
      expect(staleDeleteFailed.status, staleDeleteFailed.stderr).not.toBe(0);
      expect(staleDeleteFailed.stdout + staleDeleteFailed.stderr).toContain('refusing to reuse stale results');
      expect(existsSync(applyLog)).toBe(false);

      // The completed Job object was replaced while running: reject its result.
      const replaced = runGate({ OBSERVED_UID: 'uid-other' });
      expect(replaced.status, replaced.stderr).not.toBe(0);
      expect(replaced.stdout + replaced.stderr).toContain('was replaced while running');

      // Cleanup of the successful Job fails: the step must still fail.
      const cleanupFailed = runGate({ FAIL_DELETE_N: '2' });
      expect(cleanupFailed.status, cleanupFailed.stderr).not.toBe(0);
      expect(cleanupFailed.stdout).toContain('preflight-logs');
      expect(cleanupFailed.stdout + cleanupFailed.stderr).toContain('failed to clean up RC PostgreSQL pull preflight job');

      // Happy path: stale job cleared, new job completes on its own UID.
      const ok = runGate({});
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('preflight-logs');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('filters the runner docker config to the authorized registry entries only', async () => {
    const workflow = await loadWorkflow();
    const immutableGate = workflow.jobs.deploy_and_accept.steps.find((step: any) =>
      step.name === 'Preflight immutable native images before any RC mutation');
    const run: string = immutableGate.run;
    const marker = "read -r -d '' tcr_config_parser <<'NODE'";
    const parserStart = run.indexOf('\n', run.indexOf(marker)) + 1;
    const parserEnd = run.indexOf('\nNODE', parserStart);
    expect(parserStart).toBeGreaterThan(0);
    expect(parserEnd).toBeGreaterThan(parserStart);
    const parser = run.slice(parserStart, parserEnd);

    const temp = mkdtempSync(path.join(os.tmpdir(), 'xpod-tcr-config-'));
    const home = path.join(temp, 'home');
    mkdirSync(path.join(home, '.docker'), { recursive: true });
    writeFileSync(path.join(home, '.docker', 'config.json'), JSON.stringify({
      auths: {
        'ghcr.io': { auth: 'ghcr-token' },
        'docker.io': { auth: 'docker-token' },
        'quay.io': { auth: 'quay-token' },
      },
    }));
    const outPath = path.join(temp, 'config.json');
    try {
      // A secret missing the TCR entry must fail closed and write nothing,
      // reporting only a fixed, non-sensitive error.
      const missing = spawnSync('node', [ '-e', parser, outPath ], {
        encoding: 'utf8',
        input: JSON.stringify({ auths: { 'docker.io': { auth: 'x' } } }),
        env: { ...process.env, HOME: home },
      });
      expect(missing.status, missing.stderr).not.toBe(0);
      expect(missing.stderr).toContain('failed to install authorized registry credentials');
      expect(missing.stderr).not.toContain('docker.io');
      expect(existsSync(outPath)).toBe(false);

      // A malformed secret must never echo its own bytes: Node would otherwise
      // include a fragment of the decoded credential in the JSON.parse error.
      const sentinel = 'FAKE_TEST_SENTINEL_should_never_appear';
      const malformed = spawnSync('node', [ '-e', parser, outPath ], {
        encoding: 'utf8',
        input: `{"auths":{"ccr.ccs.tencentyun.com":{"auth":${sentinel}}}}`,
        env: { ...process.env, HOME: home },
      });
      expect(malformed.status, malformed.stderr).not.toBe(0);
      expect(malformed.stderr).toContain('failed to install authorized registry credentials');
      expect(malformed.stderr).not.toContain(sentinel);
      expect(existsSync(outPath)).toBe(false);

      // A real secret keeps only ccr plus the explicitly authorized ghcr entry.
      const ok = spawnSync('node', [ '-e', parser, outPath ], {
        encoding: 'utf8',
        input: JSON.stringify({ auths: { 'ccr.ccs.tencentyun.com': { auth: 'tcr-token' } } }),
        env: { ...process.env, HOME: home },
      });
      expect(ok.status, ok.stderr).toBe(0);
      const written = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(Object.keys(written.auths).sort()).toEqual([ 'ccr.ccs.tencentyun.com', 'ghcr.io' ]);
      expect(written.auths['ccr.ccs.tencentyun.com']).toEqual({ auth: 'tcr-token' });
      expect(written.auths['ghcr.io']).toEqual({ auth: 'ghcr-token' });
      const serialized = JSON.stringify(written);
      expect(serialized).not.toContain('docker-token');
      expect(serialized).not.toContain('quay-token');
      // The written docker config must not be group/world readable.
      expect(statSync(outPath).mode & 0o077).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('reports only a bounded operation stage and never echoes untrusted bytes', async () => {
    const workflow = await loadWorkflow();
    const immutableGate = workflow.jobs.deploy_and_accept.steps.find((step: any) =>
      step.name === 'Preflight immutable native images before any RC mutation');
    const run: string = immutableGate.run;
    const marker = "read -r -d '' tcr_config_parser <<'NODE'";
    const parserStart = run.indexOf('\n', run.indexOf(marker)) + 1;
    const parserEnd = run.indexOf('\nNODE', parserStart);
    expect(parserStart).toBeGreaterThan(0);
    expect(parserEnd).toBeGreaterThan(parserStart);
    const parser = run.slice(parserStart, parserEnd);

    // The reported stage must come from a fixed allow-list, never from the
    // secret. A valid config must not attach any stage token to a failure.
    const allowedStages = [ 'read', 'parse', 'filter', 'existing-ghcr', 'write' ];
    const sentinel = 'FAKE_TEST_SENTINEL_should_never_appear';

    const temp = mkdtempSync(path.join(os.tmpdir(), 'xpod-tcr-stage-'));
    const home = path.join(temp, 'home');
    mkdirSync(path.join(home, '.docker'), { recursive: true });
    const existingConfigPath = path.join(home, '.docker', 'config.json');
    const outPath = path.join(temp, 'config.json');
    const stageOf = (stderr: string): string | undefined => {
      const match = /\(stage: ([a-z-]+)\)/.exec(stderr);
      return match?.[1];
    };
    try {
      writeFileSync(existingConfigPath, JSON.stringify({ auths: { 'ghcr.io': { auth: 'ghcr-token' } } }));

      // Malformed source JSON: stage=parse, sentinel never echoed.
      const malformedSource = spawnSync('node', [ '-e', parser, outPath ], {
        encoding: 'utf8',
        input: `{"auths":{"ccr.ccs.tencentyun.com":{"auth":${sentinel}}}}`,
        env: { ...process.env, HOME: home },
      });
      expect(malformedSource.status, malformedSource.stderr).not.toBe(0);
      expect(malformedSource.stderr).toContain('failed to install authorized registry credentials');
      expect(malformedSource.stderr).not.toContain(sentinel);
      expect(stageOf(malformedSource.stderr)).toBe('parse');

      // Missing authorized TCR entry: stage=filter.
      const missingEntry = spawnSync('node', [ '-e', parser, outPath ], {
        encoding: 'utf8',
        input: JSON.stringify({ auths: { 'docker.io': { auth: sentinel } } }),
        env: { ...process.env, HOME: home },
      });
      expect(missingEntry.status, missingEntry.stderr).not.toBe(0);
      expect(stageOf(missingEntry.stderr)).toBe('filter');
      expect(missingEntry.stderr).not.toContain(sentinel);

      // Malformed existing GHCR config: stage=existing-ghcr, no raw error bytes.
      writeFileSync(existingConfigPath, `{"auths":{"ghcr.io":{"auth":${sentinel}}}}`);
      const malformedExisting = spawnSync('node', [ '-e', parser, outPath ], {
        encoding: 'utf8',
        input: JSON.stringify({ auths: { 'ccr.ccs.tencentyun.com': { auth: 'tcr-token' } } }),
        env: { ...process.env, HOME: home },
      });
      expect(malformedExisting.status, malformedExisting.stderr).not.toBe(0);
      expect(malformedExisting.stderr).not.toContain(sentinel);
      expect(malformedExisting.stderr).not.toContain('SyntaxError');
      const reported = stageOf(malformedExisting.stderr);
      expect(reported).toBe('existing-ghcr');
      expect(allowedStages).toContain(reported);

      // A sentinel is never allowed to become the stage token.
      expect(reported).not.toContain(sentinel);
      expect(malformedExisting.stderr.replace(/\(stage: [a-z-]+\)/, '')).not.toContain(sentinel);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('cleans the owned credential directory on every fetch/decode/parse/install/image-gate failure', async () => {
    const workflow = await loadWorkflow();
    const immutableGate = workflow.jobs.deploy_and_accept.steps.find((step: any) =>
      step.name === 'Preflight immutable native images before any RC mutation');
    const gateRun: string = immutableGate.run;

    const sentinel = 'FAKE_TEST_SENTINEL_should_never_appear';
    // Malformed secret: JSON.parse fails with the sentinel in the input.
    const malformed = runCredentialGate(gateRun, {
      secretJson: `{"auths":{"ccr.ccs.tencentyun.com":{"auth":${sentinel}}}}`,
    });
    expect(malformed.result.status, malformed.result.stderr).not.toBe(0);
    expect(malformed.result.stderr).toContain('failed to install authorized registry credentials');
    expect(malformed.result.stderr).not.toContain(sentinel);
    expect(malformed.dirExists).toBe(false);

    // Malformed existing GHCR config must fail closed instead of silently
    // continuing with a TCR-only config, and must not echo the config bytes.
    const malformedExisting = runCredentialGate(gateRun, {
      existingGhcrConfig: `{"auths":{"ghcr.io":{"auth":${sentinel}}}}`,
    });
    expect(malformedExisting.result.status, malformedExisting.result.stderr).not.toBe(0);
    expect(malformedExisting.result.stderr).toContain('failed to install authorized registry credentials');
    expect(malformedExisting.result.stderr).not.toContain(sentinel);
    expect(malformedExisting.result.stderr).not.toContain('SyntaxError');
    expect(malformedExisting.dirExists).toBe(false);

    // Existing GHCR read error (config.json is a directory) must also fail closed
    // rather than continue with a TCR-only config.
    const readErrorExisting = runCredentialGate(gateRun, {
      existingGhcrConfigAsDirectory: true,
    });
    expect(readErrorExisting.result.status, readErrorExisting.result.stderr).not.toBe(0);
    expect(readErrorExisting.result.stderr).toContain('failed to install authorized registry credentials');
    expect(readErrorExisting.result.stderr).not.toContain('EISDIR');
    expect(readErrorExisting.result.stderr).not.toContain('Error');
    expect(readErrorExisting.dirExists).toBe(false);

    // Secret fetch failure (kubectl/nonzero before decode).
    const fetchFailed = runCredentialGate(gateRun, { kubectlExit: 1 });
    expect(fetchFailed.result.status, fetchFailed.result.stderr).not.toBe(0);
    expect(fetchFailed.dirExists).toBe(false);

    // Decode failure (invalid base64 stream).
    const decodeFailed = runCredentialGate(gateRun, { rawKubectlOutput: '%%%%not base64%%%%' });
    expect(decodeFailed.result.status, decodeFailed.result.stderr).not.toBe(0);
    expect(decodeFailed.dirExists).toBe(false);

    // Image gate failure (docker pull).
    const pullFailed = runCredentialGate(gateRun, { dockerExit: 1 });
    expect(pullFailed.result.status, pullFailed.result.stderr).not.toBe(0);
    expect(pullFailed.dirExists).toBe(false);

    // Installed-image conformance failure (bun).
    const installFailed = runCredentialGate(gateRun, { bunExit: 1 });
    expect(installFailed.result.status, installFailed.result.stderr).not.toBe(0);
    expect(installFailed.dirExists).toBe(false);

    // Happy path still succeeds and leaves no owned directory behind.
    const ok = runCredentialGate(gateRun, {});
    expect(ok.result.status, ok.result.stderr).toBe(0);
    expect(ok.dirExists).toBe(false);
  });

  it('delivers the verified DROP and existence probe to psql without stray literal quotes', async () => {
    const workflow = await loadWorkflow();
    const region = nativeCleanupRegion(nativeStepRun(workflow));
    expect(region).not.toContain('\\"SELECT');
    expect(region).not.toContain('\\"DROP');

    const temp = mkdtempSync(path.join(os.tmpdir(), 'xpod-native-db-argv-'));
    const bin = path.join(temp, 'bin');
    mkdirSync(bin);
    const argvDump = path.join(temp, 'argv.txt');
    const kubectlStub = path.join(bin, 'kubectl');
    writeFileSync(kubectlStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${argvDump}"\nprintf '\\n' >> "${argvDump}"\n`);
    chmodSync(kubectlStub, 0o755);
    try {
      const script = `set -uo pipefail
export SEALOS_NAMESPACE=xpod-rc
native_db=xpod_rc_native_probe
${region}
native_db_owned=0
drop_native_db || true
`;
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status, result.stderr).toBe(0);
      const argv = readFileSync(argvDump, 'utf8').split('\n').filter((line) => line.length > 0);
      const commandValues = argv
        .map((line, index) => (line === '--command' ? argv[index + 1] : undefined))
        .filter((value): value is string => value !== undefined);
      expect(commandValues).toContain('DROP DATABASE IF EXISTS xpod_rc_native_probe WITH (FORCE)');
      expect(commandValues).toContain("SELECT 1 FROM pg_database WHERE datname = 'xpod_rc_native_probe'");
      for (const value of commandValues) expect(value).not.toContain('\\"');
      expect(argv).toContain('psql');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
