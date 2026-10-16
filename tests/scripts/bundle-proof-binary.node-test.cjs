const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { BUNDLES, verifyInstalledBundles } = require('../../scripts/verify-installed-bundles.cjs');
const { inspectTarballBuffer } = require('../../scripts/workspace-package-payload.cjs');
function archive(rows) {
  const blocks = [];
  for (const row of rows) {
    const content = Buffer.from(row.content ?? ''), h = Buffer.alloc(512);
    h.write(row.path); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(content.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.fill(32, 148, 156); h[156] = (row.type ?? '0').charCodeAt(0); h.write('ustar\0', 257); h.write('00', 263);
    if (row.prefix) h.write(row.prefix, 345, 155);
    if (row.rawName) { h.fill(0, 0, 100); row.rawName.copy(h, 0, 0, 100); }
    if (row.rawPrefix) { h.fill(0, 345, 500); row.rawPrefix.copy(h, 345, 0, 155); }
    const checksum = h.reduce((sum, byte) => sum + byte, 0); h.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function fixture(operation) {
  const parent = path.resolve('.test-data/bundle-proof-binary'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const rows = [{ path: 'package/package.json', content: '{"name":"@undefineds.co/xpod","version":"1.0.0"}' }];
    for (const name of BUNDLES) for (const [file, content] of [['package.json', JSON.stringify({ name: '@undefineds.co/' + name, version: '1.0.0' })], ['dist/index.js', 'export const fresh = true;']]) rows.push({ path: 'package/node_modules/@undefineds.co/' + name + '/' + file, content });
    const installed = path.join(root, 'installed');
    for (const row of rows) { const file = path.join(installed, row.path.slice('package/'.length)); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, row.content); }
    const tarball = path.join(root, 'root.tgz');
    const write = values => fs.writeFileSync(tarball, archive(values)); write(rows);
    return operation({ root, installed, tarball, rows, write, proof: () => verifyInstalledBundles(tarball, installed, root) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('binary proof verifies all seven original bundles without listing/extraction or scratch files', () => fixture(f => {
  const before = fs.readdirSync(f.root); const proof = f.proof();
  assert.equal(proof.length, 7); assert.ok(proof.every(row => row.files === 2 && row.bytesMatched && row.containedInInstalledXpod));
  assert.deepEqual(fs.readdirSync(f.root), before);
}));
test('literal control characters, unsafe paths, links, special entries and duplicates fail closed', () => fixture(f => {
  for (const name of ['package/evil\r', 'package/evil\n', 'package/evil\r\n', 'package/evil\t', 'package/evil\x7f', 'package/a\\b', 'package/../escape', '/escape', 'outside/file', 'package/./file']) {
    f.write([...f.rows, { path: name, content: 'bad' }]); assert.throws(f.proof, undefined, JSON.stringify(name));
  }
  for (const type of ['1', '2', '3', '4', '6', '7']) { f.write([...f.rows, { path: 'package/link', type }]); assert.throws(f.proof, /Unsupported tar entry type/); }
  f.write([...f.rows, f.rows[1]]); assert.throws(f.proof, /Duplicate tar entry/);
}));
test('missing bundle, changed installed bytes, missing file and external realpath reject', () => fixture(f => {
  f.write(f.rows.filter(row => !row.path.includes('/solid-sdk/'))); assert.throws(f.proof, /Missing bundled package/); f.write(f.rows);
  const sdk = path.join(f.installed, 'node_modules/@undefineds.co/solid-sdk'), file = path.join(sdk, 'dist/index.js');
  fs.writeFileSync(file, 'different build same version'); assert.throws(f.proof, /bytes differ/);
  fs.rmSync(file); assert.throws(f.proof, /Missing installed bundle file/); fs.writeFileSync(file, 'export const fresh = true;');
  const outside = path.join(f.root, 'outside'); fs.renameSync(sdk, outside); fs.symlinkSync(outside, sdk, 'junction'); assert.throws(f.proof, /escaped Xpod/);
}));
test('bounded binary parser rejects overflow, corrupt headers and truncated archive', () => fixture(f => {
  const original = fs.readFileSync(f.tarball);
  assert.throws(() => inspectTarballBuffer(original, { expandedBytes: 512, members: 100 }), /budget exceeded/);
  assert.throws(() => inspectTarballBuffer(original, { expandedBytes: 1024 * 1024, members: 2 }), /member budget exceeded/);
  assert.throws(() => inspectTarballBuffer(original, { expandedBytes: Infinity, members: 100 }), /Invalid tar inspection budget/);
  const raw = zlib.gunzipSync(original); raw[0] ^= 1; fs.writeFileSync(f.tarball, zlib.gzipSync(raw)); assert.throws(f.proof, /checksum/);
  fs.writeFileSync(f.tarball, original.subarray(0, original.length - 10)); assert.throws(f.proof, /Corrupted tar payload/);
  fs.truncateSync(f.tarball, 128 * 1024 ** 2 + 1); assert.throws(f.proof, /Invalid supply original/);
}));

test('literal trailing spaces remain distinct from a normalized installed filename', () => fixture(f => {
  const member = 'package/node_modules/@undefineds.co/solid-sdk/dist/trailing.js ';
  f.write([...f.rows, { path: member, content: 'same bytes' }]);
  const parsed = inspectTarballBuffer(fs.readFileSync(f.tarball), { expandedBytes: 1024 * 1024, members: 100 });
  assert.ok(parsed.entries.some(entry => entry.path === member));
  const alias = path.join(f.installed, member.slice(8).trimEnd()); fs.writeFileSync(alias, 'same bytes');
  assert.throws(f.proof, /Missing installed bundle file/);
  const exact = path.join(f.installed, member.slice(8)); fs.writeFileSync(exact, 'same bytes');
  if (fs.readdirSync(path.dirname(exact)).includes(path.basename(exact))) assert.equal(f.proof().find(row => row.name === '@undefineds.co/solid-sdk').files, 3);
  else assert.throws(f.proof, /Missing installed bundle file/); // A host that aliases the name cannot prove it.
}));

test('USTAR prefix trailing spaces are preserved and cannot alias an installed directory', () => fixture(f => {
  const prefix = 'package/node_modules/@undefineds.co/solid-sdk/dist ', member = prefix + '/prefix.js';
  f.write([...f.rows, { path: 'prefix.js', prefix, content: 'same bytes' }]);
  assert.ok(inspectTarballBuffer(fs.readFileSync(f.tarball)).entries.some(entry => entry.path === member));
  const alias = path.join(f.installed, 'node_modules/@undefineds.co/solid-sdk/dist/prefix.js'); fs.writeFileSync(alias, 'same bytes');
  assert.throws(f.proof, /Missing installed bundle file/);
}));

test('name and prefix decode losslessly: invalid UTF-8 cannot alias a real replacement character', () => fixture(f => {
  const prefix = 'package/node_modules/@undefineds.co/solid-sdk/dist/';
  const replacement = path.join(f.installed, prefix.slice(8), '\ufffd.js'); fs.writeFileSync(replacement, 'same bytes');
  for (const invalid of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from([0xc3, 0x28])]) {
    f.write([...f.rows, { path: 'unused', rawName: Buffer.concat([Buffer.from(prefix), invalid, Buffer.from('.js')]), content: 'same bytes' }]);
    assert.throws(f.proof, /Invalid UTF-8 tar name or prefix/);
    f.write([...f.rows, { path: 'file.js', rawPrefix: Buffer.concat([Buffer.from('package/'), invalid]), content: 'same bytes' }]);
    assert.throws(f.proof, /Invalid UTF-8 tar name or prefix/);
  }
  // An otherwise valid multibyte character cut at the header field boundary is invalid.
  for (const [field, width] of [['rawName', 100], ['rawPrefix', 155]]) {
    const raw = Buffer.concat([Buffer.alloc(width - 1, 0x61), Buffer.from([0xe2, 0x82, 0xac])]);
    f.write([...f.rows, { path: 'file.js', [field]: raw, content: 'same bytes' }]); assert.throws(f.proof, /Invalid UTF-8 tar name or prefix/);
  }
  f.write([...f.rows, { path: prefix + '\ufffd.js', content: 'same bytes' }]);
  assert.equal(f.proof().find(row => row.name === '@undefineds.co/solid-sdk').files, 3);
  const literalPrefix = 'package/node_modules/@undefineds.co/solid-sdk/dist/\ufffd';
  const literalFile = path.join(f.installed, literalPrefix.slice(8), 'prefix.js'); fs.mkdirSync(path.dirname(literalFile), { recursive: true }); fs.writeFileSync(literalFile, 'same bytes');
  f.write([...f.rows, { path: 'prefix.js', prefix: literalPrefix, content: 'same bytes' }]);
  assert.equal(f.proof().find(row => row.name === '@undefineds.co/solid-sdk').files, 3);
}));

function longMetadata(name) { return { path: '././@LongLink', type: 'L', content: Buffer.isBuffer(name) ? name : Buffer.from(name + '\0') }; }
const gnuLimits = { expandedBytes: 1024 * 1024, members: 100, gnuLongNames: true };
test('GNU long name metadata binds only the next ordinary entry and preserves exact bundle bytes', () => fixture(f => {
  const name = 'package/node_modules/@undefineds.co/solid-sdk/dist/' + 'long-'.repeat(25) + '.js';
  f.write([...f.rows, longMetadata(name), { path: name.slice(0, 100), content: 'same bytes' }]);
  const installed = path.join(f.installed, name.slice(8)); fs.writeFileSync(installed, 'same bytes');
  const parsed = inspectTarballBuffer(fs.readFileSync(f.tarball), gnuLimits);
  assert.ok(parsed.entries.some(entry => entry.path === name)); assert.ok(parsed.entries.every(entry => entry.type !== 'long-name'));
  assert.equal(f.proof().find(row => row.name === '@undefineds.co/solid-sdk').files, 3);
  assert.throws(() => inspectTarballBuffer(fs.readFileSync(f.tarball)), /Unsafe tar path/);
  assert.throws(() => inspectTarballBuffer(fs.readFileSync(f.tarball), { ...gnuLimits, members: f.rows.length + 1 }), /member budget exceeded/);
}));
test('GNU malformed metadata, unsafe effective names and duplicate effective entries fail closed', () => fixture(f => {
  const name = 'package/node_modules/@undefineds.co/solid-sdk/dist/' + 'x'.repeat(110) + '.js', file = { path: name.slice(0, 100), content: 'payload' };
  const bad = [
    [longMetadata(name)],
    [longMetadata(name), longMetadata(name), file],
    [{ ...longMetadata(name), path: 'package/not-the-gnu-marker' }, file],
    [longMetadata(Buffer.from(name)), file],
    [longMetadata(Buffer.from(name + '\0hidden\0')), file],
    [longMetadata(Buffer.alloc(4097, 0x61)), file],
    [longMetadata(Buffer.from([0xff, 0])), file],
    [longMetadata(Buffer.from([0xe2, 0x82, 0])), file],
    ...['/escape', 'package/../escape', 'package/a\\b', 'package/./file', 'package/evil\r', 'package/evil\n', 'package/evil\t'].map(path => [longMetadata(path), file]),
    ...['1', '2', '3', '4', '6', '7', 'K', 'x', 'g'].map(type => [longMetadata(name), { ...file, type }]),
    [{ ...longMetadata(name), type: '0' }],
    [longMetadata(name), file, longMetadata(name), file],
  ];
  for (const rows of bad) { f.write([...f.rows, ...rows]); assert.throws(f.proof); }
  f.write([...f.rows, longMetadata(name), file]); const raw = zlib.gunzipSync(fs.readFileSync(f.tarball));
  const offset = raw.indexOf(Buffer.from('././@LongLink')); assert.ok(offset >= 0); raw[offset] ^= 1;
  fs.writeFileSync(f.tarball, zlib.gzipSync(raw)); assert.throws(f.proof, /checksum/);
}));
test('stream inspection remains fail-closed for GNU metadata rather than treating it as a file', async () => {
  const { inspectTarballFile } = require('../../scripts/workspace-package-payload.cjs');
  const parent = path.resolve('.test-data/bundle-proof-binary'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'stream-'));
  try {
    const file = path.join(root, 'long.tgz'); fs.writeFileSync(file, archive([{ path: 'package/package.json', content: '{}' }, longMetadata('package/' + 'x'.repeat(110)), { path: 'package/short', content: 'payload' }]));
    await assert.rejects(inspectTarballFile(file, { expandedBytes: 1024 * 1024, members: 100, manifestBytes: 1024 }), /Unsafe tar path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
