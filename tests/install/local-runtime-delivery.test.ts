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
  extractQleverRuntimeArtifact(stageDir: string, artifactPath: string): string;
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
      'qlever/scripts/build-macos-local-runtime.sh',
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

  it('runs semantic plus FTS/VEC conformance against the installed optional runtime', () => {
    const smoke = readFileSync(path.join(repoRoot, 'scripts/package-consumer-smoke.cjs'), 'utf8');

    expect(smoke).toContain('resolveInstalledQleverRuntime');
    expect(smoke).toContain("dist', 'acceptance', 'run-installed-qlever-conformance.js");
    expect(smoke).toContain("XPOD_QLEVER_CONFORMANCE_BACKEND: 'sqlite'");
    expect(smoke).toContain('XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntimePath');
    expect(smoke).toContain('report.semantic?.failed?.length !== 0');
  });

  it('makes the product Docker image consume an immutable QLever runtime image on Debian glibc', () => {
    const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    const candidate = readFileSync(path.join(repoRoot, '.github/workflows/candidate.yml'), 'utf8');

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

    expect(candidate).toContain('uses: ./.github/workflows/publish-qlever-runtime-sdk.yml');
    expect(candidate).toContain('uses: ./.github/workflows/publish-qlever-local-runtime.yml');
    expect(candidate).toContain('prior_sdk_image: ${{ needs.publish_qlever_runtime_sdk.outputs.image }}');
    expect(candidate).toContain('XPOD_QLEVER_LOCAL_RUNTIME_IMAGE=${{ needs.publish_qlever_local_runtime.outputs.image }}');
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
    const artifactRoot = path.join(testRoot, 'artifact');
    const artifactRuntime = path.join(artifactRoot, 'bin', 'xpod_qlever_local_runtime');
    const artifactPath = path.join(testRoot, 'qlever-runtime.tar.gz');
    await mkdir(path.dirname(artifactRuntime), { recursive: true });
    writeFileSync(artifactRuntime, '#!/bin/sh\n');
    await chmod(artifactRuntime, 0o755);
    expect(spawnSync('tar', [ '-czf', artifactPath, '-C', artifactRoot, '.' ]).status).toBe(0);

    const target = platformBinaries.resolvePlatformTarget('darwin-arm64');
    const packageJson = buildPlatformPackage.createStagePackageJson({
      name: '@undefineds.co/xpod',
      version: '0.0.0-test',
      license: 'MIT',
    }, {
      ...target,
      os: ['darwin'],
      cpu: ['arm64'],
      binaryName: 'xpod',
    });
    const copiedPath = buildPlatformPackage.extractQleverRuntimeArtifact(stageDir, artifactPath);

    expect(packageJson.files).toContain('qlever');
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
