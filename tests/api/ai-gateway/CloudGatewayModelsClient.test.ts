import { describe, expect, it, vi } from 'vitest';

import {
  CloudGatewayModelsClient,
  callerIdentityAuthorization,
  resolveCloudModelsGatewayOrigin,
  unionGatewayModelLists,
} from '../../../src/api/ai-gateway/CloudGatewayModelsClient';
import { AiGatewayService, type GatewayCredentialStore, type StoredGatewayCredential } from '../../../src/api/ai-gateway/AiGatewayService';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import type { GatewayEvent } from '../../../src/api/ai-gateway/types';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import type { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';

const WEB_ID = 'https://id.undefineds.co/gcloud/profile/card#me';
const AUTH: AuthContext = {
  type: 'solid',
  webId: WEB_ID,
  accessToken: 'solid-access-token',
  tokenType: 'Bearer',
  viaApiKey: true,
  scopes: ['models:read', 'inference:write'],
};
const CHAT_BODY = {
  model: 'kimi-k2',
  messages: [{ role: 'user', content: 'hello' }],
};

function localCredential(): StoredGatewayCredential {
  return {
    id: 'local-deepseek',
    credentialIri: 'https://pod.example/settings/credentials.ttl#local-deepseek',
    provider: 'deepseek',
    authMode: 'apiKey',
    enabled: true,
    models: ['deepseek-chat'],
    health: 'healthy',
    quota: { status: 'available' },
    encryptedSecret: {
      algorithm: 'AES-256-GCM',
      aadPurpose: 'test',
      aadVersion: 'v1',
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      webId: WEB_ID,
      credentialIri: 'https://pod.example/settings/credentials.ttl#local-deepseek',
      provider: 'deepseek',
      dekWrapAlgorithm: 'test',
      keyId: 'test',
      wrappedDek: 'wrapped',
    },
  };
}

function serviceWithCloud(
  cloud?: CloudGatewayModelsClient,
  credentials: StoredGatewayCredential[] = [localCredential()],
): AiGatewayService {
  const registry = createDefaultProviderRegistry();
  const store: GatewayCredentialStore = {
    listCredentials: vi.fn(async() => credentials),
  };
  const vaultOpen = vi.fn(async() => ({ apiKey: 'sk-local-never-print' }));
  return new AiGatewayService({
    deployment: 'local',
    registry,
    router: new ModelRouter({
      registry,
      affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
      credentials: store.listCredentials,
    }),
    credentials: store,
    vault: { seal: vi.fn(), rewrap: vi.fn(), open: vaultOpen },
    runtimes: {
      get: vi.fn(() => ({
        execute: vi.fn(async function* () {
          yield { type: 'response.started', id: 'resp_local' };
          yield { type: 'text.delta', text: 'local' };
          yield { type: 'response.completed', finishReason: 'stop' };
        }),
      })),
    } as unknown as ProviderRuntimeRegistry,
    cloudModels: cloud,
  });
}

function cloudClient(fetchImpl: typeof fetch): CloudGatewayModelsClient {
  return new CloudGatewayModelsClient({
    cloudGatewayOrigin: 'https://id.undefineds.co/',
    fetch: fetchImpl,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

describe('CloudGatewayModelsClient', () => {
  it('resolves the Cloud identity origin for local edition and skips same-origin Cloud', () => {
    expect(resolveCloudModelsGatewayOrigin({
      edition: 'local',
      oidcIssuer: 'https://id.undefineds.co/',
      solidBaseUrl: 'http://127.0.0.1:3000/',
      publicUrl: 'https://node-0000.undefineds.co/',
    })).toBe('https://id.undefineds.co');
    expect(resolveCloudModelsGatewayOrigin({
      edition: 'cloud',
      oidcIssuer: 'https://id.undefineds.co/',
      solidBaseUrl: 'https://id.undefineds.co/',
    })).toBeUndefined();
    expect(resolveCloudModelsGatewayOrigin({
      edition: 'local',
      oidcIssuer: 'http://127.0.0.1:3000/',
      solidBaseUrl: 'http://127.0.0.1:3000/',
    })).toBeUndefined();
  });

  it('forwards the caller Solid access token and never a provider key', () => {
    expect(callerIdentityAuthorization(AUTH)).toBe('Bearer solid-access-token');
    expect(callerIdentityAuthorization({
      type: 'solid',
      webId: WEB_ID,
      accessToken: 'dpop-token',
      tokenType: 'DPoP',
      dpopProof: 'proof',
    })).toBeUndefined();
    expect(callerIdentityAuthorization({
      type: 'solid',
      webId: WEB_ID,
    })).toBeUndefined();
  });

  it('unions local user-owned models with Cloud /v1/models by identity', async() => {
    const fetchImpl = vi.fn(async(url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://id.undefineds.co/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer solid-access-token');
      return Response.json({
        object: 'list',
        data: [
          { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
          { id: 'kimi-k2', object: 'model', owned_by: 'kimi' },
        ],
      });
    }) as unknown as typeof fetch;
    const service = serviceWithCloud(new CloudGatewayModelsClient({
      cloudGatewayOrigin: 'https://id.undefineds.co/',
      fetch: fetchImpl,
    }));

    const models = await service.listModels(AUTH);

    expect(models.map((model) => model.id)).toEqual(['deepseek-chat', 'kimi-k2']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps local models when Cloud is unreachable', async() => {
    const fetchImpl = vi.fn(async() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const service = serviceWithCloud(new CloudGatewayModelsClient({
      cloudGatewayOrigin: 'https://id.undefineds.co/',
      fetch: fetchImpl,
    }));

    await expect(service.listModels(AUTH)).resolves.toEqual([
      expect.objectContaining({ id: 'deepseek-chat', owned_by: 'deepseek' }),
    ]);
  });

  it('does not write Cloud models into the local list helper as secrets or duplicates', () => {
    expect(unionGatewayModelLists(
      [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }],
      [
        { id: 'deepseek-chat', object: 'model', owned_by: 'cloud' },
        { id: 'kimi-k2', object: 'model', owned_by: 'kimi' },
      ],
    )).toEqual([
      { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
      { id: 'kimi-k2', object: 'model', owned_by: 'kimi' },
    ]);
  });

  it('forwards Chat with the caller identity when local has no usable credential', async() => {
    const fetchImpl = vi.fn(async(url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://id.undefineds.co/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer solid-access-token');
      expect(JSON.parse(String(init?.body))).toMatchObject({ ...CHAT_BODY, stream: false });
      return jsonResponse({
        id: 'chatcmpl-cloud',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'cloud-ok' }, finish_reason: 'stop' }],
      });
    }) as unknown as typeof fetch;
    const service = serviceWithCloud(cloudClient(fetchImpl), []);

    const result = await service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: CHAT_BODY,
    });

    expect(result).toEqual(expect.objectContaining({
      choices: [expect.objectContaining({
        message: expect.objectContaining({ content: 'cloud-ok' }),
      })],
    }));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('forwards streaming Chat to Cloud SSE without opening a local vault secret', async() => {
    const fetchImpl = vi.fn(async(url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://id.undefineds.co/v1/chat/completions');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'kimi-k2', stream: true });
      return new Response(
        'data: {"id":"chatcmpl-cloud","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;
    const service = serviceWithCloud(cloudClient(fetchImpl), []);

    const execution = await service.execute({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: { ...CHAT_BODY, stream: true },
    });

    expect(execution.route.credential.id).toBe('cloud-identity');
    const events: GatewayEvent[] = [];
    for await (const event of execution.events) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'response.started', id: 'chatcmpl-cloud' },
      { type: 'text.delta', text: 'hi' },
      { type: 'response.completed', finishReason: 'stop' },
    ]);
  });

  it('does not forward Chat when Cloud splice is not configured', async() => {
    const service = serviceWithCloud(undefined, []);

    await expect(service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: CHAT_BODY,
    })).rejects.toMatchObject({ code: 'credential_unavailable', status: 403 });
  });

  it('does not forward DPoP identities to Cloud Chat', async() => {
    const fetchImpl = vi.fn(async() => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const service = serviceWithCloud(cloudClient(fetchImpl), []);

    await expect(service.complete({
      auth: {
        type: 'solid',
        webId: WEB_ID,
        accessToken: 'dpop-token',
        tokenType: 'DPoP',
        dpopProof: 'proof',
        scopes: ['inference:write'],
      },
      protocol: 'chatCompletions',
      body: CHAT_BODY,
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces unreachable Cloud Chat as provider_error 502', async() => {
    const fetchImpl = vi.fn(async() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const service = serviceWithCloud(cloudClient(fetchImpl), []);

    await expect(service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: CHAT_BODY,
    })).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  });

  it('keeps a usable local credential and never calls Cloud Chat', async() => {
    const fetchImpl = vi.fn(async() => {
      throw new Error('Cloud should not be called');
    }) as unknown as typeof fetch;
    const service = serviceWithCloud(cloudClient(fetchImpl));

    const result = await service.complete({
      auth: AUTH,
      protocol: 'chatCompletions',
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(result).toEqual(expect.objectContaining({
      choices: [expect.objectContaining({
        message: expect.objectContaining({ content: 'local' }),
      })],
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
