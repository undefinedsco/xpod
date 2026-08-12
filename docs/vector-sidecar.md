# Vector Search (/-/search)

> **状态：历史设计 / 已删除实现。** 本文仅保留早期 `/-/search` sidecar
> 方案，便于追踪架构演进。当前主线以
> [RDF Engine Spec](rdf-engine-spec.md) 的 `RdfTextIndex` / `RdfVectorIndex`
> 与 [Progressive Semantic Index](progressive-semantic-index.md) 为准：
> text/vector 都是 RDF engine 的派生索引，embedding provider / model /
> credential 复用用户 Pod 的 AI config；原始密钥通过
> [Extension Runtime and Credential Resolution](extension-runtime-and-credential-resolution.md)
> 的 Pod exact model/credential 解析和 durable reconciliation 为准；原始密钥
> 不进入索引、Run record 或 cache。下文提到的 `VectorIndexingListener` 已从
> 源码、组件配置和公开导出中删除，不可作为实现指引。

为 Xpod 提供语义搜索能力，采用极简设计。

## 架构概览

```
读路径 (Sidecar HTTP Handler)
┌─────────────────────────────────────────────────────────────┐
│  SidecarHttpHandler                                         │
│  ├── /-/sparql    → SubgraphSparqlHttpHandler              │
│  └── /-/search    → SearchHttpHandler                       │
└─────────────────────────────────────────────────────────────┘

写路径 (Store Chain) - 自动触发索引
┌─────────────────────────────────────────────────────────────┐
│  ObservableResourceStore                                    │
│  - emit('resource:changed', { path, action })               │
│         ↓                                                   │
│  订阅者:                                                     │
│  - UsageTrackingListener (带宽/存储统计)                     │
│  - VectorIndexingListener (向量索引)                         │
│         ↓                                                   │
│  SparqlUpdateResourceStore                                  │
│         ↓                                                   │
│  DataAccessor                                               │
└─────────────────────────────────────────────────────────────┘
```

## 设计原则

### 极简 API

| 操作 | 方式 |
|------|------|
| 搜索 | `GET {path}/-/search?q=...` |
| 定义 VectorStore | 写 `.ttl` 文件（如 `/settings/vector-stores.ttl`） |
| 触发索引 | 自动（写/改/删文件时触发） |
| 查看状态 | 读 VectorStore 定义文件（RDF 元数据） |

**无需**：
- 单独的 `/index` 端点
- 单独的 `/status` 端点
- 单独的 `/upsert` 或 `/delete` 端点

### CSS 原生鉴权

- `/-/search` 继承 `/-/` 之前路径的 ACL
- 无需 API Server 额外鉴权
- AI 凭据通过 `SparqlEngine` 内部读取，不走 HTTP

### 自动索引

通过 `ObservableResourceStore` 的事件机制：

```typescript
// 写操作完成后发事件
this.emit('resource:changed', {
  path: identifier.path,
  action: 'create' | 'update' | 'delete'
});

// VectorIndexingListener 订阅事件
on('resource:changed', async ({ path, action }) => {
  if (this.shouldIndex(path)) {
    if (action === 'delete') {
      await this.removeFromIndex(path);
    } else {
      await this.indexResource(path);
    }
  }
});
```

---

## VectorStore 定义

用户通过写 RDF 文件定义 VectorStore：

```turtle
# /settings/vector-stores.ttl
@prefix xpod: <https://xpod.dev/ns#> .
@prefix schema: <http://schema.org/> .

<#documents>
  a xpod:VectorStore ;
  xpod:scope </documents/> ;           # 索引范围
  xpod:model "text-embedding-004" ;    # embedding 模型
  xpod:status "active" ;               # 状态
  xpod:indexedCount 150 ;              # 已索引文件数（自动更新）
  xpod:lastIndexedAt "2024-01-15T10:30:00Z" .

<#notes>
  a xpod:VectorStore ;
  xpod:scope </notes/> ;
  xpod:model "text-embedding-004" ;
  xpod:chunkSize 1000 ;                # 可选：分块大小
  xpod:chunkOverlap 200 .              # 可选：分块重叠
```

### 属性说明

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `xpod:scope` | URI | 是 | 索引范围（Container URI） |
| `xpod:model` | string | 否 | embedding 模型，默认使用系统配置 |
| `xpod:status` | string | 否 | active/paused，默认 active |
| `xpod:chunkSize` | integer | 否 | 文本分块大小 |
| `xpod:chunkOverlap` | integer | 否 | 分块重叠字符数 |
| `xpod:indexedCount` | integer | 自动 | 已索引文件数 |
| `xpod:lastIndexedAt` | dateTime | 自动 | 最后索引时间 |

---

## API 端点

### GET/POST `{path}/-/search`

语义搜索。

**GET 请求**：

```
GET /alice/documents/-/search?q=机器学习&limit=10
```

**POST 请求**（支持复杂查询）：

```json
{
  "query": "关于机器学习的笔记",
  "limit": 10,
  "threshold": 0.7,
  "filter": {
    "type": "http://schema.org/Article"
  }
}
```

**响应**：

```json
{
  "results": [
    {
      "subject": "https://pod.example/alice/notes/ml-intro.md",
      "score": 0.92,
      "snippet": "机器学习是人工智能的一个分支..."
    }
  ],
  "model": "text-embedding-004",
  "took_ms": 45
}
```

**权限**：继承 `{path}` 的 `read` 权限

---

## 内部实现

### SearchHttpHandler

```typescript
export class SearchHttpHandler extends HttpHandler {
  constructor(
    private sparqlEngine: SparqlEngine,
    private vectorStore: VectorStore,
    private embeddingService: EmbeddingService,
    private credentialsExtractor: CredentialsExtractor,
    private authorizer: Authorizer,
  ) {}

  async handle({ request, response }: HttpHandlerInput): Promise<void> {
    // 1. 鉴权（CSS 原生）
    await this.authorizeFor(baseUrl, request, [PERMISSIONS.Read]);

    // 2. 读取 AI 凭据（通过 SparqlEngine，不走 HTTP）
    const credential = await this.getAiCredential(baseUrl);

    // 3. 生成 query embedding
    const queryVector = await this.embeddingService.embed(query, credential);

    // 4. 向量搜索
    const results = await this.vectorStore.search(queryVector, options);

    // 5. 返回结果
    this.sendJsonResponse(response, { results, model, took_ms });
  }
}
```

### 读取 AI 凭据

使用 `SparqlEngine` 内部查询，不走 HTTP：

```typescript
async getAiCredential(podBaseUrl: string): Promise<AiCredential> {
  const query = `
    PREFIX xpod: <https://xpod.dev/ns#>
    SELECT ?apiKey ?baseUrl WHERE {
      ?cred a xpod:Credential ;
            xpod:service "AI" ;
            xpod:status "active" ;
            xpod:apiKey ?apiKey .
      OPTIONAL { ?cred xpod:baseUrl ?baseUrl }
    } LIMIT 1
  `;
  const bindings = await this.sparqlEngine.queryBindings(query, podBaseUrl);
  // 解析 bindings 返回 credential
}
```

### VectorIndexingListener

监听资源变更，自动触发索引：

```typescript
export class VectorIndexingListener {
  constructor(
    private sparqlEngine: SparqlEngine,
    private vectorStore: VectorStore,
    private embeddingService: EmbeddingService,
  ) {}

  async onResourceChanged(path: string, action: 'create' | 'update' | 'delete'): Promise<void> {
    // 1. 查找覆盖此路径的 VectorStore
    const vectorStores = await this.findVectorStoresForPath(path);
    if (vectorStores.length === 0) return;

    // 2. 根据 action 执行索引操作
    if (action === 'delete') {
      await this.vectorStore.deleteBySubject(path);
    } else {
      // 读取资源内容，生成 embedding，存入向量库
      const content = await this.getResourceContent(path);
      const credential = await this.getAiCredential(path);
      const vector = await this.embeddingService.embed(content, credential);
      await this.vectorStore.upsert(path, vector);
    }

    // 3. 更新 VectorStore 元数据（indexedCount, lastIndexedAt）
    await this.updateVectorStoreMetadata(vectorStores);
  }
}
```

---

## 数据库设计

### 向量表结构

```sql
-- 每个 embedding 模型一张表
CREATE TABLE quint_vec_{model_id} (
  id INTEGER PRIMARY KEY,       -- 关联 quints.rowid
  embedding BLOB NOT NULL,      -- 向量数据
  created_at INTEGER DEFAULT (unixepoch())
);
```

### 与 quints 表关联

```sql
-- 语义搜索 + 子图过滤
SELECT
  v.id,
  q.subject,
  q.graph,
  distance(v.embedding, ?) AS dist
FROM quint_vec_1 v
JOIN quints q ON q.rowid = v.id
WHERE q.graph >= ?              -- 子图前缀下界
  AND q.graph < ?               -- 子图前缀上界
ORDER BY dist
LIMIT ?;
```

---

## 配置

### 环境变量

```bash
CSS_VECTOR_ENABLED=true
CSS_EMBEDDING_DEFAULT_MODEL=text-embedding-004
CSS_VECTOR_BATCH_SIZE=100
```

### 组件配置

```json
{
  "@id": "urn:xpod:SearchHttpHandler",
  "@type": "SearchHttpHandler",
  "sidecarPath": "/-/search",
  "sparqlEngine": { "@id": "urn:xpod:SparqlEngine" },
  "vectorStore": { "@id": "urn:xpod:VectorStore" },
  "embeddingService": { "@id": "urn:xpod:EmbeddingService" },
  "credentialsExtractor": { "@id": "urn:solid-server:default:CredentialsExtractor" },
  "authorizer": { "@id": "urn:solid-server:default:Authorizer" }
}
```

---

## 实现计划

### 文件结构

```
src/
├── http/
│   └── search/
│       └── SearchHttpHandler.ts       # /-/search 处理器
├── storage/
│   ├── ObservableResourceStore.ts     # 可观察的 Store 包装
│   └── vector/
│       ├── VectorStore.ts             # 向量存储
│       └── VectorIndexingListener.ts  # 索引监听器
├── embedding/
│   └── EmbeddingService.ts            # Embedding 服务
└── util/
    └── SparqlEngineFetch.ts           # SparqlEngine → fetch 适配器
```

### 阶段划分

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | ObservableResourceStore + 事件机制 | 📋 |
| P1 | VectorIndexingListener + 自动索引 | 📋 |
| P2 | SearchHttpHandler + /-/search 端点 | 📋 |
| P3 | SparqlEngineFetch + drizzle-solid 集成 | 📋 |

---

## 相关文档

- [sidecar-api.md](./sidecar-api.md) - Sidecar API 设计
- [credential-schema.md](./credential-schema.md) - 凭据存储 Schema
- [sparql-support.md](./sparql-support.md) - SPARQL 实现参考
