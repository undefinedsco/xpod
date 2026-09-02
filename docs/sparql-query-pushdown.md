# xpod SPARQL 查询下推方案

## 背景

### 当前问题

xpod 使用 quadstore + quadstore-comunica 执行 SPARQL 查询，存在严重性能问题：

```
实际场景：查询 3 条消息，扫描了 18,367 条记录
```

原因：
1. **Comunica 不下推条件** - FILTER、ORDER BY、LIMIT 在 JS 内存层处理
2. **Graph 前缀不支持** - quadstore 的 Range 查询只支持 Literal，不支持 NamedNode（Graph URI）
3. **全表扫描** - `SubgraphQueryEngine.getGraphsInScope()` 遍历所有 quads 来匹配 graph 前缀

### 核心发现

quadstore 底层**已经支持**：
- ✅ Range 查询 (gt, lt, gte, lte) - 用于 Literal 值
- ✅ LIMIT 下推
- ✅ ORDER BY (reverse)
- ✅ 数值/日期正确排序 - 使用 fpstring 编码，字典序 = 数值序
- ✅ GSPO 6 组索引 - 覆盖各种查询模式

但 quadstore-comunica **没有利用这些能力**，只调用简单的 `match(s, p, o, g)`。

### 社区现状

quadstore-comunica 官方也意识到这个问题：

| 时间 | 事件 |
|------|------|
| 2020-11 | 创建 [quadstore#115](https://github.com/quadstorejs/quadstore/issues/115)，详细计划了 filter/sort 下推方案 |
| 2021-04 | 开始开发，提交 Comunica PR #808（已合并） |
| 2021-10 | 完成了 sorting 支持（`opts.orderBy`） |
| 2024-03 | 关闭 #115，迁移到 [quadstore-comunica#4](https://github.com/quadstorejs/quadstore-comunica/issues/4) |
| 2024-03 ~ 至今 | **#4 停滞，0 评论，无进展** |

官方方案未完成的部分：
- ❌ Stage 3: Separate iterator instantiation from metadata
- ❌ Stage 4: Data Model for context entry
- ❌ Stage 5: Extracting operations from algebra tree

---

## 方案对比

### 官方方案（quadstore-comunica#4 / #115）

```
SPARQL
    ↓
sparqlalgebrajs (解析成 algebra tree)
    ↓
┌─────────────────────────────────────────┐
│  新增 optimizer actor                    │
│  - 从 algebra tree 提取 FILTER/ORDER BY  │
│  - 放入 Comunica context                 │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│  新增 RDF/JS quad resolver actor         │
│  - 从 context 读取 FILTER/ORDER BY       │
│  - 转成 quadstore 的 range + orderBy     │
└─────────────────────────────────────────┘
    ↓
quadstore.getStream({ range, orderBy, limit })
```

**特点**：
- 在 Comunica 框架内扩展
- 用 Comunica 的 Actor 机制
- 长期目标：支持 RDF/JS Expression 规范
- 可贡献回社区，通用性好

### xpod 方案（本文档）

```
SPARQL
    ↓
sparqljs (解析成 AST)
    ↓
┌─────────────────────────────────────────┐
│  xpod Planner (完全自己写)               │
│  - 分析 AST                             │
│  - 提取 FILTER/ORDER BY/LIMIT           │
│  - 直接翻译成 quadstore pattern / SQL    │
└─────────────────────────────────────────┘
    ↓
quadstore.getStream() 或直接 SQL
```

**特点**：
- 绕过 Comunica
- 完全自己控制
- 可直接下推到 SQL
- 易于扩展 Vector 搜索等自定义功能

### 对比表

| | 官方方案 | xpod 方案 |
|---|---------|----------|
| 依赖 | Comunica Actor 框架 | 只依赖 sparqljs + quadstore 底层 |
| 复杂度 | 高（要理解 Comunica 架构） | 中（自己写 Planner） |
| 灵活性 | 受 Comunica 限制 | 完全自由 |
| SQL 下推 | 不支持（只到 quadstore） | 支持（可直接生成 SQL） |
| Vector 扩展 | 困难 | 容易 |
| 通用性 | 可贡献回社区 | xpod 专用 |
| 进度 | 4 年未完成 | 自己控制 |

---

## 回馈社区路径

虽然我们先用 xpod 方案快速解决问题，但可以分阶段回馈社区：

### Phase 1: Graph 前缀支持（贡献给 quadstore）

**问题**：quadstore Range 只支持 Literal，不支持 NamedNode。

**改动**：修改 `patternTermWriter` 支持 NamedNode

```typescript
// quadstore/src/serialization/patterns.ts
const patternTermWriter = {
  write(term, prefixes) {
    // 新增：支持 NamedNode (用于 graph 前缀)
    if (term.termType === 'NamedNode') {
      namedNodeWriter.write(term, serialized, prefixes);
      return;
    }
    // 原有 Literal 逻辑...
  }
};
```

**PR 目标**：`quadstorejs/quadstore`

**价值**：所有 quadstore 用户都能受益，不只是 Comunica 用户

### Phase 2: SPARQL Planner 抽象层（独立包）

将 xpod 的 Planner 抽象成独立的包：

```
@xpod/sparql-planner
├── parser (sparqljs wrapper)
├── analyzer (AST → 查询计划)
├── optimizer (索引选择)
└── executor (quadstore adapter)
```

**特点**：
- 不依赖 Comunica
- 可单独使用
- 可作为 quadstore-comunica 的替代方案

### Phase 3: Comunica Actor 实现（贡献给 quadstore-comunica）

如果社区有兴趣，可以把我们的 Planner 逻辑包装成 Comunica Actor：

```typescript
// @quadstore-comunica/actor-optimize-filter-pushdown
export class ActorOptimizeFilterPushdown extends ActorOptimizeQueryOperation {
  async run(action: IActionOptimizeQueryOperation) {
    // 复用 @xpod/sparql-planner 的逻辑
  }
}
```

**PR 目标**：`quadstorejs/quadstore-comunica`

### 贡献优先级

| 优先级 | 贡献 | 难度 | 影响范围 |
|--------|------|------|----------|
| 🔴 高 | Graph 前缀 Range 支持 | 低 | quadstore 全部用户 |
| 🟡 中 | 独立 SPARQL Planner 包 | 中 | 需要高性能查询的用户 |
| 🟢 低 | Comunica Actor 实现 | 高 | Comunica 生态 |

---

## 详细设计

### 1. SPARQL 解析

使用 `sparqljs` 解析 SPARQL 为 AST：

```typescript
import { Parser } from 'sparqljs';

const parser = new Parser();
const ast = parser.parse(`
  SELECT ?s ?date WHERE {
    GRAPH ?g {
      ?s a <http://example.org/Message> .
      ?s <http://schema.org/dateCreated> ?date .
    }
    FILTER(?date > "2024-01-01"^^xsd:dateTime)
  }
  ORDER BY DESC(?date)
  LIMIT 10
`);
```

AST 结构：

```json
{
  "queryType": "SELECT",
  "variables": ["?s", "?date"],
  "where": [
    {
      "type": "graph",
      "name": { "termType": "Variable", "value": "g" },
      "patterns": [
        {
          "type": "bgp",
          "triples": [...]
        }
      ]
    },
    {
      "type": "filter",
      "expression": {
        "operator": ">",
        "args": [?date, "2024-01-01"]
      }
    }
  ],
  "order": [{ "expression": "?date", "descending": true }],
  "limit": 10
}
```

### 2. 条件下推映射

| SPARQL | 下推方式 | 说明 |
|--------|---------|------|
| `GRAPH ?g { ... }` 且 g 有前缀约束 | `graph: { termType: 'Range', gte: namedNode(prefix) }` | 需扩展 quadstore |
| `FILTER(?x > value)` | `object: { termType: 'Range', gt: literal(value) }` | quadstore 已支持 |
| `FILTER(?x < value)` | `object: { termType: 'Range', lt: literal(value) }` | quadstore 已支持 |
| `FILTER(?x >= value)` | `object: { termType: 'Range', gte: literal(value) }` | quadstore 已支持 |
| `FILTER(?x <= value)` | `object: { termType: 'Range', lte: literal(value) }` | quadstore 已支持 |
| `FILTER(REGEX(?x, pattern))` | SQL `REGEXP` 或内存过滤 | 视模式复杂度 |
| `FILTER(STRSTARTS(?x, prefix))` | `object: { termType: 'Range', gte/lt }` | 转为前缀范围 |
| `FILTER(CONTAINS(?x, substr))` | SQL `LIKE '%substr%'` | 无法用索引，但可下推 SQL |
| `ORDER BY ?x` | `{ order: ['object'], reverse: false }` | quadstore 已支持 |
| `ORDER BY DESC(?x)` | `{ order: ['object'], reverse: true }` | quadstore 已支持 |
| `LIMIT n` | `{ limit: n }` | quadstore 已支持 |

### 3. 索引选择

quadstore 维护 6 组索引（以四元组为例）：

| 索引 | 前缀顺序 | 适用查询 |
|------|---------|---------|
| GSPO | Graph → Subject → Predicate → Object | 按 graph + subject 查询 |
| GPOS | Graph → Predicate → Object → Subject | 按 graph + predicate + object 排序 ✅ |
| GOSP | Graph → Object → Subject → Predicate | 按 graph + object 查询 |
| SPOG | Subject → Predicate → Object → Graph | 跨 graph 按 subject 查询 |
| POSG | Predicate → Object → Subject → Graph | 跨 graph 按 predicate + object 排序 |
| OSPG | Object → Subject → Predicate → Graph | 跨 graph 按 object 查询 |

**索引选择原则**：
- 查询条件匹配索引前缀越长越好
- ORDER BY 字段需要在索引顺序中

**示例**：

```sparql
SELECT * WHERE {
  GRAPH <messages/2024/> { 
    ?s <createdAt> ?date 
  }
}
ORDER BY DESC(?date)
LIMIT 10
```

选择 **GPOS** 索引：
- G = `messages/2024/*` (前缀匹配)
- P = `createdAt` (精确匹配)
- O = `?date` (用于排序)

### 4. 值编码

使用 quadstore 的 `fpstring` 编码数值，保证字典序 = 数值序：

```typescript
import { encode } from 'quadstore/serialization/fpstring';

// 数值编码
encode(99.5)   → "50029.95000000000000000"
encode(100)    → "50021.00000000000000000"
encode(-50)    → "19499.50000000000000000"

// 日期编码（转时间戳）
encode(new Date('2024-01-01').valueOf()) → "..."
```

支持的数据类型：
- `xsd:integer`, `xsd:decimal`, `xsd:double`
- `xsd:long`, `xsd:int`, `xsd:short`, `xsd:byte`
- `xsd:dateTime` (自动转时间戳)

### 5. Graph 前缀扩展

**当前限制**：quadstore 的 Range 只支持 Literal，不支持 NamedNode。

**扩展方案**：修改 `patternTermWriter` 支持 NamedNode：

```typescript
const patternTermWriter = {
  write(term, prefixes) {
    // 新增：支持 NamedNode (用于 graph 前缀)
    if (term.termType === 'NamedNode') {
      namedNodeWriter.write(term, serialized, prefixes);
      return;
    }
    // 原有 Literal 逻辑...
  }
};
```

使用：

```typescript
store.getStream({
  graph: { 
    termType: 'Range', 
    gte: { termType: 'NamedNode', value: 'messages/2024/' },
    lt: { termType: 'NamedNode', value: 'messages/2024/\uffff' }
  },
  predicate: namedNode('http://schema.org/dateCreated'),
  object: {
    termType: 'Range',
    gt: literal('2024-01-01', xsd.dateTime)
  }
}, {
  order: ['object'],
  reverse: true,
  limit: 10
});
```

### 6. 自定义函数支持（Vector 搜索）

sparqljs 天然支持自定义函数：

```sparql
PREFIX vec: <http://example.org/vector#>
SELECT ?s ?score WHERE {
  ?s <http://schema.org/text> ?text .
  BIND(vec:distance(?text, "hello world") AS ?score)
}
ORDER BY ?score
LIMIT 10
```

解析结果：

```json
{
  "type": "functionCall",
  "function": "http://example.org/vector#distance",
  "args": [?text, "hello world"]
}
```

Planner 识别 `vec:distance` 后，翻译为 pgvector 查询：

```sql
SELECT s, embedding <=> $query_vector AS score
FROM quads
WHERE p = 'http://schema.org/text'
ORDER BY score
LIMIT 10
```

---

## 实现计划

### Phase 1: 基础下推（xpod 内部）

1. [ ] 实现 SPARQL AST 分析器
2. [ ] 实现索引选择逻辑
3. [ ] 实现 FILTER 条件翻译 (>, <, >=, <=)
4. [ ] 实现 ORDER BY / LIMIT 下推
5. [ ] 集成到 xpod SPARQL 端点

### Phase 2: Graph 前缀 + 社区贡献

1. [ ] 扩展 patternTermWriter 支持 NamedNode
2. [ ] 实现 graph 前缀查询
3. [ ] **提交 PR 给 quadstore**
4. [ ] 移除 `__graphs` 表依赖（可选）

### Phase 3: 高级功能 + 独立包

1. [ ] 实现 REGEX 下推（简单模式）
2. [ ] 实现 STRSTARTS/CONTAINS 下推
3. [ ] 实现 Vector 搜索集成
4. [ ] **抽象为独立包 @xpod/sparql-planner**

---

## 依赖组件

| 组件 | 版本 | 用途 |
|------|------|------|
| sparqljs | latest | SPARQL 解析 |
| quadstore | 13.x+ | 底层存储 + 序列化工具 |
| - fpstring | - | 数值编码 |
| - termWriter | - | RDF term 序列化 |

## 测试策略

1. **单元测试**：各翻译函数的正确性
2. **集成测试**：完整 SPARQL 查询的执行结果
3. **性能测试**：对比优化前后的扫描行数和响应时间
4. **W3C 合规测试**：使用 SPARQL 1.1 官方测试套件（渐进支持）

## 参考资料

- [quadstore 源码](https://github.com/quadstorejs/quadstore)
- [quadstore#115 - 官方下推方案](https://github.com/quadstorejs/quadstore/issues/115)
- [quadstore-comunica#4 - 当前状态](https://github.com/quadstorejs/quadstore-comunica/issues/4)
- [sparqljs](https://github.com/RubenVerborgh/SPARQL.js)
- [W3C SPARQL 1.1 测试套件](https://w3c.github.io/rdf-tests/sparql/sparql11)
- [fpstring 编码算法](quadstore/dist/esm/serialization/fpstring.js)
