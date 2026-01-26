import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingServiceImpl } from '../../src/ai/service/EmbeddingServiceImpl';
import type { ProviderRegistry, ProviderInfo } from '../../src/ai/service/ProviderRegistry';
import type { AiCredential } from '../../src/ai/service/types';

// Mock the AI SDK
vi.mock('ai', () => ({
  embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  embedMany: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
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

    it('should use credential baseUrl over provider baseUrl', async () => {
      const { createOpenAI } = await import('@ai-sdk/openai');

      const customCredential: AiCredential = {
        ...mockCredential,
        baseUrl: 'https://custom.api.com/v1',
      };

      await service.embed('test', customCredential, 'text-embedding-3-small');

      expect(createOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://custom.api.com/v1',
        }),
      );
    });

    it('should fall back to provider baseUrl if credential has none', async () => {
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

      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
      expect(embedMany).toHaveBeenCalledWith({
        model: expect.anything(),
        values: ['Hello', 'World'],
      });
    });

    it('should return empty array for empty input', async () => {
      const result = await service.embedBatch([], mockCredential, 'text-embedding-3-small');

      expect(result).toEqual([]);
    });
  });
});
