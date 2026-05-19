import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('inngest/node', () => ({
  serve: vi.fn(() => vi.fn((_req: unknown, res: { end?: () => void }) => res.end?.())),
}));

import { registerRoutes } from '../../src/api/container/routes';
import type { ApiContainerConfig } from '../../src/api/container/types';
import type { ApiServer } from '../../src/api/ApiServer';

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
    databaseUrl: 'postgres://example.invalid/xpod',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'https://id.undefineds.co/.oidc/token',
    subdomain: {
      baseStorageDomain: 'nodes.undefineds.co',
    },
  };

  beforeEach(() => {
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

  function createContainer(edition: 'cloud' | 'local'): any {
    const services: Record<string, unknown> = {
      apiServer: mockServer,
      config: { ...baseConfig, edition },
      nodeRepo: {},
      apiKeyStore: {},
      chatService: {},
      chatKitService: {},
      chatKitStore: {
        listRuns: vi.fn(),
        loadRun: vi.fn(),
        loadRunSteps: vi.fn(),
      },
      runExecutionBackend: {
        getClient: vi.fn(() => ({ id: 'test-inngest' })),
        agentRunFunction: {},
      },
      taskService: {},
      inngestTaskScheduler: {
        getFunctions: vi.fn(() => [{ id: 'task-due' }, { id: 'task-event' }]),
      },
      inngestRuntimeConfig: {
        enabled: true,
        durableDelivery: true,
        baseUrl: 'http://xpod-inngest:8288',
        eventKey: 'test-event-key',
        signingKey: 'signkey-test',
        functionEndpoint: 'http://xpod-api:3001/api/inngest',
      },
      db: {},
      webIdProfileRepo: {},
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

    expect(routes['GET /:username/profile/card']).toBeTypeOf('function');
    expect(routes['POST /api/v1/ddns/allocate']).toBeTypeOf('function');
    expect(routes['POST /provision/nodes']).toBeTypeOf('function');
    expect(routes['POST /v1/tasks']).toBeUndefined();
    expect(routes['POST /v1/tasks/materialize-due']).toBeUndefined();
    expect(routes['POST /v1/tasks/events/:eventName']).toBeUndefined();
    expect(routes['GET /v1/runs']).toBeTypeOf('function');
    expect(routes['GET /v1/runs/:runId']).toBeTypeOf('function');
    expect(routes['GET /v1/runs/:runId/steps']).toBeTypeOf('function');
    expect(routes['ALL /api/inngest']).toBeTypeOf('function');
    expect(routes['ALL /api/inngest/*path']).toBeTypeOf('function');
    expect(routes['GET /api/admin/status']).toBeUndefined();
    expect(routes['GET /api/linx/capabilities']).toBeUndefined();
  });

  it('registers local-only admin and onboarding routes in local mode', () => {
    registerRoutes(createContainer('local'));

    expect(routes['GET /api/linx/capabilities']).toBeTypeOf('function');
    expect(routes['GET /api/admin/status']).toBeTypeOf('function');
    expect(routes['GET /:username/profile/card']).toBeTypeOf('function');
    expect(routes['POST /v1/tasks']).toBeUndefined();
    expect(routes['GET /v1/runs']).toBeTypeOf('function');
    expect(routes['ALL /api/inngest']).toBeTypeOf('function');
    expect(routes['POST /provision/pods']).toBeUndefined();
  });
});
