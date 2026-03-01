import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { VercelChatService } from '../../src/api/service/VercelChatService';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';

describe('VercelChatService provider config fallback', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['DEFAULT_API_KEY', 'DEFAULT_PROVIDER', 'DEFAULT_API_BASE', 'DEFAULT_MODEL'] as const;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function createService(config?: { apiKey?: string; baseUrl?: string; proxyUrl?: string; credentialId?: string }) {
    const store = {
      getAiConfig: vi.fn().mockResolvedValue(config),
    } as unknown as PodChatKitStore;
    return new VercelChatService(store);
  }

  it('uses pod config first', async () => {
    const service = createService({
      apiKey: 'pod-key',
      baseUrl: 'https://pod.example.com/v1',
      credentialId: 'cred-1',
    });

    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: { type: 'solid', webId: 'http://localhost:3310/test/profile/card#me' } });

    expect(result.baseURL).toBe('https://pod.example.com/v1');
    expect(result.apiKey).toBe('pod-key');
    expect(result.credentialId).toBe('cred-1');
  });

  it('falls back to DEFAULT_API_BASE platform Provider', async () => {
    process.env.DEFAULT_API_BASE = 'https://platform.example.com/v1';
    process.env.DEFAULT_API_KEY = 'platform-key';

    const service = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: { type: 'solid', webId: 'http://localhost:3310/test/profile/card#me' } });

    expect(result.baseURL).toBe('https://platform.example.com/v1');
    expect(result.apiKey).toBe('platform-key');
  });

  it('returns null when neither pod config nor DEFAULT_API_BASE exists', async () => {
    const service = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: { type: 'solid', webId: 'http://localhost:3310/test/profile/card#me' } });

    expect(result).toBeNull();
  });

  it('throws model_not_configured for responses when no provider config', async () => {
    const service = createService(undefined);
    await expect(
      service.responses({ model: 'xpod-default', input: 'hello' }, {
        type: 'solid',
        webId: 'http://localhost:3310/test/profile/card#me',
        token: 'test-token',
      } as any),
    ).rejects.toThrow('No AI provider configured');
  });

  it('throws model_not_configured for messages when no provider config', async () => {
    const service = createService(undefined);
    await expect(
      service.messages({ model: 'xpod-default', content: 'hello' }, {
        type: 'solid',
        webId: 'http://localhost:3310/test/profile/card#me',
        token: 'test-token',
      } as any),
    ).rejects.toThrow('No AI provider configured');
  });

  it('uses DEFAULT_API_BASE with empty key when DEFAULT_API_KEY is not set', async () => {
    process.env.DEFAULT_API_BASE = 'https://platform.example.com/v1';

    const service = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: { type: 'solid', webId: 'http://localhost:3310/test/profile/card#me' } });

    expect(result).not.toBeNull();
    expect(result.baseURL).toBe('https://platform.example.com/v1');
    expect(result.apiKey).toBe('');
  });
});
