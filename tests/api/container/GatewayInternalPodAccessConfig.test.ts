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
    gatewayLocatorSecret: 'locator-secret',
    gatewayLocatorKeyId: 'active',
    gatewayInternalClientId: 'internal-client',
    gatewayInternalClientSecret: 'internal-secret',
    ...overrides,
  };
}

const WEB_ID = 'https://id.example/alice/profile/card#me';

describe('Gateway internal Pod access container config', () => {
  it('loads internal gateway client credentials from env without using user/provider AI secrets', () => {
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

      expect(config.gatewayLocatorSecret).toBe('locator-secret');
      expect(config.gatewayLocatorKeyId).toBe('active');
      expect(config.gatewayPreviousLocatorSecrets).toEqual([
        { kid: 'old-1', secret: 'previous-secret' },
        { kid: 'old-2', secret: 'older-secret' },
      ]);
      expect(config.gatewayInternalClientId).toBe('internal-client');
      expect(config.gatewayInternalClientSecret).toBe('internal-secret');
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
    expect(container.resolve('invocationTokenCodec')).toBeTruthy();
    expect(container.resolve('aiConnectionInvocationKeyIssuer')).toBeTruthy();
  });

  it('authenticates short-lived AI Connection invocation keys without a gateway locator repository', async () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: undefined,
      gatewayLocatorKeyId: undefined,
    }));
    const issuer = container.resolve('aiConnectionInvocationKeyIssuer');
    expect(issuer).toBeDefined();
    const invocation = await issuer!.issue({
      auth: { type: 'solid', webId: WEB_ID },
    });

    await expect(container.resolve('authenticator').authenticate({
      headers: { authorization: `Bearer ${invocation.apiKey}` },
    } as any)).resolves.toMatchObject({
      success: true,
      context: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
      },
    });
  });

  it('constructs the default gateway repository when locator and internal access are configured', () => {
    const container = createApiContainer(baseConfig());

    expect(container.resolve('gatewayAccessKeyRepository')).toBeTruthy();
  });

  it('keeps inference available with plaintext Pod credentials when SecretCell is not configured', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: '0123456789abcdef0123456789abcdef',
      secretCellCredentialVaultFactory: undefined,
    }));

    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('constructs the inference gateway service when required dependencies are configured', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: '0123456789abcdef0123456789abcdef',
      secretCellCredentialVaultFactory: testCredentialVault,
    }));

    expect(container.resolve('aiGatewayService')).toBeTruthy();
  });

  it('constructs a disabled provider Connect service by default without requiring a SecretCell vault', async () => {
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

  it('uses plaintext Pod credentials when Connect is enabled without SecretCell', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayKimiOAuthIntegrationId: 'xpod-kimi-oauth',
      aiGatewayKimiOAuthClientId: 'xpod-kimi-client',
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
      aiGatewayKimiOAuthIntegrationId: undefined,
      aiGatewayKimiOAuthClientId: undefined,
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
    });
  });

  it('does not register Kimi device-code Connect even when legacy Kimi OAuth env exists', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
      aiGatewayKimiOAuthIntegrationId: 'xpod-kimi-oauth',
      aiGatewayKimiOAuthClientId: 'xpod-kimi-client',
      secretCellCredentialVaultFactory: testCredentialVault,
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
    });
    expect(() => service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    })).toThrow('Requested Connect mode does not match provider capability');
    expect((service as any).adapters.get('kimi')?.constructor.name).toBe('BrowserAssistedApiKeyConnectAdapter');
  });
});
