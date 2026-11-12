import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  EXTERNAL_PHASES, EXTERNAL_REASONS, externalPhaseDiagnostic, describeExternalPhase,
  isExternalPhaseDiagnostic, failureSafeEnvelope, isFailureSafeEnvelope, FAILURE_SAFE_FILE,
  recordExternalFailure, assertRestartObserver, RESTART_SILENT_AUTHORIZATION_CODES,
  inspectRestartObserver, restartObserverDiagnostic, isRestartObserverDiagnostic,
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
  assert.equal(Object.keys(row).length, 8);
  assert.equal(JSON.stringify(row).includes('SEKRET'), false);
  assert.equal(JSON.stringify(row).includes('secret body text'), false);
  assert.deepEqual(Object.keys(row).sort(), [
    'authorizationCodes', 'passwordPosts', 'phase', 'reason',
    'refreshFailures', 'refreshGrants', 'requestCount', 'restartObserver',
  ]);
  // The nested observer projection is itself a closed numeric key set.
  assert.equal(Object.keys(row.restartObserver).length, 8);
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
    restartObserver: restartObserverDiagnostic(undefined) }), true);
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
