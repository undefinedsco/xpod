/**
 * Agent Schema - Pod RDF 表定义
 *
 * AgentProvider 继承 Provider，添加 executorType 属性
 */

import { podTable, string, uri, relations } from '@undefineds.co/drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';
import { Model } from '../../ai/schema/model';

/**
 * 执行器类型（SDK 类型）
 */
export enum ExecutorType {
  CODEBUDDY = 'codebuddy',
  GEMINI = 'gemini',
  CLAUDE = 'claude',
  OPENAI = 'openai',
}

/**
 * AgentProvider - Agent 供应商配置
 *
 * 继承 Provider 类，添加 executorType 属性
 *
 * 存储位置: /settings/ai/agent-providers.ttl
 *
 * RDF 示例:
 * <#anthropic> a udfs:AgentProvider ;
 *     udfs:displayName "Anthropic Claude" ;
 *     udfs:executorType "claude" ;
 *     udfs:baseUrl "https://api.anthropic.com" ;
 *     udfs:defaultModel </settings/ai/models.ttl#claude-sonnet-4> ;
 *     udfs:enabled "true" .
 *
 * 说明：
 * - AgentProvider 是 Provider 的子类
 * - executorType 指定使用哪个 SDK：codebuddy, gemini, claude, openai
 * - defaultModel 是 URI 引用到 Model 实体
 */
export const AgentProvider = podTable(
  'AgentProvider',
  {
    id: string('id').primaryKey(),
    displayName: string('displayName'),
    executorType: string('executorType'),
    baseUrl: string('baseUrl'),
    defaultModel: uri('defaultModel'),
    enabled: string('enabled'),
  },
  {
    base: '/settings/ai/agent-providers.ttl',
    type: UDFS.AgentProvider,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * AgentProvider -> Model 关系定义
 */
export const AgentProviderRelations = relations(AgentProvider, ({ one }) => ({
  model: one(Model, {
    fields: [AgentProvider.defaultModel],
    references: [Model.id as any],
  }),
}));

