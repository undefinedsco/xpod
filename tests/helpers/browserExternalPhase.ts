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
  'observer-binding',
  'final-private-read',
  'cleanup-final',
] as const;

export type ExternalPhase = typeof EXTERNAL_PHASES[number];

/** Fixed reason codes. Deliberately coarse so no message text can be inferred. */
export const EXTERNAL_REASONS = [
  'assertion-failed',
  'poll-timed-out',
  'launch-failed',
] as const;

export type ExternalReason = typeof EXTERNAL_REASONS[number];

export interface ExternalPhaseDiagnostic {
  phase: ExternalPhase;
  reason: ExternalReason;
  /** Monotonic counters only; never identifiers. */
  authorizationCodes: number;
  passwordPosts: number;
  refreshGrants: number;
  refreshFailures: number;
  requestCount: number;
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
export function externalPhaseDiagnostic(input: {
  phase: ExternalPhase;
  reason: ExternalReason;
  authorizationCodes?: number;
  passwordPosts?: number;
  refreshGrants?: number;
  refreshFailures?: number;
  requestCount?: number;
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

/** True when the value is exactly a well-formed projection (tests use this). */
export function isExternalPhaseDiagnostic(value: unknown): value is ExternalPhaseDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const keys = ['phase', 'reason', 'authorizationCodes', 'passwordPosts',
    'refreshGrants', 'refreshFailures', 'requestCount'];
  if (Object.keys(row).length !== keys.length) return false;
  if (!keys.every(key => Object.prototype.hasOwnProperty.call(row, key))) return false;
  if (!EXTERNAL_PHASES.includes(row.phase as ExternalPhase)
    || !EXTERNAL_REASONS.includes(row.reason as ExternalReason)) return false;
  // Same bound as `counter()`: a negative or oversized value is NOT admissible.
  return [row.authorizationCodes, row.passwordPosts, row.refreshGrants,
    row.refreshFailures, row.requestCount].every(value =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= COUNTER_MAX);
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

export function assertRestartObserver(observer: {
  ready?: boolean; hostImported?: boolean; failed?: boolean;
  authorizationCodes?: number; passwordPosts?: number;
  refreshTokens?: number; opaquePosts?: number;
}): void {
  if (observer.ready !== true || observer.hostImported !== true) {
    throw new Error('restart observer did not import the host');
  }
  if (observer.failed !== false) throw new Error('restart observer reported failure');
  if (observer.authorizationCodes !== RESTART_SILENT_AUTHORIZATION_CODES) {
    throw new Error(`restart observer authorizationCodes must be exactly ${RESTART_SILENT_AUTHORIZATION_CODES} (silent SSO restore)`);
  }
  if (observer.passwordPosts !== 0) throw new Error('restart restored by password, not silent SSO');
  if (observer.opaquePosts !== 0) throw new Error('restart observed opaque token traffic');
}
