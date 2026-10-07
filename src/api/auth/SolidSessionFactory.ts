import { createHash } from 'node:crypto';
import { createDpopHeader, generateDpopKeyPair, type KeyPair } from '@inrupt/solid-client-authn-core';
import { getLoggerFor } from 'global-logger-factory';
import { resolveTokenEndpointRoute, type TokenEndpointRoute } from './TokenEndpointRoute';
import { extractAuthoritativeWebIdFromTokenResponse } from './TokenIdentity';

/** The caller's own CSS client credentials, in the clear, for the length of one call. */
export interface SolidClientCredential {
  clientId: string;
  clientSecret: string;
  /**
   * The credential's version, when the caller tracks rotation. It is part of the cache
   * identity, so a rotated secret never reuses the previous session.
   */
  version?: string;
}

/**
 * One exchanged credential: the token, the key it is bound to, and when it stops being usable.
 *
 * The key is kept because a DPoP token is only usable by whoever can prove possession: a caller
 * that discards the key holds a token it cannot spend on the Pod.
 */
export interface SolidSession {
  accessToken: string;
  tokenType: 'Bearer' | 'DPoP';
  dpopKey?: KeyPair;
  expiresAt: number;
  /** WebID the issuer bound this credential to, when it reports one. */
  webId?: string;
}

export interface SolidSessionFactoryOptions {
  /** Token endpoint of the Solid interface that issues these credentials. */
  tokenEndpoint: string;
  /** Canonical base URL of that interface, used to keep the DPoP proof canonical. */
  publicBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Upper bound on remembered sessions; the oldest is dropped first. */
  maxEntries?: number;
}

const TOKEN_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const DEFAULT_MAX_ENTRIES = 256;

/**
 * Exchanges CSS client credentials for Solid tokens.
 *
 * Inbound admission is a fresh exchange with the issuer on every request: a session in this cache
 * proves only that some earlier exchange succeeded, never that the credential is still
 * registered. The cache serves the outbound side - one request that arrives with an `sk-` wrapper
 * and then reads the Pod reuses the token its own admission just obtained instead of exchanging
 * the same credential a second time, and repeated Pod work keeps a live token and the key it is
 * bound to until it is spent. Cache identity is the issuer, the complete credential and its
 * version - never just the owner or the client id, which are public identification rather than
 * authentication evidence.
 */
export class SolidSessionFactory {
  private readonly logger = getLoggerFor(this);
  private readonly route: TokenEndpointRoute;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly sessions = new Map<string, SolidSession>();
  private readonly pending = new Map<string, { clientId: string; promise: Promise<SolidSession> }>();
  /** Cache keys per client id, so a revoked credential can be forgotten without its secret. */
  private readonly keysByClientId = new Map<string, Set<string>>();
  private readonly clientIdByKey = new Map<string, string>();
  /**
   * Monotonic per-client invalidation counter. `admit` reads it before its exchange and only
   * publishes the result while it is unchanged, so a success that resolves after a revocation
   * cannot hand the outbound cache authority the revocation just took away. It is not a
   * revocation record and never admits anything: every request still proves its own credential
   * with a fresh exchange.
   */
  private readonly invalidationSeq = new Map<string, number>();
  /** In-flight `admit` calls per client id, so a counter is kept only while it guards one. */
  private readonly admissionsInFlight = new Map<string, number>();

  public constructor(options: SolidSessionFactoryOptions) {
    this.route = resolveTokenEndpointRoute(options.tokenEndpoint, options.publicBaseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** A usable session for this credential, exchanging it when the cached one is spent. */
  public async session(credential: SolidClientCredential): Promise<SolidSession> {
    const key = cacheKey(this.route, credential);
    const cached = this.sessions.get(key);
    if (cached && cached.expiresAt > this.now() + TOKEN_EXPIRY_SKEW_MS) {
      return cached;
    }
    const existing = this.pending.get(key);
    if (existing) {
      return existing.promise;
    }
    this.forgetKey(key);

    const promise = this.exchange(credential).then((session) => {
      if (this.pending.get(key) !== pending) {
        throw new SolidSessionError('token_exchange_invalidated');
      }
      this.remember(key, credential.clientId, session);
      return session;
    }).finally(() => {
      if (this.pending.get(key) === pending) {
        this.pending.delete(key);
      }
    });
    const pending = { clientId: credential.clientId, promise };
    this.pending.set(key, pending);
    return promise;
  }

  /**
   * Admit an inbound request that presents these client credentials.
   *
   * Admission is always a fresh exchange with the issuer that owns the credential. A cached token
   * proves that some earlier exchange succeeded; it is not evidence that the credential is still
   * registered, so it must never stand in for present authority. A credential deleted from its
   * Account has to stop opening the gateway on the very next request, not whenever the last token
   * it obtained happens to expire.
   *
   * The fresh session is published to the cache, so the rest of this request - reaching the
   * owner's Pod - finds that same token and the DPoP key it is bound to instead of exchanging the
   * same credential a second time. Concurrent inbound requests deliberately do not share each
   * other's exchange, for the same reason they do not share a cached token: each has to prove the
   * credential itself.
   *
   * The publishing is conditional on the credential not having been invalidated while the
   * exchange was in flight. A success the issuer returned before a revocation is not present
   * authority, so it is handed to this caller - already-authorized work is not torn down - but it
   * is not written into the cache that later Pod access reads.
   */
  public async admit(credential: SolidClientCredential): Promise<SolidSession> {
    const key = cacheKey(this.route, credential);
    const clientId = credential.clientId;
    const capturedSeq = this.invalidationSeq.get(clientId) ?? 0;
    this.admissionsInFlight.set(clientId, (this.admissionsInFlight.get(clientId) ?? 0) + 1);
    let session: SolidSession;
    try {
      session = await this.exchange(credential);
    } catch (error) {
      // A definitive refusal means this credential is gone, so the session cached under it is
      // stale evidence and goes with it. An outage says nothing about the credential, so the
      // cache is left alone and the caller hears 503 instead of 401.
      try {
        if (isCredentialRefusal(error)) {
          this.invalidate(credential);
        }
      } finally {
        this.releaseAdmission(clientId);
      }
      throw error;
    }
    try {
      if ((this.invalidationSeq.get(clientId) ?? 0) === capturedSeq) {
        this.remember(key, clientId, session);
      }
    } finally {
      this.releaseAdmission(clientId);
    }
    return session;
  }

  /**
   * Forget every cached session for one client.
   *
   * Revocation happens at the issuer, which this process cannot observe, so the record that
   * represents the credential has to say so: without this an already-issued token keeps
   * authenticating the wrapper until it expires, and a deleted API Key looks like it still works.
   */
  public invalidateClientCredential(clientId: string): void {
    this.bumpInvalidation(clientId);
    const keys = this.keysByClientId.get(clientId);
    for (const key of keys ?? []) {
      this.forgetKey(key);
    }
    for (const [key, pending] of this.pending) {
      if (pending.clientId === clientId) {
        this.pending.delete(key);
      }
    }
    this.pruneInvalidation(clientId);
  }

  /**
   * Mark a credential as definitively invalidated without deleting anything yet: the counter makes
   * an in-flight exchange that resolves later decline to publish its result. Removed as soon as no
   * admission for the client is still in flight, so it carries no state past its purpose.
   */
  private bumpInvalidation(clientId: string): void {
    this.invalidationSeq.set(clientId, (this.invalidationSeq.get(clientId) ?? 0) + 1);
  }

  private releaseAdmission(clientId: string): void {
    const remaining = (this.admissionsInFlight.get(clientId) ?? 1) - 1;
    if (remaining > 0) {
      this.admissionsInFlight.set(clientId, remaining);
    } else {
      this.admissionsInFlight.delete(clientId);
    }
    this.pruneInvalidation(clientId);
  }

  /**
   * Drop the counter once no admission can still be racing it. While one is in flight the counter
   * has to survive so that admission declines to republish; afterwards it is dead weight.
   */
  private pruneInvalidation(clientId: string): void {
    if (this.admissionsInFlight.has(clientId)) {
      return;
    }
    this.invalidationSeq.delete(clientId);
  }

  private remember(key: string, clientId: string, session: SolidSession): void {
    this.sessions.set(key, session);
    const keys = this.keysByClientId.get(clientId) ?? new Set<string>();
    keys.add(key);
    this.keysByClientId.set(clientId, keys);
    this.clientIdByKey.set(key, clientId);
    pruneOldest(this.sessions, this.maxEntries, (evicted) => this.forgetKey(evicted));
  }

  /** Drop one cache entry and its client-id index, whichever path removed it. */
  private forgetKey(key: string): void {
    this.sessions.delete(key);
    const clientId = this.clientIdByKey.get(key);
    if (!clientId) {
      return;
    }
    this.clientIdByKey.delete(key);
    const tracked = this.keysByClientId.get(clientId);
    if (!tracked) {
      return;
    }
    tracked.delete(key);
    if (tracked.size === 0) {
      this.keysByClientId.delete(clientId);
    }
  }

  /**
   * Forget a credential's session, because the Pod or the issuer stopped accepting it.
   *
   * The caller retries with a fresh exchange rather than a different identity: a rejected token
   * says nothing about who the caller is.
   */
  public invalidate(credential: SolidClientCredential, expectedSession?: SolidSession): void {
    const key = cacheKey(this.route, credential);
    // A late rejection of an old token cannot evict its replacement or pending renewal.
    if (expectedSession && this.sessions.get(key) !== expectedSession) {
      return;
    }
    this.bumpInvalidation(credential.clientId);
    this.pending.delete(key);
    this.forgetKey(key);
    this.pruneInvalidation(credential.clientId);
  }

  private async exchange(credential: SolidClientCredential): Promise<SolidSession> {
    const dpopKey = await generateDpopKeyPair();
    const response = await this.fetchImpl(this.route.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${
          Buffer.from(`${credential.clientId}:${credential.clientSecret}`, 'utf8').toString('base64')
        }`,
        DPoP: await createDpopHeader(this.route.proofUrl, 'POST', dpopKey),
        ...this.route.headers,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'webid' }),
    });

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      this.logger.warn(`Solid client credential refused for ${credential.clientId.slice(0, 8)}...: ${response.status}`);
      throw new SolidSessionError(`token_exchange_failed:${response.status}`, response.status);
    }
    const parsed = parseTokenResponse(body);
    if (!parsed) {
      this.logger.warn(`Solid client credential exchange returned no access token for ${credential.clientId.slice(0, 8)}...`);
      throw new SolidSessionError('token_exchange_invalid_response');
    }
    const webId = extractAuthoritativeWebIdFromTokenResponse(parsed.raw);
    return {
      accessToken: parsed.accessToken,
      tokenType: parsed.dpopBound ? 'DPoP' : 'Bearer',
      ...(parsed.dpopBound ? { dpopKey } : {}),
      expiresAt: this.now() + parsed.expiresInSeconds * 1000,
      ...(webId ? { webId } : {}),
    };
  }
}

export class SolidSessionError extends Error {
  public readonly status?: number;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = 'SolidSessionError';
    this.status = status;
  }
}

function cacheKey(route: TokenEndpointRoute, credential: SolidClientCredential): string {
  // The secret never appears in the key, and the key never leaves this object.
  return [
    route.url,
    route.proofUrl,
    credential.clientId,
    credential.version ?? '',
    fingerprintSecret(credential.clientSecret),
  ].join('\u0000');
}

/** A stable, non-reversible fingerprint: two different secrets must never share a session. */
function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Whether the issuer definitively refused the credential itself, rather than failing to answer.
 *
 * Only 400, 401 and 403 mean "this credential is not registered any more". Everything else is not
 * evidence about the credential: a 5xx, a 429, a network error or an unparseable response is an
 * outage or a rate limit of the issuer, and reporting that as a revoked key would both mislead the
 * caller and throw away a session that is still perfectly good.
 */
function isCredentialRefusal(error: unknown): boolean {
  const status = error instanceof SolidSessionError ? error.status : undefined;
  return status === 400 || status === 401 || status === 403;
}

function pruneOldest(
  cache: Map<string, SolidSession>,
  limit: number,
  onEvict?: (key: string) => void,
): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
    onEvict?.(oldest.value);
  }
}

function parseTokenResponse(body: string): {
  accessToken: string;
  dpopBound: boolean;
  expiresInSeconds: number;
  raw: Record<string, unknown>;
} | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : undefined;
  if (!accessToken) {
    return undefined;
  }
  const expiresIn = typeof raw.expires_in === 'number' && raw.expires_in > 0
    ? raw.expires_in
    : DEFAULT_TOKEN_LIFETIME_SECONDS;
  return {
    accessToken,
    dpopBound: String(raw.token_type ?? 'DPoP').toUpperCase() !== 'BEARER',
    expiresInSeconds: expiresIn,
    raw,
  };
}
