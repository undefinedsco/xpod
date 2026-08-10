import type { GatewayProtocol } from '../types';

export type ProviderId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type ProviderAuthMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'apiKey' | 'connectUnsupported';
export type ProviderConnectMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported';

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
  imageGeneration?: boolean;
  imageEditing?: boolean;
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
      imageGeneration: true,
      imageEditing: true,
      promptCaching: true,
    },
    models: [
      { id: 'gpt-5', contextWindow: 400_000, capabilities: { toolCalls: true, reasoningEffort: true, imageInput: true } },
      { id: 'gpt-4.1', capabilities: { toolCalls: true, imageInput: true } },
      { id: 'gpt-image-1', inputModalities: ['text', 'image'], capabilities: { imageGeneration: true, imageEditing: true } },
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
    capabilities: { ...model.capabilities },
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

export function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
