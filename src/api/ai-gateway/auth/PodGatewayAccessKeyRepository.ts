import { alias, drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  aiGatewayRepository,
  gatewayAccessKeyResource,
  type GatewayAccessKeyRow,
} from '@undefineds.co/models';
import type { AuthContext } from '../../auth/AuthContext';
import {
  callerPodAccessError,
  createCallerAuthenticatedPodFetch,
  isInternalPodAccessAllowed,
} from './CallerPodAccess';
import {
  resolveGatewayAccessKeySecretResourceUrl,
  resolveGatewayAccessKeySparqlEndpoint,
} from '../service-access/AiConnectionsServiceAccess';
import {
  resolveOwnerPodBaseUrl,
  type PodBaseUrlResolver,
} from '../pod/PodBaseUrlResolver';
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
  updateByIri?<TRow>(resource: typeof gatewayAccessKeyResource, iri: string, patch: unknown): Promise<TRow | null>;
  deleteById?(resource: typeof gatewayAccessKeyResource, id: string): Promise<unknown>;
};

type GatewayAccessKeyResource = typeof gatewayAccessKeyResource;

export interface PodGatewayAccessKeyRepositoryOptions {
  locatorCodec: GatewayKeyLocatorCodec;
  internalPodAccess?: InternalPodAccessTokenProvider;
  podBaseUrlResolver?: PodBaseUrlResolver;
  dbFactory?: (input: {
    owner: string;
    auth?: AuthContext;
    fetch: typeof fetch;
    podUrl: string;
    resource?: GatewayAccessKeyResource;
    listResource?: GatewayAccessKeyResource;
  }) => Promise<GatewayAccessKeyDb>;
}

export interface InternalPodAccessTokenProvider {
  getTrustedFetch(
    owner: string,
    auth?: AuthContext,
    context?: { reason?: string; podBaseUrl?: string },
  ): Promise<typeof fetch | undefined>;
}

interface StoredGatewayAccessKeySecrets {
  version: 1;
  keys: Record<string, StoredGatewayAccessKeySecret>;
}

interface StoredGatewayAccessKeySecret {
  plaintext: string;
  createdAt: string;
}

export class PodGatewayAccessKeyRepository implements GatewayAccessKeyRepository {
  private readonly dbFactory: NonNullable<PodGatewayAccessKeyRepositoryOptions['dbFactory']>;
  private readonly locatorCodec: GatewayKeyLocatorCodec;
  private readonly internalPodAccess?: InternalPodAccessTokenProvider;
  private readonly podBaseUrlResolver?: PodBaseUrlResolver;
  private readonly usesDefaultDbFactory: boolean;

  public constructor(options: PodGatewayAccessKeyRepositoryOptions) {
    this.locatorCodec = options.locatorCodec;
    this.internalPodAccess = options.internalPodAccess;
    this.podBaseUrlResolver = options.podBaseUrlResolver;
    this.usesDefaultDbFactory = options.dbFactory === undefined;
    this.dbFactory = options.dbFactory ?? createDefaultGatewayAccessKeyDb;
  }

  public createKeyId(owner: string, deployment: GatewayDeployment): string {
    return createGatewayKeyLocator(owner, deployment, this.locatorCodec);
  }

  public async create(
    record: GatewayAccessKeyRecord,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord> {
    const { db, resource, fetch, podUrl } = await this.dbForOwner(record.owner, context);
    const valid = aiGatewayRepository.validateAccessKey(toGatewayAccessKeyInsert(record));
    await db.insert(resource).values(valid).execute();
    if (record.plaintext) {
      await this.writeSecret(record.owner, podUrl, record.id, record.plaintext, fetch);
    }
    const created = recordFromRow(valid as GatewayAccessKeyRow);
    return record.plaintext ? { ...created, plaintext: record.plaintext } : created;
  }

  public async findById(
    id: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord | undefined> {
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return undefined;
    }
    const { db, resource } = await this.dbForOwner(locator.owner, context);
    const row = await db.findById<GatewayAccessKeyRow>(resource, gatewayAccessKeyStorageId(id));
    return row ? recordFromRow(row) : undefined;
  }

  public async listByOwner(
    owner: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord[]> {
    const { db, listResource } = await this.dbForOwner(owner, context);
    const rows = await db
      .select()
      .from(listResource)
      .where(eq(listResource.owner, owner))
      .execute();
    return rows
      .map(recordFromRow)
      .filter((record) => !record.revokedAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public async setEnabled(
    id: string,
    enabled: boolean,
    changedAt: Date,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord | undefined> {
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return undefined;
    }
    const { db, resource } = await this.dbForOwner(locator.owner, context);
    const row = await db.updateById<GatewayAccessKeyRow>(
      resource,
      gatewayAccessKeyStorageId(id),
      { disabledAt: enabled ? null : changedAt },
    );
    return row ? recordFromRow(row) : undefined;
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
    const { db, resource } = await this.dbForOwner(locator.owner, context);
    const row = await db.updateById<GatewayAccessKeyRow>(
      resource,
      gatewayAccessKeyStorageId(id),
      { revokedAt },
    );
    return row ? recordFromRow(row) : undefined;
  }

  public async delete(
    id: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<boolean> {
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return false;
    }
    const { db, resource, fetch, podUrl } = await this.dbForOwner(locator.owner, context);
    const storageId = gatewayAccessKeyStorageId(id);
    await db.updateById(resource, storageId, { revokedAt: new Date() });
    await this.deleteSecret(locator.owner, podUrl, id, fetch);
    return true;
  }

  public async revealPlaintext(
    id: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<string | undefined> {
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return undefined;
    }
    const { fetch, podUrl } = await this.dbForOwner(locator.owner, context);
    return (await this.readSecrets(locator.owner, podUrl, fetch)).keys[id]?.plaintext;
  }

  public async touchLastUsed(
    id: string,
    lastUsedAt: Date,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<void> {
    const locator = this.locatorCodec.decode(id);
    if (!locator) {
      return;
    }
    const { db, resource } = await this.dbForOwner(locator.owner, {
      ...context,
      internalPodAccess: context?.internalPodAccess ? { reason: 'gateway-key-verifier' } : undefined,
    });
    await db.updateById(resource, gatewayAccessKeyStorageId(id), { lastUsedAt });
  }

  private async dbForOwner(
    owner: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<{
    db: GatewayAccessKeyDb;
    resource: GatewayAccessKeyResource;
    listResource: GatewayAccessKeyResource;
    fetch: typeof fetch;
    podUrl: string;
  }> {
    const podUrl = await resolveOwnerPodBaseUrl(owner, this.podBaseUrlResolver);
    const trustedFetch = await this.resolveTrustedFetch(owner, podUrl, context);
    const resource = gatewayAccessKeyResource;
    const listResource = this.usesDefaultDbFactory
      ? createGatewayAccessKeyResource(owner, podUrl)
      : gatewayAccessKeyResource;
    const db = await this.dbFactory({
      owner,
      auth: context?.auth,
      fetch: trustedFetch,
      podUrl,
      resource,
      listResource,
    });
    await db.init?.(resource, listResource);
    return { db, resource, listResource, fetch: trustedFetch, podUrl };
  }

  private async resolveTrustedFetch(
    owner: string,
    podUrl: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<typeof fetch> {
    const auth = context?.auth;
    if (auth?.type === 'solid' && auth.webId !== owner) {
      throw new Error(callerPodAccessError(owner, auth));
    }
    // DPoP proves this management request, not a request to a different Pod URL.
    // The hosted adapter verifies the same owner and signs a resource-scoped
    // loopback intent; it never forwards the browser's token or proof.
    if (auth?.type === 'solid' && (auth.tokenType === 'DPoP' || auth.dpopProof)) {
      const hostedFetch = await this.internalPodAccess?.getTrustedFetch(owner, auth, { podBaseUrl: podUrl });
      if (hostedFetch) {
        return this.wrapPodFetch(hostedFetch);
      }
    }
    const callerFetch = createCallerAuthenticatedPodFetch(owner, auth);
    if (callerFetch) {
      return this.wrapPodFetch(callerFetch);
    }
    if (!isInternalPodAccessAllowed(auth, {
      explicitInternalAccess: Boolean(context?.internalPodAccess?.reason),
    })) {
      throw new Error(callerPodAccessError(owner, auth));
    }
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(
      owner,
      auth,
      context?.internalPodAccess?.reason === 'gateway-key-verifier'
        ? { reason: 'gateway-key-verifier', podBaseUrl: podUrl }
        : { podBaseUrl: podUrl },
    );
    if (!trustedFetch) {
      throw new Error('AI Connection service identity is not configured');
    }
    return this.wrapPodFetch(trustedFetch);
  }

  private wrapPodFetch(trustedFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      // Comunica can inject a malformed content-length value; let the runtime recompute it.
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      }
      headers.delete('content-length');
      const response = await trustedFetch(input, { ...init, headers });
      if (response.status === 403) {
        throw new Error('service_access_missing');
      }
      return response;
    };
  }

  private async readSecrets(
    owner: string,
    podUrl: string,
    trustedFetch: typeof fetch,
  ): Promise<StoredGatewayAccessKeySecrets> {
    const response = await trustedFetch(resolveGatewayAccessKeySecretResourceUrl(owner, podUrl), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return emptySecrets();
    }
    const text = (await response.text()).trim();
    if (!text || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return emptySecrets();
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoredGatewayAccessKeySecrets>;
      if (parsed.version !== 1 || !parsed.keys || typeof parsed.keys !== 'object') {
        return emptySecrets();
      }
      return {
        version: 1,
        keys: Object.fromEntries(Object.entries(parsed.keys).filter(([, value]) =>
          value && typeof value === 'object' && typeof value.plaintext === 'string')),
      };
    } catch {
      return emptySecrets();
    }
  }

  private async writeSecret(
    owner: string,
    podUrl: string,
    keyId: string,
    plaintext: string,
    trustedFetch: typeof fetch,
  ): Promise<void> {
    const secrets = await this.readSecrets(owner, podUrl, trustedFetch);
    secrets.keys[keyId] = {
      plaintext,
      createdAt: new Date().toISOString(),
    };
    await this.writeSecrets(owner, podUrl, secrets, trustedFetch);
  }

  private async deleteSecret(owner: string, podUrl: string, keyId: string, trustedFetch: typeof fetch): Promise<void> {
    const secrets = await this.readSecrets(owner, podUrl, trustedFetch);
    delete secrets.keys[keyId];
    await this.writeSecrets(owner, podUrl, secrets, trustedFetch);
  }

  private async writeSecrets(
    owner: string,
    podUrl: string,
    secrets: StoredGatewayAccessKeySecrets,
    trustedFetch: typeof fetch,
  ): Promise<void> {
    const response = await trustedFetch(resolveGatewayAccessKeySecretResourceUrl(owner, podUrl), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secrets, null, 2),
    });
    if (!response.ok) {
      throw new Error('gateway_key_secret_write_failed');
    }
  }
}

function createDefaultGatewayAccessKeyDb(input: {
  owner: string;
  auth?: AuthContext;
  fetch: typeof fetch;
  podUrl: string;
  resource?: GatewayAccessKeyResource;
  listResource?: GatewayAccessKeyResource;
}): Promise<GatewayAccessKeyDb> {
  const resource = input.resource ?? gatewayAccessKeyResource;
  const listResource = input.listResource ?? resource;
  return Promise.resolve(drizzle(
    {
      fetch: input.fetch,
      info: { webId: input.owner, podUrl: input.podUrl, isLoggedIn: true },
    } as any,
    {
      podUrl: input.podUrl,
      resourcePreparation: 'off',
      schema: {
        gatewayAccessKey: resource,
        gatewayAccessKeyList: listResource,
      },
    },
  ) as unknown as GatewayAccessKeyDb);
}

function createGatewayAccessKeyResource(owner: string, podUrl: string): GatewayAccessKeyResource {
  const resource = alias(gatewayAccessKeyResource, 'gatewayAccessKeyList');
  resource.setSparqlEndpoint(resolveGatewayAccessKeySparqlEndpoint(owner, podUrl));
  return resource;
}

function toGatewayAccessKeyInsert(record: GatewayAccessKeyRecord): Record<string, unknown> {
  return {
    id: gatewayAccessKeyStorageId(record.id),
    owner: record.owner,
    secretHash: record.secretHash,
    deployment: record.deployment,
    scopes: record.scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    disabledAt: record.disabledAt,
    revokedAt: record.revokedAt,
    name: record.name,
  };
}

function recordFromRow(row: GatewayAccessKeyRow): GatewayAccessKeyRecord {
  return {
    id: gatewayAccessKeyLocatorFromStorageId(String(row.id)),
    owner: String(row.owner),
    secretHash: String(row.secretHash),
    deployment: row.deployment === 'local' ? 'local' : 'cloud',
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    createdAt: toDate(row.createdAt) ?? new Date(0),
    expiresAt: toDate(row.expiresAt),
    lastUsedAt: toDate(row.lastUsedAt),
    disabledAt: toDate((row as { disabledAt?: unknown }).disabledAt),
    revokedAt: toDate(row.revokedAt),
    name: typeof (row as { name?: unknown }).name === 'string' ? String((row as { name?: unknown }).name) : undefined,
  };
}

function gatewayAccessKeyStorageId(locator: string): string {
  return gatewayAccessKeyResource.buildId({ id: locator });
}

function gatewayAccessKeyLocatorFromStorageId(id: string): string {
  const decoded = decodeStorageId(id);
  const fragment = decoded.lastIndexOf('#');
  return fragment >= 0 ? decoded.slice(fragment + 1) : decoded;
}

function decodeStorageId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function emptySecrets(): StoredGatewayAccessKeySecrets {
  return { version: 1, keys: {} };
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
