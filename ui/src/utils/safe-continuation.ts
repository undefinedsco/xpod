/**
 * One-time continuation context for a task that leaves the Account document and
 * must come back to exactly where it started.
 *
 * A bare `returnTo` URL (or a bare Account *service* URL) is not enough:
 *
 * - Two different Accounts can share one Account service/issuer, so the service
 *   address can never identify who queued the task. The context is bound to the
 *   authoritative Account id the provider reports for the current session.
 * - A consent task is bound to the exact pending OIDC `interaction` and to that
 *   interaction's own consent page. The helper never approves or resumes an
 *   interaction on its own; the server cookie and the live interaction remain
 *   the authority, and a dead/foreign interaction is discarded here.
 * - The context expires on a bounded TTL, and Account switch/cancel clears it so
 *   a stale tab can never resume a task that no longer belongs to the session.
 *
 * The Account id, never a username/WebID/AccountToken, is what makes two
 * Accounts under the same issuer distinguishable.
 */

export const SAFE_CONTINUATION_TTL_MS = 10 * 60 * 1000;

const MAX_FIELD_LENGTH = 2048;
const CONSENT_KEY = 'xpod.safe-continuation.consent.v2';
const MANAGEMENT_KEY = 'xpod.safe-continuation.management.v2';

const INTERACTION_SCOPE = /^\/\.account\/interaction\/([^/?#]+)$/u;
/** Same scope as a prefix of a server-routed page address. */
const INTERACTION_PREFIX = /^\/\.account\/interaction\/([^/?#]+)(?=\/|$)/u;
/** A management route CSS builds from the session's own account id. */
const ACCOUNT_SCOPED_ROUTE = /^\/\.account\/(?:interaction\/[^/?#]+\/)?account\/([^/?#]+)\//u;

export interface ConsentContinuation {
  kind: 'consent';
  /** Authoritative Account id of the session that queued the task. */
  accountId: string;
  /** Opaque `/.account/interaction/{id}` scope of the pending authorization. */
  interaction: string;
  /** Canonical consent page of that same interaction: where the task returns. */
  returnTo: string;
  createdAt: number;
  expiresAt: number;
}

export interface ManagementContinuation {
  kind: 'management';
  /** Authoritative Account id of the session that opened the task. */
  accountId: string;
  /** Same-origin Account address the daily task came from. */
  returnTo: string;
  createdAt: number;
  expiresAt: number;
}

export interface ConsentContinuationInput {
  accountId: string;
  interaction: string;
  returnTo: string;
  /** Internal cap only; never exceeds {@link SAFE_CONTINUATION_TTL_MS}. */
  ttlMs?: number;
}

export interface ManagementContinuationInput {
  accountId: string;
  returnTo: string;
  ttlMs?: number;
}

export interface ConsentContinuationContext {
  accountId: string;
  interaction: string;
}

export interface ManagementContinuationContext {
  accountId: string;
}

function documentOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.location.origin;
  } catch {
    return undefined;
  }
}

function storageSafe(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function validIdentifier(value: unknown): value is string {
  return validString(value) && value === value.trim();
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** `/.account/interaction/{opaque}` exactly, with no child path. */
export function isInteractionScope(value: unknown): value is string {
  return validString(value) && INTERACTION_SCOPE.test(value);
}

/**
 * The interaction scope carried by a page URL. This is the server-routed address,
 * not record data, so it can verify a continuation independently of the record.
 */
export function currentInteractionScope(
  pathname: string | undefined = typeof window === 'undefined' ? undefined : window.location.pathname,
): string | undefined {
  if (!pathname) return undefined;
  const match = INTERACTION_PREFIX.exec(pathname);
  return match ? `/.account/interaction/${match[1]}` : undefined;
}

/**
 * Canonicalise one advertised Account identifier to the opaque account-id segment.
 *
 * An explicit `id` may be an opaque id or the Account resource URI, while the
 * management controls are routes built from the same opaque id. They are only
 * comparable once both are reduced to that segment; a string shaped as neither
 * is not usable evidence and is dropped (never treated as an opaque id).
 */
function canonicalAccountEvidence(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_FIELD_LENGTH) return undefined;
  const fromRoute = accountIdFromControlUrl(value);
  if (fromRoute) return fromRoute;
  // A bare opaque id carries no scheme, path or query.
  if (/^[^/?#:]+$/u.test(value) && value === value.trim()) return value;
  return undefined;
}

function accountIdFromControlUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_FIELD_LENGTH) return undefined;
  let url: URL;
  try {
    // The control is the Account authority's own advertisement, so a deployment
    // whose Account service lives on another origin is still authoritative here.
    url = new URL(value, documentOrigin() ?? 'http://localhost');
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  const match = ACCOUNT_SCOPED_ROUTE.exec(url.pathname);
  return match ? match[1] : undefined;
}

/**
 * The current session's authoritative Account id.
 *
 * The provider (CSS) scopes every Account management route to the session's own
 * account: `/.account/account/{accountId}/...`. Any of those controls therefore
 * carries the account id the server derived for this session, and two Accounts
 * under one issuer produce different ids. If a deployment ever advertises an
 * explicit `id`, that wins. Sources that disagree are rejected outright.
 *
 * Returns `undefined` when no authoritative id can be read; callers must then
 * keep loading / show a retryable error and must not create an unbound context.
 */
export function resolveAuthoritativeAccountId(
  controls: { account?: { id?: unknown; logout?: unknown; clientCredentials?: unknown; bindings?: unknown; pod?: unknown } } | null | undefined,
  identity?: { id?: unknown } | undefined,
): string | undefined {
  const account = controls?.account;
  // Every advertised source is evidence about the same session. They are only
  // trusted together: one source can never be returned while another disagrees.
  const evidence = [
    identity?.id,
    account?.id,
    account?.logout,
    account?.clientCredentials,
    account?.bindings,
    account?.pod,
  ]
    .map(canonicalAccountEvidence)
    .filter((candidate): candidate is string => Boolean(candidate));
  if (evidence.length === 0) return undefined;
  const [first, ...rest] = evidence;
  return rest.every((candidate) => candidate === first) ? first : undefined;
}

/** Same-origin Account destination with no credentials, protocol-relative or external hop. */
export function isAccountReturnTo(value: unknown, origin = documentOrigin()): boolean {
  if (!origin || typeof value !== 'string' || !value || value.length > MAX_FIELD_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return false;
  }
  return url.origin === origin && !url.username && !url.password && url.pathname.startsWith('/.account/');
}

/** The exact canonical consent page of one interaction, on this origin. */
export function isConsentReturnTo(
  interaction: string,
  value: unknown,
  origin = documentOrigin(),
): boolean {
  if (!origin || !isInteractionScope(interaction)) return false;
  if (typeof value !== 'string' || !value || value.length > MAX_FIELD_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return false;
  }
  return url.origin === origin
    && !url.username
    && !url.password
    && url.pathname === `${interaction}/oidc/consent/`
    && url.search === ''
    && url.hash === '';
}

function readRaw(key: string): string | null {
  const storage = storageSafe();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parseRecord(key: string): Record<string, unknown> | undefined {
  const raw = readRaw(key);
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isPlainRecord(parsed) ? parsed : undefined;
}

function writeRecord(key: string, record: object): boolean {
  const storage = storageSafe();
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function removeRecord(key: string): void {
  const storage = storageSafe();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Storage disabled: nothing persisted, nothing to clear.
  }
}

function boundedExpiry(createdAt: number, ttlMs: number | undefined): number | undefined {
  const ttl = ttlMs ?? SAFE_CONTINUATION_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > SAFE_CONTINUATION_TTL_MS) return undefined;
  return createdAt + ttl;
}

function withinWindow(record: Record<string, unknown>): record is { createdAt: number; expiresAt: number } {
  const { createdAt, expiresAt } = record;
  if (!validTime(createdAt) || !validTime(expiresAt)) return false;
  const now = Date.now();
  // A record stamped in the future is not evidence of a real task: a tampered
  // `createdAt`/`expiresAt` pair must not extend the window past the fixed cap.
  if (createdAt > now) return false;
  const duration = expiresAt - createdAt;
  if (duration <= 0 || duration > SAFE_CONTINUATION_TTL_MS) return false;
  if (expiresAt > createdAt + SAFE_CONTINUATION_TTL_MS) return false;
  return expiresAt > now;
}

/** Exact identity of one queued consent task: same Account, interaction and window. */
export function isSameConsentContinuation(left: ConsentContinuation, right: ConsentContinuation): boolean {
  return left.accountId === right.accountId
    && left.interaction === right.interaction
    && left.returnTo === right.returnTo
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt;
}

function decodeConsent(record: Record<string, unknown> | undefined): ConsentContinuation | null {
  if (!record || record.kind !== 'consent') return null;
  const { accountId, interaction, returnTo } = record;
  if (!validIdentifier(accountId) || !isInteractionScope(interaction) || !validString(returnTo)) return null;
  if (!withinWindow(record)) return null;
  if (!isConsentReturnTo(interaction, returnTo)) return null;
  return { kind: 'consent', accountId, interaction, returnTo, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

function decodeManagement(record: Record<string, unknown> | undefined): ManagementContinuation | null {
  if (!record || record.kind !== 'management') return null;
  const { accountId, returnTo } = record;
  if (!validIdentifier(accountId) || !validString(returnTo)) return null;
  if (!withinWindow(record)) return null;
  if (!isAccountReturnTo(returnTo)) return null;
  return { kind: 'management', accountId, returnTo, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

export function saveConsentContinuation(input: ConsentContinuationInput): boolean {
  const accountId = input?.accountId;
  const interaction = input?.interaction;
  const returnTo = input?.returnTo;
  if (!validIdentifier(accountId) || !isInteractionScope(interaction) || !isConsentReturnTo(interaction, returnTo)) {
    return false;
  }
  const now = Date.now();
  const expiresAt = boundedExpiry(now, input.ttlMs);
  if (!expiresAt) return false;
  return writeRecord(CONSENT_KEY, { kind: 'consent', accountId, interaction, returnTo, createdAt: now, expiresAt });
}

/**
 * Read a still-valid consent continuation for the pending interaction.
 *
 * Both the Account id and the interaction must match what the caller presents,
 * and `context.interaction` must be the page's own server-routed scope so a
 * caller cannot re-use the record's own interaction to fake verification.
 */
export function readConsentContinuation(context: ConsentContinuationContext): ConsentContinuation | null {
  const accountId = context?.accountId;
  const interaction = context?.interaction;
  const current = currentInteractionScope();
  if (!validIdentifier(accountId) || !isInteractionScope(interaction) || current !== interaction) {
    removeRecord(CONSENT_KEY);
    return null;
  }
  const decoded = decodeConsent(parseRecord(CONSENT_KEY));
  if (!decoded || decoded.accountId !== accountId || decoded.interaction !== interaction) {
    removeRecord(CONSENT_KEY);
    return null;
  }
  return decoded;
}

export function consumeConsentContinuation(context: ConsentContinuationContext): ConsentContinuation | null {
  const record = readConsentContinuation(context);
  removeRecord(CONSENT_KEY);
  return record;
}

/**
 * Consume the one exact task an in-flight flow already read.
 *
 * A caller that started a long async step must never consume whatever record
 * happens to be present when it finishes: a task cancelled and re-queued for the
 * same Account/interaction is a *different* task, and an old result must not
 * navigate it. The stored record is therefore only consumed when it is byte-for-
 * byte the expected window; a mismatch leaves the newer record untouched.
 */
export function consumeExactConsentContinuation(
  expected: ConsentContinuation,
  options: { assertCurrent?: () => void } = {},
): ConsentContinuation | null {
  const current = decodeConsent(parseRecord(CONSENT_KEY));
  if (!current || !isSameConsentContinuation(current, expected)) return null;
  try {
    options.assertCurrent?.();
  } catch {
    return null;
  }
  removeRecord(CONSENT_KEY);
  return current;
}

export function clearConsentContinuation(): void {
  removeRecord(CONSENT_KEY);
}

export function saveManagementContinuation(input: ManagementContinuationInput): boolean {
  const accountId = input?.accountId;
  const returnTo = input?.returnTo;
  if (!validIdentifier(accountId) || !isAccountReturnTo(returnTo)) return false;
  const now = Date.now();
  const expiresAt = boundedExpiry(now, input.ttlMs);
  if (!expiresAt) return false;
  return writeRecord(MANAGEMENT_KEY, { kind: 'management', accountId, returnTo, createdAt: now, expiresAt });
}

export function readManagementContinuation(context: ManagementContinuationContext): ManagementContinuation | null {
  const accountId = context?.accountId;
  if (!validIdentifier(accountId)) {
    removeRecord(MANAGEMENT_KEY);
    return null;
  }
  const decoded = decodeManagement(parseRecord(MANAGEMENT_KEY));
  if (!decoded || decoded.accountId !== accountId) {
    removeRecord(MANAGEMENT_KEY);
    return null;
  }
  return decoded;
}

export function consumeManagementContinuation(context: ManagementContinuationContext): ManagementContinuation | null {
  const record = readManagementContinuation(context);
  removeRecord(MANAGEMENT_KEY);
  return record;
}

export function clearManagementContinuation(): void {
  removeRecord(MANAGEMENT_KEY);
}

/**
 * Schema- and TTL-validated peek used only on a surface whose own URL carries no
 * interaction scope (the heavy `/settings/pod`). The record is never resumed on
 * its own evidence: the caller must first confirm the interaction through
 * {@link confirmConsentInteractionAtAuthority}, which re-reads the server.
 */
export function peekConsentContinuation(context: { accountId: string }): ConsentContinuation | null {
  const accountId = context?.accountId;
  if (!validIdentifier(accountId)) {
    removeRecord(CONSENT_KEY);
    return null;
  }
  const decoded = decodeConsent(parseRecord(CONSENT_KEY));
  if (!decoded || decoded.accountId !== accountId) {
    removeRecord(CONSENT_KEY);
    return null;
  }
  return decoded;
}

/**
 * One-time consume for a surface whose own URL carries no interaction scope (the
 * heavy `/settings/pod`). The caller must have already confirmed the very same
 * record through {@link confirmConsentInteractionAtAuthority} — the server, not
 * the record, is what proves the interaction is live. This only guarantees the
 * record was not swapped for another Account's task in the meantime, so the
 * confirmed destination is not replayed twice.
 */
export function consumeConfirmedConsentContinuation(
  confirmed: ConsentContinuation,
  context: { accountId: string },
  options: { assertCurrent?: () => void } = {},
): ConsentContinuation | null {
  const accountId = context?.accountId;
  if (!validIdentifier(accountId)) {
    removeRecord(CONSENT_KEY);
    return null;
  }
  const current = decodeConsent(parseRecord(CONSENT_KEY));
  if (!current || current.accountId !== accountId || !isSameConsentContinuation(current, confirmed)) {
    removeRecord(CONSENT_KEY);
    return null;
  }
  try {
    options.assertCurrent?.();
  } catch {
    return null;
  }
  removeRecord(CONSENT_KEY);
  return current;
}

/**
 * Confirm with the server that the interaction in the record is still pending for
 * this session. The record itself is never trusted: a dead, cancelled or foreign
 * interaction does not answer with a consent document, so the task is dropped.
 */
export async function confirmConsentInteractionAtAuthority(
  record: ConsentContinuation,
  options: {
    fetch?: typeof fetch;
    origin?: string;
    headers?: Record<string, string>;
    /** The caller's Account-capability guard; throws when the session changed. */
    assertCurrent?: () => void;
  } = {},
): Promise<boolean> {
  const origin = options.origin ?? documentOrigin();
  if (!origin || !isConsentReturnTo(record.interaction, record.returnTo, origin)) return false;
  const doFetch = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return false;
  const target = new URL(record.returnTo, origin).href;
  let response: Response;
  try {
    options.assertCurrent?.();
    // Never follow a redirect: a re-targeted request would answer for a
    // different interaction, which must not count as this one being live.
    response = await doFetch(target, {
      method: 'GET',
      credentials: 'include',
      redirect: 'manual',
      headers: { accept: 'application/json', ...(options.headers ?? {}) },
    });
  } catch {
    return false;
  }
  try {
    options.assertCurrent?.();
  } catch {
    return false;
  }
  if (response.redirected === true) return false;
  if (typeof response.status === 'number' && response.status >= 300 && response.status < 400) return false;
  if (!response.ok) return false;
  // The answered address must be the exact interaction we asked about.
  if (typeof response.url === 'string' && response.url && response.url !== target) return false;
  const body = await response.json().catch(() => undefined);
  if (!isPlainRecord(body)) return false;
  const client = body.client;
  return isPlainRecord(client)
    && (typeof client.client_id === 'string' || typeof client.client_name === 'string');
}

/**
 * Heavy-surface read: peek + server confirmation. Returns the record only while
 * the server still serves that interaction's consent document for this session.
 */
export async function readConfirmedConsentContinuation(
  context: { accountId: string },
  options: {
    fetch?: typeof fetch;
    origin?: string;
    headers?: Record<string, string>;
    assertCurrent?: () => void;
  } = {},
): Promise<ConsentContinuation | null> {
  const record = peekConsentContinuation(context);
  if (!record) return null;
  const confirmed = await confirmConsentInteractionAtAuthority(record, options);
  // An Account switch/expiry during the await must not return the old task: the
  // stored record is re-read and must still be the very same, still-valid task.
  const current = decodeConsent(parseRecord(CONSENT_KEY));
  if (!confirmed || !current || current.accountId !== context.accountId || !isSameConsentContinuation(current, record)) {
    removeRecord(CONSENT_KEY);
    return null;
  }
  try {
    options.assertCurrent?.();
  } catch {
    return null;
  }
  return current;
}
