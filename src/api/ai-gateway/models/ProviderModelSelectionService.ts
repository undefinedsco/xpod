import type { AuthContext } from '../../auth/AuthContext';
import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { PodCredentialRepository } from '../connect';
import { decodePlaintextCredential } from '../credentials/PlaintextCredentialPayload';
import { GatewayProtocolError } from '../errors';
import {
  createDefaultProviderRegistry,
  normalizeProviderId,
  type ProviderRegistry,
} from '../providers/ProviderRegistry';
import {
  createProviderModelDiscoveryAdapters,
  type DiscoveredProviderModel,
  type ProviderModelDiscoveryAdapter,
} from './ProviderModelDiscoveryAdapters';
import type {
  PodModelSelection,
  PodSelectedModelInput,
  PodModelSelectionRepository,
} from './PodModelSelectionRepository';

export type ProviderModelCatalogModel = DiscoveredProviderModel & {
  selected: boolean;
  availability: 'available' | 'unavailable' | 'statusUnknown';
};

export type ProviderModelCatalog = {
  provider: string;
  fetchedAt?: string;
  version: string;
  status: 'ready' | 'notFetched' | 'statusUnknown';
  models: ProviderModelCatalogModel[];
};

export interface DiscoverProviderModelInput {
  webId: string;
  provider: string;
  deployment?: GatewayDeployment;
  auth?: AuthContext;
  signal?: AbortSignal;
}

export interface GetProviderModelCatalogInput extends DiscoverProviderModelInput {}

export interface ReplaceProviderModelSelectionInput {
  webId: string;
  provider: string;
  modelIds: readonly string[];
  defaultModel?: string;
  expectedVersion?: string;
  deployment?: GatewayDeployment;
  auth?: AuthContext;
}

export interface ProviderModelSelectionRepositoryLike {
  listSelection(input: {
    webId: string;
    provider: string;
    auth?: AuthContext;
  }): Promise<PodModelSelection>;
  reconcileAvailability(input: {
    webId: string;
    provider: string;
    discoveredModels: readonly DiscoveredProviderModel[];
    auth?: AuthContext;
  }): Promise<PodModelSelection>;
  replaceSelection(input: {
    webId: string;
    provider: string;
    models: readonly PodSelectedModelInput[];
    defaultModel?: string;
    expectedVersion?: string;
    auth?: AuthContext;
  }): Promise<PodModelSelection>;
}

export interface ProviderModelDiscoveryRegistryLike {
  get(provider: string): ProviderModelDiscoveryAdapter;
}

export interface ProviderModelSelectionServiceOptions {
  credentialRepository?: PodCredentialRepository;
  selectionRepository?: ProviderModelSelectionRepositoryLike | Pick<PodModelSelectionRepository, 'listSelection' | 'reconcileAvailability' | 'replaceSelection'>;
  /** Alias matching the repository option used by other Gateway services. */
  repository?: ProviderModelSelectionRepositoryLike;
  discoveryRegistry?: ProviderModelDiscoveryRegistryLike;
  /** Backwards-compatible alias for callers that name the registry adapters. */
  discoveryAdapters?: ProviderModelDiscoveryRegistryLike;
  adapters?: readonly ProviderModelDiscoveryAdapter[];
  providerRegistry?: ProviderRegistry;
  baseUrlForProvider?: (provider: string) => string;
  now?: () => Date;
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface CatalogCacheEntry {
  catalog: ProviderModelCatalog;
  fetchedAtMs: number;
}

/**
 * Coordinates short-lived provider discovery with durable Pod selections.
 * Provider secrets are decoded only inside discoverAndCache and are never put
 * in a cache entry, result DTO, or error message.
 */
export class ProviderModelSelectionService {
  private readonly credentialRepository: PodCredentialRepository;
  private readonly selectionRepository: ProviderModelSelectionRepositoryLike;
  private readonly discoveryRegistry: ProviderModelDiscoveryRegistryLike;
  private readonly providerRegistry: ProviderRegistry;
  private readonly baseUrlForProvider?: (provider: string) => string;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CatalogCacheEntry>();
  private readonly inFlight = new Map<string, Promise<ProviderModelCatalog>>();

  public constructor(options: ProviderModelSelectionServiceOptions) {
    if (!options.credentialRepository) {
      throw new Error('PodCredentialRepository is required for model discovery');
    }
    const selectionRepository = options.selectionRepository ?? options.repository;
    if (!selectionRepository) {
      throw new Error('PodModelSelectionRepository is required for model selection');
    }
    this.credentialRepository = options.credentialRepository;
    this.selectionRepository = selectionRepository;
    this.discoveryRegistry = options.discoveryRegistry
      ?? options.discoveryAdapters
      ?? (options.adapters ? registryFromAdapters(options.adapters) : undefined)
      ?? createProviderModelDiscoveryAdapters();
    this.providerRegistry = options.providerRegistry ?? createDefaultProviderRegistry();
    this.baseUrlForProvider = options.baseUrlForProvider;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = normalizeCacheTtl(options.cacheTtlMs);
  }

  public async discover(input: DiscoverProviderModelInput): Promise<ProviderModelCatalog> {
    const normalizedProvider = normalizeProvider(input.provider);
    const key = cacheKey(input.webId, normalizedProvider, input.deployment);
    const cached = this.freshCacheEntry(key);
    if (cached) {
      return cloneCatalog(cached.catalog);
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return cloneCatalog(await existing);
    }

    const request = this.discoverAndCache({ ...input, provider: normalizedProvider });
    this.inFlight.set(key, request);
    try {
      return cloneCatalog(await request);
    } finally {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    }
  }

  public async getCatalog(input: GetProviderModelCatalogInput): Promise<ProviderModelCatalog> {
    const normalizedProvider = normalizeProvider(input.provider);
    const key = cacheKey(input.webId, normalizedProvider, input.deployment);
    const cached = this.freshCacheEntry(key);
    if (cached) {
      return cloneCatalog(cached.catalog);
    }
    const durable = await this.selectionRepository.listSelection({
      webId: input.webId,
      provider: normalizedProvider,
      auth: input.auth,
    });
    return cloneCatalog(buildUnfetchedCatalog(normalizedProvider, durable));
  }

  public listCatalog(input: GetProviderModelCatalogInput): Promise<ProviderModelCatalog> {
    return this.getCatalog(input);
  }

  public async replaceSelection(input: ReplaceProviderModelSelectionInput): Promise<ProviderModelCatalog> {
    const normalizedProvider = normalizeProvider(input.provider);
    const key = cacheKey(input.webId, normalizedProvider, input.deployment);
    const cached = this.freshCacheEntry(key);
    if (!cached || cached.catalog.status !== 'ready') {
      throw new GatewayProtocolError('model_catalog_not_ready', {
        code: 'invalid_request',
        status: 409,
        details: { provider: normalizedProvider },
      });
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== cached.catalog.version) {
      throw new GatewayProtocolError('model_selection_version_conflict', {
        code: 'invalid_request',
        status: 409,
        details: { provider: normalizedProvider },
      });
    }
    if (
      input.defaultModel !== undefined
      && !input.modelIds.some((modelId) => modelIdentity(modelId) === modelIdentity(input.defaultModel!))
    ) {
      throw modelSelectionDefaultNotPickedError(normalizedProvider, input.defaultModel);
    }

    const availableById = new Map(
      cached.catalog.models
        .filter((model) => model.availability === 'available')
        .map((model) => [modelIdentity(model.id), model]),
    );
    for (const modelId of input.modelIds) {
      if (!availableById.has(modelIdentity(modelId))) {
        throw modelNotInCatalogError(normalizedProvider, modelId);
      }
    }
    if (input.defaultModel !== undefined && !availableById.has(modelIdentity(input.defaultModel))) {
      throw modelNotInCatalogError(normalizedProvider, input.defaultModel);
    }

    const next = await this.selectionRepository.replaceSelection({
      webId: input.webId,
      provider: normalizedProvider,
      models: input.modelIds.map((modelId): PodSelectedModelInput => {
        const discovered = availableById.get(modelIdentity(modelId));
        return {
          id: modelId,
          modelType: discovered?.modelType ?? 'other',
          status: 'active',
          ...(discovered?.displayName ? { displayName: discovered.displayName } : {}),
        };
      }),
      defaultModel: input.defaultModel,
      expectedVersion: input.expectedVersion,
      auth: input.auth,
    });
    const updatedCatalog = buildReadyCatalog(
      normalizedProvider,
      cached.catalog.fetchedAt ?? this.timestamp(),
      cached.catalog.models
        .filter((model) => model.availability === 'available')
        .map((model) => ({
          id: model.id,
          ...(model.displayName ? { displayName: model.displayName } : {}),
          modelType: model.modelType,
        })),
      next,
    );
    this.cache.set(key, {
      catalog: updatedCatalog,
      fetchedAtMs: this.now().getTime(),
    });
    return cloneCatalog(updatedCatalog);
  }

  private async discoverAndCache(input: DiscoverProviderModelInput & { provider: string }): Promise<ProviderModelCatalog> {
    const normalizedProvider = input.provider;
    const credential = await this.credentialRepository.getActiveCredential({
      webId: input.webId,
      provider: normalizedProvider,
      deployment: input.deployment ?? 'local',
      auth: input.auth,
    });
    if (!credential || credential.status !== 'active' || credential.reauthRequired) {
      throw activeCredentialRequiredError(normalizedProvider);
    }

    let secret: Record<string, unknown>;
    try {
      secret = decodePlaintextCredential(credential);
    } catch {
      throw activeCredentialRequiredError(normalizedProvider);
    }

    const durable = await this.selectionRepository.listSelection({
      webId: input.webId,
      provider: normalizedProvider,
      auth: input.auth,
    });
    const adapter = this.discoveryRegistry.get(normalizedProvider);
    const baseUrl = this.resolveBaseUrl(normalizedProvider);
    let discovered: DiscoveredProviderModel[];
    try {
      discovered = await adapter.discover({
        baseUrl,
        secret,
        signal: input.signal,
      });
    } catch (error) {
      // Provider errors carry stable status/re-auth/retry metadata and must
      // reach the caller unchanged. Cancellation is also not a discovery
      // status: preserve the original abort/timeout reason for the caller.
      if (error instanceof GatewayProtocolError || isCancellationError(error, input.signal)) {
        throw error;
      }
      // A transient provider/network failure is visible for this response,
      // but never cached; the next request must retry discovery.
      return buildUnknownCatalog(normalizedProvider, durable, this.timestamp());
    }

    const reconciled = await this.selectionRepository.reconcileAvailability({
      webId: input.webId,
      provider: normalizedProvider,
      discoveredModels: discovered,
      auth: input.auth,
    });
    const ready = buildReadyCatalog(normalizedProvider, this.timestamp(), discovered, reconciled);
    this.cacheCatalog(input.webId, normalizedProvider, input.deployment, ready);
    return ready;
  }

  private resolveBaseUrl(provider: string): string {
    if (this.baseUrlForProvider) {
      return this.baseUrlForProvider(provider);
    }
    return this.providerRegistry.requireProvider(provider).defaultBaseUrl;
  }

  private cacheCatalog(
    webId: string,
    provider: string,
    deployment: GatewayDeployment | undefined,
    catalog: ProviderModelCatalog,
  ): void {
    this.cache.set(cacheKey(webId, provider, deployment), {
      catalog: cloneCatalog(catalog),
      fetchedAtMs: this.now().getTime(),
    });
  }

  private freshCacheEntry(key: string): CatalogCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    const age = this.now().getTime() - entry.fetchedAtMs;
    if (age < 0 || age >= this.cacheTtlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function normalizeProvider(provider: string): string {
  const normalized = normalizeProviderId(provider);
  if (!normalized) {
    throw new GatewayProtocolError('provider_required', {
      code: 'invalid_request',
      status: 400,
    });
  }
  return normalized;
}

function normalizeCacheTtl(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CACHE_TTL_MS;
}

function cacheKey(webId: string, provider: string, deployment: GatewayDeployment | undefined): string {
  return `${webId}\u0000${provider}\u0000${deployment ?? 'local'}`;
}

function registryFromAdapters(adapters: readonly ProviderModelDiscoveryAdapter[]): ProviderModelDiscoveryRegistryLike {
  const byProvider = new Map(adapters.map((adapter) => [normalizeProvider(adapter.provider), adapter]));
  return {
    get(provider: string): ProviderModelDiscoveryAdapter {
      const adapter = byProvider.get(normalizeProvider(provider));
      if (!adapter) {
        throw new GatewayProtocolError('Unknown provider model discovery adapter', {
          code: 'invalid_request',
          status: 400,
          details: { provider: normalizeProvider(provider) },
        });
      }
      return adapter;
    },
  };
}

function modelIdentity(value: string): string {
  const normalized = value.trim();
  const fragmentIndex = normalized.lastIndexOf('#');
  return fragmentIndex >= 0 ? normalized.slice(fragmentIndex + 1) : normalized;
}

function buildReadyCatalog(
  provider: string,
  fetchedAt: string,
  discovered: readonly DiscoveredProviderModel[],
  durable: PodModelSelection,
): ProviderModelCatalog {
  const selectedById = new Map(durable.models.map((model) => [modelIdentity(model.id), model]));
  const seen = new Set<string>();
  const models: ProviderModelCatalogModel[] = [];
  for (const model of discovered) {
    const id = modelIdentity(model.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ ...model, selected: selectedById.has(id), availability: 'available' });
  }
  for (const model of durable.models) {
    const id = modelIdentity(model.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({
      id: model.id,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      modelType: normalizeCatalogModelType(model.modelType),
      selected: true,
      availability: 'unavailable',
    });
  }
  return { provider, fetchedAt, version: durable.version, status: 'ready', models };
}

function buildUnknownCatalog(provider: string, durable: PodModelSelection, fetchedAt: string): ProviderModelCatalog {
  return {
    provider,
    fetchedAt,
    version: durable.version,
    status: 'statusUnknown',
    models: durable.models.map((model) => ({
      id: model.id,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      modelType: normalizeCatalogModelType(model.modelType),
      selected: true,
      availability: model.status === 'inactive' ? 'unavailable' : 'statusUnknown',
    })),
  };
}

function buildUnfetchedCatalog(provider: string, durable: PodModelSelection): ProviderModelCatalog {
  return {
    provider,
    version: durable.version,
    status: 'notFetched',
    models: durable.models.map((model) => ({
      id: model.id,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      modelType: normalizeCatalogModelType(model.modelType),
      selected: true,
      availability: model.status === 'inactive' ? 'unavailable' : 'statusUnknown',
    })),
  };
}

function cloneCatalog(catalog: ProviderModelCatalog): ProviderModelCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => ({ ...model })),
  };
}

function normalizeCatalogModelType(value: string): DiscoveredProviderModel['modelType'] {
  return value === 'chat' || value === 'embedding' || value === 'image' || value === 'audio' || value === 'other'
    ? value
    : 'other';
}

function activeCredentialRequiredError(provider: string): GatewayProtocolError {
  return new GatewayProtocolError('active_credential_required', {
    code: 'credential_unavailable',
    status: 401,
    details: { provider },
  });
}

function modelNotInCatalogError(provider: string, modelId: string): GatewayProtocolError {
  return new GatewayProtocolError('model_not_in_discovered_catalog', {
    code: 'invalid_request',
    status: 400,
    details: { provider, modelId },
  });
}

function modelSelectionDefaultNotPickedError(provider: string, defaultModel: string): GatewayProtocolError {
  return new GatewayProtocolError('model_selection_default_not_picked', {
    code: 'invalid_request',
    status: 400,
    details: { provider, defaultModel },
  });
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && ((error as { name?: unknown }).name === 'AbortError'
      || (error as { name?: unknown }).name === 'TimeoutError'),
  );
}
