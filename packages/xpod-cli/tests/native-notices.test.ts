import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { copyNativeNotices } from '../src/native-notices';
import { sha256File } from '../src/manifest';

test('copies exact originals, deduplicates content and refuses drift, unsafe paths and wrong targets', () => {
  const root = path.resolve('.test-data/xpod-cli/native-notices');
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(path.join(root, 'copy-'));
  try {
    const input = path.join(work, 'input');
    mkdirSync(path.join(input, 'objects'), { recursive: true });
    const seed = path.join(work, 'seed');
    writeFileSync(seed, 'Original copyright notice\r\n');
    const hash = sha256File(seed);
    const object = `objects/${hash}.txt`;
    writeFileSync(path.join(input, object), readFileSync(seed));
    const index = { schemaVersion: 1, target: 'darwin-arm64', status: 'partial-collection', packages: [
      { name: 'one', version: '1', files: [{ object, sha256: hash }] },
      { name: 'two', version: '2', files: [{ object, sha256: hash }] },
    ] };
    const filename = path.join(input, 'darwin-arm64.json');
    writeFileSync(filename, JSON.stringify(index));
    const output = path.join(work, 'output');
    expect(copyNativeNotices(input, output, 'darwin-arm64').length).toBe(2);
    expect(readFileSync(path.join(output, object))).toEqual(readFileSync(seed));
    writeFileSync(path.join(input, object), 'modified');
    const refused = path.join(work, 'refused');
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64')).toThrow('hash mismatch');
    expect(existsSync(refused)).toBe(false);
    index.packages[0].files[0].object = '../../outside';
    writeFileSync(filename, JSON.stringify(index));
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64')).toThrow('Unsafe notice');
    index.target = 'linux-arm64';
    writeFileSync(filename, JSON.stringify(index));
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64')).toThrow('Invalid native');
    expect(() => copyNativeNotices(input, refused, '../../escape')).toThrow('Unsupported build target');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
