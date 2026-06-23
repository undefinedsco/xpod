import { createContainer, asValue, InjectionMode } from 'awilix';
import { describe, expect, it, vi } from 'vitest';
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
