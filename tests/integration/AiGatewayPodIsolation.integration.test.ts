import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { aiProviderResource } from '@undefineds.co/models';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../src/api/ai-gateway/AiGatewayService';
import { createGatewayApiKey } from '../../src/api/ai-gateway/auth/GatewayApiKey';
import {
  GatewayApiKeyAuthenticator,
  LEGACY_GATEWAY_KEY_AUTHENTICATION,
} from '../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { AesGatewayKeyLocatorCodec } from '../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import { PodGatewayAccessKeyRepository } from '../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';
import { PodConnectedCredentialRepository } from '../../src/api/ai-gateway/connect';
import type { CredentialVault } from '../../src/api/ai-gateway/credentials/CredentialVault';
import type { EncryptedCredentialSecret } from '../../src/api/ai-gateway/credentials/KeyWrapper';
import { createDefaultProviderRegistry } from '../../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from '../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../src/api/ai-gateway/routing/ModelRouter';
import type { AuthContext } from '../../src/api/auth/AuthContext';
import { InMemoryGatewayAccessKeyRepository } from '../api/ai-gateway/InMemoryGatewayAccessKeyRepository';

const ALICE_WEB_ID = 'https://id.example/alice/profile/card#me';
const BOB_WEB_ID = 'https://id.example/bob/profile/card#me';
const PLAINTEXT_PROVIDER_SECRET = 'sk-task14-provider-secret-must-not-leak';
type PodRow = Record<string, any>;

function auth(webId: string): AuthContext {
  return {
    type: 'solid',
    webId,
    accountId: webId,
    scopes: ['models:read', 'inference:write'],
    viaGatewayApiKey: true,
    internalInvocation: true,
    gatewayKeyId: `internal-${encodeURIComponent(webId)}`,
    tokenType: 'Bearer',
  };
}

function callerOwnedAuth(webId: string): AuthContext {
  return {
    type: 'solid',
    webId,
    accountId: webId,
    scopes: ['models:read', 'inference:write'],
    viaApiKey: true,
    accessToken: `caller-owned-token-for-${encodeURIComponent(webId)}`,
    tokenType: 'Bearer',
  };
}

const INTERNAL_GATEWAY_KEY_CONTEXT = {
  internalPodAccess: { reason: LEGACY_GATEWAY_KEY_AUTHENTICATION },
} as const;

function legacyGatewayKeyContext() {
  return INTERNAL_GATEWAY_KEY_CONTEXT;
}

function encryptedSecret(webId: string, provider: string, id: string): EncryptedCredentialSecret {
  return {
    algorithm: 'AES-256-GCM',
    aadPurpose: 'xpod-ai-connections-test',
    aadVersion: 'v1',
    ciphertext: `ciphertext-for-${id}`,
    nonce: `nonce-for-${id}`,
    webId,
    credentialIri: `https://pod.example/${encodeURIComponent(webId)}/settings/ai-connections.ttl#${id}`,
    provider,
    dekWrapAlgorithm: 'xpod-secret-cell-root-hkdf-aes-256-gcm',
    keyId: 'test-root-v1',
    wrappedDek: `wrapped-dek-for-${id}`,
  };
}

function credential(input: {
  id: string;
  webId: string;
  provider?: string;
  models: string[];
}): StoredGatewayCredential {
  const provider = input.provider ?? 'openai';
  return {
    id: input.id,
    credentialIri: `https://pod.example/${encodeURIComponent(input.webId)}/settings/ai-connections.ttl#${input.id}`,
    provider,
    authMode: 'apiKey',
    enabled: true,
    models: input.models,
    health: 'healthy',
    quota: { status: 'available' },
    encryptedSecret: encryptedSecret(input.webId, provider, input.id),
  };
}

function createService(options: {
  deployment: 'local' | 'cloud';
  credentials: StoredGatewayCredential[];
  runtimeKeys?: string[];
}): {
  service: AiGatewayService;
  store: GatewayCredentialStore;
  vault: CredentialVault;
  runtime: { seenApiKeys: string[] };
  podArtifact: unknown;
} {
  const registry = createDefaultProviderRegistry();
  const runtime = { seenApiKeys: options.runtimeKeys ?? [] };
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async({ webId }) => options.credentials.filter((item) => item.encryptedSecret?.webId === webId)),
    recordSuccess: vi.fn(async() => {}),
    recordFailure: vi.fn(async() => {}),
  };
  const vault: CredentialVault = {
    seal: vi.fn(),
    rewrap: vi.fn(),
    open: vi.fn(async(principal, credentialIri, provider, encrypted) => {
      if (encrypted.webId !== principal.webId || !credentialIri.includes(encodeURIComponent(principal.webId))) {
        throw Object.assign(new Error('credential does not belong to the current WebID'), { status: 403 });
      }
      return {
        apiKey: PLAINTEXT_PROVIDER_SECRET,
        provider,
      };
    }),
  };
  const runtimes = {
    get: vi.fn(() => ({
      execute: vi.fn(async function* ({ apiKey }: { apiKey: string }) {
        runtime.seenApiKeys.push(apiKey);
        yield { type: 'response.started', id: 'resp_isolated' };
        yield { type: 'text.delta', text: 'isolated' };
        yield { type: 'response.completed', finishReason: 'stop' };
      }),
    })),
  } as unknown as ProviderRuntimeRegistry;

  return {
    store,
    vault,
    runtime,
    podArtifact: {
      credentials: options.credentials.map((item) => item.encryptedSecret),
    },
    service: new AiGatewayService({
      deployment: options.deployment,
      registry,
      router: new ModelRouter({
        registry,
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: store.listCredentials,
      }),
      credentials: store,
      vault,
      runtimes,
    }),
  };
}

function requestWithGatewayKey(plaintext: string): any {
  const req = new PassThrough() as any;
  req.headers = { authorization: `Bearer ${plaintext}` };
  return req;
}

function createPodBackedDbFactory() {
  const pods = new Map<string, Map<string, PodRow>>();
  const calls: Array<{ owner: string; op: string; id?: string; patch?: unknown }> = [];

  function pod(owner: string): Map<string, PodRow> {
    let store = pods.get(owner);
    if (!store) {
      store = new Map();
      pods.set(owner, store);
    }
    return store;
  }

  return {
    pods,
    calls,
    dbFactory: vi.fn(async({ owner }: { owner: string }) => {
      const store = pod(owner);
      return {
        async init() {
          calls.push({ owner, op: 'init' });
        },
        insert() {
          calls.push({ owner, op: 'insert' });
          return {
            values(value: PodRow) {
              return {
                async execute() {
                  store.set(String(value.id), structuredClone(value));
                  return [structuredClone(value)];
                },
              };
            },
          };
        },
        select() {
          return {
            from() {
              return {
                where() {
                  return {
                    async execute() {
                      return [...store.values()].filter((row) => row.owner === owner).map((row) => structuredClone(row));
                    },
                  };
                },
              };
            },
          };
        },
        async findById(_resource: unknown, id: string) {
          calls.push({ owner, op: 'findById', id });
          return structuredClone(store.get(id) ?? null);
        },
        async findByIri(_resource: unknown, id: string) {
          calls.push({ owner, op: 'findByIri', id });
          return structuredClone(store.get(id) ?? null);
        },
        async updateById(_resource: unknown, id: string, patch: PodRow) {
          calls.push({ owner, op: 'updateById', id, patch });
          const row = store.get(id);
          if (!row) {
            return null;
          }
          Object.assign(row, patch);
          return structuredClone(row);
        },
        update() {
          return {
            set(patch: PodRow) {
              return {
                where() {
                  return {
                    returning() {
                      return {
                        async execute() {
                          const first = [...store.values()][0];
                          if (!first) {
                            return [];
                          }
                          Object.assign(first, patch);
                          return [structuredClone(first)];
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    }),
  };
}

function internalPodAccess() {
  return { getTrustedFetch: vi.fn(async() => fetch) };
}

function podRows(backing: ReturnType<typeof createPodBackedDbFactory>): string {
  return JSON.stringify([...backing.pods.values()].map((pod) => [...pod.values()]));
}

describe('AI Connection Pod isolation integration', () => {
  it('serves each WebID through the production Pod credential repository adapter', async() => {
    const backing = createPodBackedDbFactory();
    const internal = internalPodAccess();
    const repository = new PodConnectedCredentialRepository({
      dbFactory: backing.dbFactory as any,
      internalPodAccess: internal,
      providerIds: ['openai', 'deepseek'],
    });
    await repository.upsertConnectedCredential({
      id: 'credentials.ttl#cloud-openai',
      credentialIri: `https://pod.example/alice/settings/credentials.ttl#cloud-openai`,
      webId: ALICE_WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: encryptedSecret(ALICE_WEB_ID, 'openai', 'alice-openai'),
      status: 'active',
    }, { auth: callerOwnedAuth(ALICE_WEB_ID) });
    backing.pods.get(ALICE_WEB_ID)?.set(aiProviderResource.buildId({ id: 'openai' }), {
      id: aiProviderResource.buildId({ id: 'openai' }),
      owner: ALICE_WEB_ID,
      hasModel: ['openai.ttl#gpt-5'],
    });
    await repository.upsertConnectedCredential({
      id: 'credentials.ttl#cloud-deepseek',
      credentialIri: `https://pod.example/bob/settings/credentials.ttl#cloud-deepseek`,
      webId: BOB_WEB_ID,
      provider: 'deepseek',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: encryptedSecret(BOB_WEB_ID, 'deepseek', 'bob-deepseek'),
      status: 'active',
    }, { auth: callerOwnedAuth(BOB_WEB_ID) });
    expect(internal.getTrustedFetch).not.toHaveBeenCalled();
    backing.pods.get(BOB_WEB_ID)?.set(aiProviderResource.buildId({ id: 'deepseek' }), {
      id: aiProviderResource.buildId({ id: 'deepseek' }),
      owner: BOB_WEB_ID,
      hasModel: ['deepseek.ttl#deepseek-chat'],
    });
    const fixture = createService({
      deployment: 'cloud',
      credentials: [],
    });
    const service = new AiGatewayService({
      deployment: 'cloud',
      registry: createDefaultProviderRegistry(),
      router: new ModelRouter({
        registry: createDefaultProviderRegistry(),
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: repository.listCredentials.bind(repository),
      }),
      credentials: repository as unknown as GatewayCredentialStore,
      vault: fixture.vault,
      runtimes: (fixture.service as any).runtimes,
    });

    await expect(service.listModels(auth(ALICE_WEB_ID))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ owned_by: 'openai' })]),
    );
    await expect(service.listModels(auth(BOB_WEB_ID))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ owned_by: 'deepseek' })]),
    );
    await expect(service.complete({
      auth: auth(ALICE_WEB_ID),
      protocol: 'responses',
      body: { model: 'deepseek-chat', input: 'hi' },
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(podRows(backing)).not.toContain(PLAINTEXT_PROVIDER_SECRET);
  });

  it('authenticates A/B Gateway keys through the production Pod key repository without cross-touching metadata', async() => {
    const backing = createPodBackedDbFactory();
    const internal = internalPodAccess();
    const repository = new PodGatewayAccessKeyRepository({
      dbFactory: backing.dbFactory as any,
      internalPodAccess: internal,
      locatorCodec: new AesGatewayKeyLocatorCodec('task14-locator-secret'),
    });
    const keyAId = repository.createKeyId(ALICE_WEB_ID, 'cloud');
    const keyBId = repository.createKeyId(ALICE_WEB_ID, 'cloud');
    const keyA = await createGatewayApiKey({ deployment: 'cloud', keyId: keyAId });
    const keyB = await createGatewayApiKey({ deployment: 'cloud', keyId: keyBId });
    await repository.create({
      ...keyA.record,
      owner: ALICE_WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
      name: 'Codex A',
    }, legacyGatewayKeyContext());
    await repository.create({
      ...keyB.record,
      owner: ALICE_WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
      name: 'Codex B',
    }, legacyGatewayKeyContext());
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:10:00.000Z'),
    });

    await expect(authenticator.authenticate(requestWithGatewayKey(keyA.plaintext))).resolves.toMatchObject({
      success: true,
      context: { webId: ALICE_WEB_ID, gatewayKeyId: keyAId },
    });
    await expect(repository.findById(keyAId, legacyGatewayKeyContext())).resolves.toMatchObject({ lastUsedAt: new Date('2026-07-23T00:10:00.000Z') });
    await expect(repository.findById(keyBId, legacyGatewayKeyContext())).resolves.not.toMatchObject({ lastUsedAt: expect.any(Date) });
    await expect(authenticator.authenticate(requestWithGatewayKey(keyB.plaintext))).resolves.toMatchObject({
      success: true,
      context: { webId: ALICE_WEB_ID, gatewayKeyId: keyBId },
    });
    expect(podRows(backing)).not.toContain(keyA.plaintext);
    expect(podRows(backing)).not.toContain(keyB.plaintext);
    expect(podRows(backing)).not.toContain(keyA.secret);
    expect(podRows(backing)).not.toContain(keyB.secret);
  });

  it('routes only credentials stored under the current WebID Pod', async() => {
    const fixture = createService({
      deployment: 'cloud',
      credentials: [
        credential({ id: 'alice-openai', webId: ALICE_WEB_ID, models: ['gpt-5'] }),
        credential({ id: 'bob-deepseek', webId: BOB_WEB_ID, provider: 'deepseek', models: ['deepseek-chat'] }),
      ],
    });

    await expect(fixture.service.listModels(auth(ALICE_WEB_ID))).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
    ]);
    await expect(fixture.service.listModels(auth(BOB_WEB_ID))).resolves.toEqual([
      expect.objectContaining({ id: 'deepseek-chat', owned_by: 'deepseek' }),
    ]);

    await expect(fixture.service.complete({
      auth: auth(ALICE_WEB_ID),
      protocol: 'chatCompletions',
      body: {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(fixture.vault.open).not.toHaveBeenCalledWith(
      expect.objectContaining({ webId: ALICE_WEB_ID }),
      expect.stringContaining(encodeURIComponent(BOB_WEB_ID)),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects keys minted for a different deployment before Pod credentials are reachable', async() => {
    const localKey = await createGatewayApiKey({ deployment: 'local', keyId: 'gak_local_only' });
    const repository = new InMemoryGatewayAccessKeyRepository();
    await repository.create({
      ...localKey.record,
      owner: ALICE_WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:01:00.000Z'),
    });

    await expect(authenticator.authenticate(requestWithGatewayKey(localKey.plaintext))).resolves.toMatchObject({
      success: false,
      error: 'Invalid gateway API key',
      statusCode: 401,
    });
    await expect(repository.findById('gak_local_only')).resolves.not.toMatchObject({
      lastUsedAt: expect.any(Date),
    });
  });

  it('rejects revoked keys uniformly without updating last-used metadata', async() => {
    const revoked = await createGatewayApiKey({ deployment: 'cloud', keyId: 'gak_revoked_task14' });
    const repository = new InMemoryGatewayAccessKeyRepository();
    await repository.create({
      ...revoked.record,
      owner: ALICE_WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
      revokedAt: new Date('2026-07-23T00:05:00.000Z'),
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:10:00.000Z'),
    });

    await expect(authenticator.authenticate(requestWithGatewayKey(revoked.plaintext))).resolves.toMatchObject({
      success: false,
      error: 'Invalid gateway API key',
      statusCode: 401,
    });
    await expect(repository.findById('gak_revoked_task14')).resolves.not.toMatchObject({
      lastUsedAt: expect.any(Date),
    });
  });

  it('does not persist fixture plaintext secrets in Pod-shaped records or response artifacts', async() => {
    const issued = await createGatewayApiKey({ deployment: 'cloud', keyId: 'gak_no_plaintext' });
    const repository = new InMemoryGatewayAccessKeyRepository();
    await repository.create({
      ...issued.record,
      owner: ALICE_WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    });
    const fixture = createService({
      deployment: 'cloud',
      credentials: [credential({ id: 'alice-openai', webId: ALICE_WEB_ID, models: ['gpt-5'] })],
    });

    const response = await fixture.service.complete({
      auth: auth(ALICE_WEB_ID),
      protocol: 'responses',
      body: { model: 'gpt-5', input: 'hi' },
    });
    const artifact = JSON.stringify({
      gatewayKeyRecord: await repository.findById('gak_no_plaintext'),
      pod: fixture.podArtifact,
      response,
      logs: [
        'AI Connection request completed',
        'provider=openai credential=alice-openai',
      ],
    });

    expect(fixture.runtime.seenApiKeys).toEqual([PLAINTEXT_PROVIDER_SECRET]);
    expect(artifact).not.toContain(PLAINTEXT_PROVIDER_SECRET);
    expect(artifact).not.toContain(issued.plaintext);
    expect(artifact).not.toContain(issued.secret);
    expect(artifact).not.toContain('xpod_gw_v1_cloud');
  });
});
