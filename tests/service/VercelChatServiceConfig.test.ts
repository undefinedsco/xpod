import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { VercelChatService } from '../../src/api/service/VercelChatService';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';

describe('VercelChatService provider config fallback', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'DEFAULT_API_KEY',
    'DEFAULT_PROVIDER',
    'DEFAULT_API_BASE',
    'DEFAULT_MODEL',
    'XPOD_AI_GATEWAY_BASE_URL',
    'XPOD_AI_GATEWAY_ENTRY_MODELS',
    'XPOD_AI_GATEWAY_TIMEOUT_MS',
  ] as const;

  const solidAuth = {
    type: 'solid' as const,
    webId: 'http://localhost:3310/test/profile/card#me',
    accountId: 'account-1',
    accessToken: 'solid-access-token',
    tokenType: 'Bearer' as const,
  };

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createService(config?: { apiKey?: string; baseUrl?: string; proxyUrl?: string; credentialId?: string }) {
    const store = {
      getAiConfig: vi.fn().mockResolvedValue(config),
      recordCredentialSuccess: vi.fn().mockResolvedValue(undefined),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
    };

    return {
      store,
      service: new VercelChatService(store as unknown as PodChatKitStore),
    };
  }

  function getFetchMock(): ReturnType<typeof vi.fn> {
    return vi.mocked(fetch);
  }

  it('uses pod config first', async () => {
    const { service } = createService({
      apiKey: 'pod-key',
      baseUrl: 'https://pod.example.com/v1',
      credentialId: 'cred-1',
    });

    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: solidAuth });

    expect(result.baseURL).toBe('https://pod.example.com/v1');
    expect(result.apiKey).toBe('pod-key');
    expect(result.credentialId).toBe('cred-1');
  });

  it('falls back to DEFAULT_API_BASE platform Provider', async () => {
    process.env.DEFAULT_API_BASE = 'https://platform.example.com/v1';
    process.env.DEFAULT_API_KEY = 'platform-key';

    const { service } = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: solidAuth });

    expect(result.baseURL).toBe('https://platform.example.com/v1');
    expect(result.apiKey).toBe('platform-key');
  });

  it('returns null when neither pod config nor DEFAULT_API_BASE exists', async () => {
    const { service } = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: solidAuth });

    expect(result).toBeNull();
  });

  it('throws model_not_configured for responses when no provider config', async () => {
    const { service } = createService(undefined);
    await expect(
      service.responses({ model: 'xpod-default', input: 'hello' }, solidAuth as any),
    ).rejects.toThrow('No AI provider configured');
  });

  it('throws model_not_configured for messages when no provider config', async () => {
    const { service } = createService(undefined);
    await expect(
      service.messages({ model: 'xpod-default', content: 'hello' }, solidAuth as any),
    ).rejects.toThrow('No AI provider configured');
  });

  it('uses DEFAULT_API_BASE with empty key when DEFAULT_API_KEY is not set', async () => {
    process.env.DEFAULT_API_BASE = 'https://platform.example.com/v1';

    const { service } = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: solidAuth });

    expect(result).not.toBeNull();
    expect(result.baseURL).toBe('https://platform.example.com/v1');
    expect(result.apiKey).toBe('');
  });

  it('forwards platform chat completions to ai-gateway', async () => {
    process.env.XPOD_AI_GATEWAY_BASE_URL = 'https://ai-gateway.example.com';
    process.env.XPOD_AI_GATEWAY_ENTRY_MODELS = 'linx, linx-lite';

    const { service, store } = createService(undefined);
    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-gateway',
      object: 'chat.completion',
      created: 123,
      model: 'linx',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'gateway ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    }, solidAuth as any);

    expect(result.choices[0].message.content).toBe('gateway ok');
    expect(store.getAiConfig).not.toHaveBeenCalled();

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ai-gateway.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    });

    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer solid-access-token');
  });

  it('forwards DPoP auth to ai-gateway with proof header', async () => {
    process.env.XPOD_AI_GATEWAY_BASE_URL = 'https://ai-gateway.example.com';
    process.env.XPOD_AI_GATEWAY_ENTRY_MODELS = 'linx';

    const { service } = createService(undefined);
    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-gateway',
      object: 'chat.completion',
      created: 123,
      model: 'linx',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'gateway ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    }, {
      ...solidAuth,
      tokenType: 'DPoP',
      dpopProof: 'test-dpop-proof',
    } as any);

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('DPoP solid-access-token');
    expect(headers.get('dpop')).toBe('test-dpop-proof');
  });

  it('fails fast when DPoP proof is missing for ai-gateway forwarding', async () => {
    process.env.XPOD_AI_GATEWAY_BASE_URL = 'https://ai-gateway.example.com';
    process.env.XPOD_AI_GATEWAY_ENTRY_MODELS = 'linx';

    const { service } = createService(undefined);

    await expect(service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    }, {
      ...solidAuth,
      tokenType: 'DPoP',
      dpopProof: undefined,
    } as any)).rejects.toThrow('DPoP token forwarding requires dpopProof in auth context');
  });

  it('forwards platform chat streams to ai-gateway', async () => {
    process.env.XPOD_AI_GATEWAY_BASE_URL = 'https://ai-gateway.example.com/v1';
    process.env.XPOD_AI_GATEWAY_ENTRY_MODELS = 'linx';

    const { service } = createService(undefined);
    getFetchMock().mockResolvedValueOnce(new Response('STREAM OK', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }));

    const result = await service.stream({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }, solidAuth as any);

    const response = result.toTextStreamResponse();
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('STREAM OK');
  });

  it('maps platform messages requests through ai-gateway chat completions', async () => {
    process.env.XPOD_AI_GATEWAY_BASE_URL = 'https://ai-gateway.example.com';
    process.env.XPOD_AI_GATEWAY_ENTRY_MODELS = 'linx';

    const { service } = createService(undefined);
    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-gateway',
      object: 'chat.completion',
      created: 123,
      model: 'linx',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'message ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 4,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.messages({
      model: 'linx',
      system: 'Be brief',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
      max_tokens: 128,
    }, solidAuth as any);

    expect(result.type).toBe('message');
    expect(result.content[0].text).toBe('message ok');
    expect(result.stop_reason).toBe('end_turn');

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'linx',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 128,
    });
  });

  it('prefers ai-gateway models and keeps platform fallback', async () => {
    process.env.XPOD_AI_GATEWAY_BASE_URL = 'https://ai-gateway.example.com';
    process.env.DEFAULT_API_BASE = 'https://platform.example.com/v1';
    process.env.DEFAULT_API_KEY = 'platform-key';

    const { service } = createService(undefined);
    getFetchMock()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'linx', object: 'model' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'legacy-model', object: 'model' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const result = await service.listModels(solidAuth as any);

    expect(result.map((model) => model.id)).toEqual(['linx', 'legacy-model']);

    const [gatewayUrl, gatewayInit] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(gatewayUrl).toBe('https://ai-gateway.example.com/v1/models');
    expect(new Headers(gatewayInit.headers).get('authorization')).toBe('Bearer solid-access-token');

    const [platformUrl, platformInit] = getFetchMock().mock.calls[1] as [string, RequestInit];
    expect(platformUrl).toBe('https://platform.example.com/v1/models');
    expect(new Headers(platformInit.headers).get('authorization')).toBe('Bearer platform-key');
  });
});
