/**
 * Model Schema - AI 模型配置
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

import { podTable, string, int, datetime, uri, relations } from '@undefineds.co/drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';
import { Provider } from './provider';

/**
 * Model - 基础模型定义
 */
export const Model = podTable(
  'Model',
  {
    id: string('id').primaryKey(),
    displayName: string('displayName'),
    modelType: string('modelType'),
    isProvidedBy: uri('isProvidedBy'),
    dimension: int('dimension'),
    contextLength: int('contextLength'),
    maxOutputTokens: int('maxOutputTokens'),
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

export type ModelRow = typeof Model.$inferSelect;
export type ModelInsert = typeof Model.$inferInsert;

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
