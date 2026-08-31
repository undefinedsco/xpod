import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'scripts/check-pack-json.cjs');

function writePackJson(files: Array<{ path: string; size: number }>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'xpod-pack-check-'));
  const packJson = path.join(directory, 'pack.json');
  writeFileSync(packJson, JSON.stringify([{
    filename: 'undefineds.co-xpod-test.tgz',
    size: files.reduce((sum, file) => sum + file.size, 0),
    unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
    files,
  }]));
  return packJson;
}

describe('npm package boundary', () => {
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
