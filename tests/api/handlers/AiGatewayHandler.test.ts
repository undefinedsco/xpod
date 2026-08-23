import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore } from '../../../src/api/ai-gateway/AiGatewayService';
import { registerAiGatewayRoutes } from '../../../src/api/handlers/AiGatewayHandler';
import { ChatCompletionsFrontend } from '../../../src/api/ai-gateway/protocol';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import type { CredentialVault, StoredCredentialSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import type { GatewayEvent } from '../../../src/api/ai-gateway/types';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError;
}

function storedSecret(provider: string): StoredCredentialSecret {
  return {
    webId: WEB_ID,
    credentialIri: `https://pod.example/settings/credentials.ttl#${provider}`,
    provider,
    secret: { apiKey: `sk-${provider}` },
  };
}

function request(path: string, body?: unknown, auth: AuthenticatedRequest['auth'] = {
  type: 'solid',
  webId: WEB_ID,
  scopes: ['models:read', 'inference:write'],
}, headers: Record<string, string> = {}): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = body === undefined ? 'GET' : 'POST';
  req.url = path;
  req.headers = { host: 'localhost', ...headers };
  req.auth = auth;
  if (body !== undefined) {
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

type TestResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  chunks: string[];
  ended: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  writeCount: number;
  body?: string;
  setHeader(name: string, value: string): void;
  write(chunk: unknown): boolean;
  end(payload?: unknown): void;
};

function response(options: { backpressureOnWrite?: number } = {}): TestResponse {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    writableEnded: false,
    destroyed: false,
    writeCount: 0,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    write(chunk: unknown) {
      this.writeCount += 1;
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return this.writeCount !== options.backpressureOnWrite;
    },
    end(payload?: unknown) {
      if (payload !== undefined) {
        this.write(payload);
      }
      this.ended = true;
      this.writableEnded = true;
      this.body = this.chunks.join('');
    },
  }) as TestResponse;
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

function delayedEventStream(events: GatewayEvent[], onAbort?: () => void): AsyncIterable<GatewayEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield event;
      }
    },
  };
}

function createFixture(options: {
  events?: GatewayEvent[];
  otherWebIdCredential?: boolean;
  firstProviderFails?: boolean;
  failAfterFirstEvent?: boolean;
  includeDeepSeek?: boolean;
  onAbort?: () => void;
  acceptanceEndpointsEnabled?: boolean;
} = {}) {
  const registry = createDefaultProviderRegistry();
  const events = options.events ?? [
    { type: 'response.started', id: 'resp_1' },
    { type: 'text.delta', text: 'hel' },
    { type: 'text.delta', text: 'lo' },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    { type: 'response.completed', finishReason: 'stop' },
  ] satisfies GatewayEvent[];
  const credentials = [
    {
      id: 'cred_openai',
      credentialIri: 'https://pod.example/settings/credentials.ttl#openai',
      provider: 'openai',
      authMode: 'apiKey' as const,
      enabled: true,
      models: ['gpt-5'],
      health: 'healthy' as const,
      quota: { status: 'available' as const },
      credentialSecret: storedSecret('openai'),
      runtimeCredential: { baseUrl: 'https://api.openai.com/v1' },
    },
    ...(options.firstProviderFails ? [{
      id: 'cred_openai_backup',
      credentialIri: 'https://pod.example/settings/credentials.ttl#openai_backup',
      provider: 'openai',
      authMode: 'apiKey' as const,
      enabled: true,
      priority: 200,
      models: ['gpt-5'],
      health: 'healthy' as const,
      quota: { status: 'available' as const },
      credentialSecret: storedSecret('openai'),
      runtimeCredential: { baseUrl: 'https://api.openai.com/v1' },
    }] : []),
    ...(options.includeDeepSeek ? [{
      id: 'cred_deepseek',
      credentialIri: 'https://pod.example/settings/credentials.ttl#deepseek',
      provider: 'deepseek',
      authMode: 'apiKey' as const,
      enabled: true,
      models: ['deepseek-chat'],
      health: 'healthy' as const,
      quota: { status: 'available' as const },
      credentialSecret: storedSecret('deepseek'),
    }] : []),
  ];
  const otherCredentials = options.otherWebIdCredential ? [{
    id: 'cred_other',
    credentialIri: 'https://pod.example/bob/settings/credentials.ttl#openai',
    provider: 'openai',
    authMode: 'apiKey' as const,
    enabled: true,
    models: ['gpt-5'],
    health: 'healthy' as const,
    quota: { status: 'available' as const },
    credentialSecret: storedSecret('openai'),
  }] : [];
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async({ webId }) => webId === WEB_ID ? credentials : otherCredentials),
    recordSuccess: vi.fn(async() => {}),
    recordFailure: vi.fn(async() => {}),
  };
  const vault: CredentialVault = {
    seal: vi.fn(),
    open: vi.fn(async(_principal, credentialIri) => ({
      apiKey: credentialIri.includes('backup') ? 'sk-backup' : 'sk-primary',
    })),
  };
  const runtime = {
    provider: 'openai',
    execute: vi.fn((input: any) => {
      if (input.signal) {
        input.signal.addEventListener('abort', () => options.onAbort?.(), { once: true });
      }
      if (options.firstProviderFails && input.apiKey === 'sk-primary') {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      if (options.failAfterFirstEvent) {
        return delayedEventStream([
          { type: 'response.started', id: 'resp_1' },
          { type: 'text.delta', text: 'partial' },
        ], options.onAbort);
      }
      return delayedEventStream(events, options.onAbort);
    }),
  };
  if (options.failAfterFirstEvent) {
    runtime.execute = vi.fn((input: any): AsyncIterable<GatewayEvent> => ({
      async *[Symbol.asyncIterator]() {
        if (input.signal) {
          input.signal.addEventListener('abort', () => options.onAbort?.(), { once: true });
        }
        yield { type: 'response.started', id: 'resp_1' } satisfies GatewayEvent;
        throw Object.assign(new Error('upstream reset'), { status: 502 });
      },
    }));
  }
  const runtimes = {
    get: vi.fn(() => runtime),
  } as unknown as ProviderRuntimeRegistry;
  const service = new AiGatewayService({
    deployment: 'local',
    registry,
    router: new ModelRouter({
      registry,
      affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
      credentials: store.listCredentials,
    }),
    credentials: store,
    vault,
    runtimes,
  });
  const { server, routes } = createServer();
  registerAiGatewayRoutes(server, {
    service,
    acceptanceEndpointsEnabled: options.acceptanceEndpointsEnabled,
  });
  return { routes, service, store, vault, runtime, runtimes };
}

async function callRoute(routes: Record<string, Function>, methodAndPath: string, req: AuthenticatedRequest): Promise<any> {
  const res = response();
  await routes[methodAndPath](req, res, {});
  return res;
}

describe('AiGatewayHandler', () => {
  it('aggregates non-streaming chat completions without exposing provider secrets to the handler', async () => {
    const { routes, vault, runtime } = createFixture({
      events: [
        { type: 'response.started', id: 'chatcmpl_1' },
        { type: 'text.delta', text: 'hi' },
        { type: 'tool.started', callId: 'call_1', name: 'lookup' },
        { type: 'tool.arguments.delta', callId: 'call_1', delta: '{"q":"xpod"}' },
        { type: 'tool.completed', callId: 'call_1' },
        { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } },
        { type: 'response.completed', finishReason: 'tool_calls' },
      ],
    });

    const res = await callRoute(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      model: 'gpt-5',
      choices: [{
        message: {
          role: 'assistant',
          content: 'hi',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"xpod"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    });
    expect(vault.open).toHaveBeenCalledOnce();
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-primary' }));
    expect(JSON.stringify(res.body)).not.toContain('sk-primary');
  });

  it('streams each protocol as SSE with per-response serializer and DONE terminator', async () => {
    const { routes } = createFixture();

    const responses = await callRoute(routes, 'POST /v1/responses', request('/v1/responses', {
      model: 'gpt-5',
      stream: true,
      input: 'hi',
    }));
    const messages = await callRoute(routes, 'POST /v1/messages', request('/v1/messages', {
      model: 'gpt-5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }));
    const chat = await callRoute(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(responses.headers['content-type']).toContain('text/event-stream');
    expect(responses.body).toContain('data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_0","type":"message","role":"assistant","content":[]}}');
    expect(responses.body).toContain('data: {"type":"response.output_text.delta","item_id":"msg_0","output_index":0,"content_index":0,"delta":"hel"}');
    expect(responses.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(messages.body).toContain('"type":"message_start"');
    expect(messages.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(chat.body).toContain('"choices":[{"index":0,"delta":{"content":"hel"}}]');
    expect(chat.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('waits for response drain before pulling the next upstream event', async () => {
    const { routes } = createFixture();
    const req = request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = response({ backpressureOnWrite: 1 });
    let settled = false;
    const pending = routes['POST /v1/chat/completions'](req, res, {}).then(() => {
      settled = true;
    });

    await eventually(() => expect(res.writeCount).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(res.writeCount).toBe(1);

    res.emit('drain');
    await pending;
    expect(res.ended).toBe(true);
    expect(res.body!.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('aborts upstream and returns its iterator when the response closes', async () => {
    const { server, routes } = createServer();
    let upstreamAborted = false;
    let iteratorReturned = false;
    const nextGate = deferred<void>();
    const service = {
      execute: vi.fn(),
      complete: vi.fn(),
      listModels: vi.fn(),
    };
    service.execute.mockImplementation(async({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener('abort', () => {
        upstreamAborted = true;
      }, { once: true });
      return {
        frontend: new ChatCompletionsFrontend(),
        events: {
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              async next() {
                if (index++ === 0) {
                  return { done: false, value: { type: 'response.started', id: 'resp_1' } as GatewayEvent };
                }
                await nextGate.promise;
                return { done: true, value: undefined };
              },
              async return() {
                iteratorReturned = true;
                nextGate.resolve();
                return { done: true, value: undefined };
              },
            };
          },
        },
      };
    });
    registerAiGatewayRoutes(server, { service: service as any });
    const req = request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = response();
    const pending = routes['POST /v1/chat/completions'](req, res, {});

    await eventually(() => expect(res.writeCount).toBe(1));
    res.emit('close');
    await pending;

    expect(upstreamAborted).toBe(true);
    expect(iteratorReturned).toBe(true);
    expect(res.ended).toBe(false);
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('drain')).toBe(0);
  });

  it('returns normalized HTTP JSON without SSE headers when streaming fails before the first event', async () => {
    const { server, routes } = createServer();
    const service = {
      execute: vi.fn(async() => ({
        frontend: new ChatCompletionsFrontend(),
        events: {
          async *[Symbol.asyncIterator]() {
            throw Object.assign(new Error('No usable credential is available for the requested model'), { status: 403 });
          },
        },
      })),
      complete: vi.fn(),
      listModels: vi.fn(),
    };
    registerAiGatewayRoutes(server, { service: service as any });

    const res = await callRoute(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    expect(JSON.parse(res.body).error.code).toBe('provider_error');
  });

  it('returns 403 when revoked Pod service access prevents model discovery', async () => {
    const { server, routes } = createServer();
    const service = {
      execute: vi.fn(),
      complete: vi.fn(),
      listModels: vi.fn(async() => {
        throw new Error('service_access_missing');
      }),
    };
    registerAiGatewayRoutes(server, { service: service as any });

    const res = await callRoute(routes, 'GET /v1/models', request('/v1/models'));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: {
        code: 'service_access_missing',
      },
    });
  });

  it('aggregates reasoning, signatures, tools, usage and finish reason in all non-streaming protocol shapes', async () => {
    const { routes } = createFixture({
      events: [
        { type: 'response.started', id: 'resp_reasoning' },
        { type: 'reasoning.delta', text: 'think' },
        { type: 'reasoning.signature', provider: 'anthropic', signature: 'sig_1' },
        { type: 'text.delta', text: 'answer' },
        { type: 'tool.started', callId: 'call_1', name: 'lookup' },
        { type: 'tool.arguments.delta', callId: 'call_1', delta: '{"q":"xpod"}' },
        { type: 'tool.completed', callId: 'call_1' },
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 } },
        { type: 'response.completed', finishReason: 'tool_use' },
      ],
    });

    const responses = await callRoute(routes, 'POST /v1/responses', request('/v1/responses', {
      model: 'gpt-5',
      input: 'hi',
    }));
    const messages = await callRoute(routes, 'POST /v1/messages', request('/v1/messages', {
      model: 'gpt-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }));
    const chat = await callRoute(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(JSON.parse(responses.body)).toMatchObject({
      output: expect.arrayContaining([
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }], encrypted_content: 'sig_1' },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"xpod"}' },
      ]),
      usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
    });
    expect(JSON.parse(messages.body)).toMatchObject({
      content: expect.arrayContaining([
        { type: 'thinking', thinking: 'think', signature: 'sig_1' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'xpod' } },
      ]),
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 11 },
    });
    expect(JSON.parse(chat.body)).toMatchObject({
      choices: [{
        message: {
          role: 'assistant',
          content: 'answer',
          reasoning_content: 'think',
          reasoning_signature: 'sig_1',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"xpod"}' },
          }],
        },
        finish_reason: 'tool_use',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
    });
  });

  it('aborts the upstream adapter when the client connection closes', async () => {
    const onAbort = vi.fn();
    const { routes } = createFixture({ onAbort });
    const req = request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = response();
    const promise = routes['POST /v1/chat/completions'](req, res, {});

    for (let index = 0; index < 50 && res.writeCount === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(res.writeCount).toBeGreaterThan(0);
    res.emit('close');
    await promise;

    expect(onAbort).toHaveBeenCalledOnce();
  });

  it('allows credential failover before the first client event and forbids switching after streaming starts', async () => {
    const pre = createFixture({ firstProviderFails: true });
    const preRes = await callRoute(pre.routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(preRes.statusCode).toBe(200);
    expect(pre.runtime.execute).toHaveBeenCalledTimes(2);
    expect(pre.store.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'cred_openai' }));

    const post = createFixture({ failAfterFirstEvent: true });
    const postRes = await callRoute(post.routes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(postRes.body).toContain('data: {"error"');
    expect(post.runtime.execute).toHaveBeenCalledTimes(1);
  });

  it('lists only current-WebID available models and requires models:read scope', async () => {
    const { routes } = createFixture({ otherWebIdCredential: true });
    const ok = await callRoute(routes, 'GET /v1/models', request('/v1/models'));
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body);
    expect(body.data.map((model: any) => model.id)).toContain('gpt-5');
    expect(body.data.map((model: any) => model.id)).not.toContain('gpt-4.1');
    expect(body.data.map((model: any) => model.id)).not.toContain('deepseek-chat');

    const forbidden = await callRoute(routes, 'GET /v1/models', request('/v1/models', undefined, {
      type: 'solid',
      webId: OTHER_WEB_ID,
      viaGatewayApiKey: true,
      gatewayKeyId: 'gak_read',
      scopes: ['inference:write'],
    } as any));
    expect(forbidden.statusCode).toBe(403);
  });

  it('does not register acceptance provenance endpoint unless explicitly enabled', () => {
    const { routes } = createFixture();

    expect(routes['GET /v1/xpod/acceptance/provenance']).toBeUndefined();
  });

  it('rejects acceptance provenance for non-Gateway callers and Gateway keys missing acceptance:read', async () => {
    const { routes } = createFixture({ acceptanceEndpointsEnabled: true });
    const path = '/v1/xpod/acceptance/provenance?model=gpt-5';

    const nonGateway = await callRoute(routes, 'GET /v1/xpod/acceptance/provenance', request(path, undefined, {
      type: 'solid',
      webId: WEB_ID,
      scopes: ['models:read', 'acceptance:read'],
    }));
    expect(nonGateway.statusCode).toBe(403);

    const missingScope = await callRoute(routes, 'GET /v1/xpod/acceptance/provenance', request(path, undefined, {
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
      gatewayKeyId: 'gak_protocol_only',
      gatewayKeyFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      scopes: ['models:read', 'inference:write'],
    } as any));
    expect(missingScope.statusCode).toBe(403);
  });

  it('validates acceptance provenance model input and fails unresolved credentials honestly', async () => {
    const { routes } = createFixture({ acceptanceEndpointsEnabled: true });
    const auth = {
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
      gatewayKeyId: 'gak_acceptance',
      gatewayKeyFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      scopes: ['acceptance:read'],
    } as any;

    const missingModel = await callRoute(routes, 'GET /v1/xpod/acceptance/provenance', request(
      '/v1/xpod/acceptance/provenance',
      undefined,
      auth,
    ));
    expect(missingModel.statusCode).toBe(400);

    const unresolved = await callRoute(routes, 'GET /v1/xpod/acceptance/provenance', request(
      '/v1/xpod/acceptance/provenance?model=missing-model',
      undefined,
      auth,
    ));
    expect(unresolved.statusCode).toBe(404);
  });

  it('returns server-derived acceptance provenance without raw Gateway or provider secrets', async () => {
    const { routes } = createFixture({ acceptanceEndpointsEnabled: true });
    const serverFingerprint = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const callerFingerprint = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const res = await callRoute(routes, 'GET /v1/xpod/acceptance/provenance', request(
      '/v1/xpod/acceptance/provenance?model=gpt-5',
      undefined,
      {
        type: 'solid',
        webId: WEB_ID,
        viaGatewayApiKey: true,
        gatewayKeyId: 'gak_acceptance',
        gatewayKeyFingerprint: serverFingerprint,
        scopes: ['acceptance:read'],
      } as any,
      {
        'x-xpod-gateway-key-fingerprint': callerFingerprint,
      },
    ));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      webId: WEB_ID,
      gatewayKeyId: 'gak_acceptance',
      gatewayKeyFingerprint: serverFingerprint,
      credentialIriHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      credentialRecordHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      providerId: 'openai',
      providerRouteSource: 'pod-credential',
      xpodBaseUrl: 'http://localhost',
    });
    expect(JSON.stringify(body)).not.toContain(callerFingerprint);
    expect(JSON.stringify(body)).not.toContain('xpod_gw_v1_');
    expect(JSON.stringify(body)).not.toContain('sk-primary');
    expect(body.credentialRecordHash).not.toBe(body.credentialIriHash);
    expect(body.credentialIri).toBeUndefined();
    expect(body.secretCellRef).toBeUndefined();
  });

  it('maps bounded body errors to 400 and 413', async () => {
    const { routes } = createFixture();
    const invalid = await callRoute(routes, 'POST /v1/chat/completions', request('/v1/chat/completions', '{'));
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body).error.code).toBe('invalid_request');

    const { server, routes: limitedRoutes } = createServer();
    registerAiGatewayRoutes(server, { service: createFixture().service, jsonBodyLimitBytes: 8 });
    const oversize = await callRoute(limitedRoutes, 'POST /v1/chat/completions', request('/v1/chat/completions', {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(oversize.statusCode).toBe(413);
  });
});
