import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../src/api/ai-gateway/AiGatewayService';
import { createGatewayApiKey } from '../../src/api/ai-gateway/auth/GatewayApiKey';
import { GatewayApiKeyAuthenticator } from '../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
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

function auth(webId: string): AuthContext {
  return {
    type: 'solid',
    webId,
    accountId: webId,
    scopes: ['models:read', 'inference:write'],
    viaGatewayApiKey: true,
  };
}

function encryptedSecret(webId: string, provider: string, id: string): EncryptedCredentialSecret {
  return {
    algorithm: 'AES-256-GCM',
    aadPurpose: 'xpod-ai-connection-test',
    aadVersion: 'v1',
    ciphertext: `ciphertext-for-${id}`,
    nonce: `nonce-for-${id}`,
    webId,
    credentialIri: `https://pod.example/${encodeURIComponent(webId)}/settings/ai-connection.ttl#${id}`,
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
    credentialIri: `https://pod.example/${encodeURIComponent(input.webId)}/settings/ai-connection.ttl#${input.id}`,
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
    listCredentials: vi.fn(async({ webId }) => options.credentials.filter((item) => item.encryptedSecret.webId === webId)),
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

describe('AI Connection Pod isolation integration', () => {
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
