import { linxSchema } from '@undefineds.co/models';
import { createAgentSchema } from './create-agent-schema';

/**
 * AgentConfig - Agent 配置
 *
 * RDF 示例:
 * <#indexing> a udfs:AgentConfig ;
 *     foaf:name "Indexing Agent" ;
 *     udfs:description "文档索引 Agent，帮助用户的文件变得可检索" ;
 *     udfs:provider </settings/ai/providers.ttl#anthropic> ;
 *     udfs:runtimeKind "claude" ;
 *     udfs:model </settings/ai/models.ttl#glm-4.7> ;
 *     udfs:systemPrompt "你是 IndexAgent..." ;
 *     udfs:maxTurns "20" ;
 *     udfs:enabled "true" .
 *
 * 说明：
 * - provider 指向通用 Provider，提供 baseUrl/defaultModel 等 Pod 配置
 * - runtimeKind 决定使用哪个 Agent Executor
 * - model 可以覆盖 provider 的 defaultModel
 * - instructions / systemPrompt 是 Agent 的核心提示词字段
 */
const agentConfigSchema = createAgentSchema({ nameRequired: false });

export const AgentConfig = agentConfigSchema.table('AgentConfig', {
  base: '/settings/ai/agents.ttl',
  subjectTemplate: '#{id}',
}) as any;

export const AgentStatus = linxSchema.agentStatusTable as any;
