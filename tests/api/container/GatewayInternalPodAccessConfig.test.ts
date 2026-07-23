import { describe, expect, it } from 'vitest';

import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig } from '../../../src/api/container';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';

class TestKeyWrapper implements KeyWrapper {
  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    return {
      algorithm: 'test-wrapper',
      keyId: context.provider,
      wrappedDek: Buffer.from(dek).toString('base64url'),
    };
  }

  public async unwrapDek(_context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(wrapped.wrappedDek, 'base64url'));
  }
}

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

  it('fails fast for inference without the platform credential wrapper', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: '0123456789abcdef0123456789abcdef',
      aiGatewayCredentialKeyWrapperFactory: undefined,
    }));

    expect(() => container.resolve('aiGatewayService')).toThrow(/credentialKeyWrapperFactory/i);
  });

  it('constructs the inference gateway service when required dependencies are configured', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: '0123456789abcdef0123456789abcdef',
      aiGatewayCredentialKeyWrapperFactory: () => new TestKeyWrapper(),
    }));

    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('constructs a disabled provider Connect service by default without requiring platform wrappers', async () => {
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

  it('fails fast when Connect is enabled without the platform credential wrapper', () => {
    expect(() => createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayKimiClientId: 'xpod-kimi-client',
      aiGatewayCredentialKeyWrapperFactory: undefined,
    })).resolve('providerConnectService')).toThrow(/CredentialKeyWrapperFactory/i);
  });

  it('keeps browser-assisted Connect usable when only the optional Kimi client id is missing', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayCredentialKeyWrapperFactory: () => new TestKeyWrapper(),
      aiGatewayKimiClientId: undefined,
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
      requestedMode: 'deviceCodeOAuth',
    })).resolves.toMatchObject({
      status: 'unsupported',
      mode: 'deviceCodeOAuth',
      message: expect.stringMatching(/not_configured|client id/i),
    });
  });

  it('constructs the configured provider Connect service with injected platform wrapper and Kimi client id', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
      aiGatewayKimiClientId: 'xpod-kimi-client',
      aiGatewayCredentialKeyWrapperFactory: () => new TestKeyWrapper(),
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
