import { describe, expect, it } from 'vitest';

import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig } from '../../../src/api/container';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';

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

function testCredentialVault(): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ keyWrapper: new TestKeyWrapper() });
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
    ...overrides,
  };
}

describe('AI credential container config', () => {
  it('does not load obsolete Gateway locator or internal client credentials', () => {
    const previous = { ...process.env };
    try {
      process.env.XPOD_GATEWAY_LOCATOR_SECRET = 'locator-secret';
      process.env.XPOD_GATEWAY_LOCATOR_KEY_ID = 'active';
      process.env.XPOD_GATEWAY_PREVIOUS_LOCATOR_SECRETS = 'old-1:previous-secret,old-2:older-secret';
      process.env.XPOD_GATEWAY_INTERNAL_CLIENT_ID = 'internal-client';
      process.env.XPOD_GATEWAY_INTERNAL_CLIENT_SECRET = 'internal-secret';
      process.env.XPOD_SECRET_CELL_KEY_ID = 'active-cell';
      process.env.XPOD_SECRET_CELL_KEY = Buffer.alloc(32, 1).toString('base64');
      process.env.XPOD_SECRET_CELL_PREVIOUS_KEYS = JSON.stringify({
        'previous-cell': Buffer.alloc(32, 2).toString('base64'),
      });

      const config = loadConfigFromEnv();

      expect(config).not.toHaveProperty('gatewayLocatorSecret');
      expect(config).not.toHaveProperty('gatewayLocatorKeyId');
      expect(config).not.toHaveProperty('gatewayPreviousLocatorSecrets');
      expect(config).not.toHaveProperty('gatewayInternalClientId');
      expect(config).not.toHaveProperty('gatewayInternalClientSecret');
      expect(config.secretCellCredentialVaultFactory).toBeTypeOf('function');
    } finally {
      process.env = previous;
    }
  });

  it('constructs the production SecretCell vault from env and rejects invalid root keys', async() => {
    const previous = { ...process.env };
    try {
      process.env.XPOD_SECRET_CELL_KEY_ID = 'active-cell';
      process.env.XPOD_SECRET_CELL_KEY = Buffer.alloc(32, 3).toString('base64');
      process.env.XPOD_SECRET_CELL_PREVIOUS_KEYS = JSON.stringify({
        'previous-cell': Buffer.alloc(32, 4).toString('base64'),
      });
      const vault = loadConfigFromEnv().secretCellCredentialVaultFactory?.();
      expect(vault).toBeTruthy();
      const principal = { webId: 'https://id.example/alice/profile/card#me' };
      const credentialIri = 'https://pod.example/settings/credentials.ttl#openai';
      const encrypted = await vault!.seal(principal, credentialIri, 'openai', { apiKey: 'sk-test' });
      await expect(vault!.open(principal, credentialIri, 'openai', encrypted))
        .resolves.toEqual({ apiKey: 'sk-test' });

      process.env.XPOD_SECRET_CELL_KEY = Buffer.alloc(31, 3).toString('base64');
      expect(() => loadConfigFromEnv()).toThrow(/32 bytes/);
      process.env.XPOD_SECRET_CELL_KEY = Buffer.alloc(32, 3).toString('base64');
      process.env.XPOD_SECRET_CELL_PREVIOUS_KEYS = '[]';
      expect(() => loadConfigFromEnv()).toThrow(/JSON object/);
      process.env.XPOD_SECRET_CELL_PREVIOUS_KEYS = JSON.stringify({
        'unsafe key id': Buffer.alloc(32, 4).toString('base64'),
      });
      expect(() => loadConfigFromEnv()).toThrow(/safe key ID/);
    } finally {
      process.env = previous;
    }
  });

  it('keeps the API container startable without delegated Pod access credentials or locator secret', () => {
    const container = createApiContainer(baseConfig());

    expect(container.resolve('invocationTokenCodec')).toBeTruthy();
    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('registers one shared Pod model selection repository and service', () => {
    const container = createApiContainer(baseConfig());
    const raw = container as any;
    const repository = raw.resolve('podModelSelectionRepository');
    const service = raw.resolve('providerModelSelectionService');

    expect(repository).toBeTruthy();
    expect(service).toBeTruthy();
    expect(raw.resolve('podModelSelectionRepository')).toBe(repository);
    expect(raw.resolve('providerModelSelectionService')).toBe(service);
  });

  it('injects the shared Pod model selection repository into Gateway routing', () => {
    const container = createApiContainer(baseConfig());
    const raw = container as any;
    const repository = raw.resolve('podModelSelectionRepository');
    const gateway = raw.resolve('aiGatewayService');

    expect(gateway.router.selectionRepository).toBe(repository);
  });

  it('does not use rotating service tokens as invocation or affinity secrets', () => {
    const container = createApiContainer(baseConfig({
      serviceToken: 'rotating-service-token',
      nodeToken: 'rotating-node-token',
    }));

    expect(container.resolve('invocationTokenCodec')).toBeTruthy();
    expect(container.resolve('gatewaySessionAffinityStore')).toBeTruthy();
  });

  it('constructs hosted Pod data access without delegated client credentials', () => {
    const container = createApiContainer(baseConfig({
      gatewayAdminProxyAuthSecret: 'admin-proxy-secret',
    }));

    expect(container.resolve('hostedPodDataAccess')).toBeTruthy();
    expect(container.resolve('gatewayCredentialStore')).toBeTruthy();
  });

  it('constructs inference without requiring the SecretCell credential vault', () => {
    const container = createApiContainer(baseConfig({
      secretCellCredentialVaultFactory: undefined,
    }));

    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('constructs the inference gateway service when required dependencies are configured', () => {
    const container = createApiContainer(baseConfig({
      secretCellCredentialVaultFactory: testCredentialVault,
    }));

    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('constructs a disabled provider Connect service by default without requiring a SecretCell vault', async () => {
    const service = createApiContainer(baseConfig({ aiGatewayConnectEnabled: false })).resolve('providerConnectService');

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).rejects.toThrow('connect_disabled');
  });

  it('enables provider Connect by default for product configuration', () => {
    const previous = { ...process.env };
    try {
      delete process.env.XPOD_AI_GATEWAY_CONNECT_ENABLED;
      expect(loadConfigFromEnv().aiGatewayConnectEnabled).toBe(true);
    } finally {
      process.env = previous;
    }
  });

  it('keeps Connect enabled without requiring the SecretCell credential vault', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayKimiClientId: 'xpod-kimi-client',
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
      secretCellCredentialVaultFactory: undefined,
    })).resolve('providerConnectService');

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({ status: 'pending' });
  });

  it('keeps browser-assisted Connect usable when only the optional Kimi client id is missing', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      secretCellCredentialVaultFactory: testCredentialVault,
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

  it('constructs the configured provider Connect service with Kimi client id', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
      aiGatewayKimiClientId: 'xpod-kimi-client',
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
