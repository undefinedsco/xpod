const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { verifyEvidence, describeArchive, bundledRuntimeHash, readArchiveRuntime } = require('../../scripts/desktop-permission-acceptance.cjs');
const { verifyDesktopAcceptance } = require('../../scripts/desktop-acceptance.cjs');

const expected = {
  sourceSha: 'a'.repeat(40),
  // The DESKTOP candidate; deliberately different from the CLI version below so a
  // test can never pass by conflating the two authorities.
  version: '0.4.26-rc.1',
  cliVersion: '0.1.0-preview.7',
  archive: { size: 1234, sha256: 'b'.repeat(64), sha512: 'A'.repeat(86) + '==' },
  runtimeBinarySha256: 'c'.repeat(64),
  resourceIds: ['one', 'two'],
};

function pod(hash) {
  return {
    bindingSha256: hash.repeat(64), webIdSha256: hash.repeat(64),
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
    runtime: { version: expected.cliVersion, edition: 'local', ownership: 'desktop',
      binarySha256: 'c'.repeat(64), bundled: true, installed: true, noExternalOverride: true, freshEndpoint: true },
    identity: { cloudCard: true, independentWebIds: true, independentStorage: true, noPublicRoute: true, browserCallback: true },
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

test('binds the launcher CLI version to its own authority, never the desktop candidate', () => {
  // Baseline: desktop 0.4.26-rc.1 with CLI 0.1.0-preview.7, each matching its own
  // authority. This is the real published shape (different versions).
  assert.notEqual(expected.version, expected.cliVersion);
  assert.deepEqual(verifyEvidence(evidence(), expected), { valid: true, errors: [] });

  // The observed CLI version must not satisfy the desktop authority...
  const desktop = expected.version;
  const cli = expected.cliVersion;
  const asDesktop = evidence(); asDesktop.runtime.version = desktop;
  assert.equal(verifyEvidence(asDesktop, expected).valid, false);
  // ...and a top-level record claiming the CLI version must not satisfy the
  // desktop authority either (the two fields bind to different expectations).
  const swappedTop = evidence(); swappedTop.version = cli;
  assert.equal(verifyEvidence(swappedTop, expected).valid, false);
  // The CLI authority is REQUIRED: an expectation without it can never match, so
  // a caller cannot silently fall back to the observed value or to the desktop
  // candidate (the CLI/producer wiring always fills it from the archive manifest).
  const { cliVersion: _omitted, ...noCli } = expected;
  assert.equal(verifyEvidence(evidence(), noCli).valid, false, 'missing CLI authority must fail closed');
  // And the desktop candidate alone is not a CLI authority.
  assert.equal(verifyEvidence(evidence(), { ...noCli, cliVersion: undefined }).valid, false);

  // A different-but-valid CLI version is rejected against this authority.
  const otherCli = evidence(); otherCli.runtime.version = '0.1.0-preview.8';
  assert.equal(verifyEvidence(otherCli, expected).valid, false);
  // A malformed CLI version is rejected even if the expectation were the same.
  const badShape = evidence(); badShape.runtime.version = 'preview.7';
  assert.equal(verifyEvidence(badShape, expected).valid, false);
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

test('hashes the actual bundled launcher chosen by the product resolver; missing members fail', async t => {
  const parent = path.resolve('.test-data'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'desktop-permission-verifier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Build a bundle in the PUBLISHED layout: runtime/bin/bun + the packaged CLI
  // under runtime/node_modules/@undefineds.co/xpod-cli. There is deliberately no
  // runtime/xpod, which the real artifact does not contain either.
  const cliRoot = path.join(directory, 'Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli');
  fs.mkdirSync(path.join(cliRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'Xpod.app/Contents/Resources/runtime/bin'), { recursive: true });
  const launcherBytes = Buffer.from('exact bundled launcher bytes');
  fs.writeFileSync(path.join(directory, 'Xpod.app/Contents/Resources/runtime/bin/bun'), launcherBytes, { mode: 0o755 });
  fs.writeFileSync(path.join(cliRoot, 'dist/xpod.mjs'), 'export {}\n');
  fs.writeFileSync(path.join(cliRoot, 'package.json'), JSON.stringify({ name: '@undefineds.co/xpod-cli', version: '0.1.0-preview.7' }) + '\n');
  fs.writeFileSync(path.join(directory, 'Xpod.app/Contents/Info.plist'),
    '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>0.4.26-rc.1</string></dict></plist>\n');
  const archive = path.join(directory, 'bundle.zip');
  assert.equal(spawnSync('zip', ['-qr', archive, 'Xpod.app'], { cwd: directory }).status, 0);

  // The hash is of the ACTUAL bundled launcher, not of a remembered path.
  assert.equal(await bundledRuntimeHash(archive), createHash('sha256').update(launcherBytes).digest('hex'));
  const runtime = await readArchiveRuntime(archive);
  assert.equal(runtime.launcherMember, 'Xpod.app/Contents/Resources/runtime/bin/bun');
  assert.equal(runtime.cliEntryMember, 'Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs');
  assert.equal(runtime.cliVersion, '0.1.0-preview.7');
  assert.equal(runtime.desktopVersion, '0.4.26-rc.1');
  assert.equal(await bundledRuntimeHash(archive), runtime.launcherSha256);

  const compressed = fs.readFileSync(archive);
  assert.deepEqual(await describeArchive(archive), { size: compressed.length,
    sha256: createHash('sha256').update(compressed).digest('hex'), sha512: createHash('sha512').update(compressed).digest('base64') });

  // A bundle with no runtime at all fails closed.
  fs.rmSync(path.join(directory, 'Xpod.app/Contents/Resources/runtime'), { recursive: true, force: true });
  fs.writeFileSync(path.join(directory, 'Xpod.app/placeholder'), 'no runtime');
  const missing = path.join(directory, 'missing.zip');
  assert.equal(spawnSync('zip', ['-qr', missing, 'Xpod.app'], { cwd: directory }).status, 0);
  await assert.rejects(bundledRuntimeHash(missing), /bundled runtime launcher is missing/);
  await assert.rejects(readArchiveRuntime(missing), /bundled runtime launcher is missing/);
});
test('rejects a bundled CLI manifest with a wrong name, version or missing member', async t => {
  const parent = path.resolve('.test-data'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'desktop-permission-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cliRoot = path.join(directory, 'Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli');
  fs.mkdirSync(path.join(cliRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'Xpod.app/Contents/Resources/runtime/bin'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'Xpod.app/Contents/Resources/runtime/bin/bun'), 'bun', { mode: 0o755 });
  fs.writeFileSync(path.join(cliRoot, 'dist/xpod.mjs'), 'export {}\n');
  const build = (manifest, name) => {
    if (manifest === undefined) fs.rmSync(path.join(cliRoot, 'package.json'), { force: true });
    else fs.writeFileSync(path.join(cliRoot, 'package.json'), JSON.stringify(manifest) + '\n');
    const out = path.join(directory, name);
    assert.equal(spawnSync('zip', ['-qr', out, 'Xpod.app'], { cwd: directory }).status, 0);
    return out;
  };
  await assert.rejects(readArchiveRuntime(build({ name: '@undefineds.co/xpod-cli', version: 'not-a-version' }, 'bad-version.zip')),
    /bundled CLI package version is not a valid CLI version/);
  await assert.rejects(readArchiveRuntime(build({ name: '@other/cli', version: '0.1.0-preview.7' }, 'bad-name.zip')),
    /bundled CLI package name is not the packaged CLI/);
  await assert.rejects(readArchiveRuntime(build(undefined, 'missing-manifest.zip')), /bundled cli manifest is not an archive member/);
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

test('rejects ZIP extraction without actual installation', () => {
  const record = evidence(); delete record.runtime.installed;
  assert.equal(verifyEvidence(record, expected).valid, false);
});

test('rejects a shared WebID even when the two storage bindings differ', () => {
  const record = evidence(); record.pods[1].webIdSha256 = record.pods[0].webIdSha256;
  assert.equal(verifyEvidence(record, expected).valid, false);
});
test('rejects the superseded same-WebID evidence contract', () => {
  const record = evidence(); delete record.identity.independentWebIds; record.identity.sameWebId = true;
  assert.equal(verifyEvidence(record, expected).valid, false);
});

// Real-artifact probe. It is skipped when the retained 427 artifact is absent so
// the file still runs on a clean checkout, and it never executes archive code.
const REAL_427 = path.resolve('.test-data/release-coordination/rc410-desktop-427-artifact/Xpod-0.4.31-rc.410-arm64-mac.zip');
test('reads the real 427 bundle: desktop 0.4.31-rc.410 with bundled CLI 0.1.0-preview.2', {
  skip: !fs.existsSync(REAL_427) && 'retained 427 artifact not present',
}, async () => {
  // `evidence()` builds its hashes from the synthetic `expected` record, so bind
  // the two real-record fields explicitly rather than reusing those placeholders.
  const realArchive = await describeArchive(REAL_427);
  const runtime = await readArchiveRuntime(REAL_427);
  assert.equal(runtime.desktopVersion, '0.4.31-rc.410');
  assert.equal(runtime.cliVersion, '0.1.0-preview.2');
  assert.equal(runtime.cliPackageName, '@undefineds.co/xpod-cli');
  assert.equal(runtime.launcherMember, 'Xpod.app/Contents/Resources/runtime/bin/bun');
  assert.match(runtime.launcherSha256, /^[a-f0-9]{64}$/);
  // The published bundle has no runtime/xpod; the launcher hash must therefore
  // come from the same member the product resolver chose, not a remembered path.
  assert.equal(await bundledRuntimeHash(REAL_427), runtime.launcherSha256);
  // Two independent versions, each matching its own authority.
  assert.notEqual(runtime.desktopVersion, runtime.cliVersion);
  const real = evidence();
  real.version = '0.4.31-rc.410';
  real.runtime = { ...real.runtime, version: '0.1.0-preview.2', binarySha256: runtime.launcherSha256 };
  real.archive = realArchive;
  assert.deepEqual(verifyEvidence(real, { ...expected, version: '0.4.31-rc.410',
    cliVersion: '0.1.0-preview.2', runtimeBinarySha256: runtime.launcherSha256,
    archive: realArchive }), { valid: true, errors: [] });
});

test('rejects a symlinked launcher instead of hashing the link target string', async t => {
  // ZIP stores a symlink as a member whose content is the link TARGET, so a
  // naive `unzip -p` would hash "../../x" and silently accept the wrong bytes.
  const parent = path.resolve('.test-data'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'desktop-permission-link-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const resources = path.join(directory, 'Xpod.app/Contents/Resources');
  fs.mkdirSync(path.join(resources, 'runtime/bin'), { recursive: true });
  const cliRoot = path.join(resources, 'runtime/node_modules/@undefineds.co/xpod-cli');
  fs.mkdirSync(path.join(cliRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'real-bun'), 'launcher bytes');
  fs.symlinkSync('../../../../../real-bun', path.join(resources, 'runtime/bin/bun'));
  fs.writeFileSync(path.join(cliRoot, 'dist/xpod.mjs'), 'export {}\n');
  fs.writeFileSync(path.join(cliRoot, 'package.json'),
    JSON.stringify({ name: '@undefineds.co/xpod-cli', version: '0.1.0-preview.7' }) + '\n');
  const archive = path.join(directory, 'link.zip');
  assert.equal(spawnSync('zip', ['-qry', archive, 'Xpod.app'], { cwd: directory }).status, 0);
  await assert.rejects(readArchiveRuntime(archive), /bundled launcher is not a regular file/);
  await assert.rejects(bundledRuntimeHash(archive), /bundled launcher is not a regular file/);
});

test('rejects duplicate members, extra app roots and escaping CLI members', async t => {
  const parent = path.resolve('.test-data'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'desktop-permission-shape-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const resources = path.join(directory, 'Xpod.app/Contents/Resources');
  const cliRoot = path.join(resources, 'runtime/node_modules/@undefineds.co/xpod-cli');
  fs.mkdirSync(path.join(cliRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'runtime/bin'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'runtime/bin/bun'), 'bun', { mode: 0o755 });
  fs.writeFileSync(path.join(cliRoot, 'dist/xpod.mjs'), 'export {}\n');
  fs.writeFileSync(path.join(cliRoot, 'package.json'),
    JSON.stringify({ name: '@undefineds.co/xpod-cli', version: '0.1.0-preview.7' }) + '\n');

  const build = (name, roots = ['Xpod.app']) => {
    const out = path.join(directory, name);
    assert.equal(spawnSync('zip', ['-qr', out, ...roots], { cwd: directory }).status, 0);
    return out;
  };
  // A second application bundle is ambiguous. The extra root has to be part of
  // the archive, so it is passed as an explicit member.
  const other = path.join(directory, 'Other.app/Contents');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'Info.plist'), '<plist/>');
  const twoRoots = build('two-roots.zip', ['Xpod.app', 'Other.app']);
  assert.equal(spawnSync('unzip', ['-Z1', twoRoots]).stdout.toString().includes('Other.app/Contents/Info.plist'),
    true, 'fixture must really contain a second bundle');
  fs.rmSync(path.join(directory, 'Other.app'), { recursive: true, force: true });
  await assert.rejects(readArchiveRuntime(twoRoots), /exactly one application bundle/);

  // Duplicate member names make every read ambiguous. `zip` de-duplicates on
  // append, so forge the archive with a writer that allows repeated names.
  build('single.zip');
  const duplicated = path.join(directory, 'dup.zip');
  const copy = spawnSync('python3', ['-c', [
    'import sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1],"w") as z:',
    '    z.writestr("Xpod.app/Contents/Resources/runtime/bin/bun","one")',
    '    z.writestr("Xpod.app/Contents/Resources/runtime/bin/bun","two")',
  ].join('\n'), duplicated]);
  assert.equal(copy.status, 0, String(copy.stderr));
  assert.equal(spawnSync('unzip', ['-Z1', duplicated]).stdout.toString().split('\n')
    .filter(line => line === 'Xpod.app/Contents/Resources/runtime/bin/bun').length, 2,
  'fixture must really contain the same member twice');
  await assert.rejects(readArchiveRuntime(duplicated), /duplicate members/);
});
