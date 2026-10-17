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
    publishedImage: '${{ env.SDK_IMAGE }}@${{ steps.module_push.outputs.digest || steps.push.outputs.digest }}',
    dockerfile: '${{ steps.resolve.outputs.dockerfile }}',
    // The immutable commit tag plus the alias named for the QLever build inputs; the
    // local build and the registry push must carry the same names, because they must be
    // the same image.
    tags: [
      '${{ env.SDK_IMAGE }}:${{ steps.resolve.outputs.tag }}',
      '${{ env.SDK_IMAGE }}:${{ steps.sdk_inputs.outputs.tag }}',
    ].join('\n') + '\n',
    // One workflow-level value now feeds all three build steps, so the job count
    // is not repeated per step (and no longer halves the runner's four CPUs).
    args: [ 'XPOD_QLEVER_BUILD_JOBS=${{ env.XPOD_QLEVER_BUILD_JOBS }}', 'XPOD_QLEVER_PRIOR_SDK_IMAGE=${{ steps.resolve.outputs.prior_image }}' ],
    gates: [ 'Smoke the exact SDK image before publishing' ],
    condition: "steps.resolve.outputs.build == 'true' && needs.resolve_target.outputs.sdk_profile == 'service-trixie'",
    reuseInspect: 'docker buildx imagetools inspect "${tag}"',
  },
  {
    name: 'local runtime image',
    file: '.github/workflows/publish-qlever-local-runtime.yml',
    imageEnv: 'IMAGE',
    publishedImage: '${{ env.IMAGE }}@${{ steps.push.outputs.digest }}',
    dockerfile: '${{ steps.resolve.outputs.dockerfile }}',
    target: 'runtime',
    // 构建与推送必须打同一组名字：不可变提交标签 + 以构建输入命名的别名，
    // 后者正是「输入未变」时下一轮复用的依据。
    tags: [
      '${{ env.IMAGE }}:sha-${{ github.sha }}',
      '${{ env.IMAGE }}:${{ steps.inputs.outputs.tag }}',
    ].join('\n') + '\n',
    condition: "steps.resolve.outputs.build == 'true'",
    reuseInspect: 'docker buildx imagetools inspect "${IMAGE}:${{ steps.resolve.outputs.tag }}"',
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

it('module SDK orchestration rejects a different source before checkout and chains the exact SDK digest', async () => {
  const workflow = await load('.github/workflows/publish-qlever-runtime-sdk.yml');
  const source = byId(workflow, 'source');
  const temporary = mkdtempSync(path.join(repoRoot, '.test-data/sdk-source-guard-'));
  writeFileSync(path.join(temporary, 'event.json'), '{}');
  try {
    for (const [profile, requested, expected] of [
      ['module-bookworm-gcc12', 'a'.repeat(40), 0],
      ['module-bookworm-gcc12', 'b'.repeat(40), 64],
      ['service-trixie', 'b'.repeat(40), 0],
    ] as const) {
      const result = spawnSync('/bin/bash', ['-c', source.run], { encoding: 'utf8', env: {
        ...process.env, GITHUB_SHA: 'a'.repeat(40), REQUESTED_SOURCE_COMMIT: requested,
        SDK_PROFILE: profile, SDK_TARGET: 'linux-x64', GITHUB_EVENT_PATH: path.join(temporary, 'event.json'),
        GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: path.join(temporary, 'output'),
      } });
      expect(result.status, result.stderr).toBe(expected);
    }
    const materials = workflow.jobs.module_runtime_materials;
    expect(materials.needs).toEqual(['resolve_target', 'publish']);
    expect(materials.if).toBe("${{ needs.resolve_target.outputs.sdk_profile == 'module-bookworm-gcc12' }}");
    expect(materials.uses).toBe('./.github/workflows/build-qlever-linux-runtime.yml');
    expect(materials.with).toEqual({ target: '${{ needs.resolve_target.outputs.target }}',
      module_sdk_image: '${{ needs.publish.outputs.image }}',
      sdk_artifact_id: '${{ needs.publish.outputs.sdk_artifact_id }}',
      sdk_artifact_digest: '${{ needs.publish.outputs.sdk_artifact_digest }}',
      sdk_master_sha256: '${{ needs.publish.outputs.sdk_master_sha256 }}',
      sdk_master_bytes: '${{ needs.publish.outputs.sdk_master_bytes }}' });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

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

function runReusePublish(run: string, imageEnv: string): string {
  const testRoot = path.join(repoRoot, '.test-data');
  mkdirSync(testRoot, { recursive: true });
  const tempRoot = mkdtempSync(path.join(testRoot, 'qlever-reuse-test-'));
  try {
    const binRoot = path.join(tempRoot, 'bin');
    const output = path.join(tempRoot, 'github-output');
    const digest = `sha256:${'a'.repeat(64)}`;
    mkdirSync(binRoot);
    writeFileSync(path.join(binRoot, 'docker'), [
      '#!/bin/sh',
      'set -eu',
      'if [ "$1" != buildx ] || [ "$2" != imagetools ] || [ "$3" != inspect ] || [ -z "$4" ] || [ "$5" != --format ]; then',
      '  echo "unexpected docker args: $*" >&2',
      '  exit 42',
      'fi',
      `printf '"%s"\\n' "${digest}"`,
    ].join('\n'));
    chmodSync(path.join(binRoot, 'docker'), 0o755);
    // The runner substitutes ${{ }} before bash sees the step; do the same here so
    // the reuse branch runs exactly as the workflow would.
    const templated = run.replace(/\$\{\{[^}]*\}\}/g, (expression) =>
      expression.includes('resolve.outputs.tag') ? 'qlever-inputs-deadbeef00' : '');
    const result = spawnSync('/bin/bash', [ '-c', templated ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH}`,
        BUILD_IMAGE: 'false',
        GITHUB_OUTPUT: output,
        IMAGE: imageEnv === 'IMAGE' ? 'ghcr.io/acme/local' : '',
        PUSHED_DIGEST: '',
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
      platforms: '${{ needs.resolve_target.outputs.docker_platform }}',
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

    // 构建路径直接用已校验的 push digest；只有「输入未变、复用已发布镜像」的
    // 分支才 inspect 标签解析 digest。两条链现在形状一致。
    expect(publish.env).toEqual({
      BUILD_IMAGE: '${{ steps.resolve.outputs.build }}',
      PUSHED_DIGEST: workflowCase.imageEnv === 'SDK_IMAGE' ? '${{ steps.module_push.outputs.digest || steps.push.outputs.digest }}' : '${{ steps.push.outputs.digest }}',
    });
    expect(publish.run).toContain(workflowCase.reuseInspect);
    expect(publish.run).toContain('if [[ "${BUILD_IMAGE}" == \'true\' ]]; then');
    expect(publish.run).toContain(`echo "image=\${${workflowCase.imageEnv}}@\${digest}" >> "\${GITHUB_OUTPUT}"`);
    expect(output).toContain(`digest=sha256:${'f'.repeat(64)}`);
    expect(output).toContain(workflowCase.imageEnv === 'SDK_IMAGE' ? 'image=ghcr.io/acme/sdk@' : 'image=ghcr.io/acme/local@');
    expect(runText).not.toMatch(/\bdocker\s+push\b/);
  });

  it('resolves a reused image digest through one real inspect call', async () => {
    const publish = byId(await load(workflowCase.file), 'publish');
    const output = runReusePublish(publish.run, workflowCase.imageEnv);
    const digest = `sha256:${'a'.repeat(64)}`;
    const image = workflowCase.imageEnv === 'SDK_IMAGE' ? 'ghcr.io/acme/sdk' : 'ghcr.io/acme/local';

    // 复用分支必须把 --format 作为同一个 docker 调用的参数；行尾写成 `\\` 会让
    // shell 把它当成一条独立命令（exit 127）。这里真实执行该分支来锁住它。
    expect(output).toContain(`digest=${digest}`);
    expect(output).toContain(`image=${image}@${digest}`);
  });

  it('delegates image identity verification to the published-image CLI', async () => {
    const guard = byId(await load(workflowCase.file), 'image_identity');

    expect(guard.shell).toBe('bash');
    expect(guard.env).toEqual({
      SMOKED_IMAGE_ID: workflowCase.imageEnv === 'SDK_IMAGE' ? '${{ steps.module_build.outputs.imageid || steps.build.outputs.imageid }}' : '${{ steps.build.outputs.imageid }}',
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

describe('module SDK actual image gate', () => {
  it('uses the same builder, inputs and deadline and requires originals before upload', async () => {
    const workflow = await load('.github/workflows/publish-qlever-runtime-sdk.yml');
    const build = byId(workflow, 'module_build');
    const push = byId(workflow, 'module_push');
    for (const step of [build, push, byId(workflow, 'sdk_originals')]) {
      expect(step.if).toBe("needs.resolve_target.outputs.sdk_profile == 'module-bookworm-gcc12'");
    }
    expect(push.env).toEqual(build.env);
    expect(push.run.replace('py push ', 'py build ')).toBe(build.run);
    const indexes = ['module_build', 'module_push', 'publish', 'sdk_originals', 'sdk_upload'].map(id => indexOf(workflow, id));
    expect(indexes).not.toContain(-1);
    expect(indexes).toEqual([...indexes].sort((a,b) => a-b));
    const helper = await readFile(path.join(repoRoot, 'qlever/scripts/sdk-image-originals.py'), 'utf8');
    // The build step cannot return a published image ID before the actual smoke succeeds.
    expect(helper.indexOf("if mode=='build':smoke_and_copy(config,out,budget)")).toBeLessThan(helper.indexOf("output.write('imageid='"));
    expect(helper).toContain("config_digest,'/opt/qlever-sdk/build/qlever-server','--help'");
    expect(helper).toContain("build.get('containerimage.config.digest')!=observed['configDigest']");
    expect(helper).toContain("raise ValueError('SDK tested build/config identity mismatch')");
    const cacheGuard = steps(workflow).find(step => step.name === 'Require original SDK custody before module cache reuse');
    expect(cacheGuard.if).toContain("steps.resolve.outputs.build != 'true'");
    expect(cacheGuard.run).toContain('exit 64');
  });
});
