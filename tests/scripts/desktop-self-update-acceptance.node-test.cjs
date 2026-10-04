const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const { compareVersions, verifyEvidence } = require('../../scripts/desktop-self-update-acceptance.cjs');

const producerPath = path.resolve(__dirname, '../../desktop/scripts/packaged-update-acceptance.mjs');
const fixturePath = path.resolve(__dirname, '../../desktop/scripts/update-feed-fixture.mjs');
const verifierPath = path.resolve(__dirname, '../../scripts/desktop-self-update-acceptance.cjs');
const SOURCE_SHA = 'a'.repeat(40);
const NEW_VERSION = '0.4.22-rc.5';
const EXPECTED = { sourceSha: SOURCE_SHA, newVersion: NEW_VERSION };
const VALID_SHA512 = 'A'.repeat(86) + '==';

function validEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'desktop-self-update-acceptance',
    ok: true,
    sourceSha: SOURCE_SHA,
    oldVersion: '0.4.20',
    newVersion: NEW_VERSION,
    oldReleaseTag: 'v0.4.20',
    oldApp: 'Xpod.app',
    oldBinarySha256: 'b'.repeat(64),
    newZip: { name: `Xpod-${NEW_VERSION}-arm64-mac.zip`, size: 1024, sha256: 'c'.repeat(64), sha512: VALID_SHA512 },
    oldZip: { name: 'Xpod-0.4.20-arm64-mac.zip', size: 2048, sha256: 'd'.repeat(64), sha512: VALID_SHA512, version: '0.4.20' },
    events: ['checking-for-update', 'update-available', 'download-verified', 'update-downloaded', 'auto-install-ready'],
    requiredEvents: ['checking-for-update', 'update-available', 'download-verified', 'update-downloaded', 'auto-install-ready'],
    cleanup: {
      oldAppStopped: true,
      relaunchedAppStopped: true,
      relaunchProcessObserved: true,
      relaunchDistinctPid: true,
      fixtureStopped: true,
      removedUserData: true,
      remainingOwnedPids: 0,
    },
    completedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

test('accepts a complete, source-bound self-update evidence record', () => {
  assert.deepEqual(verifyEvidence(validEvidence(), EXPECTED), { valid: true, errors: [] });
});

test('rejects evidence bound to a different source SHA', () => {
  const result = verifyEvidence(validEvidence({ sourceSha: 'e'.repeat(40) }), EXPECTED);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === 'sourceSha'));
});

test('rejects evidence for a different candidate version', () => {
  const result = verifyEvidence(validEvidence({ newVersion: '0.4.22-rc.6' }), EXPECTED);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === 'newVersion'));
});

test('rejects a partial lifecycle that never installed and relaunched', () => {
  const result = verifyEvidence(validEvidence({
    events: ['checking-for-update', 'update-available', 'download-verified', 'update-downloaded'],
    ok: false,
  }), EXPECTED);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === 'ok'));
  assert.ok(result.errors.some((error) => error.path.includes('auto-install-ready')));
});

test('rejects a non-increasing version pair', () => {
  const result = verifyEvidence(validEvidence({ oldVersion: NEW_VERSION }), EXPECTED);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === 'oldVersion'));
});

test('rejects cleanup facts that were not actually observed (F5)', () => {
  const result = verifyEvidence(validEvidence({
    cleanup: { oldAppStopped: true, relaunchedAppStopped: false, fixtureStopped: true, removedUserData: true },
  }), EXPECTED);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === 'cleanup.relaunchedAppStopped'));
});

test('rejects evidence carrying credential-shaped fields', () => {
  const result = verifyEvidence(validEvidence({ apiKey: 'should-not-appear' }), EXPECTED);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /sensitive fields/.test(error.message)));
});

test('rejects a missing archive hash or checksum', () => {
  const result = verifyEvidence(validEvidence({ newZip: { name: 'x.zip', size: 10 } }), EXPECTED);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === 'newZip'));
});

test('rejects old baseline provenance that does not match released bytes (F6)', () => {
  const mismatchedZip = verifyEvidence(validEvidence({
    oldZip: { name: 'Xpod-0.4.19-arm64-mac.zip', size: 2048, sha256: 'd'.repeat(64), version: '0.4.19' },
  }), EXPECTED);
  assert.equal(mismatchedZip.valid, false);
  assert.ok(mismatchedZip.errors.some((error) => error.path === 'oldZip.version'));

  const mismatchedTag = verifyEvidence(validEvidence({ oldReleaseTag: 'v0.4.19' }), EXPECTED);
  assert.equal(mismatchedTag.valid, false);
  assert.ok(mismatchedTag.errors.some((error) => error.path === 'oldReleaseTag'));
});

test('binds evidence.newZip to the uploaded candidate archive bytes (F3)', () => {
  const expected = { ...EXPECTED, newZipSha256: 'c'.repeat(64), newZipSize: 1024, requireNameVersion: true };
  assert.equal(verifyEvidence(validEvidence(), expected).valid, true);

  const wrongBytes = verifyEvidence(validEvidence(), { ...expected, newZipSha256: 'f'.repeat(64) });
  assert.equal(wrongBytes.valid, false);
  assert.ok(wrongBytes.errors.some((error) => error.path === 'newZip.sha256'));

  const wrongName = verifyEvidence(validEvidence({
    newZip: { name: 'Xpod-0.4.23-arm64-mac.zip', size: 1024, sha256: 'c'.repeat(64), sha512: VALID_SHA512 },
  }), expected);
  assert.equal(wrongName.valid, false);
  assert.ok(wrongName.errors.some((error) => error.path === 'newZip.name'));
});

test('orders released versions above their own pre-releases', () => {
  assert.ok(compareVersions('0.4.20', '0.4.22-rc.5') < 0);
  assert.ok(compareVersions('0.4.22', '0.4.22-rc.5') > 0);
  assert.equal(compareVersions('0.4.22', '0.4.22'), 0);
});

test('CLI verify requires the uploaded candidate archive to match (F3)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-verifier-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const candidateZip = path.join(dir, `Xpod-${NEW_VERSION}-arm64-mac.zip`);
  fs.writeFileSync(candidateZip, Buffer.from('candidate-archive-bytes'));
  const sha256 = createHash('sha256').update(fs.readFileSync(candidateZip)).digest('hex');
  const size = fs.statSync(candidateZip).size;

  const evidencePath = path.join(dir, 'evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(validEvidence({
    newZip: { name: path.basename(candidateZip), size, sha256, sha512: VALID_SHA512 },
  })));
  const checksOut = path.join(dir, 'checks.json');

  const good = spawnSync(process.execPath, [
    verifierPath, 'verify', '--evidence', evidencePath, '--source-sha', SOURCE_SHA,
    '--new-version', NEW_VERSION, '--expected-new-zip', candidateZip, '--checks-out', checksOut,
  ], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(checksOut, 'utf8')), { desktop: 'passed' });

  // Different archive bytes at the same path must invalidate the check.
  fs.appendFileSync(candidateZip, Buffer.from('tampered'));
  const tampered = spawnSync(process.execPath, [
    verifierPath, 'verify', '--evidence', evidencePath, '--source-sha', SOURCE_SHA,
    '--new-version', NEW_VERSION, '--expected-new-zip', candidateZip,
  ], { encoding: 'utf8' });
  assert.notEqual(tampered.status, 0);

  const badSource = spawnSync(process.execPath, [
    verifierPath, 'verify', '--evidence', evidencePath, '--source-sha', 'e'.repeat(40),
    '--new-version', NEW_VERSION, '--expected-new-zip', candidateZip,
  ], { encoding: 'utf8' });
  assert.notEqual(badSource.status, 0);
});

test('candidate workflow binds the desktop check to real source-bound acceptance', () => {
  const candidate = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/candidate.yml'), 'utf8');
  assert.match(candidate, /desktop\/scripts\/packaged-update-acceptance\.mjs/);
  assert.match(candidate, /--source-sha "\$\{\{ github\.sha \}\}"/);
  assert.match(candidate, /--expected-archive/);
  assert.match(candidate, /desktop-self-update-acceptance-\$\{\{ github\.sha \}\}/);
  assert.match(candidate, /scripts\/desktop-self-update-acceptance\.cjs verify/);
  assert.match(candidate, /scripts\/desktop-acceptance\.cjs/);
  assert.doesNotMatch(candidate, /['"]desktop['"]\s*:\s*['"]passed['"]/);
});

test('resolveCallerPath accepts desktop-relative and repo-root-relative callers (F1)', async () => {
  const producer = await import(pathToFileURL(producerPath).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-paths-'));
  const desktopDir = path.join(dir, 'desktop');
  const releaseDir = path.join(desktopDir, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const desktopRelative = path.join(releaseDir, 'candidate.zip');
  fs.writeFileSync(desktopRelative, Buffer.from('x'));

  // Documented local usage: relative to the desktop package.
  assert.equal(
    producer.resolveCallerPath('release/candidate.zip', { baseDir: desktopDir, cwd: dir }),
    desktopRelative,
  );

  // Candidate workflow: the same archive written relative to the repo root.
  assert.equal(
    producer.resolveCallerPath('desktop/release/candidate.zip', { baseDir: desktopDir, cwd: dir }),
    desktopRelative,
  );

  // Missing path falls back to the documented desktop-relative interpretation.
  assert.equal(
    producer.resolveCallerPath('release/missing.zip', { baseDir: desktopDir, cwd: dir }),
    path.join(releaseDir, 'missing.zip'),
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('producer module import has no side effects (F1/F4 wiring)', async () => {
  const producer = await import(pathToFileURL(producerPath).href);
  assert.equal(typeof producer.resolveCallerPath, 'function');
});

test('feed fixture serves the checksum the released updater verifies (F2)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifact = path.join(dir, 'candidate.zip');
  fs.writeFileSync(artifact, Buffer.from('archive-bytes'));

  const fixture = spawn(process.execPath, [
    fixturePath, '--version', NEW_VERSION, '--artifact', artifact,
    '--sha512', VALID_SHA512, '--size', '13',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => fixture.kill('SIGKILL'));

  const feedUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not start')), 10_000);
    fixture.stdout.setEncoding('utf8');
    let output = '';
    fixture.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/XPOD_UPDATE_FIXTURE_READY (http:\/\/127\.0\.0\.1:\d+\/update\/darwin)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });

  const body = await new Promise((resolve, reject) => {
    http.get(`${feedUrl}?current_version=0.0.0`, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve(text));
    }).on('error', reject);
  });

  const manifest = JSON.parse(body);
  assert.equal(manifest.sha512, VALID_SHA512);
  assert.equal(manifest.size, 13);
  assert.equal(manifest.name, NEW_VERSION);
});

test('feed fixture rejects a checksum that is not base64 sha512 (F2)', () => {
  const result = spawnSync(process.execPath, [
    fixturePath, '--version', NEW_VERSION, '--sha512', 'not-a-checksum',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(result.status, 0);
});
