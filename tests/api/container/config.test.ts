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
    databaseUrl: 'sqlite::memory:',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'https://issuer.example/.oidc/token',
    ...overrides,
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

  it('keeps example env files free of removed credential-cell configuration', () => {
    const removedMarkers = ['XPOD_SECRET_CELL', 'SecretCell'];

    for (const envFile of ['example.env.local', 'example.env.cloud']) {
      const content = fs.readFileSync(path.resolve(envFile), 'utf8');

      for (const marker of removedMarkers) {
        expect(content).not.toContain(marker);
      }
    }
  });

  it('installs only stateless provider probes and no Pod-backed AI management runtime', () => {
    const container = createApiContainer(baseConfig());

    expect(container.resolve('providerProbeService')).toBeDefined();

    expect(container.hasRegistration('gatewayInternalPodAccess')).toBe(false);
    expect(container.hasRegistration('gatewayAccessKeyRepository')).toBe(false);
    expect(container.hasRegistration('invocationTokenCodec')).toBe(false);
    expect(container.hasRegistration('aiConnectionInvocationKeyIssuer')).toBe(false);
    expect(container.hasRegistration('gatewayCredentialStore')).toBe(false);
    expect(container.hasRegistration('gatewayRuntimeRegistry')).toBe(false);
    expect(container.hasRegistration('gatewaySessionAffinityStore')).toBe(false);
    expect(container.hasRegistration('aiGatewayService')).toBe(false);
    expect(container.hasRegistration('providerConnectService')).toBe(false);
    expect(container.hasRegistration('providerQuotaService')).toBe(false);
    expect(container.hasRegistration('providerModelsService')).toBe(false);
    expect(container.hasRegistration('providerCustomModelsService')).toBe(false);
  });

  it('does not restore durable agent authority from a bare WebID registry entry', async () => {
    const container = createApiContainer(baseConfig());
    const registry = container.resolve('runAuthContextRegistry');
    const webId = 'https://pod.example/alice/profile/card#me';
    registry.remember({
      userId: webId,
      auth: {
        type: 'solid',
        webId,
        clientId: 'caller-client-id',
        clientSecret: 'caller-client-secret',
        viaApiKey: true,
      },
    });

    const backend = container.resolve('runExecutionBackend') as any;

    await expect(backend.contextResolver({
      runId: 'run-without-binding',
      threadId: 'thread-without-binding',
      webId,
    })).resolves.toBeUndefined();
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
