import { getLoggerFor } from 'global-logger-factory';
import type { ProviderModelDescriptor, ProviderRegistry } from './ProviderRegistry';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

export const XPOD_PROVIDER_TO_MODELS_DEV: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  kimi: 'moonshotai',
  bailian: 'alibaba-cn',
  deepseek: 'deepseek',
};

export interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  api?: string;
  env?: string[];
  doc?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface FetchModelsDevCatalogOptions {
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

let catalogCache: { fetchedAt: number; catalog: ModelsDevCatalog } | undefined;

export function resetModelsDevCatalogCache(): void {
  catalogCache = undefined;
}

export async function fetchModelsDevCatalog(options: FetchModelsDevCatalogOptions = {}): Promise<ModelsDevCatalog | undefined> {
  const logger = getLoggerFor('ModelsDevCatalog');
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (catalogCache && now() - catalogCache.fetchedAt < cacheTtlMs) {
    return catalogCache.catalog;
  }
  try {
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(options.url ?? MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`models.dev responded ${response.status}`);
    }
    const body = await response.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('models.dev payload is not a provider catalog object');
    }
    const catalog = body as ModelsDevCatalog;
    catalogCache = { fetchedAt: now(), catalog };
    return catalog;
  } catch (error) {
    logger.warn(`Failed to fetch models.dev catalog; keeping static provider seeds. ${(error as Error).message}`);
    return catalogCache?.catalog;
  }
}

export function modelsDevModelDescriptors(provider: ModelsDevProvider): ProviderModelDescriptor[] {
  return Object.values(provider.models ?? {}).map((model) => ({
    id: model.id,
    contextWindow: model.limit?.context,
    inputModalities: model.modalities?.input,
    capabilities: {
      toolCalls: model.tool_call,
      reasoningEffort: model.reasoning,
      imageInput: model.modalities?.input?.includes('image') ?? undefined,
    },
    metadata: {
      source: 'models.dev',
      name: model.name,
      description: model.description,
      family: model.family,
      knowledge: model.knowledge,
      releaseDate: model.release_date,
      lastUpdated: model.last_updated,
      openWeights: model.open_weights,
      limit: model.limit,
      cost: model.cost,
    },
  }));
}

export function syncProviderRegistryWithModelsDev(
  registry: ProviderRegistry,
  catalog: ModelsDevCatalog,
  mapping: Record<string, string> = XPOD_PROVIDER_TO_MODELS_DEV,
): string[] {
  const synced: string[] = [];
  for (const [providerId, modelsDevId] of Object.entries(mapping)) {
    const entry = catalog[modelsDevId];
    if (!entry?.models || Object.keys(entry.models).length === 0) {
      continue;
    }
    try {
      registry.mergeDiscoveredModels(providerId, modelsDevModelDescriptors(entry));
      synced.push(providerId);
    } catch (error) {
      getLoggerFor('ModelsDevCatalog').warn(`Skipping models.dev sync for ${providerId}: ${(error as Error).message}`);
    }
  }
  return synced;
}

export async function syncProviderRegistryFromModelsDev(
  registry: ProviderRegistry,
  options: FetchModelsDevCatalogOptions = {},
): Promise<string[]> {
  const catalog = await fetchModelsDevCatalog(options);
  if (!catalog) {
    return [];
  }
  const synced = syncProviderRegistryWithModelsDev(registry, catalog);
  if (synced.length > 0) {
    getLoggerFor('ModelsDevCatalog').info(`Synchronized provider catalogs from models.dev: ${synced.join(', ')}`);
  }
  return synced;
}
