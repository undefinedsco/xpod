import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore } from '../../src/api/ai-gateway/AiGatewayService';
import { registerAiGatewayRoutes } from '../../src/api/handlers/AiGatewayHandler';
import { ChatCompletionsFrontend } from '../../src/api/ai-gateway/protocol';
import { encodePlaintextCredential } from '../../src/api/ai-gateway/credentials/PlaintextCredentialPayload';
import { createDefaultProviderRegistry } from '../../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from '../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../src/api/ai-gateway/routing/ModelRouter';
import type { GatewayEvent } from '../../src/api/ai-gateway/types';
import type { AuthenticatedRequest } from '../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function request(path: string, body: unknown): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'POST';
  req.url = path;
  req.headers = { host: 'localhost' };
  req.auth = {
    type: 'solid',
    webId: WEB_ID,
    accountId: WEB_ID,
    scopes: ['models:read', 'inference:write'],
    viaGatewayApiKey: true,
  };
  req.end(JSON.stringify(body));
  return req;
}

function response(): any {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    setHeader(this: any, name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    write(this: any, chunk: unknown) {
      this.headersSent = true;
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(this: any, payload?: unknown) {
      if (payload !== undefined) {
        this.write(payload);
      }
      this.ended = true;
      this.writableEnded = true;
      this.body = this.chunks.join('');
    },
  });
}

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function parseSse(body: string | undefined, chunks: string[] = []): Array<Record<string, any> | '[DONE]'> {
  const text = body ?? chunks.join('');
  return text.trim().split('\n\n').map((block) => {
    const data = block.trim().slice('data:'.length).trim();
    return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
  });
}

function createFixture(options: {
  events?: GatewayEvent[];
  streamFactory?: (input: { signal: AbortSignal }) => AsyncIterable<GatewayEvent>;
} = {}): {
  routes: Record<string, Function>;
  runtimeExecute: any;
  store: GatewayCredentialStore;
} {
  const registry = createDefaultProviderRegistry();
  const defaultEvents = options.events ?? [
    { type: 'response.started', id: 'resp_stream' },
    { type: 'reasoning.delta', text: 'think' },
    { type: 'reasoning.signature', provider: 'openai', signature: 'sig_1' },
    { type: 'text.delta', text: 'hello' },
    { type: 'tool.started', callId: 'call_1', name: 'lookup' },
    { type: 'tool.arguments.delta', callId: 'call_1', delta: '{"q":"xpod"}' },
    { type: 'tool.completed', callId: 'call_1' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
    { type: 'response.completed', finishReason: 'tool_calls' },
  ] satisfies GatewayEvent[];
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async() => [{
      id: 'cred_openai',
      credentialIri: 'https://pod.example/settings/ai-connection.ttl#openai',
      provider: 'openai',
      authMode: 'apiKey' as const,
      enabled: true,
      models: ['gpt-5'],
      health: 'healthy' as const,
      quota: { status: 'available' as const },
      storageMode: 'plaintext-v1' as const,
      secretPayload: encodePlaintextCredential({ type: 'apiKey', apiKey: 'sk-runtime-only' }),
    }]),
    recordSuccess: vi.fn(async() => {}),
    recordFailure: vi.fn(async() => {}),
  };
  const runtimeExecute = vi.fn((input: { signal: AbortSignal }) => {
    if (options.streamFactory) {
      return options.streamFactory(input);
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of defaultEvents) {
          yield event;
        }
      },
    };
  });
  const service = new AiGatewayService({
    deployment: 'cloud',
    registry,
    router: new ModelRouter({
      registry,
      affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
      credentials: store.listCredentials,
    }),
    credentials: store,
    runtimes: {
      get: vi.fn(() => ({ execute: runtimeExecute })),
    } as unknown as ProviderRuntimeRegistry,
  });
  const { server, routes } = createServer();
  registerAiGatewayRoutes(server, { service });
  return { routes, runtimeExecute, store };
}

async function call(routes: Record<string, Function>, methodAndPath: string, req: AuthenticatedRequest, res = response()): Promise<any> {
  await routes[methodAndPath](req, res, {});
  return res;
}

describe('AI Connection streaming integration', () => {
  it('streams native Responses events in stable gateway order including reasoning, tool calls and usage', async() => {
    const { routes } = createFixture();

    const res = await call(routes, 'POST /v1/responses', request('/v1/responses', {
      model: 'gpt-5',
      stream: true,
      input: 'hi',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    }));

    const events = parseSse(res.body);
    expect(events.map((event) => event === '[DONE]' ? '[DONE]' : event.type)).toEqual([
      'response.created',
      'response.reasoning_summary_text.delta',
      'response.reasoning_signature.delta',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.usage',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      '[DONE]',
    ]);
    expect(events[7]).toMatchObject({
      item_id: 'fc_call_1',
      output_index: 1,
      delta: '{"q":"xpod"}',
    });
    expect(events[8]).toMatchObject({
      item_id: 'fc_call_1',
      output_index: 1,
      arguments: '{"q":"xpod"}',
    });
    expect(events[10]).toMatchObject({ usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } });
  });

  it('streams converted Messages and Chat Completions protocol shapes without reordering tool events', async() => {
    const { routes } = createFixture();

    const messages = await call(routes, 'POST /v1/messages', request('/v1/messages', {
      model: 'gpt-5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    }));
    const chat = await call(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    }));

    expect(parseSse(messages.body, messages.chunks).map((event) => event === '[DONE]' ? '[DONE]' : event.type)).toEqual([
      'message_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
      '[DONE]',
    ]);
    expect(parseSse(chat.body, chat.chunks)[4]).toMatchObject({
      choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'lookup' } }] } }],
    });
    expect(parseSse(chat.body, chat.chunks)[5]).toMatchObject({
      choices: [{ delta: { tool_calls: [{ function: { arguments: '{"q":"xpod"}' } }] } }],
    });
  });

  it('returns HTTP JSON instead of SSE when a streaming request fails before the first event', async() => {
    const { server, routes } = createServer();
    const service = {
      execute: vi.fn(async() => ({
        frontend: new ChatCompletionsFrontend(),
        events: {
          async *[Symbol.asyncIterator]() {
            throw Object.assign(new Error('credential unavailable'), { status: 403 });
          },
        },
      })),
      complete: vi.fn(),
      listModels: vi.fn(),
    };
    registerAiGatewayRoutes(server, { service: service as any });

    const res = await call(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'provider_error' } });
  });

  it('emits a terminal SSE error after the first event without replaying on another credential', async() => {
    const { routes, runtimeExecute, store } = createFixture({
      streamFactory: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'response.started', id: 'resp_partial' } satisfies GatewayEvent;
          throw Object.assign(new Error('upstream reset'), { status: 502 });
        },
      }),
    });

    const res = await call(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const events = parseSse(res.body);
    expect(events[0]).toMatchObject({ id: 'resp_partial' });
    expect(events[1]).toMatchObject({ error: { code: 'internal_error', status: 502 } });
    expect(events.at(-1)).toBe('[DONE]');
    expect(runtimeExecute).toHaveBeenCalledTimes(1);
    expect(store.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('aborts upstream without writing a synthetic completion when a streaming client disconnects', async() => {
    let upstreamAborted = false;
    const { routes } = createFixture({
      streamFactory: ({ signal }) => {
        signal.addEventListener('abort', () => {
          upstreamAborted = true;
        }, { once: true });
        return {
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              async next() {
                if (index++ === 0) {
                  return { done: false, value: { type: 'response.started', id: 'resp_cancel' } as GatewayEvent };
                }
                return await new Promise<IteratorResult<GatewayEvent>>((resolve) => {
                  const onAbort = (): void => resolve({ done: true, value: undefined });
                  signal.addEventListener('abort', onAbort, { once: true });
                });
              },
              async return() {
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    });
    const res = response();
    const pending = routes['POST /v1/chat/completions'](request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }), res, {});

    await eventually(() => expect(res.chunks).toHaveLength(1));
    res.destroyed = true;
    res.emit('close');
    await pending;

    expect(upstreamAborted).toBe(true);
    expect(res.ended).toBe(false);
    expect(res.chunks.join('')).not.toContain('[DONE]');
    expect(res.listenerCount('close')).toBe(0);
  });
});
