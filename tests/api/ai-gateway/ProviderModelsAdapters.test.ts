import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import { PlaintextCredentialVault } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialVault';
import type { ProviderSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import {
  AnthropicModelsAdapter,
  OpenAiCompatibleModelsAdapter,
  ProviderModelsFetchError,
  ProviderModelsService,
  normalizeDiscoveredModels,
  type ModelsCredentialRecord,
} from '../../../src/api/ai-gateway/models';
import { InMemoryGatewayAccessKeyRepository } from './InMemoryGatewayAccessKeyRepository';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const CREDENTIAL_IRI = 'https://id.example/alice/.data/settings/credentials.ttl#cloud-kimi';

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

function createVault(): PlaintextCredentialVault {
  return new PlaintextCredentialVault();
}

async function credential(provider: string, secret: ProviderSecret = { type: 'apiKey', apiKey: 'provider-secret' }): Promise<ModelsCredentialRecord> {
  const vault = createVault();
  const credentialIri = CREDENTIAL_IRI.replace('kimi', provider);
  return {
    id: `${provider}-credential`,
    credentialIri,
    webId: WEB_ID,
    provider,
    deployment: 'cloud',
    authMode: 'apiKey',
    credentialSecret: await vault.seal({ webId: WEB_ID }, credentialIri, provider, secret),
    status: 'active',
  };
}

describe('ProviderModelsAdapters', () => {
  it('discovers OpenAI-compatible models from the credential base URL with bearer auth', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.moonshot.ai/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
      return {
        body: {
          data: [
            { id: 'kimi-k2', display_name: 'Kimi K2' },
            { id: 'text-embedding-3-large' },
            { id: 'kimi-k2' },
            { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
          ],
        },
      };
    });

    const models = await new OpenAiCompatibleModelsAdapter({
      provider: 'kimi',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: await credential('kimi'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    });

    expect(models).toEqual([
      { id: 'kimi-k2', displayName: 'Kimi K2' },
      { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
    ]);
  });

  it('prefers the credential baseUrl over the adapter default', async () => {
    const fetch = jsonFetch((url) => {
      expect(url).toBe('https://api.moonshot.cn/v1/models');
      return { body: { data: [{ id: 'kimi-k2' }] } };
    });
    const kimiCredential = {
      ...await credential('kimi'),
      baseUrl: 'https://api.moonshot.cn/v1',
    };

    const models = await new OpenAiCompatibleModelsAdapter({
      provider: 'kimi',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: kimiCredential,
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    });

    expect(models).toEqual([{ id: 'kimi-k2' }]);
  });

  it('discovers Anthropic models with x-api-key and version headers', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/models');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('provider-secret');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      return {
        body: {
          data: [
            { id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1' },
            { id: 'claude-sonnet-4-5' },
          ],
        },
      };
    });

    const models = await new AnthropicModelsAdapter({ fetchImpl: fetch }).fetch({
      credential: await credential('anthropic'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    });

    expect(models).toEqual([
      { id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-5' },
    ]);
  });

  it('passes through the provider status code on fetch failure', async () => {
    const fetch = jsonFetch(() => ({ status: 401, body: { error: 'invalid key' } }));

    await expect(new OpenAiCompatibleModelsAdapter({
      provider: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: await credential('openai'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    })).rejects.toMatchObject({
      name: 'ProviderModelsFetchError',
      providerStatus: 401,
    });
  });

  it('normalizes alternate list envelopes and skips invalid entries', () => {
    expect(normalizeDiscoveredModels({
      models: {
        models: [
          { name: 'models/gemini-2.5-pro' },
          { model: 'gemini-2.5-flash', title: 'Gemini 2.5 Flash' },
          { slug: '' },
          'not-an-object',
        ],
      },
    })).toEqual([
      { id: 'models/gemini-2.5-pro' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    ]);
    expect(normalizeDiscoveredModels({ result: [{ id: 'deepseek-chat' }] })).toEqual([
      { id: 'deepseek-chat' },
    ]);
    expect(normalizeDiscoveredModels(undefined)).toEqual([]);
  });
});

describe('ProviderModelsService', () => {
  it('resolves the active credential, opens the vault and returns the discovery', async () => {
    const kimiCredential = await credential('kimi');
    const fetch = jsonFetch((url) => {
      expect(url).toBe('https://api.moonshot.ai/v1/models');
      return { body: { data: [{ id: 'kimi-k2' }] } };
    });
    const service = new ProviderModelsService({
      vault: createVault(),
      credentials: [kimiCredential],
      adapters: [
        new OpenAiCompatibleModelsAdapter({
          provider: 'kimi',
          defaultBaseUrl: 'https://api.moonshot.ai/v1',
          fetchImpl: fetch,
        }),
      ],
      now: () => new Date('2026-08-06T00:00:00.000Z'),
    });

    const discovery = await service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    });

    expect(discovery).toEqual({
      provider: 'kimi',
      credential: kimiCredential.credentialIri,
      models: [{ id: 'kimi-k2' }],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: 'kimi:/models',
    });
  });

  it('rejects providers without an adapter or credential with coded errors', async () => {
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [
        new OpenAiCompatibleModelsAdapter({
          provider: 'kimi',
          defaultBaseUrl: 'https://api.moonshot.ai/v1',
        }),
      ],
    });

    await expect(service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
    })).rejects.toThrow('models_adapter_not_found:openai');
    await expect(service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    })).rejects.toThrow('models_credential_not_found');
  });
});

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth'], body?: unknown, url = '/api/ai/gateway/providers/kimi/models/refresh'): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = body === undefined ? 'GET' : 'POST';
  req.url = url;
  req.headers = {};
  req.auth = auth;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(function(this: any, payload?: string) {
      this.body = payload;
    }),
  };
}

describe('AiGatewayManagementHandler models routes', () => {
  it('refreshes provider models for the current Solid identity', async () => {
    const kimiCredential = await credential('kimi');
    const modelsService = {
      list: vi.fn(async () => ({
        provider: 'kimi',
        credential: kimiCredential.credentialIri,
        models: [{ id: 'kimi-k2' }],
        observedAt: '2026-08-06T00:00:00.000Z',
        source: 'kimi:/models',
      })),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      modelsService: modelsService as never,
    });

    const res = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](request(
      { type: 'solid', webId: WEB_ID },
      { credentialIri: kimiCredential.credentialIri },
    ), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      provider: 'kimi',
      models: [{ id: 'kimi-k2' }],
    });
    expect(modelsService.list).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: kimiCredential.credentialIri,
    }));
  });

  it('rejects gateway-key principals from provider models routes', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      modelsService: { list: vi.fn() } as never,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](request({
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
    } as any, {}), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Gateway API keys cannot manage provider quota state' });
  });

  it('maps coded service errors and provider fetch failures', async () => {
    const modelsService = {
      list: vi.fn()
        .mockRejectedValueOnce(new Error('models_credential_not_found'))
        .mockRejectedValueOnce(new ProviderModelsFetchError(429, '30')),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      modelsService: modelsService as never,
    });

    const missing = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](
      request({ type: 'solid', webId: WEB_ID }, {}),
      missing,
      { provider: 'kimi' },
    );
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: 'Provider credential not found for current identity' });

    const failed = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](
      request({ type: 'solid', webId: WEB_ID }, {}),
      failed,
      { provider: 'kimi' },
    );
    expect(failed.statusCode).toBe(502);
    expect(JSON.parse(failed.body)).toEqual({
      error: 'provider_models_fetch_failed',
      providerStatus: 429,
      retryAfter: '30',
    });
  });

  it('responds 503 when the models service is not configured', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](
      request({ type: 'solid', webId: WEB_ID }, {}),
      res,
      { provider: 'kimi' },
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'AI provider models service is not configured' });
  });
});
