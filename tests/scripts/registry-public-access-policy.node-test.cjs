const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertSafeFixturePublishConfig, publishArtifact } = require('../../scripts/check-package-registry-consumer.cjs');

const unsafe = [
  { registry: 'https://must-not-publish.invalid' }, { url: 'https://must-not-publish.invalid' },
  { tag: 'latest' }, { _authToken: 'private-fixture-marker' }, { username: 'private-fixture-marker' },
  { password: 'private-fixture-marker' }, { access: 'restricted' }, { access: '' }, { access: null },
  { access: 'public', registry: 'https://must-not-publish.invalid' }, { access: 'public', tag: 'fixture' },
  { access: 'public', credentials: 'private-fixture-marker' }, { access: 'public', provenance: false },
  { access: 'public', unknown: true }, { access: 'Public' }, { access: ' public' },
  null, false, 1, 'public', [], ['public'],
  JSON.parse('{"access":"public","__proto__":{"registry":"https://must-not-publish.invalid"}}'),
];

test('fixed loopback publisher accepts only absent, empty, or exact public-access metadata without rewriting it', () => {
  for (const manifest of [{ name: 'any-package' }, { name: 'any-package', publishConfig: {} },
    { name: 'any-package', publishConfig: { access: 'public' } }]) {
    const before = JSON.stringify(manifest);
    if (manifest.publishConfig) Object.freeze(manifest.publishConfig);
    Object.freeze(manifest);
    assert.doesNotThrow(() => assertSafeFixturePublishConfig(manifest));
    assert.equal(JSON.stringify(manifest), before);
  }
});

test('registry, URL, tag, credential, unknown-key and malformed publish configurations are rejected', () => {
  for (const config of unsafe) {
    assert.throws(() => assertSafeFixturePublishConfig({ publishConfig: config }), /publishConfig overrides/);
  }
});

test('the real publisher rejects unsafe metadata before creating config files or invoking a package manager', async () => {
  const parent = path.resolve(__dirname, '../../.test-data/registry-public-access-policy');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    for (const config of unsafe) {
      await assert.rejects(publishArtifact({ manifest: { publishConfig: config }, tarball: 'must-not-be-read.tgz' },
        'http://127.0.0.1:43519/', 'fixture-only-not-a-real-token', root), /publishConfig overrides/);
      assert.deepEqual(fs.readdirSync(root), []);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmdirSync(parent); }
});

test('public-access metadata never weakens the independent loopback destination guard', async () => {
  const artifact = { manifest: { publishConfig: { access: 'public' } }, tarball: 'must-not-be-read.tgz' };
  for (const registry of ['https://registry.npmjs.org/', 'http://example.com:43519/',
    'http://user:pass@127.0.0.1:43519/', 'http://127.0.0.1:43519/?registry=external']) {
    await assert.rejects(publishArtifact(artifact, registry, 'fixture-only-not-a-real-token', '/must-not-write'), /explicit loopback/);
  }
});
