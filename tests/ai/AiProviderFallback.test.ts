/**
 * AI Provider 降级逻辑单元测试
 *
 * 测试 VercelAiProvider 的配置获取和降级逻辑
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VercelAiProvider } from '../../src/api/chatkit/ai-provider';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';

describe('VercelAiProvider', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToManage = [
    'DEFAULT_API_KEY',
    'DEFAULT_API_BASE',
  ];

  beforeEach(() => {
    for (const key of envKeysToManage) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  function createMockStore(config?: {
    apiKey?: string;
    baseUrl?: string;
    proxyUrl?: string;
    credentialId?: string;
  }): PodChatKitStore {
    return {
      getAiConfig: vi.fn().mockResolvedValue(config),
      updateCredentialStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as PodChatKitStore;
  }

  describe('getProviderConfig', () => {
    it('should return null when no config available', async () => {
      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const config = await getProviderConfig(undefined);

      expect(config).toBeNull();
    });

    it('should return config from Pod when available', async () => {
      const podConfig = {
        apiKey: 'pod-api-key',
        baseUrl: 'https://custom.api.com/v1',
        proxyUrl: 'http://proxy.example.com',
        credentialId: 'cred-123',
      };
      const store = createMockStore(podConfig);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const mockContext = { auth: { webId: 'http://example.com/profile#me' } };
      const config = await getProviderConfig(mockContext);

      expect(config).not.toBeNull();
      expect(config.apiKey).toBe('pod-api-key');
      expect(config.baseURL).toBe('https://custom.api.com/v1');
      expect(config.proxy).toBe('http://proxy.example.com');
      expect(config.credentialId).toBe('cred-123');
    });

    it('should use DEFAULT_API_BASE as platform Provider fallback', async () => {
      process.env.DEFAULT_API_BASE = 'https://platform.api.com/v1';
      process.env.DEFAULT_API_KEY = 'platform-key';

      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const config = await getProviderConfig(undefined);

      expect(config).not.toBeNull();
      expect(config.baseURL).toBe('https://platform.api.com/v1');
      expect(config.apiKey).toBe('platform-key');
    });

    it('should use DEFAULT_API_BASE with empty apiKey when DEFAULT_API_KEY is not set', async () => {
      process.env.DEFAULT_API_BASE = 'https://platform.api.com/v1';

      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const config = await getProviderConfig(undefined);

      expect(config).not.toBeNull();
      expect(config.baseURL).toBe('https://platform.api.com/v1');
      expect(config.apiKey).toBe('');
    });

    it('should prioritize Pod config over platform Provider', async () => {
      process.env.DEFAULT_API_BASE = 'https://platform.api.com/v1';
      process.env.DEFAULT_API_KEY = 'platform-key';

      const podConfig = {
        apiKey: 'pod-key',
        baseUrl: 'https://pod.api.com/v1',
      };
      const store = createMockStore(podConfig);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const mockContext = { auth: { webId: 'http://example.com/profile#me' } };
      const config = await getProviderConfig(mockContext);

      expect(config).not.toBeNull();
      expect(config.apiKey).toBe('pod-key');
      expect(config.baseURL).toBe('https://pod.api.com/v1');
    });

    it('should use default baseURL when Pod config has apiKey but no baseUrl', async () => {
      const podConfig = {
        apiKey: 'pod-key-only',
      };
      const store = createMockStore(podConfig);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const mockContext = { auth: { webId: 'http://example.com/profile#me' } };
      const config = await getProviderConfig(mockContext);

      expect(config).not.toBeNull();
      expect(config.apiKey).toBe('pod-key-only');
      expect(config.baseURL).toBe('https://openrouter.ai/api/v1');
    });
  });
});
