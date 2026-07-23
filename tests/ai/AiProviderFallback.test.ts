/**
 * ChatKit direct AI fallback adapter tests.
 *
 * The adapter must use the unified AI Connection gateway runtime. It must not
 * reopen Pod provider credentials or fall back to platform API-key env vars.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VercelAiProvider } from '../../src/api/chatkit/ai-provider';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import type { GatewayEvent } from '../../src/api/ai-gateway/types';

const solidContext = {
  auth: {
    type: 'solid' as const,
    webId: 'http://localhost:3310/test/profile/card#me',
    accountId: 'account-1',
    accessToken: 'solid-access-token',
    tokenType: 'Bearer' as const,
    scopes: ['inference:write'],
  },
};

describe('VercelAiProvider gateway fallback adapter', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToManage = [
    'DEFAULT_API_KEY',
    'DEFAULT_API_BASE',
    'DEFAULT_PROVIDER',
    'DEFAULT_MODEL',
    'OPENAI_API_KEY',
  ];

  beforeEach(() => {
    for (const key of envKeysToManage) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
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

  function createMockStore(): PodChatKitStore {
    return {
      getAiConfig: vi.fn().mockResolvedValue({
        apiKey: 'legacy-pod-key-that-must-not-be-read',
        baseUrl: 'https://legacy-provider.example/v1',
      }),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as PodChatKitStore;
  }

  it('streams text through AiGatewayService without Pod or env provider fallback', async () => {
    process.env.DEFAULT_API_BASE = 'https://legacy-env-provider.example/v1';
    process.env.DEFAULT_API_KEY = 'legacy-env-key';
    process.env.OPENAI_API_KEY = 'legacy-openai-env-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const store = createMockStore();
    const gateway = {
      execute: vi.fn(async(input: any) => ({
        protocol: input.protocol,
        frontend: {},
        request: { model: 'linx' },
        route: {},
        events: (async function*(): AsyncIterable<GatewayEvent> {
          yield { type: 'response.started', id: 'chatcmpl-1' };
          yield { type: 'text.delta', text: 'hello' };
          yield { type: 'text.delta', text: ' world' };
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
          yield { type: 'response.completed', finishReason: 'stop' };
        })(),
      })),
    };
    const provider = new VercelAiProvider({ store, aiGatewayService: gateway as any });

    const chunks: string[] = [];
    for await (const chunk of provider.streamResponse([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'ping' },
    ], {
      model: 'linx',
      temperature: 0.2,
      maxTokens: 64,
      context: solidContext,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('hello world');
    expect(gateway.execute).toHaveBeenCalledWith(expect.objectContaining({
      auth: solidContext.auth,
      protocol: 'chatCompletions',
      body: {
        model: 'linx',
        messages: [
          { role: 'system', content: 'Be brief' },
          { role: 'user', content: 'ping' },
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 64,
      },
    }));
    expect((store.getAiConfig as any)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when no AiGatewayService is injected', async () => {
    const store = createMockStore();
    const provider = new VercelAiProvider({ store });

    const iterator = provider.streamResponse([
      { role: 'user', content: 'ping' },
    ], { context: solidContext });

    await expect(iterator.next()).rejects.toThrow('AiGatewayService is required');
    expect((store.getAiConfig as any)).not.toHaveBeenCalled();
  });
});
