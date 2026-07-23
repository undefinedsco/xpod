/**
 * Backwards-compatible provider capability helpers.
 *
 * New AI Gateway routing owns provider descriptors in
 * src/api/ai-gateway/providers/ProviderRegistry.ts. Keep this module only for
 * legacy runtime surfaces that still need default base URL constants.
 */

import {
  createDefaultProviderRegistry,
  type ProviderDescriptor,
} from '../ai-gateway/providers/ProviderRegistry';

const gatewayProviderRegistry = createDefaultProviderRegistry();

const LEGACY_COMPATIBLE_PROVIDERS: ProviderDescriptor[] = [
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

for (const provider of LEGACY_COMPATIBLE_PROVIDERS) {
  gatewayProviderRegistry.register(provider);
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
  return gatewayProviderRegistry.listProviders().find((provider) =>
    provider.safeBaseUrls.some((safeUrl) => hostnameOf(safeUrl) === host));
}

function legacySupports(baseUrl: string): typeof UNKNOWN_SUPPORTS {
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
  const match = gatewayProviderRegistry.listProviders().find((candidate) =>
    candidate.id.toLowerCase() === normalized
    || candidate.label.toLowerCase().includes(normalized)
    || normalized.includes(candidate.id.toLowerCase()));
  return match?.defaultBaseUrl ?? 'https://openrouter.ai/api/v1';
}

export function supportsResponsesApi(baseUrl: string): boolean {
  return legacySupports(baseUrl).responses;
}

export function supportsMessagesApi(baseUrl: string): boolean {
  return legacySupports(baseUrl).messages;
}

/**
 * For codex wire_api selection: only native OpenAI uses Responses wire protocol.
 * All other providers should use Chat Completions wire unless explicitly migrated.
 */
export function codexWireApi(baseUrl: string): 'responses' | 'chat' {
  const host = hostnameOf(baseUrl);
  return host === 'api.openai.com' ? 'responses' : 'chat';
}
