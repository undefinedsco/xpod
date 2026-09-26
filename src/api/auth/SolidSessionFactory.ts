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
 * Exchanges CSS client credentials for Solid tokens, once per credential.
 *
 * Inbound authentication and outbound Pod access share this cache, so one request that arrives
 * with an `sk-` wrapper and then reads the Pod performs a single token exchange and keeps the
 * key the token is bound to. Cache identity is the issuer, the complete credential and its
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
    this.sessions.delete(key);

    const session = await this.exchange(credential);
    this.sessions.set(key, session);
    pruneOldest(this.sessions, this.maxEntries);
    return session;
  }

  /**
   * Forget a credential's session, because the Pod or the issuer stopped accepting it.
   *
   * The caller retries with a fresh exchange rather than a different identity: a rejected token
   * says nothing about who the caller is.
   */
  public invalidate(credential: SolidClientCredential): void {
    this.sessions.delete(cacheKey(this.route, credential));
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

function pruneOldest(cache: Map<string, SolidSession>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
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
