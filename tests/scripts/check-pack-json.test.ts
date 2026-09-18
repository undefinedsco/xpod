import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'scripts/check-pack-json.cjs');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writePackJson(files: Array<{ path: string; size: number }>, unpackedSize?: number): string {
  const testRoot = path.join(root, '.test-data');
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, 'xpod-pack-check-'));
  directories.push(directory);
  const packJson = path.join(directory, 'pack.json');
  writeFileSync(packJson, JSON.stringify([{
    filename: 'undefineds.co-xpod-test.tgz',
    size: files.reduce((sum, file) => sum + file.size, 0),
    unpackedSize: unpackedSize ?? files.reduce((sum, file) => sum + file.size, 0),
    files,
  }]));
  return packJson;
}

describe('npm package boundary', () => {
  it('permits the measured runtime payload but rejects a byte beyond the 48 MiB unpacked budget', () => {
    const env = { ...process.env };
    delete env.XPOD_MAX_UNPACKED_SIZE_MB;
    delete env.XPOD_MAX_PACKED_SIZE_MB;
    const files = [{ path: 'dist/index.js', size: 100 }];
    expect(() => execFileSync(process.execPath, [checker, writePackJson(files, 48 * 1024 * 1024)], {
      cwd: root, env, stdio: 'pipe',
    })).not.toThrow();
    expect(() => execFileSync(process.execPath, [checker, writePackJson(files, 48 * 1024 * 1024 + 1)], {
      cwd: root, env, stdio: 'pipe',
    })).toThrow(/Unpacked tarball too large/u);
  });
  it.each([
    'node_modules/auth/dist/index.js.map',
    'node_modules/auth/node_modules/external/index.d.ts.map',
    'node_modules/auth/dist/tsconfig.tsbuildinfo',
  ])('rejects bundled compiler diagnostics: %s', (file) => {
    const packJson = writePackJson([{ path: file, size: 100 }]);
    expect(() => execFileSync(process.execPath, [checker, packJson], { cwd: root, stdio: 'pipe' }))
      .toThrow(/(?:Source map|Build cache) leaked into npm tarball/u);
  });
  it('rejects compiler source maps from the runtime tarball', () => {
    const packJson = writePackJson([
      { path: 'dist/index.js', size: 100 },
      { path: 'dist/index.js.map', size: 200 },
    ]);

    expect(() => execFileSync(process.execPath, [checker, packJson], {
      cwd: root,
      stdio: 'pipe',
    })).toThrow(/Source map leaked into npm tarball: dist\/index\.js\.map/u);
  });
});
