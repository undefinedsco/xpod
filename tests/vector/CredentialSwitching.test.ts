/**
 * Credential Switching 测试
 *
 * 测试密钥切换场景：
 * 1. 多密钥负载均衡
 * 2. 密钥失效后切换
 * 3. 密钥状态管理
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialStatus, ServiceType } from '../../src/credential/schema/types';

// Mock drizzle-solid 的查询结果
interface MockCredential {
  id: string;
  provider: string;
  service: string;
  status: string;
  apiKey: string;
  baseUrl?: string;
  label?: string;
  failCount?: number;
}

interface MockProvider {
  id: string;
  providerId: string;
  baseUrl: string;
  proxyUrl?: string;
}

// 模拟 CredentialReader 的逻辑
class MockCredentialReader {
  private credentials: (MockCredential & { providerData?: MockProvider })[] = [];

  setCredentials(creds: (MockCredential & { providerData?: MockProvider })[]) {
    this.credentials = creds;
  }

  async getAiCredential(
    _podBaseUrl: string,
    providerId: string,
  ): Promise<{ provider: string; apiKey: string; baseUrl?: string; proxyUrl?: string } | null> {
    // 过滤出活跃的 AI 凭据
    const activeCredentials = this.credentials.filter(
      (c) => c.service === ServiceType.AI && c.status === CredentialStatus.ACTIVE && c.providerData?.providerId === providerId,
    );

    if (activeCredentials.length === 0) {
      return null;
    }

    // 随机选择一个（负载均衡）
    const selected = activeCredentials[Math.floor(Math.random() * activeCredentials.length)];

    return {
      provider: providerId,
      apiKey: selected.apiKey,
      baseUrl: selected.baseUrl || selected.providerData?.baseUrl,
      proxyUrl: selected.providerData?.proxyUrl,
    };
  }

  // 标记密钥失效
  markCredentialFailed(credentialId: string) {
    const cred = this.credentials.find((c) => c.id === credentialId);
    if (cred) {
      cred.failCount = (cred.failCount || 0) + 1;
      if (cred.failCount >= 3) {
        cred.status = CredentialStatus.INACTIVE;
      }
    }
  }

  // 标记密钥限流
  markCredentialRateLimited(credentialId: string) {
    const cred = this.credentials.find((c) => c.id === credentialId);
    if (cred) {
      cred.status = CredentialStatus.RATE_LIMITED;
    }
  }

  // 恢复密钥
  restoreCredential(credentialId: string) {
    const cred = this.credentials.find((c) => c.id === credentialId);
    if (cred) {
      cred.status = CredentialStatus.ACTIVE;
      cred.failCount = 0;
    }
  }
}

describe('Credential Switching', () => {
  let reader: MockCredentialReader;

  const googleProvider: MockProvider = {
    id: 'google',
    providerId: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  };

  const openaiProvider: MockProvider = {
    id: 'openai',
    providerId: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  };

  beforeEach(() => {
    reader = new MockCredentialReader();
  });

  describe('Single Credential', () => {
    it('should return credential for matching provider', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-123',
          providerData: googleProvider,
        },
      ]);

      const cred = await reader.getAiCredential('http://pod/', 'google');
      expect(cred).not.toBeNull();
      expect(cred!.apiKey).toBe('key-123');
      expect(cred!.provider).toBe('google');
    });

    it('should return null for non-matching provider', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-123',
          providerData: googleProvider,
        },
      ]);

      const cred = await reader.getAiCredential('http://pod/', 'openai');
      expect(cred).toBeNull();
    });

    it('should return null for inactive credential', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.INACTIVE,
          apiKey: 'key-123',
          providerData: googleProvider,
        },
      ]);

      const cred = await reader.getAiCredential('http://pod/', 'google');
      expect(cred).toBeNull();
    });
  });

  describe('Multiple Credentials - Load Balancing', () => {
    it('should randomly select from multiple active credentials', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-1',
          providerData: googleProvider,
        },
        {
          id: 'cred2',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-2',
          providerData: googleProvider,
        },
        {
          id: 'cred3',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-3',
          providerData: googleProvider,
        },
      ]);

      const selectedKeys = new Set<string>();
      for (let i = 0; i < 30; i++) {
        const cred = await reader.getAiCredential('http://pod/', 'google');
        if (cred) selectedKeys.add(cred.apiKey);
      }

      // 多次调用应该选到不同的密钥
      expect(selectedKeys.size).toBeGreaterThan(1);
    });

    it('should skip inactive credentials in selection', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.INACTIVE,
          apiKey: 'key-inactive',
          providerData: googleProvider,
        },
        {
          id: 'cred2',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-active',
          providerData: googleProvider,
        },
      ]);

      for (let i = 0; i < 10; i++) {
        const cred = await reader.getAiCredential('http://pod/', 'google');
        expect(cred).not.toBeNull();
        expect(cred!.apiKey).toBe('key-active');
      }
    });
  });

  describe('Credential Failure Handling', () => {
    it('should mark credential as failed after threshold', () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-1',
          failCount: 0,
          providerData: googleProvider,
        },
      ]);

      // 模拟 3 次失败
      reader.markCredentialFailed('cred1');
      reader.markCredentialFailed('cred1');
      reader.markCredentialFailed('cred1');

      // 应该被标记为 inactive
      const cred = reader['credentials'].find((c) => c.id === 'cred1');
      expect(cred?.status).toBe(CredentialStatus.INACTIVE);
    });

    it('should fallback to other credentials when one fails', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-1',
          providerData: googleProvider,
        },
        {
          id: 'cred2',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-2',
          providerData: googleProvider,
        },
      ]);

      // 标记第一个失效
      reader.markCredentialFailed('cred1');
      reader.markCredentialFailed('cred1');
      reader.markCredentialFailed('cred1');

      // 仍然可以获取到凭据（使用 cred2）
      for (let i = 0; i < 5; i++) {
        const cred = await reader.getAiCredential('http://pod/', 'google');
        expect(cred).not.toBeNull();
        expect(cred!.apiKey).toBe('key-2');
      }
    });

    it('should return null when all credentials fail', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-1',
          providerData: googleProvider,
        },
      ]);

      // 标记唯一的凭据失效
      reader.markCredentialFailed('cred1');
      reader.markCredentialFailed('cred1');
      reader.markCredentialFailed('cred1');

      const cred = await reader.getAiCredential('http://pod/', 'google');
      expect(cred).toBeNull();
    });
  });

  describe('Rate Limiting', () => {
    it('should skip rate-limited credentials', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-1',
          providerData: googleProvider,
        },
        {
          id: 'cred2',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-2',
          providerData: googleProvider,
        },
      ]);

      // 标记第一个限流
      reader.markCredentialRateLimited('cred1');

      // 只应该返回 cred2
      for (let i = 0; i < 5; i++) {
        const cred = await reader.getAiCredential('http://pod/', 'google');
        expect(cred).not.toBeNull();
        expect(cred!.apiKey).toBe('key-2');
      }
    });

    it('should restore rate-limited credential', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.RATE_LIMITED,
          apiKey: 'key-1',
          providerData: googleProvider,
        },
      ]);

      // 恢复
      reader.restoreCredential('cred1');

      const cred = await reader.getAiCredential('http://pod/', 'google');
      expect(cred).not.toBeNull();
      expect(cred!.apiKey).toBe('key-1');
    });
  });

  describe('Provider Switching', () => {
    it('should switch to different provider when current fails', async () => {
      reader.setCredentials([
        {
          id: 'cred-google',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.INACTIVE, // Google 失效
          apiKey: 'google-key',
          providerData: googleProvider,
        },
        {
          id: 'cred-openai',
          provider: 'providers.ttl#openai',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'openai-key',
          providerData: openaiProvider,
        },
      ]);

      // Google 不可用
      const googleCred = await reader.getAiCredential('http://pod/', 'google');
      expect(googleCred).toBeNull();

      // OpenAI 可用
      const openaiCred = await reader.getAiCredential('http://pod/', 'openai');
      expect(openaiCred).not.toBeNull();
      expect(openaiCred!.provider).toBe('openai');
    });
  });

  describe('Proxy Configuration', () => {
    it('should include proxy URL from provider', async () => {
      const googleWithProxy: MockProvider = {
        ...googleProvider,
        proxyUrl: 'http://proxy.example.com:8080',
      };

      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-1',
          providerData: googleWithProxy,
        },
      ]);

      const cred = await reader.getAiCredential('http://pod/', 'google');
      expect(cred).not.toBeNull();
      expect(cred!.proxyUrl).toBe('http://proxy.example.com:8080');
    });

    it('should use credential baseUrl over provider baseUrl', async () => {
      reader.setCredentials([
        {
          id: 'cred1',
          provider: 'providers.ttl#google',
          service: ServiceType.AI,
          status: CredentialStatus.ACTIVE,
          apiKey: 'key-1',
          baseUrl: 'https://custom.api.example.com', // 凭据级别覆盖
          providerData: googleProvider,
        },
      ]);

      const cred = await reader.getAiCredential('http://pod/', 'google');
      expect(cred).not.toBeNull();
      expect(cred!.baseUrl).toBe('https://custom.api.example.com');
    });
  });
});
