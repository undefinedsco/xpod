import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const requireFromRepo = createRequire(`${repoRoot}/package.json`);
const platformBinaries = requireFromRepo('./scripts/platform-binaries.cjs') as {
  QLEVER_LOCAL_RUNTIME_ENV: string;
  QLEVER_LOCAL_RUNTIME_RELATIVE_PATH: string;
  resolvePlatformTarget(target: string): {
    packageName: string;
  };
};
const buildPlatformPackage = requireFromRepo('./scripts/build-platform-package.cjs') as {
  copyQleverRuntimeArtifact(stageDir: string, artifactPath: string): string;
  createStagePackageJson(rootPackage: Record<string, unknown>, target: { packageName: string; os: string[]; cpu: string[]; binaryName: string }): Record<string, unknown>;
  resolveQleverRuntimeArtifactPath(options?: { qleverRuntimeArtifactPath?: string }): string;
};
const xpodLauncher = requireFromRepo('./bin/xpod.js') as {
  createPlatformEnvForPackage(platformPackage: { qleverLocalRuntimePath?: string } | undefined, baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};

const testRoot = path.join(repoRoot, '.test-data', 'local-runtime-delivery');

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('local runtime delivery contract', () => {
  it('keeps every remote QLever build script visible to Git', () => {
    const scripts = [
      'qlever/scripts/build-qlever-runtime-sdk.sh',
      'qlever/scripts/resolve-runtime-sdk-build.sh',
      'qlever/scripts/run-focused-native-build.sh',
    ];

    for (const script of scripts) {
      expect(existsSync(path.join(repoRoot, script))).toBe(true);
      const result = spawnSync('git', ['check-ignore', '--no-index', '-q', script], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status, `${script} is hidden by .gitignore: ${result.stderr}`).toBe(1);
    }
  });

  it('makes the product Docker image consume an immutable QLever runtime image on Debian glibc', () => {
    const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    const release = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');

    expect(dockerfile).toContain('ARG XPOD_QLEVER_LOCAL_RUNTIME_IMAGE');
    expect(dockerfile).toContain('FROM ${XPOD_QLEVER_LOCAL_RUNTIME_IMAGE} AS qlever-local-runtime');
    expect(dockerfile).toContain('XPOD_QLEVER_LOCAL_RUNTIME_IMAGE must be an immutable @sha256 image reference');
    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS node-runtime');
    expect(dockerfile).toContain('FROM qlever-local-runtime AS runtime');
    expect(dockerfile).toContain('COPY --from=node-runtime /usr/local /usr/local');
    expect(dockerfile).toContain('ENTRYPOINT []');
    expect(dockerfile).toContain('XPOD_QLEVER_LOCAL_RUNTIME_COMMAND=/opt/xpod/qlever/bin/xpod_qlever_local_runtime');
    expect(dockerfile).not.toContain('node:22-alpine');
    expect(dockerfile).not.toContain('oven/bun:1.3.8-alpine');

    expect(release).toContain('uses: ./.github/workflows/publish-qlever-runtime-sdk.yml');
    expect(release).toContain('uses: ./.github/workflows/publish-qlever-local-runtime.yml');
    expect(release).toContain('prior_sdk_image: ${{ needs.publish-qlever-runtime-sdk.outputs.image }}');
    expect(release).toContain('XPOD_QLEVER_LOCAL_RUNTIME_IMAGE=${{ needs.publish-qlever-local-runtime.outputs.image }}');
  });

  it('requires an explicit QLever runtime artifact before staging a platform package', () => {
    expect(() => buildPlatformPackage.resolveQleverRuntimeArtifactPath({
      qleverRuntimeArtifactPath: path.join(testRoot, 'missing-runtime'),
    })).toThrow(/QLever local runtime artifact does not exist/);
    expect(() => buildPlatformPackage.resolveQleverRuntimeArtifactPath()).toThrow(
      /Missing QLever local runtime artifact/,
    );
  });

  it('declares and copies the QLever runtime next to the platform package binary', async () => {
    const stageDir = path.join(testRoot, 'stage');
    const artifactPath = path.join(testRoot, 'artifact', 'xpod_qlever_local_runtime');
    await mkdir(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, '#!/bin/sh\n');
    await chmod(artifactPath, 0o755);

    const target = platformBinaries.resolvePlatformTarget('linux-x64-gnu');
    const packageJson = buildPlatformPackage.createStagePackageJson({
      name: '@undefineds.co/xpod',
      version: '0.0.0-test',
      license: 'MIT',
    }, {
      ...target,
      os: ['linux'],
      cpu: ['x64'],
      binaryName: 'xpod',
    });
    const copiedPath = buildPlatformPackage.copyQleverRuntimeArtifact(stageDir, artifactPath);

    expect(packageJson.files).toContain(platformBinaries.QLEVER_LOCAL_RUNTIME_RELATIVE_PATH);
    expect(packageJson.xpodQleverLocalRuntime).toBe(`./${platformBinaries.QLEVER_LOCAL_RUNTIME_RELATIVE_PATH}`);
    expect(copiedPath).toBe(path.join(stageDir, platformBinaries.QLEVER_LOCAL_RUNTIME_RELATIVE_PATH));
    expect(existsSync(copiedPath)).toBe(true);
  });

  it('passes the package-local runtime path through the launcher env without overriding explicit env', () => {
    const runtimePath = '/platform-package/qlever/bin/xpod_qlever_local_runtime';
    const env = xpodLauncher.createPlatformEnvForPackage({
      qleverLocalRuntimePath: runtimePath,
    }, {});

    expect(env[platformBinaries.QLEVER_LOCAL_RUNTIME_ENV]).toBe(runtimePath);
    expect(xpodLauncher.createPlatformEnvForPackage({
      qleverLocalRuntimePath: runtimePath,
    }, {
      [platformBinaries.QLEVER_LOCAL_RUNTIME_ENV]: '/explicit/runtime',
    })[platformBinaries.QLEVER_LOCAL_RUNTIME_ENV]).toBe('/explicit/runtime');
  });
});
