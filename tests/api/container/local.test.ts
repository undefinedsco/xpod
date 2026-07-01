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
  const originalTunnelProvider = process.env.XPOD_TUNNEL_PROVIDER;

  afterEach(() => {
    if (originalTunnelProvider === undefined) {
      delete process.env.XPOD_TUNNEL_PROVIDER;
    } else {
      process.env.XPOD_TUNNEL_PROVIDER = originalTunnelProvider;
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
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
    process.env.XPOD_TUNNEL_PROVIDER = 'ngrok';
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


  it('uses the selected tunnel profile rather than starting every configured tunnel', async () => {
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
        cloudflareTunnelToken: 'cf-token',
        ngrokAuthToken: 'ngrok-token',
        ngrokUrl: 'https://legacy.ngrok-free.dev',
        tunnelActiveProfileId: 'cloudflare-home',
        tunnelProfiles: [
          {
            id: 'ngrok-dev',
            provider: 'ngrok',
            publicUrl: 'https://native.ngrok-free.dev/',
            credentialEnvKey: 'NGROK_AUTHTOKEN',
            credentialConfigured: true,
          },
          {
            id: 'cloudflare-home',
            provider: 'cloudflare',
            publicUrl: 'https://home-tunnel.example.com/',
            credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
            credentialConfigured: true,
          },
        ],
      }),
      db: asValue({} as any),
    });

    registerLocalServices(container as any);

    const localTunnelProvider = container.resolve('localTunnelProvider');
    expect(localTunnelProvider.name).toBe('cloudflare-local');
    await expect(localTunnelProvider.setup({ subdomain: 'local', localPort: 5737 })).resolves.toMatchObject({
      endpoint: 'https://home-tunnel.example.com/',
    });
    container.resolve('ddnsManager');
    expect(DdnsManager).toHaveBeenCalledWith(expect.objectContaining({
      tunnelProvider: 'cloudflare',
    }));
  });

  it('does not activate Cloudflare tunnel without a user-provided tunnel token', () => {
    process.env.XPOD_TUNNEL_PROVIDER = 'cloudflare';
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


  it('treats cloud endpoint without nodeToken as pending provisioning, not managed or standalone', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
        cloudApiEndpoint: 'https://api.undefineds.co',
        nodeId: 'local-device-id',
      }),
      db: asValue({} as any),
    });

    registerLocalServices(container as any);

    expect(() => container.resolve('subdomainClient')).toThrow();
    expect(() => container.resolve('ddnsManager')).toThrow();
    expect(DdnsManager).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[Local] Managed setup pending (waiting for Cloud-issued XPOD_NODE_TOKEN)');
    expect(logSpy).not.toHaveBeenCalledWith('[Local] Standalone mode (no XPOD_NODE_TOKEN)');
  });

  it('uses api.undefineds.co as the default Cloud API while waiting for nodeToken', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
        nodeId: 'local-device-id',
      }),
      db: asValue({} as any),
    });

    registerLocalServices(container as any);

    expect(() => container.resolve('subdomainClient')).toThrow();
    expect(() => container.resolve('ddnsManager')).toThrow();
    expect(logSpy).toHaveBeenCalledWith('[Local] Managed setup pending (waiting for Cloud-issued XPOD_NODE_TOKEN)');
    expect(logSpy).toHaveBeenCalledWith('[Local] Cloud API endpoint: https://api.undefineds.co');
  });
});
