import { createContainer, asValue, InjectionMode } from 'awilix';
import { describe, expect, it } from 'vitest';
import { registerCloudServices } from '../../../src/api/container/cloud';

describe('registerCloudServices', () => {
  it('registers Cloudflare DNS provider when only Cloudflare creds are present', () => {
    const container = createContainer({
      injectionMode: InjectionMode.PROXY,
      strict: true,
    });

    container.register({
      config: asValue({
        edition: 'cloud',
        port: 3001,
        host: '127.0.0.1',
        databaseUrl: 'sqlite::memory:',
        corsOrigins: ['*'],
        cssTokenEndpoint: 'http://localhost/.oidc/token',
        subdomain: {
          baseStorageDomain: 'nodes.undefineds.co',
          cloudflareAccountId: 'account-1',
          cloudflareApiToken: 'cf-token-1',
        },
      }),
      db: asValue({} as any),
      nodeRepo: asValue({} as any),
    });

    registerCloudServices(container as any);

    const dnsProvider = container.resolve('dnsProvider');
    const tunnelProvider = container.resolve('tunnelProvider');

    expect(dnsProvider).toBeTruthy();
    expect(tunnelProvider).toBeTruthy();
  });
});
