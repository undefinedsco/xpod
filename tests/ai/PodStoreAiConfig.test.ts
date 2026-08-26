/**
 * PodChatKitStore AI Config Operations Tests
 *
 * 测试 PodChatKitStore 中的 AI 配置相关操作:
 * - getAiConfig
 * - updateCredentialStatus
 * - recordCredentialSuccess
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import { CredentialStatus, ServiceType } from '../../src/credential/schema/types';
import type { StoreContext } from '../../src/api/chatkit/store';
import { Provider } from '../../src/ai/schema/provider';
import { Model } from '../../src/ai/schema/model';
import { AIConfig } from '../../src/ai/schema/config';
import { Credential } from '../../src/credential/schema/tables';
import { aiConfigModelRef } from '@undefineds.co/models';

// Mock Session
vi.mock('@inrupt/solid-client-authn-node', () => ({
  Session: vi.fn().mockImplementation(() => ({
    login: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    info: { isLoggedIn: true, webId: 'http://localhost:3000/test/profile/card#me' },
  })),
}));

describe('PodChatKitStore AI Config Operations', () => {
  let store: PodChatKitStore;
  let mockDb: any;
  let mockContext: StoreContext;

  const mockCredentials = [
    {
      id: 'cred-001',
      provider: 'http://localhost:3000/test/settings/providers/openai.ttl',
      service: ServiceType.AI,
      status: CredentialStatus.ACTIVE,
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
      failCount: 0,
    },
  ];

  const mockProviders = [
    {
      id: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: null,
      '@id': 'http://localhost:3000/test/settings/providers/openai.ttl',
    },
  ];

  const mockModels = [
    {
      id: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
      isProvidedBy: 'http://localhost:3000/test/settings/providers/openai.ttl',
      contextLength: 128000,
      maxOutputTokens: 16384,
    },
    {
      id: 'custom-coder',
      displayName: 'Custom Coder',
      isProvidedBy: 'http://localhost:3000/test/settings/providers/openai.ttl',
      contextLength: 64000,
      maxOutputTokens: 8192,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    store = new PodChatKitStore({
      tokenEndpoint: 'http://localhost:3000/.oidc/token',
    });

    mockContext = {
      userId: 'http://localhost:3000/test/profile/card#me',
      auth: {
        type: 'solid',
        webId: 'http://localhost:3000/test/profile/card#me',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      },
    } as StoreContext;

    const findProvider = (target: string, providers = mockProviders) => providers.find((provider) => (
      target === provider.id
      || target === provider['@id']
      || target === `/settings/providers/${provider.id}.ttl`
      || target.endsWith(`/settings/providers/${provider.id}.ttl`)
    ));
    const findModel = (target: string, models = mockModels) => models.find((model) => (
      target === model.id
      || target.endsWith(`#${model.id}`)
    ));

    // Create mock db
    mockDb = {
      select: vi.fn(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      findByIri: vi.fn().mockImplementation((table: any, iri: string) => {
        if (table === Provider) return Promise.resolve(findProvider(iri));
        if (table === Model) return Promise.resolve(findModel(iri));
        return Promise.resolve(undefined);
      }),
      findById: vi.fn().mockImplementation((table: any, id: string) => {
        if (table === Provider) return Promise.resolve(findProvider(id));
        if (table === Model) return Promise.resolve(findModel(id));
        if (table === AIConfig) return Promise.resolve(undefined);
        return Promise.resolve(mockCredentials.find((cred) => cred.id === id));
      }),
      updateById: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
      query: {
        chat: { findFirst: vi.fn() },
        thread: { findFirst: vi.fn() },
        message: { findFirst: vi.fn() },
        credential: { findMany: vi.fn().mockResolvedValue(mockCredentials) },
        provider: { findMany: vi.fn().mockResolvedValue(mockProviders) },
        model: { findMany: vi.fn().mockResolvedValue(mockModels) },
      },
    };

    vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);
  });

  it('declares the Xpod settings query capability through drizzle-solid schemas', () => {
    expect(Credential.getSparqlEndpoint()).toBe('/settings/-/sparql');
    expect(Provider.getSparqlEndpoint()).toBe('/settings/-/sparql');
    expect(Model.getSparqlEndpoint()).toBe('/settings/-/sparql');
    expect(AIConfig.getSparqlEndpoint()).toBe('/settings/-/sparql');
  });

  describe('extractProviderId', () => {
    it('should extract provider ID from current provider resource URI', () => {
      // Access private method via any
      const extractProviderId = (store as any).extractProviderId.bind(store);

      expect(extractProviderId('http://localhost:3000/test/settings/providers/openai.ttl'))
        .toBe('openai');
    });

    it('should still extract provider ID from legacy fragment URI', () => {
      const extractProviderId = (store as any).extractProviderId.bind(store);

      expect(extractProviderId('http://example.com/path/to/file.ttl#google'))
        .toBe('google');
    });

    it('should return input if no hash found', () => {
      const extractProviderId = (store as any).extractProviderId.bind(store);

      expect(extractProviderId('openai')).toBe('openai');
      expect(extractProviderId('some-provider-id')).toBe('some-provider-id');
    });

    it('should handle empty string', () => {
      const extractProviderId = (store as any).extractProviderId.bind(store);
      expect(extractProviderId('')).toBe('');
    });
  });

  describe('getAiConfig', () => {
    it('should return undefined when db is not available', async () => {
      // Mock getDb to return null
      vi.spyOn(store as any, 'getDb').mockResolvedValue(null);

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
    });

    it('should return undefined when no active credentials exist', async () => {
      mockDb.query.credential.findMany.mockResolvedValue([]);

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
    });

    it('should return AI config when valid credential and provider exist', async () => {

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.providerId).toBe('openai');
      expect(config!.apiKey).toBe('sk-test-key');
      expect(config!.baseUrl).toBe('https://api.openai.com/v1');
      expect(config!.credentialId).toBe('cred-001');
    });

    it('should not treat provider hasModel links as a default model when selecting BYOK config', async () => {
      const providerWithModelLinks = {
        id: 'openai.ttl',
        displayName: 'OpenAI',
        baseUrl: 'http://127.0.0.1:52801/v1',
        proxyUrl: null,
        hasModel: ['http://localhost:3000/settings/providers/openai.ttl#xpod-fixture-chat'],
        '@id': 'http://localhost:3000/test/settings/providers/openai.ttl',
      };
      mockDb.query.credential.findMany.mockResolvedValue([
        {
          id: 'credentials.ttl#openai-default',
          provider: 'http://localhost:3000/settings/providers/openai.ttl',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'sk-provider-key',
          failCount: 0,
        },
      ]);
      mockDb.query.provider.findMany.mockResolvedValue([providerWithModelLinks]);
      mockDb.findByIri.mockImplementation((table: any, iri: string) => {
        if (table === Provider) return Promise.resolve(providerWithModelLinks);
        if (table === Model) return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      });
      mockDb.findById.mockImplementation((table: any, id: string) => {
        if (table === Provider && id === 'openai') return Promise.resolve(providerWithModelLinks);
        if (table === AIConfig) return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      });

      const config = await store.getAiConfig(mockContext);

      expect(config).toMatchObject({
        providerId: 'openai',
        apiKey: 'sk-provider-key',
        baseUrl: 'http://127.0.0.1:52801/v1',
        credentialId: 'credentials.ttl#openai-default',
      });
      expect(mockDb.findByIri).not.toHaveBeenCalledWith(Model, expect.any(Array));
    });

    it('should ignore cached Solid fetch and read AI config only through drizzle-solid tables', async () => {
      const cachedFetch = vi.fn();
      (mockContext as any)._cachedFetch = cachedFetch;
      (mockContext as any)._cachedWebId = 'https://id.undefineds.co/glocal/profile/card#me';
      (mockContext as any)._cachedPodBaseUrl = 'https://id.undefineds.co/glocal';
      mockDb.getDialect = vi.fn(() => ({
        getPodUrl: () => 'https://node-0000.undefineds.co/glocal/',
      }));

      const config = await store.getAiConfig(mockContext);

      expect(config).toMatchObject({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-key',
        credentialId: 'cred-001',
      });
      expect(cachedFetch).not.toHaveBeenCalled();
      expect((mockContext as any)._cachedPodBaseUrl).toBe('https://node-0000.undefineds.co/glocal');
      expect(mockDb.query.credential.findMany).toHaveBeenCalled();
    });

    it('should use provider baseUrl', async () => {
      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should return configured embedding model from Pod AI config', async () => {
      const embeddingModel = {
        id: 'text-embedding-3-small',
        displayName: 'Text Embedding 3 Small',
        modelType: 'embedding',
        isProvidedBy: 'http://localhost:3000/test/settings/providers/openai.ttl',
        updatedAt: '2026-08-13T00:00:00.000Z',
      };
      mockDb.findById = vi.fn().mockImplementation((table: any, id: string) => {
        if (table === AIConfig && id === 'config') {
          return Promise.resolve({
            id: 'config',
            embeddingModel: aiConfigModelRef('openai', 'text-embedding-3-small'),
          });
        }
        if (table === Provider) return Promise.resolve(mockProviders[0]);
        if (table === Model) return Promise.resolve(
          id === embeddingModel.id ? embeddingModel : mockModels.find((model) => model.id === id),
        );
        return Promise.resolve(mockCredentials.find((cred) => cred.id === id));
      });
      mockDb.findByIri = vi.fn().mockImplementation((table: any, iri: string) => {
        if (table === Provider) return Promise.resolve(mockProviders[0]);
        if (table === Model) return Promise.resolve(
          iri.endsWith(`#${embeddingModel.id}`) ? embeddingModel : undefined,
        );
        return Promise.resolve(undefined);
      });

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.embeddingModel).toBe('text-embedding-3-small');
      expect(config!.embeddingModelVersion).toBe('2026-08-13T00:00:00.000Z');
    });

    it('uses the credential owned by the exact configured embedding model provider', async () => {
      const credentials = [
        {
          ...mockCredentials[0],
          id: 'cred-default',
          provider: 'http://localhost:3000/test/settings/providers/custom.ttl',
          apiKey: 'sk-default',
          isDefault: true,
        },
        {
          ...mockCredentials[0],
          id: 'cred-embedding',
          apiKey: 'sk-embedding',
        },
      ];
      const providers = [
        ...mockProviders,
        {
          id: 'custom',
          displayName: 'Custom',
          baseUrl: 'https://custom.example.com/v1',
          proxyUrl: null,
          '@id': 'http://localhost:3000/test/settings/providers/custom.ttl',
        },
      ];
      const embeddingModel = {
        id: 'text-embedding-3-small',
        displayName: 'Text Embedding 3 Small',
        modelType: 'embedding',
        isProvidedBy: 'http://localhost:3000/test/settings/providers/openai.ttl',
        updatedAt: '2026-08-13T00:00:00.000Z',
      };

      mockDb.query.credential.findMany.mockResolvedValue(credentials);
      mockDb.findByIri = vi.fn().mockImplementation((table: any, iri: string) => {
        if (table === Provider) {
          return Promise.resolve(providers.find((provider) => iri === provider['@id']));
        }
        if (table === Model) {
          return Promise.resolve(iri.endsWith('#text-embedding-3-small') ? embeddingModel : undefined);
        }
        return Promise.resolve(undefined);
      });
      mockDb.findById = vi.fn().mockImplementation((table: any, id: string) => {
        if (table === AIConfig && id === 'config') {
          return Promise.resolve({
            id: 'config',
            embeddingModel: aiConfigModelRef('openai', 'text-embedding-3-small'),
          });
        }
        if (table === Provider) {
          return Promise.resolve(providers.find((provider) => id === provider.id));
        }
        if (table === Model) {
          return Promise.resolve(id === 'text-embedding-3-small' ? embeddingModel : undefined);
        }
        return Promise.resolve(undefined);
      });

      const config = await store.getAiConfig(mockContext);

      expect(config).toMatchObject({
        providerId: 'openai',
        apiKey: 'sk-embedding',
        credentialId: 'cred-embedding',
        embeddingModel: 'text-embedding-3-small',
      });
    });

    it('should not invent an embedding model when no exact AIConfig embeddingModel is stored', async () => {
      const credentials = [{
        ...mockCredentials[0],
        id: 'cred-dashscope',
        provider: 'http://localhost:3000/test/settings/providers/dashscope.ttl',
        apiKey: 'dashscope-key',
      }];
      const providers = [{
        id: 'dashscope',
        displayName: 'DashScope',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        proxyUrl: null,
        '@id': 'http://localhost:3000/test/settings/providers/dashscope.ttl',
      }];

      mockDb.query.credential.findMany.mockResolvedValue(credentials);
      mockDb.query.provider.findMany.mockResolvedValue(providers);
      mockDb.findByIri = vi.fn().mockImplementation((table: any, iri: string) => {
        if (table === Provider) {
          return Promise.resolve(providers.find((provider) => iri === provider['@id'] || iri.endsWith('/settings/providers/dashscope.ttl')));
        }
        return Promise.resolve(undefined);
      });
      mockDb.findById = vi.fn().mockImplementation((table: any, id: string) => {
        if (table === AIConfig && id === 'config') return Promise.resolve(undefined);
        if (table === Provider) return Promise.resolve(providers.find((provider) => id === provider.id || id.endsWith('/settings/providers/dashscope.ttl')));
        return Promise.resolve(credentials.find((cred) => cred.id === id));
      });

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.providerId).toBe('dashscope');
      expect(config!.embeddingModel).toBeUndefined();
      expect(config!.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    });

    it('should select the default credential before storage order', async () => {
      const credentials = [
        {
          ...mockCredentials[0],
          id: 'cred-alpha',
          provider: 'http://localhost:3000/test/settings/providers/openai.ttl',
          apiKey: 'sk-alpha',
        },
        {
          ...mockCredentials[0],
          id: 'cred-custom',
          provider: 'http://localhost:3000/test/settings/providers/custom.ttl',
          apiKey: 'sk-custom',
          isDefault: true,
        },
      ];
      const providers = [
        ...mockProviders,
        {
          id: 'custom',
          displayName: 'Custom',
          baseUrl: 'https://custom.example.com/v1',
          proxyUrl: null,
          '@id': 'http://localhost:3000/test/settings/providers/custom.ttl',
        },
      ];

      mockDb.query.credential.findMany.mockResolvedValue(credentials);
      mockDb.query.provider.findMany.mockResolvedValue(providers);
      mockDb.findByIri = vi.fn().mockImplementation((table: any, iri: string) => {
        if (table === Provider) {
          return Promise.resolve(providers.find((provider) => iri === provider['@id'] || iri.endsWith(`/settings/providers/${provider.id}.ttl`)));
        }
        return Promise.resolve(undefined);
      });
      mockDb.findById = vi.fn().mockImplementation((table: any, id: string) => {
        if (table === Provider) {
          return Promise.resolve(providers.find((provider) => id === provider.id || id === `/settings/providers/${provider.id}.ttl`));
        }
        return Promise.resolve(credentials.find((cred) => cred.id === id));
      });

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.providerId).toBe('custom');
      expect(config!.apiKey).toBe('sk-custom');
      expect(config!.baseUrl).toBe('https://custom.example.com/v1');
      expect(config!.credentialId).toBe('cred-custom');
    });

    it('should include proxyUrl when available on provider', async () => {
      const providerWithProxy = [
        {
          ...mockProviders[0],
          proxyUrl: 'http://proxy.example.com:8080',
        },
      ];

      mockDb.query.credential.findMany.mockResolvedValue(mockCredentials);
      mockDb.query.provider.findMany.mockResolvedValue(providerWithProxy);
      mockDb.findByIri = vi.fn().mockImplementation((table: any, iri: string) => {
        if (table === Provider) {
          return Promise.resolve(providerWithProxy.find((provider) => iri === provider['@id'] || iri.endsWith(`/settings/providers/${provider.id}.ttl`)));
        }
        return Promise.resolve(undefined);
      });
      mockDb.findById = vi.fn().mockImplementation((table: any, id: string) => {
        if (table === Provider) {
          return Promise.resolve(providerWithProxy.find((provider) => id === provider.id || id === `/settings/providers/${provider.id}.ttl`));
        }
        return Promise.resolve(mockCredentials.find((cred) => cred.id === id));
      });

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.proxyUrl).toBe('http://proxy.example.com:8080');
    });

    it('should skip credentials without provider', async () => {
      const credWithoutProvider = [{ ...mockCredentials[0], provider: null }];

      mockDb.query.credential.findMany.mockResolvedValue(credWithoutProvider);
      mockDb.query.provider.findMany.mockResolvedValue(mockProviders);

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      mockDb.query.credential.findMany.mockRejectedValue(new Error('Query failed'));

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
    });
  });

  describe('getReaderConfig', () => {
    it('should select reader model and credential from Pod provider settings', async () => {
      mockDb.query.provider.findMany.mockResolvedValue([
        {
          id: 'paddleocr',
          displayName: 'PaddleOCR',
          baseUrl: 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs',
          defaultModel: 'http://localhost:3000/test/settings/providers/paddleocr.ttl#pp-ocrv6',
        },
      ]);
      mockDb.query.model.findMany.mockResolvedValue([
        {
          id: 'paddleocr.ttl#pp-ocrv6',
          displayName: 'PP-OCRv6',
          modelType: 'reader',
          isProvidedBy: 'http://localhost:3000/test/settings/providers/paddleocr.ttl',
          status: 'active',
        },
        {
          id: 'paddleocr.ttl#chat-model',
          displayName: 'Chat-looking model',
          modelType: 'chat',
          isProvidedBy: 'http://localhost:3000/test/settings/providers/paddleocr.ttl',
          status: 'active',
        },
      ]);
      mockDb.query.credential.findMany.mockResolvedValue([
        {
          id: 'cred_reader',
          provider: 'http://localhost:3000/test/settings/providers/paddleocr.ttl',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'paddle-token',
          isDefault: true,
        },
      ]);

      const config = await store.getReaderConfig(mockContext, 'paddleocr');

      expect(config).toEqual({
        providerId: 'paddleocr',
        providerDisplayName: 'PaddleOCR',
        baseUrl: 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs',
        proxyUrl: undefined,
        model: 'pp-ocrv6',
        modelDisplayName: 'PP-OCRv6',
        modelType: 'reader',
        credentialId: 'cred_reader',
      });
    });
  });

  describe('updateCredentialStatus', () => {
    it('should not throw when db is not available', async () => {
      vi.spyOn(store as any, 'getDb').mockResolvedValue(null);

      await expect(
        store.updateCredentialStatus(mockContext, 'cred-001', CredentialStatus.RATE_LIMITED),
      ).resolves.toBeUndefined();
    });

    it('should call update with correct status', async () => {
      mockDb.updateById = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      await store.updateCredentialStatus(
        mockContext,
        'cred-001',
        CredentialStatus.RATE_LIMITED,
      );

      expect(mockDb.updateById).toHaveBeenCalled();
      expect(mockDb.updateById.mock.calls[0][2]).toEqual(
        expect.objectContaining({ status: CredentialStatus.RATE_LIMITED }),
      );
    });

    it('should include rateLimitResetAt when provided', async () => {
      mockDb.updateById = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const resetAt = new Date(Date.now() + 60000);
      await store.updateCredentialStatus(
        mockContext,
        'cred-001',
        CredentialStatus.RATE_LIMITED,
        { rateLimitResetAt: resetAt },
      );

      expect(mockDb.updateById.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          status: CredentialStatus.RATE_LIMITED,
          rateLimitResetAt: resetAt,
        }),
      );
    });

    it('should increment failCount when requested', async () => {
      const existingCred = { ...mockCredentials[0], failCount: 2 };

      mockDb.findById = vi.fn().mockResolvedValue(existingCred);
      mockDb.updateById = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      await store.updateCredentialStatus(
        mockContext,
        'cred-001',
        CredentialStatus.RATE_LIMITED,
        { incrementFailCount: true },
      );

      expect(mockDb.updateById.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          status: CredentialStatus.RATE_LIMITED,
          failCount: 3,
        }),
      );
    });

    it('should handle errors gracefully', async () => {
      mockDb.updateById = vi.fn().mockRejectedValue(new Error('Update failed'));
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      // Should not throw
      await expect(
        store.updateCredentialStatus(mockContext, 'cred-001', CredentialStatus.RATE_LIMITED),
      ).resolves.toBeUndefined();
    });
  });

  describe('recordCredentialSuccess', () => {
    it('should not throw when db is not available', async () => {
      vi.spyOn(store as any, 'getDb').mockResolvedValue(null);

      await expect(
        store.recordCredentialSuccess(mockContext, 'cred-001'),
      ).resolves.toBeUndefined();
    });

    it('should reset status and failCount on success', async () => {
      mockDb.updateById = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      await store.recordCredentialSuccess(mockContext, 'cred-001');

      expect(mockDb.updateById).toHaveBeenCalled();
      expect(mockDb.updateById.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          status: CredentialStatus.ACTIVE,
          failCount: 0,
          rateLimitResetAt: undefined,
        }),
      );
    });

    it('should set lastUsedAt to current date', async () => {
      mockDb.updateById = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const beforeCall = new Date();
      await store.recordCredentialSuccess(mockContext, 'cred-001');
      const afterCall = new Date();

      expect(mockDb.updateById).toHaveBeenCalled();
      const callArgs = mockDb.updateById.mock.calls[0][2];
      expect(callArgs.lastUsedAt).toBeInstanceOf(Date);
      expect(callArgs.lastUsedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(callArgs.lastUsedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });

    it('should handle errors gracefully', async () => {
      mockDb.updateById = vi.fn().mockRejectedValue(new Error('Update failed'));
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      // Should not throw
      await expect(
        store.recordCredentialSuccess(mockContext, 'cred-001'),
      ).resolves.toBeUndefined();
    });
  });

  describe('listAvailableModels', () => {
    it('should return empty list when no active AI config exists', async () => {
      vi.spyOn(store, 'getAiConfig').mockResolvedValueOnce(undefined);

      const models = await store.listAvailableModels(mockContext);

      expect(models).toEqual([]);
    });

    it('should return pod-defined models for current user', async () => {
      vi.spyOn(store, 'getAiConfig').mockResolvedValueOnce({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-key',
        credentialId: 'cred-001',
        defaultModel: 'gpt-4o-mini',
      });

      mockDb.query.provider.findMany.mockResolvedValue(mockProviders);
      mockDb.query.model.findMany.mockResolvedValue(mockModels);

      const models = await store.listAvailableModels(mockContext);

      expect(models.map((item: any) => item.id)).toEqual(['gpt-4o-mini', 'custom-coder']);
      expect(models[0]).toEqual(expect.objectContaining({
        id: 'gpt-4o-mini',
        object: 'model',
        provider: 'openai',
        owned_by: 'OpenAI',
        context_window: 128000,
        max_tokens: 16384,
      }));
      expect(models[1]).toEqual(expect.objectContaining({
        id: 'custom-coder',
        object: 'model',
        provider: 'openai',
        owned_by: 'OpenAI',
      }));
    });

    it('should list models when provider ids are stored as resource filenames', async () => {
      vi.spyOn(store, 'getAiConfig').mockResolvedValueOnce({
        providerId: 'openai',
        baseUrl: 'http://127.0.0.1:52801/v1',
        apiKey: 'sk-test-key',
        credentialId: 'credentials.ttl#openai-default',
      });

      mockDb.query.provider.findMany.mockResolvedValue([
        {
          id: 'openai.ttl',
          displayName: 'OpenAI',
          baseUrl: 'http://127.0.0.1:52801/v1',
          '@id': 'http://localhost:3000/test/settings/providers/openai.ttl',
        },
      ]);
      mockDb.query.model.findMany.mockResolvedValue([
        {
          id: 'openai.ttl#xpod-fixture-chat',
          displayName: 'Fixture Chat',
          isProvidedBy: 'http://localhost:3000/settings/providers/openai.ttl',
          status: 'active',
        },
      ]);

      const models = await store.listAvailableModels(mockContext);

      expect(models).toEqual([
        expect.objectContaining({
          id: 'xpod-fixture-chat',
          object: 'model',
          provider: 'openai',
          owned_by: 'OpenAI',
        }),
      ]);
    });

    it('should include default model when it is not already present', async () => {
      vi.spyOn(store, 'getAiConfig').mockResolvedValueOnce({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-key',
        credentialId: 'cred-001',
        defaultModel: 'fallback-model',
      });

      mockDb.query.provider.findMany.mockResolvedValue(mockProviders);
      mockDb.query.model.findMany.mockResolvedValue(mockModels);

      const models = await store.listAvailableModels(mockContext);

      expect(models.map((item: any) => item.id)).toContain('fallback-model');
    });
  });
});
