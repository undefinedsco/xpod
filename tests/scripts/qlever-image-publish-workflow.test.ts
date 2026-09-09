import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    publishedImage: '${{ env.SDK_IMAGE }}@${{ steps.push.outputs.digest }}',
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
    publishedImage: '${{ env.IMAGE }}@${{ steps.push.outputs.digest }}',
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

function runFreshPublish(run: string, imageEnv: string): string {
  const testRoot = path.join(repoRoot, '.test-data');
  mkdirSync(testRoot, { recursive: true });
  const tempRoot = mkdtempSync(path.join(testRoot, 'qlever-publish-test-'));
  try {
    const binRoot = path.join(tempRoot, 'bin');
    const output = path.join(tempRoot, 'github-output');
    const pushedDigest = `sha256:${'f'.repeat(64)}`;
    mkdirSync(binRoot);
    writeFileSync(path.join(binRoot, 'docker'), '#!/bin/sh\nexit 42\n');
    chmodSync(path.join(binRoot, 'docker'), 0o755);
    const result = spawnSync('/bin/bash', [ '-c', run ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH}`,
        BUILD_IMAGE: 'true',
        GITHUB_OUTPUT: output,
        IMAGE: imageEnv === 'IMAGE' ? 'ghcr.io/acme/local' : '',
        PUSHED_DIGEST: pushedDigest,
        SDK_IMAGE: imageEnv === 'SDK_IMAGE' ? 'ghcr.io/acme/sdk' : '',
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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

  it('publishes the already verified push digest without fresh tag inspection', async () => {
    const workflow = await load(workflowCase.file);
    const publish = byId(workflow, 'publish');
    const runText = steps(workflow).map((step) => step.run).filter(Boolean).join('\n');
    const output = runFreshPublish(publish.run, workflowCase.imageEnv);

    if (workflowCase.imageEnv === 'SDK_IMAGE') {
      expect(publish.env).toEqual({
        BUILD_IMAGE: '${{ steps.resolve.outputs.build }}',
        PUSHED_DIGEST: '${{ steps.push.outputs.digest }}',
      });
      expect(publish.run).toContain('docker buildx imagetools inspect "${tag}"');
    } else {
      expect(publish.env).toEqual({ PUSHED_DIGEST: '${{ steps.push.outputs.digest }}' });
      expect(publish.run).not.toContain('docker buildx imagetools inspect "${tag}"');
    }
    expect(publish.run).toContain(`echo "image=\${${workflowCase.imageEnv}}@\${digest}" >> "\${GITHUB_OUTPUT}"`);
    expect(output).toContain(`digest=sha256:${'f'.repeat(64)}`);
    expect(output).toContain(workflowCase.imageEnv === 'SDK_IMAGE' ? 'image=ghcr.io/acme/sdk@' : 'image=ghcr.io/acme/local@');
    expect(runText).not.toMatch(/\bdocker\s+push\b/);
  });

  it('delegates image identity verification to the published-image CLI', async () => {
    const guard = byId(await load(workflowCase.file), 'image_identity');

    expect(guard.shell).toBe('bash');
    expect(guard.env).toEqual({
      SMOKED_IMAGE_ID: '${{ steps.build.outputs.imageid }}',
      PUBLISHED_IMAGE: workflowCase.publishedImage,
    });
    expect(guard.run.trimEnd()).toBe([
      'set -euo pipefail',
      'node scripts/verify-published-image.cjs "${SMOKED_IMAGE_ID}" "${PUBLISHED_IMAGE}"',
    ].join('\n'));
  });

  it('keeps the SDK build-mode condition on all SDK-only image steps', async () => {
    const workflow = await load(workflowCase.file);

    for (const id of [ 'build', 'push', 'image_identity' ]) {
      expect(byId(workflow, id).if).toBe(workflowCase.condition);
    }
  });
});
