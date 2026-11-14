const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRegistry, createExactArtifactRegistry } = require('../../scripts/check-package-registry-consumer.cjs');

// Tiny synthetic HTTP protocol fixtures, never normal-producer or npm evidence.
function artifact(name, version = '1.0.0') {
  const bytes = Buffer.from(name + '@' + version);
  return { bytes, manifest: { name, version }, integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
}
async function fixture(t, supplied = []) {
  const root = artifact('@undefineds.co/xpod');
  const server = createRegistry(root, 'fixture-token', 'https://mirror.invalid', { artifacts: supplied,
    required: supplied.map(row => ({ name: row.manifest.name, version: row.manifest.version })) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, server, origin: 'http://127.0.0.1:' + server.address().port };
}
function publication(origin, row, previous) {
  const metadata = previous ? JSON.parse(JSON.stringify(previous)) : { name: row.manifest.name, versions: {}, 'dist-tags': {} };
  metadata.versions[row.manifest.version] = { ...row.manifest, dependencies: { child: '^1.0.0' },
    bundledDependencies: ['child'], optionalDependencies: { optional: '~2.0.0' },
    dist: { tarball: `${origin}/${row.manifest.name}/-/${row.manifest.version}.tgz`, integrity: row.integrity,
      shasum: crypto.createHash('sha1').update(row.bytes).digest('hex') } };
  metadata['dist-tags'].fixture = row.manifest.version;
  return { ...metadata, _attachments: { 'artifact.tgz': { data: row.bytes.toString('base64'), length: row.bytes.length } } };
}
async function put(origin, payload, token = 'fixture-token') {
  return fetch(origin + '/' + encodeURIComponent(payload.name), { method: 'PUT', headers: { authorization: 'Bearer ' + token,
    'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

test('exact transport rejects missing, duplicate, mismatched and unsafe artifacts before listening', () => {
  const root = artifact('@undefineds.co/xpod'), child = artifact('@fixture/child');
  assert.throws(() => createRegistry(root, 'token', undefined, { required: [{ name: '@fixture/missing', version: '1.0.0' }] }), /Missing/);
  assert.throws(() => createRegistry(root, 'token', undefined, { artifacts: [child, child] }), /Duplicate/);
  assert.throws(() => createRegistry(root, 'token', undefined, { artifacts: [{ ...child, integrity: 'sha512-wrong' }] }), /integrity/);
  assert.throws(() => createRegistry(root, 'token', undefined, { artifacts: [{ ...child, manifest: { ...child.manifest, publishConfig: { registry: 'https://external.invalid' } } }] }), /publishConfig/);
  assert.throws(() => createRegistry(child, 'token'), /root Xpod/);
});

test('declared local names and absent versions cannot fall back to the public upstream', async t => {
  const child = artifact('@fixture/child'), { origin } = await fixture(t, [child]);
  for (const name of ['@fixture/child', '@fixture/child/1.0.0', '@fixture/child/9.0.0', '@fixture/child/-/unknown.tgz']) {
    const response = await fetch(origin + '/' + name, { redirect: 'manual' });
    assert.equal(response.status, 404); assert.equal(response.headers.get('location'), null);
  }
  const response = await fetch(origin + '/react?token=private-fixture', { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), 'https://mirror.invalid/react');
});

test('root and supplied artifacts retain actual PUT metadata and serve exact original bytes', async t => {
  const child = artifact('@fixture/child'), { root, origin, server } = await fixture(t, [child]);
  for (const row of [root, child]) {
    const payload = publication(origin, row);
    assert.equal((await put(origin, payload)).status, 201);
    const { _attachments, ...originalMetadata } = payload;
    const metadata = await (await fetch(origin + '/' + row.manifest.name)).json();
    assert.deepEqual(metadata, originalMetadata);
    assert.deepEqual(server.publishedMetadata(row.manifest.name), originalMetadata);
    assert.deepEqual(await (await fetch(origin + '/' + row.manifest.name + '/' + row.manifest.version)).json(), originalMetadata.versions[row.manifest.version]);
    assert.deepEqual(Buffer.from(await (await fetch(originalMetadata.versions[row.manifest.version].dist.tarball)).arrayBuffer()), row.bytes);
    const head = await fetch(originalMetadata.versions[row.manifest.version].dist.tarball, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), row.bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await put(origin, payload)).status, 409);
  }
  assert.equal(server.publishedMetadata().name, '@undefineds.co/xpod');
});

test('multiple exact versions preserve prior publication metadata without fabricating a packument', async t => {
  const first = artifact('@fixture/child'), second = artifact('@fixture/child', '2.0.0');
  const { origin, server } = await fixture(t, [first, second]);
  assert.equal((await put(origin, publication(origin, first))).status, 201);
  const previous = server.publishedMetadata(first.manifest.name);
  const payload = publication(origin, second, previous);
  const corrupted = JSON.parse(JSON.stringify(payload)); corrupted.versions['1.0.0'].dependencies = {};
  assert.equal((await put(origin, corrupted)).status, 400);
  assert.equal((await put(origin, payload)).status, 201);
  const { _attachments, ...metadata } = payload;
  assert.deepEqual(await (await fetch(origin + '/' + first.manifest.name)).json(), metadata);
  assert.equal((await fetch(origin + '/' + first.manifest.name + '/3.0.0', { redirect: 'manual' })).status, 404);
});

test('changed attachments, integrity and unauthorized package publication fail without accepting state', async t => {
  const child = artifact('@fixture/child'), { origin, server } = await fixture(t, [child]);
  const payload = publication(origin, child);
  assert.equal((await put(origin, payload, 'wrong')).status, 403);
  assert.equal((await put(origin, publication(origin, artifact('@fixture/unknown')))).status, 403);
  for (const kind of ['bytes', 'integrity']) {
    const bad = JSON.parse(JSON.stringify(payload));
    if (kind === 'bytes') bad._attachments['artifact.tgz'].data = Buffer.from('changed').toString('base64');
    else bad.versions['1.0.0'].dist.integrity = 'sha512-wrong';
    assert.equal((await put(origin, bad)).status, 400);
    assert.equal(server.publishedMetadata(child.manifest.name), undefined);
  }
  assert.equal((await put(origin, payload)).status, 201);
});

test('only declared published versions with own metadata keys are routable, including after publication', async t => {
  const child = artifact('@fixture/child'), { root, origin } = await fixture(t, [child]);
  for (const row of [root, child]) {
    assert.equal((await put(origin, publication(origin, row))).status, 201);
    for (const version of ['constructor', '__proto__', 'toString', '__defineGetter__', '9.0.0', '-/unknown.tgz']) {
      const response = await fetch(`${origin}/${row.manifest.name}/${version}`, { redirect: 'manual' });
      assert.equal(response.status, 404, row.manifest.name + '/' + version);
      assert.equal(response.headers.get('location'), null);
    }
  }
});

// Preserve the original root fixture's conflict before parsing another body.
test('fully published identities reject duplicate malformed bodies as conflicts', async t => {
  const first = artifact('@fixture/child'), second = artifact('@fixture/child', '2.0.0');
  const { root, origin, server } = await fixture(t, [first, second]);
  assert.equal((await put(origin, publication(origin, root))).status, 201);
  const send = name => fetch(origin + '/' + encodeURIComponent(name), { method: 'PUT',
    headers: { authorization: 'Bearer fixture-token' }, body: '{}' });
  assert.equal((await send(root.manifest.name)).status, 409);
  assert.equal((await put(origin, publication(origin, first))).status, 201);
  assert.equal((await send(first.manifest.name)).status, 400);
  assert.equal((await put(origin, publication(origin, second, server.publishedMetadata(first.manifest.name)))).status, 201);
  assert.equal((await send(first.manifest.name)).status, 409);
});


test('generic exact registry accepts modules without a root and preserves publication metadata and version isolation', async t => {
  const first = artifact('@fixture/module'), second = artifact('@fixture/module', '2.0.0');
  const server = createExactArtifactRegistry([first, second], 'fixture-token', 'https://mirror.invalid',
    [first, second].map(row => ({ name: row.manifest.name, version: row.manifest.version })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const row of [first, second]) {
    const payload = publication(origin, row, server.publishedMetadata());
    assert.equal((await put(origin, payload, 'wrong')).status, 403);
    assert.equal((await put(origin, payload)).status, 201);
    const { _attachments, ...metadata } = payload;
    assert.deepEqual(server.publishedMetadata(), metadata);
    assert.deepEqual(Buffer.from(await (await fetch(payload.versions[row.manifest.version].dist.tarball)).arrayBuffer()), row.bytes);
    assert.equal((await fetch(origin + '/@fixture/module/toString')).status, 404);
    assert.equal((await fetch(origin + '/@fixture/module/9.0.0')).status, 404);
    assert.equal((await fetch(origin + '/@fixture/module/-/missing.tgz')).status, 404);
  }
  assert.equal((await fetch(origin + '/@undefineds.co/xpod', { redirect: 'manual' })).status, 302);
});

test('generic entry validates exact coverage and publish policy while old root wrapper still rejects modules', () => {
  const module = artifact('@fixture/module');
  assert.throws(() => createRegistry(module, 'token'), /root Xpod/);
  assert.throws(() => createExactArtifactRegistry([], 'token'), /Invalid exact artifact supply/);
  assert.throws(() => createExactArtifactRegistry([module, module], 'token'), /Duplicate/);
  assert.throws(() => createExactArtifactRegistry([module], 'token', undefined, [{ name: '@fixture/absent', version: '1.0.0' }]), /Missing/);
  assert.throws(() => createExactArtifactRegistry([{ ...module, integrity: 'sha512-wrong' }], 'token'), /integrity/);
  assert.throws(() => createExactArtifactRegistry([{ ...module, manifest: { ...module.manifest, publishConfig: { registry: 'https://external.invalid' } } }], 'token'), /publishConfig/);
});

test('generic registry snapshots bytes and its default primary identity at construction', async t => {
  const input = artifact('@fixture/module');
  const original = { ...input, bytes: Buffer.from(input.bytes), manifest: { ...input.manifest } };
  const server = createExactArtifactRegistry([input], 'fixture-token');
  input.bytes.fill(0); input.manifest.name = '@fixture/renamed';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const payload = publication(origin, original);
  assert.equal((await put(origin, payload)).status, 201);
  assert.equal(server.publishedMetadata().name, original.manifest.name);
  assert.deepEqual(Buffer.from(await (await fetch(payload.versions[original.manifest.version].dist.tarball)).arrayBuffer()), original.bytes);
});
