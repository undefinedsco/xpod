/**
 * Agents 模块导出
 *
 * 统一的 AI Agent 执行框架。
 *
 * 支持的 AI 供应商（有完整 Agent SDK）：
 * - CodeBuddy: @tencent-ai/agent-sdk
 * - Claude: @anthropic-ai/claude-agent-sdk
 *
 * 所有执行器都实现 IAgentExecutor 接口，通过 AgentExecutorFactory 从 Pod 读取凭证创建。
 */

// 类型定义
export type {
  ExecutorType,
  AuthType,
  AiCredential,
  ProviderConfig,
  AuthInfo,
  ExecutorConfig,
  ExecuteResult,
  ExecuteMessage,
  ChatMessage,
  IAgentExecutor,
  BaseExecutorOptions,
  CodeBuddyConfig,
  CodeBuddyOptions,
} from './types';

// 执行器工厂
export { AgentExecutorFactory, agentExecutorFactory, SUPPORTED_EXECUTOR_TYPES } from './AgentExecutorFactory';

// 执行器实现（仅支持有完整 Agent SDK 的供应商）
export { CodeBuddyExecutor, CodeBuddyAuthError, createCodeBuddyExecutor } from './CodeBuddyExecutor';
export { ClaudeExecutor, ClaudeAuthenticationError, createClaudeExecutor } from './ClaudeExecutor';

// 抽象基类
export { BaseAgentExecutor } from './BaseAgentExecutor';

// Schema
export { AgentProvider, AgentProviderRelations, ExecutorType as ExecutorTypeEnum } from './schema/tables';
export { AgentConfig as AgentConfigTable, AgentStatus } from './schema/agent-config';

// Agent Manager
export { AgentManager, agentManager } from './AgentManager';
export type { AgentInstance, AgentConfig } from './AgentManager';

// IndexAgent
export { IndexAgent, indexAgent } from './IndexAgent';
export type { IndexLevel, IndexAgentOptions } from './IndexAgent';

// Agent Config (per-agent AGENT.md + .meta)
export { parseAgentMd, AgentMetaSchema, resolveAgentConfig } from './config';
export type {
  AgentFrontmatter,
  AgentMcpServerDef,
  AgentMetaRecord,
  ParsedAgentMd,
  ResolvedAgentConfig,
} from './config';
