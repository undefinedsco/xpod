import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingServiceImpl } from '../../src/ai/service/EmbeddingServiceImpl';
import type { ProviderRegistry, ProviderInfo } from '../../src/ai/service/ProviderRegistry';
import type { AiCredential } from '../../src/ai/service/types';
import { createEmbeddingModelPolicy } from '../../src/ai/service/EmbeddingModelPolicy';
import { createDefaultProviderRegistry } from '../../src/api/ai-gateway/providers/ProviderRegistry';
import { createGatewayEmbeddingModelCatalog } from '../../src/api/ai-gateway/models/GatewayEmbeddingModelCatalog';

// Mock the AI SDK
vi.mock('ai', () => ({
  embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  embedMany: vi.fn().mockImplementation(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((_, index) => [index + 0.1, index + 0.2]),
  })),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn().mockReturnValue({
    embedding: vi.fn().mockReturnValue({ modelId: 'test-model' }),
  }),
}));

describe('EmbeddingServiceImpl', () => {
  let service: EmbeddingServiceImpl;
  let mockRegistry: ProviderRegistry;

  const mockProvider: ProviderInfo = {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    embeddingModels: [{ id: 'text-embedding-3-small', dimension: 1536 }],
  };

  const mockCredential: AiCredential = {
    provider: 'openai',
    apiKey: 'sk-test-key',
    baseUrl: 'https://api.openai.com/v1',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockRegistry = {
      listProviders: vi.fn().mockResolvedValue([mockProvider]),
      getProvider: vi.fn().mockResolvedValue(mockProvider),
      getEmbeddingModel: vi.fn().mockImplementation(async (_providerId: string, modelId: string) => (
        mockProvider.embeddingModels.find((model) => model.id === modelId) ?? null
      )),
      getModelDimension: vi.fn().mockResolvedValue(1536),
    } as unknown as ProviderRegistry;

    service = new EmbeddingServiceImpl(mockRegistry);
  });

  describe('embed', () => {
    it('should generate embedding for single text', async () => {
      const { embed } = await import('ai');

      const result = await service.embed('Hello world', mockCredential, 'text-embedding-3-small');

      expect(result).toEqual([0.1, 0.2, 0.3]);
      expect(embed).toHaveBeenCalledWith({
        model: expect.anything(),
        value: 'Hello world',
      });
    });

    it('should use provider baseUrl', async () => {
      const { createOpenAI } = await import('@ai-sdk/openai');

      const credentialWithoutBaseUrl: AiCredential = {
        provider: 'openai',
        apiKey: 'sk-test-key',
      };

      await service.embed('test', credentialWithoutBaseUrl, 'text-embedding-3-small');

      expect(createOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.openai.com/v1',
        }),
      );
    });

    it('should throw error if no baseUrl found', async () => {
      const noBaseUrlRegistry = {
        ...mockRegistry,
        getProvider: vi.fn().mockResolvedValue({ ...mockProvider, baseUrl: undefined }),
      } as unknown as ProviderRegistry;

      const serviceWithNoBaseUrl = new EmbeddingServiceImpl(noBaseUrlRegistry);

      const credentialWithoutBaseUrl: AiCredential = {
        provider: 'openai',
        apiKey: 'sk-test-key',
      };

      await expect(
        serviceWithNoBaseUrl.embed('test', credentialWithoutBaseUrl, 'text-embedding-3-small'),
      ).rejects.toThrow('No baseUrl found for provider: openai');
    });
  });

  describe('embedBatch', () => {
    it('should generate embeddings for multiple texts', async () => {
      const { embedMany } = await import('ai');

      const result = await service.embedBatch(['Hello', 'World'], mockCredential, 'text-embedding-3-small');

      expect(result).toEqual([[0.1, 0.2], [1.1, 1.2]]);
      expect(embedMany).toHaveBeenCalledWith({
        model: expect.anything(),
        values: ['Hello', 'World'],
      });
    });

    it('should return empty array for empty input', async () => {
      const result = await service.embedBatch([], mockCredential, 'text-embedding-3-small');

      expect(result).toEqual([]);
    });

    it('should split provider-limited batches before calling the embedding API', async () => {
      const { embedMany } = await import('ai');
      const dashscopeProvider: ProviderInfo = {
        id: 'dashscope',
        name: 'DashScope',
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        embeddingModels: [{
          id: 'text-embedding-v4',
          dimension: 1024,
          maxBatchSize: 10,
        }],
      };
      mockRegistry.getProvider = vi.fn().mockResolvedValue(dashscopeProvider);
      mockRegistry.getEmbeddingModel = vi.fn().mockResolvedValue(dashscopeProvider.embeddingModels[0]);
      mockRegistry.getModelDimension = vi.fn().mockResolvedValue(1024);

      const texts = Array.from({ length: 25 }, (_, index) => `chunk-${index}`);
      const result = await service.embedBatch(texts, {
        provider: 'dashscope',
        apiKey: 'dashscope-key',
      }, 'text-embedding-v4');

      expect(result).toHaveLength(25);
      expect(embedMany).toHaveBeenCalledTimes(3);
      expect(embedMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
        values: texts.slice(0, 10),
      }));
      expect(embedMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        values: texts.slice(10, 20),
      }));
      expect(embedMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
        values: texts.slice(20),
      }));
    });
  });
});

describe('EmbeddingServiceImpl deployment policy', () => {
  let policyService: EmbeddingServiceImpl;
  let mockRegistry: ProviderRegistry;

  const credential: AiCredential = {
    provider: 'custom',
    apiKey: 'sk-test-key',
    baseUrl: 'https://byok.example/v1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry = {
      listProviders: vi.fn().mockResolvedValue([]),
      getProvider: vi.fn().mockResolvedValue({
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://byok.example/v1',
        embeddingModels: [],
      }),
      getEmbeddingModel: vi.fn().mockResolvedValue(null),
      getModelDimension: vi.fn().mockResolvedValue(null),
    } as unknown as ProviderRegistry;
  });

  it('never reaches the provider with a model the cloud catalog does not provide', async () => {
    const { embed } = await import('ai');
    policyService = new EmbeddingServiceImpl(mockRegistry, {
      policy: createEmbeddingModelPolicy({
        deployment: 'cloud',
        catalog: createGatewayEmbeddingModelCatalog(createDefaultProviderRegistry(), 'cloud'),
      }),
    });

    await expect(policyService.embed('hello', credential, 'acme-embed-v9'))
      .rejects.toMatchObject({ code: 'embedding_model_not_allowed' });
    await expect(policyService.embedBatch(['hello'], credential, 'acme-embed-v9'))
      .rejects.toMatchObject({ code: 'embedding_model_not_allowed' });
    expect(embed).not.toHaveBeenCalled();
  });

  it('allows arbitrary BYOK embedding models on a local deployment', async () => {
    policyService = new EmbeddingServiceImpl(mockRegistry, {
      policy: createEmbeddingModelPolicy({
        deployment: 'local',
        catalog: createGatewayEmbeddingModelCatalog(createDefaultProviderRegistry(), 'local'),
      }),
    });

    await expect(policyService.embed('hello', credential, 'acme-embed-v9'))
      .resolves.toEqual([0.1, 0.2, 0.3]);
  });
});

describe('EmbeddingServiceImpl endpoint authority', () => {
  let mockRegistry: ProviderRegistry;
  const podCredential: AiCredential = {
    provider: 'openai',
    apiKey: 'sk-byok',
    baseUrl: 'https://my-own-endpoint.example/v1',
    proxyUrl: 'http://127.0.0.1:7890',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry = {
      listProviders: vi.fn().mockResolvedValue([]),
      getProvider: vi.fn().mockResolvedValue({ id: 'openai', name: 'OpenAI', baseUrl: undefined, embeddingModels: [] }),
      getEmbeddingModel: vi.fn().mockResolvedValue(null),
      getModelDimension: vi.fn().mockResolvedValue(null),
    } as unknown as ProviderRegistry;
  });

  it('uses the provided catalog endpoint on cloud and drops the Pod endpoint and proxy', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const service = new EmbeddingServiceImpl(mockRegistry, {
      policy: createEmbeddingModelPolicy({
        deployment: 'cloud',
        catalog: createGatewayEmbeddingModelCatalog(createDefaultProviderRegistry(), 'cloud'),
      }),
    });

    await service.embed('hello', podCredential, 'text-embedding-3-small');

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://api.openai.com/v1',
    }));
    expect(createOpenAI).toHaveBeenCalledWith(expect.not.objectContaining({
      fetch: expect.anything(),
    }));
  });

  it('keeps the Pod endpoint and proxy on a local deployment', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const service = new EmbeddingServiceImpl(mockRegistry, {
      policy: createEmbeddingModelPolicy({
        deployment: 'local',
        catalog: createGatewayEmbeddingModelCatalog(createDefaultProviderRegistry(), 'local'),
      }),
    });

    await service.embed('hello', podCredential, 'whatever-embed');

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://my-own-endpoint.example/v1',
      fetch: expect.any(Function),
    }));
  });
});
