import { createContainer, asValue, InjectionMode } from 'awilix';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLocalServices } from '../../../src/api/container/local';

vi.mock('../../../src/edge/DdnsManager', () => ({
  DdnsManager: vi.fn(function DdnsManager(options: unknown) {
    return { options };
  }),
}));

vi.mock('../../../src/subdomain/SubdomainClient', () => ({
  SubdomainClient: vi.fn(function SubdomainClient(options: unknown) {
    return { options };
  }),
}));

vi.mock('../../../src/edge/EdgeNodeCapabilityDetector', () => ({
  EdgeNodeCapabilityDetector: vi.fn(function EdgeNodeCapabilityDetector(options: unknown) {
    return { options };
  }),
}));

import { DdnsManager } from '../../../src/edge/DdnsManager';

describe('registerLocalServices', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('registers ngrok as the active local tunnel provider and DDNS hint when configured', () => {
    const container = createContainer({
      injectionMode: InjectionMode.PROXY,
      strict: true,
    });
    container.register({
      config: asValue({
        edition: 'local',
        port: 3001,
        host: '127.0.0.1',
        authMode: 'acp',
        databaseUrl: 'sqlite::memory:',
        corsOrigins: ['*'],
        cssTokenEndpoint: 'http://localhost/.oidc/token',
        cloudApiEndpoint: 'https://pods.example',
        nodeId: 'node-1',
        nodeToken: 'opaque-node-token',
        ngrokUrl: 'https://ravioli-basics-throbbing.ngrok-free.dev',
      }),
      db: asValue({} as any),
    });

    registerLocalServices(container as any);

    expect(container.resolve('localTunnelProvider').name).toBe('ngrok');
    container.resolve('ddnsManager');
    expect(DdnsManager).toHaveBeenCalledWith(expect.objectContaining({
      tunnelProvider: 'ngrok',
    }));
  });


  it('allows explicit ngrok provider selection to use an existing ngrok config file', () => {
    vi.stubEnv('XPOD_TUNNEL_PROVIDER', 'ngrok');
    const container = createContainer({
      injectionMode: InjectionMode.PROXY,
      strict: true,
    });
    container.register({
      config: asValue({
        edition: 'local',
        port: 3001,
        host: '127.0.0.1',
        authMode: 'acp',
        databaseUrl: 'sqlite::memory:',
        corsOrigins: ['*'],
        cssTokenEndpoint: 'http://localhost/.oidc/token',
        cloudApiEndpoint: 'https://pods.example',
        nodeId: 'node-1',
        nodeToken: 'opaque-node-token',
      }),
      db: asValue({} as any),
    });

    registerLocalServices(container as any);

    expect(container.resolve('localTunnelProvider').name).toBe('ngrok');
    container.resolve('ddnsManager');
    expect(DdnsManager).toHaveBeenCalledWith(expect.objectContaining({
      tunnelProvider: 'ngrok',
    }));
  });

  it('does not activate Cloudflare tunnel without a user-provided tunnel token', () => {
    vi.stubEnv('XPOD_TUNNEL_PROVIDER', 'cloudflare');
    const container = createContainer({
      injectionMode: InjectionMode.PROXY,
      strict: true,
    });
    container.register({
      config: asValue({
        edition: 'local',
        port: 3001,
        host: '127.0.0.1',
        authMode: 'acp',
        databaseUrl: 'sqlite::memory:',
        corsOrigins: ['*'],
        cssTokenEndpoint: 'http://localhost/.oidc/token',
        cloudApiEndpoint: 'https://pods.example',
        nodeId: 'node-1',
        nodeToken: 'opaque-node-token',
      }),
      db: asValue({} as any),
    });

    registerLocalServices(container as any);

    expect(() => container.resolve('localTunnelProvider')).toThrow();
    container.resolve('ddnsManager');
    expect(DdnsManager).toHaveBeenCalledWith(expect.objectContaining({
      tunnelProvider: 'none',
    }));
  });

  it('does not derive DDNS subdomain from node token credentials', () => {
    const container = createContainer({
      injectionMode: InjectionMode.PROXY,
      strict: true,
    });
    container.register({
      config: asValue({
        edition: 'local',
        port: 3001,
        host: '127.0.0.1',
        authMode: 'acp',
        databaseUrl: 'sqlite::memory:',
        corsOrigins: ['*'],
        cssTokenEndpoint: 'http://localhost/.oidc/token',
        cloudApiEndpoint: 'https://pods.example',
        nodeId: 'node-1',
        nodeToken: 'alice:secret',
      }),
      db: asValue({} as any),
    });

    registerLocalServices(container as any);
    container.resolve('ddnsManager');

    expect(DdnsManager).toHaveBeenCalledWith(expect.objectContaining({
      subdomain: 'node-1',
    }));
  });
});
