import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { withBoundPublicationArchiveFile, preflightBoundPublicationArchiveFiles } from '../../scripts/lib/independent-admission/publication-archive-file';
const bytes = gzipSync(Buffer.alloc(1024));
const identity = { archiveBytes: bytes.length, archiveSha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
const roots = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-publication-archive-')).sort();
test('buffer and actual file get closed readonly exact snapshots then cleanup', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'publication-archive-input-'));
  const file = path.join(root, 'source.tgz'); fs.writeFileSync(file, bytes);
  try {
    for (const source of [{ kind: 'buffer' as const, bytes }, { kind: 'file' as const, path: file }]) {
      let target = '';
      const result = await withBoundPublicationArchiveFile(source, identity, async archive => {
        target = archive.path;
        expect(fs.readFileSync(target).equals(bytes)).toBe(true);
        expect(fs.statSync(target).mode & 0o777).toBe(0o400);
        expect(archive.identity).toEqual(identity); expect(Object.isFrozen(archive.identity)).toBe(true);
        return 42;
      });
      expect(result).toBe(42); expect(fs.existsSync(target)).toBe(false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('wrong digest never invokes operation and cleans created snapshot', async () => {
  const before = roots(); let invoked = false;
  await expect(withBoundPublicationArchiveFile({ kind: 'buffer', bytes }, { ...identity, archiveSha256: '0'.repeat(64) }, async () => { invoked = true; })).rejects.toThrow('digest');
  expect(invoked).toBe(false); expect(roots()).toEqual(before);
});
test('operation rejection rechecks snapshot and always cleans', async () => {
  let target = '';
  await expect(withBoundPublicationArchiveFile({ kind: 'buffer', bytes }, identity, async archive => {
    target = archive.path; throw new Error('controlled operation failure');
  })).rejects.toThrow('controlled operation failure');
  expect(fs.existsSync(target)).toBe(false);
});
test('mutation or path replacement is rejected after successful or failed operation', async () => {
  for (const rejected of [false, true]) {
    let target = '';
    await expect(withBoundPublicationArchiveFile({ kind: 'buffer', bytes }, identity, async archive => {
      target = archive.path; fs.chmodSync(target, 0o600); fs.writeFileSync(target, Buffer.alloc(bytes.length));
      if (rejected) throw Error('controlled rejection');
    })).rejects.toThrow(rejected ? 'custody changed' : 'snapshot path changed');
    expect(fs.existsSync(target)).toBe(false);
  }
});
test('source links and invalid sizes are rejected before operation', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'publication-archive-links-'));
  const file = path.join(root, 'source.tgz'), alias = path.join(root, 'alias'); fs.writeFileSync(file, bytes);
  try {
    fs.linkSync(file, alias);
    await expect(withBoundPublicationArchiveFile({ kind: 'file', path: file }, identity, async () => {})).rejects.toThrow('single-link');
    fs.unlinkSync(alias); fs.symlinkSync(file, alias);
    await expect(withBoundPublicationArchiveFile({ kind: 'file', path: alias }, identity, async () => {})).rejects.toThrow('linked');
    await expect(withBoundPublicationArchiveFile({ kind: 'buffer', bytes }, { ...identity, archiveBytes: 768 * 1024 ** 2 + 1 }, async () => {})).rejects.toThrow('identity');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('whole-group readonly preflight validates later identities before any snapshot writes', async () => {
  const before = roots(); let invoked = false;
  const rows = [{ source: { kind: 'buffer' as const, bytes }, identity },
    { source: { kind: 'buffer' as const, bytes }, identity: { ...identity, archiveSha256: '0'.repeat(64) } }];
  try {
    preflightBoundPublicationArchiveFiles(rows);
    await withBoundPublicationArchiveFile(rows[0].source, rows[0].identity, async () => { invoked = true; });
  } catch (error) { expect(String(error).includes('digest')).toBe(true); }
  expect(invoked).toBe(false); expect(roots()).toEqual(before);
  preflightBoundPublicationArchiveFiles([{ source: { kind: 'buffer', bytes }, identity }]);
  expect(() => preflightBoundPublicationArchiveFiles([])).toThrow('group');
  expect(() => preflightBoundPublicationArchiveFiles(Array.from({ length: 65 }, () => rows[0]))).toThrow('group');
});
test('whole-group preflight hashes real files and rejects a missing later file', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.test-data', 'publication-group-'));
  const file = path.join(root, 'source.tgz'); fs.writeFileSync(file, bytes);
  const before = roots();
  try {
    preflightBoundPublicationArchiveFiles([{ source: { kind: 'file', path: file }, identity }]);
    expect(() => preflightBoundPublicationArchiveFiles([{ source: { kind: 'file', path: file }, identity },
      { source: { kind: 'file', path: file + '.missing' }, identity }])).toThrow();
    expect(roots()).toEqual(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('unconfirmed publisher closure retains readonly snapshot and exact locator', async () => {
  let target = '';
  try {
    await withBoundPublicationArchiveFile({ kind: 'buffer', bytes }, identity, async archive => {
      target = archive.path;
      throw Object.assign(Error('supervisor closure unknown'), { retainArchiveSnapshot: true });
    });
    throw Error('expected failure');
  } catch (error: any) {
    try {
      expect(error.retainArchiveSnapshot).toBe(true);
      expect(error.retainedArchive.path).toBe(target);
      expect(fs.readFileSync(target).equals(bytes)).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o400);
      expect(JSON.parse(fs.readFileSync(path.join(path.dirname(target), 'retained-archive.json'), 'utf8'))).toEqual(error.retainedArchive);
    } finally { if (target) fs.rmSync(path.dirname(target), { recursive: true, force: true }); }
  }
});
