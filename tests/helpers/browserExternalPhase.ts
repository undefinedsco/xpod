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
  // The old single `initial-private-read` label covered FIVE independent assert
  // groups, so a failure could not name which one fired. These four finer labels
  // each sit immediately BEFORE one group; `initial-private-read` is retained for
  // the actual initial GET. Every assertion and expected value is unchanged.
  'initial-token-ttl',
  'initial-token-refresh',
  'initial-put',
  'initial-acl-put',
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

/**
 * Bounded description of the private read that failed.
 *
 * Only a status CLASS is recorded, never a status line, URL, header or token:
 * - `ok`            the request returned 2xx
 * - `client-error`  4xx
 * - `server-error`  5xx
 * - `redirect`      3xx
 * - `other-status`  any other numeric status
 * - `fetch-rejected` the fetch itself rejected (auth/network); the raw reason is
 *                    never persisted, so this fixed code is all that survives
 * - `not-reached`   the read was never attempted (an earlier phase failed)
 */
export const PRIVATE_READ_OUTCOMES = [
  'not-reached',
  'ok',
  'redirect',
  'client-error',
  'server-error',
  'other-status',
  'fetch-rejected',
] as const;

export type PrivateReadOutcome = typeof PRIVATE_READ_OUTCOMES[number];

/** Map a real HTTP status to the closed enum above; no text can pass through. */
/**
 * Bounded numeric HTTP status for the failed private read: an integer 100..599,
 * or 0 when no response was received (fetch rejected / not attempted). Only the
 * NUMBER survives - never a status line, reason phrase, URL, header or message.
 * 401 and 403 therefore stay distinguishable, which the coarse class cannot do.
 */
export function privateReadStatusValue(status: unknown): number {
  if (!Number.isSafeInteger(status)) return 0;
  const value = status as number;
  return value >= 100 && value <= 599 ? value : 0;
}

export function privateReadOutcomeForStatus(status: number | undefined): PrivateReadOutcome {
  if (!Number.isSafeInteger(status)) return 'not-reached';
  const value = status as number;
  if (value >= 200 && value <= 299) return 'ok';
  if (value >= 300 && value <= 399) return 'redirect';
  if (value >= 400 && value <= 499) return 'client-error';
  if (value >= 500 && value <= 599) return 'server-error';
  if (value > 0) return 'other-status';
  return 'not-reached';
}

export type ExternalReason = typeof EXTERNAL_REASONS[number];

/**
 * Bounded facts about the INITIAL (post-login) private-request sequence.
 *
 * The existing `privateRead*` fields describe the LATER post-renew read only, so a
 * local+idle failure at `initial-private-read` shipped `privateReadStatus: 0` and
 * could not distinguish the token TTL assert from a real 4xx/5xx on the PUT/ACL/
 * GET. These fields name the CURRENT initial operation without repurposing it:
 *
 * - `initialHttpStatus` is the numeric status (100..599) of the initial Pod
 *   request that failed, or 0 when no response arrived (rejected / not reached).
 *   It is RESET before every initial operation, so a previous success can never
 *   be misattributed to a later failure.
 * - `initialTokenTtl` is the authorization_code response's `expires_in` as a
 *   small bounded integer, or 0 when it was absent/non-numeric. A string can
 *   never survive this projection.
 * - `initialRefreshIssued` is 1 only when the token response carried a refresh
 *   token, else 0.
 *
 * Values are numbers only, so this can never carry a URL, header, body, token,
 * key or assertion text.
 */
export interface InitialSessionDiagnostic {
  initialHttpStatus: number;
  initialTokenTtl: number;
  initialRefreshIssued: number;
  /**
   * Closed class of the FIRST denied initial Pod write's cause, or absent on
   * receipts written before this field existed. Derived ONLY from the response
   * status plus the fixed JSON error fields `classifyInitialDenial` documents.
   * Never the error text, headers, URL, WebID, token, key or proof.
   */
  initialDenial?: InitialDenialClass;
}

/**
 * Closed denial classes for the denied initial write.
 *
 * These name the OBSERVED response shape only. They do NOT attribute a producer or
 * prove an internal reason: a JSON `H403`/`ForbiddenHttpError` body is emitted by
 * several product/CSS forbidden paths, and 401/400 prove only "unauthorized" and
 * "bad request" respectively.
 *
 * - `root-container-write`    the product proxy's own 403, matched by the exact
 *                             `details.cause` literal it alone writes
 * - `forbidden`               any other 403 carrying the CSS/Product forbidden
 *                             error shape; the producer is NOT identified
 * - `unauthorized`            401: the response was unauthorized. It does not prove
 *                             which credential check failed
 * - `bad-request`             400: the response was a bad request. It does not prove
 *                             DPoP, the proof, or any specific rejection reason
 * - `identifier-outside-space` CSS explicit `E0001`, only with a matching 5xx
 *                             status/errorCode shape
 * - `unknown`                 non-JSON, malformed, oversized, or non-authoritative
 */
export const INITIAL_DENIAL_CLASSES = [
  'root-container-write',
  'forbidden',
  'unauthorized',
  'bad-request',
  'identifier-outside-space',
  'unknown',
] as const;

export type InitialDenialClass = typeof INITIAL_DENIAL_CLASSES[number];

/** Only these exact CSS `errorCode` values are admitted; any other text is dropped. */
const DENIAL_ERROR_CODES: Readonly<Record<string, InitialDenialClass>> = Object.freeze({
  E0001: 'identifier-outside-space',
});

/**
 * Classify the FIRST denied initial Pod write from its status and body.
 *
 * The body is parsed defensively. Only fixed fields are consulted:
 * `statusCode` (must equal the HTTP status), `errorCode` (matched against the
 * closed table) and `details.cause` (one exact
 * literal). A non-JSON, hostile, oversized or non-authoritative body yields
 * `unknown`; no field value is ever copied into the result.
 */
export function classifyInitialDenial(response: { status?: unknown; body?: unknown } | undefined): InitialDenialClass {
  const status = response?.status;
  const body = response?.body;
  let parsed: unknown;
  if (typeof body === 'string' && body.length > 0 && body.length <= 4096) {
    try { parsed = JSON.parse(body); } catch { parsed = undefined; }
  }
  const row = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  const details = row && typeof row.details === 'object' && row.details !== null
    ? row.details as Record<string, unknown> : undefined;
  // The product proxy's own root-mutation 403 is identified by the exact
  // `details.cause` literal only it writes (src/runtime/Proxy.ts). This is the one
  // strong cause marker; everything below names a shape, never a producer.
  if (status === 403 && details?.cause === 'root-container-write') return 'root-container-write';
  // The CSS/Product HTTP-error serializer writes statusCode + that status's default
  // `H<status>` errorCode (util/errors/HttpError.js). Requiring BOTH keeps an
  // arbitrary `errorCode` string from steering the class.
  const httpErrorShape = row !== undefined
    && typeof row.statusCode === 'number' && row.statusCode === status
    && (row.errorCode === `H${status}` || row.errorCode === 'E0001');
  const code = row?.errorCode;
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(DENIAL_ERROR_CODES, code)) {
    // E0001 is the identifier-space code only when the body is a 5xx HTTP error of
    // that exact shape (statusCode matching the HTTP status, errorCode as CSS
    // writes them). Any other status carrying the text is not that cause.
    if (typeof status === 'number' && status >= 500 && status <= 599 && httpErrorShape) {
      return DENIAL_ERROR_CODES[code];
    }
    return 'unknown';
  }
  if (status === 403 && httpErrorShape) return 'forbidden';
  if (status === 401) return 'unauthorized';
  if (status === 400) return 'bad-request';
  return 'unknown';
}

/** `expires_in` is a positive small TTL; 0 says "absent/non-numeric", never text. */
const TOKEN_TTL_MAX = 86_400;

/**
 * Project the initial-session facts. Every input is clamped to a number, so a
 * smuggled string/object cannot become payload.
 */
export function initialSessionDiagnostic(input: {
  initialHttpStatus?: number;
  initialTokenTtl?: number;
  initialRefreshIssued?: boolean;
  initialDenial?: InitialDenialClass;
} | undefined): InitialSessionDiagnostic {
  const ttl = input?.initialTokenTtl;
  const denial = INITIAL_DENIAL_CLASSES.includes(input?.initialDenial as InitialDenialClass)
    ? input?.initialDenial as InitialDenialClass
    : undefined;
  return {
    initialHttpStatus: privateReadStatusValue(input?.initialHttpStatus),
    initialTokenTtl: Number.isSafeInteger(ttl) && (ttl as number) > 0 && (ttl as number) <= TOKEN_TTL_MAX
      ? ttl as number
      : 0,
    initialRefreshIssued: flag(input?.initialRefreshIssued),
    // Omitted entirely when no class applies, so pre-existing receipts keep their
    // exact three-key shape and are not rewritten.
    ...(denial === undefined ? {} : { initialDenial: denial }),
  };
}

/**
 * The three numeric keys plus the OPTIONAL denial enum. A historical receipt with
 * exactly three keys stays valid; a fourth key is admissible only when it is
 * `initialDenial` with a closed-enum value, so no text can ride along.
 */
export function isInitialSessionDiagnostic(value: unknown): value is InitialSessionDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const keys = ['initialHttpStatus', 'initialTokenTtl', 'initialRefreshIssued'];
  const withDenial = [...keys, 'initialDenial'];
  const present = Object.keys(row);
  const shape = present.length === keys.length ? keys
    : present.length === withDenial.length ? withDenial
    : undefined;
  if (!shape) return false;
  if (!shape.every(key => Object.prototype.hasOwnProperty.call(row, key))) return false;
  if (shape === withDenial && !INITIAL_DENIAL_CLASSES.includes(row.initialDenial as InitialDenialClass)) return false;
  const status = row.initialHttpStatus;
  if (!Number.isSafeInteger(status) || (status as number) < 0 || (status as number) > 599
    || (status as number) > 0 && (status as number) < 100) return false;
  const ttl = row.initialTokenTtl;
  if (!Number.isSafeInteger(ttl) || (ttl as number) < 0 || (ttl as number) > TOKEN_TTL_MAX) return false;
  return row.initialRefreshIssued === 0 || row.initialRefreshIssued === 1;
}

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
  /** Bounded class of the private read that failed; never a status line. */
  privateRead: PrivateReadOutcome;
  /** Actual numeric status 100..599, or 0 when no response was received. */
  privateReadStatus: number;
  /** Bounded facts about the INITIAL post-login token/HTTP ops, kept separate. */
  initialSession: InitialSessionDiagnostic;
  /** 1 when the mounted host reported an authenticated session at failure. */
  authenticated: number;
  /** 1 when the restart host had imported the unchanged compiled host. */
  hostReady: number;
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
  privateRead?: PrivateReadOutcome;
  privateReadStatus?: number;
  /** Initial-section facts; absent means "no initial data" (all zeros). */
  initialHttpStatus?: number;
  initialTokenTtl?: number;
  initialRefreshIssued?: boolean;
  /** Closed cause class of the denied initial write; omitted when unclassified. */
  initialDenial?: InitialDenialClass;
  authenticated?: boolean;
  hostReady?: boolean;
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
    privateRead: PRIVATE_READ_OUTCOMES.includes(input.privateRead as PrivateReadOutcome)
      ? input.privateRead as PrivateReadOutcome
      : 'not-reached',
    privateReadStatus: privateReadStatusValue(input.privateReadStatus),
    initialSession: initialSessionDiagnostic({
      initialHttpStatus: input.initialHttpStatus,
      initialTokenTtl: input.initialTokenTtl,
      initialRefreshIssued: input.initialRefreshIssued,
      initialDenial: input.initialDenial,
    }),
    authenticated: flag(input.authenticated),
    hostReady: flag(input.hostReady),
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
    'refreshGrants', 'refreshFailures', 'requestCount', 'restartObserver',
    'privateRead', 'privateReadStatus', 'initialSession', 'authenticated', 'hostReady'];
  if (Object.keys(row).length !== keys.length) return false;
  if (!keys.every(key => Object.prototype.hasOwnProperty.call(row, key))) return false;
  if (!EXTERNAL_PHASES.includes(row.phase as ExternalPhase)
    || !EXTERNAL_REASONS.includes(row.reason as ExternalReason)) return false;
  // Same bound as `counter()`: a negative or oversized value is NOT admissible.
  if (![row.authorizationCodes, row.passwordPosts, row.refreshGrants,
    row.refreshFailures, row.requestCount].every(value =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= COUNTER_MAX)) return false;
  // The private-read class is a closed enum, never a status line or message.
  if (!PRIVATE_READ_OUTCOMES.includes(row.privateRead as PrivateReadOutcome)) return false;
  // 0 (no response) or a real integer status; fractions/strings/out-of-range fail.
  if (!Number.isSafeInteger(row.privateReadStatus)
    || (row.privateReadStatus as number) < 0 || (row.privateReadStatus as number) > 599
    || (row.privateReadStatus as number) > 0 && (row.privateReadStatus as number) < 100) return false;
  // Initial-session facts are three bounded numbers, nothing caller-supplied.
  if (!isInitialSessionDiagnostic(row.initialSession)) return false;
  // Readiness flags are 0|1; anything else (a raw boolean, a string) is invalid.
  if (![row.authenticated, row.hostReady].every(value => value === 0 || value === 1)) return false;
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
  // Re-project through the closed schema so only admissible values ship.
  //
  // CRITICAL: absence must survive re-projection. Passing a synthesised observer
  // object for `present === 0` would make restartObserverDiagnostic() report
  // present:1, i.e. fabricate an observer that never existed. When the record
  // says absent we pass `undefined` through, so the honest present:0 survives.
  const observed = diagnostic.restartObserver;
  const observer: RestartObserverInput | undefined = observed.present === 1
    ? {
      ready: observed.ready === 1,
      hostImported: observed.hostImported === 1,
      failed: observed.failed === 1,
      authorizationCodes: observed.authorizationCodes,
      passwordPosts: observed.passwordPosts,
      refreshTokens: observed.refreshTokens,
      opaquePosts: observed.opaquePosts,
    }
    : undefined;
  return {
    schemaVersion: 1,
    diagnostic: externalPhaseDiagnostic({
      phase: diagnostic.phase,
      reason: diagnostic.reason,
      authorizationCodes: diagnostic.authorizationCodes,
      passwordPosts: diagnostic.passwordPosts,
      refreshGrants: diagnostic.refreshGrants,
      refreshFailures: diagnostic.refreshFailures,
      requestCount: diagnostic.requestCount,
      observer,
      privateRead: diagnostic.privateRead,
      privateReadStatus: diagnostic.privateReadStatus,
      // Initial facts survive re-projection as numbers only; absence stays zeros.
      initialHttpStatus: diagnostic.initialSession?.initialHttpStatus,
      initialTokenTtl: diagnostic.initialSession?.initialTokenTtl,
      initialRefreshIssued: diagnostic.initialSession?.initialRefreshIssued === 1,
      // Absent stays absent: a historical record is never given a fabricated class.
      ...(diagnostic.initialSession?.initialDenial === undefined
        ? {} : { initialDenial: diagnostic.initialSession.initialDenial }),
      authenticated: diagnostic.authenticated === 1,
      hostReady: diagnostic.hostReady === 1,
    }),
  };
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
  privateRead?: PrivateReadOutcome;
  privateReadStatus?: number;
  /** Initial-section facts; absent means "no initial data" (all zeros). */
  initialHttpStatus?: number;
  initialTokenTtl?: number;
  initialRefreshIssued?: boolean;
  /** Closed cause class of the denied initial write; omitted when unclassified. */
  initialDenial?: InitialDenialClass;
  authenticated?: boolean;
  hostReady?: boolean;
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
