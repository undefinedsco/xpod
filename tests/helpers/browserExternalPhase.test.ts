import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  EXTERNAL_PHASES, EXTERNAL_REASONS, externalPhaseDiagnostic, describeExternalPhase,
  isExternalPhaseDiagnostic, failureSafeEnvelope, isFailureSafeEnvelope, FAILURE_SAFE_FILE,
  recordExternalFailure, assertRestartObserver, RESTART_SILENT_AUTHORIZATION_CODES,
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
    phase: 'renewal', reason: 'poll-timed-out',
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
  assert.equal(Object.keys(row).length, 7);
  assert.equal(JSON.stringify(row).includes('SEKRET'), false);
  assert.equal(JSON.stringify(row).includes('secret body text'), false);
  assert.deepEqual(Object.keys(row).sort(), [
    'authorizationCodes', 'passwordPosts', 'phase', 'reason',
    'refreshFailures', 'refreshGrants', 'requestCount',
  ]);
});

test('validator rejects the bounds-violating counters it used to accept', () => {
  // These are exactly the loopholes ROOT named: negative and huge integers.
  for (const bad of [-1, 10_001, Number.MAX_SAFE_INTEGER]) {
    const row = { phase: 'renewal', reason: 'assertion-failed', authorizationCodes: bad,
      passwordPosts: 0, refreshGrants: 0, refreshFailures: 0, requestCount: 0 };
    assert.equal(isExternalPhaseDiagnostic(row), false, String(bad));
  }
  assert.equal(isExternalPhaseDiagnostic({ phase: 'renewal', reason: 'assertion-failed',
    authorizationCodes: 0, passwordPosts: 0, refreshGrants: 0, refreshFailures: 0, requestCount: 0 }), true);
});

test('failure.safe envelope is closed-schema and validator-admissible', () => {
  const env = failureSafeEnvelope({ phase: 'restart-private-read', reason: 'assertion-failed',
    authorizationCodes: 1, passwordPosts: 1, refreshGrants: 1, refreshFailures: 0, requestCount: 12 });
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
