const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { emitWorkspaceConsumerEvidence, captureWorkspaceSourceState } = require('../../scripts/workspace-package-consumer.cjs');
function fixture(run) {
  const parent = path.resolve(__dirname, '../../.test-data/workspace-consumer-evidence');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const tree = path.join(root, 'tree/package'); fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ name: '@fixture/shared', version: '1.2.3' }));
    const archive = path.join(root, 'shared.tgz');
    execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', path.dirname(tree), 'package']);
    run(root, archive);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('retains exactly hashed normal archive bytes and reads identity from its manifest', () => fixture((root, archive) => {
  const bytes = fs.readFileSync(archive), evidencePath = path.join(root, 'evidence.json');
  const state = { commit: 'a'.repeat(40), clean: true, statusSHA256: crypto.createHash('sha256').update('').digest('hex') };
  const rows = emitWorkspaceConsumerEvidence({ '@fixture/shared': archive }, { evidencePath, sourceSha: state.commit, archiveDir: path.join(root, 'retained') }, state, state);
  assert.equal(rows[0].version, '1.2.3');
  assert.equal(rows[0].integrity, 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'));
  assert.equal(rows[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(fs.readFileSync(path.join(root, 'retained/shared.tgz')), bytes);
  const evidence = JSON.parse(fs.readFileSync(evidencePath));
  assert.equal(evidence.sourceAuthority.status, 'bound'); assert.equal(evidence.releaseQualified, false);
}));
test('missing, dirty, mismatched or changed source authority stays blocked', () => fixture((root, archive) => {
  const state = { commit: 'a'.repeat(40), clean: true, statusSHA256: 'b'.repeat(64) };
  for (const [before, after] of [[null, null], [state, { ...state, clean: false }], [state, { ...state, commit: 'c'.repeat(40) }], [state, { ...state, statusSHA256: 'd'.repeat(64) }]]) {
    const evidencePath = path.join(root, 'evidence.json');
    emitWorkspaceConsumerEvidence({ '@fixture/shared': archive }, { evidencePath, sourceSha: state.commit }, before, after);
    const evidence = JSON.parse(fs.readFileSync(evidencePath));
    assert.equal(evidence.sourceAuthority.status, 'blocked');
    assert.equal(evidence.ok, false); assert.equal(evidence.consumerPassed, true);
  }
}));
test('wrong identity and corrupt archive cannot produce acceptance evidence', () => fixture((root, archive) => {
  const evidencePath = path.join(root, 'evidence.json');
  assert.throws(() => emitWorkspaceConsumerEvidence({ '@fixture/wrong': archive }, { evidencePath, sourceSha: 'a'.repeat(40) }), /identity mismatch/);
  fs.writeFileSync(archive, 'not gzip');
  assert.throws(() => emitWorkspaceConsumerEvidence({ '@fixture/shared': archive }, { evidencePath, sourceSha: 'a'.repeat(40) }), /Corrupted tar/);
  assert.equal(fs.existsSync(evidencePath), false);
}));
test('source snapshot observes real clean, dirty and untracked checkout states', () => fixture((root) => {
  const repo = path.join(root, 'repo');fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init']); git(['config', 'user.name', 'Fixture']);git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(repo, 'source'), 'one');git(['add', 'source']);git(['commit', '-m', 'fixture']);
  const clean = captureWorkspaceSourceState(repo);assert.equal(clean.clean, true);
  fs.writeFileSync(path.join(repo, 'source'), 'two');assert.equal(captureWorkspaceSourceState(repo).clean, false);
  fs.writeFileSync(path.join(repo, 'source'), 'one');fs.writeFileSync(path.join(repo, 'new'), 'new');assert.equal(captureWorkspaceSourceState(repo).clean, false);
  assert.equal(captureWorkspaceSourceState(path.join(root, 'absent')), null);
}));
