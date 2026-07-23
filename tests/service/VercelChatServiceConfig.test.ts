import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { VercelChatService } from '../../src/api/service/VercelChatService';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import type { GatewayExecutionInput } from '../../src/api/ai-gateway/AiGatewayService';
import type { GatewayEvent, GatewayProtocolFrontend } from '../../src/api/ai-gateway/types';

class FakeFrontend implements GatewayProtocolFrontend {
  public readonly protocol = 'chatCompletions' as const;
  public parseRequest(): never {
    throw new Error('not used');
  }
  public createEventSerializer() {
    return {
      serializeEvent(event: GatewayEvent) {
        switch (event.type) {
          case 'response.started':
            return { id: event.id, choices: [{ delta: { role: 'assistant' } }] };
          case 'text.delta':
            return { choices: [{ delta: { content: event.text } }] };
          case 'response.completed':
            return { choices: [{ delta: {}, finish_reason: event.finishReason }] };
          default:
            return event;
        }
      },
    };
  }
}

describe('VercelChatService AI Connection gateway adapter', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'DEFAULT_API_BASE',
    'DEFAULT_API_KEY',
    'DEFAULT_GENERATION_TIMEOUT_MS',
    'DEFAULT_TIMEOUT_MS',
    'DEFAULT_PROVIDER',
    'DEFAULT_MODEL',
    'OPENAI_API_KEY',
  ] as const;

  const solidAuth = {
    type: 'solid' as const,
    webId: 'http://localhost:3310/test/profile/card#me',
    accountId: 'account-1',
    accessToken: 'solid-access-token',
    tokenType: 'Bearer' as const,
    scopes: ['inference:write', 'models:read'],
  };

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  function createService() {
    const store = {
      getAiConfig: vi.fn().mockResolvedValue({
        apiKey: 'legacy-pod-key-that-must-not-be-read',
        baseUrl: 'https://legacy-provider.example/v1',
      }),
      listAvailableModels: vi.fn().mockResolvedValue([{ id: 'legacy-pod-model' }]),
      recordCredentialSuccess: vi.fn().mockResolvedValue(undefined),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = {
      complete: vi.fn(async(input: GatewayExecutionInput) => ({
        id: 'chatcmpl-gateway',
        object: 'chat.completion',
        created: 123,
        model: (input.body as any).model,
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
      })),
      execute: vi.fn(async(input: GatewayExecutionInput) => ({
        protocol: input.protocol,
        frontend: new FakeFrontend(),
        request: { model: (input.body as any).model },
        route: {},
        events: (async function*(): AsyncIterable<GatewayEvent> {
          yield { type: 'response.started', id: 'chatcmpl-stream' };
          yield { type: 'text.delta', text: 'stream ok' };
          yield { type: 'response.completed', finishReason: 'stop' };
        })(),
      })),
      listModels: vi.fn(async() => [
        { id: 'linx', object: 'model', owned_by: 'openai' },
      ]),
    };
    const usageRepo = {
      incrementTokenUsage: vi.fn().mockResolvedValue(undefined),
    };
    const quotaService = {
      getAccountQuota: vi.fn().mockResolvedValue({ tokenLimitMonthly: 1000 }),
    };
    const service = new VercelChatService(store as unknown as PodChatKitStore, {
      aiGatewayService: gateway as any,
    });
    service.setUsageTracking(usageRepo as any, quotaService as any);
    return { service, store, gateway, usageRepo, quotaService };
  }

  async function waitUntil(assertion: () => void): Promise<void> {
    const deadline = Date.now() + 1_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(String(lastError));
  }

  it('routes chat completions through AiGatewayService and records returned usage', async () => {
    process.env.DEFAULT_API_BASE = 'https://legacy-env-provider.example/v1';
    process.env.DEFAULT_API_KEY = 'legacy-env-key';
    process.env.OPENAI_API_KEY = 'legacy-openai-env-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service, store, gateway, usageRepo, quotaService } = createService();

    const result = await service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ type: 'function', function: { name: 'bash' } }],
    }, solidAuth as any);

    expect(result.choices[0].message.content).toBe('gateway ok');
    expect(gateway.complete).toHaveBeenCalledWith(expect.objectContaining({
      auth: solidAuth,
      protocol: 'chatCompletions',
      body: {
        model: 'linx',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{ type: 'function', function: { name: 'bash' } }],
      },
    }));
    expect(quotaService.getAccountQuota).toHaveBeenCalledWith('account-1');
    await waitUntil(() => {
      expect(usageRepo.incrementTokenUsage).toHaveBeenCalledWith(
        'account-1',
        'http://localhost:3310/test/profile/card#me',
        12,
      );
    });
    expect(store.getAiConfig).not.toHaveBeenCalled();
    expect(store.listAvailableModels).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes Responses and Messages protocols directly through AiGatewayService without legacy converters', async () => {
    const { service, gateway } = createService();

    await service.responses({
      model: 'linx-responses',
      input: 'hello',
      vector_store_ids: ['must-remain-for-frontend'],
    }, solidAuth as any);
    await service.messages({
      model: 'linx-anthropic',
      system: 'Be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }, solidAuth as any);

    expect(gateway.complete).toHaveBeenNthCalledWith(1, expect.objectContaining({
      protocol: 'responses',
      body: {
        model: 'linx-responses',
        input: 'hello',
        vector_store_ids: ['must-remain-for-frontend'],
      },
    }));
    expect(gateway.complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
      protocol: 'anthropic',
      body: {
        model: 'linx-anthropic',
        system: 'Be brief',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      },
    }));
  });

  it('streams through AiGatewayService event serializers', async () => {
    const { service, gateway } = createService();

    const result = await service.stream({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }, solidAuth as any);

    const response = result.toTextStreamResponse();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('stream ok');
    expect(gateway.execute).toHaveBeenCalledWith(expect.objectContaining({
      auth: solidAuth,
      protocol: 'chatCompletions',
      body: {
        model: 'linx',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
      },
    }));
  });

  it('defers stream execution until response start and aborts gateway iteration on cancel', async () => {
    const { service, gateway } = createService();
    let observedSignal: AbortSignal | undefined;
    const iteratorReturn = vi.fn(async() => ({ done: true, value: undefined }));
    const iterator = {
      next: vi.fn(async() => new Promise<IteratorResult<GatewayEvent>>(() => undefined)),
      return: iteratorReturn,
    };
    gateway.execute.mockImplementationOnce(async(input: GatewayExecutionInput) => {
      observedSignal = input.signal;
      return {
        protocol: input.protocol,
        frontend: new FakeFrontend(),
        request: { model: 'linx' } as any,
        route: {} as any,
        events: {
          [Symbol.asyncIterator]: () => iterator,
        },
      };
    });

    const result = await service.stream({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }, solidAuth as any);

    expect(gateway.execute).not.toHaveBeenCalled();

    const response = result.toTextStreamResponse();
    expect(response.body).not.toBeNull();
    await waitUntil(() => expect(gateway.execute).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal),
    })));

    await response.body!.cancel();

    expect(observedSignal?.aborted).toBe(true);
    expect(iteratorReturn).toHaveBeenCalled();
  });

  it('lists only AiGatewayService models', async () => {
    const { service, store, gateway } = createService();

    const models = await service.listModels(solidAuth as any);

    expect(models).toEqual([{ id: 'linx', object: 'model', owned_by: 'openai' }]);
    expect(gateway.listModels).toHaveBeenCalledWith(solidAuth);
    expect(store.listAvailableModels).not.toHaveBeenCalled();
  });

  it('requires AiGatewayService instead of falling back to Pod or platform provider config', async () => {
    const store = {
      getAiConfig: vi.fn().mockResolvedValue({ apiKey: 'pod-key' }),
      listAvailableModels: vi.fn().mockResolvedValue([]),
    };
    const service = new VercelChatService(store as unknown as PodChatKitStore);

    await expect(service.complete({
      model: 'linx',
      messages: [{ role: 'user', content: 'ping' }],
    }, solidAuth as any)).rejects.toThrow('AiGatewayService is required');
    expect(store.getAiConfig).not.toHaveBeenCalled();
  });
});
