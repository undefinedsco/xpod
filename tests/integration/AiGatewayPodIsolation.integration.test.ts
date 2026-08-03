import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../src/api/ai-gateway/AiGatewayService';
import { createGatewayApiKey } from '../../src/api/ai-gateway/auth/GatewayApiKey';
import { GatewayApiKeyAuthenticator } from '../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { AesGatewayKeyLocatorCodec } from '../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import { PodGatewayAccessKeyRepository } from '../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';
import { PodConnectedCredentialRepository } from '../../src/api/ai-gateway/connect';
import { encodePlaintextCredential } from '../../src/api/ai-gateway/credentials/PlaintextCredentialPayload';
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
    credentialIri: `https://pod.example/${encodeURIComponent(input.webId)}/settings/ai-connection.ttl#${input.id}`,
    provider,
    authMode: 'apiKey',
    enabled: true,
    models: input.models,
    health: 'healthy',
    quota: { status: 'available' },
    storageMode: 'plaintext-v1',
    secretPayload: encodePlaintextCredential({ type: 'apiKey', apiKey: PLAINTEXT_PROVIDER_SECRET }),
  };
}

function createService(options: {
  deployment: 'local' | 'cloud';
  credentials: StoredGatewayCredential[];
  runtimeKeys?: string[];
}): {
  service: AiGatewayService;
  store: GatewayCredentialStore;
  runtime: { seenApiKeys: string[] };
  podArtifact: unknown;
} {
  const registry = createDefaultProviderRegistry();
  const runtime = { seenApiKeys: options.runtimeKeys ?? [] };
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async({ webId }) =>
      options.credentials.filter((item) => item.credentialIri.includes(encodeURIComponent(webId)))),
    recordSuccess: vi.fn(async() => {}),
    recordFailure: vi.fn(async() => {}),
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
    runtime,
    podArtifact: {
      credentials: options.credentials,
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
    const repository = new PodConnectedCredentialRepository({
      dbFactory: backing.dbFactory as any,
      internalPodAccess: internalPodAccess(),
      providerIds: ['openai', 'deepseek'],
    });
    await repository.upsertConnectedCredential({
      id: 'credentials.ttl#cloud-openai',
      credentialIri: `https://pod.example/alice/settings/credentials.ttl#cloud-openai`,
      webId: ALICE_WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      storageMode: 'plaintext-v1',
      secretPayload: encodePlaintextCredential({ type: 'apiKey', apiKey: PLAINTEXT_PROVIDER_SECRET }),
      status: 'active',
    });
    await repository.upsertConnectedCredential({
      id: 'credentials.ttl#cloud-deepseek',
      credentialIri: `https://pod.example/bob/settings/credentials.ttl#cloud-deepseek`,
      webId: BOB_WEB_ID,
      provider: 'deepseek',
      deployment: 'cloud',
      authMode: 'apiKey',
      storageMode: 'plaintext-v1',
      secretPayload: encodePlaintextCredential({ type: 'apiKey', apiKey: PLAINTEXT_PROVIDER_SECRET }),
      status: 'active',
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
    expect(podRows(backing)).toContain(PLAINTEXT_PROVIDER_SECRET);
  });

  it('authenticates A/B Gateway keys through the production Pod key repository without cross-touching metadata', async() => {
    const backing = createPodBackedDbFactory();
    const repository = new PodGatewayAccessKeyRepository({
      dbFactory: backing.dbFactory as any,
      internalPodAccess: internalPodAccess(),
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
    });
    await repository.create({
      ...keyB.record,
      owner: ALICE_WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
      name: 'Codex B',
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:10:00.000Z'),
    });

    await expect(authenticator.authenticate(requestWithGatewayKey(keyA.plaintext))).resolves.toMatchObject({
      success: true,
      context: { webId: ALICE_WEB_ID, gatewayKeyId: keyAId },
    });
    await expect(repository.findById(keyAId)).resolves.toMatchObject({ lastUsedAt: new Date('2026-07-23T00:10:00.000Z') });
    await expect(repository.findById(keyBId)).resolves.not.toMatchObject({ lastUsedAt: expect.any(Date) });
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
    expect(fixture.runtime.seenApiKeys).toEqual([]);
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

  it('does not expose fixture plaintext secrets in gateway responses or logs', async() => {
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
      response,
      logs: [
        'AI Connection request completed',
        'provider=openai credential=alice-openai',
      ],
    });

    expect(fixture.runtime.seenApiKeys).toEqual([PLAINTEXT_PROVIDER_SECRET]);
    expect(JSON.stringify(fixture.podArtifact)).toContain(PLAINTEXT_PROVIDER_SECRET);
    expect(artifact).not.toContain(PLAINTEXT_PROVIDER_SECRET);
    expect(artifact).not.toContain(issued.plaintext);
    expect(artifact).not.toContain(issued.secret);
    expect(artifact).not.toContain('xpod_gw_v1_cloud');
  });
});
