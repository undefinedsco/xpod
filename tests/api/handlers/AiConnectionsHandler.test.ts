import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import { registerAiConnectionsRoutes } from '../../../src/api/handlers/AiConnectionsHandler';

const AUTH = {
  type: 'solid' as const,
  webId: 'https://id.example/alice/profile/card#me',
  accessToken: 'browser-dpop-token',
  tokenType: 'DPoP' as const,
};

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => {
        routes[`POST ${path}`] = handler;
      }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth'], body: unknown): AuthenticatedRequest {
  const stream = new PassThrough() as PassThrough & AuthenticatedRequest;
  stream.method = 'POST';
  stream.url = '/';
  stream.headers = {};
  stream.auth = auth;
  stream.end(JSON.stringify(body));
  return stream;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(function(this: any, body?: string) {
      this.body = body;
    }),
  };
}

describe('AI provider probe routes', () => {
  it('registers only stateless model and quota probes', () => {
    const { server, routes } = createServer();
    registerAiConnectionsRoutes(server, { probeService: {} as never });

    expect(routes['POST /api/ai/connections/providers/:provider/models/refresh']).toBeTypeOf('function');
    expect(routes['POST /api/ai/connections/providers/:provider/quota/refresh']).toBeTypeOf('function');
    expect(routes['GET /api/ai/connections/providers']).toBeUndefined();
    expect(routes['POST /api/ai/connections/providers/:provider/connect/begin']).toBeUndefined();
    expect(routes['POST /api/ai/connections/providers/:provider/connect/complete-api-key']).toBeUndefined();
  });

  it('accepts browser DPoP for a stateless probe without forwarding auth or WebID', async () => {
    const discoverModels = vi.fn(async (_input: unknown) => ({
      provider: 'openai',
      models: [{ id: 'gpt-test' }],
      observedAt: '2026-08-25T00:00:00.000Z',
      source: 'openai:/models',
    }));
    const { server, routes } = createServer();
    registerAiConnectionsRoutes(server, {
      probeService: { discoverModels } as never,
    });
    const res = response();

    await routes['POST /api/ai/connections/providers/:provider/models/refresh'](
      request(AUTH, { apiKey: 'user-provider-key', baseUrl: 'https://api.openai.com/v1' }),
      res,
      { provider: 'openai' },
    );

    expect(res.statusCode).toBe(200);
    expect(discoverModels).toHaveBeenCalledWith({
      provider: 'openai',
      apiKey: 'user-provider-key',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(discoverModels.mock.calls[0]?.[0]).not.toHaveProperty('auth');
    expect(discoverModels.mock.calls[0]?.[0]).not.toHaveProperty('webId');
    expect(res.body).not.toContain('user-provider-key');
  });

  it('rejects non-Solid service callers', async () => {
    const discoverModels = vi.fn();
    const { server, routes } = createServer();
    registerAiConnectionsRoutes(server, { probeService: { discoverModels } as never });
    const res = response();

    await routes['POST /api/ai/connections/providers/:provider/models/refresh'](
      request({ type: 'service', serviceType: 'cloud', serviceId: 'gateway', scopes: [] }, {
        apiKey: 'user-provider-key',
      }),
      res,
      { provider: 'openai' },
    );

    expect(res.statusCode).toBe(403);
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it('rejects Pod credential identifiers in stateless probe bodies', async () => {
    const discoverModels = vi.fn();
    const { server, routes } = createServer();
    registerAiConnectionsRoutes(server, { probeService: { discoverModels } as never });
    const res = response();

    await routes['POST /api/ai/connections/providers/:provider/models/refresh'](
      request(AUTH, {
        apiKey: 'user-provider-key',
        credentialIri: 'https://pod.example/alice/settings/credentials.ttl#openai',
      }),
      res,
      { provider: 'openai' },
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('provider_probe_body_invalid');
    expect(discoverModels).not.toHaveBeenCalled();
  });
});
