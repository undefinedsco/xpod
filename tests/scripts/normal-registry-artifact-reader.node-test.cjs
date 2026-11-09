const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readExternalNormalArtifact, readWorkspaceNormalArtifacts } = require('../../scripts/read-normal-registry-artifacts.cjs');
const parent = path.resolve(__dirname, '../../.test-data/normal-artifact-reader');
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'case-'));
after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmdirSync(parent); });
let count = 0;
function reference(value) {
  const file = path.join(root, String(count++) + '.json'), bytes = Buffer.from(JSON.stringify(value));
  fs.writeFileSync(file, bytes);
  return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
const expected = { repository: 'https://github.com/owner/source', commit: '1'.repeat(40), name: '@fixture/normal', version: '1.0.0' };
function custody(overrides = {}) {
  return reference({ kind: 'external-extensions-normal-producer-custody', source: { repository: expected.repository, commit: expected.commit }, ...overrides });
}

test('external reader requires complete exact source identity before reading originals', () => {
  for (const version of [undefined, '', 'latest', '^1.0.0', 'file:../source']) {
    assert.throws(() => readExternalNormalArtifact({ expected: { ...expected, version } }), /complete exact source/);
  }
});
test('an ok flag and sourceAuthority claim cannot replace normal execution originals', () => {
  const ref = custody({ ok: true, sourceAuthority: { status: 'bound' }, normalArchiveIndependentlyProduced: true });
  assert.throws(() => readExternalNormalArtifact({ expected, custody: ref }), /unsupported external producer harness/);
});
test('changed source envelope and unsupported harness are rejected even with newly hashed receipts', () => {
  assert.throws(() => readExternalNormalArtifact({ expected, custody: custody({ source: { repository: expected.repository, commit: '2'.repeat(40) } }) }), /source envelope/);
  assert.throws(() => readExternalNormalArtifact({ expected, custody: custody({ harness: { sha256: '0'.repeat(64) } }) }), /unsupported external producer harness/);
});
test('mutated, truncated and symlinked original references fail closed', () => {
  const ref = custody(); fs.appendFileSync(ref.path, '\n');
  assert.throws(() => readExternalNormalArtifact({ expected, custody: ref }), /reference mismatch/);
  const original = custody(), alias = path.join(root, 'alias.json'); fs.symlinkSync(original.path, alias);
  assert.throws(() => readExternalNormalArtifact({ expected, custody: { ...original, path: alias } }), /symlink/);
  assert.throws(() => readExternalNormalArtifact({ expected, custody: { ...original, bytes: -1 } }), /byte reference/);
});
test('old workspace acceptance with true success claims remains blocked without collector originals', () => {
  const receipt = reference({ schemaVersion: 1, kind: 'workspace-consumer-acceptance', sourceSha: '1'.repeat(40),
    ok: true, consumerPassed: true, sourceAuthority: { status: 'bound' }, packages: [] });
  assert.throws(() => readWorkspaceNormalArtifacts({ receipt }), /phase\/raw\/source-input collector evidence/);
});
test('workspace rawClosed claims do not replace observed pipe EOF', () => {
  const source = path.join(root, 'source');
  for (const pipeEOF of [undefined, [true, false], [false, true], [true]]) {
    const receipt = reference({ schemaVersion: 1, kind: 'workspace-consumer-acceptance', sourceSha: expected.commit,
      ok: true, execution: { root: source, phase: { code: 0, actualReturnCode: 0, signal: null,
        waitStatus: 'known', actualClose: true, groupAbsent: true, rawClosed: true, rawClosedBeforeHash: true, cwd: source, pipeEOF } } });
    assert.throws(() => readWorkspaceNormalArtifacts({ receipt, expected: { repository: 'https://github.com/undefinedsco/xpod', commit: expected.commit } }), /execution\/EOF closure incomplete/);
  }
});

test('workspace requires actual leader wait and complete persisted output independently of EOF', () => {
  const source = path.join(root, 'source');
  for (const omitted of ['actualWait', 'rawComplete']) {
    for (const value of [undefined, false]) {
      const phase = { code: 0, actualReturnCode: 0, signal: null, waitStatus: 'known', actualWait: true,
        actualClose: true, groupAbsent: true, rawComplete: true, rawClosed: true, rawClosedBeforeHash: true,
        cwd: source, pipeEOF: [true, true], [omitted]: value };
      const receipt = reference({ schemaVersion: 1, kind: 'workspace-consumer-acceptance', sourceSha: expected.commit,
        execution: { root: source, phase } });
      assert.throws(() => readWorkspaceNormalArtifacts({ receipt, expected: {
        repository: 'https://github.com/undefinedsco/xpod', commit: expected.commit,
      } }), /execution\/EOF closure incomplete/);
    }
  }
});

test('workspace rejects any collector/runner outside the single reviewed pair before reading tool originals', () => {
  const source = path.join(root, 'source');
  const workspacePath = path.join(root, 'workspace-child.json');
  const raw = ['stdout', 'stderr'].map(stream => {
    const file = path.join(root, `normal-pack-and-consumer.${stream}.raw.log`), bytes = Buffer.from('original raw');
    fs.writeFileSync(file, bytes);
    return { path: path.basename(file), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const collector = '8f14113cfa81702b2ebc7879481c7cbeb61ffb3e2acce3ed540ec6f5ea02fdf7';
  const runner = '97980fdad10a7d078aac8746c5ed2549e24419fb67de63f16438e45f7493e8be';
  for (const [collectorHash, runnerHash, error] of [
    ['0'.repeat(64), runner, /unsupported workspace collector/],
    ['459e4b78fcd31d6341594a5578d996e70aeec98348c95a6aac77ad9ef48bcf81', runner, /unsupported workspace collector/],
    [collector, '0'.repeat(64), /command runner is blocked/],
    ['e3d4888611b5a4009dd64a62a9bb38a31992811365da5f6baa7c7b43a43a141a', runner, /unsupported workspace collector/],
    [collector, 'cfa320a653134d43189924e6bd40bc8326601f9ba2f105fac11829e1c948ccea', /command runner is blocked/],
    [collector, '0cdaa3f0ce36d11fb357c4cbbd04811cacbf0b5d05529b9efd7661a02efec706', /command runner is blocked/],
  ]) {
    const receipt = reference({ schemaVersion: 1, kind: 'workspace-consumer-acceptance', sourceSha: expected.commit,
      workspaceEvidence: { path: path.basename(workspacePath) }, execution: { root: source,
        collector: { sha256: collectorHash }, commandRunner: { sha256: runnerHash },
        phase: { code: 0, actualReturnCode: 0, signal: null, waitStatus: 'known', actualWait: true,
          actualClose: true, groupAbsent: true, rawComplete: true, rawClosed: true, rawClosedBeforeHash: true,
          cwd: source, pipeEOF: [true, true], raw, command: process.execPath,
          args: [path.join(source, 'scripts/workspace-package-consumer.cjs'), '--local', '--source-sha', expected.commit,
            '--archive-dir', path.join(root, 'archives'), '--evidence', workspacePath] } } });
    assert.throws(() => readWorkspaceNormalArtifacts({ receipt, expected: {
      repository: 'https://github.com/undefinedsco/xpod', commit: expected.commit,
    } }), error);
  }
});

test('actual tracked inputs bind symlink bytes and Git mode without reading link targets', () => {
  const { verifyActualInputs } = require('../../scripts/read-normal-registry-artifacts.cjs');
  const { execFileSync } = require('node:child_process');
  const source = path.join(root, 'tracked-links'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'tracked instructions');
  fs.symlinkSync('AGENTS.md', path.join(source, 'CLAUDE.md'));
  git(['add', '.']); git(['commit', '-m', 'tracked link']);
  const snapshot = () => {
    const inputs = {};
    for (const row of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const [, mode, gitBlob, name] = /^(\d+) ([a-f0-9]{40}) 0\t(.+)$/.exec(row);
      const file = path.join(source, name), bytes = mode === '120000' ? fs.readlinkSync(file, { encoding: 'buffer' }) : fs.readFileSync(file);
      inputs[name] = { mode, gitBlob, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        ...(mode === '120000' ? { linkTargetBase64: bytes.toString('base64') } : {}) };
    }
    return { commit: git(['rev-parse', 'HEAD']).trim(), inputs };
  };
  let state = snapshot();
  verifyActualInputs(source, state.commit, null, state.inputs);
  const wrongMode = structuredClone(state.inputs); wrongMode['CLAUDE.md'].mode = '100644';
  assert.throws(() => verifyActualInputs(source, state.commit, null, wrongMode), /symlink mode mismatch/);
  const wrongTarget = structuredClone(state.inputs); wrongTarget['CLAUDE.md'].linkTargetBase64 = Buffer.from('different').toString('base64');
  assert.throws(() => verifyActualInputs(source, state.commit, null, wrongTarget), /symlink changed while reading/);
  const wrongBytes = structuredClone(state.inputs); wrongBytes['CLAUDE.md'].sha256 = '0'.repeat(64);
  assert.throws(() => verifyActualInputs(source, state.commit, null, wrongBytes), /content\/mode mismatch/);
  fs.unlinkSync(path.join(source, 'CLAUDE.md')); fs.symlinkSync('different-target', path.join(source, 'CLAUDE.md'));
  assert.throws(() => verifyActualInputs(source, state.commit, null, state.inputs), /checkout identity\/state changed/);
  const outside = path.join(root, 'outside-secret'); fs.writeFileSync(outside, 'must not be read');
  for (const target of [outside, '../outside-secret', 'C:\\private\\secret', '..\\outside-secret']) {
    fs.unlinkSync(path.join(source, 'CLAUDE.md')); fs.symlinkSync(target, path.join(source, 'CLAUDE.md'));
    git(['add', 'CLAUDE.md']); git(['commit', '-m', 'outside link']); state = snapshot();
    const original = fs.readFileSync; let followed = false;
    fs.readFileSync = function(file, ...args) { if (String(file) === outside) { followed = true; throw new Error('followed external target'); } return original.call(fs, file, ...args); };
    try { assert.throws(() => verifyActualInputs(source, state.commit, null, state.inputs), /symlink target escapes source/); }
    finally { fs.readFileSync = original; }
    assert.equal(followed, false);
  }
});
