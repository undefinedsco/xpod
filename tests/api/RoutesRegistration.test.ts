import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('inngest/node', () => ({
  serve: vi.fn(() => vi.fn((_req: unknown, res: { end?: () => void }) => res.end?.())),
}));

import { registerRoutes } from '../../src/api/container/routes';
import type { ApiContainerConfig } from '../../src/api/container/types';
import type { ApiServer } from '../../src/api/ApiServer';
import { serve } from 'inngest/node';

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
    } as unknown as ApiServer;
  });

  function createContainer(
    edition: 'cloud' | 'local',
    overrides: { inngestRuntimeConfig?: unknown } = {},
  ): any {
    const services: Record<string, unknown> = {
      apiServer: mockServer,
      config: { ...baseConfig, edition },
      nodeRepo: {},
      chatService: {},
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
      db: {},
      podLookupRepo: {},
      ddnsRepo: edition === 'cloud' ? {} : undefined,
      dnsProvider: edition === 'cloud' ? {} : undefined,
      ddnsManager: edition === 'local' ? {} : undefined,
      subdomainClient: edition === 'local' ? {} : undefined,
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
    expect(routes['GET /_matrix/client/versions']).toBeTypeOf('function');
    expect(routes['GET /api/_matrix/client/versions']).toBeUndefined();
    expect(routes['GET /matrix/_matrix/client/versions']).toBeUndefined();
    expect(routes['POST /v1/signal']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/heartbeat']).toBeTypeOf('function');
    expect(routes['POST /v1/clients/heartbeat']).toBeTypeOf('function');
    expect(routes['POST /v1/threads/coordination/lease']).toBeTypeOf('function');
    expect(routes['POST /_matrix/client/v3/createRoom']).toBeTypeOf('function');
    expect(routes['GET /v1/signal/nodes/:nodeId/routes']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/nodes/:nodeId/p2p-sessions']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/nodes/:nodeId/relay-sessions']).toBeTypeOf('function');
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy']).toBeUndefined();
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy/*path']).toBeUndefined();
    expect(routes['GET /v1/nodes/:nodeId/routes']).toBeUndefined();
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

  it('registers local-only admin and onboarding routes in local mode', () => {
    registerRoutes(createContainer('local'));

    expect(routes['GET /api/linx/capabilities']).toBeTypeOf('function');
    expect(routes['GET /api/admin/status']).toBeTypeOf('function');
    expect(routes['GET /:username/profile/card']).toBeUndefined();
    expect(routes['POST /v1/tasks']).toBeUndefined();
    expect(routes['GET /v1/runs']).toBeTypeOf('function');
    expect(routes['GET /_matrix/client/versions']).toBeTypeOf('function');
    expect(routes['GET /api/_matrix/client/versions']).toBeUndefined();
    expect(routes['GET /matrix/_matrix/client/versions']).toBeUndefined();
    expect(routes['POST /v1/clients/heartbeat']).toBeTypeOf('function');
    expect(routes['POST /v1/threads/coordination/lease']).toBeTypeOf('function');
    expect(routes['GET /v1/signal/nodes/:nodeId/routes']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/nodes/:nodeId/p2p-sessions']).toBeTypeOf('function');
    expect(routes['POST /v1/signal/nodes/:nodeId/relay-sessions']).toBeTypeOf('function');
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy']).toBeUndefined();
    expect(routes['ALL /v1/relay/nodes/:nodeId/sessions/:sessionId/proxy/*path']).toBeUndefined();
    expect(routes['GET /v1/nodes/:nodeId/routes']).toBeUndefined();
    expect(routes['POST /v1/nodes/:nodeId/p2p-sessions']).toBeUndefined();
    expect(routes['POST /v1/nodes/:nodeId/relay-sessions']).toBeUndefined();
    expect(routes['ALL /api/inngest']).toBeTypeOf('function');
    expect(routes['POST /provision/pods']).toBeUndefined();
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
});
