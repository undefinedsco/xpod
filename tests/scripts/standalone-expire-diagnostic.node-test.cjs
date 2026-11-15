const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  IMAGE_PATTERN, PROFILE, requireImmutableImage, safeFailureProjection,
  safeLifecycleProjection, renderCompose, ownedNonce, SAFE_PHASES,
} = require('../../scripts/diagnose-standalone-expire-session.cjs');

const DIGEST = `sha256:${'a'.repeat(64)}`;

test('diagnostic image admission accepts only the exact immutable repository', () => {
  assert.equal(requireImmutableImage(`ghcr.io/undefinedsco/xpod@${DIGEST}`), `ghcr.io/undefinedsco/xpod@${DIGEST}`);
  const rejected = [
    'ghcr.io/undefinedsco/xpod:0.4.31',            // mutable tag
    'ghcr.io/undefinedsco/xpod',                    // no digest
    `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(63)}`,   // short digest
    `ghcr.io/undefinedsco/xpod@sha256:${'A'.repeat(64)}`,   // non-lowercase
    'xpod@sha256:' + 'a'.repeat(64) + '; rm -rf /',         // injection attempt
    'xpod@sha256:' + 'a'.repeat(64) + ' && echo pwned',
    '', undefined, null,
  ];
  for (const bad of rejected) assert.throws(() => requireImmutableImage(bad), /ghcr\.io\/undefinedsco\/xpod/, String(bad));
  assert.equal(IMAGE_PATTERN.test(`ghcr.io/undefinedsco/xpod@${DIGEST}`), true);
  // A foreign repository is outside the specified scope.
  assert.equal(IMAGE_PATTERN.test(`ghcr.io/other/xpod@${DIGEST}`), false);
  assert.throws(() => requireImmutableImage(`ghcr.io/other/xpod@${DIGEST}`), /ghcr\.io\/undefinedsco\/xpod/);
  // Surrounding whitespace is tolerated and normalized, but the result is still
  // an immutable digest reference - never a shell fragment.
  assert.equal(requireImmutableImage(`  ghcr.io/undefinedsco/xpod@${DIGEST}  `), `ghcr.io/undefinedsco/xpod@${DIGEST}`);
});

test('the diagnostic profile is exactly the standalone expire policy', () => {
  assert.deepEqual({ ...PROFILE }, { kind: 'expire', accessTokenTtl: 30, refreshTokenTtl: 5 });
});

test('owned nonce and compose never leak a shared port, project or volume', () => {
  const nonce = ownedNonce();
  assert.match(nonce, /^[a-f0-9]{12}$/);
  const project = `xpod-diag-${nonce}`;
  const volume = `xpod-diag-${nonce}-data`;
  const derived = '/owned/main.derived.json';
  const compose = renderCompose({ image: `ghcr.io/undefinedsco/xpod@${DIGEST}`, port: 16420, volume, project,
    derivedConfigHostPath: derived });
  const service = compose.services.standalone;
  // Only ONE service, its own port binding and its own volume.
  assert.deepEqual(Object.keys(compose.services), ['standalone']);
  assert.deepEqual(service.ports, ['127.0.0.1:16420:16420']);
  // Own data volume AND the derived config mounted read-only over the image path.
  assert.deepEqual(service.volumes, [`${volume}:/app/data`, `${derived}:/app/config/main.json:ro`]);
  // Container listens on 0.0.0.0 while the published host address stays loopback.
  assert.equal(service.command[service.command.indexOf('--host') + 1], '0.0.0.0');
  assert.deepEqual(Object.keys(compose.volumes), [volume]);
  // Real image entry point, never the non-existent dist/cli/index.js.
  assert.ok(service.command.includes('dist/runtime/service-entry.js'));
  assert.equal(service.command.includes('dist/cli/index.js'), false);
  // Diagnostic label on both container and volume so cleanup can filter exactly.
  assert.equal(service.labels['co.undefineds.xpod.diagnostic'], project);
  assert.equal(compose.volumes[volume].labels['co.undefineds.xpod.diagnostic'], project);
  // Standalone topology: issuer equals base URL.
  assert.equal(service.environment.SOLID_OIDC_ISSUER, service.environment.CSS_BASE_URL);
  // No platform chat/provider key is injected by the diagnostic.
  const env = Object.keys(service.environment);
  assert.equal(env.some(key => /API_KEY|PROVIDER|LITELLM|OPENAI|CHAT/i.test(key)), false);
});

test('failure projection is closed, clamps counters and drops foreign keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-failure-'));
  try {
    const file = path.join(dir, 'failure.safe.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      diagnostic: {
        phase: 'observer-binding-restart-codes',
        reason: 'assertion-failed',
        authorizationCodes: 2, passwordPosts: 1, refreshGrants: 0, refreshFailures: 1, requestCount: 256,
        restartObserver: { present: 1, authorizationCodes: 2, passwordPosts: 0, refreshTokens: 0,
          opaquePosts: 0, ready: 1, hostImported: 1, failed: 0 },
        pageText: 'SECRET BODY',
        url: 'https://evil.example/?token=abc',
      },
    }));
    const safe = safeFailureProjection(file);
    assert.equal(safe.present, 1);
    assert.equal(safe.phase, 'observer-binding-restart-codes');
    assert.equal(safe.restartObserver.authorizationCodes, 2);
    // Foreign/hostile keys never survive the projection.
    const text = JSON.stringify(safe);
    assert.equal(text.includes('SECRET BODY'), false);
    assert.equal(text.includes('evil.example'), false);
    assert.equal(Object.keys(safe).sort().join(','),
      ['authorizationCodes', 'passwordPosts', 'phase', 'reason', 'refreshFailures',
        'refreshGrants', 'requestCount', 'present', 'restartObserver'].sort().join(','));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every finer initial-session checkpoint survives instead of collapsing', () => {
  // The shared closed enum gained four initial labels. This driver's own allowlist
  // must accept them too; otherwise a real initial PUT/ACL/TTL failure would be
  // silently reported as `preflight`, i.e. exactly the ambiguity being removed.
  const phases = ['initial-token-ttl', 'initial-token-refresh', 'initial-put',
    'initial-acl-put', 'initial-private-read'];
  for (const phase of phases) {
    assert.equal(SAFE_PHASES.has(phase), true, phase);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-initial-'));
    try {
      const file = path.join(dir, 'failure.safe.json');
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1,
        diagnostic: { phase, reason: 'assertion-failed', authorizationCodes: 1,
          passwordPosts: 1, refreshGrants: 0, refreshFailures: 0, requestCount: 9 } }));
      assert.equal(safeFailureProjection(file).phase, phase);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // A genuinely unknown phase still collapses; the allowance is not widened.
  assert.equal(SAFE_PHASES.has('initial-evil-phase'), false);
});

test('failure projection refuses unknown enums and out-of-range counters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-enum-'));
  try {
    const file = path.join(dir, 'failure.safe.json');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      diagnostic: { phase: 'evil-phase', reason: 'evil-reason', authorizationCodes: -5,
        passwordPosts: 99_999, refreshGrants: 0, refreshFailures: 0, requestCount: 1 },
    }));
    const safe = safeFailureProjection(file);
    assert.equal(safe.phase, 'preflight');
    assert.equal(safe.reason, 'assertion-failed');
    assert.equal(safe.authorizationCodes, 0);
    assert.equal(safe.passwordPosts, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing or corrupt failure file is absent, never a fabricated pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-absent-'));
  try {
    const absent = safeFailureProjection(path.join(dir, 'nope.json'));
    assert.equal(absent.present, 0);
    assert.equal(absent.restartObserver.present, 0);
    assert.equal(absent.restartObserver.ready, 0);
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json');
    assert.equal(safeFailureProjection(corrupt).present, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lifecycle projection exposes booleans only and normalizes the exit code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-life-'));
  try {
    const file = path.join(dir, 'lifecycle.safe.json');
    fs.writeFileSync(file, JSON.stringify({
      exitCode: 1, timedOut: false, cancelled: false, forcedCleanup: false,
      outputTruncated: false, spawnFailed: false, ownershipUnknown: false, groupAbsent: true,
      stdoutSHA256: 'f'.repeat(64), stderr: 'SECRET',
    }));
    const safe = safeLifecycleProjection(file);
    assert.deepEqual(safe, { present: 1, exitCode: 1, timedOut: false, cancelled: false,
      forcedCleanup: false, outputTruncated: false, spawnFailed: false,
      ownershipUnknown: false, groupAbsent: true });
    assert.equal(JSON.stringify(safe).includes('SECRET'), false);
    assert.deepEqual(safeLifecycleProjection(path.join(dir, 'absent.json')), { present: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the diagnostic receipt can never look like release acceptance', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/diagnose-standalone-expire-session.cjs'), 'utf8');
  // It must declare itself diagnostic-only and must not claim acceptance.
  assert.match(source, /diagnosticOnly:\s*true/);
  assert.match(source, /releaseAcceptance:\s*false/);
  assert.match(source, /setsRuntimeModeMatrix:\s*false/);
  assert.match(source, /kind:\s*'standalone-expire-diagnostic'/);
  // It must never WRITE a runtime-mode-matrix result or a release-style receipt.
  // (The phrase may legitimately appear in a "this is not ..." comment, so assert
  // on assignment/write shapes rather than on the bare word.)
  assert.equal(/runtime-mode-matrix\s*[:=]\s*['"]?passed/.test(source), false);
  assert.equal(/writeFileSync\([^)]*runtime-mode-matrix/.test(source), false);
  assert.equal(/release-acceptance\.json/.test(source), false);
  // Cleanup failure must fail the run rather than pass silently.
  assert.match(source, /cleanup-unconfirmed/);
});
