const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { artifact, extract, cliArtifacts, closedOriginal } = require('../../scripts/check-afs-js-archive-ci.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(run) {
  const parent = path.resolve(__dirname, '../../.test-data/afs-js-archive-ci'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('normal archive binding rejects changed bytes, identity and symlinks before extraction', () => fixture(root => {
  const file = path.join(root, 'original.tgz'); fs.writeFileSync(file, 'not a gzip');
  const bytes = fs.readFileSync(file), bound = { path: file, bytes: bytes.length, sha256: hash(bytes), integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
  assert.throws(() => artifact({ ...bound, sha256: '0'.repeat(64) }, '@fixture/normal'));
  assert.throws(() => artifact(bound, '@fixture/normal'));
  const link = path.join(root, 'alias.tgz'); fs.symlinkSync(file, link); assert.throws(() => artifact({ ...bound, path: link }, '@fixture/normal'));
}));
test('normal input extraction preserves exact modes/bytes and rejects link or unknown root', () => fixture(root => {
  const entries = [{ path: 'package/package.json', type: 'file', mode: 0o644, content: Buffer.from('{"name":"@fixture/normal"}') }, { path: 'package/tool.cjs', type: 'file', mode: 0o755, content: Buffer.from('module.exports=1') }];
  const target = extract({ entries }, path.join(root, 'input'));
  assert.equal(fs.readFileSync(path.join(target, 'tool.cjs'), 'utf8'), 'module.exports=1'); assert.equal(fs.statSync(path.join(target, 'tool.cjs')).mode & 0o777, 0o755);
  assert.throws(() => extract({ entries }, path.join(root, 'input')));
  for (const entry of [{ ...entries[0], type: 'symlink' }, { ...entries[0], path: 'elsewhere/package.json' }]) assert.throws(() => extract({ entries: [entry] }, path.join(root, 'bad')));
}));
test('CLI originals cannot claim another checkout or copied input not in the source snapshot', () => fixture(root => {
  const write = (name, data) => fs.writeFileSync(path.join(root, name), JSON.stringify(data));
  const context = { checkoutSha: 'a'.repeat(40), workingTreeDirty: false };
  const result = { kind: 'cli-publication-preparation-producer', context, privateConsumerArtifactsReused: false, embeddedClientIdentityVerified: true, published: false, releaseQualified: false };
  write('result.json', result);
  assert.throws(() => cliArtifacts(root, { sourceSha: 'b'.repeat(40), files: [] }));
  write('source-inputs.json', { context, files: [{ path: 'untracked.ts', bytes: 1, sha256: 'x' }] });
  assert.throws(() => cliArtifacts(root, { sourceSha: context.checkoutSha, files: [] }));
}));
test('a successful exit cannot substitute for actual wait, EOF, complete output or exact raw bytes', () => fixture(root => {
  const raw = ['stdout', 'stderr'].map(name => { fs.writeFileSync(path.join(root, 'test.' + name + '.raw.log'), name); return { path: 'test.' + name + '.raw.log', bytes: name.length, sha256: hash(Buffer.from(name)) }; });
  const good = { code: 0, signal: null, actualWait: true, actualClose: true, groupAbsent: true, rawComplete: true, rawClosed: true, rawClosedBeforeHash: true, pipeEOF: [true, true], raw };
  closedOriginal(good, root);
  for (const key of ['actualWait', 'actualClose', 'groupAbsent', 'rawComplete', 'rawClosed', 'rawClosedBeforeHash']) assert.throws(() => closedOriginal({ ...good, [key]: false }, root));
  assert.throws(() => closedOriginal({ ...good, pipeEOF: [true, false] }, root));
  assert.throws(() => closedOriginal({ ...good, raw: [raw[0], raw[0]] }, root));
  assert.throws(() => closedOriginal({ ...good, raw: [raw[1], raw[0]] }, root));
  fs.writeFileSync(path.join(root, 'test.stdout.raw.log'), 'changed'); assert.throws(() => closedOriginal(good, root));
}));

test('valid tiny tgz keeps original identity and rejects a mismatched requested package', () => fixture(root => {
  const pkg = path.join(root, 'package'); fs.mkdirSync(pkg); fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/normal', version: '1.0.0' }));
  const file = path.join(root, 'normal.tgz'); require('tar').c({ sync: true, gzip: true, cwd: root, file }, ['package']);
  const bytes = fs.readFileSync(file), bound = { path: file, bytes: bytes.length, sha256: hash(bytes), integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
  assert.equal(artifact(bound, '@fixture/normal').manifest.version, '1.0.0');
  assert.throws(() => artifact(bound, '@fixture/other'));
  fs.appendFileSync(file, 'changed'); assert.throws(() => artifact(bound, '@fixture/normal'));
}));


const { observeRegistryClosure, finalizeRun, failureDetails } = require('../../scripts/check-afs-js-archive-ci.cjs');
const { createExactArtifactRegistry } = require('../../scripts/check-package-registry-consumer.cjs');
function tinyRegistry() {
  const bytes = Buffer.from('fixture');
  return createExactArtifactRegistry([{ manifest: { name: '@fixture/local', version: '1.0.0' }, bytes,
    integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') }], 'fixture-token');
}
test('normal registry close is observed naturally without forced or inferred closure', async () => {
  const server = tinyRegistry(), lifecycle = observeRegistryClosure(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/@fixture/local`); await response.arrayBuffer();
  assert.equal(response.status, 404);
  const result = await lifecycle.close();
  assert.equal(result.state, 'natural-closed'); assert.equal(result.serverCloseObserved, true);
  assert.equal(result.forceAttempted, false); assert.equal(result.remainingSockets, 0); assert.deepEqual(result.errors, []);
});
test('real partial PUT is force-closed within bounds while primary, source failure and final receipt survive', async () => {
  const server = tinyRegistry(), lifecycle = observeRegistryClosure(server, { drainMs: 20, forceMs: 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const requested = new Promise(resolve => server.once('request', resolve));
  const socket = require('node:net').connect(server.address().port, '127.0.0.1'); socket.on('error', () => {});
  const parent = path.resolve(__dirname, '../../.test-data/afs-js-archive-ci'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'partial-'));
  try {
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('PUT /%40fixture%2Flocal HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer fixture-token\r\nContent-Length: 1000\r\n\r\nx');
    await requested;
    const original = new Error('original operation failure'), sourceFailure = new Error('source verification failure');
    let afterAttempted = false; const started = performance.now();
    const failure = await finalizeRun({ lifecycle, primary: original,
      sourceAfter: () => { afterAttempted = true; fs.writeFileSync(path.join(directory, 'source-after.original.json'), '{}'); throw sourceFailure; },
      persist: ({ primary, registry }) => fs.writeFileSync(path.join(directory, 'ci.original.json'), JSON.stringify({ errors: failureDetails(primary), registry })) });
    assert.ok(performance.now() - started < 1500); assert.equal(afterAttempted, true);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'ci.original.json')));
    assert.equal(receipt.registry.state, 'forced-closed'); assert.equal(receipt.registry.forceAttempted, true);
    assert.equal(receipt.registry.serverCloseObserved, true); assert.equal(receipt.registry.remainingSockets, 0);
    assert.ok(fs.existsSync(path.join(directory, 'source-after.original.json')));
    assert.equal(failure.errors[0].errors[0], original); assert.equal(failure.errors[1], sourceFailure);
    assert.match(JSON.stringify(receipt.errors), /original operation failure/); assert.match(JSON.stringify(receipt.errors), /Registry closure: forced-closed/); assert.match(JSON.stringify(receipt.errors), /source verification failure/);
  } finally { socket.destroy(); await lifecycle.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('unknown closure never invents close and receipt errors preserve earlier failures', async () => {
  // Controlled unresponsive close observer, not an HTTP/server qualification.
  const server = new (require('node:events').EventEmitter)(); server.close = () => {}; server.closeAllConnections = () => {};
  const lifecycle = observeRegistryClosure(server, { drainMs: 10, forceMs: 10 });
  const original = new Error('original'), persistFailure = new Error('receipt write failed'); let after = false, recorded;
  const failure = await finalizeRun({ lifecycle, primary: original, sourceAfter: () => { after = true; }, persist: value => { recorded = value; throw persistFailure; } });
  assert.equal(after, true); assert.equal(recorded.registry.state, 'unknown'); assert.equal(recorded.registry.serverCloseObserved, false);
  assert.equal(recorded.registry.forceAttempted, true); assert.equal(failure.errors[0].errors[0], original); assert.equal(failure.errors[1], persistFailure);
});

test('server close callback errors cannot be lost behind an earlier close event', async () => {
  const server = new (require('node:events').EventEmitter)();
  server.close = callback => { server.emit('close'); callback(Object.assign(new Error('close failed'), { code: 'E_CLOSE' })); };
  server.closeAllConnections = () => {};
  const lifecycle = observeRegistryClosure(server, { drainMs: 10, forceMs: 10 });
  let after = false, receipt;
  const failure = await finalizeRun({ lifecycle, sourceAfter: () => { after = true; }, persist: value => { receipt = value; } });
  assert.equal(after, true); assert.ok(failure); assert.equal(receipt.registry.serverCloseObserved, true);
  assert.equal(receipt.registry.closeCallbackObserved, true); assert.deepEqual(receipt.registry.errors, [{ operation: 'server-close', code: 'E_CLOSE' }]);
});

test('driver coordinates satisfy the original CLI entry boundary without running a producer', () => {
  const { normalCliEvidence } = require('../../scripts/check-afs-js-archive-ci.cjs');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '../..'), entry = path.join(root, 'scripts/check-cli-publication.cjs');
  const target = normalCliEvidence(root);
  assert.equal(fs.existsSync(target), false); fs.mkdirSync(target, { recursive: true });
  try {
    // Existing evidence short-circuits produce() before source/context/install/build.
    const inside = spawnSync(process.execPath, [entry, '--evidence', target], { encoding: 'utf8' });
    assert.equal(inside.status, 1); assert.match(inside.stderr, /publication_evidence_already_exists/);
    assert.doesNotMatch(inside.stderr, /publication_evidence_invalid/);
    const outside = spawnSync(process.execPath, [entry, '--evidence', path.join(root, '..', 'afs-outside-' + process.pid)], { encoding: 'utf8' });
    assert.equal(outside.status, 1); assert.match(outside.stderr, /publication_evidence_invalid/);
    assert.deepEqual(fs.readdirSync(target), []);
    const ignored = spawnSync('git', ['check-ignore', path.relative(root, target)], { cwd: root, encoding: 'utf8' });
    assert.equal(ignored.status, 0);
  } finally { fs.rmdirSync(target); }
});

test('workflow preserves both exact evidence roots even when the CLI root is hidden', () => {
  const workflow = require('yaml').parse(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/afs-js-archive-consumer.yml'), 'utf8'));
  const uploads = workflow.jobs['normal-archive'].steps.filter(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(uploads.length, 2); assert.ok(uploads.every(step => step.if === 'always()'));
  const cli = uploads.find(step => step.with.path === '.test-data/afs-js-archive-ci-producer/');
  assert.ok(cli); assert.equal(cli.with['include-hidden-files'], true);
  assert.ok(uploads.some(step => step.with.path === '${{ runner.temp }}/afs-js-archive/'));
});
