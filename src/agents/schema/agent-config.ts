/**
 * Agent Config Schema - Pod RDF 表定义
 *
 * Agent 实例配置，指定使用哪个 Provider、system prompt 等
 *
 * 存储位置: /settings/ai/agents.ttl
 */

import { podTable, string, uri, int, datetime } from '@undefineds.co/drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

/**
 * AgentConfig - Agent 配置
 *
 * RDF 示例:
 * <#indexing> a udfs:AgentConfig ;
 *     udfs:displayName "Indexing Agent" ;
 *     udfs:description "文档索引 Agent，帮助用户的文件变得可检索" ;
 *     udfs:provider </settings/ai/agent-providers.ttl#codebuddy> ;
 *     udfs:model </settings/ai/models.ttl#glm-4.7> ;
 *     udfs:systemPrompt "你是 IndexAgent..." ;
 *     udfs:maxTurns "20" ;
 *     udfs:enabled "true" .
 *
 * 说明：
 * - provider 指向 AgentProvider，决定用哪个 Executor
 * - model 可以覆盖 provider 的 defaultModel
 * - systemPrompt 是 Agent 的核心 prompt
 */
export const AgentConfig = podTable(
  'AgentConfig',
  {
    id: string('id').primaryKey(),
    displayName: string('displayName'),
    description: string('description'),
    provider: uri('provider'),
    model: uri('model'),
    systemPrompt: string('systemPrompt'),
    maxTurns: int('maxTurns'),
    timeout: int('timeout'),
    enabled: string('enabled'),
  },
  {
    base: '/settings/ai/agents.ttl',
    type: UDFS.AgentConfig,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * AgentStatus - Agent 运行状态
 *
 * 存储位置: /settings/ai/agent-status.ttl
 *
 * RDF 示例:
 * <#indexing> a udfs:AgentStatus ;
 *     udfs:agentId "indexing" ;
 *     udfs:status "running" ;
 *     udfs:startedAt "2026-01-10T10:00:00Z"^^xsd:dateTime ;
 *     udfs:lastActivityAt "2026-01-10T10:05:00Z"^^xsd:dateTime ;
 *     udfs:currentTaskId "task-123" .
 */
export const AgentStatus = podTable(
  'AgentStatus',
  {
    id: string('id').primaryKey(),
    agentId: string('agentId'),
    status: string('status'),
    startedAt: datetime('startedAt'),
    lastActivityAt: datetime('lastActivityAt'),
    currentTaskId: string('currentTaskId'),
    errorMessage: string('errorMessage'),
  },
  {
    base: '/settings/ai/agent-status.ttl',
    type: UDFS.AgentStatus,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

