// Same-workflow original normal JS supply. No alternate package emitter.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { snapshotWorkspace } = require('../collect-workspace-normal-run.cjs');
const { runPublicationCommand } = require('./afs-publication-command.cjs');
const normal = require('../check-afs-js-archive-ci.cjs');
const tools = ['scripts/check-cli-publication.cjs', 'scripts/check-afs-js-archive-ci.cjs', 'scripts/lib/afs-publication-command.cjs', 'scripts/lib/legacy-afs-supply.cjs', 'scripts/lib/legacy-cli-original-projection.cjs', 'scripts/lib/legacy-afs-publication-budget.cjs', 'scripts/lib/cli-publication-budget.cjs', 'scripts/lib/product-artifact-command.cjs', 'scripts/lib/legacy-root-artifact-context.cjs', 'scripts/legacy-root-afs-supply.ts', 'scripts/acquire-independent-product-input.ts', 'scripts/lib/inspect-product-artifact.py', 'scripts/lib/module-artifact-limits.json', 'packages/xpod-afs/scripts/build-client-publication.ts', 'packages/xpod-afs/scripts/client-publication.cjs', 'packages/xpod-afs/scripts/client-publication-run.cjs'];
const MAX = 8 * 1024 ** 2;
function io() { return require('./root-registry-supply.cjs'); }
function json(file) { return JSON.parse(io().readRegular(file)); }
function portable(name) {
  if (typeof name !== 'string' || !/^(?:cli|afs|producer)\//.test(name) || /[\\:\x00-\x1f\x7f]/.test(name) || name.split('/').some(p => ['', '.', '..'].includes(p))) throw new Error('Invalid original member');
  return name;
}
function inventory(root) {
  const rows = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const member = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) visit(member);
      else { portable(member); const ref = io().reference(path.join(root, member)); rows.push({ member, bytes: ref.bytes, sha256: ref.sha256 }); }
    }
  }
  visit('');
  if (rows.length > 4095 || rows.reduce((n, row) => n + row.bytes, 0) > 39 * 1024 ** 2) throw new Error('Normal supply inventory budget');
  return rows.sort((a, b) => a.member.localeCompare(b.member));
}
function copyTree(source, destination) {
  fs.mkdirSync(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const target = path.join(destination, entry.name), original = path.join(source, entry.name);
    if (entry.isDirectory()) copyTree(original, target);
    else fs.writeFileSync(target, io().readRegular(original, entry.name === 'artifact.zip' ? 16 * 1024 ** 2 : MAX), { flag: 'wx', mode: 0o600 });
  }
}
const NODE_PROBE = "if(process.versions.bun||Number(process.versions.node.split('.')[0])!==22)throw new Error('Normal CLI requires Node 22');process.stdout.write(JSON.stringify({execPath:process.execPath,node:process.versions.node,bun:process.versions.bun??null}))";
async function runNormalCli(root, control, cliDirectory) {
  const runtime = await runPublicationCommand('node', ['-e', NODE_PROBE], { cwd: root, evidence: control, label: 'normal-node' });
  const qualified = verifyNodeRuntime(runtime, control);
  const phase = await runPublicationCommand(qualified.execPath, [path.join(root, 'scripts/check-cli-publication.cjs'), '--evidence', cliDirectory], { cwd: root, evidence: control, label: 'normal-cli-publication-parent', timeoutMs: require('./legacy-afs-publication-budget.cjs').NORMAL_SUPPLY_BUDGET.cliParentMs });
  return { runtime, phase };
}
function verifyNodeRuntime(runtime, control) {
  normal.closedOriginal(runtime, control);
  assert.equal(runtime.command, 'node'); assert.deepEqual(runtime.args, ['-e', NODE_PROBE]); assert.equal(runtime.spawnError, null);
  const qualified = json(path.join(control, runtime.raw[0].path));
  assert.equal(qualified.bun, null); assert.match(qualified.node, /^22\.\d+\.\d+$/);
  assert.ok(path.posix.isAbsolute(qualified.execPath)); assert.equal(path.posix.basename(qualified.execPath), 'node');
  return qualified;
}
async function produce(root, destination, sourceSha) {
  if (process.platform === 'win32') throw new Error('POSIX normal producer required');
  const before = snapshotWorkspace(root);
  assert.equal(before.sourceSha, sourceSha); assert.equal(before.clean, true);
  fs.mkdirSync(destination); const control = path.join(destination, 'producer'); fs.mkdirSync(control);
  fs.writeFileSync(path.join(control, 'source-before.original.json'), JSON.stringify(before));
  const cliDirectory = normal.normalCliEvidence(root);
  const phases = [];
  const cliRun = await runNormalCli(root, control, cliDirectory);
  phases.push(cliRun.phase);
  const originals = normal.cliArtifacts(cliDirectory, before);
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), 'legacy-afs-input-'));
  try {
    const cli = normal.extract(originals.cli, path.join(staging, 'cli')), client = normal.extract(originals.client, path.join(staging, 'client'));
    phases.push(await runPublicationCommand('bun', [path.join(root, 'packages/xpod-afs/scripts/build-client-publication.ts'), '--cli-package', cli, '--client-package', client, '--output', path.join(destination, 'afs')], { cwd: root, evidence: control, label: 'normal-afs' }));
  } finally { fs.rmSync(staging, { recursive: true }); }
  require('./legacy-cli-original-projection.cjs').createProjection(cliDirectory, path.join(destination, 'cli'), { sourceSha, runId: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) });
  const after = snapshotWorkspace(root); assert.equal(after.clean, true); assert.equal(after.inputSHA256, before.inputSHA256);
  fs.writeFileSync(path.join(control, 'source-after.original.json'), JSON.stringify(after));
  const index = { kind: 'legacy-root-original-afs-supply', nativeSourceRoot: root, sourceSha, runId: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), runHeadSha: process.env.EVENT_HEAD_SHA, nodeRuntime: cliRun.runtime,
    cliProjection: 'cli/projection.original.json', sourceBefore: 'producer/source-before.original.json', sourceAfter: 'producer/source-after.original.json', phases,
    producerTools: tools.map(file => ({ file, ...io().reference(path.join(root, file)) })), members: inventory(destination), releaseQualified: false };
  fs.writeFileSync(path.join(destination, 'supply-index.original.json'), JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
  verify(destination, { sourceSha, runId: index.runId, runAttempt: index.runAttempt }, root);
  return index;
}
function verify(directory, context, root) {
  const index = json(path.join(directory, 'supply-index.original.json'));
  if (index.kind !== 'legacy-root-original-afs-supply' || index.sourceSha !== context.sourceSha || index.runId !== String(context.runId) || index.runAttempt !== Number(context.runAttempt)
    || index.releaseQualified !== false || !/^[a-f0-9]{40}$/.test(index.sourceSha) || !Array.isArray(index.members) || index.members.length > 4095) throw new Error('Normal AFS source/run/attempt mismatch');
  const names = new Set(); let total = 0;
  for (const row of index.members) {
    portable(row.member); if (names.has(row.member)) throw new Error('Duplicate normal original'); names.add(row.member);
    io().bound({ ...row, path: path.join(directory, row.member) }); total += row.bytes;
  }
  if (total > 39 * 1024 ** 2) throw new Error('Normal originals budget');
  // Only the index itself is outside the closed inventory.
  function actual(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const member = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) actual(member);
      else if (member !== 'supply-index.original.json' && !names.has(member)) throw new Error('Unexpected normal original');
    }
  }
  actual();
  assert.equal(index.sourceBefore, 'producer/source-before.original.json'); assert.equal(index.sourceAfter, 'producer/source-after.original.json');
  const before = json(path.join(directory, index.sourceBefore)), after = json(path.join(directory, index.sourceAfter));
  for (const snapshot of [before, after]) { assert.equal(snapshot.sourceSha, context.sourceSha); assert.equal(snapshot.clean, true); assert.ok(snapshot.files.length); assert.ok(snapshot.files.every(row => row.matchesGit)); }
  assert.equal(before.inputSHA256, after.inputSHA256);
  assert.deepEqual(index.producerTools.map(row => row.file), tools);
  for (const row of index.producerTools) {
    const source = before.files.find(file => file.path === row.file); assert.equal(source?.sha256, row.sha256); assert.equal(source?.bytes, row.bytes);
    const current = io().reference(path.join(root, row.file)); assert.equal(current.sha256, row.sha256); assert.equal(current.bytes, row.bytes);
  }
  assert.equal(index.phases.length, 2);
  const [cliPhase, afsPhase] = index.phases;
  assert.ok(path.posix.isAbsolute(index.nativeSourceRoot));
  for (const phase of index.phases) { assert.equal(phase.cwd, index.nativeSourceRoot); assert.equal(phase.spawnError, null); normal.closedOriginal(phase, path.join(directory, 'producer')); }
  assert.equal(index.nodeRuntime.cwd, index.nativeSourceRoot);
  const qualifiedNode = verifyNodeRuntime(index.nodeRuntime, path.join(directory, 'producer'));
  assert.equal(cliPhase.command, qualifiedNode.execPath);
  assert.deepEqual(cliPhase.args, [index.nativeSourceRoot + '/scripts/check-cli-publication.cjs', '--evidence', index.nativeSourceRoot + '/.test-data/afs-js-archive-ci-producer']);
  assert.equal(afsPhase.command, 'bun'); assert.equal(afsPhase.args.length, 7);
  assert.equal(afsPhase.args[0], index.nativeSourceRoot + '/packages/xpod-afs/scripts/build-client-publication.ts');
  assert.equal(afsPhase.args[1], '--cli-package'); assert.equal(afsPhase.args[3], '--client-package'); assert.equal(afsPhase.args[5], '--output');
  for (const offset of [2, 4, 6]) assert.ok(path.posix.isAbsolute(afsPhase.args[offset]));
  if (index.cliProjection !== undefined) {
    assert.equal(index.cliProjection, 'cli/projection.original.json');
    require('./legacy-cli-original-projection.cjs').verifyProjection(path.join(directory, 'cli'), context);
  }
  const cliResult = json(path.join(directory, 'cli/result.json'));
  assert.equal(String(cliResult.context.runId), String(context.runId)); assert.equal(Number(cliResult.context.runAttempt), Number(context.runAttempt));
  const cli = normal.cliArtifacts(path.join(directory, 'cli'), before);
  const publication = json(path.join(directory, 'afs/publication.original.json'));
  assert.equal(publication.kind, 'afs-js-normal-publication');
  assert.equal(publication.command.command, 'bun'); assert.equal(publication.command.cwd, afsPhase.args[6] + '/package'); assert.equal(publication.command.spawnError, null);
  assert.equal(publication.archive.path, afsPhase.args[6] + '/xpod-afs.tgz');
  assert.deepEqual(publication.command.args, ['pm', 'pack', '--ignore-scripts', '--filename', publication.archive.path]);
  normal.closedOriginal(publication.command, path.join(directory, 'afs'));
  const afs = io().artifact({ ...publication.archive, path: path.join(directory, 'afs/xpod-afs.tgz'), name: publication.name, version: publication.version });
  assert.deepEqual(afs.manifest, publication.stage.manifest); assert.equal(afs.manifest.private, false);
  assert.equal(json(path.join(root, 'packages/xpod-afs/package.json')).private, true);
  const sourceManifest = io().reference(path.join(root, 'packages/xpod-afs/package.json'));
  assert.equal(publication.stage.sourceManifestSHA256, sourceManifest.sha256);
  const expected = new Map(publication.stage.inventory.map(row => ['package/' + row.path, row]));
  const members = afs.entries.filter(row => row.type === 'file'); assert.equal(expected.size, members.length); assert.equal(expected.size, publication.stage.inventory.length);
  for (const member of members) { const row = expected.get(member.path); assert.ok(row); assert.equal(member.content.length, row.bytes); assert.equal(require('node:crypto').createHash('sha256').update(member.content).digest('hex'), row.sha256); assert.equal(member.mode, row.mode); }
  const producerIndex = cli.cli.entries.find(row => row.path === 'package/' + cli.cli.manifest.exports['./producer-materials'].replace(/^\.\//, ''));
  assert.ok(producerIndex); assert.equal(publication.producerBinding.indexSHA256, require('node:crypto').createHash('sha256').update(producerIndex.content).digest('hex'));
  assert.equal(afs.manifest.dependencies['@undefineds.co/xpod-client'], cli.client.manifest.version);
  return { index, artifacts: [cli.cli, cli.client, afs] };
}
function verifyCustody(directory, context, root, { retained = false } = {}) {
  const request = json(path.join(directory, 'request.original.json'));
  assert.equal(request.input.sourceSha, context.sourceSha);
  assert.equal(String(request.input.runId), String(context.runId));

  // `context` is the CONSUMER coordinate (this lane's build input, or the receipt on a
  // retained readback); the retained originals belong to the PRODUCER, recorded in the
  // split receipt. Both are validated below and never conflated.
  const recordedProducer = request.producerAttempt, recordedConsumer = request.consumerAttempt;
  const split = recordedProducer !== undefined || recordedConsumer !== undefined;
  if (split) {
    assert.ok(Number.isSafeInteger(recordedProducer) && recordedProducer >= 1, 'producer attempt coordinate');
    assert.ok(Number.isSafeInteger(recordedConsumer) && recordedConsumer >= 1, 'consumer attempt coordinate');
    // One-sided replacement is refused: the pair must stay consistent with the
    // selector that was actually used for acquisition.
    assert.equal(recordedProducer, Number(request.input.runAttempt), 'producer coordinate/selector mismatch');
    assert.ok(recordedConsumer >= recordedProducer, 'consumer attempt precedes its producer');
    // context is the consumer, so it must be exactly the recorded consumer.
    assert.equal(recordedConsumer, Number(context.runAttempt), 'consumer coordinate/context mismatch');
    // A live lane must additionally still be the receipt's recorded consumer.
    if (!retained && process.env.GITHUB_ACTIONS === 'true') assert.equal(String(recordedConsumer), process.env.GITHUB_RUN_ATTEMPT);
  } else {
    // Historical/offline record without split coordinates: producer === consumer.
    assert.equal(Number(request.input.runAttempt), Number(context.runAttempt));
    if (!retained && process.env.GITHUB_ACTIONS === 'true') assert.equal(String(request.input.runAttempt), process.env.GITHUB_RUN_ATTEMPT);
  }
  if (!retained && process.env.GITHUB_ACTIONS === 'true') assert.equal(String(request.input.runId), process.env.GITHUB_RUN_ID);
  const custody = path.join(directory, 'custody');
  const receipt = JSON.parse(io().bound({ ...request.custodyReceipt, path: path.join(custody, 'receipt.json') }));
  assert.equal(receipt.kind, 'legacy-root-same-run-acquisition'); assert.equal(receipt.status, 'blocked');
  for (const key of ['runId', 'runAttempt', 'artifactId', 'runHeadSha']) assert.equal(receipt[key], request.input[key]);
  assert.equal(receipt.expectedSourceSha, context.sourceSha); assert.equal(receipt.archive.sha256, request.input.artifactSha256);
  assert.equal(receipt.archive.path, 'artifact.zip'); io().bound({ ...receipt.archive, path: path.join(custody, 'artifact.zip') }, 16 * 1024 ** 2);
  const metadata = json(path.join(custody, 'metadata.json'));
  assert.deepEqual(Object.keys(receipt.metadata.originals).sort(), ['artifact', 'run', 'workflow']);
  io().bound({ ...receipt.metadata.projection, path: path.join(custody, 'metadata.json') });
  for (const name of ['artifact', 'run', 'workflow']) {
    const row = receipt.metadata.originals[name]; assert.equal(row.path, 'metadata/' + name + '.original.json');
    assert.deepEqual(JSON.parse(io().bound({ ...row, path: path.join(custody, row.path) })), metadata[name]);
  }
  assert.equal(receipt.producerJob.path, 'metadata/jobs.original.json');
  const jobs = JSON.parse(io().bound({ ...receipt.producerJob, path: path.join(custody, receipt.producerJob.path) }));
  require('./legacy-root-artifact-context.cjs').verifyContext(request.input, metadata, jobs);
  const originals = path.join(directory, 'originals');
  io().bound({ ...request.index, path: path.join(originals, 'supply-index.original.json') });
  const checked = require('./product-artifact-command.cjs').inspectArtifact([path.join(root, 'scripts/lib/inspect-product-artifact.py'), path.join(custody, 'artifact.zip'), receipt.archive.sha256,
    String(16 * 1024 ** 2), String(40 * 1024 ** 2), '4096', '[]', originals, 'legacy-root-normal-supply'], { evidence: path.join(directory, 'diagnostics/readback'), label: 'zip-readback', timeout: 30_000, maxBuffer: MAX });
  if (checked.error || checked.status !== 0) throw new Error('Retained original ZIP verification failed');
  const inventory = JSON.parse(checked.stdout); assert.deepEqual(inventory.members, receipt.inventory.members);
  const indexBytes = io().readRegular(path.join(originals, 'supply-index.original.json'));
  const indexRow = inventory.members.filter(row => row.path === 'supply-index.original.json' && row.kind === 'file'); assert.equal(indexRow.length, 1);
  assert.equal(indexRow[0].sha256, request.index.sha256); assert.equal(indexRow[0].bytes, indexBytes.length);
  // The retained originals belong to the PRODUCER, so the original verification runs
  // with the producer coordinate from the request rather than the consumer context.
  const producerContext = Object.freeze({ sourceSha: request.input.sourceSha, runId: Number(request.input.runId),
    runAttempt: Number(request.input.runAttempt) });
  const result = verify(originals, producerContext, root);
  const files = inventory.members.filter(row => row.kind === 'file' && row.path !== 'supply-index.original.json'); assert.equal(files.length, result.index.members.length);
  for (const row of result.index.members) { const found = files.filter(member => member.path === row.member); assert.equal(found.length, 1); assert.equal(found[0].bytes, row.bytes); assert.equal(found[0].sha256, row.sha256); }
  assert.equal(result.index.runHeadSha, request.input.runHeadSha);
  return result;
}
module.exports = { tools, NODE_PROBE, runNormalCli, verifyNodeRuntime, produce, verify, verifyCustody, copyTree, inventory, portable, MAX };
