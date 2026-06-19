/**
 * Provider Registry 实现
 *
 * 管理 embedding 供应商和模型元信息
 */

import { ProviderRegistry } from './ProviderRegistry';
import type { EmbeddingModelInfo, ProviderInfo } from './ProviderRegistry';
import { DEFAULT_EMBEDDING_BASE_URL, DEFAULT_EMBEDDING_MODEL_ID, DEFAULT_EMBEDDING_PROVIDER_ID } from './defaultEmbeddingProfile';

/**
 * 默认供应商配置
 */
const DEFAULT_PROVIDERS: ProviderInfo[] = [
  {
    id: DEFAULT_EMBEDDING_PROVIDER_ID,
    name: 'DashScope',
    baseUrl: DEFAULT_EMBEDDING_BASE_URL,
    aliases: ['qwen', 'alibaba', 'dashscope-cn'],
    defaultEmbeddingModel: DEFAULT_EMBEDDING_MODEL_ID,
    embeddingModels: [
      { id: DEFAULT_EMBEDDING_MODEL_ID, dimension: 1024, maxTokens: 8192, maxBatchSize: 10 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    embeddingModels: [
      { id: 'text-embedding-3-small', dimension: 1536 },
      { id: 'text-embedding-3-large', dimension: 3072 },
      { id: 'text-embedding-ada-002', dimension: 1536 },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    embeddingModels: [
      { id: 'text-embedding-004', dimension: 768 },
      { id: 'embedding-001', dimension: 768 },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    embeddingModels: [{ id: 'mistral-embed', dimension: 1024 }],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.ai/v1',
    embeddingModels: [
      { id: 'embed-english-v3.0', dimension: 1024 },
      { id: 'embed-multilingual-v3.0', dimension: 1024 },
      { id: 'embed-english-light-v3.0', dimension: 384 },
      { id: 'embed-multilingual-light-v3.0', dimension: 384 },
    ],
  },
  {
    id: 'voyage',
    name: 'Voyage AI',
    baseUrl: 'https://api.voyageai.com/v1',
    embeddingModels: [
      { id: 'voyage-3', dimension: 1024 },
      { id: 'voyage-3-lite', dimension: 512 },
      { id: 'voyage-code-3', dimension: 1024 },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    embeddingModels: [{ id: 'embedding-2', dimension: 1024 }],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    embeddingModels: [],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    embeddingModels: [
      { id: 'nomic-embed-text', dimension: 768 },
      { id: 'mxbai-embed-large', dimension: 1024 },
      { id: 'all-minilm', dimension: 384 },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    embeddingModels: [],
  },
];

export class ProviderRegistryImpl extends ProviderRegistry {
  private providers: Map<string, ProviderInfo>;
  private aliases: Map<string, string>;

  constructor() {
    super();
    this.providers = new Map();
    this.aliases = new Map();
    for (const provider of DEFAULT_PROVIDERS) {
      this.providers.set(provider.id, provider);
      for (const alias of provider.aliases ?? []) {
        this.aliases.set(alias, provider.id);
      }
    }
  }

  public override async listProviders(): Promise<ProviderInfo[]> {
    return Array.from(this.providers.values());
  }

  public override async getProvider(providerId: string): Promise<ProviderInfo | null> {
    return this.providers.get(this.normalizeProviderId(providerId)) ?? null;
  }

  public override async getEmbeddingModel(providerId: string, modelId: string): Promise<EmbeddingModelInfo | null> {
    const provider = await this.getProvider(providerId);
    if (!provider) return null;

    return provider.embeddingModels.find((model) => model.id === modelId) ?? null;
  }

  public override async getModelDimension(providerId: string, modelId: string): Promise<number | null> {
    const model = await this.getEmbeddingModel(providerId, modelId);
    return model?.dimension ?? null;
  }

  private normalizeProviderId(providerId: string): string {
    const normalized = providerId.trim().toLowerCase();
    return this.aliases.get(normalized) ?? normalized;
  }
}
