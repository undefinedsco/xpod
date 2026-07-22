import { describe, expect, it } from 'vitest';

import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig } from '../../../src/api/container';

function baseConfig(overrides: Partial<ApiContainerConfig> = {}): ApiContainerConfig {
  return {
    edition: 'local',
    port: 3001,
    host: '127.0.0.1',
    authMode: 'acp',
    databaseUrl: ':memory:',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'https://issuer.example/.oidc/token',
    gatewayLocatorSecret: 'locator-secret',
    gatewayLocatorKeyId: 'active',
    gatewayInternalClientId: 'internal-client',
    gatewayInternalClientSecret: 'internal-secret',
    ...overrides,
  };
}

describe('Gateway internal Pod access container config', () => {
  it('loads internal gateway client credentials from env without using user/provider AI secrets', () => {
    const previous = { ...process.env };
    try {
      process.env.XPOD_GATEWAY_LOCATOR_SECRET = 'locator-secret';
      process.env.XPOD_GATEWAY_LOCATOR_KEY_ID = 'active';
      process.env.XPOD_GATEWAY_PREVIOUS_LOCATOR_SECRETS = 'old-1:previous-secret,old-2:older-secret';
      process.env.XPOD_GATEWAY_INTERNAL_CLIENT_ID = 'internal-client';
      process.env.XPOD_GATEWAY_INTERNAL_CLIENT_SECRET = 'internal-secret';

      const config = loadConfigFromEnv();

      expect(config.gatewayLocatorSecret).toBe('locator-secret');
      expect(config.gatewayLocatorKeyId).toBe('active');
      expect(config.gatewayPreviousLocatorSecrets).toEqual([
        { kid: 'old-1', secret: 'previous-secret' },
        { kid: 'old-2', secret: 'older-secret' },
      ]);
      expect(config.gatewayInternalClientId).toBe('internal-client');
      expect(config.gatewayInternalClientSecret).toBe('internal-secret');
    } finally {
      process.env = previous;
    }
  });

  it('fails fast when production gateway Pod access credentials are missing', () => {
    const container = createApiContainer(baseConfig({
      gatewayInternalClientId: undefined,
      gatewayInternalClientSecret: undefined,
    }));

    expect(() => container.resolve('gatewayAccessKeyRepository')).toThrow(/GATEWAY_INTERNAL_CLIENT_ID/);
  });

  it('does not silently fall back to rotating service tokens as locator secrets', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: undefined,
      gatewayLocatorKeyId: undefined,
      serviceToken: 'rotating-service-token',
      nodeToken: 'rotating-node-token',
    }));

    expect(() => container.resolve('gatewayAccessKeyRepository')).toThrow(/GATEWAY_LOCATOR_SECRET/);
  });

  it('constructs the default gateway repository when locator and internal access are configured', () => {
    const container = createApiContainer(baseConfig());

    expect(container.resolve('gatewayAccessKeyRepository')).toBeTruthy();
  });
});
