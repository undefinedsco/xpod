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

  it('keeps the API container startable when optional delegated Pod access credentials are missing', () => {
    const container = createApiContainer(baseConfig({
      gatewayInternalClientId: undefined,
      gatewayInternalClientSecret: undefined,
    }));

    expect(container.resolve('gatewayInternalPodAccess')).toBeUndefined();
    expect(container.resolve('gatewayAccessKeyRepository')).toBeTruthy();
  });

  it('disables the gateway repository instead of falling back to rotating service tokens', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: undefined,
      gatewayLocatorKeyId: undefined,
      serviceToken: 'rotating-service-token',
      nodeToken: 'rotating-node-token',
    }));

    expect(container.resolve('gatewayAccessKeyRepository')).toBeUndefined();
  });

  it('constructs the default gateway repository when locator and internal access are configured', () => {
    const container = createApiContainer(baseConfig());

    expect(container.resolve('gatewayAccessKeyRepository')).toBeTruthy();
  });

  it('keeps inference available with plaintext Pod credentials', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: '0123456789abcdef0123456789abcdef',
    }));

    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('constructs the inference gateway service when required dependencies are configured', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: '0123456789abcdef0123456789abcdef',
    }));

    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('constructs a disabled provider Connect service by default without requiring a credential encryption vault', async () => {
    const service = createApiContainer(baseConfig()).resolve('providerConnectService');

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      status: 'unsupported',
      message: expect.stringContaining('disabled'),
    });
  });

  it('uses plaintext Pod credentials when Connect is enabled', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
    })).resolve('providerConnectService');

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({ status: 'pending' });
  });

  it('starts Kimi API-key Connect without requiring a Kimi client id', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
    })).resolve('providerConnectService');

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      status: 'pending',
      mode: 'browserAssistedApiKey',
    });
    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'kimi',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      status: 'pending',
      mode: 'browserAssistedApiKey',
      authorizationUrl: expect.stringContaining('platform.moonshot.cn/console/api-keys'),
    });
  });

  it('constructs the configured provider Connect service with plaintext Pod credentials', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
    })).resolve('providerConnectService');

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      status: 'pending',
      mode: 'browserAssistedApiKey',
    });
  });
});
