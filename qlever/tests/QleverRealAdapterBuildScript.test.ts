import { chmodSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { cleanQleverEnv } from './qleverTestEnv';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'qlever/scripts/check-qlever-real-adapter-build.cjs');
const packageJsonPath = path.join(repoRoot, 'package.json');

describe('QLever real adapter build script', () => {
  it('is exposed as a package script', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['check:qlever-real-adapter']).toBe('node qlever/scripts/check-qlever-real-adapter-build.cjs');
  });

  it('prints the upstream configure and real adapter build commands without running them', () => {
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      path.join(repoRoot, '.test-data/qlever-upstream'),
      '--qlever-build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--adapter-build-dir',
      path.join(repoRoot, '.test-data/qlever-real-adapter-build'),
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

    const parsed = JSON.parse(output) as {
      patchCheckArgs: string[];
      upstreamConfigureArgs: string[];
      adapterConfigureArgs: string[];
      adapterBuildArgs: string[];
    };
    expect(parsed.patchCheckArgs).toContain('scripts/check-qlever-upstream-patches.cjs');
    expect(parsed.upstreamConfigureArgs).toContain('-DCMAKE_EXPORT_COMPILE_COMMANDS=ON');
    expect(parsed.upstreamConfigureArgs.join('\n')).toContain('-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1');
    expect(parsed.adapterConfigureArgs).toContain('-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON');
    expect(parsed.adapterConfigureArgs).toContain(`-DXPOD_QLEVER_SOURCE_DIR=${path.join(repoRoot, '.test-data/qlever-upstream')}`);
    expect(parsed.adapterBuildArgs).toEqual([
      '--build',
      path.join(repoRoot, '.test-data/qlever-real-adapter-build'),
      '--target',
      'xpod_qlever_adapter',
      '-j2',
    ]);
  });

  it('extracts dependency include dirs from a QLever compile_commands.json', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-compile-commands-'));
    try {
      const includeA = path.join(root, 'absl');
      const includeB = path.join(root, 'range v3');
      const includeC = path.join(root, 're2');
      const compileCommands = path.join(root, 'compile_commands.json');
      await mkdir(includeA, { recursive: true });
      await mkdir(includeB, { recursive: true });
      await mkdir(includeC, { recursive: true });
      await writeFile(compileCommands, JSON.stringify([
        {
          directory: root,
          command: `c++ -I${includeA} -isystem "${includeB}" -I ${includeC} -I${includeA} file.cpp`,
          file: 'file.cpp',
        },
      ]), 'utf8');

      const output = execFileSync('node', [
        scriptPath,
        '--qlever-source',
        path.join(repoRoot, '.test-data/qlever-upstream'),
        '--qlever-build-dir',
        path.join(repoRoot, '.test-data/qlever-full-build'),
        '--adapter-build-dir',
        path.join(repoRoot, '.test-data/qlever-real-adapter-build'),
        '--compile-commands',
        compileCommands,
        '--dry-run',
        '--json',
      ], { cwd: repoRoot, encoding: 'utf8', env: cleanQleverEnv() });

      const parsed = JSON.parse(output) as { adapterConfigureArgs: string[] };
      expect(parsed.adapterConfigureArgs).toContain(
        `-DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS=${[includeA, includeB, includeC].join(';')}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes through architecture-safe jemalloc settings to upstream configure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-real-adapter-pkg-config-'));
    try {
      const fakePkgConfig = path.join(root, 'pkg-config');
      await writeFile(fakePkgConfig, `#!/bin/sh
if [ "$1" = "--libs-only-L" ] && [ "$2" = "jemalloc" ]; then
  echo "-L/native/jemalloc/lib"
  exit 0
fi
if [ "$1" = "--variable=libdir" ] && [ "$2" = "jemalloc" ]; then
  echo "/native/jemalloc/lib"
  exit 0
fi
exit 1
`, 'utf8');
      chmodSync(fakePkgConfig, 0o755);

      const output = execFileSync('node', [
        scriptPath,
        '--qlever-source',
        path.join(repoRoot, '.test-data/qlever-upstream'),
        '--dry-run',
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: cleanQleverEnv({ PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` }),
      });

      const parsed = JSON.parse(output) as { upstreamConfigureArgs: string[] };
      expect(parsed.upstreamConfigureArgs).toContain('-DCMAKE_EXE_LINKER_FLAGS=-L/native/jemalloc/lib');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails clearly when the upstream source tree is not supplied', () => {
    let output = '';
    const env = cleanQleverEnv();
    try {
      execFileSync('node', [scriptPath, '--dry-run'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', env });
    } catch (error) {
      const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      output = [failure.stdout, failure.stderr, failure.message]
        .filter(Boolean)
        .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
        .join('\n');
    }
    expect(output).toContain('missing --qlever-source or XPOD_QLEVER_SOURCE_DIR');
  });
});
