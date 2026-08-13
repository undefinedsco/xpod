import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiContainerConfig } from '../../src/api/container';

const mocked = vi.hoisted(() => ({
  createApiContainerMock: vi.fn(),
  registerRoutesMock: vi.fn(),
  embeddedInngestStartMock: vi.fn().mockResolvedValue({
    enabled: false,
    durableDelivery: false,
  }),
  embeddedInngestStopMock: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../src/api/runs/EmbeddedInngestService', () => ({
  EmbeddedInngestService: vi.fn().mockImplementation(() => ({
    start: mocked.embeddedInngestStartMock,
    stop: mocked.embeddedInngestStopMock,
  })),
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
    const runExecutionBackend = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const rdfEngine = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const rdfSearchReconciliationWorker = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const serviceTokenRepo = {
      registerToken: vi.fn(),
    };
    const services: Record<string, unknown> = {
      apiServer,
      runExecutionBackend,
      rdfEngine,
      rdfSearchReconciliationWorker,
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

    expect(rdfEngine.open).toHaveBeenCalledTimes(1);
    expect(rdfEngine.open.mock.invocationCallOrder[0])
      .toBeLessThan(rdfSearchReconciliationWorker.start.mock.invocationCallOrder[0]);
    expect(localNetworkManager.start).toHaveBeenCalledTimes(1);
    expect(rdfSearchReconciliationWorker.start).toHaveBeenCalledTimes(1);
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
    expect(rdfSearchReconciliationWorker.stop).toHaveBeenCalledTimes(1);
    expect(apiServer.stop).toHaveBeenCalledTimes(1);
    expect(runExecutionBackend.close).toHaveBeenCalledTimes(1);
    expect(rdfEngine.close).toHaveBeenCalledTimes(1);
  });

  it('cleans up opened RDF and background services when the API server fails to start', async() => {
    const startupError = new Error('listen failed');
    const apiServer = {
      start: vi.fn().mockRejectedValue(startupError),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const runExecutionBackend = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const rdfEngine = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const rdfSearchReconciliationWorker = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const services: Record<string, unknown> = {
      apiServer,
      runExecutionBackend,
      rdfEngine,
      rdfSearchReconciliationWorker,
      serviceTokenRepo: { registerToken: vi.fn() },
    };
    mocked.createApiContainerMock.mockReturnValue({
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
    });

    await expect(startApiService({ config, initializeLogger: false }))
      .rejects.toBe(startupError);

    expect(rdfEngine.open).toHaveBeenCalledTimes(1);
    expect(rdfSearchReconciliationWorker.start).toHaveBeenCalledTimes(1);
    expect(rdfSearchReconciliationWorker.stop).toHaveBeenCalledTimes(1);
    expect(apiServer.stop).toHaveBeenCalledTimes(1);
    expect(runExecutionBackend.close).toHaveBeenCalledTimes(1);
    expect(rdfEngine.close).toHaveBeenCalledTimes(1);
  });

  it('stops embedded Inngest when API container creation fails', async() => {
    const startupError = new Error('container failed');
    mocked.createApiContainerMock.mockImplementationOnce(() => {
      throw startupError;
    });

    await expect(startApiService({ config, initializeLogger: false }))
      .rejects.toBe(startupError);

    expect(mocked.embeddedInngestStartMock).toHaveBeenCalledTimes(1);
    expect(mocked.embeddedInngestStopMock).toHaveBeenCalledTimes(1);
    expect(mocked.registerRoutesMock).not.toHaveBeenCalled();
  });
});
