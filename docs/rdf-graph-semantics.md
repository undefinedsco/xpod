# RDF 图语义（容器 = 本图 + 子图）

本文定义 Xpod 的 SPARQL 查询里"图"是什么，并记录三条查询规则的落地方式与迁移顺序。它解决的是一个已经在验收里暴露的真实分叉：**同一个 Pod 查询，两条权威给了不同答案**。

## 为什么需要定义

上游**无法表达图**，这不是风格问题而是接口事实：

- `.sparql` 端点只接受 `?query=`（GET）或请求体（POST），**没有 `default-graph-uri`／数据集参数**（`src/http/SubgraphSparqlHttpHandler.ts` 的 `extractQuery`）；
- `solid-sdk` 没有带图的查询入口；
- 而 Pod 文档**本来就是以命名图存的**：`SolidRdfDataAccessor` 只接受默认图输入，然后按文档名写入命名图（`putGraphQuads(name, …)`、`quad(…, name)`）。

所以".sparql 上一条普通查询"必须能查到 Pod 的文档；把它留给客户端补图是做不到的。

## 规则

| 查询写法 | 判定 | 含义 |
|---|---|---|
| 无名字（不在 `GRAPH` 内） | 作用域本身是容器 | **该容器 + 其全部子图**（含嵌套容器） |
| `GRAPH <…/container/>` | IRI 以 `/` 结尾 | **本容器 + 全部子图**，含容器自身的三元组（`ldp:contains` 等） |
| `GRAPH <…/doc.ttl>` | 不以 `/` 结尾 | **精确匹配这一个图** |
| `GRAPH ?g` | 变量 | 枚举作用域内的图 |

要点：
- **容器是 LDP 概念**，前缀带 `/`，因此天然不会串图（`<pod/a/>` 永不匹配 `<pod/ab`）。这是选择"容器前缀"而不是"任意前缀"的原因。
- **文档保持精确**，标准 SPARQL 客户端的预期不被破坏。
- **作用域由端点决定**：`/alice/-/sparql` → 容器 `/alice/`；`/alice/photos/-/sparql` → `/alice/photos/`。没有"整个 Pod 根"的特例——每个端点只对自己那一层负责，`alice/photos/` 的查询看不到 `alice/settings/`。
- 访问作用域的限制照旧叠加（`allowedGraphUrls` / `deniedGraphUrls` / `deniedGraphPrefixes`），容器前缀与它们是**交集**关系，不会放宽可读范围。
- **过渡条款**：真实写入路径已经"总是带图"，但历史或特殊数据可能落在默认图里；在默认图数据清零之前，无名字查询的图条件按"容器前缀 **或** 默认图"处理，避免这类事实突然不可见。清零后该条款可删除。

## 底层支持（不需要改内核）

| 引擎 | 原语 | 位置 |
|---|---|---|
| PG | 图前缀**已真下推**：`graph: { $startsWith }` → `graphPrefix` → `JOIN rdf_terms graph ON graph.id = q.graph_id AND graph.value LIKE '…%'`；`rdf_terms(kind, value_head)` 索引；planner 有 `hasGraphPrefixFanout` 代价/缓存键 | `PostgresRdfEngine.ts:7025 / 2713 / 7195 / 1080` |
| SQLite（TS） | `$startsWith` 走通用 `prefixSearchConditionJoin(key, column, …)`，图槽同样适用 | `RdfQuadIndex.ts:1963` |
| 原生扫描后端 | `graph_scope->graph_set` → SQL `graph_id IN (…)` | `rdf_sqlite_backend/src/xpod_rdf_sqlite_backend.cpp:1057` |
| QLever 适配器 | scope 已有 `graph_set` 成员判定；未命名写入落 `kQleverDefaultGraphIri` | `XpodQleverBridge.cpp:4265 / 95` |

结论：三条规则都能翻译成**已有原语**——容器→图前缀，文档→精确，无名字→作用域容器前缀。

## 当前分叉（实测）

fixture 用例 `graph/default-and-named`：一份文档种进默认图，一份种进命名图，查询为 `{ ?s ?p ?o BIND(<…g:default> AS ?g) } UNION { GRAPH ?g { ?s ?p ?o } }`。

| 权威 | executor | 结果 |
|---|---|---|
| 公有（云 `.sparql`） | Comunica + PG facts | **3 行**（无名字那支看到命名图文档）= 并集替身 |
| 原生（QLever） | `engine.sparqlQuery` | **2 行**（无名字那支只见默认图文档）= 严格 |

fixture 写的是 2 行，所以**公有验收红、原生绿**；而 `QleverProductDifferential`（本地 sqlite ↔ PG）两边都走**原生** executor，所以一直是绿的。

即：今天的"无名字查询 = 丢图约束 + 来源前缀"是**前缀图语义的替身**——它能工作只是因为 Pod 里 graph IRI 恰好等于 source URI（`seedDocument` 与 Pod 写入都是如此）。fixture 里那份 `graph: 'default'` 的文档是唯一"图 ≠ 文档 IRI"的人造情形，正是它把这层替身暴露出来。

## 迁移顺序（fixture 不能提前改）

1. **接线**（本机可全验，不改变真实 Pod 的答案）：TS 查询层引入容器规则；PG 把"无名字"从丢约束改成显式容器图前缀（含过渡条款）。不动 fixture、不动原生。
2. **原生对齐**：用 `graph_set` 实现同一规则；前缀需要先枚举作用域内的图，**枚举成本必须实测并记录**。
3. **fixture 收敛**：去掉人造的默认图构造（每份文档都带图），期望收敛成唯一一份；此时两条权威与 parity 门禁一起验。

⚠️ **顺序不能颠倒**：只做第 1 步就改 fixture，会把红从公有验收挪到 `QleverProductDifferential`（原生 parity），而后者不在本机跑——那正是"改一边、另一边悄悄红"的坑。

## 未决

- 原生侧枚举作用域图的成本（图数 = Pod 内 RDF 文档数）与是否需要在适配器里缓存。
- 过渡条款何时删除：取决于默认图数据是否还有来源（历史数据迁移脚本 / 导入路径）。
