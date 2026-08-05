import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { ApiServer } from '../../../src/api/ApiServer';
import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
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
      put: vi.fn((path: string, handler: Function) => { routes[`PUT ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(
  auth: AuthenticatedRequest['auth'],
  body?: unknown,
  url = '/',
  method?: string,
): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = method ?? (body === undefined ? 'GET' : 'POST');
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

  it('discovers models for the current Solid WebID and never trusts a body WebID', async () => {
    const { server, routes } = createServer();
    const discover = vi.fn(async () => ({
      provider: 'openai',
      version: 'selection-v1',
      status: 'ready',
      fetchedAt: '2026-08-05T00:00:00.000Z',
      models: [{ id: 'gpt-5', modelType: 'chat', selected: true, availability: 'available' }],
    }));
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      modelSelectionService: { discover } as never,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID, viaApiKey: true };
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/models/discover'](
      request(auth, { webId: 'https://id.example/attacker/profile/card#me' }, '/api/ai/gateway/providers/openai/models/discover'),
      res,
      { provider: 'openai' },
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).models[0].id).toBe('gpt-5');
    expect(discover).toHaveBeenCalledWith({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      auth,
      forceRefresh: true,
    });
  });

  it('gets cached or durable model state without triggering provider discovery', async () => {
    const { server, routes } = createServer();
    const discover = vi.fn();
    const getCatalog = vi.fn(async () => ({
      provider: 'openai',
      version: 'selection-v1',
      status: 'notFetched',
      models: [],
    }));
    registerAiGatewayManagementRoutes(server, {
      deployment: 'local',
      modelSelectionService: { discover, getCatalog } as never,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID };
    const res = response();

    await routes['GET /api/ai/gateway/providers/:provider/models'](
      request(auth, undefined, '/api/ai/gateway/providers/openai/models'),
      res,
      { provider: 'openai' },
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ provider: 'openai', status: 'notFetched' });
    expect(getCatalog).toHaveBeenCalledWith({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      auth,
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it('bounds and normalizes a model selection body before saving', async () => {
    const { server, routes } = createServer();
    const replaceSelection = vi.fn(async () => ({
      provider: 'openai',
      version: 'selection-v2',
      status: 'ready',
      models: [],
    }));
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      modelSelectionService: { replaceSelection } as never,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID };
    const res = response();

    await routes['PUT /api/ai/gateway/providers/:provider/models/selection'](
      request(auth, {
        webId: 'https://id.example/attacker/profile/card#me',
        modelIds: [' gpt-5 ', 'openai.ttl#gpt-5', 'gpt-4.1'],
        defaultModel: ' gpt-5 ',
        expectedVersion: 'selection-v1',
      }, '/api/ai/gateway/providers/openai/models/selection', 'PUT'),
      res,
      { provider: 'openai' },
    );

    expect(res.statusCode).toBe(200);
    expect(replaceSelection).toHaveBeenCalledWith({
      webId: WEB_ID,
      provider: 'openai',
      modelIds: ['gpt-5', 'gpt-4.1'],
      defaultModel: 'gpt-5',
      expectedVersion: 'selection-v1',
      deployment: 'cloud',
      auth,
    });
  });

  it('requires expectedVersion and rejects unknown providers before service calls', async () => {
    const { server, routes } = createServer();
    const replaceSelection = vi.fn();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      modelSelectionService: { replaceSelection } as never,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID };

    const missingVersion = response();
    await routes['PUT /api/ai/gateway/providers/:provider/models/selection'](
      request(auth, { modelIds: ['gpt-5'] }, undefined, 'PUT'),
      missingVersion,
      { provider: 'openai' },
    );
    expect(missingVersion.statusCode).toBe(400);
    expect(replaceSelection).not.toHaveBeenCalled();

    const unknownProvider = response();
    await routes['PUT /api/ai/gateway/providers/:provider/models/selection'](
      request(auth, { modelIds: ['gpt-5'], expectedVersion: 'selection-v1' }, undefined, 'PUT'),
      unknownProvider,
      { provider: 'not-a-provider' },
    );
    expect(unknownProvider.statusCode).toBe(400);
    expect(replaceSelection).not.toHaveBeenCalled();
  });

  it('rejects oversized or overlong selection bodies before calling the service', async () => {
    const { server, routes } = createServer();
    const replaceSelection = vi.fn();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      modelSelectionService: { replaceSelection } as never,
      jsonBodyLimitBytes: 64,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID };

    const oversized = response();
    await routes['PUT /api/ai/gateway/providers/:provider/models/selection'](
      request(auth, { modelIds: ['gpt-5'], expectedVersion: 'selection-v1', extra: 'x'.repeat(100) }, undefined, 'PUT'),
      oversized,
      { provider: 'openai' },
    );
    expect(oversized.statusCode).toBe(413);

    const longHarness = createServer();
    registerAiGatewayManagementRoutes(longHarness.server, {
      deployment: 'cloud',
      modelSelectionService: { replaceSelection } as never,
    });
    const longModelId = response();
    await longHarness.routes['PUT /api/ai/gateway/providers/:provider/models/selection'](
      request(auth, { modelIds: ['x'.repeat(257)], expectedVersion: 'selection-v1' }, undefined, 'PUT'),
      longModelId,
      { provider: 'openai' },
    );
    expect(longModelId.statusCode).toBe(400);
    expect(replaceSelection).not.toHaveBeenCalled();
  });

  it('maps provider errors to safe stable responses with retry and reauth metadata', async () => {
    const { server, routes } = createServer();
    const secret = 'sk-provider-body-must-not-leak';
    const discover = vi.fn(async () => {
      throw new GatewayProtocolError(`provider response ${secret}`, {
        code: 'provider_error',
        status: 429,
        details: {
          provider: 'openai',
          providerStatusCode: 429,
          retryAfter: '30',
          secret,
        },
      });
    });
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      modelSelectionService: { discover } as never,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/models/discover'](
      request({ type: 'solid', webId: WEB_ID }),
      res,
      { provider: 'openai' },
    );

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(429);
    expect(body.error).toMatchObject({ code: 'provider_error', status: 429 });
    expect(body.error.details).toMatchObject({ provider: 'openai', retryAfter: '30' });
    expect(body.error.details).not.toHaveProperty('secret');
    expect(res.body).not.toContain(secret);
  });

  it('maps credential, conflict, and generic discovery errors without leaking bodies', async () => {
    const { server, routes } = createServer();
    const discover = vi.fn();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      modelSelectionService: { discover } as never,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID };

    discover.mockRejectedValueOnce(new GatewayProtocolError('active_credential_required', {
      code: 'credential_unavailable',
      status: 401,
      details: { provider: 'openai', reauthRequired: true },
    }));
    const credentialResponse = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/discover'](
      request(auth), credentialResponse, { provider: 'openai' },
    );
    expect(credentialResponse.statusCode).toBe(401);
    expect(JSON.parse(credentialResponse.body).error.details).toMatchObject({ reauthRequired: true });

    discover.mockRejectedValueOnce(new Error('model_selection_version_conflict'));
    const conflictResponse = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/discover'](
      request(auth), conflictResponse, { provider: 'openai' },
    );
    expect(conflictResponse.statusCode).toBe(409);

    discover.mockRejectedValueOnce(new Error('upstream body contains sk-hidden-error'));
    const genericResponse = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/discover'](
      request(auth), genericResponse, { provider: 'openai' },
    );
    expect(genericResponse.statusCode).toBe(502);
    expect(genericResponse.body).not.toContain('sk-hidden-error');
  });
});
