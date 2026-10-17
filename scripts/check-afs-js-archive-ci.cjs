#!/usr/bin/env node
// CI orchestration only: existing normal producers, registry PUT and archive probe.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { snapshotWorkspace } = require('./collect-workspace-normal-run.cjs');
const { inspectTarballBuffer, sha512Integrity } = require('./workspace-package-payload.cjs');
const { runPublicationCommand } = require('./lib/afs-publication-command.cjs');
const { createExactArtifactRegistry, publishArtifact } = require('./check-package-registry-consumer.cjs');
const { verifyInstalledArchive } = require('./check-afs-client-publication.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ref = file => { const bytes = fs.readFileSync(file); return { path: file, bytes: bytes.length, sha256: hash(bytes) }; };
const json = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function artifact(bound, name) {
  assert.equal(fs.lstatSync(bound.path).isSymbolicLink(), false);
  const bytes = fs.readFileSync(bound.path);
  assert.equal(bytes.length, bound.bytes); assert.equal(hash(bytes), bound.sha256); assert.equal(sha512Integrity(bytes), bound.integrity);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Normal archive budget exceeded');
  zlib.gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  const inspected = inspectTarballBuffer(bytes);
  assert.equal(inspected.manifest.name, name);
  return { tarball: bound.path, bytes, manifest: inspected.manifest, integrity: bound.integrity, entries: inspected.entries };
}
function closedOriginal(phase, directory) {
  assert.equal(phase.code, 0); assert.equal(phase.signal, null);
  for (const key of ['actualWait', 'actualClose', 'groupAbsent', 'rawComplete', 'rawClosed', 'rawClosedBeforeHash']) assert.equal(phase[key], true);
  assert.deepEqual(phase.pipeEOF, [true, true]); assert.equal(phase.raw.length, 2);
  assert.equal(new Set(phase.raw.map(row => row.path)).size, 2);
  for (const [index, channel] of ['stdout', 'stderr'].entries()) assert.ok(phase.raw[index].path.endsWith('.' + channel + '.raw.log'));
  for (const row of phase.raw) {
    assert.equal(path.basename(row.path), row.path);
    if (row.status !== undefined) assert.equal(row.status, 'complete');
    const actual = ref(path.join(directory, row.path)); assert.equal(actual.bytes, row.bytes); assert.equal(actual.sha256, row.sha256);
  }
}
function extract(archive, destination) {
  if (fs.existsSync(destination)) throw new Error('Fresh normal input required');
  for (const entry of archive.entries) {
    if (!(entry.path.startsWith('package/') || entry.path === 'package' && entry.type === 'directory') || !['file', 'directory'].includes(entry.type) || (entry.mode & 0o7000)) throw new Error('Normal input layout rejected');
  }
  fs.mkdirSync(destination);
  for (const entry of archive.entries) {
    const file = path.join(destination, entry.path);
    if (entry.type === 'directory') fs.mkdirSync(file, { recursive: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entry.content, { flag: 'wx', mode: entry.mode }); fs.chmodSync(file, entry.mode); }
  }
  const installed = path.join(destination, 'package');
  verifyInstalledArchive(installed, archive.entries);
  return installed;
}
function closedCliOriginals(cleanup, directory) {
  assert.equal(cleanup.schemaVersion, 1);
  assert.equal(cleanup.kind, 'cli-publication-owned-command-cleanup');
  assert.equal(cleanup.success, true); assert.equal(cleanup.sourceAbsent, true);
  assert.equal(cleanup.commandOutcomes.length, 10);
  for (const [index, command] of cleanup.commandOutcomes.entries()) {
    const { phase, receipt, ...outcome } = command;
    assert.equal(typeof phase, 'string');
    assert.equal(receipt.path, 'phase-' + String(index).padStart(3, '0') + '.receipt.json');
    const file = path.join(directory, receipt.path);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(ref(file).sha256, receipt.sha256);
    const original = json(file);
    assert.deepEqual(outcome, original);
    closedOriginal(original, directory);
  }
}
function cliArtifacts(directory, before) {
  const result = json(path.join(directory, 'result.json'));
  assert.equal(result.kind, 'cli-publication-preparation-producer');
  assert.equal(result.context.checkoutSha, before.sourceSha); assert.equal(result.context.workingTreeDirty, false);
  assert.equal(result.privateConsumerArtifactsReused, false); assert.equal(result.embeddedClientIdentityVerified, true);
  assert.equal(result.published, false); assert.equal(result.releaseQualified, false);
  const source = json(path.join(directory, 'source-inputs.json'));
  assert.deepEqual(source.context, result.context);
  const tracked = new Map(before.files.map(file => [file.path, file]));
  assert.ok(source.files.length > 0);
  for (const file of source.files) { const actual = tracked.get(file.path); assert.ok(actual?.matchesGit); assert.equal(actual.bytes, file.bytes); assert.equal(actual.sha256, file.sha256); }
  const cleanup = json(path.join(directory, 'cleanup.json'));
  closedCliOriginals(cleanup, directory);
  return Object.fromEntries(['cli', 'client'].map(id => {
    const product = result.products[id], bound = { ...product.archive, path: path.join(directory, product.archive.path) };
    if (!['cli.tgz', 'client.tgz'].includes(product.archive.path)) throw new Error('Unexpected normal archive path');
    const value = artifact(bound, '@undefineds.co/xpod-' + id); assert.equal(value.manifest.version, product.version); return [id, value];
  }));
}
// Track the existing HTTP server's sockets before listen; never create a second service.
function observeRegistryClosure(server, { drainMs = 250, forceMs = 1000 } = {}) {
  for (const budget of [drainMs, forceMs]) if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1000) throw new Error('Invalid registry closure budget');
  const sockets = new Set(); let serverCloseObserved = false, closeCallbackObserved = false;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); check?.(); }); });
  server.once('close', () => { serverCloseObserved = true; check?.(); });
  let check, shutdown;
  return { close() {
    if (shutdown) return shutdown;
    shutdown = new Promise(resolve => {
      const started = performance.now(), errors = []; let forced = false, finished = false, timer;
      const finish = () => {
        if (finished) return; finished = true; clearTimeout(timer); check = undefined;
        resolve({ state: serverCloseObserved && closeCallbackObserved && sockets.size === 0 ? forced ? 'forced-closed' : 'natural-closed' : 'unknown',
          serverCloseObserved, closeCallbackObserved, remainingSockets: sockets.size, forceAttempted: forced,
          elapsedMs: performance.now() - started, drainMs, forceMs, errors: errors.map(error => ({ ...error })) });
      };
      check = () => { if (serverCloseObserved && closeCallbackObserved && sockets.size === 0) finish(); };
      // Wait only within these observation budgets. A timer firing is never a close fact.
      timer = setTimeout(() => {
        forced = true;
        try { server.closeAllConnections(); } catch (error) { errors.push({ operation: 'close-all-connections', code: error.code ?? null }); }
        for (const socket of sockets) try { socket.destroy(); } catch (error) { errors.push({ operation: 'socket-destroy', code: error.code ?? null }); }
        if (!finished) timer = setTimeout(finish, forceMs); check?.();
      }, drainMs);
      try { server.close(error => { closeCallbackObserved = true; if (error) errors.push({ operation: 'server-close', code: error.code ?? null }); check?.(); }); }
      catch (error) { errors.push({ operation: 'server-close', code: error.code ?? null }); }
      check?.();
    });
    return shutdown;
  } };
}
const combineFailure = (primary, secondary) => primary ? new AggregateError([primary, secondary], 'CI operation and finalization failed') : secondary;
function failureDetails(error) {
  return error ? { name: error.name, message: error.message, code: error.code ?? null,
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(failureDetails) } : {}) } : null;
}
// Each finalizer is attempted independently; a shutdown error cannot skip source/receipt.
async function finalizeRun({ lifecycle, primary, sourceAfter, persist }) {
  let registry = { state: lifecycle ? 'unknown' : 'not-started' };
  if (lifecycle) try {
    registry = await lifecycle.close();
    if (registry.state !== 'natural-closed' || registry.errors.length) throw new Error('Registry closure: ' + registry.state);
  } catch (error) { primary = combineFailure(primary, error); }
  try { await sourceAfter(); } catch (error) { primary = combineFailure(primary, error); }
  try { await persist({ primary, registry }); } catch (error) { primary = combineFailure(primary, error); }
  return primary;
}
// The original CLI entry requires a fresh child of the checkout's ignored .test-data.
// AFS/consumer evidence has a separate external-directory contract.
const normalCliEvidence = root => path.join(root, '.test-data', 'afs-js-archive-ci-producer');
async function main(output) {
  const root = path.resolve(__dirname, '..');
  output = path.resolve(output);
  const parent = path.dirname(output);
  if (fs.realpathSync(parent) !== parent || fs.existsSync(output)) throw new Error('Fresh canonical evidence required');
  // Original archive consumer requires no package ancestor; use RUNNER_TEMP.
  for (let current = parent;; current = path.dirname(current)) { if (fs.existsSync(path.join(current, 'package.json'))) throw new Error('Evidence must be outside package ancestors'); if (path.dirname(current) === current) break; }
  fs.mkdirSync(output);
  const phases = []; let before, after, server, lifecycle, primary;
  const phase = async (command, args, label, env = process.env) => {
    try { const result = await runPublicationCommand(command, args, { cwd: root, env, evidence: output, label }); phases.push(result); return result; }
    catch (error) { if (error.outcome) phases.push(error.outcome); throw error; }
  };
  try {
    before = snapshotWorkspace(root, output, 'before'); write(path.join(output, 'source-before.original.json'), before);
    assert.ok(before.clean && before.files.every(file => file.matchesGit));
    assert.equal(before.sourceSha, process.env.GITHUB_SHA);
    const cliDirectory = normalCliEvidence(root);
    await phase(process.execPath, [path.join(root, 'scripts/check-cli-publication.cjs'), '--evidence', cliDirectory], 'normal-cli');
    const normal = cliArtifacts(cliDirectory, before);
    const cliRoot = extract(normal.cli, path.join(output, 'cli-input'));
    const clientRoot = extract(normal.client, path.join(output, 'client-input'));
    const producer = path.join(output, 'afs');
    await phase('bun', [path.join(root, 'packages/xpod-afs/scripts/build-client-publication.ts'), '--cli-package', cliRoot, '--client-package', clientRoot, '--output', producer], 'normal-afs');
    const publication = path.join(producer, 'publication.original.json'), receipt = json(publication);
    closedOriginal(receipt.command, producer);
    const afs = artifact(receipt.archive, '@undefineds.co/xpod-afs');
    assert.equal(afs.manifest.version, receipt.version);
    assert.deepEqual(afs.manifest, receipt.stage.manifest);
    const expected = new Map(receipt.stage.inventory.map(row => ['package/' + row.path, row]));
    const members = afs.entries.filter(row => row.type === 'file'); assert.equal(members.length, expected.size);
    for (const member of members) { const row = expected.get(member.path); assert.ok(row); assert.equal(member.content.length, row.bytes); assert.equal(hash(member.content), row.sha256); assert.equal(member.mode, row.mode); }
    assert.equal(afs.manifest.dependencies['@undefineds.co/xpod-client'], normal.client.manifest.version);
    // Both first-party identities are reserved locally, including before PUT.
    const supply = [afs, normal.client];
    const token = crypto.randomBytes(24).toString('hex');
    server = createExactArtifactRegistry(supply, token, 'https://registry.npmjs.org', supply.map(row => ({ name: row.manifest.name, version: row.manifest.version })));
    lifecycle = observeRegistryClosure(server);
    await new Promise((resolve, reject) => {
      const onError = error => reject(error); server.once('error', onError);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
    });
    const registry = `http://127.0.0.1:${server.address().port}/`;
    for (const [index, value] of supply.entries()) {
      const directory = path.join(output, 'publish-' + index); fs.mkdirSync(directory);
      const request = path.join(directory, 'request.original.json');
      write(request, { artifact: { ...ref(value.tarball), integrity: value.integrity }, name: value.manifest.name, registry, evidence: directory });
      await phase(process.execPath, [__filename, '--publish', request], 'npm-put-' + index, { ...process.env, XPOD_FIXTURE_TOKEN: token });
      const metadata = server.publishedMetadata(value.manifest.name);
      assert.ok(metadata?.versions?.[value.manifest.version]); write(path.join(directory, 'metadata.original.json'), metadata);
    }
    const toolPath = require.resolve('typescript/lib/tsc.js');
    const request = path.join(output, 'consumer-request.original.json');
    write(request, { publicationReceipt: publication, publicationReceiptSHA256: ref(publication).sha256, registry, output: path.join(output, 'consumer'), typescriptTool: ref(toolPath) });
    await phase(process.execPath, [path.join(root, 'scripts/check-afs-client-publication.cjs'), request], 'archive-consumers');
    const consumed = json(path.join(output, 'consumer/consumer.original.json'));
    assert.equal(consumed.passed, true); assert.equal(consumed.consumersRemoved, true);
    assert.equal(consumed.phases.length, 6);
    for (const outcome of consumed.phases) closedOriginal(outcome, path.join(output, 'consumer'));
  } catch (error) { primary = error; }
  finally {
    primary = await finalizeRun({ lifecycle, primary,
      sourceAfter: () => { after = snapshotWorkspace(root, output, 'after'); write(path.join(output, 'source-after.original.json'), after); assert.ok(after.clean); assert.equal(after.sourceSha, before.sourceSha); assert.equal(after.inputSHA256, before.inputSHA256); },
      persist: ({ primary: failure, registry }) => write(path.join(output, 'ci.original.json'), { kind: 'afs-js-normal-ci', source: before?.sourceSha ?? null, cliEvidence: normalCliEvidence(root), passed: !failure, phases, registryClosure: registry, sourceBefore: fs.existsSync(path.join(output, 'source-before.original.json')) ? ref(path.join(output, 'source-before.original.json')) : null, sourceAfter: fs.existsSync(path.join(output, 'source-after.original.json')) ? ref(path.join(output, 'source-after.original.json')) : null, error: failure ? String(failure.stack || failure) : null, errors: failureDetails(failure), dependencyTransport: 'first-party exact npm PUT on loopback; public recursion via npmjs using unchanged resolver, not offline', sourceAdmission: false, legalQualified: false, nativeQualified: false, releaseQualified: false, published: false })
    });
  }
  if (primary) throw primary;
}
module.exports = { closedCliOriginals, normalCliEvidence, artifact, extract, cliArtifacts, closedOriginal, observeRegistryClosure, finalizeRun, failureDetails };
if (require.main === module) (async () => {
  if (process.argv[2] === '--publish' && process.argv.length === 4) {
    const request = json(process.argv[3]);
    if (!process.env.XPOD_FIXTURE_TOKEN) throw new Error('Ephemeral loopback token required');
    await publishArtifact(artifact(request.artifact, request.name), request.registry, process.env.XPOD_FIXTURE_TOKEN, request.evidence);
  } else if (process.argv.length === 3) await main(process.argv[2]);
  else throw new Error('Expected fresh external evidence path');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n' + JSON.stringify(failureDetails(error)) + '\n'); process.exitCode = 1; });
