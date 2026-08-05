import { describe, expect, it, vi } from 'vitest';

import type { ProviderSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import {
  createProviderModelDiscoveryAdapters,
  type DiscoveredProviderModel,
} from '../../../src/api/ai-gateway/models/ProviderModelDiscoveryAdapters';

const SECRETS: Record<string, ProviderSecret> = {
  openai: { type: 'apiKey', apiKey: 'sk-openai-secret' },
  anthropic: { type: 'apiKey', apiKey: 'sk-anthropic-secret' },
  kimi: { type: 'deviceCodeOAuth', accessToken: 'kimi-access-secret' },
  bailian: { type: 'apiKey', apiKey: 'sk-bailian-secret' },
  deepseek: { type: 'apiKey', apiKey: 'sk-deepseek-secret' },
};

const BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  kimi: 'https://api.moonshot.ai/v1',
  bailian: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

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

function modelIds(models: DiscoveredProviderModel[]): string[] {
  return models.map((model) => model.id);
}

describe('ProviderModelDiscoveryAdapters', () => {
  it('discovers all OpenAI-compatible providers through their allowlisted /models endpoint', async () => {
    const calls: Array<{ provider: string; url: string; headers: Headers }> = [];
    const fetch = jsonFetch((url, init) => {
      const provider = Object.entries(BASE_URLS).find(([, baseUrl]) => url.startsWith(`${baseUrl}/`))?.[0] ?? 'unknown';
      calls.push({ provider, url, headers: new Headers(init?.headers) });
      return {
        body: {
          object: 'list',
          data: [
            { id: `${provider}-chat`, object: 'model', owned_by: provider },
            { id: `${provider}-embedding`, object: 'model', model_type: 'embedding' },
          ],
        },
      };
    });
    const registry = createProviderModelDiscoveryAdapters({ fetch });

    for (const provider of ['openai', 'kimi', 'bailian', 'deepseek']) {
      const models = await registry.get(provider).discover({
        baseUrl: BASE_URLS[provider],
        secret: SECRETS[provider],
      });
      expect(modelIds(models)).toEqual([`${provider}-chat`, `${provider}-embedding`]);
      expect(models[1]?.modelType).toBe('embedding');
    }

    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.url.endsWith('/models'))).toBe(true);
    expect(calls.find((call) => call.provider === 'openai')?.headers.get('authorization'))
      .toBe('Bearer sk-openai-secret');
    expect(calls.find((call) => call.provider === 'kimi')?.headers.get('authorization'))
      .toBe('Bearer kimi-access-secret');
  });

  it('uses Anthropic model-list headers for api keys and OAuth access tokens', async () => {
    const calls: Headers[] = [];
    const fetch = jsonFetch((_url, init) => {
      calls.push(new Headers(init?.headers));
      return { body: { data: [{ id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet' }] } };
    });
    const adapter = createProviderModelDiscoveryAdapters({ fetch }).get('anthropic');

    await adapter.discover({ baseUrl: BASE_URLS.anthropic, secret: SECRETS.anthropic });
    await adapter.discover({
      baseUrl: BASE_URLS.anthropic,
      secret: { type: 'deviceCodeOAuth', accessToken: 'anthropic-access-secret' },
    });

    expect(calls[0]?.get('x-api-key')).toBe('sk-anthropic-secret');
    expect(calls[0]?.get('authorization')).toBeNull();
    expect(calls[0]?.get('anthropic-version')).toBe('2023-06-01');
    expect(calls[1]?.get('x-api-key')).toBeNull();
    expect(calls[1]?.get('authorization')).toBe('Bearer anthropic-access-secret');
    expect(calls[1]?.get('anthropic-version')).toBe('2023-06-01');
  });

  it('rejects endpoints outside each provider descriptor allowlist before making a request', async () => {
    const fetch = vi.fn() as unknown as typeof fetch;
    const registry = createProviderModelDiscoveryAdapters({ fetch });

    for (const provider of Object.keys(BASE_URLS)) {
      await expect(registry.get(provider).discover({
        baseUrl: `https://evil.example/${provider}/v1`,
        secret: SECRETS[provider],
      })).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
        details: { provider },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('follows cursor pagination, deduplicates IDs, and rejects a repeated cursor loop', async () => {
    const urls: string[] = [];
    const fetch = jsonFetch((url) => {
      urls.push(url);
      const cursor = new URL(url).searchParams.get('after');
      if (!cursor) {
        return {
          body: {
            data: [{ id: 'gpt-5' }, { id: 'gpt-5', display_name: 'duplicate' }],
            has_more: true,
            last_id: 'page-2',
          },
        };
      }
      return {
        body: {
          data: [{ id: 'gpt-4.1' }, { id: 'gpt-5', description: 'provider-secret' }],
          has_more: true,
          last_id: 'page-2',
        },
      };
    });
    const adapter = createProviderModelDiscoveryAdapters({ fetch }).get('openai');

    const error = await adapter.discover({
      baseUrl: BASE_URLS.openai,
      secret: SECRETS.openai,
    }).catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({
      code: 'provider_error',
      status: 502,
      details: {
        classification: 'pagination_cursor_repeated',
      },
    });
    expect(error.message).not.toContain('provider-secret');
    expect(urls).toEqual([
      `${BASE_URLS.openai}/models`,
      `${BASE_URLS.openai}/models?after=page-2`,
    ]);
  });

  it('follows Anthropic after_id pagination and honors a configured page bound', async () => {
    const urls: string[] = [];
    const fetch = jsonFetch((url) => {
      urls.push(url);
      const cursor = new URL(url).searchParams.get('after_id');
      return {
        body: {
          data: [{ id: cursor ? `claude-${cursor}` : 'claude-first' }],
          has_more: true,
          last_id: cursor ? `${cursor}-next` : 'cursor-1',
        },
      };
    });
    const adapter = createProviderModelDiscoveryAdapters({ fetch, maxPages: 2 }).get('anthropic');

    await expect(adapter.discover({
      baseUrl: BASE_URLS.anthropic,
      secret: SECRETS.anthropic,
    })).rejects.toMatchObject({
      code: 'provider_error',
      details: { classification: 'pagination_limit' },
    });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(`${BASE_URLS.anthropic}/models?after_id=cursor-1`);
  });

  it('skips malformed rows while failing malformed top-level responses', async () => {
    const fetch = jsonFetch((url) => {
      if (url.endsWith('/models')) {
        return {
          body: {
            data: [
              null,
              42,
              {},
              { id: '' },
              { id: '  gpt-5  ', display_name: 'GPT-5' },
              { id: 'text-embedding-3-small', type: 'embedding' },
            ],
          },
        };
      }
      return { body: { data: [] } };
    });
    const adapter = createProviderModelDiscoveryAdapters({ fetch }).get('openai');

    await expect(adapter.discover({
      baseUrl: BASE_URLS.openai,
      secret: SECRETS.openai,
    })).resolves.toEqual([
      { id: 'gpt-5', displayName: 'GPT-5', modelType: 'chat' },
      { id: 'text-embedding-3-small', modelType: 'embedding' },
    ]);

    const invalidTopLevelFetch = jsonFetch(() => ({ body: { data: 'not-an-array' } }));
    await expect(createProviderModelDiscoveryAdapters({ fetch: invalidTopLevelFetch }).get('openai').discover({
      baseUrl: BASE_URLS.openai,
      secret: SECRETS.openai,
    })).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  });

  it('classifies model types conservatively from metadata and identifiers', async () => {
    const fetch = jsonFetch(() => ({
      body: {
        data: [
          { id: 'text-embedding-3-large' },
          { id: 'dall-e-3' },
          { id: 'whisper-1' },
          { id: 'claude-sonnet-4-5-20250929' },
          { id: 'vendor-proprietary-v1', type: 'model' },
        ],
      },
    }));
    const models = await createProviderModelDiscoveryAdapters({ fetch }).get('openai').discover({
      baseUrl: BASE_URLS.openai,
      secret: SECRETS.openai,
    });

    expect(models).toEqual([
      { id: 'text-embedding-3-large', modelType: 'embedding' },
      { id: 'dall-e-3', modelType: 'image' },
      { id: 'whisper-1', modelType: 'audio' },
      { id: 'claude-sonnet-4-5-20250929', modelType: 'chat' },
      { id: 'vendor-proprietary-v1', modelType: 'other' },
    ]);
  });

  it('keeps multimodal chat models as chat and gives explicit output type precedence', async () => {
    const fetch = jsonFetch(() => ({
      body: {
        data: [
          {
            id: 'vendor-vision-chat',
            object: 'model',
            modalities: ['text', 'image', 'audio'],
            capabilities: { image: true, audio: true },
          },
          {
            id: 'vendor-image-chat',
            type: 'chat',
            modalities: ['text', 'image'],
          },
          { id: 'vendor-image-generation', type: 'image', modalities: ['text', 'image'] },
          { id: 'vendor-audio-generation', modelType: 'audio' },
        ],
      },
    }));
    const models = await createProviderModelDiscoveryAdapters({ fetch }).get('openai').discover({
      baseUrl: BASE_URLS.openai,
      secret: SECRETS.openai,
    });

    expect(models).toEqual([
      { id: 'vendor-vision-chat', modelType: 'chat' },
      { id: 'vendor-image-chat', modelType: 'chat' },
      { id: 'vendor-image-generation', modelType: 'image' },
      { id: 'vendor-audio-generation', modelType: 'audio' },
    ]);
  });

  it.each([
    ['DOM AbortError', () => new DOMException('The operation was aborted', 'AbortError')],
    ['TimeoutError', () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })],
  ])('preserves %s rejection when the discovery signal is already aborted', async (_label, createError) => {
    const controller = new AbortController();
    controller.abort();
    const rejection = createError();
    const fetch = vi.fn().mockRejectedValue(rejection) as unknown as typeof globalThis.fetch;

    await expect(createProviderModelDiscoveryAdapters({ fetch }).get('openai').discover({
      baseUrl: BASE_URLS.openai,
      secret: SECRETS.openai,
      signal: controller.signal,
    })).rejects.toBe(rejection);
  });

  it('preserves a custom AbortController reason from a cancelled discovery request', async () => {
    const controller = new AbortController();
    const rejection = new Error('caller cancelled discovery');
    controller.abort(rejection);
    const fetch = vi.fn().mockRejectedValue(rejection) as unknown as typeof globalThis.fetch;

    await expect(createProviderModelDiscoveryAdapters({ fetch }).get('anthropic').discover({
      baseUrl: BASE_URLS.anthropic,
      secret: SECRETS.anthropic,
      signal: controller.signal,
    })).rejects.toBe(rejection);
  });

  it.each([401, 403])('marks HTTP %s as reauth-required without exposing provider body', async (status) => {
    const secret = SECRETS.openai.apiKey as string;
    const fetch = jsonFetch(() => ({
      status,
      body: { error: `upstream body contains ${secret}` },
    }));

    const error = await createProviderModelDiscoveryAdapters({ fetch }).get('openai').discover({
      baseUrl: BASE_URLS.openai,
      secret: SECRETS.openai,
    }).catch((caught: unknown) => caught as Error & { details?: Record<string, unknown> });

    expect(error).toMatchObject({
      code: 'provider_error',
      status,
      details: {
        provider: 'openai',
        providerStatusCode: status,
        reauthRequired: true,
      },
    });
    expect(error.message).not.toContain(secret);
  });

  it('preserves Retry-After for 429 while keeping errors secret-safe', async () => {
    const secret = SECRETS.deepseek.apiKey as string;
    const fetch = jsonFetch(() => ({
      status: 429,
      headers: { 'Retry-After': '17' },
      body: { message: `retry later ${secret}` },
    }));

    await expect(createProviderModelDiscoveryAdapters({ fetch }).get('deepseek').discover({
      baseUrl: BASE_URLS.deepseek,
      secret: SECRETS.deepseek,
    })).rejects.toMatchObject({
      code: 'provider_error',
      status: 429,
      details: {
        providerStatusCode: 429,
        classification: 'rate_limited',
        retryAfter: '17',
      },
    });

    try {
      await createProviderModelDiscoveryAdapters({ fetch }).get('deepseek').discover({
        baseUrl: BASE_URLS.deepseek,
        secret: SECRETS.deepseek,
      });
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
    }
  });

  it('exposes a typed registry for all five focused providers', () => {
    const registry = createProviderModelDiscoveryAdapters();
    expect(registry.list().map((adapter) => adapter.provider)).toEqual([
      'openai',
      'anthropic',
      'kimi',
      'bailian',
      'deepseek',
    ]);
    expect(registry.get('OPENAI').provider).toBe('openai');
    expect(() => registry.get('unknown')).toThrow(/unknown provider/i);
  });
});
