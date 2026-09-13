import { alias, drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  aiGatewayRepository,
  aiProviderResource,
  credentialResource,
  gatewayAccessKeyResource,
  type CredentialRow,
  type GatewayAccessKeyRow,
} from '@undefineds.co/models';
import type { AuthContext } from '../../auth/AuthContext';
import {
  callerPodAccessError,
  createCallerAuthenticatedPodFetch,
  isInternalPodAccessAllowed,
} from './CallerPodAccess';
import {
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

/** Schema resources this repository reads and writes in the owner's Pod. */
type PodSchemaResource = typeof gatewayAccessKeyResource | typeof credentialResource;

type GatewayAccessKeyDb = {
  init?: (...resources: unknown[]) => Promise<void>;
  insert(resource: PodSchemaResource): {
    values(value: unknown): { execute(): Promise<unknown[]> };
  };
  select(): {
    from(resource: PodSchemaResource): {
      where(condition: unknown): { execute(): Promise<GatewayAccessKeyRow[]> };
    };
  };
  findById<TRow>(resource: PodSchemaResource, id: string): Promise<TRow | null>;
  findByIri<TRow>(resource: PodSchemaResource, iri: string): Promise<TRow | null>;
  updateById<TRow>(resource: PodSchemaResource, id: string, patch: unknown): Promise<TRow | null>;
  updateByIri?<TRow>(resource: PodSchemaResource, iri: string, patch: unknown): Promise<TRow | null>;
  deleteById?(resource: PodSchemaResource, id: string): Promise<unknown>;
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
    credentialListResource?: typeof credentialResource;
  }) => Promise<GatewayAccessKeyDb>;
}

export interface InternalPodAccessTokenProvider {
  getTrustedFetch(
    owner: string,
    auth?: AuthContext,
    context?: { reason?: string; podBaseUrl?: string },
  ): Promise<typeof fetch | undefined>;
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
    if (record.kind === 'client-credentials') {
      if (!record.clientCredentialId) {
        throw new Error('client_credentials_registration_incomplete');
      }
      const locator = this.locatorCodec.decode(record.id);
      if (locator?.owner !== record.owner || locator.deployment !== record.deployment) {
        throw new Error('client_credentials_registration_owner_mismatch');
      }
      // The wrapper itself is never stored: CSS keeps the secret and the client
      // configuration holds the only copy the caller needs. This row records the
      // purpose and where the credential is in effect.
      await db.insert(credentialResource).values(toClientCredentialInsert(record)).execute();
      return { ...record, scopes: [], secretHash: '' };
    }
    const valid = aiGatewayRepository.validateAccessKey(toGatewayAccessKeyInsert(record));
    await db.insert(resource).values(valid).execute();
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
    // Authentication uses only the legacy RDF verifier rows; issued client
    // credentials are owner-authorized management records.
    if (!context?.internalPodAccess) {
      const credential = await db.findById<CredentialRow>(credentialResource, clientCredentialStorageId(id));
      if (credential) return clientCredentialRecord(id, locator, credential);
    }
    const row = await db.findById<GatewayAccessKeyRow>(resource, gatewayAccessKeyStorageId(id));
    return row ? recordFromRow(row) : undefined;
  }

  public async listByOwner(
    owner: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<GatewayAccessKeyRecord[]> {
    const { db, listResource, credentialListResource } = await this.dbForOwner(owner, context);
    const rows = await db
      .select()
      .from(listResource)
      .where(eq(listResource.owner, owner))
      .execute();
    const credentialRows = await db
      .select()
      .from(credentialListResource)
      .where(eq(credentialListResource.provider, clientCredentialProviderId()))
      .execute() as unknown as CredentialRow[];
    const credentials = credentialRows
      .map((row) => {
        const id = clientCredentialLocator(String(row.id));
        return id ? clientCredentialRecord(id, this.locatorCodec.decode(id), row as CredentialRow) : undefined;
      })
      .filter((record): record is GatewayAccessKeyRecord => Boolean(record))
      .filter((record) => this.locatorCodec.decode(record.id)?.owner === owner);
    return [...rows.map(recordFromRow), ...credentials]
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
    if (await db.findById<CredentialRow>(credentialResource, clientCredentialStorageId(id))) {
      // Suspension is an application-layer fact (is the client configuration in
      // effect?); the issued credential itself can only be destroyed.
      throw new Error('client_credentials_suspension_unsupported');
    }
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
    if (await db.findById<CredentialRow>(credentialResource, clientCredentialStorageId(id))) {
      throw new Error('client_credentials_revocation_requires_account');
    }
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
    const { db, resource } = await this.dbForOwner(locator.owner, context);
    const credentialStorageId = clientCredentialStorageId(id);
    if (await db.findById<CredentialRow>(credentialResource, credentialStorageId)) {
      // The Account host destroys the CSS credential; this removes the record of
      // where it was applied. Nothing secret is deleted here because none was kept.
      await db.deleteById?.(credentialResource, credentialStorageId);
      return true;
    }
    await db.updateById(resource, gatewayAccessKeyStorageId(id), { revokedAt: new Date() });
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
    // Xpod never keeps a copy of an issued credential: it exists in the client
    // configuration that received it and nowhere else, so there is nothing to
    // reveal after the call that created it.
    return undefined;
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
    const credentialStorageId = clientCredentialStorageId(id);
    if (await db.findById<CredentialRow>(credentialResource, credentialStorageId)) {
      await db.updateById(credentialResource, credentialStorageId, { lastUsedAt });
      return;
    }
    await db.updateById(resource, gatewayAccessKeyStorageId(id), { lastUsedAt });
  }

  private async dbForOwner(
    owner: string,
    context?: GatewayAccessKeyRepositoryContext,
  ): Promise<{
    db: GatewayAccessKeyDb;
    resource: GatewayAccessKeyResource;
    listResource: GatewayAccessKeyResource;
    credentialListResource: typeof credentialResource;
    fetch: typeof fetch;
    podUrl: string;
  }> {
    const podUrl = await resolveOwnerPodBaseUrl(owner, this.podBaseUrlResolver);
    const trustedFetch = await this.resolveTrustedFetch(owner, podUrl, context);
    const resource = gatewayAccessKeyResource;
    const listResource = this.usesDefaultDbFactory
      ? createGatewayAccessKeyResource(owner, podUrl)
      : gatewayAccessKeyResource;
    const credentialListResource = this.usesDefaultDbFactory
      ? createClientCredentialListResource(podUrl)
      : credentialResource;
    const db = await this.dbFactory({
      owner,
      auth: context?.auth,
      fetch: trustedFetch,
      podUrl,
      resource,
      listResource,
      credentialListResource,
    });
    await db.init?.(resource, listResource, credentialResource, credentialListResource);
    return { db, resource, listResource, credentialListResource, fetch: trustedFetch, podUrl };
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

}

/** Derived provider id of the built-in Xpod gateway provider; no provider row is persisted. */
export function clientCredentialProviderId(): string {
  return aiProviderResource.buildId({ id: 'xpod-gateway.ttl#this' });
}

function clientCredentialStorageId(locator: string): string {
  return credentialResource.buildId({ id: locator });
}

function clientCredentialLocator(storageId: string): string | undefined {
  const decoded = decodeStorageId(storageId);
  const fragment = decoded.lastIndexOf('#');
  const locator = fragment >= 0 ? decoded.slice(fragment + 1) : decoded;
  return locator || undefined;
}

function clientCredentialRecord(
  id: string,
  locator: { owner: string; deployment: GatewayDeployment } | undefined,
  row: CredentialRow,
): GatewayAccessKeyRecord | undefined {
  const createdAt = toDate(row.createdAt);
  const clientCredentialId = typeof row.clientCredentialId === 'string' ? row.clientCredentialId : undefined;
  if (!createdAt || !clientCredentialId || !locator) return undefined;
  return {
    id,
    owner: locator.owner,
    kind: 'client-credentials',
    clientCredentialId,
    name: typeof row.label === 'string' ? row.label : undefined,
    status: typeof row.status === 'string' ? row.status : undefined,
    createdAt,
    deployment: locator.deployment,
    scopes: [],
    secretHash: '',
    lastUsedAt: toDate(row.lastUsedAt),
    appliedTo: typeof row.appliedTo === 'string' ? row.appliedTo : undefined,
    appliedOn: typeof row.appliedOn === 'string' ? row.appliedOn : undefined,
    appliedAt: toDate(row.appliedAt),
  };
}

function toClientCredentialInsert(record: GatewayAccessKeyRecord): Record<string, unknown> {
  return {
    id: clientCredentialStorageId(record.id),
    provider: clientCredentialProviderId(),
    authMode: 'apiKey',
    service: 'xpod-gateway',
    status: record.status ?? 'active',
    label: record.name,
    clientCredentialId: record.clientCredentialId,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    appliedTo: record.appliedTo,
    appliedOn: record.appliedOn,
    appliedAt: record.appliedAt,
  };
}

function createClientCredentialListResource(podUrl: string): typeof credentialResource {
  const resource = alias(credentialResource, 'clientCredentialList');
  resource.setSparqlEndpoint(`${podUrl.replace(/\/$/u, '')}/settings/-/sparql`);
  return resource;
}

function createDefaultGatewayAccessKeyDb(input: {
  owner: string;
  auth?: AuthContext;
  fetch: typeof fetch;
  podUrl: string;
  resource?: GatewayAccessKeyResource;
  listResource?: GatewayAccessKeyResource;
  credentialListResource?: typeof credentialResource;
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
        credential: credentialResource,
        credentialList: input.credentialListResource ?? credentialResource,
        // The credential `provider` column is a link into the provider document;
        // resolving the derived gateway provider id needs that table in scope.
        aiProvider: aiProviderResource,
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
