import { describe, expect, it } from 'vitest';

import {
  ProviderRegistry,
  createDefaultProviderRegistry,
  type ProviderDescriptor,
} from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import {
  ModelRouter,
  type GatewayCredentialCandidate,
} from '../../../src/api/ai-gateway/routing/ModelRouter';
import { RedisSessionAffinityStore } from '../../../src/api/ai-gateway/routing/RedisSessionAffinityStore';

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
    id: input.id,
    credentialIri: input.credentialIri ?? `https://pod.example/alice/settings/credentials.ttl#${input.id}`,
    provider: input.provider,
    authMode: input.authMode ?? 'apiKey',
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    models: input.models ?? [],
    defaultModel: input.defaultModel,
    health: input.health ?? 'healthy',
    quota: input.quota ?? { status: 'available' },
    cooldownUntil: input.cooldownUntil,
    customModels: input.customModels,
    runtimeCredential: input.runtimeCredential,
    metadata: input.metadata,
  };
}

function router(input: {
  credentials?: GatewayCredentialCandidate[];
  registry?: ProviderRegistry;
  defaultProvider?: string;
  defaultModel?: string;
  now?: Date;
} = {}): ModelRouter {
  return new ModelRouter({
    registry: input.registry ?? createDefaultProviderRegistry(),
    affinityStore: new InMemorySessionAffinityStore({ secret: AFFINITY_SECRET }),
    credentials: async() => input.credentials ?? [],
    defaultProvider: input.defaultProvider,
    defaultModel: input.defaultModel,
    now: () => input.now ?? new Date('2026-07-23T00:00:00.000Z'),
  });
}

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
      authModes: ['deviceCodeOAuth', 'apiKey'],
      connect: { mode: 'deviceCodeOAuth' },
      protocols: ['chatCompletions'],
    });
    expect(registry.requireProvider('bailian')).toMatchObject({
      authModes: ['browserAssistedApiKey', 'apiKey'],
      connect: { mode: 'browserAssistedApiKey' },
      protocols: ['anthropic', 'chatCompletions'],
    });
    expect(registry.requireProvider('deepseek')).toMatchObject({
      authModes: ['connectUnsupported', 'apiKey'],
      connect: { mode: 'connectUnsupported' },
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

  it('registers an OpenAI-compatible custom provider from an explicit Pod credential route', async () => {
    const registry = createDefaultProviderRegistry();
    const modelRouter = router({
      registry,
      credentials: [credential({
        id: 'cred_timecc',
        provider: 'timecc',
        models: ['codex-auto-review'],
        runtimeCredential: { baseUrl: 'https://timicc.example/v1' },
      })],
    });

    await expect(modelRouter.route({
      webId: WEB_ID,
      deployment: 'local',
      model: 'timecc/codex-auto-review',
    })).resolves.toMatchObject({
      provider: { id: 'timecc' },
      model: 'codex-auto-review',
      credential: { id: 'cred_timecc' },
      source: 'explicit-provider',
    });
    expect(registry.requireProvider('timecc')).toMatchObject({
      protocols: ['chatCompletions'],
      safeBaseUrls: ['https://timicc.example/v1'],
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
