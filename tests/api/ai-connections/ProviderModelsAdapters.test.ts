import { describe, expect, it, vi } from 'vitest';

import {
  AnthropicModelsAdapter,
  OpenAiCompatibleModelsAdapter,
  ProviderModelsFetchError,
  normalizeDiscoveredModels,
} from '../../../src/api/ai-connections/models';

function jsonFetch(
  handler: (url: string, init: RequestInit | undefined) => {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  },
): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: result.headers,
    });
  }) as unknown as typeof fetch;
}

describe('ProviderModelsAdapters', () => {
  it('discovers OpenAI-compatible models from the requested base URL with bearer auth', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.moonshot.ai/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
      return {
        body: {
          data: [
            { id: 'kimi-k2', display_name: 'Kimi K2' },
            { id: 'text-embedding-3-large' },
            { id: 'kimi-k2' },
            { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
          ],
        },
      };
    });

    const models = await new OpenAiCompatibleModelsAdapter({
      provider: 'kimi',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: { provider: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' },
      secret: { apiKey: 'provider-secret' },
    });

    expect(models).toEqual([
      { id: 'kimi-k2', displayName: 'Kimi K2' },
      { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
    ]);
  });

  it('prefers the requested base URL over the adapter default', async () => {
    const fetch = jsonFetch((url) => {
      expect(url).toBe('https://api.moonshot.cn/v1/models');
      return { body: { data: [{ id: 'kimi-k2' }] } };
    });

    const models = await new OpenAiCompatibleModelsAdapter({
      provider: 'kimi',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: { provider: 'kimi', baseUrl: 'https://api.moonshot.cn/v1' },
      secret: { apiKey: 'provider-secret' },
    });

    expect(models).toEqual([{ id: 'kimi-k2' }]);
  });

  it('discovers Anthropic models with x-api-key and version headers', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/models');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('provider-secret');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      return {
        body: {
          data: [
            { id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1' },
            { id: 'claude-sonnet-4-5' },
          ],
        },
      };
    });

    const models = await new AnthropicModelsAdapter({ fetchImpl: fetch }).fetch({
      credential: { provider: 'anthropic' },
      secret: { apiKey: 'provider-secret' },
    });

    expect(models).toEqual([
      { id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-5' },
    ]);
  });

  it('passes through the provider status code on fetch failure', async () => {
    const fetch = jsonFetch(() => ({ status: 401, body: { error: 'invalid key' } }));

    await expect(new OpenAiCompatibleModelsAdapter({
      provider: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: { provider: 'openai' },
      secret: { apiKey: 'provider-secret' },
    })).rejects.toMatchObject({
      name: 'ProviderModelsFetchError',
      providerStatus: 401,
    } satisfies Partial<ProviderModelsFetchError>);
  });

  it('normalizes alternate list envelopes and skips invalid entries', () => {
    expect(normalizeDiscoveredModels({
      models: {
        models: [
          { name: 'models/gemini-2.5-pro' },
          { model: 'gemini-2.5-flash', title: 'Gemini 2.5 Flash' },
          { slug: '' },
          'not-an-object',
        ],
      },
    })).toEqual([
      { id: 'models/gemini-2.5-pro' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    ]);
    expect(normalizeDiscoveredModels({ result: [{ id: 'deepseek-chat' }] })).toEqual([
      { id: 'deepseek-chat' },
    ]);
    expect(normalizeDiscoveredModels(undefined)).toEqual([]);
  });
});
