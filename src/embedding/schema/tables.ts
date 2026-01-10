/**
 * Embedding Schema - Pod RDF 表定义
 */

import { podTable, string, int, datetime, uri, relations } from 'drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

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
 * AIConfig - Pod 级别的 AI 配置（单例）
 *
 * 存储位置: /settings/ai/config.ttl
 *
 * RDF 示例:
 * <#config> a udfs:AIConfig ;
 *     udfs:embeddingModel </settings/ai/models.ttl#text-embedding-004> ;
 *     udfs:migrationStatus "idle" ;
 *     udfs:previousModel </settings/ai/models.ttl#text-embedding-003> ;
 *     udfs:updatedAt "2024-01-15T10:30:00Z"^^xsd:dateTime .
 *
 * 说明：
 * - 全 Pod 只有一个 embedding 模型配置
 * - 更换模型时触发迁移，migrationStatus 变为 in_progress
 * - previousModel 记录迁移前的模型，用于双读策略
 */
export const AIConfig = podTable(
  'AIConfig',
  {
    id: string('id').primaryKey(),
    embeddingModel: uri('embeddingModel'),
    previousModel: uri('previousModel'),
    migrationStatus: string('migrationStatus'),
    migrationProgress: int('migrationProgress'),
    updatedAt: datetime('updatedAt'),
  },
  {
    base: '/settings/ai/config.ttl',
    type: UDFS.AIConfig,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * Provider - AI 供应商配置
 *
 * 存储位置: /settings/ai/providers.ttl
 *
 * RDF 示例:
 * <#google> a udfs:Provider ;
 *     udfs:displayName "Google AI" ;
 *     udfs:baseUrl "https://generativelanguage.googleapis.com/v1beta/openai" ;
 *     udfs:hasModel </settings/ai/models.ttl#text-embedding-004> .
 */
export const Provider = podTable(
  'Provider',
  {
    id: string('id').primaryKey(),
    displayName: string('displayName'),
    baseUrl: string('baseUrl'),
    proxyUrl: string('proxyUrl'),
    hasModel: uri('hasModel'),
  },
  {
    base: '/settings/ai/providers.ttl',
    type: UDFS.Provider,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * Model - AI 模型配置
 *
 * 存储位置: /settings/ai/models.ttl
 *
 * RDF 示例:
 * <#text-embedding-004> a udfs:Model ;
 *     udfs:displayName "Google Text Embedding 004" ;
 *     udfs:modelType "embedding" ;
 *     udfs:dimension 768 ;
 *     udfs:status "active" ;
 *     udfs:isProvidedBy </settings/ai/providers.ttl#google> .
 *
 * 注：id 即为模型名（如 text-embedding-004），与供应商 API 对齐
 */
export const Model = podTable(
  'Model',
  {
    id: string('id').primaryKey(),
    displayName: string('displayName'),
    modelType: string('modelType'),
    isProvidedBy: uri('isProvidedBy'),
    dimension: int('dimension'),
    status: string('status'),
    createdAt: datetime('createdAt'),
    updatedAt: datetime('updatedAt'),
  },
  {
    base: '/settings/ai/models.ttl',
    type: UDFS.Model,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * Model -> Provider 关系定义
 */
export const ModelRelations = relations(Model, ({ one }) => ({
  provider: one(Provider, {
    fields: [Model.isProvidedBy],
    references: [Provider.id as any],
  }),
}));

/**
 * Provider -> Model 关系定义
 */
export const ProviderRelations = relations(Provider, ({ many }) => ({
  models: many(Model, {
    fields: [Provider.hasModel],
    references: [Model.id as any],
  }),
}));

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
 * VectorStore - Container 级别的知识库配置
 *
 * 存储位置: /settings/ai/vector-stores.ttl
 *
 * RDF 示例:
 * <#vs_abc123> a udfs:VectorStore ;
 *     udfs:name "My Notes" ;
 *     udfs:container </notes/> ;
 *     udfs:chunkingStrategy "auto" ;
 *     udfs:status "completed" ;
 *     udfs:createdAt "2024-01-15T10:30:00Z"^^xsd:dateTime .
 */
export const VectorStore = podTable(
  'VectorStore',
  {
    id: string('id').primaryKey(),
    name: string('name'),
    container: uri('container'),
    chunkingStrategy: string('chunkingStrategy'),
    status: string('status'),
    createdAt: datetime('createdAt'),
    lastActiveAt: datetime('lastActiveAt'),
  },
  {
    base: '/settings/ai/vector-stores.ttl',
    type: UDFS.VectorStore,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * 文件索引状态
 */
export enum FileIndexStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * IndexedFile - 全局文件索引状态管理
 *
 * 存储位置: /settings/ai/indexed-files.ttl
 *
 * RDF 示例:
 * <#idx_abc123> a udfs:IndexedFile ;
 *     udfs:fileUrl </notes/hello.md> ;
 *     udfs:vectorId "123456789"^^xsd:integer ;
 *     udfs:chunkingStrategy "auto" ;
 *     udfs:status "completed" ;
 *     udfs:usageBytes "1024"^^xsd:integer ;
 *     udfs:indexedAt "2024-01-15T10:30:00Z"^^xsd:dateTime .
 */
export const IndexedFile = podTable(
  'IndexedFile',
  {
    id: string('id').primaryKey(),
    fileUrl: uri('fileUrl'),
    vectorId: int('vectorId'),
    chunkingStrategy: string('chunkingStrategy'),
    status: string('status'),
    usageBytes: int('usageBytes'),
    lastError: string('lastError'),
    indexedAt: datetime('indexedAt'),
  },
  {
    base: '/settings/ai/indexed-files.ttl',
    type: UDFS.IndexedFile,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

