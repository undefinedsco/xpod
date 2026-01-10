# Agent 系统设计

## 概述

xpod 的 Agent 系统让 AI 成为用户 Pod 的智能管家。当前聚焦 **L0 索引**（文件摘要），为文件生成描述和 embedding，使其可检索。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                        xpod API Server                       │
│                                                              │
│  ┌──────────────┐      ┌───────────────┐                    │
│  │  TaskQueue   │─────→│ AgentExecutor │                    │
│  │  (消息路由)   │      │ (CodeBuddy SDK)│                    │
│  └──────────────┘      └───────┬───────┘                    │
│                                │                             │
│                                ▼                             │
│                    ┌───────────────────┐                    │
│                    │   IndexAgent      │                    │
│                    │   (L0 索引)        │                    │
│                    └─────────┬─────────┘                    │
│                              │                               │
│              ┌───────────────┼───────────────┐              │
│              ▼               ▼               ▼              │
│      ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│      │  Pod MCP    │ │  JINA MCP   │ │  Bash/Code  │       │
│      │ (文件读写)   │ │ (解析/搜索)  │ │ (Python等)  │       │
│      └─────────────┘ └─────────────┘ └─────────────┘       │
│              │               │               │              │
└──────────────┼───────────────┼───────────────┼──────────────┘
               ▼               ▼               ▼
        ┌─────────────────────────────────────────┐
        │              User's Pod                  │
        │  /.agent/sessions/   - Agent 会话历史    │
        │  /.credentials/      - API Keys         │
        │  /docs/*.meta        - 索引状态          │
        └─────────────────────────────────────────┘
```

## 会话管理

### 模式：任务式 + Session 关联

```
Task 1: "索引文件 /docs/report.pdf"
    │
    ▼
┌────────────────────────────┐
│  Agent Session             │
│  session_id: abc123        │
│  transcript 存储在 Pod     │
└────────────────────────────┘
    │
    ▼ (完成后 session 结束)

Task 2: "刚才那个文件，生成更详细的摘要"
    │
    ▼ (通过 parentTaskId 或 sessionId 关联)
┌────────────────────────────┐
│  Agent Session (resume)    │
│  session_id: abc123        │ ← 恢复上下文
│  知道"刚才那个文件"是什么   │
└────────────────────────────┘
```

### Session 存储

```
/.agent/
  sessions/
    {session_id}/
      transcript.json   # 对话历史（SDK 生成）
      metadata.json     # 元数据：创建时间、关联任务等
```

### Task 数据结构

```typescript
interface Task {
  id: string;
  agent: string;          // "indexing"
  message: string;        // 任务描述
  status: TaskStatus;     // pending | running | completed | failed
  
  // Session 关联
  sessionId?: string;     // Agent session ID
  parentTaskId?: string;  // 父任务（用于关联上下文）
  
  // 时间戳
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  
  // 结果
  result?: unknown;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    turns: number;
    durationMs: number;
  };
}
```

## AgentExecutor

基于 CodeBuddy Agent SDK 的执行器。

### 接口

```typescript
class AgentExecutor {
  // 流式执行
  async *execute(
    config: AgentConfig,
    message: string,
    options: ExecuteOptions
  ): AsyncGenerator<ExecuteMessage>;

  // 等待完成
  async executeAndWait(
    config: AgentConfig,
    message: string,
    options: ExecuteOptions
  ): Promise<ExecuteResult>;
}

interface ExecuteOptions {
  podBaseUrl?: string;      // Pod URL
  accessToken?: string;     // OAuth token（用于 MCP 访问 Pod）
  sessionId?: string;       // 恢复之前的 session
  timeout?: number;         // 超时（默认 5 分钟）
}
```

### MCP 服务器管理

**SDK 自动管理**：
- 首次使用时启动 MCP server
- 执行期间保持连接
- Session 结束后关闭

**自动注入 Pod MCP**：
```typescript
// 如果提供了 accessToken，自动添加 Pod MCP
if (options.podBaseUrl && options.accessToken) {
  servers.pod = {
    type: 'http',
    url: `${options.podBaseUrl}/.mcp`,
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
    },
  };
}
```

## OAuth Token 流程

Agent 访问 Pod 资源需要 OAuth token。

### 流程

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  User    │     │  xpod    │     │  OIDC    │     │  Pod     │
│ Browser  │     │  Server  │     │ Provider │     │          │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │ 1. 触发授权     │                │                │
     │───────────────→│                │                │
     │                │                │                │
     │ 2. 重定向到 OIDC│                │                │
     │←───────────────│                │                │
     │                │                │                │
     │ 3. 用户登录授权 │                │                │
     │───────────────────────────────→│                │
     │                │                │                │
     │ 4. 返回 code   │                │                │
     │←──────────────────────────────│                │
     │                │                │                │
     │ 5. 交换 token  │                │                │
     │───────────────→│                │                │
     │                │ 6. code→token │                │
     │                │───────────────→│                │
     │                │←───────────────│                │
     │                │                │                │
     │                │ 7. 存储 refresh_token           │
     │                │───────────────────────────────→│
     │                │                │                │
     │ 8. 完成        │                │                │
     │←───────────────│                │                │
```

### Token 存储

```
/.credentials/
  agent-tokens/
    {provider}.json     # { refresh_token, scope, expires_at }
```

### 静默刷新

Agent 执行时：
1. 读取 `/.credentials/agent-tokens/{provider}.json`
2. 用 refresh_token 获取新的 access_token
3. access_token 传给 MCP 服务器

```typescript
// AgentContext 提供 accessToken
interface AgentContext {
  taskId: string;
  podBaseUrl: string;
  accessToken?: string;  // 自动刷新的 access_token
  // ...
}
```

## IndexAgent (L0)

当前实现聚焦 **L0 索引**：为文件生成摘要和 embedding。

### 触发场景

| 场景 | 消息示例 |
|------|---------|
| 文件上传 | "用户在 </docs/> 上传了文件 </docs/report.pdf>" |
| 定时扫描 | "定时检查：文件 </docs/report.pdf> 未被索引" |

### L0 索引内容

| 项目 | 说明 |
|------|------|
| 内容 | 文件摘要/描述 |
| 来源 | 文件名、类型、前几行内容、周边上下文 |
| 产物 | 描述文本 + embedding |
| 成本 | 最低 |

### Agent 配置

```typescript
const config: AgentConfig = {
  name: 'indexing',
  description: '文档索引 Agent，帮助用户的文件变得可检索',
  systemPrompt: SYSTEM_PROMPT,  // 定义角色、工具、规范
  mcpServers: {
    jina: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@jina-ai/mcp-server'],
    },
  },
  model: 'claude-sonnet-4-20250514',
  maxTurns: 20,
  permissionMode: 'acceptEdits',
};
```

### 存储规范

**索引状态**（`.meta`）：
```turtle
</docs/report.pdf> 
    udfs:indexLevel "L0" ;
    udfs:lastIndexedAt "2026-01-09T10:00:00Z"^^xsd:dateTime ;
    udfs:summary "2024年度财务报告，包含收入、支出、利润分析" .
```

**Embedding**：
```turtle
</docs/report.pdf> 
    udfs:vectorId 12345 .  # 向量存储 ID
```

### System Prompt 要点

```markdown
你是 IndexAgent，负责 L0 文档索引。

## 任务
为文件生成摘要和 embedding，使其可检索。

## L0 索引标准
- 内容：文件的简短描述（1-3句话）
- 来源：文件名、类型、前几行内容
- 产物：描述文本 + embedding

## 流程
1. 读取文件基本信息（类型、大小）
2. 读取文件前几行内容（如果是文本类型）
3. 生成简短描述
4. 调用 Embedding API 生成向量
5. 更新 .meta 记录索引状态

## 输出格式
{
  "success": true,
  "indexLevel": "L0",
  "summary": "文件描述...",
  "vectorId": 12345
}
```

## 未来扩展

### L1/L2 索引

当前只实现 L0，未来可扩展：

| 层级 | 内容 | 触发条件 |
|------|------|---------|
| L0 | 摘要 | 所有新文件 |
| L1 | 目录结构 | 用户主动请求、收藏 |
| L2 | 全文分块 | 用户深度需求 |

### 更多 Agent

| Agent | 职责 |
|-------|------|
| indexing | 文档索引 |
| organizing | 文件整理、分类 |
| summarizing | 内容摘要、笔记 |
| reminding | 提醒、待办跟踪 |

## 文件结构

```
src/
  agent/
    index.ts              # 导出
    AgentExecutor.ts      # SDK 封装
    IndexAgent.ts         # L0 索引 Agent
  task/
    types.ts              # 类型定义
    TaskQueue.ts          # 任务队列（TODO）
    TaskExecutor.ts       # 任务执行器（TODO）
```

## 依赖

- `@tencent-ai/agent-sdk` - CodeBuddy Agent SDK
- MCP Servers（SDK 自动管理）
