/**
 * Agent Executor 类型定义
 *
 * 统一的 AI Agent 执行框架接口。
 * 供应商配置从 Pod 读取，不在代码中硬编码。
 */

/**
 * 通用 MCP Server 配置类型
 *
 * 这是一个宽松的类型定义，各个 Executor 会在内部转换为对应 SDK 的具体类型。
 * 支持的配置类型：
 * - stdio: { command: string, args?: string[], env?: Record<string, string> }
 * - sse: { type: 'sse', url: string, headers?: Record<string, string> }
 * - http: { type: 'http', url: string, headers?: Record<string, string> }
 * - sdk: { type: 'sdk', name: string, instance?: McpServer }
 */
export type McpServerConfig = {
  type?: 'stdio' | 'sse' | 'http' | 'sdk';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  name?: string;
  [key: string]: unknown;
};

/**
 * 执行器类型（SDK 类型）
 *
 * 只支持有完整 Agent SDK 的供应商：
 * - codebuddy: @tencent-ai/agent-sdk
 * - claude: @anthropic-ai/claude-agent-sdk
 *
 * 不支持的原因：
 * - OpenAI: 没有完整的 Agent SDK，Codex CLI 使用 MCP 不使用 ACP
 * - Gemini: 没有完整的 Agent SDK，CLI core 使用 MCP 不使用 ACP
 */
export type ExecutorType = 'codebuddy' | 'claude';

/**
 * 认证类型
 */
export type AuthType = 'api-key' | 'oidc';

/**
 * AI 凭证（从 Pod 读取）
 */
export interface AiCredential {
  /** 提供商 ID（对应 Pod 中的 provider URI fragment） */
  providerId: string;
  /** API Key */
  apiKey: string;
  /** 自定义 API 端点 */
  baseUrl?: string;
  /** 代理 URL */
  proxyUrl?: string;
  /** 项目 ID (Gemini Vertex AI) */
  projectId?: string;
  /** 组织 ID (OpenAI) */
  organizationId?: string;
}

/**
 * 供应商配置（从 Pod 读取）
 */
export interface ProviderConfig {
  /** 供应商 ID */
  id: string;
  /** 显示名称 */
  displayName: string;
  /** 执行器类型（SDK 类型） */
  executorType: ExecutorType;
  /** API 端点 */
  baseUrl?: string;
  /** 默认模型 URI */
  defaultModel?: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 认证信息
 */
export interface AuthInfo {
  /** 是否已认证 */
  authenticated: boolean;
  /** 认证类型 */
  authType: AuthType;
  /** 供应商 ID */
  providerId: string;
  /** 执行器类型 */
  executorType: ExecutorType;
  /** 过期时间 */
  expiresAt?: Date;
  /** 账户信息 */
  account?: {
    email?: string;
    name?: string;
  };
}

/**
 * 执行器配置（基础）
 */
export interface ExecutorConfig {
  /** Agent 名称 */
  name: string;
  /** Agent 描述 */
  description?: string;
  /** System prompt */
  systemPrompt: string;
  /** 模型名称 */
  model?: string;
  /** 最大输出 tokens */
  maxTokens?: number;
  /** 温度参数 (0-2) */
  temperature?: number;
  /** Top-P 参数 */
  topP?: number;
  /** 工作目录 */
  workingDirectory?: string;
  /** 可用工具列表 */
  tools?: string[];
  /** 允许的工具列表（自动允许，不需要权限确认） */
  allowedTools?: string[];
  /** 禁用的工具列表 */
  disallowedTools?: string[];
  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerConfig>;
  /** 最大轮数 */
  maxTurns?: number;
  /** 权限模式 */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
}

/**
 * CodeBuddy 扩展配置
 */
export interface CodeBuddyConfig extends ExecutorConfig {
  /** 工作目录（限制文件操作范围） */
  cwd?: string;
  /** 允许的工具列表 */
  allowedTools?: string[];
  /** 禁用的工具列表 */
  disallowedTools?: string[];
  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerConfig>;
  /** 最大轮数 */
  maxTurns?: number;
  /** 权限模式 */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
}

/**
 * CodeBuddy 执行选项
 */
export interface CodeBuddyOptions {
  /** Pod base URL */
  podBaseUrl?: string;
  /** OAuth access token（用于 MCP 访问 Pod） */
  accessToken?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 额外上下文 */
  context?: Record<string, unknown>;
}

/**
 * 执行结果（基础）
 */
export interface ExecuteResult {
  /** 是否成功 */
  success: boolean;
  /** 结果文本 */
  result?: string;
  /** 错误信息 */
  error?: string;
  /** 结构化输出（CodeBuddy 专用） */
  structuredOutput?: unknown;
  /** 使用统计 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  };
}

/**
 * 执行消息类型
 */
export type ExecuteMessage =
  | { type: 'system'; executorType: ExecutorType; model: string; tools?: string[] }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolName: string; toolInput: unknown }
  | { type: 'tool_result'; toolName: string; result: string }
  | { type: 'error'; error: string }
  | { type: 'done'; result: ExecuteResult };

/**
 * 聊天消息
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Agent 执行器接口
 *
 * 所有 AI 执行器都必须实现此接口。
 */
export interface IAgentExecutor {
  /** 执行器类型 */
  readonly executorType: ExecutorType;

  /** 供应商 ID */
  readonly providerId: string;

  /**
   * 获取认证类型
   */
  getAuthType(): AuthType;

  /**
   * 检查认证状态
   */
  checkAuthentication(): Promise<AuthInfo>;

  /**
   * 执行任务（流式）
   *
   * @param config 执行器配置
   * @param message 用户消息
   * @returns 异步迭代器，yield 执行过程中的消息
   */
  execute(config: ExecutorConfig, message: string): AsyncGenerator<ExecuteMessage>;

  /**
   * 执行任务并等待完成
   *
   * @param config 执行器配置
   * @param message 用户消息
   * @returns 执行结果
   */
  executeAndWait(config: ExecutorConfig, message: string): Promise<ExecuteResult>;

  /**
   * 多轮对话
   *
   * @param config 执行器配置
   * @param messages 对话历史
   * @returns 执行结果
   */
  chat(config: ExecutorConfig, messages: ChatMessage[]): Promise<ExecuteResult>;
}

/**
 * 执行器基类选项
 */
export interface BaseExecutorOptions {
  /** 供应商 ID */
  providerId: string;
  /** 凭证 */
  credential: AiCredential;
  /** 供应商配置（可选，用于覆盖默认值） */
  providerConfig?: Partial<ProviderConfig>;
}
