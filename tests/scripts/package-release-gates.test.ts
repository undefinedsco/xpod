import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const testRoot = path.join(repoRoot, '.test-data', 'package-release-gates');

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createConsumerFixture(name: string): string {
  const consumerRoot = path.join(testRoot, name);
  const packageRoot = path.join(consumerRoot, 'node_modules', '@undefineds.co', 'xpod');

  writeJson(path.join(consumerRoot, 'package.json'), { name, private: true });
  writeJson(path.join(packageRoot, 'package.json'), {
    name: '@undefineds.co/xpod',
    version: '0.4.0-test',
    optionalDependencies: {},
    bin: { xpod: './bin/xpod.js' },
    exports: {
      './package.json': './package.json',
      './runtime': './runtime.js',
      './test-utils': './test-utils.js',
    },
  });
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'bin', 'xpod.js'), '#!/usr/bin/env node\nprocess.stdout.write("xpod help\\n");\n');
  writeFileSync(
    path.join(packageRoot, 'runtime.js'),
    'exports.startXpodRuntime = async () => ({ fetch: async () => ({ ok: true }), stop: async () => {} });\n',
  );
  writeFileSync(path.join(packageRoot, 'test-utils.js'), 'exports.startNoAuthXpod = async () => {};\n');
  return consumerRoot;
}

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('package release gates', () => {
  it('removes repository-only patch metadata from the published manifest and restores the source manifest', () => {
    const fixtureRoot = path.join(testRoot, 'manifest');
    const scriptsRoot = path.join(fixtureRoot, 'scripts');
    mkdirSync(scriptsRoot, { recursive: true });
    cpSync(
      path.join(repoRoot, 'scripts', 'prepare-package-manifest.cjs'),
      path.join(scriptsRoot, 'prepare-package-manifest.cjs'),
    );
    cpSync(
      path.join(repoRoot, 'scripts', 'platform-binaries.cjs'),
      path.join(scriptsRoot, 'platform-binaries.cjs'),
    );

    const sourceManifest = {
      name: '@undefineds.co/xpod',
      version: '0.4.0-test',
      scripts: {
        prepack: 'node scripts/prepare-package-manifest.cjs pack',
        postpack: 'node scripts/prepare-package-manifest.cjs restore',
        test: 'vitest',
      },
      optionalDependencies: {
        '@undefineds.co/xpod-darwin-arm64': '0.4.0-test',
        retained: '1.0.0',
      },
      patchedDependencies: {
        '@undefineds.co/models@0.2.53': 'patches/models.patch',
      },
    };
    const packageJsonPath = path.join(fixtureRoot, 'package.json');
    writeJson(packageJsonPath, sourceManifest);

    const pack = spawnSync(process.execPath, [ 'scripts/prepare-package-manifest.cjs', 'pack' ], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, XPOD_INCLUDE_PLATFORM_PACKAGES: '' },
    });
    expect(pack.status, pack.stderr).toBe(0);
    const packedManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    expect(packedManifest.patchedDependencies).toBeUndefined();
    expect(packedManifest.optionalDependencies).toEqual({ retained: '1.0.0' });

    const restore = spawnSync(process.execPath, [ 'scripts/prepare-package-manifest.cjs', 'restore' ], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    expect(restore.status, restore.stderr).toBe(0);
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(sourceManifest);
  });

  it('runs the explicit cross-platform package smoke when no native optional runtime is installed', () => {
    const consumerRoot = createConsumerFixture('core-consumer');
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'package-consumer-smoke.cjs'),
      consumerRoot,
      '--package-only',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: '',
        XPOD_QLEVER_SEMANTIC_FIXTURE_PATH: '',
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('[consumer-smoke] package-only ok:');
  });

  it('still rejects a full runtime smoke without the native optional runtime', () => {
    const consumerRoot = createConsumerFixture('qlever-consumer');
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'package-consumer-smoke.cjs'),
      consumerRoot,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: '',
        XPOD_QLEVER_SEMANTIC_FIXTURE_PATH: '',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Installed package is missing its platform QLever runtime');
  });

  it('builds UI artifacts before unit tests read generated static assets', () => {
    const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const buildUi = workflow.indexOf('name: Build UI artifacts');
    const unitTests = workflow.indexOf('name: Unit tests');

    expect(buildUi).toBeGreaterThan(-1);
    expect(buildUi).toBeLessThan(unitTests);
    expect(workflow).toContain('package-consumer-smoke.cjs "${{ runner.temp }}/xpod-package-smoke" --package-only');
    expect(workflow).toContain('package-consumer-smoke.cjs "${{ runner.temp }}/xpod-package-smoke-bun" --package-only');
  });
});
