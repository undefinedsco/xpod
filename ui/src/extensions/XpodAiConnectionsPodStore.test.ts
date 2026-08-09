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
    }) as { id: string; authMode: string };

    expect(saved).toMatchObject({ authMode: 'deviceCode' });
    expect(rows.has('credentials.ttl#kimi-api')).toBe(true);
    const stored = rows.get(saved.id)!;
    expect(stored.metadata).toMatchObject({
      offeringId: 'official-subscription',
      authoritativeSubject: 'moonshot-user-1',
    });
    const envelope = JSON.parse(String(stored.encryptedSecret));
    expect(JSON.parse(atob(envelope.ciphertext))).toEqual(expect.objectContaining({
      type: 'deviceCodeOAuth',
      accessToken: 'kimi-access-token',
      refreshToken: 'kimi-refresh-token',
    }));

    await expect(store.updateOAuthCredential!('kimi', saved.id, 1, {
      accessToken: 'next-access-token',
      refreshToken: 'next-refresh-token',
      expiresAt: '2026-08-09T09:00:00.000Z',
    })).resolves.toMatchObject({ version: 2, authMode: 'deviceCode' });
    await expect(store.updateOAuthCredential!('kimi', saved.id, 1, {
      accessToken: 'stale-access-token',
      refreshToken: 'stale-refresh-token',
    })).rejects.toThrow('credential_version_conflict');
    const refreshedEnvelope = JSON.parse(String(rows.get(saved.id)?.encryptedSecret));
    expect(JSON.parse(atob(refreshedEnvelope.ciphertext))).toEqual(expect.objectContaining({
      accessToken: 'next-access-token',
      refreshToken: 'next-refresh-token',
    }));
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

  it('keeps same-named models isolated by their offering-qualified Provider after reload', async () => {
    const productProviderId = aiProviderResource.buildId({ id: 'bailian' });
    const paygOfferingProviderId = aiProviderResource.buildId({ id: 'bailian-pay-as-you-go.ttl#this' });
    const tokenOfferingProviderId = aiProviderResource.buildId({ id: 'bailian-token-plan-personal.ttl#this' });
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

    const persistedModels = [...rowsByResource.get(aiModelResource)!.values()];
    expect(persistedModels).toHaveLength(2);
    expect(persistedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: paygOfferingProviderId }),
        isProvidedBy: paygOfferingProviderId,
        displayName: 'Qwen Pay as You Go',
      }),
      expect.objectContaining({
        id: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: tokenOfferingProviderId }),
        isProvidedBy: tokenOfferingProviderId,
        displayName: 'Qwen Token Plan Personal',
      }),
    ]));

    const reloadedStore = createXpodAiConnectionsPodStore({
      database: database as never,
      podUrl: POD_URL,
      webId: WEB_ID,
    });
    await expect(reloadedStore.listModels!()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'qwen-same', provider: 'bailian', offeringId: 'pay-as-you-go', resourceId: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: paygOfferingProviderId }), displayName: 'Qwen Pay as You Go' }),
      expect.objectContaining({ id: 'qwen-same', provider: 'bailian', offeringId: 'token-plan', resourceId: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: tokenOfferingProviderId }), displayName: 'Qwen Token Plan Personal' }),
    ]));

    await reloadedStore.saveModelSelection!('bailian', [
      aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: paygOfferingProviderId }),
      aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: tokenOfferingProviderId }),
    ]);
    const bailian = (await reloadedStore.listProviders()).find((provider) => provider.id === 'bailian');
    expect(bailian?.selectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'qwen-same', offeringId: 'pay-as-you-go', resourceId: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: paygOfferingProviderId }) }),
      expect.objectContaining({ id: 'qwen-same', offeringId: 'token-plan', resourceId: aiModelResource.buildId({ id: 'qwen-same', isProvidedBy: tokenOfferingProviderId }) }),
    ]));
  });
});
