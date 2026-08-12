import {
  APICallError,
  LoadAPIKeyError,
  NoSuchModelError,
  RetryError,
} from 'ai';

export type EmbeddingProviderFailureCategory =
  | 'embedding_authentication_failed'
  | 'embedding_authorization_failed'
  | 'embedding_model_invalid'
  | 'embedding_request_invalid'
  | 'embedding_quota_exhausted'
  | 'embedding_rate_limited'
  | 'embedding_upstream_unavailable'
  | 'embedding_provider_failed';

export interface EmbeddingProviderFailure {
  retryable: boolean;
  category: EmbeddingProviderFailureCategory;
}

/** Classify AI SDK failures without inspecting provider-specific message text. */
export function classifyEmbeddingProviderFailure(error: unknown): EmbeddingProviderFailure {
  if (RetryError.isInstance(error) && error.lastError !== error) {
    return classifyEmbeddingProviderFailure(error.lastError);
  }
  if (NoSuchModelError.isInstance(error)) {
    return { retryable: false, category: 'embedding_model_invalid' };
  }
  if (LoadAPIKeyError.isInstance(error)) {
    return { retryable: false, category: 'embedding_authentication_failed' };
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401) {
      return { retryable: false, category: 'embedding_authentication_failed' };
    }
    if (status === 403) {
      return { retryable: false, category: 'embedding_authorization_failed' };
    }
    if (status === 404) {
      return { retryable: false, category: 'embedding_model_invalid' };
    }
    if (status === 402) {
      return { retryable: true, category: 'embedding_quota_exhausted' };
    }
    if (status === 429) {
      return { retryable: true, category: 'embedding_rate_limited' };
    }
    if (error.isRetryable || status === 408 || status === 409 || (status !== undefined && status >= 500)) {
      return { retryable: true, category: 'embedding_upstream_unavailable' };
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return { retryable: false, category: 'embedding_request_invalid' };
    }
  }
  return { retryable: true, category: 'embedding_provider_failed' };
}
