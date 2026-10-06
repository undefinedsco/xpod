#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  parseTar,
  inspectTarballBuffer,
  comparePackagePayloads,
  readOctal,
  sha512Integrity,
  assertIntegrity,
  PROVENANCE_FIELDS,
} = require('../../scripts/workspace-package-payload.cjs');
const {
  planSharedPublication,
  assertSelectedIntegrity,
  readBoundedBody,
  selectMode,
} = require('../../scripts/publish-workspace-packages.cjs');

const SDK = '@undefineds.co/solid-sdk';

function header({ name, size, mode = 0o644, type = '0', linkname = '' }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(6, '0')} \0`, 100, 8);
  block.write('0000000\0', 108, 8);
  block.write('0000000\0', 116, 8);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  block.write('00000000000\0', 136, 12);
  block.write('        ', 148, 8);
  block.write(type, 156, 1);
  block.write(linkname, 157, 100);
  block.write('ustar\0', 257, 6);
  block.write('00', 263, 2);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function buildRawTar(entries, { endBlocks = 1024, trailing = Buffer.alloc(0) } = {}) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '');
    blocks.push(header({ ...entry, name: entry.path, size: entry.type === '5' ? 0 : content.length }));
    if (entry.type !== '5') {
      const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      content.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(endBlocks));
  if (trailing.length) blocks.push(trailing);
  return Buffer.concat(blocks);
}

function makeTarball(entries) {
  return zlib.gzipSync(buildRawTar(entries));
}

function manifestBytes({ version = '0.1.4', gitHead, extra = {} } = {}) {
  const manifest = {
    name: SDK,
    version,
    files: ['dist', 'README.md'],
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    ...extra,
  };
  if (gitHead !== undefined) manifest.gitHead = gitHead;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function baseEntries(options = {}) {
  return [
    { path: 'package/dist/index.js', content: 'export const value = 1;\n' },
    { path: 'package/dist/index.d.ts', content: 'export declare const value: number;\n' },
    { path: 'package/package.json', content: manifestBytes(options) },
  ];
}

function fakeResponse(chunks) {
  let index = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: Uint8Array.from(chunks[index++]) };
          },
          async cancel() {},
        };
      },
    },
  };
}

test('parses a gzipped workspace payload with exact names, types, modes and content', () => {
  const info = inspectTarballBuffer(makeTarball(baseEntries({ gitHead: 'a'.repeat(40) })));
  assert.deepEqual(info.entries.map((entry) => entry.path), [
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/package.json',
  ]);
  for (const entry of info.entries) {
    assert.equal(entry.type, 'file');
    assert.equal(entry.mode, 0o644);
  }
  assert.equal(info.manifest.version, '0.1.4');
});

test('content-equivalence ignores only the fixed gitHead provenance field', () => {
  assert.deepEqual(PROVENANCE_FIELDS, ['gitHead']);
  const published = makeTarball(baseEntries({ gitHead: 'd'.repeat(40) }));
  const local = makeTarball(baseEntries({ gitHead: '6'.repeat(40) }));
  const result = comparePackagePayloads(published, local);
  assert.equal(result.ok, true, result.reasons.join('; '));
  assert.deepEqual(result.reasons, []);
});

test('reason labels read published first, then packed local', () => {
  const published = baseEntries({ gitHead: 'd'.repeat(40) });
  const local = baseEntries({ gitHead: 'd'.repeat(40) });
  local[0] = { path: 'package/dist/index.js', content: 'export const value = 2;\n' };
  const reasons = comparePackagePayloads(makeTarball(published), makeTarball(local)).reasons.join('; ');
  assert.match(reasons, /dist\/index\.js: content changed/);
});

test('fails closed when a real member byte diverges', () => {
  const published = baseEntries({ gitHead: 'd'.repeat(40) });
  const local = baseEntries({ gitHead: 'd'.repeat(40) });
  local[0] = { path: 'package/dist/index.js', content: 'export const value = 2;\n' };
  const result = comparePackagePayloads(makeTarball(published), makeTarball(local));
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('; '), /dist\/index\.js/);
});

test('fails closed when an entry is added or removed', () => {
  const withExtra = baseEntries({ gitHead: 'd'.repeat(40) });
  withExtra.push({ path: 'package/dist/extra.js', content: 'export const extra = true;\n' });
  const added = comparePackagePayloads(makeTarball(baseEntries({ gitHead: 'd'.repeat(40) })), makeTarball(withExtra));
  assert.equal(added.ok, false);
  assert.match(added.reasons.join('; '), /only in local: package\/dist\/extra\.js/);
  const removed = comparePackagePayloads(makeTarball(withExtra), makeTarball(baseEntries({ gitHead: 'd'.repeat(40) })));
  assert.equal(removed.ok, false);
  assert.match(removed.reasons.join('; '), /only in published: package\/dist\/extra\.js/);
});

test('fails closed when modes differ', () => {
  const published = baseEntries({ gitHead: 'd'.repeat(40) });
  const local = baseEntries({ gitHead: 'd'.repeat(40) });
  local[0].mode = 0o755;
  const result = comparePackagePayloads(makeTarball(published), makeTarball(local));
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('; '), /mode/);
});

test('fails closed when manifest dependencies, exports, types, version or name change', () => {
  const cases = [
    { version: '0.1.5' },
    { extra: { name: '@undefineds.co/other' } },
    { extra: { exports: { '.': './dist/index.js' } } },
    { extra: { types: './dist/index.d.ts' } },
    { extra: { dependencies: { zustand: '^5.0.0' } } },
  ];
  for (const options of cases) {
    const local = options.extra?.name
      ? baseEntries({ gitHead: 'd'.repeat(40), extra: options.extra })
      : baseEntries({ gitHead: 'd'.repeat(40), ...options });
    const result = comparePackagePayloads(
      makeTarball(baseEntries({ gitHead: 'd'.repeat(40) })),
      makeTarball(local),
    );
    assert.equal(result.ok, false, JSON.stringify(options));
  }
});

test('rejects a corrupted gzip payload', () => {
  assert.throws(() => inspectTarballBuffer(zlib.gzipSync(Buffer.alloc(600))), /tar/i);
});

test('rejects a corrupted tar header checksum', () => {
  const raw = buildRawTar(baseEntries({ gitHead: 'd'.repeat(40) }));
  raw[130] = raw[130] ^ 0xff;
  assert.throws(() => parseTar(raw), /checksum|corrupt/i);
});

test('rejects a missing end-of-archive marker', () => {
  assert.throws(() => parseTar(buildRawTar(baseEntries({ gitHead: 'd'.repeat(40) }), { endBlocks: 0 })), /end-of-archive marker/);
});

test('rejects a partial final block after the end-of-archive marker', () => {
  assert.throws(() => parseTar(buildRawTar(baseEntries({ gitHead: 'd'.repeat(40) }), { trailing: Buffer.from([0]) })), /partial final block/);
});

test('rejects nonzero trailing data after the end-of-archive marker', () => {
  const trailing = Buffer.alloc(512);
  trailing[10] = 1;
  assert.throws(() => parseTar(buildRawTar(baseEntries({ gitHead: 'd'.repeat(40) }), { trailing })), /nonzero data/);
});

test('rejects duplicate entries', () => {
  const entries = baseEntries({ gitHead: 'd'.repeat(40) });
  entries.push({ path: 'package/dist/index.js', content: 'export const value = 9;\n' });
  assert.throws(() => parseTar(buildRawTar(entries)), /duplicate/i);
});

test('rejects path traversal and absolute member names', () => {
  const traversing = baseEntries({ gitHead: 'd'.repeat(40) });
  traversing.push({ path: 'package/../escape.js', content: 'x' });
  assert.throws(() => parseTar(buildRawTar(traversing)), /path|traversal/i);
  const absolute = baseEntries({ gitHead: 'd'.repeat(40) });
  absolute.push({ path: '/etc/passwd', content: 'x' });
  assert.throws(() => parseTar(buildRawTar(absolute)), /path|traversal/i);
});

test('rejects link and unsupported entry types', () => {
  const link = baseEntries({ gitHead: 'd'.repeat(40) });
  link.push({ path: 'package/dist/link.js', type: '2', linkname: 'index.js', content: '' });
  assert.throws(() => parseTar(buildRawTar(link)), /unsupported|link/i);
  const unsupported = baseEntries({ gitHead: 'd'.repeat(40) });
  unsupported.push({ path: 'package/dist/weird', type: 'Z', content: 'x' });
  assert.throws(() => parseTar(buildRawTar(unsupported)), /unsupported|link/i);
});

test('readOctal validates the entire field instead of an accepted prefix', () => {
  assert.equal(readOctal(Buffer.from('0000644\0', 'utf8'), 0, 8), 0o644);
  assert.equal(readOctal(Buffer.from('0000644 ', 'utf8'), 0, 8), 0o644);
  assert.equal(readOctal(Buffer.from('\0\0\0\0\0\0\0\0', 'utf8'), 0, 8), 0);
  assert.throws(() => readOctal(Buffer.from('00006448', 'utf8'), 0, 8), /invalid numeric field/);
  assert.throws(() => readOctal(Buffer.from('12g0000\0', 'utf8'), 0, 8), /invalid numeric field/);
});

test('assertIntegrity reports raw sha512 mismatches', () => {
  const bytes = makeTarball(baseEntries({ gitHead: 'd'.repeat(40) }));
  assert.equal(assertIntegrity(bytes, sha512Integrity(bytes), 'fixture'), sha512Integrity(bytes));
  assert.throws(() => assertIntegrity(bytes, 'sha512-AAAA', 'fixture'), /integrity mismatch/);
  assert.throws(() => assertIntegrity(bytes, undefined, 'fixture'), /sha512/);
});

test('readBoundedBody stops at the configured cap', async () => {
  assert.equal((await readBoundedBody(fakeResponse([[1, 2, 3]]), 4, 'fixture')).length, 3);
  await assert.rejects(() => readBoundedBody(fakeResponse([[1, 2, 3], [4, 5]]), 4, 'fixture'), /exceeded the 4 byte limit/);
});

test('planSharedPublication reuses a verified immutable version without reporting a publish', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-publication-'));
  try {
    const publishedPath = path.join(directory, 'published.tgz');
    const packedPath = path.join(directory, 'packed.tgz');
    const published = makeTarball(baseEntries({ gitHead: 'd'.repeat(40) }));
    fs.writeFileSync(publishedPath, published);
    fs.writeFileSync(packedPath, makeTarball(baseEntries({ gitHead: '6'.repeat(40) })));
    const plan = await planSharedPublication({
      manifests: [{ name: SDK, version: '0.1.4' }],
      packed: { [SDK]: packedPath },
      lookup: async () => ({ name: SDK, version: '0.1.4', dist: { integrity: sha512Integrity(published), tarball: 'https://example.test/solid-sdk-0.1.4.tgz' } }),
      materialize: async () => publishedPath,
    });
    assert.deepEqual(plan.publish, []);
    assert.deepEqual(plan.reuse, [SDK]);
    assert.equal(plan.mixed[SDK], publishedPath);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('planSharedPublication rejects prerelease or malformed versions before any mutation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-publication-'));
  try {
    const packedPath = path.join(directory, 'packed.tgz');
    fs.writeFileSync(packedPath, makeTarball(baseEntries({ gitHead: '6'.repeat(40) })));
    await assert.rejects(() => planSharedPublication({
      manifests: [{ name: SDK, version: '0.1.5-rc.1' }],
      packed: { [SDK]: packedPath },
      lookup: async () => null,
      materialize: async () => { throw new Error('must not download'); },
    }), /Invalid stable version/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('planSharedPublication fails closed and tells the operator to bump the shared version', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-publication-'));
  try {
    const publishedPath = path.join(directory, 'published.tgz');
    const packedPath = path.join(directory, 'packed.tgz');
    const published = makeTarball(baseEntries({ gitHead: 'd'.repeat(40) }));
    fs.writeFileSync(publishedPath, published);
    fs.writeFileSync(packedPath, makeTarball(baseEntries({ gitHead: 'd'.repeat(40), version: '0.1.5' })));
    await assert.rejects(() => planSharedPublication({
      manifests: [{ name: SDK, version: '0.1.4' }],
      packed: { [SDK]: packedPath },
      lookup: async () => ({ name: SDK, version: '0.1.4', dist: { integrity: sha512Integrity(published), tarball: 'https://example.test/solid-sdk-0.1.4.tgz' } }),
      materialize: async () => publishedPath,
    }), /bump the shared package version/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('planSharedPublication fails closed on a registry integrity mismatch', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-publication-'));
  try {
    const publishedPath = path.join(directory, 'published.tgz');
    const packedPath = path.join(directory, 'packed.tgz');
    fs.writeFileSync(publishedPath, makeTarball(baseEntries({ gitHead: 'd'.repeat(40) })));
    fs.writeFileSync(packedPath, makeTarball(baseEntries({ gitHead: 'd'.repeat(40) })));
    await assert.rejects(() => planSharedPublication({
      manifests: [{ name: SDK, version: '0.1.4' }],
      packed: { [SDK]: packedPath },
      lookup: async () => ({ name: SDK, version: '0.1.4', dist: { integrity: 'sha512-wrong', tarball: 'https://example.test/solid-sdk-0.1.4.tgz' } }),
      materialize: async () => publishedPath,
    }), /integrity mismatch/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('planSharedPublication binds a fresh version to the packed tarball for publication', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-publication-'));
  try {
    const packedPath = path.join(directory, 'packed.tgz');
    fs.writeFileSync(packedPath, makeTarball(baseEntries({ gitHead: '6'.repeat(40) })));
    const plan = await planSharedPublication({
      manifests: [{ name: SDK, version: '0.1.5' }],
      packed: { [SDK]: packedPath },
      lookup: async () => null,
      materialize: async () => { throw new Error('must not download an unpublished version'); },
    });
    assert.deepEqual(plan.reuse, []);
    assert.equal(plan.publish.length, 1);
    assert.equal(plan.publish[0].tarball, packedPath);
    assert.equal(plan.mixed[SDK], packedPath);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('assertSelectedIntegrity binds any selected mixed tarball to the registry integrity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-publication-'));
  try {
    const selectedPath = path.join(directory, 'selected.tgz');
    const bytes = makeTarball(baseEntries({ gitHead: '6'.repeat(40) }));
    fs.writeFileSync(selectedPath, bytes);
    assert.equal(
      assertSelectedIntegrity({ dist: { integrity: sha512Integrity(bytes) } }, selectedPath, SDK),
      sha512Integrity(bytes),
    );
    assert.throws(
      () => assertSelectedIntegrity({ dist: { integrity: 'sha512-other' } }, selectedPath, SDK),
      /Registry integrity mismatch/,
    );
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the preflight is read-only and rejects unknown arguments', () => {
  assert.equal(selectMode(['node', 'script']), 'publish');
  assert.equal(selectMode(['node', 'script', '--verify-only']), 'verify');
  assert.throws(() => selectMode(['node', 'script', '--verify-only', '--publish']), /Only --verify-only/);
});
