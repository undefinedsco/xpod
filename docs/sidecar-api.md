# Sidecar API (`/-/` 路径模式)

Xpod 使用 `/-/` 路径模式提供资源级别的扩展 API，灵感来自 GitLab 的路径设计。

## 设计原则

### 路径约定

```
{resource_path}/-/{service}
```

- `/-/` 是保留的路径分隔符，不会与用户资源冲突
- 权限继承自 `/-/` 之前的资源路径
- 服务端点挂载在资源路径下，提供上下文感知的功能

### 权限模型

| 资源路径 | Sidecar API | 权限继承 |
|---------|-------------|---------|
| `/alice/` | `/alice/-/sparql` | 继承 `/alice/` 的 ACL |
| `/alice/photos/` | `/alice/photos/-/sparql` | 继承 `/alice/photos/` 的 ACL |
| `/alice/project/` | `/alice/project/-/terminal` | 继承 `/alice/project/` 的 ACL |

### 与 `.suffix` 模式对比

| 对比 | `/-/sparql` | `.sparql` |
|------|-------------|-----------|
| 冲突风险 | 低（`-` 是保留字符） | 高（用户可能创建叫 `sparql` 的资源） |
| 语义 | 明确是"API入口" | 可能和资源混淆 |
| 扩展性 | 统一模式：`/-/sparql`, `/-/vector`, `/-/terminal` | 需要不同后缀 |
| 路径解析 | 一次匹配 `/-/` | 需要判断多种后缀 |

---

## 现有服务

### `/-/sparql` - SPARQL 查询端点

提供对 RDF 数据的 SPARQL 1.1 查询能力。

**端点**：
```
GET  {path}/-/sparql?query=...
POST {path}/-/sparql
```

**Content-Type**：
- `application/sparql-query` - SELECT/ASK/CONSTRUCT/DESCRIBE
- `application/sparql-update` - INSERT/DELETE
- `application/x-www-form-urlencoded` - 表单提交

**权限映射**：
| 操作 | 所需权限 |
|------|----------|
| SELECT, ASK, CONSTRUCT, DESCRIBE | `read` |
| INSERT | `append` |
| DELETE | `delete` |

**作用域限制**：
- Graph IRI 必须在当前端点的 basePath 范围内
- 不允许跨 Pod 查询

详见 [sparql-support.md](./sparql-support.md)

---

## 规划服务

### `/-/terminal` - Agent 终端服务

为 AI Agent（如 Claude Code）及通用 CLI 工具提供交互式终端能力。

**设计目标**：
- 将计算（CLI 进程）与交互（终端流）解耦
- 支持 HTTP-Based Streaming，完美穿透 FRP/Nginx 代理
- 上层 App 可自由定制 UI（原生 Terminal 或 Chat 界面）

**端点**：
```
POST {path}/-/terminal                    # 创建会话，返回 Session ID
GET  {path}/-/terminal/{sessionId}        # SSE 下行流 (stdout/stderr)
POST {path}/-/terminal/{sessionId}/input  # 上行输入 (stdin)
```

**行为**：
- CWD 自动设置为 `{path}` 对应的资源目录
- 使用标准 HTTPS，无需 WebSocket Upgrade
- 支持自动重连 (Last-Event-ID)

**权限**：
| 操作 | 权限要求 |
|------|---------|
| 创建会话 | 资源 `write` 权限 |
| 输入/流 | Session Owner (Bearer Token) |

**隔离策略**：
- 默认：Process Isolation (No Sandbox)
- 依赖宿主机预装 Shell (bash/zsh/powershell) 及 Agent CLI
- 安全依靠 Solid 权限检查与用户交互确认 (Human-in-the-loop)

**运行时管理**：
- Edge 模式：使用 `node-pty` 本地运行
- Cluster 模式（未来）：对接 K8s Job
- 自动挂载 Pod 数据目录到 `/workspace`

---

### `/-/search` - 语义搜索服务

为 AI 应用提供语义搜索能力，极简设计。

**端点**：
```
GET  {path}/-/search?q=...     # 语义搜索
POST {path}/-/search           # 语义搜索（支持复杂查询）
```

**设计原则**：
- **极简 API**：只有 search 端点，状态通过 RDF 元数据查看
- **自动索引**：通过 Store 层钩子自动触发，写文件即索引
- **CSS 原生鉴权**：继承 `/-/` 之前路径的 ACL，无需额外鉴权

**索引触发**：
- 写入 `.ttl` 文件定义 `VectorStore`（指定索引范围、模型等）
- 文件创建/修改/删除自动触发向量索引更新
- 通过 `ObservableResourceStore` 的事件机制实现

**状态查看**：
- 直接 GET VectorStore 定义文件（如 `/settings/vector-stores.ttl`）
- 索引状态、文件数量等作为 RDF 属性存储

**架构**：
- 在存储层 (Data Accessor) 原生集成向量支持
- SQLite: 集成 `sqlite-vec`
- PostgreSQL: 集成 `pgvector`

**AI 凭据**：
- 从 Pod 的 `/settings/credentials.ttl` 读取
- 使用 `SparqlEngine` 内部查询，无需 HTTP 往返

---

### `/-/responses` - LLM Responses API 代理

为 OpenAI Responses API 提供资源上下文注入能力。

**端点**（规划）：
```
POST {path}/-/responses    # OpenAI Responses API 兼容
```

**行为**：
- **Stateless Proxy**：不维护会话状态，仅透传请求/响应流
- **Context Injection**：读取当前资源（及子资源）内容，注入到 Payload 中
- 支持 `file_citation` 或 `system_context` 格式

**权限**：
- 检查资源 `read` 权限
- Bearer Token 用于计费或透传给 LLM

---

### `/-/jobs` - 后台任务服务

支持一次性或定时任务 (Cron)。

**端点**（规划）：
```
POST   {path}/-/jobs              # 提交任务
GET    {path}/-/jobs              # 列出任务
GET    {path}/-/jobs/{jobId}      # 任务状态
DELETE {path}/-/jobs/{jobId}      # 取消任务
```

**参数**：
```json
{
  "command": "python script.py",
  "schedule": "0 2 * * *",
  "timeout": 3600
}
```

**日志**：自动将 stdout/stderr 重定向至 Pod `/-/logs/` 目录

---

## 配置

### 服务启用

在 `config/extensions.*.json` 中配置：

```json
{
  "@type": "SidecarApiHandler",
  "services": {
    "sparql": { "enabled": true },
    "terminal": { "enabled": true, "allowedCommands": ["claude", "python", "node"] },
    "vector": { "enabled": false },
    "responses": { "enabled": false }
  }
}
```

### 安全白名单

Terminal 服务需要配置允许运行的命令白名单：

```json
{
  "terminal": {
    "allowedCommands": ["claude", "python", "node", "git", "npm"],
    "blockedCommands": ["rm -rf", "sudo", "su"],
    "maxSessions": 10,
    "sessionTimeout": 3600
  }
}
```

---

## 实现状态

| 服务 | 状态 | 组件 |
|------|------|------|
| `/-/sparql` | ✅ 已实现 | `SubgraphSparqlHttpHandler` |
| `/-/search` | 📋 规划中 | `SearchHttpHandler` |
| `/-/terminal` | 📋 规划中 | - |
| `/-/responses` | 📋 规划中 | - |
| `/-/jobs` | 📋 规划中 | - |

---

## 相关文档

- [sparql-support.md](./sparql-support.md) - SPARQL 详细文档
- [modern-pod-roadmap.md](./modern-pod-roadmap.md) - 控制面路线图
