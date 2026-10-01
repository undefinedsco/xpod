import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { copyNativeNotices, type NativeNoticeIndex } from '../src/native-notices';
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
    const index: NativeNoticeIndex = { schemaVersion: 1, target: 'darwin-arm64', status: 'partial-collection', packages: [
      { name: 'one', version: '1', files: [{ object, sha256: hash }] },
      { name: 'two', version: '2', files: [{ object, sha256: hash }] },
    ] };
    const filename = path.join(input, 'darwin-arm64.json');
    writeFileSync(filename, JSON.stringify(index));
    const refused = path.join(work, 'refused');
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64')).toThrow('runtime notice provenance');
    expect(existsSync(refused)).toBe(false);
    index.runtimeNotices = { toolchain: 'nightly-2026-09-30', compilerCommit: 'a'.repeat(40), scope: 'fixture sysroot notice', files: [{ object, sha256: hash }] };
    writeFileSync(filename, JSON.stringify(index));
    const runtimeOutput = path.join(work, 'with-runtime');
    expect(copyNativeNotices(input, runtimeOutput, 'darwin-arm64').length).toBe(2);
    expect(readFileSync(path.join(runtimeOutput, object))).toEqual(readFileSync(seed));
    expect(JSON.parse(readFileSync(path.join(runtimeOutput, 'darwin-arm64.json'), 'utf8')).runtimeNotices).toEqual(index.runtimeNotices);
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64', { toolchain: 'nightly-2026-10-01', commit: 'a'.repeat(40) })).toThrow('runtime notice provenance');
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64', { toolchain: 'nightly-2026-09-30', commit: 'b'.repeat(40) })).toThrow('runtime notice provenance');
    index.runtimeNotices.compilerCommit = 'unknown';
    writeFileSync(filename, JSON.stringify(index));
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64')).toThrow('runtime notice provenance');
    expect(existsSync(refused)).toBe(false);
    index.runtimeNotices.compilerCommit = 'a'.repeat(40);
    index.runtimeNotices.files[0].object = '../outside';
    writeFileSync(filename, JSON.stringify(index));
    expect(() => copyNativeNotices(input, refused, 'darwin-arm64')).toThrow('Unsafe notice');
    index.runtimeNotices.files[0].object = object;
    writeFileSync(filename, JSON.stringify(index));
    writeFileSync(path.join(input, object), 'modified');
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
