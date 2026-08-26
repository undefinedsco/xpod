export const AMBIENT_AI_PROVIDER_ENV_KEYS = [
  'AI_CONNECTIONS_API_KEY',
  'AI_CONNECTIONS_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'OPENAI_MODEL',
  'CODEX_API_KEY',
  'CODEX_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'DEFAULT_API_KEY',
  'DEFAULT_API_BASE',
  'DEFAULT_PROVIDER',
  'DEFAULT_MODEL',
] as const;

const AMBIENT_AI_PROVIDER_ENV_KEY_SET = new Set<string>(AMBIENT_AI_PROVIDER_ENV_KEYS);
const AMBIENT_AI_PROVIDER_ENV_KEY_PATTERNS = [
  /^ANTHROPIC_DEFAULT_[A-Z0-9_]*MODEL$/u,
] as const;

export interface PlatformAiRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export function sanitizeRuntimeEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !isAmbientAiProviderEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

function isAmbientAiProviderEnvKey(key: string): boolean {
  return AMBIENT_AI_PROVIDER_ENV_KEY_SET.has(key as typeof AMBIENT_AI_PROVIDER_ENV_KEYS[number]) ||
    AMBIENT_AI_PROVIDER_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function requirePlatformAiRuntimeConfig(
  input: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  },
  context: string,
): PlatformAiRuntimeConfig {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(`${context} requires platform AI baseUrl`);
  }
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error(`${context} requires platform AI API key`);
  }
  const model = input.model?.trim();
  return {
    baseUrl,
    apiKey,
    ...(model ? { model } : {}),
  };
}

export function projectPlatformAiEnv(config: PlatformAiRuntimeConfig): Record<string, string> {
  return {
    AI_CONNECTIONS_BASE_URL: config.baseUrl,
    AI_CONNECTIONS_API_KEY: config.apiKey,
  };
}

export function projectOpenAiCompatibleEnv(config: PlatformAiRuntimeConfig): Record<string, string> {
  return {
    ...projectPlatformAiEnv(config),
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

export function projectAnthropicCompatibleEnv(config: PlatformAiRuntimeConfig): Record<string, string> {
  const baseUrl = normalizeMessagesCompatibleBaseUrl(config.baseUrl);
  const isOpenRouterLike = baseUrl.includes('openrouter.ai');
  return {
    ...projectPlatformAiEnv(config),
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
