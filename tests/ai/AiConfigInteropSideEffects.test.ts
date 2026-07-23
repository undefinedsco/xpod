import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../src/api/chatkit/store';
import { Provider } from '../../src/ai/schema/provider';
import { Model } from '../../src/ai/schema/model';
import { Credential } from '../../src/credential/schema/tables';
import { CredentialStatus, ServiceType } from '../../src/credential/schema/types';
import { AgentMetaSchema } from '../../src/agents/config/agent-meta-schema';
import { getFreePort } from '../../src/runtime/port-finder';

function tableConfig(table: any): { resourcePath?: string; containerPath?: string; subjectTemplate?: string } {
  return {
    resourcePath: table.resourcePath,
    containerPath: table.containerPath,
    subjectTemplate: table.subjectTemplate,
  };
}

describe('AI config data interop side effects', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'DEFAULT_API_BASE',
    'DEFAULT_API_KEY',
    'DEFAULT_PROVIDER',
    'DEFAULT_MODEL',
  ] as const;

  beforeAll(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  const podRoot = 'http://pod.example/';
  const providerIri = `${podRoot}settings/providers/openai.ttl`;
  const modelIri = `${providerIri}#gpt-4o-mini`;
  const credentialIri = `${podRoot}settings/credentials.ttl#openai-key`;

  const providerRecord = {
    id: 'openai',
    '@id': providerIri,
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: modelIri,
  };
  const modelRecord = {
    id: 'gpt-4o-mini',
    '@id': modelIri,
    displayName: 'GPT-4o mini',
    isProvidedBy: providerIri,
    contextLength: 128000,
    maxOutputTokens: 16384,
  };
  const credentialRecord = {
    id: 'credentials.ttl#openai-key',
    '@id': credentialIri,
    provider: providerIri,
    service: ServiceType.AI,
    status: CredentialStatus.ACTIVE,
    apiKey: 'sk-from-pod',
    isDefault: true,
    failCount: 0,
  };

  function createMockDb(providerOverride: Partial<typeof providerRecord> = {}) {
    const effectiveProvider = { ...providerRecord, ...providerOverride };
    return {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: any) => {
          if (table === Credential) {
            return {
              where: vi.fn().mockResolvedValue([credentialRecord]),
            };
          }
          if (table === Provider) {
            return Promise.resolve([effectiveProvider]);
          }
          if (table === Model) {
            return Promise.resolve([modelRecord]);
          }
          return Promise.resolve([]);
        }),
      })),
      findByIri: vi.fn().mockImplementation((table: any, iri: string) => {
        if (table === Provider && iri === providerIri) return Promise.resolve(effectiveProvider);
        if (table === Model && iri === modelIri) return Promise.resolve(modelRecord);
        if (table === Credential && iri === credentialIri) return Promise.resolve(credentialRecord);
        return Promise.resolve(undefined);
      }),
      findById: vi.fn().mockImplementation((table: any, id: string) => {
        if (table === Provider && id === 'openai') return Promise.resolve(effectiveProvider);
        if (table === Model && id === 'gpt-4o-mini') return Promise.resolve(modelRecord);
        if (table === Credential && id === 'credentials.ttl#openai-key') return Promise.resolve(credentialRecord);
        return Promise.resolve(undefined);
      }),
      updateById: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('keeps provider/model/credential/secretary runtime config in their expected Pod resources', () => {
    expect(tableConfig(Provider)).toMatchObject({
      resourcePath: '/settings/providers/',
      containerPath: '/settings/providers/',
      subjectTemplate: undefined,
    });
    expect((Provider as any).buildId({ id: 'openai' })).toBe('openai.ttl');

    expect(tableConfig(Model)).toMatchObject({
      resourcePath: '/settings/providers/',
      containerPath: '/settings/providers/',
      subjectTemplate: undefined,
    });
    expect((Model as any).buildId({
      id: 'gpt-4o-mini',
      isProvidedBy: '/settings/providers/openai.ttl',
    })).toBe('openai.ttl#gpt-4o-mini');

    expect(tableConfig(Credential)).toMatchObject({
      resourcePath: '/settings/',
      containerPath: '/settings/',
      subjectTemplate: undefined,
    });
    expect((Credential as any).buildId({ id: 'openai-key' })).toBe('credentials.ttl#openai-key');

    const secretaryMeta = AgentMetaSchema.table('AgentMeta', {
      base: '/agents/secretary/.meta',
      subjectTemplate: '#{id}',
    }) as any;
    expect(tableConfig(secretaryMeta)).toMatchObject({
      resourcePath: '/agents/secretary/.meta',
      containerPath: '/agents/secretary/',
      subjectTemplate: '#{id}',
    });
  });

  it('reads written provider/model/credential data back as chat AI config and available models', async () => {
    const store = new PodChatKitStore({ tokenEndpoint: `${podRoot}.oidc/token` });
    const context = {
      userId: `${podRoot}profile/card#me`,
      auth: {
        type: 'solid',
        webId: `${podRoot}profile/card#me`,
        accessToken: 'pod-token',
        tokenType: 'Bearer',
      },
    } as StoreContext;
    vi.spyOn(store as any, 'getDb').mockResolvedValue(createMockDb());

    const config = await store.getAiConfig(context);
    expect(config).toEqual({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: undefined,
      defaultModel: 'gpt-4o-mini',
      apiKey: 'sk-from-pod',
      credentialId: 'credentials.ttl#openai-key',
    });

    const models = await store.listAvailableModels(context);
    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-4o-mini',
        object: 'model',
        provider: 'openai',
        owned_by: 'OpenAI',
        context_window: 128000,
        max_tokens: 16384,
      }),
    ]);
  });


  describe('/v1/chat/completions side effect', () => {
    let server: ApiServer;
    let baseUrl: string;
    let gatewayComplete: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const port = await getFreePort(12100);
      baseUrl = `http://127.0.0.1:${port}`;
      gatewayComplete = vi.fn().mockResolvedValue({
        id: 'chatcmpl-from-gateway',
        object: 'chat.completion',
        created: 123,
        model: 'gpt-4o-mini',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'chat used gateway' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
      const authMiddleware = new AuthMiddleware({
        authenticator: {
          canAuthenticate: () => true,
          authenticate: async () => ({
            success: true,
            context: {
              type: 'solid',
              webId: `${podRoot}profile/card#me`,
              accessToken: 'pod-token',
              tokenType: 'Bearer',
            },
          }),
        } as any,
      });

      server = new ApiServer({ port, authMiddleware });
      registerChatRoutes(server, {
        aiGatewayService: {
          complete: gatewayComplete,
          execute: vi.fn(),
          listModels: vi.fn(),
        } as any,
      });
      await server.start();
    });

    afterAll(async () => {
      await server?.stop();
    });

    it('routes chat completion requests through AiGatewayService instead of Pod provider secrets', async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.choices[0].message.content).toBe('chat used gateway');
      expect(gatewayComplete).toHaveBeenCalledWith(expect.objectContaining({
        protocol: 'chatCompletions',
        body: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
        },
      }));
    });
  });

  describe('/v1/models side effect', () => {
    let server: ApiServer;
    let baseUrl: string;
    let gatewayListModels: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      const port = await getFreePort(12000);
      baseUrl = `http://127.0.0.1:${port}`;
      gatewayListModels = vi.fn().mockResolvedValue([
        {
          id: 'gpt-4o-mini',
          object: 'model',
          owned_by: 'openai',
        },
      ]);
      const authMiddleware = new AuthMiddleware({
        authenticator: {
          canAuthenticate: () => true,
          authenticate: async () => ({
            success: true,
            context: {
              type: 'solid',
              webId: `${podRoot}profile/card#me`,
              accessToken: 'pod-token',
              tokenType: 'Bearer',
            },
          }),
        } as any,
      });

      server = new ApiServer({ port, authMiddleware });
      registerChatRoutes(server, {
        aiGatewayService: {
          complete: vi.fn(),
          execute: vi.fn(),
          listModels: gatewayListModels,
        } as any,
      });
      await server.start();
    });

    afterAll(async () => {
      await server?.stop();
    });

    it('exposes AiGatewayService models through the OpenAI-compatible models endpoint', async () => {
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: { Authorization: 'Bearer test' },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.object).toBe('list');
      expect(body.data).toEqual([
        expect.objectContaining({
          id: 'gpt-4o-mini',
          object: 'model',
          owned_by: 'openai',
        }),
      ]);
      expect(gatewayListModels).toHaveBeenCalled();
    });
  });
});
