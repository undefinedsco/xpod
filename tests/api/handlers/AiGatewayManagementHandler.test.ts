import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import { InMemoryGatewayAccessKeyRepository } from '../ai-gateway/InMemoryGatewayAccessKeyRepository';
import { AesGatewayKeyLocatorCodec } from '../../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import { PodGatewayAccessKeyRepository } from '../../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';
import { GatewayApiKeyAuthenticator } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { AiConnectionInvocationKeyIssuer } from '../../../src/api/ai-gateway/auth/AiConnectionInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../../../src/api/ai-gateway/auth/InvocationTokenCodec';
import { createGatewayApiKey } from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import {
  BrowserAssistedApiKeyConnectAdapter,
  InMemoryConnectAttemptStore,
  PodConnectedCredentialRepository,
  ProviderConnectService,
} from '../../../src/api/ai-gateway/connect';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';

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
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
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

function rawRequest(auth: AuthenticatedRequest['auth'], rawBody: string): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'POST';
  req.url = '/api/ai/gateway/keys';
  req.headers = {};
  req.auth = auth;
  req.end(rawBody);
  return req;
}

async function requestWithBearer(
  authenticator: GatewayApiKeyAuthenticator,
  token: string,
  body?: unknown,
): Promise<AuthenticatedRequest> {
  const req = request(undefined, body);
  req.headers.authorization = `Bearer ${token}`;
  const result = await authenticator.authenticate(req);
  if (result.success) {
    req.auth = result.context;
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

function jsonClone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function invocationHarness(input: {
  deployment?: 'cloud' | 'local';
  now?: Date;
  scopes?: string[];
  ttlMs?: number;
} = {}) {
  const now = input.now ?? new Date('2026-07-30T00:00:00.000Z');
  const deployment = input.deployment ?? 'cloud';
  const repository = new InMemoryGatewayAccessKeyRepository();
  const codec = new AesInvocationTokenCodec({
    active: { kid: 'active', secret: 'management-invocation-secret' },
  });
  const authenticator = new GatewayApiKeyAuthenticator({
    repository,
    invocationTokenCodec: codec,
    deployment,
    invocationTokenAudience: 'https://pod.example',
    now: () => now,
    requiredScopes: input.scopes ?? ['models:read', 'inference:write'],
  });
  const issuer = new AiConnectionInvocationKeyIssuer({
    codec,
    deployment,
    baseUrl: 'https://pod.example/v1',
    audience: 'https://pod.example',
    ttlMs: input.ttlMs,
    now: () => now,
  });
  return { repository, authenticator, issuer, codec, now };
}

describe('AiGatewayManagementHandler', () => {
  it('requires Solid authentication for the AI Connection service-access descriptor', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connection'](request(undefined), res, {});

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Authentication required' });
  });

  it('returns the AI Connection service-access descriptor from the authenticated owner without internal credentials', async () => {
    const { server, routes } = createServer();
    const servicePrincipal = {
      getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
    };
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      servicePrincipal,
    } as any);
    const res = response();

    await routes['GET /api/applets/service-access/ai-connection'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(200);
    expect(servicePrincipal.getServicePrincipal).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      service: { webId: WEB_ID },
      resources: expect.arrayContaining([
        expect.objectContaining({
          url: 'https://id.example/alice/settings/credentials.ttl',
        }),
      ]),
    });
  });

  it('publishes AI Connection service-access resources derived only from the authenticated WebID', async () => {
    const servicePrincipal = {
      getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      servicePrincipal,
    } as any);
    const req = request({
      type: 'solid',
      webId: 'https://pod.example/bob/profile/card#me',
    });
    req.url = '/api/applets/service-access/ai-connection?resource=https%3A%2F%2Fevil.example%2Fcredentials.ttl';
    const res = response();

    await routes['GET /api/applets/service-access/ai-connection'](req, res, {});

    expect(res.statusCode).toBe(200);
    expect(servicePrincipal.getServicePrincipal).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      appletId: 'co.undefineds.ai-connection',
      service: {
        webId: 'https://pod.example/bob/profile/card#me',
      },
      resources: expect.arrayContaining([
        expect.objectContaining({
          url: 'https://pod.example/bob/settings/credentials.ttl',
        }),
      ]),
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('evil.example');
  });

  it('includes a short-lived owner-bound invocation token in the AI Connection service-access response', async () => {
    const issue = vi.fn(async (context: unknown) => ({
      baseUrl: 'https://pod.example',
      gatewayKey: 'xpod_inv_v1.short-lived-owner-token',
      expiresAt: '2026-07-30T00:10:00.000Z',
    }));
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      aiConnectionInvocationKeyIssuer: { issue },
    });
    const auth = {
      type: 'solid' as const,
      webId: WEB_ID,
      accessToken: 'browser-solid-token',
      tokenType: 'DPoP' as const,
    };
    const res = response();

    await routes['GET /api/applets/service-access/ai-connection'](request(auth), res, {});

    expect(issue).toHaveBeenCalledWith({ auth });
    expect(JSON.parse(res.body)).toMatchObject({
      invocation: {
        baseUrl: 'https://pod.example',
        gatewayKey: 'xpod_inv_v1.short-lived-owner-token',
        expiresAt: '2026-07-30T00:10:00.000Z',
      },
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('browser-solid-token');
  });

  it('includes a safe AI client configuration capability descriptor in service-access when local host support is explicit', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'local',
      aiClientConfiguration: {
        available: true,
        authority: 'local-filesystem',
        manualInstructions: 'Configure clients manually if local filesystem access is unavailable.',
      },
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connection'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.aiClientConfiguration).toEqual({
      available: true,
      authority: 'local-filesystem',
      manualInstructions: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain('/Users/');
    expect(JSON.stringify(body)).not.toContain('xpod_gw');
  });

  it('reports AI client configuration unavailable in cloud service-access without exposing host paths', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connection'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).aiClientConfiguration).toEqual({
      available: false,
      manualInstructions: expect.any(String),
    });
  });

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
      scopes: ['models:read', 'inference:write'],
      expiresAt: '2026-08-01T00:00:00.000Z',
    }), res, {});

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(201);
    expect(body.key).toMatch(/^xpod_gw_v1_cloud_gak_created_/);
    expect(body.record).toMatchObject({
      id: 'gak_created',
      owner: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: '2026-07-23T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    expect(JSON.stringify(await repository.findById('gak_created'))).not.toContain(body.key);
    expect((await repository.findById('gak_created'))?.secretHash).toMatch(/^scrypt\$/);
  });

  it('uses repository-backed locator minting by default when creating keys', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository() as InMemoryGatewayAccessKeyRepository & {
      createKeyId(owner: string, deployment: 'cloud' | 'local'): string;
    };
    const codec = new AesGatewayKeyLocatorCodec('locator-secret');
    repository.createKeyId = (owner, deployment) => codec.encode({ owner, deployment, keyId: 'gak_inner' });
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'cloud',
    });
    const res = response();

    await routes['POST /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
      accountId: WEB_ID,
    }, {}), res, {});

    const body = JSON.parse(res.body);
    const parsedKeyId = body.record.id;
    expect(res.statusCode).toBe(201);
    expect(codec.decode(parsedKeyId)).toMatchObject({
      owner: WEB_ID,
      deployment: 'cloud',
      keyId: 'gak_inner',
    });
    expect(body.key).toContain(parsedKeyId);
  });

  it('creates, authenticates, lists, and revokes a locator-backed key across the real Pod repository boundary', async () => {
    const podRows = new Map<string, any>();
    const codec = new AesGatewayKeyLocatorCodec('locator-secret');
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: codec,
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: () => ({
          values: (value: any) => ({
            execute: async () => {
              podRows.set(value.id, structuredClone(value));
              return [structuredClone(value)];
            },
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              execute: async () => [...podRows.values()].map((row) => structuredClone(row)),
            }),
          }),
        }),
        findById: async (_resource: unknown, id: string) => structuredClone(podRows.get(id)),
        findByIri: async () => null,
        updateById: async (_resource: unknown, id: string, patch: any) => {
          const row = podRows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return structuredClone(row);
        },
      } as any),
    });
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });
    const createRes = response();

    await routes['POST /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
      accessToken: 'solid-access-token',
    }, { name: 'Codex laptop' }), createRes, {});

    const created = JSON.parse(createRes.body);
    expect(codec.decode(created.record.id)).toMatchObject({ owner: WEB_ID, deployment: 'cloud' });
    expect(created.record).not.toHaveProperty('deployment');
    await expect(new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T01:00:00.000Z'),
    }).authenticate({
      headers: { authorization: `Bearer ${created.key}` },
    } as any)).resolves.toMatchObject({
      success: true,
      context: { webId: WEB_ID },
    });

    const listRes = response();
    await routes['GET /api/ai/gateway/keys'](request({ type: 'solid', webId: WEB_ID }), listRes, {});
    expect(JSON.parse(listRes.body).data).toEqual([
      expect.objectContaining({ id: created.record.id, name: 'Codex laptop' }),
    ]);
    expect(JSON.parse(listRes.body).data[0]).not.toHaveProperty('deployment');

    const revokeRes = response();
    await routes['DELETE /api/ai/gateway/keys/:keyId'](request({ type: 'solid', webId: WEB_ID }), revokeRes, {
      keyId: encodeURIComponent(created.record.id),
    });
    expect(JSON.parse(revokeRes.body).record).toMatchObject({
      id: created.record.id,
      revokedAt: '2026-07-23T00:00:00.000Z',
      name: 'Codex laptop',
    });
    expect(JSON.parse(revokeRes.body).record).not.toHaveProperty('deployment');
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
    }, { scopes: ['models:read', 'inference:write'] }), response(), {});
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
      scopes: ['models:read', 'inference:write'],
    });
    expect(JSON.stringify(body)).not.toContain('secretHash');
    expect(JSON.stringify(body)).not.toContain('xpod_gw_');
  });

  it('defaults created keys to models:read plus inference:write only', async () => {
    const repository = new InMemoryGatewayAccessKeyRepository();
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'local',
      keyId: () => 'gak_default_scopes',
    });
    const res = response();

    await routes['POST /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {}), res, {});

    expect(res.statusCode).toBe(201);
    await expect(repository.findById('gak_default_scopes')).resolves.toMatchObject({
      scopes: ['models:read', 'inference:write'],
    });
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
      scopes: ['models:read', 'inference:write'],
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
    } as any, { scopes: ['models:read', 'inference:write'] }), res, {});

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
      scopes: ['models:read', 'inference:write'],
    }), res, {});

    expect(res.statusCode).toBe(201);
    await expect(repository.findById('gak_service')).resolves.toMatchObject({
      owner: WEB_ID,
      deployment: 'local',
    });
  });

  it('rejects invalid JSON with 400 and oversized JSON bodies with 413', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      keyId: () => 'gak_unused',
      jsonBodyLimitBytes: 32,
    });
    const invalid = response();
    await routes['POST /api/ai/gateway/keys'](rawRequest({
      type: 'solid',
      webId: WEB_ID,
    }, '{not-json'), invalid, {});
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body)).toEqual({ error: 'Request body must be valid JSON' });

    const oversized = response();
    await routes['POST /api/ai/gateway/keys'](rawRequest({
      type: 'solid',
      webId: WEB_ID,
    }, JSON.stringify({ name: 'x'.repeat(64) })), oversized, {});
    expect(oversized.statusCode).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({ error: 'Request body too large' });
  });

  it('begins provider Connect for the current Solid WebID only', async () => {
    const connectService = {
      begin: vi.fn(async (input: any) => ({
        mode: input.requestedMode,
        status: 'pending',
        provider: input.provider,
        deployment: input.deployment,
        attemptId: 'attempt_1',
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      mode: 'browserAssistedApiKey',
      owner: 'https://id.example/mallory/profile/card#me',
      deployment: 'local',
      expectedCredentialVersion: 7,
    }), res, {
      provider: 'openai',
    });

    expect(res.statusCode).toBe(200);
    expect(connectService.begin).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
      expectedCredentialVersion: 7,
      auth: {
        type: 'solid',
        webId: WEB_ID,
      },
    });
    expect(JSON.parse(res.body)).not.toHaveProperty('deployment');
  });

  it('lists effective provider connections for the current identity without infrastructure fields', async () => {
    const connectService = {
      listProviders: vi.fn(async () => [
        {
          provider: 'openai',
          status: 'connected',
          authMode: 'apiKey',
          accountLabel: 'Alice',
          deployment: 'cloud',
          webId: WEB_ID,
          connect: {
            modes: ['browserAssistedApiKey', 'apiKey'],
            configured: true,
          },
        },
        {
          provider: 'deepseek',
          status: 'disconnected',
          connect: {
            modes: ['apiKey'],
            configured: true,
          },
        },
      ]),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['GET /api/ai/connections/providers'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(connectService.listProviders).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
      },
    });
    expect(JSON.parse(res.body)).toEqual({
      data: [
        expect.objectContaining({
          provider: 'openai',
          status: 'connected',
          accountLabel: 'Alice',
        }),
        expect.objectContaining({
          provider: 'deepseek',
          status: 'disconnected',
        }),
      ],
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('deployment');
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('webId');
  });

  it('keeps deployment internal in Connect status and poll responses', async () => {
    const connectService = {
      status: vi.fn(async() => ({
        attemptId: 'attempt_1',
        deployment: 'cloud',
        status: 'pending',
        credential: { id: 'cred_1', deployment: 'cloud' },
      })),
      pollDevice: vi.fn(async() => ({
        attemptId: 'attempt_1',
        deployment: 'cloud',
        status: 'completed',
        credential: { id: 'cred_1', deployment: 'cloud' },
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      connectService,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID };
    const statusRequest = request(auth);
    statusRequest.url = '/api/ai/gateway/providers/kimi/connect/status/attempt_1?state=s&signature=sig';
    const statusResponse = response();
    await routes['GET /api/ai/gateway/providers/:provider/connect/status/:attemptId'](
      statusRequest,
      statusResponse,
      { provider: 'kimi', attemptId: 'attempt_1' },
    );
    const pollResponse = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/poll'](request(auth, {
      attemptId: 'attempt_1',
      state: 's',
      signature: 'sig',
    }), pollResponse, { provider: 'kimi' });

    expect(JSON.stringify(JSON.parse(statusResponse.body))).not.toContain('deployment');
    expect(JSON.stringify(JSON.parse(pollResponse.body))).not.toContain('deployment');
    expect(connectService.status).toHaveBeenCalledWith(expect.objectContaining({ deployment: 'cloud' }));
    expect(connectService.pollDevice).toHaveBeenCalledWith(expect.objectContaining({ deployment: 'cloud' }));
  });

  it('keeps browser-assisted API key completion on authenticated management API, never public callback', async () => {
    const connectService = {
      completeApiKey: vi.fn(async () => ({ mode: 'browserAssistedApiKey', status: 'completed' })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'local',
      connectService,
    });
    const callback = response();

    await routes['GET /api/ai/gateway/providers/:provider/connect/callback'](request(undefined), callback, {
      provider: 'openai',
    });

    expect(callback.statusCode).toBe(405);
    expect(JSON.parse(callback.body).error).toMatch(/unsupported/i);
    expect(connectService.completeApiKey).not.toHaveBeenCalled();

    const complete = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/complete-api-key'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      attemptId: 'attempt_1',
      state: 'state_1',
      signature: 'sig_1',
      apiKey: 'sk-submit-only-here',
      accountLabel: 'Alice',
    }), complete, {
      provider: 'openai',
    });

    expect(complete.statusCode).toBe(200);
    expect(connectService.completeApiKey).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      attemptId: 'attempt_1',
      state: 'state_1',
      signature: 'sig_1',
      apiKey: 'sk-submit-only-here',
      accountLabel: 'Alice',
      auth: {
        type: 'solid',
        webId: WEB_ID,
      },
    });
    expect(JSON.parse(complete.body)).not.toHaveProperty('deployment');
  });

  it('persists browser-assisted API keys through the production management handler and Pod repository without plaintext serialization', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: { getTrustedFetch: vi.fn(async () => fetch) },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: () => ({
          values: (value: any) => ({
            execute: async () => {
              rows.set(value.id, jsonClone(value));
              return [jsonClone(value)];
            },
          }),
        }),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: async (_resource: unknown, id: string, patch: Record<string, unknown>) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return jsonClone(row);
        },
      } as any),
    });
    const connectService = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      adapters: [
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'openai',
          consoleUrl: 'https://platform.openai.com/api-keys',
          attempts: new InMemoryConnectAttemptStore(),
          credentialRepository: repository,
          deployment: 'cloud',
          signingSecret: 'connect-signing-secret',
          randomBytes: () => Buffer.alloc(32, 17),
          now: () => new Date('2026-07-30T00:00:00.000Z'),
        }),
      ],
    });
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      connectService,
    });
    const auth = { type: 'solid' as const, webId: WEB_ID };
    const begin = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](request(auth, {
      mode: 'browserAssistedApiKey',
    }), begin, { provider: 'openai' });
    const attempt = JSON.parse(begin.body);

    const complete = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/complete-api-key'](request(auth, {
      attemptId: attempt.attemptId,
      state: attempt.state,
      signature: attempt.signature,
      apiKey: 'sk-production-management-path',
      accountLabel: 'Alice OpenAI',
    }), complete, { provider: 'openai' });

    expect(complete.statusCode).toBe(200);
    expect(JSON.parse(complete.body)).toMatchObject({
      provider: 'openai',
      status: 'completed',
      credentialId: 'credentials.ttl#cloud-openai',
    });
    const serializedPodRows = JSON.stringify([...rows.values()]);
    expect(serializedPodRows).toContain('"storageMode":"plaintext-v1"');
    expect(serializedPodRows).toContain('"secretPayload"');
    expect(serializedPodRows).toContain('sk-production-management-path');

    const reload = response();
    await routes['GET /api/ai/connections/providers'](request(auth), reload, {});
    const provider = JSON.parse(reload.body).data.find((item: any) => item.provider === 'openai');
    expect(provider).toMatchObject({
      provider: 'openai',
      status: 'connected',
      authMode: 'apiKey',
      accountLabel: 'Alice OpenAI',
      connect: expect.objectContaining({ configured: true }),
    });
    expect(JSON.stringify(provider)).not.toContain('encryptedSecret');
    expect(JSON.stringify(provider)).not.toContain('sk-production-management-path');

    const remove = response();
    await routes['DELETE /api/ai/gateway/providers/:provider/connect'](request(auth), remove, {
      provider: 'openai',
    });
    expect(JSON.parse(remove.body).record).toMatchObject({
      id: 'credentials.ttl#cloud-openai',
      provider: 'openai',
      status: 'revoked',
    });
    expect(JSON.stringify(remove.body)).not.toContain('sk-production-management-path');
  });

  it('allows owner-bound internal invocation tokens through management key, provider, quota and connect routes', async () => {
    const { repository, authenticator, issuer } = invocationHarness();
    const issued = await issuer.issue({ auth: { type: 'solid', webId: WEB_ID } });
    const connectService = {
      listProviders: vi.fn(async () => [
        { provider: 'openai', status: 'disconnected', connect: { modes: ['browserAssistedApiKey'], configured: true } },
      ]),
      begin: vi.fn(async (input: any) => ({
        mode: input.requestedMode,
        status: 'pending',
        provider: input.provider,
        attemptId: 'attempt_1',
      })),
    } as any;
    const quotaService = {
      status: vi.fn(async () => ({
        credential: 'credentials.ttl#cloud-openai',
        status: 'unsupported',
        windows: [],
        observedAt: '2026-07-30T00:00:00.000Z',
        expiresAt: '2026-07-30T00:05:00.000Z',
        source: 'openai:no-credential-quota-api',
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'cloud',
      connectService,
      quotaService,
      keyId: () => 'gak_internal_created',
      now: () => new Date('2026-07-30T00:00:00.000Z'),
    });

    const createKey = response();
    await routes['POST /api/ai/gateway/keys'](await requestWithBearer(authenticator, issued.gatewayKey, {
      name: 'Internal setup',
      owner: OTHER_WEB_ID,
      scopes: ['models:read'],
    }), createKey, {});
    const providers = response();
    await routes['GET /api/ai/connections/providers'](await requestWithBearer(authenticator, issued.gatewayKey), providers, {});
    const quota = response();
    await routes['GET /api/ai/gateway/providers/:provider/quota/status'](
      await requestWithBearer(authenticator, issued.gatewayKey),
      quota,
      { provider: 'openai' },
    );
    const connect = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](
      await requestWithBearer(authenticator, issued.gatewayKey, { mode: 'browserAssistedApiKey' }),
      connect,
      { provider: 'openai' },
    );

    expect(createKey.statusCode).toBe(201);
    expect(JSON.parse(createKey.body).record).toMatchObject({
      id: 'gak_internal_created',
      owner: WEB_ID,
      scopes: ['models:read'],
    });
    expect(providers.statusCode).toBe(200);
    expect(quota.statusCode).toBe(200);
    expect(connect.statusCode).toBe(200);
    expect(connectService.listProviders).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      auth: expect.objectContaining({ internalInvocation: true }),
    }));
    expect(quotaService.status).toHaveBeenCalledWith(expect.objectContaining({ webId: WEB_ID }));
    expect(connectService.begin).toHaveBeenCalledWith(expect.objectContaining({ webId: WEB_ID }));
  });

  it('keeps management routes closed to wrong-owner, expired, insufficient-scope and regular Gateway keys', async () => {
    const now = new Date('2026-07-30T00:00:00.000Z');
    const { repository, authenticator, issuer } = invocationHarness({ now });
    const aliceIssued = await issuer.issue({ auth: { type: 'solid', webId: WEB_ID } });
    const bobIssued = await issuer.issue({ auth: { type: 'solid', webId: OTHER_WEB_ID } });
    await repository.create({
      id: 'gak_alice',
      owner: WEB_ID,
      deployment: 'cloud',
      secretHash: 'unused',
      scopes: ['models:read'],
      createdAt: now,
    });
    const { plaintext: regularGatewayKey, record: regularRecord } = await createGatewayApiKey({
      deployment: 'cloud',
      keyId: 'gak_regular',
      secret: 'regular-secret',
    });
    await repository.create({
      ...regularRecord,
      owner: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: now,
    });
    const expiredHarness = invocationHarness({
      now: new Date('2026-07-30T00:00:00.000Z'),
      ttlMs: 60_000,
    });
    const expiredIssued = await expiredHarness.issuer.issue({ auth: { type: 'solid', webId: WEB_ID } });
    const expiredAuthenticator = new GatewayApiKeyAuthenticator({
      repository,
      invocationTokenCodec: expiredHarness.codec,
      deployment: 'cloud',
      invocationTokenAudience: 'https://pod.example',
      now: () => new Date('2026-07-30T00:02:00.000Z'),
    });
    const insufficientScopeCodec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'management-invocation-secret' },
    });
    const insufficientScopeToken = insufficientScopeCodec.encode({
      deployment: 'cloud',
      audience: 'https://pod.example',
      issuer: 'https://pod.example',
      webId: WEB_ID,
      scopes: ['models:read'],
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const insufficientScopeAuthenticator = new GatewayApiKeyAuthenticator({
      repository,
      invocationTokenCodec: insufficientScopeCodec,
      deployment: 'cloud',
      invocationTokenAudience: 'https://pod.example',
      now: () => now,
    });
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository,
      deployment: 'cloud',
      connectService: { listProviders: vi.fn(async () => []) } as any,
      quotaService: { status: vi.fn(async () => ({})) } as any,
    });

    const bobDeleteAlice = response();
    await routes['DELETE /api/ai/gateway/keys/:keyId'](
      await requestWithBearer(authenticator, bobIssued.gatewayKey),
      bobDeleteAlice,
      { keyId: 'gak_alice' },
    );
    const regularProviderList = response();
    await routes['GET /api/ai/connections/providers'](
      await requestWithBearer(authenticator, regularGatewayKey),
      regularProviderList,
      {},
    );
    const regularQuota = response();
    await routes['GET /api/ai/gateway/providers/:provider/quota/status'](
      await requestWithBearer(authenticator, regularGatewayKey),
      regularQuota,
      { provider: 'openai' },
    );
    const regularConnect = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](
      await requestWithBearer(authenticator, regularGatewayKey, { mode: 'browserAssistedApiKey' }),
      regularConnect,
      { provider: 'openai' },
    );
    const expiredKeyCreate = response();
    await routes['POST /api/ai/gateway/keys'](
      await requestWithBearer(expiredAuthenticator, expiredIssued.gatewayKey, {}),
      expiredKeyCreate,
      {},
    );
    const insufficientScopeKeyCreate = response();
    await routes['POST /api/ai/gateway/keys'](
      await requestWithBearer(insufficientScopeAuthenticator, insufficientScopeToken, {}),
      insufficientScopeKeyCreate,
      {},
    );
    const aliceDeleteAlice = response();
    await routes['DELETE /api/ai/gateway/keys/:keyId'](
      await requestWithBearer(authenticator, aliceIssued.gatewayKey),
      aliceDeleteAlice,
      { keyId: 'gak_alice' },
    );

    expect(bobDeleteAlice.statusCode).toBe(403);
    expect(regularProviderList.statusCode).toBe(403);
    expect(regularQuota.statusCode).toBe(403);
    expect(regularConnect.statusCode).toBe(403);
    expect(expiredKeyCreate.statusCode).toBe(401);
    expect(insufficientScopeKeyCreate.statusCode).toBe(401);
    expect(aliceDeleteAlice.statusCode).toBe(200);
  });

  it('rejects gateway API key principals from managing provider Connect state', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      connectService: { begin: vi.fn() } as any,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](request({
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
    } as any, {
      mode: 'browserAssistedApiKey',
    }), res, {
      provider: 'openai',
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Gateway API keys cannot manage provider Connect state' });
  });

  it('does not accept plaintext refresh tokens through the provider Connect refresh API', async () => {
    const connectService = {
      refresh: vi.fn(async () => undefined),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/connect/refresh'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      refreshToken: 'must-not-leave-handler',
    }), res, {
      provider: 'kimi',
    });

    expect(res.statusCode).toBe(200);
    expect(connectService.refresh).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      auth: {
        type: 'solid',
        webId: WEB_ID,
      },
    });
  });
});
