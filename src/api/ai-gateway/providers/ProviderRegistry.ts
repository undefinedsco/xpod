import type { GatewayProtocol } from '../types';

export type ProviderId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type ProviderProductId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type ProviderAuthMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'apiKey' | 'connectUnsupported';
export type ProviderConnectMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported';
export type OfferingAuthMode = 'oauth' | 'deviceCode' | 'apiKey' | 'local';
export type ProviderOfferingKind =
  | 'payAsYouGo'
  | 'codingPlan'
  | 'tokenPlan'
  | 'officialSubscription'
  | 'local'
  | 'custom';
export type ProviderOfferingLifecycle = 'active' | 'legacy' | 'unavailable';

export interface ProviderOfferingEndpointDescriptor {
  protocol: GatewayProtocol;
  baseUrl: string;
  region?: string;
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

  public resolveAlias(model: string): ModelAliasTarget | undefined {
    return this.aliases.get(normalizeKey(model));
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

function catalogOffering(
  productLabel: string,
  input: Omit<ProviderOfferingDescriptor,
    'productLabel' | 'credentialPrefixHints' | 'consoleUrl' | 'subscriptionUrl' |
    'modelDiscovery' | 'quota' | 'usagePolicyUrl' | 'region' | 'lifecycle'> &
  Partial<Pick<ProviderOfferingDescriptor,
    'credentialPrefixHints' | 'consoleUrl' | 'subscriptionUrl' |
    'modelDiscovery' | 'quota' | 'usagePolicyUrl' | 'region' | 'lifecycle'>>,
): ProviderOfferingDescriptor {
  const consoleUrl = input.consoleUrl ?? input.subscriptionUrl;
  if (!consoleUrl) throw new Error(`Provider offering "${input.id}" requires a console URL`);
  return {
    ...input,
    productLabel,
    credentialPrefixHints: input.credentialPrefixHints ?? [],
    consoleUrl,
    subscriptionUrl: input.subscriptionUrl ?? consoleUrl,
    modelDiscovery: input.modelDiscovery ?? {
      strategy: 'openaiCompatible',
      path: '/models',
      endpointProtocol: input.endpoints[0]?.protocol ?? 'chatCompletions',
    },
    quota: input.quota ?? { strategy: 'console', url: consoleUrl },
    usagePolicyUrl: input.usagePolicyUrl ?? consoleUrl,
    region: input.region ?? 'global',
    lifecycle: input.lifecycle ?? 'active',
  };
}

export const DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS: ProviderProductDescriptor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    offerings: [
      catalogOffering('OpenAI', {
        id: 'api-platform',
        runtimeProviderIds: ['openai'],
        label: 'API Platform',
        kind: 'payAsYouGo',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://platform.openai.com/api-keys',
        subscriptionUrl: 'https://platform.openai.com/settings/organization/billing/overview',
        quota: { strategy: 'providerApi', url: 'https://platform.openai.com/usage' },
        usagePolicyUrl: 'https://openai.com/policies/usage-policies/',
        endpoints: [
          { protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
          { protocol: 'chatCompletions', baseUrl: 'https://api.openai.com/v1' },
        ],
      }),
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    offerings: [
      catalogOffering('Anthropic', {
        id: 'api-platform',
        runtimeProviderIds: ['anthropic'],
        label: 'API Platform',
        kind: 'payAsYouGo',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-ant-'],
        consoleUrl: 'https://console.anthropic.com/settings/keys',
        subscriptionUrl: 'https://console.anthropic.com/settings/plans',
        modelDiscovery: { strategy: 'anthropic', path: '/models', endpointProtocol: 'anthropic' },
        quota: { strategy: 'console', url: 'https://console.anthropic.com/settings/limits' },
        usagePolicyUrl: 'https://www.anthropic.com/legal/aup',
        endpoints: [
          { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
        ],
      }),
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    offerings: [
      catalogOffering('Kimi', {
        id: 'official-subscription',
        runtimeProviderIds: ['kimi'],
        label: 'Official Subscription',
        kind: 'officialSubscription',
        authModes: ['oauth'],
        oauthIntegrationId: 'kimi-code',
        consoleUrl: 'https://www.kimi.com/code',
        subscriptionUrl: 'https://www.kimi.com/code',
        quota: { strategy: 'subscription', url: 'https://www.kimi.com/code' },
        usagePolicyUrl: 'https://www.kimi.com/user/agreement',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://api.kimi.com/coding/v1' },
          { protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding/' },
        ],
      }),
      catalogOffering('Kimi', {
        id: 'api-platform',
        runtimeProviderIds: ['kimi'],
        label: 'API Platform',
        kind: 'payAsYouGo',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
        subscriptionUrl: 'https://platform.moonshot.cn/console/account',
        quota: { strategy: 'console', url: 'https://platform.moonshot.cn/console/account' },
        usagePolicyUrl: 'https://platform.moonshot.cn/docs/intro',
        region: 'cn',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://api.moonshot.ai/v1' },
        ],
      }),
    ],
  },
  {
    id: 'bailian',
    label: 'Alibaba Bailian',
    offerings: [
      catalogOffering('Alibaba Bailian', {
        id: 'pay-as-you-go',
        runtimeProviderIds: ['bailian'],
        label: 'Pay as You Go',
        kind: 'payAsYouGo',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://bailian.console.aliyun.com/',
        subscriptionUrl: 'https://bailian.console.aliyun.com/',
        quota: { strategy: 'console', url: 'https://bailian.console.aliyun.com/' },
        usagePolicyUrl: 'https://help.aliyun.com/zh/model-studio/',
        region: 'cn',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
          { protocol: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
        ],
      }),
      catalogOffering('Alibaba Bailian', {
        id: 'token-plan',
        runtimeProviderIds: ['bailian-token-plan'],
        label: 'Token Plan Personal',
        kind: 'tokenPlan',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://bailian.console.aliyun.com/',
        subscriptionUrl: 'https://bailian.console.aliyun.com/',
        quota: { strategy: 'subscription', url: 'https://bailian.console.aliyun.com/' },
        usagePolicyUrl: 'https://help.aliyun.com/zh/model-studio/',
        region: 'cn-beijing',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
          { protocol: 'anthropic', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' },
        ],
      }),
      catalogOffering('Alibaba Bailian', {
        id: 'token-plan-team',
        runtimeProviderIds: ['bailian-token-plan'],
        label: 'Token Plan Team',
        kind: 'tokenPlan',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://bailian.console.aliyun.com/',
        subscriptionUrl: 'https://bailian.console.aliyun.com/',
        quota: { strategy: 'subscription', url: 'https://bailian.console.aliyun.com/' },
        usagePolicyUrl: 'https://help.aliyun.com/zh/model-studio/',
        region: 'cn-beijing',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
          { protocol: 'anthropic', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' },
        ],
      }),
      catalogOffering('Alibaba Bailian', {
        id: 'coding-plan',
        runtimeProviderIds: ['bailian-coding-plan'],
        label: 'Coding Plan Pro',
        kind: 'codingPlan',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-sp-'],
        consoleUrl: 'https://bailian.console.aliyun.com/',
        subscriptionUrl: 'https://bailian.console.aliyun.com/',
        quota: { strategy: 'subscription', url: 'https://bailian.console.aliyun.com/' },
        usagePolicyUrl: 'https://help.aliyun.com/zh/model-studio/',
        region: 'cn',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
          { protocol: 'anthropic', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic' },
        ],
      }),
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    offerings: [
      catalogOffering('DeepSeek', {
        id: 'api-platform',
        runtimeProviderIds: ['deepseek'],
        label: 'API Platform',
        kind: 'payAsYouGo',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://platform.deepseek.com/api_keys',
        subscriptionUrl: 'https://platform.deepseek.com/usage',
        quota: { strategy: 'console', url: 'https://platform.deepseek.com/usage' },
        usagePolicyUrl: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-use.html',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://api.deepseek.com/v1' },
        ],
      }),
    ],
  },
];

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
      notes: ['Do not reuse official Codex client IDs or scrape browser cookies.'],
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
    authModes: ['deviceCodeOAuth', 'apiKey'],
    connect: {
      mode: 'deviceCodeOAuth',
      label: 'Kimi Code device-code OAuth',
      apiKeyManagementSupported: true,
      configured: false,
      experimental: true,
      publicCallbackSupported: false,
      remoteRevocationSupported: false,
      notes: ['Requires an Xpod/Moonshot-issued device-code OAuth client id; do not reuse the official Kimi CLI client id.'],
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
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    authModes: ['connectUnsupported', 'apiKey'],
    connect: {
      mode: 'connectUnsupported',
      label: 'DeepSeek does not expose a supported third-party browser Connect flow',
      apiKeyManagementSupported: true,
      configured: false,
      publicCallbackSupported: false,
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
    ],
  },
];

function mergeModelDescriptor(
  existing: ProviderModelDescriptor,
  discovered: ProviderModelDescriptor,
  provider: ProviderDescriptor,
): ProviderModelDescriptor {
  return {
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
      endpoints: offering.endpoints.map((endpoint) => ({ ...endpoint })),
      credentialPrefixHints: [ ...offering.credentialPrefixHints ],
      modelDiscovery: { ...offering.modelDiscovery },
      quota: { ...offering.quota },
    })),
  };
}

export function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
