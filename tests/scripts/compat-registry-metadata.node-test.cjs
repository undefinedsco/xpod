const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { captureManifestEvidence, captureRegistryMetadataEvidence } = require('../../scripts/lib/compat-manifest-evidence.cjs');
const { createRegistry } = require('../../scripts/check-package-registry-consumer.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(action) {
  const parent = path.resolve('.test-data/compat-registry-metadata'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')), pkg = path.join(root, 'tree/package'); fs.mkdirSync(pkg, { recursive: true });
  const manifest = { name: '@undefineds.co/xpod', version: '1.0.0', dependencies: { child: '2.0.0' }, bundledDependencies: ['child'] };
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(manifest));
  fs.mkdirSync(path.join(pkg, 'node_modules/child'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'node_modules/child/package.json'), JSON.stringify({ name: 'child', version: '2.0.0' }));
  const tarball = path.join(root, 'original.tgz'); execFileSync('tar', ['czf', tarball, '-C', path.join(root, 'tree'), 'package']);
  const bytes = fs.readFileSync(tarball), artifact = { manifest, tarball, bytes, integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
  const input = path.join(root, 'install.manifests.json'); assert.equal(captureManifestEvidence(input, tarball, tarball, 'bun').status, 'captured');
  const server = createRegistry(artifact, 'private-token'); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const version = { ...manifest, dist: { tarball: origin + '/@undefineds.co/xpod/-/root.tgz', integrity: artifact.integrity, shasum: crypto.createHash('sha1').update(bytes).digest('hex') } };
  const publish = async value => {
    const body = { name: manifest.name, versions: { '1.0.0': value }, _attachments: { 'root.tgz': { data: bytes.toString('base64'), length: bytes.length } } };
    return await fetch(origin + '/@undefineds.co%2fxpod', { method: 'PUT', headers: { authorization: 'Bearer private-token' }, body: JSON.stringify(body) });
  };
  const capture = (record = server.publishedMetadata(), name = 'out.json') => {
    const output = path.join(root, name); const ref = captureRegistryMetadataEvidence(output, record, artifact, input);
    assert.equal(ref.sha256, hash(fs.readFileSync(output))); return JSON.parse(fs.readFileSync(output));
  };
  try { await action({ artifact, root, input, server, version, publish, capture }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); if (!fs.readdirSync(parent).length) fs.rmdirSync(parent); }
}
test('actual parsed PUT record is projected and bound, without pretending serialized bytes are raw HTTP', () => fixture(async ({ artifact, input, server, version, publish, capture }) => {
  assert.equal((await publish(version)).status, 201);
  const record = server.publishedMetadata(); assert.equal('_attachments' in record, false);
  const before = JSON.stringify(record), result = capture();
  assert.equal(result.status, 'captured'); assert.equal(result.publicationRecord.sha256, hash(Buffer.from(before)));
  assert.equal(result.publicationRecord.rawPutBytesRetained, false); assert.match(result.publicationRecord.encoding, /not original HTTP bytes/);
  assert.equal(result.archive.sha256, hash(artifact.bytes)); assert.equal(result.selectedInputEvidence.sha256, hash(fs.readFileSync(input)));
  assert.equal(result.versionRecord.sha256, hash(Buffer.from(JSON.stringify(record.versions['1.0.0']))));
  assert.equal(result.comparison.bundledDependencies, 'equal'); assert.equal(result.comparison.dependencies, 'equal');
  assert.deepEqual(result.distMatchesArchive, { integrity: true, shasum: true });
  assert.equal(JSON.stringify(record), before); assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(result.installationOutcome, 'not-attested'); assert.equal(result.releaseQualified, false);
}));
test('missing runtime fields in actual served metadata are recorded rather than repaired', () => fixture(async ({ version, publish, capture, server }) => {
  delete version.bundledDependencies; delete version.dependencies;
  assert.equal((await publish(version)).status, 201); const result = capture();
  assert.equal(result.comparison.bundledDependencies, 'metadata-missing'); assert.equal(result.comparison.dependencies, 'metadata-missing');
  assert.equal(server.publishedMetadata().versions['1.0.0'].dependencies, undefined);
}));
test('publication identity rejection cannot create a successful metadata observation', () => fixture(async ({ version, publish, capture }) => {
  version.version = '2.0.0'; assert.equal((await publish(version)).status, 400);
  const result = capture(); assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'registry-publication-record-unavailable');
}));
test('version differences and malicious URL fields are diagnostic only, never supplied back to the fixture', () => fixture(async ({ version, publish, capture, server }) => {
  assert.equal((await publish(version)).status, 201); const copy = structuredClone(server.publishedMetadata());
  copy.versions['1.0.0'].version = '2.0.0'; copy.versions['1.0.0'].dist.tarball = 'https://user:private-marker@example.invalid/a?private-marker';
  copy.versions['1.0.0'].dependencies = { child: 'https://user:private-marker@example.invalid/b' };
  const result = capture(copy); assert.equal(result.comparison.version, 'different'); assert.equal(result.comparison.dependencies, 'different');
  assert.equal(JSON.stringify(result).includes('private-marker'), false); assert.ok(result.versionRecord.dist.tarball.sha256);
  assert.equal(server.publishedMetadata().versions['1.0.0'].version, '1.0.0');
}));
test('wrong selected archive, absent version, and write failure stay unavailable without throwing', () => fixture(async ({ artifact, root, input, version, publish, capture, server }) => {
  assert.equal((await publish(version)).status, 201);
  const copy = structuredClone(server.publishedMetadata()); delete copy.versions['1.0.0'];
  assert.equal(capture(copy).reason, 'registry-version-unavailable');
  const wrong = JSON.parse(fs.readFileSync(input)); wrong.selectedInput.archive.sha256 = '0'.repeat(64); fs.writeFileSync(input, JSON.stringify(wrong));
  assert.equal(capture(undefined, 'mismatch.json').reason, 'registry-input-archive-mismatch');
  assert.doesNotThrow(() => captureRegistryMetadataEvidence(path.join(root, 'no-parent/out.json'), null, artifact, input));
}));

test('diagnostic capture survives the actual installer child failure and registry cleanup', { skip: process.platform === 'win32' }, () => fixture(async ({ artifact, root, input }) => {
  const target = path.join(root, 'consumer'), cache = path.join(root, 'cache'), bin = path.join(root, 'bin');
  fs.mkdirSync(target); fs.mkdirSync(cache); fs.mkdirSync(bin); fs.writeFileSync(path.join(target, 'package.json'), '{}');
  fs.writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nexit 23\n', { mode: 0o700 });
  const registryModule = require('../../scripts/check-package-registry-consumer.cjs'), originalPublish = registryModule.publishArtifact;
  const modulePath = require.resolve('../../scripts/package-smoke-install.cjs'), prior = require.cache[modulePath];
  registryModule.publishArtifact = async (actual, registry, token) => {
    const version = { ...actual.manifest, dist: { tarball: registry + '/@undefineds.co/xpod/-/root.tgz', integrity: actual.integrity,
      shasum: crypto.createHash('sha1').update(actual.bytes).digest('hex') } };
    const body = { name: actual.manifest.name, versions: { [actual.manifest.version]: version }, _attachments: { 'root.tgz': { data: actual.bytes.toString('base64'), length: actual.bytes.length } } };
    const response = await fetch(registry + '/@undefineds.co%2fxpod', { method: 'PUT', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    assert.equal(response.status, 201);
  };
  try {
    delete require.cache[modulePath]; const { installLocalTarballViaRegistry } = require(modulePath);
    await assert.rejects(installLocalTarballViaRegistry(artifact.tarball, target, cache,
      { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, input), /Registry consumer child failed \(23\)/);
  } finally { registryModule.publishArtifact = originalPublish; require.cache[modulePath] = prior; }
  const result = JSON.parse(fs.readFileSync(path.join(root, 'registry.metadata.json')));
  assert.equal(result.status, 'captured'); assert.equal(result.installationOutcome, 'not-attested');
  assert.equal(result.archive.sha256, hash(artifact.bytes)); assert.deepEqual(fs.readdirSync(cache), []);
}));
