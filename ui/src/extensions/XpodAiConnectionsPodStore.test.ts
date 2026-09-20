import { describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { modelCatalogId } from '../../../packages/ai-connections/src/AiModelCatalog';
import { createXpodAiConnectionsPodStore } from './XpodAiConnectionsPodStore';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

/**
 * The SPARQL a credential row turns into.
 *
 * `drizzle-solid` drops values whose key is not a declared column, so asserting
 * on the row object alone cannot tell a persisted attribute from a silently
 * ignored one. This renders the real INSERT the Pod receives.
 */
function renderCredentialInsert(row: Record<string, unknown>): string {
  const database = drizzle(
    {
      info: { isLoggedIn: true, webId: WEB_ID },
      fetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    } as never,
    {
      schema: { credential: credentialResource, aiProvider: aiProviderResource, aiModel: aiModelResource },
      podUrl: POD_URL,
      autoConnect: false,
      resourcePreparation: 'off',
    },
  ) as unknown as {
    insert(resource: unknown): { values(value: unknown): { toSPARQL(): { query: string } } };
  };
  return database.insert(credentialResource).values(row).toSPARQL().query;
}

describe('XpodAiConnectionsPodStore', () => {
  it('lists multiple same-provider credential rows from the opened Pod database', async () => {
    const rows = [
      {
        id: 'credentials.ttl#openai-primary',
        owner: WEB_ID,
        provider: aiProviderResource.buildId({ id: 'openai' }),
        service: 'ai',
        authMode: 'apiKey',
        status: 'active',
        accountLabel: 'Primary',
        keyVersion: '2',
        encryptedSecret: JSON.stringify({
          algorithm: 'PLAINTEXT',
          ciphertext: JSON.stringify({ type: 'apiKey', apiKey: 'sk-primary-secret' }),
          webId: WEB_ID,
          credentialIri: credentialResource.buildIri(POD_URL, { id: 'credentials.ttl#openai-primary' }),
          provider: 'openai',
        }),
        metadata: { offeringId: 'api-platform', priority: 10, enabled: true, health: 'healthy' },
      },
      {
        id: 'credentials.ttl#openai-backup',
        owner: WEB_ID,
        provider: aiProviderResource.buildId({ id: 'openai' }),
        service: 'ai',
        authMode: 'apiKey',
        status: 'active',
        accountLabel: 'Backup',
        keyVersion: '1',
        encryptedSecret: JSON.stringify({
          algorithm: 'PLAINTEXT',
          ciphertext: JSON.stringify({ type: 'apiKey', apiKey: 'sk-backup-secret' }),
          webId: WEB_ID,
          credentialIri: credentialResource.buildIri(POD_URL, { id: 'credentials.ttl#openai-backup' }),
          provider: 'openai',
        }),
        metadata: { offeringId: 'api-platform', priority: 20, enabled: false, health: 'unknown' },
      },
    ];
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => {
            return resource === credentialResource ? rows : [];
          },
        }),
      }),
    };

    const providers = await createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    }).listProviders();

    expect(database.init).toHaveBeenCalledWith(credentialResource, aiProviderResource, aiModelResource);
    expect(providers.find((provider) => provider.id === 'openai')).toMatchObject({
      status: 'available',
      credentials: [
        { id: 'credentials.ttl#openai-primary', label: 'Primary', enabled: true, priority: 10, maskedHint: 'sk-...cret', version: 2 },
        { id: 'credentials.ttl#openai-backup', label: 'Backup', enabled: false, priority: 20, maskedHint: 'sk-...cret', version: 1 },
      ],
    });
  });

  it('exposes host session import as OpenAI Subscription only when the desktop host enables it', async () => {
    const database = {
      init: vi.fn(),
      select: () => ({
        from: () => ({ execute: async () => [] }),
      }),
    };

    const disabled = await createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    }).listProviders();
    const enabled = await createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
      openAiSubscriptionImportAvailable: true,
    }).listProviders();

    expect(disabled.find((provider) => provider.id === 'openai')?.offerings[0]).toMatchObject({
      id: 'official-subscription',
      label: 'OpenAI Subscription',
      lifecycle: 'unavailable',
      // Both ways in stay declared; availability is expressed by lifecycle.
      authModes: ['oauth', 'local'],
    });
    expect(enabled.find((provider) => provider.id === 'openai')?.offerings[0]).toMatchObject({
      id: 'official-subscription',
      label: 'OpenAI Subscription',
      lifecycle: 'active',
      authModes: expect.arrayContaining(['oauth', 'local']),
      authorizationMethods: expect.arrayContaining([
        expect.objectContaining({ id: 'device-code' }),
        expect.objectContaining({ id: 'local-session-import' }),
      ]),
    });
  });

  it('keeps legacy OpenAI subscription credentials in the subscription offering after toggling', async () => {
    const row = {
      id: 'credentials.ttl#openai-subscription',
      owner: WEB_ID,
      provider: aiProviderResource.buildId({ id: 'openai' }),
      service: 'ai',
      authMode: 'local',
      status: 'disabled',
      accountLabel: 'OpenAI Subscription',
      keyVersion: '2',
      encryptedSecret: JSON.stringify({ algorithm: 'PLAINTEXT', ciphertext: '{}' }),
    };
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({ execute: async () => resource === credentialResource ? [row] : [] }),
      }),
    };

    const providers = await createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
      openAiSubscriptionImportAvailable: true,
    }).listProviders();

    expect(providers.find((provider) => provider.id === 'openai')?.credentials[0]).toMatchObject({
      offeringId: 'official-subscription',
      enabled: false,
    });
  });

  it('creates, updates, and deletes API key credentials in the opened Pod database', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({
        from: () => ({
          execute: async () => [...rows.values()],
        }),
      }),
      findById: vi.fn(async (_resource: unknown, id: string) => rows.get(id) ?? null),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (_resource: unknown, id: string, patch: Record<string, unknown>) => {
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
      deleteById: vi.fn(async (_resource: unknown, id: string) => rows.delete(id)),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const created = await store.createApiKeyCredential!('deepseek', {
      apiKey: 'sk-secret-value',
      label: 'Primary',
      baseUrl: 'https://api.deepseek.com/v1',
      priority: 5,
    }) as { id: string; maskedHint: string; version: number };
    expect(created).toMatchObject({ maskedHint: 'sk-...alue', version: 1, health: 'unknown' });
    const storedEnvelope = JSON.parse(String(rows.get(created.id)?.encryptedSecret));
    expect(storedEnvelope.encoding).toBe('base64');
    expect(JSON.parse(atob(storedEnvelope.ciphertext))).toEqual({
      type: 'apiKey',
      apiKey: 'sk-secret-value',
    });
    expect(rows.get(created.id)?.metadata).toMatchObject({
      baseUrl: 'https://api.deepseek.com/v1',
      health: 'unknown',
    });
    await expect(store.readCredentialSecret!('deepseek', created.id)).resolves.toEqual({
      type: 'apiKey',
      apiKey: 'sk-secret-value',
    });

    const updated = await store.updateProviderCredential!('deepseek', created.id, {
      expectedVersion: 1,
      label: 'Backup',
      enabled: false,
      priority: 20,
    }) as { label: string; enabled: boolean; priority: number; version: number };
    expect(updated).toMatchObject({ label: 'Backup', enabled: false, priority: 20, version: 2 });

    await expect(store.updateProviderCredential!('deepseek', created.id, {
      expectedVersion: 1,
      label: 'Stale',
    })).rejects.toThrow('credential_version_conflict');

    await store.deleteProviderCredential!('deepseek', created.id);
    expect(database.deleteById).toHaveBeenCalledWith(credentialResource, created.id);
    expect(rows.has(created.id)).toBe(false);
  });

  it('completes the row a live collection created instead of inserting a second one', async () => {
    // The collection writes the models descriptor's columns optimistically; the
    // secret envelope and the columns the descriptor does not declare are the
    // store's. One credential, two writers, one row.
    const id = 'credentials.ttl#openai-live';
    const rows = new Map<string, Record<string, unknown>>([[id, {
      service: 'ai',
      provider: 'openai.ttl',
      authMode: 'apiKey',
      status: 'active',
      accountLabel: 'Live',
      label: 'Live',
      keyVersion: '1',
      reauthRequired: false,
      encryptionAlgorithm: 'PLAINTEXT',
    }]]);
    const database = {
      init: vi.fn(),
      findById: vi.fn(async (_resource: unknown, resourceId: string) => rows.get(resourceId) ?? null),
      insert: vi.fn(),
      updateById: vi.fn(async (_resource: unknown, resourceId: string, patch: Record<string, unknown>) => {
        const current = rows.get(resourceId);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(resourceId, updated);
        return { id: resourceId, ...updated };
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const created = await store.createApiKeyCredential!('openai', {
      apiKey: 'sk-live-secret',
      label: 'Live',
      id,
    });

    expect(database.insert).not.toHaveBeenCalled();
    expect(database.updateById).toHaveBeenCalledTimes(1);
    const [resource, updatedId, patch] = database.updateById.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(resource).toBe(credentialResource);
    expect(updatedId).toBe(id);
    // The columns the descriptor cannot express, and the secret it cannot project.
    expect(patch.offeringId).toBeTruthy();
    expect(patch.metadata).toMatchObject({ enabled: true });
    expect(String(patch.encryptedSecret)).toContain('PLAINTEXT');
    expect(created.id).toBe(id);
  });

  it('derives the Token Plan Team base URL from its Offering descriptor', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(value.id), value);
            return [value];
          },
        }),
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const created = await store.createApiKeyCredential!('bailian', {
      apiKey: 'sk-token-plan-team',
      label: 'Team',
      offeringId: 'token-plan-team',
    });

    expect(rows.get(created.id)?.baseUrl).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('persists a credential-free proxy independently of its provider Base URL', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({ from: () => ({ execute: async () => [...rows.values()] }) }),
      findById: vi.fn(async (_resource: unknown, id: string) => rows.get(id) ?? null),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (_resource: unknown, id: string, patch: Record<string, unknown>) => {
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const created = await store.createApiKeyCredential!('zhipu', {
      apiKey: 'id.secret-key',
      offeringId: 'coding-plan',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      proxyUrl: 'https://proxy.example:8443',
    } as never);

    expect(rows.get(created.id)).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      proxyUrl: 'https://proxy.example:8443',
    });
    expect(created).toMatchObject({
      offeringId: 'coding-plan',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      proxyUrl: 'https://proxy.example:8443',
    });
    await expect(store.createApiKeyCredential!('zhipu', {
      apiKey: 'id.other-key',
      offeringId: 'coding-plan',
      proxyUrl: 'https://proxy-user:proxy-password@proxy.example:8443',
    } as never)).rejects.toThrow('invalid_proxy_url');

    const updated = await store.updateProviderCredential!('zhipu', created.id, {
      expectedVersion: 1,
      proxyUrl: 'https://proxy.example:8443',
    } as never);
    expect(rows.get(created.id)).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      proxyUrl: 'https://proxy.example:8443',
    });
    expect(updated).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      proxyUrl: 'https://proxy.example:8443',
      version: 2,
    });

    const providers = await store.listProviders();
    expect(providers.find((provider) => provider.id === 'zhipu')?.credentials).toEqual([
      expect.objectContaining({
        offeringId: 'coding-plan',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        proxyUrl: 'https://proxy.example:8443',
      }),
    ]);
  });

  it('stores a custom Provider credential with normalized endpoint and restores its product metadata', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => resource === credentialResource ? [...rows.values()] : [],
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(value.id), value);
            return [value];
          },
        }),
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const created = await store.createApiKeyCredential!('custom', {
      apiKey: 'sk-custom-secret',
      label: 'timicc',
      offeringId: 'openai-compatible',
      baseUrl: 'https://timicc.com/v1',
      compatibility: 'openai',
    } as never);

    expect(created).toMatchObject({
      provider: 'custom',
      label: 'timicc',
      offeringId: 'openai-compatible',
      baseUrl: 'https://timicc.com/v1',
    });
    expect(rows.get(created.id)?.metadata).toMatchObject({
      offeringId: 'openai-compatible',
      compatibility: 'openai',
      baseUrl: 'https://timicc.com/v1',
    });

    const providers = await store.listProviders();
    expect(providers.find((provider) => provider.id === 'custom')).toMatchObject({
      id: 'custom',
      name: 'timicc',
      status: 'available',
      offerings: [
        expect.objectContaining({
          id: 'openai-compatible',
          label: 'OpenAI Compatible',
          modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
          endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://timicc.com/v1' }],
        }),
      ],
      credentials: [
        expect.objectContaining({
          label: 'timicc',
          baseUrl: 'https://timicc.com/v1',
        }),
      ],
    });
  });

  it('assigns independent provider resources to custom credentials with the same protocol', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({ from: (resource: unknown) => ({ execute: async () => resource === credentialResource ? [...rows.values()] : [] }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => ({ execute: async () => { rows.set(String(value.id), value); return [value]; } }) }),
    };
    const store = createXpodAiConnectionsPodStore({ database: database as never, podUrl: POD_URL, webId: WEB_ID });

    const first = await store.createApiKeyCredential!('custom', {
      apiKey: 'sk-first', label: 'timicc', offeringId: 'openai-compatible', baseUrl: 'https://timicc.com/v1', compatibility: 'openai',
    } as never);
    const second = await store.createApiKeyCredential!('custom', {
      apiKey: 'sk-second', label: '备用接口', offeringId: 'openai-compatible', baseUrl: 'https://other.example/v1', compatibility: 'openai',
    } as never);

    expect(rows.get(first.id)?.provider).not.toBe(rows.get(second.id)?.provider);
    expect(String(rows.get(first.id)?.provider)).toContain('custom-instance-');
    expect(String(rows.get(second.id)?.provider)).toContain('custom-instance-');
  });

  it('persists model picks on the selected custom credential provider resource', async () => {
    const rowsByResource = new Map<unknown, Map<string, Record<string, unknown>>>([
      [credentialResource, new Map()],
      [aiProviderResource, new Map()],
      [aiModelResource, new Map()],
    ]);
    const database = {
      init: vi.fn(),
      select: () => ({ from: (resource: unknown) => ({ execute: async () => [...(rowsByResource.get(resource)?.values() ?? [])] }) }),
      insert: (resource: unknown) => ({ values: (value: Record<string, unknown>) => ({ execute: async () => {
        rowsByResource.get(resource)!.set(String(value.id), value);
        return [value];
      } }) }),
      findById: async (resource: unknown, id: string) => rowsByResource.get(resource)?.get(id) ?? null,
      updateById: async (resource: unknown, id: string, patch: Record<string, unknown>) => {
        const current = rowsByResource.get(resource)?.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rowsByResource.get(resource)!.set(id, updated);
        return updated;
      },
    };
    const store = createXpodAiConnectionsPodStore({ database: database as never, podUrl: POD_URL, webId: WEB_ID });
    const first = await store.createApiKeyCredential!('custom', {
      apiKey: 'sk-first', label: 'timicc', offeringId: 'openai-compatible', baseUrl: 'https://timicc.com/v1', compatibility: 'openai',
    } as never) as { id: string };
    const second = await store.createApiKeyCredential!('custom', {
      apiKey: 'sk-second', label: '备用接口', offeringId: 'openai-compatible', baseUrl: 'https://other.example/v1', compatibility: 'openai',
    } as never) as { id: string };
    await store.saveDiscoveredModels!('custom', first.id, [{ id: 'shared-model' }]);
    await store.saveDiscoveredModels!('custom', second.id, [{ id: 'shared-model' }]);

    await store.saveModelSelection!('custom', [{ id: 'shared-model' }], second.id);

    const firstProviderId = String(rowsByResource.get(credentialResource)!.get(first.id)!.provider);
    const secondProviderId = String(rowsByResource.get(credentialResource)!.get(second.id)!.provider);
    expect(rowsByResource.get(aiProviderResource)!.get(firstProviderId)?.hasModel).toBeUndefined();
    expect(rowsByResource.get(aiProviderResource)!.get(secondProviderId)?.hasModel).toEqual([
      `${secondProviderId.split('#', 1)[0]}#shared-model`,
    ]);
  });

  it('persists credential health after a connection test', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({ from: (resource: unknown) => ({ execute: async () => resource === credentialResource ? [...rows.values()] : [] }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => ({ execute: async () => { rows.set(String(value.id), value); return [value]; } }) }),
      findById: async (_resource: unknown, id: string) => rows.get(id) ?? null,
      updateById: async (_resource: unknown, id: string, patch: Record<string, unknown>) => {
        const updated = { ...rows.get(id), ...patch };
        rows.set(id, updated);
        return updated;
      },
    };
    const store = createXpodAiConnectionsPodStore({ database: database as never, podUrl: POD_URL, webId: WEB_ID });
    const created = await store.createApiKeyCredential!('custom', {
      apiKey: 'sk-test', label: 'timicc', offeringId: 'openai-compatible', baseUrl: 'https://timicc.com/v1', compatibility: 'openai',
    } as never) as { id: string; version: number };

    await store.markCredentialHealth!('custom', created.id, 'healthy', created.version);

    expect(rows.get(created.id)?.metadata).toMatchObject({ health: 'healthy' });
    expect(rows.get(created.id)?.keyVersion).toBe('2');
  });

  it('stores an Ollama local credential without an API key', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({ from: (resource: unknown) => ({ execute: async () => resource === credentialResource ? [...rows.values()] : [] }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => ({ execute: async () => { rows.set(String(value.id), value); return [value]; } }) }),
    };
    const store = createXpodAiConnectionsPodStore({ database: database as never, podUrl: POD_URL, webId: WEB_ID });

    const created = await store.createLocalCredential!('ollama', {
      offeringId: 'local',
      baseUrl: 'http://localhost:11434/v1',
    }) as { id: string };
    const row = rows.get(created.id)!;
    expect(row).toMatchObject({ authMode: 'local', baseUrl: 'http://localhost:11434/v1' });
    expect(JSON.stringify(row.encryptedSecret)).not.toContain('apiKey');
  });

  it('lists Ollama as a local offering and uses it as the default local credential scope', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({ from: (resource: unknown) => ({ execute: async () => resource === credentialResource ? [...rows.values()] : [] }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => ({ execute: async () => { rows.set(String(value.id), value); return [value]; } }) }),
    };
    const store = createXpodAiConnectionsPodStore({ database: database as never, podUrl: POD_URL, webId: WEB_ID });

    const beforeCreate = await store.listProviders();
    expect(beforeCreate.find((provider) => provider.id === 'ollama')?.offerings).toEqual([
      expect.objectContaining({
        id: 'local',
        label: 'Local Ollama',
        kind: 'local',
        lifecycle: 'active',
        authModes: ['local'],
        endpoints: [{ protocol: 'chatCompletions', baseUrl: 'http://localhost:11434/v1' }],
        modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
        quota: { strategy: 'unsupported', url: 'https://ollama.com' },
      }),
    ]);

    const created = await store.createLocalCredential!('ollama', {}) as { id: string };
    expect(created).toMatchObject({
      provider: 'ollama',
      offeringId: 'local',
      authMode: 'local',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(rows.get(created.id)).toMatchObject({
      provider: aiProviderResource.buildId({ id: 'ollama' }),
      // The offering is an attribute of the credential, never a provider
      // document name: `providers/ollama.ttl` holds every Ollama row.
      offeringId: 'local',
      authMode: 'local',
      baseUrl: 'http://localhost:11434/v1',
      metadata: expect.objectContaining({
        offeringId: 'local',
        baseUrl: 'http://localhost:11434/v1',
      }),
    });

    const afterCreate = await store.listProviders();
    expect(afterCreate.find((provider) => provider.id === 'ollama')?.credentials).toEqual([
      expect.objectContaining({
        id: created.id,
        offeringId: 'local',
        authMode: 'local',
        baseUrl: 'http://localhost:11434/v1',
      }),
    ]);
  });

  it('records the offering on the credential instead of the provider document name', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => resource === credentialResource ? [...rows.values()] : [],
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(value.id), value);
            return [value];
          },
        }),
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const kimi = await store.createApiKeyCredential!('kimi', {
      apiKey: 'sk-kimi-subscription',
      offeringId: 'subscription-key',
    });
    const bailian = await store.createApiKeyCredential!('bailian', {
      apiKey: 'sk-sp-coding-plan',
      offeringId: 'coding-plan',
    });

    // Every offering resolves to the provider's own document. An offering
    // segment here is what created a phantom `providers/openai-<offering>.ttl`
    // document whose `hasModel` entries dangle.
    expect(rows.get(kimi.id)?.provider).toBe(aiProviderResource.buildId({ id: 'kimi' }));
    expect(rows.get(bailian.id)?.provider).toBe(aiProviderResource.buildId({ id: 'bailian' }));
    expect(rows.get(kimi.id)?.offeringId).toBe('subscription-key');
    // Bailian's catalog id is `coding-plan`; the document-name variant
    // (`coding-plan-pro`) must not leak into the attribute.
    expect(rows.get(bailian.id)?.offeringId).toBe('coding-plan');

    // The row reaches the Pod as these two triples: the offering as the
    // credential's own attribute, and the provider as the provider's document.
    const kimiInsert = renderCredentialInsert(rows.get(kimi.id)!);
    expect(kimiInsert).toContain('<https://undefineds.co/ns#offeringId> "subscription-key"');
    expect(kimiInsert).toContain('<https://undefineds.co/ns#provider> <https://pod.example/alice/settings/providers/kimi.ttl>');
    expect(kimiInsert).not.toContain('kimi-subscription-key.ttl');
    const bailianInsert = renderCredentialInsert(rows.get(bailian.id)!);
    expect(bailianInsert).toContain('<https://undefineds.co/ns#offeringId> "coding-plan"');
    expect(bailianInsert).toContain('<https://undefineds.co/ns#provider> <https://pod.example/alice/settings/providers/bailian.ttl>');
    expect(bailianInsert).not.toContain('bailian-coding-plan');

    // The offering is a first-class credential attribute, so it survives even
    // when the JSON metadata bag is not hydrated - and no reader has to fall
    // back to reverse-engineering it from a provider reference.
    rows.set(kimi.id, { ...rows.get(kimi.id)!, metadata: undefined });
    rows.set(bailian.id, { ...rows.get(bailian.id)!, metadata: undefined });

    const providers = await store.listProviders();
    expect(providers.find((provider) => provider.id === 'kimi')?.credentials).toEqual([
      expect.objectContaining({
        offeringId: 'subscription-key',
        baseUrl: 'https://api.kimi.com/coding/v1',
      }),
    ]);
    expect(providers.find((provider) => provider.id === 'bailian')?.credentials).toEqual([
      expect.objectContaining({
        offeringId: 'coding-plan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      }),
    ]);
  });

  it('writes model references the fragment-folding fallback has nothing to fold', async () => {
    const rowsByResource = new Map<unknown, Map<string, Record<string, unknown>>>([
      [credentialResource, new Map()],
      [aiProviderResource, new Map()],
      [aiModelResource, new Map()],
    ]);
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => [...(rowsByResource.get(resource)?.values() ?? [])],
        }),
      }),
      findById: vi.fn(async (resource: unknown, id: string) => rowsByResource.get(resource)?.get(id) ?? null),
      insert: (resource: unknown) => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rowsByResource.get(resource)?.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (resource: unknown, id: string, patch: Record<string, unknown>) => {
        const rows = rowsByResource.get(resource)!;
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const subscription = await store.createLocalCredential!('openai', {
      offeringId: 'official-subscription',
    }) as { id: string };
    const platform = await store.createApiKeyCredential!('openai', {
      apiKey: 'sk-platform',
      offeringId: 'api-platform',
    }) as { id: string };

    // The subscription offering on its own credential used to become
    // `providers/openai-official-subscription.ttl`; both credentials now name
    // the provider's own document.
    const providerDocument = aiProviderResource.buildId({ id: 'openai' });
    expect(rowsByResource.get(credentialResource)!.get(subscription.id)?.provider).toBe(providerDocument);
    expect(rowsByResource.get(credentialResource)!.get(platform.id)?.provider).toBe(providerDocument);

    await store.saveDiscoveredModels!('openai', subscription.id, [
      { id: 'gpt-6-astra', displayName: 'GPT-6-Astra' },
    ]);
    await store.saveModelSelection!('openai', [
      { id: 'gpt-6-astra', offeringId: 'official-subscription' },
    ]);

    // The selection stores one reference into the provider's own document, and
    // no phantom offering document is created for it.
    expect(rowsByResource.get(aiProviderResource)!.get(providerDocument)?.hasModel).toEqual([
      aiModelResource.buildId({ id: 'gpt-6-astra', isProvidedBy: providerDocument }),
    ]);
    expect([...rowsByResource.get(aiProviderResource)!.keys()]).toEqual([providerDocument]);

    // A freshly written selection therefore lists a plain model id, so the
    // fragment-folding fallback has nothing to fold...
    const selected = (await store.listProviders())
      .find((provider) => provider.id === 'openai')!.selectedModels[0]!;
    expect(selected.id).toBe('gpt-6-astra');
    expect(modelCatalogId(selected)).toBe(selected.id);
    // ...while it stays in place for the old shape the migration still cleans up.
    expect(modelCatalogId({ id: 'openai-official-subscription.ttl#gpt-6-astra' })).toBe('gpt-6-astra');
  });

  it('lists complete Kimi offering metadata and derives offering base URLs', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const database = {
      init: vi.fn(),
      select: () => ({
        from: () => ({
          execute: async () => [],
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(value.id), value);
            return [value];
          },
        }),
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const kimi = (await store.listProviders()).find((provider) => provider.id === 'kimi');

    expect(kimi?.offerings).toEqual([
      expect.objectContaining({
        id: 'subscription-key',
        label: 'Token Plan',
        kind: 'token-plan',
        lifecycle: 'active',
        authModes: ['apiKey'],
        productLabel: 'Kimi Coding',
        runtimeProviderIds: ['kimi'],
        credentialPrefixHints: ['sk-kimi-'],
        consoleUrl: 'https://www.kimi.com/code',
        subscriptionUrl: 'https://www.kimi.com/code',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://api.kimi.com/coding/v1', region: 'cn', supportsDeveloperMessages: false },
          { protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding/', region: 'cn' },
        ],
        modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
        quota: { strategy: 'subscription', url: 'https://www.kimi.com/code' },
        usagePolicyUrl: 'https://www.kimi.com/user/agreement',
        region: 'cn',
      }),
      expect.objectContaining({
        id: 'api-platform',
        label: 'API Platform',
        kind: 'api-platform',
        lifecycle: 'active',
        authModes: ['apiKey'],
        productLabel: 'Moonshot AI',
        runtimeProviderIds: ['kimi'],
        credentialPrefixHints: ['sk-'],
        consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
        subscriptionUrl: 'https://platform.moonshot.cn/console/account',
        endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.moonshot.ai/v1', region: 'cn' }],
        modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
        quota: { strategy: 'console', url: 'https://platform.moonshot.cn/console/account' },
        usagePolicyUrl: 'https://platform.moonshot.cn/docs/intro',
        region: 'cn',
      }),
    ]);

    const subscriptionKey = await store.createApiKeyCredential!('kimi', {
      apiKey: 'sk-kimi-subscription',
      label: 'Subscription Key',
      offeringId: 'subscription-key',
    });
    const apiPlatform = await store.createApiKeyCredential!('kimi', {
      apiKey: 'sk-kimi-platform',
      label: 'API Platform',
      offeringId: 'api-platform',
    });

    expect(rows.get(subscriptionKey.id)?.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(rows.get(apiPlatform.id)?.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('describes each provider offering with its own endpoint, console, and quota source', async () => {
    const database = {
      init: vi.fn(),
      select: () => ({ from: () => ({ execute: async () => [] }) }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });
    const providers = await store.listProviders();

    const openai = providers.find((provider) => provider.id === 'openai');
    expect(openai?.offerings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'official-subscription',
        lifecycle: 'unavailable',
        quota: { strategy: 'subscription', url: 'https://chatgpt.com/codex' },
      }),
      expect.objectContaining({
        id: 'api-platform',
        consoleUrl: 'https://platform.openai.com/api-keys',
        endpoints: expect.arrayContaining([
          expect.objectContaining({ protocol: 'responses', baseUrl: 'https://api.openai.com/v1' }),
        ]),
        quota: { strategy: 'providerApi', url: 'https://platform.openai.com/usage' },
      }),
    ]));

    const anthropic = providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.offerings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'official-subscription', lifecycle: 'unavailable' }),
      expect.objectContaining({
        id: 'api-platform',
        consoleUrl: 'https://console.anthropic.com/settings/keys',
        endpoints: [{ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }],
        quota: { strategy: 'console', url: 'https://console.anthropic.com/settings/limits' },
      }),
    ]));

    const deepseek = providers.find((provider) => provider.id === 'deepseek');
    expect(deepseek?.offerings).toEqual([
      expect.objectContaining({
        id: 'api-platform',
        consoleUrl: 'https://platform.deepseek.com/api_keys',
        subscriptionUrl: 'https://platform.deepseek.com/usage',
        endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.deepseek.com/v1' }],
        quota: { strategy: 'console', url: 'https://platform.deepseek.com/usage' },
      }),
    ]);

    const bailian = providers.find((provider) => provider.id === 'bailian');
    expect(bailian?.offerings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'pay-as-you-go',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', region: 'cn' },
          { protocol: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', region: 'cn' },
        ],
      }),
      expect.objectContaining({
        id: 'token-plan',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', region: 'cn-beijing' },
          { protocol: 'anthropic', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', region: 'cn-beijing' },
        ],
      }),
      expect.objectContaining({
        id: 'coding-plan',
        endpoints: [
          { protocol: 'chatCompletions', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', region: 'cn' },
          { protocol: 'anthropic', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', region: 'cn' },
        ],
      }),
    ]));
  });

  it.each([undefined, null] as const)(
    'rejects credential updates when the Pod returns %s and keeps the persisted row unchanged',
    async (updateResult) => {
      const credentialId = 'credentials.ttl#openai-primary';
      const rows = new Map<string, Record<string, unknown>>([
        [credentialId, {
          id: credentialId,
          provider: aiProviderResource.buildId({ id: 'openai' }),
          service: 'ai',
          authMode: 'apiKey',
          status: 'active',
          accountLabel: 'Primary',
          keyVersion: '2',
          encryptedSecret: JSON.stringify({
            algorithm: 'PLAINTEXT',
            ciphertext: JSON.stringify({ type: 'apiKey', apiKey: 'sk-primary-secret' }),
            webId: WEB_ID,
            credentialIri: credentialResource.buildIri(POD_URL, { id: credentialId }),
            provider: 'openai',
          }),
          metadata: { offeringId: 'api-platform', priority: 10, enabled: true, health: 'healthy' },
        }],
      ]);
      const database = {
        init: vi.fn(),
        select: () => ({
          from: (resource: unknown) => ({
            execute: async () => resource === credentialResource ? [...rows.values()] : [],
          }),
        }),
        findById: vi.fn(async (_resource: unknown, id: string) => rows.get(id) ?? null),
        updateById: vi.fn(async () => updateResult),
      };
      const store = createXpodAiConnectionsPodStore({
        database: database as never,
        podUrl: POD_URL,
        webId: WEB_ID,
      });

      await expect(store.updateProviderCredential!('openai', credentialId, {
        expectedVersion: 2,
        label: 'Renamed',
        enabled: false,
      })).rejects.toThrow('credential_update_failed');

      const provider = (await store.listProviders()).find((item) => item.id === 'openai');
      expect(provider?.credentials).toEqual([
        expect.objectContaining({
          id: credentialId,
          label: 'Primary',
          enabled: true,
          version: 2,
        }),
      ]);
    },
  );

  it('persists OAuth completion as a sibling credential with the current Pod database', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    rows.set('credentials.ttl#kimi-api', {
      id: 'credentials.ttl#kimi-api',
      provider: aiProviderResource.buildId({ id: 'kimi' }),
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
    });
    const database = {
      init: vi.fn(),
      select: () => ({ from: () => ({ execute: async () => [...rows.values()] }) }),
      findById: vi.fn(async (_resource: unknown, id: string) => rows.get(id) ?? null),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (_resource: unknown, id: string, patch: Record<string, unknown>) => {
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    const saved = await store.saveOAuthCredential!('kimi', {
      accessToken: 'kimi-access-token',
      refreshToken: 'kimi-refresh-token',
      expiresAt: '2026-08-09T08:00:00.000Z',
      scope: 'openid profile',
      accountSubject: 'moonshot-user-1',
      offeringId: 'subscription-key',
      accountId: 'moonshot-account-1',
      accountLabel: 'alice@kimi.example',
    }) as { id: string; authMode: string };

    expect(saved).toMatchObject({ authMode: 'deviceCode' });
    expect(rows.has('credentials.ttl#kimi-api')).toBe(true);
    const stored = rows.get(saved.id)!;
    expect(stored.metadata).toMatchObject({
      offeringId: 'subscription-key',
      authoritativeSubject: 'moonshot-user-1',
      accountId: 'moonshot-account-1',
    });
    expect(stored.accountLabel).toBe('alice@kimi.example');
    const envelope = JSON.parse(String(stored.encryptedSecret));
    expect(JSON.parse(atob(envelope.ciphertext))).toEqual(expect.objectContaining({
      type: 'deviceCodeOAuth',
      accessToken: 'kimi-access-token',
      refreshToken: 'kimi-refresh-token',
    }));

    rows.set(saved.id, {
      ...stored, status: 'disabled', accountLabel: 'My subscription', label: 'My subscription',
      metadata: { ...stored.metadata as object, priority: 7, enabled: false },
      models: ['selected-model'],
    });
    const secondStore = createXpodAiConnectionsPodStore({ database: database as never, podUrl: POD_URL, webId: WEB_ID });
    const identity = { offeringId: 'subscription-key', accountId: 'moonshot-account-1', accountSubject: 'moonshot-user-1' };
    const repeated = await Promise.all([store, secondStore].map((target) => target.saveOAuthCredential!('kimi', {
      ...identity, accessToken: 'replacement-token', accountLabel: 'Changed upstream label',
    })));
    expect(repeated).toEqual([
      expect.objectContaining({ id: saved.id, version: 2, label: 'My subscription', priority: 7, enabled: false }),
      expect.objectContaining({ id: saved.id, version: 3, label: 'My subscription', priority: 7, enabled: false }),
    ]);
    expect(rows.size).toBe(2);
    expect(rows.get(saved.id)).toMatchObject({ status: 'disabled', models: ['selected-model'] });

    // Missing metadata must still permit exact identity matching from the bound secret.
    rows.set(saved.id, { ...rows.get(saved.id)!, metadata: undefined });
    const fromSecret = await store.saveOAuthCredential!('kimi', { ...identity, accessToken: 'secret-matched-token' });
    expect(fromSecret).toMatchObject({ id: saved.id, version: 4, enabled: false });
    expect(rows.size).toBe(2);

    // A shared account id cannot override a conflicting authoritative subject.
    const conflict = await store.saveOAuthCredential!('kimi', {
      ...identity, accountSubject: 'different-subject', accessToken: 'different-token', accountLabel: 'My subscription',
    }) as { id: string };
    expect(conflict.id).not.toBe(saved.id);
    const unidentified = await store.saveOAuthCredential!('kimi', {
      offeringId: 'subscription-key', accessToken: 'unidentified-token', accountLabel: 'My subscription',
    }) as { id: string };
    expect(unidentified.id).not.toBe(saved.id);
    const otherOffering = await store.saveOAuthCredential!('kimi', {
      ...identity, offeringId: 'official-subscription', accessToken: 'other-offering-token',
    }) as { id: string };
    expect(otherOffering.id).not.toBe(saved.id);

    const beforeConcurrentCreate = rows.size;
    const concurrentCreates = await Promise.all([store, secondStore].map((target) => target.saveOAuthCredential!('kimi', {
      offeringId: 'subscription-key', accountId: 'brand-new-account', accessToken: 'new-token',
    }))) as Array<{ id: string }>;
    expect(concurrentCreates[0].id).toBe(concurrentCreates[1].id);
    expect(rows.size).toBe(beforeConcurrentCreate + 1);

    await expect(store.updateOAuthCredential!('kimi', saved.id, 4, {
      accessToken: 'next-access-token',
      refreshToken: 'next-refresh-token',
      expiresAt: '2026-08-09T09:00:00.000Z',
    })).resolves.toMatchObject({ version: 5, authMode: 'deviceCode' });
    await expect(store.updateOAuthCredential!('kimi', saved.id, 1, {
      accessToken: 'stale-access-token',
      refreshToken: 'stale-refresh-token',
    })).rejects.toThrow('credential_version_conflict');
    const refreshedEnvelope = JSON.parse(String(rows.get(saved.id)?.encryptedSecret));
    expect(JSON.parse(atob(refreshedEnvelope.ciphertext))).toEqual(expect.objectContaining({
      accessToken: 'next-access-token',
      refreshToken: 'next-refresh-token',
      accountId: 'moonshot-account-1',
      accountSubject: 'moonshot-user-1',
    }));
  });

  it('keeps the discovered model type so an embedding model is listed as one', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const providerId = aiProviderResource.buildId({ id: 'openai' });
    const rowsByResource = new Map<unknown, Map<string, Record<string, unknown>>>([
      [credentialResource, new Map()],
      [aiProviderResource, new Map()],
      [aiModelResource, new Map()],
    ]);
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => [...(rowsByResource.get(resource)?.values() ?? [])],
        }),
      }),
      findById: vi.fn(async (resource: unknown, id: string) => rowsByResource.get(resource)?.get(id) ?? null),
      insert: (resource: unknown) => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rowsByResource.get(resource)?.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (resource: unknown, id: string, patch: Record<string, unknown>) => {
        const rows = rowsByResource.get(resource)!;
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      authenticatedFetch,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    await store.saveDiscoveredModels!('openai', 'credentials.ttl#openai-primary', [
      { id: 'gpt-5', modelType: 'chat' },
      { id: 'text-embedding-3-small', modelType: 'embedding' },
    ]);

    // 同步模型的类型必须落进 Pod 行：行里没有类型，embedding 模型之后就和普通
    // 模型无从区分，向量模型列表与 embedding 允许名单都找不到它。
    expect(rowsByResource.get(aiModelResource)?.get('openai.ttl#text-embedding-3-small'))
      .toEqual(expect.objectContaining({ modelType: 'embedding' }));
    await expect(store.listModels!()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'text-embedding-3-small',
        modelType: 'embedding',
        capabilities: ['embedding'],
      }),
      expect.objectContaining({ id: 'gpt-5', modelType: 'chat' }),
    ]));
    const chatRow = (await store.listModels!()).find((model) => model.id === 'gpt-5')!;
    // 只有向量模型带能力标记：聊天模型的能力由目录投影提供，不由 Pod 行伪造。
    expect(chatRow.capabilities).toBeUndefined();

    // 后续一次没有类型的同步不能把已记录的类型抹掉。
    await store.saveDiscoveredModels!('openai', 'credentials.ttl#openai-primary', [
      { id: 'text-embedding-3-small' },
    ]);
    expect(rowsByResource.get(aiModelResource)?.get('openai.ttl#text-embedding-3-small'))
      .toEqual(expect.objectContaining({ modelType: 'embedding' }));
  });

  it('persists discovered models and provider selection while retaining missing selected models', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const providerId = aiProviderResource.buildId({ id: 'deepseek' });
    const selectedModelId = 'deepseek.ttl#deepseek-reasoner';
    const rowsByResource = new Map<unknown, Map<string, Record<string, unknown>>>([
      [credentialResource, new Map()],
      [aiProviderResource, new Map([
        ['deepseek-api-platform.ttl#this', {
          id: 'deepseek-api-platform.ttl#this',
          displayName: 'DeepSeek API Platform',
        }],
        [providerId, {
          id: providerId,
          displayName: 'DeepSeek',
          hasModel: [selectedModelId],
        }],
      ])],
      [aiModelResource, new Map([[selectedModelId, {
        id: selectedModelId,
        displayName: 'DeepSeek Reasoner',
        isProvidedBy: providerId,
        status: 'active',
      }]])],
    ]);
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => [...(rowsByResource.get(resource)?.values() ?? [])],
        }),
      }),
      findById: vi.fn(async (resource: unknown, id: string) => rowsByResource.get(resource)?.get(id) ?? null),
      insert: (resource: unknown) => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rowsByResource.get(resource)?.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (resource: unknown, id: string, patch: Record<string, unknown>) => {
        const rows = rowsByResource.get(resource)!;
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      authenticatedFetch,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    await store.saveDiscoveredModels!('deepseek', 'credentials.ttl#deepseek-primary', [
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
    ]);

    await expect(store.listModels!()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deepseek-chat', availability: 'available' }),
      // Capabilities are not Pod data: a row records what was discovered, and
      // the application derives what a model can do from its id.
      expect.objectContaining({ id: 'deepseek-reasoner', availability: 'unavailable' }),
    ]));

    let provider = (await store.listProviders()).find((item) => item.id === 'deepseek')!;
    expect(provider.selectedModels).toEqual([
      expect.objectContaining({ id: 'deepseek-reasoner', availability: 'unavailable' }),
    ]);

    await store.saveModelSelection!('deepseek', [{ id: 'deepseek-chat' }]);
    provider = (await store.listProviders()).find((item) => item.id === 'deepseek')!;
    expect(provider.selectedModels).toEqual([
      expect.objectContaining({ id: 'deepseek-chat', displayName: 'DeepSeek Chat', availability: 'available' }),
    ]);
    expect(rowsByResource.get(aiProviderResource)?.get(providerId)?.hasModel).toEqual([
      'deepseek.ttl#deepseek-chat',
    ]);
    expect(authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/settings/providers/deepseek.ttl'),
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('https://undefineds.co/ns#hasModel'),
      }),
    );
    const selectionPatch = String(authenticatedFetch.mock.calls.at(-1)?.[1]?.body);
    expect(selectionPatch).toContain('DELETE DATA');
    expect(selectionPatch).toContain('deepseek-reasoner');
    expect(selectionPatch).toContain('INSERT DATA');
    expect(selectionPatch).toContain('deepseek-chat');
    expect(selectionPatch).not.toContain('WHERE');

    await store.saveModelSelection!('deepseek', [
      { id: 'stale-upstream-id', resourceId: 'deepseek.ttl#deepseek-chat' },
    ]);
    expect(rowsByResource.get(aiProviderResource)?.get(providerId)?.hasModel).toEqual([
      'deepseek.ttl#deepseek-chat',
    ]);

    // A selection pinned before the storage model moved a provider's model
    // documents still names the older document. It is carried over to where the
    // model lives now, instead of failing the write and stranding every other
    // model in the selection.
    await store.saveModelSelection!('deepseek', [
      { id: 'deepseek-chat', resourceId: 'deepseek-official-subscription.ttl#deepseek-chat' },
    ]);
    expect(rowsByResource.get(aiProviderResource)?.get(providerId)?.hasModel).toEqual([
      'deepseek.ttl#deepseek-chat',
    ]);

    await expect(store.saveModelSelection!('deepseek', [
      { id: 'foreign-model', resourceId: 'kimi-subscription-key.ttl#foreign-model' },
    ])).rejects.toThrow('invalid_model_selection_resource');
  });

  it('uses credential IRIs from gateway model discovery when updating offering-scoped catalogs', async () => {
    const productProviderId = aiProviderResource.buildId({ id: 'openai' });
    const offeringProviderId = aiProviderResource.buildId({ id: 'openai-api-platform.ttl#this' });
    const credentialId = credentialResource.buildId({ id: 'openai-primary' });
    const selectedModelId = 'openai.ttl#fixture-gpt-acceptance';
    const offeringModelId = 'openai-api-platform.ttl#fixture-gpt-acceptance';
    const rowsByResource = new Map<unknown, Map<string, Record<string, unknown>>>([
      [credentialResource, new Map([[credentialId, {
        id: credentialId,
        provider: productProviderId,
        service: 'ai',
        authMode: 'apiKey',
        status: 'active',
        metadata: { offeringId: 'api-platform', priority: 10, enabled: true },
      }]])],
      [aiProviderResource, new Map([
        [productProviderId, { id: productProviderId, displayName: 'OpenAI', hasModel: [selectedModelId] }],
        [offeringProviderId, { id: offeringProviderId, displayName: 'OpenAI API Platform' }],
      ])],
      [aiModelResource, new Map([[offeringModelId, {
        id: offeringModelId,
        displayName: 'Fixture GPT Acceptance',
        isProvidedBy: offeringProviderId,
        status: 'active',
      }]])],
    ]);
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => [...(rowsByResource.get(resource)?.values() ?? [])],
        }),
      }),
      findById: vi.fn(async (resource: unknown, id: string) => rowsByResource.get(resource)?.get(id) ?? null),
      insert: (resource: unknown) => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rowsByResource.get(resource)?.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (resource: unknown, id: string, patch: Record<string, unknown>) => {
        const rows = rowsByResource.get(resource)!;
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    await store.saveDiscoveredModels!(
      'openai',
      credentialResource.buildIri(POD_URL, { id: credentialId }),
      [],
    );

    expect(rowsByResource.get(aiModelResource)?.get(offeringModelId)?.status).toBe('unavailable');
    const provider = (await store.listProviders()).find((item) => item.id === 'openai')!;
    expect(provider.selectedModels).toEqual([
      expect.objectContaining({ id: 'fixture-gpt-acceptance', availability: 'unavailable' }),
    ]);
  });

  it('stores a provider’s models in one document whatever offering discovered them', async () => {
    const productProviderId = aiProviderResource.buildId({ id: 'bailian' });
    const paygCredentialId = credentialResource.buildId({ id: 'bailian-payg' });
    const tokenCredentialId = credentialResource.buildId({ id: 'bailian-token-personal' });
    const rowsByResource = new Map<unknown, Map<string, Record<string, unknown>>>([
      [credentialResource, new Map([
        [paygCredentialId, {
          id: paygCredentialId,
          provider: productProviderId,
          service: 'ai',
          authMode: 'apiKey',
          status: 'active',
          accountLabel: 'Pay as you go',
          metadata: { offeringId: 'pay-as-you-go', enabled: true },
        }],
        [tokenCredentialId, {
          id: tokenCredentialId,
          provider: productProviderId,
          service: 'ai',
          authMode: 'apiKey',
          status: 'active',
          accountLabel: 'Token Plan Personal',
          metadata: { offeringId: 'token-plan-personal', enabled: true },
        }],
      ])],
      [aiProviderResource, new Map([[productProviderId, {
        id: productProviderId,
        displayName: '百炼',
      }]])],
      [aiModelResource, new Map()],
    ]);
    const database = {
      init: vi.fn(),
      select: () => ({
        from: (resource: unknown) => ({
          execute: async () => [...(rowsByResource.get(resource)?.values() ?? [])],
        }),
      }),
      findById: vi.fn(async (resource: unknown, id: string) => rowsByResource.get(resource)?.get(id) ?? null),
      insert: (resource: unknown) => ({
        values: (value: Record<string, unknown>) => ({
          execute: async () => {
            rowsByResource.get(resource)?.set(String(value.id), value);
            return [value];
          },
        }),
      }),
      updateById: vi.fn(async (resource: unknown, id: string, patch: Record<string, unknown>) => {
        const rows = rowsByResource.get(resource)!;
        const current = rows.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch };
        rows.set(id, updated);
        return updated;
      }),
    };
    const store = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    await store.saveDiscoveredModels!("bailian", paygCredentialId, [
      { id: 'qwen-same', displayName: 'Qwen Pay as You Go' },
    ]);
    await store.saveDiscoveredModels!("bailian", tokenCredentialId, [
      { id: 'qwen-same', displayName: 'Qwen Token Plan Personal' },
    ]);

    // One provider document holds the provider's models: the same upstream id
    // discovered through two offerings is one row, not one row per offering, and
    // no `providers/bailian-<offering>.ttl` document appears.
    const persistedModels = [...rowsByResource.get(aiModelResource)!.values()];
    expect(persistedModels).toHaveLength(1);
    expect(persistedModels[0]).toMatchObject({
      id: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: productProviderId }),
      isProvidedBy: productProviderId,
    });
    expect([...rowsByResource.get(aiProviderResource)!.keys()]).toEqual([productProviderId]);

    const reloadedStore = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });
    await expect(reloadedStore.listModels!()).resolves.toEqual([
      expect.objectContaining({
        id: 'qwen-same',
        provider: 'bailian',
        resourceId: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: productProviderId }),
      }),
    ]);

    await reloadedStore.saveModelSelection!('bailian', [
      { id: 'qwen-same', offeringId: 'pay-as-you-go' },
      { id: 'qwen-same', offeringId: 'token-plan' },
    ]);
    // Two offerings picking the same upstream model are one provider reference,
    // not a real entry plus a dangling twin.
    expect(rowsByResource.get(aiProviderResource)?.get(productProviderId)?.hasModel).toEqual([
      aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: productProviderId }),
    ]);
    const bailian = (await reloadedStore.listProviders()).find((provider) => provider.id === 'bailian');
    expect(bailian?.selectedModels).toEqual([
      expect.objectContaining({
        id: 'qwen-same',
        resourceId: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: productProviderId }),
        availability: 'available',
      }),
    ]);
  });
  it('names the document each table lives in, and never a row, as its live-update topic', () => {
    const store = createXpodAiConnectionsPodStore({
      database: {
        init: vi.fn(),
        select: () => ({ from: () => ({ execute: async () => [] }) }),
      } as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    // A table is one document: the credentials table, and one document per
    // provider holding that provider's row plus its model rows.
    expect(store.credentialsTableDocument!()).toBe(`${POD_URL}settings/credentials.ttl`);
    expect(store.providerTableDocument!('openai')).toBe(`${POD_URL}settings/providers/openai.ttl`);

    // A user-defined provider instance owns its own document, so the instance -
    // not the provider id - selects the topic, and the row fragment is dropped.
    const customDocument = store.providerTableDocument!('custom', 'credentials.ttl#custom-one');
    expect(customDocument.startsWith(`${POD_URL}settings/providers/custom-instance-`)).toBe(true);
    expect(customDocument.endsWith('.ttl')).toBe(true);
    expect(customDocument).not.toContain('#');
  });
});
