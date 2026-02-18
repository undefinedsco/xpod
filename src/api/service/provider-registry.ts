/**
 * AI Provider capability registry.
 *
 * Single source of truth for which API protocols each known provider supports.
 * Used by VercelChatService (API proxy/conversion) and PtyThreadRuntime (agent env setup).
 *
 * TODO: replace with discovery service lookup via provider WebID
 * See: docs/issues/discovery/001-provider-capability-registry.md
 */

interface ProviderInfo {
  /** Default base URL (with /v1 suffix where applicable) */
  baseUrl: string;
  /** Hostnames that identify this provider */
  hostnames: string[];
  supports: {
    chatCompletions: boolean;
    /** OpenAI Responses API: POST /v1/responses */
    responses: boolean;
    /** Anthropic Messages API: POST /v1/messages */
    messages: boolean;
  };
}

const REGISTRY: ProviderInfo[] = [
  {
    baseUrl: 'https://api.openai.com/v1',
    hostnames: ['api.openai.com'],
    supports: { chatCompletions: true, responses: true, messages: false },
  },
  {
    baseUrl: 'https://api.anthropic.com/v1',
    hostnames: ['api.anthropic.com'],
    supports: { chatCompletions: false, responses: false, messages: true },
  },
  {
    baseUrl: 'https://openrouter.ai/api/v1',
    hostnames: ['openrouter.ai'],
    supports: { chatCompletions: true, responses: true, messages: true },
  },
  {
    baseUrl: 'https://api.deepseek.com/v1',
    hostnames: ['api.deepseek.com'],
    supports: { chatCompletions: true, responses: false, messages: false },
  },
  {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hostnames: ['generativelanguage.googleapis.com'],
    supports: { chatCompletions: true, responses: false, messages: false },
  },
  {
    baseUrl: 'http://localhost:11434/v1',
    hostnames: ['localhost', '127.0.0.1'],
    supports: { chatCompletions: true, responses: false, messages: false },
  },
  {
    baseUrl: 'https://api.mistral.ai/v1',
    hostnames: ['api.mistral.ai'],
    supports: { chatCompletions: true, responses: false, messages: false },
  },
  {
    baseUrl: 'https://api.cohere.ai/v1',
    hostnames: ['api.cohere.ai'],
    supports: { chatCompletions: true, responses: false, messages: false },
  },
  {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hostnames: ['open.bigmodel.cn'],
    supports: { chatCompletions: true, responses: false, messages: false },
  },
];

/** Default for unknown providers — Chat Completions is the most widely supported protocol */
const UNKNOWN: ProviderInfo['supports'] = {
  chatCompletions: true,
  responses: false,
  messages: false,
};

const byName = new Map<string, ProviderInfo>();
const byHost = new Map<string, ProviderInfo>();

for (const p of REGISTRY) {
  // Index by provider name derived from hostname
  byName.set(p.hostnames[0], p);
  for (const h of p.hostnames) {
    byHost.set(h, p);
  }
}

function hostnameOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function lookupByUrl(baseUrl: string): ProviderInfo['supports'] {
  const host = hostnameOf(baseUrl);
  if (!host) return UNKNOWN;
  return byHost.get(host)?.supports ?? UNKNOWN;
}

export function getDefaultBaseUrl(provider?: string): string {
  const normalized = (provider || 'openrouter').toLowerCase();
  // Match by first hostname segment or full name
  for (const p of REGISTRY) {
    if (p.hostnames[0].includes(normalized) || normalized.includes(p.hostnames[0].split('.')[0])) {
      return p.baseUrl;
    }
  }
  return 'https://openrouter.ai/api/v1';
}

export function supportsResponsesApi(baseUrl: string): boolean {
  return lookupByUrl(baseUrl).responses;
}

export function supportsMessagesApi(baseUrl: string): boolean {
  return lookupByUrl(baseUrl).messages;
}

/**
 * For codex wire_api selection: only native OpenAI uses Responses wire protocol.
 * All other providers (including openrouter) should use Chat Completions wire.
 */
export function codexWireApi(baseUrl: string): 'responses' | 'chat' {
  const host = hostnameOf(baseUrl);
  return host === 'api.openai.com' ? 'responses' : 'chat';
}
