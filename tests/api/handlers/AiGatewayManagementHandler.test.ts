import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import { InMemoryGatewayAccessKeyRepository } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';

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

function request(auth: AuthenticatedRequest['auth'], body?: unknown): AuthenticatedRequest {
  const req = new PassThrough() as unknown as AuthenticatedRequest;
  req.method = 'POST';
  req.url = '/api/ai/gateway/keys';
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

describe('AiGatewayManagementHandler', () => {
  it('creates a gateway key for the logged-in Solid WebID and returns plaintext once', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      keyId: () => 'gak_created',
    });
    const res = response();

    await routes['POST /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
      accountId: WEB_ID,
    }, {
      name: 'Codex',
      scopes: ['gateway:invoke', 'models:read'],
      expiresAt: '2026-08-01T00:00:00.000Z',
    }), res, {});

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(201);
    expect(body.key).toMatch(/^xpod_gw_v1_cloud_gak_created_/);
    expect(body.record).toMatchObject({
      id: 'gak_created',
      owner: WEB_ID,
      deployment: 'cloud',
      scopes: ['gateway:invoke', 'models:read'],
      createdAt: '2026-07-23T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    expect(JSON.stringify(await repository.findById('gak_created'))).not.toContain(body.key);
    expect((await repository.findById('gak_created'))?.secretHash).toMatch(/^scrypt\$/);
  });

  it('lists keys without plaintext or secret hash for the current owner', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'local',
      keyId: () => 'gak_listed',
    });
    await routes['POST /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
    }, { scopes: ['gateway:invoke'] }), response(), {});
    const res = response();

    await routes['GET /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'gak_listed',
      owner: WEB_ID,
      deployment: 'local',
      scopes: ['gateway:invoke'],
    });
    expect(JSON.stringify(body)).not.toContain('secretHash');
    expect(JSON.stringify(body)).not.toContain('xpod_gw_');
  });

  it('revokes a key owned by the current Solid WebID', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      keyId: () => 'gak_revoke',
    });
    await routes['POST /api/ai/gateway/keys'](request({ type: 'solid', webId: WEB_ID }, {
      scopes: ['gateway:invoke'],
    }), response(), {});
    const res = response();

    await routes['DELETE /api/ai/gateway/keys/:keyId'](request({ type: 'solid', webId: WEB_ID }), res, {
      keyId: 'gak_revoke',
    });

    expect(res.statusCode).toBe(200);
    await expect(repository.findById('gak_revoke')).resolves.toMatchObject({
      revokedAt: new Date('2026-07-23T00:00:00.000Z'),
    });
  });

  it('rejects gateway-key principals from managing keys', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
    });
    const res = response();

    await routes['POST /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
    } as any, { scopes: ['gateway:invoke'] }), res, {});

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Gateway API keys cannot manage gateway keys' });
  });

  it('allows service principals with gateway scope to create keys for an explicit owner', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'local',
      keyId: () => 'gak_service',
    });
    const res = response();

    await routes['POST /api/ai/gateway/keys'](request({
      type: 'service',
      serviceType: 'cloud',
      serviceId: 'provisioner',
      scopes: ['gateway:keys:write'],
    }, {
      owner: WEB_ID,
      scopes: ['gateway:invoke'],
    }), res, {});

    expect(res.statusCode).toBe(201);
    await expect(repository.findById('gak_service')).resolves.toMatchObject({
      owner: WEB_ID,
      deployment: 'local',
    });
  });
});
