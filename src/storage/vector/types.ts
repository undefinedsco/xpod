/**
 * VectorStore - 向量存储类型定义
 *
 * 支持多模型版本管理和向量搜索
 */

/**
 * 向量记录
 */
export interface VectorRecord {
  id: number; // 关联 quints.rowid
  embedding: number[]; // 向量数据
  createdAt: number;
}

/**
 * 向量搜索选项
 */
export interface VectorSearchOptions {
  /** 搜索结果数量限制 */
  limit?: number;
  /** 相似度阈值 (0-1) */
  threshold?: number;
  /** 排除的 ID 列表（用于双读去重） */
  excludeIds?: Set<number>;
}

/**
 * 向量搜索结果
 */
export interface VectorSearchResult {
  id: number; // quints.rowid
  distance: number; // 距离（越小越相似）
  score: number; // 相似度分数 (0-1)
}
