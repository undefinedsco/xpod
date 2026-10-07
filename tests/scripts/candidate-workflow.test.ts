import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { TASK_RESUME_STAGES, TASK_RESUME_ERROR_TYPES, TASK_RESUME_FAILURE_NAMES, TASK_RESUME_FAILURE_CODES, TASK_RESUME_SITE_MODULES } from '../../src/api/tasks/TaskResumeDiagnostics';

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
  it('proves diagnostic container absence and removes private files even when cleanup fails', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs.task_runtime_diagnostic.steps;
    const cleanupIndex = steps.findIndex((step: { name?: string }) => step.name === 'Cleanup only the owned diagnostic container and private files');
    const uploadIndex = steps.findIndex((step: { name?: string }) => step.name === 'Upload diagnostic evidence (never stable-promotion evidence)');
    const parent = path.join(repoRoot, '.test-data', 'task-cleanup-contract');
    await mkdir(parent, { recursive: true });
    for (const mode of ['removed', 'remaining', 'unreachable', 'already-absent', 'foreign-marker']) {
      const directory = await mkdtemp(path.join(parent, 'case-'));
      try {
        const bin = path.join(directory, 'bin');
        await mkdir(bin);
        await writeFile(path.join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$1" >> "$RUNNER_TEMP/docker-calls"
case "$1" in
  info) [ "$FAKE_DOCKER_MODE" != unreachable ] ;;
  rm) [ "$FAKE_DOCKER_MODE" = removed ] ;;
  ps) if [ "$FAKE_DOCKER_MODE" = remaining ]; then printf '%s\\n' xpod-task-diagnostic-123-2; fi ;;
  *) exit 99 ;;
esac
`);
        await chmod(path.join(bin, 'docker'), 0o700);
        await writeFile(path.join(directory, 'task-diagnostic-container-name'),
          mode === 'foreign-marker' ? 'foreign-container' : 'xpod-task-diagnostic-123-2');
        await writeFile(path.join(directory, 'task-diagnostic-provider-config'), 'private-fixture');
        let failed = false;
        try {
          execFileSync('bash', ['-euo', 'pipefail', '-c', steps[cleanupIndex].run], {
            encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
              RUNNER_TEMP: directory, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', FAKE_DOCKER_MODE: mode },
          });
        } catch { failed = true; }
        expect(failed, mode).toBe(['remaining', 'unreachable', 'foreign-marker'].includes(mode));
        expect(await readFile(path.join(directory, 'task-diagnostic-provider-config'), 'utf8').catch(() => undefined), mode).toBeUndefined();
        const calls = await readFile(path.join(directory, 'docker-calls'), 'utf8').catch(() => '');
        if (mode === 'foreign-marker') expect(calls).not.toContain('rm');
        if (!failed) {
          expect(JSON.parse(await readFile(path.join(directory, 'task-diagnostic-safe', 'cleanup.json'), 'utf8')))
            .toMatchObject({ schemaVersion: 1, ownedContainerAbsent: true, privateFilesRemoved: true, accepted: false });
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    expect(uploadIndex).toBeGreaterThan(cleanupIndex);
  });

  it('builds the current diagnostic runtime locally while preserving independent native provenance', async () => {
    const workflow = await loadWorkflow();
    const job = workflow.jobs.task_runtime_diagnostic;
    expect(job.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(job.env.DIAGNOSTIC_RUNTIME_SOURCE_SHA).toBe('${{ github.sha }}');
    expect(job.env.DIAGNOSTIC_NATIVE_SOURCE_SHA).toBe('35dce6f1fc5f69b189b695d5321d68e9c0df9331');
    const build = job.steps.find((step: { name?: string }) => step.name === 'Build current source only for local Task diagnostics');
    expect(build.with).toMatchObject({ context: '.', file: './Dockerfile', target: 'runtime',
      platforms: 'linux/amd64', load: true, push: false });
    expect(build.with['cache-to']).toBeUndefined();
    expect(build.with['build-args']).toContain('XPOD_QLEVER_LOCAL_RUNTIME_IMAGE=${{ steps.native.outputs.image }}');
    const text = jobRunText(workflow, 'task_runtime_diagnostic');
    expect(text).toContain('git diff --quiet "$DIAGNOSTIC_NATIVE_SOURCE_SHA" HEAD --');
    expect(text).toContain('org.opencontainers.image.revision');
    expect(text).toContain('nativeImageId');
    expect(text).toContain('runtimeImageId');
    expect(text).not.toContain('publish-qlever');
    expect(text).not.toContain('docker push');
    expect(text).not.toContain('--apply-root-version');
    const verifyIndex = job.steps.findIndex((step: { name?: string }) => step.name === 'Bind the locally built diagnostic runtime and native input');
    const liveIndex = job.steps.findIndex((step: { name?: string }) => step.name === 'Run unchanged real live Task acceptance against current source');
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(liveIndex).toBeGreaterThan(verifyIndex);
    expect(jobRunText(workflow, 'task_runtime_diagnostic')).not.toContain('release-acceptance-manifest.cjs');
    // 保留的 task_runtime_diagnostic 也必须跑在 .cn RC 上，不得保留过时的 .co 端点。
    expect(text).toContain('id-rc.undefineds.cn');
    expect(text).not.toContain('id-rc.undefineds.co');
  });

  it('projects Task model receipts before owned-container cleanup without uploading raw logs', async () => {
    const workflow = await loadWorkflow();
    for (const name of ['deploy_and_accept', 'task_runtime_diagnostic']) {
      const steps = workflow.jobs[name].steps;
      const projectIndex = steps.findIndex((step: { name?: string }) => step.name === 'Project safe Task model failure evidence');
      expect(projectIndex).toBeGreaterThan(-1);
      const project = steps[projectIndex];
      expect(project.if).toBe('always()');
      expect(project.run).toContain('project-task-model-diagnostics.ts');
      expect(project.run).toContain('docker logs --timestamps "$local_name"');
      expect(project.run).toContain('trap \'rm -f "$raw_log"\' EXIT');
      expect(project.run).toContain('"$(cat "$name_file")" = "$local_name"');
      expect(project.run).toContain('xpod-rc-local-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}');
      expect(project.run).toContain('xpod-task-diagnostic-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}');
      const cleanupIndex = steps.findIndex((step: { name?: string }) => /Cleanup.*(?:Local Xpod|owned diagnostic container)/u.test(step.name ?? ''));
      expect(cleanupIndex).toBeGreaterThan(projectIndex);
      const upload = steps.find((step: { name?: string }) => step.name === 'Upload safe Task model failure evidence');
      expect(upload.if).toBe('always()');
      expect(upload.with.path).toBe('${{ runner.temp }}/task-model-diagnostic-safe/');
      expect(upload.with.name).toContain('task-model-failure-diagnostic-${{ github.sha }}');
      expect(upload.with.path).not.toContain('private');
    }
  });

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

  it('only runs on release branches with a shared workflow lock and minimal permissions', async () => {
    const workflow = await loadWorkflow();

    expect(workflow.on.push.branches).toEqual([ 'release/**' ]);
    expect(workflow.on.push.tags).toBeUndefined();
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.concurrency).toEqual({
      group: 'xpod-shared-rc-workflow',
      'cancel-in-progress': false,
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
      if (jobName === 'task_runtime_diagnostic') {
        expect((job as { permissions?: Record<string, string> }).permissions, jobName).toEqual({
          contents: 'read',
          packages: 'read',
        });
      } else if (!packageJobs.has(jobName)) {
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
    expect(runText).toContain('id-rc.undefineds.cn');
    expect(runText).toContain('pods-rc.undefineds.cn');
    expect(runText).toContain('api-rc.undefineds.cn');
    expect(runText).toContain('auth can-i create deployments');
    expect(runText).not.toContain('get secret xpod-rc-tls');
  });

  it('runs the read-only shared-package reuse preflight before artifact jobs and never publishes', async () => {
    const workflow = await loadWorkflow();
    const steps = workflow.jobs.rc_prerequisites.steps;
    const bun = steps.find((step: any) => step.uses === 'oven-sh/setup-bun@v2');
    expect(bun.with['bun-version']).toBe('1.4.2');
    const installIndex = steps.findIndex((step: any) => step.run === 'bun install --frozen-lockfile');
    const buildIndex = steps.findIndex((step: any) => step.run === 'bun run build:packages');
    const preflightIndex = steps.findIndex((step: any) =>
      typeof step.run === 'string' && step.run.includes('scripts/publish-workspace-packages.cjs --verify-only'));
    const preflight = steps[preflightIndex];
    expect(installIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(preflightIndex).toBeGreaterThan(buildIndex);
    expect(preflight.name).toBe('Verify shared package reuse without publishing');
    expect(preflight.env.XPOD_ACCEPTED_SHA).toBe('${{ github.sha }}');
    expect(preflight.run).not.toContain('npm publish');
    expect(preflight.run).not.toContain('dist-tag');
    expect(preflight.run).not.toContain(':latest');
    for (const jobName of ['publish_qlever_runtime_sdk', 'build_qlever_macos_runtime', 'build_image']) {
      const needs = workflow.jobs[jobName].needs;
      expect(Array.isArray(needs) ? needs.includes('rc_prerequisites') : needs === 'rc_prerequisites', jobName).toBe(true);
    }
  });

  it('checks out the repository and validates the Guangzhou cluster target before any namespace access', async () => {
    const workflow = await loadWorkflow();
    const job = workflow.jobs.rc_prerequisites;
    const steps = job.steps;
    const checkoutIndex = steps.findIndex((step: any) => step.uses === 'actions/checkout@v4');
    expect(checkoutIndex).toBeGreaterThan(-1);

    const runText = jobRunText(workflow, 'rc_prerequisites');
    const guardIndex = runText.indexOf('node scripts/verify-rc-cluster-target.cjs');
    const kubeconfigIndex = runText.search(/> ~\/\.kube\/config/);
    const authIndex = runText.indexOf('auth can-i create deployments');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(kubeconfigIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(kubeconfigIndex);
    expect(guardIndex).toBeLessThan(authIndex);

    const guardStepIndex = steps.findIndex((step: any) =>
      typeof step.run === 'string' && step.run.includes('verify-rc-cluster-target.cjs'));
    expect(guardStepIndex).toBeGreaterThan(checkoutIndex);
  });

  it('guards deployment diagnostics and RC scaling on a verified kubeconfig setup', async () => {
    const workflow = await loadWorkflow();
    const job = workflow.jobs.deploy_and_accept;
    const steps = job.steps;
    const setupIndex = steps.findIndex((step: any) => step.name === 'Set up kubeconfig');
    expect(setupIndex).toBeGreaterThan(-1);
    expect(steps[setupIndex].id).toBe('rc_kubeconfig');

    const runText = jobRunText(workflow, 'deploy_and_accept');
    const guardIndex = runText.indexOf('node scripts/verify-rc-cluster-target.cjs');
    const kubeconfigIndex = runText.search(/> ~\/\.kube\/config/);
    const firstClusterOperation = runText.indexOf(
      'kubectl -n "$SEALOS_NAMESPACE" create secret generic "$XPOD_RUNTIME_SECRET_NAME"');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(kubeconfigIndex).toBeGreaterThan(-1);
    expect(firstClusterOperation).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(kubeconfigIndex);
    expect(guardIndex).toBeLessThan(firstClusterOperation);

    const guardStepIndex = steps.findIndex((step: any) =>
      typeof step.run === 'string' && step.run.includes('verify-rc-cluster-target.cjs'));
    expect(guardStepIndex).toBeGreaterThanOrEqual(setupIndex);

    const diagnostics = steps.find((step: any) => step.name === 'Dump diagnostics');
    expect(diagnostics.if).toContain('failure()');
    expect(diagnostics.if).toContain("steps.rc_kubeconfig.outcome == 'success'");
    // The RC scale-down moved to the dedicated `cleanup_rc` job so it can run after
    // the desktop and finalize acceptance jobs (asserted by the cleanup contract test).
    expect(steps.some((step: any) => step.name === 'Scale RC deployments to zero')).toBe(false);
  });

  it('builds and verifies the macOS desktop without Apple distribution credentials', async () => {
    const workflow = await loadWorkflow();
    const desktop = workflow.jobs.build_desktop_rc;
    const runText = jobRunText(workflow, 'build_desktop_rc');
    const desktopManifest = JSON.parse(await readFile(path.join(repoRoot, 'desktop/package.json'), 'utf8'));

    expect(desktop.name).toBe('Build macOS RC desktop');
    expect(desktop.needs).toEqual([ 'metadata', 'build_qlever_macos_runtime', 'deploy_and_accept' ]);
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
    expect(runText).not.toContain('--overlay deploy/sealos/rc-postgres');
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
    expect(runText).not.toContain('xpod-rc-postgres-secret');
    expect(runText).not.toContain('kubectl -n "$SEALOS_NAMESPACE" patch deployment/xpod-rc');
    expect(runText).not.toContain('kubectl -n "$SEALOS_NAMESPACE" set image deployment/xpod-rc');
    expect(runText).not.toContain('kubectl -n "$SEALOS_NAMESPACE" rollout restart deployment/xpod-rc');
    expect(runText).toContain('kubectl rollout status deployment/xpod-rc');
    expect(runText).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(runText).toContain("CREATE EXTENSION IF NOT EXISTS xpod_rdf VERSION '0.2.0'");
    expect(runText).toContain("CREATE EXTENSION IF NOT EXISTS xpod_qlever VERSION '0.4.0'");
    expect(runText).toContain('delete deployment/xpod-rc --cascade=foreground --wait=true --ignore-not-found');
    expect(runText).not.toContain('delete statefulset/xpod-rc-postgres');
    expect(runText).not.toContain('pvc/data-xpod-rc-postgres-0');
    expect(runText).not.toContain('delete pvc -l');
    expect(runText.indexOf('DROP DATABASE IF EXISTS xpod_rc WITH (FORCE)'))
      .toBeLessThan(runText.indexOf('kubectl apply -f "$rendered_manifest"'));
    expect(runText).toContain('CREATE DATABASE xpod_rc OWNER xpod_rc');
    // 扩展由超级用户安装，schema 归属必须一并交给应用角色，否则 CSS 起不来。
    expect(runText).toContain('ALTER SCHEMA %I OWNER TO xpod_rc');
    expect(runText).not.toContain('kubectl rollout status deployment/xpod-inngest');
    expect(runText).toContain('node scripts/update-gateway-rc-configmap.cjs');
    expect(runText).toContain('https://id-rc.undefineds.cn/service/status');
    expect(runText).toContain('https://pods-rc.undefineds.cn');
    expect(runText).toContain('https://api-rc.undefineds.cn');
    expect(runText).toContain('/.well-known/openid-configuration');
    expect(runText).toContain('https://id-rc.undefineds.cn/dashboard/');
    expect(runText).toContain('/settings/');
    expect(runText).toContain('dashboard.html');
    expect(runText).toContain('settings.html');
    expect(runText).toContain('dashboard did not return HTML');
    expect(runText).toContain('settings did not return HTML');
    expect(runText).toContain('https://api-rc.undefineds.cn/api/pod/settings/status');
    for (const pair of [
      [ 'xpod-rc-id-tls', 'id-rc.undefineds.cn' ],
      [ 'xpod-rc-pods-tls', 'pods-rc.undefineds.cn' ],
      [ 'xpod-rc-api-tls', 'api-rc.undefineds.cn' ],
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

    expect(runText).not.toContain("['CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT'].includes(key)");
    expect(runText).not.toContain('identity_db_url="postgresql://xpod_rc:');
    expect(runText).not.toContain('sparql_endpoint="postgresql://xpod_rc:');
    expect(runText).not.toContain('pg_password="$(openssl rand -hex 32)"');
    expect(runText).not.toContain('add-mask::$pg_password');
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
    // Gateway API Keys are gone, so the API no longer requires a locator secret at startup.
    expect(runText).not.toContain('XPOD_GATEWAY_LOCATOR_SECRET');
    expect(runText).not.toContain('--from-literal=POSTGRES_DB=xpod_rc');
    expect(runText).not.toContain('--from-literal=POSTGRES_USER=xpod_rc');
    expect(runText).not.toContain('must match the isolated RC PostgreSQL service identity');
    expect(runText).not.toContain('production database is not allowed in RC APP_ENV_FILE');
    expect(runText).not.toMatch(/cat\s+["']?\$APP_ENV_FILE/);
    expect(runText).not.toMatch(/grep .*APP_ENV_FILE/);
  });

  it.each([
    ['postgresql://xpod_rc:fixture@xpod-rdf-postgres:5432/xpod_rc', true],
    ['postgresql://xpod_rc:fixture@xpod-rdf-postgres.fixture-ns.svc.cluster.local/xpod_rc', true],
    ['postgresql://xpod_rc:fixture@xpod-rdf-postgres:5432/xpod_cn', false],
    ['postgresql://postgres:fixture@xpod-rdf-postgres:5432/xpod_rc', false],
    ['postgresql://xpod_rc:fixture@production-postgres:5432/xpod_rc', false],
    ['https://xpod_rc:fixture@xpod-rdf-postgres:5432/xpod_rc', false],
  ])('validates both configured database URLs before resetting the shared RC database (%s)', async (url, allowed) => {
    const workflow = await loadWorkflow();
    const run = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Validate RC runtime secret isolation').run;
    const script = run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
    const parent = path.join(repoRoot, '.test-data/candidate-database-isolation');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(parent, 'case-'));
    const envPath = path.join(directory, 'runtime.env');
    const seedPath = path.join(directory, 'seed.json');
    try {
      for (const key of ['CSS_IDENTITY_DB_URL', 'CSS_SPARQL_ENDPOINT']) {
        const entries = {
          CSS_IDENTITY_DB_URL: 'postgresql://xpod_rc:fixture@xpod-rdf-postgres/xpod_rc',
          CSS_SPARQL_ENDPOINT: 'postgresql://xpod_rc:fixture@xpod-rdf-postgres/xpod_rc',
          CSS_REDIS_CLIENT: 'redis://redis:6379/1',
          CSS_MINIO_ENDPOINT: 'https://fixture.r2.cloudflarestorage.com',
          CSS_MINIO_BUCKET_NAME: 'xpod-rc', CSS_MINIO_ACCESS_KEY: 'fixture', CSS_MINIO_SECRET_KEY: 'fixture',
          XPOD_INNGEST_EVENT_KEY: 'fixture', XPOD_INNGEST_SIGNING_KEY: 'fixture', XPOD_GATEWAY_LOCATOR_SECRET: 'fixture',
          [key]: url,
        };
        await writeFile(envPath, Object.entries(entries).map(([name, value]) => `${name}=${value}`).join('\n'), { mode: 0o600 });
        await writeFile(seedPath, JSON.stringify([{email: 'alice@fixture'}, {email: 'bob@fixture'}]), { mode: 0o600 });
        const runValidation = () => execFileSync(process.execPath, ['-', envPath, seedPath], {
          env: {...process.env, SEALOS_NAMESPACE: 'fixture-ns'}, input: script, stdio: 'pipe',
        });
        if (allowed) expect(runValidation).not.toThrow();
        else expect(runValidation).toThrow(/must use the isolated xpod_rc database and role/);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
    const reset = workflow.jobs.deploy_and_accept.steps.find((step: any) => step.name === 'Reset the shared RC database').run;
    expect(reset).toContain('SHOW server_version_num');
    expect(reset).toContain("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  });

  it('derives authenticated smoke configuration from the fixed RC seed instead of manual secrets', async () => {
    const workflow = await loadWorkflow();
    const deploy = workflow.jobs.deploy_and_accept;
    const runText = jobRunText(workflow, 'deploy_and_accept');

    expect(deploy.env.XPOD_ACCEPTANCE_REAL_XPOD).toBe('true');
    expect(deploy.env.XPOD_ACCEPTANCE_RUN_VISUAL).toBe('true');
    expect(deploy.env.XPOD_SETTINGS_E2E_BASE_URL).toBe('https://id-rc.undefineds.cn');
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
    expect(runText).toContain('--env SOLID_OIDC_ISSUER=https://id-rc.undefineds.cn/');
    expect(runText).toContain('docker port "$local_name" 5737/tcp');
    expect(runText).not.toContain('port-forward deployment/xpod-rc 3000:3000');
    expect(runText).toContain('XPOD_LIVE_PROVIDER_KEY_FILE="$provider_file"');
    expect(runText).toContain('XPOD_LIVE_GATEWAY_URL="$gateway"');
    expect(runText).toContain('XPOD_LIVE_CLOUD_IDP="https://id-rc.undefineds.cn/"');
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
    const script = step.run.match(/node - <<'NODE'\n([\s\S]*?)\nNODE/)[1];
    const parent = path.join(repoRoot, '.test-data', 'task-evidence-contract');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'case-'));
    try {
      const input = path.join(directory, '.test-data', 'acceptance');
      await mkdir(input, { recursive: true });
      if (contents !== undefined) await writeFile(path.join(input, 'live-gateway-login-chat-local.json'), contents);
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: directory, encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: directory, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' },
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

  it('uses the shared failure enums and retains only the bounded producer attribution', async () => {
    const workflow = await loadWorkflow();
    const script = workflow.jobs.deploy_and_accept.steps.find((entry: any) => entry.name === 'Project safe Task approval evidence').run;
    for (const [name, values] of [['failureNames', TASK_RESUME_FAILURE_NAMES], ['codes', TASK_RESUME_FAILURE_CODES], ['modules', TASK_RESUME_SITE_MODULES]] as const) {
      const literal = script.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))?.[1];
      expect(literal).toBeDefined();
      expect(Function(`return ${literal}`)()).toEqual(values);
    }
    const taskResumeFailure = { name: 'Error', code: 'ECONNRESET', causeCode: 'ECONNREFUSED',
      site: { module: 'api/runs/store', line: 17, column: 4, coordinate: 'source_ts', kind: 'first_project_frame' } };
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false,
      cases: [{ kind: 'approved', ok: false, failureDetails: { substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', taskResumeFailure } }], cleanup: { ok: true } } }));
    expect(JSON.parse(result.evidence!).cases[0].failureDetails.taskResumeFailure).toEqual(taskResumeFailure);
  });
  it.each([null, 'private', { name: 'private' }, { name: 'Error', stack: 'private' },
    { name: 'Error', site: { module: '/Users/private/store.ts', line: 17, column: 4, coordinate: 'source_ts', kind: 'first_project_frame' } },
    { name: 'Error', site: { module: 'api/runs/store', line: 0, column: 4, coordinate: 'source_ts', kind: 'first_project_frame' } },
  ])('rejects malformed producer attribution %# instead of publishing it', async taskResumeFailure => {
    await expect(projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false,
      cases: [{ kind: 'approved', ok: false, failureDetails: { substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', taskResumeFailure } }], cleanup: { ok: true } } }))).rejects.toThrow('Invalid safe Task failure details');
  });
  it('projects only optional allowlisted Task failure details and accepts older evidence', async () => {
    const details = { substage: 'decision-resume-request', category: 'connection', name: 'TypeError', causeCode: 'ECONNREFUSED', httpStatus: 403, taskError: 'service_access_missing', errorEnvelope: 'error_string', runDocumentHttpStatus: 401, taskResumeStage: 'task_auth_restore', taskResumeErrorType: 'type_error' };
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false,
      cases: [{ kind: 'approved', ok: false, acceptancePhase: 'approved:decision', failureDetails: { ...details, message: 'secret-body', uri: 'private-uri' } }],
      cleanup: { ok: true },
    } }));
    const evidence = JSON.parse(result.evidence!);
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.cases[0].failureDetails).toEqual(details);
    expect(result.evidence).not.toContain('secret-body');
    expect(result.evidence).not.toContain('private-uri');
  });
  it.each([
    ...TASK_RESUME_STAGES.map(taskResumeStage => ({ taskResumeStage })),
    ...TASK_RESUME_ERROR_TYPES.map(taskResumeErrorType => ({ taskResumeErrorType })),
  ])('accepts every producer diagnostic enum in the independent workflow projection', async diagnostic => {
    const failureDetails = { substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', ...diagnostic };
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false, cases: [{ kind: 'approved', ok: false, failureDetails }], cleanup: { ok: true } } }));
    expect(JSON.parse(result.evidence!).cases[0].failureDetails).toEqual(failureDetails);
  });
  it.each(['run_conditional_auth_required', 'run_strong_etag_required', 'run_turtle_document_required', 'run_persisted_status_invalid', 'run_persisted_timestamp_invalid', 'run_conditional_update_conflict', 'continuation_claim_required', 'continuation_release_required', 'run_workspace_required', 'approval_session_storage_unavailable', 'run_document_read_failed', 'run_document_update_failed'])('projects fixed reachable Run error token %s', async taskError => {
    const failureDetails = { substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', httpStatus: 400, taskError };
    const result = await projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false, cases: [{ kind: 'approved', ok: false, failureDetails }], cleanup: { ok: true } } }));
    expect(JSON.parse(result.evidence!).cases[0].failureDetails).toEqual(failureDetails);
  });
  it.each([
    ...[-1, 99, 600, 400.5, '400', null, 'secret-body'].map(runDocumentHttpStatus => ({ substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', runDocumentHttpStatus })),
    ...[-1, 99, 600, 400.5, '400', null, 'secret-body'].map(httpStatus => ({ substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', httpStatus })),
    { substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', taskError: 'secret-body' },
    { substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', errorEnvelope: 'secret-body' },
    ...['secret-body', null, 1, {}, [], 'task_auth_restore\n'].map(taskResumeStage => ({ substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', taskResumeStage })),
    ...['secret-body', null, 1, {}, [], 'type_error\n'].map(taskResumeErrorType => ({ substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', taskResumeErrorType })),
    { substage: 'secret-body', category: 'other', name: 'Error' },
    { substage: 'decision-resume-request', category: 'secret-body', name: 'Error' },
    { substage: 'decision-resume-request', category: 'other', name: 'secret-body' },
    { substage: 'decision-resume-request', category: 'other', name: 'Error', code: 'secret-body' },
    { substage: 'decision-resume-request', category: 'other', name: 'Error', causeCode: 'secret-body' },
  ])('rejects unknown Task failure diagnostic values', async failureDetails => {
    await expect(projectTaskEvidence(JSON.stringify({ taskApproval: { ok: false,
      cases: [{ kind: 'approved', ok: false, failureDetails }], cleanup: { ok: true },
    } }))).rejects.toThrow('Invalid safe Task failure details');
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
    expect(diagnostics.if).toContain('failure()');
    expect(diagnostics.if).toContain("steps.rc_kubeconfig.outcome == 'success'");
    expect(diagnostics.run).toContain('kubectl -n "$SEALOS_NAMESPACE" get');
    expect(diagnostics.run).toContain('describe deployment xpod-rc');
    expect(diagnostics.run).toContain('describe statefulset xpod-rdf-postgres');
    expect(diagnostics.run).toContain('app=xpod-rdf-postgres');
    expect(diagnostics.run).toContain('--previous');
    expect(diagnostics.run).toContain('live-gateway-local-container-name');
    expect(diagnostics.run).toContain('docker inspect "$local_name"');
    expect(diagnostics.run).toContain('docker logs "$local_name"');
    expect(workflow.jobs.deploy_and_accept.steps.some((step: any) => step.name === 'Scale RC deployments to zero')).toBe(false);
    const cleanupJob = workflow.jobs.cleanup_rc;
    expect(cleanupJob.needs).toEqual(['deploy_and_accept', 'build_desktop_rc', 'finalize_acceptance']);
    expect(cleanupJob.if).toBe('${{ always() }}');
    expect(workflow.jobs.build_desktop_rc.needs).toContain('deploy_and_accept');
    const cleanup = cleanupJob.steps.find((step: any) => step.name === 'Scale RC deployments to zero');
    expect(cleanup.if).toBeUndefined();
    expect(cleanup.run).toContain('resource=deployment/xpod-rc');
    expect(cleanup.run).toContain('scale deployment/xpod-rc-inngest --replicas=0');
    expect(cleanup.run).toContain('delete secret "$XPOD_RC_SEED_SECRET_NAME" --ignore-not-found');
    expect(cleanup.run).not.toContain('statefulset/');
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
    // 所有 RC 公开主机（含保留的 task_runtime_diagnostic）都必须使用 .cn。
    expect(allRunText(workflow)).not.toContain('id-rc.undefineds.co');
    expect(allRunText(workflow)).not.toContain('pods-rc.undefineds.co');
    expect(allRunText(workflow)).not.toContain('api-rc.undefineds.co');
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

  it('resolves the desktop self-update baseline by version order, not by recency alone', async () => {
    const workflow = await loadWorkflow();
    const step = workflow.jobs.build_desktop_rc.steps.find(
      (candidate: any) => candidate.name === 'Download the previously released desktop bundle',
    );
    expect(step).toBeDefined();
    // The verifier already rejects evidence unless oldVersion < newVersion, so the
    // baseline must be resolved against the candidate instead of taken blindly.
    expect(step.run).toContain('scripts/select-desktop-update-baseline.cjs');
    expect(step.run).toContain('--candidate "$CANDIDATE_VERSION"');
    expect(step.run).toContain('--releases "$dest/releases.json"');
    expect(step.run).toContain('gh release download "$old_tag"');
    // A shipped build is the only valid baseline, so pre-releases stay excluded.
    expect(step.run).toContain('--exclude-pre-releases');
    // Drafts are unpublished; exclude them from gh and pass the field through so
    // the selector can drop a draft row as well.
    expect(step.run).toContain('--exclude-drafts');
    expect(step.run).toContain('isDraft');
    // Recency alone is what asked the newer released app to downgrade: the list is
    // no longer truncated to a single newest tag.
    expect(step.run).not.toMatch(/release list[\s\S]*--limit 1\b/);
    expect(step.run).not.toContain("--jq '.[0].tagName'");
  });
});
