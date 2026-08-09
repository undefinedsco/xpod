import { createHash, createHmac, randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID, timingSafeEqual } from 'node:crypto';
import { alias, and, drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  aiProviderResource,
  aiRuntimeRepository,
  credentialResource,
} from '@undefineds.co/models';
import type { EncryptedCredentialSecret } from '../credentials/KeyWrapper';
import type { CredentialVault, GatewayPrincipal, ProviderSecret } from '../credentials/CredentialVault';
import type { GatewayDeployment } from '../auth/GatewayApiKey';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import { DEFAULT_PROVIDER_DESCRIPTORS } from '../providers/ProviderRegistry';
import type { AuthContext } from '../../auth/AuthContext';
import type { InternalPodAccessTokenProvider } from '../auth/PodGatewayAccessKeyRepository';

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
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  intervalSeconds?: number;
  apiKeyManagementSupported?: boolean;
  credentialId?: string;
  message?: string;
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
  auth?: AuthContext;
}

export interface DisconnectInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  auth?: AuthContext;
}

export interface UpdateConnectionInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  /** Omit to leave unchanged; empty string clears the override. */
  baseUrl?: string;
  expectedVersion?: number;
  auth?: AuthContext;
}

export interface ConnectCredentialRecord {
  id: string;
  credentialIri: string;
  webId: string;
  provider: string;
  deployment: GatewayDeployment;
  authMode: 'apiKey' | 'deviceCodeOAuth';
  encryptedSecret: EncryptedCredentialSecret;
  status: 'active' | 'revoked';
  accountLabel?: string;
  expiresAt?: Date;
  scopes?: string[];
  expectedVersion?: number;
  version?: number;
  reauthRequired?: boolean;
  metadata?: Record<string, unknown>;
  baseUrl?: string | null;
  offeringId?: string;
  priority?: number;
  enabled?: boolean;
  health?: 'healthy' | 'reauthRequired' | 'disabled' | 'error';
}

export interface ProviderCredentialQuery {
  webId: string;
  provider: string;
  deployment: GatewayDeployment;
  auth?: AuthContext;
}

export interface PodCredentialRepository {
  listProviderCredentials?: (input: ProviderCredentialQuery) => Promise<ConnectCredentialRecord[]>;
  getCredentialById?: (input: ProviderCredentialQuery & { credentialId: string }) => Promise<ConnectCredentialRecord | undefined>;
  createCredential?: (record: ConnectCredentialRecord, context?: { auth?: AuthContext }) => Promise<ConnectCredentialRecord>;
  updateCredential?: (record: ConnectCredentialRecord, context?: { auth?: AuthContext }) => Promise<ConnectCredentialRecord | undefined>;
  revokeCredential?: (input: ProviderCredentialQuery & { credentialId: string }) => Promise<ConnectCredentialRecord | undefined>;
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
    from(resource: typeof credentialResource): {
      where(condition: unknown): { execute(): Promise<Record<string, unknown>[]> };
    };
  };
  findById<TRow>(resource: typeof credentialResource, id: string): Promise<TRow | null>;
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
  providerIds?: string[];
  dbFactory?: (input: {
    owner: string;
    auth?: AuthContext;
    fetch: typeof fetch;
    credential?: typeof credentialResource;
    aiProvider?: typeof aiProviderResource;
  }) => Promise<ConnectedCredentialDb>;
}

export class PodConnectedCredentialRepository implements PodCredentialRepository {
  private readonly dbFactory: NonNullable<PodConnectedCredentialRepositoryOptions['dbFactory']>;
  private readonly internalPodAccess?: InternalPodAccessTokenProvider;
  private readonly providerIds: string[];
  private readonly credentialTemplate: typeof credentialResource;
  private readonly aiProviderTemplate: typeof aiProviderResource;

  public constructor(options: PodConnectedCredentialRepositoryOptions = {}) {
    this.internalPodAccess = options.internalPodAccess;
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
    const legacyId = aiRuntimeRepository.credentialId(input);
    const legacy = await this.getCredentialById({ ...input, credentialId: legacyId });
    if (legacy) {
      return legacy;
    }
    const candidates = await this.listProviderCredentials({
      webId: input.webId,
      provider: input.provider,
      deployment: input.deployment,
      auth: input.auth,
    });
    const provider = normalizeProvider(input.provider);
    const active = candidates.find((candidate) => candidate.provider === provider
      && candidate.deployment === input.deployment
      && candidate.status === 'active');
    if (active) {
      return active;
    }
    return candidates[0];
  }

  public async getActiveCredential(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined> {
    const records = await this.findCredentialRows(input, false);
    const provider = normalizeProvider(input.provider);
    const candidate = records.find((record) => record.provider === provider
      && record.deployment === input.deployment
      && record.status === 'active'
      && !record.reauthRequired);
    return candidate ?? undefined;
  }

  public async listCredentials(input: {
    webId: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<Array<{
    id: string;
    credentialIri: string;
    provider: string;
    authMode: 'apiKey' | 'deviceCodeOAuth';
    enabled: boolean;
    priority?: number;
    models?: string[];
    customModels?: CustomProviderModel[];
    defaultModel?: string;
    health?: 'healthy' | 'reauthRequired' | 'disabled' | 'error';
    quota?: { status: 'available' | 'unsupported' | 'exhausted' | 'error' };
    encryptedSecret: EncryptedCredentialSecret;
    version?: number;
    runtimeCredential?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>> {
    const records = (await this.findCredentialRows(input, false))
      .filter((record) => this.providerIds.includes(record.provider));
    return records
      .filter((record) => record.webId === input.webId)
      .filter((record) => record.deployment === input.deployment)
      .filter((record) => record.status === 'active')
      .sort(compareCredentialRecords)
      .map((record) => ({
        id: record.id,
        credentialIri: record.credentialIri,
        provider: record.provider,
        authMode: record.authMode,
        enabled: record.enabled ?? !record.reauthRequired,
        models: modelsFromMetadata(record.metadata),
        customModels: customModelsFromMetadata(record.metadata),
        defaultModel: defaultModelFromMetadata(record.metadata),
        priority: priorityFromMetadata(record.metadata) ?? record.priority,
        health: record.health ?? (record.reauthRequired ? 'reauthRequired' : 'healthy'),
        quota: { status: 'available' },
        encryptedSecret: record.encryptedSecret,
        version: record.version,
        runtimeCredential: {
          ...runtimeCredentialFromMetadata(record.metadata),
          ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        },
        metadata: record.metadata
          ? {
            ...record.metadata,
            ...(record.offeringId !== undefined ? { offeringId: record.offeringId } : {}),
            ...(record.priority !== undefined ? { priority: record.priority } : {}),
            ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
            ...(record.health !== undefined ? { health: record.health } : {}),
          }
          : (record.offeringId || record.priority !== undefined || record.enabled !== undefined || record.health)
            ? {
              ...(record.offeringId !== undefined ? { offeringId: record.offeringId } : {}),
              ...(record.priority !== undefined ? { priority: record.priority } : {}),
              ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
              ...(record.health !== undefined ? { health: record.health } : {}),
            }
            : undefined,
      }));
  }

  public async listProviderCredentials(input: ProviderCredentialQuery): Promise<ConnectCredentialRecord[]> {
    return this.findCredentialRows(
      {
      webId: input.webId,
      provider: input.provider,
      deployment: input.deployment,
      auth: input.auth,
      },
      true,
    ).then((records) => records.sort(compareCredentialRecords));
  }

  public async getCredentialById(input: ProviderCredentialQuery & { credentialId: string }): Promise<ConnectCredentialRecord | undefined> {
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const row = await db.findById<Record<string, unknown>>(credential, input.credentialId);
    const record = row ? recordFromCredentialRow(row) : undefined;
    if (!record) {
      return undefined;
    }
    if (record.webId !== input.webId || record.deployment !== input.deployment || record.provider !== normalizeProvider(input.provider)) {
      return undefined;
    }
    return record;
  }

  public async createCredential(
    record: ConnectCredentialRecord,
    context?: { auth?: AuthContext },
  ): Promise<ConnectCredentialRecord> {
    const { db, credential } = await this.dbForOwner(record.webId, context?.auth);
    const baseId = record.id && record.id.trim() ? record.id : `${nodeRandomUUID()}`;
    const id = baseId.includes('#')
      ? baseId
      : `credentials.ttl#${record.deployment}-${normalizeProvider(record.provider)}-${baseId}`;
    const withDefaults = normalizeCredentialMetadataDefaults(record);
    const row = credentialRowFromRecord({ ...withDefaults, id, version: Math.max((record.version ?? 0), 1) });
    await db.insert(credential).values(row).execute();
    return recordFromCredentialRow(row);
  }

  public async updateCredential(
    record: ConnectCredentialRecord,
    context?: { auth?: AuthContext },
  ): Promise<ConnectCredentialRecord | undefined> {
    const current = await this.getCredentialById({
      webId: record.webId,
      provider: record.provider,
      deployment: record.deployment,
      credentialId: record.id,
      auth: context?.auth,
    });
    if (!current) {
      return undefined;
    }
    if (record.expectedVersion !== undefined && record.expectedVersion !== current.version) {
      throw new Error('credential_version_conflict');
    }
    const nextVersion = (current.version ?? 0) + 1;
    const withDefaults = normalizeCredentialMetadataDefaults(record);
    const dbForOwner = await this.dbForOwner(record.webId, context?.auth);
    const row = credentialRowFromRecord({ ...withDefaults, version: nextVersion });
    const updated = await dbForOwner.db.updateById<Record<string, unknown>>(
      dbForOwner.credential,
      withDefaults.id,
      row,
    );
    return updated ? recordFromCredentialRow(updated) : undefined;
  }

  public async revokeCredential(
    input: ProviderCredentialQuery & { credentialId: string },
  ): Promise<ConnectCredentialRecord | undefined> {
    const record = await this.getCredentialById(input);
    if (!record) {
      return undefined;
    }
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const nextVersion = (record.version ?? 0) + 1;
    const next = {
      ...record,
      status: 'revoked' as const,
      enabled: false,
      expectedVersion: record.version,
      version: nextVersion,
    };
    const metadata = {
      ...(record.metadata ?? {}),
      enabled: false,
      health: 'disabled',
    };
    const updated = await db.updateById<Record<string, unknown>>(credential, record.id, {
      ...credentialRowFromRecord(next),
      metadata,
      keyVersion: String(nextVersion),
    });
    return updated ? recordFromCredentialRow(updated) : undefined;
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
    if (current.webId !== input.webId || current.deployment !== input.deployment) {
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
    const provider = normalizeProvider(input.provider);
    const candidates = await this.findCredentialRows({
      webId: input.webId,
      provider,
      deployment: input.deployment,
      auth: input.auth,
    }, false);
    const existing = candidates.find((candidate) => candidate.provider === provider
      && candidate.deployment === input.deployment
      && candidate.status === 'active');
    if (!existing) {
      return undefined;
    }
    const existingVersion = existing.version ?? 0;
    if (input.expectedVersion !== undefined && input.expectedVersion !== existingVersion) {
      throw new Error('credential_version_conflict');
    }
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const metadata = {
      ...existing.metadata,
      health: 'reauthRequired',
      reauthReason: input.reason,
    };
    const updated = await db.updateById<Record<string, unknown>>(credential, existing.id, {
      reauthRequired: true,
      status: 'active',
      metadata,
      keyVersion: String(existingVersion + 1),
    });
    return updated ? recordFromCredentialRow(updated) : undefined;
  }

  public async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    const provider = normalizeProvider(input.provider);
    const candidates = await this.findCredentialRows({
      webId: input.webId,
      provider,
      deployment: input.deployment,
      auth: input.auth,
    }, false);
    const existing = candidates.find((candidate) => candidate.provider === provider
      && candidate.deployment === input.deployment
      && candidate.status === 'active');
    if (!existing) {
      return undefined;
    }
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const updated = await db.updateById<Record<string, unknown>>(credential, existing.id, {
      reauthRequired: true,
      status: 'revoked',
      metadata: {
        ...(existing.metadata ?? {}),
        enabled: false,
      },
      keyVersion: String((existing.version ?? 0) + 1),
    });
    return updated ? recordFromCredentialRow(updated) : undefined;
  }

  private async findCredentialRows(
    input: {
      webId: string;
      provider?: string;
      deployment: GatewayDeployment;
      auth?: AuthContext;
    },
    includeRevoked: boolean,
  ): Promise<ConnectCredentialRecord[]> {
    const provider = input.provider ? normalizeProvider(input.provider) : undefined;
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const rows = await (db.select().from(credential) as unknown as {
      where: (_condition: unknown) => { execute: () => Promise<Record<string, unknown>[]> };
    }).where(eq(credential.id, credential.id)).execute();
    return rows
      .map((row) => recordFromCredentialRow(row as Record<string, unknown>))
      .filter((record) => record.webId === undefined || record.webId === input.webId)
      .filter((record) => !provider || record.provider === provider)
      .filter((record) => record.deployment === input.deployment)
      .filter((record) => includeRevoked || record.status === 'active');
  }

  private async dbForOwner(owner: string, auth?: AuthContext): Promise<{
    db: ConnectedCredentialDb;
    credential: typeof credentialResource;
  }> {
    const trustedFetch = await this.resolveTrustedFetch(owner);
    const credential = alias(this.credentialTemplate, 'credential');
    const aiProvider = alias(this.aiProviderTemplate, 'aiProvider');
    const db = await this.dbFactory({ owner, auth, fetch: trustedFetch, credential, aiProvider });
    await db.init?.(credential, aiProvider);
    return { db, credential };
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
  deviceCode?: string;
  codeVerifier?: string;
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
    const baseUrl = normalizeBaseUrlOverride(input.baseUrl);
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
      baseUrl,
      expectedVersion: consumed.expectedCredentialVersion,
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
  clientId: string;
  deviceAuthorizationEndpoint?: string;
  tokenEndpoint?: string;
}

export class KimiDeviceCodeConnectAdapter extends BrowserAssistedApiKeyConnectAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly deviceAuthorizationEndpoint: string;
  private readonly tokenEndpoint: string;

  public constructor(options: KimiDeviceCodeConnectAdapterOptions) {
    super({
      ...options,
      provider: 'kimi',
      consoleUrl: 'https://kimi.moonshot.cn/device',
    });
    this.fetchImpl = options.fetch ?? fetch;
    this.clientId = options.clientId;
    this.deviceAuthorizationEndpoint = options.deviceAuthorizationEndpoint ?? 'https://auth.moonshot.cn/oauth/device_authorization';
    this.tokenEndpoint = options.tokenEndpoint ?? 'https://auth.moonshot.cn/oauth/token';
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
    requireStringField(body, 'verification_uri');
    requireStringField(body, 'verification_uri_complete');
    const intervalSeconds = numberFrom(body.interval, 5);
    const expiresIn = numberFrom(body.expires_in, 300);
    const attempt = await this.createAttempt(input, new Date(now.getTime() + expiresIn * 1000), {
      mode: 'deviceCodeOAuth',
      codeVerifier: verifier,
      deviceCode: stringFrom(body.device_code),
      intervalSeconds,
      currentPollIntervalSeconds: intervalSeconds,
      nextPollAt: new Date(now.getTime() + intervalSeconds * 1000),
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
      userCode: stringFrom(body.user_code),
      verificationUri: stringFrom(body.verification_uri),
      verificationUriComplete: stringFrom(body.verification_uri_complete),
      intervalSeconds,
    };
  }

  public async pollDevice(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const attempt = await this.loadConsumableAttempt(input, 'deviceCodeOAuth');
    const now = this.now();
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
          const status = stringFrom(body.error) as ConnectAttemptStatus;
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
          await this.attempts.consume(input.attemptId, now);
          return pendingResult(input, 'expired');
        }
        throw new Error(`Kimi device token failed: ${safeProviderError(body)}`);
      }
      await this.attempts.consume(input.attemptId, now);
      requireStringField(body, 'access_token');
      requireStringField(body, 'refresh_token');
      const record = await this.storeOAuthCredential(input, body, attempt.expectedCredentialVersion);
      return {
        mode: 'deviceCodeOAuth',
        status: 'completed',
        provider: 'kimi',
        deployment: input.deployment,
        attemptId: input.attemptId,
        credentialId: record.id,
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
    return this.storeOAuthCredential(input, body, current.version);
  }

  public override async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    return this.credentialRepository.disconnect({
      webId: input.webId,
      provider: 'kimi',
      deployment: input.deployment,
      auth: input.auth,
    });
  }

  private async storeOAuthCredential(
    input: { webId: string; deployment: GatewayDeployment; auth?: AuthContext },
    body: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<ConnectCredentialRecord> {
    const credentialIri = aiRuntimeRepository.credentialIri(input.webId, {
      deployment: input.deployment,
      provider: 'kimi',
    });
    const encryptedSecret = await this.vault.seal(
      principal(input.webId),
      credentialIri,
      'kimi',
      {
        type: 'deviceCodeOAuth',
        accessToken: stringFrom(body.access_token),
        refreshToken: stringFrom(body.refresh_token),
        expiresAt: expiresAtFrom(body.expires_in, this.now)?.toISOString(),
        scope: stringFrom(body.scope),
        idToken: stringFrom(body.id_token),
      },
    );
    return this.credentialRepository.upsertConnectedCredential({
      id: aiRuntimeRepository.credentialId({ deployment: input.deployment, provider: 'kimi' }),
      credentialIri,
      webId: input.webId,
      provider: 'kimi',
      deployment: input.deployment,
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      expectedVersion,
    });
  }
}


export class DeepSeekConnectAdapter implements ProviderConnectAdapter {
  public readonly provider = 'deepseek';

  public async begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    if (normalizeProvider(input.provider) !== this.provider) {
      throw new Error('Connect provider mismatch');
    }
    return {
      mode: 'connectUnsupported',
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
  credentialRepository?: PodCredentialRepository;
  vault?: CredentialVault;
}

export interface ProviderConnectionSummary {
  provider: string;
  status: 'connected' | 'disconnected' | 'reauthRequired';
  authMode?: 'apiKey' | 'deviceCodeOAuth';
  accountLabel?: string;
  baseUrl?: string;
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

export class ProviderConnectService {
  private readonly registry: ProviderRegistry;
  private readonly credentialRepository?: PodCredentialRepository;
  private readonly vault?: CredentialVault;
  private readonly adapters = new Map<string, ProviderConnectAdapter>();

  public constructor(options: ProviderConnectServiceOptions) {
    this.registry = options.registry;
    this.credentialRepository = options.credentialRepository;
    this.vault = options.vault;
    for (const adapter of options.adapters) {
      this.adapters.set(normalizeProvider(adapter.provider), adapter);
    }
  }

  public begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    const descriptor = this.registry.requireProvider(input.provider);
    if (descriptor.connect?.mode !== input.requestedMode) {
      throw new Error('Requested Connect mode does not match provider capability');
    }
    if (descriptor.connect?.configured === false) {
      return Promise.resolve({
        mode: descriptor.connect.mode,
        status: 'unsupported',
        provider: normalizeProvider(input.provider),
        deployment: input.deployment,
        apiKeyManagementSupported: descriptor.connect.apiKeyManagementSupported,
        message: descriptor.connect.notes?.join(' '),
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
        baseUrl: active ? credential.baseUrl ?? undefined : undefined,
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
    const current = await this.credentialRepository.getActiveCredential(input);
    if (!current) {
      throw new Error('Active provider credential not found');
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
        const latest = await this.credentialRepository.getActiveCredential(input);
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

  public async updateConnection(input: UpdateConnectionInput): Promise<ConnectCredentialRecord> {
    if (!this.credentialRepository?.getCredential) {
      throw new Error('PodCredentialRepository is required for connection updates');
    }
    const provider = normalizeProvider(input.provider);
    const current = await this.credentialRepository.getCredential({
      webId: input.webId,
      provider,
      deployment: input.deployment,
      auth: input.auth,
    });
    if (!current || current.status !== 'active') {
      throw new Error('Active provider credential not found');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new Error('credential_version_conflict');
    }

    const next: ConnectCredentialRecord = {
      ...current,
      expectedVersion: current.version,
    };
    if (input.baseUrl !== undefined) {
      next.baseUrl = normalizeBaseUrlOverride(input.baseUrl) ?? null;
    }

    return this.credentialRepository.upsertConnectedCredential(next, { auth: input.auth });
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

function normalizeBaseUrlOverride(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https');
  }
  return trimmed;
}

function createDefaultConnectedCredentialDb(input: {
  owner: string;
  auth?: AuthContext;
  fetch: typeof fetch;
  credential?: typeof credentialResource;
  aiProvider?: typeof aiProviderResource;
}): Promise<ConnectedCredentialDb> {
  const credential = input.credential ?? credentialResource;
  const aiProvider = input.aiProvider ?? aiProviderResource;
  return Promise.resolve(drizzle(
    {
      fetch: input.fetch,
      info: { webId: input.owner, isLoggedIn: true },
    } as any,
    {
      schema: {
        credential,
        aiProvider,
      },
    },
  ) as unknown as ConnectedCredentialDb);
}

function credentialRowFromRecord(record: ConnectCredentialRecord): Record<string, unknown> {
  const metadata = {
    ...(record.metadata ?? {}),
    ...(record.offeringId !== undefined ? { offeringId: record.offeringId } : {}),
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
    ...(record.health !== undefined ? { health: record.health } : {}),
  };
  return {
    id: record.id,
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
    baseUrl: record.baseUrl === undefined ? undefined : (record.baseUrl ?? null),
    reauthRequired: record.reauthRequired ?? false,
    lastRefreshAt: new Date(),
    metadata: metadataFromRecord(metadata),
  };
}

function recordFromCredentialRow(row: Record<string, unknown>): ConnectCredentialRecord {
  const encrypted = parseEncryptedSecret(row.encryptedSecret);
  const id = stringFrom(row.id);
  const provider = providerFromRelation(stringFrom(row.provider))
    || providerFromCredentialId(id);
  const deployment = deploymentFromCredentialId(id);
  const webId = encrypted.webId;
  return {
    id,
    credentialIri: encrypted.credentialIri,
    webId,
    provider,
    deployment,
    authMode: stringFrom(row.authMode) === 'deviceCodeOAuth' ? 'deviceCodeOAuth' : 'apiKey',
    encryptedSecret: encrypted,
    status: stringFrom(row.status) === 'revoked' ? 'revoked' : 'active',
    accountLabel: stringFrom(row.accountLabel) || stringFrom(row.label) || undefined,
    expiresAt: dateFrom(row.expiresAt),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : undefined,
    version: versionFromRow(row),
    reauthRequired: row.reauthRequired === true || row.reauthRequired === 'true',
    offeringId: stringMetadata(recordFromMetadata(row).offeringId),
    priority: numberMetadata(recordFromMetadata(row).priority),
    enabled: booleanMetadata(recordFromMetadata(row).enabled),
    health: healthFromMetadata(recordFromMetadata(row).health),
    metadata: metadataFromRow(row),
    baseUrl: stringFrom(row.baseUrl) || undefined,
  };
}

function metadataFromRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function recordFromMetadata(record: Record<string, unknown> | undefined): Record<string, unknown> {
  return metadataFromRow(record as Record<string, unknown>) ?? {};
}

function normalizeCredentialMetadataDefaults(record: ConnectCredentialRecord): ConnectCredentialRecord {
  const metadata = metadataFromRow({ metadata: record.metadata } as Record<string, unknown>) ?? {};
  return {
    ...record,
    offeringId: stringMetadata(metadata.offeringId) ?? record.offeringId,
    priority: numberMetadata(metadata.priority) ?? record.priority ?? 100,
    enabled: booleanMetadata(metadata.enabled) ?? record.enabled ?? record.status === 'active',
    health: stringMetadata(metadata.health) as 'healthy' | 'reauthRequired' | 'disabled' | 'error' | undefined
      ?? record.health
      ?? (record.reauthRequired ? 'reauthRequired' : 'healthy'),
  };
}

function compareCredentialRecords(a: ConnectCredentialRecord, b: ConnectCredentialRecord): number {
  const aPriority = numberMetadata(a.priority) ?? 100;
  const bPriority = numberMetadata(b.priority) ?? 100;
  if (aPriority !== bPriority) {
    return aPriority - bPriority;
  }
  const aVersion = a.version ?? 0;
  const bVersion = b.version ?? 0;
  if (aVersion !== bVersion) {
    return bVersion - aVersion;
  }
  return a.id.localeCompare(b.id);
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

function defaultModelFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.defaultModel;
  return typeof value === 'string' ? value : undefined;
}

function priorityFromMetadata(metadata: Record<string, unknown> | undefined): number | undefined {
  const value = metadata?.priority;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function healthFromMetadata(value: unknown): 'healthy' | 'reauthRequired' | 'disabled' | 'error' | undefined {
  const health = stringMetadata(value);
  return health === 'healthy' || health === 'reauthRequired' || health === 'disabled' || health === 'error'
    ? health
    : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanMetadata(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function runtimeCredentialFromMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = metadata?.runtimeCredential;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseEncryptedSecret(value: unknown): EncryptedCredentialSecret {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Credential row is missing encrypted secret payload');
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Credential row encrypted secret payload is invalid');
  }
  return parsed as EncryptedCredentialSecret;
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

function expiresAtFrom(value: unknown, now: () => Date): Date | undefined {
  const seconds = numberFrom(value, 0);
  return seconds > 0 ? new Date(now().getTime() + seconds * 1000) : undefined;
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function requireStringField(body: Record<string, unknown>, field: string): string {
  const value = stringFrom(body[field]);
  if (!value) {
    throw new Error(`Provider response missing required field: ${field}`);
  }
  return value;
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



function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /version_conflict|credential_version_conflict/u.test(error.message);
}
