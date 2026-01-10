/**
 * IndexAgent - 多层级文档索引 Agent
 *
 * 职责：为文件生成摘要和 embedding，使其可检索。
 *
 * 支持三个索引层级：
 * - L0：摘要级别，1-3句话描述文件
 * - L1：目录级别，提取主要标题和结构
 * - L2：全文级别，完整分块和向量化
 *
 * @see docs/indexing-agent.md 完整设计文档
 */

import { getLoggerFor } from 'global-logger-factory';
import type { Agent, AgentContext, AgentResult } from '../task/types';
import { CodeBuddyExecutor } from './CodeBuddyExecutor';
import type { CodeBuddyConfig } from './types';

/**
 * 索引层级类型
 */
export type IndexLevel = 'L0' | 'L1' | 'L2';

/**
 * L0 索引 System Prompt
 */
const L0_SYSTEM_PROMPT = `你是 IndexAgent，负责 L0 文档索引，帮助用户的 Pod 中的文件变得可检索。

## 任务

为文件生成简短摘要和 embedding，使其可通过语义搜索被找到。

## L0 索引标准

| 项目 | 说明 |
|------|------|
| 内容 | 文件的简短描述（1-3句话） |
| 来源 | 文件名、类型、前几行内容 |
| 产物 | 描述文本 + embedding |
| 成本 | 最低 |

## 处理流程

1. **读取文件信息**：类型、大小、文件名
2. **获取内容预览**：
   - 文本文件：读取前 500 字符
   - 其他类型：根据文件名和类型推断
3. **生成摘要**：1-3句话描述文件内容和用途
4. **生成 embedding**：调用 Embedding API
5. **更新状态**：写入 .meta 记录索引完成

## 存储规范

索引状态存储在资源的 .meta 辅助资源：

\`\`\`turtle
</docs/report.pdf> 
    udfs:indexLevel "L0" ;
    udfs:lastIndexedAt "2026-01-09T10:00:00Z"^^xsd:dateTime ;
    udfs:summary "2024年度财务报告，包含收入、支出、利润分析" ;
    udfs:vectorId 12345 .
\`\`\`

## 可用工具

- **Read**：读取 Pod 中的文件
- **Write**：写入文件到 Pod
- **Bash**：执行命令（如需要）

## 输出格式

完成后返回 JSON：
{
  "success": true,
  "indexLevel": "L0",
  "summary": "文件摘要...",
  "vectorId": 12345
}

如果文件不需要索引或出错：
{
  "success": false,
  "reason": "说明原因"
}
`;

/**
 * L1 索引 System Prompt - 目录级别
 */
const L1_SYSTEM_PROMPT = `你是 IndexAgent，负责 L1 文档索引（目录级别），帮助用户的 Pod 中的文件变得可检索。

## 任务

提取文件的目录结构和主要标题，为每个主要部分生成描述和 embedding。

## L1 索引标准

| 项目 | 说明 |
|------|------|
| 内容 | 目录结构，主要标题的描述 |
| 来源 | PDF/Word：提取 TOC；Markdown：扫描标题行 |
| 产物 | 主要标题 chunks + embeddings |
| 成本 | 低 |

## 处理流程

1. **读取文件**：获取完整内容
2. **提取目录结构**：
   - Markdown：提取 # 和 ## 标题
   - 其他格式：尝试识别结构
3. **生成标题描述**：为每个主要标题生成简短描述
4. **生成 embeddings**：为每个标题 chunk 生成向量
5. **更新状态**：写入 .meta 记录索引完成

## 存储规范

\`\`\`turtle
</docs/report.pdf> 
    udfs:indexLevel "L1" ;
    udfs:lastIndexedAt "2026-01-09T10:00:00Z"^^xsd:dateTime ;
    udfs:hasChunk </docs/report.pdf#chunk-1> ;
    udfs:hasChunk </docs/report.pdf#chunk-2> .

</docs/report.pdf#chunk-1> a udfs:TextChunk ;
    udfs:level 1 ;
    udfs:heading "Introduction" ;
    udfs:summary "介绍部分的简要描述" ;
    udfs:vectorId 12345 .
\`\`\`

## 输出格式

{
  "success": true,
  "indexLevel": "L1",
  "chunks": [
    {"heading": "Introduction", "level": 1, "summary": "..."},
    {"heading": "Background", "level": 2, "summary": "..."}
  ],
  "chunkCount": 5
}
`;

/**
 * L2 索引 System Prompt - 全文级别
 */
const L2_SYSTEM_PROMPT = `你是 IndexAgent，负责 L2 文档索引（全文级别），帮助用户的 Pod 中的文件变得可检索。

## 任务

对文件进行全文分块，为每个内容块生成描述和 embedding，实现深度语义检索。

## L2 索引标准

| 项目 | 说明 |
|------|------|
| 内容 | 全文分块（所有标题层级） |
| 前置 | 需要完整 parse |
| 产物 | 所有 chunks + embeddings |
| 成本 | 高 |

## 处理流程

1. **读取完整文件**：获取全部内容
2. **解析文档结构**：识别所有层级的标题和段落
3. **智能分块**：
   - 按标题层级分割（H1, H2, H3...）
   - 保持语义完整性
   - 每块控制在 500-2000 字符
4. **生成 embeddings**：为每个 chunk 生成向量
5. **建立 chunk 关系**：记录父子关系
6. **更新状态**：写入 .meta 记录索引完成

## 分块策略

对于 Markdown 文件：
\`\`\`python
# 按标题层级分割
headers = ["#", "##", "###", "####"]
# 每个标题下的内容作为一个 chunk
# 保留父子关系
\`\`\`

## 存储规范

\`\`\`turtle
</docs/report.pdf> 
    udfs:indexLevel "L2" ;
    udfs:lastIndexedAt "2026-01-09T10:00:00Z"^^xsd:dateTime ;
    udfs:hasChunk </docs/report.pdf#chunk-1> ;
    udfs:hasChunk </docs/report.pdf#chunk-2> ;
    udfs:hasChunk </docs/report.pdf#chunk-3> .

# chunk 父子关系
</docs/report.pdf#chunk-2> udfs:parentChunk </docs/report.pdf#chunk-1> .
</docs/report.pdf#chunk-3> udfs:parentChunk </docs/report.pdf#chunk-1> .

# chunk 实体
</docs/report.pdf#chunk-1> a udfs:TextChunk ;
    udfs:level 1 ;
    udfs:heading "Introduction" ;
    udfs:content "This document describes..." ;
    udfs:startOffset 0 ;
    udfs:endOffset 256 ;
    udfs:vectorId 12345 .

</docs/report.pdf#chunk-2> a udfs:TextChunk ;
    udfs:level 2 ;
    udfs:heading "Background" ;
    udfs:content "The background of this project..." ;
    udfs:startOffset 257 ;
    udfs:endOffset 512 ;
    udfs:vectorId 12346 .
\`\`\`

## 可用工具

- **Read**：读取 Pod 中的文件
- **Write**：写入文件到 Pod
- **Bash**：执行命令（如需要）

## 输出格式

{
  "success": true,
  "indexLevel": "L2",
  "chunks": [
    {
      "id": "chunk-1",
      "heading": "Introduction",
      "level": 1,
      "content": "摘要或前100字...",
      "vectorId": 12345
    },
    {
      "id": "chunk-2", 
      "heading": "Background",
      "level": 2,
      "parent": "chunk-1",
      "content": "摘要或前100字...",
      "vectorId": 12346
    }
  ],
  "chunkCount": 15,
  "totalCharacters": 8500
}

如果失败：
{
  "success": false,
  "reason": "说明原因"
}
`;

/**
 * 获取指定层级的 System Prompt
 */
function getSystemPrompt(level: IndexLevel): string {
  switch (level) {
    case 'L0':
      return L0_SYSTEM_PROMPT;
    case 'L1':
      return L1_SYSTEM_PROMPT;
    case 'L2':
      return L2_SYSTEM_PROMPT;
    default:
      return L0_SYSTEM_PROMPT;
  }
}

/**
 * IndexAgent 配置选项
 */
export interface IndexAgentOptions {
  /** 索引层级，默认 L0 */
  level?: IndexLevel;
}

/**
 * IndexAgent 实现
 *
 * 通过 CodeBuddy SDK 执行，支持 L0/L1/L2 三个索引层级。
 */
export class IndexAgent implements Agent {
  private readonly logger = getLoggerFor(this);
  private readonly executor = new CodeBuddyExecutor();
  private readonly defaultLevel: IndexLevel;

  public readonly name = 'indexing';
  public readonly description = '文档索引 Agent，帮助用户的文件变得可检索';

  constructor(options?: IndexAgentOptions) {
    this.defaultLevel = options?.level ?? 'L0';
  }

  /**
   * Agent 配置
   *
   * 根据索引层级配置不同的 system prompt 和参数
   */
  private getConfig(level: IndexLevel, _context: AgentContext): CodeBuddyConfig {
    // 根据层级调整 maxTurns
    const maxTurns = level === 'L0' ? 10 : level === 'L1' ? 15 : 20;

    return {
      name: `${this.name}-${level}`,
      description: `${this.description} (${level})`,
      systemPrompt: getSystemPrompt(level),
      // L0/L1 不需要额外的 MCP 服务器
      // L2 可能需要 JINA 等，但由 CodeBuddyExecutor 根据 context 注入
      mcpServers: {},
      // 使用 GLM-4.7 模型
      model: 'glm-4.7',
      maxTurns,
      // 接受编辑模式
      permissionMode: 'acceptEdits',
    };
  }

  /**
   * 从消息中解析索引层级
   */
  private parseLevel(message: string): IndexLevel {
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('l2') || lowerMessage.includes('全文') || lowerMessage.includes('深度')) {
      return 'L2';
    }
    if (lowerMessage.includes('l1') || lowerMessage.includes('目录') || lowerMessage.includes('结构')) {
      return 'L1';
    }
    if (lowerMessage.includes('l0') || lowerMessage.includes('摘要') || lowerMessage.includes('简要')) {
      return 'L0';
    }
    return this.defaultLevel;
  }

  /**
   * 转换 usage 格式（ExecuteResult -> AgentResult）
   */
  private convertUsage(usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  }): { inputTokens: number; outputTokens: number; cost: number; turns: number; durationMs: number } | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cost: 0, // CodeBuddy SDK 不返回 cost
      turns: 0, // CodeBuddy SDK 不返回 turns
      durationMs: usage.durationMs,
    };
  }

  /**
   * 执行任务
   *
   * @param message 任务消息，可包含层级指示（如 "L2 索引"、"深度索引"、"全文索引"）
   * @param context Agent 上下文
   */
  public async execute(message: string, context: AgentContext): Promise<AgentResult> {
    const level = this.parseLevel(message);
    context.log.info(`IndexAgent (${level}) received: ${message}`);

    try {
      const config = this.getConfig(level, context);

      // 通过 CodeBuddy SDK 执行
      const result = await this.executor.executeAndWaitWithConfig(config, message, {
        podBaseUrl: context.podBaseUrl,
        accessToken: context.accessToken,
        timeout: level === 'L2' ? 600000 : 300000, // L2 给 10 分钟，其他 5 分钟
      });

      if (result.success) {
        context.log.info(`IndexAgent (${level}) completed: ${result.result}`);
        return {
          success: true,
          data: result.structuredOutput ?? result.result,
          usage: this.convertUsage(result.usage),
        };
      } else {
        context.log.error(`IndexAgent (${level}) failed: ${result.error}`);
        return {
          success: false,
          error: result.error,
          usage: this.convertUsage(result.usage),
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.log.error(`IndexAgent (${level}) error: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * 执行指定层级的索引
   *
   * @param level 索引层级
   * @param message 任务消息
   * @param context Agent 上下文
   */
  public async executeWithLevel(
    level: IndexLevel,
    message: string,
    context: AgentContext,
  ): Promise<AgentResult> {
    context.log.info(`IndexAgent (${level}) received: ${message}`);

    try {
      const config = this.getConfig(level, context);

      const result = await this.executor.executeAndWaitWithConfig(config, message, {
        podBaseUrl: context.podBaseUrl,
        accessToken: context.accessToken,
        timeout: level === 'L2' ? 600000 : 300000,
      });

      if (result.success) {
        context.log.info(`IndexAgent (${level}) completed: ${result.result}`);
        return {
          success: true,
          data: result.structuredOutput ?? result.result,
          usage: this.convertUsage(result.usage),
        };
      } else {
        context.log.error(`IndexAgent (${level}) failed: ${result.error}`);
        return {
          success: false,
          error: result.error,
          usage: this.convertUsage(result.usage),
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.log.error(`IndexAgent (${level}) error: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }
}

/**
 * 默认 IndexAgent 实例
 */
export const indexAgent = new IndexAgent();
