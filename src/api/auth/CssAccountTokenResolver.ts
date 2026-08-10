import { sql } from 'drizzle-orm';
import type { Finalizable } from '@solid/community-server';
import { executeQuery, type IdentityDatabase } from '../../identity/drizzle/db';

const ACCOUNT_COOKIE_KEY_PREFIXES = [
  '/.internal/accounts/cookies/',
  'accounts/cookies/',
] as const;

const REDIS_ACCOUNT_COOKIE_PREFIX = 'accounts/cookies/';

export interface CssAccountTokenRedisStorage {
  get(key: string): Promise<unknown | undefined>;
  finalize?: Finalizable['finalize'];
}

export interface CssAccountTokenResolverOptions {
  /** Shared identity DB used by local and PostgreSQL-backed CSS deployments. */
  db?: IdentityDatabase;
  /** CSS Redis storage configured with the `/.internal/` namespace. */
  redisStorage?: CssAccountTokenRedisStorage;
}

interface WrappedCookieValue {
  expires?: unknown;
  payload?: unknown;
}

/**
 * Resolves CSS's opaque account cookie token without depending on CSS's
 * account-store internals. Local deployments persist it in internal_kv;
 * cloud deployments persist it through the namespaced Redis storage.
 */
export class CssAccountTokenResolver {
  private readonly db?: IdentityDatabase;
  private readonly redisStorage?: CssAccountTokenRedisStorage;

  public constructor(options: CssAccountTokenResolverOptions = {}) {
    this.db = options.db;
    this.redisStorage = options.redisStorage;
  }

  public async resolveAccountId(token: string): Promise<string | undefined> {
    if (!token) {
      return undefined;
    }

    let dbError: unknown;
    if (this.db) {
      for (const prefix of ACCOUNT_COOKIE_KEY_PREFIXES) {
        try {
          const result = await executeQuery<{ value: unknown }>(
            this.db,
            sql`SELECT value FROM internal_kv WHERE key = ${`${prefix}${token}`} LIMIT 1`,
          );
          const accountId = parseWrappedCookieValue(result.rows[0]?.value);
          if (accountId) {
            return accountId;
          }
        } catch (error) {
          dbError = error;
        }
      }
    }

    if (this.redisStorage) {
      try {
        const value = await this.redisStorage.get(`${REDIS_ACCOUNT_COOKIE_PREFIX}${token}`);
        return parseWrappedCookieValue(value);
      } catch (error) {
        // A configured Redis backend is authoritative when the local lookup
        // misses. Propagate the failure so authentication returns 503 rather
        // than accidentally treating a backend outage as a valid session.
        throw error;
      }
    }

    if (dbError) {
      throw dbError;
    }
    return undefined;
  }

  public async finalize(): Promise<void> {
    await this.redisStorage?.finalize?.();
  }
}

function parseWrappedCookieValue(raw: unknown): string | undefined {
  const value = parseJsonIfNeeded(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const wrapped = value as WrappedCookieValue;
  if (typeof wrapped.expires === 'string') {
    const expiresAt = Date.parse(wrapped.expires);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return undefined;
    }
  } else {
    return undefined;
  }

  if (typeof wrapped.payload !== 'string' || !wrapped.payload.trim()) {
    return undefined;
  }
  return wrapped.payload.trim();
}

function parseJsonIfNeeded(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
