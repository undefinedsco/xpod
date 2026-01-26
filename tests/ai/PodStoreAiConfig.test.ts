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
      provider: 'http://localhost:3000/test/settings/ai/providers.ttl#openai',
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

    // Create mock db
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      init: vi.fn().mockResolvedValue(undefined),
      query: {
        chat: { findFirst: vi.fn() },
        thread: { findFirst: vi.fn() },
        message: { findFirst: vi.fn() },
      },
    };
  });

  describe('extractProviderId', () => {
    it('should extract provider ID from URI with hash', () => {
      // Access private method via any
      const extractProviderId = (store as any).extractProviderId.bind(store);

      expect(extractProviderId('http://localhost:3000/test/settings/ai/providers.ttl#openai'))
        .toBe('openai');
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
      // Mock getDb to return db with empty credentials
      mockDb.from = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
    });

    it('should return AI config when valid credential and provider exist', async () => {
      // Track which call we're on
      let callIndex = 0;

      // Mock the query chain - first call returns credentials, second returns providers
      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            callIndex++;
            if (callIndex === 1) {
              return Promise.resolve(mockCredentials);
            }
            return Promise.resolve(mockProviders);
          }),
        })),
      });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.providerId).toBe('openai');
      expect(config!.apiKey).toBe('sk-test-key');
      expect(config!.baseUrl).toBe('https://api.openai.com/v1');
      expect(config!.credentialId).toBe('cred-001');
    });

    it('should prefer credential baseUrl over provider baseUrl', async () => {
      const credWithCustomUrl = [
        {
          ...mockCredentials[0],
          baseUrl: 'https://custom.api.com/v1',
        },
      ];

      let callIndex = 0;
      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            callIndex++;
            if (callIndex === 1) {
              return Promise.resolve(credWithCustomUrl);
            }
            return Promise.resolve(mockProviders);
          }),
        })),
      });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.baseUrl).toBe('https://custom.api.com/v1');
    });

    it('should include proxyUrl when available on credential', async () => {
      const credWithProxy = [
        {
          ...mockCredentials[0],
          proxyUrl: 'http://proxy.example.com:8080',
        },
      ];

      let callIndex = 0;
      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            callIndex++;
            if (callIndex === 1) {
              return Promise.resolve(credWithProxy);
            }
            return Promise.resolve(mockProviders);
          }),
        })),
      });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.proxyUrl).toBe('http://proxy.example.com:8080');
    });

    it('should include proxyUrl from provider when credential has none', async () => {
      const providerWithProxy = [
        {
          ...mockProviders[0],
          proxyUrl: 'http://provider-proxy.example.com:8080',
        },
      ];

      let callIndex = 0;
      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            callIndex++;
            if (callIndex === 1) {
              return Promise.resolve(mockCredentials);
            }
            return Promise.resolve(providerWithProxy);
          }),
        })),
      });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const config = await store.getAiConfig(mockContext);

      expect(config).toBeDefined();
      expect(config!.proxyUrl).toBe('http://provider-proxy.example.com:8080');
    });

    it('should skip credentials without provider', async () => {
      const credWithoutProvider = [{ ...mockCredentials[0], provider: null }];

      mockDb.from = vi.fn().mockImplementation(() => ({
        where: vi.fn().mockResolvedValue(credWithoutProvider),
      }));
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const config = await store.getAiConfig(mockContext);
      expect(config).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      mockDb.from = vi.fn().mockImplementation(() => ({
        where: vi.fn().mockRejectedValue(new Error('Query failed')),
      }));
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

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
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.update = vi.fn().mockReturnValue({ set: setMock });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      await store.updateCredentialStatus(
        mockContext,
        'cred-001',
        CredentialStatus.RATE_LIMITED,
      );

      expect(mockDb.update).toHaveBeenCalled();
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: CredentialStatus.RATE_LIMITED }),
      );
    });

    it('should include rateLimitResetAt when provided', async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.update = vi.fn().mockReturnValue({ set: setMock });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const resetAt = new Date(Date.now() + 60000);
      await store.updateCredentialStatus(
        mockContext,
        'cred-001',
        CredentialStatus.RATE_LIMITED,
        { rateLimitResetAt: resetAt },
      );

      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: CredentialStatus.RATE_LIMITED,
          rateLimitResetAt: resetAt,
        }),
      );
    });

    it('should increment failCount when requested', async () => {
      const existingCred = { ...mockCredentials[0], failCount: 2 };

      mockDb.from = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([existingCred]),
      });
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.update = vi.fn().mockReturnValue({ set: setMock });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      await store.updateCredentialStatus(
        mockContext,
        'cred-001',
        CredentialStatus.RATE_LIMITED,
        { incrementFailCount: true },
      );

      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: CredentialStatus.RATE_LIMITED,
          failCount: 3,
        }),
      );
    });

    it('should handle errors gracefully', async () => {
      mockDb.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('Update failed')),
        }),
      });
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
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.update = vi.fn().mockReturnValue({ set: setMock });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      await store.recordCredentialSuccess(mockContext, 'cred-001');

      expect(mockDb.update).toHaveBeenCalled();
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: CredentialStatus.ACTIVE,
          failCount: 0,
          rateLimitResetAt: undefined,
        }),
      );
    });

    it('should set lastUsedAt to current date', async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.update = vi.fn().mockReturnValue({ set: setMock });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      const beforeCall = new Date();
      await store.recordCredentialSuccess(mockContext, 'cred-001');
      const afterCall = new Date();

      expect(setMock).toHaveBeenCalled();
      const callArgs = setMock.mock.calls[0][0];
      expect(callArgs.lastUsedAt).toBeInstanceOf(Date);
      expect(callArgs.lastUsedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(callArgs.lastUsedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });

    it('should handle errors gracefully', async () => {
      mockDb.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('Update failed')),
        }),
      });
      vi.spyOn(store as any, 'getDb').mockResolvedValue(mockDb);

      // Should not throw
      await expect(
        store.recordCredentialSuccess(mockContext, 'cred-001'),
      ).resolves.toBeUndefined();
    });
  });
});
