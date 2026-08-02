import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/deploy.yml');

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

describe('production deployment workflow', () => {
  it('is reusable by digest and keeps manual recovery explicit without asynchronous release triggers', async () => {
    const workflow = await loadWorkflow();

    expect(workflow.on.workflow_run).toBeUndefined();
    expect(workflow.on.workflow_call.inputs).toMatchObject({
      version: {
        required: true,
        type: 'string',
      },
      'image-digest': {
        required: true,
        type: 'string',
      },
      environment: {
        required: true,
        type: 'string',
      },
    });
    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      version: expect.objectContaining({ required: true }),
      'image-digest': expect.objectContaining({ required: true }),
      environment: expect.objectContaining({
        required: true,
        type: 'choice',
        options: [ 'all', 'co', 'cn' ],
      }),
    });
    expect(JSON.stringify(workflow.on.workflow_dispatch.inputs)).not.toContain('image-tag');
    expect(workflow.permissions).toEqual({
      contents: 'read',
      packages: 'read',
    });
  });

  it('uses separate .co and .cn production environments with reusable-call-friendly selectors', async () => {
    const workflow = await loadWorkflow();

    expect(Object.keys(workflow.jobs).sort()).toEqual([ 'deploy-cn', 'deploy-co', 'preflight' ]);
    expect(workflow.jobs.preflight.if).toBeUndefined();
    expect(workflow.jobs.preflight['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs.preflight.environment).toBeUndefined();
    expect(workflow.jobs['deploy-co'].environment).toBe('co');
    expect(workflow.jobs['deploy-cn'].environment).toBe('cn');
    expect(workflow.jobs['deploy-co'].needs).toBe('preflight');
    expect(workflow.jobs['deploy-cn'].needs).toBe('preflight');
    expect(workflow.jobs['deploy-co'].concurrency).toEqual({
      group: 'deploy-co',
      'cancel-in-progress': false,
    });
    expect(workflow.jobs['deploy-cn'].concurrency).toEqual({
      group: 'deploy-cn',
      'cancel-in-progress': false,
    });
    expect(workflow.jobs['deploy-co'].if).toContain("inputs.environment == 'co'");
    expect(workflow.jobs['deploy-co'].if).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow.jobs['deploy-cn'].if).toContain("inputs.environment == 'cn'");
    expect(workflow.jobs['deploy-cn'].if).toContain("github.event_name == 'workflow_dispatch'");
  });

  it('validates all untrusted inputs and Kubernetes names through env-injected shell variables', async () => {
    const workflow = await loadWorkflow();
    const preflightRunText = jobRunText(workflow, 'preflight');
    const runText = allRunText(workflow);

    expect(preflightRunText).toContain("VERSION_REGEX='^[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(preflightRunText).not.toContain('-[0-9A-Za-z.-]+');
    expect(preflightRunText).not.toContain('\\+[0-9A-Za-z.-]+');
    expect(preflightRunText).toContain('DIGEST_REGEX=');
    expect(preflightRunText).toContain('^sha256:[0-9a-f]{64}$');
    expect(preflightRunText).toContain('ENVIRONMENT_REGEX=');
    expect(preflightRunText).toContain('^(co|cn)$');
    expect(preflightRunText).toContain('environment=all is only allowed for manual workflow_dispatch recovery');
    expect(runText).toContain('K8S_NAME_REGEX=');
    expect(runText).toContain('SEALOS_NAMESPACE must be a valid Kubernetes name');
    expect(runText).toContain('XPOD_RUNTIME_SECRET_NAME must be a valid Kubernetes name');
    expect(runText).not.toContain('${{ inputs.version }}');
    expect(runText).not.toContain('${{ inputs.image-digest }}');
    expect(runText).not.toContain('${{ inputs.environment }}');
    expect(runText).not.toContain('${{ github.ref');
  });

  it('verifies the GHCR digest exists and deploys only the immutable digest after manifest apply preserves the previous image', async () => {
    const workflow = await loadWorkflow();
    const workflowText = await loadWorkflowText();
    const runText = allRunText(workflow);

    expect(runText).toContain('docker manifest inspect "$TARGET_IMAGE"');
    expect(workflowText).toContain('TARGET_IMAGE: ghcr.io/undefinedsco/xpod@${{ inputs.image-digest }}');
    expect(runText).toContain('jsonpath={.spec.template.spec.containers[?(@.name=="xpod")].image}');
    expect(runText).toContain('previous_image=');
    expect(runText).toContain('PREVIOUS_IMAGE');
    expect(runText).toContain('s#image: ghcr.io/undefinedsco/xpod:.*#image: ${PREVIOUS_IMAGE}#g');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" set image deployment/xpod-cloud xpod="$TARGET_IMAGE"');
    expect(runText).toContain('kubectl rollout status deployment/xpod-inngest');
    expect(runText).toContain('kubectl rollout status deployment/xpod-cloud');
    expect(runText).not.toMatch(/set image deployment\/xpod-cloud xpod=ghcr\.io\/undefinedsco\/xpod:[^\s"]+/);
    expect(runText).not.toContain('xpod:replace-me');
  });

  it('gates success on public, Kubernetes, digest, and direct pod health checks for both domains', async () => {
    const workflow = await loadWorkflow();
    const runText = allRunText(workflow);

    expect(Object.values(workflow.jobs).flatMap((job: any) => job.steps ?? [])
      .filter((step: any) => step.name === 'Verify production gates')).toHaveLength(2);
    expect(workflow.jobs['deploy-co'].env.PUBLIC_BASE_URL).toBe('https://id.undefineds.co');
    expect(workflow.jobs['deploy-cn'].env.PUBLIC_BASE_URL).toBe('https://id.undefineds.cn');
    expect(runText).toContain('service_url="$PUBLIC_BASE_URL/service/status"');
    expect(runText).toContain('oidc_url="$PUBLIC_BASE_URL/.well-known/openid-configuration"');
    expect(runText).toContain('dashboard_url="$PUBLIC_BASE_URL/dashboard/"');
    expect(runText).toContain('settings_url="$PUBLIC_BASE_URL/settings/"');
    expect(runText).toContain('protected_settings_url="$PUBLIC_BASE_URL/api/pod/settings/status"');
    expect(runText).toContain('dashboard.html');
    expect(runText).toContain('settings.html');
    expect(runText).toContain('<!doctype html\\|<html');
    expect(runText).toContain('settings did not return HTML');
    expect(runText).toContain('expected_status "$protected_settings_url" 401');
    expect(runText).not.toContain('expected_status "$settings_url" 401');
    expect(runText).not.toContain('/settings/api/providers');
    expect(runText).toContain('deployment_image="$(kubectl -n "$SEALOS_NAMESPACE" get deployment xpod-cloud');
    expect(runText).toContain('imageID');
    expect(runText).toContain('service/status');
    expect(runText).toContain('kubectl -n "$SEALOS_NAMESPACE" exec "$ready_pod"');
  });

  it('rolls back to the captured previous image only on failure and dumps non-secret diagnostics', async () => {
    const workflow = await loadWorkflow();
    const runText = allRunText(workflow);

    for (const job of [ workflow.jobs['deploy-co'], workflow.jobs['deploy-cn'] ]) {
      const rollback = job.steps.find((step: any) => step.name === 'Rollback on failure');
      const diagnostics = job.steps.find((step: any) => step.name === 'Dump diagnostics on failure');
      expect(rollback.if).toBe('failure()');
      expect(diagnostics.if).toBe('failure()');
      expect(rollback.run).toContain('PREVIOUS_IMAGE="$(cat "$RUNNER_TEMP/xpod-previous-image")"');
      expect(rollback.run).toContain('No previous image was captured; skipping rollback');
      expect(rollback.run).toContain('kubectl -n "$SEALOS_NAMESPACE" set image deployment/xpod-cloud xpod="$PREVIOUS_IMAGE"');
      expect(rollback.run).toContain('kubectl rollout status deployment/xpod-cloud');
      expect(diagnostics.run).toContain('--previous');
      expect(diagnostics.run).toContain('get deployment xpod-cloud');
      expect(diagnostics.run).toContain('describe deployment xpod-cloud');
      expect(diagnostics.run).toContain('logs -l app=xpod-cloud');
      expect(diagnostics.run).not.toContain('get secret');
      expect(diagnostics.run).not.toContain('describe secret');
    }
    expect(runText).not.toMatch(/cat\s+["']?\$APP_ENV_FILE/);
  });
});
