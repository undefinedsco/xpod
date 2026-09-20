import type {
  AiConnectionsProvider,
  AiProviderAuthorizationMethod,
  AiProviderCredentialSummary,
  AiProviderOffering,
} from './ai-connections-client'
import { AI_CONNECTIONS_PROVIDERS } from './client/types'

// Built-in provider and offering catalog. This is the single place that names a
// provider or an offering; display layers project from it instead of keeping a
// second copy, which is how the same offering used to appear under two names.

export const DEFAULT_PROVIDER_OFFERINGS: AiProviderOffering[] = [
  { id: 'api-platform', label: 'API Platform', kind: 'api-platform', lifecycle: 'active', authModes: ['apiKey'] },
];

/**
 * How an offering accepts a key: typed into Xpod's own form (this entry) or
 * minted in the provider's console (the browser-assisted entry below). An
 * offering that declares its actions declares this one too - the catalog is the
 * single source of the wording, and the server only decides whether the entry is
 * usable in a given deployment.
 */
export const API_KEY_METHOD: AiProviderAuthorizationMethod = {
  id: 'api-key',
  authMode: 'apiKey',
  label: '添加 API Key',
  lifecycle: 'active',
};

/**
 * The connect entry that opens the provider's own console so the user signs in
 * there and mints a key. Which ways in exist is offering data, so the entry is
 * declared on the offerings that accept a key (`authModes` keeps the mechanical
 * truth, `apiKey`) instead of on a provider-level label, and it points at the
 * `consoleUrl` the offering already carries.
 *
 * Providers without one say something real by not declaring it: DeepSeek has no
 * account console to sign into, Ollama is a local service, and `custom` is
 * configured inside Xpod rather than at a provider.
 *
 * The label is 浏览器登录 rather than the legacy 「登录」 because it names the
 * action the way its siblings do (浏览器登录 / 设备码登录 / 已有登录态); 「登录」
 * named the provider instead, which is what let a provider-level string claim a
 * capability no offering declared.
 */
export const BROWSER_LOGIN_METHOD: AiProviderAuthorizationMethod = {
  id: 'browser-login',
  authMode: 'apiKey',
  connectMode: 'browserAssistedApiKey',
  label: '浏览器登录',
  lifecycle: 'active',
};

/** Both ways a key arrives, for an offering whose provider has a console. */
const API_KEY_METHODS: AiProviderAuthorizationMethod[] = [API_KEY_METHOD, BROWSER_LOGIN_METHOD];

export const CUSTOM_DEFAULT_OFFERINGS: AiProviderOffering[] = [
  {
    id: 'openai-compatible',
    label: 'OpenAI Compatible',
    kind: 'api-platform',
    lifecycle: 'active',
    authModes: ['apiKey'],
    runtimeProviderIds: ['custom'],
    consoleUrl: 'https://undefineds.co',
    subscriptionUrl: 'https://undefineds.co',
    // A user-owned endpoint replaces this placeholder; it exists so the
    // descriptor always names a route rather than an empty list.
    endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://example.invalid/v1' }],
    modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    quota: { strategy: 'unsupported', url: 'https://undefineds.co' },
  },
  {
    id: 'anthropic-compatible',
    label: 'Anthropic Compatible',
    kind: 'api-platform',
    lifecycle: 'active',
    authModes: ['apiKey'],
    runtimeProviderIds: ['custom'],
    consoleUrl: 'https://undefineds.co',
    subscriptionUrl: 'https://undefineds.co',
    endpoints: [{ protocol: 'anthropic', baseUrl: 'https://example.invalid/v1' }],
    modelDiscovery: { strategy: 'anthropic', path: '/models', endpointProtocol: 'anthropic' },
    quota: { strategy: 'unsupported', url: 'https://undefineds.co' },
  },
];

const KIMI_SUBSCRIPTION_URL = 'https://www.kimi.com/code';
const KIMI_USAGE_POLICY_URL = 'https://www.kimi.com/user/agreement';
const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding/';
const MOONSHOT_CONSOLE_URL = 'https://platform.moonshot.cn/console/api-keys';
const MOONSHOT_ACCOUNT_URL = 'https://platform.moonshot.cn/console/account';
const MOONSHOT_USAGE_POLICY_URL = 'https://platform.moonshot.cn/docs/intro';
const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
const BAILIAN_CONSOLE_URL = 'https://bailian.console.aliyun.com/';
const BAILIAN_USAGE_POLICY_URL = 'https://help.aliyun.com/zh/model-studio/';
const ZHIPU_CONSOLE_URL = 'https://open.bigmodel.cn/usercenter/apikeys';
const ZHIPU_USAGE_POLICY_URL = 'https://open.bigmodel.cn/';
const ZHIPU_API_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const ZHIPU_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

export const PROVIDER_OFFERINGS: Partial<Record<AiConnectionsProvider, AiProviderOffering[]>> = {
  openai: [
    {
      id: 'official-subscription',
      label: 'OpenAI Subscription',
      kind: 'oauth-subscription',
      lifecycle: 'unavailable',
      // Two distinct ways in, and the product keeps them apart: starting an
      // authorization (browser or device code) versus collecting the login state
      // an already-signed-in local client holds. AuthorizationMethods below name
      // the concrete methods.
      authModes: ['oauth', 'local'],
      productLabel: 'OpenAI',
      runtimeProviderIds: ['openai'],
      credentialPrefixHints: [],
      consoleUrl: 'https://chatgpt.com/codex',
      subscriptionUrl: 'https://chatgpt.com/codex',
      // The Codex backend this subscription actually calls; without it the
      // offering has no inference route at all.
      endpoints: [{ protocol: 'responses', baseUrl: 'https://chatgpt.com/backend-api/codex' }],
      modelDiscovery: { strategy: 'unsupported', path: '/models', endpointProtocol: 'responses' },
      quota: { strategy: 'subscription', url: 'https://chatgpt.com/codex' },
      usagePolicyUrl: 'https://openai.com/policies/usage-policies/',
      region: 'global',
    },
    {
      id: 'api-platform',
      label: 'API Platform',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      authorizationMethods: API_KEY_METHODS,
      productLabel: 'OpenAI',
      runtimeProviderIds: ['openai'],
      credentialPrefixHints: ['sk-'],
      consoleUrl: 'https://platform.openai.com/api-keys',
      subscriptionUrl: 'https://platform.openai.com/settings/organization/billing/overview',
      endpoints: [
        { protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
        { protocol: 'chatCompletions', baseUrl: 'https://api.openai.com/v1' },
      ],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'responses' },
      quota: { strategy: 'providerApi', url: 'https://platform.openai.com/usage' },
      usagePolicyUrl: 'https://openai.com/policies/usage-policies/',
      region: 'global',
    },
  ],
  anthropic: [
    {
      id: 'official-subscription',
      label: 'Claude Code Subscription',
      kind: 'oauth-subscription',
      lifecycle: 'unavailable',
      authModes: ['oauth'],
      productLabel: 'Anthropic',
      runtimeProviderIds: ['anthropic'],
      credentialPrefixHints: [],
      consoleUrl: 'https://claude.ai/',
      subscriptionUrl: 'https://claude.ai/settings/billing',
      endpoints: [],
      modelDiscovery: { strategy: 'unsupported', path: '/models', endpointProtocol: 'anthropic' },
      quota: { strategy: 'subscription', url: 'https://claude.ai/settings/usage' },
      usagePolicyUrl: 'https://www.anthropic.com/legal/aup',
      region: 'global',
    },
    {
      id: 'api-platform',
      label: 'API Platform',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      authorizationMethods: API_KEY_METHODS,
      productLabel: 'Anthropic',
      runtimeProviderIds: ['anthropic'],
      credentialPrefixHints: ['sk-ant-'],
      consoleUrl: 'https://console.anthropic.com/settings/keys',
      subscriptionUrl: 'https://console.anthropic.com/settings/plans',
      endpoints: [{ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }],
      modelDiscovery: { strategy: 'anthropic', path: '/models', endpointProtocol: 'anthropic' },
      quota: { strategy: 'console', url: 'https://console.anthropic.com/settings/limits' },
      usagePolicyUrl: 'https://www.anthropic.com/legal/aup',
      region: 'global',
    },
  ],
  kimi: [
    kimiOffering({
      id: 'subscription-key',
      label: 'Token Plan',
      kind: 'token-plan',
      authModes: ['apiKey'],
      productLabel: 'Kimi Coding',
      runtimeProviderIds: ['kimi'],
      credentialPrefixHints: ['sk-kimi-'],
      baseUrl: KIMI_CODING_BASE_URL,
      anthropicBaseUrl: KIMI_ANTHROPIC_BASE_URL,
      quotaStrategy: 'subscription',
      quotaUrl: KIMI_SUBSCRIPTION_URL,
      consoleUrl: KIMI_SUBSCRIPTION_URL,
      subscriptionUrl: KIMI_SUBSCRIPTION_URL,
      usagePolicyUrl: KIMI_USAGE_POLICY_URL,
      // The coding endpoint rejects developer messages, which the runtime has to
      // know before it sends them.
      supportsDeveloperMessages: false,
    }),
    kimiOffering({
      id: 'api-platform',
      label: 'API Platform',
      kind: 'api-platform',
      authModes: ['apiKey'],
      productLabel: 'Moonshot AI',
      runtimeProviderIds: ['kimi'],
      credentialPrefixHints: ['sk-'],
      baseUrl: MOONSHOT_BASE_URL,
      quotaStrategy: 'console',
      quotaUrl: MOONSHOT_ACCOUNT_URL,
      consoleUrl: MOONSHOT_CONSOLE_URL,
      subscriptionUrl: MOONSHOT_ACCOUNT_URL,
      usagePolicyUrl: MOONSHOT_USAGE_POLICY_URL,
    }),
  ],
  bailian: [
    bailianOffering({ id: 'pay-as-you-go', label: 'Pay as You Go', kind: 'api-platform', runtimeProviderIds: ['bailian'], credentialPrefixHints: ['sk-'], region: 'cn', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', anthropicBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', quotaStrategy: 'console', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
    bailianOffering({ id: 'token-plan', label: 'Token Plan Personal', kind: 'token-plan', runtimeProviderIds: ['bailian-token-plan'], credentialPrefixHints: ['sk-'], region: 'cn-beijing', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', anthropicBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', quotaStrategy: 'subscription', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
    bailianOffering({ id: 'token-plan-team', label: 'Token Plan Team', kind: 'token-plan', runtimeProviderIds: ['bailian-token-plan'], credentialPrefixHints: ['sk-'], region: 'cn-beijing', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', anthropicBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', quotaStrategy: 'subscription', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
    bailianOffering({ id: 'coding-plan', label: 'Coding Plan Pro', kind: 'token-plan', runtimeProviderIds: ['bailian-coding-plan'], credentialPrefixHints: ['sk-sp-'], region: 'cn', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', anthropicBaseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', quotaStrategy: 'subscription', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
  ],
  deepseek: [
    {
      id: 'api-platform',
      label: 'API Platform',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      productLabel: 'DeepSeek',
      runtimeProviderIds: ['deepseek'],
      credentialPrefixHints: ['sk-'],
      consoleUrl: 'https://platform.deepseek.com/api_keys',
      subscriptionUrl: 'https://platform.deepseek.com/usage',
      endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.deepseek.com/v1' }],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      quota: { strategy: 'console', url: 'https://platform.deepseek.com/usage' },
      usagePolicyUrl: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-use.html',
      region: 'global',
    },
  ],
  ollama: [
    {
      id: 'local',
      label: 'Local Ollama',
      kind: 'local',
      lifecycle: 'active',
      authModes: ['local'],
      productLabel: 'Ollama',
      runtimeProviderIds: ['ollama'],
      credentialPrefixHints: [],
      consoleUrl: 'https://ollama.com',
      subscriptionUrl: 'https://ollama.com',
      endpoints: [{ protocol: 'chatCompletions', baseUrl: 'http://localhost:11434/v1' }],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      quota: { strategy: 'unsupported', url: 'https://ollama.com' },
      usagePolicyUrl: 'https://ollama.com',
      region: 'local',
    },
  ],
  zhipu: [
    {
      id: 'api-platform',
      label: 'API Platform',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      authorizationMethods: API_KEY_METHODS,
      productLabel: '智谱 AI',
      runtimeProviderIds: ['zhipu'],
      credentialPrefixHints: ['id.'],
      consoleUrl: ZHIPU_CONSOLE_URL,
      subscriptionUrl: 'https://open.bigmodel.cn/finance-center/expense-manage',
      endpoints: [{ protocol: 'chatCompletions', baseUrl: ZHIPU_API_BASE_URL, region: 'cn' }],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      quota: { strategy: 'console', url: 'https://open.bigmodel.cn/finance-center/expense-manage' },
      usagePolicyUrl: ZHIPU_USAGE_POLICY_URL,
      region: 'cn',
    },
    {
      id: 'coding-plan',
      label: 'GLM Coding Plan',
      kind: 'token-plan',
      lifecycle: 'active',
      authModes: ['apiKey'],
      authorizationMethods: API_KEY_METHODS,
      productLabel: '智谱 AI',
      runtimeProviderIds: ['zhipu'],
      credentialPrefixHints: ['id.'],
      consoleUrl: ZHIPU_CONSOLE_URL,
      subscriptionUrl: 'https://bigmodel.cn/glm-coding',
      endpoints: [{ protocol: 'chatCompletions', baseUrl: ZHIPU_CODING_BASE_URL, region: 'cn' }],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      quota: { strategy: 'subscription', url: 'https://bigmodel.cn/glm-coding' },
      usagePolicyUrl: ZHIPU_USAGE_POLICY_URL,
      region: 'cn',
    },
  ],
};

function kimiOffering(input: {
  id: string;
  label: string;
  kind: NonNullable<AiProviderOffering['kind']>;
  authModes: NonNullable<AiProviderOffering['authModes']>;
  productLabel: string;
  runtimeProviderIds: string[];
  credentialPrefixHints?: string[];
  baseUrl: string;
  anthropicBaseUrl?: string;
  quotaStrategy: string;
  quotaUrl: string;
  consoleUrl?: string;
  subscriptionUrl?: string;
  usagePolicyUrl: string;
  supportsDeveloperMessages?: boolean;
}): AiProviderOffering {
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    lifecycle: 'active',
    authModes: input.authModes,
    authorizationMethods: API_KEY_METHODS,
    productLabel: input.productLabel,
    runtimeProviderIds: input.runtimeProviderIds,
    credentialPrefixHints: input.credentialPrefixHints,
    consoleUrl: input.consoleUrl,
    subscriptionUrl: input.subscriptionUrl,
    endpoints: offeringEndpoints(input.baseUrl, input.anthropicBaseUrl, 'cn', input.supportsDeveloperMessages),
    modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    quota: { strategy: input.quotaStrategy, url: input.quotaUrl },
    usagePolicyUrl: input.usagePolicyUrl,
    region: 'cn',
  };
}

function bailianOffering(input: {
  id: string;
  label: string;
  kind: NonNullable<AiProviderOffering['kind']>;
  runtimeProviderIds: string[];
  credentialPrefixHints: string[];
  region: string;
  baseUrl: string;
  anthropicBaseUrl?: string;
  quotaStrategy: string;
  consoleUrl: string;
  usagePolicyUrl: string;
}): AiProviderOffering {
  return {
    id: input.id,
    label: input.label,
    lifecycle: 'active',
    productLabel: 'Alibaba Bailian',
    kind: input.kind,
    authModes: ['apiKey'],
    authorizationMethods: API_KEY_METHODS,
    runtimeProviderIds: input.runtimeProviderIds,
    credentialPrefixHints: input.credentialPrefixHints,
    consoleUrl: input.consoleUrl,
    subscriptionUrl: input.consoleUrl,
    endpoints: offeringEndpoints(input.baseUrl, input.anthropicBaseUrl, input.region),
    modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    quota: { strategy: input.quotaStrategy, url: input.consoleUrl },
    usagePolicyUrl: input.usagePolicyUrl,
    region: input.region,
  };
}

function offeringEndpoints(
  chatCompletionsBaseUrl: string,
  anthropicBaseUrl: string | undefined,
  region: string,
  supportsDeveloperMessages?: boolean,
): NonNullable<AiProviderOffering['endpoints']> {
  return [
    {
      protocol: 'chatCompletions',
      baseUrl: chatCompletionsBaseUrl,
      region,
      ...(supportsDeveloperMessages === undefined ? {} : { supportsDeveloperMessages }),
    },
    ...(anthropicBaseUrl ? [{ protocol: 'anthropic', baseUrl: anthropicBaseUrl, region }] : []),
  ];
}

export function providerOfferings(
  provider: AiConnectionsProvider,
  openAiSubscriptionImportAvailable = false,
): AiProviderOffering[] {
  return (PROVIDER_OFFERINGS[provider] ?? DEFAULT_PROVIDER_OFFERINGS).map((offering) => {
    if (
      provider === 'openai'
      && offering.id === 'official-subscription'
      && openAiSubscriptionImportAvailable
    ) {
      return {
        ...offering,
        lifecycle: 'active',
        authModes: Array.from(new Set([...(offering.authModes ?? []), 'local'])),
        authorizationMethods: [
          { id: 'device-code', authMode: 'deviceCode', connectMode: 'deviceCodeOAuth', label: '设备码登录', lifecycle: 'active' },
          { id: 'local-session-import', authMode: 'local', label: '已有登录态', lifecycle: 'active' },
        ],
      };
    }
    return { ...offering };
  });
}

/**
 * Provider documents the AI Connection service is granted access to: the
 * provider container document plus one document per built-in offering, named
 * `<provider>-<offeringId>` by the Pod layout.
 *
 * This is the single program-side authority for that list. The Gateway's
 * service-access descriptor and this package's descriptor validator both read
 * it, so the granted surface and the validator cannot drift from the catalogue
 * or from each other. Adding an offering to the catalogue adds its document
 * here, which is exactly the program capability the service is allowed to
 * reach.
 */
export const AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS: readonly string[] =
  AI_CONNECTIONS_PROVIDERS.flatMap((provider) => [
    provider,
    ...builtinOfferings(provider).map((offering) => `${provider}-${offering.id}`),
  ])

/**
 * Built-in offerings of one provider as the catalogue declares them. `custom`
 * keeps its placeholder offerings in their own table because its endpoints are
 * intentionally invalid; every other provider declares its own list above.
 * This mirrors the Gateway's `ProviderRegistry.offeringsForProduct`.
 */
function builtinOfferings(provider: AiConnectionsProvider): readonly AiProviderOffering[] {
  if (provider === 'custom') return CUSTOM_DEFAULT_OFFERINGS
  return PROVIDER_OFFERINGS[provider] ?? DEFAULT_PROVIDER_OFFERINGS
}

export function customCompatibilityValue(value: unknown, offeringId?: string): 'openai' | 'anthropic' {
  if (value === 'anthropic' || offeringId === 'anthropic-compatible') return 'anthropic';
  return 'openai';
}

export function providerName(provider: AiConnectionsProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'kimi':
      return 'Kimi';
    case 'bailian':
      return '百炼';
    case 'deepseek':
      return 'DeepSeek';
    case 'zhipu':
      return '智谱 AI';
    case 'ollama':
      return 'Ollama';
    case 'custom':
      return 'Custom';
  }
}

export function defaultOfferingFor(provider: AiConnectionsProvider, authMode: AiProviderCredentialSummary['authMode']): string {
  if (provider === 'openai' && (authMode === 'local' || authMode === 'oauth' || authMode === 'deviceCode')) {
    return 'official-subscription';
  }
  if (provider === 'kimi' && (authMode === 'oauth' || authMode === 'deviceCode')) {
    return 'subscription-key';
  }
  if (provider === 'bailian') return 'pay-as-you-go';
  if (provider === 'ollama') return 'local';
  if (provider === 'custom') return 'openai-compatible';
  return 'api-platform';
}

export function offeringBaseUrl(provider: AiConnectionsProvider, offeringId?: string): string | undefined {
  const offering = providerOfferings(provider).find((candidate) =>
    candidate.id === (offeringId ?? defaultOfferingFor(provider, 'apiKey')));
  if (!offering) return undefined;
  const discoveryProtocol = offering.modelDiscovery?.endpointProtocol;
  return offering.endpoints?.find((endpoint) => endpoint.protocol === discoveryProtocol)?.baseUrl
    ?? offering.endpoints?.[0]?.baseUrl;
}
