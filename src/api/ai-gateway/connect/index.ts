import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { alias, and, drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  aiProviderResource,
  aiRuntimeRepository,
  credentialResource,
} from '@undefineds.co/models';
import type { ProviderSecret } from '../credentials/CredentialVault';
import {
  decodePlaintextCredential,
  encodePlaintextCredential,
  PLAINTEXT_CREDENTIAL_STORAGE_MODE,
  UnsupportedCredentialStorageModeError,
} from '../credentials/PlaintextCredentialPayload';
import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import { DEFAULT_PROVIDER_DESCRIPTORS } from '../providers/ProviderRegistry';
import type { AuthContext } from '../../auth/AuthContext';
import type { InternalPodAccessTokenProvider } from '../pod/HostedPodDataAccess';

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

export interface ConnectCredentialRecord {
  id: string;
  credentialIri: string;
  webId: string;
  provider: string;
  deployment: GatewayDeployment;
  authMode: 'apiKey' | 'deviceCodeOAuth';
  storageMode: 'plaintext-v1';
  secretPayload: string;
  status: 'active' | 'revoked';
  accountLabel?: string;
  expiresAt?: Date;
  scopes?: string[];
  expectedVersion?: number;
  version?: number;
  reauthRequired?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PodCredentialRepository {
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
  deleteById(resource: typeof credentialResource, id: string): Promise<boolean>;
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
    podUrl: string;
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
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const match = await this.findCredentialRow(db, credential, input);
    const row = match?.row;
    const record = row ? recordFromCredentialRow(row, input.webId) : undefined;
    if (!record) {
      return undefined;
    }
    return record;
  }

  public async getActiveCredential(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined> {
    const record = await this.getCredential(input);
    return record?.status === 'active' && !record.reauthRequired ? record : undefined;
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
    defaultModel?: string;
    health?: 'healthy' | 'reauthRequired' | 'disabled' | 'error';
    quota?: { status: 'available' | 'unsupported' | 'exhausted' | 'error' };
    storageMode: 'plaintext-v1';
    secretPayload: string;
    version?: number;
    runtimeCredential?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>> {
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const rows = (await Promise.all(
      this.providerIds.map(async (provider) => {
        const match = await this.findCredentialRow(db, credential, {
          deployment: input.deployment,
          provider,
        });
        return match?.row ?? null;
      }),
    )).filter((row): row is Record<string, unknown> => row !== null);
    return rows
      .flatMap((row) => {
        try {
          return [recordFromCredentialRow(row, input.webId)];
        } catch (error) {
          if (error instanceof UnsupportedCredentialStorageModeError) {
            return [];
          }
          throw error;
        }
      })
      .filter((record) => record.webId === input.webId)
      .filter((record) => record.deployment === input.deployment)
      .filter((record) => record.status === 'active')
      .map((record) => ({
        id: record.id,
        credentialIri: record.credentialIri,
        provider: record.provider,
        authMode: record.authMode,
        enabled: !record.reauthRequired,
        models: modelsFromMetadata(record.metadata),
        defaultModel: defaultModelFromMetadata(record.metadata),
        priority: priorityFromMetadata(record.metadata),
        health: record.reauthRequired ? 'reauthRequired' : 'healthy',
        quota: { status: 'available' },
        storageMode: record.storageMode,
        secretPayload: record.secretPayload,
        version: record.version,
        runtimeCredential: runtimeCredentialFromMetadata(record.metadata),
        metadata: record.metadata,
      }));
  }

  public async upsertConnectedCredential(
    record: ConnectCredentialRecord,
    context?: { auth?: AuthContext },
  ): Promise<ConnectCredentialRecord> {
    const { db, credential } = await this.dbForOwner(record.webId, context?.auth);
    const match = await this.findCredentialRow(db, credential, record);
    const existing = match?.row;
    const existingId = match?.id ?? record.id;
    const existingVersion = existing ? versionFromRow(existing) : 0;
    const replacesUnsupportedRecord = Boolean(existing)
      && stringFrom(existing?.storageMode) !== PLAINTEXT_CREDENTIAL_STORAGE_MODE;
    if (!replacesUnsupportedRecord
      && record.expectedVersion !== undefined
      && record.expectedVersion !== existingVersion) {
      throw new Error('credential_version_conflict');
    }
    const nextVersion = existingVersion + 1;
    const row = credentialRowFromRecord({
      ...record,
      version: nextVersion,
    });
    if (existing && (existingId !== record.id || isLegacyCredentialId(existingId))) {
      const { id: _canonicalId, ...patch } = row;
      try {
        const updated = await db.updateById<Record<string, unknown>>(credential, existingId, patch);
        if (!updated) {
          throw new Error('legacy credential resource was not updated');
        }
        return recordFromCredentialRow(updated, record.webId);
      } catch (error) {
        throw credentialPersistenceError('legacy-update', error);
      }
    }
    if (existing) {
      try {
        const deleted = await db.deleteById(credential, existingId);
        if (!deleted) {
          throw new Error('exact credential resource was not deleted');
        }
      } catch (error) {
        throw credentialPersistenceError('replace-delete', error);
      }
      try {
        await db.insert(credential).values(row).execute();
      } catch (error) {
        try {
          await db.insert(credential).values(existing).execute();
        } catch (rollbackError) {
          throw credentialPersistenceError('replace-insert-rollback', rollbackError);
        }
        throw credentialPersistenceError('replace-insert', error);
      }
      return recordFromCredentialRow(row, record.webId);
    }
    try {
      await db.insert(credential).values(row).execute();
    } catch (error) {
      throw credentialPersistenceError('insert', error);
    }
    return recordFromCredentialRow(row, record.webId);
  }

  public async markReauthRequired(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    reason: string;
    expectedVersion?: number;
    auth?: AuthContext;
  }): Promise<ConnectCredentialRecord | undefined> {
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const match = await this.findCredentialRow(db, credential, input);
    const id = match?.id ?? aiRuntimeRepository.credentialId(input);
    const existing = match?.row;
    if (!existing) {
      return undefined;
    }
    const existingVersion = versionFromRow(existing);
    if (input.expectedVersion !== undefined && input.expectedVersion !== existingVersion) {
      throw new Error('credential_version_conflict');
    }
    const updated = await db.updateById<Record<string, unknown>>(credential, id, {
      reauthRequired: true,
      status: 'active',
      keyVersion: String(existingVersion + 1),
    });
    return updated ? recordFromCredentialRow(updated, input.webId) : undefined;
  }

  public async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const match = await this.findCredentialRow(db, credential, input);
    const id = match?.id ?? aiRuntimeRepository.credentialId(input);
    const existing = match?.row;
    if (!existing) {
      return undefined;
    }
    const updated = await db.updateById<Record<string, unknown>>(credential, id, {
      status: 'revoked',
      keyVersion: String(versionFromRow(existing) + 1),
    });
    return updated ? recordFromCredentialRow(updated, input.webId) : undefined;
  }

  private async dbForOwner(owner: string, auth?: AuthContext): Promise<{
    db: ConnectedCredentialDb;
    credential: typeof credentialResource;
  }> {
    const trustedFetch = await this.resolveTrustedFetch(owner, auth);
    const credential = alias(this.credentialTemplate, 'credential');
    const aiProvider = alias(this.aiProviderTemplate, 'aiProvider');
    const podUrl = podUrlFromHostedWebId(owner);
    const db = await this.dbFactory({ owner, podUrl, auth, fetch: trustedFetch, credential, aiProvider });
    await db.init?.(credential, aiProvider);
    return { db, credential };
  }

  private async findCredentialRow(
    db: ConnectedCredentialDb,
    credential: typeof credentialResource,
    input: { deployment: GatewayDeployment; provider: string },
  ): Promise<{ id: string; row: Record<string, unknown> } | undefined> {
    for (const id of credentialIdCandidates(input)) {
      try {
        const row = await db.findById<Record<string, unknown>>(credential, id);
        if (row) {
          return { id, row };
        }
      } catch (error) {
        if (!isPodResourceNotFound(error)) {
          throw error;
        }
      }
    }
    return undefined;
  }

  private async resolveTrustedFetch(owner: string, auth?: AuthContext): Promise<typeof fetch> {
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(owner, auth);
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
  protected readonly deployment: GatewayDeployment;
  protected readonly now: () => Date;
  protected readonly randomBytes: (bytes: number) => Buffer;
  private readonly signingSecret: string;

  public constructor(options: BrowserAssistedApiKeyConnectAdapterOptions) {
    this.provider = normalizeProvider(options.provider);
    this.consoleUrl = options.consoleUrl;
    this.attempts = options.attempts;
    this.credentialRepository = options.credentialRepository;
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
    const secretPayload = encodePlaintextCredential({ type: 'apiKey', apiKey: input.apiKey });
    const record = await this.credentialRepository.upsertConnectedCredential({
      id: aiRuntimeRepository.credentialId({ deployment: input.deployment, provider: this.provider }),
      credentialIri,
      webId: input.webId,
      provider: this.provider,
      deployment: input.deployment,
      authMode: 'apiKey',
      storageMode: PLAINTEXT_CREDENTIAL_STORAGE_MODE,
      secretPayload,
      status: 'active',
      accountLabel: input.accountLabel,
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
    this.deviceAuthorizationEndpoint = options.deviceAuthorizationEndpoint ?? 'https://auth.kimi.com/api/oauth/device_authorization';
    this.tokenEndpoint = options.tokenEndpoint ?? 'https://auth.kimi.com/api/oauth/token';
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

  private nowForConsume(): Date {
    return this.now();
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
    const expiresAt = expiresAtFrom(body.expires_in, this.now());
    const secret: ProviderSecret = {
      type: 'deviceCodeOAuth',
      accessToken: stringFrom(body.access_token),
      refreshToken: stringFrom(body.refresh_token),
      expiresAt: expiresAt?.toISOString(),
      scope: stringFrom(body.scope),
      idToken: stringFrom(body.id_token),
    };
    return this.credentialRepository.upsertConnectedCredential({
      id: aiRuntimeRepository.credentialId({ deployment: input.deployment, provider: 'kimi' }),
      credentialIri,
      webId: input.webId,
      provider: 'kimi',
      deployment: input.deployment,
      authMode: 'deviceCodeOAuth',
      storageMode: PLAINTEXT_CREDENTIAL_STORAGE_MODE,
      secretPayload: encodePlaintextCredential(secret),
      status: 'active',
      expiresAt,
      expectedVersion,
      metadata: {
        authoritativeSubject: decodeJwtSubject(stringFrom(body.id_token)),
      },
    }, { auth: input.auth });
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
}

export interface ProviderConnectionSummary {
  provider: string;
  status: 'connected' | 'disconnected' | 'reauthRequired';
  authMode?: 'apiKey' | 'deviceCodeOAuth';
  accountLabel?: string;
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
  private readonly adapters = new Map<string, ProviderConnectAdapter>();

  public constructor(options: ProviderConnectServiceOptions) {
    this.registry = options.registry;
    this.credentialRepository = options.credentialRepository;
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
      let credential: ConnectCredentialRecord | undefined;
      try {
        credential = this.credentialRepository?.getCredential
          ? await this.credentialRepository.getCredential({
            ...input,
            provider: descriptor.id,
          })
          : await this.credentialRepository?.getActiveCredential({
            ...input,
            provider: descriptor.id,
          });
      } catch (error) {
        if (!(error instanceof UnsupportedCredentialStorageModeError)) {
          throw error;
        }
      }
      const activeCredential = credential?.status === 'active' ? credential : undefined;
      const reauthRequired = activeCredential?.reauthRequired === true;
      const modes = Array.from(new Set([
        ...descriptor.authModes.filter((mode) => mode !== 'connectUnsupported'),
        ...(descriptor.connect?.apiKeyManagementSupported ? ['apiKey'] : []),
      ]));
      return {
        provider: descriptor.id,
        status: reauthRequired
          ? 'reauthRequired' as const
          : activeCredential
            ? 'connected' as const
            : 'disconnected' as const,
        authMode: activeCredential?.authMode,
        accountLabel: activeCredential?.accountLabel,
        expiresAt: activeCredential?.expiresAt?.toISOString(),
        reauthRequired: reauthRequired || undefined,
        credentialIri: activeCredential?.credentialIri,
        version: activeCredential?.version,
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
    if (!this.credentialRepository) {
      throw new Error('PodCredentialRepository is required for provider refresh');
    }
    const current = await this.credentialRepository.getActiveCredential(input);
    if (!current) {
      throw new Error('Active provider credential not found');
    }
    const secret = decodePlaintextCredential(current);
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

function createDefaultConnectedCredentialDb(input: {
  owner: string;
  podUrl: string;
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
      info: { webId: input.owner, podUrl: input.podUrl, isLoggedIn: true },
    } as any,
    {
      schema: {
        credential,
        aiProvider,
      },
      podUrl: input.podUrl,
    },
  ) as unknown as ConnectedCredentialDb);
}

function podUrlFromHostedWebId(webId: string): string {
  const ownerUrl = new URL(webId);
  if (ownerUrl.hash !== '#me' || !ownerUrl.pathname.endsWith('/profile/card')) {
    throw new Error('hosted_pod_owner_url_invalid');
  }
  const podPath = ownerUrl.pathname.slice(0, -'profile/card'.length);
  if (!podPath || !podPath.endsWith('/')) {
    throw new Error('hosted_pod_owner_url_invalid');
  }
  return new URL(podPath, ownerUrl.origin).href;
}

function credentialRowFromRecord(record: ConnectCredentialRecord): Record<string, unknown> {
  return {
    id: record.id,
    provider: aiProviderResource.buildId({ id: normalizeProvider(record.provider) }),
    service: 'ai',
    authMode: record.authMode,
    status: record.status,
    storageMode: record.storageMode,
    secretPayload: record.secretPayload,
    keyVersion: String(record.version ?? 1),
    scopes: record.scopes ?? [],
    expiresAt: record.expiresAt,
    accountLabel: record.accountLabel,
    label: record.accountLabel,
    reauthRequired: record.reauthRequired ?? false,
    lastRefreshAt: new Date(),
  };
}

function recordFromCredentialRow(row: Record<string, unknown>, owner: string): ConnectCredentialRecord {
  const storageMode = stringFrom(row.storageMode) === PLAINTEXT_CREDENTIAL_STORAGE_MODE
    ? PLAINTEXT_CREDENTIAL_STORAGE_MODE
    : stringFrom(row.storageMode);
  const secretPayload = typeof row.secretPayload === 'string' ? row.secretPayload : '';
  decodePlaintextCredential({
    storageMode,
    secretPayload,
    encryptedSecret: row.encryptedSecret,
    wrappedDataKey: row.wrappedDataKey,
    encryptionAlgorithm: row.encryptionAlgorithm,
  });
  const id = stringFrom(row.id);
  const provider = providerFromRelation(stringFrom(row.provider))
    || providerFromCredentialId(id);
  const deployment = deploymentFromCredentialId(id);
  const credentialIri = stringFrom(row.credentialIri)
    || aiRuntimeRepository.credentialIri(owner, { deployment, provider });
  return {
    id,
    credentialIri,
    webId: owner,
    provider,
    deployment,
    authMode: stringFrom(row.authMode) === 'deviceCodeOAuth' ? 'deviceCodeOAuth' : 'apiKey',
    storageMode: PLAINTEXT_CREDENTIAL_STORAGE_MODE,
    secretPayload,
    status: stringFrom(row.status) === 'revoked' ? 'revoked' : 'active',
    accountLabel: stringFrom(row.accountLabel) || stringFrom(row.label) || undefined,
    expiresAt: dateFrom(row.expiresAt),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : undefined,
    version: versionFromRow(row),
    reauthRequired: row.reauthRequired === true || row.reauthRequired === 'true',
    metadata: metadataFromRow(row),
  };
}

function providerFromRelation(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const fragmentIndex = value.lastIndexOf('#');
  if (fragmentIndex >= 0 && fragmentIndex < value.length - 1) {
    return normalizeProvider(value.slice(fragmentIndex + 1));
  }
  const withoutFragment = value.split('#', 1)[0] ?? value;
  const fileName = withoutFragment.split('/').filter(Boolean).at(-1) ?? withoutFragment;
  const provider = fileName.replace(/\.ttl$/u, '');
  return provider ? normalizeProvider(provider) : undefined;
}

function credentialPersistenceError(stage: string, cause: unknown): Error {
  return new Error(`credential_persistence_failed:${stage}`, { cause });
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

function runtimeCredentialFromMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = metadata?.runtimeCredential;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
  const key = credentialIdKey(id);
  if (!key) {
    return '';
  }
  const match = /^(?:local|cloud)-([a-z0-9][a-z0-9-]*)$/u.exec(key);
  if (!match) {
    return '';
  }
  const provider = match[1].replace(/^local-cloud-/u, '');
  return provider ? normalizeProvider(provider) : '';
}

function credentialIdCandidates(input: {
  deployment: GatewayDeployment;
  provider: string;
}): string[] {
  const canonical = aiRuntimeRepository.credentialId(input);
  const legacyCommentedEdition = aiRuntimeRepository.credentialId({
    deployment: `${input.deployment}-local-cloud` as GatewayDeployment,
    provider: input.provider,
  });
  return canonical === legacyCommentedEdition
    ? [canonical]
    : [canonical, legacyCommentedEdition];
}

function isLegacyCredentialId(id: string): boolean {
  const key = credentialIdKey(id);
  return key ? /^(?:local|cloud)-local-cloud-[a-z0-9][a-z0-9-]*$/u.test(key) : false;
}

function credentialIdKey(id: string): string | undefined {
  const fragmentIndex = id.lastIndexOf('#');
  if (fragmentIndex < 0) {
    return undefined;
  }
  const resourcePath = id.slice(0, fragmentIndex);
  if (resourcePath !== 'credentials.ttl' && !resourcePath.endsWith('/credentials.ttl')) {
    return undefined;
  }
  return id.slice(fragmentIndex + 1) || undefined;
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

function expiresAtFrom(expiresIn: unknown, now: Date): Date | undefined {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return undefined;
  }
  return new Date(now.getTime() + expiresIn * 1000);
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
