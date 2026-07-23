import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore } from '../../../src/api/ai-gateway/AiGatewayService';
import { registerAiGatewayRoutes } from '../../../src/api/handlers/AiGatewayHandler';
import { ChatCompletionsFrontend } from '../../../src/api/ai-gateway/protocol';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import type { CredentialVault } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import type { EncryptedCredentialSecret } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import type { GatewayEvent } from '../../../src/api/ai-gateway/types';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';

function encrypted(provider: string): EncryptedCredentialSecret {
  return {
    algorithm: 'AES-256-GCM',
    aadPurpose: 'test',
    aadVersion: 'v1',
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    webId: WEB_ID,
    credentialIri: `https://pod.example/settings/credentials.ttl#${provider}`,
    provider,
    dekWrapAlgorithm: 'test',
    keyId: 'test',
    wrappedDek: 'wrapped',
  };
}

function request(path: string, body?: unknown, auth: AuthenticatedRequest['auth'] = {
  type: 'solid',
  webId: WEB_ID,
  scopes: ['models:read', 'inference:write'],
}): AuthenticatedRequest {
  const req = new PassThrough() as unknown as AuthenticatedRequest;
  req.method = body === undefined ? 'GET' : 'POST';
  req.url = path;
  req.headers = { host: 'localhost' };
  req.auth = auth;
  if (body !== undefined) {
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    write(chunk: unknown) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(payload?: unknown) {
      if (payload !== undefined) {
        this.write(payload);
      }
      this.ended = true;
      this.body = this.chunks.join('');
    },
  };
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
      encryptedSecret: encrypted('openai'),
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
      encryptedSecret: encrypted('openai'),
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
      encryptedSecret: encrypted('deepseek'),
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
    encryptedSecret: encrypted('openai'),
  }] : [];
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async({ webId }) => webId === WEB_ID ? credentials : otherCredentials),
    recordSuccess: vi.fn(async() => {}),
    recordFailure: vi.fn(async() => {}),
  };
  const vault: CredentialVault = {
    seal: vi.fn(),
    rewrap: vi.fn(),
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
    runtime.execute = vi.fn((input: any) => ({
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
  registerAiGatewayRoutes(server, { service });
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
    expect(responses.body).toContain('data: {"type":"response.output_text.delta","delta":"hel"}');
    expect(responses.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(messages.body).toContain('"type":"message_start"');
    expect(messages.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(chat.body).toContain('"choices":[{"index":0,"delta":{"content":"hel"}}]');
    expect(chat.body.trim().endsWith('data: [DONE]')).toBe(true);
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
    const promise = callRoute(routes, 'POST /v1/chat/completions', req);

    await new Promise((resolve) => setTimeout(resolve, 1));
    req.emit('close');
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
    expect(body.data.map((model: any) => model.id)).toContain('gpt-4.1');
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
