/**
 * AIConfig Schema - Pod 级别的 AI 配置（单例）
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

import { podTable, string, int, datetime, uri } from 'drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

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

export type AIConfigRow = typeof AIConfig.$inferSelect;
export type AIConfigInsert = typeof AIConfig.$inferInsert;
