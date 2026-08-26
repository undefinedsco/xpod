import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import { VercelChatService } from '../../src/api/service/VercelChatService';

describe('VercelChatService platform and Pod boundary', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const auth = {
    type: 'solid' as const,
    webId: 'https://pod.example/alice/profile/card#me',
    accountId: 'account-alice',
    accessToken: 'alice-token',
    tokenType: 'DPoP' as const,
    dpopProof: 'browser-proof',
  };
  let fetchMock: ReturnType<typeof vi.fn>;
  const sensitiveGatewayFields = {
    webId: 'https://pod.example/alice/profile/card#me',
    podUrl: 'https://pod.example/alice/',
    storageUrl: 'https://pod.example/alice/storage/',
    accessToken: 'leaked-access-token',
    dpopProof: 'leaked-dpop-proof',
    clientId: 'leaked-client-id',
    clientSecret: 'leaked-client-secret',
    apiKey: 'leaked-api-key',
    auth: { accessToken: 'nested-auth-token' },
    credentials: { clientSecret: 'nested-client-secret' },
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEFAULT_API_BASE;
    delete process.env.DEFAULT_API_KEY;
    delete process.env.DEFAULT_MODEL;
    delete process.env.DEFAULT_PROVIDER;
    delete process.env.DEFAULT_TIMEOUT_MS;
    delete process.env.DEFAULT_GENERATION_TIMEOUT_MS;
    delete process.env.XPOD_EDITION;
    fetchMock = vi.fn();
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  function createService(input: {
    aiConfig?: {
      providerId?: string;
      apiKey: string;
      baseUrl: string;
      proxyUrl?: string;
      credentialId?: string;
    };
    userModels?: Array<Record<string, unknown>>;
  } = {}) {
    const store = {
      getAiConfig: vi.fn().mockResolvedValue(input.aiConfig),
      listAvailableModels: vi.fn().mockResolvedValue(input.userModels ?? []),
      recordCredentialSuccess: vi.fn().mockResolvedValue(undefined),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
    };
    return {
      service: new VercelChatService(store as unknown as PodChatKitStore),
      store,
    };
  }

  function lastGatewayBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return JSON.parse(String(init.body));
  }

  function expectNoSensitiveGatewayFields(body: Record<string, unknown>): void {
    for (const key of Object.keys(sensitiveGatewayFields)) {
      expect(body).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('leaked-access-token');
    expect(serialized).not.toContain('leaked-dpop-proof');
    expect(serialized).not.toContain('leaked-client-id');
    expect(serialized).not.toContain('leaked-client-secret');
    expect(serialized).not.toContain('leaked-api-key');
    expect(serialized).not.toContain('nested-auth-token');
    expect(serialized).not.toContain('nested-client-secret');
  }

  it('routes shared platform models with the server key without reading the Pod', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-platform',
      object: 'chat.completion',
      created: 1,
      model: 'linx-lite',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'platform ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { service, store } = createService({
      aiConfig: {
        apiKey: 'pod-key-that-must-not-be-read',
        baseUrl: 'https://user-provider.example/v1',
      },
    });

    const result = await service.complete({
      model: 'linx-lite',
      messages: [{ role: 'user', content: 'hello' }],
    }, auth);

    expect(result.choices[0]?.message.content).toBe('platform ok');
    expect(store.getAiConfig).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ai-gateway.internal/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-only-key');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'linx-lite',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(String(init.body)).not.toContain(auth.webId);
    expect(String(init.body)).not.toContain(auth.accessToken);
    expect(String(init.body)).not.toContain(auth.dpopProof);
  });

  it('projects chat completion JSON requests before forwarding to the shared gateway', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-platform-projected',
      object: 'chat.completion',
      created: 1,
      model: 'linx-lite',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'projected json ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { service } = createService();

    await service.complete({
      model: 'linx-lite',
      messages: [{
        role: 'user',
        content: 'hello',
        accessToken: 'message-level-extra-token',
      }, {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_weather',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: {
              city: 'Guangzhou',
              metadata: { accessToken: 'tool-call-token' },
              credentials: { apiKey: 'tool-call-api-key' },
            },
            apiKey: 'tool-call-function-key',
          },
          auth: { dpopProof: 'tool-call-proof' },
        }],
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              apiKey: { type: 'string' },
            },
            metadata: { webId: 'tool-schema-webid' },
          },
          credentials: { clientSecret: 'tool-schema-client-secret' },
        },
        vector_store_ids: ['tool_vs_must_not_forward'],
        auth: { accessToken: 'tool-definition-token' },
      }],
      temperature: 0.2,
      metadata: { secret: 'metadata-secret' },
      ...sensitiveGatewayFields,
    } as any, auth);

    const body = lastGatewayBody();
    expect(body).toEqual({
      model: 'linx-lite',
      messages: [{
        role: 'user',
        content: 'hello',
      }, {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_weather',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: {
              city: 'Guangzhou',
            },
          },
        }],
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
          },
        },
      }],
      temperature: 0.2,
    });
    expectNoSensitiveGatewayFields(body);
    expect(JSON.stringify(body)).not.toContain('metadata-secret');
    expect(JSON.stringify(body)).not.toContain('message-level-extra-token');
    expect(JSON.stringify(body)).not.toContain('tool-call-token');
    expect(JSON.stringify(body)).not.toContain('tool-call-api-key');
    expect(JSON.stringify(body)).not.toContain('tool-call-function-key');
    expect(JSON.stringify(body)).not.toContain('tool-call-proof');
    expect(JSON.stringify(body)).not.toContain('tool-schema-webid');
    expect(JSON.stringify(body)).not.toContain('tool-schema-client-secret');
    expect(JSON.stringify(body)).not.toContain('tool_vs_must_not_forward');
    expect(JSON.stringify(body)).not.toContain('tool-definition-token');
  });

  it('projects chat completion stream requests before forwarding to the shared gateway', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const { service } = createService();

    await service.stream({
      model: 'linx-lite',
      messages: [{ role: 'user', content: 'hello stream' }],
      stream: true,
      metadata: { secret: 'metadata-stream-secret' },
      ...sensitiveGatewayFields,
    } as any, auth);

    const body = lastGatewayBody();
    expect(body).toEqual({
      model: 'linx-lite',
      messages: [{ role: 'user', content: 'hello stream' }],
      stream: true,
    });
    expectNoSensitiveGatewayFields(body);
    expect(JSON.stringify(body)).not.toContain('metadata-stream-secret');
  });

  it('projects responses requests before forwarding to the shared gateway', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'resp_platform_projected',
      object: 'response',
      created: 1,
      status: 'completed',
      model: 'linx-lite',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'projected responses ok' }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { service } = createService();

    await service.responses({
      model: 'linx-lite',
      input: 'hello responses',
      instructions: 'be brief',
      max_output_tokens: 64,
      metadata: { secret: 'metadata-response-secret' },
      vector_store_ids: ['vs_must_not_forward'],
      ...sensitiveGatewayFields,
    }, auth);

    const body = lastGatewayBody();
    expect(body).toEqual({
      model: 'linx-lite',
      input: 'hello responses',
      instructions: 'be brief',
      max_output_tokens: 64,
    });
    expectNoSensitiveGatewayFields(body);
    expect(JSON.stringify(body)).not.toContain('metadata-response-secret');
    expect(JSON.stringify(body)).not.toContain('vs_must_not_forward');
  });

  it('keeps the platform configuration after the runtime environment is restored', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    process.env.DEFAULT_TIMEOUT_MS = '1234';
    process.env.DEFAULT_GENERATION_TIMEOUT_MS = '5678';
    const { service } = createService();

    delete process.env.DEFAULT_API_BASE;
    delete process.env.DEFAULT_API_KEY;
    delete process.env.DEFAULT_TIMEOUT_MS;
    delete process.env.DEFAULT_GENERATION_TIMEOUT_MS;

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-platform-after-restore',
      object: 'chat.completion',
      created: 1,
      model: 'linx-lite',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'platform config retained' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await service.complete({
      model: 'linx-lite',
      messages: [{ role: 'user', content: 'hello after restore' }],
    }, auth);

    expect(result.choices[0]?.message.content).toBe('platform config retained');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ai-gateway.internal/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-only-key');
  });

  it('fails user provider access closed for a browser DPoP caller without reading the Pod', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    const { service, store } = createService({
      aiConfig: {
        apiKey: 'user-pod-key',
        baseUrl: 'https://user-provider.example/v1',
      },
    });

    await expect(service.complete({
      model: 'user-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, auth)).rejects.toMatchObject({ code: 'model_not_configured' });

    expect(store.getAiConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a user provider through client-credentials backed xpod API context', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-user-provider',
      object: 'chat.completion',
      created: 1,
      model: 'user-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'user provider ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { service, store } = createService({
      aiConfig: {
        apiKey: 'user-pod-key',
        baseUrl: 'https://user-provider.example/v1',
        credentialId: 'credential-1',
      },
    });
    const clientCredentialsAuth = {
      ...auth,
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      viaApiKey: true as const,
      oidcIssuer: 'https://pod.example/',
    };

    const result = await service.complete({
      model: 'user-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, clientCredentialsAuth);

    expect(result.choices[0]?.message.content).toBe('user provider ok');
    expect(store.getAiConfig).toHaveBeenCalledWith(expect.objectContaining({
      userId: clientCredentialsAuth.webId,
      auth: clientCredentialsAuth,
    }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://user-provider.example/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer user-pod-key');
    expect(String(init.body)).not.toContain(clientCredentialsAuth.clientSecret);
    expect(String(init.body)).not.toContain(clientCredentialsAuth.accessToken);
  });

  it('does not inspect arbitrary Pod-supplied provider endpoints or proxies in cloud edition', async () => {
    process.env.XPOD_EDITION = 'cloud';
    const { service, store } = createService({
      aiConfig: {
        providerId: 'openai',
        apiKey: 'user-pod-key',
        baseUrl: 'http://169.254.169.254/latest',
        proxyUrl: 'http://127.0.0.1:7890',
      },
    });

    await expect(service.complete({
      model: 'user-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, auth)).rejects.toMatchObject({ code: 'model_not_configured' });

    expect(store.getAiConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe Pod-supplied provider endpoints for client-credentials callers in cloud edition', async () => {
    process.env.XPOD_EDITION = 'cloud';
    const { service, store } = createService({
      aiConfig: {
        providerId: 'openai',
        apiKey: 'user-pod-key',
        baseUrl: 'http://169.254.169.254/latest',
        proxyUrl: 'http://127.0.0.1:7890',
      },
    });
    const clientCredentialsAuth = {
      ...auth,
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      viaApiKey: true as const,
      oidcIssuer: 'https://pod.example/',
    };

    await expect(service.complete({
      model: 'user-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, clientCredentialsAuth)).rejects.toThrow('provider_base_url_not_allowed');

    expect(store.getAiConfig).toHaveBeenCalledWith(expect.objectContaining({
      userId: clientCredentialsAuth.webId,
      auth: clientCredentialsAuth,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('merges caller-owned Pod models for client-credentials callers while platform models win', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'linx-lite', object: 'model', owned_by: 'undefineds' },
        { id: 'linx', object: 'model', owned_by: 'undefineds' },
        { id: 'gateway-internal-model', object: 'model', owned_by: 'internal' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { service, store } = createService({
      userModels: [
        { id: 'user-model', object: 'model', owned_by: 'openai' },
        { id: 'linx-lite', object: 'model', owned_by: 'stale-pod-row' },
      ],
    });

    const clientCredentialsAuth = {
      ...auth,
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      viaApiKey: true as const,
      oidcIssuer: 'https://pod.example/',
    };

    const models = await service.listModels(clientCredentialsAuth);

    expect(store.listAvailableModels).toHaveBeenCalledWith(expect.objectContaining({
      userId: clientCredentialsAuth.webId,
      auth: clientCredentialsAuth,
    }));
    expect(models.map((model) => model.id)).toEqual(['linx-lite', 'linx', 'user-model']);
    expect(models.find((model) => model.id === 'linx-lite')?.owned_by).toBe('undefineds');
    expect(models.some((model) => model.id === 'gateway-internal-model')).toBe(false);
  });

  it('keeps platform models visible when caller-owned Pod model merge fails', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'linx-lite', object: 'model', owned_by: 'undefineds' },
        { id: 'linx', object: 'model', owned_by: 'undefineds' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { service, store } = createService();
    store.listAvailableModels.mockRejectedValueOnce(new Error('pod unavailable'));
    const clientCredentialsAuth = {
      ...auth,
      clientId: 'solid-client-id',
      clientSecret: 'solid-client-secret',
      viaApiKey: true as const,
      oidcIssuer: 'https://pod.example/',
    };

    const models = await service.listModels(clientCredentialsAuth);

    expect(models.map((model) => model.id)).toEqual(['linx-lite', 'linx']);
    expect(store.listAvailableModels).toHaveBeenCalledWith(expect.objectContaining({
      userId: clientCredentialsAuth.webId,
      auth: clientCredentialsAuth,
    }));
  });

  it('lists shared cloud models for browser callers without Pod access or gateway identity metadata', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'linx-lite', object: 'model', owned_by: 'undefineds' },
        { id: 'linx', object: 'model', owned_by: 'undefineds' },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const { service, store } = createService({
      userModels: [
        { id: 'user-model', object: 'model', owned_by: 'openai' },
      ],
    });

    const models = await service.listModels(auth);

    expect(store.listAvailableModels).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toEqual(['linx-lite', 'linx']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ai-gateway.internal/v1/models');
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer server-only-key');
    const headerValueList: string[] = [];
    headers.forEach((value) => headerValueList.push(value));
    const headerValues = headerValueList.join('\n');
    expect(headerValues).not.toContain(auth.webId);
    expect(headerValues).not.toContain(auth.accessToken);
    expect(headerValues).not.toContain(auth.dpopProof);
  });

  it('keeps the shared cloud catalog visible when the execution backend model query is unavailable', async () => {
    process.env.DEFAULT_API_BASE = 'http://ai-gateway.internal/v1';
    process.env.DEFAULT_API_KEY = 'server-only-key';
    fetchMock.mockRejectedValueOnce(new Error('backend unavailable'));
    const { service, store } = createService();

    const models = await service.listModels(auth);

    expect(models.map((model) => model.id)).toEqual(['linx-lite', 'linx']);
    expect(models.every((model) => model.owned_by === 'undefineds')).toBe(true);
    expect(store.listAvailableModels).not.toHaveBeenCalled();
  });
});
