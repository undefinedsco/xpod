import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { ApiServer } from '../../../src/api/ApiServer';
import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';

const WEB_ID = 'https://id.example/alice/profile/card#me';

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(
  auth: AuthenticatedRequest['auth'],
  body?: unknown,
  url = '/',
): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = body === undefined ? 'GET' : 'POST';
  req.url = url;
  req.headers = {};
  req.auth = auth;
  req.end(body === undefined ? undefined : JSON.stringify(body));
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    end: vi.fn(function(this: any, payload?: string) { this.body = payload; }),
  };
}

describe('AiGatewayManagementHandler', () => {
  it('does not register a second long-term Gateway Key management API', () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, { deployment: 'cloud' });

    expect(routes['GET /api/ai/gateway/keys']).toBeUndefined();
    expect(routes['POST /api/ai/gateway/keys']).toBeUndefined();
    expect(routes['DELETE /api/ai/gateway/keys/:keyId']).toBeUndefined();
  });

  it('publishes owner-derived service access and a short-lived invocation token for a Solid user', async () => {
    const { server, routes } = createServer();
    const issue = vi.fn(async () => ({
      token: 'xpod_inv_v1.short-lived',
      expiresAt: '2026-08-04T00:05:00.000Z',
    }));
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      aiConnectionInvocationKeyIssuer: { issueClientConfiguration: issue } as never,
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connection'](
      request({ type: 'solid', webId: WEB_ID }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.appletId).toBe('co.undefineds.ai-connection');
    expect(body.resources.map((resource: { id: string }) => resource.id)).not.toContain('gatewayAccessKeys');
    expect(body.invocation.token).toBe('xpod_inv_v1.short-lived');
    expect(issue).toHaveBeenCalledWith({ auth: { type: 'solid', webId: WEB_ID } });
  });

  it('keeps provider management bound to the current Solid identity', async () => {
    const { server, routes } = createServer();
    const listProviders = vi.fn(async () => [{ provider: 'kimi', status: 'connected', deployment: 'cloud', webId: WEB_ID }]);
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService: { listProviders } as never,
    });

    const unauthorized = response();
    await routes['GET /api/ai/connections/providers'](request(undefined), unauthorized);
    expect(unauthorized.statusCode).toBe(401);

    const authorized = response();
    await routes['GET /api/ai/connections/providers'](
      request({ type: 'solid', webId: WEB_ID, viaApiKey: true }),
      authorized,
    );
    expect(authorized.statusCode).toBe(200);
    expect(JSON.parse(authorized.body)).toEqual({ data: [{ provider: 'kimi', status: 'connected' }] });
    expect(listProviders).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: { type: 'solid', webId: WEB_ID, viaApiKey: true },
    }));
  });

  it('passes the authenticated Solid context into quota reads', async () => {
    const { server, routes } = createServer();
    const status = vi.fn(async () => ({ status: 'available', stale: false }));
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      quotaService: { status } as never,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID, viaApiKey: true };
    const res = response();

    await routes['GET /api/ai/gateway/providers/:provider/quota/status'](
      request(auth, undefined, '/api/ai/gateway/providers/kimi/quota/status'),
      res,
      { provider: 'kimi' },
    );

    expect(res.statusCode).toBe(200);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      provider: 'kimi',
      auth,
      refresh: false,
    }));
  });

  it('returns a secret-free persistence stage when an API-key save fails', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService: {
        completeApiKey: vi.fn(async () => {
          throw new Error('credential_persistence_failed:replace-delete', {
            cause: new Error('upstream response contained sk-must-not-leak'),
          });
        }),
      } as never,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/connect/complete-api-key'](
      request(
        { type: 'solid', webId: WEB_ID },
        { attemptId: 'attempt', state: 'state', signature: 'signature', apiKey: 'sk-must-not-leak' },
      ),
      res,
      { provider: 'openai' },
    );

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: 'credential_persistence_failed',
      stage: 'replace-delete',
    });
    expect(res.body).not.toContain('sk-must-not-leak');
  });
});
