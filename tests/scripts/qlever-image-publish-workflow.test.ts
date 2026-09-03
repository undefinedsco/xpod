import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const buildAction = 'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a';
const sameImageKeys = [ 'context', 'file', 'target', 'platforms', 'tags', 'labels', 'build-args' ];

const cases = [
  {
    name: 'runtime SDK image',
    file: '.github/workflows/publish-qlever-runtime-sdk.yml',
    imageEnv: 'SDK_IMAGE',
    dockerfile: '${{ steps.resolve.outputs.dockerfile }}',
    tags: '${{ env.SDK_IMAGE }}:${{ steps.resolve.outputs.tag }}',
    args: [ 'XPOD_QLEVER_BUILD_JOBS=2', 'XPOD_QLEVER_PRIOR_SDK_IMAGE=${{ steps.resolve.outputs.prior_image }}' ],
    gates: [ 'Smoke the exact SDK image before publishing' ],
    condition: "steps.resolve.outputs.build == 'true'",
  },
  {
    name: 'local runtime image',
    file: '.github/workflows/publish-qlever-local-runtime.yml',
    imageEnv: 'IMAGE',
    dockerfile: './docker/qlever-local-runtime/Dockerfile',
    target: 'runtime',
    tags: '${{ env.IMAGE }}:sha-${{ github.sha }}',
    args: [ 'XPOD_QLEVER_BUILD_JOBS=2', 'XPOD_QLEVER_PRIOR_SDK_IMAGE=${{ inputs.prior_sdk_image }}' ],
    gates: [
      'Smoke the exact image before publishing',
      'Run SQLite QLever semantic and native search conformance',
      'Exercise the Gateway credential path against the exact image',
    ],
  },
];

type Workflow = Record<string, any>;
type WorkflowCase = typeof cases[number];

async function load(file: string): Promise<Workflow> {
  return parseDocument(await readFile(path.join(repoRoot, file), 'utf8')).toJSON() as Workflow;
}

function steps(workflow: Workflow): any[] {
  return workflow.jobs.publish.steps;
}

function byId(workflow: Workflow, id: string): any {
  return steps(workflow).find((step) => step.id === id);
}

function indexOf(workflow: Workflow, idOrName: string): number {
  return steps(workflow).findIndex((step) => step.id === idOrName || step.name === idOrName);
}

function sameInputs(step: any): Record<string, unknown> {
  return Object.fromEntries(sameImageKeys.map((key) => [ key, step.with[key] ]));
}

function runGuard(script: string, smoked: string, published: string): number | null {
  return spawnSync('/bin/bash', [ '-c', script ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '/dev/null', PUBLISHED_IMAGE_ID: published, SMOKED_IMAGE_ID: smoked },
  }).status;
}

describe.each(cases)('$name publish workflow image identity gate', (workflowCase: WorkflowCase) => {
  it('uses the same image inputs for local build and registry push', async () => {
    const workflow = await load(workflowCase.file);
    const build = byId(workflow, 'build');
    const push = byId(workflow, 'push');

    expect(build.uses).toBe(buildAction);
    expect(push.uses).toBe(buildAction);
    expect(build.with).toEqual(expect.objectContaining({
      context: '.',
      file: workflowCase.dockerfile,
      load: true,
      platforms: 'linux/amd64',
      push: false,
      tags: workflowCase.tags,
    }));
    if ('target' in workflowCase) {
      expect(build.with.target).toBe(workflowCase.target);
    }
    expect(push.with.push).toBe(true);
    expect(push.with.load).toBeUndefined();
    expect(sameInputs(push)).toEqual(sameInputs(build));
    expect(build.with['cache-from']).toBeDefined();
    expect(build.with['cache-to']).toBeDefined();
    expect(push.with['cache-to']).toBeUndefined();
    for (const arg of workflowCase.args) {
      expect(build.with['build-args']).toContain(arg);
      expect(push.with['build-args']).toContain(arg);
    }
  });

  it('orders publish after real gates and image identity verification', async () => {
    const workflow = await load(workflowCase.file);
    const orderedIndexes = [
      indexOf(workflow, 'build'),
      ...workflowCase.gates.map((gate) => indexOf(workflow, gate)),
      indexOf(workflow, 'push'),
      indexOf(workflow, 'image_identity'),
      indexOf(workflow, 'publish'),
    ];

    expect(orderedIndexes).not.toContain(-1);
    expect(orderedIndexes).toEqual([ ...orderedIndexes ].sort((a, b) => a - b));
  });

  it('resolves the immutable digest without shelling out to docker push', async () => {
    const workflow = await load(workflowCase.file);
    const publish = byId(workflow, 'publish');
    const runText = steps(workflow).map((step) => step.run).filter(Boolean).join('\n');

    expect(publish.run).toContain('docker buildx imagetools inspect "${tag}"');
    expect(publish.run).toContain(`echo "image=\${${workflowCase.imageEnv}}@\${digest}" >> "\${GITHUB_OUTPUT}"`);
    expect(runText).not.toMatch(/\bdocker\s+push\b/);
  });

  it('checks image id env wiring, format validation, and equality', async () => {
    const guard = byId(await load(workflowCase.file), 'image_identity');
    const good = `sha256:${'a'.repeat(64)}`;

    expect(guard.shell).toBe('bash');
    expect(guard.env).toEqual({
      SMOKED_IMAGE_ID: '${{ steps.build.outputs.imageid }}',
      PUBLISHED_IMAGE_ID: '${{ steps.push.outputs.imageid }}',
    });
    expect(guard.run).toContain('set -euo pipefail');
    expect(runGuard(guard.run, good, good)).toBe(0);
    expect(runGuard(guard.run, good, `sha256:${'b'.repeat(64)}`)).not.toBe(0);
    for (const invalid of [ '', 'not-a-sha', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}` ]) {
      expect(runGuard(guard.run, invalid, invalid), invalid).not.toBe(0);
    }
  });

  it('keeps the SDK build-mode condition on all SDK-only image steps', async () => {
    const workflow = await load(workflowCase.file);

    for (const id of [ 'build', 'push', 'image_identity' ]) {
      expect(byId(workflow, id).if).toBe(workflowCase.condition);
    }
  });
});
