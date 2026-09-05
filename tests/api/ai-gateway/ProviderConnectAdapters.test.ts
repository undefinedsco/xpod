import { describe, expect, it, vi } from 'vitest';

import { PlaintextCredentialVault } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialVault';
import {
  BrowserAssistedApiKeyConnectAdapter,
  DeepSeekConnectAdapter,
  InMemoryConnectAttemptStore,
  PodConnectedCredentialRepository,
  ProviderConnectService,
  type ConnectBeginResult,
  type ConnectCredentialRecord,
  type PodCredentialRepository,
} from '../../../src/api/ai-gateway/connect';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';

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
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = latestMatchingRow(this.rows, (row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment);
    if (!latest) return undefined;
    latest.status = 'revoked';
    return structuredClone(latest);
  }
}

function vault(): PlaintextCredentialVault {
  return new PlaintextCredentialVault();
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
      experimental: false,
      publicCallbackSupported: false,
      remoteRevocationSupported: false,
    });
    expect(registry.requireProvider('deepseek').connect).toMatchObject({
      mode: 'connectUnsupported',
      apiKeyManagementSupported: true,
    });
    for (const provider of ['openai', 'anthropic', 'bailian']) {
      expect(registry.requireProvider(provider).authModes).not.toContain('oauth');
    }
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
    });
    expect(JSON.stringify(completed)).not.toContain('sk-live-openai-secret');
    expect(JSON.stringify(repository.rows[0])).toContain('sk-live-openai-secret');
    expect(repository.rows[0].credentialSecret).toMatchObject({
      provider: 'openai',
      webId: WEB_ID,
      secret: { type: 'apiKey', apiKey: 'sk-live-openai-secret' },
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

describe('ProviderConnectService', () => {
  it('routes Kimi browser-assisted API-key Connect without device OAuth configuration', async () => {
    const repository = new RecordingCredentialRepository();
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'kimi',
      consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      signingSecret: 'connect-signing-secret',
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [adapter],
    });

    await expect(service.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      status: 'pending',
      mode: 'browserAssistedApiKey',
      authorizationUrl: expect.stringContaining('platform.moonshot.cn/console/api-keys'),
    });
  });

  it('routes DeepSeek begin to connectUnsupported while keeping authenticated API key management separate', async () => {
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
      requestedMode: 'connectUnsupported',
    })).resolves.toMatchObject({
      mode: 'connectUnsupported',
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
      credentialSecret: {
        webId: WEB_ID,
        credentialIri: 'https://id.example/alice/settings/ai/credentials/openai.ttl#cloud-openai',
        provider,
        secret: { type: 'apiKey', apiKey: 'sk-not-returned-by-listProviders' },
      },
      status: 'active' as const,
      accountLabel: 'Alice',
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
        version: 3,
      }),
      expect.objectContaining({
        provider: 'deepseek',
        status: 'disconnected',
      }),
    ]));
    expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ auth }));
  });

  it('uses the production Pod credential repository adapter against models credentialResource fields', async () => {
    const rows = new Map<string, Record<string, unknown>>();
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
          Object.assign(row, patch);
          return jsonClone(row);
        },
        update: vi.fn() as any,
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

    await adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-pod-backed-secret',
      baseUrl: 'https://gateway.example/v1',
    });

    const stored = [...rows.values()][0];
    expect(stored).toMatchObject({
      id: 'credentials.ttl#cloud-openai',
      provider: 'openai.ttl',
      authMode: 'apiKey',
      status: 'active',
      keyVersion: '1',
      baseUrl: 'https://gateway.example/v1',
    });
    expect(JSON.stringify(stored)).toContain('https://id.example/alice/settings/credentials.ttl#cloud-openai');
    const rowSecretField = ['encrypted', 'Secret'].join('');
    expect(JSON.parse(String(stored[rowSecretField]))).toMatchObject({
      webId: WEB_ID,
      provider: 'openai',
      secret: { type: 'apiKey', apiKey: 'sk-pod-backed-secret' },
    });
    expect(stored).not.toHaveProperty('encryptionAlgorithm');
    expect(stored).not.toHaveProperty('wrappedDataKey');
    const active = await repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    });
    expect(active).toMatchObject({
      provider: 'openai',
      version: 1,
      credentialSecret: {
        webId: WEB_ID,
        provider: 'openai',
        secret: { type: 'apiKey', apiKey: 'sk-pod-backed-secret' },
      },
      baseUrl: 'https://gateway.example/v1',
    });
    await expect(repository.listCredentials({
      webId: WEB_ID,
      deployment: 'cloud',
    })).resolves.toEqual([
      expect.objectContaining({
        provider: 'openai',
        enabled: true,
        health: 'healthy',
        runtimeCredential: expect.objectContaining({ baseUrl: 'https://gateway.example/v1' }),
      }),
    ]);
    await expect(repository.disconnect({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    })).resolves.toMatchObject({ status: 'revoked', version: 2 });
  });

  it('reads the shared LinX default credential and provider Base URL for the current identity', async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ['credentials.ttl#openai-default', {
        id: 'credentials.ttl#openai-default',
        provider: 'openai.ttl',
        service: 'ai',
        status: 'active',
        apiKey: 'sk-linx-provider',
      }],
      ['openai.ttl', {
        id: 'openai.ttl',
        baseUrl: 'https://timicc.example/v1',
      }],
    ]);
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: { getTrustedFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn() as any,
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()] }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        resolveRowIri: (_resource: unknown, row: Record<string, unknown>) =>
          `https://pod.example/alice/settings/${String(row.id).replace(/^credentials\.ttl#/u, 'credentials.ttl#')}`,
        updateById: vi.fn(async () => null),
        update: vi.fn() as any,
      } as any),
    });

    await expect(repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    })).resolves.toMatchObject({
      id: 'credentials.ttl#openai-default',
      provider: 'openai',
      deployment: 'cloud',
      baseUrl: 'https://timicc.example/v1',
      credentialSecret: {
        webId: WEB_ID,
        provider: 'openai',
        secret: { type: 'apiKey', apiKey: 'sk-linx-provider' },
      },
    });
  });

  it('keeps the newly sealed secret when a Pod update returns a redacted row', async () => {
    const existing = {
      id: 'credentials.ttl#cloud-openai',
      provider: 'openai.ttl',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      keyVersion: '1',
    };
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: { getTrustedFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn() as any,
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [existing] }) }) }),
        findById: vi.fn(async () => ({ ...existing })),
        updateById: vi.fn(async (_resource: unknown, _id: string, patch: Record<string, unknown>) => ({
          id: patch.id,
          provider: patch.provider,
          service: patch.service,
          authMode: patch.authMode,
          status: patch.status,
          keyVersion: patch.keyVersion,
        })),
        update: vi.fn() as any,
      } as any),
    });
    const storedSecret = await vault().seal(
      { webId: WEB_ID },
      'https://id.example/alice/settings/credentials.ttl#cloud-openai',
      'openai',
      { type: 'apiKey', apiKey: 'sk-replacement' },
    );

    await expect(repository.upsertConnectedCredential({
      id: 'credentials.ttl#cloud-openai',
      credentialIri: 'https://id.example/alice/settings/credentials.ttl#cloud-openai',
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      credentialSecret: storedSecret,
      status: 'active',
    })).resolves.toMatchObject({
      version: 2,
      credentialSecret: {
        webId: WEB_ID,
        provider: 'openai',
        secret: { type: 'apiKey', apiKey: 'sk-replacement' },
      },
    });
  });

  it('does not fall back to caller management tokens when service Pod identity is mismatched', async () => {
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    const ownerMismatch = new Error('Gateway internal Pod token WebID does not match requested owner');
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => { throw ownerMismatch; }),
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
      auth: {
        type: 'solid',
        webId: WEB_ID,
        accessToken: 'browser-bearer-token',
        tokenType: 'Bearer',
      },
    })).rejects.toBe(ownerMismatch);

    expect(browserFetch).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer browser-bearer-token',
        }),
      }),
    );
    browserFetch.mockRestore();
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

    await expect(repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    })).rejects.toThrow('service_access_missing');
  });
});

function jsonClone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
