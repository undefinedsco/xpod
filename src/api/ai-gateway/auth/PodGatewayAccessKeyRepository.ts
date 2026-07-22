import { drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  aiGatewayRepository,
  gatewayAccessKeyResource,
  type GatewayAccessKeyRow,
} from '@undefineds.co/models';
import type { AuthContext } from '../../auth/AuthContext';
import { isSolidAuth } from '../../auth/AuthContext';
import {
  decodeGatewayKeyLocatorOwner,
} from './GatewayApiKey';
import {
  type GatewayAccessKeyRecord,
  type GatewayAccessKeyRepository,
  type GatewayAccessKeyRepositoryContext,
} from './GatewayApiKeyAuthenticator';

type GatewayAccessKeyDb = {
  init?: (...resources: unknown[]) => Promise<void>;
  insert(resource: typeof gatewayAccessKeyResource): {
    values(value: unknown): { execute(): Promise<unknown[]> };
  };
  select(): {
    from(resource: typeof gatewayAccessKeyResource): {
      where(condition: unknown): { execute(): Promise<GatewayAccessKeyRow[]> };
    };
  };
  updateById<TRow>(resource: typeof gatewayAccessKeyResource, id: string, patch: unknown): Promise<TRow | null>;
};

export interface PodGatewayAccessKeyRepositoryOptions {
  dbFactory?: (input: {
    owner: string;
    auth?: AuthContext;
  }) => Promise<GatewayAccessKeyDb>;
}

export class PodGatewayAccessKeyRepository implements GatewayAccessKeyRepository {
  private readonly dbFactory: NonNullable<PodGatewayAccessKeyRepositoryOptions['dbFactory']>;

  public constructor(options: PodGatewayAccessKeyRepositoryOptions = {}) {
    this.dbFactory = options.dbFactory ?? createDefaultGatewayAccessKeyDb;
  }

  public async create(
    record: GatewayAccessKeyRecord,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord> {
    const db = await this.dbForOwner(record.owner, context);
    const valid = aiGatewayRepository.validateAccessKey(toGatewayAccessKeyInsert(record));
    await db.insert(gatewayAccessKeyResource).values(valid).execute();
    return recordFromRow(valid as GatewayAccessKeyRow);
  }

  public async findById(id: string): Promise<GatewayAccessKeyRecord | undefined> {
    const owner = decodeGatewayKeyLocatorOwner(id);
    if (!owner) {
      return undefined;
    }
    try {
      const db = await this.dbForOwner(owner);
      const row = await aiGatewayRepository.findAccessKeyById(db as never, id);
      return row ? recordFromRow(row) : undefined;
    } catch {
      return undefined;
    }
  }

  public async listByOwner(
    owner: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord[]> {
    const db = await this.dbForOwner(owner, context);
    const rows = await db
      .select()
      .from(gatewayAccessKeyResource)
      .where(eq(gatewayAccessKeyResource.owner, owner))
      .execute();
    return rows.map(recordFromRow).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public async revoke(
    id: string,
    revokedAt: Date,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord | undefined> {
    const owner = decodeGatewayKeyLocatorOwner(id);
    if (!owner) {
      return undefined;
    }
    const db = await this.dbForOwner(owner, context);
    const row = await aiGatewayRepository.revokeAccessKey(db as never, {
      id,
      revokedAt,
    });
    return row ? recordFromRow(row) : undefined;
  }

  public async touchLastUsed(id: string, lastUsedAt: Date): Promise<void> {
    const owner = decodeGatewayKeyLocatorOwner(id);
    if (!owner) {
      return;
    }
    const db = await this.dbForOwner(owner);
    await db.updateById(gatewayAccessKeyResource, id, { lastUsedAt });
  }

  public async verifySecretHashForTimingOnly(_secret: string): Promise<void> {
    // Pod-backed misses do not have a safe per-owner salt/cost to use. The
    // authenticator still returns the same external failure envelope.
  }

  private async dbForOwner(
    owner: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyDb> {
    const db = await this.dbFactory({ owner, auth: context?.auth });
    await db.init?.(gatewayAccessKeyResource);
    return db;
  }
}

function createDefaultGatewayAccessKeyDb(input: {
  owner: string;
  auth?: AuthContext;
}): Promise<GatewayAccessKeyDb> {
  const authFetch = createAuthFetch(input.auth);
  return Promise.resolve(drizzle(
    {
      fetch: authFetch,
      info: { webId: input.owner, isLoggedIn: true },
    } as any,
    {
      schema: {
        gatewayAccessKey: gatewayAccessKeyResource,
      },
    },
  ) as unknown as GatewayAccessKeyDb);
}

function createAuthFetch(auth: AuthContext | undefined): typeof fetch {
  if (auth && isSolidAuth(auth) && auth.accessToken) {
    const scheme = auth.tokenType ?? 'Bearer';
    return async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `${scheme} ${auth.accessToken}`);
      }
      return fetch(input, { ...init, headers });
    };
  }
  return fetch;
}

function toGatewayAccessKeyInsert(record: GatewayAccessKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    owner: record.owner,
    secretHash: record.secretHash,
    deployment: record.deployment,
    scopes: record.scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

function recordFromRow(row: GatewayAccessKeyRow): GatewayAccessKeyRecord {
  return {
    id: String(row.id),
    owner: String(row.owner),
    secretHash: String(row.secretHash),
    deployment: row.deployment === 'local' ? 'local' : 'cloud',
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    createdAt: toDate(row.createdAt) ?? new Date(0),
    expiresAt: toDate(row.expiresAt),
    lastUsedAt: toDate(row.lastUsedAt),
    revokedAt: toDate(row.revokedAt),
  };
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}
