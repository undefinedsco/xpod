import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fixed-enum phase projection for the EXTERNAL refresh E2E path.
 *
 * The external branch currently throws a constant string, which erased the exact
 * failing checkpoint from RC405. This module names WHERE the run stopped using a
 * closed allowlist, so a future RC keeps the checkpoint without ever exporting
 * page text, error.message, URLs, tokens, keys or account identifiers.
 *
 * Diagnostics only: the failure outcome and exit are unchanged.
 */

/** The ordered checkpoints of the external renew/idle/expire run. Closed set. */
export const EXTERNAL_PHASES = [
  'preflight',
  'storage-verify',
  'browser-verify',
  'electron-launch',
  'login',
  'initial-private-read',
  'anonymous-denied',
  'renewal',
  'post-renew-runtime',
  'restart-launch',
  'restart-runtime',
  'restart-binding-webid',
  'restart-binding-pod',
  'restart-binding-issuer',
  'restart-private-read',
  // The observer-binding checkpoint historically collapsed FOUR independent
  // conjuncts behind one label, so an RC failure could not name which one fired.
  // These finer labels keep every assertion and its expected value identical and
  // only sharpen WHERE the run stopped.
  'observer-binding',
  'observer-binding-read',
  'observer-binding-restart-codes',
  'observer-binding-restart-password',
  'observer-binding-global-counts',
  'final-private-read',
  'cleanup-final',
] as const;

export type ExternalPhase = typeof EXTERNAL_PHASES[number];

/** Fixed reason codes. Deliberately coarse so no message text can be inferred.
 * `approval-timed-out` says the bounded external LOGIN approval loop exhausted
 * its own budget. It is not proof of an `expect.poll` exhaustion: the browser
 * driver throws its timeout error through the same catch. */
export const EXTERNAL_REASONS = [
  'assertion-failed',
  'approval-timed-out',
  'launch-failed',
] as const;

export type ExternalReason = typeof EXTERNAL_REASONS[number];

/**
 * The restart observer's OWN startup counters, projected separately.
 *
 * These are deliberately NOT merged into the global totals above: `authorizationCodes`
 * and `passwordPosts` at the top level are whole-browser-session totals, whereas a
 * restart observer counts only the restarted host. Conflating them was exactly the
 * ambiguity that made an earlier RC failure unreadable.
 *
 * Encoded as small non-negative integers so the envelope stays identifier-free:
 * `authorizationCodes` / `passwordPosts` / `refreshTokens` / `opaquePosts` are the
 * observer's counters, and the booleans are its flags. `present` is 0 when the
 * observer file was absent or unparsable (its read error is then only "no data").
 */
export interface RestartObserverDiagnostic {
  present: number;
  authorizationCodes: number;
  passwordPosts: number;
  refreshTokens: number;
  opaquePosts: number;
  ready: number;
  hostImported: number;
  failed: number;
}

export interface ExternalPhaseDiagnostic {
  phase: ExternalPhase;
  reason: ExternalReason;
  /** Monotonic counters only; never identifiers. GLOBAL session totals. */
  authorizationCodes: number;
  passwordPosts: number;
  refreshGrants: number;
  refreshFailures: number;
  requestCount: number;
  /** Restart observer's own counters/flags (zeros when absent). */
  restartObserver: RestartObserverDiagnostic;
}

const COUNTER_MAX = 10_000;

function counter(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= COUNTER_MAX
    ? (value as number)
    : 0;
}

/**
 * Project the checkpoint. Any unknown phase/reason collapses to a safe member,
 * so a caller cannot smuggle free text through this envelope.
 */
export interface RestartObserverInput {
  /** Recorded host process id; present in the on-disk record, not projected. */
  hostPid?: number;
  ready?: boolean; hostImported?: boolean; failed?: boolean;
  authorizationCodes?: number; passwordPosts?: number;
  refreshTokens?: number; opaquePosts?: number;
}

/** Booleans become 0/1 integers so the envelope stays a fixed numeric shape. */
function flag(value: unknown): number {
  return value === true ? 1 : 0;
}

/**
 * Project the restart observer's own counters. A missing/unparsable observer
 * yields all zeros with `present: 0`, which is honest ("no data") rather than a
 * fabricated success or a silently inflated count.
 */
export function restartObserverDiagnostic(observer: RestartObserverInput | undefined): RestartObserverDiagnostic {
  if (!observer || typeof observer !== 'object') {
    return { present: 0, authorizationCodes: 0, passwordPosts: 0, refreshTokens: 0,
      opaquePosts: 0, ready: 0, hostImported: 0, failed: 0 };
  }
  return {
    present: 1,
    authorizationCodes: counter(observer.authorizationCodes),
    passwordPosts: counter(observer.passwordPosts),
    refreshTokens: counter(observer.refreshTokens),
    opaquePosts: counter(observer.opaquePosts),
    ready: flag(observer.ready),
    hostImported: flag(observer.hostImported),
    failed: flag(observer.failed),
  };
}

export function externalPhaseDiagnostic(input: {
  phase: ExternalPhase;
  reason: ExternalReason;
  authorizationCodes?: number;
  passwordPosts?: number;
  refreshGrants?: number;
  refreshFailures?: number;
  requestCount?: number;
  observer?: RestartObserverInput;
}): ExternalPhaseDiagnostic {
  const phase = EXTERNAL_PHASES.includes(input.phase) ? input.phase : 'preflight';
  const reason = EXTERNAL_REASONS.includes(input.reason) ? input.reason : 'assertion-failed';
  return {
    phase,
    reason,
    authorizationCodes: counter(input.authorizationCodes),
    passwordPosts: counter(input.passwordPosts),
    refreshGrants: counter(input.refreshGrants),
    refreshFailures: counter(input.refreshFailures),
    requestCount: counter(input.requestCount),
    restartObserver: restartObserverDiagnostic(input.observer),
  };
}

/**
 * Serialise for the failure message. The output is a fixed-shape JSON object
 * whose values come only from the closed enums and clamped integers, so this
 * string cannot carry page content, URLs, credentials or identifiers.
 */
export function describeExternalPhase(diagnostic: ExternalPhaseDiagnostic): string {
  return `external session failed at ${JSON.stringify(diagnostic)}`;
}

/** Exactly the eight numeric keys, each a bounded non-negative integer. */
export function isRestartObserverDiagnostic(value: unknown): value is RestartObserverDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const keys = ['present', 'authorizationCodes', 'passwordPosts', 'refreshTokens',
    'opaquePosts', 'ready', 'hostImported', 'failed'];
  if (Object.keys(row).length !== keys.length) return false;
  if (!keys.every(key => Object.prototype.hasOwnProperty.call(row, key))) return false;
  // present/ready/hostImported/failed are 0|1 flags; a value like 2 is NOT valid.
  const flags = ['present', 'ready', 'hostImported', 'failed'];
  if (!flags.every(key => row[key] === 0 || row[key] === 1)) return false;
  // Counters stay non-negative and bounded.
  const counters = ['authorizationCodes', 'passwordPosts', 'refreshTokens', 'opaquePosts'];
  return counters.every(key => Number.isSafeInteger(row[key])
    && (row[key] as number) >= 0 && (row[key] as number) <= COUNTER_MAX);
}

/** True when the value is exactly a well-formed projection (tests use this). */
export function isExternalPhaseDiagnostic(value: unknown): value is ExternalPhaseDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const keys = ['phase', 'reason', 'authorizationCodes', 'passwordPosts',
    'refreshGrants', 'refreshFailures', 'requestCount', 'restartObserver'];
  if (Object.keys(row).length !== keys.length) return false;
  if (!keys.every(key => Object.prototype.hasOwnProperty.call(row, key))) return false;
  if (!EXTERNAL_PHASES.includes(row.phase as ExternalPhase)
    || !EXTERNAL_REASONS.includes(row.reason as ExternalReason)) return false;
  // Same bound as `counter()`: a negative or oversized value is NOT admissible.
  if (![row.authorizationCodes, row.passwordPosts, row.refreshGrants,
    row.refreshFailures, row.requestCount].every(value =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= COUNTER_MAX)) return false;
  return isRestartObserverDiagnostic(row.restartObserver);
}

/** Bounded on-disk envelope. Exactly these keys, nothing caller-supplied. */
export const FAILURE_SAFE_FILE = 'failure.safe.json';

/**
 * Validate a decoded failure.safe.json. Mirrors `isExternalPhaseDiagnostic`
 * exactly, so the exporter admits only the fixed projection: any extra field,
 * unknown enum, or out-of-range counter is inadmissible and must not be copied.
 */
export function isFailureSafeEnvelope(value: unknown): value is { schemaVersion: 1; diagnostic: ExternalPhaseDiagnostic } {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2) return false;
  if (!Object.prototype.hasOwnProperty.call(row, 'schemaVersion')
    || !Object.prototype.hasOwnProperty.call(row, 'diagnostic')) return false;
  return row.schemaVersion === 1 && isExternalPhaseDiagnostic(row.diagnostic);
}

/** The exact bytes written for a failure. Deterministic, fixed shape. */
export function failureSafeEnvelope(diagnostic: ExternalPhaseDiagnostic): {
  schemaVersion: 1; diagnostic: ExternalPhaseDiagnostic;
} {
  return { schemaVersion: 1, diagnostic: externalPhaseDiagnostic(diagnostic) };
}

/**
 * Write the closed-schema failure checkpoint at most ONCE, then describe it.
 *
 * Shared by the main catch and the cleanup path so a throw inside `finally`
 * still records cleanup-final. Never overwrites an earlier, more specific
 * checkpoint (the primary failure wins). Logging cannot replace the real
 * failure or alter the exit status.
 */
export function recordExternalFailure(input: {
  outputDirectory: string;
  phase: ExternalPhase;
  reason: ExternalReason;
  authorizationCodes?: number;
  passwordPosts?: number;
  refreshGrants?: number;
  refreshFailures?: number;
  requestCount?: number;
  observer?: RestartObserverInput;
}): string {
  const diagnostic = externalPhaseDiagnostic(input);
  try {
    writeFileSync(join(input.outputDirectory, FAILURE_SAFE_FILE),
      `${JSON.stringify(failureSafeEnvelope(diagnostic))}\n`, { mode: 0o600, flag: 'wx' });
  } catch { /* absent stays honestly absent; never mask the primary failure */ }
  return describeExternalPhase(diagnostic);
}

/**
 * The restart startup observer contract for a restarted desktop host.
 *
 * The installed @inrupt/solid-client-authn-browser restores a previous session
 * with `prompt: "none"` (dist/index.mjs, silentlyAuthenticate), which is a real
 * silent OAuth login: no user interaction and no password, but it DOES mint a
 * new authorization code. docs in Session.d.ts say the IdP "re-activate[s] the
 * session ... without requiring user interaction", not that zero token
 * exchanges occur.
 *
 * So the durable-login requirement is: exactly one silent authorization code,
 * and zero password posts. Proactive refresh may also run during startup;
 * its count is diagnostic and does not imply another login.
 */
export const RESTART_SILENT_AUTHORIZATION_CODES = 1;

/**
 * Which restart conjunct failed. Diagnostic only: the thrown Error messages are
 * unchanged, so callers and tests that match on message text keep working. The
 * caller uses this to emit a finer fixed phase label, never to relax a check.
 */
export type RestartObserverConjunct =
  | 'import'
  | 'failure'
  | 'authorizationCodes'
  | 'passwordPosts'
  | 'opaquePosts';

export interface RestartObserverResult {
  ok: boolean;
  conjunct?: RestartObserverConjunct;
}

/**
 * Same assertions as `assertRestartObserver`, but reports the failing conjunct
 * instead of throwing. Used by the E2E harness to pick a precise fixed phase tag
 * while still failing the run. This does NOT accept a bad observer.
 */
export function inspectRestartObserver(observer: {
  ready?: boolean; hostImported?: boolean; failed?: boolean;
  authorizationCodes?: number; passwordPosts?: number;
  refreshTokens?: number; opaquePosts?: number;
}): RestartObserverResult {
  if (observer.ready !== true || observer.hostImported !== true) return { ok: false, conjunct: 'import' };
  if (observer.failed !== false) return { ok: false, conjunct: 'failure' };
  if (observer.authorizationCodes !== RESTART_SILENT_AUTHORIZATION_CODES) {
    return { ok: false, conjunct: 'authorizationCodes' };
  }
  if (observer.passwordPosts !== 0) return { ok: false, conjunct: 'passwordPosts' };
  if (observer.opaquePosts !== 0) return { ok: false, conjunct: 'opaquePosts' };
  return { ok: true };
}

export function assertRestartObserver(observer: {
  ready?: boolean; hostImported?: boolean; failed?: boolean;
  authorizationCodes?: number; passwordPosts?: number;
  refreshTokens?: number; opaquePosts?: number;
}): void {
  // Delegates to the single classifier so the throwing and reporting paths can
  // never disagree about which conjunct failed or whether the observer is valid.
  const verdict = inspectRestartObserver(observer);
  if (verdict.ok) return;
  switch (verdict.conjunct) {
    case 'import': throw new Error('restart observer did not import the host');
    case 'failure': throw new Error('restart observer reported failure');
    case 'authorizationCodes':
      throw new Error(`restart observer authorizationCodes must be exactly ${RESTART_SILENT_AUTHORIZATION_CODES} (silent SSO restore)`);
    case 'passwordPosts': throw new Error('restart restored by password, not silent SSO');
    case 'opaquePosts': throw new Error('restart observed opaque token traffic');
  }
}
