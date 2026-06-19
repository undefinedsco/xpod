export const DEFAULT_EMBEDDING_PROVIDER_ID = 'dashscope';
export const DEFAULT_EMBEDDING_MODEL_ID = 'text-embedding-v4';
export const DEFAULT_EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const DEFAULT_EMBEDDING_MODELS_BY_PROVIDER = new Map<string, string>([
  [DEFAULT_EMBEDDING_PROVIDER_ID, DEFAULT_EMBEDDING_MODEL_ID],
  ['qwen', DEFAULT_EMBEDDING_MODEL_ID],
  ['alibaba', DEFAULT_EMBEDDING_MODEL_ID],
]);

const DEFAULT_BASE_URLS_BY_PROVIDER = new Map<string, string>([
  [DEFAULT_EMBEDDING_PROVIDER_ID, DEFAULT_EMBEDDING_BASE_URL],
  ['qwen', DEFAULT_EMBEDDING_BASE_URL],
  ['alibaba', DEFAULT_EMBEDDING_BASE_URL],
  ['dashscope-cn', DEFAULT_EMBEDDING_BASE_URL],
  ['dashscope-intl', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
]);

export function defaultEmbeddingModelForProvider(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  return DEFAULT_EMBEDDING_MODELS_BY_PROVIDER.get(providerId.trim().toLowerCase());
}

export function defaultBaseUrlForProvider(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  return DEFAULT_BASE_URLS_BY_PROVIDER.get(providerId.trim().toLowerCase());
}
