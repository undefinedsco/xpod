import type { AuthContext } from '../../auth/AuthContext';
import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { ConnectCredentialRecord, PodCredentialRepository } from '../connect';
import type { CredentialVault } from '../credentials/CredentialVault';
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

export interface ProviderModelDiscoveryServiceLike {
  /**
   * Discover with the caller-selected credential. This is deliberately the
   * caller-owned path: the delegate must not resolve another credential or
   * fall back to process configuration.
   */
  listFromSecret(input: {
    webId: string;
    provider: string;
    offeringId?: string;
    credentialId: string;
    authMode?: ConnectCredentialRecord['authMode'];
    secret?: Record<string, unknown>;
    apiKey?: string;
    baseUrl?: string;
    proxyUrl?: string;
    compatibility?: 'auto' | 'openai' | 'anthropic';
    signal?: AbortSignal;
  }): Promise<{
    models: ReadonlyArray<{
      id: string;
      displayName?: string;
      modelType?: DiscoveredProviderModel['modelType'];
    }>;
  }>;
}

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
  /** Resolve a specific active credential in the caller's Pod scope. */
  credentialId?: string;
  deployment?: GatewayDeployment;
  auth?: AuthContext;
  signal?: AbortSignal;
  /** Bypass a fresh catalog cache while preserving in-flight de-duplication. */
  forceRefresh?: boolean;
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
  /** Optional provider-model service for offering-aware caller-owned discovery. */
  modelsService?: ProviderModelDiscoveryServiceLike;
  /** Opens the selected caller credential when the Pod stores a secret cell. */
  credentialVault?: CredentialVault;
  now?: () => Date;
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface CatalogCacheEntry {
  catalog: ProviderModelCatalog;
  fetchedAtMs: number;
}

interface DiscoveryContext {
  credentialId: string;
  credentialIri: string;
  offeringId?: string;
  baseUrl: string;
  proxyUrl?: string;
  compatibility?: 'auto' | 'openai' | 'anthropic';
  path?: string;
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
  private readonly modelsService?: ProviderModelDiscoveryServiceLike;
  private readonly credentialVault?: CredentialVault;
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
    this.modelsService = options.modelsService;
    this.credentialVault = options.credentialVault;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = normalizeCacheTtl(options.cacheTtlMs);
  }

  public async discover(input: DiscoverProviderModelInput): Promise<ProviderModelCatalog> {
    const normalizedProvider = normalizeProvider(input.provider);
    const credential = await this.resolveCredential(input, normalizedProvider);
    const context = this.discoveryContext(normalizedProvider, credential);
    const key = cacheKey(input.webId, normalizedProvider, input.deployment, context);
    if (!input.forceRefresh) {
      const cached = this.freshCacheEntry(key);
      if (cached) {
        return cloneCatalog(cached.catalog);
      }
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return cloneCatalog(await existing);
    }

    const request = this.discoverAndCache({ ...input, provider: normalizedProvider }, credential, context);
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
    const credential = await this.resolveOptionalCredential(input, normalizedProvider);
    const context = credential ? this.discoveryContext(normalizedProvider, credential) : undefined;
    const key = cacheKey(input.webId, normalizedProvider, input.deployment, context);
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
    const credential = await this.resolveOptionalCredential(input, normalizedProvider);
    const context = credential ? this.discoveryContext(normalizedProvider, credential) : undefined;
    const key = cacheKey(input.webId, normalizedProvider, input.deployment, context);
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

  private async discoverAndCache(
    input: DiscoverProviderModelInput & { provider: string },
    credential: ConnectCredentialRecord,
    context: DiscoveryContext,
  ): Promise<ProviderModelCatalog> {
    const normalizedProvider = input.provider;
    const secret = await this.openCredentialSecret(credential, normalizedProvider);

    const durable = await this.selectionRepository.listSelection({
      webId: input.webId,
      provider: normalizedProvider,
      auth: input.auth,
    });
    let discovered: DiscoveredProviderModel[];
    try {
      discovered = await this.discoverProviderModels({
        input,
        credential,
        context,
        secret,
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
    this.cacheCatalog(input.webId, normalizedProvider, input.deployment, context, ready);
    return ready;
  }

  private async openCredentialSecret(
    credential: ConnectCredentialRecord,
    provider: string,
  ): Promise<Record<string, unknown>> {
    try {
      return decodePlaintextCredential(credential);
    } catch {
      if (!this.credentialVault || !credential.encryptedSecret) {
        throw activeCredentialRequiredError(provider);
      }
      try {
        return await this.credentialVault.open(
          { webId: credential.webId },
          credential.credentialIri,
          provider,
          credential.encryptedSecret,
        );
      } catch {
        throw activeCredentialRequiredError(provider);
      }
    }
  }

  private async discoverProviderModels(input: {
    input: DiscoverProviderModelInput & { provider: string };
    credential: ConnectCredentialRecord;
    context: DiscoveryContext;
    secret: Record<string, unknown>;
  }): Promise<DiscoveredProviderModel[]> {
    if (this.modelsService) {
      const result = await this.modelsService.listFromSecret({
        webId: input.input.webId,
        provider: input.input.provider,
        offeringId: input.context.offeringId,
        credentialId: input.credential.id || input.credential.credentialIri,
        authMode: input.credential.authMode,
        secret: input.secret,
        baseUrl: input.context.baseUrl,
        proxyUrl: input.context.proxyUrl,
        compatibility: input.context.compatibility,
        signal: input.input.signal,
      });
      return result.models.map((model) => ({
        id: model.id,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        modelType: model.modelType ?? inferModelType(model.id),
      }));
    }

    const adapter = this.discoveryRegistry.get(input.input.provider);
    const adapterInput = {
      baseUrl: input.context.baseUrl,
      secret: input.secret,
      signal: input.input.signal,
      credentialId: input.credential.id,
      credentialIri: input.credential.credentialIri,
      offeringId: input.context.offeringId,
      proxyUrl: input.context.proxyUrl,
      compatibility: input.context.compatibility,
      path: input.context.path,
    };
    return adapter.discover(adapterInput);
  }

  private async resolveCredential(
    input: DiscoverProviderModelInput,
    provider: string,
  ): Promise<ConnectCredentialRecord> {
    const credential = input.credentialId && this.credentialRepository.getCredentialById
      ? await this.credentialRepository.getCredentialById({
        webId: input.webId,
        provider,
        deployment: input.deployment ?? 'local',
        credentialId: input.credentialId,
        auth: input.auth,
      })
      : await this.credentialRepository.getActiveCredential({
        webId: input.webId,
        provider,
        deployment: input.deployment ?? 'local',
        auth: input.auth,
      });
    if (!credential || credential.status !== 'active' || credential.reauthRequired || credential.enabled === false) {
      throw activeCredentialRequiredError(provider);
    }
    return credential;
  }

  private async resolveOptionalCredential(
    input: DiscoverProviderModelInput,
    provider: string,
  ): Promise<ConnectCredentialRecord | undefined> {
    try {
      return await this.resolveCredential(input, provider);
    } catch (error) {
      if (error instanceof GatewayProtocolError && error.message === 'active_credential_required') {
        return undefined;
      }
      throw error;
    }
  }

  private discoveryContext(provider: string, credential: ConnectCredentialRecord): DiscoveryContext {
    const metadata = metadataRecord(credential.metadata);
    const offeringId = stringValue(credential.offeringId) ?? stringValue(metadata?.offeringId);
    const offering = offeringId ? this.providerRegistry.getOffering(provider, offeringId) : undefined;
    const endpoint = offering?.endpoints.find((candidate) =>
      candidate.protocol === offering.modelDiscovery.endpointProtocol);
    const configuredBaseUrl = stringValue((credential as unknown as { baseUrl?: unknown }).baseUrl)
      ?? stringValue(metadata?.baseUrl);
    const proxyUrl = stringValue(credential.proxyUrl)
      ?? stringValue(metadata?.proxyUrl)
      ?? stringValue(metadata?.proxy);
    const compatibility = normalizeCompatibility(
      (credential as unknown as { compatibility?: unknown }).compatibility
      ?? metadata?.compatibility,
    );
    return {
      credentialId: credential.id,
      credentialIri: credential.credentialIri,
      offeringId,
      baseUrl: configuredBaseUrl ?? endpoint?.baseUrl ?? this.resolveBaseUrl(provider),
      proxyUrl,
      compatibility,
      path: offering?.modelDiscovery.path,
    };
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
    context: DiscoveryContext,
    catalog: ProviderModelCatalog,
  ): void {
    this.cache.set(cacheKey(webId, provider, deployment, context), {
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

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCompatibility(value: unknown): DiscoveryContext['compatibility'] {
  return value === 'auto' || value === 'openai' || value === 'anthropic' ? value : undefined;
}

function inferModelType(id: string): DiscoveredProviderModel['modelType'] {
  const normalized = id.toLowerCase();
  if (/(?:embedding|embed)/u.test(normalized)) return 'embedding';
  if (/(?:dall[-_ ]?e|stable[-_ ]?diffusion|flux|imagen|midjourney|image[-_ ]?(?:generation|gen))/u.test(normalized)) {
    return 'image';
  }
  if (/(?:whisper|tts|speech|musicgen|audio[-_ ]?(?:generation|gen))/u.test(normalized)) return 'audio';
  if (/(?:chat|completion|conversation|text[-_ ]?generation|instruct|reason|coder|gpt|claude|kimi|qwen|deepseek|llama|mistral|gemini)/u.test(normalized)) {
    return 'chat';
  }
  return 'other';
}

function normalizeCacheTtl(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CACHE_TTL_MS;
}

function cacheKey(
  webId: string,
  provider: string,
  deployment: GatewayDeployment | undefined,
  context?: DiscoveryContext,
): string {
  return [
    webId,
    provider,
    deployment ?? 'local',
    context?.credentialId ?? '',
    context?.credentialIri ?? '',
    context?.offeringId ?? '',
    context?.baseUrl ?? '',
    context?.proxyUrl ?? '',
    context?.compatibility ?? '',
  ].join('\u0000');
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
