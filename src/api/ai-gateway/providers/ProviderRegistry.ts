import type { GatewayProtocol } from '../types';
import { getBuiltinProvider } from '@undefineds.co/models';

export type ProviderId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type ProviderProductId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type ProviderAuthMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'apiKey' | 'local' | 'connectUnsupported';
export type ProviderConnectMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported';
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
  | 'oauth-device-code';

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

const LEGACY_PROVIDER_PRODUCT_DESCRIPTORS: ProviderProductDescriptor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    offerings: [
      catalogOffering('OpenAI', {
        id: 'official-subscription',
        runtimeProviderIds: ['openai'],
        label: 'Codex Subscription',
        kind: 'oauth-subscription',
        authModes: ['oauth'],
        credentialPrefixHints: [],
        consoleUrl: 'https://chatgpt.com/codex',
        subscriptionUrl: 'https://chatgpt.com/codex',
        quota: { strategy: 'subscription', url: 'https://chatgpt.com/codex' },
        modelDiscovery: { strategy: 'unsupported', path: '/models', endpointProtocol: 'responses' },
        upstream: [
          { capability: 'quota', protocol: 'rolling-quota-windows', options: { profile: 'codex' } },
        ],
        usagePolicyUrl: 'https://openai.com/policies/usage-policies/',
        endpoints: [],
        lifecycle: 'unavailable',
      }),
      catalogOffering('OpenAI', {
        id: 'api-platform',
        runtimeProviderIds: ['openai'],
        label: 'API Platform',
        kind: 'api-platform',
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
        id: 'official-subscription',
        runtimeProviderIds: ['anthropic'],
        label: 'Claude Code Subscription',
        kind: 'oauth-subscription',
        authModes: ['oauth'],
        credentialPrefixHints: [],
        consoleUrl: 'https://claude.ai/',
        subscriptionUrl: 'https://claude.ai/settings/billing',
        quota: { strategy: 'subscription', url: 'https://claude.ai/settings/usage' },
        modelDiscovery: { strategy: 'unsupported', path: '/models', endpointProtocol: 'anthropic' },
        upstream: [
          { capability: 'quota', protocol: 'rolling-quota-windows', options: { profile: 'claude-code' } },
        ],
        usagePolicyUrl: 'https://www.anthropic.com/legal/aup',
        endpoints: [],
        lifecycle: 'unavailable',
      }),
      catalogOffering('Anthropic', {
        id: 'api-platform',
        runtimeProviderIds: ['anthropic'],
        label: 'API Platform',
        kind: 'api-platform',
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
        id: 'subscription-key',
        runtimeProviderIds: ['kimi'],
        label: 'Token Plan',
        kind: 'token-plan',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-kimi-'],
        consoleUrl: 'https://www.kimi.com/code',
        subscriptionUrl: 'https://www.kimi.com/code',
        quota: { strategy: 'subscription', url: 'https://www.kimi.com/code' },
        upstream: [
          { capability: 'models', protocol: 'openai-models', options: { path: '/models', endpointProtocol: 'chatCompletions' } },
          { capability: 'inference', protocol: 'chatCompletions', options: { baseUrl: 'https://api.kimi.com/coding/v1' } },
          { capability: 'inference', protocol: 'anthropic', options: { baseUrl: 'https://api.kimi.com/coding/' } },
          { capability: 'quota', protocol: 'rolling-quota-windows', options: { profile: 'kimi-code' } },
        ],
        usagePolicyUrl: 'https://www.kimi.com/user/agreement',
        endpoints: [
          {
            protocol: 'chatCompletions',
            baseUrl: 'https://api.kimi.com/coding/v1',
            supportsDeveloperMessages: false,
          },
          { protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding/' },
        ],
      }),
      catalogOffering('Kimi', {
        id: 'api-platform',
        runtimeProviderIds: ['kimi'],
        label: 'API Platform',
        kind: 'api-platform',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
        subscriptionUrl: 'https://platform.moonshot.cn/console/account',
        quota: { strategy: 'console', url: 'https://platform.moonshot.cn/console/account' },
        upstream: [
          { capability: 'models', protocol: 'openai-models', options: { path: '/models', endpointProtocol: 'chatCompletions' } },
          { capability: 'inference', protocol: 'chatCompletions', options: { baseUrl: 'https://api.moonshot.ai/v1' } },
          { capability: 'balance', protocol: 'api-balance', options: { profile: 'moonshot' } },
        ],
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
        kind: 'api-platform',
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
        kind: 'token-plan',
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
        kind: 'token-plan',
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
        kind: 'token-plan',
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
        kind: 'api-platform',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://platform.deepseek.com/api_keys',
        subscriptionUrl: 'https://platform.deepseek.com/usage',
        quota: { strategy: 'console', url: 'https://platform.deepseek.com/usage' },
        upstream: [
          { capability: 'models', protocol: 'openai-models', options: { path: '/models', endpointProtocol: 'chatCompletions' } },
          { capability: 'inference', protocol: 'chatCompletions', options: { baseUrl: 'https://api.deepseek.com/v1' } },
          { capability: 'balance', protocol: 'api-balance', options: { profile: 'deepseek' } },
        ],
        usagePolicyUrl: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-use.html',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://api.deepseek.com/v1' },
        ],
      }),
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 AI',
    offerings: [
      catalogOffering('智谱 AI', {
        id: 'api-platform',
        runtimeProviderIds: ['zhipu'],
        label: 'API 平台',
        kind: 'api-platform',
        authModes: ['apiKey'],
        credentialPrefixHints: ['id.'],
        consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
        subscriptionUrl: 'https://open.bigmodel.cn/finance-center/expense-manage',
        quota: { strategy: 'console', url: 'https://open.bigmodel.cn/finance-center/expense-manage' },
        usagePolicyUrl: 'https://open.bigmodel.cn/',
        region: 'cn',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
        ],
      }),
      catalogOffering('智谱 AI', {
        id: 'coding-plan',
        runtimeProviderIds: ['zhipu'],
        label: 'GLM Coding Plan',
        kind: 'token-plan',
        authModes: ['apiKey'],
        credentialPrefixHints: ['id.'],
        consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
        subscriptionUrl: 'https://bigmodel.cn/glm-coding',
        quota: { strategy: 'subscription', url: 'https://bigmodel.cn/glm-coding' },
        usagePolicyUrl: 'https://open.bigmodel.cn/',
        region: 'cn',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        ],
      }),
    ],
  },
];

const CANONICAL_PROVIDER_SLUGS: Record<string, string> = {
  kimi: 'moonshot',
  bailian: 'qwen',
};

/**
 * The shared models package owns the provider/offering catalog. Keep the
 * legacy descriptors above only as a compatibility fallback while deployed
 * installations roll forward to a models package that exposes offerings.
 */
export const DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS: ProviderProductDescriptor[] =
  canonicalProviderProducts(LEGACY_PROVIDER_PRODUCT_DESCRIPTORS);

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
    const canonicalSlug = CANONICAL_PROVIDER_SLUGS[fallback.id] ?? fallback.id;
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
    models: [],
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
      auth: offering.auth.map((capability) => ({ ...capability })),
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
