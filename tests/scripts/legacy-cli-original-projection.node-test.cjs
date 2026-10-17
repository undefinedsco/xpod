const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createProjection, verifyProjection } = require('../../scripts/lib/legacy-cli-original-projection.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
test('bounded projection keeps all ten receipt/raw pairs and leaves large sourcekit originals untouched', () => {
  const parent = path.resolve(__dirname, '../../.test-data/legacy-cli-projection'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-')), source = path.join(root, 'source'), output = path.join(root, 'output'); fs.mkdirSync(source);
  const rows = [], put = (name, value) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); fs.writeFileSync(path.join(source, name), bytes); const row = { path: name, bytes: bytes.length, sha256: hash(bytes) }; rows.push(row); return row; };
  try {
    const identity = { sourceSha: 'a'.repeat(40), runId: '21', runAttempt: 3 }, outcomes = [];
    for (let n = 0; n < 10; n++) {
      const label = 'phase-' + String(n).padStart(3, '0');
      const raw = ['stdout', 'stderr'].map(channel => put(label + '.' + channel + '.raw.log', channel));
      const outcome = { code: 0, signal: null, actualWait: true, actualClose: true, groupAbsent: true, rawComplete: true, rawClosed: true, rawClosedBeforeHash: true, pipeEOF: [true, true], raw };
      const receipt = put(label + '.receipt.json', outcome); outcomes.push({ phase: label, receipt, ...outcome });
    }
    put('cleanup.json', { schemaVersion: 1, kind: 'cli-publication-owned-command-cleanup', success: true, sourceAbsent: true, commandOutcomes: outcomes });
    put('source-inputs.json', { context: identity }); put('cli.tgz', 'original cli'); put('client.tgz', 'original client');
    fs.mkdirSync(path.join(source, 'source-materials'));
    const materials = put('source-materials/materials.json', { original: 'full sourcekit descriptor' });
    const large = path.join(source, 'source-materials/dependencies-0000.tar'); fs.closeSync(fs.openSync(large, 'wx')); fs.truncateSync(large, 41062400);
    const stat = fs.statSync(large);
    const inventory = put('inventory.json', { schemaVersion: 1, files: rows.slice() });
    put('result.json', { context: { checkoutSha: identity.sourceSha, runId: identity.runId, runAttempt: identity.runAttempt }, inventory: { path: inventory.path, sha256: inventory.sha256 }, sourceMaterials: materials });
    const resultOriginal = fs.readFileSync(path.join(source, 'result.json'));
    const projection = createProjection(source, output, identity);
    assert.equal(projection.members.length, 35); assert.equal(projection.sourceQualified, false);
    assert.equal(fs.statSync(large).size, stat.size); assert.equal(fs.statSync(large).mtimeMs, stat.mtimeMs);
    assert.deepEqual(fs.readFileSync(path.join(output, 'result.json')), resultOriginal);
    assert.equal(fs.existsSync(path.join(output, 'source-materials')), false);
    verifyProjection(output, identity);
    assert.throws(() => verifyProjection(output, { ...identity, runAttempt: 4 }));
    fs.writeFileSync(path.join(output, 'unselected.json'), '{}'); assert.throws(() => verifyProjection(output, identity)); fs.unlinkSync(path.join(output, 'unselected.json'));
    const receiptOriginal = fs.readFileSync(path.join(output, 'phase-009.receipt.json'));
    fs.unlinkSync(path.join(output, 'phase-009.receipt.json')); assert.throws(() => verifyProjection(output, identity)); fs.writeFileSync(path.join(output, 'phase-009.receipt.json'), receiptOriginal);
    fs.appendFileSync(path.join(output, 'phase-009.stderr.raw.log'), 'changed'); assert.throws(() => verifyProjection(output, identity));
    fs.rmSync(output, { recursive: true });
    const changed = JSON.parse(fs.readFileSync(path.join(source, 'inventory.json'))); changed.files.find(row => row.path === 'cli.tgz').sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(source, 'inventory.json'), JSON.stringify(changed)); assert.throws(() => createProjection(source, output, identity)); assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy workflow envelopes the normal CLI single publication budget and both retained originals', () => {
  const { NORMAL_SUPPLY_BUDGET: budget } = require('../../scripts/lib/legacy-afs-publication-budget.cjs');
  const { PUBLICATION_BUDGET: cli } = require('../../scripts/check-cli-publication.cjs');
  const yaml = require('yaml');
  const job = yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/legacy-root-compat.yml'), 'utf8')).jobs.normal_afs;
  assert.equal(budget.cliParentMs, cli.producerWindowMs + cli.terminationGraceMs);
  assert.equal(job['timeout-minutes'], budget.jobMinutes);
  assert.deepEqual(job.steps.map(step => step['timeout-minutes']), Object.values(budget.steps));
  assert.equal(budget.steps.produce * 60000 > budget.producerWindowMs, true);
});
