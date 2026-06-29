import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const adapterRoot = path.join(repoRoot, 'native/postgres/qlever_adapter');
const cmakeLists = path.join(adapterRoot, 'CMakeLists.txt');

function hasCmake(): boolean {
  try {
    execFileSync('/usr/bin/env', ['cmake', '--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
  });

  it('includes the CMake adapter build in the repository ABI check', () => {
    const scriptPath = path.join(repoRoot, 'scripts/check-rdf-physical-protocol-abi.cjs');
    const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(output).toContain('QLever adapter CMake target');
  });
});
