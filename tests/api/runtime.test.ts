import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

import { resolveTunnelIngressPort, startApiService } from '../../src/api/runtime';

describe('startApiService background services', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToManage = [
    'XPOD_MAIN_PORT',
    'CSS_PORT',
    'PORT',
    'CSS_BASE_URL',
    'XPOD_LOCAL_SETUP_PATH',
    'XPOD_PROVIDER_ID',
    'XPOD_NODE_ID',
    'XPOD_NODE_TOKEN',
    'XPOD_SERVICE_TOKEN',
    'XPOD_PROVISION_CODE',
    'XPOD_PROVISION_URL',
    'XPOD_SP_DOMAIN',
    'XPOD_LOCAL_AUTO_PROVISION_TIMEOUT_MS',
    'XPOD_TUNNEL_PROVIDER',
  ];
  const originalFetch = globalThis.fetch;
  let setupDir: string;
  let setupPath: string;

  const config: ApiContainerConfig = {
    edition: 'local',
    port: 3001,
    host: '127.0.0.1',
    authMode: 'acp',
    databaseUrl: 'sqlite::memory:',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'http://127.0.0.1:3000/.oidc/token',
  };

  const makeManagedProvisionCode = (nodeId = 'local-device-id'): string => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      spUrl: 'https://node-0000.undefineds.co/',
      serviceAccessToken: 'sat-test',
      serviceAccessTokenExp: now + 3600,
      signalApiUrl: 'https://api.undefineds.co/',
      routeAccessToken: 'route-once',
      routeAccessTokenExp: now + 3600,
      nodeId,
      spDomain: 'node-0000.undefineds.co',
      exp: now + 3600,
    };
    return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of envKeysToManage) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const testRoot = path.resolve('.test-data');
    fs.mkdirSync(testRoot, { recursive: true });
    setupDir = fs.mkdtempSync(path.join(testRoot, 'api-runtime-'));
    setupPath = path.join(setupDir, 'xpod-cloud-registration.json');
    // Every successful provisioning branch persists state, including credential refresh.
    process.env.XPOD_LOCAL_SETUP_PATH = setupPath;
  });

  afterEach(() => {
    for (const key of envKeysToManage) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    globalThis.fetch = originalFetch;
    fs.rmSync(setupDir, { recursive: true, force: true });
  });

  it('auto-provisions a first-run Local before creating the container', async() => {
    process.env.CSS_BASE_URL = 'https://node-0000.undefineds.co/';
    process.env.XPOD_MAIN_PORT = '3000';
    process.env.CSS_PORT = '5737';
    process.env.XPOD_LOCAL_SETUP_PATH = setupPath;
    process.env.XPOD_PROVIDER_ID = 'local';
    const managedProvisionCode = makeManagedProvisionCode();

    const apiServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const services: Record<string, unknown> = {
      apiServer,
      serviceTokenRepo: { registerToken: vi.fn() },
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
    const fetchMock = vi.fn(async(_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
        nodeId: 'local-device-id',
        nodeToken: 'node-token-issued-by-cloud',
      serviceToken: 'svc-issued-by-cloud',
      provisionCode: managedProvisionCode,
      publicUrl: 'https://node-0000.undefineds.co/',
      spDomain: 'node-0000.undefineds.co',
      tunnelToken: 'cf-token-issued-by-cloud',
      tunnelProvider: 'cloudflare',
      tunnelEndpoint: 'https://node-0000.undefineds.co/',
    }), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const handle = await startApiService({
      config: {
        ...config,
        nodeId: 'local-device-id',
        oidcIssuer: 'https://id.undefineds.co/',
        cloudApiEndpoint: 'https://api.undefineds.co',
      },
      initializeLogger: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const provisionCall = fetchMock.mock.calls[0];
    if (!provisionCall) {
      throw new Error('Expected provision request');
    }
    const [provisionUrl, provisionInit] = provisionCall;
    expect(provisionUrl).toBe('https://api.undefineds.co/provision/nodes');
    const provisionRequest = JSON.parse(String(provisionInit?.body));
    expect(provisionRequest).toMatchObject({
      nodeId: 'local-device-id',
      domainMode: 'managed',
      localPort: 3000,
    });
    expect(provisionRequest.publicUrl).toBeUndefined();
    expect(mocked.createApiContainerMock).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'local-device-id',
      nodeToken: 'node-token-issued-by-cloud',
      serviceToken: 'svc-issued-by-cloud',
      provisionCode: managedProvisionCode,
      spDomain: 'node-0000.undefineds.co',
      cloudflareTunnelToken: 'cf-token-issued-by-cloud',
      activeTunnelProfile: expect.objectContaining({
        id: 'cloud-managed',
        provider: 'cloudflare',
        publicUrl: 'https://node-0000.undefineds.co/',
      }),
    }));
    expect(JSON.parse(fs.readFileSync(setupPath, 'utf8')).local).toMatchObject({
      nodeId: 'local-device-id',
      nodeToken: 'node-token-issued-by-cloud',
      serviceToken: 'svc-issued-by-cloud',
      provisionCode: managedProvisionCode,
      publicUrl: 'https://node-0000.undefineds.co/',
      spDomain: 'node-0000.undefineds.co',
      tunnelToken: 'cf-token-issued-by-cloud',
      tunnelProvider: 'cloudflare',
      tunnelEndpoint: 'https://node-0000.undefineds.co/',
      cloudApiUrl: 'https://api.undefineds.co/',
    });
    expect(process.env.XPOD_NODE_TOKEN).toBe('node-token-issued-by-cloud');
    expect(process.env.XPOD_SERVICE_TOKEN).toBe('svc-issued-by-cloud');

    await handle.stop();
  });

  it('refreshes an existing managed Local registration when the tunnel credentials are missing', async() => {
    process.env.XPOD_MAIN_PORT = '3000';
    process.env.CSS_PORT = '5737';
    process.env.XPOD_LOCAL_SETUP_PATH = setupPath;
    process.env.XPOD_PROVIDER_ID = 'local';
    const managedProvisionCode = makeManagedProvisionCode();

    const apiServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const services: Record<string, unknown> = {
      apiServer,
      serviceTokenRepo: { registerToken: vi.fn() },
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Tunnel backend unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
          nodeId: 'local-device-id',
          nodeToken: 'node-token-refreshed',
          serviceToken: 'svc-refreshed',
          provisionCode: managedProvisionCode,
          publicUrl: 'https://node-0000.undefineds.co/',
          spDomain: 'node-0000.undefineds.co',
        }), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const handle = await startApiService({
      config: {
        ...config,
        nodeId: 'local-device-id',
        nodeToken: 'node-token-existing',
        serviceToken: 'svc-existing',
        provisionCode: 'still-fresh-provision-code',
        oidcIssuer: 'https://id.undefineds.co/',
        cloudApiEndpoint: 'https://api.undefineds.co',
        publicUrl: 'https://node-0000.undefineds.co/',
        spDomain: 'node-0000.undefineds.co',
      },
      initializeLogger: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      nodeId: 'local-device-id',
      nodeToken: 'node-token-existing',
      serviceToken: 'svc-existing',
      domainMode: 'managed',
      spDomain: 'node-0000.undefineds.co',
      localPort: 3000,
    });
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(fallbackBody.domainMode).toBe('managed');
    expect(fallbackBody.localPort).toBeUndefined();
    expect(fallbackBody.tunnelToken).toBeUndefined();
    expect(fallbackBody.tunnelMode).toBeUndefined();
    expect(mocked.createApiContainerMock).toHaveBeenCalledWith(expect.objectContaining({
      nodeToken: 'node-token-refreshed',
      serviceToken: 'svc-refreshed',
      cloudflareTunnelToken: undefined,
    }));

    await handle.stop();
  });

  it('refreshes an existing managed Local registration when the provision code lacks route credentials', async() => {
    process.env.XPOD_MAIN_PORT = '3000';
    process.env.XPOD_TUNNEL_PROVIDER = 'none';
    const managedProvisionCode = makeManagedProvisionCode();

    const apiServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const services: Record<string, unknown> = {
      apiServer,
      serviceTokenRepo: { registerToken: vi.fn() },
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
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>(async() => new Response(JSON.stringify({
      nodeId: 'local-device-id',
      nodeToken: 'node-token-refreshed',
      serviceToken: 'svc-refreshed',
      provisionCode: managedProvisionCode,
      publicUrl: 'https://node-0000.undefineds.co/',
      spDomain: 'node-0000.undefineds.co',
    }), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const handle = await startApiService({
      config: {
        ...config,
        nodeId: 'local-device-id',
        nodeToken: 'node-token-existing',
        serviceToken: 'svc-existing',
        provisionCode: 'legacy-provision-code',
        oidcIssuer: 'https://id.undefineds.co/',
        cloudApiEndpoint: 'https://api.undefineds.co',
        publicUrl: 'https://node-0000.undefineds.co/',
        spDomain: 'node-0000.undefineds.co',
      },
      initializeLogger: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      nodeId: 'local-device-id',
      nodeToken: 'node-token-existing',
      serviceToken: 'svc-existing',
      domainMode: 'managed',
      spDomain: 'node-0000.undefineds.co',
      localPort: 3000,
    });
    expect(mocked.createApiContainerMock).toHaveBeenCalledWith(expect.objectContaining({
      nodeToken: 'node-token-refreshed',
      serviceToken: 'svc-refreshed',
      provisionCode: managedProvisionCode,
      localSetupPath: setupPath,
    }));
    expect(JSON.parse(fs.readFileSync(setupPath, 'utf8')).local).toMatchObject({
      nodeId: 'local-device-id',
      nodeToken: 'node-token-refreshed',
      serviceToken: 'svc-refreshed',
      provisionCode: managedProvisionCode,
    });

    await handle.stop();
  });


  it('continues startup when first-run Local Cloud registration times out', async() => {
    process.env.XPOD_LOCAL_AUTO_PROVISION_TIMEOUT_MS = '1';

    const apiServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const container = {
      register: vi.fn(),
      resolve: vi.fn((name: string, options?: { allowUnregistered?: boolean }) => {
        if (name === 'apiServer') {
          return apiServer;
        }
        if (options?.allowUnregistered) {
          return undefined;
        }
        throw new Error(`Unexpected resolve: ${name}`);
      }),
    };
    mocked.createApiContainerMock.mockReturnValue(container);
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.signal) {
        return Promise.resolve({ ok: false, text: async() => 'missing timeout signal' });
      }
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    globalThis.fetch = fetchMock as any;

    const handle = await startApiService({
      config: {
        ...config,
        nodeId: 'local-device-id',
        oidcIssuer: 'https://id.undefineds.co/',
        cloudApiEndpoint: 'https://api.undefineds.co',
      },
      initializeLogger: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeDefined();
    const containerConfig = mocked.createApiContainerMock.mock.calls[0][0];
    expect(containerConfig.nodeId).toBe('local-device-id');
    expect(containerConfig.nodeToken).toBeUndefined();
    expect(containerConfig.serviceToken).toBeUndefined();

    await handle.stop();
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
      // A real provider builds its origin from the port it was set up for; echoing the
      // argument keeps this test about the wiring instead of about this machine's env.
      setup: vi.fn(async (options: { subdomain: string; localPort: number; localProtocol: string }) => ({
        provider: 'cloudflare',
        subdomain: options.subdomain,
        endpoint: '',
        originUrl: `${options.localProtocol}://127.0.0.1:${options.localPort}`,
        tunnelToken: 'cf-token',
      })),
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
      close: vi.fn().mockResolvedValue(undefined),
    };
    const serviceTokenRepo = {
      registerToken: vi.fn(),
    };
    const services: Record<string, unknown> = {
      apiServer,
      runExecutionBackend,
      rdfEngine,
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
    // The tunnel forwards to this runtime's Gateway port, whatever this environment
    // resolved it to (`XPOD_MAIN_PORT`/`XPOD_PORT`), never to a second listener port.
    const gatewayPort = resolveTunnelIngressPort();
    expect(localTunnelProvider.setup).toHaveBeenCalledWith({
      subdomain: 'local',
      localPort: gatewayPort,
      localProtocol: 'http',
    });
    expect(localTunnelProvider.start).toHaveBeenCalledWith({
      provider: 'cloudflare',
      subdomain: 'local',
      endpoint: '',
      originUrl: `http://127.0.0.1:${gatewayPort}`,
      tunnelToken: 'cf-token',
    });
    expect(apiServer.start).toHaveBeenCalledTimes(1);

    await handle.stop();

    expect(localTunnelProvider.stop).toHaveBeenCalledTimes(1);
    expect(apiServer.stop).toHaveBeenCalledTimes(1);
    expect(runExecutionBackend.close).toHaveBeenCalledTimes(1);
    expect(rdfEngine.close).toHaveBeenCalledTimes(1);
  });

  it('registers the cloud primary deployment token with explicit network control scopes', async () => {
    const apiServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const serviceTokenRepo = {
      registerToken: vi.fn().mockResolvedValue('service-token-id'),
    };
    const services: Record<string, unknown> = {
      apiServer,
      serviceTokenRepo,
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
      config: {
        ...config,
        edition: 'cloud',
        serviceToken: 'cloud-primary-token',
      },
      initializeLogger: false,
    });

    expect(serviceTokenRepo.registerToken).toHaveBeenCalledWith('cloud-primary-token', expect.objectContaining({
      serviceType: 'cloud',
      scopes: expect.arrayContaining(['network:read', 'network:write']),
    }));

    await handle.stop();
    expect(apiServer.stop).toHaveBeenCalledTimes(1);
  });
});

describe('resolveTunnelIngressPort', () => {
  it('uses the recorded ingress port, and the documented default when there is none', () => {
    // A tunnel terminating on the gateway port reaches the Gateway from loopback and
    // would let forwarded remote requests inherit local trust, so only the listener the
    // runtime recorded counts - never the CSS/API/main ports it happens to run beside.
    // One entry: the Gateway. A tunnel console is configured with this same number, so
    // neither the CSS port beside it nor a separate listener port is ever the answer.
    expect(resolveTunnelIngressPort({ XPOD_MAIN_PORT: '5737' })).toBe(5737);
    expect(resolveTunnelIngressPort({ XPOD_MAIN_PORT: '5737', CSS_PORT: '5738' })).toBe(5737);
    expect(resolveTunnelIngressPort({ XPOD_PORT: '4000' })).toBe(4000);
    expect(resolveTunnelIngressPort({ CSS_PORT: '3001' })).toBe(3000);
  });
});
