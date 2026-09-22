import { describe, expect, it, vi } from 'vitest';
import { aiModelResource, aiProviderResource } from '@undefineds.co/models';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../src/api/ai-gateway/AiGatewayService';
import { PodConnectedCredentialRepository } from '../../src/api/ai-gateway/connect';
import type { CredentialVault } from '../../src/api/ai-gateway/credentials/CredentialVault';
import type { EncryptedCredentialSecret } from '../../src/api/ai-gateway/credentials/KeyWrapper';
import { createDefaultProviderRegistry } from '../../src/api/ai-gateway/providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from '../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import { InMemorySessionAffinityStore } from '../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../src/api/ai-gateway/routing/ModelRouter';
import type { AuthContext } from '../../src/api/auth/AuthContext';

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

function createPodBackedDbFactory() {
  const pods = new Map<string, Map<string, PodRow>>();
  const calls: Array<{ owner: string; op: string; id?: string; patch?: unknown }> = [];
  /** The Pod fetch every owner's db was opened with, so cross-owner reuse stays observable. */
  const podFetches: Array<{ owner: string; fetch?: typeof fetch }> = [];

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
    podFetches,
    dbFactory: vi.fn(async({ owner, fetch: podFetch }: { owner: string; fetch?: typeof fetch }) => {
      podFetches.push({ owner, fetch: podFetch });
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
            from(resource: { config?: { type?: string } }) {
              const resourceType = resource.config?.type;
              return {
                where() {
                  return {
                    async execute() {
                      return [...store.values()]
                        .filter((row) => row.owner === owner)
                        .filter((row) => {
                          if (resourceType === 'https://undefineds.co/ns#Credential') {
                            return row.encryptedSecret !== undefined;
                          }
                          if (resourceType === 'https://undefineds.co/ns#Provider') {
                            return row.hasModel !== undefined;
                          }
                          if (resourceType === 'https://undefineds.co/ns#AIModel') {
                            return row.encryptedSecret === undefined && row.hasModel === undefined;
                          }
                          return false;
                        })
                        .map((row) => structuredClone(row));
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

/**
 * A Pod fetch provider keyed strictly per owner, mirroring `OwnerPodAccess`.
 *
 * Server-side Pod access now goes through the owner's own interface key, so the property worth
 * proving is the same one the deleted internal provider had to uphold: the fetch for one owner's
 * Pod is never handed to work for another owner.
 */
function podAccess() {
  const fetches = new Map<string, typeof fetch>();
  const getPodFetch = vi.fn(async(owner: string, context?: { auth?: AuthContext }) => {
    if (context?.auth?.type === 'solid' && context.auth.webId !== owner) {
      // A caller authenticated as somebody else never borrows this owner's Pod fetch.
      return undefined;
    }
    return fetches.get(owner);
  });
  return { fetches, getPodFetch };
}

function podRows(backing: ReturnType<typeof createPodBackedDbFactory>): string {
  return JSON.stringify([...backing.pods.values()].map((pod) => [...pod.values()]));
}

describe('AI Connection Pod isolation integration', () => {
  it('serves each WebID through the production Pod credential repository adapter', async() => {
    const backing = createPodBackedDbFactory();
    const pod = podAccess();
    const alicePodFetch = vi.fn(async() => new Response('alice-pod'));
    const bobPodFetch = vi.fn(async() => new Response('bob-pod'));
    pod.fetches.set(ALICE_WEB_ID, alicePodFetch as unknown as typeof fetch);
    pod.fetches.set(BOB_WEB_ID, bobPodFetch as unknown as typeof fetch);
    const repository = new PodConnectedCredentialRepository({
      dbFactory: backing.dbFactory as any,
      podAccess: pod,
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
    backing.pods.get(ALICE_WEB_ID)?.set(aiModelResource.buildId({ id: 'openai.ttl#gpt-5' }), {
      id: aiModelResource.buildId({ id: 'openai.ttl#gpt-5' }),
      owner: ALICE_WEB_ID,
      status: 'active',
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
    // The provider is keyed per owner: it is only ever asked for the owner whose Pod the
    // repository is addressing, together with that owner's own caller context.
    expect(pod.getPodFetch).toHaveBeenCalledWith(ALICE_WEB_ID, expect.objectContaining({
      auth: expect.objectContaining({ webId: ALICE_WEB_ID }),
    }));
    expect(pod.getPodFetch).toHaveBeenCalledWith(BOB_WEB_ID, expect.objectContaining({
      auth: expect.objectContaining({ webId: BOB_WEB_ID }),
    }));
    for (const [owner, context] of pod.getPodFetch.mock.calls) {
      expect(context?.auth?.webId).toBe(owner);
    }
    backing.pods.get(BOB_WEB_ID)?.set(aiProviderResource.buildId({ id: 'deepseek' }), {
      id: aiProviderResource.buildId({ id: 'deepseek' }),
      owner: BOB_WEB_ID,
      hasModel: ['deepseek.ttl#deepseek-chat'],
    });
    backing.pods.get(BOB_WEB_ID)?.set(aiModelResource.buildId({ id: 'deepseek.ttl#deepseek-chat' }), {
      id: aiModelResource.buildId({ id: 'deepseek.ttl#deepseek-chat' }),
      owner: BOB_WEB_ID,
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
    // Every Pod db opened during those reads was opened with that same owner's fetch, so no
    // request for Alice ever travelled over Bob's credential (and the reverse). The repository
    // wraps the fetch it is given, so each owner's key is identified by its own response.
    expect(new Set(backing.podFetches.map((entry) => entry.owner)))
      .toEqual(new Set([ ALICE_WEB_ID, BOB_WEB_ID ]));
    for (const entry of backing.podFetches) {
      const expectedBody = entry.owner === ALICE_WEB_ID ? 'alice-pod' : 'bob-pod';
      const response = await entry.fetch!('https://pod.example/settings/credentials.ttl');
      await expect(response.text()).resolves.toBe(expectedBody);
    }
    expect(alicePodFetch).toHaveBeenCalledTimes(
      backing.podFetches.filter((entry) => entry.owner === ALICE_WEB_ID).length,
    );
    expect(bobPodFetch).toHaveBeenCalledTimes(
      backing.podFetches.filter((entry) => entry.owner === BOB_WEB_ID).length,
    );
    expect(podRows(backing)).not.toContain(PLAINTEXT_PROVIDER_SECRET);
  });

  it('refuses to open another owner Pod for a caller authenticated as somebody else', async() => {
    const backing = createPodBackedDbFactory();
    const pod = podAccess();
    pod.fetches.set(BOB_WEB_ID, vi.fn(async() => new Response('bob-pod')) as unknown as typeof fetch);
    const repository = new PodConnectedCredentialRepository({
      dbFactory: backing.dbFactory as any,
      podAccess: pod,
      providerIds: ['openai', 'deepseek'],
    });

    await expect(repository.listCredentials({
      webId: BOB_WEB_ID,
      deployment: 'cloud',
      auth: callerOwnedAuth(ALICE_WEB_ID),
    })).rejects.toThrow('caller_owner_mismatch');

    expect(pod.getPodFetch).toHaveBeenCalledWith(BOB_WEB_ID, expect.objectContaining({
      auth: expect.objectContaining({ webId: ALICE_WEB_ID }),
    }));
    // Bob's Pod fetch was never borrowed, so his Pod db was never even opened.
    expect(backing.podFetches).toHaveLength(0);
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

});
