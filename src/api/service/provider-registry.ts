/**
 * Provider capability helpers shared by direct BYOK execution paths.
 *
 * AI connection routing owns provider descriptors in
 * src/api/ai-connections/providers/ProviderRegistry.ts. This module exposes the
 * small URL/protocol lookups still consumed by the execution adapters.
 */

import {
  createDefaultProviderRegistry,
  type ProviderDescriptor,
} from '../ai-connections/providers/ProviderRegistry';

const aiConnectionProviderRegistry = createDefaultProviderRegistry();

const ADDITIONAL_PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    authModes: ['apiKey'],
    protocols: ['responses', 'anthropic', 'chatCompletions'],
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    safeBaseUrls: ['https://openrouter.ai/api/v1'],
    capabilities: { toolCalls: true, imageInput: true },
    models: [],
  },
  {
    id: 'gemini',
    label: 'Google Gemini OpenAI-compatible',
    authModes: ['apiKey'],
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    safeBaseUrls: ['https://generativelanguage.googleapis.com/v1beta/openai'],
    capabilities: { toolCalls: true, imageInput: true },
    models: [],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    authModes: ['apiKey'],
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'http://localhost:11434/v1',
    safeBaseUrls: ['http://localhost:11434/v1'],
    capabilities: { toolCalls: true },
    models: [],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    authModes: ['apiKey'],
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    safeBaseUrls: ['https://api.mistral.ai/v1'],
    capabilities: { toolCalls: true },
    models: [],
  },
  {
    id: 'cohere',
    label: 'Cohere',
    authModes: ['apiKey'],
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'https://api.cohere.ai/v1',
    safeBaseUrls: ['https://api.cohere.ai/v1'],
    capabilities: { toolCalls: true },
    models: [],
  },
  {
    id: 'bigmodel',
    label: 'BigModel',
    authModes: ['apiKey'],
    protocols: ['chatCompletions'],
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    safeBaseUrls: ['https://open.bigmodel.cn/api/paas/v4'],
    capabilities: { toolCalls: true },
    models: [],
  },
];

for (const provider of ADDITIONAL_PROVIDER_DESCRIPTORS) {
  aiConnectionProviderRegistry.register(provider);
}

const UNKNOWN_SUPPORTS = {
  chatCompletions: true,
  responses: false,
  messages: false,
};

function hostnameOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function lookupByUrl(baseUrl: string): ProviderDescriptor | undefined {
  const host = hostnameOf(baseUrl);
  if (!host) {
    return undefined;
  }
  return aiConnectionProviderRegistry.listProviders().find((provider) =>
    provider.safeBaseUrls.some((safeUrl) => hostnameOf(safeUrl) === host));
}

function supportsForBaseUrl(baseUrl: string): typeof UNKNOWN_SUPPORTS {
  const provider = lookupByUrl(baseUrl);
  if (!provider) {
    return UNKNOWN_SUPPORTS;
  }
  return {
    chatCompletions: provider.protocols.includes('chatCompletions'),
    responses: provider.protocols.includes('responses'),
    messages: provider.protocols.includes('anthropic'),
  };
}

export function getDefaultBaseUrl(provider?: string): string {
  const normalized = (provider || 'openrouter').toLowerCase();
  const match = aiConnectionProviderRegistry.listProviders().find((candidate) =>
    candidate.id.toLowerCase() === normalized
    || candidate.label.toLowerCase().includes(normalized)
    || normalized.includes(candidate.id.toLowerCase()));
  return match?.defaultBaseUrl ?? 'https://openrouter.ai/api/v1';
}

export function resolveServerProviderTransport(input: {
  providerId: string;
  baseUrl?: string;
  proxyUrl?: string;
  edition?: 'cloud' | 'local';
}): { baseUrl: string; proxyUrl?: string } {
  const edition = input.edition ?? (process.env.XPOD_EDITION === 'cloud' ? 'cloud' : 'local');
  const provider = aiConnectionProviderRegistry.getProvider(input.providerId);
  const requestedBaseUrl = input.baseUrl?.trim() || provider?.defaultBaseUrl;
  if (!requestedBaseUrl) {
    throw new Error('provider_base_url_not_allowed');
  }

  const baseUrl = normalizeTransportUrl(requestedBaseUrl, false);
  if (edition === 'cloud') {
    const allowedBaseUrls = provider?.safeBaseUrls.map((value) => normalizeTransportUrl(value, false)) ?? [];
    if (!baseUrl.startsWith('https://') || !allowedBaseUrls.includes(baseUrl)) {
      throw new Error('provider_base_url_not_allowed');
    }
    if (input.proxyUrl?.trim()) {
      throw new Error('provider_proxy_not_allowed');
    }
    return { baseUrl };
  }

  const proxyUrl = input.proxyUrl?.trim()
    ? normalizeTransportUrl(input.proxyUrl, true)
    : undefined;
  return { baseUrl, ...(proxyUrl ? { proxyUrl } : {}) };
}

function normalizeTransportUrl(value: string, allowUserInfo: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('provider_base_url_not_allowed');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:')
    || (!allowUserInfo && (url.username || url.password))
    || url.search
    || url.hash) {
    throw new Error('provider_base_url_not_allowed');
  }
  return url.toString().replace(/\/$/u, '');
}

export function supportsResponsesApi(baseUrl: string): boolean {
  return supportsForBaseUrl(baseUrl).responses;
}

export function supportsMessagesApi(baseUrl: string): boolean {
  return supportsForBaseUrl(baseUrl).messages;
}

/**
 * For codex wire_api selection: only native OpenAI uses Responses wire protocol.
 * All other providers should use Chat Completions wire unless explicitly migrated.
 */
export function codexWireApi(baseUrl: string): 'responses' | 'chat' {
  const host = hostnameOf(baseUrl);
  return host === 'api.openai.com' ? 'responses' : 'chat';
}
