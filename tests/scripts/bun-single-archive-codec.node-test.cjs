/** The embedded native payload codec must be LOSSLESS and strict. It replaces a
 * JSON+base64 representation with a raw-byte container so Brotli compresses the
 * actual payload; nothing may be lost, reordered, or silently truncated, and a
 * malformed archive must be rejected rather than half-extracted.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');
const {
  encodeArchive, decodeArchive, MAGIC, HEADER_BYTES,
} = require('../../scripts/lib/bun-single-archive.cjs');

const root = path.resolve(__dirname, '../..');

function fixture() {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  return fs.mkdtempSync(path.join(root, '.test-data/archive-codec-'));
}

function sampleEntries() {
  return [
    { path: 'dist/__cli__.cjs', content: Buffer.from('console.log(1)\n'), mode: 0o644 },
    // Binary content with NUL, high bytes and CRLF must survive untouched.
    { path: 'data.bin', content: Buffer.from([0, 255, 17, 128, 10, 13, 0, 0, 7]), mode: 0o600 },
    { path: 'native-fixture', content: Buffer.from('#!/bin/sh\nprintf native-ok'), mode: 0o755 },
    { path: 'node_modules/@fixture/runtime/index.cjs', content: Buffer.from('exports.x=1;'), mode: 0o644 },
    // A UTF-8 path and an empty file are both legal and must round trip.
    { path: 'docs/日本語.md', content: Buffer.from('# 文档\n', 'utf8'), mode: 0o644 },
    { path: 'empty.txt', content: Buffer.alloc(0), mode: 0o444 },
  ];
}

test('round trips every entry: exact path, bytes, mode and sorted order', () => {
  const dir = fixture();
  try {
    const entries = sampleEntries();
    const { container } = encodeArchive(entries);
    const decoded = decodeArchive(container);
    assert.equal(decoded.length, entries.length);
    // Sorted by path, exactly as the encoder normalises.
    const expectedOrder = [...entries].map((entry) => entry.path).sort();
    assert.deepEqual(decoded.map((entry) => entry.path), expectedOrder);
    for (const original of entries) {
      const found = decoded.find((entry) => entry.path === original.path);
      assert.ok(found, `missing ${original.path}`);
      assert.equal(found.mode, original.mode, `mode for ${original.path}`);
      assert.deepEqual(found.content, original.content, `bytes for ${original.path}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('survives a Brotli round trip byte for byte', () => {
  const dir = fixture();
  try {
    const entries = sampleEntries();
    const { container } = encodeArchive(entries);
    const compressed = zlib.brotliCompressSync(container, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
    assert.ok(compressed.length > 0);
    const decoded = decodeArchive(zlib.brotliDecompressSync(compressed));
    for (const original of entries) {
      const found = decoded.find((entry) => entry.path === original.path);
      assert.deepEqual(found.content, original.content);
      assert.equal(found.mode, original.mode);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a foreign magic instead of guessing the old JSON format', () => {
  const dir = fixture();
  try {
    const { container } = encodeArchive(sampleEntries());
    assert.equal(container.subarray(0, 8).toString('latin1'), MAGIC);
    const wrong = Buffer.from(container);
    wrong.write('XPODAR02', 0, 'latin1');
    assert.throws(() => decodeArchive(wrong), /magic/u);
    // The historical JSON+base64 array is NOT accepted by this reader.
    const legacy = Buffer.from(JSON.stringify([{ path: 'a', contentBase64: 'AA==', mode: 420 }]));
    assert.throws(() => decodeArchive(legacy), /magic|shorter/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects truncation at every boundary', () => {
  const dir = fixture();
  try {
    const { container } = encodeArchive(sampleEntries());
    // Header shorter than the fixed prefix.
    assert.throws(() => decodeArchive(container.subarray(0, 6)), /shorter/u);
    // Metadata length claims more than the buffer holds.
    const cutMeta = Buffer.from(container);
    cutMeta.writeUInt32LE(container.length, 8);
    assert.throws(() => decodeArchive(cutMeta), /short?er|truncated|invalid/u);
    // Body truncated after a valid header+metadata.
    assert.throws(() => decodeArchive(container.subarray(0, container.length - 1)), /truncated|trailing/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects tampered metadata: path escape, order, duplicate, mode, length', () => {
  const dir = fixture();
  try {
    const entries = sampleEntries();
    const { container } = encodeArchive(entries);
    const metadataLength = container.readUInt32LE(8);
    const meta = JSON.parse(container.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength).toString('utf8'));
    const rebuild = (mutated) => {
      const bytes = Buffer.from(JSON.stringify(mutated));
      const head = Buffer.alloc(HEADER_BYTES);
      head.write(MAGIC, 0, 'latin1');
      head.writeUInt32LE(bytes.length, 8);
      return Buffer.concat([head, bytes, container.subarray(HEADER_BYTES + metadataLength)]);
    };
    assert.throws(() => decodeArchive(rebuild(meta.map((item, index) => (index === 0 ? { ...item, path: '../escape' } : item)))), /dot segments/u);
    assert.throws(() => decodeArchive(rebuild(meta.map((item, index) => (index === 0 ? { ...item, path: '/abs' } : item)))), /must be relative/u);
    if (meta.length > 1) {
      const swapped = [...meta];
      [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
      assert.throws(() => decodeArchive(rebuild(swapped)), /strict path order/u);
      assert.throws(() => decodeArchive(rebuild([...meta, meta[0]])), /order|duplicated/u);
    }
    assert.throws(() => decodeArchive(rebuild(meta.map((item, index) => (index === 0 ? { ...item, mode: 0o7777 } : item)))), /mode/u);
    assert.throws(() => decodeArchive(rebuild(meta.map((item, index) => (index === 0 ? { ...item, length: -1 } : item)))), /length/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('encoder refuses duplicate paths and unsafe modes', () => {
  const dir = fixture();
  try {
    assert.throws(() => encodeArchive([
      { path: 'a.txt', content: Buffer.from('1'), mode: 0o644 },
      { path: 'a.txt', content: Buffer.from('2'), mode: 0o644 },
    ]), /Duplicate/u);
    assert.throws(() => encodeArchive([{ path: 'a.txt', content: Buffer.from('1'), mode: 0o7777 }]), /mode/u);
    assert.throws(() => encodeArchive([]), /at least one/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects non-canonical paths instead of silently normalising them into a different location', () => {
  const dir = fixture();
  try {
    const good = Buffer.from('x');
    // Each of these would otherwise alias a valid path or escape the cache root.
    const rejected = [
      ['backslash alias', 'a\\b'],
      ['empty segment alias', 'a//b'],
      ['trailing empty segment', 'a/'],
      ['dot segment', 'a/./b'],
      ['dotdot segment', 'a/../b'],
      ['leading dotdot', '../b'],
      ['absolute path', '/abs/b'],
      ['drive path', 'C:/abs/b'],
      ['NUL byte', 'a\u0000b'],
      ['empty path', ''],
    ];
    for (const [label, value] of rejected) {
      assert.throws(() => encodeArchive([{ path: value, content: good, mode: 0o644 }]), /path/u, label);
      // The decoder enforces the same contract, so a crafted archive cannot smuggle one through.
      const meta = Buffer.from(JSON.stringify([{ path: value, mode: 420, length: good.length }]));
      const head = Buffer.alloc(12); head.write('XPODAR01', 0, 'latin1'); head.writeUInt32LE(meta.length, 8);
      assert.throws(() => decodeArchive(Buffer.concat([head, meta, good])), /path/u, `${label} (decode)`);
    }
    // A canonical path with a space, unicode and dots inside a segment stays legal.
    const ok = encodeArchive([{ path: 'docs/a b/日本語.v1.md', content: good, mode: 0o644 }]).container;
    assert.deepEqual(decodeArchive(ok).map((entry) => entry.path), ['docs/a b/日本語.v1.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata bound is the format capacity and the actual buffer, not a policy cap', () => {
  const dir = fixture();
  try {
    const good = Buffer.from('x');
    // A metadata length beyond the real buffer must fail on buffer bounds.
    const head = Buffer.alloc(24); head.write('XPODAR01', 0, 'latin1');
    head.writeUInt32LE(0xFFFFFFFF, 8);
    assert.throws(() => decodeArchive(Buffer.concat([head, good])), /truncated/u);
    // Zero length is not a valid metadata section either.
    const zero = Buffer.alloc(24); zero.write('XPODAR01', 0, 'latin1'); zero.writeUInt32LE(0, 8);
    assert.throws(() => decodeArchive(zero), /must be positive/u);
    // A genuinely large (12 MiB) metadata section decodes: bigger than any old hard cap would have allowed cheaply.
    const big = [];
    for (let index = 0; index < 60000; index++) big.push({ path: `f/${String(index).padStart(6, '0')}.txt`, mode: 420, length: 0 });
    const encoded = encodeArchive(big.map((entry) => ({ path: entry.path, content: Buffer.alloc(0), mode: entry.mode })));
    assert.ok(encoded.metadataLength > 1024 * 1024, 'metadata should exceed 1 MiB for this fixture');
    assert.equal(decodeArchive(encoded.container).length, big.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
