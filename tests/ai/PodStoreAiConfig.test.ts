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

    let selectCallIndex = 0;
    const createSelectChain = (
      credentials = mockCredentials,
      providers = mockProviders,
      models = mockModels,
    ) => ({
      from: vi.fn().mockImplementation(() => {
        selectCallIndex++;
        if (selectCallIndex === 1) {
          return {
            where: vi.fn().mockResolvedValue(credentials),
          };
        }
        if (selectCallIndex === 2) {
          return Promise.resolve(providers);
        }
        return Promise.resolve(models);
      }),
    });
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
      select: vi.fn().mockImplementation(() => createSelectChain()),
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
        return Promise.resolve(mockCredentials.find((cred) => cred.id === id));
      }),
      updateById: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
      query: {
        chat: { findFirst: vi.fn() },
        thread: { findFirst: vi.fn() },
        message: { findFirst: vi.fn() },
      },
    };

    vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);
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
      let selectCallIndex = 0;
      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => {
          selectCallIndex++;
          if (selectCallIndex === 1) {
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }
          return Promise.resolve([]);
        }),
      }));

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

    it('should use provider baseUrl', async () => {
      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.baseUrl).toBe('https://api.openai.com/v1');
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

      let selectCallIndex = 0;
      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => {
          selectCallIndex++;
          if (selectCallIndex === 1) {
            return {
              where: vi.fn().mockResolvedValue(credentials),
            };
          }
          return Promise.resolve(providers);
        }),
      }));
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

      let selectCallIndex = 0;
      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => {
          selectCallIndex++;
          if (selectCallIndex === 1) {
            return {
              where: vi.fn().mockResolvedValue(mockCredentials),
            };
          }
          return Promise.resolve(providerWithProxy);
        }),
      }));
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

      let selectCallIndex = 0;
      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => {
          selectCallIndex++;
          if (selectCallIndex === 1) {
            return {
              where: vi.fn().mockResolvedValue(credWithoutProvider),
            };
          }
          return Promise.resolve(mockProviders);
        }),
      }));

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockRejectedValue(new Error('Query failed')),
        })),
      }));

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
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

      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: any) => {
          if (table === Provider) {
            return Promise.resolve(mockProviders);
          }
          if (table === Model) {
            return Promise.resolve(mockModels);
          }
          return {
            where: vi.fn().mockResolvedValue(mockCredentials),
          };
        }),
      }));

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

    it('should include default model when it is not already present', async () => {
      vi.spyOn(store, 'getAiConfig').mockResolvedValueOnce({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-key',
        credentialId: 'cred-001',
        defaultModel: 'fallback-model',
      });

      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((table: any) => {
          if (table === Provider) {
            return Promise.resolve(mockProviders);
          }
          if (table === Model) {
            return Promise.resolve(mockModels);
          }
          return {
            where: vi.fn().mockResolvedValue(mockCredentials),
          };
        }),
      }));

      const models = await store.listAvailableModels(mockContext);

      expect(models.map((item: any) => item.id)).toContain('fallback-model');
    });
  });
});
