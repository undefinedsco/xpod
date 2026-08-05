import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    ...overrides,
  };
}

function testCredentialVault(): any {
  return {
    seal: async () => ({ algorithm: 'test', keyId: 'test', wrappedDek: 'test', ciphertext: 'test', iv: 'test' }),
    open: async () => ({ apiKey: 'sk-test' }),
    needsRewrap: () => false,
    rewrap: async (secret: unknown) => secret,
  };
}

describe('loadConfigFromEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('normalizes an inline comment accidentally included in XPOD_EDITION', () => {
    process.env.XPOD_EDITION = 'local                    # local or cloud';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';

    expect(loadConfigFromEnv().edition).toBe('local');
  });

  it('rejects an unsupported XPOD_EDITION instead of leaking it into credential ids', () => {
    process.env.XPOD_EDITION = 'preview';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';

    expect(() => loadConfigFromEnv()).toThrow(/XPOD_EDITION.*local.*cloud/i);
  });

  it('defaults local Cloud API endpoint to api.undefineds.co', () => {
    delete process.env.XPOD_CLOUD_API_ENDPOINT;
    delete process.env.XPOD_NODE_TOKEN;
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';

    const config = loadConfigFromEnv();

    expect(config.cloudApiEndpoint).toBe('https://api.undefineds.co');
  });

  it('loads XPOD_SERVICE_TOKEN into config as the single local service credential', () => {
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';
    process.env.XPOD_SERVICE_TOKEN = 'svc-local-config-token';

    const config = loadConfigFromEnv();

    expect(config.serviceToken).toBe('svc-local-config-token');
  });

  it('loads an explicit OpenAI gateway fixture base URL for local E2E runs', () => {
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';
    process.env.XPOD_AI_GATEWAY_OPENAI_BASE_URL = 'http://127.0.0.1:48111/v1/';

    const config = loadConfigFromEnv();

    expect(config.aiGatewayProviderBaseUrls?.openai).toBe('http://127.0.0.1:48111/v1');
  });

  it('enables AI Connection by default and only disables it with an explicit false value', () => {
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';
    delete process.env.XPOD_AI_GATEWAY_CONNECT_ENABLED;

    expect(loadConfigFromEnv().aiGatewayConnectEnabled).toBe(true);

    process.env.XPOD_AI_GATEWAY_CONNECT_ENABLED = 'false';
    expect(loadConfigFromEnv().aiGatewayConnectEnabled).toBe(false);
  });

  it('constructs disabled provider Connect without delegated service credentials', async () => {
    const service = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: false,
    })).resolve('providerConnectService');

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).rejects.toThrow('connect_disabled');
  });

  it('injects one singleton hosted Pod data adapter into active AI Connection Pod paths', () => {
    const container = createApiContainer(baseConfig({
      aiGatewayConnectEnabled: true,
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
      gatewayAdminProxyAuthSecret: 'admin-proxy-secret',
    }));

    const hostedPodDataAccess = container.resolve('hostedPodDataAccess');
    const providerConnectService = container.resolve('providerConnectService') as any;
    const gatewayCredentialStore = container.resolve('gatewayCredentialStore') as any;
    const providerQuotaService = container.resolve('providerQuotaService') as any;

    expect(providerConnectService.credentialRepository.internalPodAccess).toBe(hostedPodDataAccess);
    expect(gatewayCredentialStore.internalPodAccess).toBe(hostedPodDataAccess);
    expect(providerQuotaService.repository.internalPodAccess).toBe(hostedPodDataAccess);
    expect(providerQuotaService.credentialRepository.internalPodAccess).toBe(hostedPodDataAccess);
  });

  it('does not use public CSS_BASE_URL as the hosted Pod internal channel', () => {
    process.env.CSS_BASE_URL = 'https://pod.example/';
    delete process.env.CSS_INTERNAL_URL;
    const container = createApiContainer(baseConfig({
      gatewayAdminProxyAuthSecret: 'admin-proxy-secret',
    }));

    const hostedPodDataAccess = container.resolve('hostedPodDataAccess') as any;

    expect(hostedPodDataAccess.cssBaseUrl.href).toBe('http://127.0.0.1:3000/');
  });

  it('routes hosted Pod access through the loopback Gateway instead of the CSS child port', () => {
    process.env.CSS_INTERNAL_URL = 'http://localhost:6501/';
    process.env.XPOD_MAIN_PORT = '6500';
    const container = createApiContainer(baseConfig({
      gatewayAdminProxyAuthSecret: 'admin-proxy-secret',
    }));

    const hostedPodDataAccess = container.resolve('hostedPodDataAccess') as any;

    expect(hostedPodDataAccess.cssBaseUrl.href).toBe('http://127.0.0.1:6500/');
  });

  it('does not expose hosted Pod access to a non-loopback CSS_INTERNAL_URL', () => {
    process.env.CSS_INTERNAL_URL = 'https://pod.example/';
    process.env.XPOD_MAIN_PORT = '6500';
    const container = createApiContainer(baseConfig({
      gatewayAdminProxyAuthSecret: 'admin-proxy-secret',
    }));

    const hostedPodDataAccess = container.resolve('hostedPodDataAccess') as any;

    expect(hostedPodDataAccess.cssBaseUrl.href).toBe('http://127.0.0.1:6500/');
  });

  it('restores first-run Local Cloud credentials from the default setup file without env tokens', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-local-config-'));
    fs.writeFileSync(path.join(rootDir, '.xpod-cloud-registration.json'), JSON.stringify({
      local: {
        nodeId: 'persisted-node',
        nodeToken: 'persisted-node-token',
        serviceToken: 'svc-persisted',
        provisionCode: 'persisted-provision-code',
        publicUrl: 'https://node-0000.undefineds.co/',
        spDomain: 'node-0000.undefineds.co',
        cloudIdentityUrl: 'https://id.undefineds.co/',
        cloudApiUrl: 'https://api.undefineds.co/',
      },
    }), 'utf8');
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = rootDir;
    delete process.env.XPOD_NODE_ID;
    delete process.env.XPOD_NODE_TOKEN;
    delete process.env.XPOD_SERVICE_TOKEN;
    delete process.env.XPOD_PROVISION_CODE;

    const config = loadConfigFromEnv();

    expect(config.nodeId).toBe('persisted-node');
    expect(config.nodeToken).toBe('persisted-node-token');
    expect(config.serviceToken).toBe('svc-persisted');
    expect(config.provisionCode).toBe('persisted-provision-code');
    expect(config.publicUrl).toBe('https://node-0000.undefineds.co/');
    expect(config.spDomain).toBe('node-0000.undefineds.co');
    expect(config.oidcIssuer).toBe('https://id.undefineds.co/');
    expect(config.cloudApiEndpoint).toBe('https://api.undefineds.co/');
  });

});
