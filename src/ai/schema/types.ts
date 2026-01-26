/**
 * AI Schema 类型定义
 */

/**
 * 模型类型
 */
export enum ModelType {
  EMBEDDING = 'embedding',
  CHAT = 'chat',
  COMPLETION = 'completion',
}

/**
 * 模型状态
 */
export enum ModelStatus {
  ACTIVE = 'active',
  MIGRATING = 'migrating',
  DEPRECATED = 'deprecated',
}

/**
 * 迁移状态
 */
export enum MigrationStatus {
  IDLE = 'idle',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Vector Store 状态
 */
export enum VectorStoreStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

/**
 * Chunking 策略
 */
export enum ChunkingStrategy {
  AUTO = 'auto',
  STATIC = 'static',
}

/**
 * 文件索引状态
 */
export enum FileIndexStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}
