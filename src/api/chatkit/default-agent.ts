/**
 * Default Agent
 *
 * 基于 Claude Code SDK 的默认 AI Agent，用于：
 * 1. 用户未配置 AI 时的降级方案
 * 2. 帮助用户完成初始化配置
 * 3. 识别并收纳结构化数据到 Pod
 */

import { getLoggerFor } from 'global-logger-factory';

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
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;
  const mod = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  const maybeQuery = mod.query;

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
  /** 默认 AI 提供商 */
  provider?: string;
  /** 默认模型 */
  model?: string;
  /** API Key */
  apiKey?: string;
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

/**
 * 获取 Default Agent 配置
 */
export function getDefaultAgentConfig(): DefaultAgentConfig {
  return {
    claudeCodePath: process.env.CLAUDE_CODE_PATH || undefined,
    provider: process.env.DEFAULT_PROVIDER || 'openrouter',
    model: process.env.DEFAULT_MODEL || 'stepfun/step-3.5-flash:free',
    apiKey: process.env.DEFAULT_API_KEY || '',
  };
}

/**
 * 检查 Default Agent 是否可用
 */
export function isDefaultAgentAvailable(): boolean {
  const config = getDefaultAgentConfig();
  return !!config.apiKey;
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
- API Key、Provider、Model、Base URL
- 存储位置：/settings/ai/credentials.ttl
- 识别模式：
  - "我的 OpenAI key 是 sk-xxx"
  - "用这个 API key: xxx"
  - "anthropic 密钥 xxx"

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

### AI 配置示例
\`\`\`turtle
@prefix xpod: <http://xpod.dev/ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<#openai-credential> a xpod:AiCredential ;
  rdfs:label "OpenAI" ;
  xpod:provider "openai" ;
  xpod:apiKey "sk-xxx" ;
  xpod:baseUrl "https://api.openai.com/v1" .
\`\`\`

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
3. 如果是 AI 配置，提示用户"已保存，后续对话将使用你的 AI 配置"
4. 其他情况正常对话即可
5. 回复使用中文`;

/**
 * 运行 Default Agent
 */
export async function runDefaultAgent(
  message: string,
  context: DefaultAgentContext,
  options?: {
    timeout?: number;
    maxTurns?: number;
  },
): Promise<DefaultAgentResponse> {
  const config = getDefaultAgentConfig();

  if (!config.apiKey) {
    return {
      content: '',
      success: false,
      error: 'Default Agent not configured: DEFAULT_API_KEY is required',
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
        env: {
          ...process.env,
          SOLID_TOKEN: context.solidToken,
          POD_BASE_URL: context.podBaseUrl,
          // 通过 OpenRouter 使用 Claude 模型
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
          ANTHROPIC_API_KEY: config.apiKey,
        },
        systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
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
        if (msg.subtype === 'success' && typeof msg.result === 'string') {
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
      model: config.model,
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
  options?: {
    timeout?: number;
    maxTurns?: number;
  },
): AsyncGenerator<string, void, unknown> {
  const config = getDefaultAgentConfig();

  if (!config.apiKey) {
    throw new Error('Default Agent not configured: DEFAULT_API_KEY is required');
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
        env: {
          ...process.env,
          SOLID_TOKEN: context.solidToken,
          POD_BASE_URL: context.podBaseUrl,
          // 通过 OpenRouter 使用 Claude 模型
          ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
          ANTHROPIC_API_KEY: config.apiKey,
        },
        systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
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
