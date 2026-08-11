/**
 * Default Agent
 *
 * 基于 Claude Code SDK 的默认 AI Agent，用于：
 * 1. 用户未配置 AI 时的降级方案
 * 2. 帮助用户完成初始化配置
 * 3. 识别并收纳结构化数据到 Pod
 */

import { getLoggerFor } from 'global-logger-factory';
import {
  projectAnthropicCompatibleEnv,
  requireAiConnectionsRuntimeConfig,
  sanitizeRuntimeEnv,
} from '../../runtime/safe-env';

/**
 * CC SDK 运行时消息结构（避免直接静态导入 ESM 包导致 CJS 启动崩溃）
 */
type ClaudeAssistantBlock = { type: 'text'; text: string } | { type: string; [key: string]: unknown };
type ClaudeAssistantMessage = { type: 'assistant'; message: { content: ClaudeAssistantBlock[] | unknown } };
type ClaudeResultMessage = { type: 'result'; subtype?: string; result?: string; total_cost_usd?: number };
type ClaudeQueryMessage = ClaudeAssistantMessage | ClaudeResultMessage | { type: string; [key: string]: unknown };
type ClaudeQuery = (args: unknown) => AsyncIterable<ClaudeQueryMessage>;

let cachedClaudeQuery: ClaudeQuery | undefined;

async function loadClaudeQuery(): Promise<ClaudeQuery> {
  if (cachedClaudeQuery) {
    return cachedClaudeQuery;
  }

  // Keep native dynamic import so CJS build can load ESM-only SDK lazily.
  const mod = await import('@anthropic-ai/claude-agent-sdk') as Record<string, unknown>;
  const maybeQuery = (mod as { query?: unknown }).query;

  if (typeof maybeQuery !== 'function') {
    throw new Error('Invalid Claude Agent SDK: query() not found');
  }

  cachedClaudeQuery = maybeQuery as ClaudeQuery;
  return cachedClaudeQuery;
}

const logger = getLoggerFor('DefaultAgent');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAssistantMessage(value: ClaudeQueryMessage): value is ClaudeAssistantMessage {
  return value.type === 'assistant' && isObject((value as { message?: unknown }).message);
}

function isResultMessage(value: ClaudeQueryMessage): value is ClaudeResultMessage {
  return value.type === 'result';
}

function getAssistantText(value: ClaudeQueryMessage): string {
  if (!isAssistantMessage(value)) {
    return '';
  }

  const content = value.message.content;
  if (!Array.isArray(content)) {
    return '';
  }

  let text = '';
  for (const block of content) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }

  return text;
}

/**
 * Default Agent 配置
 */
export interface DefaultAgentConfig {
  /** Claude Code 可执行文件路径 */
  claudeCodePath?: string;
  /** AI Connection invocation endpoint/key */
  connection?: DefaultAgentAiConnections;
  /** 模型 */
  model?: string;
}

export interface DefaultAgentAiConnections {
  /** Xpod AI Connection endpoint, usually the current /v1 gateway URL */
  baseUrl: string;
  /** Solid client-credentials API key for this invocation */
  apiKey: string;
}

/**
 * Default Agent 会话上下文
 */
export interface DefaultAgentContext {
  /** 用户的访问令牌 */
  solidToken: string;
  /** 用户的 Pod 基础 URL */
  podBaseUrl: string;
  /** 用户 WebID */
  webId?: string;
}

/**
 * Default Agent 响应
 */
export interface DefaultAgentResponse {
  /** 响应内容 */
  content: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
  /** 使用的模型 */
  model?: string;
  /** 花费（USD） */
  costUsd?: number;
}

export interface DefaultAgentRunOptions {
  timeout?: number;
  maxTurns?: number;
  connection?: DefaultAgentAiConnections;
  model?: string;
}

/**
 * 获取 Default Agent 配置
 */
export function getDefaultAgentConfig(input: {
  connection?: DefaultAgentAiConnections;
  model?: string;
} = {}): DefaultAgentConfig {
  return {
    claudeCodePath: process.env.CLAUDE_CODE_PATH || undefined,
    connection: input.connection,
    model: input.model,
  };
}

/**
 * 检查 Default Agent 是否可用
 */
export function isDefaultAgentAvailable(input: {
  connection?: DefaultAgentAiConnections;
} = {}): boolean {
  return Boolean(input.connection?.baseUrl?.trim() && input.connection?.apiKey?.trim());
}

/**
 * Default Agent System Prompt
 */
const DEFAULT_AGENT_SYSTEM_PROMPT = `你是 Xpod Default Agent，运行在用户的 Solid Pod 上。

## 你的职责
1. 帮助用户完成初始化配置（特别是 AI 配置）
2. 识别用户消息中的结构化数据并存储到 Pod
3. 按语义网规范组织数据

## 数据收纳能力
当用户的消息中包含以下类型的信息时，识别并保存：

### AI 配置（最重要）
- Provider、Model、Base URL 与认证方式
- 引导用户通过 AI Connection 的 Connect UI/API 完成授权或录入凭证
- 密钥由 SecretCell 安全保存；不要要求用户在聊天中发送密钥，也不要把明文凭证写入 Pod 资源

### 联系人
- 姓名、邮箱、电话、WebID
- 存储位置：/contacts/<name>.ttl
- 词汇表：vCard (http://www.w3.org/2006/vcard/ns#)

### 日程/事件
- 时间、地点、标题
- 存储位置：/calendar/events.ttl
- 词汇表：schema:Event

### 笔记
- 标题、内容
- 存储位置：/notes/<title>.ttl
- 词汇表：schema:Note

## Pod 访问方式
使用 curl 访问用户 Pod，鉴权信息已在环境变量中：

### 读取资源
\`\`\`bash
curl -s -H "Authorization: Bearer $SOLID_TOKEN" "$POD_BASE_URL<path>"
\`\`\`

### 写入 Turtle 数据
\`\`\`bash
curl -s -X PUT \\
  -H "Authorization: Bearer $SOLID_TOKEN" \\
  -H "Content-Type: text/turtle" \\
  -d '<turtle-content>' \\
  "$POD_BASE_URL<path>"
\`\`\`

### 创建容器（目录）
\`\`\`bash
curl -s -X PUT \\
  -H "Authorization: Bearer $SOLID_TOKEN" \\
  -H "Content-Type: text/turtle" \\
  -H "Link: <http://www.w3.org/ns/ldp#BasicContainer>; rel=\\"type\\"" \\
  "$POD_BASE_URL<path>/"
\`\`\`

## 语义网规范
使用 Turtle 格式，优先使用标准词汇表。

### 联系人示例
\`\`\`turtle
@prefix vcard: <http://www.w3.org/2006/vcard/ns#> .

<#person> a vcard:Individual ;
  vcard:fn "张三" ;
  vcard:hasEmail <mailto:zhangsan@example.com> ;
  vcard:hasTelephone <tel:+8613800138000> .
\`\`\`

## 交互原则
1. 识别到结构化数据时，直接保存（不需要确认）
2. 保存成功后简短告知用户
3. 如果是 AI 配置，引导用户打开 AI Connection 的 Connect UI 或调用 Connect API；不要代为收集或写入明文密钥
4. 其他情况正常对话即可
5. 回复使用中文`;


function buildClaudeEnv(config: DefaultAgentConfig, context: DefaultAgentContext): NodeJS.ProcessEnv {
  const connection = requireAiConnectionsRuntimeConfig({
    baseUrl: config.connection?.baseUrl,
    apiKey: config.connection?.apiKey,
    model: config.model,
  }, 'Default Agent');

  return {
    ...sanitizeRuntimeEnv(process.env),
    ...projectAnthropicCompatibleEnv(connection),
    SOLID_TOKEN: context.solidToken,
    POD_BASE_URL: context.podBaseUrl,
  };
}

function resolveClaudeModel(config: DefaultAgentConfig): string {
  const model = (config.model || '').trim();
  if (!model) {
    return 'sonnet';
  }

  if (model.startsWith('claude') || model.includes('anthropic/')) {
    return model;
  }

  // Non-Anthropic models (OpenRouter route) are mapped via ANTHROPIC_DEFAULT_SONNET_MODEL.
  return 'sonnet';
}

/**
 * 运行 Default Agent
 */
export async function runDefaultAgent(
  message: string,
  context: DefaultAgentContext,
  options?: DefaultAgentRunOptions,
): Promise<DefaultAgentResponse> {
  const config = getDefaultAgentConfig(options);

  if (!isDefaultAgentAvailable(config)) {
    return {
      content: '',
      success: false,
      error: 'Default Agent not configured: AI Connection baseUrl and API key are required',
    };
  }

  const abortController = new AbortController();
  const timeout = options?.timeout || 60000;

  const timeoutId = setTimeout(() => {
    logger.warn('Default Agent timeout, aborting...');
    abortController.abort();
  }, timeout);

  try {
    logger.info(`Running Default Agent for Pod: ${context.podBaseUrl}`);

    const queryFn = await loadClaudeQuery();
    const q = queryFn({
      prompt: message,
      options: {
        abortController,
        pathToClaudeCodeExecutable: config.claudeCodePath,
        env: buildClaudeEnv(config, context),
        systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
        model: resolveClaudeModel(config),
        permissionMode: 'acceptEdits',
        allowedTools: ['Bash', 'Read', 'Write'],
        maxTurns: options?.maxTurns || 10,
      },
    });

    let content = '';
    let costUsd: number | undefined;

    for await (const msg of q) {
      const assistantText = getAssistantText(msg);
      if (assistantText) {
        content += assistantText;
      }

      if (isResultMessage(msg)) {
        if (msg.subtype === 'success' && typeof msg.result === 'string' && msg.result.trim()) {
          content = msg.result;
        }
        if (typeof msg.total_cost_usd === 'number') {
          costUsd = msg.total_cost_usd;
        }
      }
    }

    clearTimeout(timeoutId);

    return {
      content,
      success: true,
      model: config.model || resolveClaudeModel(config),
      costUsd,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Default Agent error: ${errorMessage}`);

    return {
      content: '',
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * 流式运行 Default Agent
 */
export async function* streamDefaultAgent(
  message: string,
  context: DefaultAgentContext,
  options?: DefaultAgentRunOptions,
): AsyncGenerator<string, void, unknown> {
  const config = getDefaultAgentConfig(options);

  if (!isDefaultAgentAvailable(config)) {
    throw new Error('Default Agent not configured: AI Connection baseUrl and API key are required');
  }

  const abortController = new AbortController();
  const timeout = options?.timeout || 60000;

  const timeoutId = setTimeout(() => {
    logger.warn('Default Agent timeout, aborting...');
    abortController.abort();
  }, timeout);

  try {
    logger.info(`Streaming Default Agent for Pod: ${context.podBaseUrl}`);

    const queryFn = await loadClaudeQuery();
    const q = queryFn({
      prompt: message,
      options: {
        abortController,
        pathToClaudeCodeExecutable: config.claudeCodePath,
        env: buildClaudeEnv(config, context),
        systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
        model: resolveClaudeModel(config),
        permissionMode: 'acceptEdits',
        allowedTools: ['Bash', 'Read', 'Write'],
        maxTurns: options?.maxTurns || 10,
        includePartialMessages: true,
      },
    });

    for await (const msg of q) {
      const assistantText = getAssistantText(msg);
      if (assistantText) {
        yield assistantText;
      }
    }

    clearTimeout(timeoutId);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}
