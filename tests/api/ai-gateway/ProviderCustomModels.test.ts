import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import { ProviderCustomModelsService } from '../../../src/api/ai-gateway/models';
import { createEmbeddingModelPolicy } from '../../../src/ai/service/EmbeddingModelPolicy';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { createGatewayEmbeddingModelCatalog } from '../../../src/api/ai-gateway/models/GatewayEmbeddingModelCatalog';
import {
  customModelsFromMetadata,
  type ConnectCredentialRecord,
  type PodCredentialRepository,
} from '../../../src/api/ai-gateway/connect';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const CREDENTIAL_IRI = 'https://id.example/alice/.data/settings/credentials.ttl#cloud-openai';

function credential(overrides: Partial<ConnectCredentialRecord> = {}): ConnectCredentialRecord {
  return {
    id: 'openai-credential',
    credentialIri: CREDENTIAL_IRI,
    webId: WEB_ID,
    provider: 'openai',
    deployment: 'cloud',
    authMode: 'apiKey',
    encryptedSecret: { algorithm: 'test', keyId: 'k', keyVersion: 'v1', wrappedDek: 'x', ciphertext: 'y' } as never,
    status: 'active',
    version: 1,
    ...overrides,
  };
}

class InMemoryCredentialRepository implements Partial<PodCredentialRepository> {
  public record: ConnectCredentialRecord | undefined;
  public upserts: ConnectCredentialRecord[] = [];

  public constructor(record?: ConnectCredentialRecord) {
    this.record = record;
  }

  public async getCredential() {
    return this.record;
  }

  public async upsertConnectedCredential(record: ConnectCredentialRecord) {
    if (this.record && record.expectedVersion !== undefined && record.expectedVersion !== this.record.version) {
      throw new Error('credential_version_conflict');
    }
    const next = { ...record, version: (this.record?.version ?? 0) + 1 };
    this.record = next;
    this.upserts.push(next);
    return next;
  }
}

describe('customModelsFromMetadata', () => {
  it('parses only well-formed custom model entries', () => {
    expect(customModelsFromMetadata({
      customModels: [
        { id: 'ft-a', displayName: 'A', inputModalities: ['image', ''], capabilities: ['tool_call', 'image'] },
        { id: '  ' },
        { id: 'ft-b' },
        'garbage',
        { displayName: 'no-id' },
      ],
    })).toEqual([
      { id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call', 'image'] },
      { id: 'ft-b' },
    ]);
    expect(customModelsFromMetadata(undefined)).toEqual([]);
    expect(customModelsFromMetadata({ customModels: 'nope' })).toEqual([]);
  });
});

describe('ProviderCustomModelsService', () => {
  it('adds and updates custom models in credential metadata with a version bump', async () => {
    const repository = new InMemoryCredentialRepository(credential());
    const service = new ProviderCustomModelsService({ credentialRepository: repository as never });

    const added = await service.upsert({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      model: { id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] },
    });
    expect(added).toEqual([{ id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] }]);
    expect(repository.record?.version).toBe(2);
    expect(customModelsFromMetadata(repository.record?.metadata)).toEqual(added);

    const updated = await service.upsert({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      model: { id: 'ft-a', displayName: 'A2' },
    });
    expect(updated).toEqual([{ id: 'ft-a', displayName: 'A2' }]);
    expect(repository.record?.version).toBe(3);
  });

  it('removes custom models and drops the metadata key when the last one is gone', async () => {
    const repository = new InMemoryCredentialRepository(credential({
      metadata: {
        customModels: [{ id: 'ft-a' }, { id: 'ft-b' }],
        defaultModel: 'gpt-5',
      },
    }));
    const service = new ProviderCustomModelsService({ credentialRepository: repository as never });

    expect(await service.remove({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      modelId: 'ft-a',
    })).toEqual([{ id: 'ft-b' }]);
    expect(repository.record?.metadata?.customModels).toEqual([{ id: 'ft-b' }]);

    expect(await service.remove({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      modelId: 'ft-b',
    })).toEqual([]);
    expect(repository.record?.metadata).toEqual({ defaultModel: 'gpt-5' });
  });

  it('rejects writes without an active credential', async () => {
    const service = new ProviderCustomModelsService({
      credentialRepository: new InMemoryCredentialRepository() as never,
    });

    await expect(service.upsert({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      model: { id: 'ft-a' },
    })).rejects.toThrow('models_credential_not_found');

    const revoked = new InMemoryCredentialRepository(credential({ status: 'revoked' }));
    const revokedService = new ProviderCustomModelsService({ credentialRepository: revoked as never });
    await expect(revokedService.remove({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      modelId: 'ft-a',
    })).rejects.toThrow('models_credential_not_found');
  });
});

describe('ProviderCustomModelsService embedding policy', () => {
  const registry = createDefaultProviderRegistry();
  const cloud = () => createEmbeddingModelPolicy({
    deployment: 'cloud',
    catalog: createGatewayEmbeddingModelCatalog(registry, 'cloud'),
  });
  const local = () => createEmbeddingModelPolicy({
    deployment: 'local',
    catalog: createGatewayEmbeddingModelCatalog(registry, 'local'),
  });

  it('rejects a cloud custom model that declares an embedding model the catalog does not provide', async () => {
    const repository = new InMemoryCredentialRepository(credential());
    const service = new ProviderCustomModelsService({
      credentialRepository: repository as never,
      embeddingModelPolicy: cloud(),
    });

    for (const [provider, id] of [['openai', 'acme-embed-v9'], ['openai', 'text-embedding-v4']]) {
      await expect(service.upsert({
        webId: WEB_ID,
        deployment: 'cloud',
        provider,
        model: { id, capabilities: ['embedding'] },
      })).rejects.toMatchObject({ code: 'embedding_model_not_allowed' });
    }
    // A self-hosted endpoint is not a provider Cloud offers at all.
    await expect(service.upsert({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'custom',
      model: { id: 'acme-embed-v9', capabilities: ['embedding'] },
    })).rejects.toThrow('provider_not_available_in_deployment');
    expect(repository.upserts).toHaveLength(0);
  });

  it('allows a cloud custom model when the catalog provides that embedding model', async () => {
    const repository = new InMemoryCredentialRepository(credential());
    const service = new ProviderCustomModelsService({
      credentialRepository: repository as never,
      embeddingModelPolicy: cloud(),
    });

    const stored = await service.upsert({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      model: { id: 'text-embedding-3-small', capabilities: ['embedding'] },
    });

    expect(stored).toEqual([{ id: 'text-embedding-3-small', capabilities: ['embedding'] }]);
  });

  it('keeps non-embedding custom models available in cloud', async () => {
    const repository = new InMemoryCredentialRepository(credential());
    const service = new ProviderCustomModelsService({
      credentialRepository: repository as never,
      embeddingModelPolicy: cloud(),
    });

    const stored = await service.upsert({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      model: { id: 'ft-my-model', capabilities: ['tool_call'] },
    });

    expect(stored).toEqual([{ id: 'ft-my-model', capabilities: ['tool_call'] }]);
  });

  it('keeps local BYOK free to declare any embedding model', async () => {
    const repository = new InMemoryCredentialRepository(credential({ deployment: 'local' }));
    const service = new ProviderCustomModelsService({
      credentialRepository: repository as never,
      embeddingModelPolicy: local(),
    });

    const stored = await service.upsert({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'custom',
      model: { id: 'acme-embed-v9', capabilities: ['embedding'] },
    });

    expect(stored).toEqual([{ id: 'acme-embed-v9', capabilities: ['embedding'] }]);
  });
});

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      put: vi.fn((path: string, handler: Function) => { routes[`PUT ${path}`] = handler; }),
      patch: vi.fn((path: string, handler: Function) => { routes[`PATCH ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth'], body?: unknown, url = '/api/ai/gateway/providers/openai/models'): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = body === undefined ? 'DELETE' : 'POST';
  req.url = url;
  req.headers = {};
  req.auth = auth;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(function(this: any, payload?: string) {
      this.body = payload;
    }),
  };
}

describe('AiGatewayManagementHandler custom models routes', () => {
  it('upserts a custom model for the current Solid identity', async () => {
    const repository = new InMemoryCredentialRepository(credential());
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      customModelsService: new ProviderCustomModelsService({ credentialRepository: repository as never }),
    });

    const res = response();
    await routes['POST /api/ai/gateway/providers/:provider/models'](request(
      { type: 'solid', webId: WEB_ID },
      { id: 'ft-a', displayName: 'A', inputModalities: ['image', 'image'], capabilities: ['tool_call'] },
    ), res, { provider: 'openai' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: [{ id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] }],
    });
    expect(customModelsFromMetadata(repository.record?.metadata)).toEqual([
      { id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] },
    ]);
  });

  it('validates the model payload before touching the credential', async () => {
    const repository = new InMemoryCredentialRepository(credential());
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      customModelsService: new ProviderCustomModelsService({ credentialRepository: repository as never }),
    });

    for (const body of [
      { id: '  ' },
      { id: 'has space' },
      { id: 'ft-a', capabilities: ['vision', 1] },
      { displayName: 'no id' },
    ]) {
      const res = response();
      await routes['POST /api/ai/gateway/providers/:provider/models'](
        request({ type: 'solid', webId: WEB_ID }, body),
        res,
        { provider: 'openai' },
      );
      expect(res.statusCode).toBe(400);
    }
    expect(repository.upserts).toHaveLength(0);
  });

  it('maps missing credentials and version conflicts', async () => {
    const missing = new InMemoryCredentialRepository();
    const conflicted = new InMemoryCredentialRepository(credential({ version: 5 }));
    conflicted.upsertConnectedCredential = async () => {
      throw new Error('credential_version_conflict');
    };
    const services = [
      new ProviderCustomModelsService({ credentialRepository: missing as never }),
      new ProviderCustomModelsService({ credentialRepository: conflicted as never }),
    ];

    for (const [index, expected] of [[0, 404], [1, 409]] as const) {
      const { server, routes } = createServer();
      registerAiGatewayManagementRoutes(server, {
        deployment: 'cloud',
        customModelsService: services[index],
      });
      const res = response();
      await routes['POST /api/ai/gateway/providers/:provider/models'](
        request({ type: 'solid', webId: WEB_ID }, { id: 'ft-a' }),
        res,
        { provider: 'openai' },
      );
      expect(res.statusCode).toBe(expected);
    }
  });

  it('deletes a custom model by id', async () => {
    const repository = new InMemoryCredentialRepository(credential({
      metadata: { customModels: [{ id: 'ft-a' }, { id: 'ft-b' }] },
    }));
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      customModelsService: new ProviderCustomModelsService({ credentialRepository: repository as never }),
    });

    const res = response();
    await routes['DELETE /api/ai/gateway/providers/:provider/models/:modelId'](request(
      { type: 'solid', webId: WEB_ID },
      undefined,
      `/api/ai/gateway/providers/openai/models/${encodeURIComponent('ft-a')}`,
    ), res, { provider: 'openai', modelId: 'ft-a' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: [{ id: 'ft-b' }] });
  });

  it('rejects gateway-key principals from custom model routes', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      customModelsService: { upsert: vi.fn(), remove: vi.fn() } as never,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/models'](request({
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
    } as any, { id: 'ft-a' }), res, { provider: 'openai' });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Gateway API keys cannot manage provider Connect state' });
  });
});

describe('AiGatewayManagementHandler custom model embedding rejection', () => {
  it('answers 403 with a stable code when cloud rejects an embedding declaration', async () => {
    const repository = new InMemoryCredentialRepository(credential());
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      deployment: 'cloud',
      customModelsService: new ProviderCustomModelsService({
        credentialRepository: repository as never,
        embeddingModelPolicy: createEmbeddingModelPolicy({
          deployment: 'cloud',
          catalog: createGatewayEmbeddingModelCatalog(createDefaultProviderRegistry(), 'cloud'),
        }),
      }),
    });

    const embedding = response();
    await routes['POST /api/ai/gateway/providers/:provider/models'](
      request({ type: 'solid', webId: WEB_ID }, { id: 'acme-embed-v9', capabilities: ['embedding'] }),
      embedding,
      { provider: 'openai' },
    );
    expect(embedding.statusCode).toBe(403);
    expect(JSON.parse(embedding.body)).toMatchObject({ error: 'embedding_model_not_allowed' });

    const selfHosted = response();
    await routes['POST /api/ai/gateway/providers/:provider/models'](
      request({ type: 'solid', webId: WEB_ID }, { id: 'ft-mine', capabilities: ['tool_call'] }),
      selfHosted,
      { provider: 'custom' },
    );
    expect(selfHosted.statusCode).toBe(403);
    expect(JSON.parse(selfHosted.body)).toMatchObject({ error: 'provider_not_available_in_deployment' });
    expect(repository.upserts).toHaveLength(0);
  });
});
