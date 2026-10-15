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
  const result = JSON.parse(fs.readFileSync(output)); assert.equal(result.original.manifests[1].status, 'unresolved');
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

test('native tar long-name metadata elsewhere does not make exact manifest evidence unavailable', () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0' });
  put('unrelated/' + 'long-name-'.repeat(20) + '.json', { material: true });
  const archive = pack();
  const { inspectTarballBuffer } = require('../../scripts/workspace-package-payload.cjs');
  assert.throws(() => inspectTarballBuffer(fs.readFileSync(archive)), /Unsupported tar entry type/);
  const output = path.join(root, 'evidence.json'); assert.equal(captureManifestEvidence(output, archive).status, 'captured');
  assert.equal(JSON.parse(fs.readFileSync(output)).original.manifests[0].manifest.name, '@fixture/root');
}));
test('exact selected manifest symlinks cannot substitute for regular archive members', () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0', bundledDependencies: ['child'] });
  const file = path.join(root, 'tree/package/node_modules/child/package.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync('../../../package.json', file);
  assert.equal(captureManifestEvidence(path.join(root, 'out.json'), pack()).status, 'unavailable');
}));

test('unrelated symlink metadata is never followed or extracted by manifest selection', () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0' });
  fs.symlinkSync('/private-marker/not-readable', path.join(root, 'tree/package/unrelated-link'));
  const output = path.join(root, 'out.json'); assert.equal(captureManifestEvidence(output, pack()).status, 'captured');
  assert.equal(fs.readFileSync(output, 'utf8').includes('private-marker'), false);
}));
test('duplicate exact root member is rejected rather than concatenated or last-wins', () => fixture(({ root, put }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0' });
  const raw = path.join(root, 'duplicate.tar'), archive = path.join(root, 'duplicate.tgz');
  execFileSync('tar', ['cf', raw, '-C', path.join(root, 'tree'), 'package']);
  execFileSync('tar', ['rf', raw, '-C', path.join(root, 'tree'), 'package/package.json']);
  fs.writeFileSync(archive, require('node:zlib').gzipSync(fs.readFileSync(raw)));
  const output = path.join(root, 'out.json'); captureManifestEvidence(output, archive);
  assert.equal(JSON.parse(fs.readFileSync(output)).reason, 'member-not-unique-regular');
}));
test('fixed reason codes distinguish gzip, root, projection and manifest bounds without exception text', () => fixture(({ root, put, pack }) => {
  const output = (index, archive) => { const p = path.join(root, 'reason-' + index + '.json'); captureManifestEvidence(p, archive); return JSON.parse(fs.readFileSync(p)); };
  const bad = path.join(root, 'invalid.tgz'); fs.writeFileSync(bad, 'private-marker');
  assert.equal(output(1, bad).reason, 'archive-gzip-invalid');
  put('not-a-manifest.json', {}); assert.equal(output(2, pack()).reason, 'root-manifest-unresolved');
  put('package.json', { name: 'invalid/private-marker/name', version: '1.0.0' }); assert.equal(output(3, pack()).reason, 'manifest-projection-invalid');
  put('package.json', { name: '@fixture/root', version: '1.0.0', ignored: 'x'.repeat(129 * 1024) }); assert.equal(output(4, pack()).reason, 'manifest-size-bound');
}));
test('compressed and expanded budgets reject before reading selected manifests', () => fixture(({ put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0' }); const archive = pack();
  assert.throws(() => archiveManifests(archive, { compressed: 1 }), error => error.evidenceReason === 'archive-compressed-bound');
  assert.throws(() => archiveManifests(archive, { expanded: 1 }), error => error.evidenceReason === 'archive-expanded-bound');
}));

test('path replacement after reading cannot combine archive A hash with archive B manifest', () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0' }); const archive = pack(), original = fs.readFileSync(archive);
  put('package.json', { name: '@fixture/root', version: '2.0.0' }); const replacement = fs.readFileSync(pack()); fs.writeFileSync(archive, original);
  const read = fs.readSync; let changed = false;
  fs.readSync = function(...args) {
    const result = read.apply(this, args);
    if (result > 0 && !changed) { changed = true; fs.writeFileSync(archive, replacement); }
    return result;
  };
  const output = path.join(root, 'out.json');
  try { captureManifestEvidence(output, archive); } finally { fs.readSync = read; }
  assert.equal(changed, true);
  const result = JSON.parse(fs.readFileSync(output));
  if (result.status === 'captured') {
    assert.equal(result.original.archive.sha256, hash(original));
    assert.equal(result.original.manifests[0].manifest.version, '1.0.0');
    assert.equal(result.selectedInput.archive.sha256, hash(original));
  } else assert.equal(result.status, 'unavailable');
}));

test('ABA pathname replacement during native tar cannot defeat the byte snapshot binding', () => fixture(({ root, put, pack }) => {
  put('package.json', { name: '@fixture/root', version: '1.0.0' }); const archive = pack(), original = fs.readFileSync(archive);
  put('package.json', { name: '@fixture/root', version: '2.0.0' }); const replacement = fs.readFileSync(pack()); fs.writeFileSync(archive, original);
  const cp = require('node:child_process'), real = cp.execFileSync; let changed = false, restored = false;
  const modulePath = require.resolve('../../scripts/lib/compat-manifest-evidence.cjs'); const prior = require.cache[modulePath];
  cp.execFileSync = function(command, args, ...rest) {
    if (command === 'tar' && !changed) { changed = true; fs.writeFileSync(archive, replacement); }
    const result = real.call(this, command, args, ...rest);
    if (command === 'tar' && args[0].includes('O')) { fs.writeFileSync(archive, original); restored = true; }
    return result;
  };
  const output = path.join(root, 'out.json');
  try { delete require.cache[modulePath]; require(modulePath).captureManifestEvidence(output, archive); }
  finally { cp.execFileSync = real; require.cache[modulePath] = prior; }
  const result = JSON.parse(fs.readFileSync(output));
  assert.equal(changed, true); assert.equal(restored, true); assert.equal(hash(fs.readFileSync(archive)), hash(original));
  assert.equal(result.status, 'captured'); assert.equal(result.original.archive.sha256, hash(original));
  assert.equal(result.original.manifests[0].manifest.version, '1.0.0');
}));
