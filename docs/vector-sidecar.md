# Vector Sidecar

Vector Sidecar 为 Xpod 提供向量嵌入和语义搜索能力，支持 AI 应用进行基于语义的资源检索。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        Vector Sidecar                        │
├─────────────────────────────────────────────────────────────┤
│  HTTP Layer                                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              VectorHttpHandler                       │    │
│  │  POST /-/vector/index   (索引资源)                   │    │
│  │  POST /-/vector/search  (语义搜索)                   │    │
│  │  GET  /-/vector/status  (索引状态)                   │    │
│  │  GET  /-/vector/models  (模型列表)                   │    │
│  └─────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│  Service Layer                                               │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ EmbeddingService │  │  VectorService   │                 │
│  │  - 调用外部 API   │  │  - 索引管理      │                 │
│  │  - 多模型支持     │  │  - 搜索执行      │                 │
│  │  - 批量处理      │  │  - 迁移协调      │                 │
│  └──────────────────┘  └──────────────────┘                 │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   VectorStore                        │    │
│  │  ┌─────────────────┐  ┌─────────────────┐           │    │
│  │  │ embedding_models │  │ quint_vec_{id}  │           │    │
│  │  │   (模型元数据)    │  │   (向量数据)     │           │    │
│  │  └─────────────────┘  └─────────────────┘           │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│                              ▼                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    quints 表                         │    │
│  │         (通过 rowid 关联，JOIN 查询过滤)              │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 数据模型

### Embedding 粒度

| 粒度 | 说明 | 标识 |
|------|------|------|
| **GSPO** | 最小粒度，单条四元组的 embedding（按需生成） | `quints.rowid` |
| **Subject** | 实体 embedding，根据 `rdf:type` 挑选相关属性计算 | `quints.rowid` (type triple) |
| **文件** | 文件作为 subject 的 embedding | `quints.rowid` |
| **文档块** | Lazy 分块后的子资源，也是 Pod 上的实体 | `quints.rowid` (chunk triple) |

### 设计原则

1. **Lazy 分块** - 按需分块，用户访问或 AI 需要时才进行分块
2. **多版本共存** - 升级过程中新旧 embedding 同时服务
3. **统一架构** - SQLite 和 PostgreSQL 使用相同的表结构设计

---

## 数据库设计

### 表结构

#### 1. embedding_models（模型元数据表）

存储 embedding 模型的配置信息，支持多版本管理。

```sql
CREATE TABLE embedding_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- PG: SERIAL
  name TEXT NOT NULL UNIQUE,             -- 模型标识，如 'text-embedding-004'
  provider TEXT NOT NULL,                -- 提供商，如 'google', 'openai'
  dimension INTEGER NOT NULL,            -- 向量维度，如 768, 3072
  status TEXT NOT NULL DEFAULT 'active', -- 状态：active, migrating, deprecated
  config TEXT,                           -- JSON 配置（API endpoint, 参数等）
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- 索引
CREATE INDEX idx_embedding_models_status ON embedding_models (status);
```

**状态流转**：

```
active ──────► migrating ──────► deprecated
   │              │                  │
   │              │                  ▼
   │              │              (可删除)
   │              ▼
   └─────► active (新模型)
```

#### 2. quint_vec_{model_id}（向量数据表，每个模型一个）

存储实际的向量数据，通过 `quints.rowid` 关联。

```sql
-- 动态创建，{model_id} 为 embedding_models.id
CREATE TABLE quint_vec_{model_id} (
  id INTEGER PRIMARY KEY,       -- 关联 quints.rowid
  embedding BLOB NOT NULL,      -- 向量数据 (float[] 序列化)
  created_at INTEGER DEFAULT (unixepoch())
);
```

**说明**：

- `id` 直接使用 `quints` 表的 `rowid`，无需额外映射
- `embedding` 存储为 BLOB（float32 数组序列化），SQLite 和 PG 统一处理
- 每个模型独立一张表，便于：
  - 不同维度的向量
  - 独立迁移和删除
  - 并行查询

### ER 关系

```
┌─────────────────┐         ┌─────────────────┐
│ embedding_models │         │     quints      │
├─────────────────┤         ├─────────────────┤
│ id (PK)         │         │ rowid (隐式 PK)  │
│ name            │         │ graph           │
│ provider        │         │ subject         │
│ dimension       │         │ predicate       │
│ status          │         │ object          │
│ config          │         │ vector (legacy) │
│ created_at      │         │                 │
│ updated_at      │         └────────┬────────┘
└────────┬────────┘                  │
         │                           │
         │ 1:N                       │ 1:1
         ▼                           ▼
┌─────────────────────────────────────────────┐
│           quint_vec_{model_id}              │
├─────────────────────────────────────────────┤
│ id (PK, FK → quints.rowid)                  │
│ embedding (BLOB)                            │
│ created_at                                  │
└─────────────────────────────────────────────┘
```

---

## 查询设计

### 语义搜索（带过滤）

通过 JOIN `quints` 表实现子图过滤 + 向量搜索：

```sql
-- 子图前缀匹配 + 向量相似度搜索
SELECT 
  v.id,
  v.embedding,
  q.graph,
  q.subject,
  q.predicate,
  q.object,
  distance(v.embedding, ?) AS dist
FROM quint_vec_1 v
JOIN quints q ON q.rowid = v.id
WHERE q.graph >= ?              -- 子图前缀下界
  AND q.graph < ?               -- 子图前缀上界 (prefix + '\uffff')
ORDER BY dist
LIMIT ?;
```

### 复杂过滤

支持基于 `quints` 表任意字段的过滤：

```sql
-- 按类型过滤 + 向量搜索
SELECT v.id, v.embedding, q.*
FROM quint_vec_1 v
JOIN quints q ON q.rowid = v.id
WHERE q.graph >= ? AND q.graph < ?
  AND q.predicate = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
  AND q.object = '<http://schema.org/Article>'
ORDER BY distance(v.embedding, ?)
LIMIT 10;
```

### 平台差异处理

| 操作 | SQLite | PostgreSQL |
|------|--------|------------|
| 向量距离 | 应用层计算 / sqlite-vec | `<->` 运算符 (pgvector) |
| 向量索引 | sqlite-vec (可选) | HNSW / IVFFlat |
| JOIN 性能 | 先向量搜索取 Top N，再 JOIN 过滤 | 原生支持 JOIN + 向量排序 |

---

## 多版本迁移

### 迁移流程（双读策略）

采用**双读**而非双写，节省 embedding API 调用成本。

```
┌─────────────────────────────────────────────────────────────┐
│                   迁移流程（双读策略）                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 创建新模型                                               │
│     INSERT INTO embedding_models (name, status, ...)        │
│     VALUES ('text-embedding-005', 'migrating', ...);        │
│     CREATE TABLE quint_vec_2 (...);                         │
│                                                             │
│  2. 切换写入目标                                             │
│     - 新索引请求只写入 quint_vec_2（新模型）                  │
│     - 不再写入 quint_vec_1                                   │
│                                                             │
│  3. 双读阶段                                                 │
│     搜索时：                                                 │
│     - 先查 quint_vec_2（新模型）                             │
│     - 若结果不足，fallback 查 quint_vec_1（旧模型）          │
│     - 合并去重返回                                           │
│                                                             │
│  4. 后台迁移                                                 │
│     - 逐批将 quint_vec_1 中的记录迁移到 quint_vec_2          │
│     - 调用新模型重新生成 embedding                           │
│     - 记录进度，支持断点续传                                  │
│                                                             │
│  5. 完成切换                                                 │
│     UPDATE embedding_models SET status = 'active'           │
│       WHERE id = 2;                                         │
│     UPDATE embedding_models SET status = 'deprecated'       │
│       WHERE id = 1;                                         │
│                                                             │
│  6. 清理（可选）                                              │
│     DROP TABLE quint_vec_1;                                 │
│     DELETE FROM embedding_models WHERE id = 1;              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**双读 vs 双写**：

| 策略 | 索引成本 | 搜索复杂度 | 适用场景 |
|------|----------|-----------|---------|
| 双写 | 高（2x API） | 低 | API 成本低、迁移期短 |
| 双读 | 低（1x API） | 中 | API 成本高、迁移期长 |

### 迁移状态追踪

```sql
-- 可选：迁移进度表
CREATE TABLE embedding_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_model_id INTEGER NOT NULL,
  target_model_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
  total_count INTEGER,
  migrated_count INTEGER DEFAULT 0,
  last_migrated_id INTEGER,                -- 断点续传
  started_at INTEGER,
  completed_at INTEGER,
  error_message TEXT,
  FOREIGN KEY (source_model_id) REFERENCES embedding_models(id),
  FOREIGN KEY (target_model_id) REFERENCES embedding_models(id)
);
```

### 搜索时的版本选择（双读）

```typescript
async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
  // 获取活跃模型列表（按优先级排序：active > migrating）
  const models = await this.getActiveModels();
  
  let results: SearchResult[] = [];
  const seenIds = new Set<number>();
  
  for (const model of models) {
    if (results.length >= options.limit) break;
    
    // 生成查询向量
    const queryEmbedding = await this.embed(query, model);
    
    // 在当前模型搜索，排除已找到的 id
    const modelResults = await this.searchInModel(
      model, 
      queryEmbedding, 
      {
        ...options,
        limit: options.limit - results.length,
        excludeIds: seenIds
      }
    );
    
    // 合并结果
    for (const r of modelResults) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        results.push(r);
      }
    }
  }
  
  return results;
}
```

---

## API 端点

### 通用约定

- 请求/响应均为 `application/json`
- 响应头 `X-Request-ID` 返回可追踪的请求 ID
- `model` 与 `modelId` 同时提供时以 `model` 为准
- `{path}` 为 Sidecar scope，`subject`/`graph` 必须在该范围内
- `score` 为相似度 (0-1)，`distance = 1 - score`

### POST `{path}/-/vector/index`

索引指定资源的向量。

**请求**：

```json
{
  "targets": [
    {
      "subject": "https://pod.example/alice/notes/note1",
      "predicates": ["http://schema.org/text", "http://schema.org/name"]
    }
  ],
  "model": "text-embedding-004",  // 可选，默认使用活跃模型
  "force": false                   // 是否强制重新索引
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `targets` | array | 是 | 索引目标列表 |
| `targets[].subject` | string | 是 | 目标 subject IRI |
| `targets[].predicates` | string[] | 否 | 限定提取的谓词；为空使用服务端默认策略 |
| `targets[].graph` | string | 否 | 显式 graph IRI |
| `model` | string | 否 | 模型名称 |
| `modelId` | number | 否 | 模型 ID |
| `force` | boolean | 否 | 已有向量时是否覆盖 |
| `dryRun` | boolean | 否 | 仅校验与统计，不写入 |

**响应**：

```json
{
  "model": "text-embedding-004",
  "modelId": 1,
  "indexed": 3,
  "skipped": 1,
  "errors": [
    {
      "subject": "https://pod.example/alice/notes/note1",
      "code": "EMBEDDING_PROVIDER_ERROR",
      "message": "Provider error: rate_limit"
    }
  ],
  "took_ms": 42
}
```

**权限**：资源 `write` 权限

### POST `{path}/-/vector/search`

语义搜索。

**请求**：

```json
{
  "query": "关于机器学习的笔记",
  "limit": 10,
  "threshold": 0.7,           // 可选，相似度阈值
  "filter": {                 // 可选，额外过滤条件
    "type": "http://schema.org/Article"
  },
  "model": "text-embedding-004", // 可选
  "include": {                  // 可选
    "snippet": true,
    "distance": true
  }
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 查询文本，与 `embedding` 二选一 |
| `embedding` | number[] | 否 | 预计算向量，与 `query` 二选一 |
| `model` | string | 否 | 模型名称 |
| `modelId` | number | 否 | 模型 ID |
| `limit` | number | 否 | 返回数量上限 |
| `threshold` | number | 否 | 最低相似度阈值 |
| `filter` | object | 否 | 过滤条件 |
| `include` | object | 否 | 返回字段控制 |
| `after` | object | 否 | 游标分页 |

**filter 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `graphPrefix` | string | 子图前缀过滤 |
| `subjectPrefix` | string | subject 前缀过滤 |
| `predicate` | string | 限定 predicate |
| `object` | string | 限定 object |
| `type` | string | `rdf:type` 快捷过滤 |
| `excludeIds` | number[] | 排除指定向量 ID |

**include 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `snippet` | boolean | 是否返回文本片段 |
| `distance` | boolean | 是否返回 `distance` |
| `embedding` | boolean | 是否返回向量（谨慎使用） |
| `quint` | boolean | 是否返回原始四元组 |

**after 字段**：

```json
{
  "score": 0.88,
  "id": 12345
}
```

**响应**：

```json
{
  "results": [
    {
      "id": 12345,
      "subject": "https://pod.example/alice/notes/ml-intro",
      "graph": "https://pod.example/alice/notes/",
      "score": 0.92,
      "distance": 0.08,
      "snippet": "机器学习是人工智能的一个分支..."
    }
  ],
  "model": "text-embedding-004",
  "took_ms": 45,
  "next": {
    "after": { "score": 0.88, "id": 12345 }
  }
}
```

**权限**：资源 `read` 权限

### GET `{path}/-/vector/status`

获取索引状态。

**响应**：

```json
{
  "total_indexed": 1250,
  "default_model": "text-embedding-004",
  "by_model": {
    "text-embedding-004": {
      "count": 1250,
      "status": "active"
    },
    "text-embedding-005": {
      "count": 800,
      "status": "migrating",
      "migration_progress": 0.64
    }
  },
  "queue": {
    "size": 12,
    "capacity": 1000,
    "in_flight": 4
  },
  "last_indexed_at": "2024-01-15T10:30:00Z"
}
```

**权限**：资源 `read` 权限

### GET `{path}/-/vector/models`

获取可用的 embedding 模型列表。

**查询参数**：

- `status=active|migrating|deprecated`
- `provider=google|openai|...`
- `include=stats`（附带 `count`）

**响应**：

```json
{
  "models": [
    {
      "id": 1,
      "name": "text-embedding-004",
      "provider": "google",
      "dimension": 768,
      "status": "active",
      "count": 1250
    },
    {
      "id": 2,
      "name": "gemini-embedding-exp-03-07",
      "provider": "google",
      "dimension": 3072,
      "status": "migrating",
      "count": 800
    }
  ],
  "default": "text-embedding-004"
}
```

**权限**：资源 `read` 权限

### GET `{path}/-/vector/models/{id}`

获取单个模型详情。

**响应**：

```json
{
  "id": 1,
  "name": "text-embedding-004",
  "provider": "google",
  "dimension": 768,
  "status": "active",
  "config": { "endpoint": "https://..." },
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

---

## 错误码与返回约定

### 统一错误响应

```json
{
  "error": {
    "code": "MODEL_NOT_FOUND",
    "message": "Embedding model not found: text-embedding-004",
    "details": { "model": "text-embedding-004" }
  }
}
```

### 常见错误码

| HTTP | code | 场景 |
|------|------|------|
| 400 | `INVALID_REQUEST` | 请求体缺字段、字段类型错误 |
| 400 | `INDEX_TARGET_OUT_OF_SCOPE` | 目标不在 scope 内 |
| 401 | `UNAUTHORIZED` | 缺少或无效的凭据 |
| 403 | `FORBIDDEN` | 当前资源无读/写权限 |
| 404 | `MODEL_NOT_FOUND` | 指定模型不存在 |
| 404 | `MIGRATION_NOT_FOUND` | 迁移任务不存在 |
| 409 | `MODEL_ALREADY_EXISTS` | 模型名称重复 |
| 409 | `MODEL_STATUS_CONFLICT` | 状态冲突（如删除 active/migrating 模型） |
| 409 | `MIGRATION_CONFLICT` | 迁移任务冲突或重复 |
| 413 | `PAYLOAD_TOO_LARGE` | 单次索引 payload 过大 |
| 422 | `EMBEDDING_DIMENSION_MISMATCH` | embedding 维度与模型不一致 |
| 422 | `INVALID_MODEL_STATUS` | 不允许的状态变更 |
| 429 | `VECTOR_QUEUE_FULL` | 索引队列满载，请稍后重试 |
| 502 | `EMBEDDING_PROVIDER_ERROR` | 供应商 API 返回错误 |
| 503 | `EMBEDDING_PROVIDER_UNAVAILABLE` | 供应商不可用或超时 |
| 500 | `STORAGE_ERROR` | 向量表写入或查询失败 |

**重试建议**：
- `429`/`503` 返回 `Retry-After`，客户端应延时重试

---

## 模型管理与迁移 API（规划）

### 模型管理

**创建模型**

```
POST {path}/-/vector/models
```

```json
{
  "name": "text-embedding-005",
  "provider": "google",
  "dimension": 768,
  "status": "migrating",
  "config": { "endpoint": "https://..." }
}
```

**响应**：

```json
{
  "id": 3,
  "name": "text-embedding-005",
  "provider": "google",
  "dimension": 768,
  "status": "migrating"
}
```

**更新状态**

```
PATCH {path}/-/vector/models/{id}
```

```json
{
  "status": "active",
  "config": { "endpoint": "https://..." }
}
```

**状态流转**：

| 当前状态 | 可变更为 |
|----------|----------|
| `active` | `migrating`, `deprecated` |
| `migrating` | `active`, `deprecated` |
| `deprecated` | - |

**删除模型**

```
DELETE {path}/-/vector/models/{id}
```

- 仅允许删除 `deprecated` 模型
- 删除时会同时清理 `quint_vec_{model_id}`

**列表查询**

```
GET {path}/-/vector/models?status=active&provider=google
```

**权限**：写操作需要资源 `write` 权限

### 迁移任务

**创建迁移任务**

```
POST {path}/-/vector/migrations
```

```json
{
  "sourceModelId": 1,
  "targetModelId": 3,
  "batchSize": 100,
  "resumeFrom": 120000
}
```

**前置约束**：
- `sourceModelId` 与 `targetModelId` 必须存在且不同
- `targetModelId` 建议为 `migrating`

**响应**：

```json
{
  "id": 12,
  "status": "pending",
  "sourceModelId": 1,
  "targetModelId": 3,
  "migratedCount": 0
}
```

**查询迁移状态**

```
GET {path}/-/vector/migrations/{id}
```

```json
{
  "id": 12,
  "status": "running",
  "totalCount": 500000,
  "migratedCount": 120000,
  "lastMigratedId": 240001
}
```

**列表查询**

```
GET {path}/-/vector/migrations?status=running&sourceModelId=1
```

**控制迁移任务**

```
POST {path}/-/vector/migrations/{id}/pause
POST {path}/-/vector/migrations/{id}/resume
POST {path}/-/vector/migrations/{id}/cancel
```

**权限**：写操作需要资源 `write` 权限；查询需要 `read` 权限

---

## 运行流程

### 索引管线

1. 校验权限与请求参数，确定目标模型（显式 `model` 或当前 active）
2. 解析 `targets`：按 subject/predicates 拉取可索引文本，必要时进行 Lazy 分块
3. 以 `CSS_VECTOR_BATCH_SIZE` 批量调用 `EmbeddingService` 生成向量
4. 写入 `quint_vec_{model_id}`，统计 indexed/skipped/errors
5. 索引任务通过队列控并发，超限时返回错误并提示稍后重试

### 搜索管线

1. 生成 query embedding（active → migrating），开启双读去重
2. `VectorStore.search` 返回候选 id 与相似度
3. JOIN `quints` 做子图范围过滤与类型过滤
4. 组装响应：subject/graph + score + snippet（可选）

### 幂等与错误处理

- `force=false` 且向量已存在时跳过（计入 skipped）
- 单条失败不阻断批次，errors 记录失败原因
- 迁移期通过 `excludeIds` 去重，保证结果稳定

---

## 凭据管理

### API Key 来源

Embedding API Key 从用户 Pod 的 `preferencesFile` 中读取，使用统一的 Credential Schema：
- 复用 W3C Security Vocabulary (`sec:`) 已定义的属性
- 自定义 `udfs:` 词汇补充 API Key 等概念

**存储位置**：

```turtle
# WebID Profile
<#me> pim:preferencesFile </settings/prefs.ttl> .
```

```turtle
# /settings/prefs.ttl
@prefix udfs: <https://undefineds.co/ns#> .
@prefix sec: <https://w3id.org/security#> .

<> udfs:credentials <#credentials> .

<#credentials>
  a udfs:CredentialStore ;
  udfs:credential <#google-ai> .

<#google-ai>
  a udfs:ApiKeyCredential ;
  udfs:provider "google" ;
  udfs:service "ai" ;
  udfs:apiKey "AIzaSy..." ;
  sec:expires "2025-12-31T00:00:00Z"^^xsd:dateTime .  # 可选
```

**访问方式**：

1. 用户完成 OIDC 认证
2. Sidecar 以用户身份读取 `preferencesFile`
3. 查询 `udfs:ApiKeyCredential` 类型、指定 provider 的凭据
4. 提取 `udfs:apiKey` 调用 Embedding API

详见 [credential-schema.md](./credential-schema.md)

---

## 配置

### 环境变量

```bash
# Vector 服务配置
CSS_VECTOR_ENABLED=true
CSS_EMBEDDING_DEFAULT_PROVIDER=google   # 默认供应商
CSS_EMBEDDING_DEFAULT_MODEL=text-embedding-004

# 性能配置
CSS_VECTOR_BATCH_SIZE=100               # 批量 embedding 大小
CSS_VECTOR_SEARCH_LIMIT=100             # 默认搜索结果数
CSS_VECTOR_INDEX_QUEUE_SIZE=1000        # 索引队列大小
```

### 组件配置

```json
// config/vector.json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld",
    "https://linkedsoftwaredependencies.org/bundles/npm/@undefineds/xpod/^0.0.0/components/context.jsonld"
  ],
  "@graph": [
    {
      "@id": "urn:undefineds:xpod:VectorHttpHandler",
      "@type": "VectorHttpHandler",
      "sidecarPath": "/-/vector",
      "vectorStore": { "@id": "urn:undefineds:xpod:VectorStore" },
      "embeddingService": { "@id": "urn:undefineds:xpod:EmbeddingService" },
      "credentialsExtractor": { "@id": "urn:solid-server:default:CredentialsExtractor" },
      "authorizer": { "@id": "urn:solid-server:default:Authorizer" }
    },
    {
      "@id": "urn:undefineds:xpod:VectorStore",
      "@type": "VectorStore",
      "quintStore": { "@id": "urn:undefineds:xpod:QuintStore" }
    },
    {
      "@id": "urn:undefineds:xpod:EmbeddingService",
      "@type": "EmbeddingService",
      "provider": "google",
      "defaultModel": "text-embedding-004"
    }
  ]
}
```

### 集成到 HTTP Pipeline

在 `extensions.*.json` 中引入 `vector.json`，并将 `VectorHttpHandler` 放在 `LdpHandler` 之前：

```json
{
  "import": ["./vector.json"],
  "@graph": [
    {
      "@type": "Override",
      "overrideInstance": { "@id": "urn:solid-server:default:BaseHttpHandler" },
      "overrideParameters": {
        "@type": "StatusWaterfallHandler",
        "handlers": [
          { "@id": "urn:undefineds:xpod:SubgraphSparqlHttpHandler" },
          { "@id": "urn:undefineds:xpod:VectorHttpHandler" },
          { "@id": "urn:undefineds:xpod:AppStaticAssetHandler" },
          { "@id": "urn:solid-server:default:LdpHandler" }
        ]
      }
    }
  ]
}
```

---

## 实现计划

### 文件结构

```
src/
├── http/
│   └── vector/
│       ├── VectorHttpHandler.ts      # HTTP 处理器
│       └── index.ts
├── storage/
│   └── vector/
│       ├── VectorStore.ts            # 向量存储接口与实现
│       ├── types.ts                  # 类型定义
│       └── index.ts
├── service/
│   └── vector/
│       ├── EmbeddingService.ts       # Embedding 生成服务
│       ├── VectorService.ts          # 向量业务逻辑
│       ├── MigrationService.ts       # 迁移服务
│       └── index.ts
config/
└── vector.json                       # 组件配置
tests/
└── vector/
    ├── VectorStore.test.ts
    ├── VectorHttpHandler.test.ts
    └── EmbeddingService.test.ts
```

### 阶段划分

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | 数据库设计、VectorStore 基础实现 | 📋 |
| P1 | EmbeddingService、基础 API (index/search) | 📋 |
| P2 | 多版本支持、迁移服务 | 📋 |
| P3 | 性能优化、sqlite-vec/pgvector 集成 | 📋 |

---

## 相关组件

| 组件 | 文件 | 说明 |
|------|------|------|
| EmbeddingServiceImpl | `src/embedding/EmbeddingService.ts` | embedding 调用封装 |
| ProviderRegistryImpl | `src/embedding/ProviderRegistryImpl.ts` | 供应商/模型元信息缓存 |
| VectorStoreImpl | `src/storage/vector/VectorStore.ts` | SQLite/PG 向量存储 |
| VectorHttpHandler | `src/http/vector/VectorHttpHandler.ts` | Sidecar HTTP 入口（规划） |
| VectorService | `src/service/vector/VectorService.ts` | 索引与搜索编排（规划） |
| MigrationService | `src/service/vector/MigrationService.ts` | 模型迁移协调（规划） |

---

## 相关文档

- [credential-schema.md](./credential-schema.md) - 凭据存储 Schema
- [sidecar-api.md](./sidecar-api.md) - Sidecar API 设计
- [sparql-support.md](./sparql-support.md) - SPARQL 实现参考
- [terminal-sidecar.md](./terminal-sidecar.md) - Terminal Sidecar 实现参考
