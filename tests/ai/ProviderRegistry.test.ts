import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistryImpl } from '../../src/ai/service/ProviderRegistryImpl';

describe('ProviderRegistryImpl', () => {
  let registry: ProviderRegistryImpl;

  beforeEach(() => {
    registry = new ProviderRegistryImpl();
  });

  describe('listProviders', () => {
    it('should return all default providers', async () => {
      const providers = await registry.listProviders();

      expect(providers.length).toBeGreaterThan(0);
      expect(providers.map((p) => p.id)).toContain('openai');
      expect(providers.map((p) => p.id)).toContain('google');
      expect(providers.map((p) => p.id)).toContain('ollama');
    });

    it('should include provider metadata', async () => {
      const providers = await registry.listProviders();
      const openai = providers.find((p) => p.id === 'openai');

      expect(openai).toBeDefined();
      expect(openai!.name).toBe('OpenAI');
      expect(openai!.baseUrl).toBe('https://api.openai.com/v1');
      expect(openai!.embeddingModels.length).toBeGreaterThan(0);
    });
  });

  describe('getProvider', () => {
    it('should return provider by id', async () => {
      const provider = await registry.getProvider('openai');

      expect(provider).not.toBeNull();
      expect(provider!.id).toBe('openai');
      expect(provider!.name).toBe('OpenAI');
    });

    it('should return null for unknown provider', async () => {
      const provider = await registry.getProvider('unknown-provider');

      expect(provider).toBeNull();
    });

    it('should return google provider with correct baseUrl', async () => {
      const provider = await registry.getProvider('google');

      expect(provider).not.toBeNull();
      expect(provider!.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    });

    it('should return ollama provider with localhost baseUrl', async () => {
      const provider = await registry.getProvider('ollama');

      expect(provider).not.toBeNull();
      expect(provider!.baseUrl).toBe('http://localhost:11434/v1');
    });
  });

  describe('getModelDimension', () => {
    it('should return dimension for known model', async () => {
      const dimension = await registry.getModelDimension('openai', 'text-embedding-3-small');

      expect(dimension).toBe(1536);
    });

    it('should return dimension for large model', async () => {
      const dimension = await registry.getModelDimension('openai', 'text-embedding-3-large');

      expect(dimension).toBe(3072);
    });

    it('should return null for unknown model', async () => {
      const dimension = await registry.getModelDimension('openai', 'unknown-model');

      expect(dimension).toBeNull();
    });

    it('should return null for unknown provider', async () => {
      const dimension = await registry.getModelDimension('unknown', 'text-embedding-3-small');

      expect(dimension).toBeNull();
    });

    it('should return google model dimension', async () => {
      const dimension = await registry.getModelDimension('google', 'text-embedding-004');

      expect(dimension).toBe(768);
    });

    it('should return voyage model dimension', async () => {
      const dimension = await registry.getModelDimension('voyage', 'voyage-3');

      expect(dimension).toBe(1024);
    });

    it('should return ollama model dimension', async () => {
      const dimension = await registry.getModelDimension('ollama', 'nomic-embed-text');

      expect(dimension).toBe(768);
    });
  });

  describe('provider embedding models', () => {
    it('openai should have multiple embedding models', async () => {
      const provider = await registry.getProvider('openai');

      expect(provider!.embeddingModels.length).toBe(3);
      expect(provider!.embeddingModels.map((m) => m.id)).toContain('text-embedding-3-small');
      expect(provider!.embeddingModels.map((m) => m.id)).toContain('text-embedding-3-large');
      expect(provider!.embeddingModels.map((m) => m.id)).toContain('text-embedding-ada-002');
    });

    it('cohere should have multiple embedding models', async () => {
      const provider = await registry.getProvider('cohere');

      expect(provider!.embeddingModels.length).toBe(4);
    });

    it('deepseek should have no embedding models', async () => {
      const provider = await registry.getProvider('deepseek');

      expect(provider!.embeddingModels.length).toBe(0);
    });
  });
});
