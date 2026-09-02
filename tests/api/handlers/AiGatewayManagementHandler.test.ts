import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import { registerAiClientConfigurationRoutes } from '../../../src/api/handlers/AiClientConfigurationHandler';
import { AiConnectionsInvocationKeyIssuer } from '../../../src/api/ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../../../src/api/ai-gateway/auth/InvocationTokenCodec';
import { InvocationTokenAuthenticator } from '../../../src/api/ai-gateway/auth/InvocationTokenAuthenticator';
import type {
  GatewayAccessKeyRecord,
  GatewayAccessKeyRepository,
} from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import {
  BrowserAssistedApiKeyConnectAdapter,
  InMemoryConnectAttemptStore,
  PodConnectedCredentialRepository,
  ProviderConnectService,
} from '../../../src/api/ai-gateway/connect';
import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type {
  KeyWrapContext,
  KeyWrapper,
  WrappedDataKey,
} from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';

function callerOwnedAuth(webId = WEB_ID, accessToken = 'caller-owned-access-token'): AuthenticatedRequest['auth'] {
  return {
    type: 'solid',
    webId,
    viaApiKey: true,
    accessToken,
    tokenType: 'Bearer',
  };
}

class StaticKeyWrapper implements KeyWrapper {
  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    return {
      algorithm: 'test-static-wrap',
      keyId: `${context.webId}|${context.credentialIri}|${context.provider}`,
      wrappedDek: Buffer.from(dek).toString('base64url'),
    };
  }

  public async unwrapDek(_context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(wrapped.wrappedDek, 'base64url'));
  }
}

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      patch: vi.fn((path: string, handler: Function) => { routes[`PATCH ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      put: vi.fn((path: string, handler: Function) => { routes[`PUT ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth'], body?: unknown): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'POST';
  req.url = '/api/ai/connections/providers';
  req.headers = {};
  req.auth = auth;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function bearerRequest(token: string, url: string, method = 'GET'): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = method;
  req.url = url;
  req.headers = { authorization: `Bearer ${token}` };
  req.end();
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

describe('AiGatewayManagementHandler', () => {
  it('requires Solid authentication for the AI Connection service-access descriptor', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
      },
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request(undefined), res, {});

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Authentication required' });
  });

  it('uses the authenticated WebID for interactive service access when no service identity is configured', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      service: {
        webId: WEB_ID,
      },
      resources: expect.arrayContaining([
        expect.objectContaining({
          url: 'https://id.example/alice/settings/credentials.ttl',
        }),
      ]),
    });
  });

  it('returns a structured unavailable response when the configured service identity cannot be resolved', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => {
          throw new Error('Gateway internal Pod token exchange failed: HTTP 503');
        }),
      },
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: 'ai_connection_service_access_unavailable',
      message: 'AI Connection service access is temporarily unavailable',
    });
    expect(res.body).not.toContain('token exchange');
  });

  it('keeps local interactive service access usable when a remembered internal service identity is stale', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'local',
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => {
          throw new Error('stale local client credentials');
        }),
      },
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      service: { webId: WEB_ID },
    });
    expect(res.body).not.toContain('stale local client credentials');
  });

  it('returns a structured unavailable response when the invocation key cannot be issued', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
      },
      aiConnectionInvocationKeyIssuer: {
        issue: vi.fn(async () => {
          throw new Error('invocation key signing key is not configured');
        }),
        issueClientConfiguration: vi.fn(),
      },
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: 'ai_connection_service_access_unavailable',
      message: 'AI Connection service access is temporarily unavailable',
    });
    expect(res.body).not.toContain('signing key');
  });

  it('publishes AI Connection service-access resources derived only from the authenticated WebID', async () => {
    const servicePrincipal = {
      getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      servicePrincipal,
    });
    const req = request({
      type: 'solid',
      webId: 'https://pod.example/bob/profile/card#me',
    });
    req.url = '/api/applets/service-access/ai-connections?resource=https%3A%2F%2Fevil.example%2Fcredentials.ttl';
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](req, res, {});

    expect(res.statusCode).toBe(200);
    expect(servicePrincipal.getServicePrincipal).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.body)).toMatchObject({
      appletId: 'co.undefineds.ai-connections',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
      },
      resources: expect.arrayContaining([
        expect.objectContaining({
          url: 'https://pod.example/bob/settings/credentials.ttl',
        }),
      ]),
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('evil.example');
  });

  it('includes a short-lived owner-bound client-configuration invocation token in the AI Connection service-access response', async () => {
    const issue = vi.fn(async () => ({
      baseUrl: 'https://pod.example',
      apiKey: 'xpod_inv_v1.provider-owner-token',
      expiresAt: '2026-07-30T00:10:00.000Z',
    }));
    const issueClientConfiguration = vi.fn(async (context: unknown) => ({
      baseUrl: 'https://pod.example',
      apiKey: 'xpod_inv_v1.client-config-owner-token',
      expiresAt: '2026-07-30T00:10:00.000Z',
    }));
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
      },
      aiClientConfiguration: {
        available: true,
        authority: 'local-filesystem',
        manualInstructions: 'Configure clients manually if local filesystem access is unavailable.',
      },
      aiConnectionInvocationKeyIssuer: { issue, issueClientConfiguration },
    });
    const auth = {
      type: 'solid' as const,
      webId: WEB_ID,
      accessToken: 'browser-solid-token',
      tokenType: 'DPoP' as const,
    };
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request(auth), res, {});

    expect(issue).toHaveBeenCalledWith({ auth });
    expect(issueClientConfiguration).toHaveBeenCalledWith({ auth });
    expect(JSON.parse(res.body)).toMatchObject({
      invocation: {
        baseUrl: 'https://pod.example',
        apiKey: 'xpod_inv_v1.provider-owner-token',
        expiresAt: '2026-07-30T00:10:00.000Z',
      },
      aiClientConfiguration: {
        available: true,
        invocation: {
          baseUrl: 'https://pod.example',
          apiKey: 'xpod_inv_v1.client-config-owner-token',
          expiresAt: '2026-07-30T00:10:00.000Z',
        },
      },
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('browser-solid-token');
  });

  it('service-access invocation token authenticates client-configuration handlers with client-config scopes', async () => {
    const now = new Date('2026-08-14T00:00:00.000Z');
    const codec = new AesInvocationTokenCodec({
      active: { kid: 'active', secret: 'service-access-invocation-secret' },
    });
    const issuer = new AiConnectionsInvocationKeyIssuer({
      codec,
      deployment: 'cloud',
      baseUrl: 'https://pod.example',
      audience: 'https://pod.example',
      now: () => now,
    });
    const invocationAuthenticator = new InvocationTokenAuthenticator({
      codec,
      deployment: 'cloud',
      audience: 'https://pod.example',
      now: () => now,
    });
    const service = {
      inspect: vi.fn(async () => ({
        client: 'codex',
        configured: false,
      })),
      capability: vi.fn(() => ({ available: true, authority: 'local-filesystem' })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      aiConnectionInvocationKeyIssuer: issuer,
      aiClientConfiguration: {
        available: true,
        authority: 'local-filesystem',
        manualInstructions: 'Configure clients manually if local filesystem access is unavailable.',
      },
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
      },
    });
    registerAiClientConfigurationRoutes(server, { service });
    const serviceAccess = response();

    await routes['GET /api/applets/service-access/ai-connections'](request({
      type: 'solid',
      webId: WEB_ID,
      accessToken: 'browser-solid-token',
      tokenType: 'DPoP',
    }), serviceAccess, {});

    const body = JSON.parse(serviceAccess.body);
    const invocation = body.aiClientConfiguration.invocation;
    const providerInvocation = body.invocation;
    expect(providerInvocation.apiKey).not.toBe(invocation.apiKey);
    await expect(invocationAuthenticator.authenticate(bearerRequest(providerInvocation.apiKey, '/api/ai/client-configuration/codex')))
      .resolves
      .toMatchObject({
        success: false,
        statusCode: 401,
      });
    const clientConfigRequest = request(undefined);
    clientConfigRequest.method = 'GET';
    clientConfigRequest.url = '/api/ai/client-configuration/codex';
    clientConfigRequest.headers.authorization = `Bearer ${invocation.apiKey}`;
    const authResult = await invocationAuthenticator.authenticate(clientConfigRequest);
    expect(authResult).toMatchObject({
      success: true,
      context: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
        scopes: ['client-config:read', 'client-config:write'],
      },
    });
    if (!authResult.success) throw new Error('Expected invocation token authentication to succeed');
    clientConfigRequest.auth = authResult.context;
    const clientConfig = response();

    await routes['GET /api/ai/client-configuration/:client'](clientConfigRequest, clientConfig, { client: 'codex' });

    expect(clientConfig.statusCode).toBe(200);
    expect(service.inspect).toHaveBeenCalledWith('codex');
    expect(JSON.parse(clientConfig.body)).toMatchObject({ client: 'codex', configured: false });
  });

  it('includes a safe AI client configuration capability descriptor in service-access when local host support is explicit', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'local',
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
      },
      aiClientConfiguration: {
        available: true,
        authority: 'local-filesystem',
        manualInstructions: 'Configure clients manually if local filesystem access is unavailable.',
      },
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request({
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
      deployment: 'cloud',
      servicePrincipal: {
        getServicePrincipal: vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' })),
      },
    });
    const res = response();

    await routes['GET /api/applets/service-access/ai-connections'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).aiClientConfiguration).toEqual({
      available: false,
      manualInstructions: expect.any(String),
    });
  });

  it('keeps listed Gateway API key masking aligned with recoverable plaintext', async () => {
    const plaintext = 'xpod_gw_v1_local_gakv1.default.public_locator_secretTail';
    const record: GatewayAccessKeyRecord = {
      id: 'gakv1.default.public_locator',
      owner: WEB_ID,
      secretHash: 'hash',
      deployment: 'local',
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      name: 'Web persistent acceptance 20260828',
    };
    const repository = {
      listByOwner: vi.fn(async () => [record]),
      revealPlaintext: vi.fn(async (id: string) => id === record.id ? plaintext : undefined),
    } as unknown as GatewayAccessKeyRepository;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'local',
      gatewayAccessKeyRepository: repository,
    });
    const res = response();

    await routes['GET /api/ai/gateway/keys'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0]).toMatchObject({
      id: record.id,
      plaintextAvailable: true,
      suffix: 'cretTail',
      maskedHint: '••••••••cretTail',
    });
    expect(res.body).not.toContain(plaintext);
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
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('clientId');
  });

  it('rejects provider Connect begin requests that include a clientId', async () => {
    const connectService = {
      begin: vi.fn(),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      mode: 'deviceCodeOAuth',
      clientId: 'attacker-client-id',
    }), res, {
      provider: 'kimi',
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'clientId is not accepted' });
    expect(connectService.begin).not.toHaveBeenCalled();
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
        oauthCredential: {
          accessToken: 'one-time-access',
          refreshToken: 'one-time-refresh',
          expiresAt: '2026-08-09T08:00:00.000Z',
        },
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
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
    expect(JSON.parse(pollResponse.body)).toMatchObject({
      oauthCredential: {
        accessToken: 'one-time-access',
        refreshToken: 'one-time-refresh',
      },
    });
    expect(JSON.stringify(JSON.parse(pollResponse.body))).not.toContain('client_secret');
    expect(connectService.status).toHaveBeenCalledWith(expect.objectContaining({ deployment: 'cloud' }));
    expect(connectService.pollDevice).toHaveBeenCalledWith(expect.objectContaining({ deployment: 'cloud' }));
  });

  it('keeps browser-assisted API key completion on authenticated management API, never public callback', async () => {
    const connectService = {
      completeApiKey: vi.fn(async () => ({ mode: 'browserAssistedApiKey', status: 'completed' })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
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
      baseUrl: 'https://gateway.example/v1',
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
      baseUrl: 'https://gateway.example/v1',
      auth: {
        type: 'solid',
        webId: WEB_ID,
      },
    });
    expect(JSON.parse(complete.body)).not.toHaveProperty('deployment');
  });

  it('maps legacy provider Connect operation errors instead of leaking raw route failures', async () => {
    const auth = { type: 'solid' as const, webId: WEB_ID };

    const completeService = {
      completeApiKey: vi.fn(async () => {
        throw new Error('Connect attempt not found');
      }),
    } as any;
    const completeServer = createServer();
    registerAiGatewayManagementRoutes(completeServer.server, {
      deployment: 'cloud',
      connectService: completeService,
    });
    const complete = response();
    await expect(completeServer.routes['POST /api/ai/gateway/providers/:provider/connect/complete-api-key'](
      request(auth, {
        attemptId: 'attempt_missing',
        state: 'state_1',
        signature: 'sig_1',
        apiKey: 'sk-test',
      }),
      complete,
      { provider: 'openai' },
    )).resolves.toBeUndefined();
    expect(complete.statusCode).toBe(404);
    expect(JSON.parse(complete.body)).toEqual({ error: 'Provider Connect attempt not found' });

    const refreshService = {
      refreshCallerOwned: vi.fn(async () => {
        throw new Error('provider_credential_not_found');
      }),
    } as any;
    const refreshServer = createServer();
    registerAiGatewayManagementRoutes(refreshServer.server, {
      deployment: 'cloud',
      connectService: refreshService,
    });
    const refresh = response();
    await expect(refreshServer.routes['POST /api/ai/gateway/providers/:provider/connect/refresh'](
      request(auth, { credentialId: 'missing_credential', refreshToken: 'refresh', expectedVersion: 1 }),
      refresh,
      { provider: 'kimi' },
    )).resolves.toBeUndefined();
    expect(refresh.statusCode).toBe(404);
    expect(JSON.parse(refresh.body)).toEqual({ error: 'Provider credential not found for current identity' });

    const disconnectService = {
      disconnect: vi.fn(async () => {
        throw new Error('service_access_missing');
      }),
    } as any;
    const disconnectServer = createServer();
    registerAiGatewayManagementRoutes(disconnectServer.server, {
      deployment: 'cloud',
      connectService: disconnectService,
    });
    const disconnect = response();
    await expect(disconnectServer.routes['DELETE /api/ai/gateway/providers/:provider/connect'](
      request(auth),
      disconnect,
      { provider: 'kimi' },
    )).resolves.toBeUndefined();
    expect(disconnect.statusCode).toBe(403);
    expect(JSON.parse(disconnect.body)).toEqual({ error: 'service_access_missing' });

    const unsupportedService = {
      refreshCallerOwned: vi.fn(async () => {
        throw new Error('credential_collection_query_unsupported');
      }),
    } as any;
    const unsupportedServer = createServer();
    registerAiGatewayManagementRoutes(unsupportedServer.server, {
      deployment: 'cloud',
      connectService: unsupportedService,
    });
    const unsupported = response();
    await expect(unsupportedServer.routes['POST /api/ai/gateway/providers/:provider/connect/refresh'](
      request(auth, { credentialId: 'credential_1', refreshToken: 'refresh', expectedVersion: 1 }),
      unsupported,
      { provider: 'kimi' },
    )).resolves.toBeUndefined();
    expect(unsupported.statusCode).toBe(501);
    expect(JSON.parse(unsupported.body)).toMatchObject({
      error: 'credential_collection_query_unsupported',
    });
  });

  it('persists browser-assisted API keys through the production management handler and Pod repository without plaintext serialization', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const internalPodAccess = { getTrustedFetch: vi.fn(async () => fetch) };
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess,
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
        update: () => ({
          set: (patch: Record<string, unknown>) => ({
            where: () => ({
              returning: () => ({
                execute: async () => {
                  const row = [...rows.values()][0];
                  if (!row) return [];
                  Object.assign(row, patch);
                  rows.set(String(row.id), row);
                  return [jsonClone(row)];
                },
              }),
            }),
          }),
        }),
      } as any),
    });
    const vault = new WebCryptoCredentialVault({ keyWrapper: new StaticKeyWrapper() });
    const connectService = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault,
      adapters: [
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'openai',
          consoleUrl: 'https://platform.openai.com/api-keys',
          attempts: new InMemoryConnectAttemptStore(),
          credentialRepository: repository,
          vault,
          deployment: 'cloud',
          signingSecret: 'connect-signing-secret',
          randomBytes: () => Buffer.alloc(32, 17),
          now: () => new Date('2026-07-30T00:00:00.000Z'),
        }),
      ],
    });
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const auth = callerOwnedAuth(WEB_ID, 'solid-access-token');
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
      baseUrl: 'https://proxy.example/v1',
    }), complete, { provider: 'openai' });

    expect(complete.statusCode).toBe(200);
    expect(JSON.parse(complete.body)).toMatchObject({
      provider: 'openai',
      status: 'completed',
      credentialId: 'credentials.ttl#cloud-openai',
    });
    const serializedPodRows = JSON.stringify([...rows.values()]);
    expect(serializedPodRows).toContain('https://id.example/alice/settings/credentials.ttl#cloud-openai');
    expect(serializedPodRows).not.toContain('sk-production-management-path');

    const reload = response();
    await routes['GET /api/ai/connections/providers'](request(auth), reload, {});
    const provider = JSON.parse(reload.body).data.find((item: any) => item.provider === 'openai');
    expect(provider).toMatchObject({
      provider: 'openai',
      status: 'connected',
      authMode: 'apiKey',
      accountLabel: 'Alice OpenAI',
      baseUrl: 'https://proxy.example/v1',
      connect: expect.objectContaining({ configured: true }),
    });
    expect(JSON.stringify(provider)).not.toContain('encryptedSecret');
    expect(JSON.stringify(provider)).not.toContain('sk-production-management-path');

    const pool = response();
    await routes['GET /api/ai/providers'](request(auth), pool, {});
    const openAiPool = JSON.parse(pool.body).data.find((item: any) => item.id === 'openai');
    expect(openAiPool.credentials).toEqual([
      expect.objectContaining({
        id: 'credentials.ttl#cloud-openai',
        provider: 'openai',
        authMode: 'apiKey',
        label: 'Alice OpenAI',
        enabled: true,
      }),
    ]);
    expect(JSON.stringify(openAiPool)).not.toContain('encryptedSecret');
    expect(JSON.stringify(openAiPool)).not.toContain('sk-production-management-path');

    const remove = response();
    await routes['DELETE /api/ai/gateway/providers/:provider/connect'](request(auth), remove, {
      provider: 'openai',
    });
    expect(JSON.parse(remove.body).record).toMatchObject({
      id: 'credentials.ttl#cloud-openai',
      provider: 'openai',
      status: 'revoked',
    });
    expect(JSON.stringify([...rows.values()])).not.toContain('sk-production-management-path');
    expect(internalPodAccess.getTrustedFetch).not.toHaveBeenCalled();
  });

  it('allows owner-bound internal invocation principals through provider, quota and connect routes', async () => {
    const internalAuth = {
      type: 'solid' as const,
      webId: WEB_ID,
      accountId: WEB_ID,
      viaGatewayApiKey: true,
      internalInvocation: true,
      gatewayKeyId: 'invocation-jti',
      scopes: ['models:read', 'inference:write'],
      tokenType: 'Bearer' as const,
    };
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
      deployment: 'cloud',
      connectService,
      quotaService,
    });

    const providers = response();
    await routes['GET /api/ai/connections/providers'](request(internalAuth as any), providers, {});
    const quota = response();
    await routes['GET /api/ai/gateway/providers/:provider/quota/status'](
      request(internalAuth as any),
      quota,
      { provider: 'openai' },
    );
    const connect = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](
      request(internalAuth as any, { mode: 'browserAssistedApiKey' }),
      connect,
      { provider: 'openai' },
    );

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

  it('keeps management routes closed to regular Gateway key principals', async () => {
    const gatewayKeyAuth = {
      type: 'solid' as const,
      webId: WEB_ID,
      accountId: WEB_ID,
      viaGatewayApiKey: true,
      gatewayKeyId: 'gak_regular',
      scopes: ['models:read', 'inference:write'],
      tokenType: 'Bearer' as const,
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService: {
        listProviders: vi.fn(async () => []),
        begin: vi.fn(),
      } as any,
      quotaService: { status: vi.fn(async () => ({})) } as any,
    });

    const regularProviderList = response();
    await routes['GET /api/ai/connections/providers'](
      request(gatewayKeyAuth as any),
      regularProviderList,
      {},
    );
    const regularQuota = response();
    await routes['GET /api/ai/gateway/providers/:provider/quota/status'](
      request(gatewayKeyAuth as any),
      regularQuota,
      { provider: 'openai' },
    );
    const regularConnect = response();
    await routes['POST /api/ai/gateway/providers/:provider/connect/begin'](
      request(gatewayKeyAuth as any, { mode: 'browserAssistedApiKey' }),
      regularConnect,
      { provider: 'openai' },
    );

    expect(regularProviderList.statusCode).toBe(403);
    expect(regularQuota.statusCode).toBe(403);
    expect(regularConnect.statusCode).toBe(403);
  });

  it('rejects gateway API key principals from managing provider Connect state', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
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

  it('passes only the transient refresh input through caller-owned OAuth refresh', async () => {
    const connectService = {
      refreshCallerOwned: vi.fn(async () => ({
        mode: 'deviceCodeOAuth',
        status: 'completed',
        provider: 'kimi',
        credentialId: 'cloud-kimi-oauth',
        oauthCredential: { accessToken: 'next-access', refreshToken: 'next-refresh', expectedVersion: 3 },
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/connect/refresh'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      refreshToken: 'must-not-leave-handler',
      credentialId: 'cloud-kimi-oauth',
      expectedVersion: 3,
    }), res, {
      provider: 'kimi',
    });

    expect(res.statusCode).toBe(200);
    expect(connectService.refreshCallerOwned).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'cloud-kimi-oauth',
      refreshToken: 'must-not-leave-handler',
      expectedVersion: 3,
      auth: {
        type: 'solid',
        webId: WEB_ID,
      },
    });
    expect(JSON.parse(res.body)).toMatchObject({ oauthCredential: { refreshToken: 'next-refresh' } });
    expect(res.body).not.toContain('must-not-leave-handler');
  });

  it('passes an optional credentialId through provider Connect disconnect', async () => {
    const connectService = {
      disconnect: vi.fn(async () => ({
        id: 'cloud-kimi-oauth',
        credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth',
        provider: 'kimi',
        deployment: 'cloud',
        authMode: 'deviceCodeOAuth',
        status: 'revoked',
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const req = request({ type: 'solid', webId: WEB_ID });
    req.url = '/api/ai/gateway/providers/kimi/connect?credentialId=cloud-kimi-oauth';
    const res = response();

    await routes['DELETE /api/ai/gateway/providers/:provider/connect'](req, res, {
      provider: 'kimi',
    });

    expect(res.statusCode).toBe(200);
    expect(connectService.disconnect).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'cloud-kimi-oauth',
      auth: {
        type: 'solid',
        webId: WEB_ID,
      },
    });
  });

  it('returns grouped provider credential pools without credential secrets', async () => {
    const connectService = {
      listProviderCredentialPools: vi.fn(async () => [
        {
          id: 'kimi',
          name: 'Kimi',
          status: 'available',
          offerings: [{ id: 'api-platform', label: 'API Platform' }],
          credentials: [
            {
              id: 'kimi-key-a',
              credentialIri: 'https://id.example/alice/settings/credentials.ttl#kimi-key-a',
              webId: WEB_ID,
              provider: 'kimi',
              deployment: 'cloud',
              offeringId: 'api-platform',
              authMode: 'apiKey',
              accountLabel: 'Alice Kimi',
              label: 'Alice Kimi',
              enabled: true,
              priority: 10,
              health: 'healthy',
              status: 'active',
              baseUrl: 'https://api.moonshot.cn/v1',
              maskedHint: 'sk-...abcd',
              version: 3,
              expiresAt: new Date('2026-08-01T00:00:00.000Z'),
              encryptedSecret: { algorithm: 'test', wrappedDek: 'wrapped', ciphertext: 'cipher' },
              refreshToken: 'refresh-secret',
              apiKey: 'sk-secret',
              metadata: {
                encryptedSecret: 'nested-secret',
                apiKey: 'nested-api-key',
                quota: { status: 'ok', remaining: 42 },
              },
            },
          ],
          selectedModels: [{ id: 'moonshot-v1-8k', provider: 'kimi' }],
        },
      ]),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['GET /api/ai/providers'](request({ type: 'solid', webId: WEB_ID }), res, {});

    expect(res.statusCode).toBe(200);
    expect(connectService.listProviderCredentialPools).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: { type: 'solid', webId: WEB_ID },
    });
    expect(JSON.parse(res.body)).toEqual({
      data: [
        {
          id: 'kimi',
          name: 'Kimi',
          status: 'available',
          offerings: [{ id: 'api-platform', label: 'API Platform' }],
          credentials: [
            {
              id: 'kimi-key-a',
              provider: 'kimi',
              offeringId: 'api-platform',
              authMode: 'apiKey',
              label: 'Alice Kimi',
              enabled: true,
              priority: 10,
              health: 'healthy',
              maskedHint: 'sk-...abcd',
              expiresAt: '2026-08-01T00:00:00.000Z',
              baseUrl: 'https://api.moonshot.cn/v1',
              version: 3,
              quota: { status: 'ok', remaining: 42 },
            },
          ],
          selectedModels: [{ id: 'moonshot-v1-8k', provider: 'kimi' }],
        },
      ],
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toMatch(/encryptedSecret|refreshToken|sk-secret|nested-api-key|wrapped|cipher/);
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('credentialIri');
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain(WEB_ID);
  });

  it('reports an unsupported Pod collection capability without a generic 500', async () => {
    const connectService = {
      listProviderCredentialPools: vi.fn(async () => {
        throw new Error('credential_collection_query_unsupported');
      }),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['GET /api/ai/providers'](request({ type: 'solid', webId: WEB_ID }), res, {});

    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'credential_collection_query_unsupported',
    });
  });

  it('creates API-key credentials in a provider pool without echoing plaintext secrets', async () => {
    const connectService = {
      createApiKeyCredential: vi.fn(async (input: any) => ({
        id: 'kimi-key-new',
        provider: input.provider,
        offeringId: input.offeringId,
        authMode: 'apiKey',
        accountLabel: input.label,
        enabled: true,
        priority: 30,
        health: 'healthy',
        status: 'active',
        maskedHint: 'sk-...tkey',
        version: 1,
        encryptedSecret: { ciphertext: 'cipher' },
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/providers/:provider/credentials/api-key'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      offeringId: 'api-platform',
      apiKey: 'sk-new-secret-key',
      label: 'Work key',
      baseUrl: 'https://api.moonshot.cn/v1',
      priority: 30,
    }), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(201);
    expect(connectService.createApiKeyCredential).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'api-platform',
      apiKey: 'sk-new-secret-key',
      label: 'Work key',
      baseUrl: 'https://api.moonshot.cn/v1',
      priority: 30,
      auth: { type: 'solid', webId: WEB_ID },
    });
    expect(JSON.parse(res.body)).toEqual({
      credential: expect.objectContaining({
        id: 'kimi-key-new',
        provider: 'kimi',
        offeringId: 'api-platform',
        authMode: 'apiKey',
        label: 'Work key',
      }),
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toMatch(/sk-new-secret-key|encryptedSecret|cipher/);
  });

  it('creates a local provider credential without accepting an API key', async () => {
    const connectService = {
      createLocalCredential: vi.fn(async (input: any) => ({
        id: 'ollama-local', provider: input.provider, offeringId: input.offeringId,
        authMode: 'local', enabled: true, priority: 10, health: 'healthy', version: 1,
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'local',
      connectService,
    });
    const res = response();
    await routes['POST /api/ai/providers/:provider/credentials/local'](request(
      { type: 'solid', webId: WEB_ID },
      { offeringId: 'local', baseUrl: 'http://localhost:11434/v1', priority: 10 },
    ), res, { provider: 'ollama' });
    expect(res.statusCode).toBe(201);
    expect(connectService.createLocalCredential).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID, provider: 'ollama', offeringId: 'local', baseUrl: 'http://localhost:11434/v1',
    }));
  });

  it('returns coded invalid_request errors for incompatible API-key offerings', async () => {
    const connectService = {
      createApiKeyCredential: vi.fn(async () => {
        throw new GatewayProtocolError('Provider offering is not compatible with API key credentials', {
          code: 'invalid_request',
          status: 400,
          details: { provider: 'kimi', offeringId: 'official-subscription' },
        });
      }),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/providers/:provider/credentials/api-key'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      offeringId: 'official-subscription',
      apiKey: 'sk-new-secret-key',
    }), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: 'invalid_request',
        message: 'Provider offering is not compatible with API key credentials',
        status: 400,
        details: { provider: 'kimi', offeringId: 'official-subscription' },
      },
    });
  });

  it('patches only allowlisted credential fields and requires expectedVersion', async () => {
    const connectService = {
      updateCredential: vi.fn(async (input: any) => ({
        id: input.credentialId,
        provider: input.provider,
        offeringId: 'api-platform',
        authMode: 'apiKey',
        accountLabel: input.patch.label,
        enabled: input.patch.enabled,
        priority: input.patch.priority,
        health: 'disabled',
        status: 'active',
        version: 8,
        metadata: { baseUrl: input.patch.baseUrl },
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });

    const missingVersion = response();
    await routes['PATCH /api/ai/providers/:provider/credentials/:credentialId'](request({
      type: 'solid',
      webId: WEB_ID,
    }, { enabled: false }), missingVersion, { provider: 'kimi', credentialId: 'kimi-key-a' });

    const patched = response();
    await routes['PATCH /api/ai/providers/:provider/credentials/:credentialId'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      label: 'Paused',
      enabled: false,
      priority: 5,
      baseUrl: 'https://api.moonshot.cn/v1',
      expectedVersion: 7,
      apiKey: 'must-be-ignored',
      status: 'revoked',
    }), patched, { provider: 'kimi', credentialId: 'kimi-key-a' });

    expect(missingVersion.statusCode).toBe(400);
    expect(JSON.parse(missingVersion.body)).toEqual({ error: 'expectedVersion is required' });
    expect(patched.statusCode).toBe(200);
    expect(connectService.updateCredential).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'kimi-key-a',
      expectedVersion: 7,
      patch: {
        label: 'Paused',
        enabled: false,
        priority: 5,
        baseUrl: 'https://api.moonshot.cn/v1',
      },
      auth: { type: 'solid', webId: WEB_ID },
    });
    expect(JSON.stringify(connectService.updateCredential.mock.calls[0][0])).not.toContain('must-be-ignored');
  });

  it('deletes one credential by id', async () => {
    const connectService = {
      revokeCredential: vi.fn(async (input: any) => ({
        id: input.credentialId,
        provider: input.provider,
        offeringId: 'api-platform',
        authMode: 'apiKey',
        enabled: false,
        priority: 10,
        health: 'disabled',
        status: 'revoked',
        version: 4,
      })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['DELETE /api/ai/providers/:provider/credentials/:credentialId'](request({
      type: 'solid',
      webId: WEB_ID,
    }), res, { provider: 'kimi', credentialId: 'kimi-key-a' });

    expect(res.statusCode).toBe(200);
    expect(connectService.revokeCredential).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'kimi-key-a',
      auth: { type: 'solid', webId: WEB_ID },
    }));
  });

  it('tests provider credentials without exposing probe secrets', async () => {
    const connectService = {
      testCredential: vi.fn(async () => ({
        status: 'ok',
        checkedAt: '2026-08-08T00:00:00.000Z',
        apiKey: 'must-not-return',
      })),
    } as any;
    const modelsService = { list: vi.fn() } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
      modelsService,
    });
    const res = response();

    await routes['POST /api/ai/providers/:provider/credentials/test'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      credentialId: 'kimi-key-a',
    }), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(200);
    expect(connectService.testCredential).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'kimi-key-a',
      modelsService,
      auth: { type: 'solid', webId: WEB_ID },
    });
    expect(JSON.parse(res.body)).toEqual({
      result: {
        status: 'ok',
        checkedAt: '2026-08-08T00:00:00.000Z',
      },
    });
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain('must-not-return');
  });

  it('rejects temporary API keys on provider credential test route', async () => {
    const connectService = {
      testCredential: vi.fn(),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/providers/:provider/credentials/test'](request({
      type: 'solid',
      webId: WEB_ID,
    }, {
      apiKey: 'sk-temporary',
    }), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'credentialId is required' });
    expect(connectService.testCredential).not.toHaveBeenCalled();
  });

  it('adds deprecation headers to legacy provider Connect routes', async () => {
    const connectService = {
      refreshCallerOwned: vi.fn(async () => ({ mode: 'deviceCodeOAuth', status: 'completed', provider: 'kimi' })),
    } as any;
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      connectService,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/connect/refresh'](request({
      type: 'solid',
      webId: WEB_ID,
    }, { credentialId: 'credential-1', refreshToken: 'refresh', expectedVersion: 1 }), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      deprecation: 'true',
      link: '</api/ai/providers>; rel="successor-version"',
    });
  });
});
