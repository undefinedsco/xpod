import { drizzle } from '@undefineds.co/drizzle-solid';
import {
  aiGatewayRepository,
  quotaSnapshotId as buildQuotaSnapshotId,
  quotaSnapshotResource,
  type QuotaSnapshotRow,
} from '@undefineds.co/models';
import type { AuthContext } from '../../auth/AuthContext';
import {
  CALLER_POD_ACCESS_UNAVAILABLE,
  createCallerAuthenticatedPodFetch,
  isInternalPodAccessAllowed,
} from '../auth/CallerPodAccess';
import type { GatewayDeployment } from '../auth/GatewayApiKey';
import type { InternalPodAccessTokenProvider } from '../auth/PodGatewayAccessKeyRepository';
import type { ConnectCredentialRecord, PodCredentialRepository } from '../connect';
import type { CredentialVault, ProviderSecret } from '../credentials/CredentialVault';

export type QuotaSnapshotStatus = 'available' | 'unsupported' | 'error';

export interface QuotaWindow {
  name: string;
  used?: number;
  usedExact?: string;
  limit?: number;
  limitExact?: string;
  remaining?: number;
  remainingExact?: string;
  displayApprox?: boolean;
  currency?: string;
  resetsAt?: string;
}

export interface NormalizedQuotaSnapshot {
  id?: string;
  credential: string;
  status: QuotaSnapshotStatus;
  balance?: number;
  windows: QuotaWindow[];
  observedAt: string;
  expiresAt: string;
  source: string;
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

export interface QuotaCredentialRecord extends ConnectCredentialRecord {
  baseUrl?: string;
  offeringId?: string;
}

export interface ProviderQuotaFetchInput {
  credential: QuotaCredentialRecord;
  secret: ProviderSecret;
  now: Date;
  signal?: AbortSignal;
}

export interface ProviderQuotaAdapter {
  readonly provider: string;
  fetch(input: ProviderQuotaFetchInput): Promise<NormalizedQuotaSnapshot>;
}

export interface QuotaSnapshotRepository {
  findFresh(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    credentialIri: string;
    now: Date;
    auth?: AuthContext;
  }): Promise<NormalizedQuotaSnapshot | undefined>;
  findLatest(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    credentialIri: string;
    auth?: AuthContext;
  }): Promise<NormalizedQuotaSnapshot | undefined>;
  upsert(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    snapshot: NormalizedQuotaSnapshot;
    auth?: AuthContext;
  }): Promise<NormalizedQuotaSnapshot>;
}

export interface ProviderQuotaStatusInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  offeringId?: string;
  credentialIri?: string;
  refresh?: boolean;
  now?: Date;
  signal?: AbortSignal;
  auth?: AuthContext;
}

export interface CallerOwnedQuotaInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  offeringId?: string;
  credentialId: string;
  credentialIri: string;
  authMode: 'apiKey' | 'deviceCodeOAuth';
  baseUrl?: string;
  secret: ProviderSecret;
  now?: Date;
  signal?: AbortSignal;
}

export interface ProviderQuotaServiceOptions {
  repository: QuotaSnapshotRepository;
  vault: CredentialVault;
  adapters: ProviderQuotaAdapter[];
  credentialRepository?: PodCredentialRepository;
  credentials?: QuotaCredentialRecord[];
  now?: () => Date;
}

export class ProviderQuotaService {
  private readonly repository: QuotaSnapshotRepository;
  private readonly vault: CredentialVault;
  private readonly adapters = new Map<string, ProviderQuotaAdapter>();
  private readonly credentialRepository?: PodCredentialRepository;
  private readonly credentials: QuotaCredentialRecord[];
  private readonly now: () => Date;
  private readonly inFlightRefreshes = new Map<string, Promise<NormalizedQuotaSnapshot>>();

  public constructor(options: ProviderQuotaServiceOptions) {
    this.repository = options.repository;
    this.vault = options.vault;
    this.credentialRepository = options.credentialRepository;
    this.credentials = options.credentials ?? [];
    this.now = options.now ?? (() => new Date());
    for (const adapter of options.adapters) {
      this.adapters.set(normalizeProvider(adapter.provider), adapter);
    }
  }

  public async status(input: ProviderQuotaStatusInput): Promise<NormalizedQuotaSnapshot> {
    const provider = normalizeProvider(input.provider);
    const now = input.now ?? this.now();
    if (input.refresh && input.credentialIri) {
      const refreshKey = quotaRefreshKey({
        webId: input.webId,
        deployment: input.deployment,
        provider,
        offeringId: input.offeringId,
        credentialIri: input.credentialIri,
      });
      const inFlight = this.inFlightRefreshes.get(refreshKey);
      if (inFlight) {
        return inFlight;
      }
      const refresh = this.refreshAndCache({
        input,
        provider,
        now,
      }).finally(() => {
        this.inFlightRefreshes.delete(refreshKey);
      });
      this.inFlightRefreshes.set(refreshKey, refresh);
      return refresh;
    }

    return this.statusAfterImplicitCredentialResolution(input, provider, now);
  }

  public async statusCallerOwned(input: CallerOwnedQuotaInput): Promise<NormalizedQuotaSnapshot> {
    const provider = normalizeProvider(input.provider);
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`quota_adapter_not_found:${provider}`);
    const now = input.now ?? this.now();
    const credential = {
      id: input.credentialId,
      credentialIri: input.credentialIri,
      webId: input.webId,
      provider,
      deployment: input.deployment,
      authMode: input.authMode,
      encryptedSecret: {} as QuotaCredentialRecord['encryptedSecret'],
      status: 'active' as const,
      offeringId: input.offeringId,
      baseUrl: input.baseUrl,
    };
    try {
      return await adapter.fetch({ credential, secret: input.secret, now, signal: input.signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return errorQuotaSnapshot({
        credential: input.credentialIri,
        source: quotaErrorSource(provider),
        now,
        metadata: { reason: 'provider_quota_unavailable' },
      });
    }
  }

  private async statusAfterImplicitCredentialResolution(
    input: ProviderQuotaStatusInput,
    provider: string,
    now: Date,
  ): Promise<NormalizedQuotaSnapshot> {
    const credential = await this.resolveCredential({
      webId: input.webId,
      deployment: input.deployment,
      provider,
      offeringId: input.offeringId,
      credentialIri: input.credentialIri,
      auth: input.auth,
    });

    if (!input.refresh) {
      const cached = await this.repository.findFresh({
        webId: input.webId,
        deployment: input.deployment,
        provider,
        offeringId: credential.offeringId,
        credentialIri: credential.credentialIri,
        now,
        auth: input.auth,
      });
      if (cached) {
        return { ...cached, stale: false };
      }
      const latest = await this.repository.findLatest({
        webId: input.webId,
        deployment: input.deployment,
        provider,
        offeringId: credential.offeringId,
        credentialIri: credential.credentialIri,
        auth: input.auth,
      });
      if (latest) {
        return { ...latest, stale: true };
      }
    }

    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`quota_adapter_not_found:${provider}`);
    }
    const refreshKey = quotaRefreshKey({
      webId: input.webId,
      deployment: input.deployment,
      provider,
      offeringId: credential.offeringId,
      credentialIri: credential.credentialIri,
    });
    const inFlight = this.inFlightRefreshes.get(refreshKey);
    if (inFlight) {
      return inFlight;
    }

    const refresh = this.fetchAndCache({
      webId: input.webId,
      deployment: input.deployment,
      provider,
      credential,
      adapter,
      now,
      signal: input.signal,
      auth: input.auth,
    }).finally(() => {
      this.inFlightRefreshes.delete(refreshKey);
    });
    this.inFlightRefreshes.set(refreshKey, refresh);
    return refresh;
  }

  private async refreshAndCache(input: {
    input: ProviderQuotaStatusInput;
    provider: string;
    now: Date;
  }): Promise<NormalizedQuotaSnapshot> {
    const credential = await this.resolveCredential({
      webId: input.input.webId,
      deployment: input.input.deployment,
      provider: input.provider,
      offeringId: input.input.offeringId,
      credentialIri: input.input.credentialIri,
      auth: input.input.auth,
    });
    const adapter = this.adapters.get(input.provider);
    if (!adapter) {
      throw new Error(`quota_adapter_not_found:${input.provider}`);
    }
    return this.fetchAndCache({
      webId: input.input.webId,
      deployment: input.input.deployment,
      provider: input.provider,
      credential,
      adapter,
      now: input.now,
      signal: input.input.signal,
      auth: input.input.auth,
    });
  }

  private async fetchAndCache(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    credential: QuotaCredentialRecord;
    adapter: ProviderQuotaAdapter;
    now: Date;
    signal?: AbortSignal;
    auth?: AuthContext;
  }): Promise<NormalizedQuotaSnapshot> {
    const secret = await this.vault.open(
      { webId: input.webId },
      input.credential.credentialIri,
      input.provider,
      input.credential.encryptedSecret,
    );
    if (
      this.vault.needsRewrap?.(input.credential.encryptedSecret)
      && this.credentialRepository?.rewrapCredential
    ) {
      const rewrapped = await this.vault.rewrap(
        { webId: input.webId },
        input.credential.encryptedSecret,
      );
      await this.credentialRepository.rewrapCredential({
        webId: input.webId,
        deployment: input.deployment,
        credentialId: input.credential.id,
        expectedVersion: input.credential.version,
        encryptedSecret: rewrapped,
        auth: input.auth,
      });
    }
    let snapshot: NormalizedQuotaSnapshot;
    try {
      snapshot = await input.adapter.fetch({
        credential: input.credential,
        secret,
        now: input.now,
        signal: input.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      snapshot = errorQuotaSnapshot({
        credential: input.credential.credentialIri,
        source: quotaErrorSource(input.provider),
        now: input.now,
        metadata: { reason: 'provider_quota_unavailable' },
      });
    }
    return this.repository.upsert({
      webId: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      offeringId: input.credential.offeringId,
      snapshot,
      auth: input.auth,
    });
  }

  private async resolveCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    credentialIri?: string;
    auth?: AuthContext;
  }): Promise<QuotaCredentialRecord> {
    const listed = this.credentials.find((candidate) =>
      candidate.webId === input.webId
      && candidate.deployment === input.deployment
      && normalizeProvider(candidate.provider) === input.provider
      && (!input.offeringId || candidate.offeringId === input.offeringId)
      && (!input.credentialIri || candidate.credentialIri === input.credentialIri));
    if (listed) {
      return listed;
    }

    if (input.offeringId && this.credentialRepository) {
      const activeForOffering = (await this.credentialRepository.listProviderCredentials({
        webId: input.webId,
        deployment: input.deployment,
        provider: input.provider,
        auth: input.auth,
      })).find((candidate) =>
        candidate.offeringId === input.offeringId
        && candidate.status === 'active'
        && candidate.enabled !== false
        && (!input.credentialIri || candidate.credentialIri === input.credentialIri));
      if (activeForOffering) {
        return activeForOffering as QuotaCredentialRecord;
      }
      throw new Error('quota_credential_not_found');
    }

    const active = await this.credentialRepository?.getActiveCredential({
      webId: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      auth: input.auth,
    });
    if (
      active
      && (!input.credentialIri || active.credentialIri === input.credentialIri)
    ) {
      return active as QuotaCredentialRecord;
    }
    throw new Error('quota_credential_not_found');
  }
}

export class InMemoryQuotaSnapshotRepository implements QuotaSnapshotRepository {
  public readonly rows: Array<NormalizedQuotaSnapshot & {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
  }> = [];

  public async findFresh(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    credentialIri: string;
    now: Date;
  }): Promise<NormalizedQuotaSnapshot | undefined> {
    const latest = await this.findLatest(input);
    if (!latest || new Date(latest.expiresAt).getTime() <= input.now.getTime()) {
      return undefined;
    }
    return latest;
  }

  public async findLatest(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    credentialIri: string;
  }): Promise<NormalizedQuotaSnapshot | undefined> {
    const row = this.rows
      .filter((candidate) =>
        candidate.webId === input.webId
        && candidate.deployment === input.deployment
        && normalizeProvider(candidate.provider) === normalizeProvider(input.provider)
        && quotaOfferingMatches(candidate.offeringId, input.offeringId)
        && candidate.credential === input.credentialIri)
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
    return row ? publicSnapshot(row) : undefined;
  }

  public async upsert(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    snapshot: NormalizedQuotaSnapshot;
  }): Promise<NormalizedQuotaSnapshot> {
    const id = input.snapshot.id ?? quotaSnapshotCacheId({
      webId: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      offeringId: input.offeringId,
      credentialIri: input.snapshot.credential,
    });
    const next = {
      ...sanitizeSnapshot(input.snapshot),
      id,
      webId: input.webId,
      deployment: input.deployment,
      provider: normalizeProvider(input.provider),
      offeringId: input.offeringId,
      stale: false,
    };
    const index = this.rows.findIndex((row) => row.id === id);
    if (index === -1) {
      this.rows.push(next);
    } else {
      this.rows[index] = next;
    }
    return publicSnapshot(next);
  }
}

function quotaSnapshotCacheId(input: {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  credentialIri: string;
  offeringId?: string;
}): string {
  return buildQuotaSnapshotId({
    owner: input.webId,
    deployment: input.deployment,
    provider: input.offeringId
      ? `${normalizeProvider(input.provider)}:${input.offeringId}`
      : input.provider,
    credential: input.credentialIri,
  });
}

function quotaOfferingMatches(candidateOfferingId: string | undefined, inputOfferingId: string | undefined): boolean {
  return inputOfferingId ? candidateOfferingId === inputOfferingId : candidateOfferingId === undefined;
}

type QuotaSnapshotDb = {
  init?: (...resources: unknown[]) => Promise<void>;
  select(): {
    from(resource: typeof quotaSnapshotResource): {
      where(condition: unknown): { execute(): Promise<QuotaSnapshotRow[]> };
    };
  };
  findById<TRow>(resource: typeof quotaSnapshotResource, id: string): Promise<TRow | null>;
  findByIri<TRow>(resource: typeof quotaSnapshotResource, iri: string): Promise<TRow | null>;
  updateById<TRow>(resource: typeof quotaSnapshotResource, id: string, patch: unknown): Promise<TRow | null>;
  updateByIri<TRow>(resource: typeof quotaSnapshotResource, iri: string, patch: unknown): Promise<TRow | null>;
  insert(resource: typeof quotaSnapshotResource): {
    values(value: unknown): { execute(): Promise<QuotaSnapshotRow[]> };
  };
};

export interface PodQuotaSnapshotRepositoryOptions {
  internalPodAccess?: InternalPodAccessTokenProvider;
  dbFactory?: (input: {
    owner: string;
    auth?: AuthContext;
    fetch: typeof fetch;
  }) => Promise<QuotaSnapshotDb>;
}

export class PodQuotaSnapshotRepository implements QuotaSnapshotRepository {
  private readonly dbFactory: NonNullable<PodQuotaSnapshotRepositoryOptions['dbFactory']>;
  private readonly internalPodAccess?: InternalPodAccessTokenProvider;

  public constructor(options: PodQuotaSnapshotRepositoryOptions = {}) {
    this.internalPodAccess = options.internalPodAccess;
    this.dbFactory = options.dbFactory ?? createDefaultQuotaSnapshotDb;
  }

  public async findFresh(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    credentialIri: string;
    now: Date;
    auth?: AuthContext;
  }): Promise<NormalizedQuotaSnapshot | undefined> {
    const db = await this.dbForOwner(input.webId, input.auth);
    if (input.offeringId) {
      const row = await db.findById<QuotaSnapshotRow>(quotaSnapshotResource, quotaSnapshotCacheId(input));
      return row && isFreshQuotaSnapshotRow(row, input.now) ? snapshotFromRow(row, false) : undefined;
    }
    const row = await aiGatewayRepository.findFreshQuotaSnapshot(db as never, {
      owner: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      credential: input.credentialIri,
      now: input.now,
    });
    return row ? snapshotFromRow(row, false) : undefined;
  }

  public async findLatest(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    credentialIri: string;
    auth?: AuthContext;
  }): Promise<NormalizedQuotaSnapshot | undefined> {
    const db = await this.dbForOwner(input.webId, input.auth);
    if (input.offeringId) {
      const row = await db.findById<QuotaSnapshotRow>(quotaSnapshotResource, quotaSnapshotCacheId(input));
      return row ? snapshotFromRow(row, true) : undefined;
    }
    const row = await aiGatewayRepository.findLatestQuotaSnapshot(db as never, {
      owner: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      credential: input.credentialIri,
    });
    return row ? snapshotFromRow(row, true) : undefined;
  }

  public async upsert(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    offeringId?: string;
    snapshot: NormalizedQuotaSnapshot;
    auth?: AuthContext;
  }): Promise<NormalizedQuotaSnapshot> {
    const db = await this.dbForOwner(input.webId, input.auth);
    const snapshot = sanitizeSnapshot({
      ...input.snapshot,
      id: input.snapshot.id ?? quotaSnapshotCacheId({
        webId: input.webId,
        deployment: input.deployment,
        provider: input.provider,
        offeringId: input.offeringId,
        credentialIri: input.snapshot.credential,
      }),
    });
    await aiGatewayRepository.upsertQuotaSnapshot(db as never, {
      id: snapshot.id!,
      owner: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      credential: snapshot.credential,
      status: snapshot.status,
      balance: snapshot.balance,
      windows: JSON.stringify(snapshot.windows),
      observedAt: new Date(snapshot.observedAt),
      expiresAt: new Date(snapshot.expiresAt),
      source: snapshot.source,
    } as never);
    return { ...snapshot, stale: false };
  }

  private async dbForOwner(owner: string, auth?: AuthContext): Promise<QuotaSnapshotDb> {
    const trustedFetch = await this.resolveTrustedFetch(owner, auth);
    const db = await this.dbFactory({ owner, auth, fetch: trustedFetch });
    await db.init?.(quotaSnapshotResource);
    return db;
  }

  private async resolveTrustedFetch(owner: string, auth?: AuthContext): Promise<typeof fetch> {
    const callerFetch = createCallerAuthenticatedPodFetch(owner, auth);
    if (callerFetch) {
      return this.wrapPodFetch(callerFetch);
    }
    if (!isInternalPodAccessAllowed(auth)) {
      throw new Error(CALLER_POD_ACCESS_UNAVAILABLE);
    }
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(owner);
    if (!trustedFetch) {
      throw new Error('AI Connection service identity is not configured');
    }
    return this.wrapPodFetch(trustedFetch);
  }

  private wrapPodFetch(trustedFetch: typeof fetch): typeof fetch {
    return async (input, init) => {
      const response = await trustedFetch(input, init);
      if (response.status === 403) {
        throw new Error('service_access_missing');
      }
      return response;
    };
  }
}

export function unsupportedQuotaSnapshot(
  input: {
    credential: string;
    source: string;
    now: Date;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  },
): NormalizedQuotaSnapshot {
  return {
    credential: input.credential,
    status: 'unsupported',
    windows: [],
    observedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? 60 * 60_000)).toISOString(),
    source: input.source,
    metadata: input.metadata,
  };
}

export function errorQuotaSnapshot(
  input: {
    credential: string;
    source: string;
    now: Date;
    status?: number;
    retryAfter?: string | null;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  },
): NormalizedQuotaSnapshot {
  return {
    credential: input.credential,
    status: 'error',
    windows: [],
    observedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString(),
    source: input.source,
    metadata: {
      ...input.metadata,
      ...(input.status ? { providerStatusCode: input.status } : {}),
      ...(input.status === 429 ? {
        cooldown: {
          reason: 'rate_limited',
          ...(retryAfterSeconds(input.retryAfter) !== undefined ? { retryAfterSeconds: retryAfterSeconds(input.retryAfter) } : {}),
        },
      } : {}),
    },
  };
}

export function apiKeyFromSecret(secret: ProviderSecret): string | undefined {
  const apiKey = secret.apiKey;
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey : undefined;
}

export async function fetchJsonWithBearer(input: {
  fetch: typeof fetch;
  url: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; body: unknown } | { ok: false; status: number; retryAfter?: string | null }> {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${input.apiKey}`);
  const response = await input.fetch(input.url, {
    method: 'GET',
    headers,
    signal: input.signal,
  });
  if (!response.ok) {
    await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      retryAfter: response.headers.get('Retry-After') ?? response.headers.get('retry-after'),
    };
  }
  return { ok: true, body: await response.json() };
}

export function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function decimalAmount(value: unknown): {
  exact?: string;
  numeric?: number;
  displayApprox?: boolean;
} {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      exact: String(value),
      numeric: value,
      ...(Number.isSafeInteger(value) ? {} : { displayApprox: true }),
    };
  }
  if (typeof value !== 'string') {
    return {};
  }
  const exact = value.trim();
  if (!exact) {
    return {};
  }
  const parsed = Number(exact);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    return { exact };
  }
  return {
    exact,
    numeric: parsed,
    ...(/[.eE]/u.test(exact) ? { displayApprox: true } : {}),
  };
}

export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function retryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function quotaRefreshKey(input: {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  offeringId?: string;
  credentialIri: string;
}): string {
  return JSON.stringify([
    input.webId,
    input.deployment,
    normalizeProvider(input.provider),
    input.offeringId ?? '',
    input.credentialIri,
  ]);
}

function quotaErrorSource(provider: string): string {
  switch (normalizeProvider(provider)) {
    case 'kimi':
      return 'kimi:/v1/users/me/balance';
    case 'deepseek':
      return 'deepseek:/user/balance';
    case 'openai':
      return 'openai:no-credential-quota-api';
    case 'anthropic':
      return 'anthropic:no-credential-quota-api';
    case 'bailian':
      return 'bailian:console-only';
    default:
      return `${normalizeProvider(provider)}:quota`;
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError',
  );
}

function sanitizeSnapshot(snapshot: NormalizedQuotaSnapshot): NormalizedQuotaSnapshot {
  return {
    ...snapshot,
    windows: snapshot.windows.map((window) => ({ ...window })),
    metadata: snapshot.metadata ? sanitizeMetadata(snapshot.metadata) : undefined,
  };
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metadata, (_key, value) => {
    if (typeof value === 'string' && /secret|sk-|api[_-]?key/i.test(value)) {
      return '[redacted]';
    }
    return value;
  })) as Record<string, unknown>;
}

function publicSnapshot(snapshot: NormalizedQuotaSnapshot): NormalizedQuotaSnapshot {
  return sanitizeSnapshot(snapshot);
}

function snapshotFromRow(row: QuotaSnapshotRow, stale: boolean): NormalizedQuotaSnapshot {
  return sanitizeSnapshot({
    id: String(row.id),
    credential: String(row.credential),
    status: row.status === 'available' || row.status === 'unsupported' ? row.status : 'error',
    balance: typeof row.balance === 'number' ? row.balance : undefined,
    windows: parseWindows(row.windows),
    observedAt: toIso(row.observedAt),
    expiresAt: toIso(row.expiresAt),
    source: typeof row.source === 'string' ? row.source : '',
    stale,
  });
}

function isFreshQuotaSnapshotRow(row: QuotaSnapshotRow, now: Date): boolean {
  return new Date(toIso(row.expiresAt)).getTime() > now.getTime();
}

function parseWindows(value: unknown): QuotaWindow[] {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
      : [];
  } catch {
    return [];
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(0).toISOString();
}

function createDefaultQuotaSnapshotDb(input: {
  owner: string;
  auth?: AuthContext;
  fetch: typeof fetch;
}): Promise<QuotaSnapshotDb> {
  return Promise.resolve(drizzle(
    {
      fetch: input.fetch,
      info: { webId: input.owner, isLoggedIn: true },
    } as any,
    {
      schema: {
        quotaSnapshot: quotaSnapshotResource,
      },
    },
  ) as unknown as QuotaSnapshotDb);
}
