const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { verifyEvidence, describeArchive, bundledRuntimeHash } = require('../../scripts/desktop-permission-acceptance.cjs');
const { verifyDesktopAcceptance } = require('../../scripts/desktop-acceptance.cjs');

const expected = {
  sourceSha: 'a'.repeat(40), version: '0.4.26-rc.1',
  archive: { size: 1234, sha256: 'b'.repeat(64), sha512: 'A'.repeat(86) + '==' },
  runtimeBinarySha256: 'c'.repeat(64),
  resourceIds: ['one', 'two'],
};

function pod(hash) {
  return {
    bindingSha256: hash.repeat(64),
    selectedInUi: true,
    first: { resourceIds: ['one', 'two'], fresh: true, granted: 2, readBack: 2, parentUnchanged: true },
    repeat: { readBack: 2, acrWrites: 0, sameSession: true },
    management: { configuration: true, models: true, quota: true },
  };
}

function evidence() {
  return {
    schemaVersion: 1, kind: 'desktop-permission-acceptance', ok: true,
    sourceSha: expected.sourceSha, version: expected.version, archive: { ...expected.archive },
    runtime: { version: expected.version, edition: 'local', ownership: 'desktop',
      binarySha256: 'c'.repeat(64), bundled: true, noExternalOverride: true, freshEndpoint: true },
    identity: { cloudCard: true, sameWebId: true, independentStorage: true, noPublicRoute: true, browserCallback: true },
    pods: [pod('d'), pod('e')],
    operations: { accountActor: true, keyCreate: true, keyList: true, keyRevoke: true,
      collectionConfirmed: true, conflictCount: 0, chatStatus: 200, chatBodyMatches: true, chatDispatches: 1,
      samePodReuse: true, crossPodRejected: true, isolatedRows: true, oldRunRejected: true },
    cleanup: { appStopped: true, runtimeStopped: true, ownedDataRemoved: true,
      providerRemoved: true, keyRemoved: true, attributedGrantsRestored: true, remainingOwnedPids: 0 },
    completedAt: '2026-10-05T00:00:00.000Z',
  };
}

function selfUpdate() {
  const events = ['checking-for-update', 'update-available', 'download-verified', 'update-downloaded', 'auto-install-ready'];
  return {
    schemaVersion: 1, kind: 'desktop-self-update-acceptance', ok: true,
    sourceSha: expected.sourceSha, oldVersion: '0.4.25', newVersion: expected.version, oldReleaseTag: 'v0.4.25',
    oldApp: 'Xpod.app', oldBinarySha256: 'f'.repeat(64),
    newZip: { name: `Xpod-${expected.version}-arm64-mac.zip`, ...expected.archive },
    oldZip: { name: 'Xpod-0.4.25-arm64-mac.zip', ...expected.archive, version: '0.4.25' },
    events, requiredEvents: [...events],
    cleanup: { oldAppStopped: true, relaunchedAppStopped: true, relaunchProcessObserved: true,
      relaunchDistinctPid: true, fixtureStopped: true, removedUserData: true, remainingOwnedPids: 0 },
    completedAt: '2026-10-05T00:00:00.000Z',
  };
}

test('requires complete packaged operations bound to source/version/archive', () => {
  assert.deepEqual(verifyEvidence(evidence(), expected), { valid: true, errors: [] });
});
test('rejects missing operations, even if self-update succeeded separately', () => {
  const record = evidence(); delete record.operations;
  assert.equal(verifyEvidence(record, expected).valid, false);
  assert.equal(verifyEvidence(undefined, expected).valid, false);
});
test('rejects wrong source, version and archive bytes', () => {
  for (const alter of [r => r.sourceSha = 'f'.repeat(40), r => r.version = '0.4.25',
    r => r.archive.sha256 = 'f'.repeat(64), r => r.archive.sha512 = 'B'.repeat(86) + '==',
    r => r.archive.size += 1]) {
    const record = evidence(); alter(record);
    assert.equal(verifyEvidence(record, expected).valid, false);
  }
});
test('rejects source UI on an old shell or an external runtime', () => {
  for (const alter of [r => r.runtime.version = '0.4.25', r => r.runtime.ownership = 'external',
    r => r.runtime.bundled = false, r => r.runtime.noExternalOverride = false,
    r => r.runtime.freshEndpoint = false, r => r.runtime.binarySha256 = 'f'.repeat(64)]) {
    const record = evidence(); alter(record);
    assert.equal(verifyEvidence(record, expected).valid, false);
  }
});
test('requires fresh and repeated complete grants on two different UI-selected Pods', () => {
  for (const alter of [r => r.pods.pop(), r => r.pods[1].bindingSha256 = r.pods[0].bindingSha256,
    r => r.pods[1].selectedInUi = false, r => r.pods[0].first.resourceIds = ['one', 'one'],
    r => r.pods[0].first.granted = 0, r => r.pods[0].repeat.acrWrites = 1,
    r => r.pods[1].repeat.readBack = 0, r => r.identity.browserCallback = false]) {
    const record = evidence(); alter(record);
    assert.equal(verifyEvidence(record, expected).valid, false);
  }
});
test('rejects chat without body proof or with replay, isolation failure and partial cleanup', () => {
  for (const alter of [r => r.operations.chatBodyMatches = false, r => r.operations.chatDispatches = 2,
    r => r.operations.crossPodRejected = false, r => r.operations.conflictCount = 1,
    r => r.cleanup.attributedGrantsRestored = false, r => r.cleanup.remainingOwnedPids = 1]) {
    const record = evidence(); alter(record);
    assert.equal(verifyEvidence(record, expected).valid, false);
  }
});
test('rejects arbitrary public fields or sensitive values instead of copying private diagnostics', () => {
  for (const alter of [r => r.accessToken = 'private', r => r.runtime.authorizationUrl = 'https://auth.example/',
    r => r.completedAt = 'Bearer private', r => r.archive.sha256 = 'private']) {
    const record = evidence(); alter(record);
    assert.equal(verifyEvidence(record, expected).valid, false);
  }
});

test('hashes the actual archive and its exact bundled runtime member; a missing member fails', async t => {
  const parent = path.resolve('.test-data'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'desktop-permission-verifier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const member = path.join(directory, 'Xpod.app/Contents/Resources/runtime/xpod');
  fs.mkdirSync(path.dirname(member), { recursive: true });
  const bytes = Buffer.from('exact archive runtime bytes'); fs.writeFileSync(member, bytes);
  const archive = path.join(directory, 'bundle.zip');
  assert.equal(spawnSync('zip', ['-qr', archive, 'Xpod.app'], { cwd: directory }).status, 0);
  assert.equal(await bundledRuntimeHash(archive), createHash('sha256').update(bytes).digest('hex'));
  const compressed = fs.readFileSync(archive);
  assert.deepEqual(await describeArchive(archive), { size: compressed.length,
    sha256: createHash('sha256').update(compressed).digest('hex'), sha512: createHash('sha512').update(compressed).digest('base64') });
  fs.unlinkSync(member); fs.writeFileSync(path.join(directory, 'Xpod.app/placeholder'), 'no runtime');
  const missing = path.join(directory, 'missing.zip');
  assert.equal(spawnSync('zip', ['-qr', missing, 'Xpod.app'], { cwd: directory }).status, 0);
  await assert.rejects(bundledRuntimeHash(missing), /Missing archive runtime/);
});

test('mandatory desktop passes only with both complete records for the same actual archive', () => {
  assert.deepEqual(verifyDesktopAcceptance({ selfUpdate: selfUpdate(), permissions: evidence() }, expected), { valid: true, errors: [] });
  assert.equal(verifyDesktopAcceptance({ selfUpdate: selfUpdate() }, expected).valid, false);
  assert.equal(verifyDesktopAcceptance({ permissions: evidence() }, expected).valid, false);
  const update = selfUpdate(); update.newZip.sha256 = 'f'.repeat(64);
  assert.equal(verifyDesktopAcceptance({ selfUpdate: update, permissions: evidence() }, expected).valid, false);
  const permission = evidence(); permission.operations.chatDispatches = 2;
  assert.equal(verifyDesktopAcceptance({ selfUpdate: selfUpdate(), permissions: permission }, expected).valid, false);
});
