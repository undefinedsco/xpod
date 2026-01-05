# Vector API Server 集成指南

本文档说明外部 API Server 需要实现的功能，以配合 xpod server 的向量存储服务完成语义搜索能力。

## 为什么采用这种架构？

**核心问题**：为什么不让 `/-/vector` 完成所有逻辑（包括 embedding 生成）？

**设计决策**：xpod server 只负责向量存储，embedding 生成由外部 API Server 完成。

**原因**：

1. **灵活性**
   - 外部可自由选择 embedding 服务供应商（OpenAI、Google、本地 Ollama 等）
   - 不同用户可使用不同的模型，xpod server 无需关心具体实现
   - 可以根据场景选择不同精度/成本的模型

2. **成本控制**
   - Embedding API 调用产生费用，由外部管理更灵活
   - 用户可以控制调用频率和批量大小
   - 可以实现缓存策略减少重复调用

3. **隐私考虑**
   - 敏感数据可选择在本地生成 embedding（如使用 Ollama）
   - 文本内容不经过 xpod server，只传递向量
   - 用户保留对数据流向的完全控制

4. **架构简洁**
   - xpod server 保持单一职责：存储和检索向量
   - 减少 xpod server 的外部依赖（不依赖 AI API）
   - 测试和部署更简单

5. **凭据管理**
   - AI API Key 存储在用户 Pod 中，由用户控制
   - xpod server 不需要管理第三方凭据
   - 符合 Solid 的数据主权原则

---

## API 端点 basePath 说明

### URL 格式

Vector API 的 URL 格式为：

```
{basePath}/-/vector/{action}
```

其中 `basePath` 可以是：
- Pod 根 URL：`https://alice.pod.example/`
- 容器 URL：`https://alice.pod.example/notes/`

### basePath 的作用

**1. 权限验证**

basePath 用于确定权限验证的目标资源：

```
请求: POST https://alice.pod.example/notes/-/vector/search
权限检查: 用户是否有 https://alice.pod.example/notes/ 的 Read 权限
```

**2. 数据隔离（关键）**

向量存储是**全局共享**的，所有 Pod 的向量存储在同一个数据库中。隔离通过 `quints.graph` 字段实现：

- 每条 RDF 数据有一个 `graph` 字段，标识它属于哪个资源/容器
- 向量 ID 是 `quints.rowid`，通过 JOIN 可以关联回原始数据

**外部 API Server 必须在搜索结果中做前缀过滤**：

```typescript
// 搜索返回的是全库结果，需要过滤只属于当前 basePath 的数据
const searchResults = await vectorSearch(podUrl, model, queryVector, { limit: 100 });

// 通过 rowid JOIN quints 表，过滤 graph 前缀
const filteredResults = await filterByGraphPrefix(searchResults, basePath);

async function filterByGraphPrefix(
  results: VectorSearchResult[], 
  basePath: string
): Promise<VectorSearchResult[]> {
  // 方式 1：批量查询 quints 表
  const ids = results.map(r => r.id);
  const rows = await db.query(`
    SELECT rowid FROM quints 
    WHERE rowid IN (${ids.join(',')}) 
    AND graph LIKE '${basePath}%'
  `);
  const validIds = new Set(rows.map(r => r.rowid));
  return results.filter(r => validIds.has(r.id));
  
  // 方式 2：直接在搜索时 JOIN（需要 xpod server 支持）
  // 当前版本不支持，需要外部过滤
}
```

### basePath 选择建议

| 场景 | basePath | 说明 |
|------|----------|------|
| 搜索用户所有数据 | `https://alice.pod.example/` | Pod 根路径 |
| 搜索特定容器 | `https://alice.pod.example/notes/` | 限定搜索范围 |
| 搜索单个资源 | `https://alice.pod.example/notes/note1` | 精确匹配 |

### 代码示例

```typescript
// 构建 URL
function buildVectorUrl(basePath: string, action: string): string {
  // 确保 basePath 以 / 结尾（对于容器）
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return `${base}-/vector/${action}`;
}

// 调用搜索 API
async function semanticSearch(
  basePath: string,
  queryVector: number[],
  model: string,
  session: Session
): Promise<SearchResult[]> {
  const url = buildVectorUrl(basePath, 'search');
  
  const response = await session.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, vector: queryVector, limit: 100 }),
  });
  
  const { results } = await response.json();
  
  // 重要：过滤只属于 basePath 的结果
  return filterByGraphPrefix(results, basePath);
}
```

### 当前限制

> **注意**：当前版本的 `/-/vector/search` 返回全库结果，不做 graph 前缀过滤。
> 
> 外部 API Server **必须**在获取搜索结果后，通过 JOIN quints 表进行前缀过滤。
> 
> 未来版本可能在 search 请求中增加 `graphPrefix` 参数，在服务端完成过滤。

---

## 架构概览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           外部 API Server                                 │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  1. 接收用户请求（索引资源/语义搜索）                                │  │
│  │  2. 从 Pod 读取资源内容（文本）                                      │  │
│  │  3. 调用 AI Embedding API 生成向量                                   │  │
│  │  4. 调用 xpod server 的 /-/vector/* 端点                            │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           xpod server                                     │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  VectorHttpHandler (纯向量存储服务)                                  │  │
│  │  - POST /-/vector/upsert   接收向量并存储                           │  │
│  │  - POST /-/vector/search   接收查询向量并返回相似结果               │  │
│  │  - POST /-/vector/delete   删除指定向量                             │  │
│  │  - GET  /-/vector/status   返回索引统计                             │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  VectorStore (SQLite/PostgreSQL)                                    │  │
│  │  - 向量存储、索引、相似度搜索                                        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## xpod server 提供的能力

### 1. 向量存储 API

xpod server 的 `VectorHttpHandler` 提供纯向量存储服务，**不负责 embedding 生成**：

| 端点 | 方法 | 功能 | 权限 |
|------|------|------|------|
| `{podUrl}/-/vector/upsert` | POST | 存入向量 | Append |
| `{podUrl}/-/vector/search` | POST | 向量搜索 | Read |
| `{podUrl}/-/vector/delete` | POST | 删除向量 | Modify |
| `{podUrl}/-/vector/status` | GET | 索引状态 | Read |

### 2. 关键设计决策

- **向量以 (subject, aspect) 为主键**：
  - `subject`：资源 URI，标识向量属于哪个资源
  - `aspect`：语义视角，标识从什么角度提取资源的语义
  - `id = hash(subject, aspect)`，由服务端自动计算
  
- **按模型分表存储**：每个 embedding 模型对应独立的向量表（`vec_{hash(model)}`）

- **支持 subject 前缀过滤**：搜索时可按 `subjectPrefix` 过滤，实现容器/Pod 级别的数据隔离

- **支持元数据过滤 + 向量排序**：通过 `subject` JOIN quints 表实现

---

## 外部 API Server 需要实现的功能

### 1. 资源索引服务

**功能**: 将 Pod 中的资源内容转换为向量并存储

**流程**:
```
用户请求索引资源
    │
    ▼
从 Pod 读取资源内容 (LDP GET)
    │
    ▼
提取文本内容 (解析 RDF/HTML/Markdown 等)
    │
    ▼
确定 aspect（类型视角、分片等）
    │
    ▼
调用 AI Embedding API 生成向量
    │
    ▼
调用 xpod /-/vector/upsert 存储向量（传入 subject 和 aspect）
    │
    ▼
返回索引结果
```

**调用 upsert 示例**:
```typescript
// POST {podUrl}/-/vector/upsert
const response = await fetch(`${podUrl}-/vector/upsert`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `DPoP ${accessToken}`,
  },
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    vectors: [
      {
        subject: 'https://alice.pod/notes/note1',
        aspect: 'Article',
        vector: [0.1, 0.2, ...]
      },
      {
        subject: 'https://alice.pod/notes/note1',
        aspect: 'Article#0',  // 第一个分片
        vector: [0.3, 0.4, ...]
      }
    ]
  })
});

// 响应
{
  "upserted": 2,
  "errors": [],
  "took_ms": 15
}
```

### 2. 语义搜索服务

**功能**: 将用户的文本查询转换为向量搜索

**流程**:
```
用户输入搜索查询 (文本)
    │
    ▼
调用 AI Embedding API 生成查询向量
    │
    ▼
调用 xpod /-/vector/search 搜索相似向量
    │
    ▼
根据返回的 subject 获取原始资源信息 (LDP GET)
    │
    ▼
返回搜索结果给用户
```

**调用 search 示例**:
```typescript
// POST {podUrl}/-/vector/search
const response = await fetch(`${podUrl}-/vector/search`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `DPoP ${accessToken}`,
  },
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    vector: [0.1, 0.2, ...],
    filter: {
      subject: { $startsWith: 'https://alice.pod/notes/' },
      aspect: { $eq: 'Article' }
    },
    distinctSubject: true,
    limit: 10
  })
});

// 响应
{
  "results": [
    { "subject": "https://alice.pod/notes/note1", "aspect": "Article", "score": 0.92, "distance": 0.15 },
    { "subject": "https://alice.pod/notes/note2", "aspect": "Article", "score": 0.85, "distance": 0.28 }
  ],
  "model": "text-embedding-3-small",
  "took_ms": 8
}
```

### 3. 凭据管理

**功能**: 管理用户的 AI API 凭据

API Server 需要：
1. 提供界面让用户配置 AI API Key
2. 安全存储凭据（存储在用户 Pod 的 `preferencesFile` 中）
3. 调用 embedding API 时使用对应的凭据

> **重要**：凭据存储必须遵循 xpod 已定义的 Credential Schema，详见 [credential-schema.md](./credential-schema.md)

**Schema 概要**：

使用 `udfs:` 命名空间（`https://undefineds.co/ns#`）：

```turtle
@prefix udfs: <https://undefineds.co/ns#> .
@prefix sec: <https://w3id.org/security#> .

# AI API Key 使用 ApiKeyCredential 类型
<#cred-openai>
  a udfs:ApiKeyCredential ;
  udfs:provider "openai" ;       # 供应商标识
  udfs:service "ai" ;            # 服务类别
  udfs:apiKey "sk-..." ;         # API 密钥
  udfs:organizationId "org-..." ; # 可选：组织 ID
  sec:expires "2025-12-31T00:00:00Z"^^xsd:dateTime . # 可选：过期时间

<#cred-google-ai>
  a udfs:ApiKeyCredential ;
  udfs:provider "google" ;
  udfs:service "ai" ;
  udfs:apiKey "AIzaSy..." ;
  udfs:baseUrl "https://generativelanguage.googleapis.com" . # 可选：自定义端点
```

**存储位置**：

凭据存储在用户的 `pim:preferencesFile` 指向的文件中：

```turtle
# WebID Profile 中声明 preferencesFile
<#me> pim:preferencesFile </settings/prefs.ttl> .

# /settings/prefs.ttl 中存储凭据
<#credentials>
  a udfs:CredentialStore ;
  udfs:credential <#cred-openai>, <#cred-google-ai> .
```

**读取凭据示例**：

```typescript
import { QueryEngine } from '@comunica/query-sparql';

async function getAiCredential(
  podUrl: string, 
  provider: string,
  session: Session
): Promise<{ apiKey: string; baseUrl?: string } | null> {
  const prefsUrl = await getPreferencesFile(podUrl, session);
  
  const query = `
    PREFIX udfs: <https://undefineds.co/ns#>
    SELECT ?apiKey ?baseUrl WHERE {
      ?cred a udfs:ApiKeyCredential ;
            udfs:provider "${provider}" ;
            udfs:service "ai" ;
            udfs:apiKey ?apiKey .
      OPTIONAL { ?cred udfs:baseUrl ?baseUrl }
    } LIMIT 1
  `;
  
  const engine = new QueryEngine();
  const result = await engine.queryBindings(query, {
    sources: [prefsUrl],
    fetch: session.fetch,
  });
  
  // 解析结果...
}
```

**支持的 AI 供应商**（`udfs:provider` 值）：

| Provider | 说明 |
|----------|------|
| `openai` | OpenAI API |
| `google` | Google AI (Gemini) |
| `anthropic` | Anthropic (Claude) |
| `azure` | Azure OpenAI |
| `local` | 本地模型 (Ollama) |

### 4. 模型迁移支持

**功能**: 当用户更换 embedding 模型时，支持平滑迁移

**双读策略实现**:
```typescript
// 搜索时同时查询新旧模型
const [oldResults, newResults] = await Promise.all([
  searchVector(podUrl, oldModel, queryVector, { limit: 20 }),
  searchVector(podUrl, newModel, queryVector, { limit: 20 }),
]);

// 合并去重（新模型结果优先，按 subject + aspect 去重）
const newKeys = new Set(newResults.map(r => `${r.subject}|${r.aspect}`));
const merged = [
  ...newResults,
  ...oldResults.filter(r => !newKeys.has(`${r.subject}|${r.aspect}`))
];

// 按 score 排序后返回
return merged.sort((a, b) => b.score - a.score).slice(0, limit);
```

**后台迁移任务**:
```typescript
// 分批读取旧模型的向量
let cursor: string | undefined;
while (true) {
  const { vectors, nextCursor } = await listVectors(podUrl, oldModel, { limit: 100, cursor });
  if (vectors.length === 0) break;
  
  // 读取原始资源，重新生成 embedding
  for (const v of vectors) {
    const resource = await fetch(v.subject);  // LDP GET
    const text = extractText(resource, v.aspect);
    const newVector = await generateEmbedding(newModel, text);
    await upsertVector(podUrl, newModel, {
      subject: v.subject,
      aspect: v.aspect,
      vector: newVector
    });
  }
  
  cursor = nextCursor;
}

// 迁移完成后可删除旧模型表（通过 /-/vector/status 确认）
```

---

## API 请求/响应格式详解

### 向量数据模型

每个向量由三个核心字段标识：

| 字段 | 类型 | 说明 |
|------|------|------|
| `subject` | string | 资源 URI，如 `https://alice.pod/notes/note1` |
| `aspect` | string | 语义视角，定义从什么角度提取资源的语义 |
| `vector` | number[] | 向量数据 |

**主键**：`id = hash(subject, aspect)`，由服务端自动计算。

**`aspect` 字段说明**：

`aspect` 表示从什么视角/角度提取 subject 的语义。同一个 subject 可以有多个 aspect：

| aspect 示例 | 含义 |
|-------------|------|
| `Person` | 作为 Person 类型，聚合 name、bio 等字段 |
| `Teacher` | 作为 Teacher 类型，聚合 name、courses、expertise 等字段 |
| `Article` | 作为 Article 类型，聚合 title、content 等字段 |
| `Article#0` | Article 内容的第 0 个分片 |
| `Article#1` | Article 内容的第 1 个分片 |
| `schema:name` | 仅 schema:name 属性的值 |
| `schema:content#0` | schema:content 属性值的第 0 个分片 |

> **注意**：`aspect` 的具体定义和语义由外部 API Server 设计和管理，xpod server 只负责存储和匹配。

### 向量表结构

```sql
CREATE TABLE vec_{model_hash} (
  id INTEGER PRIMARY KEY,    -- hash(subject, aspect)
  subject TEXT NOT NULL,     -- 资源 URI
  aspect TEXT NOT NULL,      -- 语义视角
  embedding vector(768),     -- 向量数据
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_subject ON vec_{model_hash}(subject);
CREATE INDEX idx_aspect ON vec_{model_hash}(aspect);
```

---

### Upsert 请求

```typescript
interface UpsertRequest {
  /** embedding 模型名，如 "text-embedding-3-small" */
  model: string;
  
  /** 要存入的向量列表 */
  vectors: Array<{
    /** 资源 URI */
    subject: string;
    
    /** 语义视角（类型、分片、属性等） */
    aspect: string;
    
    /** 向量数据（维度需与模型匹配，通常 768 或 1536） */
    vector: number[];
  }>;
}

interface UpsertResponse {
  /** 成功存入的数量 */
  upserted: number;
  
  /** 错误信息列表 */
  errors: string[];
  
  /** 耗时（毫秒） */
  took_ms: number;
}
```

**示例**：

```typescript
// 索引一个人的多个视角
await fetch(`${podUrl}-/vector/upsert`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    vectors: [
      {
        subject: 'https://alice.pod/profile#me',
        aspect: 'Person',
        vector: [0.1, 0.2, ...]  // embed(name + bio)
      },
      {
        subject: 'https://alice.pod/profile#me',
        aspect: 'Teacher',
        vector: [0.3, 0.4, ...]  // embed(name + courses + expertise)
      }
    ]
  })
});

// 索引一篇长文章的多个分片
await fetch(`${podUrl}-/vector/upsert`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    vectors: [
      { subject: 'https://alice.pod/notes/note1', aspect: 'Article#0', vector: [...] },
      { subject: 'https://alice.pod/notes/note1', aspect: 'Article#1', vector: [...] },
      { subject: 'https://alice.pod/notes/note1', aspect: 'Article#2', vector: [...] },
    ]
  })
});
```

---

### Search 请求

```typescript
interface SearchRequest {
  /** embedding 模型名 */
  model: string;
  
  /** 查询向量（已生成的 embedding） */
  vector: number[];
  
  /** 返回结果数量，默认 10 */
  limit?: number;
  
  /** 相似度阈值 (0-1)，低于此值的结果会被过滤 */
  threshold?: number;
  
  /** 过滤条件（MongoDB 风格） */
  filter?: {
    subject?: FieldFilter;
    aspect?: FieldFilter;
  };
  
  /** 是否按 subject 去重，默认 false */
  distinctSubject?: boolean;
}

interface FieldFilter {
  $eq?: string;           // 等于
  $startsWith?: string;   // 前缀匹配
  $in?: string[];         // IN 列表
}

interface SearchResponse {
  results: Array<{
    /** 资源 URI */
    subject: string;
    
    /** 语义视角 */
    aspect: string;
    
    /** 相似度分数 (0-1)，越高越相似 */
    score: number;
    
    /** 距离值，越小越相似 */
    distance: number;
  }>;
  
  /** 使用的模型名 */
  model: string;
  
  /** 耗时（毫秒） */
  took_ms: number;
}
```

**示例**：

```typescript
// 搜索老师
const response = await fetch(`${podUrl}-/vector/search`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    vector: queryVector,
    filter: {
      subject: { $startsWith: 'https://alice.pod/people/' },
      aspect: { $eq: 'Teacher' }
    },
    limit: 10
  })
});

// 响应
{
  "results": [
    { "subject": "https://alice.pod/people/bob", "aspect": "Teacher", "score": 0.92, "distance": 0.15 },
    { "subject": "https://alice.pod/people/carol", "aspect": "Teacher", "score": 0.85, "distance": 0.28 }
  ],
  "model": "text-embedding-3-small",
  "took_ms": 8
}

// 搜索文章，按 subject 去重（多个分片只返回最相似的）
const response = await fetch(`${podUrl}-/vector/search`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    vector: queryVector,
    filter: {
      subject: { $startsWith: 'https://alice.pod/notes/' }
    },
    distinctSubject: true,
    limit: 10
  })
});

// 搜索多个 aspect
const response = await fetch(`${podUrl}-/vector/search`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    vector: queryVector,
    filter: {
      subject: { $startsWith: 'https://alice.pod/' },
      aspect: { $in: ['Person', 'Teacher', 'Article'] }
    },
    limit: 10
  })
});
```

---

### Delete 请求

```typescript
interface DeleteRequest {
  /** embedding 模型名 */
  model: string;
  
  /** 过滤条件（至少提供一个字段） */
  filter: {
    subject?: FieldFilter;
    aspect?: FieldFilter;
  };
}

interface DeleteResponse {
  /** 删除的数量 */
  deleted: number;
  
  /** 错误信息列表 */
  errors: string[];
  
  /** 耗时（毫秒） */
  took_ms: number;
}
```

**示例**：

```typescript
// 删除某个资源的所有向量
await fetch(`${podUrl}-/vector/delete`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    filter: {
      subject: { $eq: 'https://alice.pod/notes/note1' }
    }
  })
});

// 删除某个资源的特定视角
await fetch(`${podUrl}-/vector/delete`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    filter: {
      subject: { $eq: 'https://alice.pod/notes/note1' },
      aspect: { $eq: 'Article#0' }
    }
  })
});

// 批量删除某个容器下的所有向量
await fetch(`${podUrl}-/vector/delete`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    filter: {
      subject: { $startsWith: 'https://alice.pod/notes/' }
    }
  })
});

// 删除特定资源的所有分片
await fetch(`${podUrl}-/vector/delete`, {
  method: 'POST',
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    filter: {
      subject: { $eq: 'https://alice.pod/notes/note1' },
      aspect: { $startsWith: 'Article#' }
    }
  })
});
```

### Status 响应

```typescript
// GET {podUrl}/-/vector/status
interface StatusResponse {
  /** 按模型分组的统计 */
  byModel: Array<{
    model: string;   // 模型表名
    count: number;   // 向量数量
  }>;
  
  /** 总向量数量 */
  totalCount: number;
}
```

---

## 错误处理

### 错误响应格式

```typescript
interface ErrorResponse {
  error: true;
  code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'STORAGE_ERROR';
  message: string;
  details?: Record<string, unknown>;
}
```

### 常见错误码

| HTTP 状态 | 错误码 | 说明 |
|-----------|--------|------|
| 400 | INVALID_REQUEST | 请求格式错误（缺少字段、JSON 解析失败等） |
| 401 | UNAUTHORIZED | 未认证 |
| 403 | FORBIDDEN | 无权限访问该资源 |
| 404 | NOT_FOUND | 未知的 action |
| 405 | - | 方法不允许 |
| 500 | STORAGE_ERROR | 存储层错误 |

---

## 认证方式

xpod server 使用 Solid OIDC 认证，API Server 需要：

1. **获取用户授权**: 通过 Solid OIDC 流程获取 access token
2. **DPoP 绑定**: 请求时携带 DPoP proof
3. **传递认证头**: `Authorization: DPoP {access_token}`

示例（使用 @inrupt/solid-client-authn）:
```typescript
import { Session } from '@inrupt/solid-client-authn-node';

const session = new Session();
await session.login({
  clientId,
  clientSecret,
  oidcIssuer: 'https://pod.example/',
  tokenType: 'DPoP',
});

// 使用 session.fetch 自动处理认证
const response = await session.fetch(`${podUrl}-/vector/search`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, vector, limit: 10 }),
});
```

---

## 推荐的 Embedding 模型

| 供应商 | 模型 | 维度 | 说明 |
|--------|------|------|------|
| OpenAI | text-embedding-3-small | 1536 | 性价比高，推荐 |
| OpenAI | text-embedding-3-large | 3072 | 更高精度 |
| Google | text-embedding-004 | 768 | 免费额度大 |
| Cohere | embed-multilingual-v3.0 | 1024 | 多语言支持好 |
| Voyage | voyage-3 | 1024 | 代码搜索优秀 |
| 本地 | nomic-embed-text (Ollama) | 768 | 隐私敏感场景 |

---

## 最佳实践

### 1. aspect 设计

`aspect` 的命名建议遵循以下规范：

| 格式 | 示例 | 使用场景 |
|------|------|----------|
| `{Type}` | `Person`, `Article` | 按 rdf:type 聚合字段生成的向量 |
| `{Type}#{index}` | `Article#0`, `Article#1` | 长文本分片 |
| `{predicate}` | `schema:name` | 单个属性值的向量 |
| `{predicate}#{index}` | `schema:content#0` | 单个属性值的分片 |

### 2. 批量操作

- upsert 支持批量，建议每批 100-500 条
- 避免单次请求过大（向量数据较大）

### 3. 错误重试

```typescript
async function upsertWithRetry(vectors, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await upsert(vectors);
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await sleep(1000 * Math.pow(2, i)); // 指数退避
    }
  }
}
```

### 4. 搜索结果处理

```typescript
// 根据返回的 subject 获取完整资源信息
const results = await search(model, queryVector, { 
  filter: {
    subject: { $startsWith: 'https://alice.pod/notes/' }
  },
  distinctSubject: true,
  limit: 10 
});

const resources = await Promise.all(
  results.results.map(async (r) => {
    const resource = await session.fetch(r.subject);  // LDP GET
    return {
      ...await resource.json(),
      score: r.score,
      matchedAspect: r.aspect,
    };
  })
);
```

### 5. 资源删除同步

当资源被删除时，记得同步删除对应的向量：

```typescript
// 监听资源删除事件（通过 Solid Notifications）
onResourceDeleted(async (subject) => {
  await fetch(`${podUrl}-/vector/delete`, {
    method: 'POST',
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      filter: {
        subject: { $eq: subject }
      }
    })
  });
});
```

---

## 附录：xpod server 内置的 Embedding 基础设施

xpod server 已实现但**未暴露为 HTTP API** 的组件：

| 组件 | 说明 | 状态 |
|------|------|------|
| `EmbeddingService` | 调用 AI API 生成向量 | 已实现，未集成 |
| `ProviderRegistry` | 供应商/模型元信息 | 已实现 |
| `CredentialReader` | 从 Pod 读取 API Key | 已实现 |

这些组件可供后续直接集成到 xpod server，届时可以提供：
- `POST /-/vector/index` - 自动索引资源（传入 URI，服务端生成 embedding）
- `POST /-/vector/query` - 文本搜索（传入文本，服务端生成查询向量）

当前版本选择将 embedding 生成放在外部，主要考虑：
1. 灵活性：外部可自由选择 embedding 服务
2. 成本控制：embedding API 调用由外部管理
3. 隐私：敏感数据可在本地生成 embedding
