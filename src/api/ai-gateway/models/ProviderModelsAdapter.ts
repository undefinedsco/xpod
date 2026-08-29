import type { ConnectCredentialRecord } from '../connect';
import type { ProviderSecret } from '../credentials/CredentialVault';
import { apiKeyFromSecret } from '../quota/ProviderQuotaAdapter';
import { ProviderHttpTransport } from '../../service/provider-http-transport';
import type {
  ProviderOfferingDescriptor,
  ProviderProductDescriptor,
  ProviderRegistry,
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
  proxyUrl?: string;
}

export interface ProviderModelsFetchInput {
  credential: ModelsCredentialRecord;
  secret: ProviderSecret;
  signal?: AbortSignal;
}

export interface ProviderModelsAdapter {
  readonly provider?: string;
  readonly protocol?: string;
  fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]>;
}

export class ProviderModelsFetchError extends Error {
  public readonly providerStatus: number;
  public readonly retryAfter?: string | null;
  public readonly providerMessage?: string;

  public constructor(providerStatus: number, retryAfter?: string | null, providerMessage?: string) {
    super(`provider_models_fetch_failed:${providerStatus}`);
    this.name = 'ProviderModelsFetchError';
    this.providerStatus = providerStatus;
    this.retryAfter = retryAfter;
    this.providerMessage = providerMessage;
  }
}

/**
 * The upstream returned HTTP 2xx but still reported a business failure.
 * Keep this separate from transport/status failures so the management API can
 * surface a sanitized provider message without ever echoing credentials.
 */
export class ProviderModelsResponseError extends Error {
  public readonly safeMessage: string;

  public constructor(message: string) {
    super(`provider_models_response_error:${message}`);
    this.name = 'ProviderModelsResponseError';
    this.safeMessage = message;
  }
}

export interface OpenAiCompatibleModelsAdapterOptions {
  provider?: string;
  protocol?: 'openai-models';
  registry?: ProviderRegistry;
  defaultBaseUrl?: string;
  safeBaseUrls?: string[];
  product?: ProviderProductDescriptor;
  fetchImpl?: typeof fetch;
  transport?: ProviderHttpTransport;
}

export interface CodexSubscriptionModelsAdapterOptions {
  transport?: ProviderHttpTransport;
  clientVersion?: string;
}

/** Discovers the models currently enabled for a ChatGPT Codex subscription. */
export class CodexSubscriptionModelsAdapter implements ProviderModelsAdapter {
  public readonly protocol = 'codex-models';
  private readonly transport: ProviderHttpTransport;
  private readonly clientVersion: string;

  public constructor(options: CodexSubscriptionModelsAdapterOptions = {}) {
    this.transport = options.transport ?? new ProviderHttpTransport();
    this.clientVersion = options.clientVersion ?? '0.0.0';
  }

  public async fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]> {
    const accessToken = stringSecret(input.secret, 'accessToken', 'access_token');
    const accountId = stringSecret(input.secret, 'accountId', 'account_id');
    if (!accessToken) throw new Error('models_secret_missing');
    const headers = new Headers({
      authorization: `Bearer ${accessToken}`,
      originator: 'xpod',
    });
    if (accountId) headers.set('ChatGPT-Account-Id', accountId);
    try {
      const body = await this.transport.getJson({
        url: `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(this.clientVersion)}`,
        headers,
        proxy: input.credential.proxyUrl,
        signal: input.signal,
      });
      const models: unknown[] = Array.isArray(body?.models) ? body.models : [];
      return models
        .filter((model: unknown): model is Record<string, unknown> => Boolean(model) && typeof model === 'object')
        .filter((model) => model.visibility !== 'hide')
        .map((model) => ({
          id: String(model.slug ?? model.id ?? '').trim(),
          ...(typeof model.display_name === 'string' && model.display_name.trim()
            ? { displayName: model.display_name.trim() }
            : {}),
        }))
        .filter((model) => Boolean(model.id));
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : undefined;
      if (status !== undefined) throw new ProviderModelsFetchError(status);
      throw error;
    }
  }
}

function stringSecret(secret: ProviderSecret, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = secret[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export class OpenAiCompatibleModelsAdapter implements ProviderModelsAdapter {
  public readonly provider?: string;
  public readonly protocol: string;
  private readonly registry?: ProviderRegistry;
  private readonly defaultBaseUrl?: string;
  private readonly safeBaseUrls: string[];
  private readonly product?: ProviderProductDescriptor;
  private readonly transport: ProviderHttpTransport;

  public constructor(options: OpenAiCompatibleModelsAdapterOptions) {
    this.provider = options.provider;
    this.protocol = options.protocol ?? 'openai-models';
    this.registry = options.registry;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.safeBaseUrls = options.safeBaseUrls ?? (options.defaultBaseUrl ? [options.defaultBaseUrl] : []);
    this.product = options.product;
    this.transport = options.transport ?? new ProviderHttpTransport({ fetch: options.fetchImpl });
  }

  public async fetch(input: ProviderModelsFetchInput): Promise<DiscoveredProviderModel[]> {
    const bearerToken = bearerTokenFromSecret(input.secret);
    const product = this.registry?.getProduct(input.credential.provider) ?? this.product;
    const provider = this.registry?.getProvider(input.credential.provider);
    const offering = resolveCredentialOffering(input.credential, product);
    if (!bearerToken
      && input.credential.authMode !== 'local'
      && input.credential.provider.trim().toLowerCase() !== 'ollama'
      && !offering?.authModes.includes('local')) {
      throw new Error('models_secret_missing');
    }
    const target = resolveOfferingDiscoveryTarget(
      input.credential,
      product,
      this.defaultBaseUrl ?? provider?.defaultBaseUrl ?? '',
      this.registry
        ? [ ...(provider?.safeBaseUrls ?? []), ...(product?.offerings.flatMap((offering) => offering.endpoints.map((endpoint) => endpoint.baseUrl)) ?? []) ]
        : this.safeBaseUrls,
      isCustomProvider(input.credential.provider),
    );
    try {
      const body = await this.transport.getJson({
        url: `${target.baseUrl}${target.path}`,
        headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : undefined,
        proxy: input.credential.proxyUrl,
        signal: input.signal,
        allowPrivateNetwork: allowsLocalProviderNetwork(input.credential, offering),
      });
      return normalizeDiscoveredModels(body);
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : undefined;
      if (status !== undefined) {
        const responseMessage = status === 403 ? providerErrorMessage(error) : undefined;
        if (responseMessage) {
          throw new ProviderModelsResponseError(responseMessage);
        }
        const headers = (error as { headers?: Headers }).headers;
        const body = typeof (error as { body?: unknown })?.body === 'string'
          ? (error as { body: string }).body
          : '';
        throw new ProviderModelsFetchError(
          status,
          headers?.get('Retry-After') ?? headers?.get('retry-after'),
          safeProviderMessage(body, bearerToken ?? ''),
        );
      }
      throw error;
    }
  }
}

function bearerTokenFromSecret(secret: ProviderSecret): string | undefined {
  const apiKey = apiKeyFromSecret(secret);
  if (apiKey) return apiKey;
  const accessToken = secret.accessToken;
  return typeof accessToken === 'string' && accessToken.trim() ? accessToken : undefined;
}

function resolveOfferingDiscoveryTarget(
  credential: ModelsCredentialRecord,
  product: ProviderProductDescriptor | undefined,
  defaultBaseUrl: string,
  safeBaseUrls: readonly string[],
  allowCredentialBaseUrl = false,
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
      allowCredentialBaseUrl,
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
  if (authMode === 'local') return offering.authModes.includes('local');
  if (authMode === 'deviceCodeOAuth') {
    return offering.authModes.includes('deviceCode')
      || offering.authModes.includes('oauth')
      || (offering.kind === 'oauth-subscription' && offering.authModes.includes('local'));
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
  public readonly protocol = 'anthropic-models';
  private readonly defaultBaseUrl: string;
  private readonly safeBaseUrls: string[];
  private readonly product?: ProviderProductDescriptor;
  private readonly transport: ProviderHttpTransport;

  public constructor(options: { defaultBaseUrl?: string; safeBaseUrls?: string[]; product?: ProviderProductDescriptor; fetchImpl?: typeof fetch; transport?: ProviderHttpTransport } = {}) {
    this.defaultBaseUrl = options.defaultBaseUrl ?? ANTHROPIC_MODELS_BASE_URL;
    this.safeBaseUrls = options.safeBaseUrls ?? [this.defaultBaseUrl];
    this.product = options.product;
    this.transport = options.transport ?? new ProviderHttpTransport({ fetch: options.fetchImpl });
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
      isCustomProvider(input.credential.provider),
    );
    try {
      const body = await this.transport.getJson({
        url: `${target.baseUrl}${target.path}`,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_MODELS_VERSION,
        },
        proxy: input.credential.proxyUrl,
        signal: input.signal,
        allowPrivateNetwork: allowsLocalProviderNetwork(input.credential, resolveCredentialOffering(input.credential, this.product)),
      });
      return normalizeDiscoveredModels(body);
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : undefined;
      if (status !== undefined) {
        const responseMessage = status === 403 ? providerErrorMessage(error) : undefined;
        if (responseMessage) {
          throw new ProviderModelsResponseError(responseMessage);
        }
        const headers = (error as { headers?: Headers }).headers;
        const body = typeof (error as { body?: unknown })?.body === 'string'
          ? (error as { body: string }).body
          : '';
        throw new ProviderModelsFetchError(
          status,
          headers?.get('Retry-After') ?? headers?.get('retry-after'),
          safeProviderMessage(body, apiKey),
        );
      }
      throw error;
    }
  }
}

export function resolveSafeModelsBaseUrl(
  configuredBaseUrl: string | undefined,
  defaultBaseUrl: string,
  safeBaseUrls: readonly string[],
  allowCredentialBaseUrl = false,
): string {
  if (allowCredentialBaseUrl && configuredBaseUrl) {
    return normalizeModelsBaseUrl(configuredBaseUrl);
  }
  const requested = normalizeModelsBaseUrl(configuredBaseUrl ?? defaultBaseUrl);
  const allowed = new Set(safeBaseUrls.map(normalizeModelsBaseUrl));
  if (!allowed.has(requested)) {
    throw new Error('unsafe_provider_base_url');
  }
  return requested;
}

function isCustomProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === 'custom';
}

function allowsLocalProviderNetwork(
  credential: ModelsCredentialRecord,
  _offering: ProviderOfferingDescriptor | undefined,
): boolean {
  // Deployment is assigned by the Xpod runtime. Provider/auth metadata comes
  // from the user's Pod and must never be able to relax the Cloud SSRF policy.
  return credential.deployment === 'local';
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
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/v1';
  }
  return url.href.replace(/\/$/u, '');
}

function safeProviderMessage(raw: string, secret: string): string | undefined {
  const message = providerMessageFromJson(raw) ?? providerMessageFromText(raw);
  if (!message) return undefined;
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

function providerMessageFromJson(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : undefined;
    return boundedMessage(
      stringValue(nested?.message)
        ?? stringValue(record.message)
        ?? stringValue(record.error_description)
        ?? stringValue(record.error),
    );
  } catch {
    return undefined;
  }
}

function providerMessageFromText(raw: string): string | undefined {
  return boundedMessage(raw);
}

function boundedMessage(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 240);
}

export function normalizeDiscoveredModels(payload: unknown): DiscoveredProviderModel[] {
  const responseError = providerResponseErrorMessage(payload);
  if (responseError) {
    throw new ProviderModelsResponseError(responseError);
  }
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

function providerResponseErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (extractModelList(payload).length > 0) return undefined;
  const candidate = stringValue(record.message)
    ?? stringValue(record.error)
    ?? stringValue(record.msg);
  if (!candidate) return undefined;
  const sanitized = sanitizeProviderResponseMessage(candidate);
  return sanitized || undefined;
}

function providerErrorMessage(error: unknown): string | undefined {
  const body = (error as { body?: unknown })?.body;
  if (typeof body !== 'string' || !body.trim()) return undefined;
  try {
    return providerResponseErrorMessage(JSON.parse(body));
  } catch {
    // Only structured provider responses are eligible for display. Plain text
    // can contain proxy diagnostics, request URLs, or credential fragments.
    return undefined;
  }
}

function sanitizeProviderResponseMessage(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/(?:sk|id)[._-][A-Za-z0-9._-]{8,}/gu, '[REDACTED]')
    .replace(/https?:\/\/[^\s]+/giu, '[URL]')
    .trim()
    .slice(0, 240);
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
