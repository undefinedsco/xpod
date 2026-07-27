import { drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  aiGatewayRepository,
  gatewayAccessKeyResource,
  type GatewayAccessKeyRow,
} from '@undefineds.co/models';
import type { AuthContext } from '../../auth/AuthContext';
import { createGatewayKeyLocator, type GatewayKeyLocatorCodec } from './GatewayKeyLocatorCodec';
import {
  type GatewayAccessKeyRecord,
  type GatewayAccessKeyRepository,
  type GatewayAccessKeyRepositoryContext,
} from './GatewayApiKeyAuthenticator';
import type { GatewayDeployment } from './GatewayApiKey';

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
  findById<TRow>(resource: typeof gatewayAccessKeyResource, id: string): Promise<TRow | null>;
  findByIri<TRow>(resource: typeof gatewayAccessKeyResource, iri: string): Promise<TRow | null>;
  updateById<TRow>(resource: typeof gatewayAccessKeyResource, id: string, patch: unknown): Promise<TRow | null>;
};

export interface PodGatewayAccessKeyRepositoryOptions {
  locatorCodec: GatewayKeyLocatorCodec;
  internalPodAccess?: InternalPodAccessTokenProvider;
  dbFactory?: (input: {
    owner: string;
    auth?: AuthContext;
    fetch: typeof fetch;
  }) => Promise<GatewayAccessKeyDb>;
}

export interface InternalPodAccessTokenProvider {
  getTrustedFetch(owner: string): Promise<typeof fetch | undefined>;
}

export class PodGatewayAccessKeyRepository implements GatewayAccessKeyRepository {
  private readonly dbFactory: NonNullable<PodGatewayAccessKeyRepositoryOptions['dbFactory']>;
  private readonly locatorCodec: GatewayKeyLocatorCodec;
  private readonly internalPodAccess?: InternalPodAccessTokenProvider;

  public constructor(options: PodGatewayAccessKeyRepositoryOptions) {
    this.locatorCodec = options.locatorCodec;
    this.internalPodAccess = options.internalPodAccess;
    this.dbFactory = options.dbFactory ?? createDefaultGatewayAccessKeyDb;
  }

  public createKeyId(owner: string, deployment: GatewayDeployment): string {
    return createGatewayKeyLocator(owner, deployment, this.locatorCodec);
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
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return undefined;
    }
    const db = await this.dbForOwner(locator.owner);
    const row = await aiGatewayRepository.findAccessKeyById(db as never, id);
    return row ? recordFromRow(row) : undefined;
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
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return undefined;
    }
    const db = await this.dbForOwner(locator.owner, context);
    const row = await aiGatewayRepository.revokeAccessKey(db as never, {
      id,
      revokedAt,
    });
    return row ? recordFromRow(row) : undefined;
  }

  public async touchLastUsed(id: string, lastUsedAt: Date): Promise<void> {
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return;
    }
    const db = await this.dbForOwner(locator.owner);
    await db.updateById(gatewayAccessKeyResource, id, { lastUsedAt });
  }

  private async dbForOwner(
    owner: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyDb> {
    const trustedFetch = await this.resolveTrustedFetch(owner);
    const db = await this.dbFactory({ owner, auth: context?.auth, fetch: trustedFetch });
    await db.init?.(gatewayAccessKeyResource);
    return db;
  }

  private async resolveTrustedFetch(owner: string): Promise<typeof fetch> {
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(owner);
    if (!trustedFetch) {
      throw new Error('AI Connection service identity is not configured');
    }
    return async (input, init) => {
      const response = await trustedFetch(input, init);
      if (response.status === 403) {
        throw new Error('service_access_missing');
      }
      return response;
    };
  }
}

function createDefaultGatewayAccessKeyDb(input: {
  owner: string;
  auth?: AuthContext;
  fetch: typeof fetch;
}): Promise<GatewayAccessKeyDb> {
  return Promise.resolve(drizzle(
    {
      fetch: input.fetch,
      info: { webId: input.owner, isLoggedIn: true },
    } as any,
    {
      schema: {
        gatewayAccessKey: gatewayAccessKeyResource,
      },
    },
  ) as unknown as GatewayAccessKeyDb);
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
    name: record.name,
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
    name: typeof (row as any).name === 'string' ? (row as any).name : undefined,
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
