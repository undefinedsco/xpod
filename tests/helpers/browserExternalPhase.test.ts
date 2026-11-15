import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  classifyInitialDenial, INITIAL_DENIAL_CLASSES,
  EXTERNAL_PHASES, EXTERNAL_REASONS, externalPhaseDiagnostic, describeExternalPhase,
  isExternalPhaseDiagnostic, failureSafeEnvelope, isFailureSafeEnvelope, FAILURE_SAFE_FILE,
  recordExternalFailure, assertRestartObserver, RESTART_SILENT_AUTHORIZATION_CODES,
  inspectRestartObserver, restartObserverDiagnostic, isRestartObserverDiagnostic,
  privateReadOutcomeForStatus, initialSessionDiagnostic, isInitialSessionDiagnostic,
} from './browserExternalPhase';

/**
 * These tests prove the external failure projection cannot carry secrets.
 * They are diagnostics-only guarantees, not release gates.
 */
test('projection accepts only closed-enum phases and reasons', () => {
  for (const phase of EXTERNAL_PHASES) {
    const row = externalPhaseDiagnostic({ phase, reason: 'assertion-failed' });
    assert.equal(row.phase, phase);
    assert.ok(isExternalPhaseDiagnostic(row));
  }
  for (const reason of EXTERNAL_REASONS) {
    assert.equal(externalPhaseDiagnostic({ phase: 'renewal', reason }).reason, reason);
  }
  // An out-of-enum phase/reason collapses to a safe member instead of passing through.
  const smuggled = externalPhaseDiagnostic({
    phase: 'https://id-rc.example/?token=SEKRET' as never,
    reason: 'alice@example.test password=hunter2' as never,
  });
  assert.equal(smuggled.phase, 'preflight');
  assert.equal(smuggled.reason, 'assertion-failed');
});

test('counters are clamped and non-integers cannot become payload', () => {
  const row = externalPhaseDiagnostic({
    phase: 'renewal', reason: 'approval-timed-out',
    authorizationCodes: 3,
    passwordPosts: Number.NaN as never,
    refreshGrants: -5 as never,
    refreshFailures: 10 ** 9 as never,
    requestCount: 1.5 as never,
  });
  assert.equal(row.authorizationCodes, 3);
  assert.deepEqual(
    [row.passwordPosts, row.refreshGrants, row.refreshFailures, row.requestCount],
    [0, 0, 0, 0],
  );
});

test('the projection is a fixed key set so extra fields cannot leak', () => {
  const row = externalPhaseDiagnostic({
    phase: 'restart-runtime', reason: 'binding-mismatch',
    pageText: 'secret body text',
    token: 'SEKRET',
  } as never);
  assert.equal(Object.keys(row).length, 13);
  assert.equal(JSON.stringify(row).includes('SEKRET'), false);
  assert.equal(JSON.stringify(row).includes('secret body text'), false);
  assert.deepEqual(Object.keys(row).sort(), [
    'authenticated', 'authorizationCodes', 'hostReady', 'initialSession', 'passwordPosts',
    'phase', 'privateRead', 'privateReadStatus', 'reason', 'refreshFailures',
    'refreshGrants', 'requestCount', 'restartObserver',
  ]);
  // The nested observer projection is itself a closed numeric key set.
  assert.equal(Object.keys(row.restartObserver).length, 8);
  // The initial-session projection is a closed numeric key set too.
  assert.equal(Object.keys(row.initialSession).length, 3);
});

test('validator rejects the bounds-violating counters it used to accept', () => {
  // These are exactly the loopholes ROOT named: negative and huge integers.
  for (const bad of [-1, 10_001, Number.MAX_SAFE_INTEGER]) {
    const row = { phase: 'renewal', reason: 'assertion-failed', authorizationCodes: bad,
      passwordPosts: 0, refreshGrants: 0, refreshFailures: 0, requestCount: 0,
      restartObserver: restartObserverDiagnostic(undefined) };
    assert.equal(isExternalPhaseDiagnostic(row), false, String(bad));
  }
  assert.equal(isExternalPhaseDiagnostic({ phase: 'renewal', reason: 'assertion-failed',
    authorizationCodes: 0, passwordPosts: 0, refreshGrants: 0, refreshFailures: 0, requestCount: 0,
    restartObserver: restartObserverDiagnostic(undefined), initialSession: initialSessionDiagnostic(undefined),
    privateRead: 'not-reached', privateReadStatus: 0, authenticated: 0, hostReady: 0 }), true);
});

test('failure.safe envelope is closed-schema and validator-admissible', () => {
  const env = failureSafeEnvelope(externalPhaseDiagnostic({ phase: 'restart-private-read', reason: 'assertion-failed',
    authorizationCodes: 1, passwordPosts: 1, refreshGrants: 1, refreshFailures: 0, requestCount: 12,
    observer: { ready: true, hostImported: true, failed: false,
      authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 } }));
  assert.equal(FAILURE_SAFE_FILE, 'failure.safe.json');
  assert.deepEqual(Object.keys(env).sort(), ['diagnostic', 'schemaVersion']);
  assert.equal(isFailureSafeEnvelope(env), true);
  // extra field at envelope level is inadmissible
  assert.equal(isFailureSafeEnvelope({ ...env, pageText: 'secret' }), false);
  // extra field inside the diagnostic is inadmissible
  assert.equal(isFailureSafeEnvelope({ schemaVersion: 1,
    diagnostic: { ...env.diagnostic, url: 'http://x/' } }), false);
  // malformed / wrong version / wrong shape
  assert.equal(isFailureSafeEnvelope({ schemaVersion: 2, diagnostic: env.diagnostic }), false);
  assert.equal(isFailureSafeEnvelope({ schemaVersion: 1 }), false);
  assert.equal(isFailureSafeEnvelope(null), false);
  assert.equal(isFailureSafeEnvelope(env.diagnostic), false);
});

test('new phase names cover restart read, observer binding and cleanup-final', () => {
  for (const phase of ['restart-private-read', 'observer-binding', 'cleanup-final'] as const) {
    assert.ok(EXTERNAL_PHASES.includes(phase), phase);
  }
});


test('the denied initial write maps observed SHAPES to neutral closed classes', () => {
  // CAUTION: a JSON H403/ForbiddenHttpError body is written by several CSS/product
  // forbidden paths. The class names the observed shape and never attributes the
  // producer or proves an internal reason.
  // The product proxy's own root-mutation 403 carries one exact cause literal.
  assert.equal(classifyInitialDenial({ status: 403, body: JSON.stringify({
    name: 'ForbiddenHttpError', message: 'Write to server root is not allowed.',
    statusCode: 403, errorCode: 'H403', details: { cause: 'root-container-write' },
  }) }), 'root-container-write');
  // A generic forbiddden shape stays NEUTRAL: no producer, no authenticated proof.
  assert.equal(classifyInitialDenial({ status: 403, body: JSON.stringify({
    name: 'ForbiddenHttpError', message: 'Forbidden', statusCode: 403, errorCode: 'H403', details: {},
  }) }), 'forbidden');
  // The exact root marker outranks the generic shape.
  assert.equal(classifyInitialDenial({ status: 403, body: JSON.stringify({
    name: 'ForbiddenHttpError', statusCode: 403, errorCode: 'H403',
    details: { cause: 'root-container-write' },
  }) }), 'root-container-write');
  // 401 proves only "unauthorized"; 400 only "bad request".
  assert.equal(classifyInitialDenial({ status: 401, body: '' }), 'unauthorized');
  assert.equal(classifyInitialDenial({ status: 400, body: 'not json' }), 'bad-request');
  // E0001 counts ONLY as the identifier-space cause with a matching 5xx HTTP shape.
  assert.equal(classifyInitialDenial({ status: 500, body: JSON.stringify({
    name: 'InternalServerError', message: 'x', statusCode: 500, errorCode: 'E0001',
  }) }), 'identifier-outside-space');
  assert.equal(classifyInitialDenial({ status: 404, body: JSON.stringify({
    name: 'NotFoundHttpError', message: 'x', statusCode: 404, errorCode: 'E0001',
  }) }), 'unknown');
  assert.equal(classifyInitialDenial({ status: 500, body: JSON.stringify({
    name: 'InternalServerError', message: 'x', statusCode: 500, errorCode: 'H500',
  }) }), 'unknown');
  // A mismatched statusCode field never confers the authorised shape.
  assert.equal(classifyInitialDenial({ status: 403, body: JSON.stringify({
    name: 'ForbiddenHttpError', statusCode: 200, errorCode: 'H403', details: {},
  }) }), 'unknown');
  // Everything else is honestly unknown rather than guessed.
  for (const response of [
    { status: 403, body: 'plain text' },
    { status: 502, body: '{}' },
    { status: 201, body: '{}' },
    { status: undefined, body: undefined },
    undefined,
  ]) assert.equal(classifyInitialDenial(response as never), 'unknown', JSON.stringify(response));
  // The closed set is exactly what the recorder may ever emit.
  assert.deepEqual([...INITIAL_DENIAL_CLASSES].sort(), [
    'bad-request', 'forbidden', 'identifier-outside-space',
    'root-container-write', 'unauthorized', 'unknown',
  ]);
});

test('the classifier agrees with the REAL CSS error serializer output', () => {
  // Use the installed authoritative serializer and error classes, not a hand-copied
  // object, so the shape cannot silently drift from the CSS this product ships.
  const { ErrorToJsonConverter } = require('@solid/community-server/dist/storage/conversion/ErrorToJsonConverter.js');
  const { ForbiddenHttpError } = require('@solid/community-server/dist/util/errors/ForbiddenHttpError.js');
  const { BadRequestHttpError } = require('@solid/community-server/dist/util/errors/BadRequestHttpError.js');
  const { UnauthorizedHttpError } = require('@solid/community-server/dist/util/errors/UnauthorizedHttpError.js');
  const serialize = (error: unknown): string => JSON.stringify(new ErrorToJsonConverter().errorToJson(error));

  // The real generic forbidden serialization: neutral class, no producer claim.
  assert.equal(classifyInitialDenial({ status: 403, body: serialize(new ForbiddenHttpError()) }), 'forbidden');
  // The real 400/401 serializations: shape-only classes.
  assert.equal(classifyInitialDenial({ status: 400, body: serialize(new BadRequestHttpError('nope')) }), 'bad-request');
  assert.equal(classifyInitialDenial({ status: 401, body: serialize(new UnauthorizedHttpError()) }), 'unauthorized');
  // Adding the product's root marker to that SAME real shape changes the class,
  // proving the discriminator is the exact literal and nothing else.
  const realForbidden = JSON.parse(serialize(new ForbiddenHttpError())) as Record<string, unknown>;
  assert.equal(classifyInitialDenial({ status: 403, body: JSON.stringify({
    ...realForbidden, details: { cause: 'root-container-write' },
  }) }), 'root-container-write');
  // Re-serialized real bytes must not leak the stack/message through the projection.
  const withSecret = classifyInitialDenial({ status: 403,
    body: JSON.stringify({ ...realForbidden, message: 'SEKRET-STACK-VALUE' }) });
  assert.equal(withSecret, 'forbidden');
  assert.equal(JSON.stringify(withSecret).includes('SEKRET'), false);
});

test('a denied initial write cannot carry secret-like text into the projection', () => {
  const secret = 'Bearer SEKRET https://id-rc.example/?access_token=SEKRET alice@example.test';
  // A hostile body smuggling secret text in EVERY field still classifies by the
  // fixed literals only; the text itself is never returned.
  const hostile = classifyInitialDenial({ status: 403, body: JSON.stringify({
    statusCode: 403, name: 'ForbiddenHttpError', message: secret, errorCode: 'H403',
    details: { cause: secret, path: secret },
  }) });
  assert.equal(hostile, 'forbidden');
  assert.equal(JSON.stringify(hostile).includes('SEKRET'), false);
  // An over-bound body is not parsed at all.
  assert.equal(classifyInitialDenial({ status: 400, body: `${'x'.repeat(5000)}` }), 'bad-request');
  // A non-enum class is rejected by the serializer instead of being written.
  const row = externalPhaseDiagnostic({
    phase: 'initial-put', reason: 'assertion-failed',
    initialHttpStatus: 403, initialTokenTtl: 30, initialRefreshIssued: true,
    initialDenial: `BEARER ${secret}` as never,
  });
  assert.equal(row.initialSession.initialDenial, undefined);
  assert.equal(JSON.stringify(row).includes('SEKRET'), false);
  // And an injected enum value never survives validation.
  assert.equal(isInitialSessionDiagnostic({
    initialHttpStatus: 403, initialTokenTtl: 30, initialRefreshIssued: 1,
    initialDenial: secret,
  }), false);
});

test('the denial enum reaches the real failure file and stays backward compatible', () => {
  const root = path.resolve('.test-data/browser-external-phase');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'denial-'));
  try {
    recordExternalFailure({
      outputDirectory: dir, phase: 'initial-put', reason: 'assertion-failed',
      initialHttpStatus: 403, initialTokenTtl: 30, initialRefreshIssued: true,
      initialDenial: 'root-container-write',
    });
    const onDisk = JSON.parse(readFileSync(path.join(dir, FAILURE_SAFE_FILE), 'utf8'));
    // The FAILED status is preserved even though the cause is known.
    assert.equal(onDisk.diagnostic.initialSession.initialHttpStatus, 403);
    assert.equal(onDisk.diagnostic.initialSession.initialDenial, 'root-container-write');
    assert.equal(onDisk.diagnostic.phase, 'initial-put');
    assert.equal(isFailureSafeEnvelope(onDisk), true);
    // Re-projection keeps the class and the real numbers.
    const again = failureSafeEnvelope(onDisk.diagnostic).diagnostic;
    assert.equal(again.initialSession.initialDenial, 'root-container-write');
    assert.equal(again.initialSession.initialTokenTtl, 30);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // A historical receipt with exactly three keys stays admissible and unchanged,
  // and re-projection does not invent a denial class for it.
  const historical = { initialHttpStatus: 403, initialTokenTtl: 30, initialRefreshIssued: 1 };
  assert.equal(isInitialSessionDiagnostic(historical), true);
  const reprojected = failureSafeEnvelope(externalPhaseDiagnostic({
    phase: 'initial-put', reason: 'assertion-failed',
    initialHttpStatus: 403, initialTokenTtl: 30, initialRefreshIssued: true,
  })).diagnostic;
  assert.equal('initialDenial' in reprojected.initialSession, false);
  assert.equal(reprojected.initialSession.initialHttpStatus, 403);
});

test('a successful initial write records NO denial class', () => {
  // The spec only classifies a non-201, so success keeps the three-key shape.
  const row = externalPhaseDiagnostic({
    phase: 'initial-private-read', reason: 'assertion-failed',
    initialHttpStatus: 201, initialTokenTtl: 30, initialRefreshIssued: true,
  });
  assert.equal('initialDenial' in row.initialSession, false);
  assert.equal(isInitialSessionDiagnostic(row.initialSession), true);
});

test('the FIVE initial-session checkpoints all survive and stay ordered', () => {
  // Each of the five historically-conflated initial assert groups gets its own
  // closed token. `initial-private-read` is retained for the actual initial GET.
  const checkpoints = ['initial-token-ttl', 'initial-token-refresh', 'initial-put',
    'initial-acl-put', 'initial-private-read'] as const;
  for (const phase of checkpoints) {
    assert.ok(EXTERNAL_PHASES.includes(phase), phase);
    const row = externalPhaseDiagnostic({ phase, reason: 'assertion-failed' });
    assert.equal(row.phase, phase);
    // A realistic initial failure is writable and still admissible.
    assert.equal(isExternalPhaseDiagnostic(row), true);
  }
  const i = (p: string) => EXTERNAL_PHASES.indexOf(p as never);
  // Before the token asserts is `login`; the five are strictly ordered and the
  // GET token is last, immediately before the unchanged anonymous-denied phase.
  assert.ok(i('initial-token-ttl') > i('login'));
  assert.ok(i('initial-token-refresh') > i('initial-token-ttl'));
  assert.ok(i('initial-put') > i('initial-token-refresh'));
  assert.ok(i('initial-acl-put') > i('initial-put'));
  assert.ok(i('initial-private-read') > i('initial-acl-put'));
  assert.ok(i('anonymous-denied') > i('initial-private-read'));
});

test('initial-session projection accepts only three bounded numbers', () => {
  // Real contract shape: 30s deployment TTL, HTTP 201, refresh issued.
  const row = externalPhaseDiagnostic({
    phase: 'initial-put', reason: 'assertion-failed',
    initialHttpStatus: 500, initialTokenTtl: 30, initialRefreshIssued: true,
  });
  assert.deepEqual(row.initialSession, {
    initialHttpStatus: 500, initialTokenTtl: 30, initialRefreshIssued: 1,
  });
  assert.equal(isInitialSessionDiagnostic(row.initialSession), true);
  // Absent initial data is honest zeros, never a fabricated pass value.
  assert.deepEqual(initialSessionDiagnostic(undefined), {
    initialHttpStatus: 0, initialTokenTtl: 0, initialRefreshIssued: 0,
  });
  // A rejected fetch/unknown TTL projects as 0; only the number survives.
  assert.deepEqual(initialSessionDiagnostic({
    initialHttpStatus: undefined, initialTokenTtl: undefined, initialRefreshIssued: false,
  }), { initialHttpStatus: 0, initialTokenTtl: 0, initialRefreshIssued: 0 });
});

test('arbitrary secret-like initial values cannot enter the projection', () => {
  const secret = 'Bearer SEKRET https://id-rc.example/?access_token=SEKRET 30 expires_in';
  const row = externalPhaseDiagnostic({
    phase: 'initial-token-ttl', reason: 'assertion-failed',
    initialHttpStatus: secret as never,
    initialTokenTtl: secret as never,
    initialRefreshIssued: 'true' as never,
  });
  const text = JSON.stringify(row);
  assert.equal(text.includes('SEKRET'), false);
  assert.equal(text.includes('id-rc.example'), false);
  assert.equal(text.includes('Bearer'), false);
  // Non-numbers clamp: status 0, ttl 0, refresh bit 0 (a string is not `true`).
  assert.deepEqual(row.initialSession, {
    initialHttpStatus: 0, initialTokenTtl: 0, initialRefreshIssued: 0,
  });
  // Bounds: out-of-range/fractional TTLs and statuses are rejected, not shipped.
  for (const ttl of [-1, 0.5, 86_401, Number.NaN, '30']) {
    assert.equal(isInitialSessionDiagnostic({
      initialHttpStatus: 0, initialTokenTtl: ttl, initialRefreshIssued: 0,
    }), false, String(ttl));
  }
  for (const status of [99, 600, -1, 1.5, Number.NaN, '401', '403 Unauthorized']) {
    assert.equal(isInitialSessionDiagnostic({
      initialHttpStatus: status, initialTokenTtl: 0, initialRefreshIssued: 0,
    }), false, String(status));
  }
  // Extra foreign keys are inadmissible, so text cannot ride along.
  assert.equal(isInitialSessionDiagnostic({
    initialHttpStatus: 0, initialTokenTtl: 0, initialRefreshIssued: 0, token: 'SEKRET',
  }), false);
  // A raw boolean flag is not 0|1 and must be rejected.
  assert.equal(isInitialSessionDiagnostic({
    initialHttpStatus: 0, initialTokenTtl: 0, initialRefreshIssued: true,
  }), false);
});

test('initial-session facts survive the real file pipeline and re-projection', () => {
  const root = path.resolve('.test-data/browser-external-phase');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'initial-'));
  try {
    recordExternalFailure({
      outputDirectory: dir, phase: 'initial-put', reason: 'assertion-failed',
      initialHttpStatus: 500, initialTokenTtl: 30, initialRefreshIssued: true,
    });
    const onDisk = JSON.parse(readFileSync(path.join(dir, FAILURE_SAFE_FILE), 'utf8'));
    assert.equal(onDisk.diagnostic.phase, 'initial-put');
    assert.deepEqual(onDisk.diagnostic.initialSession, {
      initialHttpStatus: 500, initialTokenTtl: 30, initialRefreshIssued: 1,
    });
    assert.equal(isFailureSafeEnvelope(onDisk), true);
    // Re-projection is idempotent and keeps the real numbers (30 is the exact TTL).
    const again = failureSafeEnvelope(onDisk.diagnostic).diagnostic;
    assert.deepEqual(again.initialSession, onDisk.diagnostic.initialSession);
    assert.equal(again.initialSession.initialTokenTtl, 30);
    // The later post-renew field is untouched and stays independently 0 here.
    assert.equal(onDisk.diagnostic.privateReadStatus, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('each of the five initial checkpoints writes a distinct record', () => {
  // Proves every checkpoint can actually reach failure.safe.json, not just exist
  // in the enum: an RC failure stops at exactly one of these five labels.
  const root = path.resolve('.test-data/browser-external-phase');
  mkdirSync(root, { recursive: true });
  const phases = ['initial-token-ttl', 'initial-token-refresh', 'initial-put',
    'initial-acl-put', 'initial-private-read'] as const;
  const written: string[] = [];
  try {
    for (const phase of phases) {
      const dir = mkdtempSync(path.join(root, `${phase}-`));
      try {
        recordExternalFailure({ outputDirectory: dir, phase, reason: 'assertion-failed',
          initialHttpStatus: phase === 'initial-private-read' ? 200 : 0, initialTokenTtl: 30 });
        const onDisk = JSON.parse(readFileSync(path.join(dir, FAILURE_SAFE_FILE), 'utf8'));
        assert.equal(onDisk.diagnostic.phase, phase);
        assert.equal(isFailureSafeEnvelope(onDisk), true);
        written.push(onDisk.diagnostic.phase);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // Five distinct labels, no collapse back into one checkpoint.
    assert.deepEqual(written, [...phases]);
    assert.equal(new Set(written).size, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('per-field restart binding phases exist and are ordered after restart-runtime', () => {
  const i = (p: string) => EXTERNAL_PHASES.indexOf(p as never);
  assert.ok(i('restart-binding-webid') > i('restart-runtime'));
  assert.ok(i('restart-binding-pod') > i('restart-binding-webid'));
  assert.ok(i('restart-binding-issuer') > i('restart-binding-pod'));
  assert.ok(i('restart-private-read') > i('restart-binding-issuer'));
});

test('recordExternalFailure writes once, never overwrites, and keeps the first checkpoint', () => {
  const root = path.resolve('.test-data/browser-external-phase');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'phase-'));
  try {
    const first = recordExternalFailure({ outputDirectory: dir,
      phase: 'restart-binding-pod', reason: 'assertion-failed', requestCount: 181 });
    // A later cleanup checkpoint must not replace the primary one.
    const second = recordExternalFailure({ outputDirectory: dir,
      phase: 'cleanup-final', reason: 'assertion-failed' });
    assert.match(first, /restart-binding-pod/u);
    assert.match(second, /cleanup-final/u);
    const onDisk = JSON.parse(readFileSync(path.join(dir, FAILURE_SAFE_FILE), 'utf8'));
    assert.equal(onDisk.diagnostic.phase, 'restart-binding-pod');
    assert.equal(onDisk.diagnostic.requestCount, 181);
    assert.equal(isFailureSafeEnvelope(onDisk), true);
    assert.equal((statSync(path.join(dir, FAILURE_SAFE_FILE)).mode & 0o777), 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordExternalFailure never throws when the directory is unwritable', () => {
  // Absent directory: the write fails, but the helper still returns the message
  // so the caller can preserve the ORIGINAL failure.
  const text = recordExternalFailure({ outputDirectory: '/nonexistent-rc405-dir',
    phase: 'cleanup-final', reason: 'assertion-failed' });
  assert.match(text, /cleanup-final/u);
});

test('restart accepts exactly one silent authorization code and no password', () => {
  // Observed real contract from ROOT's run: ready/import true, codes 1,
  // password 0, refresh 0, opaque 0 -- a silent prompt=none SSO restore.
  assert.equal(RESTART_SILENT_AUTHORIZATION_CODES, 1);
  assertRestartObserver({ ready: true, hostImported: true, failed: false,
    authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 });
  // A normal proactive refresh is compatible with a single silent login.
  assertRestartObserver({ ready: true, hostImported: true, failed: false,
    authorizationCodes: 1, passwordPosts: 0, refreshTokens: 1, opaquePosts: 0 });
});

test('restart still rejects password login, zero codes, extra codes and bad flags', () => {
  const base = { ready: true, hostImported: true, failed: false,
    authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 };
  const rejects = (over: object, why: RegExp) => {
    assert.throws(() => assertRestartObserver({ ...base, ...over }), { message: why });
  };
  // A password login is NOT a silent restore.
  rejects({ passwordPosts: 1 }, /password/u);
  // The old zero-code assumption is genuinely invalid for prompt=none SSO.
  rejects({ authorizationCodes: 0 }, /authorizationCodes/u);
  // A second code means an extra interactive/again exchange.
  rejects({ authorizationCodes: 2 }, /authorizationCodes/u);
  // No degraded startup.
  rejects({ ready: false }, /import/u);
  rejects({ hostImported: false }, /import/u);
  rejects({ failed: true }, /failure/u);
  rejects({ opaquePosts: 1 }, /opaque/u);
});

test('restart observer counters are reported separately from global totals', () => {
  // The exact RC409 ambiguity: global totals 2 codes / 1 password on an expire
  // run are NORMAL, while the restarted host must show 1 code / 0 password.
  const diag = externalPhaseDiagnostic({
    phase: 'observer-binding-restart-codes', reason: 'assertion-failed',
    authorizationCodes: 2, passwordPosts: 1, refreshGrants: 0, refreshFailures: 1, requestCount: 256,
    observer: { ready: true, hostImported: true, failed: false,
      authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 },
  });
  // Global projection keeps the whole-session numbers.
  assert.equal(diag.authorizationCodes, 2);
  assert.equal(diag.passwordPosts, 1);
  // The observer projection reports the restarted host only.
  assert.deepEqual(diag.restartObserver, {
    present: 1, authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0,
    opaquePosts: 0, ready: 1, hostImported: 1, failed: 0,
  });
  assert.equal(isExternalPhaseDiagnostic(diag), true);
});

test('a missing restart observer is reported as absent, not as a passing zero', () => {
  const diag = externalPhaseDiagnostic({
    phase: 'observer-binding-read', reason: 'assertion-failed', observer: undefined,
  });
  assert.equal(diag.restartObserver.present, 0);
  // Zeros alone must never be confused with a valid 0-code observer, because
  // present=0 is the explicit "no data" marker.
  assert.equal(isRestartObserverDiagnostic(diag.restartObserver), true);
  assert.notDeepEqual(diag.restartObserver, restartObserverDiagnostic({
    ready: true, hostImported: true, failed: false,
    authorizationCodes: 0, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0,
  }));
});

test('observer projection rejects out-of-range or extra keys', () => {
  const base = restartObserverDiagnostic({ ready: true, hostImported: true, failed: false,
    authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 });
  assert.equal(isRestartObserverDiagnostic({ ...base, authorizationCodes: -1 }), false);
  assert.equal(isRestartObserverDiagnostic({ ...base, authorizationCodes: 10_001 }), false);
  assert.equal(isRestartObserverDiagnostic({ ...base, token: 'SEKRET' } as never), false);
  assert.equal(isRestartObserverDiagnostic({ ...base, ready: undefined } as never), false);
});

test('inspectRestartObserver names each failing conjunct and never accepts a bad observer', () => {
  const base = { ready: true, hostImported: true, failed: false,
    authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 };
  assert.deepEqual(inspectRestartObserver(base), { ok: true });
  const cases: Array<[object, string]> = [
    [{ ready: false }, 'import'],
    [{ hostImported: false }, 'import'],
    [{ failed: true }, 'failure'],
    [{ authorizationCodes: 0 }, 'authorizationCodes'],
    [{ authorizationCodes: 2 }, 'authorizationCodes'],
    [{ passwordPosts: 1 }, 'passwordPosts'],
    [{ opaquePosts: 1 }, 'opaquePosts'],
  ];
  for (const [over, conjunct] of cases) {
    assert.deepEqual(inspectRestartObserver({ ...base, ...over }), { ok: false, conjunct });
    // The throwing path must agree with the reporting path, always.
    assert.throws(() => assertRestartObserver({ ...base, ...over }));
  }
});

test('observer flags must be 0 or 1 while counters stay bounded', () => {
  const base = restartObserverDiagnostic({ ready: true, hostImported: true, failed: false,
    authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 });
  assert.equal(isRestartObserverDiagnostic(base), true);
  // A flag of 2 must be inadmissible even though it is a safe integer.
  for (const flagKey of ['present', 'ready', 'hostImported', 'failed'] as const) {
    assert.equal(isRestartObserverDiagnostic({ ...base, [flagKey]: 2 }), false, flagKey);
  }
  // Counters remain plain bounded non-negative integers.
  assert.equal(isRestartObserverDiagnostic({ ...base, authorizationCodes: 2 }), true);
  assert.equal(isRestartObserverDiagnostic({ ...base, authorizationCodes: 10_001 }), false);
  assert.equal(isRestartObserverDiagnostic({ ...base, passwordPosts: -1 }), false);
});

test('a parsed observer with a BAD flag keeps present=1 and its actual counters', () => {
  // This is the read-failure data that was previously lost: the record parsed, so
  // it must be reported as present with its real values even though the spec will
  // (correctly) fail on the bad flag.
  const bad = restartObserverDiagnostic({ ready: false, hostImported: true, failed: true,
    authorizationCodes: 3, passwordPosts: 1, refreshTokens: 2, opaquePosts: 4 });
  assert.equal(bad.present, 1);
  assert.equal(bad.ready, 0);
  assert.equal(bad.hostImported, 1);
  assert.equal(bad.failed, 1);
  assert.equal(bad.authorizationCodes, 3);
  assert.equal(bad.passwordPosts, 1);
  assert.equal(bad.opaquePosts, 4);
  assert.equal(isRestartObserverDiagnostic(bad), true, 'a bad-flag record is still a valid projection');
  // And it still fails the real contract.
  assert.deepEqual(inspectRestartObserver({ ready: false, hostImported: true, failed: true,
    authorizationCodes: 3, passwordPosts: 1, refreshTokens: 2, opaquePosts: 4 }),
  { ok: false, conjunct: 'import' });
});

test('an absent observer is present=0, never a fabricated present=1', () => {
  const absent = restartObserverDiagnostic(undefined);
  assert.equal(absent.present, 0);
  assert.equal(isRestartObserverDiagnostic(absent), true);
});


test('CONTROL FLOW: a private-read failure recorded after an early capture keeps the real snapshot', () => {
  // This reproduces the ACTUAL ordering used by the spec, not a hand-built row:
  // the observer is captured BEFORE the read, the read rejects, and the catch
  // records with whatever snapshot was captured. The old order captured inside
  // the catch and shipped present:0 even though the file existed on disk.
  const root = path.resolve('.test-data/browser-external-phase');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'control-flow-'));
  const observerFile = path.join(dir, 'restart-observer.safe.json');
  writeFileSync(observerFile, JSON.stringify({
    hostPid: 26396, ready: true, hostImported: true, failed: false,
    authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0,
  }));
  try {
    // Mirrors captureObserver(): a single read, kept in a variable.
    let restartObserver: Record<string, unknown> | undefined;
    let phase = 'restart-private-read';
    let privateReadStatus = 0;
    let privateReadOutcome: string = 'not-reached';
    const captureObserver = () => JSON.parse(readFileSync(observerFile, 'utf8'));
    // --- the corrected order: capture first, then read ---
    phase = 'observer-binding-read';
    restartObserver = captureObserver();
    phase = 'restart-private-read';
    let failed = false;
    try {
      throw new Error('private read rejected');     // stands in for a 401/403 fetch
    } catch {
      failed = true;
      privateReadStatus = 403;
      privateReadOutcome = privateReadOutcomeForStatus(privateReadStatus);
    }
    assert.equal(failed, true);
    assert.equal(phase, 'restart-private-read');
    recordExternalFailure({
      outputDirectory: dir, phase: 'restart-private-read', reason: 'assertion-failed',
      observer: restartObserver as never, privateRead: privateReadOutcome as never,
      privateReadStatus, authenticated: true, hostReady: true,
    });
    const onDisk = JSON.parse(readFileSync(path.join(dir, FAILURE_SAFE_FILE), 'utf8'));
    // The snapshot captured BEFORE the failure is the one that ships.
    assert.equal(onDisk.diagnostic.restartObserver.present, 1);
    assert.equal(onDisk.diagnostic.restartObserver.hostImported, 1);
    assert.equal(onDisk.diagnostic.restartObserver.authorizationCodes, 1);
    assert.equal(onDisk.diagnostic.privateReadStatus, 403);
    assert.equal(onDisk.diagnostic.phase, 'restart-private-read');

    // --- the OLD order, for contrast: capture inside the catch, after a failed
    // read that never captured. That yields absent, which is honest but useless.
    const dir2 = mkdtempSync(path.join(root, 'old-order-'));
    try {
      recordExternalFailure({ outputDirectory: dir2, phase: 'restart-private-read',
        reason: 'assertion-failed', observer: undefined });
      const old = JSON.parse(readFileSync(path.join(dir2, FAILURE_SAFE_FILE), 'utf8'));
      assert.equal(old.diagnostic.restartObserver.present, 0);
      assert.notEqual(old.diagnostic.restartObserver.present,
        onDisk.diagnostic.restartObserver.present);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a genuinely missing observer is still present:0 and still fails the gate', () => {
  const row = externalPhaseDiagnostic({
    phase: 'restart-private-read', reason: 'assertion-failed', observer: undefined,
    privateRead: 'fetch-rejected', authenticated: true, hostReady: false,
  });
  assert.equal(row.restartObserver.present, 0);
  assert.equal(row.privateRead, 'fetch-rejected');
  // The observer contract itself must still reject this record.
  assert.equal(inspectRestartObserver({ ready: false, hostImported: false, failed: false,
    authorizationCodes: 0, passwordPosts: 0, opaquePosts: 0 }).ok, false);
  assert.throws(() => assertRestartObserver({ ready: false, hostImported: false, failed: false,
    authorizationCodes: 0, passwordPosts: 0, opaquePosts: 0 }));
});

test('private read status collapses to a closed class and never leaks text', () => {
  assert.equal(privateReadOutcomeForStatus(200), 'ok');
  assert.equal(privateReadOutcomeForStatus(204), 'ok');
  assert.equal(privateReadOutcomeForStatus(401), 'client-error');
  assert.equal(privateReadOutcomeForStatus(403), 'client-error');
  assert.equal(privateReadOutcomeForStatus(500), 'server-error');
  assert.equal(privateReadOutcomeForStatus(302), 'redirect');
  assert.equal(privateReadOutcomeForStatus(undefined), 'not-reached');
  // A smuggled string can never survive projection.
  const row = externalPhaseDiagnostic({
    phase: 'restart-private-read', reason: 'assertion-failed',
    privateRead: 'GET https://id-rc.example/?token=SEKRET 401 Unauthorized' as never,
  });
  assert.equal(row.privateRead, 'not-reached');
  assert.equal(JSON.stringify(row).includes('SEKRET'), false);
  assert.equal(JSON.stringify(row).includes('401'), false);
});

test('new readiness flags reject raw booleans, strings and out-of-range values', () => {
  const base = () => ({
    phase: 'restart-private-read' as const, reason: 'assertion-failed' as const,
    authorizationCodes: 0, passwordPosts: 0, refreshGrants: 0, refreshFailures: 0,
    requestCount: 0, restartObserver: restartObserverDiagnostic(undefined),
    initialSession: initialSessionDiagnostic(undefined),
    privateRead: 'ok' as const, privateReadStatus: 200, authenticated: 1, hostReady: 0,
  });
  assert.equal(isExternalPhaseDiagnostic(base()), true);
  for (const bad of [true, '1', 2, -1, 1.5, null]) {
    assert.equal(isExternalPhaseDiagnostic({ ...base(), authenticated: bad }), false, String(bad));
    assert.equal(isExternalPhaseDiagnostic({ ...base(), hostReady: bad }), false, String(bad));
  }
  // An out-of-enum private read is inadmissible.
  assert.equal(isExternalPhaseDiagnostic({ ...base(), privateRead: 'HTTP/1.1 401' }), false);
});

/**
 * BLOCKING-1 regression: the ACTUAL pipeline (recordExternalFailure -> file ->
 * failureSafeEnvelope/export admission) must never turn an ABSENT observer into
 * a present one. The earlier test only exercised externalPhaseDiagnostic, which
 * is why the unconditional re-projection slipped through.
 */
test('a genuinely missing observer stays present:0 through the real file pipeline', () => {
  const root = path.resolve('.test-data/browser-external-phase');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'absent-'));
  try {
    recordExternalFailure({
      outputDirectory: dir, phase: 'restart-private-read', reason: 'assertion-failed',
      authorizationCodes: 2, passwordPosts: 1, refreshGrants: 0, refreshFailures: 1,
      requestCount: 255, observer: undefined,
      privateRead: 'client-error', privateReadStatus: 403, authenticated: true, hostReady: false,
    });
    const onDisk = JSON.parse(readFileSync(path.join(dir, FAILURE_SAFE_FILE), 'utf8'));
    // The honest absence must survive: present 0 and all-zero counters.
    assert.equal(onDisk.diagnostic.restartObserver.present, 0);
    assert.deepEqual(onDisk.diagnostic.restartObserver, {
      present: 0, authorizationCodes: 0, passwordPosts: 0, refreshTokens: 0,
      opaquePosts: 0, ready: 0, hostImported: 0, failed: 0,
    });
    // And it must still be exportable/admissible, not silently dropped.
    assert.equal(isFailureSafeEnvelope(onDisk), true);
    const reEnveloped = failureSafeEnvelope(onDisk.diagnostic);
    assert.equal(reEnveloped.diagnostic.restartObserver.present, 0);
    assert.equal(isFailureSafeEnvelope(reEnveloped), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('envelope re-projection is idempotent for present:0, present:1 and injected junk', () => {
  // present:0 -> stays absent, exactly once through the projectors.
  const absent = externalPhaseDiagnostic({ phase: 'restart-private-read', reason: 'assertion-failed' });
  const a1 = failureSafeEnvelope(absent).diagnostic;
  const a2 = failureSafeEnvelope(a1).diagnostic;
  assert.deepEqual(a1, a2);
  assert.equal(a1.restartObserver.present, 0);

  // present:1 -> keeps every real field across repeats.
  const present = externalPhaseDiagnostic({
    phase: 'restart-private-read', reason: 'assertion-failed',
    observer: { hostPid: 26396, ready: true, hostImported: true, failed: false,
      authorizationCodes: 1, passwordPosts: 0, refreshTokens: 0, opaquePosts: 0 },
    privateRead: 'ok', privateReadStatus: 200,
  });
  const p1 = failureSafeEnvelope(present).diagnostic;
  const p2 = failureSafeEnvelope(p1).diagnostic;
  assert.deepEqual(p1, p2);
  assert.equal(p1.restartObserver.present, 1);
  assert.equal(p1.restartObserver.hostImported, 1);
  assert.equal(p1.restartObserver.authorizationCodes, 1);

  // Injected junk cannot become a present observer or leak text.
  const junk = { ...absent, restartObserver: { present: 1, ready: 7, hostImported: 'yes',
    failed: 'SEKRET', authorizationCodes: -3, passwordPosts: 1e9, refreshTokens: 1.5,
    opaquePosts: 999999 } } as never;
  const j = failureSafeEnvelope(junk).diagnostic;
  assert.equal(j.restartObserver.present, 1); // declared present, but every field is clamped
  assert.equal(j.restartObserver.ready, 0);
  assert.equal(j.restartObserver.hostImported, 0);
  assert.equal(j.restartObserver.failed, 0);
  assert.equal(j.restartObserver.authorizationCodes, 0);
  assert.equal(j.restartObserver.refreshTokens, 0);
  assert.equal(JSON.stringify(j).includes('SEKRET'), false);
  assert.equal(isFailureSafeEnvelope(failureSafeEnvelope(j)), true);
});

test('401 and 403 stay DISTINCT in the actual saved record, and only numbers ship', () => {
  const root = path.resolve('.test-data/browser-external-phase');
  mkdirSync(root, { recursive: true });
  const statuses = [401, 403];
  const saved: number[] = [];
  try {
    for (const status of statuses) {
      const dir = mkdtempSync(path.join(root, `status-${status}-`));
      try {
        recordExternalFailure({ outputDirectory: dir, phase: 'restart-private-read',
          reason: 'assertion-failed', privateRead: 'client-error', privateReadStatus: status });
        const onDisk = JSON.parse(readFileSync(path.join(dir, FAILURE_SAFE_FILE), 'utf8'));
        saved.push(onDisk.diagnostic.privateReadStatus);
        assert.equal(isFailureSafeEnvelope(onDisk), true);
        // 401 and 403 are the same coarse class but different numbers.
        assert.equal(onDisk.diagnostic.privateRead, 'client-error');
        assert.equal(JSON.stringify(onDisk).includes(String(status)), true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    assert.deepEqual(saved, statuses);
    assert.notEqual(saved[0], saved[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('privateReadStatus accepts 0 and 100..599 only; fractions, strings and junk are rejected', () => {
  const base = () => ({
    phase: 'restart-private-read' as const, reason: 'assertion-failed' as const,
    authorizationCodes: 0, passwordPosts: 0, refreshGrants: 0, refreshFailures: 0,
    requestCount: 0, restartObserver: restartObserverDiagnostic(undefined),
    initialSession: initialSessionDiagnostic(undefined),
    privateRead: 'not-reached' as const, privateReadStatus: 0,
    authenticated: 0, hostReady: 0,
  });
  assert.equal(isExternalPhaseDiagnostic(base()), true);          // 0 = no response
  assert.equal(isExternalPhaseDiagnostic({ ...base(), privateReadStatus: 100 }), true);
  assert.equal(isExternalPhaseDiagnostic({ ...base(), privateReadStatus: 599 }), true);
  for (const bad of [99, 600, -1, 1.5, Number.NaN, '401', '403 Unauthorized', 10 ** 6, null]) {
    assert.equal(isExternalPhaseDiagnostic({ ...base(), privateReadStatus: bad }), false, String(bad));
  }
  // Projection clamps anything inadmissible to 0 rather than passing it through.
  const clamped = externalPhaseDiagnostic({ phase: 'restart-private-read',
    reason: 'assertion-failed', privateReadStatus: '403 Unauthorized' as never });
  assert.equal(clamped.privateReadStatus, 0);
  assert.equal(JSON.stringify(clamped).includes('403 Unauthorized'), false);
});
