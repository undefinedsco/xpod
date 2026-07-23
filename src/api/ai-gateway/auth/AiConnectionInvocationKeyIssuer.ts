import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import type { StoreContext } from '../../chatkit/store';
import type { AIConnectionInvocationConfig } from '../../../agents/types';
import type { GatewayDeployment } from './GatewayApiKey';
import { DEFAULT_GATEWAY_API_KEY_SCOPES } from './GatewayApiKeyAuthenticator';
import { requireCanonicalWebId, type InvocationTokenCodec } from './InvocationTokenCodec';

// ACP can remain in an interactive authentication wait for five minutes.
// Ten minutes covers that boundary plus the resumed turn while retaining a
// hard fifteen-minute ceiling for every stateless invocation token.
const DEFAULT_INVOCATION_KEY_TTL_MS = 10 * 60_000;
const MAX_INVOCATION_KEY_TTL_MS = 15 * 60_000;

export interface AiConnectionInvocationKeyIssuerOptions {
  codec: InvocationTokenCodec;
  deployment: GatewayDeployment;
  baseUrl: string;
  ttlMs?: number;
  reuseSafetyMarginMs?: number;
  maxCacheEntries?: number;
  now?: () => Date;
}

/**
 * Produces a short-lived stateless Gateway token at the trusted execution
 * boundary. Nothing is persisted; plaintext exists solely in process memory
 * and the returned invocation context.
 */
export class AiConnectionInvocationKeyIssuer {
  private readonly codec: InvocationTokenCodec;
  private readonly deployment: GatewayDeployment;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly reuseSafetyMarginMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CachedInvocation>();
  private readonly pending = new Map<string, Promise<CachedInvocation>>();

  public constructor(options: AiConnectionInvocationKeyIssuerOptions) {
    this.codec = options.codec;
    this.deployment = options.deployment;
    this.baseUrl = requireBaseUrl(options.baseUrl);
    this.ttlMs = normalizeTtl(options.ttlMs);
    this.reuseSafetyMarginMs = normalizeSafetyMargin(options.reuseSafetyMarginMs, this.ttlMs);
    this.maxCacheEntries = normalizeMaxCacheEntries(options.maxCacheEntries);
    this.now = options.now ?? (() => new Date());
  }

  public async issue(context: StoreContext): Promise<AIConnectionInvocationConfig> {
    const auth = requireTrustedSolidAuth(context.auth as AuthContext | undefined);
    const webId = requireCanonicalWebId(auth.webId);
    const now = this.now();
    const cached = this.cache.get(webId);
    if (cached && cached.expiresAt.getTime() - now.getTime() >= this.reuseSafetyMarginMs) {
      return { baseUrl: this.baseUrl, gatewayKey: cached.plaintext };
    }
    let pending = this.pending.get(webId);
    if (!pending) {
      pending = Promise.resolve().then(() => this.createInvocation(webId, now));
      this.pending.set(webId, pending);
      const clearPending = (): void => {
        if (this.pending.get(webId) === pending) {
          this.pending.delete(webId);
        }
      };
      void pending.then(clearPending, clearPending);
    }
    const issued = await pending;

    return {
      baseUrl: this.baseUrl,
      gatewayKey: issued.plaintext,
    };
  }

  private createInvocation(webId: string, createdAt: Date): CachedInvocation {
    this.pruneCache(createdAt);
    const expiresAt = new Date(createdAt.getTime() + this.ttlMs);
    const plaintext = this.codec.encode({
      deployment: this.deployment,
      webId,
      scopes: [...DEFAULT_GATEWAY_API_KEY_SCOPES],
      issuedAt: createdAt,
      expiresAt,
    });
    const cached = { plaintext, expiresAt };
    this.cache.set(webId, cached);
    return cached;
  }

  private pruneCache(now: Date): void {
    for (const [webId, cached] of this.cache) {
      if (cached.expiresAt.getTime() <= now.getTime()) {
        this.cache.delete(webId);
      }
    }
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.cache.delete(oldest);
    }
  }
}

interface CachedInvocation {
  plaintext: string;
  expiresAt: Date;
}

function requireTrustedSolidAuth(auth: AuthContext | undefined): SolidAuthContext {
  if (
    auth?.type !== 'solid'
    || typeof auth.webId !== 'string'
    || auth.webId.trim().length === 0
    || auth.viaGatewayApiKey === true
  ) {
    throw new Error('AI Connection invocation key requires an authenticated Solid WebID');
  }
  return auth;
}

function requireBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '');
  if (!normalized) {
    throw new Error('AI Connection invocation baseUrl is required');
  }
  return normalized;
}

function normalizeTtl(value: number | undefined): number {
  const ttlMs = value ?? DEFAULT_INVOCATION_KEY_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_INVOCATION_KEY_TTL_MS) {
    throw new Error(`AI Connection invocation key TTL must be between 1 and ${MAX_INVOCATION_KEY_TTL_MS} milliseconds`);
  }
  return ttlMs;
}

function normalizeSafetyMargin(value: number | undefined, ttlMs: number): number {
  const margin = value ?? 30_000;
  if (!Number.isFinite(margin) || margin < 0 || margin >= ttlMs) {
    throw new Error('AI Connection invocation key reuse safety margin must be non-negative and less than its TTL');
  }
  return margin;
}

function normalizeMaxCacheEntries(value: number | undefined): number {
  const entries = value ?? 1_024;
  if (!Number.isSafeInteger(entries) || entries <= 0 || entries > 100_000) {
    throw new Error('AI Connection invocation key cache size must be between 1 and 100000');
  }
  return entries;
}
