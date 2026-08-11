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
    gatewayLocatorSecret: 'locator-secret',
    gatewayInternalClientId: 'internal-client',
    gatewayInternalClientSecret: 'internal-secret',
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

  it('explicitly enables the local filesystem AI client configuration capability', () => {
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';
    process.env.XPOD_AI_CLIENT_CONFIGURATION_ENABLED = 'true';
    process.env.XPOD_AI_CLIENT_CONFIGURATION_HOME_DIR = '/tmp/xpod-ai-client-home';
    process.env.XPOD_AI_CLIENT_CONFIGURATION_BACKUP_ROOT = '/tmp/xpod-ai-client-backups';

    const config = loadConfigFromEnv();

    expect(config.aiClientConfiguration).toEqual({
      enabled: true,
      authority: 'local-filesystem',
      homeDir: '/tmp/xpod-ai-client-home',
      backupRoot: '/tmp/xpod-ai-client-backups',
    });
  });

  it('does not enable a local filesystem capability for cloud edition', () => {
    process.env.XPOD_EDITION = 'cloud';
    process.env.XPOD_AI_CLIENT_CONFIGURATION_ENABLED = 'true';
    process.env.XPOD_AI_CLIENT_CONFIGURATION_HOME_DIR = '/tmp/xpod-ai-client-home';

    expect(loadConfigFromEnv().aiClientConfiguration).toBeUndefined();
  });

  it('constructs disabled provider Connect without eagerly requiring internal service credentials', async () => {
    const container = createApiContainer(baseConfig({
      gatewayInternalClientId: undefined,
      gatewayInternalClientSecret: undefined,
      aiGatewayConnectEnabled: false,
    }));
    const service = container.resolve('providerConnectService');
    const quotaService = container.resolve('providerQuotaService') as any;

    expect((service as any).credentialRepository).toBeTruthy();
    expect((service as any).vault).toBeTruthy();

    await expect(service.begin({
      webId: 'https://id.example/alice/profile/card#me',
      deployment: 'local',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({ status: 'unsupported' });
    expect(quotaService).toBeTruthy();
    expect(quotaService.adapters.get('openai')).toHaveLength(2);
    expect(quotaService.adapters.get('anthropic')).toHaveLength(2);
    expect(quotaService.adapters.get('kimi')).toHaveLength(2);
  });

  it('injects one singleton internal Pod access provider into all gateway services that need Pod access', () => {
    const container = createApiContainer(baseConfig({
      gatewayLocatorSecret: '0123456789abcdef0123456789abcdef',
      aiGatewayConnectEnabled: true,
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
      secretCellCredentialVaultFactory: testCredentialVault,
    }));

    const internalPodAccess = container.resolve('hostedPodDataAccess');
    const gatewayAccessKeyRepository = container.resolve('gatewayAccessKeyRepository') as any;
    const providerConnectService = container.resolve('providerConnectService') as any;
    const gatewayCredentialStore = container.resolve('gatewayCredentialStore') as any;
    const providerQuotaService = container.resolve('providerQuotaService') as any;
    const podModelSelectionRepository = container.resolve('podModelSelectionRepository') as any;

    expect(gatewayAccessKeyRepository.internalPodAccess).toBe(internalPodAccess);
    expect(providerConnectService.credentialRepository.internalPodAccess).toBe(internalPodAccess);
    expect(gatewayCredentialStore.internalPodAccess).toBe(internalPodAccess);
    expect(providerQuotaService.repository.internalPodAccess).toBe(internalPodAccess);
    expect(providerQuotaService.credentialRepository.internalPodAccess).toBe(internalPodAccess);
    expect(podModelSelectionRepository.internalPodAccess).toBe(internalPodAccess);
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
