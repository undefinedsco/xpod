/**
 * Embedding 模型信息
 */
export interface EmbeddingModelInfo {
  id: string;
  dimension: number;
  maxTokens?: number;
  maxBatchSize?: number;
}

/**
 * 供应商信息
 */
export interface ProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  proxyUrl?: string;
  aliases?: string[];
  defaultEmbeddingModel?: string;
  embeddingModels: EmbeddingModelInfo[];
}

/**
 * 供应商注册表抽象基类
 */
export abstract class ProviderRegistry {
  abstract listProviders(): Promise<ProviderInfo[]>;
  abstract getProvider(providerId: string): Promise<ProviderInfo | null>;
  abstract getEmbeddingModel(providerId: string, modelId: string): Promise<EmbeddingModelInfo | null>;
  abstract getModelDimension(providerId: string, modelId: string): Promise<number | null>;
}
