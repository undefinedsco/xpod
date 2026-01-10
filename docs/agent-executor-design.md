# Agent Executor 架构设计

## 概述

Agent Executor 是一个统一的 AI Agent 执行框架，支持多种 AI 提供商和认证方式。

**核心原则：所有凭证都存储在用户的 Pod 中，服务器不存储任何用户密钥。**

## 支持的提供商

| 提供商 | SDK | 模型示例 | 特点 |
|--------|-----|----------|------|
| **CodeBuddy** | `@anthropic-ai/agent-sdk` | claude, glm-4 | 支持 MCP 工具 |
| **Gemini** | `@google/generative-ai`, `@google-cloud/vertexai` | gemini-2.0-flash, gemini-1.5-pro | 多模态 |
| **Claude** | `@anthropic-ai/sdk` | claude-4-opus, claude-3.5-sonnet | 长上下文 |
| **OpenAI** | `openai` | gpt-4o, o1, o3 | 广泛兼容 |

## 凭证管理

### 核心原则

1. **用户数据主权**：所有 API Key 和 Token 都存储在用户自己的 Pod 中
2. **服务器无状态**：服务器不存储任何用户凭证，只在请求时从 Pod 读取
3. **用户完全控制**：用户可以随时查看、修改、删除自己的凭证

### 存储位置（使用现有结构）

```
pod:/
└── settings/
    ├── credentials.ttl          # 凭据存储 (API Keys, Tokens)
    └── ai/
        └── providers.ttl        # AI 供应商配置
```

### 凭证格式 (RDF/Turtle)

使用现有的 `udfs:Credential` Schema（参见 `docs/credential-schema.md`）：

```turtle
@prefix udfs: <https://undefineds.co/ns#> .

# /settings/credentials.ttl

<#cred-gemini>
  a udfs:ApiKeyCredential ;
  udfs:provider </settings/ai/providers.ttl#gemini> ;
  udfs:service "ai" ;
  udfs:status "active" ;
  udfs:apiKey "AIzaSy..." ;
  udfs:label "我的 Gemini Key" .

<#cred-openai>
  a udfs:ApiKeyCredential ;
  udfs:provider </settings/ai/providers.ttl#openai> ;
  udfs:service "ai" ;
  udfs:status "active" ;
  udfs:apiKey "sk-..." ;
  udfs:organizationId "org-..." .

<#cred-anthropic>
  a udfs:ApiKeyCredential ;
  udfs:provider </settings/ai/providers.ttl#anthropic> ;
  udfs:service "ai" ;
  udfs:status "active" ;
  udfs:apiKey "sk-ant-..." .

<#cred-codebuddy>
  a udfs:ApiKeyCredential ;
  udfs:provider </settings/ai/providers.ttl#codebuddy> ;
  udfs:service "ai" ;
  udfs:status "active" ;
  udfs:apiKey "cb-..." .
```

### 供应商配置

```turtle
@prefix udfs: <https://undefineds.co/ns#> .

# /settings/ai/providers.ttl

<#gemini>
  a udfs:AiProvider ;
  udfs:name "gemini" ;
  udfs:displayName "Google Gemini" ;
  udfs:baseUrl "https://generativelanguage.googleapis.com" ;
  udfs:defaultModel "gemini-2.0-flash-exp" ;
  udfs:enabled true .

<#openai>
  a udfs:AiProvider ;
  udfs:name "openai" ;
  udfs:displayName "OpenAI" ;
  udfs:defaultModel "gpt-4o" ;
  udfs:enabled true .

<#anthropic>
  a udfs:AiProvider ;
  udfs:name "anthropic" ;
  udfs:displayName "Anthropic Claude" ;
  udfs:defaultModel "claude-sonnet-4-20250514" ;
  udfs:enabled true .

<#codebuddy>
  a udfs:AiProvider ;
  udfs:name "codebuddy" ;
  udfs:displayName "CodeBuddy" ;
  udfs:defaultModel "claude-sonnet-4-20250514" ;
  udfs:enabled true .
```

### 现有实现

项目中已有凭证读取实现：

- **Schema**: `src/credential/schema/tables.ts` - 定义 `credentialTable`
- **Reader**: `src/embedding/CredentialReaderImpl.ts` - 从 Pod 读取凭证
- **文档**: `docs/credential-schema.md` - 完整 Schema 定义

## 认证方式

每个提供商支持两种认证方式：

### 1. API Key

用户在前端输入 API Key，存储到 Pod。

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│ 前端 UI │     │ XPod API│     │   Pod   │
└────┬────┘     └────┬────┘     └────┬────┘
     │               │               │
     │ 1. 用户输入 API Key           │
     │──────────────>│               │
     │               │               │
     │               │ 2. 验证 API Key (调用提供商 API)
     │               │───────────────────────>
     │               │<───────────────────────
     │               │               │
     │               │ 3. 存储到 Pod │
     │               │──────────────>│
     │               │               │
     │ 4. 配置成功   │               │
     │<──────────────│               │
```

### 2. OIDC (OAuth/OpenID Connect)

通过 OAuth 登录获取 Token，存储到 Pod。

| 提供商 | OIDC 提供方 | OAuth 端点 |
|--------|-------------|------------|
| CodeBuddy | Tencent Cloud | copilot.tencent.com |
| Gemini | Google Cloud | accounts.google.com |
| Claude | Anthropic | console.anthropic.com |
| OpenAI | OpenAI / Azure AD | platform.openai.com |

## 前端 OIDC 授权流程

```
┌─────────┐     ┌─────────┐     ┌──────────────┐     ┌─────────┐
│ 前端 UI │     │ XPod API│     │ AI Provider  │     │   Pod   │
│         │     │ Server  │     │ (OAuth)      │     │ Storage │
└────┬────┘     └────┬────┘     └──────┬───────┘     └────┬────┘
     │               │                  │                  │
     │ 1. 选择 AI 提供商 + 授权方式    │                  │
     │──────────────>│                  │                  │
     │               │                  │                  │
     │ 2. 返回 OAuth URL               │                  │
     │<──────────────│                  │                  │
     │               │                  │                  │
     │ 3. 弹窗重定向到 OAuth 授权页面  │                  │
     │─────────────────────────────────>│                  │
     │               │                  │                  │
     │ 4. 用户授权，回调带 code        │                  │
     │<─────────────────────────────────│                  │
     │               │                  │                  │
     │ 5. 发送 code 到后端             │                  │
     │──────────────>│                  │                  │
     │               │                  │                  │
     │               │ 6. 用 code 换 token                │
     │               │─────────────────>│                  │
     │               │                  │                  │
     │               │ 7. 返回 access_token + refresh_token
     │               │<─────────────────│                  │
     │               │                  │                  │
     │               │ 8. 存储 token 到用户 Pod           │
     │               │─────────────────────────────────────>
     │               │                  │                  │
     │ 9. 授权成功   │                  │                  │
     │<──────────────│                  │                  │
```

## 执行流程

当执行 Agent 任务时：

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌──────────┐
│ 前端/   │     │ XPod API│     │   Pod   │     │ AI       │
│ 任务队列│     │ Server  │     │ Storage │     │ Provider │
└────┬────┘     └────┬────┘     └────┬────┘     └────┬─────┘
     │               │               │                │
     │ 1. 执行任务   │               │                │
     │──────────────>│               │                │
     │               │               │                │
     │               │ 2. 读取凭证   │                │
     │               │──────────────>│                │
     │               │               │                │
     │               │ 3. 返回凭证   │                │
     │               │<──────────────│                │
     │               │               │                │
     │               │ 4. 使用凭证调用 AI API         │
     │               │───────────────────────────────>│
     │               │               │                │
     │               │ 5. 返回结果   │                │
     │               │<───────────────────────────────│
     │               │               │                │
     │               │ 6. (如果 token 刷新) 更新凭证  │
     │               │──────────────>│                │
     │               │               │                │
     │ 7. 返回结果   │               │                │
     │<──────────────│               │                │
```

## 接口设计

### IAgentExecutor 接口

```typescript
/**
 * 认证类型
 */
type AuthType = 'api-key' | 'oidc';

/**
 * 凭证信息（从 Pod 读取）
 */
interface Credential {
  provider: string;
  authType: AuthType;
  // API Key 方式
  apiKey?: string;
  // OIDC 方式
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  // 其他配置
  projectId?: string;  // Gemini Vertex AI
  baseUrl?: string;    // OpenAI 兼容 API
}

/**
 * 认证信息
 */
interface AuthInfo {
  authenticated: boolean;
  authType: AuthType;
  provider: string;
  expiresAt?: Date;
  account?: {
    email?: string;
    name?: string;
  };
}

/**
 * 执行器配置
 */
interface ExecutorConfig {
  name: string;
  systemPrompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * 执行结果
 */
interface ExecuteResult {
  success: boolean;
  result?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  };
}

/**
 * Agent 执行器接口
 */
interface IAgentExecutor {
  /** 提供商名称 */
  readonly provider: string;
  
  /** 获取认证类型 */
  getAuthType(): AuthType;
  
  /** 检查认证状态 */
  checkAuthentication(): Promise<AuthInfo>;
  
  /** 执行任务（流式） */
  execute(config: ExecutorConfig, message: string): AsyncGenerator<ExecuteMessage>;
  
  /** 执行任务并等待完成 */
  executeAndWait(config: ExecutorConfig, message: string): Promise<ExecuteResult>;
  
  /** 多轮对话 */
  chat(config: ExecutorConfig, messages: ChatMessage[]): Promise<ExecuteResult>;
}
```

### CredentialReader（现有实现）

项目中已有 `CredentialReaderImpl`，可直接使用：

```typescript
import { CredentialReaderImpl } from '../embedding/CredentialReaderImpl';

// 读取 AI 凭证
const credentialReader = new CredentialReaderImpl();
const credential = await credentialReader.getAiCredential(
  podBaseUrl,           // 'https://pod.example.com/alice/'
  'gemini',             // provider ID
  authenticatedFetch,   // 用户授权的 fetch
  webId,                // 用户 WebID
);

// credential: { provider, apiKey, baseUrl?, proxyUrl? }
```

### AgentExecutorFactory 工厂

```typescript
/**
 * 从 Pod 凭证创建执行器
 * 
 * @param provider - 提供商名称
 * @param credentialReader - 凭证读取器
 * @param context - Agent 上下文（包含 Pod URL 和认证信息）
 */
async function createExecutorFromPod(
  provider: string,
  credentialReader: CredentialReader,
  context: AgentContext
): Promise<IAgentExecutor>;

/**
 * 创建执行器（直接传入凭证，用于测试）
 */
function createExecutor(
  provider: string,
  credential: { apiKey: string; baseUrl?: string }
): IAgentExecutor;
```

## 使用示例

### 1. 前端配置 API Key

```typescript
// 前端代码
async function configureApiKey(provider: string, apiKey: string) {
  // 调用后端 API 验证并保存
  await api.post('/api/credentials', {
    provider,
    authType: 'api-key',
    apiKey,
  });
}
```

### 2. 前端触发 OIDC 授权

```typescript
// 前端代码
async function authorizeProvider(provider: string) {
  // 1. 获取 OAuth URL
  const { authUrl, state } = await api.get(`/api/oauth/${provider}/authorize`);
  
  // 2. 弹出授权窗口
  const popup = window.open(authUrl, 'oauth', 'width=600,height=700');
  
  // 3. 监听回调
  window.addEventListener('message', async (event) => {
    if (event.data.type === 'oauth-callback' && event.data.state === state) {
      const { code } = event.data;
      
      // 4. 发送 code 到后端完成授权（后端会存储到 Pod）
      await api.post(`/api/oauth/${provider}/callback`, { code, state });
      
      popup.close();
    }
  });
}
```

### 3. 后端执行 Agent 任务

```typescript
// 后端代码
import { CredentialReaderImpl } from '../embedding/CredentialReaderImpl';
import { createExecutorFromPod } from '../agent';

async function executeAgentTask(
  provider: string,
  config: ExecutorConfig,
  message: string,
  context: AgentContext
) {
  // 1. 创建凭证读取器
  const credentialReader = new CredentialReaderImpl();
  
  // 2. 从 Pod 读取凭证并创建执行器
  const executor = await createExecutorFromPod(
    provider,
    credentialReader,
    context
  );
  
  // 3. 执行任务
  const result = await executor.executeAndWait(config, message);
  
  return result;
}
```

## API 端点设计

### 凭证管理

```
# 获取凭证状态（不返回敏感信息）
GET /api/credentials
  -> { providers: [{ provider, authType, configured, expiresAt }] }

# 保存 API Key
POST /api/credentials
  <- { provider, authType: 'api-key', apiKey }
  -> { success, message }

# 删除凭证
DELETE /api/credentials/:provider
  -> { success }

# 验证凭证
POST /api/credentials/:provider/verify
  -> { valid, account?, error? }
```

### OAuth 授权

```
# 获取 OAuth 授权 URL
GET /api/oauth/:provider/authorize
  -> { authUrl, state }

# OAuth 回调处理
POST /api/oauth/:provider/callback
  <- { code, state }
  -> { success, message }

# 撤销 OAuth 授权
DELETE /api/oauth/:provider/revoke
  -> { success }
```

### Agent 执行

```
# 执行 Agent 任务
POST /api/agent/execute
  <- { provider, config, message }
  -> SSE stream of ExecuteMessage

# 获取可用提供商
GET /api/agent/providers
  -> { providers: [{ name, models, authTypes, configured }] }
```

## 安全考虑

### 1. 传输安全

- 所有 API 调用使用 HTTPS
- 敏感数据（API Key、Token）只在必要时传输

### 2. 存储安全

- 凭证存储在用户 Pod 的私有目录 `.xpod/credentials/`
- 可选：使用 Pod 的加密存储功能
- 服务器不持久化任何凭证

### 3. 访问控制

- 只有 Pod 所有者可以访问凭证目录
- 服务器使用用户的 OAuth Token 访问 Pod（需要用户授权）

### 4. Token 管理

- OIDC Token 自动刷新
- 过期 Token 自动清理
- 用户可以随时撤销授权

## 实现计划

### Phase 1: 基础框架
- [ ] 定义 `IAgentExecutor` 接口
- [x] 实现 `CredentialReaderImpl`（已有）
- [x] 定义 Credential Schema（已有）

### Phase 2: 执行器实现
- [x] 实现 `CodeBuddyExecutor`（已有 `AgentExecutor`）
- [x] 实现 `GeminiExecutor`（已有 `GeminiAgentExecutor`）
- [ ] 实现 `ClaudeExecutor`
- [ ] 实现 `OpenAIExecutor`
- [ ] 实现 `AgentExecutorFactory`
- [ ] 重构现有执行器实现统一接口

### Phase 3: API Key 支持
- [x] 凭证 Schema 定义（已有）
- [ ] 实现凭证管理 API
- [ ] 实现 API Key 验证
- [ ] 添加前端配置 UI

### Phase 4: OIDC 支持
- [ ] 扩展 Credential Schema 支持 OIDC Token
- [ ] 实现 OAuth 授权流程
- [ ] 实现 Token 自动刷新
- [ ] 添加前端授权 UI

### Phase 5: 高级功能
- [ ] 多账户支持（同一供应商多个凭证）
- [ ] 使用量统计
- [ ] 成本跟踪
- [ ] 凭证健康检查
