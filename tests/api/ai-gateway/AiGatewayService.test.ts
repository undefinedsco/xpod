import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../../src/api/ai-gateway/AiGatewayService';
import {
  encodePlaintextCredential,
  UnsupportedCredentialStorageModeError,
} from '../../../src/api/ai-gateway/credentials/PlaintextCredentialPayload';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
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

function serviceWith(credentials: StoredGatewayCredential[], now = new Date('2026-07-23T00:00:00.000Z')): {
  service: AiGatewayService;
  store: GatewayCredentialStore;
} {
  const registry = createDefaultProviderRegistry();
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
        now: () => now,
      }),
      credentials: store,
      runtimes,
      now: () => now,
    }),
  };
}

describe('AiGatewayService', () => {
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
