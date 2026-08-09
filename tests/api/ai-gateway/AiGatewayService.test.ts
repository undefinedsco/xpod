import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../../src/api/ai-gateway/AiGatewayService';
import type { CredentialVault } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import type { EncryptedCredentialSecret } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import { ProviderHttpTransport } from '../../../src/api/service/provider-http-transport';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const AUTH: AuthContext = {
  type: 'solid',
  webId: WEB_ID,
  viaGatewayApiKey: true,
  scopes: ['models:read', 'inference:write'],
};

function encrypted(id: string, provider = 'openai'): EncryptedCredentialSecret {
  return {
    algorithm: 'AES-256-GCM',
    aadPurpose: 'test',
    aadVersion: 'v1',
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    webId: WEB_ID,
    credentialIri: `https://pod.example/settings/credentials.ttl#${id}`,
    provider,
    dekWrapAlgorithm: 'test',
    keyId: 'test',
    wrappedDek: 'wrapped',
  };
}

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
    models: input.models,
    defaultModel: input.defaultModel,
    health: input.health ?? 'healthy',
    quota: input.quota ?? { status: 'available' },
    cooldownUntil: input.cooldownUntil,
    customModels: input.customModels,
    metadata: input.metadata,
    encryptedSecret: input.encryptedSecret ?? encrypted(input.id, input.provider),
    version: input.version,
    runtimeCredential: input.runtimeCredential,
  };
}

function serviceWith(
  credentials: StoredGatewayCredential[],
  now = new Date('2026-07-23T00:00:00.000Z'),
  options: {
    usageRecorder?: (input: {
      webId: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }) => Promise<void>;
  } = {},
): {
  service: AiGatewayService;
  store: GatewayCredentialStore;
  vault: CredentialVault;
} {
  const registry = createDefaultProviderRegistry();
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async() => credentials),
    recordSuccess: vi.fn(async() => {}),
    recordFailure: vi.fn(async() => {}),
  };
  const vault: CredentialVault = {
    seal: vi.fn(),
    rewrap: vi.fn(),
    open: vi.fn(async(_principal, credentialIri) => ({
      apiKey: credentialIri.includes('backup') ? 'sk-backup' : 'sk-primary',
    })),
  };
  const runtimes = {
    get: vi.fn(() => ({
      execute: vi.fn(async function* () {
        yield { type: 'response.started', id: 'resp_1' };
        yield { type: 'text.delta', text: 'ok' };
        if (options.usageRecorder) {
          yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
        }
        yield { type: 'response.completed', finishReason: 'stop' };
      }),
    })),
  } as unknown as ProviderRuntimeRegistry;

  return {
    store,
    vault,
    service: new AiGatewayService({
      deployment: 'cloud',
      registry,
      router: new ModelRouter({
        registry,
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: store.listCredentials,
        now: () => now,
      }),
      credentials: store,
      vault,
      runtimes,
      now: () => now,
      usageRecorder: options.usageRecorder,
    }),
  };
}

function kimiSse(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"chatcmpl_kimi","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('AiGatewayService', () => {
  it('records final upstream token usage once for the resolved Pod principal', async () => {
    const usageRecorder = vi.fn(async() => {});
    const { service } = serviceWith([
      credential({ id: 'openai', provider: 'openai', models: ['gpt-5'] }),
    ], undefined, { usageRecorder });
    const execution = await service.execute({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }], stream: true },
    });

    for await (const _event of execution.events) {
      // Usage is recorded only after the upstream stream has been consumed.
    }

    expect(usageRecorder).toHaveBeenCalledTimes(1);
    expect(usageRecorder).toHaveBeenCalledWith({
      webId: WEB_ID,
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
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

  it('exposes no models when an active credential has an empty model Pick', async () => {
    const { service } = serviceWith([
      credential({
        id: 'empty_pick',
        provider: 'openai',
        models: [],
        customModels: [{ id: 'ft-hidden' }],
      }),
    ]);

    await expect(service.listModels(AUTH)).resolves.toEqual([]);
  });

  it('lists provider registry and discovered models only when an active unrestricted credential exists for that provider', async () => {
    const registry = createDefaultProviderRegistry();
    registry.mergeDiscoveredModels('openai', [{ id: 'gpt-5-dynamic-safe' }]);
    const credentials = [
      credential({ id: 'limited_openai', provider: 'openai', models: ['gpt-5'] }),
      credential({ id: 'unrestricted_disabled', provider: 'openai', enabled: false, models: [] }),
      credential({ id: 'unrestricted_deepseek', provider: 'deepseek' }),
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
      }),
      credentials: store,
      vault: { seal: vi.fn(), rewrap: vi.fn(), open: vi.fn() },
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

  it('unions custom credential models with display names and capability markers', async () => {
    const { service } = serviceWith([
      credential({
        id: 'limited_openai',
        provider: 'openai',
        models: ['gpt-5'],
        customModels: [
          { id: 'ft-my-model', displayName: 'My Fine Tune', inputModalities: ['image'], capabilities: ['tool_call'] },
          { id: 'gpt-5', displayName: 'Shadow' },
        ],
      }),
    ]);

    const models = await service.listModels(AUTH);

    expect(models).toEqual([
      expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
      {
        id: 'ft-my-model',
        object: 'model',
        owned_by: 'openai',
        custom: true,
        display_name: 'My Fine Tune',
        modalities: { input: ['image'] },
        custom_capabilities: ['tool_call'],
      },
    ]);
    expect(models.filter((model) => model.id === 'gpt-5')).toHaveLength(1);
  });

  it('keeps custom models hidden when their credential is not model-visible', async () => {
    const { service } = serviceWith([
      credential({
        id: 'disabled_openai',
        provider: 'openai',
        enabled: false,
        models: [],
        customModels: [{ id: 'ft-hidden' }],
      }),
    ]);

    const models = await service.listModels(AUTH);
    expect(models.map((model) => model.id)).not.toContain('ft-hidden');
  });

  it('rewraps an old-key credential through the production inference read path', async() => {
    const oldEncrypted = { ...encrypted('rotating'), keyId: 'root-v1' };
    const activeEncrypted = { ...oldEncrypted, keyId: 'root-v2', wrappedDek: 'rewrapped' };
    const fixture = serviceWith([
      credential({
        id: 'rotating',
        provider: 'openai',
        models: ['gpt-5'],
        version: 4,
        encryptedSecret: oldEncrypted,
      }),
    ]);
    fixture.vault.needsRewrap = vi.fn(() => true);
    fixture.vault.rewrap = vi.fn(async() => activeEncrypted);
    fixture.store.rewrapCredential = vi.fn(async() => true);

    await fixture.service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(fixture.vault.rewrap).toHaveBeenCalledWith(
      { webId: WEB_ID },
      oldEncrypted,
    );
    expect(fixture.store.rewrapCredential).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      credentialId: 'rotating',
      expectedVersion: 4,
      encryptedSecret: activeEncrypted,
      auth: AUTH,
    });
  });

  it('passes the selected offering endpoint to the runtime credential', async() => {
    const runtimeExecute = vi.fn(async function* () {
      yield { type: 'response.started' as const, id: 'resp_1' };
      yield { type: 'response.completed' as const, finishReason: 'stop' };
    });
    const registry = createDefaultProviderRegistry();
    const credentials = [
      credential({
        id: 'token_plan',
        provider: 'bailian-token-plan',
        models: ['qwen-max'],
        metadata: { offeringId: 'token-plan' },
        encryptedSecret: encrypted('token_plan', 'bailian-token-plan'),
      }),
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
      }),
      credentials: store,
      vault: {
        seal: vi.fn(),
        rewrap: vi.fn(),
        open: vi.fn(async() => ({ apiKey: 'sk-token-plan' })),
      },
      runtimes: { get: vi.fn(() => ({ execute: runtimeExecute })) } as unknown as ProviderRuntimeRegistry,
    });

    await service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'bailian/qwen-max',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(runtimeExecute).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        keyType: 'tokenPlan',
      }),
    }));
  });

  it('passes Bailian Coding Plan through the Anthropic-compatible offering endpoint', async() => {
    const runtimeExecute = vi.fn(async function* () {
      yield { type: 'response.started' as const, id: 'resp_1' };
      yield { type: 'response.completed' as const, finishReason: 'stop' };
    });
    const registry = createDefaultProviderRegistry();
    const credentials = [
      credential({
        id: 'coding_plan',
        provider: 'bailian-coding-plan',
        models: ['qwen-coder-plus'],
        metadata: { offeringId: 'coding-plan' },
        encryptedSecret: encrypted('coding_plan', 'bailian-coding-plan'),
      }),
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
      }),
      credentials: store,
      vault: {
        seal: vi.fn(),
        rewrap: vi.fn(),
        open: vi.fn(async() => ({ apiKey: 'sk-sp-coding-plan' })),
      },
      runtimes: { get: vi.fn(() => ({ execute: runtimeExecute })) } as unknown as ProviderRuntimeRegistry,
    });

    await service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'bailian/qwen-coder-plus',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(runtimeExecute).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
        keyType: 'codingPlan',
      }),
    }));
  });

  it('keeps an explicitly configured credential base URL ahead of the offering default', async() => {
    const runtimeExecute = vi.fn(async function* () {
      yield { type: 'response.started' as const, id: 'resp_1' };
      yield { type: 'response.completed' as const, finishReason: 'stop' };
    });
    const registry = createDefaultProviderRegistry();
    const credentials = [credential({
      id: 'openai_custom_endpoint',
      provider: 'openai',
      models: ['custom-model'],
      runtimeCredential: { baseUrl: 'https://gateway.example/v1' },
    })];
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
      }),
      credentials: store,
      vault: {
        seal: vi.fn(),
        rewrap: vi.fn(),
        open: vi.fn(async() => ({ apiKey: 'sk-custom' })),
      },
      runtimes: { get: vi.fn(() => ({ execute: runtimeExecute })) } as unknown as ProviderRuntimeRegistry,
    });

    await service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'openai/custom-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(runtimeExecute).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({ baseUrl: 'https://gateway.example/v1' }),
    }));
  });

  it('routes Kimi omitted offeringId by credential auth mode through the real runtime adapter', async() => {
    const captured: string[] = [];
    const registry = createDefaultProviderRegistry();
    const credentials = [
      credential({
        id: 'kimi_api_key',
        provider: 'kimi',
        authMode: 'apiKey',
        models: ['kimi-k2'],
        encryptedSecret: encrypted('kimi_api_key', 'kimi'),
      }),
      credential({
        id: 'kimi_oauth',
        provider: 'kimi',
        authMode: 'deviceCodeOAuth',
        models: ['kimi-k2'],
        priority: 200,
        encryptedSecret: encrypted('kimi_oauth', 'kimi'),
      }),
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
      }),
      credentials: store,
      vault: {
        seal: vi.fn(),
        rewrap: vi.fn(),
        open: vi.fn(async(_principal, credentialIri) => credentialIri.includes('oauth')
          ? { accessToken: 'oauth-token' }
          : { apiKey: 'sk-kimi-api-key' }),
      },
      runtimes: new ProviderRuntimeRegistry({
        registry,
        transport: new ProviderHttpTransport({
          fetch: (async(url: string | URL | Request) => {
            captured.push(String(url));
            return new Response(kimiSse(), { status: 200 });
          }) as typeof fetch,
        }),
      }),
    });

    await service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'kimi/kimi-k2',
        messages: [{ role: 'user', content: 'hi' }],
        xpod_credential_id: 'kimi_api_key',
      },
    });
    await service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'kimi/kimi-k2',
        messages: [{ role: 'user', content: 'hi' }],
        xpod_credential_id: 'kimi_oauth',
      },
    });

    expect(captured).toEqual([
      'https://api.moonshot.ai/v1/chat/completions',
      'https://api.kimi.com/coding/v1/chat/completions',
    ]);
  });

  it('rejects Kimi API-key credentials with OAuth-only offering metadata before runtime dispatch', async() => {
    const captured: string[] = [];
    const registry = createDefaultProviderRegistry();
    const credentials = [
      credential({
        id: 'kimi_api_key',
        provider: 'kimi',
        authMode: 'apiKey',
        models: ['kimi-k2'],
        metadata: { offeringId: 'official-subscription' },
        encryptedSecret: encrypted('kimi_api_key', 'kimi'),
      }),
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
      }),
      credentials: store,
      vault: {
        seal: vi.fn(),
        rewrap: vi.fn(),
        open: vi.fn(async() => ({ apiKey: 'sk-kimi-api-key' })),
      },
      runtimes: new ProviderRuntimeRegistry({
        registry,
        transport: new ProviderHttpTransport({
          fetch: (async(url: string | URL | Request) => {
            captured.push(String(url));
            return new Response(kimiSse(), { status: 200 });
          }) as typeof fetch,
        }),
      }),
    });

    await expect(service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'kimi/kimi-k2',
        messages: [{ role: 'user', content: 'hi' }],
        xpod_credential_id: 'kimi_api_key',
      },
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 403,
      details: {
        provider: 'kimi',
        credentialId: 'kimi_api_key',
        offeringId: 'official-subscription',
        authMode: 'apiKey',
      },
    });
    expect(captured).toEqual([]);
  });

  it('does not fail over across credentials on provider authentication failures', async() => {
    const attempts: string[] = [];
    const runtimeExecute = vi.fn((input) => {
      attempts.push(input.apiKey);
      throw new GatewayProtocolError('Provider auth failed', {
        code: 'provider_error',
        status: 401,
        details: { classification: 'authentication' },
      });
    });
    const fixture = serviceWith([
      credential({ id: 'primary', provider: 'openai', models: ['gpt-5'], priority: 1 }),
      credential({ id: 'backup', provider: 'openai', models: ['gpt-5'], priority: 2 }),
    ]);
    (fixture.service as unknown as { runtimes: ProviderRuntimeRegistry }).runtimes = {
      get: vi.fn(() => ({ execute: runtimeExecute })),
    } as unknown as ProviderRuntimeRegistry;

    await expect(fixture.service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).rejects.toMatchObject({
      status: 401,
      details: { classification: 'authentication' },
    });
    expect(attempts).toEqual(['sk-primary']);
  });

  it('fails over before client events on typed transient provider failures', async() => {
    const attempts: string[] = [];
    const runtimeExecute = vi.fn(async function* (input) {
      attempts.push(input.apiKey);
      if (attempts.length === 1) {
        throw new GatewayProtocolError('Provider is rate limited', {
          code: 'provider_error',
          status: 429,
          details: { classification: 'rate_limited' },
        });
      }
      yield { type: 'response.started' as const, id: 'resp_1' };
      yield { type: 'text.delta' as const, text: 'ok' };
      yield { type: 'response.completed' as const, finishReason: 'stop' };
    });
    const fixture = serviceWith([
      credential({ id: 'primary', provider: 'openai', models: ['gpt-5'], priority: 1 }),
      credential({ id: 'backup', provider: 'openai', models: ['gpt-5'], priority: 2 }),
    ]);
    (fixture.service as unknown as { runtimes: ProviderRuntimeRegistry }).runtimes = {
      get: vi.fn(() => ({ execute: runtimeExecute })),
    } as unknown as ProviderRuntimeRegistry;

    await expect(fixture.service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).resolves.toMatchObject({
      choices: [
        expect.objectContaining({
          message: expect.objectContaining({ content: 'ok' }),
        }),
      ],
    });
    expect(attempts).toEqual(['sk-primary', 'sk-backup']);
    expect(fixture.store.listCredentials).toHaveBeenNthCalledWith(1, expect.objectContaining({ auth: AUTH }));
    expect(fixture.store.listCredentials).toHaveBeenNthCalledWith(2, expect.objectContaining({ auth: AUTH }));
  });

  it('fails over before client events when a runtime preserves an untyped HTTP 429', async() => {
    const attempts: string[] = [];
    const runtimeExecute = vi.fn(async function* (input) {
      attempts.push(input.apiKey);
      if (attempts.length === 1) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      yield { type: 'response.started' as const, id: 'resp_1' };
      yield { type: 'text.delta' as const, text: 'ok' };
      yield { type: 'response.completed' as const, finishReason: 'stop' };
    });
    const fixture = serviceWith([
      credential({ id: 'primary', provider: 'openai', models: ['gpt-5'], priority: 1 }),
      credential({ id: 'backup', provider: 'openai', models: ['gpt-5'], priority: 2 }),
    ]);
    (fixture.service as unknown as { runtimes: ProviderRuntimeRegistry }).runtimes = {
      get: vi.fn(() => ({ execute: runtimeExecute })),
    } as unknown as ProviderRuntimeRegistry;

    await expect(fixture.service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).resolves.toMatchObject({
      choices: [
        expect.objectContaining({
          message: expect.objectContaining({ content: 'ok' }),
        }),
      ],
    });
    expect(attempts).toEqual(['sk-primary', 'sk-backup']);
    expect(fixture.store.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: 'primary',
      status: 429,
      errorCode: 'provider_error',
    }));
  });
});
