import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/check-qlever-full-engine-build.cjs');
const packageJsonPath = path.join(repoRoot, 'package.json');

describe('QLever full upstream engine build script', () => {
  it('is exposed as a package script', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['check:qlever-full-engine']).toBe('node scripts/check-qlever-full-engine-build.cjs');
  });

  it('prints the native-first CMake configuration without running build steps', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const output = execFileSync('node', [
      scriptPath,
      '--qlever-source',
      path.join(repoRoot, '.test-data/qlever-upstream'),
      '--build-dir',
      path.join(repoRoot, '.test-data/qlever-full-build'),
      '--dry-run',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    const parsed = JSON.parse(output) as { configureArgs: string[]; buildArgs: string[]; patchCheckArgs: string[] };
    expect(parsed.patchCheckArgs).toContain('scripts/check-qlever-upstream-patches.cjs');
    expect(parsed.configureArgs).toContain('-DCHEAPER_COMPILATION=ON');
    expect(parsed.configureArgs).toContain('-DUSE_PRECOMPILED_HEADERS=OFF');
    expect(parsed.configureArgs).toContain('-DUSE_IO_URING=OFF');
    expect(parsed.configureArgs.join('\n')).toContain('-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1');
    expect(parsed.configureArgs.join('\n')).toContain('native/postgres/qlever_adapter/src');
    expect(parsed.configureArgs.join('\n')).toContain('native/postgres/rdf_protocol/include');
    expect(parsed.buildArgs).toEqual(['--build', path.join(repoRoot, '.test-data/qlever-full-build'), '--target', 'engine', '-j2']);
  });

  it('adds pkg-config jemalloc library dirs to executable linker flags', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-pkg-config-'));
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
        '--build-dir',
        path.join(repoRoot, '.test-data/qlever-full-build'),
        '--dry-run',
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` },
      });

      const parsed = JSON.parse(output) as { configureArgs: string[] };
      expect(parsed.configureArgs).toContain('-DCMAKE_EXE_LINKER_FLAGS=-L/native/jemalloc/lib');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not pass architecture-incompatible jemalloc pkg-config paths to CMake', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-bad-jemalloc-'));
    try {
      const libdir = path.join(root, 'lib');
      await mkdir(libdir, { recursive: true });
      await writeFile(path.join(libdir, 'libjemalloc.dylib'), 'not a native library', 'utf8');
      const fakePkgConfig = path.join(root, 'pkg-config');
      await writeFile(fakePkgConfig, `#!/bin/sh
if [ "$1" = "--libs-only-L" ] && [ "$2" = "jemalloc" ]; then
  echo "-L${libdir}"
  exit 0
fi
if [ "$1" = "--variable=libdir" ] && [ "$2" = "jemalloc" ]; then
  echo "${libdir}"
  exit 0
fi
exit 1
`, 'utf8');
      chmodSync(fakePkgConfig, 0o755);

      const output = execFileSync('node', [
        scriptPath,
        '--qlever-source',
        path.join(repoRoot, '.test-data/qlever-upstream'),
        '--build-dir',
        path.join(repoRoot, '.test-data/qlever-full-build'),
        '--dry-run',
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` },
      });

      const parsed = JSON.parse(output) as { configureArgs: string[]; configureEnv?: Record<string, string> };
      expect(parsed.configureArgs.join('\n')).not.toContain(`-DCMAKE_EXE_LINKER_FLAGS=-L${libdir}`);
      if (process.platform === 'darwin' && existsSync('/opt/homebrew')) {
        expect(parsed.configureEnv?.PKG_CONFIG_LIBDIR).toBe('/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails clearly when the upstream source tree is not supplied', () => {
    let output = '';
    try {
      execFileSync('node', [scriptPath, '--dry-run'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
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
