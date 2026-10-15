const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { archiveManifests, captureManifestEvidence } = require('../../scripts/lib/compat-manifest-evidence.cjs');
const { withSmokeTarball } = require('../../scripts/package-smoke-install.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(action) {
  const parent = path.resolve('.test-data/compat-manifest-evidence'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')); const tree = path.join(root, 'tree');
  const put = (name, object) => { const file = path.join(tree, 'package', name); fs.mkdirSync(path.dirname(file), { recursive: true }); const bytes = Buffer.from(JSON.stringify(object)); fs.writeFileSync(file, bytes); return bytes; };
  const pack = () => { const archive = path.join(root, 'original.tgz'); execFileSync('tar', ['czf', archive, '-C', tree, 'package']); return archive; };
  const finish = () => { fs.rmSync(root, { recursive: true, force: true }); if (!fs.readdirSync(parent).length) fs.rmdirSync(parent); };
  try { const result = action({ root, put, pack }); if (result?.then) return result.finally(finish); finish(); return result; }
  catch (error) { finish(); throw error; }
}
test('actual root bundle declarations select exact child manifests with original hashes', () => fixture(({ root, put, pack }) => {
  const raw = put('package.json', { name: '@fixture/root', version: '1.0.0', dependencies: { '@fixture/child': '2.0.0' }, bundledDependencies: ['@fixture/child'] });
  const child = put('node_modules/@fixture/child/package.json', { name: '@fixture/child', version: '2.0.0', dependencies: { missing: '3.0.0' }, scripts: { install: 'private-marker' }, _authToken: 'private-marker' });
  put('node_modules/not-declared/package.json', { name: 'not-declared', version: '1.0.0' });
  const archive = pack(); const output = path.join(root, 'evidence.json');
  const reference = captureManifestEvidence(output, archive, archive, 'bun'); const result = JSON.parse(fs.readFileSync(output));
  assert.equal(reference.status, 'captured'); assert.equal(reference.sha256, hash(fs.readFileSync(output)));
  assert.deepEqual(result.original.archive, { bytes: fs.statSync(archive).size, sha256: hash(fs.readFileSync(archive)) });
  assert.equal(result.transformation, 'none'); assert.deepEqual(result.original, result.selectedInput);
  assert.equal(result.original.manifests.length, 2); assert.equal(result.original.manifests[0].sha256, hash(raw));
  assert.equal(result.original.manifests[1].sha256, hash(child)); assert.equal(result.original.manifests[1].manifest.dependencies.missing, '3.0.0');
  assert.equal(fs.readFileSync(output, 'utf8').includes('private-marker'), false); assert.equal(result.releaseQualified, false);
}));
test('real existing npm smoke conversion binds both actual archives, without changing original bytes', () => fixture(async ({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0', optionalDependencies: { optional: '1.0.0' }, dependencies: { required: '2.0.0' } });
  const archive = pack(), before = fs.readFileSync(archive); const output = path.join(root, 'install.json');
  await withSmokeTarball(archive, smoke => {
    captureManifestEvidence(output, archive, smoke, 'npm'); const result = JSON.parse(fs.readFileSync(output));
    assert.equal(result.transformation, 'existing-npm-optional-dependency-smoke');
    assert.equal(result.original.archive.sha256, hash(before)); assert.equal(result.selectedInput.archive.sha256, hash(fs.readFileSync(smoke)));
    assert.notEqual(result.original.archive.sha256, result.selectedInput.archive.sha256);
    assert.deepEqual(result.original.manifests[0].manifest.optionalDependencies, { optional: '1.0.0' });
    assert.equal(result.selectedInput.manifests[0].manifest.optionalDependencies, undefined);
    assert.deepEqual(result.selectedInput.manifests[0].manifest.dependencies, { required: '2.0.0' });
  }); assert.deepEqual(fs.readFileSync(archive), before);
}));
test('missing declared bundle is explicit and arbitrary dependency URLs are hash-only', () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0', bundleDependencies: ['absent'], dependencies: { secret: 'https://user:private-marker@example.invalid/a.tgz' } });
  const archive = pack(), output = path.join(root, 'out.json'); captureManifestEvidence(output, archive);
  const result = JSON.parse(fs.readFileSync(output)); assert.equal(result.original.manifests[1].status, 'missing');
  assert.equal(result.original.manifests[0].manifest.dependencies.secret.redacted, true);
  assert.equal(fs.readFileSync(output, 'utf8').includes('private-marker'), false);
}));
test('oversized or malformed manifest yields bounded unavailable evidence, not a fabricated pass', () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0', ignored: 'x'.repeat(128 * 1024) });
  const archive = pack(), output = path.join(root, 'out.json');
  assert.equal(captureManifestEvidence(output, archive).status, 'unavailable');
  assert.equal(JSON.parse(fs.readFileSync(output)).sourceQualified, false);
  assert.ok(fs.statSync(output).size < 1024); assert.doesNotThrow(() => captureManifestEvidence('/absent-parent/out.json', archive));
}));
test('bundleDependencies true reuses actual dependency names and retains version mismatches', () => fixture(({ put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0', bundleDependencies: true, dependencies: { child: '2.0.0' } });
  put('node_modules/child/package.json', { name: 'child', version: '1.0.0' });
  const result = archiveManifests(pack()); assert.equal(result.manifests[1].manifest.version, '1.0.0');
  assert.equal(result.manifests[0].manifest.dependencies.child, '2.0.0');
}));
test('combined raw manifest budget is enforced even when ignored fields would project small', () => fixture(({ root, put, pack }) => {
  const names = Array.from({ length: 10 }, (_, index) => 'child-' + index);
  put('package.json', { name: '@fixture/root', version: '1.0.0', bundledDependencies: names });
  for (const child of names) put('node_modules/' + child + '/package.json', { name: child, version: '1.0.0', ignored: 'x'.repeat(110 * 1024) });
  const output = path.join(root, 'out.json'); assert.equal(captureManifestEvidence(output, pack()).status, 'unavailable');
  assert.ok(fs.statSync(output).size < 1024);
}));
for (const runtime of ['npm', 'bun']) test(`a failing ${runtime} subprocess retains its exit and selected input`, { skip: process.platform === 'win32' }, () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0', optionalDependencies: { optional: '1.0.0' } });
  const archive = pack(), bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, runtime), '#!/bin/sh\nexit 23\n', { mode: 0o700 });
  const evidence = path.join(root, 'consumed.json');
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve('scripts/package-smoke-install.cjs'), archive, path.join(root, 'consumer'), path.join(root, 'cache'), runtime],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, XPOD_COMPAT_MANIFEST_EVIDENCE_FILE: evidence } });
  assert.equal(result.status, 1); assert.match(result.stderr, /Registry consumer child failed \(23\)/);
  const captured = JSON.parse(fs.readFileSync(evidence)); assert.equal(captured.runtime, runtime);
  assert.equal(captured.original.archive.sha256, hash(fs.readFileSync(archive)));
  assert.equal(captured.installationOutcome, 'not-attested');
  if (runtime === 'npm') assert.equal(captured.selectedInput.manifests[0].manifest.optionalDependencies, undefined);
  else { assert.deepEqual(captured.original, captured.selectedInput); assert.equal(captured.transformation, 'none'); }
}));
