'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runCliPublicationCommand, publicationBuildInputInventory, retainBuildMetafiles } = require('../../scripts/check-cli-publication.cjs');
const root = path.resolve(__dirname, '../..');
async function fixture(run) {
  const parent = path.join(root, '.test-data/cli-publication-lifecycle'); fs.mkdirSync(parent, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(parent, 'phase-'));
  try { return await run(evidence); } finally { fs.rmSync(evidence, { recursive: true, force: true }); }
}
const options = evidence => ({ cwd: root, env: process.env, evidence, label: 'tiny', timeoutMs: 1000 });
test('CLI command original proves actual wait/close, pipe EOF and absent owned group', async () => fixture(async evidence => {
  const receipt = await runCliPublicationCommand(process.execPath, ['-e', "process.stdout.write('actual stdout');process.stderr.write('actual stderr')"], options(evidence));
  assert.equal(receipt.actualWait, true); assert.equal(receipt.actualClose, true); assert.equal(receipt.groupAbsent, true);
  assert.equal(receipt.rawClosedBeforeHash, true); assert.deepEqual(receipt.pipeEOF, [true, true]);
  assert.equal(receipt.descendantClosureVerified, false); // No claim about escaped sessions.
  for (const raw of receipt.raw) {
    const bytes = fs.readFileSync(path.join(evidence, raw.path)); assert.equal(bytes.length, raw.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), raw.sha256);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence, 'tiny.receipt.json'))), receipt);
}));
test('nonzero and signal fail with actual closed original receipts', async () => {
  for (const script of ['process.exit(3)', 'process.kill(process.pid,"SIGTERM")']) await fixture(async evidence => {
    await assert.rejects(runCliPublicationCommand(process.execPath, ['-e', script], options(evidence)), error => {
      assert.equal(error.outcome.actualWait, true); assert.equal(error.outcome.actualClose, true);
      assert.equal(error.outcome.groupAbsent, true); return true;
    });
  });
});
test('spawn failure cannot claim wait, group absence or closed raw authority', async () => fixture(async evidence => {
  await assert.rejects(runCliPublicationCommand('/nonexistent/xpod-owned-command', [], { ...options(evidence), timeoutMs: 30 }), error => {
    assert.equal(error.outcome.spawnError, 'ENOENT'); assert.equal(error.outcome.actualWait, false);
    assert.equal(error.outcome.groupAbsent, false); assert.equal(error.outcome.rawComplete, false); return true;
  });
}));
test('bounded phase timeout terminates its owned process and preserves failure', async () => fixture(async evidence => {
  await assert.rejects(runCliPublicationCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options(evidence), timeoutMs: 50 }), error => {
    assert.match(error.message, /deadline/); assert.equal(error.outcome.actualClose, true); assert.equal(error.outcome.groupAbsent, true); return true;
  });
}));
test('a same-group descendant keeping inherited pipes delays successful receipt until its real exit', async () => fixture(async evidence => {
  const start = Date.now();
  const receipt = await runCliPublicationCommand(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.stdout.write("descendant done"),150)'],{stdio:['ignore','inherit','inherit']}).unref()`], options(evidence));
  assert.ok(Date.now() - start >= 140); assert.equal(receipt.groupAbsent, true);
  assert.equal(fs.readFileSync(path.join(evidence, receipt.raw[0].path), 'utf8'), 'descendant done');
}));
test('256KiB raw cap fails rather than truncating into a successful original', async () => fixture(async evidence => {
  await assert.rejects(runCliPublicationCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(262145))'], options(evidence)), error => {
    assert.equal(error.outcome.rawBudgetPerStream, 262144); assert.equal(error.outcome.rawComplete, false);
    assert.equal(error.outcome.raw[0].status, 'truncated'); assert.equal(error.outcome.raw[0].sha256, undefined); return true;
  });
}));

test('actual current preparation stdout size fits the bounded command original', async () => fixture(async evidence => {
  const receipt = await runCliPublicationCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(172867, 32))'], options(evidence));
  assert.equal(receipt.raw[0].bytes, 172867); assert.equal(receipt.rawComplete, true);
}));

test('compile snapshots bind actual generated manifest and relocated frozen lock bytes', async () => fixture(async source => {
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"generated-build"}');
  fs.writeFileSync(path.join(source, 'bun.lock'), 'actual frozen lock');
  const inputs = [{path:'packages/xpod-cli/publication.bun.lock'}, {path:'package.json'}];
  const before = publicationBuildInputInventory(source, inputs);
  assert.equal(before[0].path, 'package.json');
  assert.equal(before[1].buildPath, 'bun.lock');
  fs.writeFileSync(path.join(source, 'bun.lock'), 'changed lock');
  assert.notDeepEqual(publicationBuildInputInventory(source, inputs), before);
  fs.unlinkSync(path.join(source, 'bun.lock')); fs.symlinkSync(path.join(source, 'package.json'), path.join(source, 'bun.lock'));
  assert.throws(() => publicationBuildInputInventory(source, inputs), /not_regular/);
}));

test('build metafiles retain bound original bytes and reject oversize or linked material', async () => fixture(async evidence => {
  const source = path.join(evidence, 'owned-build'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'inputs.json'), '{"inputs":{},"outputs":{}}');
  const rows = retainBuildMetafiles(source, evidence, 'phase-005');
  assert.equal(rows.length, 1); assert.equal(rows[0].original.path, 'phase-005.metafiles/inputs.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(evidence, rows[0].original.path))).digest('hex'), rows[0].sha256);
  fs.writeFileSync(path.join(source, 'oversize.json'), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.throws(() => retainBuildMetafiles(source, evidence, 'phase-006'), /budget_exceeded/);
  fs.unlinkSync(path.join(source, 'oversize.json')); fs.symlinkSync(path.join(source, 'inputs.json'), path.join(source, 'alias.json'));
  assert.throws(() => retainBuildMetafiles(source, evidence, 'phase-007'), /not_regular/);
}));
