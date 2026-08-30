import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/publish-xpod-image.yml');

type Workflow = Record<string, any>;

async function loadWorkflow(): Promise<{ workflow: Workflow; text: string }> {
  const text = await readFile(workflowPath, 'utf8');
  return { workflow: parseDocument(text).toJSON() as Workflow, text };
}

function allUses(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job: any) => job.steps ?? [])
    .map((step: any) => step.uses)
    .filter((uses: unknown): uses is string => typeof uses === 'string');
}

function allRunText(workflow: Workflow): string {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job: any) => job.steps ?? [])
    .map((step: any) => step.run)
    .filter((run: unknown): run is string => typeof run === 'string')
    .join('\n');
}

describe('publish Xpod image workflow', () => {
  it('is a manual image-only lane with the minimum publish authority', async () => {
    const { workflow } = await loadWorkflow();

    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: expect.objectContaining({
          source_commit: expect.objectContaining({
            required: true,
            type: 'string',
          }),
          'qlever-local-runtime-image': expect.objectContaining({
            required: true,
            type: 'string',
          }),
        }),
      },
    });
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.permissions).toEqual({
      contents: 'read',
      packages: 'write',
    });
  });

  it('validates immutable inputs and checks out the exact requested commit', async () => {
    const { workflow } = await loadWorkflow();
    const runText = allRunText(workflow);
    const checkout = workflow.jobs.publish.steps.find((step: any) =>
      typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));

    expect(runText).toContain('source_commit must be a 40-character lowercase commit SHA');
    expect(runText).toContain('qlever-local-runtime-image must be immutable repository@sha256');
    expect(checkout.with.ref).toBe('${{ steps.source.outputs.commit }}');
  });

  it('builds and publishes only the server image sha tag, then records the immutable digest', async () => {
    const { workflow } = await loadWorkflow();
    const build = workflow.jobs.publish.steps.find((step: any) =>
      typeof step.uses === 'string' && step.uses.startsWith('docker/build-push-action@'));
    const runText = allRunText(workflow);

    expect(workflow.env.IMAGE).toBe('ghcr.io/${{ github.repository_owner }}/xpod');
    expect(build.with.target).toBe('server');
    expect(build.with.push).toBe(true);
    expect(build.with.tags).toBe('${{ env.IMAGE }}:sha-${{ steps.source.outputs.commit }}');
    expect(build.with['cache-from']).toBe('type=gha,scope=xpod-server');
    expect(build.with['cache-to']).toBe('type=gha,mode=max,scope=xpod-server');
    expect(build.with['build-args']).toContain('XPOD_QLEVER_LOCAL_RUNTIME_IMAGE=${{ inputs.qlever-local-runtime-image }}');
    expect(build.with.labels).toContain('org.opencontainers.image.revision=${{ steps.source.outputs.commit }}');
    expect(runText).toContain('docker buildx imagetools inspect "${tag}"');
    expect(runText).toContain('echo "image=${IMAGE}@${digest}" >> "${GITHUB_OUTPUT}"');
    expect(runText).toContain('## Xpod image');
  });

  it('does not trigger candidate, deployment, Kubernetes, or release side effects', async () => {
    const { text } = await loadWorkflow();

    expect(text).not.toContain('release-candidate.cjs');
    expect(text).not.toContain('kubectl');
    expect(text).not.toContain('KUBE_CONFIG_DATA');
    expect(text).not.toContain('deploy.yml');
    expect(text).not.toContain('candidate.yml');
    expect(text).not.toContain('workflow_call');
    expect(text).not.toContain(':latest');
  });

  it('pins every external action to an immutable commit', async () => {
    const { workflow } = await loadWorkflow();

    for (const uses of allUses(workflow)) {
      const revision = uses.split('@', 2)[1];
      expect(revision, uses).toMatch(/^[a-f0-9]{40}$/);
    }
  });
});
