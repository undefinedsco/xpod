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
    'XPOD_AI_API_KEY',
    'XPOD_AI_BASE_URL',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'DEFAULT_API_KEY',
  ];

  beforeEach(() => {
    // 保存并清除环境变量
    for (const key of envKeysToManage) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // 恢复环境变量
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

      // 访问私有方法
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

    it('should use XPOD_AI_API_KEY env var when Pod config not available', async () => {
      process.env.XPOD_AI_API_KEY = 'env-api-key';
      process.env.XPOD_AI_BASE_URL = 'https://env.api.com/v1';

      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const config = await getProviderConfig(undefined);

      expect(config).not.toBeNull();
      expect(config.apiKey).toBe('env-api-key');
      expect(config.baseURL).toBe('https://env.api.com/v1');
    });

    it('should use GOOGLE_API_KEY env var', async () => {
      process.env.GOOGLE_API_KEY = 'google-api-key';

      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const config = await getProviderConfig(undefined);

      expect(config).not.toBeNull();
      expect(config.apiKey).toBe('google-api-key');
      expect(config.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    });

    it('should use OPENROUTER_API_KEY env var', async () => {
      process.env.OPENROUTER_API_KEY = 'openrouter-api-key';

      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getProviderConfig = (provider as any).getProviderConfig.bind(provider);
      const config = await getProviderConfig(undefined);

      expect(config).not.toBeNull();
      expect(config.apiKey).toBe('openrouter-api-key');
      expect(config.baseURL).toBe('https://openrouter.ai/api/v1');
    });

    it('should prioritize Pod config over env vars', async () => {
      process.env.OPENROUTER_API_KEY = 'env-key';

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


  describe('getPodBaseUrlFromWebId', () => {
    it('should extract Pod base URL from WebID', () => {
      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getPodBaseUrl = (provider as any).getPodBaseUrlFromWebId.bind(provider);

      expect(getPodBaseUrl('http://localhost:3000/alice/profile/card#me'))
        .toBe('http://localhost:3000/alice/');

      expect(getPodBaseUrl('https://pod.example.com/user/profile/card#me'))
        .toBe('https://pod.example.com/user/');
    });

    it('should handle WebID without profile path', () => {
      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getPodBaseUrl = (provider as any).getPodBaseUrlFromWebId.bind(provider);

      expect(getPodBaseUrl('http://localhost:3000/alice#me'))
        .toBe('http://localhost:3000/alice/');
    });

    it('should return empty string for invalid WebID', () => {
      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getPodBaseUrl = (provider as any).getPodBaseUrlFromWebId.bind(provider);

      expect(getPodBaseUrl('not-a-url')).toBe('');
    });
  });

  describe('getDefaultBaseUrl', () => {
    it('should return correct URLs for known providers', () => {
      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getDefaultBaseUrl = (provider as any).getDefaultBaseUrl.bind(provider);

      expect(getDefaultBaseUrl('openai')).toBe('https://api.openai.com/v1');
      expect(getDefaultBaseUrl('google')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
      expect(getDefaultBaseUrl('anthropic')).toBe('https://api.anthropic.com/v1');
      expect(getDefaultBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
      expect(getDefaultBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1');
      expect(getDefaultBaseUrl('ollama')).toBe('http://localhost:11434/v1');
    });

    it('should return openrouter URL for unknown providers', () => {
      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getDefaultBaseUrl = (provider as any).getDefaultBaseUrl.bind(provider);

      expect(getDefaultBaseUrl('unknown')).toBe('https://openrouter.ai/api/v1');
    });

    it('should be case insensitive', () => {
      const store = createMockStore(undefined);
      const provider = new VercelAiProvider({ store });

      const getDefaultBaseUrl = (provider as any).getDefaultBaseUrl.bind(provider);

      expect(getDefaultBaseUrl('OpenAI')).toBe('https://api.openai.com/v1');
      expect(getDefaultBaseUrl('GOOGLE')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    });
  });
});
