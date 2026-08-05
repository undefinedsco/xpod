import { GatewayProtocolError } from '../errors';
import type { ProviderSecret } from '../credentials/CredentialVault';
import {
  createDefaultProviderRegistry,
  normalizeProviderId,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../providers/ProviderRegistry';

export type DiscoveredProviderModel = {
  id: string;
  displayName?: string;
  modelType: 'chat' | 'embedding' | 'image' | 'audio' | 'other';
};

export interface ProviderModelDiscoveryAdapter {
  readonly provider: string;
  discover(input: {
    baseUrl: string;
    secret: ProviderSecret;
    signal?: AbortSignal;
  }): Promise<DiscoveredProviderModel[]>;
}

export interface ProviderModelDiscoveryAdapterOptions {
  registry?: ProviderRegistry;
  fetch?: typeof fetch;
  maxPages?: number;
}

export interface ProviderModelDiscoveryRegistryOptions extends ProviderModelDiscoveryAdapterOptions {}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_PAGES = 20;

/**
 * Typed lookup for the provider-specific model discovery adapters.
 *
 * The registry deliberately contains only the providers with a supported
 * model-list transport. Adding a provider requires an explicit adapter rather
 * than falling back to an arbitrary endpoint.
 */
export class ProviderModelDiscoveryRegistry {
  public readonly adapters: ReadonlyMap<string, ProviderModelDiscoveryAdapter>;

  public constructor(options: ProviderModelDiscoveryRegistryOptions = {}) {
    const registry = options.registry ?? createDefaultProviderRegistry();
    const adapterOptions = {
      fetch: options.fetch,
      maxPages: options.maxPages,
    };
    const adapters = new Map<string, ProviderModelDiscoveryAdapter>();
    adapters.set('openai', new OpenAiProviderModelDiscoveryAdapter({
      ...adapterOptions,
      provider: registry.requireProvider('openai'),
    }));
    adapters.set('anthropic', new AnthropicProviderModelDiscoveryAdapter({
      ...adapterOptions,
      provider: registry.requireProvider('anthropic'),
    }));
    adapters.set('kimi', new KimiProviderModelDiscoveryAdapter({
      ...adapterOptions,
      provider: registry.requireProvider('kimi'),
    }));
    adapters.set('bailian', new BailianProviderModelDiscoveryAdapter({
      ...adapterOptions,
      provider: registry.requireProvider('bailian'),
    }));
    adapters.set('deepseek', new DeepSeekProviderModelDiscoveryAdapter({
      ...adapterOptions,
      provider: registry.requireProvider('deepseek'),
    }));
    this.adapters = adapters;
  }

  public get(provider: string): ProviderModelDiscoveryAdapter {
    const normalized = normalizeProviderId(provider);
    const adapter = this.adapters.get(normalized);
    if (!adapter) {
      throw new GatewayProtocolError('Unknown provider model discovery adapter', {
        code: 'invalid_request',
        status: 400,
        details: { provider: normalized },
      });
    }
    return adapter;
  }

  public list(): ProviderModelDiscoveryAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export type ProviderModelDiscoveryAdapterRegistry = ProviderModelDiscoveryRegistry;

export function createProviderModelDiscoveryAdapters(
  options: ProviderModelDiscoveryAdapterOptions = {},
): ProviderModelDiscoveryRegistry {
  return new ProviderModelDiscoveryRegistry(options);
}

interface ProviderModelDiscoveryAdapterConstructorOptions {
  provider: ProviderDescriptor;
  fetch?: typeof fetch;
  maxPages?: number;
}

abstract class BaseProviderModelDiscoveryAdapter implements ProviderModelDiscoveryAdapter {
  public readonly provider: string;
  protected readonly descriptor: ProviderDescriptor;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPages: number;
  private readonly paginationCursorParam: string;

  public constructor(options: ProviderModelDiscoveryAdapterConstructorOptions, paginationCursorParam = 'after') {
    this.provider = normalizeProviderId(options.provider.id);
    this.descriptor = options.provider;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxPages = normalizeMaxPages(options.maxPages);
    this.paginationCursorParam = paginationCursorParam;
  }

  public async discover(input: {
    baseUrl: string;
    secret: ProviderSecret;
    signal?: AbortSignal;
  }): Promise<DiscoveredProviderModel[]> {
    const baseUrl = this.resolveBaseUrl(input.baseUrl);
    const headers = this.createHeaders(input.secret);
    const models = new Map<string, DiscoveredProviderModel>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;

    while (true) {
      if (pageCount >= this.maxPages) {
        throw discoveryError(this.provider, 502, 'pagination_limit');
      }
      const url = buildModelsUrl(baseUrl, this.paginationCursorParam, cursor);
      const body = await this.fetchPage(url, headers, input.signal);
      const page = parseModelPage(body, this.provider);
      pageCount += 1;

      for (const row of page.rows) {
        const model = normalizeModelRow(row);
        if (model && !models.has(model.id)) {
          models.set(model.id, model);
        }
      }

      if (!page.nextCursor) {
        break;
      }
      if (seenCursors.has(page.nextCursor)) {
        // A provider returning the same cursor would otherwise loop forever.
        // The models collected so far are still a deterministic prefix of the
        // catalog, so return them rather than issuing an unsafe extra request.
        break;
      }
      seenCursors.add(page.nextCursor);
      if (pageCount >= this.maxPages) {
        throw discoveryError(this.provider, 502, 'pagination_limit');
      }
      cursor = page.nextCursor;
    }

    return Array.from(models.values());
  }

  protected createHeaders(secret: ProviderSecret): Headers {
    const token = tokenFromSecret(secret);
    if (!token) {
      throw new GatewayProtocolError('Provider credential is missing an API key or access token', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider },
      });
    }
    return new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    });
  }

  private resolveBaseUrl(candidate: string): string {
    if (typeof candidate !== 'string' || !candidate) {
      throw new GatewayProtocolError('Configured provider endpoint is not allowed', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider },
      });
    }
    const normalizedCandidate = trimTrailingSlash(candidate);
    const allowed = this.descriptor.safeBaseUrls
      .map((safeBaseUrl) => trimTrailingSlash(safeBaseUrl));
    if (!allowed.includes(normalizedCandidate)) {
      throw new GatewayProtocolError('Configured provider endpoint is not allowed', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider },
      });
    }
    return normalizedCandidate;
  }

  private async fetchPage(url: string, headers: Headers, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw discoveryError(this.provider, 502, 'network_error');
    }

    if (!response.ok) {
      const retryAfter = response.headers.get('Retry-After') ?? response.headers.get('retry-after');
      // Consume the body but never include it in an exception. Provider error
      // payloads frequently echo credentials or request material.
      await response.text().catch(() => undefined);
      throw discoveryError(this.provider, response.status, classificationForStatus(response.status), retryAfter);
    }

    try {
      return await response.json();
    } catch {
      throw discoveryError(this.provider, 502, 'invalid_response');
    }
  }
}

export class OpenAiProviderModelDiscoveryAdapter extends BaseProviderModelDiscoveryAdapter {
  public constructor(options: ProviderModelDiscoveryAdapterConstructorOptions) {
    super(options, 'after');
  }
}

export class AnthropicProviderModelDiscoveryAdapter extends BaseProviderModelDiscoveryAdapter {
  public constructor(options: ProviderModelDiscoveryAdapterConstructorOptions) {
    super(options, 'after_id');
  }

  protected override createHeaders(secret: ProviderSecret): Headers {
    const apiKey = nonEmptySecretValue(secret.apiKey);
    const accessToken = nonEmptySecretValue(secret.accessToken);
    if (!apiKey && !accessToken) {
      throw new GatewayProtocolError('Provider credential is missing an API key or access token', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider },
      });
    }
    const headers = new Headers({
      Accept: 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    });
    if (apiKey) {
      headers.set('x-api-key', apiKey);
    } else {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return headers;
  }
}

export class KimiProviderModelDiscoveryAdapter extends BaseProviderModelDiscoveryAdapter {}

export class BailianProviderModelDiscoveryAdapter extends BaseProviderModelDiscoveryAdapter {}

export class DeepSeekProviderModelDiscoveryAdapter extends BaseProviderModelDiscoveryAdapter {}

// Short aliases are useful to callers that construct one adapter directly.
export {
  OpenAiProviderModelDiscoveryAdapter as OpenAiModelDiscoveryAdapter,
  AnthropicProviderModelDiscoveryAdapter as AnthropicModelDiscoveryAdapter,
  KimiProviderModelDiscoveryAdapter as KimiModelDiscoveryAdapter,
  BailianProviderModelDiscoveryAdapter as BailianModelDiscoveryAdapter,
  DeepSeekProviderModelDiscoveryAdapter as DeepSeekModelDiscoveryAdapter,
};

interface ParsedModelPage {
  rows: unknown[];
  nextCursor?: string;
}

function parseModelPage(body: unknown, provider: string): ParsedModelPage {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw discoveryError(provider, 502, 'invalid_response');
  }
  const record = body as Record<string, unknown>;
  let rows: unknown[] | undefined;
  if ('data' in record) {
    rows = Array.isArray(record.data) ? record.data : undefined;
  } else if ('models' in record) {
    rows = Array.isArray(record.models) ? record.models : undefined;
  }
  if (!rows) {
    throw discoveryError(provider, 502, 'invalid_response');
  }

  const hasMore = record.has_more === true || record.hasMore === true;
  const explicitCursor = firstString([
    record.next_cursor,
    record.nextCursor,
    record.next_page_token,
    record.nextPageToken,
    record.next,
    record.cursor,
    nestedValue(record.pagination, 'next_cursor'),
    nestedValue(record.pagination, 'nextCursor'),
    nestedValue(record.meta, 'next_cursor'),
    nestedValue(record.meta, 'nextCursor'),
  ]);
  const lastId = firstString([record.last_id, record.lastId]);
  const nextCursor = explicitCursor ?? (hasMore ? lastId : undefined);
  if (hasMore && !nextCursor) {
    throw discoveryError(provider, 502, 'pagination_cursor_missing');
  }
  return { rows, nextCursor };
}

function normalizeModelRow(row: unknown): DiscoveredProviderModel | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const id = firstString([record.id, record.model, record.model_id]);
  if (!id) {
    return undefined;
  }
  const displayName = firstString([record.display_name, record.displayName, record.name]);
  return {
    id,
    ...(displayName ? { displayName } : {}),
    modelType: inferModelType(record, id),
  };
}

function inferModelType(record: Record<string, unknown>, id: string): DiscoveredProviderModel['modelType'] {
  const signals = [
    record.modelType,
    record.model_type,
    record.type,
    record.category,
    record.modality,
    record.modalities,
    capabilityTypeSignals(record.capabilities),
  ];
  const signalText = signals
    .flatMap((value) => flattenSignal(value))
    .join(' ')
    .toLowerCase();
  const text = `${signalText} ${id.toLowerCase()}`;
  if (/(?:embedding|embed)/u.test(text)) {
    return 'embedding';
  }
  if (/(?:image|dall-e|stable[-_ ]?diffusion|flux)/u.test(text)) {
    return 'image';
  }
  if (/(?:audio|whisper|speech|tts)/u.test(text)) {
    return 'audio';
  }
  if (/(?:chat|completion|conversation|text-generation|instruct|reason|coder|gpt|claude|kimi|qwen|deepseek|llama|mistral|gemini)/u.test(text)) {
    return 'chat';
  }
  return 'other';
}

function capabilityTypeSignals(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, enabled]) => enabled === true && /^(?:chat|embedding|image|audio)$/u.test(key.toLowerCase()))
    .map(([key]) => key);
}

function flattenSignal(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenSignal(item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...flattenSignal(item)]);
  }
  return [];
}

function tokenFromSecret(secret: ProviderSecret): string | undefined {
  return nonEmptySecretValue(secret.apiKey) ?? nonEmptySecretValue(secret.accessToken);
}

function nonEmptySecretValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = typeof value === 'string' && value.trim() ? value.trim() : undefined;
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function nestedValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function buildModelsUrl(baseUrl: string, cursorParam: string, cursor?: string): string {
  const url = `${baseUrl}/models`;
  if (!cursor) {
    return url;
  }
  const parsed = new URL(url);
  parsed.searchParams.set(cursorParam, cursor);
  return parsed.toString();
}

function normalizeMaxPages(maxPages: number | undefined): number {
  if (typeof maxPages !== 'number' || !Number.isFinite(maxPages) || maxPages < 1) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.floor(maxPages);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function classificationForStatus(status: number): string {
  if (status === 401) {
    return 'authentication';
  }
  if (status === 403) {
    return 'authorization';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'upstream_unavailable';
  }
  return 'provider_error';
}

function discoveryError(
  provider: string,
  status: number,
  classification: string,
  retryAfter?: string | null,
): GatewayProtocolError {
  const reauthRequired = status === 401 || status === 403;
  return new GatewayProtocolError(`Provider model discovery failed with status ${status}`, {
    code: 'provider_error',
    status,
    details: {
      provider,
      providerStatusCode: status,
      classification,
      ...(reauthRequired ? { reauthRequired: true, requiresReauth: true } : {}),
      ...(retryAfter ? { retryAfter } : {}),
    },
  });
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError',
  );
}
