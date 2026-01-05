import type { VectorRecord, VectorSearchOptions, VectorSearchResult } from './types';

/**
 * 计算 modelId 的 short hash
 */
export function hashModelId(modelId: string): string {
  let hash = 0;
  for (let i = 0; i < modelId.length; i++) {
    const char = modelId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

/**
 * 向量存储抽象基类
 * 
 * 提供公共工具方法，子类实现具体的数据库操作
 */
export abstract class VectorStore {
  /** 默认向量维度 */
  protected readonly defaultDimension: number = 768;

  // ============================================
  // 抽象方法 - 子类必须实现
  // ============================================

  public abstract open(): Promise<void>;
  public abstract close(): Promise<void>;
  public abstract ensureVectorTable(modelId: string): Promise<void>;
  public abstract dropVectorTable(modelId: string): Promise<void>;
  public abstract hasVectorTable(modelId: string): Promise<boolean>;
  public abstract listVectorTables(): Promise<string[]>;
  public abstract upsertVector(modelId: string, id: number, embedding: number[]): Promise<void>;
  public abstract batchUpsertVectors(modelId: string, records: { id: number; embedding: number[] }[]): Promise<void>;
  public abstract getVector(modelId: string, id: number): Promise<VectorRecord | null>;
  public abstract deleteVector(modelId: string, id: number): Promise<void>;
  public abstract batchDeleteVectors(modelId: string, ids: number[]): Promise<void>;
  public abstract search(modelId: string, queryEmbedding: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  public abstract countVectors(modelId: string): Promise<number>;
  public abstract getVectorIds(modelId: string, options?: { limit?: number; afterId?: number }): Promise<number[]>;

  // ============================================
  // 公共工具方法
  // ============================================

  /**
   * 将各种时间格式转换为 Unix 时间戳（秒）
   */
  protected toTimestamp(value: any): number {
    if (value instanceof Date) {
      return Math.floor(value.getTime() / 1000);
    }
    if (typeof value === 'number') {
      return value;
    }
    return Math.floor(Date.now() / 1000);
  }

  /**
   * 将 distance 转换为 score [0, 1]
   */
  protected distanceToScore(distance: number): number {
    return Math.max(0, Math.min(1, 1 - distance));
  }
}
