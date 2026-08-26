/**
 * ChatKit direct AI fallback adapter tests.
 *
 * The adapter keeps the platform execution plane separate from user Pod
 * provider settings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VercelAiProvider } from '../../src/api/chatkit/ai-provider';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(),
}));

vi.mock('ai', () => ({
  streamText: vi.fn(),
  APICallError: class APICallError extends Error {
    public statusCode?: number;
    public responseHeaders?: Record<string, string>;
  },
}));

const solidContext = {
  auth: {
    type: 'solid' as const,
    webId: 'http://localhost:3310/test/profile/card#me',
    accountId: 'account-1',
    clientId: 'solid-client-id',
    clientSecret: 'solid-client-secret',
    accessToken: 'solid-access-token',
    tokenType: 'Bearer' as const,
    viaApiKey: true as const,
    scopes: ['inference:write'],
  },
};

describe('VercelAiProvider direct fallback adapter', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToManage = [
    'DEFAULT_API_KEY',
    'DEFAULT_API_BASE',
    'DEFAULT_PROVIDER',
    'DEFAULT_MODEL',
    'OPENAI_API_KEY',
    'XPOD_EDITION',
  ];
  let createOpenAIMock: any;
  let streamTextMock: any;

  beforeEach(async() => {
    for (const key of envKeysToManage) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    createOpenAIMock = (await import('@ai-sdk/openai')).createOpenAI as any;
    streamTextMock = (await import('ai')).streamText as any;
    const provider = {
      chat: vi.fn((model: string) => ({ provider: 'mock-openai', model })),
    };
    createOpenAIMock.mockReset();
    streamTextMock.mockReset();
    createOpenAIMock.mockReturnValue(provider);
    streamTextMock.mockReturnValue({
      textStream: (async function*(): AsyncIterable<string> {
        yield 'hello';
        yield ' world';
      })(),
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    vi.restoreAllMocks();
  });

  function createMockStore(config?: {
    providerId?: string;
    apiKey: string;
    baseUrl: string;
    proxyUrl?: string;
    defaultModel?: string;
    credentialId?: string;
  }): PodChatKitStore {
    return {
      getAiConfig: vi.fn().mockResolvedValue(config),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as PodChatKitStore;
  }

  it('streams platform models with server-only platform config without reading Pod', async () => {
    process.env.DEFAULT_API_BASE = 'https://platform-gateway.example/v1';
    process.env.DEFAULT_API_KEY = 'platform-key';
    process.env.OPENAI_API_KEY = 'openai-key-that-must-not-be-used';
    const store = createMockStore();
    const provider = new VercelAiProvider({ store });

    const chunks: string[] = [];
    for await (const chunk of provider.streamResponse([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'ping' },
    ], {
      model: 'linx-lite',
      temperature: 0.2,
      maxTokens: 64,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('hello world');
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://platform-gateway.example/v1',
      apiKey: 'platform-key',
    }));
    expect((createOpenAIMock.mock.results[0].value.chat as any)).toHaveBeenCalledWith('linx-lite');
    expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'ping' },
      ],
      temperature: 0.2,
      maxTokens: 64,
    }));
    expect((store.getAiConfig as any)).not.toHaveBeenCalled();
  });

  it('streams user models with caller-owned Solid client credentials', async () => {
    const store = createMockStore({
      apiKey: 'user-key',
      baseUrl: 'https://user-provider.example/v1',
      proxyUrl: undefined,
      defaultModel: 'user-default',
      credentialId: 'credential-1',
    });
    const provider = new VercelAiProvider({ store });

    const iterator = provider.streamResponse([
      { role: 'user', content: 'ping' },
    ], {
      model: 'gpt-4o-mini',
      context: solidContext,
    });

    const chunks: string[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('hello world');
    expect((store.getAiConfig as any)).toHaveBeenCalledWith(expect.objectContaining({
      userId: solidContext.auth.webId,
      auth: solidContext.auth,
    }));
    expect(createOpenAIMock).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://user-provider.example/v1',
      apiKey: 'user-key',
    }));
    expect((createOpenAIMock.mock.results[0].value.chat as any)).toHaveBeenCalledWith('gpt-4o-mini');
    expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: 'ping' }],
    }));
  });

  it('fails user models without current Solid caller auth before reading Pod', async () => {
    const store = createMockStore({
      apiKey: 'user-key',
      baseUrl: 'https://user-provider.example/v1',
    });
    const provider = new VercelAiProvider({ store });

    const iterator = provider.streamResponse([
      { role: 'user', content: 'ping' },
    ], { model: 'gpt-4o-mini' });

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'model_not_configured' });
    expect((store.getAiConfig as any)).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('rejects browser DPoP for user models instead of replaying it to the Pod', async () => {
    const store = createMockStore({
      apiKey: 'user-key',
      baseUrl: 'https://user-provider.example/v1',
    });
    const provider = new VercelAiProvider({ store });
    const iterator = provider.streamResponse([
      { role: 'user', content: 'ping' },
    ], {
      model: 'gpt-4o-mini',
      context: {
        auth: {
          type: 'solid',
          webId: 'https://pod.example/alice/profile/card#me',
          accessToken: 'browser-token',
          tokenType: 'DPoP',
          dpopProof: 'proof-for-the-api-request-only',
        },
      },
    });

    await expect(iterator[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'model_not_configured' });
    expect((store.getAiConfig as any)).not.toHaveBeenCalled();
  });

  it('does not inspect Pod-supplied proxies in cloud edition for browser callers', async () => {
    process.env.XPOD_EDITION = 'cloud';
    const store = createMockStore({
      providerId: 'openai',
      apiKey: 'user-key',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: 'http://127.0.0.1:7890',
    });
    const provider = new VercelAiProvider({ store });
    const iterator = provider.streamResponse([
      { role: 'user', content: 'ping' },
    ], {
      model: 'gpt-4o-mini',
      context: {
        auth: {
          type: 'solid',
          webId: 'https://pod.example/alice/profile/card#me',
          accessToken: 'browser-token',
          tokenType: 'DPoP',
          dpopProof: 'proof-for-the-api-request-only',
        },
      },
    });

    await expect(iterator[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'model_not_configured' });
    expect((store.getAiConfig as any)).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});
