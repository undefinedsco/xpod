import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiContainerConfig } from '../../src/api/container';

const mocked = vi.hoisted(() => ({
  createApiContainerMock: vi.fn(),
  registerRoutesMock: vi.fn(),
  getLoggerForMock: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../src/api/container', () => ({
  createApiContainer: mocked.createApiContainerMock,
  loadConfigFromEnv: vi.fn(),
}));

vi.mock('../../src/api/container/routes', () => ({
  registerRoutes: mocked.registerRoutesMock,
}));

vi.mock('global-logger-factory', () => ({
  getLoggerFor: mocked.getLoggerForMock,
  setGlobalLoggerFactory: vi.fn(),
}));

vi.mock('../../src/logging/ConfigurableLoggerFactory', () => ({
  ConfigurableLoggerFactory: vi.fn(),
}));

import { startApiService } from '../../src/api/runtime';

describe('startApiService background services', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToManage = [
    'XPOD_MAIN_PORT',
    'CSS_PORT',
    'PORT',
  ];

  const config: ApiContainerConfig = {
    edition: 'local',
    port: 3001,
    host: '127.0.0.1',
    authMode: 'acp',
    databaseUrl: 'sqlite::memory:',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'http://127.0.0.1:3000/.oidc/token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of envKeysToManage) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeysToManage) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('starts the local tunnel provider even when local network manager is registered', async() => {
    const localNetworkManager = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const ddnsManager = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    const localTunnelProvider = {
      setup: vi.fn().mockResolvedValue({
        provider: 'cloudflare',
        subdomain: 'local',
        endpoint: '',
        originUrl: 'http://127.0.0.1:5737',
        tunnelToken: 'cf-token',
      }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const apiServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const serviceTokenRepo = {
      registerToken: vi.fn(),
    };
    const services: Record<string, unknown> = {
      apiServer,
      serviceTokenRepo,
      localNetworkManager,
      ddnsManager,
      localTunnelProvider,
    };
    const container = {
      register: vi.fn(),
      resolve: vi.fn((name: string, options?: { allowUnregistered?: boolean }) => {
        if (name in services) {
          return services[name];
        }
        if (options?.allowUnregistered) {
          return undefined;
        }
        throw new Error(`Unexpected resolve: ${name}`);
      }),
    };

    mocked.createApiContainerMock.mockReturnValue(container);

    const handle = await startApiService({
      config,
      initializeLogger: false,
    });

    expect(localNetworkManager.start).toHaveBeenCalledTimes(1);
    expect(ddnsManager.start).toHaveBeenCalledTimes(1);
    expect(localTunnelProvider.setup).toHaveBeenCalledWith({
      subdomain: 'local',
      localPort: 3000,
      localProtocol: 'http',
    });
    expect(localTunnelProvider.start).toHaveBeenCalledWith({
      provider: 'cloudflare',
      subdomain: 'local',
      endpoint: '',
      originUrl: 'http://127.0.0.1:5737',
      tunnelToken: 'cf-token',
    });
    expect(apiServer.start).toHaveBeenCalledTimes(1);

    await handle.stop();

    expect(localTunnelProvider.stop).toHaveBeenCalledTimes(1);
    expect(apiServer.stop).toHaveBeenCalledTimes(1);
  });
});
