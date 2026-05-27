import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { VercelChatService } from '../../src/api/service/VercelChatService';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';

describe('VercelChatService provider config fallback', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let savedFetch: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;
  const envKeys = [
    'DEFAULT_API_BASE',
    'DEFAULT_API_KEY',
    'DEFAULT_GENERATION_TIMEOUT_MS',
    'DEFAULT_TIMEOUT_MS',
    'DEFAULT_PROVIDER',
    'DEFAULT_MODEL',
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
    savedFetch = globalThis.fetch;
    fetchMock = vi.fn();
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }

    if (savedFetch) {
      Object.defineProperty(globalThis, 'fetch', {
        value: savedFetch,
        writable: true,
        configurable: true,
      });
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
    vi.restoreAllMocks();
  });

  function createService(config?: { apiKey?: string; baseUrl?: string; proxyUrl?: string; credentialId?: string }) {
    const store = {
      getAiConfig: vi.fn().mockResolvedValue(config),
      listAvailableModels: vi.fn().mockResolvedValue([]),
      recordCredentialSuccess: vi.fn().mockResolvedValue(undefined),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
    };

    return {
      store,
      service: new VercelChatService(store as unknown as PodChatKitStore),
    };
  }

  function getFetchMock(): ReturnType<typeof vi.fn> {
    return fetchMock;
  }

  function mockAiGatewayModels(ids: string[]): void {
    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      data: ids.map((id) => ({ id, object: 'model' })),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  function spyAbortTimeout(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      return controller.signal;
    });
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

  it('uses DEFAULT_API_BASE as platform entry', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const { service } = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: solidAuth });

    expect(result.baseURL).toBe('https://ai-gateway.example.com/v1');
    expect(result.apiKey).toBe('gateway-service-key');
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
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const { service, store } = createService(undefined);
    mockAiGatewayModels(['linx', 'linx-lite']);
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

    const [modelsUrl, modelsInit] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(modelsUrl).toBe('https://ai-gateway.example.com/v1/models');
    expect(new Headers(modelsInit.headers).get('authorization')).toBe('Bearer gateway-service-key');

    const [url, init] = getFetchMock().mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://ai-gateway.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    });

    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer gateway-service-key');
  });

  it('keeps ai-gateway model queries on short timeout and generations on long timeout', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const abortTimeoutSpy = spyAbortTimeout();
    const { service } = createService(undefined);
    mockAiGatewayModels(['linx']);
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

    await service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    }, solidAuth as any);

    expect(abortTimeoutSpy).toHaveBeenNthCalledWith(1, 30_000);
    expect(abortTimeoutSpy).toHaveBeenNthCalledWith(2, 120_000);
  });

  it('allows separate env overrides for ai-gateway query and generation timeouts', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';
    process.env.DEFAULT_TIMEOUT_MS = '45000';
    process.env.DEFAULT_GENERATION_TIMEOUT_MS = '240000';

    const abortTimeoutSpy = spyAbortTimeout();
    const { service } = createService(undefined);
    mockAiGatewayModels(['linx']);
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

    await service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    }, solidAuth as any);

    expect(abortTimeoutSpy).toHaveBeenNthCalledWith(1, 45_000);
    expect(abortTimeoutSpy).toHaveBeenNthCalledWith(2, 240_000);
  });

  it('forwards OpenAI tool-call fields to ai-gateway chat completions', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const { service } = createService(undefined);
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"pwd"}',
        },
      },
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
          },
        },
      },
    ];

    mockAiGatewayModels(['linx-lite']);
    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-tool',
      object: 'chat.completion',
      created: 123,
      model: 'linx-lite',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.complete({
      model: 'linx-lite',
      stream: false,
      messages: [
        { role: 'user', content: 'List the current directory using the bash tool.' },
        { role: 'assistant', content: null, tool_calls: toolCalls },
        { role: 'tool', tool_call_id: 'call_1', content: '/tmp/project' },
      ],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    }, solidAuth as any);

    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.tool_calls).toEqual(toolCalls);

    const [url, init] = getFetchMock().mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://ai-gateway.example.com/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'linx-lite',
      stream: false,
      messages: [
        { role: 'user', content: 'List the current directory using the bash tool.' },
        { role: 'assistant', content: null, tool_calls: toolCalls },
        { role: 'tool', tool_call_id: 'call_1', content: '/tmp/project' },
      ],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
  });

  it('forwards OpenAI tool-call fields to direct provider chat completions', async () => {
    const { service, store } = createService({
      apiKey: 'pod-key',
      baseUrl: 'https://provider.example.com/v1',
      credentialId: 'cred-1',
    });
    const tools = [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
          },
        },
      },
    ];
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"pwd"}',
        },
      },
    ];

    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-provider-tool',
      object: 'chat.completion',
      created: 123,
      model: 'gpt-tool',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.complete({
      model: 'gpt-tool',
      stream: false,
      messages: [
        { role: 'user', content: 'List the current directory using the bash tool.' },
      ],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    }, solidAuth as any);

    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.tool_calls).toEqual(toolCalls);
    expect(store.recordCredentialSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ auth: solidAuth }),
      'cred-1',
    );

    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://provider.example.com/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer pod-key');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-tool',
      stream: false,
      messages: [
        { role: 'user', content: 'List the current directory using the bash tool.' },
      ],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
  });

  it('forwards platform chat streams to ai-gateway', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const { service } = createService(undefined);
    mockAiGatewayModels(['linx']);
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

    expect(getFetchMock().mock.calls).toHaveLength(2);
    expect(getFetchMock().mock.calls[0]?.[0]).toBe('https://ai-gateway.example.com/v1/models');
    expect(getFetchMock().mock.calls[1]?.[0]).toBe('https://ai-gateway.example.com/v1/chat/completions');
  });

  it('maps platform messages requests through ai-gateway chat completions', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const { service } = createService(undefined);
    mockAiGatewayModels(['linx']);
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

    const [, init] = getFetchMock().mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'linx',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 128,
    });
  });

  it('drops unsupported vector_store_ids only when forwarding platform responses requests', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const { service } = createService(undefined);
    mockAiGatewayModels(['linx-lite']);
    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'resp-gateway',
      object: 'response',
      status: 'completed',
      output: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await service.responses({
      model: 'linx-lite',
      input: 'hello',
      vector_store_ids: ['vs_123'],
    }, solidAuth as any);

    expect(getFetchMock().mock.calls[1]?.[0]).toBe('https://ai-gateway.example.com/v1/responses');
    const [, init] = getFetchMock().mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'linx-lite',
      input: 'hello',
    });
  });

  it('caches ai-gateway models between forwarded requests', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
    process.env.DEFAULT_API_KEY = 'gateway-service-key';

    const { service } = createService(undefined);
    mockAiGatewayModels(['linx']);
    getFetchMock()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-gateway-1',
        object: 'chat.completion',
        created: 123,
        model: 'linx',
        choices: [{ index: 0, message: { role: 'assistant', content: 'first' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-gateway-2',
        object: 'chat.completion',
        created: 124,
        model: 'linx',
        choices: [{ index: 0, message: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'first' }],
    }, solidAuth as any);

    await service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'second' }],
    }, solidAuth as any);

    expect(getFetchMock().mock.calls).toHaveLength(3);
    expect(getFetchMock().mock.calls[0]?.[0]).toBe('https://ai-gateway.example.com/v1/models');
    expect(getFetchMock().mock.calls[1]?.[0]).toBe('https://ai-gateway.example.com/v1/chat/completions');
    expect(getFetchMock().mock.calls[2]?.[0]).toBe('https://ai-gateway.example.com/v1/chat/completions');
  });

  it('reuses DEFAULT_API_BASE models without duplicate platform fetch', async () => {
    process.env.DEFAULT_API_BASE = 'https://ai-gateway.example.com/v1';
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
        id: 'chatcmpl-gateway',
        object: 'chat.completion',
        created: 123,
        model: 'linx',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const result = await service.listModels(solidAuth as any);

    expect(result.map((model) => model.id)).toEqual(['linx']);

    const [gatewayUrl, gatewayInit] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(gatewayUrl).toBe('https://ai-gateway.example.com/v1/models');
    expect(new Headers(gatewayInit.headers).get('authorization')).toBe('Bearer platform-key');
    expect(getFetchMock().mock.calls).toHaveLength(1);
  });

  it('merges current user models with platform models', async () => {
    process.env.DEFAULT_API_BASE = 'https://platform.example.com/v1';
    process.env.DEFAULT_API_KEY = 'platform-key';

    const { service, store } = createService({
      apiKey: 'pod-key',
      baseUrl: 'https://api.openai.com/v1',
      credentialId: 'cred-1',
    });

    store.listAvailableModels.mockResolvedValueOnce([
      {
        id: 'gpt-4o-mini',
        object: 'model',
        provider: 'openai',
        owned_by: 'OpenAI',
      },
    ]);

    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: 'linx', object: 'model', provider: 'undefineds', owned_by: 'Platform' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.listModels(solidAuth as any);

    expect(store.listAvailableModels).toHaveBeenCalledWith(expect.objectContaining({
      auth: solidAuth,
      userId: solidAuth.webId,
    }));
    expect(result.map((model) => model.id)).toEqual(['gpt-4o-mini', 'linx']);
  });

  it('deduplicates user models against platform models', async () => {
    process.env.DEFAULT_API_BASE = 'https://platform.example.com/v1';
    process.env.DEFAULT_API_KEY = 'platform-key';

    const { service, store } = createService({
      apiKey: 'pod-key',
      baseUrl: 'https://api.openai.com/v1',
      credentialId: 'cred-1',
    });

    store.listAvailableModels.mockResolvedValueOnce([
      {
        id: 'linx',
        object: 'model',
        provider: 'openai',
        owned_by: 'User Pod',
      },
    ]);

    getFetchMock().mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: 'linx', object: 'model', provider: 'undefineds', owned_by: 'Platform' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.listModels(solidAuth as any);

    expect(result.map((model) => model.id)).toEqual(['linx']);
  });
});
