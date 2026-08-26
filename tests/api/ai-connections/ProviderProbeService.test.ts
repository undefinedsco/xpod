import { describe, expect, it, vi } from 'vitest';
import { ProviderProbeService } from '../../../src/api/ai-connections/ProviderProbeService';
import { createDefaultProviderRegistry } from '../../../src/api/ai-connections/providers/ProviderRegistry';

describe('ProviderProbeService', () => {
  it('uses only the request credential and never accepts Pod identity or authority', async () => {
    const fetchModels = vi.fn(async () => [{ id: 'gpt-test' }]);
    const service = new ProviderProbeService({
      registry: createDefaultProviderRegistry(),
      modelAdapters: [{ provider: 'openai', fetch: fetchModels }],
      quotaAdapters: [],
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });

    await expect(service.discoverModels({
      provider: 'openai',
      apiKey: 'user-provider-key',
      baseUrl: 'https://api.openai.com/v1/',
    })).resolves.toEqual({
      provider: 'openai',
      models: [{ id: 'gpt-test' }],
      observedAt: '2026-08-25T00:00:00.000Z',
      source: 'openai:/models',
    });

    expect(fetchModels).toHaveBeenCalledWith({
      credential: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      },
      secret: { apiKey: 'user-provider-key' },
      signal: undefined,
    });
  });

  it('rejects unlisted or non-HTTPS provider endpoints before calling the adapter', async () => {
    const fetchModels = vi.fn();
    const service = new ProviderProbeService({
      registry: createDefaultProviderRegistry(),
      modelAdapters: [{ provider: 'openai', fetch: fetchModels }],
      quotaAdapters: [],
    });

    await expect(service.discoverModels({
      provider: 'openai',
      apiKey: 'user-provider-key',
      baseUrl: 'http://127.0.0.1:3000/v1',
    })).rejects.toThrow('provider_base_url_not_allowed');
    await expect(service.discoverModels({
      provider: 'openai',
      apiKey: 'user-provider-key',
      baseUrl: 'https://attacker.example/v1',
    })).rejects.toThrow('provider_base_url_not_allowed');
    await expect(service.discoverModels({
      provider: 'openai',
      apiKey: 'user-provider-key',
      baseUrl: 'not-a-url',
    })).rejects.toThrow('provider_base_url_not_allowed');
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('allows an explicit HTTP self-hosted provider endpoint in local edition', async () => {
    const fetchModels = vi.fn(async () => [{ id: 'local-model' }]);
    const service = new ProviderProbeService({
      registry: createDefaultProviderRegistry(),
      modelAdapters: [{ provider: 'openai', fetch: fetchModels }],
      quotaAdapters: [],
      edition: 'local',
    });

    await expect(service.discoverModels({
      provider: 'openai',
      apiKey: 'local-provider-key',
      baseUrl: 'http://127.0.0.1:52801/v1/',
    })).resolves.toMatchObject({
      provider: 'openai',
      models: [{ id: 'local-model' }],
    });
    expect(fetchModels).toHaveBeenCalledWith(expect.objectContaining({
      credential: {
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:52801/v1',
      },
      secret: { apiKey: 'local-provider-key' },
    }));
  });

  it('validates quota credentials before calling the adapter', async () => {
    const fetchQuota = vi.fn();
    const service = new ProviderProbeService({
      registry: createDefaultProviderRegistry(),
      modelAdapters: [],
      quotaAdapters: [{ provider: 'kimi', fetch: fetchQuota }],
    });

    await expect(service.quota({
      provider: 'kimi',
      apiKey: ' ',
    })).rejects.toThrow('provider_api_key_required');
    await expect(service.quota({
      provider: 'kimi',
      apiKey: 'user-provider-key',
      baseUrl: 'https://attacker.example/v1',
    })).rejects.toThrow('provider_base_url_not_allowed');
    expect(fetchQuota).not.toHaveBeenCalled();
  });
});
