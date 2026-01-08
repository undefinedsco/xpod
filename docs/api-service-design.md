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

### 2.2 Local 模式 (LinX 桌面端)

在 LinX 桌面版中，API 服务作为子进程随桌面端启动，为本地 AI 能力提供转换。

```
┌─────────────────────────────────────────────────────────┐
│                    LinX 桌面端本地模式                    │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │ LinX UI     │───►│ CSS :3000   │    │ API :3001   │ │
│  │ (渲染进程)   │───►│ (xPod 内核) │    │ (xPod 内核) │ │
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

### 5.3 使用方式

**方式 1: LinX App (前端)**

```typescript
// LinX 使用 Solid Session 自动携带 token
const response = await fetch('https://pod.example.com/api/chat/completions', {
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

---

## 7. 服务间通信

**通信方向：单向，API 服务 → CSS**

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

# 注：AI Provider 配置现在存储在用户 Pod 中，不再通过环境变量全局配置。
```

---

## 9. 实现计划

### Phase 1: 基础架构
- [x] 创建 `api-server/` 目录结构
- [x] 实现鉴权中间件 (Solid Token + API Key)
- [x] 实现 API Key 数据模型和管理 API

### Phase 2: 迁移现有 API
- [x] 迁移 `/api/signal/*`
- [x] 迁移 `/api/quota/*`
- [x] 迁移 `/api/nodes/*`

### Phase 3: Chat API
- [x] 实现 `/api/chat/completions` (兼容 OpenAI)
- [x] 实现流式响应 (SSE)

### Phase 4: 生产就绪与集成
- [ ] 添加 rate limiting
- [ ] 本地模式进程管理 (LinX 集成)
- [ ] 编写 API 文档 (OpenAPI/Swagger)