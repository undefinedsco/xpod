import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../../src/api/ai-gateway/AiGatewayService';
import {
  encodePlaintextCredential,
  UnsupportedCredentialStorageModeError,
} from '../../../src/api/ai-gateway/credentials/PlaintextCredentialPayload';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import {
  ModelRouter,
  type GatewayModelSelection,
} from '../../../src/api/ai-gateway/routing/ModelRouter';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const AUTH: AuthContext = {
  type: 'solid',
  webId: WEB_ID,
  viaApiKey: true,
};

function credential(input: Partial<StoredGatewayCredential> & {
  id: string;
  provider: string;
  models?: string[];
}): StoredGatewayCredential {
  return {
    id: input.id,
    credentialIri: input.credentialIri ?? `https://pod.example/settings/credentials.ttl#${input.id}`,
    provider: input.provider,
    authMode: input.authMode ?? 'apiKey',
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    models: input.models ?? [],
    defaultModel: input.defaultModel,
    health: input.health ?? 'healthy',
    quota: input.quota ?? { status: 'available' },
    cooldownUntil: input.cooldownUntil,
    metadata: input.metadata,
    storageMode: input.storageMode ?? 'plaintext-v1',
    secretPayload: input.secretPayload ?? encodePlaintextCredential({
      type: 'apiKey',
      apiKey: input.credentialIri?.includes('backup') ? 'sk-backup' : 'sk-primary',
    }),
    version: input.version,
    runtimeCredential: input.runtimeCredential,
  };
}

function serviceWith(
  credentials: StoredGatewayCredential[],
  now = new Date('2026-07-23T00:00:00.000Z'),
  selections?: GatewayModelSelection[],
): {
  service: AiGatewayService;
  store: GatewayCredentialStore;
} {
  const registry = createDefaultProviderRegistry();
  const durableSelections = selections ?? selectionsFromCredentials(credentials, registry);
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async() => credentials),
    recordSuccess: vi.fn(async() => {}),
    recordFailure: vi.fn(async() => {}),
  };
  const runtimes = {
    get: vi.fn(() => ({
      execute: vi.fn(async function* () {
        yield { type: 'response.started', id: 'resp_1' };
        yield { type: 'text.delta', text: 'ok' };
        yield { type: 'response.completed', finishReason: 'stop' };
      }),
    })),
  } as unknown as ProviderRuntimeRegistry;

  return {
    store,
    service: new AiGatewayService({
      deployment: 'cloud',
      registry,
      router: new ModelRouter({
        registry,
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: store.listCredentials,
        selectionRepository: { listActiveSelections: async() => durableSelections },
        now: () => now,
      }),
      credentials: store,
      runtimes,
      now: () => now,
    }),
  };
}

function selectionsFromCredentials(
  credentials: StoredGatewayCredential[],
  registry: ReturnType<typeof createDefaultProviderRegistry>,
): GatewayModelSelection[] {
  const selections = new Map<string, GatewayModelSelection>();
  for (const credential of credentials) {
    const provider = credential.provider.trim().toLowerCase();
    const models = credential.models?.length
      ? credential.models
      : registry.getProvider(provider)?.models.map((model) => model.id) ?? [];
    const selection = selections.get(provider) ?? { provider, models: [], version: `test:${provider}` };
    const existing = new Set(selection.models.map((model) => typeof model === 'string' ? model : model.id));
    for (const model of models) {
      if (!existing.has(model)) {
        selection.models.push({ id: `${provider}.ttl#${model}`, status: 'active', modelType: 'chat' });
      }
    }
    selections.set(provider, selection);
  }
  return Array.from(selections.values());
}

describe('AiGatewayService', () => {
  it('returns an empty model projection for a connected provider with no durable picks', async () => {
    const { service } = serviceWith([
      credential({ id: 'connected_openai', provider: 'openai', models: [] }),
    ], undefined, []);

    await expect(service.listModels(AUTH)).resolves.toEqual([]);
  });

  it('projects only active selected models whose credentials are usable', async () => {
    const { service } = serviceWith([
      credential({ id: 'healthy', provider: 'openai', models: [] }),
      credential({ id: 'reauth', provider: 'openai', health: 'reauthRequired', models: ['gpt-4.1'] }),
      credential({ id: 'quota', provider: 'openai', quota: { status: 'exhausted' }, models: ['gpt-4.1'] }),
      credential({
        id: 'cooling',
        provider: 'openai',
        cooldownUntil: new Date('2026-07-23T00:05:00.000Z'),
        models: ['gpt-4.1'],
      }),
    ], undefined, [{
      provider: 'openai',
      models: [
        { id: 'openai.ttl#gpt-5', modelType: 'chat', status: 'active' },
        { id: 'openai.ttl#gpt-4.1', modelType: 'chat', status: 'inactive' },
      ],
      version: 'sha256:openai',
    }]);

    await expect(service.listModels(AUTH)).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
    ]);
  });

  it('rejects an explicit unpicked model before provider runtime I/O', async () => {
    const fixture = serviceWith([
      credential({ id: 'healthy', provider: 'openai', models: [] }),
    ], undefined, [{
      provider: 'openai',
      models: [{ id: 'openai.ttl#gpt-5', modelType: 'chat', status: 'active' }],
      version: 'sha256:openai',
    }]);
    const runtime = vi.fn();
    (fixture.service as any).runtimes.get = vi.fn(() => ({ execute: runtime }));

    await expect(fixture.service.execute({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).rejects.toMatchObject({ code: 'model_not_available', status: 404 });
    expect(runtime).not.toHaveBeenCalled();
  });

  it('keeps durable model visibility isolated by WebID', async () => {
    const otherAuth: AuthContext = { type: 'solid', webId: 'https://id.example/bob/profile/card#me', viaApiKey: true };
    const selections: GatewayModelSelection[] = [{
      provider: 'openai',
      models: [{ id: 'openai.ttl#gpt-5', modelType: 'chat', status: 'active' }],
      version: 'sha256:openai',
    }];
    const registry = createDefaultProviderRegistry();
    const store: GatewayCredentialStore = {
      listCredentials: vi.fn(async(input) => input.webId === AUTH.webId
        ? [credential({ id: 'alice', provider: 'openai', models: [] })]
        : [credential({ id: 'bob', provider: 'openai', models: [] })]),
    };
    const selectionRepository = {
      listActiveSelections: vi.fn(async(input: { webId: string }) => input.webId === AUTH.webId ? selections : []),
    };
    const service = new AiGatewayService({
      deployment: 'cloud',
      registry,
      router: new ModelRouter({
        registry,
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: store.listCredentials,
        selectionRepository,
      }),
      credentials: store,
      runtimes: { get: vi.fn() } as unknown as ProviderRuntimeRegistry,
    });

    await expect(service.listModels(AUTH)).resolves.toHaveLength(1);
    await expect(service.listModels(otherAuth)).resolves.toEqual([]);
    expect(selectionRepository.listActiveSelections).toHaveBeenCalledWith(expect.objectContaining({ webId: AUTH.webId }));
    expect(selectionRepository.listActiveSelections).toHaveBeenCalledWith(expect.objectContaining({ webId: otherAuth.webId }));
  });

  it('lists the union of active credential model allowlists without exposing inactive credentials', async () => {
    const registryOnlyOpenAiModel = 'gpt-4.1';
    const { service } = serviceWith([
      credential({ id: 'limited_openai', provider: 'openai', models: ['gpt-5'] }),
      credential({ id: 'limited_deepseek', provider: 'deepseek', models: ['deepseek-chat'] }),
      credential({ id: 'disabled_openai', provider: 'openai', enabled: false, models: [registryOnlyOpenAiModel] }),
      credential({ id: 'reauth_openai', provider: 'openai', health: 'reauthRequired', models: [registryOnlyOpenAiModel] }),
    ]);

    await expect(service.listModels(AUTH)).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
      expect.objectContaining({ id: 'deepseek-chat', owned_by: 'deepseek' }),
    ]);
  });

  it('lists provider registry and discovered models only when an active unrestricted credential exists for that provider', async () => {
    const registry = createDefaultProviderRegistry();
    registry.mergeDiscoveredModels('openai', [{ id: 'gpt-5-dynamic-safe' }]);
    const credentials = [
      credential({ id: 'limited_openai', provider: 'openai', models: ['gpt-5'] }),
      credential({ id: 'unrestricted_disabled', provider: 'openai', enabled: false, models: [] }),
      credential({ id: 'unrestricted_deepseek', provider: 'deepseek', models: [] }),
    ];
    const store: GatewayCredentialStore = {
      listCredentials: vi.fn(async() => credentials),
    };
    const service = new AiGatewayService({
      deployment: 'cloud',
      registry,
      router: new ModelRouter({
        registry,
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: store.listCredentials,
        selectionRepository: {
          listActiveSelections: async() => [
            {
              provider: 'openai',
              models: [{ id: 'openai.ttl#gpt-5', modelType: 'chat', status: 'active' }],
              version: 'test:openai',
            },
            {
              provider: 'deepseek',
              models: [
                { id: 'deepseek.ttl#deepseek-chat', modelType: 'chat', status: 'active' },
                { id: 'deepseek.ttl#deepseek-reasoner', modelType: 'chat', status: 'active' },
              ],
              version: 'test:deepseek',
            },
          ],
        },
      }),
      credentials: store,
      runtimes: { get: vi.fn() } as unknown as ProviderRuntimeRegistry,
    });

    const models = await service.listModels(AUTH);

    expect(models.map((model) => model.id)).toEqual([
      'gpt-5',
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(models.map((model) => model.id)).not.toContain('gpt-4.1');
    expect(models.map((model) => model.id)).not.toContain('gpt-5-dynamic-safe');
  });

  it('opens plaintext-v1 credential payloads through the production inference read path without rewrap', async() => {
    const runtimeExecute = vi.fn(async function* () {
      yield { type: 'response.started', id: 'resp_1' };
      yield { type: 'text.delta', text: 'ok' };
      yield { type: 'response.completed', finishReason: 'stop' };
    });
    const fixture = serviceWith([
      credential({
        id: 'rotating',
        provider: 'openai',
        models: ['gpt-5'],
        version: 4,
        secretPayload: encodePlaintextCredential({ type: 'apiKey', apiKey: 'sk-plaintext-runtime' }),
      }),
    ]);
    (fixture.service as any).runtimes.get = vi.fn(() => ({ execute: runtimeExecute }));

    await fixture.service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(runtimeExecute).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-plaintext-runtime',
    }));
    expect(fixture.store).not.toHaveProperty('rewrapCredential');
  });

  it('keeps gateway auth on failover credential routing after the first route fails', async() => {
    const registry = createDefaultProviderRegistry();
    const authSeenByCredentialStore: Array<AuthContext | undefined> = [];
    const credentials = [
      credential({
        id: 'primary',
        provider: 'openai',
        models: ['gpt-5'],
        priority: 10,
        credentialIri: 'https://pod.example/settings/credentials.ttl#primary',
      }),
      credential({
        id: 'backup',
        provider: 'openai',
        models: ['gpt-5'],
        priority: 50,
        credentialIri: 'https://pod.example/settings/credentials.ttl#backup',
      }),
    ];
    const store: GatewayCredentialStore = {
      listCredentials: vi.fn(async(input) => {
        authSeenByCredentialStore.push(input.auth);
        return credentials;
      }),
      recordFailure: vi.fn(async() => {}),
      recordSuccess: vi.fn(async() => {}),
    };
    const runtimeExecute = vi.fn(async function* (input: { apiKey: string }) {
      if (input.apiKey === 'sk-primary') {
        throw new Error('primary unavailable before first event');
      }
      yield { type: 'response.started', id: 'resp_1' };
      yield { type: 'text.delta', text: 'ok' };
      yield { type: 'response.completed', finishReason: 'stop' };
    });
    const service = new AiGatewayService({
      deployment: 'cloud',
      registry,
      router: new ModelRouter({
        registry,
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: store.listCredentials,
        selectionRepository: {
          listActiveSelections: async() => [{
            provider: 'openai',
            models: [{ id: 'openai.ttl#gpt-5', modelType: 'chat', status: 'active' }],
            version: 'test:openai',
          }],
        },
      }),
      credentials: store,
      runtimes: { get: vi.fn(() => ({ execute: runtimeExecute })) } as unknown as ProviderRuntimeRegistry,
    });

    await expect(service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).resolves.toMatchObject({ choices: expect.any(Array) });

    expect(authSeenByCredentialStore).toEqual([AUTH, AUTH]);
    expect(runtimeExecute).toHaveBeenCalledTimes(2);
    expect(runtimeExecute).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-backup' }));
  });

  it('fails closed on legacy encrypted credential rows before provider runtime I/O', async() => {
    const runtimeExecute = vi.fn();
    const fixture = serviceWith([
      {
        ...credential({ id: 'legacy', provider: 'openai', models: ['gpt-5'] }),
        storageMode: 'secret-cell-v1' as 'plaintext-v1',
        secretPayload: '',
        encryptedSecret: { ciphertext: 'sk-legacy-secret' },
      } as unknown as StoredGatewayCredential,
    ]);
    (fixture.service as any).runtimes.get = vi.fn(() => ({ execute: runtimeExecute }));

    await expect(fixture.service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).rejects.toThrow(UnsupportedCredentialStorageModeError);
    await expect(fixture.service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).rejects.not.toThrow(/sk-legacy-secret/);
    expect(runtimeExecute).not.toHaveBeenCalled();
  });
});
