import { describe, expect, it, afterEach } from 'vitest';

import {
  ProviderRegistry,
  createDefaultProviderRegistry,
  type ProviderDescriptor,
} from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import {
  fetchModelsDevCatalog,
  resetModelsDevCatalogCache,
} from '../../../src/api/ai-gateway/providers/ModelsDevCatalog';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import {
  ModelRouter,
  type GatewayCredentialCandidate,
} from '../../../src/api/ai-gateway/routing/ModelRouter';
import { RedisSessionAffinityStore } from '../../../src/api/ai-gateway/routing/RedisSessionAffinityStore';
import { createEmbeddingModelPolicy } from '../../../src/ai/service/EmbeddingModelPolicy';
import { createGatewayEmbeddingModelCatalog } from '../../../src/api/ai-gateway/models/GatewayEmbeddingModelCatalog';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';
const AFFINITY_SECRET = '0123456789abcdef0123456789abcdef';
const OTHER_AFFINITY_SECRET = 'abcdef0123456789abcdef0123456789';

function credential(input: Partial<GatewayCredentialCandidate> & {
  id: string;
  provider: string;
  models?: string[];
}): GatewayCredentialCandidate {
  return {
    source: input.source,
    id: input.id,
    credentialIri: input.credentialIri ?? `https://pod.example/alice/settings/credentials.ttl#${input.id}`,
    provider: input.provider,
    authMode: input.authMode ?? 'apiKey',
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    models: input.models,
    modelProjections: input.modelProjections,
    defaultModel: input.defaultModel,
    health: input.health ?? 'healthy',
    quota: input.quota ?? { status: 'available' },
    cooldownUntil: input.cooldownUntil,
    customModels: input.customModels,
    metadata: input.metadata,
  };
}

function router(input: {
  credentials?: GatewayCredentialCandidate[];
  registry?: ProviderRegistry;
  defaultProvider?: string;
  defaultModel?: string;
  embeddingModelPolicy?: ReturnType<typeof createEmbeddingModelPolicy>;
  selections?: Array<{
    provider: string;
    models: Array<string | { id: string; modelType?: string; status?: 'active' | 'inactive'; displayName?: string }>;
    defaultModel?: string;
    version?: string;
  }>;
  now?: Date;
} = {}): ModelRouter {
  return new ModelRouter({
    registry: input.registry ?? createDefaultProviderRegistry(),
    affinityStore: new InMemorySessionAffinityStore({ secret: AFFINITY_SECRET }),
    credentials: async() => input.credentials ?? [],
    selectionRepository: input.selections
      ? { listActiveSelections: async() => input.selections! }
      : undefined,
    defaultProvider: input.defaultProvider,
    defaultModel: input.defaultModel,
    embeddingModelPolicy: input.embeddingModelPolicy,
    now: () => input.now ?? new Date('2026-07-23T00:00:00.000Z'),
  });
}

describe('ModelRouter platform and personal model union', () => {
  it('preserves platform metadata while binding model ownership to the configured route', async () => {
    const registry = createDefaultProviderRegistry();
    registry.register({ ...registry.requireProvider('openai'), id: 'platform-test', models: [], deploymentManaged: true });
    const modelRouter = router({ registry, credentials: [credential({
      id: 'platform', source: 'platform', provider: 'platform-test', models: ['org/model'],
      modelProjections: [{ id: 'org/model', object: 'model', owned_by: 'upstream', context_window: 32768, modalities: { input: ['text', 'image'], output: ['text'] }, protocols: ['chatCompletions'] }],
    })], selections: [] });
    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'cloud' });
    expect(models).toContainEqual({ id: 'org/model', object: 'model', owned_by: 'platform-test', context_window: 32768, modalities: { input: ['text', 'image'], output: ['text'] }, protocols: ['chatCompletions'] });
    expect((await modelRouter.route({ webId: WEB_ID, deployment: 'cloud', model: 'org/model' })).provider.id).toBe('platform-test');
    models[0].modalities!.input!.push('audio');
    expect((await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'cloud' }))[0].modalities!.input).toEqual(['text', 'image']);
  });
  function setup(selections?: Array<{ provider: string; models: string[] }>) {
    const registry = createDefaultProviderRegistry();
    registry.register({ ...registry.requireProvider('openai'), id: 'platform-test', models: [], deploymentManaged: true });
    const platform = credential({ id: 'platform-credential', source: 'platform', provider: 'platform-test', models: ['gpt-5', 'platform-only'], priority: 1000 });
    const personal = credential({ id: 'personal-credential', provider: 'openai', models: ['gpt-5'] });
    return router({ registry, credentials: [platform, personal], selections });
  }

  it('deduplicates a shared model in favor of the personal route even when platform candidates arrive first', async () => {
    const modelRouter = setup();
    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });
    expect(models.filter((model) => model.id === 'gpt-5')).toEqual([expect.objectContaining({ owned_by: 'openai' })]);
    expect(models).toContainEqual(expect.objectContaining({ id: 'platform-only', owned_by: 'platform-test' }));
    const route = await modelRouter.route({ webId: WEB_ID, deployment: 'local', model: 'gpt-5' });
    expect(route.credential.id).toBe('personal-credential');
  });

  it('keeps platform models visible and routable when a new account has no personal selections', async () => {
    const modelRouter = setup([]);
    expect(await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' })).toEqual([
      expect.objectContaining({ id: 'gpt-5', owned_by: 'platform-test' }),
      expect.objectContaining({ id: 'platform-only', owned_by: 'platform-test' }),
    ]);
    expect((await modelRouter.route({ webId: WEB_ID, deployment: 'local', model: 'platform-only' })).credential.id).toBe('platform-credential');
  });

  it('merges platform models with explicit personal selections without duplicating a shared id', async () => {
    const modelRouter = setup([{ provider: 'openai', models: ['gpt-5'] }]);
    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });
    expect(models.filter((model) => model.id === 'gpt-5')).toEqual([expect.objectContaining({ owned_by: 'openai' })]);
    expect(models).toContainEqual(expect.objectContaining({ id: 'platform-only' }));
  });

  it('uses a healthy platform model when the matching personal credential is disabled', async () => {
    const registry = createDefaultProviderRegistry();
    registry.register({ ...registry.requireProvider('openai'), id: 'platform-test', models: [], deploymentManaged: true });
    const modelRouter = router({ registry, credentials: [
      credential({ id: 'disabled', provider: 'openai', models: ['gpt-5'], enabled: false }),
      credential({ id: 'platform', provider: 'platform-test', source: 'platform', models: ['gpt-5'] }),
    ] });
    expect((await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'cloud' }))[0].owned_by).toBe('platform-test');
    expect((await modelRouter.route({ webId: WEB_ID, deployment: 'cloud', model: 'gpt-5' })).credential.id).toBe('platform');
  });

  it('rejects a personal credential that forges the deployment platform provider identity', async () => {
    const registry = createDefaultProviderRegistry();
    registry.register({ ...registry.requireProvider('openai'), id: 'platform-test', models: [], deploymentManaged: true });
    const modelRouter = router({ registry, credentials: [credential({ id: 'forged', provider: 'platform-test', models: ['platform-only'] })] });
    expect(await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'cloud' })).toEqual([]);
    await expect(modelRouter.route({ webId: WEB_ID, deployment: 'cloud', model: 'platform-test/platform-only' })).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('does not let a disabled catalog credential intercept a healthy personal compatible route with a platform alternative', async () => {
    const registry = createDefaultProviderRegistry();
    registry.register({ ...registry.requireProvider('openai'), id: 'platform-test', models: [], deploymentManaged: true });
    const modelRouter = router({ registry, credentials: [
      credential({ id: 'disabled-catalog', provider: 'openai', models: ['gpt-5'], enabled: false }),
      credential({ id: 'personal-compatible', provider: 'custom', models: ['gpt-5'] }),
      credential({ id: 'platform', provider: 'platform-test', source: 'platform', models: ['gpt-5'] }),
    ] });
    expect((await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' }))[0]).toMatchObject({ id: 'gpt-5', owned_by: 'custom' });
    expect((await modelRouter.route({ webId: WEB_ID, deployment: 'local', model: 'gpt-5' })).credential.id).toBe('personal-compatible');
  });

  it.each([
    ['org/model', undefined],
    ['openai/gpt-5', undefined],
    ['smart', { smart: { provider: 'openai', model: 'gpt-5' } }],
  ])('routes the published opaque id %s before provider prefixes and aliases', async (model, aliases) => {
    const registry = new ProviderRegistry(createDefaultProviderRegistry().listProviders(), { aliases });
    registry.register({ ...registry.requireProvider('openai'), id: 'platform-test', models: [], deploymentManaged: true });
    for (const selections of [undefined, []]) {
      const modelRouter = router({ registry, selections, credentials: [
        credential({ id: 'personal', provider: 'openai', models: ['gpt-5'] }),
        credential({ id: 'platform', provider: 'platform-test', source: 'platform', models: [model] }),
      ] });
      expect(await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'cloud' })).toContainEqual(expect.objectContaining({ id: model, owned_by: 'platform-test' }));
      expect(await modelRouter.route({ webId: WEB_ID, deployment: 'cloud', model })).toMatchObject({ model, provider: { id: 'platform-test' }, credential: { id: 'platform' } });
    }
  });
});

describe('ProviderRegistry', () => {
  it('seeds first-phase providers with safe endpoints, protocols and auth modes', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.requireProvider('openai')).toMatchObject({
      id: 'openai',
      authModes: ['browserAssistedApiKey', 'apiKey'],
      connect: { mode: 'browserAssistedApiKey' },
      protocols: ['responses', 'chatCompletions'],
      safeBaseUrls: ['https://api.openai.com/v1'],
      capabilities: {
        toolCalls: true,
        reasoningEffort: true,
        imageInput: true,
      },
    });
    expect(registry.requireProvider('anthropic')).toMatchObject({
      authModes: ['browserAssistedApiKey', 'apiKey'],
      connect: { mode: 'browserAssistedApiKey' },
      protocols: ['anthropic'],
      safeBaseUrls: ['https://api.anthropic.com/v1'],
    });
    expect(registry.requireProvider('kimi')).toMatchObject({
      authModes: ['browserAssistedApiKey', 'apiKey'],
      connect: {
        mode: 'browserAssistedApiKey',
        notes: ['Device-code login is intentionally not offered; use a Token Plan or API Platform key.'],
      },
      protocols: ['chatCompletions'],
    });
    expect(registry.requireProvider('bailian')).toMatchObject({
      authModes: ['browserAssistedApiKey', 'apiKey'],
      connect: { mode: 'browserAssistedApiKey' },
      protocols: ['anthropic', 'chatCompletions'],
    });
    expect(registry.requireProvider('deepseek')).toMatchObject({
      authModes: ['browserAssistedApiKey', 'apiKey'],
      connect: { mode: 'browserAssistedApiKey' },
      protocols: ['chatCompletions'],
      safeBaseUrls: ['https://api.deepseek.com/v1'],
    });
  });

  it('merges dynamic model metadata without changing provider endpoint boundaries', () => {
    const registry = new ProviderRegistry([
      {
        id: 'openai',
        label: 'OpenAI',
        authModes: ['browserAssistedApiKey', 'apiKey'],
        connect: {
          mode: 'browserAssistedApiKey',
          label: 'Browser-assisted key setup',
          apiKeyManagementSupported: true,
        },
        protocols: ['responses'],
        defaultBaseUrl: 'https://api.openai.com/v1',
        safeBaseUrls: ['https://api.openai.com/v1'],
        capabilities: { toolCalls: true, reasoningEffort: true },
        models: [
          { id: 'gpt-5', contextWindow: 200_000, capabilities: { toolCalls: true } },
        ],
      },
    ]);

    registry.mergeDiscoveredModels('openai', [
      {
        id: 'gpt-5',
        contextWindow: 256_000,
        capabilities: { imageInput: true },
        metadata: {
          baseUrl: 'https://evil.example/v1',
          providerEndpoint: 'https://evil.example/v1/responses',
        },
      },
    ]);

    expect(registry.requireProvider('openai')).toMatchObject({
      defaultBaseUrl: 'https://api.openai.com/v1',
      safeBaseUrls: ['https://api.openai.com/v1'],
      models: [
        {
          id: 'gpt-5',
          contextWindow: 256_000,
          capabilities: { toolCalls: true, reasoningEffort: true, imageInput: true },
          metadata: {},
        },
      ],
    });
  });
});

describe('ModelRouter', () => {
  afterEach((): void => {
    resetModelsDevCatalogCache();
  });

  it('enriches projections for models missing from the static registry via the models.dev cache', async () => {
    const fetchImpl = (async (): Promise<Response> => Response.json({
      zhipuai: {
        id: 'zhipuai',
        name: 'Zhipu AI',
        models: {
          'glm-4.6': {
            id: 'glm-4.6',
            reasoning: true,
            tool_call: true,
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 204800 },
          },
        },
      },
    })) as typeof fetch;
    await fetchModelsDevCatalog({ fetch: fetchImpl });

    const modelRouter = router({
      credentials: [
        credential({ id: 'zhipu_key', provider: 'zhipu', models: ['glm-4.6'] }),
      ],
    });

    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });

    expect(models).toEqual([
      expect.objectContaining({
        id: 'glm-4.6',
        owned_by: 'zhipu',
        context_window: 204800,
        capabilities: { toolCalls: true, reasoningEffort: true, imageInput: false },
      }),
    ]);
  });

  it('omits capabilities for models unknown to both the registry and the models.dev cache', async () => {
    const modelRouter = router({
      credentials: [
        credential({ id: 'ollama_local', provider: 'ollama', models: ['qwen3:8b'] }),
      ],
    });

    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });

    expect(models).toEqual([
      expect.objectContaining({ id: 'qwen3:8b', owned_by: 'ollama' }),
    ]);
    expect(models[0]).not.toHaveProperty('capabilities');
  });

  it('fails closed for a requested registry model when the credential Pick is empty', async () => {
    const modelRouter = router({
      credentials: [
        credential({ id: 'empty_pick', provider: 'openai', models: [] }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 403,
      details: { provider: 'openai', model: 'gpt-5' },
    });
  });

  it('fails closed for a default model when the credential Pick is empty', async () => {
    const modelRouter = router({
      defaultProvider: 'openai',
      defaultModel: 'gpt-5',
      credentials: [
        credential({ id: 'empty_pick', provider: 'openai', models: [] }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: '',
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 403,
      details: { provider: 'openai', model: 'gpt-5' },
    });
  });

  it('keeps legacy unrestricted routing only when models are absent', async () => {
    const modelRouter = router({
      credentials: [
        credential({ id: 'legacy_unrestricted', provider: 'openai' }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      provider: { id: 'openai' },
      model: 'gpt-5',
      credential: { id: 'legacy_unrestricted' },
    });
  });

  it('routes by alias before explicit provider/model and exact model matches', async () => {
    const registry = createDefaultProviderRegistry({
      aliases: {
        'claude-sonnet': { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
        'deepseek/deepseek-chat': { provider: 'openai', model: 'gpt-5' },
      },
    });
    const modelRouter = router({
      registry,
      credentials: [
        credential({ id: 'cred_openai', provider: 'openai', models: ['gpt-5'] }),
        credential({ id: 'cred_anthropic', provider: 'anthropic', models: ['claude-sonnet-4-5-20250929'] }),
        credential({ id: 'cred_deepseek', provider: 'deepseek', models: ['deepseek-chat'] }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'claude-sonnet',
    })).resolves.toMatchObject({
      provider: { id: 'anthropic' },
      model: 'claude-sonnet-4-5-20250929',
      credential: { id: 'cred_anthropic' },
      source: 'alias',
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'deepseek/deepseek-chat',
    })).resolves.toMatchObject({
      provider: { id: 'openai' },
      model: 'gpt-5',
      credential: { id: 'cred_openai' },
      source: 'alias',
    });
  });

  it('falls through explicit provider/model, exact model, default provider and default model in order', async () => {
    const modelRouter = router({
      defaultProvider: 'bailian',
      defaultModel: 'qwen-max',
      credentials: [
        credential({ id: 'cred_openai', provider: 'openai', models: ['gpt-5'] }),
        credential({ id: 'cred_deepseek', provider: 'deepseek', models: ['deepseek-chat'] }),
        credential({ id: 'cred_bailian', provider: 'bailian', models: ['qwen-max'], defaultModel: 'qwen-max' }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'local',
      model: 'deepseek/deepseek-chat',
    })).resolves.toMatchObject({
      provider: { id: 'deepseek' },
      model: 'deepseek-chat',
      credential: { id: 'cred_deepseek' },
      source: 'explicit-provider',
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'local',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      provider: { id: 'openai' },
      model: 'gpt-5',
      credential: { id: 'cred_openai' },
      source: 'exact-model',
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'local',
      model: '',
    })).resolves.toMatchObject({
      provider: { id: 'bailian' },
      model: 'qwen-max',
      credential: { id: 'cred_bailian' },
      source: 'default-model',
    });
  });

  it('routes custom credential models even when an allowlist restricts registry models', async () => {
    const modelRouter = router({
      credentials: [
        credential({
          id: 'cred_openai',
          provider: 'openai',
          models: ['gpt-5'],
          customModels: [{ id: 'ft-my-model', displayName: 'My Fine Tune' }],
        }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'ft-my-model',
    })).resolves.toMatchObject({
      provider: { id: 'openai' },
      model: 'ft-my-model',
      credential: { id: 'cred_openai' },
    });
  });

  it('still rejects non-allowlisted registry models when custom models exist', async () => {
    const modelRouter = router({
      credentials: [
        credential({
          id: 'cred_openai',
          provider: 'openai',
          models: ['gpt-5'],
          customModels: [{ id: 'ft-my-model' }],
        }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-4.1',
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
  });

  it('does not let unrestricted credentials from another provider claim registry-owned exact models', async () => {
    const modelRouter = router({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      credentials: [
        credential({ id: 'cred_anthropic', provider: 'anthropic', models: [] }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 403,
      details: {
        provider: 'openai',
        model: 'gpt-5',
      },
    });
  });

  it('routes a visible catalog model through the custom credential that explicitly selected it', async () => {
    const modelRouter = router({
      credentials: [credential({ id: 'custom_key', provider: 'custom', models: ['deepseek-chat'] })],
    });

    await expect(modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' })).resolves.toContainEqual(
      expect.objectContaining({ id: 'deepseek-chat', owned_by: 'custom' }),
    );
    await expect(modelRouter.route({ webId: WEB_ID, deployment: 'local', model: 'deepseek-chat' }))
      .resolves.toMatchObject({
        provider: { id: 'custom' },
        credential: { id: 'custom_key' },
        model: 'deepseek-chat',
        source: 'exact-model',
      });
    await expect(modelRouter.route({ webId: WEB_ID, deployment: 'local', model: 'deepseek/deepseek-chat' }))
      .rejects.toMatchObject({ code: 'credential_unavailable', details: { provider: 'deepseek' } });
  });

  it('does not infer a cross-provider route from an unrestricted credential', async () => {
    const modelRouter = router({
      credentials: [credential({ id: 'custom_key', provider: 'custom' })],
    });

    await expect(modelRouter.route({ webId: WEB_ID, deployment: 'local', model: 'deepseek-chat' }))
      .rejects.toMatchObject({ code: 'credential_unavailable', details: { provider: 'deepseek' } });
  });

  it('rejects explicit provider/model routes when the provider is not registered', async () => {
    const modelRouter = router({
      credentials: [
        credential({ id: 'cred_openai', provider: 'openai', models: ['gpt-5'] }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'foo/bar',
    })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: {
        provider: 'foo',
      },
    });
  });

  it('skips disabled, expired, exhausted and cooling credentials unless explicitly requested', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    const modelRouter = router({
      now,
      credentials: [
        credential({ id: 'disabled', provider: 'openai', enabled: false, models: ['gpt-5'], priority: 1 }),
        credential({ id: 'expired', provider: 'openai', health: 'reauthRequired', models: ['gpt-5'], priority: 2 }),
        credential({ id: 'quota', provider: 'openai', quota: { status: 'exhausted' }, models: ['gpt-5'], priority: 3 }),
        credential({
          id: 'cooling',
          provider: 'openai',
          cooldownUntil: new Date('2026-07-23T00:05:00.000Z'),
          models: ['gpt-5'],
          priority: 4,
        }),
        credential({ id: 'healthy', provider: 'openai', models: ['gpt-5'], priority: 5 }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      credential: { id: 'healthy' },
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
      explicitCredentialId: 'disabled',
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 403,
    });
  });

  it('honors explicit healthy credentials and disables failover for them', async () => {
    const modelRouter = router({
      credentials: [
        credential({ id: 'preferred', provider: 'openai', models: ['gpt-5'], priority: 100 }),
        credential({ id: 'fallback', provider: 'openai', models: ['gpt-5'], priority: 200 }),
      ],
    });

    const route = await modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
      explicitCredentialId: 'fallback',
    });

    expect(route).toMatchObject({
      credential: { id: 'fallback' },
      failover: {
        allowedBeforeFirstEvent: false,
        committed: false,
        clientEventEmitted: false,
      },
    });
    expect(modelRouter.markClientEventEmitted(route)).toMatchObject({
      allowedBeforeFirstEvent: false,
      committed: true,
      clientEventEmitted: true,
    });
  });

  it('uses the same route filtering when excluding failed credentials for failover', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    const modelRouter = router({
      now,
      credentials: [
        credential({ id: 'failed', provider: 'openai', models: ['gpt-5'], priority: 1 }),
        credential({ id: 'disabled', provider: 'openai', enabled: false, models: ['gpt-5'], priority: 2 }),
        credential({ id: 'reauth', provider: 'openai', health: 'reauthRequired', models: ['gpt-5'], priority: 3 }),
        credential({ id: 'quota', provider: 'openai', quota: { status: 'exhausted' }, models: ['gpt-5'], priority: 4 }),
        credential({
          id: 'cooling',
          provider: 'openai',
          cooldownUntil: new Date('2026-07-23T00:05:00.000Z'),
          models: ['gpt-5'],
          priority: 5,
        }),
        credential({ id: 'wrong_model', provider: 'openai', models: ['gpt-4.1'], priority: 6 }),
        credential({ id: 'healthy', provider: 'openai', models: ['gpt-5'], priority: 7 }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    }, new Set(['failed']))).resolves.toMatchObject({
      credential: { id: 'healthy' },
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
      explicitCredentialId: 'failed',
    }, new Set(['failed']))).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 403,
    });
  });

  it('routes product credentials through compatible offering runtime provider ids', async () => {
    const modelRouter = router({
      credentials: [
        credential({
          id: 'token_plan',
          provider: 'bailian-token-plan',
          models: ['qwen-max'],
          metadata: { offeringId: 'token-plan' },
        }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'bailian/qwen-max',
    })).resolves.toMatchObject({
      provider: { id: 'bailian' },
      model: 'qwen-max',
      credential: {
        id: 'token_plan',
        provider: 'bailian-token-plan',
      },
    });
  });

  it('maps credential-only runtime provider custom models back to the provider product id', async () => {
    const modelRouter = router({
      credentials: [
        credential({
          id: 'token_plan',
          provider: 'bailian-token-plan',
          customModels: [{ id: 'qwen-token-custom' }],
          metadata: { offeringId: 'token-plan' },
        }),
      ],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'qwen-token-custom',
    })).resolves.toMatchObject({
      provider: { id: 'bailian' },
      model: 'qwen-token-custom',
      credential: {
        id: 'token_plan',
        provider: 'bailian-token-plan',
      },
    });
  });

  it('keeps conversation affinity isolated by deployment and WebID without using raw prompt text', async () => {
    const affinityStore = new InMemorySessionAffinityStore({
      secret: AFFINITY_SECRET,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });
    const modelRouter = new ModelRouter({
      registry: createDefaultProviderRegistry(),
      affinityStore,
      credentials: async(input) => [
        credential({ id: 'cred_a', provider: 'openai', models: ['gpt-5'], priority: 1 }),
        credential({ id: 'cred_b', provider: 'openai', models: ['gpt-5'], priority: 2 }),
      ].filter((item) => input.webId === WEB_ID ? true : item.id === 'cred_b'),
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    const first = await modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
      conversationId: 'chat/index.ttl#thread_1',
      rawPrompt: 'do not include this prompt in the affinity key',
    });
    const second = await modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
      conversationId: 'chat/index.ttl#thread_1',
      rawPrompt: 'a totally different prompt',
    });
    const otherDeployment = await modelRouter.route({
      webId: WEB_ID,
      deployment: 'local',
      model: 'gpt-5',
      conversationId: 'chat/index.ttl#thread_1',
    });
    const otherWebId = await modelRouter.route({
      webId: OTHER_WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
      conversationId: 'chat/index.ttl#thread_1',
    });

    expect(first.credential.id).toBe('cred_a');
    expect(second.credential.id).toBe('cred_a');
    expect(otherDeployment.affinityKey).not.toBe(first.affinityKey);
    expect(otherWebId.affinityKey).not.toBe(first.affinityKey);
    expect(Array.from(affinityStore.debugKeys()).join('\n')).not.toContain('prompt');
  });

  it('expires in-memory affinity entries and records cooldowns with isolated keys', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const store = new InMemorySessionAffinityStore({
      secret: AFFINITY_SECRET,
      ttlMs: 1_000,
      now: () => now,
    });

    await store.set({
      deployment: 'cloud',
      webId: WEB_ID,
      conversationId: 'chat/index.ttl#thread_1',
      provider: 'openai',
      credentialId: 'cred_a',
    });
    expect(await store.get({
      deployment: 'cloud',
      webId: WEB_ID,
      conversationId: 'chat/index.ttl#thread_1',
      provider: 'openai',
    })).toMatchObject({ credentialId: 'cred_a' });

    now = new Date('2026-07-23T00:00:02.000Z');
    expect(await store.get({
      deployment: 'cloud',
      webId: WEB_ID,
      conversationId: 'chat/index.ttl#thread_1',
      provider: 'openai',
    })).toBeUndefined();

    await store.setCooldown({
      deployment: 'cloud',
      webId: WEB_ID,
      credentialId: 'cred_a',
      until: new Date('2026-07-23T00:05:00.000Z'),
    });
    expect(await store.getCooldown({
      deployment: 'cloud',
      webId: WEB_ID,
      credentialId: 'cred_a',
    })).toEqual(new Date('2026-07-23T00:05:00.000Z'));
    expect(await store.getCooldown({
      deployment: 'local',
      webId: WEB_ID,
      credentialId: 'cred_a',
    })).toBeUndefined();
  });

  it('skips credentials cooled through the affinity store with WebID and deployment isolation', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const affinityStore = new InMemorySessionAffinityStore({
      secret: AFFINITY_SECRET,
      now: () => now,
    });
    const modelRouter = new ModelRouter({
      registry: createDefaultProviderRegistry(),
      affinityStore,
      credentials: async() => [
        credential({ id: 'cred_a', provider: 'openai', models: ['gpt-5'], priority: 1 }),
        credential({ id: 'cred_b', provider: 'openai', models: ['gpt-5'], priority: 2 }),
      ],
      now: () => now,
    });

    await modelRouter.recordCooldown({
      deployment: 'cloud',
      webId: WEB_ID,
      credentialId: 'cred_a',
      until: new Date('2026-07-23T00:05:00.000Z'),
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      credential: { id: 'cred_b' },
    });
    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'local',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      credential: { id: 'cred_a' },
    });
    await expect(modelRouter.route({
      webId: OTHER_WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      credential: { id: 'cred_a' },
    });

    now = new Date('2026-07-23T00:06:00.000Z');
    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      credential: { id: 'cred_a' },
    });
  });

  it('uses the stricter value between candidate cooldownUntil and store cooldown', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const affinityStore = new InMemorySessionAffinityStore({
      secret: AFFINITY_SECRET,
      now: () => now,
    });
    const modelRouter = new ModelRouter({
      registry: createDefaultProviderRegistry(),
      affinityStore,
      credentials: async() => [
        credential({
          id: 'cred_a',
          provider: 'openai',
          models: ['gpt-5'],
          priority: 1,
          cooldownUntil: new Date('2026-07-23T00:01:00.000Z'),
        }),
        credential({ id: 'cred_b', provider: 'openai', models: ['gpt-5'], priority: 2 }),
      ],
      now: () => now,
    });
    await modelRouter.recordCooldown({
      deployment: 'cloud',
      webId: WEB_ID,
      credentialId: 'cred_a',
      until: new Date('2026-07-23T00:05:00.000Z'),
    });

    now = new Date('2026-07-23T00:02:00.000Z');
    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      credential: { id: 'cred_b' },
    });

    now = new Date('2026-07-23T00:06:00.000Z');
    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'cloud',
      model: 'gpt-5',
    })).resolves.toMatchObject({
      credential: { id: 'cred_a' },
    });
  });

  it('uses Redis-compatible PX TTL storage without double-encoding cooldown timestamps', async () => {
    const calls: Array<{ key: string; value: string; args: unknown[] }> = [];
    const values = new Map<string, string>();
    const redis = {
      async get(key: string): Promise<string | null> {
        return values.get(key) ?? null;
      },
      async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
        calls.push({ key, value, args });
        values.set(key, value);
        return 'OK';
      },
      async del(key: string): Promise<unknown> {
        values.delete(key);
        return 1;
      },
    };
    const store = new RedisSessionAffinityStore({
      client: redis,
      secret: AFFINITY_SECRET,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await store.setCooldown({
      deployment: 'cloud',
      webId: WEB_ID,
      credentialId: 'cred_a',
      until: new Date('2026-07-23T00:05:00.000Z'),
    });

    expect(calls[0]).toMatchObject({
      value: '2026-07-23T00:05:00.000Z',
      args: ['PX', 300_000],
    });
    await expect(store.getCooldown({
      deployment: 'cloud',
      webId: WEB_ID,
      credentialId: 'cred_a',
    })).resolves.toEqual(new Date('2026-07-23T00:05:00.000Z'));
  });

  it('derives stable HMAC affinity keys with secret isolation and no raw identity material', async () => {
    const first = new InMemorySessionAffinityStore({ secret: AFFINITY_SECRET });
    const sameSecret = new RedisSessionAffinityStore({
      client: {
        async get(): Promise<string | null> { return null; },
        async set(): Promise<unknown> { return 'OK'; },
        async del(): Promise<unknown> { return 0; },
      },
      secret: AFFINITY_SECRET,
    });
    const otherSecret = new InMemorySessionAffinityStore({ secret: OTHER_AFFINITY_SECRET });
    const identity = {
      deployment: 'cloud',
      webId: WEB_ID,
      conversationId: 'chat/index.ttl#thread_1',
      provider: 'openai',
    };

    expect(first.debugAffinityKey(identity)).toBe(sameSecret.debugAffinityKey(identity));
    expect(first.debugAffinityKey(identity)).not.toBe(otherSecret.debugAffinityKey(identity));
    expect(first.debugAffinityKey(identity)).toMatch(/:web_[a-f0-9]{64}:openai:conv_[a-f0-9]{64}$/u);
    expect(first.debugAffinityKey(identity)).not.toContain(WEB_ID);
    expect(first.debugAffinityKey(identity)).not.toContain('thread_1');
    expect(first.debugAffinityKey(identity)).not.toContain('prompt');
    const cooldownIdentity = {
      deployment: 'cloud',
      webId: WEB_ID,
      credentialId: 'settings/credentials.ttl#cred_openai_api_key',
    };
    expect(first.cooldownKey(cooldownIdentity)).toBe(sameSecret.cooldownKey(cooldownIdentity));
    expect(first.cooldownKey(cooldownIdentity)).not.toBe(otherSecret.cooldownKey(cooldownIdentity));
    expect(first.cooldownKey(cooldownIdentity)).toMatch(/:web_[a-f0-9]{64}:cred_[a-f0-9]{64}$/u);
    expect(first.cooldownKey(cooldownIdentity)).not.toContain('cred_openai_api_key');
    expect(() => new InMemorySessionAffinityStore({ secret: 'too-short' })).toThrow(/128-bit/);
    expect(() => new RedisSessionAffinityStore({
      client: {
        async get(): Promise<string | null> { return null; },
        async set(): Promise<unknown> { return 'OK'; },
        async del(): Promise<unknown> { return 0; },
      },
    })).toThrow(/secret/);
  });
});

describe('ModelRouter embedding capability projection', () => {
  const customCredential = credential({
    id: 'cred_openai',
    provider: 'openai',
    models: ['gpt-5', 'text-embedding-3-small'],
    customModels: [
      { id: 'ft-my-model', capabilities: ['tool_call', 'embedding'] },
      { id: 'text-embedding-3-small', capabilities: ['embedding'] },
    ],
  });

  it('never advertises a user-declared embedding model the cloud catalog does not provide', async () => {
    const modelRouter = router({
      credentials: [customCredential],
      embeddingModelPolicy: createEmbeddingModelPolicy({
        deployment: 'cloud',
        catalog: createGatewayEmbeddingModelCatalog(createDefaultProviderRegistry(), 'cloud'),
      }),
    });

    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'cloud' });
    const fineTune = models.find((model) => model.id === 'ft-my-model');

    expect(fineTune?.custom).toBe(true);
    expect(fineTune?.custom_capabilities).toEqual(['tool_call']);
    // The catalog-provided embedding model keeps its capability flag.
    const provided = models.find((model) => model.id === 'text-embedding-3-small');
    expect(provided?.capabilities).toMatchObject({ embedding: true });
  });

  it('keeps local projections unchanged', async () => {
    const modelRouter = router({
      credentials: [customCredential],
      embeddingModelPolicy: createEmbeddingModelPolicy({
        deployment: 'local',
        catalog: createGatewayEmbeddingModelCatalog(createDefaultProviderRegistry(), 'local'),
      }),
    });

    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });
    expect(models.find((model) => model.id === 'ft-my-model')?.custom_capabilities)
      .toEqual(['tool_call', 'embedding']);
  });
});

describe('ModelRouter published model names', () => {
  it('publishes the name the Pod recorded for a selected model', async () => {
    const modelRouter = router({
      credentials: [credential({ id: 'cred_openai', provider: 'openai', models: ['gpt-6-astra'] })],
      selections: [{
        provider: 'openai',
        version: 'v1',
        models: [{
          id: 'openai.ttl#gpt-6-astra',
          modelType: 'chat',
          status: 'active',
          displayName: 'GPT-6-Astra',
        }],
      }],
    });

    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });

    // The settings model lists render `display name` over `id` on both pages,
    // so the published projection has to carry the name the Pod stored.
    expect(models.find((model) => model.id === 'gpt-6-astra')).toMatchObject({
      id: 'gpt-6-astra',
      owned_by: 'openai',
      display_name: 'GPT-6-Astra',
    });
  });

  it('publishes the name the credential recorded for a picked model', async () => {
    const modelRouter = router({
      credentials: [{
        ...credential({ id: 'cred_openai', provider: 'openai', models: ['gpt-6-astra'] }),
        modelNames: { 'gpt-6-astra': 'GPT-6-Astra' },
      }],
    });

    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });

    // Without a selection repository the visible list comes from the credential,
    // which is what the local runtime wires. The Pod's name has to win over the
    // catalog name so this list matches the provider page for the same model.
    expect(models.find((model) => model.id === 'gpt-6-astra')?.display_name).toBe('GPT-6-Astra');
  });

  it('leaves an unnamed selection without a display name', async () => {
    const modelRouter = router({
      credentials: [credential({ id: 'cred_openai', provider: 'openai', models: ['gpt-6-astra'] })],
      selections: [{
        provider: 'openai',
        version: 'v1',
        models: [{ id: 'openai.ttl#gpt-6-astra', modelType: 'chat', status: 'active' }],
      }],
    });

    const models = await modelRouter.listVisibleModels({ webId: WEB_ID, deployment: 'local' });
    const model = models.find((candidate) => candidate.id === 'gpt-6-astra');

    expect(model).toBeTruthy();
    // A name may only come from the Pod row or the provider catalog; never from
    // the id itself, which the client already renders on its own line.
    expect(model?.display_name).not.toBe('gpt-6-astra');
  });
});
