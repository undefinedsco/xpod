import { describe, expect, it } from 'vitest';

import {
  createEmbeddingModelPolicy,
  EmbeddingModelNotAllowedError,
  EmbeddingModelPolicy,
  parseEmbeddingModelRef,
} from '../../src/ai/service/EmbeddingModelPolicy';
import { createDefaultProviderRegistry } from '../../src/api/ai-gateway/providers/ProviderRegistry';
import { createGatewayEmbeddingModelCatalog } from '../../src/api/ai-gateway/models/GatewayEmbeddingModelCatalog';
import { classifyEmbeddingProviderFailure } from '../../src/ai/service/EmbeddingProviderError';
import {
  EmbeddingEndpointNotProvidedError,
  isEmbeddingPolicyRejection,
} from '../../src/ai/service/EmbeddingModelPolicy';

const registry = createDefaultProviderRegistry();
const catalog = createGatewayEmbeddingModelCatalog(registry, 'cloud');
const localCatalog = createGatewayEmbeddingModelCatalog(registry, 'local');

describe('EmbeddingModelPolicy', () => {
  it('allows any model for a local deployment', () => {
    const policy = createEmbeddingModelPolicy({ deployment: 'local', catalog: localCatalog });

    expect(policy.isEnforced()).toBe(false);
    expect(policy.isAllowed({ provider: 'custom', model: 'acme-embed-v9' })).toBe(true);
    expect(() => policy.assertAllowed({ provider: 'custom', model: 'acme-embed-v9' })).not.toThrow();
  });

  it('only allows catalog embedding models for a cloud deployment', () => {
    const policy = createEmbeddingModelPolicy({ deployment: 'cloud', catalog });

    expect(policy.isEnforced()).toBe(true);
    expect(policy.isAllowed({ provider: 'openai', model: 'text-embedding-3-small' })).toBe(true);
    expect(policy.isAllowed({ provider: 'custom', model: 'acme-embed-v9' })).toBe(false);
    expect(policy.isAllowed({ provider: 'openai', model: 'acme-embed-v9' })).toBe(false);
    expect(policy.isAllowed({ provider: '', model: 'text-embedding-3-small' })).toBe(false);
    expect(policy.isAllowed({ provider: 'openai', model: '  ' })).toBe(false);
  });

  it('resolves runtime provider vocabularies onto catalog providers', () => {
    const policy = createEmbeddingModelPolicy({ deployment: 'cloud', catalog });

    // The default embedding profile names the provider `dashscope`; the catalog
    // provides it as `bailian`.
    expect(policy.isAllowed({ provider: 'dashscope', model: 'text-embedding-v4' })).toBe(true);
    expect(policy.isAllowed({ provider: 'qwen', model: 'text-embedding-v4' })).toBe(true);
    expect(policy.isAllowed({ provider: 'dashscope', model: 'text-embedding-v3' })).toBe(false);
  });

  it('treats a cloud policy without a catalog as unenforced rather than failing closed', () => {
    const policy = createEmbeddingModelPolicy({ deployment: 'cloud' });

    expect(policy.isEnforced()).toBe(false);
    expect(policy.isAllowed({ provider: 'custom', model: 'acme-embed-v9' })).toBe(true);
  });

  it('throws a typed, non-retryable rejection', () => {
    const policy = EmbeddingModelPolicy.fromCatalog(catalog);

    try {
      policy.assertAllowed({ provider: 'custom', model: 'acme-embed-v9' });
      expect.unreachable('policy must reject a non-provided embedding model');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingModelNotAllowedError);
      expect((error as EmbeddingModelNotAllowedError).code).toBe('embedding_model_not_allowed');
    }
  });
});

describe('parseEmbeddingModelRef', () => {
  it('parses relative and absolute AI Config model refs', () => {
    expect(parseEmbeddingModelRef('settings/providers/bailian.ttl#text-embedding-v4'))
      .toEqual({ provider: 'bailian', model: 'text-embedding-v4' });
    expect(parseEmbeddingModelRef('https://pod.example/alice/settings/providers/openai.ttl#text-embedding-3-small'))
      .toEqual({ provider: 'openai', model: 'text-embedding-3-small' });
    expect(parseEmbeddingModelRef('/settings/providers/custom.ttl#acme-embed-v9'))
      .toEqual({ provider: 'custom', model: 'acme-embed-v9' });
  });

  it('returns undefined when the ref cannot prove both provider and model', () => {
    expect(parseEmbeddingModelRef('')).toBeUndefined();
    expect(parseEmbeddingModelRef('   ')).toBeUndefined();
    expect(parseEmbeddingModelRef('text-embedding-v4')).toBeUndefined();
    expect(parseEmbeddingModelRef('settings/providers/bailian.ttl')).toBeUndefined();
  });
});

describe('embedding failure classification', () => {
  it('treats a policy rejection as a non-retryable configuration failure', () => {
    const policy = EmbeddingModelPolicy.fromCatalog(catalog);

    let rejection: unknown;
    try {
      policy.assertAllowed({ provider: 'custom', model: 'acme-embed-v9' });
    } catch (error) {
      rejection = error;
    }

    expect(classifyEmbeddingProviderFailure(rejection)).toEqual({
      retryable: false,
      category: 'embedding_model_invalid',
    });
  });
});

describe('EmbeddingModelPolicy endpoint authority', () => {
  it('keeps the Pod endpoint on a local deployment', () => {
    const policy = createEmbeddingModelPolicy({ deployment: 'local', catalog: localCatalog });

    expect(policy.resolveEndpoint({
      provider: 'custom',
      baseUrl: 'https://my-own-endpoint.example/v1',
      proxyUrl: 'http://127.0.0.1:7890',
    })).toEqual({
      baseUrl: 'https://my-own-endpoint.example/v1',
      proxyUrl: 'http://127.0.0.1:7890',
      source: 'pod',
    });
  });

  it('replaces the Pod endpoint with the provided catalog endpoint on cloud', () => {
    const policy = createEmbeddingModelPolicy({ deployment: 'cloud', catalog });

    expect(policy.resolveEndpoint({
      provider: 'openai',
      baseUrl: 'https://my-own-endpoint.example/v1',
      proxyUrl: 'http://127.0.0.1:7890',
    })).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: undefined,
      source: 'catalog',
    });
    // The runtime provider vocabulary resolves to the same catalog endpoint.
    expect(policy.resolveEndpoint({ provider: 'dashscope' }).baseUrl)
      .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('rejects a provider the deployment does not provide an endpoint for', () => {
    const policy = createEmbeddingModelPolicy({ deployment: 'cloud', catalog });

    // Ollama only has a local offering, so Cloud must not pin traffic to it.
    expect(() => policy.resolveEndpoint({ provider: 'ollama' }))
      .toThrow(EmbeddingEndpointNotProvidedError);
    expect(() => policy.resolveEndpoint({ provider: 'google' }))
      .toThrow(EmbeddingEndpointNotProvidedError);
    expect(isEmbeddingPolicyRejection(new EmbeddingEndpointNotProvidedError('ollama'))).toBe(true);
  });
});
