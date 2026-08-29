import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig } from '../../../src/api/container';
import { secretPathForGatewayLocatorDatabase } from '../../../src/runtime/gateway-locator-secret';

const cleanupRoots: string[] = [];

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
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create a Cloud API endpoint for standalone local mode', () => {
    delete process.env.XPOD_NODE_TOKEN;
    delete process.env.oidcIssuer;
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';

    const config = loadConfigFromEnv();

    expect(config.cloudApiEndpoint).toBeUndefined();
  });

  it('loads XPOD_SERVICE_TOKEN into config as the single local service credential', () => {
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';
    process.env.XPOD_SERVICE_TOKEN = 'svc-local-config-token';

    const config = loadConfigFromEnv();

    expect(config.serviceToken).toBe('svc-local-config-token');
  });

  it('restores Cloud-managed tunnel credentials from the local provision state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-local-provision-state-'));
    const setupPath = path.join(dir, '.xpod-cloud-registration.json');
    fs.writeFileSync(setupPath, JSON.stringify({
      local: {
        nodeId: 'local-device-id',
        nodeToken: 'node-token',
        serviceToken: 'service-token',
        provisionCode: 'provision-code',
        publicUrl: 'https://node-0000.undefineds.co/',
        spDomain: 'node-0000.undefineds.co',
        cloudIdentityUrl: 'https://id.undefineds.co/',
        cloudApiUrl: 'https://api.undefineds.co/',
        tunnelToken: 'cf-token-issued-by-cloud',
        tunnelProvider: 'cloudflare',
        tunnelEndpoint: 'https://node-0000.undefineds.co/',
      },
    }));

    process.env.XPOD_EDITION = 'local';
    process.env.XPOD_LOCAL_SETUP_PATH = setupPath;

    const config = loadConfigFromEnv();

    expect(config.cloudflareTunnelToken).toBe('cf-token-issued-by-cloud');
    expect(config.tunnelProvider).toBe('cloudflare');
    expect(config.tunnelActiveProfileId).toBe('cloud-managed');
    expect(config.activeTunnelProfile).toMatchObject({
      id: 'cloud-managed',
      provider: 'cloudflare',
      publicUrl: 'https://node-0000.undefineds.co/',
    });
  });

  it('loads an explicit OpenAI gateway fixture base URL for local E2E runs', () => {
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_ROOT_FILE_PATH = '.test-data/api-container-config';
    process.env.XPOD_AI_GATEWAY_OPENAI_BASE_URL = 'http://127.0.0.1:48111/v1/';

    const config = loadConfigFromEnv();

    expect(config.aiGatewayProviderBaseUrls?.openai).toBe('http://127.0.0.1:48111/v1');
  });

  it('loads an explicit Gateway locator secret without deriving a local file secret', () => {
    process.env.XPOD_EDITION = 'local';
    process.env.CSS_IDENTITY_DB_URL = ':memory:';
    process.env.XPOD_GATEWAY_LOCATOR_SECRET = 'explicit-gateway-locator-secret';

    const config = loadConfigFromEnv();
    const container = createApiContainer(config);

    expect(config.gatewayLocatorSecret).toBe('explicit-gateway-locator-secret');
    expect(() => container.resolve('gatewayAccessKeyRepository')).not.toThrow();
  });

  it('derives a persistent Gateway locator secret for local SQLite identity storage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-container-locator-'));
    cleanupRoots.push(root);
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    const container = createApiContainer(baseConfig({ databaseUrl }));

    expect(() => container.resolve('gatewayAccessKeyRepository')).not.toThrow();
    const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    expect(fs.existsSync(secretPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    }
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

  it('derives Cloud issuer, public URL, and API endpoint from CSS_BASE_URL', () => {
    process.env.XPOD_EDITION = 'cloud';
    process.env.CSS_BASE_URL = 'https://id.undefineds.co/';
    delete process.env.SOLID_OIDC_ISSUER;
    delete process.env.XPOD_PUBLIC_URL;

    const config = loadConfigFromEnv();

    expect(config.oidcIssuer).toBe('https://id.undefineds.co/');
    expect(config.publicUrl).toBe('https://id.undefineds.co/');
    expect(config.cloudApiEndpoint).toBe('https://api.undefineds.co');
  });

  it('constructs provider Connect without eagerly requiring internal service credentials', async () => {
    const container = createApiContainer(baseConfig());
    const service = container.resolve('providerConnectService');
    const quotaService = container.resolve('providerQuotaService') as any;

    expect((service as any).credentialRepository).toBeTruthy();
    expect((service as any).vault).toBeTruthy();
    // Connect is always on: adapters are registered without any toggle or secret.
    expect((service as any).adapters.size).toBeGreaterThan(0);
    expect((service as any).registry).toBeTruthy();
    expect(quotaService).toBeTruthy();
    expect(quotaService.adapters.get('openai')).toHaveLength(2);
    expect(quotaService.adapters.get('anthropic')).toHaveLength(2);
    expect(quotaService.adapters.get('kimi')).toHaveLength(2);
  });

  it('injects one singleton internal Pod access provider into all gateway services that need Pod access', () => {
    const container = createApiContainer(baseConfig({
      aiGatewayConnectSigningSecret: 'connect-signing-secret',
      secretCellCredentialVaultFactory: testCredentialVault,
    }));

    const internalPodAccess = container.resolve('hostedPodDataAccess');
    const providerConnectService = container.resolve('providerConnectService') as any;
    const gatewayCredentialStore = container.resolve('gatewayCredentialStore') as any;
    const providerQuotaService = container.resolve('providerQuotaService') as any;
    const podModelSelectionRepository = container.resolve('podModelSelectionRepository') as any;
    const providerModelsService = container.resolve('providerModelsService') as any;
    const providerModelSelectionService = container.resolve('providerModelSelectionService') as any;
    const aiGatewayService = container.resolve('aiGatewayService') as any;

    expect(providerConnectService.credentialRepository.internalPodAccess).toBe(internalPodAccess);
    expect(gatewayCredentialStore.internalPodAccess).toBe(internalPodAccess);
    expect(providerQuotaService.repository.internalPodAccess).toBe(internalPodAccess);
    expect(providerQuotaService.credentialRepository.internalPodAccess).toBe(internalPodAccess);
    expect(podModelSelectionRepository.internalPodAccess).toBe(internalPodAccess);
    expect(providerModelSelectionService.modelsService).toBe(providerModelsService);
    expect(providerModelSelectionService.credentialVault).toBeTruthy();
    expect(aiGatewayService.router.selectionRepository).toBeUndefined();
    expect(aiGatewayService.cloudModels).toBeUndefined();
  });

  it('splices Cloud /v1/models for local edition using the Cloud identity origin', () => {
    const container = createApiContainer(baseConfig({
      oidcIssuer: 'https://id.undefineds.co/',
      solidBaseUrl: 'http://127.0.0.1:3000/',
      publicUrl: 'https://node-0000.undefineds.co/',
    }));
    const aiGatewayService = container.resolve('aiGatewayService') as any;

    expect(aiGatewayService.router.selectionRepository).toBeUndefined();
    expect(aiGatewayService.cloudModels).toBeTruthy();
    expect(aiGatewayService.cloudModels.modelsUrl).toBe('https://id.undefineds.co/v1/models');
  });

  it('does not splice Cloud /v1/models when this process already is Cloud', () => {
    const container = createApiContainer(baseConfig({
      edition: 'cloud',
      oidcIssuer: 'https://id.undefineds.co/',
      solidBaseUrl: 'https://id.undefineds.co/',
    }));
    const aiGatewayService = container.resolve('aiGatewayService') as any;

    expect(aiGatewayService.cloudModels).toBeUndefined();
  });

  it('fails closed for Cloud Gateway API keys without a stable shared locator secret', () => {
    const container = createApiContainer(baseConfig({
      edition: 'cloud',
      databaseUrl: 'postgres://db.example/xpod',
    }));

    expect(() => container.resolve('gatewayAccessKeyRepository'))
      .toThrow(/XPOD_GATEWAY_LOCATOR_SECRET is required for Cloud Gateway API keys/u);
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
