import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { alias, and, drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  aiProviderResource,
  aiRuntimeRepository,
  credentialResource,
} from '@undefineds.co/models';
import type { CredentialVault, GatewayPrincipal, ProviderSecret, StoredCredentialSecret } from '../credentials/CredentialVault';
import type { GatewayDeployment } from '../auth/GatewayApiKey';
import type { ProviderDescriptor, ProviderRegistry } from '../providers/ProviderRegistry';
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
  baseUrl?: string;
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
  credentialSecret: StoredCredentialSecret;
  status: 'active' | 'revoked';
  accountLabel?: string;
  expiresAt?: Date;
  scopes?: string[];
  expectedVersion?: number;
  version?: number;
  reauthRequired?: boolean;
  metadata?: Record<string, unknown>;
  baseUrl?: string;
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
  findById<TRow>(resource: typeof credentialResource | typeof aiProviderResource, id: string): Promise<TRow | null>;
  resolveRowIri?(resource: typeof credentialResource, row: Record<string, unknown>): string;
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
    const { db, credential, aiProvider } = await this.dbForOwner(input.webId, input.auth);
    const provider = normalizeProvider(input.provider);
    const runtimeId = aiRuntimeRepository.credentialId(input);
    const defaultId = credential.buildId({ id: `${provider}-default` });
    const row = await db.findById<Record<string, unknown>>(credential, runtimeId)
      ?? await db.findById<Record<string, unknown>>(credential, defaultId);
    const credentialIri = row
      ? db.resolveRowIri?.(credential, row)
        ?? credential.buildIri(input.webId, { id: stringFrom(row.id) })
      : undefined;
    const record = row && credentialIri
      ? recordFromCredentialRow(row, {
          credentialIri,
          deployment: input.deployment,
          provider,
          webId: input.webId,
        })
      : undefined;
    if (!record) {
      return undefined;
    }
    const providerRow = await db.findById<Record<string, unknown>>(
      aiProvider,
      aiProvider.buildId({ id: provider }),
    );
    const baseUrl = stringFrom(providerRow?.baseUrl) || stringFrom(row?.baseUrl);
    return { ...record, ...(baseUrl ? { baseUrl } : {}) };
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
    provider?: string;
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
    credentialSecret: StoredCredentialSecret;
    version?: number;
    runtimeCredential?: Record<string, unknown>;
    runtimeCapabilities?: string[];
    metadata?: Record<string, unknown>;
  }>> {
    const { db, credential, aiProvider } = await this.dbForOwner(input.webId, input.auth);
    const providerIds = Array.from(new Set([
      ...this.providerIds,
      ...(input.provider ? [normalizeProvider(input.provider)] : []),
    ]));
    const rows = (await Promise.all(
      providerIds.map(async (provider) => {
        try {
          const runtimeCredentialId = aiRuntimeRepository.credentialId({ deployment: input.deployment, provider });
          const defaultCredentialId = credential.buildId({ id: `${provider}-default` });
          const row = await db.findById<Record<string, unknown>>(credential, runtimeCredentialId)
            ?? await db.findById<Record<string, unknown>>(credential, defaultCredentialId);
          if (!row) return null;
          const providerRow = await db.findById<Record<string, unknown>>(
            aiProvider,
            aiProvider.buildId({ id: provider }),
          );
          return {
            row,
            providerRow,
          };
        } catch (error) {
          if (isPodResourceNotFound(error)) {
            return null;
          }
          throw error;
        }
      }),
    )).filter((entry): entry is { row: Record<string, unknown>; providerRow: Record<string, unknown> | null } => entry !== null);
    return rows
      .map(({ row, providerRow }) => ({ record: recordFromCredentialRow(row), providerRow }))
      .filter(({ record }) => record.webId === input.webId)
      .filter(({ record }) => record.deployment === input.deployment)
      .filter(({ record }) => record.status === 'active')
      .map(({ record, providerRow }) => ({
        record,
        runtimeCapabilities: runtimeCapabilitiesFromProviderRow(providerRow),
        runtimeCredential: {
          ...runtimeCredentialFromMetadata(record.metadata),
          ...(record.baseUrl
            ? { baseUrl: record.baseUrl }
            : typeof providerRow?.baseUrl === 'string'
              ? { baseUrl: providerRow.baseUrl }
              : {}),
        },
      }))
      .map(({ record, runtimeCredential, runtimeCapabilities }) => ({
        id: record.id,
        credentialIri: record.credentialIri,
        provider: record.provider,
        authMode: record.authMode,
        enabled: !record.reauthRequired,
        models: modelsFromMetadata(record.metadata),
        customModels: customModelsFromMetadata(record.metadata),
        defaultModel: defaultModelFromMetadata(record.metadata),
        priority: priorityFromMetadata(record.metadata),
        health: record.reauthRequired ? 'reauthRequired' : 'healthy',
        quota: { status: 'available' },
        credentialSecret: record.credentialSecret,
        version: record.version,
        runtimeCredential,
        runtimeCapabilities,
        metadata: record.metadata,
      }));
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
      // Some Pod repositories intentionally omit secret-bearing columns from
      // UPDATE ... RETURNING.  The just-sealed payload in `row` is still the
      // authoritative value for this write, so merge the returned public
      // fields over it instead of trying to decode a redacted row.
      return recordFromCredentialRow({ ...row, ...(updated ?? {}) });
    }
    await db.insert(credential).values(row).execute();
    return recordFromCredentialRow(row);
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
    const id = aiRuntimeRepository.credentialId(input);
    const existing = await db.findById<Record<string, unknown>>(credential, id);
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
    return updated ? recordFromCredentialRow(updated) : undefined;
  }

  public async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    const { db, credential } = await this.dbForOwner(input.webId, input.auth);
    const id = aiRuntimeRepository.credentialId(input);
    const existing = await db.findById<Record<string, unknown>>(credential, id);
    if (!existing) {
      return undefined;
    }
    const updated = await db.updateById<Record<string, unknown>>(credential, id, {
      status: 'revoked',
      keyVersion: String(versionFromRow(existing) + 1),
    });
    return updated ? recordFromCredentialRow(updated) : undefined;
  }

  private async dbForOwner(owner: string, auth?: AuthContext): Promise<{
    db: ConnectedCredentialDb;
    credential: typeof credentialResource;
    aiProvider: typeof aiProviderResource;
  }> {
    const trustedFetch = await this.resolveTrustedFetch(owner);
    const credential = alias(this.credentialTemplate, 'credential');
    const aiProvider = alias(this.aiProviderTemplate, 'aiProvider');
    const db = await this.dbFactory({ owner, auth, fetch: trustedFetch, credential, aiProvider });
    await db.init?.(credential, aiProvider);
    return { db, credential, aiProvider };
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
    const storedSecret = await this.vault.seal(
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
      credentialSecret: storedSecret,
      status: 'active',
      accountLabel: input.accountLabel,
      baseUrl: input.baseUrl,
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
  dynamicApiKeyAdapter?: (provider: string) => ProviderConnectAdapter;
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
  private readonly vault?: CredentialVault;
  private readonly dynamicApiKeyAdapter?: (provider: string) => ProviderConnectAdapter;
  private readonly adapters = new Map<string, ProviderConnectAdapter>();

  public constructor(options: ProviderConnectServiceOptions) {
    this.registry = options.registry;
    this.credentialRepository = options.credentialRepository;
    this.vault = options.vault;
    this.dynamicApiKeyAdapter = options.dynamicApiKeyAdapter;
    for (const adapter of options.adapters) {
      this.adapters.set(normalizeProvider(adapter.provider), adapter);
    }
  }

  public begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    const descriptor = this.ensureProviderDescriptor(input.provider);
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
      current.credentialSecret,
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

  private requireAdapter(provider: string): ProviderConnectAdapter {
    const providerId = normalizeProvider(provider);
    const adapter = this.adapters.get(providerId) ?? this.createDynamicAdapter(providerId);
    if (!adapter) {
      throw new Error(`No Connect adapter registered for ${provider}`);
    }
    return adapter;
  }

  private ensureProviderDescriptor(provider: string): ProviderDescriptor {
    const providerId = normalizeProvider(provider);
    const existing = this.registry.getProvider(providerId);
    if (existing) return existing;
    if (!this.dynamicApiKeyAdapter) {
      return this.registry.requireProvider(providerId);
    }
    this.registry.register({
      id: providerId,
      label: providerId,
      authModes: ['browserAssistedApiKey', 'apiKey'],
      connect: {
        mode: 'browserAssistedApiKey',
        label: 'Submit the custom provider API key through Xpod authenticated management',
        apiKeyManagementSupported: true,
        configured: true,
        requiresAuthenticatedManagementApi: true,
        publicCallbackSupported: false,
      },
      protocols: ['chatCompletions'],
      defaultBaseUrl: 'https://invalid.invalid/v1',
      safeBaseUrls: ['https://invalid.invalid/v1'],
      capabilities: {},
      models: [],
    });
    return this.registry.requireProvider(providerId);
  }

  private createDynamicAdapter(provider: string): ProviderConnectAdapter | undefined {
    if (!this.dynamicApiKeyAdapter) return undefined;
    const adapter = this.dynamicApiKeyAdapter(provider);
    this.adapters.set(provider, adapter);
    return adapter;
  }
}

function token(randomBytes: (bytes: number) => Buffer): string {
  return randomBytes(32).toString('base64url');
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
  return {
    id: record.id,
    provider: aiProviderResource.buildId({ id: normalizeProvider(record.provider) }),
    service: 'ai',
    authMode: record.authMode,
    status: record.status,
    encryptedSecret: JSON.stringify(record.credentialSecret),
    keyVersion: String(record.version ?? 1),
    scopes: record.scopes ?? [],
    expiresAt: record.expiresAt,
    accountLabel: record.accountLabel,
    label: record.accountLabel,
    baseUrl: record.baseUrl,
    reauthRequired: record.reauthRequired ?? false,
    lastRefreshAt: new Date(),
  };
}

function recordFromCredentialRow(
  row: Record<string, unknown>,
  fallback?: {
    credentialIri: string;
    deployment: GatewayDeployment;
    provider: string;
    webId: string;
  },
): ConnectCredentialRecord {
  const id = stringFrom(row.id);
  const provider = providerFromRelation(stringFrom(row.provider))
    || providerFromCredentialId(id)
    || fallback?.provider
    || '';
  const deployment = deploymentFromCredentialId(id, fallback?.deployment);
  const storedSecret = storedCredentialSecretFromRow(row, {
    credentialIri: fallback?.credentialIri ?? '',
    provider,
    webId: fallback?.webId,
  });
  const webId = storedSecret.webId;
  return {
    id,
    credentialIri: storedSecret.credentialIri,
    webId,
    provider,
    deployment,
    authMode: stringFrom(row.authMode) === 'deviceCodeOAuth' ? 'deviceCodeOAuth' : 'apiKey',
    credentialSecret: storedSecret,
    status: stringFrom(row.status) === 'revoked' ? 'revoked' : 'active',
    accountLabel: stringFrom(row.accountLabel) || stringFrom(row.label) || undefined,
    expiresAt: dateFrom(row.expiresAt),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : undefined,
    version: versionFromRow(row),
    reauthRequired: row.reauthRequired === true || row.reauthRequired === 'true',
    metadata: metadataFromRow(row),
    baseUrl: stringFrom(row.baseUrl) || undefined,
  };
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

function runtimeCredentialFromMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = metadata?.runtimeCredential;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function runtimeCapabilitiesFromProviderRow(providerRow: Record<string, unknown> | null): string[] | undefined {
  if (!providerRow || !Array.isArray(providerRow.capabilities)) {
    return undefined;
  }
  return stringList(providerRow.capabilities.map((capability) =>
    typeof capability === 'string' ? capability.trim().toLowerCase() : capability));
}

function parseStoredCredentialSecret(value: unknown): StoredCredentialSecret {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Credential row is missing credential secret payload');
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Credential row secret payload is invalid');
  }
  const secret = parsed as Partial<StoredCredentialSecret>;
  if (!secret.secret || typeof secret.secret !== 'object' || Array.isArray(secret.secret)) {
    throw new Error('Credential row secret payload is missing plaintext secret');
  }
  return secret as StoredCredentialSecret;
}

function storedCredentialSecretFromRow(
  row: Record<string, unknown>,
  fallback: { credentialIri: string; provider: string; webId?: string },
): StoredCredentialSecret {
  if (typeof row.encryptedSecret === 'string' && row.encryptedSecret.trim()) {
    return parseStoredCredentialSecret(row.encryptedSecret);
  }
  const apiKey = stringFrom(row.apiKey);
  if (!apiKey || !fallback.webId || !fallback.provider || !fallback.credentialIri) {
    return parseStoredCredentialSecret(row.encryptedSecret);
  }
  return {
    webId: fallback.webId,
    credentialIri: fallback.credentialIri,
    provider: fallback.provider,
    secret: { type: 'apiKey', apiKey },
  };
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
  const fragment = id.includes('#') ? id.slice(id.lastIndexOf('#') + 1) : id;
  const match = /^(?:local|cloud)-(.+)$/u.exec(fragment);
  return match?.[1] ? normalizeProvider(match[1]) : '';
}

function deploymentFromCredentialId(id: string, fallback: GatewayDeployment = 'local'): GatewayDeployment {
  if (id.includes('#cloud-')) return 'cloud';
  if (id.includes('#local-')) return 'local';
  return fallback;
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

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /version_conflict|credential_version_conflict/u.test(error.message);
}
