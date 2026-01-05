# Xpod API 服务设计

## 1. 目标

将管理类 API 从 CSS 主服务拆分到独立进程，实现：

- **稳定性隔离**：API 崩溃不影响 CSS 核心功能
- **安全性隔离**：减少 CSS 攻击面
- **独立扩容**：API 服务可水平扩展

---

## 2. 架构

### 2.1 整体架构

```
                        ┌─────────────────────────────────────┐
                        │           Nginx / Caddy              │
                        │  ┌───────────┐    ┌───────────────┐ │
                        │  │ /*        │    │ /api/*        │ │
                        │  │ → :3000   │    │ → :3001       │ │
                        │  └───────────┘    └───────────────┘ │
                        └─────────┬──────────────────┬────────┘
                                  │                  │
                                  ▼                  ▼
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│         CSS 主服务 :3000             │  │         API 服务 :3001               │
│                                     │  │                                     │
│  - LDP 资源访问                      │  │  - /api/signal/*     节点信令        │
│  - OIDC 认证                        │  │  - /api/quota/*      配额管理        │
│  - SPARQL 查询                      │  │  - /api/nodes/*      节点管理        │
│  - WebSocket 通知                   │  │  - /api/keys/*       API Key 管理    │
│                                     │  │  - /api/chat/*       AI 能力         │
│  高稳定性，保守更新                   │  │                                     │
│                                     │  │  可独立重启，快速迭代                 │
└──────────────────┬──────────────────┘  └──────────────────┬──────────────────┘
                   │                                        │
                   │         ┌──────────────────┐           │
                   └────────►│   PostgreSQL     │◄──────────┘
                             │   (共享数据库)    │
                             └──────────────────┘
```

### 2.2 Local 模式 (单机)

```
┌─────────────────────────────────────────────────────────┐
│                    本地开发/单机部署                      │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │ Router :80  │───►│ CSS :3000   │    │ API :3001   │ │
│  │ (可选)      │───►│             │    │             │ │
│  └─────────────┘    └──────┬──────┘    └──────┬──────┘ │
│                            │                  │        │
│                            ▼                  ▼        │
│                     ┌─────────────────────────────┐    │
│                     │   SQLite (本地文件)          │    │
│                     └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 2.3 Server 模式 (多机)

```
┌──────────────────────────────────────────────────────────────────┐
│                         生产部署                                  │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │   Nginx     │───►│ CSS :3000   │    │ API Service         │  │
│  │   负载均衡   │───►│ (多实例)    │    │ :3001 (多实例)       │  │
│  └─────────────┘    └──────┬──────┘    └──────────┬──────────┘  │
│                            │                      │              │
│                            ▼                      ▼              │
│              ┌─────────────────────────────────────────────┐    │
│              │              PostgreSQL                      │    │
│              │    ┌─────────┐  ┌─────────┐  ┌─────────┐    │    │
│              │    │ Quint   │  │ Identity│  │ API Keys│    │    │
│              │    │ (RDF)   │  │ (用户)  │  │ (鉴权)  │    │    │
│              │    └─────────┘  └─────────┘  └─────────┘    │    │
│              └─────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. API 路由设计

### 3.1 路由总览

| 路径 | 方法 | 说明 | 鉴权 |
|------|------|------|------|
| `/api/signal/heartbeat` | POST | 节点心跳 | Node Token |
| `/api/signal/certificate` | POST | 证书申请 | Node Token |
| `/api/nodes` | GET | 列出用户节点 | Solid Token |
| `/api/nodes` | POST | 创建节点 | Solid Token |
| `/api/nodes/:id` | GET | 获取节点详情 | Solid Token |
| `/api/nodes/:id` | DELETE | 删除节点 | Solid Token |
| `/api/quota/:webId` | GET | 查询配额 | Solid Token / API Key |
| `/api/quota/:webId` | PUT | 设置配额 | API Key (系统级) |
| `/api/keys` | GET | 列出用户 API Key | Solid Token |
| `/api/keys` | POST | 创建 API Key | Solid Token |
| `/api/keys/:id` | DELETE | 删除 API Key | Solid Token |
| `/api/chat/completions` | POST | AI 对话 | Solid Token / API Key |
| `/api/chat/models` | GET | 可用模型列表 | Solid Token / API Key |

### 3.2 从 CSS 迁移的 Handler

| 原文件 | 原路径 | 新路径 |
|-------|-------|-------|
| `EdgeNodeSignalHttpHandler.ts` | `/api/signal` | `/api/signal/*` |
| `EdgeNodeCertificateHttpHandler.ts` | `/api/signal/certificate` | `/api/signal/certificate` |
| `QuotaAdminHttpHandler.ts` | `/api/quota/*` | `/api/quota/*` |
| `EdgeNodeAdminHttpHandler.ts` | `/admin/nodes/*` | `/api/nodes/*` |

---

## 4. 鉴权设计

### 4.1 鉴权方式总览

| 方式 | Header | 验证方法 | 身份信息 |
|------|--------|---------|---------|
| Solid Token | `Authorization: Bearer/DPoP xxx` | OIDC JWKS 验签 | webId, clientId |
| API Key (用户级) | `Authorization: Bearer sk-xxx` | 数据库 hash 比对 | keyOwner (webId) |
| API Key (系统级) | `Authorization: Bearer sk-xxx` | 数据库 hash 比对 | scopes |
| Node Token | Body: `{nodeId, token}` | 数据库 hash 比对 | nodeId |
| Internal Token | `X-Internal-Token: jwt` | 共享密钥验签 | isInternal |

### 4.2 API Key 数据模型

```sql
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,           -- 'key_xxxxx'
  hashed_key    TEXT NOT NULL UNIQUE,       -- SHA256(sk-xxx)
  name          TEXT NOT NULL,              -- 用户命名
  type          TEXT NOT NULL,              -- 'user' | 'system'
  owner_webid   TEXT,                       -- user 类型必填
  scopes        JSONB,                      -- ['chat', 'quota:read']
  rate_limit    INTEGER,                    -- 每分钟调用限制
  expires_at    TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW(),
  last_used_at  TIMESTAMP
);

CREATE INDEX idx_api_keys_owner ON api_keys(owner_webid);
CREATE INDEX idx_api_keys_hashed ON api_keys(hashed_key);
```

### 4.3 API Key 格式

```
sk-{type}_{random}

示例:
- sk-user_a1b2c3d4e5f6...   (用户级)
- sk-sys_x9y8z7w6v5u4...    (系统级)
```

### 4.4 鉴权流程

```typescript
async function authenticate(req: Request): Promise<AuthContext> {
  const authHeader = req.headers.authorization;
  
  // 1. 检查 Internal Token (服务间调用)
  const internalToken = req.headers['x-internal-token'];
  if (internalToken) {
    return verifyInternalToken(internalToken);
  }
  
  // 2. 检查 Node Token (signal 专用)
  if (req.path.startsWith('/api/signal')) {
    const body = await req.json();
    if (body.nodeId && body.token) {
      return verifyNodeToken(body.nodeId, body.token);
    }
  }
  
  // 3. 检查 Authorization header
  if (!authHeader) {
    throw new UnauthorizedHttpError('Missing authorization');
  }
  
  // 4. API Key (sk- 前缀)
  if (authHeader.startsWith('Bearer sk-')) {
    const apiKey = authHeader.slice(7);
    return verifyApiKey(apiKey);
  }
  
  // 5. Solid Token (Bearer/DPoP)
  return verifySolidToken(req, authHeader);
}
```

### 4.5 各 API 鉴权要求

| API | 允许的鉴权方式 | 权限要求 |
|-----|--------------|---------|
| `/api/signal/*` | Node Token | 绑定到该节点 |
| `/api/nodes` GET/POST | Solid Token | 登录用户 |
| `/api/nodes/:id` | Solid Token | 节点所有者 |
| `/api/quota/:webId` GET | Solid Token, API Key | 本人或有 `quota:read` |
| `/api/quota/:webId` PUT | API Key (系统级) | `quota:write` scope |
| `/api/keys/*` | Solid Token | 登录用户 |
| `/api/chat/*` | Solid Token, API Key | 登录用户或有 `chat` scope |

---

## 5. Chat API 设计 (兼容 OpenAI)

### 5.1 POST /api/chat/completions

**Request:**

```json
{
  "model": "gpt-4",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1000
}
```

**Response:**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 10,
    "total_tokens": 30
  }
}
```

**Streaming Response (SSE):**

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"!"}}]}

data: [DONE]
```

### 5.2 GET /api/chat/models

**Response:**

```json
{
  "object": "list",
  "data": [
    {"id": "gpt-4", "object": "model", "owned_by": "openai"},
    {"id": "gpt-3.5-turbo", "object": "model", "owned_by": "openai"},
    {"id": "claude-3-opus", "object": "model", "owned_by": "anthropic"}
  ]
}
```

### 5.3 使用方式

**方式 1: Solid App (前端)**

```typescript
// 使用 Solid Session 自动携带 token
const response = await fetch('https://xpod.example.com/api/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `DPoP ${accessToken}`,
    'DPoP': dpopProof,
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
});
```

**方式 2: 第三方 App (API Key)**

```typescript
// 直接使用 OpenAI SDK
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-user_xxx',  // 用户在 Dashboard 生成的 API Key
  baseURL: 'https://xpod.example.com/api',
});

const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### 5.4 配额计费

```typescript
async function handleChatCompletion(req: Request, auth: AuthContext) {
  // 1. 确定计费用户
  const billingWebId = auth.method === 'api-key' ? auth.keyOwner : auth.webId;
  
  // 2. 检查配额
  const quota = await quotaService.get(billingWebId);
  if (quota.tokensUsed >= quota.tokensLimit) {
    throw new PaymentRequiredHttpError('Token quota exceeded');
  }
  
  // 3. 调用 AI
  const result = await aiProvider.chat(req.body);
  
  // 4. 扣减配额
  await quotaService.deduct(billingWebId, result.usage.total_tokens);
  
  return result;
}
```

---

## 6. API Key 管理 API

### 6.1 POST /api/keys (创建)

**Request:**

```json
{
  "name": "My App Key",
  "scopes": ["chat"],
  "expiresIn": 2592000  // 30 天，可选
}
```

**Response:**

```json
{
  "id": "key_abc123",
  "name": "My App Key",
  "key": "sk-user_xyzABC...",  // 仅返回一次！
  "scopes": ["chat"],
  "createdAt": "2024-01-01T00:00:00Z",
  "expiresAt": "2024-01-31T00:00:00Z"
}
```

### 6.2 GET /api/keys (列出)

**Response:**

```json
{
  "keys": [
    {
      "id": "key_abc123",
      "name": "My App Key",
      "scopes": ["chat"],
      "createdAt": "2024-01-01T00:00:00Z",
      "expiresAt": "2024-01-31T00:00:00Z",
      "lastUsedAt": "2024-01-15T12:00:00Z"
    }
  ]
}
```

### 6.3 DELETE /api/keys/:id (删除)

**Response:** `204 No Content`

---

## 7. 服务间通信

**通信方向：单向，API 服务 → CSS**

CSS 主服务不需要调用 API 服务。API 服务在需要写入 Pod 数据时调用 CSS。

```
┌─────────────┐                      ┌─────────────┐
│  CSS 主服务  │ ←── Internal Token ──│  API 服务   │
│             │     (写入 Pod 时)     │             │
└──────┬──────┘                      └──────┬──────┘
       │                                    │
       │         ┌──────────────┐           │
       └────────►│  PostgreSQL  │◄──────────┘
                 │  (共享读写)   │
                 └──────────────┘
```

### 7.1 API 服务 → 数据库 (直连)

```typescript
// 读取用户数据，复用 QuintStore
import { createQuintStore } from 'xpod/storage/quint';

const store = createQuintStore(process.env.DATABASE_URL);

// 查询用户 Pod 数据
const quads = await store.get({
  graph: `${podBaseUrl}/profile/card`,
});
```

### 7.2 API 服务 → CSS (需要写入时)

```typescript
// 通过 Internal Token 调用 CSS
const internalToken = jwt.sign(
  { iss: 'xpod-api', iat: Date.now() },
  process.env.INTERNAL_SECRET
);

await fetch(`${CSS_URL}/path/to/resource`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'text/turtle',
    'X-Internal-Token': internalToken,
  },
  body: turtleData,
});
```

### 7.3 CSS 侧 Internal Token 验证

```typescript
// 在 CSS handler chain 最前面
if (req.headers['x-internal-token']) {
  try {
    jwt.verify(req.headers['x-internal-token'], INTERNAL_SECRET);
    req.credentials = { isInternal: true, agent: { webId: 'system' } };
    // 跳过后续鉴权
  } catch {
    // 无效 token，继续正常流程
  }
}
```

---

## 8. 配置

### 8.1 环境变量

```bash
# 共享
DATABASE_URL=postgresql://user:pass@localhost:5432/xpod
INTERNAL_SECRET=your-shared-secret-between-css-and-api

# CSS 主服务
PORT=3000

# API 服务
API_PORT=3001
CSS_INTERNAL_URL=http://localhost:3000  # 内网地址

# AI Provider (API 服务)
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-xxx
```

### 8.2 启动命令

```bash
# Local 模式
yarn local          # CSS :3000
yarn api:local      # API :3001

# Server 模式
yarn server         # CSS :3000
yarn api:server     # API :3001 (可多实例)
```

---

## 9. 实现计划

### Phase 1: 基础架构
- [ ] 创建 `api-server/` 目录结构
- [ ] 实现鉴权中间件 (Solid Token + API Key)
- [ ] 实现 API Key 数据模型和管理 API

### Phase 2: 迁移现有 API
- [ ] 迁移 `/api/signal/*`
- [ ] 迁移 `/api/quota/*`
- [ ] 迁移 `/api/nodes/*` (原 `/admin/nodes/*`)

### Phase 3: Chat API
- [ ] 实现 `/api/chat/completions` (兼容 OpenAI)
- [ ] 实现配额计费逻辑
- [ ] 实现流式响应 (SSE)

### Phase 4: 生产就绪
- [ ] 添加 rate limiting
- [ ] 添加请求日志和监控
- [ ] 编写 API 文档 (OpenAPI/Swagger)
- [ ] Local 模式进程管理

---

## 10. 安全考虑

1. **API Key 存储**：只存 hash，不存明文
2. **Internal Token**：短有效期 (30秒)，仅限内网
3. **Rate Limiting**：按 API Key / WebID 限流
4. **审计日志**：记录所有敏感操作
5. **Scope 最小化**：API Key 默认最小权限
