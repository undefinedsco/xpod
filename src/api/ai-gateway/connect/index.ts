import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { alias, and, drizzle, eq, resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import {
  aiModelSchema,
  aiModelResource,
  aiProviderResource,
  aiRuntimeRepository,
  credentialResource,
} from '@undefineds.co/models';
import type { EncryptedCredentialSecret } from '../credentials/KeyWrapper';
import type { CredentialVault, GatewayPrincipal, ProviderSecret } from '../credentials/CredentialVault';
import { GatewayProtocolError } from '../errors';
import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import {
  DEFAULT_PROVIDER_DESCRIPTORS,
  DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS,
  type ProviderRegistry,
} from '../providers/ProviderRegistry';
import type { AuthContext } from '../../auth/AuthContext';
import {
  callerPodAccessError,
  createCallerAuthenticatedPodFetch,
  isInternalPodAccessAllowed,
} from '../auth/CallerPodAccess';
import type { InternalPodAccessTokenProvider } from '../pod/HostedPodDataAccess';
import { resolveOwnerPodBaseUrl, type PodBaseUrlResolver } from '../pod/PodBaseUrlResolver';
import { OAuthConnectCredentialStore } from './OAuthConnectAdapter';
import type { OAuthIntegration } from './OAuthIntegrationRegistry';
import { requireKimiOAuthClientId } from './OAuthIntegrationRegistry';
import type { LocalSessionImportAdapter } from './OpenAiSubscriptionSessionImportAdapter';
import { normalizeProviderProxyUrl, redactProviderProxyUrl } from '../../service/provider-http-transport';
import { Parser as N3Parser, type Quad as N3Quad } from 'n3';
export { OAuthConnectCredentialStore } from './OAuthConnectAdapter';
export { OAuthIntegrationRegistry, requireKimiOAuthClientId, type OAuthIntegration } from './OAuthIntegrationRegistry';
export {
  OpenAiSubscriptionSessionImportAdapter,
  type LocalSessionImportAdapter,
  type LocalSessionImportResult,
} from './OpenAiSubscriptionSessionImportAdapter';

const CREDENTIAL_COLLECTION_QUERY_UNSUPPORTED = 'credential_collection_query_unsupported';

export type ConnectMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported';
export type ConnectAttemptStatus =
  | 'pending'
  | 'authorization_pending'
  | 'slow_down'
  | 'completed'
  | 'expired'
  | 'unsupported';

export interface ConnectBeginInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  requestedMode: ConnectMode;
  expectedCredentialVersion?: number;
  auth?: AuthContext;
}

export interface ConnectBeginResult {
  mode: ConnectMode;
  status: ConnectAttemptStatus;
  provider: string;
  deployment: GatewayDeployment;
  attemptId?: string;
  state?: string;
  signature?: string;
  expiresAt?: string;
  authorizationUrl?: string;
  pkceChallenge?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  intervalSeconds?: number;
  apiKeyManagementSupported?: boolean;
  credentialId?: string;
  oauthCredential?: OneTimeOAuthCredential;
  message?: string;
}

export interface OneTimeOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  scope?: string;
  idToken?: string;
  accountSubject?: string;
  expectedVersion?: number;
}

export interface CompleteApiKeyInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  attemptId: string;
  state: string;
  signature: string;
  apiKey: string;
  accountLabel?: string;
  baseUrl?: string;
  auth?: AuthContext;
}

export interface PollDeviceInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  attemptId: string;
  state: string;
  signature: string;
  auth?: AuthContext;
}

export interface RefreshInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  credentialId?: string;
  auth?: AuthContext;
}

export interface CallerOwnedOAuthRefreshInput extends RefreshInput {
  credentialId: string;
  refreshToken: string;
  expectedVersion: number;
}

export interface DisconnectInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  credentialId?: string;
  auth?: AuthContext;
}

export interface ConnectCredentialRecord {
  id: string;
  credentialIri: string;
  webId: string;
  provider: string;
  deployment: GatewayDeployment;
  authMode: 'apiKey' | 'deviceCodeOAuth' | 'local';
  encryptedSecret: EncryptedCredentialSecret;
  status: 'active' | 'revoked';
  accountLabel?: string;
  expiresAt?: Date;
  scopes?: string[];
  expectedVersion?: number;
  version?: number;
  reauthRequired?: boolean;
  offeringId?: string;
  proxyUrl?: string;
  priority?: number;
  enabled?: boolean;
  health?: 'healthy' | 'reauthRequired' | 'disabled' | 'error' | 'invalid' | 'unknown';
  selectedModels?: AiGatewayModelSummary[];
  metadata?: Record<string, unknown>;
}

export type CreateConnectCredentialRecord = Omit<ConnectCredentialRecord, 'id'> & { id?: string };

export interface ProviderCredentialQuery {
  webId: string;
  provider: string;
  deployment: GatewayDeployment;
  auth?: AuthContext;
}

export interface PodCredentialRepository {
  listProviderCredentials(input: ProviderCredentialQuery): Promise<ConnectCredentialRecord[]>;
  getCredentialById(input: ProviderCredentialQuery & {
    credentialId: string;
    keyVersion?: number;
  }): Promise<ConnectCredentialRecord | undefined>;
  createCredential(
    record: CreateConnectCredentialRecord,
    context?: { auth?: AuthContext },
  ): Promise<ConnectCredentialRecord>;
  updateCredential(input: ProviderCredentialQuery & {
    credentialId: string;
    keyVersion?: number;
    expectedVersion?: number;
    patch: Partial<ConnectCredentialRecord>;
  }): Promise<ConnectCredentialRecord | undefined>;
  revokeCredential(input: ProviderCredentialQuery & {
    credentialId: string;
    keyVersion?: number;
    expectedVersion?: number;
  }): Promise<ConnectCredentialRecord | undefined>;
  getCredential?(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined>;
  getActiveCredential(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined>;
  upsertConnectedCredential(
    record: ConnectCredentialRecord,
    context?: { auth?: AuthContext },
  ): Promise<ConnectCredentialRecord>;
  rewrapCredential?(input: {
    webId: string;
    deployment: GatewayDeployment;
    credentialId: string;
    keyVersion?: number;
    expectedVersion?: number;
    encryptedSecret: EncryptedCredentialSecret;
    auth?: AuthContext;
  }): Promise<boolean>;
  markReauthRequired(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    reason: string;
    expectedVersion?: number;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined>;
  disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined>;
}

type ConnectedCredentialDb = {
  init?: (...resources: unknown[]) => Promise<void>;
  insert(resource: typeof credentialResource): {
    values(value: unknown): { execute(): Promise<unknown[]> };
  };
  select(): {
    from(resource: typeof credentialResource | typeof aiProviderResource | typeof aiModelResource): {
      execute?(): Promise<Record<string, unknown>[]>;
      where(condition: unknown): { execute(): Promise<Record<string, unknown>[]> };
    };
  };
  findById<TRow>(
    resource: typeof credentialResource | typeof aiProviderResource | typeof aiModelResource,
    id: string,
  ): Promise<TRow | null>;
  findByIri?<TRow>(
    resource: typeof credentialResource | typeof aiProviderResource | typeof aiModelResource,
    iri: string,
  ): Promise<TRow | null>;
  updateById<TRow>(resource: typeof credentialResource, id: string, patch: unknown): Promise<TRow | null>;
  update(resource: typeof credentialResource): {
    set(patch: unknown): {
      where(condition: unknown): {
        returning(): { execute(): Promise<Record<string, unknown>[]> };
      };
    };
  };
};

export interface PodConnectedCredentialRepositoryOptions {
  internalPodAccess?: InternalPodAccessTokenProvider;
  podBaseUrlResolver?: PodBaseUrlResolver;
  providerIds?: string[];
  dbFactory?: (input: {
    owner: string;
    auth?: AuthContext;
    fetch: typeof fetch;
    podUrl: string;
    credential?: typeof credentialResource;
    aiProvider?: typeof aiProviderResource;
    aiModel?: typeof aiModelResource;
  }) => Promise<ConnectedCredentialDb>;
}

export class PodConnectedCredentialRepository implements PodCredentialRepository {
  private readonly dbFactory: NonNullable<PodConnectedCredentialRepositoryOptions['dbFactory']>;
  private readonly internalPodAccess?: InternalPodAccessTokenProvider;
  private readonly podBaseUrlResolver?: PodBaseUrlResolver;
  private readonly providerIds: string[];
  private readonly credentialTemplate: typeof credentialResource;
  private readonly aiProviderTemplate: typeof aiProviderResource;

  public constructor(options: PodConnectedCredentialRepositoryOptions = {}) {
    this.internalPodAccess = options.internalPodAccess;
    this.podBaseUrlResolver = options.podBaseUrlResolver;
    this.providerIds = options.providerIds
      ?? DEFAULT_PROVIDER_DESCRIPTORS.map((provider) => provider.id);
    this.dbFactory = options.dbFactory ?? createDefaultConnectedCredentialDb;
    this.credentialTemplate = alias(credentialResource, 'credentialTemplate');
    this.aiProviderTemplate = alias(aiProviderResource, 'aiProviderTemplate');
  }

  public async getCredential(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined> {
    const rows = await this.listProviderCredentials(input);
    const requestedId = aiRuntimeRepository.credentialId(input);
    const byId = rows.find((row) => row.id === requestedId);
    if (byId) {
      return byId;
    }
    return rows[0];
  }

  public async getActiveCredential(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined> {
    const rows = await this.listProviderCredentials(input);
    return rows
      .filter((row) => row.status === 'active')
      .filter((row) => !row.reauthRequired)
      .at(0);
  }

  public async listCredentials(input: {
    webId: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<Array<{
    id: string;
    credentialIri: string;
    provider: string;
    authMode: 'apiKey' | 'deviceCodeOAuth' | 'local';
    enabled: boolean;
    accountLabel?: string;
    priority?: number;
    models?: string[];
    customModels?: CustomProviderModel[];
    defaultModel?: string;
    health?: 'healthy' | 'reauthRequired' | 'disabled' | 'error' | 'invalid' | 'unknown';
    quota?: { status: 'available' | 'unsupported' | 'exhausted' | 'error' };
    encryptedSecret: EncryptedCredentialSecret;
    version?: number;
    runtimeCredential?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>> {
    const { db, credential, aiProvider, aiModel, fetch: podFetch } = await this.dbForOwner(input.webId, input.auth);
    const rows = parseCredentialRows(await this.selectCredentialRows(db, credential));
    const enabledProviderIds = new Set(this.providerIds.map(normalizeProvider));
    const filtered = rows
      .filter((record) => record.status === 'active')
      .filter((record) => normalizeProvider(record.provider) !== '')
      .filter((record) => providerAllowedByConfiguredIds(record.provider, enabledProviderIds));
    const podBaseUrl = await resolveOwnerPodBaseUrl(input.webId, this.podBaseUrlResolver);
    const hydrated = await this.withSelectedModels(db, aiProvider, aiModel, filtered, input.webId, podBaseUrl, podFetch);
    return hydrated
      .sort(compareCredentialRecords)
      .map((record) => {
        const selectedModelIds = record.selectedModels?.map((model) => model.id);
        const offeringId = record.offeringId ?? (metadataFromRowValue(record.metadata)?.offeringId ?? undefined);
        return {
          id: record.id,
          credentialIri: record.credentialIri,
          provider: runtimeProviderId(record.provider),
          authMode: record.authMode,
          enabled: record.enabled === false ? false : !record.reauthRequired,
          accountLabel: record.accountLabel,
          models: selectedModelIds ?? modelsFromMetadata(record.metadata),
          customModels: customModelsFromMetadata(record.metadata),
          defaultModel: defaultModelFromMetadata(record.metadata),
          priority: record.priority ?? 100,
          health: record.health ?? (record.reauthRequired ? 'reauthRequired' : 'healthy'),
          quota: { status: 'available' },
          encryptedSecret: record.encryptedSecret,
          version: record.version,
          runtimeCredential: runtimeCredentialFromMetadata({ ...record.metadata, offeringId }),
          metadata: {
            ...record.metadata,
            models: selectedModelIds ?? modelsFromMetadata(record.metadata),
            offeringId,
            priority: record.priority ?? 100,
            enabled: record.enabled ?? !record.reauthRequired,
            health: record.health ?? (record.reauthRequired ? 'reauthRequired' : 'healthy'),
          },
        };
      });
  }

  public async listProviderCredentials(input: ProviderCredentialQuery): Promise<ConnectCredentialRecord[]> {
    return this.findCredentialRows({
      ...input,
      includeRevoked: true,
    });
  }

  public async getCredentialById(input: ProviderCredentialQuery & {
    credentialId: string;
    keyVersion?: number;
  }): Promise<ConnectCredentialRecord | undefined> {
    const rows = await this.findCredentialRows({
      ...input,
      includeRevoked: true,
    });
    const requestedVersion = input.keyVersion;
    return rows
      .filter((row) => row.id === input.credentialId)
      .find((row) => requestedVersion === undefined || row.version === requestedVersion);
  }

  public async createCredential(
    record: CreateConnectCredentialRecord,
    context?: { auth?: AuthContext },
  ): Promise<ConnectCredentialRecord> {
    const inferredCredentialKey = credentialKeyFromCanonicalIri(record.webId, record.credentialIri);
    if (!record.id && !inferredCredentialKey) {
      throw new Error('credential_iri_not_canonical');
    }
    const credentialId = credentialResource.buildId({
      id: record.id || inferredCredentialKey!,
    });
    const expectedCredentialIri = credentialResource.buildIri(record.webId, { id: credentialId });
    if (new URL(expectedCredentialIri).href !== new URL(record.credentialIri).href) {
      throw new Error('credential_id_iri_mismatch');
    }
    const { db, credential } = await this.dbForOwner(record.webId, context?.auth);
    const withDefaults = {
      ...record,
      id: credentialId,
      version: Math.max(record.version ?? 0, 1),
    };
    const row = credentialRowFromRecord(withDefaults);
    await db.insert(credential).values(row).execute();
    return recordFromCredentialRow(row);
  }

  public async updateCredential(input: ProviderCredentialQuery & {
    credentialId: string;
    keyVersion?: number;
    expectedVersion?: number;
    patch: Partial<ConnectCredentialRecord>;
  }): Promise<ConnectCredentialRecord | undefined> {
    const target = await this.getCredentialById(input);
    if (!target) {
      return undefined;
    }
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const currentVersion = target.version ?? 0;
    const expectedVersion = input.expectedVersion ?? input.keyVersion;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new Error('credential_version_conflict');
    }
    const merged: ConnectCredentialRecord = {
      ...target,
      ...input.patch,
      id: input.credentialId,
      webId: input.webId,
      provider: target.provider,
      deployment: input.deployment,
      version: currentVersion + 1,
    };
    if (merged.status === 'revoked' && input.patch.enabled === undefined) {
      merged.enabled = false;
    }
    if (merged.status === 'revoked' && input.patch.health === undefined) {
      merged.health = 'disabled';
    } else if (merged.reauthRequired === true && input.patch.health === undefined) {
      merged.health = 'reauthRequired';
    }
    const row = credentialRowFromRecord({
      ...merged,
      health: merged.health ?? (merged.reauthRequired ? 'reauthRequired' : 'healthy'),
      enabled: merged.enabled ?? merged.status === 'active',
      priority: merged.priority ?? 100,
    });
    const expectedVersionString = String(expectedVersion ?? currentVersion);
    const updated = await updateByCredentialIdAndVersion({
      db,
      credential,
      credentialId: input.credentialId,
      expectedVersion: expectedVersionString,
      patch: row,
    });
    return updated ? recordFromCredentialRow(updated) : undefined;
  }

  public async revokeCredential(input: ProviderCredentialQuery & {
    credentialId: string;
    keyVersion?: number;
    expectedVersion?: number;
  }): Promise<ConnectCredentialRecord | undefined> {
    return this.updateCredential({
      webId: input.webId,
      provider: input.provider,
      deployment: input.deployment,
      credentialId: input.credentialId,
      keyVersion: input.keyVersion,
      expectedVersion: input.expectedVersion,
      patch: { status: 'revoked', enabled: false, health: 'disabled' },
      auth: input.auth,
    });
  }

  private async findCredentialRows(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
    includeRevoked?: boolean;
  }): Promise<ConnectCredentialRecord[]> {
    const { db, credential, aiProvider, aiModel, fetch: podFetch } = await this.dbForOwner(input.webId, input.auth);
    const rows = await this.selectCredentialRows(db, credential);
    const providerIds = queryProviderIds(input.provider);
    const filtered = rows
      .flatMap(parseCredentialRow)
      .filter((record) => record.webId === input.webId)
      .filter((record) => providerMatchesQuery(record.provider, input.provider, providerIds))
      .filter((record) => input.includeRevoked || record.status === 'active');
    const podBaseUrl = await resolveOwnerPodBaseUrl(input.webId, this.podBaseUrlResolver);
    return (await this.withSelectedModels(db, aiProvider, aiModel, filtered, input.webId, podBaseUrl, podFetch))
      .sort(compareCredentialRecords);
  }

  private async dbForOwnerRows(owner: string, auth?: AuthContext): Promise<ConnectCredentialRecord[]> {
    const { db, credential } = await this.dbForOwner(owner, auth);
    const rows = await this.selectCredentialRows(db, credential);
    return parseCredentialRows(rows);
  }

  private async selectCredentialRows(
    db: ConnectedCredentialDb,
    credential: typeof credentialResource,
  ): Promise<Record<string, unknown>[]> {
    try {
      return await db
        .select()
        .from(credential)
        .where(eq(credential.service, 'ai'))
        .execute();
    } catch (error) {
      if (isCollectionQueryUnsupported(error)) {
        throw new Error(CREDENTIAL_COLLECTION_QUERY_UNSUPPORTED);
      }
      throw error;
    }
  }

  public async upsertConnectedCredential(
    record: ConnectCredentialRecord,
    context?: { auth?: AuthContext },
  ): Promise<ConnectCredentialRecord> {
    const { db, credential } = await this.dbForOwner(record.webId, context?.auth);
    const existing = await db.findById<Record<string, unknown>>(credential, record.id);
    const existingVersion = existing ? versionFromRow(existing) : 0;
    if (record.expectedVersion !== undefined && record.expectedVersion !== existingVersion) {
      throw new Error('credential_version_conflict');
    }
    const nextVersion = existingVersion + 1;
    const row = credentialRowFromRecord({
      ...record,
      version: nextVersion,
    });
    if (existing) {
      const updated = await db.updateById<Record<string, unknown>>(credential, record.id, row);
      return recordFromCredentialRow(updated ?? row);
    }
    await db.insert(credential).values(row).execute();
    return recordFromCredentialRow(row);
  }

  public async rewrapCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    credentialId: string;
    expectedVersion?: number;
    encryptedSecret: EncryptedCredentialSecret;
    auth?: AuthContext;
  }): Promise<boolean> {
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const existing = await db.findById<Record<string, unknown>>(credential, input.credentialId);
    if (!existing) {
      return false;
    }
    const current = recordFromCredentialRow(existing);
    if (current.webId !== input.webId) {
      return false;
    }
    const currentVersion = versionFromRow(existing);
    if (input.expectedVersion === undefined || currentVersion !== input.expectedVersion) {
      return false;
    }
    const updated = await db.update(credential)
      .set({
        encryptedSecret: JSON.stringify(input.encryptedSecret),
        wrappedDataKey: input.encryptedSecret.wrappedDek,
        encryptionAlgorithm: input.encryptedSecret.algorithm,
        keyVersion: String(currentVersion + 1),
      })
      .where(and(
        eq(credential.id, input.credentialId),
        eq(credential.keyVersion, String(input.expectedVersion)),
      ))
      .returning()
      .execute();
    return updated.length === 1;
  }

  public async markReauthRequired(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    reason: string;
    expectedVersion?: number;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined> {
    const current = await this.getActiveCredential(input);
    if (!current) {
      return undefined;
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new Error('credential_version_conflict');
    }
    return this.updateCredential({
      webId: input.webId,
      provider: input.provider,
      deployment: input.deployment,
      credentialId: current.id,
      expectedVersion: input.expectedVersion,
      patch: {
        reauthRequired: true,
        status: 'active',
      },
      auth: input.auth,
    });
  }

  public async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    const current = await this.getCredential(input);
    if (!current) {
      return undefined;
    }
    return this.revokeCredential({
      webId: input.webId,
      provider: input.provider,
      deployment: input.deployment,
      credentialId: current.id,
      expectedVersion: current.version,
      auth: input.auth,
    });
  }

  private async withSelectedModels(
    db: ConnectedCredentialDb,
    aiProvider: typeof aiProviderResource,
    aiModel: typeof aiModelResource,
    records: ConnectCredentialRecord[],
    owner: string,
    podBaseUrl: string,
    podFetch: typeof fetch,
  ): Promise<ConnectCredentialRecord[]> {
    if (records.length === 0) {
      return records;
    }
    const selectedByProduct = new Map<string, AiGatewayModelSummary[] | undefined>();
    const productIds = [...new Set(records.map((record) => productProviderId(record.provider)))];
    const modelCollection = await selectResourceRowsBestEffort(db, aiModel);
    const providerCollection = await selectResourceRowsBestEffort(db, aiProvider);
    const queriedModelRows = modelCollection.rows;
    const queriedProviderRows = providerCollection.rows;
    // One remote drizzle-solid database owns one query engine. Keep product
    // hydration sequential so exact offering reads cannot overlap collection
    // reads on the same Pod connection.
    for (const productId of productIds) {
      const productRecords = records.filter((record) => productProviderId(record.provider) === productId);
      const exactProviderRows = providerCollection.unsupported
        ? await findProviderRowsByReferences(
          db,
          aiProvider,
          podBaseUrl,
          [productId, ...productRecords.map((record) => record.provider)],
        )
        : [];
      const matchingProviderRows = queriedProviderRows.filter((row) => {
        const referencedProviderId = providerIdFromResourceReference(String(row.id ?? ''));
        return referencedProviderId !== undefined
          && productProviderId(referencedProviderId) === productId;
      });
      const providerRows = [...exactProviderRows, ...matchingProviderRows].filter(
        (row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index,
      );
      const selected = new Map<string, AiGatewayModelSummary>();
      for (const row of providerRows) {
        for (const model of await selectedModelReferencesFromProviderRow(
          db,
          aiModel,
          row,
          productId,
          podBaseUrl,
          queriedModelRows,
        )) {
          selected.set(model.resourceId ?? `${model.offeringId ?? ''}:${model.id}`, model);
        }
      }
      if (selected.size === 0) {
        for (const model of await selectedModelReferencesFromPodResource(podFetch, podBaseUrl, productId)) {
          selected.set(model.resourceId ?? `${model.offeringId ?? ''}:${model.id}`, model);
        }
      }
      // No rows means “no credential-level restriction”, not “this
      // credential supports zero models”. Pod-wide selection is enforced by
      // ModelRouter's selection repository.
      selectedByProduct.set(productId, selected.size > 0 ? [...selected.values()] : undefined);
    }
    return records.map((record) => {
      const productId = productProviderId(record.provider);
      const selected = selectedByProduct.get(productId);
      if (selected === undefined) return record;
      const offeringId = credentialOfferingId(record);
      const offeringSelected = selected.filter((model) => !model.offeringId || model.offeringId === offeringId);
      const instanceOfferingId = customProviderInstanceCredentialId(record.provider)
        ? offeringId
        : undefined;
      return {
        ...record,
        selectedModels: offeringSelected.map((model) => (
          !model.offeringId && instanceOfferingId
            ? { ...model, offeringId: instanceOfferingId }
            : model
        )),
      };
    });
  }

  private async dbForOwner(owner: string, auth?: AuthContext): Promise<{
    db: ConnectedCredentialDb;
    credential: typeof credentialResource;
    aiProvider: typeof aiProviderResource;
    aiModel: typeof aiModelResource;
    fetch: typeof fetch;
  }> {
    const credential = alias(this.credentialTemplate, 'credential');
    const podUrl = await resolveOwnerPodBaseUrl(owner, this.podBaseUrlResolver);
    const trustedFetch = await this.resolveTrustedFetch(owner, auth, podUrl);
    const podBaseUrl = podUrl.replace(/\/$/u, '');
    const settingsSparqlEndpoint = `${podBaseUrl}/settings/-/sparql`;
    credential.setSparqlEndpoint(settingsSparqlEndpoint);
    const aiProvider = alias(this.aiProviderTemplate, 'aiProvider');
    aiProvider.setSparqlEndpoint(settingsSparqlEndpoint);
    const aiModel = aiModelSchema.table('aiModel', {
      base: '/settings/providers/',
      sparqlEndpoint: settingsSparqlEndpoint,
    });
    const db = await this.dbFactory({ owner, auth, fetch: trustedFetch, podUrl, credential, aiProvider, aiModel });
    await db.init?.(credential, aiProvider, aiModel);
    return { db, credential, aiProvider, aiModel, fetch: trustedFetch };
  }

  private async resolveTrustedFetch(
    owner: string,
    auth: AuthContext | undefined,
    podBaseUrl: string,
  ): Promise<typeof fetch> {
    if (auth?.type === 'solid' && auth.webId !== owner) {
      throw new Error(callerPodAccessError(owner, auth));
    }
    // A CSS account client-credentials token authenticates its exchange, not a
    // reusable Pod request. Prefer the constrained hosted route for that wrapper.
    if (
      auth?.type === 'solid'
      && auth.webId === owner
      && auth.viaApiKey === true
      && typeof auth.clientId === 'string'
      && typeof auth.clientSecret === 'string'
    ) {
      const hostedFetch = await this.internalPodAccess?.getTrustedFetch(owner, auth, { podBaseUrl });
      if (hostedFetch) {
        return this.wrapPodFetch(hostedFetch);
      }
    }
    const callerFetch = createCallerAuthenticatedPodFetch(owner, auth);
    if (callerFetch) {
      return this.wrapPodFetch(callerFetch);
    }
    // Browser DPoP proves the management caller but is bound to that request
    // URL. Never replay it against the Pod; use the same-owner hosted route.
    if (
      auth?.type === 'solid'
      && auth.webId === owner
      && (auth.tokenType === 'DPoP' || typeof auth.dpopProof === 'string')
    ) {
      const hostedFetch = await this.internalPodAccess?.getTrustedFetch(owner, auth, { podBaseUrl });
      if (hostedFetch) {
        return this.wrapPodFetch(hostedFetch);
      }
    }
    if (!isInternalPodAccessAllowed(auth)) {
      throw new Error(callerPodAccessError(owner, auth));
    }
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(owner, auth, { podBaseUrl });
    if (!trustedFetch) {
      throw new Error('AI Connection service identity is not configured');
    }
    return this.wrapPodFetch(trustedFetch);
  }

  private wrapPodFetch(trustedFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      let response: Response;
      try {
        response = await trustedFetch(input, init);
      } catch (error) {
        const url = input instanceof Request ? input.url : String(input);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`credential_pod_fetch_failed:${url}:${message}`, { cause: error });
      }
      if (response.status === 403) {
        throw new Error('service_access_missing');
      }
      return response;
    };
  }
}

export interface ProviderConnectAdapter {
  readonly provider: string;
  begin(input: ConnectBeginInput): Promise<ConnectBeginResult>;
  status?(input: PollDeviceInput): Promise<ConnectBeginResult>;
  completeApiKey?(input: CompleteApiKeyInput): Promise<ConnectBeginResult>;
  pollDevice?(input: PollDeviceInput): Promise<ConnectBeginResult>;
  refresh?(
    input: RefreshInput,
    current: ConnectCredentialRecord,
    secret: ProviderSecret,
  ): Promise<ConnectCredentialRecord | undefined>;
  refreshCallerOwned?(input: CallerOwnedOAuthRefreshInput): Promise<ConnectBeginResult>;
  disconnect?(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined>;
}

interface ConnectAttempt {
  id: string;
  provider: string;
  deployment: GatewayDeployment;
  webId: string;
  mode: ConnectMode;
  state: string;
  signature: string;
  expiresAt: Date;
  consumedAt?: Date;
  expectedCredentialVersion?: number;
  codeVerifier?: string;
  deviceCode?: string;
  intervalSeconds?: number;
  currentPollIntervalSeconds?: number;
  nextPollAt?: Date;
  pollClaimedAt?: Date;
  lastPollStatus?: ConnectAttemptStatus;
}

interface PollClaimResult {
  attempt: ConnectAttempt;
  claimed: boolean;
}

export class InMemoryConnectAttemptStore {
  private readonly attempts = new Map<string, ConnectAttempt>();
  private readonly maxAttempts = 1_000;

  public async create(attempt: ConnectAttempt): Promise<ConnectAttempt> {
    this.pruneExpired(new Date());
    this.attempts.set(attempt.id, cloneAttempt(attempt));
    this.pruneBounded();
    return cloneAttempt(attempt);
  }

  public async get(id: string, now?: Date): Promise<ConnectAttempt | undefined> {
    this.pruneExpired(now ?? new Date(), id);
    const attempt = this.attempts.get(id);
    if (attempt && now && attempt.expiresAt.getTime() <= now.getTime()) {
      this.attempts.delete(id);
    }
    return attempt ? cloneAttempt(attempt) : undefined;
  }

  public async consume(id: string, now: Date): Promise<ConnectAttempt> {
    this.pruneExpired(now, id);
    const attempt = this.attempts.get(id);
    if (!attempt) {
      throw new Error('Connect attempt not found');
    }
    if (attempt.consumedAt) {
      throw new Error('Connect attempt already consumed');
    }
    if (attempt.expiresAt.getTime() <= now.getTime()) {
      this.attempts.delete(id);
      throw new Error('Connect attempt expired');
    }
    attempt.consumedAt = new Date(now);
    return cloneAttempt(attempt);
  }

  public async claimPoll(id: string, now: Date): Promise<PollClaimResult> {
    this.pruneExpired(now, id);
    const attempt = this.attempts.get(id);
    if (!attempt) {
      throw new Error('Connect attempt not found');
    }
    if (attempt.consumedAt) {
      throw new Error('Connect attempt already consumed');
    }
    if (attempt.expiresAt.getTime() <= now.getTime()) {
      this.attempts.delete(id);
      throw new Error('Connect attempt expired');
    }
    if (attempt.nextPollAt && attempt.nextPollAt.getTime() > now.getTime()) {
      return { attempt: cloneAttempt(attempt), claimed: false };
    }
    if (attempt.pollClaimedAt) {
      return { attempt: cloneAttempt(attempt), claimed: false };
    }
    attempt.pollClaimedAt = new Date(now);
    return { attempt: cloneAttempt(attempt), claimed: true };
  }

  public async updatePollSchedule(
    id: string,
    patch: {
      intervalSeconds: number;
      nextPollAt: Date;
      lastPollStatus: ConnectAttemptStatus;
    },
  ): Promise<ConnectAttempt | undefined> {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.consumedAt) {
      return undefined;
    }
    attempt.intervalSeconds = patch.intervalSeconds;
    attempt.currentPollIntervalSeconds = patch.intervalSeconds;
    attempt.nextPollAt = new Date(patch.nextPollAt);
    attempt.lastPollStatus = patch.lastPollStatus;
    attempt.pollClaimedAt = undefined;
    return cloneAttempt(attempt);
  }

  public async releasePollClaim(id: string): Promise<void> {
    const attempt = this.attempts.get(id);
    if (attempt) {
      attempt.pollClaimedAt = undefined;
    }
  }

  private pruneExpired(now: Date, exceptId?: string): void {
    for (const [id, attempt] of this.attempts) {
      if (id !== exceptId && attempt.expiresAt.getTime() <= now.getTime()) {
        this.attempts.delete(id);
      }
    }
  }

  private pruneBounded(): void {
    while (this.attempts.size > this.maxAttempts) {
      const oldest = this.attempts.keys().next().value;
      if (typeof oldest !== 'string') {
        return;
      }
      this.attempts.delete(oldest);
    }
  }
}

export interface BrowserAssistedApiKeyConnectAdapterOptions {
  provider: string;
  consoleUrl: string;
  attempts: InMemoryConnectAttemptStore;
  credentialRepository: PodCredentialRepository;
  vault: CredentialVault;
  deployment: GatewayDeployment;
  now?: () => Date;
  randomBytes?: (bytes: number) => Buffer;
  signingSecret: string;
}

export class BrowserAssistedApiKeyConnectAdapter implements ProviderConnectAdapter {
  public readonly provider: string;
  private readonly consoleUrl: string;
  protected readonly attempts: InMemoryConnectAttemptStore;
  protected readonly credentialRepository: PodCredentialRepository;
  protected readonly vault: CredentialVault;
  protected readonly deployment: GatewayDeployment;
  protected readonly now: () => Date;
  protected readonly randomBytes: (bytes: number) => Buffer;
  private readonly signingSecret: string;

  public constructor(options: BrowserAssistedApiKeyConnectAdapterOptions) {
    this.provider = normalizeProvider(options.provider);
    this.consoleUrl = options.consoleUrl;
    this.attempts = options.attempts;
    this.credentialRepository = options.credentialRepository;
    this.vault = options.vault;
    this.deployment = options.deployment;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.signingSecret = options.signingSecret;
  }

  public async begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    this.assertInput(input, 'browserAssistedApiKey');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    const attempt = await this.createAttempt(input, expiresAt);
    const url = new URL(this.consoleUrl);
    url.searchParams.set('xpod_connect_attempt', attempt.id);
    url.searchParams.set('xpod_provider', this.provider);

    return {
      mode: 'browserAssistedApiKey',
      status: 'pending',
      provider: this.provider,
      deployment: this.deployment,
      attemptId: attempt.id,
      state: attempt.state,
      signature: attempt.signature,
      expiresAt: expiresAt.toISOString(),
      authorizationUrl: url.toString(),
    };
  }

  public async completeApiKey(input: CompleteApiKeyInput): Promise<ConnectBeginResult> {
    if (!input.apiKey.trim()) {
      throw new Error('API key is required');
    }
    const attempt = await this.loadConsumableAttempt(input, 'browserAssistedApiKey');
    const consumed = await this.attempts.consume(input.attemptId, this.now());
    const credentialIri = aiRuntimeRepository.credentialIri(input.webId, {
      deployment: input.deployment,
      provider: this.provider,
    });
    const encryptedSecret = await this.vault.seal(
      principal(input.webId),
      credentialIri,
      this.provider,
      { type: 'apiKey', apiKey: input.apiKey },
    );
    const metadata = metadataWithoutUndefined({
      baseUrl: input.baseUrl,
      health: 'unknown',
    });
    const record = await this.credentialRepository.upsertConnectedCredential({
      id: aiRuntimeRepository.credentialId({ deployment: input.deployment, provider: this.provider }),
      credentialIri,
      webId: input.webId,
      provider: this.provider,
      deployment: input.deployment,
      authMode: 'apiKey',
      encryptedSecret,
      status: 'active',
      accountLabel: input.accountLabel,
      expectedVersion: consumed.expectedCredentialVersion,
      health: 'unknown',
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }, { auth: input.auth });

    return {
      mode: 'browserAssistedApiKey',
      status: 'completed',
      provider: this.provider,
      deployment: input.deployment,
      attemptId: attempt.id,
      credentialId: record.id,
    };
  }

  public async status(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const attempt = await this.loadAttemptForStatus(input, 'browserAssistedApiKey');
    return {
      mode: attempt.mode,
      status: this.statusForAttempt(attempt),
      provider: this.provider,
      deployment: input.deployment,
      attemptId: attempt.id,
      expiresAt: attempt.expiresAt.toISOString(),
    };
  }

  public async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    return this.credentialRepository.disconnect({
      webId: input.webId,
      provider: this.provider,
      deployment: input.deployment,
      credentialId: input.credentialId,
      auth: input.auth,
    });
  }

  protected async createAttempt(input: ConnectBeginInput, expiresAt: Date, extra: Partial<ConnectAttempt> = {}): Promise<ConnectAttempt> {
    const attemptWithoutSignature: Omit<ConnectAttempt, 'signature'> = {
      id: token(this.randomBytes),
      provider: this.provider,
      deployment: input.deployment,
      webId: input.webId,
      mode: input.requestedMode,
      state: token(this.randomBytes),
      expiresAt,
      expectedCredentialVersion: input.expectedCredentialVersion,
      ...extra,
    };
    const signature = signAttempt(attemptWithoutSignature, this.signingSecret);
    return this.attempts.create({ ...attemptWithoutSignature, signature });
  }

  protected async loadAttemptForStatus(input: PollDeviceInput, mode: ConnectMode): Promise<ConnectAttempt> {
    const attempt = await this.attempts.get(input.attemptId, this.now());
    if (!attempt) {
      throw new Error('Connect attempt not found');
    }
    if (attempt.webId !== input.webId) {
      throw new Error('Connect attempt is bound to a different WebID');
    }
    if (attempt.deployment !== input.deployment) {
      throw new Error('Connect attempt is bound to a different deployment');
    }
    if (attempt.provider !== normalizeProvider(input.provider)) {
      throw new Error('Connect attempt is bound to a different provider');
    }
    if (attempt.mode !== mode) {
      throw new Error('Connect attempt mode mismatch');
    }
    if (attempt.state !== input.state) {
      throw new Error('Invalid Connect attempt state');
    }
    if (!signatureMatches(input.signature, signAttempt(attempt, this.signingSecret))) {
      throw new Error('Invalid Connect attempt signature');
    }
    return attempt;
  }

  protected async loadConsumableAttempt(input: PollDeviceInput, mode: ConnectMode): Promise<ConnectAttempt> {
    const attempt = await this.loadAttemptForStatus(input, mode);
    if (attempt.expiresAt.getTime() <= this.now().getTime()) {
      throw new Error('Connect attempt expired');
    }
    if (attempt.consumedAt) {
      throw new Error('Connect attempt already consumed');
    }
    return attempt;
  }

  protected statusForAttempt(attempt: ConnectAttempt): ConnectAttemptStatus {
    if (attempt.expiresAt.getTime() <= this.now().getTime()) {
      return 'expired';
    }
    return attempt.consumedAt ? 'completed' : 'pending';
  }

  protected assertInput(input: ConnectBeginInput, mode: ConnectMode): void {
    if (normalizeProvider(input.provider) !== this.provider) {
      throw new Error('Connect provider mismatch');
    }
    if (input.deployment !== this.deployment) {
      throw new Error('Connect deployment mismatch');
    }
    if (input.requestedMode !== mode) {
      throw new Error('Unsupported Connect mode');
    }
    if (!input.webId) {
      throw new Error('Connect WebID is required');
    }
  }
}

export interface KimiDeviceCodeConnectAdapterOptions extends Omit<BrowserAssistedApiKeyConnectAdapterOptions, 'provider' | 'consoleUrl'> {
  fetch?: typeof fetch;
  oauthIntegration: OAuthIntegration;
  deviceAuthorizationEndpoint?: string;
  tokenEndpoint?: string;
}

export class KimiDeviceCodeConnectAdapter extends BrowserAssistedApiKeyConnectAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly deviceAuthorizationEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly oauthCredentials: OAuthConnectCredentialStore;

  public constructor(options: KimiDeviceCodeConnectAdapterOptions) {
    super({
      ...options,
      provider: 'kimi',
      consoleUrl: 'https://kimi.moonshot.cn/device',
    });
    this.fetchImpl = options.fetch ?? fetch;
    this.clientId = requireKimiOAuthClientId(options.oauthIntegration);
    this.deviceAuthorizationEndpoint = options.deviceAuthorizationEndpoint ?? 'https://auth.kimi.com/api/oauth/device_authorization';
    this.tokenEndpoint = options.tokenEndpoint ?? 'https://auth.kimi.com/api/oauth/token';
    this.oauthCredentials = new OAuthConnectCredentialStore({
      provider: 'kimi',
      deployment: options.deployment,
      credentialRepository: options.credentialRepository,
      vault: options.vault,
    });
    assertKimiEndpoint(this.deviceAuthorizationEndpoint, '/api/oauth/device_authorization');
    assertKimiEndpoint(this.tokenEndpoint, '/api/oauth/token');
  }

  public override async begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    this.assertInput(input, 'deviceCodeOAuth');
    const now = this.now();
    const verifier = token(this.randomBytes);
    const challenge = codeChallenge(verifier);
    const response = await this.fetchImpl(this.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      throw new Error(`Kimi device authorization failed: ${safeProviderError(body)}`);
    }
    requireStringField(body, 'device_code');
    requireStringField(body, 'user_code');
    requireStringField(body, 'verification_uri_complete');
    const expiresIn = numberFrom(body.expires_in, 300);
    const attempt = await this.createAttempt(input, new Date(now.getTime() + expiresIn * 1000), {
      mode: 'deviceCodeOAuth',
      codeVerifier: verifier,
      deviceCode: stringFrom(body.device_code),
      intervalSeconds: numberFrom(body.interval, 5),
      currentPollIntervalSeconds: numberFrom(body.interval, 5),
      nextPollAt: new Date(now.getTime() + numberFrom(body.interval, 5) * 1000),
    });
    return {
      mode: 'deviceCodeOAuth',
      status: 'pending',
      provider: 'kimi',
      deployment: input.deployment,
      attemptId: attempt.id,
      state: attempt.state,
      signature: attempt.signature,
      expiresAt: attempt.expiresAt.toISOString(),
      pkceChallenge: challenge,
      deviceCode: attempt.deviceCode,
      userCode: stringFrom(body.user_code),
      verificationUri: stringFrom(body.verification_uri),
      verificationUriComplete: stringFrom(body.verification_uri_complete),
      intervalSeconds: attempt.intervalSeconds,
    };
  }

  public async pollDevice(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const attempt = await this.loadConsumableAttempt(input, 'deviceCodeOAuth');
    const now = this.nowForConsume();
    const claim = await this.attempts.claimPoll(input.attemptId, now);
    if (!claim.claimed) {
      return pendingResult(
        input,
        claim.attempt.lastPollStatus === 'slow_down' ? 'slow_down' : 'authorization_pending',
        claim.attempt.currentPollIntervalSeconds ?? claim.attempt.intervalSeconds,
      );
    }
    try {
      const response = await this.fetchImpl(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: attempt.deviceCode ?? '',
          client_id: this.clientId,
          code_verifier: attempt.codeVerifier ?? '',
        }),
      });
      const body = await safeJson(response);
      if (!response.ok) {
        if (body.error === 'authorization_pending' || body.error === 'slow_down') {
          const status = body.error;
          const intervalSeconds = status === 'slow_down'
            ? (attempt.currentPollIntervalSeconds ?? attempt.intervalSeconds ?? 5) + 5
            : (attempt.currentPollIntervalSeconds ?? attempt.intervalSeconds ?? 5);
          await this.attempts.updatePollSchedule(input.attemptId, {
            intervalSeconds,
            nextPollAt: new Date(now.getTime() + intervalSeconds * 1000),
            lastPollStatus: status,
          });
          return pendingResult(input, status, intervalSeconds);
        }
        if (body.error === 'expired_token') {
          await this.attempts.consume(input.attemptId, this.nowForConsume());
          return pendingResult(input, 'expired');
        }
        throw new Error(`Kimi device token failed: ${safeProviderError(body)}`);
      }
      await this.attempts.consume(input.attemptId, this.nowForConsume());
      requireStringField(body, 'access_token');
      requireStringField(body, 'refresh_token');
      return {
        mode: 'deviceCodeOAuth',
        status: 'completed',
        provider: 'kimi',
        deployment: input.deployment,
        attemptId: input.attemptId,
        oauthCredential: oneTimeOAuthCredential(body, this.now(), attempt.expectedCredentialVersion),
      };
    } catch (error) {
      await this.attempts.releasePollClaim(input.attemptId);
      throw error;
    }
  }

  public override async status(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const attempt = await this.loadAttemptForStatus(input, 'deviceCodeOAuth');
    return {
      mode: 'deviceCodeOAuth',
      status: this.statusForAttempt(attempt),
      provider: 'kimi',
      deployment: input.deployment,
      attemptId: attempt.id,
      expiresAt: attempt.expiresAt.toISOString(),
      deviceCode: attempt.deviceCode,
      intervalSeconds: attempt.currentPollIntervalSeconds ?? attempt.intervalSeconds,
    };
  }

  public async refresh(
    input: RefreshInput,
    current: ConnectCredentialRecord,
    secret: ProviderSecret,
  ): Promise<ConnectCredentialRecord | undefined> {
    const refreshToken = stringFrom(secret.refreshToken);
    if (!refreshToken) {
      return this.credentialRepository.markReauthRequired({
        webId: input.webId,
        provider: 'kimi',
        deployment: input.deployment,
        reason: 'missing_refresh_token',
        expectedVersion: current.version,
        auth: input.auth,
      });
    }
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      return this.credentialRepository.markReauthRequired({
        webId: input.webId,
        provider: 'kimi',
        deployment: input.deployment,
        reason: safeProviderError(body),
        expectedVersion: current.version,
        auth: input.auth,
      });
    }
    requireStringField(body, 'access_token');
    requireStringField(body, 'refresh_token');
    return this.updateOAuthCredential(input, body, current);
  }

  public async refreshCallerOwned(input: CallerOwnedOAuthRefreshInput): Promise<ConnectBeginResult> {
    if (!input.refreshToken.trim()) throw new Error('oauth_refresh_token_required');
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: this.clientId,
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      throw new Error(`Kimi OAuth refresh failed: ${safeProviderError(body)}`);
    }
    return {
      mode: 'deviceCodeOAuth',
      status: 'completed',
      provider: 'kimi',
      deployment: input.deployment,
      credentialId: input.credentialId,
      oauthCredential: oneTimeOAuthCredential(body, this.now(), input.expectedVersion),
    };
  }

  public override async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    const current = await this.findOAuthCredential(input);
    if (!current) {
      throw new Error('oauth_credential_not_found');
    }
    return this.credentialRepository.revokeCredential({
      webId: input.webId,
      provider: 'kimi',
      deployment: input.deployment,
      credentialId: current.id,
      expectedVersion: current.version,
      auth: input.auth,
    });
  }

  private nowForConsume(): Date {
    return this.now();
  }

  private async updateOAuthCredential(
    input: { webId: string; deployment: GatewayDeployment; auth?: AuthContext },
    body: Record<string, unknown>,
    current: ConnectCredentialRecord,
  ): Promise<ConnectCredentialRecord | undefined> {
    const expiresAt = expiresAtFrom(body.expires_in, this.now());
    const secret: ProviderSecret = {
      type: 'deviceCodeOAuth',
      accessToken: stringFrom(body.access_token),
      refreshToken: stringFrom(body.refresh_token),
      expiresAt: expiresAt?.toISOString(),
      scope: stringFrom(body.scope),
      idToken: stringFrom(body.id_token),
    };
    return this.oauthCredentials.updateOAuthCredential({
      current,
      webId: input.webId,
      deployment: input.deployment,
      secret,
      expiresAt,
      auth: input.auth,
      metadata: {
        authoritativeSubject: decodeJwtSubject(stringFrom(body.id_token)),
      },
    });
  }

  private async findOAuthCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    credentialId?: string;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined> {
    const credentials = input.credentialId
      ? [
        await this.credentialRepository.getCredentialById({
          webId: input.webId,
          provider: 'kimi',
          deployment: input.deployment,
          credentialId: input.credentialId,
          auth: input.auth,
        }),
      ]
      : await this.credentialRepository.listProviderCredentials({
        webId: input.webId,
        provider: 'kimi',
        deployment: input.deployment,
        auth: input.auth,
      });
    return credentials.find((credential) => credential && isKimiOAuthCredential(credential));
  }
}

export class DeepSeekConnectAdapter implements ProviderConnectAdapter {
  public readonly provider = 'deepseek';

  public async begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    if (normalizeProvider(input.provider) !== this.provider) {
      throw new Error('Connect provider mismatch');
    }
    return {
      mode: input.requestedMode,
      status: 'unsupported',
      provider: 'deepseek',
      deployment: input.deployment,
      apiKeyManagementSupported: true,
      message: 'DeepSeek does not expose a supported third-party browser Connect flow; use authenticated API key management.',
    };
  }
}

export interface ProviderConnectServiceOptions {
  registry: ProviderRegistry;
  adapters: ProviderConnectAdapter[];
  localSessionImporters?: LocalSessionImportAdapter[];
  credentialRepository?: PodCredentialRepository;
  vault?: CredentialVault;
}

export interface ProviderConnectionSummary {
  provider: string;
  status: 'connected' | 'disconnected' | 'reauthRequired';
  authMode?: 'apiKey' | 'deviceCodeOAuth' | 'local';
  accountLabel?: string;
  baseUrl?: string;
  proxyUrl?: string;
  expiresAt?: string;
  reauthRequired?: boolean;
  credentialIri?: string;
  version?: number;
  connect: {
    modes: string[];
    configured: boolean;
    message?: string;
  };
}

export interface AiProviderCredentialSummary {
  id: string;
  provider: string;
  offeringId: string;
  authMode: 'oauth' | 'deviceCode' | 'apiKey' | 'local';
  label?: string;
  enabled: boolean;
  priority: number;
  health: 'healthy' | 'expired' | 'invalid' | 'unknown';
  maskedHint?: string;
  baseUrl?: string;
  proxyUrl?: string;
  expiresAt?: string;
  version: number;
  quota?: unknown;
}

export interface AiGatewayModelSummary {
  id: string;
  provider: string;
  offeringId?: string;
  resourceId?: string;
  displayName?: string;
  custom?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
}

export interface AiProviderPoolSummary {
  id: string;
  name: string;
  status: 'unconfigured' | 'configured' | 'available' | 'attention' | 'unavailable';
  offerings: Array<{
    id: string;
    label: string;
    kind?: string;
    lifecycle: 'active' | 'legacy' | 'unavailable';
    authModes?: string[];
    runtimeProviderIds?: string[];
    productLabel: string;
    credentialPrefixHints: string[];
    consoleUrl: string;
    subscriptionUrl: string;
    endpoints: Array<{ protocol: string; baseUrl: string; region?: string }>;
    modelDiscovery: { strategy: string; path: string; endpointProtocol: string };
    quota: { strategy: string; url: string };
    usagePolicyUrl: string;
    region: string;
  }>;
  credentials: AiProviderCredentialSummary[];
  selectedModels: AiGatewayModelSummary[];
}

export interface ProviderCredentialTestModelsService {
  list(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    credentialIri?: string;
  }): Promise<{
    models: Array<{
      id: string;
      displayName?: string;
      capabilities?: string[];
    }>;
    observedAt: string;
  }>;
}

export class ProviderConnectService {
  private readonly registry: ProviderRegistry;
  private readonly credentialRepository?: PodCredentialRepository;
  private readonly vault?: CredentialVault;
  private readonly adapters = new Map<string, ProviderConnectAdapter>();
  private readonly localSessionImporters = new Map<string, LocalSessionImportAdapter>();

  public constructor(options: ProviderConnectServiceOptions) {
    this.registry = options.registry;
    this.credentialRepository = options.credentialRepository;
    this.vault = options.vault;
    for (const adapter of options.adapters) {
      this.adapters.set(normalizeProvider(adapter.provider), adapter);
    }
    for (const importer of options.localSessionImporters ?? []) {
      this.localSessionImporters.set(localSessionImporterKey(importer.provider, importer.offeringId), importer);
    }
  }

  public begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    const descriptor = this.registry.requireProvider(input.provider);
    if (descriptor.connect?.mode !== input.requestedMode) {
      throw new Error('Requested Connect mode does not match provider capability');
    }
    if (descriptor.connect?.configured === false) {
      const message = descriptor.connect.notes?.includes('auth_not_available')
        ? 'auth_not_available'
        : descriptor.connect.notes?.join(' ');
      return Promise.resolve({
        mode: descriptor.connect.mode,
        status: 'unsupported',
        provider: normalizeProvider(input.provider),
        deployment: input.deployment,
        apiKeyManagementSupported: descriptor.connect.apiKeyManagementSupported,
        message,
      });
    }
    return this.requireAdapter(input.provider).begin(input);
  }

  public async listProviders(input: {
    webId: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ProviderConnectionSummary[]> {
    return Promise.all(this.registry.listProviders().map(async (descriptor) => {
      const credential = this.credentialRepository?.getCredential
        ? await this.credentialRepository.getCredential({
          ...input,
          provider: descriptor.id,
        })
        : await this.credentialRepository?.getActiveCredential({
          ...input,
          provider: descriptor.id,
        });
      const active = credential?.status === 'active';
      const reauthRequired = active && credential.reauthRequired === true;
      const metadata = metadataFromRowValue(credential?.metadata) ?? {};
      const modes = Array.from(new Set([
        ...descriptor.authModes.filter((mode) => mode !== 'connectUnsupported'),
        ...(descriptor.connect?.apiKeyManagementSupported ? ['apiKey'] : []),
      ]));
      return {
        provider: descriptor.id,
        status: reauthRequired
          ? 'reauthRequired' as const
          : active
            ? 'connected' as const
            : 'disconnected' as const,
        authMode: active ? credential.authMode : undefined,
        accountLabel: active ? credential.accountLabel : undefined,
        baseUrl: active ? stringMetadata(metadata, 'baseUrl') : undefined,
        proxyUrl: active ? redactProviderProxyUrl(stringMetadata(metadata, 'proxyUrl')) : undefined,
        expiresAt: active ? credential.expiresAt?.toISOString() : undefined,
        reauthRequired: reauthRequired || undefined,
        credentialIri: active ? credential.credentialIri : undefined,
        version: active ? credential.version : undefined,
        connect: {
          modes,
          configured: descriptor.connect?.configured !== false,
          message: descriptor.connect?.notes?.join(' ') || undefined,
        },
      };
    }));
  }

  public async listProviderCredentialPools(input: {
    webId: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<AiProviderPoolSummary[]> {
    if (!this.credentialRepository) {
      return this.registry.listProducts().map((product) => ({
        id: product.id,
        name: product.label,
        status: 'unconfigured',
        offerings: product.offerings.map(publicOfferingSummary),
        credentials: [],
        selectedModels: [],
      }));
    }
    return Promise.all(this.registry.listProducts().map(async (product) => {
      const runtimeProviders = new Set(product.offerings.flatMap((offering) => offering.runtimeProviderIds));
      const credentials = (await Promise.all([...runtimeProviders].map((provider) =>
        this.credentialRepository!.listProviderCredentials({
          ...input,
          provider,
        })))).flat();
      const publicCredentials = credentials.map(publicPoolCredentialSummary);
      return {
        id: product.id,
        name: product.label,
        status: aggregateProviderPoolStatus(publicCredentials),
        offerings: product.offerings.map(publicOfferingSummary),
        credentials: publicCredentials,
        selectedModels: selectedModelsFromCredentials(credentials),
      };
    }));
  }

  public async createApiKeyCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    apiKey: string;
    label?: string;
    baseUrl?: string;
    proxyUrl?: string;
    priority?: number;
    auth?: AuthContext;
  }): Promise<AiProviderCredentialSummary> {
    if (!this.credentialRepository || !this.vault) {
      throw new Error('credential_pool_not_configured');
    }
    const provider = normalizeProvider(input.provider);
    const offeringId = requireApiKeyOffering(provider, input.offeringId);
    const proxyUrl = normalizeProviderProxyUrl(input.proxyUrl);
    const { credentialId, credentialIri } = createPoolCredentialLocator(
      input.webId,
      input.deployment,
      provider,
    );
    const encryptedSecret = await this.vault.seal(
      { webId: input.webId },
      credentialIri,
      provider,
      { type: 'apiKey', apiKey: input.apiKey },
    );
    const created = await this.credentialRepository.createCredential({
      id: credentialId,
      credentialIri,
      webId: input.webId,
      provider,
      deployment: input.deployment,
      authMode: 'apiKey',
      encryptedSecret,
      status: 'active',
      accountLabel: input.label,
      offeringId,
      proxyUrl,
      priority: input.priority ?? 100,
      enabled: true,
      health: 'unknown',
      metadata: metadataWithoutUndefined({
        offeringId,
        priority: input.priority ?? 100,
        enabled: true,
        health: 'unknown',
        baseUrl: input.baseUrl,
        proxyUrl,
        maskedHint: maskApiKey(input.apiKey),
      }),
    }, { auth: input.auth });
    return publicPoolCredentialSummary(created);
  }

  public async createLocalCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    label?: string;
    baseUrl?: string;
    priority?: number;
    auth?: AuthContext;
  }): Promise<AiProviderCredentialSummary> {
    if (!this.credentialRepository || !this.vault) throw new Error('credential_pool_not_configured');
    const provider = normalizeProvider(input.provider);
    const offeringId = this.requireLocalOffering(provider, input.offeringId);
    const { credentialId, credentialIri } = createPoolCredentialLocator(
      input.webId,
      input.deployment,
      provider,
    );
    const importer = this.localSessionImporters.get(localSessionImporterKey(provider, offeringId));
    const offering = this.registry.getOffering(provider, offeringId);
    if (offering?.kind === 'oauth-subscription' && !importer) {
      throw new GatewayProtocolError('Local subscription session import is unavailable', {
        code: 'invalid_request',
        status: 400,
        details: { provider, offeringId },
      });
    }
    const imported = await importer?.importSession({ deployment: input.deployment });
    const encryptedSecret = await this.vault.seal(
      { webId: input.webId },
      credentialIri,
      provider,
      imported?.secret ?? { type: 'local' },
    );
    const created = await this.credentialRepository.createCredential({
      id: credentialId,
      credentialIri,
      webId: input.webId,
      provider,
      deployment: input.deployment,
      authMode: imported?.credentialAuthMode ?? 'local',
      encryptedSecret,
      status: 'active',
      accountLabel: imported?.accountLabel ?? input.label ?? 'Local',
      offeringId,
      priority: input.priority ?? 100,
      enabled: true,
      health: 'healthy',
      metadata: metadataWithoutUndefined({
        ...imported?.metadata,
        offeringId,
        priority: input.priority ?? 100,
        enabled: true,
        health: 'healthy',
        baseUrl: input.baseUrl,
      }),
    }, { auth: input.auth });
    return publicPoolCredentialSummary(created);
  }

  public async updateCredential(input: ProviderCredentialQuery & {
    credentialId: string;
    expectedVersion: number;
    patch: {
      label?: string;
      enabled?: boolean;
      priority?: number;
      baseUrl?: string;
      proxyUrl?: string;
    };
  }): Promise<AiProviderCredentialSummary | undefined> {
    if (!this.credentialRepository) {
      throw new Error('credential_pool_not_configured');
    }
    const existing = await this.credentialRepository.getCredentialById(input);
    const metadata = metadataFromRowValue(existing?.metadata) ?? {};
    const updated = await this.credentialRepository.updateCredential({
      ...input,
      patch: metadataWithoutUndefined({
        accountLabel: input.patch.label,
        enabled: input.patch.enabled,
        priority: input.patch.priority,
        proxyUrl: input.patch.proxyUrl === undefined
          ? undefined
          : normalizeProviderProxyUrl(input.patch.proxyUrl),
        health: input.patch.enabled === false ? 'disabled' : undefined,
        metadata: metadataWithoutUndefined({
          ...metadata,
          baseUrl: input.patch.baseUrl ?? metadata.baseUrl,
          proxyUrl: input.patch.proxyUrl === undefined
            ? metadata.proxyUrl
            : normalizeProviderProxyUrl(input.patch.proxyUrl),
          priority: input.patch.priority ?? metadata.priority,
          enabled: input.patch.enabled ?? metadata.enabled,
          health: input.patch.enabled === false ? 'disabled' : metadata.health,
        }),
      }),
    });
    return updated ? publicPoolCredentialSummary(updated) : undefined;
  }

  public async revokeCredential(input: ProviderCredentialQuery & {
    credentialId: string;
  }): Promise<AiProviderCredentialSummary | undefined> {
    if (!this.credentialRepository) {
      throw new Error('credential_pool_not_configured');
    }
    const revoked = await this.credentialRepository.revokeCredential(input);
    return revoked ? publicPoolCredentialSummary(revoked) : undefined;
  }

  public async testCredential(input: ProviderCredentialQuery & {
    credentialId?: string;
    apiKey?: string;
    modelsService?: ProviderCredentialTestModelsService;
  }): Promise<{
    status: 'ok';
    checkedAt: string;
    models: Array<{ id: string; displayName?: string; capabilities?: string[] }>;
  }> {
    if (input.apiKey) {
      throw new Error('credential_test_requires_credential_id');
    }
    if (!input.credentialId) {
      throw new Error('credential_not_found');
    }
    if (!this.credentialRepository) {
      throw new Error('credential_pool_not_configured');
    }
    if (!input.modelsService) {
      throw new Error('models_probe_not_configured');
    }
    const credential = await this.credentialRepository.getCredentialById({
      ...input,
      credentialId: input.credentialId,
    });
    if (!credential) {
      throw new Error('credential_not_found');
    }
    let result: Awaited<ReturnType<ProviderCredentialTestModelsService['list']>>;
    try {
      result = await input.modelsService.list({
        webId: input.webId,
        deployment: input.deployment,
        provider: input.provider,
        credentialIri: credential.credentialIri,
      });
    } catch (error) {
      await this.markCredentialHealth({ ...input, credentialId: input.credentialId }, credential, 'invalid');
      throw error;
    }
    await this.markCredentialHealth({ ...input, credentialId: input.credentialId }, credential, 'healthy');
    return {
      status: 'ok',
      checkedAt: result.observedAt,
      models: result.models.map((model) => ({
        id: model.id,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      })),
    };
  }

  private async markCredentialHealth(
    input: ProviderCredentialQuery & { credentialId: string },
    credential: ConnectCredentialRecord,
    health: 'healthy' | 'invalid',
  ): Promise<void> {
    const metadata = metadataFromRowValue(credential.metadata) ?? {};
    await this.credentialRepository?.updateCredential({
      ...input,
      credentialId: credential.id,
      expectedVersion: credential.version,
      patch: {
        health,
        metadata: metadataWithoutUndefined({
          ...metadata,
          health,
        }),
      },
    });
  }

  private requireLocalOffering(provider: string, offeringId: string | undefined): string {
    const resolvedOfferingId = offeringId ?? defaultOfferingFor(provider, 'local');
    const offering = resolvedOfferingId
      ? this.registry.getOffering(provider, resolvedOfferingId)
      : undefined;
    if (!resolvedOfferingId || !offering?.authModes.includes('local') || offering.lifecycle === 'unavailable') {
      throw new GatewayProtocolError('Provider offering is not compatible with local credentials', {
        code: 'invalid_request',
        status: 400,
        details: { provider, ...(offeringId ? { offeringId } : {}) },
      });
    }
    return offering.id;
  }

  public completeApiKey(input: CompleteApiKeyInput): Promise<ConnectBeginResult> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.completeApiKey) {
      throw new Error('Provider does not support API key Connect completion');
    }
    return adapter.completeApiKey(input);
  }

  public pollDevice(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.pollDevice) {
      throw new Error('Provider does not support device-code polling');
    }
    return adapter.pollDevice(input);
  }

  public status(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.status) {
      throw new Error('Provider does not support Connect status');
    }
    return adapter.status(input);
  }

  public refresh(input: RefreshInput): Promise<ConnectCredentialRecord | undefined> {
    return this.refreshWithRetry(input, 2);
  }

  public refreshCallerOwned(input: CallerOwnedOAuthRefreshInput): Promise<ConnectBeginResult> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.refreshCallerOwned) {
      throw new Error('Provider does not support caller-owned OAuth refresh');
    }
    return adapter.refreshCallerOwned(input);
  }

  private async refreshWithRetry(
    input: RefreshInput,
    remainingAttempts: number,
  ): Promise<ConnectCredentialRecord | undefined> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.refresh) {
      throw new Error('Provider does not support refresh');
    }
    if (!this.credentialRepository || !this.vault) {
      throw new Error('CredentialVault and PodCredentialRepository are required for provider refresh');
    }
    const current = await this.getRefreshCredential(input);
    if (!current) {
      throw new Error('oauth_credential_not_found');
    }
    const secret = await this.vault.open(
      { webId: input.webId },
      current.credentialIri,
      normalizeProvider(input.provider),
      current.encryptedSecret,
    );
    try {
      return await adapter.refresh(input, current, secret);
    } catch (error) {
      if (remainingAttempts > 0 && isVersionConflict(error)) {
        const latest = await this.getRefreshCredential(input);
        if (latest && latest.version !== current.version && !latest.reauthRequired) {
          return latest;
        }
        return this.refreshWithRetry(input, remainingAttempts - 1);
      }
      throw error;
    }
  }

  public disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.disconnect) {
      throw new Error('Provider does not support disconnect');
    }
    return adapter.disconnect(input);
  }

  private async getRefreshCredential(input: RefreshInput): Promise<ConnectCredentialRecord | undefined> {
    if (!this.credentialRepository) {
      return undefined;
    }
    const credential = input.credentialId
      ? await this.credentialRepository.getCredentialById({
        ...input,
        credentialId: input.credentialId,
      })
      : (await this.credentialRepository.listProviderCredentials(input))
        .find(isOAuthProviderCredential);
    return credential && isOAuthProviderCredential(credential) ? credential : undefined;
  }

  private requireAdapter(provider: string): ProviderConnectAdapter {
    const adapter = this.adapters.get(normalizeProvider(provider));
    if (!adapter) {
      throw new Error(`No Connect adapter registered for ${provider}`);
    }
    return adapter;
  }
}

function token(randomBytes: (bytes: number) => Buffer): string {
  return randomBytes(32).toString('base64url');
}

function publicOfferingSummary(offering: {
  id: string;
  label: string;
  kind?: string;
  lifecycle: 'active' | 'legacy' | 'unavailable';
  authModes?: string[];
  runtimeProviderIds?: string[];
  productLabel: string;
  credentialPrefixHints: string[];
  consoleUrl: string;
  subscriptionUrl: string;
  endpoints: Array<{ protocol: string; baseUrl: string; region?: string }>;
  modelDiscovery: { strategy: string; path: string; endpointProtocol: string };
  quota: { strategy: string; url: string };
  usagePolicyUrl: string;
  region: string;
}): AiProviderPoolSummary['offerings'][number] {
  return metadataWithoutUndefined({
    id: offering.id,
    label: offering.label,
    kind: offering.kind,
    lifecycle: offering.lifecycle,
    authModes: offering.authModes,
    runtimeProviderIds: offering.runtimeProviderIds,
    productLabel: offering.productLabel,
    credentialPrefixHints: offering.credentialPrefixHints,
    consoleUrl: offering.consoleUrl,
    subscriptionUrl: offering.subscriptionUrl,
    endpoints: offering.endpoints,
    modelDiscovery: offering.modelDiscovery,
    quota: offering.quota,
    usagePolicyUrl: offering.usagePolicyUrl,
    region: offering.region,
  }) as AiProviderPoolSummary['offerings'][number];
}

function publicPoolCredentialSummary(record: ConnectCredentialRecord): AiProviderCredentialSummary {
  const metadata = metadataFromRowValue(record.metadata) ?? {};
  return metadataWithoutUndefined({
    id: record.id,
    provider: normalizeProvider(record.provider),
    offeringId: record.offeringId ?? stringMetadata(metadata, 'offeringId') ?? defaultOfferingFor(record.provider, record.authMode) ?? 'api-platform',
    authMode: publicAuthMode(record.authMode),
    label: record.accountLabel,
    enabled: record.enabled ?? booleanMetadata(metadata, 'enabled') ?? record.status === 'active',
    priority: record.priority ?? numberMetadata(metadata, 'priority') ?? 100,
    health: publicCredentialHealth(record),
    maskedHint: stringMetadata(metadata, 'maskedHint'),
    baseUrl: stringMetadata(metadata, 'baseUrl'),
    proxyUrl: redactProviderProxyUrl(record.proxyUrl ?? stringMetadata(metadata, 'proxyUrl')),
    expiresAt: record.expiresAt?.toISOString(),
    version: record.version ?? 0,
    quota: metadata.quota ?? metadata.quotaStatus,
  }) as unknown as AiProviderCredentialSummary;
}

function publicAuthMode(authMode: ConnectCredentialRecord['authMode']): AiProviderCredentialSummary['authMode'] {
  return authMode === 'deviceCodeOAuth' ? 'deviceCode' : authMode;
}

function isOAuthProviderCredential(record: ConnectCredentialRecord): boolean {
  return record.status === 'active'
    && record.authMode === 'deviceCodeOAuth'
    && credentialOfferingId(record) === 'official-subscription';
}

function isKimiOAuthCredential(record: ConnectCredentialRecord): boolean {
  return normalizeProvider(record.provider) === 'kimi' && isOAuthProviderCredential(record);
}

function credentialOfferingId(record: ConnectCredentialRecord): string | undefined {
  const metadata = metadataFromRowValue(record.metadata) ?? {};
  return record.offeringId ?? stringMetadata(metadata, 'offeringId');
}

function publicCredentialHealth(record: ConnectCredentialRecord): AiProviderCredentialSummary['health'] {
  const metadata = metadataFromRowValue(record.metadata) ?? {};
  const health = record.health ?? stringMetadata(metadata, 'health');
  if (record.reauthRequired || health === 'reauthRequired') {
    return 'expired';
  }
  if (health === 'healthy') {
    return 'healthy';
  }
  if (health === 'error' || health === 'invalid') {
    return 'invalid';
  }
  if (health === 'unknown') {
    return 'unknown';
  }
  if (record.status === 'revoked' || health === 'disabled') {
    return 'unknown';
  }
  return record.status === 'active' ? 'healthy' : 'unknown';
}

function aggregateProviderPoolStatus(credentials: AiProviderCredentialSummary[]): AiProviderPoolSummary['status'] {
  if (credentials.length === 0) {
    return 'unconfigured';
  }
  if (credentials.some((credential) => credential.enabled && credential.health === 'healthy')) {
    return 'available';
  }
  if (credentials.some((credential) => credential.health === 'expired' || credential.health === 'invalid')) {
    return 'attention';
  }
  return 'configured';
}

function selectedModelsFromCredentials(credentials: ConnectCredentialRecord[]): AiGatewayModelSummary[] {
  const selected = new Map<string, AiGatewayModelSummary>();
  for (const credential of credentials) {
    if (credential.status !== 'active') {
      continue;
    }
    const metadata = metadataFromRowValue(credential.metadata);
    const provider = normalizeProvider(credential.provider);
    const models: AiGatewayModelSummary[] = credential.selectedModels
      ?? modelIdsFromMetadata(metadata).map((id) => ({ id, provider }));
    for (const model of models) {
      const publicModel = { ...model, provider: productProviderId(provider) };
      selected.set(
        publicModel.resourceId
          ?? `${publicModel.provider}:${publicModel.offeringId ?? ''}:${publicModel.id}`,
        publicModel,
      );
    }
    for (const custom of customModelsFromMetadata(metadata)) {
      selected.set(`${provider}:${custom.id}`, metadataWithoutUndefined({
        id: custom.id,
        provider,
        displayName: custom.displayName,
        custom: true,
        inputModalities: custom.inputModalities,
        outputModalities: custom.outputModalities,
        capabilities: custom.capabilities,
      }) as unknown as AiGatewayModelSummary);
    }
  }
  return [...selected.values()];
}

function localSessionImporterKey(provider: string, offeringId: string): string {
  return `${normalizeProvider(provider)}:${normalizeProvider(offeringId)}`;
}

function modelIdsFromMetadata(metadata: Record<string, unknown> | undefined): string[] {
  const ids = new Set<string>();
  const models = modelsFromMetadata(metadata) ?? [];
  for (const model of models) {
    ids.add(model);
  }
  const defaultModel = defaultModelFromMetadata(metadata);
  if (defaultModel) {
    ids.add(defaultModel);
  }
  return [...ids];
}

function createPoolCredentialLocator(
  webId: string,
  deployment: GatewayDeployment,
  provider: string,
): { credentialId: string; credentialIri: string } {
  const key = `${deployment}-${provider}-${nodeRandomUUID()}`;
  return {
    credentialId: credentialResource.buildId({ id: key }),
    credentialIri: credentialResource.buildIri(webId, { id: key }),
  };
}

function credentialKeyFromCanonicalIri(webId: string, credentialIri: string): string | undefined {
  try {
    const parsed = new URL(credentialIri);
    const key = decodeURIComponent(parsed.hash.slice(1));
    if (!key) {
      return undefined;
    }
    const canonicalIri = credentialResource.buildIri(webId, { id: key });
    return new URL(canonicalIri).href === parsed.href ? key : undefined;
  } catch {
    return undefined;
  }
}

function maskApiKey(apiKey: string): string | undefined {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return undefined;
  }
  const prefix = trimmed.slice(0, Math.min(3, trimmed.length));
  const suffix = trimmed.slice(-Math.min(4, trimmed.length));
  return `${prefix}...${suffix}`;
}

function metadataWithoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberMetadata(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanMetadata(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadata[key];
  return typeof value === 'boolean' ? value : undefined;
}

function createDefaultConnectedCredentialDb(input: {
  owner: string;
  auth?: AuthContext;
  fetch: typeof fetch;
  podUrl: string;
  credential?: typeof credentialResource;
  aiProvider?: typeof aiProviderResource;
  aiModel?: typeof aiModelResource;
}): Promise<ConnectedCredentialDb> {
  const credential = input.credential ?? credentialResource;
  const aiProvider = input.aiProvider ?? aiProviderResource;
  const aiModel = input.aiModel ?? aiModelResource;
  const podUrl = input.podUrl;
  return Promise.resolve(drizzle(
    {
      fetch: input.fetch,
      info: { webId: input.owner, podUrl, isLoggedIn: true },
    } as any,
    {
      schema: {
        credential,
        aiProvider,
        aiModel,
      },
      podUrl,
    },
  ) as unknown as ConnectedCredentialDb);
}

function credentialRowFromRecord(record: ConnectCredentialRecord): Record<string, unknown> {
  const metadata = metadataFromRowValue(record.metadata) ?? {};
  const normalizedProvider = normalizeProvider(record.provider);
  if (record.offeringId === undefined) {
    metadata.offeringId = metadata.offeringId ?? defaultOfferingFor(normalizedProvider, record.authMode);
  } else {
    metadata.offeringId = record.offeringId;
  }
  metadata.priority = record.priority ?? metadata.priority ?? 100;
  metadata.enabled = record.enabled ?? metadata.enabled ?? record.status === 'active';
  if (record.health !== undefined) {
    metadata.health = record.health;
  } else {
    metadata.health = rowHealthFromMetadata({ metadata })
      ?? (record.reauthRequired === true ? 'reauthRequired' : 'healthy');
  }
  if (record.proxyUrl !== undefined) {
    metadata.proxyUrl = normalizeProviderProxyUrl(record.proxyUrl);
  }
  return {
    id: record.id,
    owner: record.webId,
    provider: aiProviderResource.buildId({ id: normalizeProvider(record.provider) }),
    service: 'ai',
    authMode: record.authMode,
    status: record.status,
    encryptedSecret: JSON.stringify(record.encryptedSecret),
    wrappedDataKey: record.encryptedSecret.wrappedDek,
    encryptionAlgorithm: record.encryptedSecret.algorithm,
    keyVersion: String(record.version ?? 1),
    scopes: record.scopes ?? [],
    expiresAt: record.expiresAt,
    accountLabel: record.accountLabel,
    label: record.accountLabel,
    reauthRequired: record.reauthRequired ?? false,
    proxyUrl: normalizeProviderProxyUrl(record.proxyUrl ?? stringMetadata(metadata, 'proxyUrl')),
    lastRefreshAt: new Date(),
    metadata,
  };
}

function recordFromCredentialRow(row: Record<string, unknown>): ConnectCredentialRecord {
  const encrypted = parseEncryptedSecret(row.encryptedSecret);
  const id = stringFrom(row.id);
  const provider = providerFromRelation(stringFrom(row.provider))
    || providerFromCredentialId(id);
  const deployment = deploymentFromCredentialId(id);
  const webId = encrypted.webId;
  const status = stringFrom(row.status) === 'revoked' ? 'revoked' : 'active';
  const reauthRequired = row.reauthRequired === true || row.reauthRequired === 'true';
  const rowAuthMode = stringFrom(row.authMode);
  const authMode = rowAuthMode === 'deviceCodeOAuth' || rowAuthMode === 'local' ? rowAuthMode : 'apiKey';
  const rowMetadata = metadataFromRow(row) ?? {};
  const metadata = {
    ...rowMetadata,
    ...(typeof rowMetadata.baseUrl === 'string' || typeof row.baseUrl !== 'string'
      ? {}
      : { baseUrl: row.baseUrl }),
    ...(typeof rowMetadata.proxyUrl === 'string' || typeof row.proxyUrl !== 'string'
      ? {}
      : { proxyUrl: row.proxyUrl }),
  };
  return {
    id,
    credentialIri: encrypted.credentialIri,
    webId,
    provider,
    deployment,
    authMode,
    encryptedSecret: encrypted,
    status,
    accountLabel: stringFrom(row.accountLabel) || stringFrom(row.label) || undefined,
    expiresAt: dateFrom(row.expiresAt),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : undefined,
    version: versionFromRow(row),
    reauthRequired,
    proxyUrl: normalizeProviderProxyUrl(stringFrom(row.proxyUrl) ?? stringMetadata(metadata, 'proxyUrl')),
    metadata,
    priority: rowPriorityFromMetadata(row) ?? 100,
    offeringId: rowOfferingIdFromMetadata(row) ?? defaultOfferingFor(provider, authMode),
    enabled: rowEnabledFromMetadata(row) ?? status === 'active',
    health: rowHealthFromMetadata(row) ?? (reauthRequired ? 'reauthRequired' : 'healthy'),
  };
}

function compareCredentialRecords(left: ConnectCredentialRecord, right: ConnectCredentialRecord): number {
  return (left.priority ?? 100) - (right.priority ?? 100)
    || (right.version ?? 0) - (left.version ?? 0)
    || left.id.localeCompare(right.id);
}

function metadataFromRowValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rowOfferingIdFromMetadata(row: Record<string, unknown>): string | undefined {
  const metadata = metadataFromRow(row);
  const value = metadata?.offeringId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function rowPriorityFromMetadata(row: Record<string, unknown>): number | undefined {
  const metadata = metadataFromRow(row);
  const value = metadata?.priority;
  return typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function rowEnabledFromMetadata(row: Record<string, unknown>): boolean | undefined {
  const metadata = metadataFromRow(row);
  const value = metadata?.enabled;
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }
  return undefined;
}

function rowHealthFromMetadata(row: Record<string, unknown>): 'healthy' | 'reauthRequired' | 'disabled' | 'error' | 'invalid' | 'unknown' | undefined {
  const metadata = metadataFromRow(row);
  const value = metadata?.health;
  return value === 'healthy'
    || value === 'disabled'
    || value === 'error'
    || value === 'invalid'
    || value === 'unknown'
    || value === 'reauthRequired'
    ? value
    : undefined;
}

function providerFromRelation(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutFragment = value.split('#', 1)[0] ?? value;
  const fileName = withoutFragment.split('/').filter(Boolean).at(-1) ?? withoutFragment;
  const provider = fileName.replace(/\.ttl$/u, '');
  return provider ? normalizeProvider(provider) : undefined;
}

function isPodResourceNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\b404\b|not found/i.test(error.message);
}

function isCollectionQueryUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Document-mode collection queries over plain LDP are not supported/i.test(message)
    || /Invalid SPARQL endpoint response from .*HTTP status (?:404|405|501)\b/i.test(message);
}

async function selectResourceRowsBestEffort(
  db: ConnectedCredentialDb,
  resource: typeof aiProviderResource | typeof aiModelResource,
): Promise<{ rows: Record<string, unknown>[]; unsupported: boolean }> {
  try {
    const query = db.select().from(resource);
    if (!query.execute) {
      return { rows: [], unsupported: true };
    }
    return {
      rows: await query.execute(),
      unsupported: false,
    };
  } catch (error) {
    if (isCollectionQueryUnsupported(error)) {
      return { rows: [], unsupported: true };
    }
    throw error;
  }
}

async function findProviderRowsByReferences(
  db: ConnectedCredentialDb,
  aiProvider: typeof aiProviderResource,
  podBaseUrl: string,
  references: readonly string[],
): Promise<Record<string, unknown>[]> {
  const providerIds = [...new Set(references
    .map(providerResourceIdFromReference)
    .filter((providerId) => customProviderInstanceCredentialId(providerId) === undefined))];
  const rows: Record<string, unknown>[] = [];
  for (const providerId of providerIds) {
    const documentId = aiProviderResource.buildId({ id: providerId });
    const idCandidates = documentId.includes('#')
      ? [documentId]
      : [documentId, `${documentId}#this`];
    let row: Record<string, unknown> | null = null;
    for (const candidate of idCandidates) {
      try {
        row = await db.findById<Record<string, unknown>>(aiProvider, candidate);
      } catch (error) {
        if (!isPodResourceNotFound(error)) {
          throw error;
        }
      }
      if (row) break;
    }
    if (!row && db.findByIri) {
      for (const candidate of idCandidates.map((id) => aiProviderResource.buildIri(podBaseUrl, { id }))) {
        try {
          row = await db.findByIri<Record<string, unknown>>(aiProvider, candidate);
        } catch (error) {
          if (!isPodResourceNotFound(error)) {
            throw error;
          }
        }
        if (row) break;
      }
    }
    if (row) rows.push(row);
  }
  return rows;
}

function providerResourceIdFromReference(value: string): string {
  const withoutFragment = value.split('#', 1)[0] ?? value;
  const fileName = withoutFragment.slice(withoutFragment.lastIndexOf('/') + 1);
  const documentId = fileName.endsWith('.ttl') ? fileName : `${fileName}.ttl`;
  const fragmentIndex = value.indexOf('#');
  return fragmentIndex < 0 ? documentId : `${documentId}${value.slice(fragmentIndex)}`;
}

function metadataFromRow(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = row.metadata;
  if (!value) {
    return undefined;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface CustomProviderModel {
  id: string;
  displayName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
}

export function customModelsFromMetadata(metadata: Record<string, unknown> | undefined): CustomProviderModel[] {
  const value = metadata?.customModels;
  if (!Array.isArray(value)) {
    return [];
  }
  const models: CustomProviderModel[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) {
      continue;
    }
    const displayName = typeof record.displayName === 'string' && record.displayName.trim()
      ? record.displayName
      : undefined;
    const inputModalities = stringList(record.inputModalities);
    const outputModalities = stringList(record.outputModalities);
    const capabilities = stringList(record.capabilities);
    models.push({
      id: record.id,
      ...(displayName ? { displayName } : {}),
      ...(inputModalities.length > 0 ? { inputModalities } : {}),
      ...(outputModalities.length > 0 ? { outputModalities } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
    });
  }
  return models;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))];
}

function modelsFromMetadata(metadata: Record<string, unknown> | undefined): string[] | undefined {
  const value = metadata?.models;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

async function selectedModelReferencesFromProviderRow(
  db: ConnectedCredentialDb,
  aiModel: typeof aiModelResource,
  row: Record<string, unknown>,
  provider: string,
  podBaseUrl: string,
  modelRows: readonly Record<string, unknown>[],
): Promise<AiGatewayModelSummary[]> {
  const raw = row?.hasModel;
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const resourceIds = [...new Set(values.filter((value): value is string =>
    typeof value === 'string' && Boolean(value.trim())))];
  const models: AiGatewayModelSummary[] = [];
  for (const resourceId of resourceIds) {
    const row = await findActiveModelRow(db, aiModel, resourceId, podBaseUrl, modelRows);
    if (!row) {
      continue;
    }
    models.push(modelSummaryFromResourceReference(resourceId, provider, row));
  }
  return models;
}

async function selectedModelReferencesFromPodResource(
  podFetch: typeof fetch,
  podBaseUrl: string,
  provider: string,
): Promise<AiGatewayModelSummary[]> {
  const compactId = aiProviderResource.buildId({ id: provider });
  const resourceIri = aiProviderResource.buildIri(podBaseUrl, { id: compactId });
  const resourceUrl = resourceIri.split('#', 1)[0] ?? resourceIri;
  let response: Response;
  try {
    response = await podFetch(resourceUrl, { headers: { accept: 'text/turtle' } });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let quads: N3Quad[];
  try {
    const turtle = await response.text();
    quads = new N3Parser({ baseIRI: resourceUrl }).parse(turtle);
  } catch {
    return [];
  }
  const legacyResourceIds = quads
    .filter((quad) => /(?:#|\/)hasModel$/u.test(quad.predicate.value))
    .map((quad) => quad.object.value)
    .filter(Boolean);
  const canonicalProviderIri = resourceUrl.replace(/#.*$/u, '');
  const canonicalResourceIds = quads
    .filter((quad) => (
      /(?:#|\/)isProvidedBy$/u.test(quad.predicate.value)
      && quad.object.value.replace(/#.*$/u, '') === canonicalProviderIri
    ))
    .map((quad) => quad.subject.value)
    .filter(Boolean);
  const resourceIds = [...new Set([...legacyResourceIds, ...canonicalResourceIds])];
  return resourceIds
    .filter((resourceId) => parsedModelStatus(quads, resourceId) === 'active')
    .map((resourceId) => modelSummaryFromResourceReference(resourceId, provider));
}

async function findActiveModelRow(
  db: ConnectedCredentialDb,
  aiModel: typeof aiModelResource,
  resourceId: string,
  podBaseUrl: string,
  modelRows: readonly Record<string, unknown>[],
): Promise<Record<string, unknown> | undefined> {
  const localId = localModelResourceId(resourceId, podBaseUrl);
  if (!localId) {
    return undefined;
  }
  const candidateIds = [localId];
  try {
    const decodedLocalId = decodeURIComponent(localId);
    if (decodedLocalId !== localId) candidateIds.push(decodedLocalId);
  } catch {
    // The validated local ID may still contain a malformed escape. The exact
    // candidate remains safe to try without suppressing the IRI fallback.
  }
  const candidateIdSet = new Set([resourceId, ...candidateIds]);
  const collectionMatches = modelRows.filter((row) => candidateIdSet.has(String(row.id ?? '')));
  if (collectionMatches.length > 0) {
    return collectionMatches.find((row) => row.status === 'active');
  }
  for (const candidateId of candidateIds) {
    try {
      const row = await db.findById<Record<string, unknown>>(aiModel, candidateId);
      if (row?.status === 'active') {
        return row;
      }
    } catch {
      // drizzle-solid can reject one serialization while accepting another
      // canonical representation of the same compound resource ID.
    }
  }
  try {
    const row = await db.findByIri?.<Record<string, unknown>>(aiModel, resourceId) ?? null;
    return row?.status === 'active' ? row : undefined;
  } catch {
    return undefined;
  }
}

function localModelResourceId(value: string, podBaseUrl: string): string | undefined {
  try {
    const podRoot = new URL(`${podBaseUrl.replace(/\/$/u, '')}/`);
    const providerDirectory = new URL('settings/providers/', podRoot);
    const resource = new URL(value, providerDirectory);
    const document = resource.pathname.slice(resource.pathname.lastIndexOf('/') + 1);
    if (
      (resource.protocol !== 'http:' && resource.protocol !== 'https:')
      || resource.origin !== providerDirectory.origin
      || resource.username
      || resource.password
      || resource.search
      || resource.pathname.slice(0, resource.pathname.lastIndexOf('/') + 1) !== providerDirectory.pathname
      || !/^(?:[a-z0-9._-]|%23)+\.ttl$/iu.test(document)
      || resource.hash.length < 2
    ) {
      return undefined;
    }
    return `${document}${resource.hash}`;
  } catch {
    return undefined;
  }
}

function modelSummaryFromResourceReference(
  resourceId: string,
  provider: string,
  row?: Record<string, unknown>,
): AiGatewayModelSummary {
  return metadataWithoutUndefined({
    id: modelIdFromResourceReference(resourceId),
    provider,
    offeringId: offeringIdFromProviderReference(resourceId, provider),
    resourceId,
    displayName: typeof row?.displayName === 'string' && row.displayName ? row.displayName : undefined,
  }) as unknown as AiGatewayModelSummary;
}

function parsedModelStatus(
  quads: readonly N3Quad[],
  resourceId: string,
): string | undefined {
  const match = quads.find((quad) => (
    quad.subject.value === resourceId
    && /(?:#|\/)status$/u.test(quad.predicate.value)
  ));
  return match?.object.value;
}

function modelIdFromResourceReference(value: string): string {
  const fragment = value.includes('#') ? value.slice(value.lastIndexOf('#') + 1) : value;
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function providerIdFromResourceReference(value: string): string | undefined {
  const withoutFragment = value.split('#', 1)[0] ?? value;
  const fileName = withoutFragment.slice(withoutFragment.lastIndexOf('/') + 1);
  if (!fileName.endsWith('.ttl')) return undefined;
  try {
    return decodeURIComponent(fileName.slice(0, -4));
  } catch {
    return fileName.slice(0, -4);
  }
}

function productProviderId(provider: string): string {
  const normalized = normalizeProvider(provider);
  return customProviderProductId(normalized)
    ?? normalizeProvider(providerProductFor(normalized)?.id ?? normalized);
}

function offeringIdFromProviderReference(value: string, provider: string): string | undefined {
  if (customProviderInstanceCredentialId(value)) {
    return undefined;
  }
  const withoutFragment = value.split('#', 1)[0] ?? value;
  const fileName = withoutFragment.split('/').filter(Boolean).at(-1) ?? withoutFragment;
  const key = fileName.replace(/\.ttl$/u, '');
  const productId = productProviderId(provider);
  if (!key || key === productId || !key.startsWith(`${productId}-`)) return undefined;
  const offeringId = key.slice(productId.length + 1);
  if (productId === 'bailian') {
    if (offeringId === 'token-plan-personal') return 'token-plan';
    if (offeringId === 'coding-plan-pro') return 'coding-plan';
  }
  return offeringId;
}

function defaultModelFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.defaultModel;
  return typeof value === 'string' ? value : undefined;
}

function runtimeCredentialFromMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = metadata?.runtimeCredential;
  const runtime = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  const proxyUrl = stringMetadata(metadata ?? {}, 'proxyUrl');
  if (proxyUrl && runtime.proxy === undefined) runtime.proxy = proxyUrl;
  const providerMetadata = metadataWithoutUndefined({
    offeringId: stringMetadata(metadata ?? {}, 'offeringId'),
    source: stringMetadata(metadata ?? {}, 'source'),
    accountId: stringMetadata(metadata ?? {}, 'accountId'),
  });
  if (Object.keys(providerMetadata).length > 0) {
    runtime.metadata = {
      ...providerMetadata,
      ...(runtime.metadata && typeof runtime.metadata === 'object' && !Array.isArray(runtime.metadata)
        ? runtime.metadata as Record<string, unknown>
        : {}),
    };
  }
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function parseEncryptedSecret(value: unknown): EncryptedCredentialSecret {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Credential row is missing encrypted secret payload');
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Credential row encrypted secret payload is invalid');
  }
  return parsed as EncryptedCredentialSecret;
}

function parseCredentialRows(rows: Record<string, unknown>[]): ConnectCredentialRecord[] {
  return rows.flatMap(parseCredentialRow);
}

function parseCredentialRow(row: Record<string, unknown>): ConnectCredentialRecord[] {
  try {
    return [recordFromCredentialRow(row)];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid credential row ${stringFrom(row.id) || '<unknown>'}: ${detail}`, {
      cause: error,
    });
  }
}

function versionFromRow(row: Record<string, unknown>): number {
  const value = row.keyVersion;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function providerFromCredentialId(id: string): string {
  const match = /\/([^/#]+)\.ttl#/u.exec(id);
  return match?.[1] ?? '';
}

function deploymentFromCredentialId(id: string): GatewayDeployment {
  return id.includes('#cloud-') ? 'cloud' : 'local';
}

function dateFrom(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function signAttempt(
  attempt: Pick<ConnectAttempt, 'id' | 'provider' | 'deployment' | 'webId' | 'mode' | 'state' | 'expiresAt'>,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify({
      id: attempt.id,
      provider: attempt.provider,
      deployment: attempt.deployment,
      webId: attempt.webId,
      mode: attempt.mode,
      state: attempt.state,
      expiresAt: attempt.expiresAt.toISOString(),
    }))
    .digest('base64url');
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function principal(webId: string): GatewayPrincipal {
  return { webId };
}

function cloneAttempt(attempt: ConnectAttempt): ConnectAttempt {
  return {
    ...attempt,
    expiresAt: new Date(attempt.expiresAt),
    consumedAt: attempt.consumedAt ? new Date(attempt.consumedAt) : undefined,
    nextPollAt: attempt.nextPollAt ? new Date(attempt.nextPollAt) : undefined,
    pollClaimedAt: attempt.pollClaimedAt ? new Date(attempt.pollClaimedAt) : undefined,
  };
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function queryProviderIds(provider: string): Set<string> {
  const normalized = normalizeProvider(provider);
  if (normalized === 'custom') {
    return new Set(['custom', 'custom-openai-compatible', 'custom-anthropic-compatible']);
  }
  const product = providerProductFor(normalized);
  if (!product || normalizeProvider(product.id) !== normalized) {
    return new Set([normalized]);
  }
  return new Set([
    normalizeProvider(product.id),
    ...product.offerings.map((offering) => normalizeProvider(`${product.id}-${offering.id}`)),
    ...product.offerings.flatMap((offering) => offering.runtimeProviderIds.map(normalizeProvider)),
  ]);
}

function providerMatchesQuery(
  storedProvider: string,
  requestedProvider: string,
  queryIds: ReadonlySet<string> = queryProviderIds(requestedProvider),
): boolean {
  const normalizedStored = normalizeProvider(storedProvider);
  if (queryIds.has(normalizedStored)) {
    return true;
  }
  return normalizeProvider(requestedProvider) === 'custom'
    && customProviderProductId(normalizedStored) === 'custom';
}

function providerAllowedByConfiguredIds(provider: string, configuredProviderIds: ReadonlySet<string>): boolean {
  const normalized = normalizeProvider(provider);
  if (configuredProviderIds.has(normalized)) {
    return true;
  }
  if (customProviderProductId(normalized) === 'custom' && configuredProviderIds.has('custom')) {
    return true;
  }
  const product = providerProductFor(normalized);
  return product ? configuredProviderIds.has(normalizeProvider(product.id)) : false;
}

function providerProductFor(provider: string): typeof DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS[number] | undefined {
  const normalized = normalizeProvider(provider);
  return DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS.find((product) =>
    normalizeProvider(product.id) === normalized
    || product.offerings.some((offering) => (
      normalizeProvider(`${product.id}-${offering.id}`) === normalized
    ))
    || product.offerings.some((offering) =>
      offering.runtimeProviderIds.some((runtimeProviderId) => normalizeProvider(runtimeProviderId) === normalized)));
}

function runtimeProviderId(provider: string): string {
  const normalized = normalizeProvider(provider);
  const customProduct = customProviderProductId(normalized);
  if (customProduct) return customProduct;
  const explicitRuntimeProvider = DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS.some((product) => (
    product.offerings.some((offering) => offering.runtimeProviderIds.some(
      (runtimeId) => normalizeProvider(runtimeId) === normalized,
    ))
  ));
  if (explicitRuntimeProvider) return normalized;
  const storageProduct = DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS.find((product) => (
    product.offerings.some((offering) => (
      normalizeProvider(`${product.id}-${offering.id}`) === normalized
    ))
  ));
  return storageProduct ? normalizeProvider(storageProduct.id) : normalized;
}

function customProviderProductId(provider: string): 'custom' | undefined {
  return provider === 'custom'
    || provider === 'custom-openai-compatible'
    || provider === 'custom-anthropic-compatible'
    || customProviderInstanceCredentialId(provider) !== undefined
    ? 'custom'
    : undefined;
}

function customProviderInstanceCredentialId(provider: string): string | undefined {
  const normalized = normalizeProvider(provider);
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
  const withoutResourceFragment = fileName.endsWith('#this')
    ? fileName.slice(0, -'#this'.length)
    : fileName;
  const resourceKey = withoutResourceFragment.endsWith('.ttl')
    ? withoutResourceFragment.slice(0, -'.ttl'.length)
    : withoutResourceFragment;
  if (!resourceKey.startsWith('custom-instance-')) {
    return undefined;
  }
  const encodedCredentialId = resourceKey.slice('custom-instance-'.length);
  if (!encodedCredentialId) {
    return undefined;
  }
  let credentialId: string;
  try {
    credentialId = decodeURIComponent(encodedCredentialId);
  } catch {
    return undefined;
  }
  const [documentId, fragment] = credentialId.split('#', 2);
  return documentId?.endsWith('.ttl') && Boolean(fragment)
    ? credentialId
    : undefined;
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    if (response.ok) {
      throw new Error('Provider returned an empty JSON response');
    }
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (response.ok) {
        throw new Error('Provider returned a non-object JSON response');
      }
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    if (response.ok) {
      throw new Error('Provider returned invalid JSON');
    }
    return {};
  }
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function expiresAtFrom(expiresIn: unknown, now: Date): Date | undefined {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return undefined;
  }
  return new Date(now.getTime() + expiresIn * 1000);
}

function oneTimeOAuthCredential(
  body: Record<string, unknown>,
  now: Date,
  expectedVersion?: number,
): OneTimeOAuthCredential {
  requireStringField(body, 'access_token');
  requireStringField(body, 'refresh_token');
  return {
    accessToken: stringFrom(body.access_token)!,
    refreshToken: stringFrom(body.refresh_token)!,
    expiresAt: expiresAtFrom(body.expires_in, now)?.toISOString(),
    scope: stringFrom(body.scope),
    idToken: stringFrom(body.id_token),
    accountSubject: decodeJwtSubject(stringFrom(body.id_token)),
    expectedVersion,
  };
}

function safeProviderError(body: Record<string, unknown>): string {
  const code = stringFrom(body.error);
  if (SAFE_PROVIDER_ERROR_CODES.has(code)) {
    return code;
  }
  if (!code) {
    return 'provider_error';
  }
  if (code.endsWith('_error')) {
    return 'provider_error';
  }
  return 'provider_error';
}

const SAFE_PROVIDER_ERROR_CODES = new Set([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'invalid_grant',
  'invalid_client',
]);

function pendingResult(
  input: PollDeviceInput,
  status: ConnectAttemptStatus,
  intervalSeconds?: number,
): ConnectBeginResult {
  return {
    mode: 'deviceCodeOAuth',
    status,
    provider: 'kimi',
    deployment: input.deployment,
    attemptId: input.attemptId,
    intervalSeconds,
  };
}

function assertKimiEndpoint(endpoint: string, pathname: string): void {
  const url = new URL(endpoint);
  if (
    url.origin !== 'https://auth.kimi.com'
    || url.pathname !== pathname
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error('Kimi Connect endpoint is not allowlisted');
  }
}

function requireStringField(body: Record<string, unknown>, field: string): void {
  if (typeof body[field] !== 'string' || !(body[field] as string).trim()) {
    throw new Error(`Provider response missing required field: ${field}`);
  }
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /version_conflict|credential_version_conflict/u.test(error.message);
}

function decodeJwtSubject(idToken: string): string | undefined {
  const payload = idToken.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof decoded.sub === 'string' ? decoded.sub : undefined;
  } catch {
    return undefined;
  }
}

function defaultOfferingFor(provider: string, authMode?: ConnectCredentialRecord['authMode']): string | undefined {
  const normalized = normalizeProvider(provider);
  const product = providerProductFor(normalized);
  if (!product) {
    return undefined;
  }
  if (normalized === normalizeProvider(product.id)) {
    const preferredKind = authMode === 'apiKey' ? 'api-platform' : authMode === 'local' ? 'local' : 'oauth-subscription';
    const standardOffering = product.offerings.find((offering) =>
      offering.kind === preferredKind && offeringMatchesAuthMode(offering.authModes, authMode));
    if (standardOffering) return standardOffering.id;
  }
  const runtimeOffering = product.offerings.find((offering) =>
    offering.runtimeProviderIds.some((runtimeProviderId) => normalizeProvider(runtimeProviderId) === normalized)
    && offeringMatchesAuthMode(offering.authModes, authMode));
  if (runtimeOffering) {
    return runtimeOffering.id;
  }
  return product.offerings.find((offering) => offeringMatchesAuthMode(offering.authModes, authMode))?.id
    ?? product.offerings.at(0)?.id;
}

function requireApiKeyOffering(provider: string, offeringId: string | undefined): string {
  const normalized = normalizeProvider(provider);
  const product = providerProductFor(normalized);
  const resolvedOfferingId = offeringId ?? defaultOfferingFor(normalized, 'apiKey');
  const offering = product?.offerings.find((candidate) =>
    normalizeProvider(candidate.id) === normalizeProvider(resolvedOfferingId ?? ''));
  if (!resolvedOfferingId || !offering || !offering.authModes.includes('apiKey')) {
    throw new GatewayProtocolError('Provider offering is not compatible with API key credentials', {
      code: 'invalid_request',
      status: 400,
      details: {
        provider: normalized,
        ...(offeringId ? { offeringId } : {}),
      },
    });
  }
  return offering.id;
}

function offeringMatchesAuthMode(
  offeringAuthModes: readonly string[],
  authMode: ConnectCredentialRecord['authMode'] | undefined,
): boolean {
  if (!authMode) {
    return true;
  }
  if (authMode === 'apiKey') {
    return offeringAuthModes.includes('apiKey');
  }
  if (authMode === 'local') return offeringAuthModes.includes('local');
  return offeringAuthModes.includes('oauth') || offeringAuthModes.includes('deviceCode');
}

async function updateByCredentialIdAndVersion(params: {
  db: ConnectedCredentialDb;
  credential: typeof credentialResource;
  credentialId: string;
  expectedVersion: string;
  patch: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const { db, credential, credentialId, expectedVersion, patch } = params;
  const updated = await db
    .update(credential)
    .set({ ...patch })
    .where(and(eq(credential.id, credentialId), eq(credential.keyVersion, expectedVersion)))
    .returning()
    .execute();
  if (updated.length === 1) {
    return updated[0] as Record<string, unknown>;
  }
  return null;
}
