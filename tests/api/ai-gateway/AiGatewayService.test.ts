import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../../src/api/ai-gateway/AiGatewayService';
import type { CredentialVault, StoredCredentialSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import { PlaintextCredentialVault } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialVault';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const AUTH: AuthContext = {
  type: 'solid',
  webId: WEB_ID,
  viaGatewayApiKey: true,
  scopes: ['models:read', 'inference:write'],
};
const ACCEPTANCE_AUTH: AuthContext = {
  ...AUTH,
  scopes: ['acceptance:read'],
  gatewayKeyId: 'gak_acceptance',
  gatewayKeyFingerprint: 'sha256:gateway',
};

function storedSecret(id: string, provider = 'openai'): StoredCredentialSecret {
  return {
    webId: WEB_ID,
    credentialIri: `https://pod.example/settings/credentials.ttl#${id}`,
    provider,
    secret: { type: 'apiKey', apiKey: `sk-${id}` },
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
    models: input.models ?? [],
    defaultModel: input.defaultModel,
    health: input.health ?? 'healthy',
    quota: input.quota ?? { status: 'available' },
    cooldownUntil: input.cooldownUntil,
    customModels: input.customModels,
    metadata: input.metadata,
    credentialSecret: input.credentialSecret ?? storedSecret(input.id, input.provider),
    version: input.version,
    runtimeCredential: input.runtimeCredential,
  };
}

function serviceWith(
  credentials: StoredGatewayCredential[],
  now = new Date('2026-07-23T00:00:00.000Z'),
  vaultOverride?: CredentialVault,
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
    open: vi.fn(async(_principal, credentialIri) => ({
      apiKey: credentialIri.includes('backup') ? 'sk-backup' : 'sk-primary',
    })),
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
      vault: vaultOverride ?? vault,
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
      vault: { seal: vi.fn(), open: vi.fn() },
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

  it('verifies the stored credential before producing non-secret acceptance provenance', async () => {
    const first = serviceWith([
      credential({ id: 'limited_openai', provider: 'openai', models: ['gpt-5'], version: 7 }),
    ]);
    vi.mocked(first.vault.open).mockResolvedValueOnce({ apiKey: 'sk-first', accessToken: 'tok-first' });

    const provenance = await first.service.acceptanceProvenance({
      auth: ACCEPTANCE_AUTH,
      model: 'gpt-5',
      xpodBaseUrl: 'http://localhost',
    });

    expect(first.vault.open).toHaveBeenCalledWith(
      { webId: WEB_ID },
      'https://pod.example/settings/credentials.ttl#limited_openai',
      'openai',
      expect.objectContaining({ credentialIri: 'https://pod.example/settings/credentials.ttl#limited_openai' }),
    );
    expect(provenance.credentialRecordHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(provenance.credentialRecordHash).not.toBe(provenance.credentialIriHash);
    expect(JSON.stringify(provenance)).not.toContain('sk-first');
    expect(JSON.stringify(provenance)).not.toContain('tok-first');

    const second = serviceWith([
      credential({ id: 'limited_openai', provider: 'openai', models: ['gpt-5'], version: 7 }),
    ]);
    vi.mocked(second.vault.open).mockResolvedValueOnce({ accessToken: 'tok-second', apiKey: 'sk-second' });
    await expect(second.service.acceptanceProvenance({
      auth: ACCEPTANCE_AUTH,
      model: 'gpt-5',
      xpodBaseUrl: 'http://localhost',
    })).resolves.toMatchObject({
      credentialRecordHash: provenance.credentialRecordHash,
    });
  });

  it('fails acceptance provenance when the stored credential record cannot be opened', async () => {
    const { service } = serviceWith([
      credential({
        id: 'limited_openai',
        provider: 'openai',
        models: ['gpt-5'],
        credentialSecret: {
          ...storedSecret('limited_openai', 'openai'),
          provider: 'deepseek',
        },
      }),
    ], new Date('2026-07-23T00:00:00.000Z'), new PlaintextCredentialVault());

    await expect(service.acceptanceProvenance({
      auth: ACCEPTANCE_AUTH,
      model: 'gpt-5',
      xpodBaseUrl: 'http://localhost',
    })).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 404,
    });
  });

});
