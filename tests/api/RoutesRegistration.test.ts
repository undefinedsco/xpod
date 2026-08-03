import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcmeCertificateManager } from '../../src/edge/acme/AcmeCertificateManager';
import {
  getEdgeNodeCertificateCapabilityBridge,
  hasEdgeNodeCertificateCapabilityBridge,
  resolveEdgeNodeCertificateCapabilityBridgeId,
} from '../../src/edge/EdgeNodeCertificateCapabilityBridge';

vi.mock('inngest/node', () => ({
  serve: vi.fn(() => vi.fn((_req: unknown, res: { end?: () => void }) => res.end?.())),
}));

import { registerRoutes } from '../../src/api/container/routes';
import type { ApiContainerConfig } from '../../src/api/container/types';
import type { ApiServer } from '../../src/api/ApiServer';
import { serve } from 'inngest/node';

const SAMPLE_CERT = `-----BEGIN CERTIFICATE-----
MIICvjCCAaYCCQCzYZphWIDKfjANBgkqhkiG9w0BAQsFADAhMR8wHQYDVQQDDBZu
b2RlLTEuY2x1c3Rlci5leGFtcGxlMB4XDTI1MTExMTA3MjYwMVoXDTI2MTExMTA3
MjYwMVowITEfMB0GA1UEAwwWbm9kZS0xLmNsdXN0ZXIuZXhhbXBsZTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAMUfvY61jRGXmOUCw/CKMdpfmLkH0tQs
3jmtMDcMHI73hudmJtRLavM+dcdRtlkb24s8QeYa3ZOpKp00/noTaOow2ItKFPiK
nQvEPGfjVShv65X5Tv6X1zcLNxCymRN2YTxfRrm8Niy1q6xsi2woeJjqwUw9ai56
eLUvoyvEtXakv11zY/v6SE6g9+X70J3cNf2+KnpHGrJ/g0hYSorzHHSDC8co+1+9
rQ+5FCDRcswZcLDST9Q1AzJrrTglM6LYUAtXZanTc664E8xRcdLMlmE3NseXBQFh
xc8x+qQ1JBk2si+ZYugjnqyU/ITUI02V7smcP6aM4ySYUtKZWoHStv0CAwEAATAN
BgkqhkiG9w0BAQsFAAOCAQEAMhHoYiNdKhNW8LY1/A0tPRY71bCryfu1QKXJDm+y
xRcUhHGTzTHvi/rE4T0/NaOGYlhQ1VYZ7BX4Q9p13AD3lDxF+n6X40EiaWzSs1+s
yJiI9w0CfzOLMwdt4db+7CBWXq95Bep8kEPLXrSqljG+qgdpWRY462EcRfszgUbR
FthYIl292Sn1BL6yh8snJyEE9KYFVmO6PQjB6vEODuhAZj2Twku1u7T6FyE8eJqN
jn64lJdLOW3uzhbxOETW8kNX6AyotU+E5l/3eeNT0v6w7A1Z0RkOm0Smg8nW8xKf
rfWd+Y8jP9+2OHWWDZb4Y/28T35JgI9qQ18eS3HoX1l0wQ==
-----END CERTIFICATE-----`;

describe('registerRoutes mode wiring', () => {
  let routes: Record<string, Function>;
  let mockServer: ApiServer;

  function storeRoute(method: string, path: string, handlerOrOptions: Function | { public?: boolean }, maybeOptions?: { public?: boolean }): void {
    const handler = typeof handlerOrOptions === 'function' ? handlerOrOptions : undefined;
    const options = typeof handlerOrOptions === 'function' ? maybeOptions : handlerOrOptions;
    void options;
    routes[`${method.toUpperCase()} ${path}`] = handler as Function;
  }

  const baseConfig: ApiContainerConfig = {
    edition: 'cloud',
    port: 3002,
    host: '0.0.0.0',
    authMode: 'acp',
    databaseUrl: 'postgres://example.invalid/xpod',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'https://id.undefineds.co/.oidc/token',
    subdomain: {
      baseStorageDomain: 'nodes.undefineds.co',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    routes = {};
    mockServer = {
      route: vi.fn((method: string, path: string, handler: Function, options?: { public?: boolean }) => {
        storeRoute(method, path, handler, options);
      }),
      get: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
        storeRoute('GET', path, handler, options);
      }),
      post: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
        storeRoute('POST', path, handler, options);
      }),
      put: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
        storeRoute('PUT', path, handler, options);
      }),
      delete: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
        storeRoute('DELETE', path, handler, options);
      }),
      patch: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
        storeRoute('PATCH', path, handler, options);
      }),
      all: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
        storeRoute('ALL', path, handler, options);
      }),
      addResponseHeaders: vi.fn(),
      addUpgradeHandler: vi.fn(),
      addShutdownHandler: vi.fn(),
    } as unknown as ApiServer;
  });

  function createContainer(
    edition: 'cloud' | 'local',
    overrides: {
      inngestRuntimeConfig?: unknown;
      rdfStorageStatsService?: unknown;
      config?: Partial<ApiContainerConfig>;
      services?: Record<string, unknown>;
    } = {},
  ): any {
    const config = { ...baseConfig, edition, ...overrides.config };
    const bridgeId = resolveEdgeNodeCertificateCapabilityBridgeId({ nodeId: config.nodeId, baseUrl: config.solidBaseUrl ?? config.publicUrl });
    const services: Record<string, unknown> = {
      apiServer: mockServer,
      config,
      nodeRepo: {},
      chatService: {},
      aiGatewayService: {
        complete: vi.fn(),
        execute: vi.fn(),
        listModels: vi.fn(),
      },
      chatKitService: {},
      chatKitStore: {
        listRuns: vi.fn(),
        loadRun: vi.fn(),
        loadRunSteps: vi.fn(),
      },
      matrixStore: {},
      clientReconcilerCoordinator: {},
      runExecutionBackend: {
        getClient: vi.fn(() => ({ id: 'test-inngest' })),
        agentRunFunction: {},
      },
      taskService: {},
      inngestTaskScheduler: {
        getFunctions: vi.fn(() => [{ id: 'task-due' }, { id: 'task-event' }]),
      },
      inngestRuntimeConfig: overrides.inngestRuntimeConfig ?? {
        enabled: true,
        durableDelivery: true,
        baseUrl: 'http://xpod-inngest:8288',
        eventKey: 'test-event-key',
        signingKey: 'signkey-test',
        functionEndpoint: 'http://xpod-api:3001/api/inngest',
      },
      rdfStorageStatsService: overrides.rdfStorageStatsService ?? {
        snapshot: vi.fn().mockResolvedValue({
          available: false,
          engine: 'unsupported',
          generatedAt: '2026-06-09T00:00:00.000Z',
          reason: 'not-cloud',
        }),
      },
      gatewayAccessKeyRepository: {},
      gatewayInternalPodAccess: {},
      hostedPodDataAccess: {
        getTrustedFetch: vi.fn(async () => fetch),
      },
      aiConnectionInvocationKeyIssuer: {
        issue: vi.fn(async () => undefined),
      },
      providerConnectService: {},
      db: {},
      podLookupRepo: {
        findByWebId: vi.fn(async () => undefined),
      },
      accountRoleRepo: {
        findByWebId: vi.fn(async () => undefined),
      },
      ddnsRepo: edition === 'cloud' ? {} : undefined,
      dnsProvider: edition === 'cloud' ? { upsertRecord: vi.fn(), deleteRecord: vi.fn() } : undefined,
      dnsCoordinator: edition === 'cloud' ? { synchronize: vi.fn() } : undefined,
      tunnelProvider: edition === 'cloud' ? {
        getStatus: vi.fn(() => ({ running: true, connected: true, endpoint: 'https://cloud-tunnel.example/' })),
        getEndpoint: vi.fn(() => 'https://cloud-tunnel.example/'),
      } : undefined,
      ddnsManager: edition === 'local' ? {
        getStatus: vi.fn(() => ({
          allocated: true,
          fqdn: 'local-node.undefineds.site',
          mode: 'tunnel',
          tunnelProvider: 'ngrok',
        })),
      } : undefined,
      localTunnelProvider: edition === 'local' ? {
        getStatus: vi.fn(() => ({ running: true, connected: true, endpoint: 'https://local-tunnel.example/' })),
        getEndpoint: vi.fn(() => 'https://local-tunnel.example/'),
      } : undefined,
      subdomainClient: edition === 'local' ? {} : undefined,
      edgeNodeCertificateCapabilityBridge: bridgeId ? getEdgeNodeCertificateCapabilityBridge(bridgeId) : undefined,
      ...overrides.services,
    };

    return {
      resolve(name: string, options?: { allowUnregistered?: boolean }) {
        if (name in services) {
          return services[name];
        }
        if (options?.allowUnregistered) {
          return undefined;
        }
        throw new Error(`Unexpected resolve: ${name}`);
      },
    };
  }

  function authedRequest(mode: 'read' | 'write' = 'read'): any {
    return {
      auth: {
        type: 'service',
        serviceType: 'cloud',
        serviceId: 'cloud-admin',
        scopes: [mode === 'write' ? 'network:write' : 'network:read'],
      },
      headers: {},
      method: 'GET',
      url: '/api/network/settings/status',
    };
  }

  function solidRequest(webId: string): any {
    return {
      auth: { type: 'solid', webId },
      headers: {},
      method: 'GET',
      url: '/api/network/settings/status',
    };
  }

  function jsonResponse(): any {
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

  it('registers cloud-only management routes in cloud mode', () => {
    registerRoutes(createContainer('cloud'));

    expect(routes['GET /:username/profile/card']).toBeUndefined();
    expect(routes['POST /api/v1/ddns/allocate']).toBeTypeOf('function');
    expect(routes['POST /provision/nodes']).toBeTypeOf('function');
    expect(routes['POST /v1/tasks']).toBeUndefined();
    expect(routes['POST /v1/tasks/materialize-due']).toBeUndefined();
    expect(routes['POST /v1/tasks/events/:eventName']).toBeUndefined();
    expect(routes['GET /v1/runs']).toBeTypeOf('function');
    expect(routes['GET /v1/runs/:runId']).toBeTypeOf('function');
    expect(routes['GET /v1/runs/:runId/steps']).toBeTypeOf('function');
    expect(routes['GET /v1/rdf/stats']).toBeTypeOf('function');
    expect(routes['GET /api/admin/rdf/stats']).toBeTypeOf('function');
    expect(routes['POST /api/ai/gateway/keys']).toBeTypeOf('function');
    expect(routes['GET /api/ai/gateway/keys']).toBeTypeOf('function');
    expect(routes['DELETE /api/ai/gateway/keys/:keyId']).toBeTypeOf('function');
    expect(routes['POST /v1/responses']).toBeTypeOf('function');
    expect(routes['POST /v1/messages']).toBeTypeOf('function');
    expect(routes['POST /v1/chat/completions']).toBeTypeOf('function');
    expect(routes['GET /v1/models']).toBeTypeOf('function');
    expect(routes['GET /_matrix/client/versions']).toBeTypeOf('function');
    expect(routes['GET /api/_matrix/client/versions']).toBeUndefined();
    expect(routes['GET /matrix/_matrix/client/versions']).toBeUndefined();
    expect(routes['POST /v1/signal']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/heartbeat']).toBeTypeOf('function');
    expect(routes['POST /v1/clients/heartbeat']).toBeTypeOf('function');
    expect(routes['POST /v1/threads/coordination/lease']).toBeTypeOf('function');
    expect(routes['POST /_matrix/client/v3/createRoom']).toBeTypeOf('function');
    expect(routes['GET /v1/signal/nodes/:nodeId/routes']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/nodes/:nodeId/sessions']).toBeTypeOf('function');
    expect(routes['GET /v1/signal/nodes/:nodeId/sessions']).toBeTypeOf('function');
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy']).toBeUndefined();
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy/*path']).toBeUndefined();
    expect(routes['GET /v1/nodes/:nodeId/routes']).toBeUndefined();
    expect(routes['POST /v1/signal/nodes/:nodeId/p2p-sessions']).toBeUndefined();
    expect(routes['POST /v1/signal/nodes/:nodeId/relay-sessions']).toBeUndefined();
    expect(routes['POST /v1/nodes/:nodeId/p2p-sessions']).toBeUndefined();
    expect(routes['POST /v1/nodes/:nodeId/relay-sessions']).toBeUndefined();
    expect(routes['ALL /api/inngest']).toBeTypeOf('function');
    expect(routes['ALL /api/inngest/*path']).toBeTypeOf('function');
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({
      serveOrigin: 'http://xpod-api:3001',
      servePath: '/api/inngest',
    }));
    expect(routes['GET /api/admin/status']).toBeUndefined();
    expect(routes['GET /api/linx/capabilities']).toBeUndefined();
  });

  it('wires AI Connection service-access without internal Pod credentials', async () => {
    const ownerWebId = 'https://id.example/alice/profile/card#me';
    const getServicePrincipal = vi.fn(async () => ({ webId: 'https://id.example/xpod/profile/card#me' }));
    registerRoutes(createContainer('cloud', {
      services: {
        gatewayInternalPodAccess: {
          getServicePrincipal,
        },
      },
    }));
    const res = jsonResponse();

    await routes['GET /api/applets/service-access/ai-connection'](solidRequest(ownerWebId), res, {});

    expect(res.statusCode).toBe(200);
    expect(getServicePrincipal).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      service: { webId: ownerWebId },
      resources: expect.arrayContaining([
        expect.objectContaining({
          url: 'https://id.example/alice/settings/credentials.ttl',
        }),
      ]),
    });
  });

  it('wires Pod settings AI status through hosted Pod access with the logged-in auth', async () => {
    const ownerWebId = 'https://id.example/alice/profile/card#me';
    const auth = { type: 'solid' as const, webId: ownerWebId, accessToken: 'solid-token' };
    const getTrustedFetch = vi.fn(async () => (async () => new Response('', { status: 404 })) as typeof fetch);
    const legacyGetTrustedFetch = vi.fn(async () => fetch);
    registerRoutes(createContainer('cloud', {
      services: {
        hostedPodDataAccess: { getTrustedFetch },
        gatewayInternalPodAccess: { getTrustedFetch: legacyGetTrustedFetch },
        podLookupRepo: {
          findByWebId: vi.fn(async () => ({
            podId: 'pod-alice',
            accountId: 'account-alice',
            baseUrl: 'https://id.example/alice/',
            storageUrl: 'https://id.example/alice/',
            webId: ownerWebId,
          })),
        },
      },
    }));
    const res = jsonResponse();

    await routes['GET /api/pod/settings/status']({ ...solidRequest(ownerWebId), auth }, res, {});

    expect(res.statusCode).toBe(200);
    expect(getTrustedFetch).toHaveBeenCalledWith(ownerWebId, auth);
    expect(legacyGetTrustedFetch).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({
      identity: { webId: ownerWebId, podUrl: 'https://id.example/alice/' },
      aiConnection: expect.objectContaining({ status: expect.any(String) }),
    });
  });

  it('registers local-only admin and onboarding routes in local mode', () => {
    registerRoutes(createContainer('local'));

    expect(routes['GET /api/linx/capabilities']).toBeTypeOf('function');
    expect(routes['GET /api/admin/status']).toBeTypeOf('function');
    expect(routes['GET /:username/profile/card']).toBeUndefined();
    expect(routes['POST /v1/tasks']).toBeUndefined();
    expect(routes['GET /v1/runs']).toBeTypeOf('function');
    expect(routes['GET /v1/rdf/stats']).toBeTypeOf('function');
    expect(routes['GET /api/admin/rdf/stats']).toBeTypeOf('function');
    expect(routes['POST /api/ai/gateway/keys']).toBeTypeOf('function');
    expect(routes['GET /api/ai/gateway/keys']).toBeTypeOf('function');
    expect(routes['DELETE /api/ai/gateway/keys/:keyId']).toBeTypeOf('function');
    expect(routes['GET /_matrix/client/versions']).toBeTypeOf('function');
    expect(routes['GET /api/_matrix/client/versions']).toBeUndefined();
    expect(routes['GET /matrix/_matrix/client/versions']).toBeUndefined();
    expect(routes['POST /v1/clients/heartbeat']).toBeTypeOf('function');
    expect(routes['POST /v1/threads/coordination/lease']).toBeTypeOf('function');
    expect(routes['GET /v1/signal/nodes/:nodeId/routes']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/nodes/:nodeId/sessions']).toBeTypeOf('function');
    expect(routes['GET /v1/signal/nodes/:nodeId/sessions']).toBeTypeOf('function');
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy']).toBeUndefined();
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy/*path']).toBeUndefined();
    expect(routes['GET /v1/nodes/:nodeId/routes']).toBeUndefined();
    expect(routes['POST /v1/signal/nodes/:nodeId/p2p-sessions']).toBeUndefined();
    expect(routes['POST /v1/signal/nodes/:nodeId/relay-sessions']).toBeUndefined();
    expect(routes['POST /v1/nodes/:nodeId/p2p-sessions']).toBeUndefined();
    expect(routes['POST /v1/nodes/:nodeId/relay-sessions']).toBeUndefined();
    expect(routes['ALL /api/inngest']).toBeTypeOf('function');
    expect(routes['POST /provision/pods']).toBeUndefined();
    expect(routes['POST /v1/agents/access-tokens']).toBeUndefined();
    expect(routes['GET /v1/agents/jwks']).toBeUndefined();
  });


  it('registers Local provision routes from the auto-provisioned config service token', () => {
    registerRoutes(createContainer('local', {
      config: {
        serviceToken: 'svc-issued-by-cloud',
        nodeId: 'local-node-1',
        nodeToken: 'node-token-issued-by-cloud',
      },
    }));

    expect(routes['POST /provision/pods']).toBeTypeOf('function');
    expect(routes['GET /provision/pods/:podName']).toBeTypeOf('function');
    expect(routes['DELETE /provision/pods/:podName']).toBeTypeOf('function');
    expect(routes['GET /provision/status']).toBeTypeOf('function');
  });

  it('does not expose the public Inngest callback route when Inngest is disabled', () => {
    registerRoutes(createContainer('cloud', {
      inngestRuntimeConfig: {
        enabled: false,
        durableDelivery: false,
      },
    }));

    expect(routes['ALL /api/inngest']).toBeUndefined();
    expect(routes['ALL /api/inngest/*path']).toBeUndefined();
    expect(routes['GET /v1/runs']).toBeTypeOf('function');
  });

  it('wires cloud DNS and tunnel providers into Network settings without deployment branching', async () => {
    registerRoutes(createContainer('cloud', {
      config: {
        publicUrl: 'https://cloud.example/',
      },
    }));
    const res = jsonResponse();

    await routes['GET /api/network/settings/status'](authedRequest(), res, {});

    expect(JSON.parse(res.body)).toMatchObject({
      endpoint: 'https://cloud.example/',
      dns: { supported: true, status: 'configured' },
      tunnel: { supported: true, status: 'active' },
      addresses: { public: ['https://cloud.example/', 'https://cloud-tunnel.example/'] },
    });
    expect(res.body).not.toContain('deployment');
  });

  it('wires local DDNS and local tunnel endpoints into Network settings', async () => {
    registerRoutes(createContainer('local', {
      config: {
        publicUrl: 'https://local-public.example/',
      },
    }));
    const res = jsonResponse();

    await routes['GET /api/network/settings/status'](authedRequest(), res, {});

    expect(JSON.parse(res.body)).toMatchObject({
      dns: { supported: true, status: 'tunnel' },
      tunnel: { supported: true, status: 'active' },
      addresses: {
        public: [
          'https://local-public.example/',
          'https://local-node.undefineds.site/',
          'https://local-tunnel.example/',
        ],
      },
    });
    expect(res.body).not.toContain('deployment');
  });

  it('rejects arbitrary local Pod owners and allows explicit local deployment owner/admin roles', async () => {
    const podOwnerWebId = 'https://id.example/alice/profile/card#me';
    const deploymentOwnerWebId = 'https://id.example/local-owner/profile/card#me';
    const deploymentAdminWebId = 'https://id.example/local-admin/profile/card#me';
    const podLookupRepo = {
      findByWebId: vi.fn(async (webId: string) => webId === podOwnerWebId
        ? {
            podId: 'pod-alice',
            accountId: 'account-alice',
            baseUrl: 'https://local.example/alice/',
            webId,
          }
        : undefined),
    };
    const accountRoleRepo = {
      findByWebId: vi.fn(async (webId: string) => {
        if (webId === deploymentOwnerWebId) {
          return { accountId: 'account-owner', webId, roles: ['owner'] };
        }
        if (webId === deploymentAdminWebId) {
          return { accountId: 'account-admin', webId, roles: ['admin'] };
        }
        return { accountId: 'account-user', webId, roles: [] };
      }),
    };
    const certificateManager = {
      readCertificateStatus: vi.fn(async () => ({ status: 'valid' })),
      renewCertificate: vi.fn(async () => undefined),
    };
    registerRoutes(createContainer('local', {
      config: {
        publicUrl: 'https://local-public.example/',
      },
      services: { podLookupRepo, accountRoleRepo, certificateManager },
    }));

    const podOwnerStatusRes = jsonResponse();
    await routes['GET /api/network/settings/status'](solidRequest(podOwnerWebId), podOwnerStatusRes, {});
    expect(podOwnerStatusRes.statusCode).toBe(403);

    const podOwnerRenewRes = jsonResponse();
    await routes['POST /api/network/settings/certificate/renew'](solidRequest(podOwnerWebId), podOwnerRenewRes, {});
    expect(podOwnerRenewRes.statusCode).toBe(403);
    expect(podLookupRepo.findByWebId).not.toHaveBeenCalled();

    const ownerRes = jsonResponse();
    await routes['GET /api/network/settings/status'](solidRequest(deploymentOwnerWebId), ownerRes, {});
    expect(ownerRes.statusCode).toBe(200);
    expect(JSON.parse(ownerRes.body)).toMatchObject({ endpoint: 'https://local-public.example/' });

    const adminRenewRes = jsonResponse();
    await routes['POST /api/network/settings/certificate/renew'](solidRequest(deploymentAdminWebId), adminRenewRes, {});
    expect(adminRenewRes.statusCode).toBe(200);
    expect(certificateManager.renewCertificate).toHaveBeenCalledTimes(1);
    expect(accountRoleRepo.findByWebId).toHaveBeenCalledWith(deploymentOwnerWebId);
    expect(accountRoleRepo.findByWebId).toHaveBeenCalledWith(deploymentAdminWebId);
  });

  it('allows cloud Solid admins from account role data and rejects ordinary cloud users', async () => {
    const adminWebId = 'https://id.example/admin/profile/card#me';
    const ownerWebId = 'https://id.example/owner/profile/card#me';
    const accountRoleRepo = {
      findByWebId: vi.fn(async (webId: string) => webId === adminWebId
        ? { accountId: 'account-admin', webId, roles: ['admin'] }
        : webId === ownerWebId
          ? { accountId: 'account-owner', webId, roles: ['owner'] }
        : { accountId: 'account-user', webId, roles: [] }),
    };
    registerRoutes(createContainer('cloud', {
      config: {
        publicUrl: 'https://cloud.example/',
      },
      services: { accountRoleRepo },
    }));

    const adminRes = jsonResponse();
    await routes['GET /api/network/settings/status'](solidRequest(adminWebId), adminRes, {});
    expect(adminRes.statusCode).toBe(200);
    expect(accountRoleRepo.findByWebId).toHaveBeenCalledWith(adminWebId);

    const userRes = jsonResponse();
    await routes['GET /api/network/settings/status'](solidRequest('https://id.example/user/profile/card#me'), userRes, {});
    expect(userRes.statusCode).toBe(403);

    const ownerRes = jsonResponse();
    await routes['GET /api/network/settings/status'](solidRequest(ownerWebId), ownerRes, {});
    expect(ownerRes.statusCode).toBe(403);
  });

  it('rejects account manage service tokens without explicit network scopes', async () => {
    registerRoutes(createContainer('cloud', {
      config: {
        publicUrl: 'https://cloud.example/',
      },
    }));
    const auth = {
      auth: {
        type: 'service',
        serviceType: 'business',
        serviceId: 'business-default',
        scopes: ['account:manage'],
      },
      headers: {},
      method: 'GET',
      url: '/api/network/settings/status',
    };

    const statusRes = jsonResponse();
    await routes['GET /api/network/settings/status'](auth, statusRes, {});
    expect(statusRes.statusCode).toBe(403);

    const renewRes = jsonResponse();
    await routes['POST /api/network/settings/certificate/renew'](auth, renewRes, {});
    expect(renewRes.statusCode).toBe(403);
  });

  it('wires a cloud certificate runtime surface into Network settings TLS status and renewal', async () => {
    const certificateManager = {
      readCertificateStatus: vi.fn(async () => ({
        status: 'valid',
        expiresAt: '2026-10-31T00:00:00.000Z',
      })),
      renewCertificate: vi.fn(async () => undefined),
    };
    registerRoutes(createContainer('cloud', {
      config: {
        publicUrl: 'https://cloud.example/',
      },
      services: { certificateManager },
    }));

    const statusRes = jsonResponse();
    await routes['GET /api/network/settings/status'](authedRequest(), statusRes, {});
    expect(JSON.parse(statusRes.body)).toMatchObject({
      tls: { supported: true, status: 'valid', expiresAt: '2026-10-31T00:00:00.000Z' },
      actions: { renewCertificate: true },
    });

    const renewRes = jsonResponse();
    await routes['POST /api/network/settings/certificate/renew'](authedRequest('write'), renewRes, {});
    expect(renewRes.statusCode).toBe(200);
    expect(certificateManager.renewCertificate).toHaveBeenCalledTimes(1);
  });

  it('wires the production certificate bridge into Network settings TLS status and renewal', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-acme-cert-'));
    const bridgeId = resolveEdgeNodeCertificateCapabilityBridgeId({ nodeId: 'node-1' })!;
    const bridge = getEdgeNodeCertificateCapabilityBridge(bridgeId);
    try {
      const certPath = path.join(tmpDir, 'tls.crt');
      await fs.writeFile(certPath, SAMPLE_CERT, 'utf8');
      const acmeCertificateManager = new AcmeCertificateManager({
        dnsChallengeHandler: {
          setChallenge: vi.fn(),
          removeChallenge: vi.fn(),
        },
        email: 'ops@example.com',
        domains: [ 'node-1.cluster.example' ],
        accountKeyPath: path.join(tmpDir, 'account.key'),
        certificateKeyPath: path.join(tmpDir, 'tls.key'),
        certificatePath: certPath,
        renewBeforeDays: 10,
      });
      const renewSpy = vi.spyOn(acmeCertificateManager, 'renewCertificate').mockResolvedValue({ status: 'renewed' });
      bridge.setSource(() => acmeCertificateManager);
      registerRoutes(createContainer('local', {
        config: {
          nodeId: 'node-1',
          publicUrl: 'https://local-public.example/',
        },
      }));

      const statusRes = jsonResponse();
      await routes['GET /api/network/settings/status'](authedRequest(), statusRes, {});
      expect(JSON.parse(statusRes.body)).toMatchObject({
        tls: { supported: true, status: 'valid', expiresAt: '2026-11-11T07:26:01.000Z' },
        actions: { renewCertificate: true },
      });

      const renewRes = jsonResponse();
      await routes['POST /api/network/settings/certificate/renew'](authedRequest('write'), renewRes, {});
      expect(renewRes.statusCode).toBe(200);
      expect(renewSpy).toHaveBeenCalledTimes(1);
    } finally {
      bridge.clearSource();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves the production certificate bridge dynamically across same-id source replacement and cleanup', async () => {
    const bridgeId = resolveEdgeNodeCertificateCapabilityBridgeId({ nodeId: 'node-rotate' })!;
    const sourceA = {
      readCertificateStatus: vi.fn(async () => ({ status: 'renewal_due', expiresAt: '2026-09-01T00:00:00.000Z' })),
      renewCertificate: vi.fn(async () => undefined),
    };
    const sourceB = {
      readCertificateStatus: vi.fn(async () => ({ status: 'valid', expiresAt: '2026-12-01T00:00:00.000Z' })),
      renewCertificate: vi.fn(async () => undefined),
    };

    const releaseA = getEdgeNodeCertificateCapabilityBridge(bridgeId).setSource(() => sourceA);
    registerRoutes(createContainer('local', {
      config: {
        nodeId: 'node-rotate',
        publicUrl: 'https://local-public.example/',
      },
    }));
    releaseA();
    const releaseB = getEdgeNodeCertificateCapabilityBridge(bridgeId).setSource(() => sourceB);

    const statusRes = jsonResponse();
    await routes['GET /api/network/settings/status'](authedRequest(), statusRes, {});
    expect(JSON.parse(statusRes.body)).toMatchObject({
      tls: { supported: true, status: 'valid', expiresAt: '2026-12-01T00:00:00.000Z' },
      actions: { renewCertificate: true },
    });
    expect(sourceA.readCertificateStatus).not.toHaveBeenCalled();
    expect(sourceB.readCertificateStatus).toHaveBeenCalledTimes(1);

    const renewRes = jsonResponse();
    await routes['POST /api/network/settings/certificate/renew'](authedRequest('write'), renewRes, {});
    expect(renewRes.statusCode).toBe(200);
    expect(sourceA.renewCertificate).not.toHaveBeenCalled();
    expect(sourceB.renewCertificate).toHaveBeenCalledTimes(1);

    releaseB();
    expect(hasEdgeNodeCertificateCapabilityBridge(bridgeId)).toBe(false);
  });

  it('returns certificate renewal unavailable when the dynamic bridge source disappears after availability', async () => {
    const bridgeId = resolveEdgeNodeCertificateCapabilityBridgeId({ nodeId: 'node-disappears' })!;
    let releaseSource: () => void = () => undefined;
    const runtime = {
      readCertificateStatus: vi.fn(async () => ({ status: 'valid', expiresAt: '2026-12-01T00:00:00.000Z' })),
      isAvailable: vi.fn(async () => {
        releaseSource();
        return true;
      }),
      renewCertificate: vi.fn(async () => undefined),
    };

    releaseSource = getEdgeNodeCertificateCapabilityBridge(bridgeId).setSource(() => runtime);
    registerRoutes(createContainer('local', {
      config: {
        nodeId: 'node-disappears',
        publicUrl: 'https://local-public.example/',
      },
    }));

    const renewRes = jsonResponse();
    await routes['POST /api/network/settings/certificate/renew'](authedRequest('write'), renewRes, {});

    expect(renewRes.statusCode).toBe(503);
    expect(JSON.parse(renewRes.body)).toMatchObject({
      code: 'certificate_renewal_unavailable',
    });
    expect(runtime.isAvailable).toHaveBeenCalledTimes(1);
    expect(runtime.renewCertificate).not.toHaveBeenCalled();
    expect(hasEdgeNodeCertificateCapabilityBridge(bridgeId)).toBe(false);
  });

  it('keeps TLS unsupported when no certificate runtime surface is registered', async () => {
    registerRoutes(createContainer('local', {
      config: {
        publicUrl: 'https://local-public.example/',
      },
      services: {
        certificateManager: undefined,
        acmeCertificateManager: undefined,
        clusterCertificateManager: undefined,
      },
    }));
    const res = jsonResponse();

    await routes['GET /api/network/settings/status'](authedRequest(), res, {});

    expect(JSON.parse(res.body)).toMatchObject({
      tls: { supported: false, status: 'unsupported' },
      actions: { renewCertificate: false },
    });
    expect(routes['POST /api/network/settings/certificate/renew']).toBeTypeOf('function');
  });

  it('wires RDF stats routes to the container stats service', async () => {
    const rdfStorageStatsService = {
      snapshot: vi.fn().mockResolvedValue({
        available: true,
        engine: 'postgres-rdf',
        generatedAt: '2026-06-09T00:00:00.000Z',
        stats: {
          factsBytes: 10,
          derivedBytes: 4,
          totalBytes: 14,
          totalToFactsRatio: 1.4,
          derivedToFactsRatio: 0.4,
        },
      }),
    };
    registerRoutes(createContainer('cloud', { rdfStorageStatsService }));

    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    await routes['GET /api/admin/rdf/stats'](
      { url: '/api/admin/rdf/stats?cacheScopeQuery=ops', headers: {} },
      response,
      {},
    );

    expect(response.statusCode).toBe(200);
    expect(rdfStorageStatsService.snapshot).toHaveBeenCalledWith({
      cacheScope: { query: 'ops' },
    });
  });
});
