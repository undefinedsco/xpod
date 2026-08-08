import { describe, expect, it, vi } from 'vitest';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { createXpodAiConnectionsPodStore } from './XpodAiConnectionsPodStore';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

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
    expect(created).toMatchObject({ maskedHint: 'sk-...alue', version: 1 });
    expect(JSON.stringify(rows.get(created.id))).not.toContain('sk-secret-value');
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

  it('persists discovered models and provider selection while retaining missing selected models', async () => {
    const providerId = aiProviderResource.buildId({ id: 'deepseek' });
    const selectedModelId = 'deepseek.ttl#deepseek-reasoner';
    const rowsByResource = new Map<unknown, Map<string, Record<string, unknown>>>([
      [credentialResource, new Map()],
      [aiProviderResource, new Map([[providerId, {
        id: providerId,
        displayName: 'DeepSeek',
        hasModel: [selectedModelId],
      }]])],
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
      podUrl: POD_URL,
      webId: WEB_ID,
    });

    await store.saveDiscoveredModels!('deepseek', 'credentials.ttl#deepseek-primary', [
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
    ]);

    await expect(store.listModels!()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deepseek-chat', availability: 'available' }),
      expect.objectContaining({ id: 'deepseek-reasoner', availability: 'unavailable' }),
    ]));

    let provider = (await store.listProviders()).find((item) => item.id === 'deepseek')!;
    expect(provider.selectedModels).toEqual([
      expect.objectContaining({ id: 'deepseek-reasoner', availability: 'unavailable' }),
    ]);

    await store.saveModelSelection!('deepseek', ['deepseek-chat']);
    provider = (await store.listProviders()).find((item) => item.id === 'deepseek')!;
    expect(provider.selectedModels).toEqual([
      expect.objectContaining({ id: 'deepseek-chat', displayName: 'DeepSeek Chat', availability: 'available' }),
    ]);
    expect(rowsByResource.get(aiProviderResource)?.get(providerId)?.hasModel).toEqual([
      'deepseek.ttl#deepseek-chat',
    ]);
  });
});
