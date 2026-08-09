import type { ConnectCredentialRecord } from '../connect';
import type { ProviderSecret } from '../credentials/CredentialVault';
import { apiKeyFromSecret } from '../quota/ProviderQuotaAdapter';
import type {
  ProviderOfferingDescriptor,
  ProviderProductDescriptor,
} from '../providers/ProviderRegistry';

export interface DiscoveredProviderModel {
  id: string;
  displayName?: string;
  capabilities?: string[];
  availability?: 'available' | 'unavailable';
  metadata?: {
    sources?: ProviderModelDiscoverySource[];
  };
}

export interface ProviderModelDiscoverySource {
  credential: string;
  source: string;
  status: 'available' | 'unavailable' | 'error';
  error?: string;
}

export interface ModelsCredentialRecord extends ConnectCredentialRecord {
  baseUrl?: string;
}

export interface ProviderModelsFetchInput {
  credential: ModelsCredentialRecord;
  secret: ProviderSecret;
  signal?: AbortSignal;
}

export interface ProviderModelsAdapter {
  readonly provider: string;
  fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]>;
}

export class ProviderModelsFetchError extends Error {
  public readonly providerStatus: number;
  public readonly retryAfter?: string | null;

  public constructor(providerStatus: number, retryAfter?: string | null) {
    super(`provider_models_fetch_failed:${providerStatus}`);
    this.name = 'ProviderModelsFetchError';
    this.providerStatus = providerStatus;
    this.retryAfter = retryAfter;
  }
}

export interface OpenAiCompatibleModelsAdapterOptions {
  provider: string;
  defaultBaseUrl: string;
  safeBaseUrls?: string[];
  product?: ProviderProductDescriptor;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleModelsAdapter implements ProviderModelsAdapter {
  public readonly provider: string;
  private readonly defaultBaseUrl: string;
  private readonly safeBaseUrls: string[];
  private readonly product?: ProviderProductDescriptor;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: OpenAiCompatibleModelsAdapterOptions) {
    this.provider = options.provider;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.safeBaseUrls = options.safeBaseUrls ?? [options.defaultBaseUrl];
    this.product = options.product;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]> {
    const apiKey = apiKeyFromSecret(input.secret);
    if (!apiKey) {
      throw new Error('models_secret_missing');
    }
    const target = resolveOfferingDiscoveryTarget(
      input.credential,
      this.product,
      this.defaultBaseUrl,
      this.safeBaseUrls,
    );
    const response = await this.fetchImpl(`${target.baseUrl}${target.path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: input.signal,
    });
    if (!response.ok) {
      await response.text().catch(() => '');
      throw new ProviderModelsFetchError(
        response.status,
        response.headers.get('Retry-After') ?? response.headers.get('retry-after'),
      );
    }
    return normalizeDiscoveredModels(await response.json());
  }
}

function resolveOfferingDiscoveryTarget(
  credential: ModelsCredentialRecord,
  product: ProviderProductDescriptor | undefined,
  defaultBaseUrl: string,
  safeBaseUrls: readonly string[],
): { baseUrl: string; path: string } {
  const offering = resolveCredentialOffering(credential, product);
  if (offering?.modelDiscovery.strategy === 'unsupported') {
    throw new Error(`models_discovery_unsupported:${offering.id}`);
  }
  const endpoint = offering
    ? offering.endpoints.find((candidate) => candidate.protocol === offering.modelDiscovery.endpointProtocol)
    : undefined;
  if (offering && !endpoint) {
    throw new Error(`models_discovery_endpoint_not_found:${offering.id}`);
  }
  const siblingBaseUrls = new Set(product?.offerings
    .filter((candidate) => candidate.id !== offering?.id)
    .flatMap((candidate) => candidate.endpoints.map((item) => item.baseUrl)) ?? []);
  const allowedBaseUrls = offering && endpoint
    ? [endpoint.baseUrl, ...safeBaseUrls.filter((baseUrl) => !siblingBaseUrls.has(baseUrl))]
    : safeBaseUrls;
  return {
    baseUrl: resolveSafeModelsBaseUrl(
      credential.baseUrl,
      endpoint?.baseUrl ?? defaultBaseUrl,
      allowedBaseUrls,
    ),
    path: normalizeDiscoveryPath(offering?.modelDiscovery.path ?? '/models'),
  };
}

function resolveCredentialOffering(
  credential: ModelsCredentialRecord,
  product: ProviderProductDescriptor | undefined,
): ProviderOfferingDescriptor | undefined {
  if (!product) return undefined;
  if (credential.offeringId) {
    const offering = product.offerings.find((candidate) => candidate.id === credential.offeringId);
    if (!offering) throw new Error(`models_offering_not_found:${credential.offeringId}`);
    return offering;
  }
  const provider = credential.provider.trim().toLowerCase();
  const candidates = product.offerings.filter((candidate) =>
    candidate.runtimeProviderIds.some((runtimeProviderId) => runtimeProviderId === provider)
    && offeringAcceptsCredential(candidate, credential.authMode));
  if (candidates.length === 1) return candidates[0];
  throw new Error(`models_offering_required:${product.id}`);
}

function offeringAcceptsCredential(
  offering: ProviderOfferingDescriptor,
  authMode: ModelsCredentialRecord['authMode'],
): boolean {
  if (authMode === 'apiKey') return offering.authModes.includes('apiKey');
  if (authMode === 'deviceCodeOAuth') {
    return offering.authModes.includes('deviceCode') || offering.authModes.includes('oauth');
  }
  return offering.authModes.includes('oauth');
}

function normalizeDiscoveryPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('invalid_models_discovery_path');
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export const ANTHROPIC_MODELS_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_MODELS_VERSION = '2023-06-01';

export class AnthropicModelsAdapter implements ProviderModelsAdapter {
  public readonly provider = 'anthropic';
  private readonly defaultBaseUrl: string;
  private readonly safeBaseUrls: string[];
  private readonly product?: ProviderProductDescriptor;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: { defaultBaseUrl?: string; safeBaseUrls?: string[]; product?: ProviderProductDescriptor; fetchImpl?: typeof fetch } = {}) {
    this.defaultBaseUrl = options.defaultBaseUrl ?? ANTHROPIC_MODELS_BASE_URL;
    this.safeBaseUrls = options.safeBaseUrls ?? [this.defaultBaseUrl];
    this.product = options.product;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]> {
    const apiKey = apiKeyFromSecret(input.secret);
    if (!apiKey) {
      throw new Error('models_secret_missing');
    }
    const target = resolveOfferingDiscoveryTarget(
      input.credential,
      this.product,
      this.defaultBaseUrl,
      this.safeBaseUrls,
    );
    const response = await this.fetchImpl(`${target.baseUrl}${target.path}`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_MODELS_VERSION,
      },
      signal: input.signal,
    });
    if (!response.ok) {
      await response.text().catch(() => '');
      throw new ProviderModelsFetchError(
        response.status,
        response.headers.get('Retry-After') ?? response.headers.get('retry-after'),
      );
    }
    return normalizeDiscoveredModels(await response.json());
  }
}

export function resolveSafeModelsBaseUrl(
  configuredBaseUrl: string | undefined,
  defaultBaseUrl: string,
  safeBaseUrls: readonly string[],
): string {
  const requested = normalizeModelsBaseUrl(configuredBaseUrl ?? defaultBaseUrl);
  const allowed = new Set(safeBaseUrls.map(normalizeModelsBaseUrl));
  if (!allowed.has(requested)) {
    throw new Error('unsafe_provider_base_url');
  }
  return requested;
}

function normalizeModelsBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('unsafe_provider_base_url');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('unsafe_provider_base_url');
  }
  return url.href.replace(/\/$/u, '');
}

export function normalizeDiscoveredModels(payload: unknown): DiscoveredProviderModel[] {
  const items = extractModelList(payload);
  const models: DiscoveredProviderModel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? record.name ?? record.model ?? record.slug ?? record.uid ?? '').trim();
    if (!id || seen.has(id) || isEmbeddingModel(id)) {
      continue;
    }
    seen.add(id);
    const displayName = stringValue(
      record.display_name ?? record.displayName ?? record.title ?? record.name,
    );
    const capabilities = normalizeCapabilities(record);
    models.push({
      id,
      ...(displayName && displayName !== id ? { displayName } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
    });
  }
  return models;
}

function extractModelList(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return Array.isArray(payload) ? payload : [];
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'models', 'result']) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  const nested = record.models;
  if (nested && typeof nested === 'object' && Array.isArray((nested as Record<string, unknown>).models)) {
    return (nested as Record<string, unknown>).models as unknown[];
  }
  return [];
}

function isEmbeddingModel(id: string): boolean {
  return /embed/i.test(id);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCapabilities(record: Record<string, unknown>): string[] {
  const raw = record.capabilities ?? record.capability;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}
