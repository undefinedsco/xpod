import type { GatewayProtocol } from '../types';
import { getBuiltinProvider } from '@undefineds.co/models';
import { DEFAULT_EMBEDDING_MODEL_ID } from '../../../ai/service/defaultEmbeddingProfile';
import {
  API_KEY_METHOD,
  CUSTOM_DEFAULT_OFFERINGS,
  DEFAULT_PROVIDER_OFFERINGS,
  PROVIDER_OFFERINGS,
} from '@undefineds.co/ai-connections/provider-catalog';
import type { AiConnectionsProvider, AiProviderAuthorizationMethod, AiProviderOffering } from '@undefineds.co/ai-connections/client';
import {
  SUBSCRIPTION_AUTHORIZATION_BINDINGS,
  subscriptionAuthorizationMethods,
  type OfferingAuthorizationMethod,
} from './OfferingAuthorization';

export const OPENAI_SUBSCRIPTION_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export type ProviderId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type ProviderProductId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type ProviderAuthMode = 'browserAssistedApiKey' | 'authorizationCodeOAuth' | 'deviceCodeOAuth' | 'apiKey' | 'local' | 'connectUnsupported';
export type ProviderConnectMode = 'browserAssistedApiKey' | 'authorizationCodeOAuth' | 'deviceCodeOAuth' | 'connectUnsupported';
export type OfferingAuthMode = 'oauth' | 'deviceCode' | 'apiKey' | 'local';
export type ProviderOfferingKind =
  | 'oauth-subscription'
  | 'api-platform'
  | 'token-plan'
  | 'local';
export type ProviderOfferingLifecycle = 'active' | 'legacy' | 'unavailable';

export type ProviderAuthCapabilityProtocol =
  | 'api-key'
  | 'subscription-key'
  | 'local-none'
  | 'oauth-device-code'
  | 'oauth-authorization-code';

export interface ProviderAuthCapabilityDescriptor {
  protocol: ProviderAuthCapabilityProtocol;
}

export type ProviderUpstreamCapability = 'models' | 'inference' | 'quota' | 'balance';

export interface ProviderUpstreamCapabilityDescriptor {
  capability: ProviderUpstreamCapability;
  protocol: string;
  options?: Record<string, unknown>;
}

export interface ProviderOfferingEndpointDescriptor {
  protocol: GatewayProtocol;
  baseUrl: string;
  region?: string;
  supportsDeveloperMessages?: boolean;
}

export type ProviderModelDiscoveryStrategy = 'openaiCompatible' | 'anthropic' | 'unsupported';
export type ProviderQuotaStrategy = 'providerApi' | 'subscription' | 'console' | 'unsupported';

export interface ProviderOfferingModelDiscoveryDescriptor {
  strategy: ProviderModelDiscoveryStrategy;
  path: string;
  endpointProtocol: GatewayProtocol;
}

export interface ProviderOfferingQuotaDescriptor {
  strategy: ProviderQuotaStrategy;
  url: string;
}

export interface ProviderOfferingDescriptor {
  id: string;
  runtimeProviderIds: string[];
  label: string;
  productLabel: string;
  kind: ProviderOfferingKind;
  authModes: OfferingAuthMode[];
  auth: ProviderAuthCapabilityDescriptor[];
  upstream: ProviderUpstreamCapabilityDescriptor[];
  endpoints: ProviderOfferingEndpointDescriptor[];
  credentialPrefixHints: string[];
  consoleUrl: string;
  subscriptionUrl: string;
  modelDiscovery: ProviderOfferingModelDiscoveryDescriptor;
  quota: ProviderOfferingQuotaDescriptor;
  usagePolicyUrl: string;
  region: string;
  lifecycle: ProviderOfferingLifecycle;
  oauthIntegrationId?: string;
  authorizationMethods?: OfferingAuthorizationMethod[];
}

export interface ProviderProductDescriptor {
  id: ProviderProductId;
  label: string;
  offerings: ProviderOfferingDescriptor[];
}

export interface ProviderConnectCapability {
  mode: ProviderConnectMode;
  label: string;
  apiKeyManagementSupported: boolean;
  configured?: boolean;
  experimental?: boolean;
  requiresAuthenticatedManagementApi?: boolean;
  publicCallbackSupported?: boolean;
  remoteRevocationSupported?: boolean;
  notes?: string[];
}

export interface ProviderCapabilities {
  toolCalls?: boolean;
  parallelToolCalls?: boolean;
  reasoningEffort?: boolean;
  imageInput?: boolean;
  promptCaching?: boolean;
  /**
   * Catalog marker for embedding models. This provider catalog is the single
   * authority for the embedding models a deployment provides, so a model only
   * becomes embeddable by being registered here (or merged from models.dev with
   * this capability already set). User-declared custom models cannot add it.
   */
  embedding?: boolean;
  /**
   * Curated fast-tier marker.
   *
   * Neither this catalog nor models.dev carries latency data, so "fast" is a
   * published judgement about a model's tier rather than a measurement. It is
   * surfaced to clients as the `fast` capability token.
   */
  fast?: boolean;
}

/**
 * One row per managed provider: every vocabulary that names it.
 *
 * Pod AI config, credentials and the default embedding profile name providers in
 * their own vocabulary (`dashscope`, `qwen`, `moonshot`, ...), while the gateway
 * catalog names the product (`bailian`, `kimi`, ...), and the catalogs we
 * project from name it again (`qwen`, `alibaba-cn`, `moonshotai`, `zhipuai`).
 * Keeping all of that in one block means every model-policy check compares
 * against one provider identity instead of each caller inventing its own
 * aliases, and adding a provider cannot leave one of the parallel translations
 * behind.
 */
export interface ManagedProviderVocabulary {
  /** Canonical gateway catalog provider id. */
  readonly id: string;
  /**
   * Runtime vocabularies that resolve to `id`. The id itself is always an
   * accepted spelling and does not need to be repeated here.
   */
  readonly runtimeIds: readonly string[];
  /**
   * Slug of the same provider in the bundled `@undefineds.co/models` discovery
   * catalog. Defaults to `id` when the two agree.
   */
  readonly discoverySlug?: string;
  /** Provider id in models.dev. Absent when models.dev does not carry the provider. */
  readonly modelsDevId?: string;
}

export const MANAGED_PROVIDER_VOCABULARY: readonly ManagedProviderVocabulary[] = [
  { id: 'openai', runtimeIds: [ 'codex' ], modelsDevId: 'openai' },
  { id: 'anthropic', runtimeIds: [ 'claude' ], modelsDevId: 'anthropic' },
  { id: 'kimi', runtimeIds: [ 'moonshot', 'moonshotai' ], discoverySlug: 'moonshot', modelsDevId: 'moonshotai' },
  {
    id: 'bailian',
    runtimeIds: [ 'dashscope', 'dashscope-cn', 'dashscope-intl', 'qwen', 'alibaba' ],
    discoverySlug: 'qwen',
    modelsDevId: 'alibaba-cn',
  },
  { id: 'deepseek', runtimeIds: [], modelsDevId: 'deepseek' },
  { id: 'zhipu', runtimeIds: [ 'zhipuai', 'bigmodel', 'glm' ], modelsDevId: 'zhipuai' },
  { id: 'ollama', runtimeIds: [] },
];

/**
 * Runtime vocabulary to canonical provider id, derived from
 * `MANAGED_PROVIDER_VOCABULARY`.
 *
 * `ProviderRegistry.resolveManagedProviderId` is the translation entry point:
 * it validates the canonical id against the registered catalog, which a raw
 * table lookup cannot do.
 */
export const MANAGED_PROVIDER_ALIASES: Record<string, string> = Object.fromEntries(
  MANAGED_PROVIDER_VOCABULARY.flatMap((provider) =>
    [ provider.id, ...provider.runtimeIds ].map((runtimeId) => [ runtimeId, provider.id ])),
);

/** Discovery-catalog slug of a gateway catalog provider id (identity when undeclared). */
export function discoveryProviderSlug(providerId: string): string {
  return managedProviderVocabulary(providerId)?.discoverySlug ?? providerId;
}

/** models.dev provider ids keyed by gateway catalog provider id, derived from the vocabulary block. */
export const XPOD_PROVIDER_TO_MODELS_DEV: Record<string, string> = Object.fromEntries(
  MANAGED_PROVIDER_VOCABULARY.flatMap((provider) =>
    provider.modelsDevId ? [[ provider.id, provider.modelsDevId ]] : []),
);

function managedProviderVocabulary(providerId: string): ManagedProviderVocabulary | undefined {
  const canonical = MANAGED_PROVIDER_ALIASES[normalizeProviderId(providerId)] ?? normalizeProviderId(providerId);
  return MANAGED_PROVIDER_VOCABULARY.find((provider) => provider.id === canonical);
}

export interface ProviderModelDescriptor {
  id: string;
  aliases?: string[];
  contextWindow?: number;
  inputModalities?: string[];
  capabilities?: ProviderCapabilities;
  protocols?: GatewayProtocol[];
  metadata?: Record<string, unknown>;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  authModes: ProviderAuthMode[];
  connect?: ProviderConnectCapability;
  protocols: GatewayProtocol[];
  defaultBaseUrl: string;
  safeBaseUrls: string[];
  capabilities: ProviderCapabilities;
  models: ProviderModelDescriptor[];
}

export interface ModelAliasTarget {
  provider: ProviderId;
  model: string;
}

export interface ProviderRegistryOptions {
  aliases?: Record<string, ModelAliasTarget>;
  connect?: Partial<Record<string, Partial<ProviderConnectCapability>>>;
  products?: ProviderProductDescriptor[];
}

const RESERVED_DISCOVERY_METADATA_KEYS = new Set([
  'baseUrl',
  'base_url',
  'endpoint',
  'providerEndpoint',
  'provider_endpoint',
  'url',
]);

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>();
  private readonly aliases = new Map<string, ModelAliasTarget>();
  private readonly products = new Map<string, ProviderProductDescriptor>();
  private readonly productByRuntimeProvider = new Map<string, ProviderProductDescriptor>();

  public constructor(providers: ProviderDescriptor[], options: ProviderRegistryOptions = {}) {
    for (const provider of providers) {
      const connectOverride = options.connect?.[normalizeProviderId(provider.id)];
      this.register(connectOverride && provider.connect ? {
        ...provider,
        connect: {
          ...provider.connect,
          ...connectOverride,
          notes: [
            ...provider.connect.notes ?? [],
            ...connectOverride.notes ?? [],
          ],
        },
      } : provider);
    }
    for (const product of options.products ?? DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS) {
      const normalizedProduct = freezeProviderProductDescriptor(product);
      validateProviderProductDescriptor(normalizedProduct);
      this.products.set(normalizeProviderId(normalizedProduct.id), normalizedProduct);
      for (const offering of normalizedProduct.offerings) {
        for (const runtimeProviderId of offering.runtimeProviderIds) {
          this.productByRuntimeProvider.set(normalizeProviderId(runtimeProviderId), normalizedProduct);
        }
      }
    }
    for (const [alias, target] of Object.entries(options.aliases ?? {})) {
      this.aliases.set(normalizeKey(alias), {
        provider: normalizeProviderId(target.provider),
        model: target.model,
      });
    }
  }

  public register(provider: ProviderDescriptor): void {
    const normalized = normalizeProviderId(provider.id);
    this.providers.set(normalized, freezeProviderDescriptor({
      ...provider,
      id: normalized,
      authModes: Array.from(new Set(provider.authModes)),
      protocols: Array.from(new Set(provider.protocols)),
      safeBaseUrls: Array.from(new Set(provider.safeBaseUrls)),
      models: provider.models.map((model) => normalizeModelDescriptor(model, provider)),
    }));
  }

  public getProvider(provider: string): ProviderDescriptor | undefined {
    return this.providers.get(normalizeProviderId(provider));
  }

  public requireProvider(provider: string): ProviderDescriptor {
    const descriptor = this.getProvider(provider);
    if (!descriptor) {
      throw new Error(`Unknown AI provider "${provider}"`);
    }
    return descriptor;
  }

  public listProviders(): ProviderDescriptor[] {
    return Array.from(this.providers.values());
  }

  /**
   * Resolve a runtime provider vocabulary entry to the catalog provider that
   * owns it. Unknown providers stay unresolved so a deployment can never treat
   * a Pod-invented provider id as a catalog provider.
   */
  public resolveManagedProviderId(provider: string): string | undefined {
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      return undefined;
    }
    const canonical = MANAGED_PROVIDER_ALIASES[normalized] ?? normalized;
    return this.providers.has(canonical) ? canonical : undefined;
  }

  /**
   * Whether this deployment offers the provider at all.
   *
   * Cloud only offers the operator-designated providers with the endpoints the
   * catalog names: a self-hosted `custom` endpoint or a local-daemon provider
   * such as Ollama is a Local-only capability, because there the user owns the
   * endpoint.
   */
  public isProvidedInDeployment(provider: string, deployment: string): boolean {
    if (deployment !== 'cloud') {
      return true;
    }
    const providerId = normalizeProviderId(provider);
    if (!providerId || providerId === 'custom') {
      return false;
    }
    if (!this.providers.has(providerId)) {
      return false;
    }
    return this.products.get(providerId)?.offerings.some((offering) => offering.kind !== 'local') === true;
  }

  public listProvidedProviders(deployment: string): ProviderDescriptor[] {
    return this.listProviders().filter((provider) => this.isProvidedInDeployment(provider.id, deployment));
  }

  /**
   * Embedding models this catalog provides for a provider. This is the authority
   * for embedding model policy; anything absent is not provided by the gateway.
   */
  public listManagedEmbeddingModels(provider: string): ProviderModelDescriptor[] {
    const providerId = this.resolveManagedProviderId(provider);
    const descriptor = providerId ? this.providers.get(providerId) : undefined;
    if (!descriptor) {
      return [];
    }
    return descriptor.models.filter((model) => model.capabilities?.embedding === true);
  }

  public isManagedEmbeddingModel(provider: string, modelId: string): boolean {
    const model = normalizeKey(modelId);
    if (!model) {
      return false;
    }
    return this.listManagedEmbeddingModels(provider).some((candidate) =>
      normalizeKey(candidate.id) === model
      || (candidate.aliases ?? []).some((alias) => normalizeKey(alias) === model));
  }

  public getProduct(product: string): ProviderProductDescriptor | undefined {
    const normalized = normalizeProviderId(product);
    return this.products.get(normalized) ?? this.productByRuntimeProvider.get(normalized);
  }

  public requireProduct(product: string): ProviderProductDescriptor {
    const descriptor = this.getProduct(product);
    if (!descriptor) {
      throw new Error(`Unknown AI provider product "${product}"`);
    }
    return descriptor;
  }

  public listProducts(): ProviderProductDescriptor[] {
    return Array.from(this.products.values());
  }

  public getOffering(product: string, offeringId: string): ProviderOfferingDescriptor | undefined {
    return this.getProduct(product)?.offerings.find((offering) => offering.id === offeringId);
  }

  public requireOffering(product: string, offeringId: string): ProviderOfferingDescriptor {
    const offering = this.getOffering(product, offeringId);
    if (!offering) throw new Error(`Unknown AI provider offering "${product}/${offeringId}"`);
    return offering;
  }

  public resolveAlias(model: string): ModelAliasTarget | undefined {
    return this.aliases.get(normalizeKey(model));
  }

  /**
   * Catalog descriptor for one model of one provider, matched by id or alias.
   *
   * Provider vocabularies differ between the Pod configuration and the catalog,
   * so the runtime id is resolved through the same alias table the model-policy
   * checks use. An unknown provider stays unresolved rather than falling back to
   * another provider's catalog entry.
   */
  public getModelDescriptor(provider: string, modelId: string): ProviderModelDescriptor | undefined {
    const providerId = this.resolveManagedProviderId(provider);
    const descriptor = providerId ? this.providers.get(providerId) : undefined;
    const normalizedModel = normalizeKey(modelId);
    if (!descriptor || !normalizedModel) {
      return undefined;
    }
    return descriptor.models.find((candidate) =>
      normalizeKey(candidate.id) === normalizedModel
      || (candidate.aliases ?? []).some((alias) => normalizeKey(alias) === normalizedModel));
  }

  public findModel(model: string): Array<{ provider: ProviderDescriptor; model: ProviderModelDescriptor }> {
    const normalizedModel = normalizeKey(model);
    const matches: Array<{ provider: ProviderDescriptor; model: ProviderModelDescriptor }> = [];
    for (const provider of this.providers.values()) {
      const found = provider.models.find((candidate) =>
        normalizeKey(candidate.id) === normalizedModel
        || (candidate.aliases ?? []).some((alias) => normalizeKey(alias) === normalizedModel));
      if (found) {
        matches.push({ provider, model: found });
      }
    }
    return matches;
  }

  public mergeDiscoveredModels(providerId: string, models: ProviderModelDescriptor[]): void {
    const provider = this.requireProvider(providerId);
    const byModel = new Map(provider.models.map((model) => [ normalizeKey(model.id), model ]));
    for (const discovered of models) {
      const normalizedDiscovered = normalizeModelDescriptor(discovered, provider);
      const key = normalizeKey(normalizedDiscovered.id);
      const existing = byModel.get(key);
      byModel.set(key, existing ? mergeModelDescriptor(existing, normalizedDiscovered, provider) : normalizedDiscovered);
    }
    this.providers.set(normalizeProviderId(provider.id), freezeProviderDescriptor({
      ...provider,
      models: Array.from(byModel.values()),
    }));
  }
}

export function createDefaultProviderRegistry(options: ProviderRegistryOptions = {}): ProviderRegistry {
  return new ProviderRegistry(DEFAULT_PROVIDER_DESCRIPTORS, options);
}

/**
 * An offering's own connect entry, narrowed to the server's descriptor type.
 * The catalog owns the declaration (id, mode, label); this deployment only says
 * whether the offering it belongs to is usable at all, the same way the derived
 * api-key entry does.
 */
function catalogAuthorizationMethod(
  method: AiProviderAuthorizationMethod,
  offeringLifecycle: AiProviderOffering['lifecycle'],
): OfferingAuthorizationMethod {
  const connectMode = method.connectMode === 'browserAssistedApiKey'
    || method.connectMode === 'deviceCodeOAuth'
    || method.connectMode === 'authorizationCodeOAuth'
    ? method.connectMode
    : undefined;
  return {
    id: method.id,
    authMode: method.authMode,
    ...(connectMode ? { connectMode } : {}),
    label: method.label,
    lifecycle: offeringLifecycle === 'unavailable' ? 'unavailable' : method.lifecycle ?? 'active',
    ...(method.reason ? { reason: method.reason } : {}),
  };
}

export function providerProductsForDeployment(deployment: 'local' | 'cloud'): ProviderProductDescriptor[] {
  return DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS.map((product) => ({
    ...product,
    offerings: product.offerings.map((offering) => {
      const binding = SUBSCRIPTION_AUTHORIZATION_BINDINGS.find((candidate) =>
        candidate.provider === product.id && candidate.offeringId === offering.id);
      const authorizationMethods: OfferingAuthorizationMethod[] = [];
      if (offering.authModes.includes('apiKey')) {
        authorizationMethods.push(catalogAuthorizationMethod(API_KEY_METHOD, offering.lifecycle));
      }
      if (binding) {
        authorizationMethods.push(...subscriptionAuthorizationMethods(deployment, binding));
      } else if (offering.kind === 'local') {
        authorizationMethods.push({
          id: 'local-service', authMode: 'local',
          lifecycle: offering.lifecycle === 'unavailable' ? 'unavailable' : 'active',
        });
      }
      // An oauth/deviceCode mode with no integration binding is a capability this
      // build has not implemented, and it is omitted rather than published as a
      // disabled entry: a button that cannot be pressed together with an internal
      // reason is noise, and the offering's own lifecycle already says it is not
      // available here. Entries that are merely unavailable in this deployment
      // (cloud without a local callback, cloud without session import) come from
      // the binding above and keep their place and their reason.
      //
      // The catalog's own connect entries, such as the browser-assisted console
      // login, supplement the derived ones instead of replacing them.
      for (const declared of offering.authorizationMethods ?? []) {
        if (authorizationMethods.some((method) => method.id === declared.id)) continue;
        authorizationMethods.push(catalogAuthorizationMethod(declared, offering.lifecycle));
      }
      return {
        ...offering,
        ...(binding ? {
          lifecycle: 'active' as const,
          oauthIntegrationId: binding.integrationId,
          authModes: [...new Set<OfferingAuthMode>([
            ...offering.authModes.filter((mode) => mode !== 'local'),
            ...authorizationMethods.filter((method) => method.lifecycle === 'active').map((method) => method.authMode),
            ...(deployment === 'local' ? ['local' as const] : []),
          ])],
          auth: [...offering.auth.filter((capability) => capability.protocol !== 'local-none' && capability.protocol !== 'oauth-device-code'),
            { protocol: 'oauth-device-code' as const },
            ...(authorizationMethods.some((method) => method.connectMode === 'authorizationCodeOAuth' && method.lifecycle === 'active')
              ? [{ protocol: 'oauth-authorization-code' as const }] : [])],
        } : {}),
        authorizationMethods,
      };
    }),
  }));
}

function catalogOffering(
  productId: ProviderProductId,
  productLabel: string,
  input: Omit<ProviderOfferingDescriptor,
    'productLabel' | 'credentialPrefixHints' | 'consoleUrl' | 'subscriptionUrl' |
    'auth' | 'upstream' | 'modelDiscovery' | 'quota' | 'usagePolicyUrl' | 'region' | 'lifecycle'> &
  Partial<Pick<ProviderOfferingDescriptor,
    'auth' | 'upstream' | 'credentialPrefixHints' | 'consoleUrl' | 'subscriptionUrl' |
    'modelDiscovery' | 'quota' | 'usagePolicyUrl' | 'region' | 'lifecycle'>>,
): ProviderOfferingDescriptor {
  const consoleUrl = input.consoleUrl ?? input.subscriptionUrl;
  if (!consoleUrl) throw new Error(`Provider offering "${input.id}" requires a console URL`);
  const modelDiscovery = input.modelDiscovery ?? {
    strategy: 'openaiCompatible' as const,
    path: '/models',
    endpointProtocol: input.endpoints[0]?.protocol ?? 'chatCompletions',
  };
  const quota = input.quota ?? { strategy: 'console' as const, url: consoleUrl };
  return {
    ...input,
    productLabel,
    credentialPrefixHints: input.credentialPrefixHints ?? [],
    consoleUrl,
    subscriptionUrl: input.subscriptionUrl ?? consoleUrl,
    auth: input.auth ?? defaultAuthCapabilities(input.kind, input.authModes),
    upstream: input.upstream ?? defaultUpstreamCapabilities(input.endpoints, modelDiscovery, quota),
    modelDiscovery,
    quota,
    usagePolicyUrl: input.usagePolicyUrl ?? consoleUrl,
    region: input.region ?? 'global',
    lifecycle: input.lifecycle ?? 'active',
  };
}

function defaultAuthCapabilities(
  kind: ProviderOfferingKind,
  authModes: OfferingAuthMode[],
): ProviderAuthCapabilityDescriptor[] {
  return authModes.map((mode) => ({
    protocol: mode === 'local'
      ? 'local-none'
      : mode === 'oauth' || mode === 'deviceCode'
      ? 'oauth-device-code'
      : kind === 'token-plan'
        ? 'subscription-key'
        : 'api-key',
  }));
}

function defaultUpstreamCapabilities(
  endpoints: ProviderOfferingEndpointDescriptor[],
  modelDiscovery: ProviderOfferingModelDiscoveryDescriptor,
  quota: ProviderOfferingQuotaDescriptor,
): ProviderUpstreamCapabilityDescriptor[] {
  const capabilities: ProviderUpstreamCapabilityDescriptor[] = [
    {
      capability: 'models',
      protocol: modelDiscovery.strategy === 'anthropic' ? 'anthropic-models' : 'openai-models',
      options: { path: modelDiscovery.path, endpointProtocol: modelDiscovery.endpointProtocol },
    },
    ...endpoints.map((endpoint) => ({
      capability: 'inference' as const,
      protocol: endpoint.protocol,
      options: { baseUrl: endpoint.baseUrl },
    })),
  ];
  if (quota.strategy === 'subscription') {
    capabilities.push({ capability: 'quota', protocol: 'unsupported-quota' });
  } else if (quota.strategy === 'providerApi') {
    capabilities.push({ capability: 'balance', protocol: 'unsupported-quota' });
  } else {
    capabilities.push({ capability: 'balance', protocol: 'unsupported-quota' });
  }
  return capabilities;
}

// The provider/offering catalog itself lives in @undefineds.co/ai-connections:
// it is content rather than schema, and it carries endpoints, console links and
// authorization actions that a property-definition package must not own. Only
// the runtime capability descriptors below stay server-side - they describe how
// Xpod talks to an upstream, which is behaviour rather than shared content.
const PROVIDER_PRODUCT_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  kimi: 'Moonshot (Kimi)',
  bailian: 'Alibaba Bailian',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  zhipu: '智谱 AI',
  custom: 'Custom Provider',
};

const PROVIDER_UPSTREAM_OVERRIDES: Partial<Record<string, Record<string, ProviderUpstreamCapabilityDescriptor[]>>> = {
  openai: {
    'official-subscription': [
      { capability: 'models', protocol: 'codex-models' },
      {
        capability: 'quota',
        protocol: 'rolling-quota-windows',
        options: { profile: 'codex', credentialAuthModes: [ 'deviceCodeOAuth' ] },
      },
    ],
  },
  anthropic: {
    'official-subscription': [
      {
        capability: 'quota',
        protocol: 'rolling-quota-windows',
        options: { profile: 'claude-code', credentialAuthModes: [ 'deviceCodeOAuth' ] },
      },
    ],
  },
  kimi: {
    'subscription-key': [
      { capability: 'models', protocol: 'openai-models', options: { path: '/models', endpointProtocol: 'chatCompletions' } },
      { capability: 'inference', protocol: 'chatCompletions', options: { baseUrl: 'https://api.kimi.com/coding/v1' } },
      { capability: 'inference', protocol: 'anthropic', options: { baseUrl: 'https://api.kimi.com/coding/' } },
      {
        capability: 'quota',
        protocol: 'rolling-quota-windows',
        options: { profile: 'kimi-code', credentialAuthModes: [ 'apiKey', 'deviceCodeOAuth' ] },
      },
    ],
    // MIGRATION WINDOW: Kimi credentials written before the offering rename name
    // the coding-plan quota by the generic subscription id, and only ever hold a
    // device-code token. The declaration owns both facts so the quota handler
    // never has to compare offering ids itself; delete this row once no stored
    // credential carries the old id.
    'official-subscription': [
      {
        capability: 'quota',
        protocol: 'rolling-quota-windows',
        options: { profile: 'kimi-code', credentialAuthModes: [ 'deviceCodeOAuth' ] },
      },
    ],
    'api-platform': [
      { capability: 'models', protocol: 'openai-models', options: { path: '/models', endpointProtocol: 'chatCompletions' } },
      { capability: 'inference', protocol: 'chatCompletions', options: { baseUrl: 'https://api.moonshot.ai/v1' } },
      { capability: 'balance', protocol: 'api-balance', options: { profile: 'moonshot' } },
    ],
  },
  deepseek: {
    'api-platform': [
      { capability: 'models', protocol: 'openai-models', options: { path: '/models', endpointProtocol: 'chatCompletions' } },
      { capability: 'inference', protocol: 'chatCompletions', options: { baseUrl: 'https://api.deepseek.com/v1' } },
      { capability: 'balance', protocol: 'api-balance', options: { profile: 'deepseek' } },
    ],
  },
};

/**
 * Whether one declared upstream capability assigns a protocol+profile to a
 * product offering under the credential kind that would use it.
 *
 * `PROVIDER_UPSTREAM_OVERRIDES` is the axis's single authority for the
 * offering→capability mapping and `QuotaCapabilityRegistry` dispatches handlers
 * from the protocol+profile declared here. A handler that needs to know whether
 * an offering is its own asks the declaration instead of comparing offering id
 * literals in `supports()`, which would be a second copy of this table.
 *
 * A capability may narrow itself to the credential auth modes it serves
 * (`options.credentialAuthModes`); without that option every credential kind the
 * Offering publishes is served. When the declaration narrows the kinds and the
 * caller does not know the credential kind, the offering cannot be claimed.
 */
export function offeringDeclaresUpstreamCapability(
  product: string,
  offeringId: string | undefined,
  capability: { protocol: string; profile?: string },
  credentialAuthMode?: string,
): boolean {
  if (!offeringId) {
    return false;
  }
  const declared = PROVIDER_UPSTREAM_OVERRIDES[normalizeProviderId(product)]?.[offeringId];
  return declared?.some((candidate) => {
    if (candidate.protocol !== capability.protocol) {
      return false;
    }
    if (capability.profile !== undefined && candidate.options?.profile !== capability.profile) {
      return false;
    }
    const credentialAuthModes = candidate.options?.credentialAuthModes;
    if (!Array.isArray(credentialAuthModes)) {
      return true;
    }
    return credentialAuthMode !== undefined && credentialAuthModes.includes(credentialAuthMode);
  }) ?? false;
}

function offeringsForProduct(provider: string): AiProviderOffering[] {
  if (provider === 'custom') return CUSTOM_DEFAULT_OFFERINGS;
  return PROVIDER_OFFERINGS[provider as AiConnectionsProvider] ?? DEFAULT_PROVIDER_OFFERINGS;
}

const LEGACY_PROVIDER_PRODUCT_DESCRIPTORS: ProviderProductDescriptor[] = (
  Object.keys(PROVIDER_PRODUCT_LABELS) as ProviderProductId[]
).map((provider) => ({
  id: provider,
  label: PROVIDER_PRODUCT_LABELS[provider]!,
  offerings: offeringsForProduct(provider).map((offering) =>
    // The shared catalog is the source of the offering content; the server's
    // descriptor type narrows the same fields, so the projection converts at
    // this boundary rather than duplicating the values.
    catalogOffering(provider, PROVIDER_PRODUCT_LABELS[provider]!, {
      ...offering,
      endpoints: offering.endpoints ?? [],
      ...(PROVIDER_UPSTREAM_OVERRIDES[provider]?.[offering.id]
        ? { upstream: PROVIDER_UPSTREAM_OVERRIDES[provider]![offering.id]! }
        : {}),
    } as Parameters<typeof catalogOffering>[2])),
}));

/**
 * The provider/offering catalog belongs to `@undefineds.co/ai-connections`: it
 * is content rather than schema, and it carries endpoints, console links and
 * authorization actions that a property-definition package must not own. The
 * descriptors above are the pre-existing copy that is being replaced by that
 * shared catalog; only runtime capability descriptors stay server-side.
 */
export const DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS: ProviderProductDescriptor[] =
  canonicalProviderProducts(LEGACY_PROVIDER_PRODUCT_DESCRIPTORS)
    .map(normalizeOpenAiSubscriptionProduct);

type CanonicalOffering = {
  id: string;
  label: string;
  kind: ProviderOfferingKind;
  lifecycle?: ProviderOfferingLifecycle;
  authModes: OfferingAuthMode[];
  runtimeProviderIds?: string[];
  productLabel?: string;
  credentialPrefixHints?: string[];
  consoleUrl?: string;
  subscriptionUrl?: string;
  endpoints: Array<{
    protocol: string;
    baseUrl: string;
    region?: string;
    supportsDeveloperMessages?: boolean;
  }>;
  modelDiscovery?: {
    strategy: ProviderModelDiscoveryStrategy;
    path: string;
    endpointProtocol: string;
  };
  quota?: {
    strategy: ProviderQuotaStrategy;
    url: string;
  };
  usagePolicyUrl?: string;
  region?: string;
};

function canonicalProviderProducts(
  legacy: ProviderProductDescriptor[],
): ProviderProductDescriptor[] {
  return legacy.map((fallback) => {
    const canonicalSlug = discoveryProviderSlug(fallback.id);
    const provider = getBuiltinProvider(canonicalSlug) as unknown as {
      slug: string;
      displayName: string;
      homepage: string;
      offerings?: CanonicalOffering[];
    } | undefined;
    if (!provider?.offerings?.length) return fallback;
    return {
      id: fallback.id,
      label: provider.displayName || fallback.label,
      offerings: provider.offerings.map((offering) => canonicalOfferingDescriptor(
        provider,
        offering,
        fallback.offerings.find((candidate) => candidate.id === offering.id),
      )),
    };
  }).concat(canonicalStandaloneProducts());
}

function normalizeOpenAiSubscriptionProduct(product: ProviderProductDescriptor): ProviderProductDescriptor {
  if (product.id !== 'openai') {
    return product;
  }
  return {
    ...product,
    offerings: product.offerings.map((offering) => offering.id === 'official-subscription'
      ? {
          ...offering,
          label: 'OpenAI Subscription',
          authModes: ['local'],
          auth: [{ protocol: 'local-none' }],
          consoleUrl: 'https://chatgpt.com/',
          subscriptionUrl: 'https://chatgpt.com/#pricing',
          quota: { strategy: 'subscription', url: 'https://chatgpt.com/' },
          endpoints: [{ protocol: 'responses', baseUrl: OPENAI_SUBSCRIPTION_BASE_URL }],
          lifecycle: 'unavailable',
        }
      : offering),
  };
}

function canonicalStandaloneProducts(): ProviderProductDescriptor[] {
  const fallback = new Map(LEGACY_PROVIDER_PRODUCT_DESCRIPTORS.map((product) => [product.id, product]));
  const ollama = getBuiltinProvider('ollama') as unknown as {
    slug: string;
    displayName: string;
    homepage: string;
    offerings?: CanonicalOffering[];
  } | undefined;
  if (!ollama?.offerings?.length || fallback.has('ollama')) return [];
  return [{
    id: 'ollama',
    label: ollama.displayName,
    offerings: ollama.offerings.map((offering) => canonicalOfferingDescriptor(ollama, offering)),
  }];
}

function canonicalOfferingDescriptor(
  provider: { slug: string; displayName: string; homepage: string },
  offering: CanonicalOffering,
  fallback?: ProviderOfferingDescriptor,
): ProviderOfferingDescriptor {
  const endpoints = offering.endpoints
    .map((endpoint) => ({
      ...endpoint,
      protocol: toGatewayProtocol(endpoint.protocol),
    }))
    .filter((endpoint): endpoint is ProviderOfferingEndpointDescriptor => endpoint.protocol !== undefined);
  const modelDiscovery = offering.modelDiscovery
    ? {
        strategy: offering.modelDiscovery.strategy,
        path: offering.modelDiscovery.path,
        endpointProtocol: toGatewayProtocol(offering.modelDiscovery.endpointProtocol)
          ?? endpoints[0]?.protocol
          ?? 'chatCompletions',
      }
    : fallback?.modelDiscovery ?? {
        strategy: endpoints[0]?.protocol === 'anthropic' ? 'anthropic' as const : 'openaiCompatible' as const,
        path: '/models',
        endpointProtocol: endpoints[0]?.protocol ?? 'chatCompletions' as const,
      };
  const quota = offering.quota ?? fallback?.quota ?? {
    strategy: 'unsupported' as const,
    url: offering.consoleUrl ?? provider.homepage,
  };
  return {
    id: offering.id,
    runtimeProviderIds: offering.runtimeProviderIds ?? [provider.slug],
    label: offering.label,
    productLabel: offering.productLabel ?? provider.displayName,
    kind: offering.kind,
    authModes: offering.authModes,
    // The canonical source carries schema, not actions: which connect entries an
    // offering declares stays with the catalog that declared them.
    ...(fallback?.authorizationMethods ? { authorizationMethods: fallback.authorizationMethods } : {}),
    auth: fallback?.auth ?? defaultAuthCapabilities(offering.kind, offering.authModes),
    upstream: fallback?.upstream ?? defaultUpstreamCapabilities(endpoints, modelDiscovery, quota),
    endpoints,
    credentialPrefixHints: offering.credentialPrefixHints ?? fallback?.credentialPrefixHints ?? [],
    consoleUrl: offering.consoleUrl ?? fallback?.consoleUrl ?? provider.homepage,
    subscriptionUrl: offering.subscriptionUrl ?? fallback?.subscriptionUrl ?? offering.consoleUrl ?? provider.homepage,
    modelDiscovery,
    quota,
    usagePolicyUrl: offering.usagePolicyUrl ?? fallback?.usagePolicyUrl ?? provider.homepage,
    region: offering.region ?? fallback?.region ?? 'global',
    lifecycle: offering.lifecycle ?? fallback?.lifecycle ?? 'active',
    ...(fallback?.oauthIntegrationId ? { oauthIntegrationId: fallback.oauthIntegrationId } : {}),
  };
}

function toGatewayProtocol(value: string | undefined): GatewayProtocol | undefined {
  return value === 'responses' || value === 'anthropic' || value === 'chatCompletions'
    ? value
    : undefined;
}

export const DEFAULT_PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    authModes: ['browserAssistedApiKey', 'apiKey'],
    connect: {
      mode: 'browserAssistedApiKey',
      label: 'Open official OpenAI API key settings, then submit the key through Xpod management API',
      apiKeyManagementSupported: true,
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
      notes: ['API keys use the official settings page; OAuth uses a trusted server-side client profile.'],
    },
    protocols: ['responses', 'chatCompletions'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    safeBaseUrls: ['https://api.openai.com/v1'],
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoningEffort: true,
      imageInput: true,
      promptCaching: true,
    },
    models: [
      { id: 'gpt-5', contextWindow: 400_000, capabilities: { toolCalls: true, reasoningEffort: true, imageInput: true } },
      { id: 'gpt-4.1', capabilities: { toolCalls: true, imageInput: true } },
      embeddingModel('text-embedding-3-small', 1536),
      embeddingModel('text-embedding-3-large', 3072),
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    authModes: ['browserAssistedApiKey', 'apiKey'],
    connect: {
      mode: 'browserAssistedApiKey',
      label: 'Open official Anthropic console keys, then submit the key through Xpod management API',
      apiKeyManagementSupported: true,
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
      notes: ['Do not reuse Claude Code OAuth clients or scrape browser cookies.'],
    },
    protocols: ['anthropic'],
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    safeBaseUrls: ['https://api.anthropic.com/v1'],
    capabilities: {
      toolCalls: true,
      reasoningEffort: true,
      imageInput: true,
      promptCaching: true,
    },
    models: [
      { id: 'claude-sonnet-4-5-20250929', aliases: ['claude-sonnet-4.5'], capabilities: { toolCalls: true, reasoningEffort: true, imageInput: true } },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    authModes: ['browserAssistedApiKey', 'apiKey'],
    connect: {
      mode: 'browserAssistedApiKey',
      label: 'Add a Kimi Token Plan or Moonshot API key',
      apiKeyManagementSupported: true,
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
      notes: ['Device-code login is intentionally not offered; use a Token Plan or API Platform key.'],
    },
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    safeBaseUrls: ['https://api.moonshot.ai/v1'],
    capabilities: {
      toolCalls: true,
      imageInput: true,
    },
    models: [
      { id: 'kimi-k2', capabilities: { toolCalls: true } },
      { id: 'kimi-k3-thinking', capabilities: { toolCalls: true, reasoningEffort: true } },
    ],
  },
  {
    id: 'bailian',
    label: 'Alibaba Bailian',
    authModes: ['browserAssistedApiKey', 'apiKey'],
    connect: {
      mode: 'browserAssistedApiKey',
      label: 'Open official Bailian console keys, then submit the key through Xpod management API',
      apiKeyManagementSupported: true,
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
      notes: ['Bailian browser Connect is API-key assisted unless an official third-party OAuth flow is available.'],
    },
    protocols: ['anthropic', 'chatCompletions'],
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    safeBaseUrls: [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://dashscope.aliyuncs.com/api/v1',
    ],
    capabilities: {
      toolCalls: true,
      parallelToolCalls: true,
      reasoningEffort: true,
      imageInput: true,
    },
    models: [
      { id: 'qwen-max', capabilities: { toolCalls: true, imageInput: true } },
      { id: 'qwen-coder-plus', capabilities: { toolCalls: true } },
      // The DashScope-compatible endpoint the default embedding profile uses.
      embeddingModel(DEFAULT_EMBEDDING_MODEL_ID, 1024),
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    authModes: ['browserAssistedApiKey', 'apiKey'],
    connect: {
      mode: 'browserAssistedApiKey',
      label: 'Open official DeepSeek API key settings, then submit the key through Xpod management API',
      apiKeyManagementSupported: true,
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
      notes: ['DeepSeek browser Connect is API-key assisted; keys are submitted only through the authenticated management API.'],
    },
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    safeBaseUrls: ['https://api.deepseek.com/v1'],
    capabilities: {
      toolCalls: true,
    },
    models: [
      { id: 'deepseek-chat', capabilities: { toolCalls: true } },
      { id: 'deepseek-reasoner', capabilities: { toolCalls: true, reasoningEffort: true } },
      { id: 'deepseek-flash', capabilities: { toolCalls: true, reasoningEffort: true } },
      // models.dev lists this model under the third-party aggregators that serve
      // it, not under the first-party DeepSeek entry, so the catalog seeds it
      // here. `fast` is a curated tier claim, not a measurement.
      {
        id: 'deepseek-v4.1-flash',
        contextWindow: 1_048_576,
        inputModalities: ['text', 'image'],
        capabilities: { toolCalls: true, reasoningEffort: true, imageInput: true, fast: true },
      },
      { id: 'deepseek-v4-flash', capabilities: { toolCalls: true, reasoningEffort: true } },
      { id: 'deepseek-v4-pro', capabilities: { toolCalls: true, reasoningEffort: true } },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 AI',
    authModes: ['browserAssistedApiKey', 'apiKey'],
    connect: {
      mode: 'browserAssistedApiKey',
      label: 'Open official Zhipu API key settings, then submit the key through Xpod management API',
      apiKeyManagementSupported: true,
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
    },
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    safeBaseUrls: [
      'https://open.bigmodel.cn/api/paas/v4',
      'https://open.bigmodel.cn/api/coding/paas/v4',
    ],
    capabilities: {
      toolCalls: true,
      reasoningEffort: true,
      imageInput: true,
    },
    models: [
      { id: 'glm-4.5', capabilities: { toolCalls: true, reasoningEffort: true } },
      { id: 'glm-4.5-air', capabilities: { toolCalls: true, reasoningEffort: true } },
      embeddingModel('embedding-2', 1024),
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    authModes: ['connectUnsupported'],
    connect: {
      mode: 'connectUnsupported',
      label: 'Ollama runs locally and does not require a provider API-key Connect flow',
      apiKeyManagementSupported: false,
      configured: true,
      publicCallbackSupported: false,
    },
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'http://localhost:11434/v1',
    safeBaseUrls: ['http://localhost:11434/v1'],
    capabilities: {
      toolCalls: true,
    },
    models: [
      embeddingModel('nomic-embed-text', 768),
    ],
  },
  {
    id: 'custom',
    label: 'Custom Provider',
    authModes: ['apiKey'],
    connect: {
      mode: 'browserAssistedApiKey',
      label: 'Add a user-owned OpenAI-compatible or Anthropic-compatible endpoint',
      apiKeyManagementSupported: true,
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
    },
    protocols: ['chatCompletions', 'anthropic'],
    defaultBaseUrl: 'https://example.invalid/v1',
    safeBaseUrls: [],
    capabilities: {
      toolCalls: true,
      imageInput: true,
    },
    models: [],
  },
];

/**
 * Registers an embedding model in the provided catalog. Embedding models exist
 * here (not in the chat lists) so that provider/model capability and the
 * deployment embedding policy read from one source.
 */
function embeddingModel(id: string, dimension: number): ProviderModelDescriptor {
  return {
    id,
    capabilities: { embedding: true },
    metadata: { modelType: 'embedding', dimension },
  };
}

function mergeModelDescriptor(
  existing: ProviderModelDescriptor,
  discovered: ProviderModelDescriptor,
  provider: ProviderDescriptor,
): ProviderModelDescriptor {  return {
    ...existing,
    ...discovered,
    aliases: Array.from(new Set([ ...existing.aliases ?? [], ...discovered.aliases ?? [] ])),
    protocols: Array.from(new Set([ ...existing.protocols ?? [], ...discovered.protocols ?? provider.protocols ])),
    capabilities: {
      ...provider.capabilities,
      ...existing.capabilities,
      ...discovered.capabilities,
    },
    metadata: sanitizeDiscoveryMetadata({
      ...existing.metadata,
      ...discovered.metadata,
    }),
  };
}

function normalizeModelDescriptor(
  model: ProviderModelDescriptor,
  provider: ProviderDescriptor,
): ProviderModelDescriptor {
  return {
    ...model,
    protocols: Array.from(new Set(model.protocols ?? provider.protocols)),
    capabilities: {
      ...provider.capabilities,
      ...model.capabilities,
    },
    metadata: sanitizeDiscoveryMetadata(model.metadata ?? {}),
  };
}

function sanitizeDiscoveryMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_DISCOVERY_METADATA_KEYS.has(key)),
  );
}

function freezeProviderDescriptor(provider: ProviderDescriptor): ProviderDescriptor {
  return {
    ...provider,
    authModes: [ ...provider.authModes ],
    connect: provider.connect ? {
      ...provider.connect,
      notes: provider.connect.notes ? [ ...provider.connect.notes ] : undefined,
    } : undefined,
    protocols: [ ...provider.protocols ],
    safeBaseUrls: [ ...provider.safeBaseUrls ],
    capabilities: { ...provider.capabilities },
    models: provider.models.map((model) => ({
      ...model,
      aliases: model.aliases ? [ ...model.aliases ] : undefined,
      protocols: model.protocols ? [ ...model.protocols ] : undefined,
      capabilities: model.capabilities ? { ...model.capabilities } : undefined,
      metadata: model.metadata ? { ...model.metadata } : undefined,
    })),
  };
}

function freezeProviderProductDescriptor(product: ProviderProductDescriptor): ProviderProductDescriptor {
  return {
    ...product,
    id: normalizeProviderId(product.id),
    offerings: product.offerings.map((offering) => ({
      ...offering,
      runtimeProviderIds: offering.runtimeProviderIds.map(normalizeProviderId),
      authModes: [ ...offering.authModes ],
      auth: offering.auth.map((capability) => ({ ...capability })),
      ...(offering.authorizationMethods ? {
        authorizationMethods: offering.authorizationMethods.map((method) => ({ ...method })),
      } : {}),
      upstream: offering.upstream.map((capability) => ({
        ...capability,
        options: capability.options ? { ...capability.options } : undefined,
      })),
      endpoints: offering.endpoints.map((endpoint) => ({ ...endpoint })),
      credentialPrefixHints: [ ...offering.credentialPrefixHints ],
      modelDiscovery: { ...offering.modelDiscovery },
      quota: { ...offering.quota },
    })),
  };
}

function validateProviderProductDescriptor(product: ProviderProductDescriptor): void {
  const offeringIds = new Set<string>();
  for (const offering of product.offerings) {
    if (offeringIds.has(offering.id)) {
      throw new Error(`Duplicate AI provider offering "${product.id}/${offering.id}"`);
    }
    offeringIds.add(offering.id);
    if (offering.auth.length === 0) {
      throw new Error(`AI provider offering "${product.id}/${offering.id}" requires auth capability`);
    }
    if (offering.upstream.length === 0) {
      throw new Error(`AI provider offering "${product.id}/${offering.id}" requires upstream capability`);
    }
    const authProtocols = new Set<string>();
    for (const capability of offering.auth) {
      if (!capability.protocol || authProtocols.has(capability.protocol)) {
        throw new Error(`Duplicate AI auth capability "${product.id}/${offering.id}/${capability.protocol}"`);
      }
      authProtocols.add(capability.protocol);
    }
    const upstreamProtocols = new Set<string>();
    for (const capability of offering.upstream) {
      const key = `${capability.capability}:${capability.protocol}`;
      if (!capability.protocol || upstreamProtocols.has(key)) {
        throw new Error(`Duplicate AI upstream capability "${product.id}/${offering.id}/${key}"`);
      }
      upstreamProtocols.add(key);
    }
  }
}

export function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
