import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../../src/api/container/routes';
import type { ApiContainerConfig } from '../../src/api/container/types';
import type { ApiServer } from '../../src/api/ApiServer';

describe('registerRoutes vector wiring', () => {
  let routes: Record<string, Function>;
  let mockServer: ApiServer;

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
      route: vi.fn((method: string, path: string, handler: Function) => {
        routes[`${method.toUpperCase()} ${path}`] = handler;
      }),
      get: vi.fn((path: string, handler: Function) => {
        routes[`GET ${path}`] = handler;
      }),
      post: vi.fn((path: string, handler: Function) => {
        routes[`POST ${path}`] = handler;
      }),
      put: vi.fn((path: string, handler: Function) => {
        routes[`PUT ${path}`] = handler;
      }),
      delete: vi.fn((path: string, handler: Function) => {
        routes[`DELETE ${path}`] = handler;
      }),
      patch: vi.fn((path: string, handler: Function) => {
        routes[`PATCH ${path}`] = handler;
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
      chatKitStore: {},
      vectorService: {},
      db: {},
      webIdProfileRepo: edition === 'cloud' ? {} : undefined,
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

  it('registers vector routes in cloud mode', () => {
    registerRoutes(createContainer('cloud'));

    expect(routes['GET /v1/vectors/status']).toBeTypeOf('function');
    expect(routes['POST /v1/embeddings']).toBeTypeOf('function');
    expect(routes['GET /api/admin/status']).toBeUndefined();
  });

  it('registers vector routes in local mode', () => {
    registerRoutes(createContainer('local'));

    expect(routes['GET /v1/vectors/status']).toBeTypeOf('function');
    expect(routes['POST /v1/embeddings']).toBeTypeOf('function');
    expect(routes['GET /api/admin/status']).toBeTypeOf('function');
  });
});
