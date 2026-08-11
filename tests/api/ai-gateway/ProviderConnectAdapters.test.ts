import { describe, expect, it, vi } from 'vitest';

import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import type { ProviderSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import { aiRuntimeRepository } from '@undefineds.co/models';
import {
  BrowserAssistedApiKeyConnectAdapter,
  DeepSeekConnectAdapter,
  InMemoryConnectAttemptStore,
  KimiDeviceCodeConnectAdapter,
  OAuthIntegrationRegistry,
  PodConnectedCredentialRepository,
  ProviderConnectService,
  type ConnectBeginResult,
  type ConnectCredentialRecord,
  type PodCredentialRepository,
} from '../../../src/api/ai-gateway/connect';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';
const INTERNAL_INVOCATION_AUTH = {
  type: 'solid' as const,
  webId: WEB_ID,
  internalInvocation: true,
  tokenType: 'Bearer' as const,
};

function withInternalAuth<const T extends Record<string, unknown>>(input: T): T & { auth: typeof INTERNAL_INVOCATION_AUTH } {
  return {
    ...input,
    auth: INTERNAL_INVOCATION_AUTH,
  };
}

class StaticKeyWrapper implements KeyWrapper {
  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    return {
      algorithm: 'test-static-wrap',
      keyId: `${context.webId}|${context.credentialIri}|${context.provider}`,
      wrappedDek: Buffer.from(dek).toString('base64url'),
    };
  }

  public async unwrapDek(_context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(wrapped.wrappedDek, 'base64url'));
  }
}

class RecordingCredentialRepository implements PodCredentialRepository {
  public readonly rows: ConnectCredentialRecord[] = [];
  public version = 0;

  public async getActiveCredential(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = latestMatchingRow(this.rows, (row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment
      && row.status === 'active'
      && row.reauthRequired !== true);
    return latest ? structuredClone(latest) : undefined;
  }

  public async upsertConnectedCredential(record: ConnectCredentialRecord): Promise<ConnectCredentialRecord> {
    if (record.expectedVersion !== undefined && record.expectedVersion !== this.version) {
      throw new Error('credential_version_conflict');
    }
    this.version += 1;
    const stored = structuredClone({ ...record, version: this.version });
    this.rows.push(stored);
    return stored;
  }

  public async markReauthRequired(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    reason: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = latestMatchingRow(this.rows, (row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment);
    if (!latest) return undefined;
    latest.reauthRequired = true;
    latest.metadata = { ...latest.metadata, reauthReason: input.reason };
    return structuredClone(latest);
  }

  public async disconnect(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId?: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = latestMatchingRow(this.rows, (row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment
      && (input.credentialId === undefined || row.id === input.credentialId));
    if (!latest) return undefined;
    latest.status = 'revoked';
    return structuredClone(latest);
  }

  public async listProviderCredentials(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
  }): Promise<ConnectCredentialRecord[]> {
    return this.rows
      .filter((row) =>
        row.webId === input.webId
        && row.provider === input.provider
        && row.deployment === input.deployment)
      .sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100))
      .map((row) => structuredClone(row));
  }

  public async getCredentialById(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    const row = this.rows.find((candidate) =>
      candidate.webId === input.webId
      && candidate.provider === input.provider
      && candidate.deployment === input.deployment
      && candidate.id === input.credentialId);
    return row ? structuredClone(row) : undefined;
  }

  public async createCredential(record: Omit<ConnectCredentialRecord, 'id'> & { id?: string }): Promise<ConnectCredentialRecord> {
    this.version += 1;
    const stored = structuredClone({
      ...record,
      id: record.id ?? `credential-${this.version}`,
      version: this.version,
    });
    this.rows.push(stored);
    return stored;
  }

  public async updateCredential(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId: string;
    expectedVersion?: number;
    patch: Partial<ConnectCredentialRecord>;
  }): Promise<ConnectCredentialRecord | undefined> {
    const row = this.rows.find((candidate) =>
      candidate.webId === input.webId
      && candidate.provider === input.provider
      && candidate.deployment === input.deployment
      && candidate.id === input.credentialId);
    if (!row) return undefined;
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw new Error('credential_version_conflict');
    }
    Object.assign(row, input.patch, { version: (row.version ?? 0) + 1 });
    return structuredClone(row);
  }

  public async revokeCredential(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    return this.updateCredential({
      ...input,
      patch: { status: 'revoked', enabled: false, health: 'disabled' },
    });
  }
}

function vault(): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ keyWrapper: new StaticKeyWrapper() });
}

async function encryptedSecret(
  provider: string,
  credentialIri: string,
  secret: ProviderSecret,
) {
  return vault().seal({ webId: WEB_ID }, credentialIri, provider, secret);
}

function kimiOAuthIntegration() {
  return OAuthIntegrationRegistry.fromServerConfig({
    kimi: {
      integrationId: 'xpod-kimi-oauth',
      issuedBy: 'xpod',
      clientId: 'xpod-kimi-device-client',
    },
  }).require('kimi');
}

function latestMatchingRow<T>(rows: T[], predicate: (row: T) => boolean): T | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (predicate(row)) {
      return row;
    }
  }
  return undefined;
}

function requireConnectAttempt(result: ConnectBeginResult): {
  attemptId: string;
  state: string;
  signature: string;
} {
  if (!result.attemptId || !result.state || !result.signature) {
    throw new Error(`Expected signed Connect attempt, got ${JSON.stringify(result)}`);
  }
  return {
    attemptId: result.attemptId,
    state: result.state,
    signature: result.signature,
  };
}

describe('Provider Connect capabilities', () => {
  it('reports honest Connect modes without claiming unsupported OAuth', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.requireProvider('openai').connect).toMatchObject({
      mode: 'browserAssistedApiKey',
      requiresAuthenticatedManagementApi: true,
    });
    expect(registry.requireProvider('anthropic').connect?.mode).toBe('browserAssistedApiKey');
    expect(registry.requireProvider('bailian').connect?.mode).toBe('browserAssistedApiKey');
    expect(registry.requireProvider('kimi').connect?.mode).toBe('browserAssistedApiKey');
    expect(registry.requireProvider('kimi').connect).toMatchObject({
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
    });
    expect(registry.requireProvider('deepseek').connect).toMatchObject({
      mode: 'browserAssistedApiKey',
      apiKeyManagementSupported: true,
    });
    for (const provider of ['openai', 'anthropic', 'bailian']) {
      expect(registry.requireProvider(provider).authModes).not.toContain('oauth');
    }
  });
});

describe('Provider credential pool management', () => {
  it('publishes unavailable lifecycle metadata for OAuth offerings without a Connect flow', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
    });

    const pools = await service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
    });

    for (const provider of ['openai', 'anthropic']) {
      const offering = pools
        .find((pool) => pool.id === provider)
        ?.offerings.find((candidate) => candidate.id === 'official-subscription');
      expect(offering).toMatchObject({
        lifecycle: 'unavailable',
        authModes: ['oauth'],
      });
    }
    expect(pools.find((pool) => pool.id === 'kimi')?.offerings.find(
      (offering) => offering.id === 'official-subscription',
    )).toBeUndefined();
    expect(pools.find((pool) => pool.id === 'kimi')?.offerings.find(
      (offering) => offering.id === 'subscription-key',
    )).toMatchObject({ lifecycle: 'active', authModes: ['apiKey'] });
  });

  it('lists canonical provider summaries with aggregate status and selected models', async () => {
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'kimi-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      accountLabel: 'Kimi key',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'healthy',
      version: 3,
      metadata: {
        models: ['moonshot-v1-8k'],
        defaultModel: 'moonshot-v1-8k',
        customModels: [{ id: 'moonshot-custom', displayName: 'Custom Moonshot' }],
      },
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    await expect(service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'kimi',
        name: 'Moonshot (Kimi)',
        status: 'available',
        offerings: expect.arrayContaining([
          expect.objectContaining({ id: 'subscription-key', lifecycle: 'active' }),
          expect.objectContaining({ id: 'api-platform', lifecycle: 'active' }),
        ]),
        selectedModels: [
          expect.objectContaining({ id: 'moonshot-v1-8k', provider: 'kimi' }),
          expect.objectContaining({ id: 'moonshot-custom', provider: 'kimi', custom: true }),
        ],
        credentials: [
          expect.objectContaining({
            id: 'kimi-key-a',
            provider: 'kimi',
            offeringId: 'api-platform',
            authMode: 'apiKey',
            label: 'Kimi key',
            enabled: true,
            priority: 10,
            health: 'healthy',
            version: 3,
          }),
        ],
      }),
    ]));
    const payload = JSON.stringify(await service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
    }));
    expect(payload).not.toMatch(/encryptedSecret|sk-secret|credentialIri|webId/);
  });

  it('creates, patches and revokes credentials through explicit pool methods', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    const created = await service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'api-platform',
      apiKey: 'sk-new-secret',
      label: 'Work key',
      baseUrl: 'https://api.moonshot.cn/v1',
      priority: 5,
    });
    expect(repository.rows[0]).toMatchObject({
      health: 'unknown',
      metadata: {
        health: 'unknown',
      },
    });
    const patched = await service.updateCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: created.id,
      expectedVersion: created.version,
      patch: {
        label: 'Paused',
        enabled: false,
        priority: 20,
        baseUrl: 'https://example.test/v1',
      },
    });
    const revoked = await service.revokeCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: created.id,
    });

    expect(created).toMatchObject({
      provider: 'kimi',
      offeringId: 'api-platform',
      authMode: 'apiKey',
      label: 'Work key',
      enabled: true,
      priority: 5,
      health: 'unknown',
    });
    expect(JSON.stringify(created)).not.toContain('sk-new-secret');
    expect(patched).toMatchObject({
      label: 'Paused',
      enabled: false,
      priority: 20,
      health: 'unknown',
      baseUrl: 'https://example.test/v1',
    });
    expect(revoked).toMatchObject({
      id: created.id,
      enabled: false,
      health: 'unknown',
    });
  });

  it('rejects API-key credentials for offerings that do not support API-key auth', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      adapters: [],
    });

    await expect(service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'official-subscription',
      apiKey: 'sk-new-secret',
    })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: {
        provider: 'kimi',
        offeringId: 'official-subscription',
      },
    });
  });

  it('creates a local Ollama credential without an API key', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });
    const created = await service.createLocalCredential({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'ollama',
      offeringId: 'local',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(created).toMatchObject({ provider: 'ollama', offeringId: 'local', authMode: 'local' });
    expect(repository.rows[0]).toMatchObject({ authMode: 'local' });
    expect(JSON.stringify(repository.rows[0])).not.toContain('apiKey');
  });

  it('tests stored credentials through ProviderModelsService and rejects temporary API keys', async () => {
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'kimi-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'unknown',
      version: 1,
    });
    const modelsService = {
      list: vi.fn(async () => ({
        provider: 'kimi',
        credential: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        models: [{ id: 'moonshot-v1-8k' }],
        observedAt: '2026-08-08T00:00:00.000Z',
        source: 'kimi:/models',
      })),
    };
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    await expect(service.testCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'kimi-key-a',
      modelsService,
    })).resolves.toEqual({
      status: 'ok',
      checkedAt: '2026-08-08T00:00:00.000Z',
      models: [{ id: 'moonshot-v1-8k' }],
    });
    expect(modelsService.list).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
    });
    expect(repository.rows[0]).toMatchObject({
      health: 'healthy',
      metadata: {
        health: 'healthy',
      },
      version: 2,
    });
    await expect(service.testCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      apiKey: 'sk-temporary',
      modelsService,
    })).rejects.toThrow('credential_test_requires_credential_id');
  });

  it('marks a stored API-key credential invalid when the provider probe fails', async () => {
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'kimi-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'unknown',
      version: 1,
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    await expect(service.testCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'kimi-key-a',
      modelsService: {
        list: vi.fn(async () => {
          throw new Error('provider rejected key');
        }),
      },
    })).rejects.toThrow('provider rejected key');
    expect(repository.rows[0]).toMatchObject({
      health: 'invalid',
      metadata: {
        health: 'invalid',
      },
      version: 2,
    });
  });
});

describe('BrowserAssistedApiKeyConnectAdapter', () => {
  it('uses signed one-time attempts bound to WebID, deployment and provider before sealing an API key into Pod storage', async () => {
    const attempts = new InMemoryConnectAttemptStore();
    const repository = new RecordingCredentialRepository();
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'openai',
      consoleUrl: 'https://platform.openai.com/api-keys',
      attempts,
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 7),
      signingSecret: 'connect-signing-secret',
    });

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    });

    expect(begun.mode).toBe('browserAssistedApiKey');
    expect(begun.expiresAt).toBe('2026-07-23T00:05:00.000Z');
    expect(begun.authorizationUrl).toContain('https://platform.openai.com/api-keys');
    expect(begun.state).toHaveLength(43);
    expect(begun.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(begun.pkceChallenge).toBeUndefined();
    const begunAttempt = requireConnectAttempt(begun);

    await expect(adapter.completeApiKey({
      webId: OTHER_WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-other-user',
    })).rejects.toThrow(/bound to a different webid/i);

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      signature: 'tampered',
      apiKey: 'sk-bad-signature',
    })).rejects.toThrow(/invalid connect attempt signature/i);

    const completed = await adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-live-openai-secret',
      accountLabel: 'Alice OpenAI',
      baseUrl: 'https://gateway.example/v1',
    });

    expect(completed.status).toBe('completed');
    expect(completed.credentialId).toBe('credentials.ttl#cloud-openai');
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      accountLabel: 'Alice OpenAI',
      status: 'active',
      metadata: {
        baseUrl: 'https://gateway.example/v1',
      },
    });
    expect(JSON.stringify(repository.rows[0])).not.toContain('sk-live-openai-secret');
    expect(repository.rows[0].encryptedSecret).toMatchObject({
      provider: 'openai',
      webId: WEB_ID,
    });

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'completed',
      provider: 'openai',
    });

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-second-use',
    })).rejects.toThrow(/already consumed/i);
  });

  it('disconnects the requested API-key credential without revoking its sibling', async () => {
    const repository = new RecordingCredentialRepository();
    const credentialA: ConnectCredentialRecord = {
      id: 'cloud-openai-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-a',
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: {
        algorithm: 'PLAINTEXT',
        keyId: 'a',
        wrappedDek: 'wrapped-a',
        aadPurpose: 'test',
        aadVersion: '1',
        ciphertext: 'ciphertext-a',
        nonce: 'nonce-a',
        webId: WEB_ID,
        credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-a',
        provider: 'openai',
        dekWrapAlgorithm: 'test',
      },
      status: 'active',
      version: 1,
    };
    const credentialB: ConnectCredentialRecord = {
      ...credentialA,
      id: 'cloud-openai-key-b',
      credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-b',
      encryptedSecret: {
        ...credentialA.encryptedSecret,
        keyId: 'b',
        wrappedDek: 'wrapped-b',
        ciphertext: 'ciphertext-b',
        nonce: 'nonce-b',
        credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-b',
      },
      version: 2,
    };
    repository.rows.push(credentialA, credentialB);
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'openai',
      consoleUrl: 'https://platform.openai.com/api-keys',
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      signingSecret: 'connect-signing-secret',
    });

    await expect(adapter.disconnect({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      credentialId: credentialA.id,
    })).resolves.toMatchObject({ id: credentialA.id, status: 'revoked' });
    expect(repository.rows.find((row) => row.id === credentialA.id)).toMatchObject({ status: 'revoked' });
    expect(repository.rows.find((row) => row.id === credentialB.id)).toMatchObject({ status: 'active' });
  });

  it('expires attempts after five minutes and protects concurrent completion with version CAS', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const attempts = new InMemoryConnectAttemptStore();
    const repository = new RecordingCredentialRepository();
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'anthropic',
      consoleUrl: 'https://console.anthropic.com/settings/keys',
      attempts,
      credentialRepository: repository,
      vault: vault(),
      deployment: 'local',
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 9),
      signingSecret: 'connect-signing-secret',
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      requestedMode: 'browserAssistedApiKey',
    });
    const begunAttempt = requireConnectAttempt(begun);
    now = new Date('2026-07-23T00:05:01.000Z');

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      ...begunAttempt,
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'expired',
      provider: 'anthropic',
    });

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      ...begunAttempt,
      apiKey: 'sk-expired',
    })).rejects.toThrow(/not found/i);

    now = new Date('2026-07-23T01:00:00.000Z');
    const fresh = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      requestedMode: 'browserAssistedApiKey',
      expectedCredentialVersion: 41,
    });
    const freshAttempt = requireConnectAttempt(fresh);

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      ...freshAttempt,
      apiKey: 'sk-version-race',
    })).rejects.toThrow(/credential_version_conflict/i);
    expect(repository.rows).toHaveLength(0);
  });
});

describe('KimiDeviceCodeConnectAdapter', () => {
  it('requires an explicit server-side Xpod OAuth integration and never falls back to request client ids', async () => {
    expect(() => OAuthIntegrationRegistry.fromServerConfig({})).toThrow('auth_not_available');
    expect(() => OAuthIntegrationRegistry.fromServerConfig({
      kimi: {
        integrationId: 'xpod-kimi-oauth',
        issuedBy: 'moonshot',
        clientId: 'provider-owned-client',
      },
    })).toThrow('auth_not_available');
    expect(() => OAuthIntegrationRegistry.fromServerConfig({
      kimi: {
        integrationId: 'user-supplied-kimi-oauth',
        issuedBy: 'xpod',
        clientId: 'user-owned-client',
      },
    })).toThrow('auth_not_available');

    const registry = OAuthIntegrationRegistry.fromServerConfig({
    kimi: {
      integrationId: 'xpod-kimi-oauth',
      issuedBy: 'xpod',
      clientId: 'xpod-kimi-device-client',
    },
  });
    const bodies: URLSearchParams[] = [];
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(new URLSearchParams(String(init?.body ?? '')));
        return Response.json({
          device_code: 'kimi-device-code',
          user_code: 'KIMI-123',
          verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
          expires_in: 300,
          interval: 1,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud',
      oauthIntegration: registry.require('kimi'),
      signingSecret: 'connect-signing-secret',
    });

    await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
      clientId: 'attacker-client-id',
    } as any);

    expect(bodies.at(-1)?.get('client_id')).toBe('xpod-kimi-device-client');
    expect(bodies.at(-1)?.get('client_id')).not.toBe('attacker-client-id');
  });

  it('starts OAuth device authorization with PKCE, polls slow_down/pending/expired, refreshes and revokes against allowlisted Kimi endpoints', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ url, body });
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
        return Response.json({
          device_code: 'kimi-device-code',
          user_code: 'KIMI-123',
          verification_uri: 'https://kimi.moonshot.cn/device',
          verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
          expires_in: 300,
          interval: 1,
        });
      }
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const pollCount = calls.filter((call) => call.body.get('grant_type') === body.get('grant_type')).length;
        if (pollCount === 1) {
          return Response.json({ error: 'authorization_pending' }, { status: 400 });
        }
        if (pollCount === 2) {
          return Response.json({ error: 'slow_down' }, { status: 400 });
        }
        return Response.json({
          access_token: 'kimi-access-token',
          refresh_token: 'kimi-refresh-token',
          expires_in: 3600,
          scope: 'openid profile',
          id_token: 'header.payload.signature',
        });
      }
      if (body.get('grant_type') === 'refresh_token') {
        return Response.json({
          access_token: 'kimi-refreshed',
          refresh_token: 'kimi-refresh-next',
          expires_in: 3600,
        });
      }
      if (url.endsWith('/api/oauth/revoke')) {
        return new Response(null, { status: 200 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const repository = new RecordingCredentialRepository();
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: fetchMock as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 11),
      signingSecret: 'connect-signing-secret',
    });

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    expect(begun).toMatchObject({
      mode: 'deviceCodeOAuth',
      deviceCode: 'kimi-device-code',
      userCode: 'KIMI-123',
      verificationUriComplete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
    });
    expect(begun.pkceChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const begunAttempt = requireConnectAttempt(begun);

    now = new Date('2026-07-23T00:00:00.500Z');
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'authorization_pending', intervalSeconds: 1 });
    expect(calls).toHaveLength(1);

    now = new Date('2026-07-23T00:00:01.000Z');
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'authorization_pending' });
    expect(calls).toHaveLength(2);

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'authorization_pending', intervalSeconds: 1 });
    expect(calls).toHaveLength(2);

    now = new Date('2026-07-23T00:00:02.000Z');
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'slow_down', intervalSeconds: 6 });

    now = new Date('2026-07-23T00:00:08.000Z');
    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      oauthCredential: {
        accessToken: 'kimi-access-token',
        refreshToken: 'kimi-refresh-token',
        expiresAt: '2026-07-23T01:00:08.000Z',
      },
    });

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'completed',
      provider: 'kimi',
      deviceCode: 'kimi-device-code',
    });

    const callsAfterCompletion = calls.length;
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).rejects.toThrow(/already consumed/i);
    expect(calls).toHaveLength(callsAfterCompletion);

    expect(repository.rows).toHaveLength(0);
    expect(calls.every((call) => call.url.startsWith('https://auth.kimi.com/api/oauth/'))).toBe(true);

    // Simulate the authenticated host persisting the one-time payload in the Pod.
    const oauthCredentialIri = `${WEB_ID.replace('/profile/card#me', '')}/settings/credentials/kimi.ttl#cloud-kimi-oauth-host`;
    await repository.createCredential({
      credentialIri: oauthCredentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await vault().seal(
        { webId: WEB_ID },
        oauthCredentialIri,
        'kimi',
        {
          type: 'deviceCodeOAuth',
          accessToken: completed.oauthCredential!.accessToken,
          refreshToken: completed.oauthCredential!.refreshToken,
          expiresAt: completed.oauthCredential!.expiresAt,
        },
      ),
      status: 'active',
      offeringId: 'official-subscription',
    });

    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        connect: { kimi: { configured: true } },
      }),
      adapters: [adapter],
      credentialRepository: repository,
      vault: vault(),
    });
    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    })).resolves.toMatchObject({ status: 'active' });
    await adapter.disconnect({ webId: WEB_ID, deployment: 'cloud', provider: 'kimi' });
    expect(calls.some((call) => call.url.endsWith('/api/oauth/revoke'))).toBe(false);
    expect(repository.rows.at(-1)).toMatchObject({ status: 'revoked' });
  });

  it('returns a one-time Kimi OAuth credential without replacing an existing API key credential', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: aiRuntimeRepository.credentialId({ deployment: 'cloud', provider: 'kimi' }),
      credentialIri: aiRuntimeRepository.credentialIri(WEB_ID, {
        deployment: 'cloud',
        provider: 'kimi',
      }),
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#api-key',
        { type: 'apiKey', apiKey: 'sk-existing' },
      ),
      status: 'active',
      accountLabel: 'Existing API key',
      offeringId: 'api-platform',
      version: 1,
    });
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (url: string, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
          return Response.json({
            device_code: 'kimi-device-code',
            user_code: 'KIMI-123',
            verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
            expires_in: 300,
            interval: 0,
          });
        }
        if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          return Response.json({
            access_token: 'kimi-access-token',
            refresh_token: 'kimi-refresh-token',
            expires_in: 3600,
            scope: 'openid profile',
          });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 15),
      signingSecret: 'connect-signing-secret',
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    now = new Date('2026-07-23T00:00:01.000Z');

    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...requireConnectAttempt(begun),
    });

    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      id: 'credentials.ttl#cloud-kimi',
      authMode: 'apiKey',
      accountLabel: 'Existing API key',
    });
    expect(completed.oauthCredential).toMatchObject({
      accessToken: 'kimi-access-token',
      refreshToken: 'kimi-refresh-token',
      scope: 'openid profile',
    });
    expect(JSON.stringify(repository.rows)).not.toMatch(/kimi-(?:access|refresh)-token/u);
  });

  it('refreshes a caller-owned OAuth secret without reading or writing the Pod repository', async () => {
    const repository = new RecordingCredentialRepository();
    const listCredentials = vi.spyOn(repository, 'listProviderCredentials');
    const createCredential = vi.spyOn(repository, 'createCredential');
    const updateCredential = vi.spyOn(repository, 'updateCredential');
    const sharedVault = vault();
    const openSecret = vi.spyOn(sharedVault, 'open');
    const sealSecret = vi.spyOn(sharedVault, 'seal');
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        expect(body.get('refresh_token')).toBe('host-refresh-token');
        return Response.json({
          access_token: 'next-access-token',
          refresh_token: 'next-refresh-token',
          expires_in: 3600,
          scope: 'openid profile',
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
      now: () => new Date('2026-08-09T07:00:00.000Z'),
    });

    await expect(adapter.refreshCallerOwned({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'credentials.ttl#kimi-oauth-1',
      refreshToken: 'host-refresh-token',
      expectedVersion: 4,
    })).resolves.toMatchObject({
      status: 'completed',
      credentialId: 'credentials.ttl#kimi-oauth-1',
      oauthCredential: {
        accessToken: 'next-access-token',
        refreshToken: 'next-refresh-token',
        expectedVersion: 4,
      },
    });
    expect(repository.rows).toHaveLength(0);
    expect(listCredentials).not.toHaveBeenCalled();
    expect(createCredential).not.toHaveBeenCalled();
    expect(updateCredential).not.toHaveBeenCalled();
    expect(openSecret).not.toHaveBeenCalled();
    expect(sealSecret).not.toHaveBeenCalled();
  });

  it('fails Kimi 2xx device responses that are empty, HTML, or missing required fields', async () => {
    const base = {
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud' as const,
      oauthIntegration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
    };
    for (const response of [
      new Response('', { status: 200 }),
      new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      Response.json({ device_code: 'device-only' }, { status: 200 }),
    ]) {
      const adapter = new KimiDeviceCodeConnectAdapter({
        ...base,
        fetch: (async () => response.clone()) as typeof fetch,
      });
      await expect(adapter.begin({
        webId: WEB_ID,
        deployment: 'cloud',
        provider: 'kimi',
        requestedMode: 'deviceCodeOAuth',
      })).rejects.toThrow(/json|required field/i);
    }
  });

  it('rejects Kimi endpoint overrides outside the exact official OAuth paths', () => {
    const base = {
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud' as const,
      oauthIntegration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
    };
    for (const override of [
      { deviceAuthorizationEndpoint: 'https://auth.kimi.com/api/oauth/device_authorization?debug=1' },
      { deviceAuthorizationEndpoint: 'https://user:pass@auth.kimi.com/api/oauth/device_authorization' },
      { tokenEndpoint: 'https://auth.kimi.com/api/oauth/token#frag' },
      { tokenEndpoint: 'https://auth.kimi.com/api/oauth/revoke' },
      { tokenEndpoint: 'https://auth.kimi.com/other/token' },
      { tokenEndpoint: 'https://evil.example/api/oauth/token' },
    ]) {
      expect(() => new KimiDeviceCodeConnectAdapter({
        ...base,
        ...override,
      })).toThrow(/allowlisted|endpoint/i);
    }
  });

  it('redacts provider error descriptions from exceptions and reauth reasons', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const credentialIri = aiRuntimeRepository.credentialIri(WEB_ID, {
      deployment: 'cloud',
      provider: 'kimi',
    });
    const encryptedSecret = await sharedVault.seal(
      { webId: WEB_ID },
      credentialIri,
      'kimi',
      { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
    );
    const current = await repository.upsertConnectedCredential({
      id: 'settings/ai/credentials/kimi.ttl#cloud-kimi',
      credentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      offeringId: 'official-subscription',
    });
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (url: string) => {
        if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
          return Response.json({
            device_code: 'kimi-device-code',
            user_code: 'KIMI-123',
            verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
            expires_in: 300,
            interval: 0,
          });
        }
        return Response.json({
          error: 'invalid_grant',
          error_description: 'leaked sk-live api_key device-code refresh-token',
        }, { status: 400 });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
      randomBytes: () => Buffer.alloc(32, 12),
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    const begunAttempt = requireConnectAttempt(begun);

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).rejects.toThrow(/invalid_grant/i);
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).rejects.not.toThrow(/sk-live|api_key|device-code|refresh-token/i);

    await adapter.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    }, current, { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' });

    expect(repository.rows.at(-1)?.metadata?.reauthReason).toBe('invalid_grant');
    expect(JSON.stringify(repository.rows)).not.toContain('sk-live');
    expect(JSON.stringify(repository.rows)).not.toContain('api_key');
    expect(JSON.stringify(repository.rows)).not.toContain('device-code');
    expect(JSON.stringify(repository.rows)).not.toContain('refresh-token');
  });

  it('coalesces concurrent eligible Kimi polls into one provider request', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
        return Response.json({
          device_code: 'kimi-device-code',
          user_code: 'KIMI-123',
          verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
          expires_in: 300,
          interval: 0,
        });
      }
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        tokenCalls += 1;
        await Promise.resolve();
        return Response.json({ error: 'authorization_pending' }, { status: 400 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: fetchMock as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 14),
      signingSecret: 'connect-signing-secret',
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    const begunAttempt = requireConnectAttempt(begun);
    now = new Date('2026-07-23T00:00:01.000Z');
    const input = {
      webId: WEB_ID,
      deployment: 'cloud' as const,
      provider: 'kimi',
      ...begunAttempt,
    };

    await expect(Promise.all([
      adapter.pollDevice(input),
      adapter.pollDevice(input),
    ])).resolves.toEqual([
      expect.objectContaining({ status: 'authorization_pending' }),
      expect.objectContaining({ status: 'authorization_pending' }),
    ]);
    expect(tokenCalls).toBe(1);
  });
});

describe('ProviderConnectService', () => {
  it('reports disabled Kimi API-key assisted Connect capability when deployment disables it', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        connect: {
          kimi: { configured: false, notes: ['auth_not_available'] },
        },
      }),
      adapters: [],
    });

    await expect(service.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      status: 'unsupported',
      mode: 'browserAssistedApiKey',
      apiKeyManagementSupported: true,
      message: 'auth_not_available',
    });
  });

  it('routes DeepSeek browser-assisted begin to an explicit unsupported API-key-management response', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [
        new DeepSeekConnectAdapter(),
      ],
    });

    await expect(service.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'deepseek',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'unsupported',
      apiKeyManagementSupported: true,
    });
  });

  it('summarizes one effective connection per provider for the current identity', async () => {
    const auth = {
      type: 'solid' as const,
      webId: WEB_ID,
      accessToken: 'alice-management-token',
      tokenType: 'Bearer' as const,
    };
    const getCredential = vi.fn(async ({ provider }: { provider: string }) => provider === 'openai' ? ({
      id: 'credential_openai',
      credentialIri: 'https://id.example/alice/settings/ai/credentials/openai.ttl#cloud-openai',
      webId: WEB_ID,
      provider,
      deployment: 'cloud' as const,
      authMode: 'apiKey' as const,
      encryptedSecret: { ciphertext: 'not-public' },
      status: 'active' as const,
      accountLabel: 'Alice',
      metadata: { baseUrl: 'https://proxy.example/v1' },
      version: 3,
      reauthRequired: true,
    }) : undefined);
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
      credentialRepository: {
        getCredential,
        getActiveCredential: vi.fn(),
        upsertConnectedCredential: vi.fn(),
        markReauthRequired: vi.fn(),
        disconnect: vi.fn(),
      } as any,
    });

    await expect(service.listProviders({
      webId: WEB_ID,
      deployment: 'cloud',
      auth,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai',
        status: 'reauthRequired',
        authMode: 'apiKey',
        accountLabel: 'Alice',
        baseUrl: 'https://proxy.example/v1',
        version: 3,
      }),
      expect.objectContaining({
        provider: 'deepseek',
        status: 'disconnected',
      }),
    ]));
    expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ auth }));
  });

  it('refreshes by opening the sealed Pod credential and never accepting a plaintext refresh token in the API input', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const credentialIri = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi';
    const encryptedSecret = await sharedVault.seal(
      { webId: WEB_ID },
      credentialIri,
      'kimi',
      { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
    );
    await repository.upsertConnectedCredential({
      id: aiRuntimeRepository.credentialId({ deployment: 'cloud', provider: 'kimi' }),
      credentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      offeringId: 'official-subscription',
    });
    const bodies: URLSearchParams[] = [];
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(new URLSearchParams(String(init?.body ?? '')));
        return Response.json({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ connect: { kimi: { configured: true } } }),
      adapters: [adapter],
      credentialRepository: repository,
      vault: sharedVault,
    });

    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      // If this property accidentally becomes part of the public API again,
      // TypeScript will flag this test object.
    })).resolves.toMatchObject({ status: 'active' });

    expect(bodies.at(-1)?.get('refresh_token')).toBe('sealed-refresh-token');
    expect(JSON.stringify(repository.rows.at(-1))).not.toContain('sealed-refresh-token');
  });

  it('refreshes and disconnects Kimi OAuth siblings without selecting a coexisting API key credential', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const apiKeyIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key';
    const oauthIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth';
    repository.rows.push({
      id: 'cloud-kimi-api-key',
      credentialIri: apiKeyIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        apiKeyIri,
        'kimi',
        { type: 'apiKey', apiKey: 'sk-existing-api-key' },
      ),
      status: 'active',
      accountLabel: 'API key',
      offeringId: 'api-platform',
      version: 1,
    });
    repository.rows.push({
      id: 'cloud-kimi-oauth',
      credentialIri: oauthIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        oauthIri,
        'kimi',
        { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
      ),
      status: 'active',
      accountLabel: 'OAuth',
      offeringId: 'official-subscription',
      version: 2,
    });
    const bodies: URLSearchParams[] = [];
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(new URLSearchParams(String(init?.body ?? '')));
        return Response.json({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ connect: { kimi: { configured: true } } }),
      adapters: [adapter],
      credentialRepository: repository,
      vault: sharedVault,
    });

    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    })).resolves.toMatchObject({ id: 'cloud-kimi-oauth', authMode: 'deviceCodeOAuth' });
    expect(bodies.at(-1)?.get('refresh_token')).toBe('sealed-refresh-token');

    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'cloud-kimi-api-key',
    })).rejects.toThrow('oauth_credential_not_found');

    await expect(service.disconnect({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'cloud-kimi-oauth',
    })).resolves.toMatchObject({ id: 'cloud-kimi-oauth', status: 'revoked' });
    expect(repository.rows.find((row) => row.id === 'cloud-kimi-api-key')).toMatchObject({
      status: 'active',
      authMode: 'apiKey',
    });
  });

  it('revalidates the same Kimi OAuth sibling after refresh CAS conflicts instead of returning a coexisting API key', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const oauthIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth';
    const apiKeyIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key';
    repository.rows.push({
      id: 'cloud-kimi-oauth',
      credentialIri: oauthIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        oauthIri,
        'kimi',
        { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
      ),
      status: 'active',
      accountLabel: 'OAuth',
      offeringId: 'official-subscription',
      version: 2,
    });
    repository.rows.push({
      id: 'cloud-kimi-api-key',
      credentialIri: apiKeyIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        apiKeyIri,
        'kimi',
        { type: 'apiKey', apiKey: 'sk-existing-api-key' },
      ),
      status: 'active',
      accountLabel: 'API key',
      offeringId: 'api-platform',
      version: 9,
    });
    const originalUpdate = repository.updateCredential.bind(repository);
    let conflictInjected = false;
    repository.updateCredential = vi.fn(async (input) => {
      if (!conflictInjected && input.credentialId === 'cloud-kimi-oauth') {
        conflictInjected = true;
        const oauth = repository.rows.find((row) => row.id === 'cloud-kimi-oauth')!;
        oauth.version = 3;
        return Promise.reject(new Error('credential_version_conflict'));
      }
      return originalUpdate(input);
    });
    const bodies: URLSearchParams[] = [];
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(new URLSearchParams(String(init?.body ?? '')));
        return Response.json({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      oauthIntegration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ connect: { kimi: { configured: true } } }),
      adapters: [adapter],
      credentialRepository: repository,
      vault: sharedVault,
    });

    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    })).resolves.toMatchObject({
      id: 'cloud-kimi-oauth',
      authMode: 'deviceCodeOAuth',
      offeringId: 'official-subscription',
      version: 3,
    });
    expect(bodies).toHaveLength(1);
  });

  it('uses the production Pod credential repository adapter against models credentialResource fields', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    let simulateConcurrentRefreshBeforeRewrap = false;
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: { getTrustedFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: () => ({
          values: (value: any) => ({
            execute: async () => {
              rows.set(value.id, jsonClone(value));
              return [jsonClone(value)];
            },
          }),
        }),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()] }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: async (_resource: unknown, id: string, patch: any) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, {
            ...patch,
            encryptedSecret: typeof patch.encryptedSecret === 'string'
              ? patch.encryptedSecret
              : JSON.stringify(patch.encryptedSecret),
          });
          return jsonClone(row);
        },
        update: () => ({
          set: (patch: any) => ({
            where: (_condition: any) => ({
              returning: () => ({
                execute: async () => {
                  const id = 'credentials.ttl#cloud-openai';
                  const row = rows.get(id);
                  if (!row) return [];
                  if (simulateConcurrentRefreshBeforeRewrap) {
                    simulateConcurrentRefreshBeforeRewrap = false;
                    const currentSecret = JSON.parse(String(row.encryptedSecret));
                    Object.assign(row, {
                      encryptedSecret: JSON.stringify({
                        ...currentSecret,
                        ciphertext: 'fresh-token-ciphertext',
                      }),
                      keyVersion: String(Number(row.keyVersion) + 1),
                    });
                    return [];
                  }
                  Object.assign(row, {
                    ...patch,
                    encryptedSecret: typeof patch.encryptedSecret === 'string'
                      ? patch.encryptedSecret
                      : JSON.stringify(patch.encryptedSecret),
                  });
                  return [jsonClone(row)];
                },
              }),
            }),
          }),
        }),
      } as any),
    });
    const sharedVault = vault();
    const attempts = new InMemoryConnectAttemptStore();
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'openai',
      consoleUrl: 'https://platform.openai.com/api-keys',
      attempts,
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      signingSecret: 'connect-signing-secret',
      randomBytes: () => Buffer.alloc(32, 13),
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    });
    const begunAttempt = requireConnectAttempt(begun);

    await adapter.completeApiKey(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-pod-backed-secret',
    }));

    const stored = [...rows.values()][0];
    expect(stored).toMatchObject({
      id: 'credentials.ttl#cloud-openai',
      provider: 'openai.ttl',
      authMode: 'apiKey',
      status: 'active',
      encryptionAlgorithm: 'AES-256-GCM',
      wrappedDataKey: expect.any(String),
      keyVersion: '1',
    });
    expect(JSON.stringify(stored)).toContain('https://id.example/alice/settings/credentials.ttl#cloud-openai');
    expect(JSON.stringify(stored)).not.toContain('sk-pod-backed-secret');
    const active = await repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }));
    expect(active).toMatchObject({ provider: 'openai', version: 1 });
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual([
      expect.objectContaining({ provider: 'openai', enabled: true, health: 'unknown' }),
    ]);
    await expect(repository.rewrapCredential(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      credentialId: active!.id,
      expectedVersion: 1,
      encryptedSecret: {
        ...active!.encryptedSecret,
        keyId: 'root-v2',
        wrappedDek: 'rewrapped-dek',
      },
    }))).resolves.toBe(true);
    await expect(repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject({
      version: 2,
      encryptedSecret: {
        keyId: 'root-v2',
        wrappedDek: 'rewrapped-dek',
      },
    });
    const beforeRace = await repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }));
    simulateConcurrentRefreshBeforeRewrap = true;
    await expect(repository.rewrapCredential(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      credentialId: beforeRace!.id,
      expectedVersion: beforeRace!.version,
      encryptedSecret: {
        ...beforeRace!.encryptedSecret,
        keyId: 'root-v3',
        wrappedDek: 'stale-rewrapped-dek',
      },
    }))).resolves.toBe(false);
    const racedRow = rows.get(beforeRace!.id);
    expect(typeof racedRow?.encryptedSecret).toBe('string');
    expect(racedRow?.encryptedSecret).toContain('fresh-token-ciphertext');
    expect(racedRow).toMatchObject({ keyVersion: '3' });
    const disconnected = await repository.disconnect(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }));
    expect(disconnected).toMatchObject({ status: 'revoked', version: 4 });
  });

  it.each([
    ['missing auth', undefined, 'caller_pod_access_unavailable'],
    ['browser Bearer token', { accessToken: 'browser-bearer-token', tokenType: 'Bearer' as const }, 'caller_pod_access_unavailable'],
    ['browser DPoP token', { accessToken: 'browser-dpop-token', tokenType: 'DPoP' as const, dpopProof: 'proof-for-management-url' }, 'caller_dpop_replay_unsupported'],
    ['Gateway API key principal', { viaGatewayApiKey: true, gatewayKeyId: 'gateway-key-id', scopes: ['models:read'], tokenType: 'Bearer' as const }, 'caller_pod_access_unavailable'],
    ['owner-mismatched caller Bearer token', { webId: OTHER_WEB_ID, viaApiKey: true, accessToken: 'caller-bearer-token', tokenType: 'Bearer' as const }, 'caller_owner_mismatch'],
  ])('rejects %s when no caller-owned reusable Pod token is available', async (_label, authPatch, expectedError) => {
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    const getTrustedFetch = vi.fn(async () => {
      throw new Error('service identity must not be used for direct caller access');
    });
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch,
      },
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: vi.fn() as any,
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [] }) }) }),
          findById: vi.fn(async () => null),
          updateById: vi.fn(async () => null),
          update: vi.fn() as any,
        } as any;
      },
    });

    await expect(repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      auth: authPatch === undefined
        ? undefined
        : {
            type: 'solid' as const,
            webId: WEB_ID,
            ...authPatch,
          },
    })).rejects.toThrow(expectedError);

    expect(getTrustedFetch).not.toHaveBeenCalled();

    expect(browserFetch).not.toHaveBeenCalled();
    browserFetch.mockRestore();
  });

  it('uses an owner-bound sk client-credentials Bearer token before service Pod access', async () => {
    const internalPodAccess = {
      getTrustedFetch: vi.fn(async () => {
        throw new Error('service identity must not be used for caller-owned access');
      }),
    };
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess,
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: vi.fn() as any,
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [] }) }) }),
          findById: vi.fn(async () => null),
          updateById: vi.fn(async () => null),
          update: vi.fn() as any,
        } as any;
      },
    });
    const callerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        viaApiKey: true,
        accessToken: 'caller-bearer-token',
        tokenType: 'Bearer',
      },
    });

    expect(internalPodAccess.getTrustedFetch).not.toHaveBeenCalled();
    expect(callerFetch).toHaveBeenCalledWith(
      'https://id.example/alice/settings/credentials.ttl',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const headers = callerFetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer caller-bearer-token');
    callerFetch.mockRestore();
  });

  it('normalizes credential Pod 403 responses as service_access_missing', async () => {
    const serviceFetch = vi.fn(async () => new Response('', { status: 403 }));
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => serviceFetch as typeof fetch),
      },
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: vi.fn() as any,
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [] }) }) }),
          findById: vi.fn(async () => null),
          updateById: vi.fn(async () => null),
          update: vi.fn() as any,
        } as any;
      },
    });

    await expect(repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).rejects.toThrow('service_access_missing');
  });

  it('supports multiple credential rows for the same provider when listing and resolving active credentials', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const providerIri = 'https://id.example/alice/settings/credentials/openai.ttl#openai';
    const activeCredentialIri = aiRuntimeRepository.credentialIri(WEB_ID, {
      deployment: 'cloud',
      provider: 'openai',
    });
    const legacyCredentialIri = 'https://id.example/alice/settings/ai/credentials/openai.ttl#legacy-openai';
    const makeRecord = (id: string, version: number, options: {
      status: 'active' | 'revoked';
      reauthRequired?: boolean;
      accountLabel: string;
      encryptedSecret: Record<string, unknown>;
    }): Record<string, unknown> => ({
      id,
      provider: providerIri,
      service: 'ai',
      status: options.status,
      authMode: 'apiKey',
      encryptedSecret: JSON.stringify(options.encryptedSecret),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: String(version),
      accountLabel: options.accountLabel,
      label: options.accountLabel,
      reauthRequired: options.reauthRequired ?? false,
      expiresAt: null,
      scopes: [],
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
    });

    const activeId = aiRuntimeRepository.credentialId({ deployment: 'cloud', provider: 'openai' });
    const legacyId = 'https://id.example/settings/credentials/openai.ttl#cloud-openai-legacy';
    rows.set(activeId, makeRecord(activeId, 4, {
      status: 'active',
      accountLabel: 'Primary',
      reauthRequired: true,
      encryptedSecret: {
        webId: WEB_ID,
        credentialIri: activeCredentialIri,
        provider: 'openai',
        type: 'apiKey',
        apiKey: 'sk-primary',
      },
    }));
    rows.set(legacyId, makeRecord(legacyId, 2, {
      status: 'active',
      accountLabel: 'Legacy',
      encryptedSecret: {
        webId: WEB_ID,
        credentialIri: legacyCredentialIri,
        provider: 'openai',
        type: 'apiKey',
        apiKey: 'sk-legacy',
      },
    }));

    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({
              execute: async () => [...rows.values()].map(jsonClone),
            }),
          }),
        }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: async (_resource: unknown, id: string, patch: any) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return jsonClone(row);
        },
        update: vi.fn(),
      } as any),
    });

    await expect(repository.getCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject({
      id: activeId,
      version: 4,
      reauthRequired: true,
    });
    await expect(repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject({
      id: 'https://id.example/settings/credentials/openai.ttl#cloud-openai-legacy',
      version: 2,
      accountLabel: 'Legacy',
      reauthRequired: false,
    });
    const listed = await repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }));
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountLabel: 'Primary', credentialIri: activeCredentialIri, enabled: false }),
      expect.objectContaining({ accountLabel: 'Legacy', credentialIri: legacyCredentialIri, enabled: true }),
    ]));
  });

  it('reads and manages UUID credentials independently of the host deployment', async () => {
    const credentialId = 'credentials.ttl#openai-8d790bab-2c3d-43d0-a25d-916bc205ba42';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const rows = new Map<string, Record<string, unknown>>([[credentialId, {
      id: credentialId,
      owner: WEB_ID,
      provider: 'https://id.example/alice/settings/openai.ttl#openai',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify({
        algorithm: 'PLAINTEXT',
        keyId: 'test-v1',
        wrappedDek: 'wrapped-v1',
        aadPurpose: 'test',
        aadVersion: '1',
        ciphertext: 'ciphertext-v1',
        nonce: 'nonce-v1',
        webId: WEB_ID,
        credentialIri,
        provider: 'openai',
        dekWrapAlgorithm: 'test',
      }),
      keyVersion: '1',
      metadata: {
        offeringId: 'api-platform',
        enabled: true,
        priority: 10,
        health: 'healthy',
      },
    }]]);
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: { getTrustedFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }),
          }),
        }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: vi.fn(),
        update: () => ({
          set: (patch: Record<string, unknown>) => ({
            where: () => ({
              returning: () => ({
                execute: async () => {
                  const current = rows.get(credentialId);
                  if (!current) return [];
                  Object.assign(current, patch);
                  return [jsonClone(current)];
                },
              }),
            }),
          }),
        }),
      } as any),
    });

    for (const deployment of ['cloud', 'local'] as const) {
      await expect(repository.listProviderCredentials(withInternalAuth({
        webId: WEB_ID,
        provider: 'openai',
        deployment,
      }))).resolves.toMatchObject([{ id: credentialId, provider: 'openai' }]);
      await expect(repository.getCredentialById(withInternalAuth({
        webId: WEB_ID,
        provider: 'openai',
        deployment,
        credentialId,
      }))).resolves.toMatchObject({ id: credentialId, version: 1 });
    }

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: 'https://id.example/bob/profile/card#me',
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toEqual([]);
    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'anthropic',
      deployment: 'local',
    }))).resolves.toEqual([]);
    await expect(repository.updateCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
      expectedVersion: 0,
      patch: { accountLabel: 'Stale write' },
    }))).rejects.toThrow('credential_version_conflict');

    await expect(repository.updateCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      credentialId,
      expectedVersion: 1,
      patch: { accountLabel: 'Portable credential' },
    }))).resolves.toMatchObject({
      id: credentialId,
      accountLabel: 'Portable credential',
      version: 2,
    });

    const updated = await repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
    }));
    await expect(repository.rewrapCredential(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      credentialId,
      expectedVersion: updated?.version,
      encryptedSecret: {
        ...updated!.encryptedSecret,
        keyId: 'test-v2',
        wrappedDek: 'wrapped-v2',
      },
    }))).resolves.toBe(true);

    const rewrapped = await repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
    }));
    await expect(repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
      expectedVersion: rewrapped?.version,
    }))).resolves.toMatchObject({
      id: credentialId,
      status: 'revoked',
    });
  });

  it('persists and restores offeringId/priority/enabled/health metadata and defaults', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const trustedFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => trustedFetch as unknown as typeof fetch),
      },
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: () => ({
            values: (value: any) => ({
              execute: async () => {
                rows.set(value.id, jsonClone(value));
                return [jsonClone(value)];
              },
            }),
          }),
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
          findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
          updateById: async (_resource: unknown, id: string, patch: any) => {
            const row = rows.get(id);
            if (!row) return null;
            Object.assign(row, patch);
            return jsonClone(row);
          },
          update: () => ({
            set: (_patch: any) => ({
              where: (_condition: any) => ({
                returning: () => ({ execute: async () => [] }),
              }),
            }),
          }),
        } as any;
      },
    });

    await repository.createCredential({
      id: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
      credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'openai',
        'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
        { type: 'apiKey', apiKey: 'legacy-key' },
      ),
      status: 'active',
      accountLabel: 'Defaulted',
    }, { auth: INTERNAL_INVOCATION_AUTH });

    const stored = [...rows.values()][0];
    expect(stored.metadata).toMatchObject({
      offeringId: 'api-platform',
      priority: 100,
      enabled: true,
      health: 'healthy',
    });
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      credentialId: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
    }))).resolves.toMatchObject({
      offeringId: 'api-platform',
      priority: 100,
      enabled: true,
      health: 'healthy',
    });
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toMatchObject([{
      provider: 'openai',
      enabled: true,
      health: 'healthy',
      priority: 100,
    }]);
    const listed = await repository.listCredentials(withInternalAuth({ webId: WEB_ID, deployment: 'cloud' }));
    expect(listed.at(0)?.metadata).toMatchObject({
      offeringId: 'api-platform',
    });

    const generated = await repository.createCredential({
      credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-generated',
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'openai',
        'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-generated',
        { type: 'apiKey', apiKey: 'generated-key' },
      ),
      status: 'active',
      accountLabel: 'Generated',
      metadata: {
        offeringId: 'responses-api',
        priority: 5,
        enabled: false,
        health: 'error',
      },
    }, { auth: INTERNAL_INVOCATION_AUTH });
    expect(generated.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(rows.get(generated.id)?.metadata).toMatchObject({
      offeringId: 'responses-api',
      priority: 5,
      enabled: false,
      health: 'error',
    });

    await repository.createCredential({
      id: 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key',
        { type: 'apiKey', apiKey: 'sk-kimi' },
      ),
      status: 'active',
      accountLabel: 'Kimi API key',
    }, { auth: INTERNAL_INVOCATION_AUTH });
    expect(rows.get('https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key')?.metadata)
      .toMatchObject({ offeringId: 'api-platform' });

    const kimiOAuthId = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth-legacy';
    rows.set(kimiOAuthId, {
      id: kimiOAuthId,
      provider: 'https://id.example/alice/settings/ai/credentials/kimi.ttl#kimi',
      service: 'ai',
      status: 'active',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri: kimiOAuthId,
        provider: 'kimi',
        type: 'deviceCodeOAuth',
        accessToken: 'oauth-access',
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: '1',
      accountLabel: 'Kimi OAuth',
      label: 'Kimi OAuth',
      reauthRequired: false,
      expiresAt: null,
      scopes: [],
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
    });
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: kimiOAuthId,
    }))).resolves.toMatchObject({
      authMode: 'deviceCodeOAuth',
      offeringId: 'subscription-key',
    });
  });

  it('supports creating multi-row credentials, get by id and sibling revoke with version CAS', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const trustedFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const makeRecord = (id: string, credentialIri: string, version: number, input: {
      status: 'active' | 'revoked';
      authMode: 'apiKey' | 'deviceCodeOAuth';
      reauthRequired?: boolean;
      accountLabel: string;
      secretType: string;
    }): Record<string, unknown> => ({
      id,
      provider: 'https://id.example/alice/settings/ai/credentials/kimi.ttl#kimi',
      service: 'ai',
      status: input.status,
      authMode: input.authMode,
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri,
        provider: 'kimi',
        type: input.secretType,
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: String(version),
      accountLabel: input.accountLabel,
      label: input.accountLabel,
      reauthRequired: input.reauthRequired ?? false,
      scopes: [],
      expiresAt: null,
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
      metadata: {},
    });
    const apiKeyId = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-api';
    const oauthId = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-oauth';
    rows.set(apiKeyId, makeRecord(
      apiKeyId,
      'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-api',
      7,
      {
      status: 'active',
      authMode: 'apiKey',
      accountLabel: 'ApiKey',
      secretType: 'apiKey',
      },
    ));
    rows.set(oauthId, makeRecord(
      oauthId,
      'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-oauth',
      3,
      {
      status: 'active',
      authMode: 'deviceCodeOAuth',
      accountLabel: 'OAuth',
      secretType: 'deviceCodeOAuth',
      },
    ));
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => trustedFetch as unknown as typeof fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: vi.fn(async (_resource: unknown, id: string, patch: any) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return jsonClone(row);
        }),
        update: () => ({
          set: (_patch: any) => ({
            where: (_condition: any) => ({
              returning: () => ({
                execute: async () => {
                  if (!rows.has(oauthId)) return [];
                  rows.set(oauthId, {
                    ...rows.get(oauthId)!,
                    status: 'revoked',
                    keyVersion: String(Number(rows.get(oauthId)!.keyVersion) + 1),
                  });
                  return [jsonClone(rows.get(oauthId)!)];
                },
              }),
            }),
          }),
        }),
      } as any),
    });

    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
    }))).resolves.toMatchObject({ authMode: 'deviceCodeOAuth', accountLabel: 'OAuth' });
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: apiKeyId,
    }))).resolves.toMatchObject({ authMode: 'apiKey', accountLabel: 'ApiKey' });

    const revoked = await repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
      keyVersion: 3,
      expectedVersion: 3,
    }));
    expect(revoked).toMatchObject({
      id: oauthId,
      status: 'revoked',
      version: 4,
      authMode: 'deviceCodeOAuth',
    });

    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: apiKeyId,
    }))).resolves.toMatchObject({
      status: 'active',
      accountLabel: 'ApiKey',
      id: apiKeyId,
    });
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: apiKeyId }),
    ]));
    expect((await repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).map((item) => item.id)).not.toContain(oauthId);

    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
      keyVersion: 3,
    }))).resolves.toBeUndefined();
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
      keyVersion: 4,
    }))).resolves.toMatchObject({ id: oauthId, status: 'revoked' });
  });

  it('lists provider credentials in priority order and treats CAS mismatch as no update', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const makeRecord = (id: string, version: number, priority: number): Record<string, unknown> => ({
      id,
      provider: 'https://id.example/alice/settings/ai/credentials/kimi.ttl#kimi',
      service: 'ai',
      status: 'active',
      authMode: 'apiKey',
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri: id,
        provider: 'kimi',
        type: 'apiKey',
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: String(version),
      accountLabel: id.endsWith('a') ? 'A' : 'B',
      label: id.endsWith('a') ? 'A' : 'B',
      reauthRequired: false,
      scopes: [],
      expiresAt: null,
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
      metadata: { offeringId: 'official-subscription', priority, enabled: true, health: 'healthy' },
    });
    const credentialA = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi-key-a';
    const credentialB = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi-key-b';
    rows.set(credentialA, makeRecord(credentialA, 1, 20));
    rows.set(credentialB, makeRecord(credentialB, 2, 10));
    const updateById = vi.fn();
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById,
        update: () => ({
          set: (_patch: any) => ({
            where: (_condition: any) => ({
              returning: () => ({ execute: async () => [] }),
            }),
          }),
        }),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: credentialB, status: 'active', priority: 10 },
      { id: credentialA, status: 'active', priority: 20 },
    ]);

    await expect(repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: credentialA,
      expectedVersion: 1,
    }))).resolves.toBeUndefined();
    expect(updateById).not.toHaveBeenCalled();
    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: credentialB, status: 'active' },
      { id: credentialA, status: 'active' },
    ]);
  });

  it('queries product credential rows across offering runtime provider ids without overwriting sibling providers', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const makeRecord = (
      id: string,
      provider: string,
      offeringId: string,
      priority: number,
    ): Record<string, unknown> => ({
      id,
      provider: `https://id.example/alice/settings/ai/credentials/${provider}.ttl#${provider}`,
      service: 'ai',
      status: 'active',
      authMode: 'apiKey',
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri: id,
        provider,
        type: 'apiKey',
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: '1',
      accountLabel: provider,
      label: provider,
      reauthRequired: false,
      scopes: [],
      expiresAt: null,
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
      metadata: {
        offeringId,
        priority,
        enabled: true,
        health: 'healthy',
        models: [`${provider}-model`],
      },
    });
    const paygoId = 'https://id.example/alice/settings/ai/credentials/bailian.ttl#cloud-bailian-key';
    const codingId = 'https://id.example/alice/settings/ai/credentials/bailian-coding-plan.ttl#cloud-bailian-coding-key';
    const tokenId = 'https://id.example/alice/settings/ai/credentials/bailian-token-plan.ttl#cloud-bailian-token-key';
    const kimiId = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi-oauth';
    rows.set(paygoId, makeRecord(paygoId, 'bailian', 'pay-as-you-go', 30));
    rows.set(codingId, makeRecord(codingId, 'bailian-coding-plan', 'coding-plan', 10));
    rows.set(tokenId, makeRecord(tokenId, 'bailian-token-plan', 'token-plan', 20));
    rows.set(kimiId, makeRecord(kimiId, 'kimi', 'official-subscription', 5));
    const updatedRows: Record<string, unknown>[] = [];
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: vi.fn(),
        update: () => ({
          set: (patch: Record<string, unknown>) => ({
            where: (_condition: any) => ({
              returning: () => ({
                execute: async () => {
                  updatedRows.push(patch);
                  return [jsonClone(patch)];
                },
              }),
            }),
          }),
        }),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'bailian',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: codingId, provider: 'bailian-coding-plan', offeringId: 'coding-plan', priority: 10 },
      { id: tokenId, provider: 'bailian-token-plan', offeringId: 'token-plan', priority: 20 },
      { id: paygoId, provider: 'bailian', offeringId: 'pay-as-you-go', priority: 30 },
    ]);

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'bailian-token-plan',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: tokenId, provider: 'bailian-token-plan', offeringId: 'token-plan' },
    ]);

    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: codingId, provider: 'bailian-coding-plan' }),
      expect.objectContaining({ id: tokenId, provider: 'bailian-token-plan' }),
      expect.objectContaining({ id: paygoId, provider: 'bailian' }),
      expect.objectContaining({ id: kimiId, provider: 'kimi' }),
    ]));

    await expect(repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'bailian',
      deployment: 'cloud',
      credentialId: tokenId,
      expectedVersion: 1,
    }))).resolves.toMatchObject({
      provider: 'bailian-token-plan',
      status: 'revoked',
    });
    expect(updatedRows.at(-1)).toMatchObject({
      provider: 'bailian-token-plan.ttl',
      status: 'revoked',
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: kimiId, provider: 'kimi', offeringId: 'official-subscription' },
    ]);
  });

  it('binds credential collection hydration to the Xpod settings SPARQL sidecar', async () => {
    const endpoints: string[] = [];
    const credentialId = 'credentials.ttl#cloud-openai';
    const row = {
      id: credentialId,
      owner: WEB_ID,
      provider: 'https://id.example/alice/settings/ai/providers/openai.ttl#openai',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify({
        algorithm: 'PLAINTEXT',
        keyId: 'test',
        wrappedDek: 'test',
        aadPurpose: 'test',
        aadVersion: '1',
        ciphertext: 'test',
        nonce: 'test',
        webId: WEB_ID,
        credentialIri: `https://id.example/alice/settings/${credentialId}`,
        provider: 'openai',
        dekWrapAlgorithm: 'test',
      }),
      keyVersion: '1',
      baseUrl: 'https://api.example/v1',
      metadata: { priority: 1 },
    };
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => fetch),
      },
      dbFactory: async ({ credential, aiProvider }) => {
        endpoints.push(credential?.getSparqlEndpoint?.() ?? '');
        endpoints.push(aiProvider?.getSparqlEndpoint?.() ?? '');
        return {
          init: vi.fn(),
          insert: vi.fn(),
          select: () => ({
            from: () => ({
              where: () => ({ execute: async () => [jsonClone(row)] }),
            }),
          }),
          findById: async () => null,
          updateById: vi.fn(),
          update: vi.fn(),
        } as any;
      },
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject([{ id: credentialId, provider: 'openai' }]);
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toMatchObject([{
      id: credentialId,
      provider: 'openai',
      metadata: { baseUrl: 'https://api.example/v1' },
    }]);
    expect(endpoints).toEqual([
      'https://id.example/alice/settings/-/sparql',
      'https://id.example/alice/settings/-/sparql',
      'https://id.example/alice/settings/-/sparql',
      'https://id.example/alice/settings/-/sparql',
    ]);
  });

  it('hydrates selected models as offering-aware Pod resource references', async () => {
    const subscriptionModel = 'kimi-subscription-key.ttl#shared-model';
    const platformModel = 'kimi-api-platform.ttl#shared-model';
    const credentialRows = await Promise.all([
      ['credentials.ttl#kimi-subscription', 'subscription-key'],
      ['credentials.ttl#kimi-platform', 'api-platform'],
    ].map(async ([id, offeringId], priority) => {
      const credentialIri = `https://id.example/alice/settings/${id}`;
      return {
        id,
        owner: WEB_ID,
        provider: `kimi-${offeringId}.ttl`,
        service: 'ai',
        authMode: 'apiKey',
        status: 'active',
        encryptedSecret: JSON.stringify(await encryptedSecret('kimi', credentialIri, {
          type: 'apiKey',
          apiKey: `fixture-${offeringId}`,
        })),
        keyVersion: '1',
        metadata: { offeringId, priority, enabled: true, health: 'healthy' },
      };
    }));
    const rows = new Map<string, Record<string, unknown>>([
      ['kimi.ttl', { id: 'kimi.ttl', hasModel: [subscriptionModel, platformModel] }],
      [subscriptionModel, {
        id: subscriptionModel,
        displayName: 'Subscription Shared Model',
        isProvidedBy: 'kimi-subscription-key.ttl#this',
      }],
      [platformModel, {
        id: platformModel,
        displayName: 'Platform Shared Model',
        isProvidedBy: 'kimi-api-platform.ttl#this',
      }],
    ]);
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: { getTrustedFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({ where: () => ({ execute: async () => jsonClone(credentialRows) }) }),
        }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
      },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        offeringId: 'subscription-key',
        selectedModels: [{
          id: 'shared-model',
          provider: 'kimi',
          offeringId: 'subscription-key',
          resourceId: subscriptionModel,
        }],
      }),
      expect.objectContaining({
        offeringId: 'api-platform',
        selectedModels: [{
          id: 'shared-model',
          provider: 'kimi',
          offeringId: 'api-platform',
          resourceId: platformModel,
        }],
      }),
    ]));

    const runtimeCredentials = await repository.listCredentials({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
      },
    });
    expect(runtimeCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({ offeringId: 'subscription-key', models: ['shared-model'] }),
        models: ['shared-model'],
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({ offeringId: 'api-platform', models: ['shared-model'] }),
        models: ['shared-model'],
      }),
    ]));
    expect(JSON.stringify(runtimeCredentials)).not.toContain('subscription-key:shared-model');
    expect(JSON.stringify(runtimeCredentials)).not.toContain('api-platform:shared-model');

    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
      credentialRepository: repository,
    });
    const kimi = (await service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
      },
    })).find((provider) => provider.id === 'kimi');
    expect(kimi?.selectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'shared-model', offeringId: 'subscription-key', resourceId: subscriptionModel }),
      expect.objectContaining({ id: 'shared-model', offeringId: 'api-platform', resourceId: platformModel }),
    ]));
    expect(kimi?.selectedModels.map((model) => model.id)).toEqual(['shared-model', 'shared-model']);
  });

  it('maps a custom compatible Offering credential back to the custom runtime Provider', async () => {
    const credentialId = 'credentials.ttl#custom-timicc';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const row = {
      id: credentialId,
      owner: WEB_ID,
      provider: 'custom-openai-compatible.ttl',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify(await encryptedSecret('custom', credentialIri, {
        type: 'apiKey',
        apiKey: 'fixture-custom-key',
      })),
      keyVersion: '1',
      metadata: { offeringId: 'openai-compatible', enabled: true, health: 'healthy' },
    };
    const selectedModel = 'custom-openai-compatible.ttl#gpt-custom';
    const repository = new PodConnectedCredentialRepository({
      providerIds: ['custom'],
      internalPodAccess: { getTrustedFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({ where: () => ({ execute: async () => [jsonClone(row)] }) }),
        }),
        findById: async (_resource: unknown, id: string) => id === 'custom.ttl'
          ? { id, hasModel: [selectedModel] }
          : null,
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials({
      webId: WEB_ID,
      provider: 'custom',
      deployment: 'cloud',
      auth: INTERNAL_INVOCATION_AUTH,
    })).resolves.toEqual([expect.objectContaining({
      provider: 'custom-openai-compatible',
      selectedModels: [expect.objectContaining({
        id: 'gpt-custom',
        provider: 'custom',
        offeringId: 'openai-compatible',
      })],
    })]);
    await expect(repository.listCredentials({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: INTERNAL_INVOCATION_AUTH,
    })).resolves.toEqual([expect.objectContaining({ provider: 'custom' })]);
  });

  it('reports a capability error when the Pod has no collection query sidecar', async () => {
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({
              execute: async () => {
                throw new Error('Document-mode collection queries over plain LDP are not supported for table "credential".');
              },
            }),
          }),
        }),
        findById: async () => null,
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).rejects.toThrow('credential_collection_query_unsupported');
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).rejects.toThrow('credential_collection_query_unsupported');
  });
});

function jsonClone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
