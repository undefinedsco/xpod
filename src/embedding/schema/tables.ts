/**
 * Embedding Schema - Pod RDF 表定义
 */

import { podTable, string, int, datetime, uri, relations } from 'drizzle-solid';

// 命名空间配置
const AI_NAMESPACE = {
  prefix: 'ai',
  uri: 'https://vocab.xpod.dev/ai#',
};

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
 * Provider 表 - AI 供应商配置
 *
 * 存储位置: /settings/ai/providers.ttl
 *
 * RDF 示例:
 * <#google> a ai:Provider;
 *     ai:baseUrl "https://generativelanguage.googleapis.com/v1beta/openai";
 *     ai:hasModel </settings/ai/models.ttl#text-embedding-004>.
 */
export const providerTable = podTable(
  'provider',
  {
    id: string('id').primaryKey(),
    baseUrl: string('baseUrl'),
    proxyUrl: string('proxyUrl'),
    hasModel: uri('hasModel'), // 指向 Model 实体的 URI（可多个）
  },
  {
    base: '/settings/ai/providers.ttl',
    type: 'https://vocab.xpod.dev/ai#Provider',
    namespace: AI_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * Model 表 - AI 模型配置
 *
 * 存储位置: /settings/ai/models.ttl
 *
 * RDF 示例:
 * <#text-embedding-004> a ai:Model;
 *     ai:displayName "Google Text Embedding 004";
 *     ai:modelType "embedding";
 *     ai:dimension 768;
 *     ai:status "active";
 *     ai:isProvidedBy </settings/ai/providers.ttl#google>.
 *
 * 注：id 即为模型名（如 text-embedding-004），与供应商 API 对齐
 */
export const modelTable = podTable(
  'model',
  {
    id: string('id').primaryKey(), // 模型名，如 text-embedding-004
    displayName: string('displayName'),
    modelType: string('modelType'),
    isProvidedBy: uri('isProvidedBy'), // 指向 Provider 实体的 URI
    dimension: int('dimension'),
    status: string('status'),
    createdAt: datetime('createdAt'),
    updatedAt: datetime('updatedAt'),
  },
  {
    base: '/settings/ai/models.ttl',
    type: 'https://vocab.xpod.dev/ai#Model',
    namespace: AI_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * Model -> Provider 关系定义
 * 通过 isProvidedBy 字段关联到 Provider
 */
export const modelRelations = relations(modelTable, ({ one }) => ({
  provider: one(providerTable, {
    fields: [modelTable.isProvidedBy],
    references: [providerTable.id as any], // FIXME: drizzle-solid #issue - primaryKey 类型不兼容
  }),
}));

/**
 * Provider -> Model 关系定义
 * 通过 hasModel 字段关联到 Model（一对多）
 */
export const providerRelations = relations(providerTable, ({ many }) => ({
  models: many(modelTable, {
    fields: [providerTable.hasModel],
    references: [modelTable.id as any], // FIXME: drizzle-solid #issue - primaryKey 类型不兼容
  }),
}));
