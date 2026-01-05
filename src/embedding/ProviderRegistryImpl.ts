/**
 * Provider Registry 实现
 *
 * 管理 embedding 供应商和模型元信息
 */

import { ProviderRegistry } from './ProviderRegistry';
import type { ProviderInfo } from './ProviderRegistry';

/**
 * 默认供应商配置
 */
const DEFAULT_PROVIDERS: ProviderInfo[] = [
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

  constructor() {
    super();
    this.providers = new Map();
    for (const provider of DEFAULT_PROVIDERS) {
      this.providers.set(provider.id, provider);
    }
  }

  public override async listProviders(): Promise<ProviderInfo[]> {
    return Array.from(this.providers.values());
  }

  public override async getProvider(providerId: string): Promise<ProviderInfo | null> {
    return this.providers.get(providerId) ?? null;
  }

  public override async getModelDimension(providerId: string, modelId: string): Promise<number | null> {
    const provider = this.providers.get(providerId);
    if (!provider) return null;

    const model = provider.embeddingModels.find((m) => m.id === modelId);
    return model?.dimension ?? null;
  }
}