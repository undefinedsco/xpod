import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/api/chatkit/default-agent', () => ({
  isDefaultAgentAvailable: () => true,
  runDefaultAgent: vi.fn(async () => ({ success: true, content: 'default-agent-reply' })),
  streamDefaultAgent: vi.fn(),
}));
import { VercelChatService } from '../../src/api/service/VercelChatService';
import type { PodChatKitStore } from '../../src/api/chatkit/pod-store';

describe('VercelChatService provider config fallback', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['DEFAULT_API_KEY', 'DEFAULT_PROVIDER', 'DEFAULT_BASE_URL', 'DEFAULT_MODEL'] as const;

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

  it('falls back to DEFAULT_API_KEY when pod config is missing', async () => {
    process.env.DEFAULT_API_KEY = 'default-key';
    process.env.DEFAULT_PROVIDER = 'openrouter';

    const service = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: { type: 'solid', webId: 'http://localhost:3310/test/profile/card#me' } });

    expect(result.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(result.apiKey).toBe('default-key');
  });

  it('returns null when neither pod config nor DEFAULT_API_KEY exists', async () => {
    const service = createService(undefined);
    const getProviderConfig = (service as any).getProviderConfig.bind(service);
    const result = await getProviderConfig({ auth: { type: 'solid', webId: 'http://localhost:3310/test/profile/card#me' } });

    expect(result).toBeNull();
  });


  it('falls back to DefaultAgent for responses when no provider config', async () => {
    const service = createService(undefined);
    const response = await service.responses({ model: 'xpod-default', input: 'hello' }, {
      type: 'solid',
      webId: 'http://localhost:3310/test/profile/card#me',
      token: 'test-token',
    } as any);

    expect(response.object).toBe('response');
    expect(response.output[0].content[0].text).toContain('default-agent-reply');
  });

  it('falls back to DefaultAgent for messages when no provider config', async () => {
    const service = createService(undefined);
    const response = await service.messages({ model: 'xpod-default', content: 'hello' }, {
      type: 'solid',
      webId: 'http://localhost:3310/test/profile/card#me',
      token: 'test-token',
    } as any);

    expect(response.type).toBe('message');
    expect(response.content[0].text).toContain('default-agent-reply');
  });

});
