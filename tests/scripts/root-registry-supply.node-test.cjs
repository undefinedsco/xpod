const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { execFileSync } = childProcess;
// This host has no npm binary. Exercise the normal pack call/restore seam with
// tiny synthetic source tarballs, never installed payloads or product originals.
let failPack = false;
const realNpm = process.env.XPOD_TEST_REAL_NPM === '1';
childProcess.execFileSync = (command, args, options) => {
  if (!(command === 'npm' && args[0] === 'pack' || args.includes('npm.cmd') && args.includes('pack'))) return execFileSync(command, args, options);
  if (failPack) throw new Error('synthetic npm pack failure');
  if (realNpm) return execFileSync(command, args, options);
  const destination = args[args.indexOf('--pack-destination') + 1], stage = fs.mkdtempSync(path.join(destination, 'fixture-'));
  try {
    fs.mkdirSync(path.join(stage, 'package'));
    for (const name of ['package.json', 'index.js']) fs.copyFileSync(path.join(options.cwd, name), path.join(stage, 'package', name));
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package/package.json'))), filename = manifest.name.replace(/[^a-z0-9]/g, '-') + '.tgz';
    execFileSync('tar', ['czf', path.join(destination, filename), '-C', stage, 'package']);
    return JSON.stringify([{ filename }]);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
};
const { createRegistry } = require('../../scripts/check-package-registry-consumer.cjs');
const { observeRegistryClosure } = require('../../scripts/check-afs-js-archive-ci.cjs');
const helper = require('../../scripts/lib/root-registry-supply.cjs');
childProcess.execFileSync = execFileSync;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
async function fixture(operation) {
  const parent = path.resolve('.test-data/root-registry-supply'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')), git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const oldCache = process.env.npm_config_cache;
  try {
    write(path.join(root, '.gitignore'), '.test-data/\n');
    write(path.join(root, 'package.json'), { name: '@undefineds.co/xpod', version: '1.0.0', workspaces: ['packages/*'], dependencies: { '@fixture/first': 'workspace:*' } });
    for (const name of ['first', 'leaf']) {
      write(path.join(root, 'packages', name, 'package.json'), { name: '@fixture/' + name, version: '1.0.0', files: ['index.js'], main: 'index.js', ...(name === 'first' ? { dependencies: { '@fixture/leaf': 'workspace:*' } } : {}) });
      write(path.join(root, 'packages', name, 'index.js'), 'module.exports = ' + JSON.stringify(name) + ';\n');
    }
    for (const name of ['scripts/workspace-package-pack.cjs', 'scripts/lib/root-registry-supply.cjs']) write(path.join(root, name), fs.readFileSync(path.resolve(name), 'utf8'));
    git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const sha = git(['rev-parse', 'HEAD']).trim(), evidence = path.join(root, '.test-data/evidence'); fs.mkdirSync(evidence, { recursive: true });
    process.env.npm_config_cache = path.join(root, '.test-data/npm-cache');
    const bytes = Buffer.from('synthetic root bytes, not an actual Xpod producer');
    const original = path.join(evidence, 'root.tgz'); fs.writeFileSync(original, bytes);
    for (const kind of ['stdout', 'stderr']) write(path.join(evidence, 'build.' + kind), 'synthetic parent build output');
    const build = { command: ['bun', 'run', 'build'], actualExit: 0, signal: null, spawnError: null, actualWaitCompleted: true, rawLogsClosed: true,
      stdout: helper.reference(path.join(evidence, 'build.stdout')), stderr: helper.reference(path.join(evidence, 'build.stderr')) };
    const input = { kind: 'legacy-root-normal-build-input', sourceSha: sha, runId: process.env.GITHUB_RUN_ID || '1', runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || '1'), sourceBeforeStatus: '', build,
      archive: { ...helper.reference(original), integrity: sri(bytes) } };
    const inputFile = path.join(evidence, 'input.json'); write(inputFile, input);
    const rootArtifact = { bytes, integrity: sri(bytes), manifest: { name: '@undefineds.co/xpod', version: '1.0.0', dependencies: { '@fixture/first': '1.0.0' } } };
    await operation({ root, sha, input, inputFile, rootArtifact, evidence });
  } finally { if (oldCache === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = oldCache; fs.rmSync(root, { recursive: true, force: true }); }
}
test('normal pack seam on synthetic sources preserves manifests, derives transitive required and rejects substitutions', () => fixture(async context => {
  const { root, sha, input, inputFile, rootArtifact, evidence } = context;
  const manifestsBefore = ['first', 'leaf'].map(name => fs.readFileSync(path.join(root, 'packages', name, 'package.json')));
  const result = await helper.produceRootSupply({ root, inputFile, rootArtifact, destination: path.join(evidence, 'supply'), cache: path.join(root, '.test-data/cache') });
  assert.deepEqual(result.required, [{ name: '@fixture/first', version: '1.0.0' }, { name: '@fixture/leaf', version: '1.0.0' }]);
  for (const [index, name] of ['first', 'leaf'].entries()) assert.deepEqual(fs.readFileSync(path.join(root, 'packages', name, 'package.json')), manifestsBefore[index]);
  const requestFile = path.join(evidence, 'request.json');
  const update = record => { write(result.receipt.path, record); write(requestFile, { receipt: helper.reference(result.receipt.path) }); };
  const original = JSON.parse(fs.readFileSync(result.receipt.path)); update(original);
  assert.equal(helper.readRootSupply(requestFile, root, rootArtifact).artifacts.length, 2);
  for (const kind of ['missing-transitive', 'duplicate', 'wrong-source', 'empty-required', 'wrong-sri', 'changed-archive', 'missing-tools']) {
    const record = structuredClone(original);
    if (kind === 'missing-transitive') record.artifacts = record.artifacts.filter(row => row.name !== '@fixture/leaf');
    if (kind === 'duplicate') record.artifacts.push(record.artifacts[0]);
    if (kind === 'wrong-source') record.sourceSha = '0'.repeat(40);
    if (kind === 'empty-required') record.required = [];
    if (kind === 'wrong-sri') record.artifacts[0].integrity = sri(Buffer.from('wrong'));
    if (kind === 'changed-archive') record.artifacts[0].sha256 = '0'.repeat(64);
    if (kind === 'missing-tools') record.producerTools = [];
    update(record); assert.throws(() => helper.readRootSupply(requestFile, root, rootArtifact), undefined, kind);
  }
  update(original);
  write(inputFile, { ...input, sourceSha: '0'.repeat(40) }); assert.throws(() => helper.readRootSupply(requestFile, root, rootArtifact), /source mismatch/);
  write(inputFile, input);
  const broken = { ...input, build: { ...input.build, actualExit: 1 } }; write(inputFile, broken);
  assert.throws(() => helper.verifyBuild(inputFile, root, rootArtifact), /Actual root build/);
  write(inputFile, { ...input, runAttempt: 0 }); assert.throws(() => helper.verifyBuild(inputFile, root, rootArtifact), /run\/attempt/);
  write(inputFile, input); fs.appendFileSync(input.build.stdout.path, 'tampered'); assert.throws(() => helper.verifyBuild(inputFile, root, rootArtifact), /reference mismatch/);
}));
test('source restoration is mandatory even when the normal pack command fails', () => fixture(async ({ root }) => {
  const file = path.join(root, 'packages/first/package.json'), bytes = fs.readFileSync(file);
  failPack = true;
  try { assert.throws(() => require('../../scripts/workspace-package-pack.cjs').packWorkspacePackages(root, ['first'], path.join(root, '.test-data/out'), 'a'.repeat(40))); }
  finally { failPack = false; }
  assert.deepEqual(fs.readFileSync(file), bytes);
}));
test('external identity pin is independent of the Xpod candidate and cannot be replaced by a newly hashed claim', () => {
  const source = { repository: 'owner/external', commit: 'a'.repeat(40) }, authority = { git: new Map([['@fixture/external', source]]) };
  const record = { name: '@fixture/external', source, sourceBefore: { sourceSha: source.commit }, sourceAfter: { sourceSha: source.commit } };
  assert.equal(helper.verifyExternalPin(record.name, authority, [record]), record);
  for (const change of [{ source: { ...source, commit: 'b'.repeat(40) } }, { sourceAfter: { sourceSha: 'b'.repeat(40) } }]) assert.throws(() => helper.verifyExternalPin(record.name, authority, [{ ...record, ...change }]), /pin mismatch/);
  assert.throws(() => helper.verifyExternalPin(record.name, authority, [record, record]), /pin mismatch/);
});
test('missing private dependencies cannot be hidden by an empty required list or an undeclared workspace edge', () => {
  const authority = { workspaces: new Map([['@fixture/one', {}], ['@fixture/two', {}]]), git: new Map() };
  assert.throws(() => helper.requiredArtifacts({ dependencies: { '@fixture/one': '1.0.0' } }, [], authority), /Missing exact private/);
  assert.throws(() => helper.requiredArtifacts({ dependencies: { '@fixture/unknown': 'workspace:*' } }, [], authority), /Unknown private/);
  assert.throws(() => helper.requiredArtifacts({ dependencies: { '@fixture/one': '2.0.0' } }, [{ name: '@fixture/one', version: '1.0.0' }], authority), /range mismatch/);
  assert.throws(() => helper.requiredArtifacts({ dependencies: { '@fixture/one': '2.0.0' }, peerDependencies: { '@fixture/one': '1.0.0' } }, [{ name: '@fixture/one', version: '1.0.0' }], authority), /range mismatch/);
});
test('original publication dependency/bundle metadata cannot be repaired or silently discarded', () => {
  const bytes = Buffer.from('synthetic'), value = { bytes, integrity: sri(bytes), manifest: { name: '@fixture/one', version: '1.0.0', dependencies: { '@fixture/two': '1.0.0' }, bundledDependencies: ['@fixture/two'] } };
  const version = { ...value.manifest, dist: { integrity: value.integrity, shasum: crypto.createHash('sha1').update(bytes).digest('hex') } };
  delete version.bundledDependencies; version.bundleDependencies = ['@fixture/two'];
  const metadata = { name: value.manifest.name, versions: { '1.0.0': version } }; helper.verifyPublicationMetadata(value, metadata);
  for (const field of ['dependencies', 'bundleDependencies']) { const changed = structuredClone(metadata); delete changed.versions['1.0.0'][field]; assert.throws(() => helper.verifyPublicationMetadata(value, changed), /metadata changed/); }
});
test('bounded original reader rejects symlinks, hardlinks and actual FIFOs without blocking', () => fixture(({ evidence }) => {
  const file = path.join(evidence, 'original'); fs.writeFileSync(file, 'original');
  const link = path.join(evidence, 'link'); fs.symlinkSync(file, link); assert.throws(() => helper.readRegular(link), /Invalid supply original/);
  const hard = path.join(evidence, 'hard'); fs.linkSync(file, hard); assert.throws(() => helper.readRegular(hard), /Invalid supply original/); fs.unlinkSync(hard);
  if (process.platform !== 'win32') { const fifo = path.join(evidence, 'fifo'); execFileSync('mkfifo', [fifo], { timeout: 1000 }); assert.throws(() => helper.readRegular(fifo), /Invalid supply original/); }
}));
test('partial PUT on the reused exact registry fails bounded closure without admitting publication', async () => {
  const http = require('node:http'), bytes = Buffer.from('synthetic root'), artifact = { bytes, integrity: sri(bytes), manifest: { name: '@undefineds.co/xpod', version: '1.0.0' } };
  const server = createRegistry(artifact, 'test-token'), observed = observeRegistryClosure(server, { drainMs: 20, forceMs: 100 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/@undefineds.co%2fxpod', method: 'PUT', headers: { authorization: 'Bearer test-token', 'content-length': 1000 } });
  request.on('error', () => {}); request.write('{');
  await new Promise(resolve => setTimeout(resolve, 20));
  const closure = await observed.close(); request.destroy();
  assert.equal(server.publishedMetadata(), undefined); assert.equal(closure.state, 'forced-closed'); assert.equal(closure.remainingSockets, 0);
});
test('tiny real npm pack and npm PUT preserve original dependencies, aliases and tar bytes', { skip: !realNpm }, async () => {
  const { publishArtifact } = require('../../scripts/check-package-registry-consumer.cjs');
  const parent = path.resolve('.test-data/root-registry-real-put'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')), out = path.join(root, 'archives'); fs.mkdirSync(out);
  let server, observed;
  try {
    const manifests = [{ name: '@fixture/real-dependency', version: '1.0.0', main: 'index.js', files: ['index.js'] },
      { name: '@undefineds.co/xpod', version: '1.0.0', main: 'index.js', files: ['index.js'], dependencies: { '@fixture/real-dependency': '1.0.0' }, bundledDependencies: ['@fixture/real-dependency'] }];
    const artifacts = manifests.map((manifest, index) => {
      const directory = path.join(root, 'source-' + index); write(path.join(directory, 'package.json'), manifest); write(path.join(directory, 'index.js'), 'module.exports = 1;\n');
      if (index) fs.cpSync(path.join(root, 'source-0'), path.join(directory, 'node_modules/@fixture/real-dependency'), { recursive: true });
      const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out, '--cache', path.join(root, 'cache')], { cwd: directory, encoding: 'utf8' }))[0];
      const file = path.join(out, packed.filename), bytes = fs.readFileSync(file);
      return helper.artifact({ ...helper.reference(file), name: manifest.name, version: manifest.version, integrity: sri(bytes) });
    });
    const token = 'test-only-token'; server = createRegistry(artifacts[1], token, undefined, { artifacts: [artifacts[0]], required: [{ name: artifacts[0].manifest.name, version: '1.0.0' }] });
    observed = observeRegistryClosure(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const registry = 'http://127.0.0.1:' + server.address().port;
    for (const [index, value] of artifacts.entries()) {
      const evidence = path.join(root, 'publication-' + index); fs.mkdirSync(evidence);
      await publishArtifact(value, registry, token, evidence);
      const metadata = server.publishedMetadata(value.manifest.name); helper.verifyPublicationMetadata(value, metadata);
      const response = await fetch(metadata.versions['1.0.0'].dist.tarball);
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), value.bytes);
    }
    console.log('[root-supply-real-put]', JSON.stringify({ npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), packages: artifacts.map(row => ({ name: row.manifest.name, bytes: row.bytes.length, sha256: hash(row.bytes) })), syntheticSourceFixture: true, installPerformed: false }));
  } finally {
    if (observed) { const closure = await observed.close(); assert.equal(closure.state, 'natural-closed'); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
