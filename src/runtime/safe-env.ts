export const AMBIENT_AI_PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'DEFAULT_API_KEY',
  'DEFAULT_API_BASE',
  'DEFAULT_PROVIDER',
  'DEFAULT_MODEL',
] as const;

const AMBIENT_AI_PROVIDER_ENV_KEY_SET = new Set<string>(AMBIENT_AI_PROVIDER_ENV_KEYS);

export interface AiConnectionRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export function sanitizeRuntimeEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !AMBIENT_AI_PROVIDER_ENV_KEY_SET.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

export function requireAiConnectionRuntimeConfig(
  input: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  },
  context: string,
): AiConnectionRuntimeConfig {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(`${context} requires AI Connection baseUrl`);
  }
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error(`${context} requires AI Connection API key`);
  }
  const model = input.model?.trim();
  return {
    baseUrl,
    apiKey,
    ...(model ? { model } : {}),
  };
}

export function projectAiConnectionEnv(config: AiConnectionRuntimeConfig): Record<string, string> {
  return {
    AI_CONNECTION_BASE_URL: config.baseUrl,
    AI_CONNECTION_API_KEY: config.apiKey,
  };
}

export function projectOpenAiCompatibleEnv(config: AiConnectionRuntimeConfig): Record<string, string> {
  return {
    ...projectAiConnectionEnv(config),
    OPENAI_BASE_URL: config.baseUrl,
    OPENAI_API_BASE: config.baseUrl,
    OPENAI_API_KEY: config.apiKey,
    CODEX_API_KEY: config.apiKey,
    ...(config.model ? {
      OPENAI_MODEL: config.model,
      CODEX_MODEL: config.model,
    } : {}),
  };
}

export function projectAnthropicCompatibleEnv(config: AiConnectionRuntimeConfig): Record<string, string> {
  const baseUrl = normalizeMessagesCompatibleBaseUrl(config.baseUrl);
  const isOpenRouterLike = baseUrl.includes('openrouter.ai');
  return {
    ...projectAiConnectionEnv(config),
    ANTHROPIC_BASE_URL: baseUrl,
    ...(isOpenRouterLike
      ? { ANTHROPIC_AUTH_TOKEN: config.apiKey }
      : { ANTHROPIC_API_KEY: config.apiKey }),
    ...(config.model ? {
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
    } : {}),
  };
}

function normalizeMessagesCompatibleBaseUrl(baseUrl: string): string {
  if (baseUrl.endsWith('/v1')) {
    return baseUrl.slice(0, -3);
  }
  if (baseUrl.endsWith('/v1/')) {
    return baseUrl.slice(0, -4);
  }
  return baseUrl;
}
