import type { AiCredential } from './types';

/**
 * Embedding 服务抽象基类
 */
export abstract class EmbeddingService {
  public abstract embed(text: string, credential: AiCredential, modelId: string): Promise<number[]>;
  public abstract embedBatch(texts: string[], credential: AiCredential, modelId: string): Promise<number[][]>;
}
