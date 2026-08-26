import type { ProviderRegistry } from './providers/ProviderRegistry';
import type {
  DiscoveredProviderModel,
  ProviderModelsAdapter,
} from './models/ProviderModelsAdapter';
import {
  errorQuotaSnapshot,
  normalizeProvider,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
} from './quota/ProviderQuotaAdapter';

export interface ProviderProbeInput {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface ProviderModelDiscovery {
  provider: string;
  models: DiscoveredProviderModel[];
  observedAt: string;
  source: string;
}

export interface ProviderProbeServiceOptions {
  registry: ProviderRegistry;
  modelAdapters: ProviderModelsAdapter[];
  quotaAdapters: ProviderQuotaAdapter[];
  edition?: 'cloud' | 'local';
  now?: () => Date;
}

/**
 * Executes short-lived provider probes with credentials supplied by the current
 * caller. This service has no Pod repository and never receives Pod authority.
 */
export class ProviderProbeService {
  private readonly registry: ProviderRegistry;
  private readonly modelAdapters = new Map<string, ProviderModelsAdapter>();
  private readonly quotaAdapters = new Map<string, ProviderQuotaAdapter>();
  private readonly edition: 'cloud' | 'local';
  private readonly now: () => Date;

  public constructor(options: ProviderProbeServiceOptions) {
    this.registry = options.registry;
    this.edition = options.edition ?? 'cloud';
    this.now = options.now ?? (() => new Date());
    for (const adapter of options.modelAdapters) {
      this.modelAdapters.set(normalizeProvider(adapter.provider), adapter);
    }
    for (const adapter of options.quotaAdapters) {
      this.quotaAdapters.set(normalizeProvider(adapter.provider), adapter);
    }
  }

  public async discoverModels(input: ProviderProbeInput): Promise<ProviderModelDiscovery> {
    const provider = normalizeProvider(input.provider);
    const adapter = this.modelAdapters.get(provider);
    if (!adapter) {
      throw new Error(`models_adapter_not_found:${provider}`);
    }
    const baseUrl = this.resolveBaseUrl(provider, input.baseUrl);
    const models = await adapter.fetch({
      credential: { provider, baseUrl },
      secret: { apiKey: requireApiKey(input.apiKey) },
      signal: input.signal,
    });
    return {
      provider,
      models,
      observedAt: this.now().toISOString(),
      source: `${provider}:/models`,
    };
  }

  public async quota(input: ProviderProbeInput): Promise<NormalizedQuotaSnapshot> {
    const provider = normalizeProvider(input.provider);
    const adapter = this.quotaAdapters.get(provider);
    if (!adapter) {
      throw new Error(`quota_adapter_not_found:${provider}`);
    }
    const baseUrl = this.resolveBaseUrl(provider, input.baseUrl);
    const apiKey = requireApiKey(input.apiKey);
    const now = this.now();
    try {
      return await adapter.fetch({
        credential: {
          provider,
          baseUrl,
        },
        secret: { apiKey },
        now,
        signal: input.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return errorQuotaSnapshot({
        credential: provider,
        source: `${provider}:quota`,
        now,
        metadata: { reason: 'provider_quota_unavailable' },
      });
    }
  }

  private resolveBaseUrl(provider: string, requested?: string): string {
    const descriptor = this.registry.requireProvider(provider);
    if (!requested) {
      return descriptor.defaultBaseUrl;
    }
    const normalized = normalizeBaseUrl(requested, this.edition === 'local');
    if (this.edition === 'local') {
      return normalized;
    }
    const allowed = descriptor.safeBaseUrls.map((value) => normalizeBaseUrl(value));
    if (!allowed.includes(normalized)) {
      throw new Error('provider_base_url_not_allowed');
    }
    return normalized;
  }
}

function requireApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey) {
    throw new Error('provider_api_key_required');
  }
  return apiKey;
}

function normalizeBaseUrl(value: string, allowHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('provider_base_url_not_allowed');
  }
  if (url.protocol !== 'https:' && (!allowHttp || url.protocol !== 'http:')) {
    throw new Error('provider_base_url_not_allowed');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('provider_base_url_not_allowed');
  }
  return url.toString().replace(/\/$/u, '');
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError',
  );
}
