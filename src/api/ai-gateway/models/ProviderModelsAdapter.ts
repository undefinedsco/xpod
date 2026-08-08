import type { ConnectCredentialRecord } from '../connect';
import type { ProviderSecret } from '../credentials/CredentialVault';
import { apiKeyFromSecret } from '../quota/ProviderQuotaAdapter';

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
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleModelsAdapter implements ProviderModelsAdapter {
  public readonly provider: string;
  private readonly defaultBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: OpenAiCompatibleModelsAdapterOptions) {
    this.provider = options.provider;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]> {
    const apiKey = apiKeyFromSecret(input.secret);
    if (!apiKey) {
      throw new Error('models_secret_missing');
    }
    const baseUrl = (input.credential.baseUrl ?? this.defaultBaseUrl).replace(/\/$/, '');
    const response = await this.fetchImpl(`${baseUrl}/models`, {
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

export const ANTHROPIC_MODELS_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_MODELS_VERSION = '2023-06-01';

export class AnthropicModelsAdapter implements ProviderModelsAdapter {
  public readonly provider = 'anthropic';
  private readonly defaultBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: { defaultBaseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.defaultBaseUrl = options.defaultBaseUrl ?? ANTHROPIC_MODELS_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]> {
    const apiKey = apiKeyFromSecret(input.secret);
    if (!apiKey) {
      throw new Error('models_secret_missing');
    }
    const baseUrl = (input.credential.baseUrl ?? this.defaultBaseUrl).replace(/\/$/, '');
    const response = await this.fetchImpl(`${baseUrl}/models`, {
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
