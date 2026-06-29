import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const adapterRoot = path.join(repoRoot, 'native/postgres/qlever_adapter');
const cmakeLists = path.join(adapterRoot, 'CMakeLists.txt');
const qleverBridgeSource = path.join(adapterRoot, 'src/XpodQleverBridge.cpp');
const nativeBuildTimeoutMs = 30_000;

function hasCmake(): boolean {
  try {
    execFileSync('/usr/bin/env', ['cmake', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function cmakeFailureOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  return [failure.stdout, failure.stderr, failure.message]
    .filter(Boolean)
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
    .join('\n');
}

describe('native QLever adapter CMake target', () => {
  it('configures and builds the adapter facade as a native library', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);
    expect(existsSync(cmakeLists)).toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-cmake-'));
    try {
      const buildDir = path.join(root, 'build');
      execFileSync('cmake', ['-S', adapterRoot, '-B', buildDir, '-DXPOD_QLEVER_ADAPTER_BUILD_SHARED=OFF'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      execFileSync('cmake', ['--build', buildDir, '--target', 'xpod_qlever_adapter'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('includes the CMake adapter build in the repository ABI check', () => {
    const scriptPath = path.join(repoRoot, 'scripts/check-rdf-physical-protocol-abi.cjs');
    const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('QLever adapter CMake target');
  }, nativeBuildTimeoutMs);

  it('fails clearly when QLever mode is enabled without a source tree', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-required-'));
    try {
      const buildDir = path.join(root, 'build');
      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', buildDir,
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('XPOD_QLEVER_SOURCE_DIR is required');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('accepts an explicit QLever source tree when the required native headers exist', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);
    expect(existsSync(qleverBridgeSource)).toBe(true);
    expect(readFileSync(cmakeLists, 'utf8')).toContain('src/XpodQleverBridge.cpp');

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-present-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/index'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryPlanner.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/IndexScan.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Index.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/index/Permutation.h'), `
#pragma once
class Permutation {
 public:
  enum struct Enum { PSO, POS, SPO, SOP, OPS, OSP };
};
`, 'utf8');

      const buildDir = path.join(root, 'build');
      execFileSync('cmake', [
        '-S', adapterRoot,
        '-B', buildDir,
        '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
        `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
      ], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      execFileSync('cmake', ['--build', buildDir, '--target', 'xpod_qlever_adapter'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);

  it('rejects a QLever source tree missing lower-level planner and index headers', async () => {
    expect(hasCmake(), 'cmake is required for native adapter build check').toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-qlever-adapter-source-incomplete-'));
    try {
      const qleverSource = path.join(root, 'qlever');
      await mkdir(path.join(qleverSource, 'src/libqlever'), { recursive: true });
      await mkdir(path.join(qleverSource, 'src/engine'), { recursive: true });
      await writeFile(path.join(qleverSource, 'src/libqlever/Qlever.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/QueryExecutionContext.h'), '#pragma once\n', 'utf8');
      await writeFile(path.join(qleverSource, 'src/engine/RuntimeInformation.h'), '#pragma once\n', 'utf8');

      let output = '';
      try {
        execFileSync('cmake', [
          '-S', adapterRoot,
          '-B', path.join(root, 'build'),
          '-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON',
          `-DXPOD_QLEVER_SOURCE_DIR=${qleverSource}`,
        ], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        output = cmakeFailureOutput(error);
      }
      expect(output).toContain('engine/QueryPlanner.h');
      expect(output).toContain('index/Index.h');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, nativeBuildTimeoutMs);
});
