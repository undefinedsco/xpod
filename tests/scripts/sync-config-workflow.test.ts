import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/sync-config.yml');

function load(): any {
  return parse(readFileSync(workflowPath, 'utf8'));
}

describe('environment configuration sync', () => {
  it('applies one environment file to that environment only', () => {
    const workflow = load();
    const dispatch = workflow.on.workflow_dispatch.inputs.environment;
    expect(dispatch.type).toBe('choice');
    expect(dispatch.options).toEqual([ 'cn', 'co' ]);
    expect(workflow.jobs.sync.environment).toContain('inputs.environment');
    expect(workflow.jobs.sync.env.APP_ENV_FILE).toBe('${{ secrets.APP_ENV_FILE }}');
    expect(workflow.jobs.sync.env.KUBE_CONFIG_DATA).toBe('${{ secrets.KUBE_CONFIG_DATA }}');
    expect(workflow.jobs.sync.env.XPOD_SECRET_NAME).toBe('${{ vars.XPOD_RUNTIME_SECRET_NAME }}');
  });

  it('replaces the runtime secret wholesale and restarts only when it changed', () => {
    const run = load().jobs.sync.steps.map((step: any) => step.run ?? '').join('\n');

    expect(run).toContain('printf \'%s\\n\' "$APP_ENV_FILE" > "$RUNNER_TEMP/xpod-env"');
    expect(run).toContain('--from-env-file="$RUNNER_TEMP/xpod-env"');
    expect(run).toContain('create secret generic "$XPOD_SECRET_NAME"');
    expect(run).toContain('[[ "$before" == "$after" ]]');
    expect(run).toContain('rollout restart "deployment/${XPOD_DEPLOYMENT}"');
  });

  it('does not deploy images, so a configuration change stays a configuration change', () => {
    const workflow = load();
    const run = workflow.jobs.sync.steps.map((step: any) => step.run ?? '').join('\n');

    expect(run).not.toMatch(/set image\b/);
    expect(run).not.toMatch(/xpod@sha256:/);
    expect(JSON.stringify(workflow)).not.toContain('image-digest');
  });
});
