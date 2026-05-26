# Xpod RDF Engine Spec

本 spec 定义 Xpod 自有 Pod 的 RDF 索引和查询引擎边界。它和 [SolidFS Spec](solidfs-spec.md) 分工如下：

- SolidFS 定义文件权威、workspace materialization、工具面对真实目录的语义。
- RDF Engine 定义标准 RDF 文档解析后的语义索引、查询计划、全文/向量检索和更新回写协议。

## 目标

- Xpod-owned Pod 的 server 端查询不再以 Comunica 作为主路径。
- 保留 `/-/sparql` 这种组件边界，但内部查询执行逐步切到 Xpod 自己的本地引擎。
- 以文件为内容权威，DB/RDF index 为全局语义索引。
- 分层内化 Hexastore、RDF-3X、QLever 的关键思想，但不把它们作为并列运行时组合。
- 让全文、结构化 RDF 查询、未来向量检索在同一套资源身份和索引模型里协同。

## 非目标

- 不在 Xpod server 端实现通用外部 Solid provider proxy。
- 不把 federation 作为 server-owned Pod 的主查询路径。
- 不要求第一版完整覆盖 SPARQL 1.1。
- 不把 DB 索引变成 `.ttl` / `.jsonld` 的内容事实源。
- 不把 shell 工具查询虚拟到 DB；`rg`、`grep`、`cat` 仍然面对真实文件。

## 核心判断

同一个 Xpod Pod 内的多文件查询不是 federation：

```text
多个 RDF 文件
  -> 解析成同一个 Pod scope 下的 named graphs
  -> 本地全局 RDF index 查询
```

Federation 只出现在跨 storage provider、跨 endpoint 或显式 `SERVICE` 的场景：

```text
Xpod Pod + external Pod + Wikidata
  -> client/app/gateway 级 orchestration
  -> 不进入 Xpod server 本地热路径
```

## 架构

```text
SolidFS authority files
  .ttl / .jsonld / by-line resources
        |
        v
RDF Parser + Sync Journal
        |
        v
Term Dictionary
        |
        v
Quad Indexes
  SPOG / POSG / OSPG / GSPO / GPOS / ...
        |
        +--> Text Index
        +--> Vector Index
        +--> Statistics
        |
        v
SolidRdfEngine
        |
        +--> SPARQL endpoint
        +--> drizzle-solid / models queries
        +--> app SQL-like query surfaces
```

组件名称建议：

| 组件 | 职责 |
| --- | --- |
| `SolidRdfEngine` | Xpod server-owned Pod 的主查询引擎。 |
| `RdfTermDictionary` | IRI、literal、blank node、datatype、language 的字典编码。 |
| `RdfQuadIndex` | 基于 term id 的 quad/quint 存储和多排列索引。 |
| `RdfQueryPlanner` | SPARQL algebra / app query 到物理计划。 |
| `RdfTextIndex` | literal、IRI label、文件 chunk 的全文索引。 |
| `RdfVectorIndex` | chunk / resource embedding 索引。 |
| `ComunicaCompatibilityEngine` | 可选兼容层、测试 oracle、过渡 fallback；不是主路径。 |

第一阶段只实现 embedded 形态：`SolidRdfEngine` 直接作为 Xpod 进程内 RDF engine 接入 Components.js。当前阶段不新增 sidecar/backend selector、不暴露 Components.js backend 注册面，也不区分 cloud/local 的查询引擎类型；cloud/local 只允许在同一行为契约下替换持久化实现。

当前决策口径：

- RDF-3X-style core 是 local 和 cloud 都必须具备的基础查询内核。
- QLever-style capability 是 cloud 更早需要吸收的增强能力，不是 cloud 的替代内核。
- 对外不暴露 “RDF-3X backend / QLever backend” 选择；即便后续引入 QLever，也只能作为 `SolidRdfEngine` 内部执行层、result table 或 cache layer。

部署矩阵：

| 部署 | 必备查询内核 | 持久化差异 | QLever-style 能力 |
| --- | --- | --- | --- |
| local | `SolidRdfEngine` + RDF-3X-style planner/index | SQLite / PGlite、本机可移动索引 | 可延后吸收 vocabulary/text/result-table 思路，不引入额外常驻服务 |
| cloud | 同一套 `SolidRdfEngine` + RDF-3X-style planner/index | PostgreSQL / shared storage、租约、索引生命周期、Pod 迁移 | 更早吸收 result table、query cache、全文/RDF 一体化、高并发执行层 |

cloud/local 的差异只能体现在持久化、并发控制、租约、索引生命周期和部署形态上；查询语义、planner 能力和对外协议仍由同一个 `SolidRdfEngine` 行为契约约束。

## 数据权威

| 数据 | 权威源 | 索引/派生 |
| --- | --- | --- |
| line-addressable RDF 内容 | SolidFS 真实文件 | RDF quads、term dictionary、text/vector index |
| RDF/XML 等标准 RDF 文档内容 | SolidFS 真实文件 | RDF quads、term dictionary |
| 普通 by-line 文本 | SolidFS 真实文件 | text/vector index |
| 大二进制/特殊格式 | 对象存储或 hydrated working copy | metadata、按需提取的 text/chunk |
| RDF 查询状态 | RDF index | 不是内容源 |

DB 可以先接收 intent、队列、id 壳、索引刷新任务，但 durable 内容事实必须最终写入权威源。

## Server / Client 边界

Xpod server 只对自己拥有的 Pod storage 提供强一致本地查询：

```text
xpod-owned Pod
  server 执行
  server 有文件权威、本地 RDF index、SolidRdfEngine
```

外部 provider、用户本机 workspace、第三方 Solid storage 不进入 server 存储链路：

```text
client-mounted workspace
  client 执行
  client 读写外部 provider 或本地文件
  client 可自行使用 Comunica / local mirror / provider SPARQL
  server 只接收 Run 状态、事件、摘要、结果和必要的 durable 数据
```

如果 client 侧使用 Comunica 或类似 source router，必须按 storage provider 分发，而不是按 IdP 分发：

```text
IdP = credential authority
SP  = storage authority
```

同一个 WebID / IdP 下可以有多个 storage provider：

```text
WebID issuer: https://id.example/
Workspace A: https://pod-a.example/alice/
Workspace B: https://pod-b.example/alice/
Workspace C: file://macbook.local/Users/alice/project/
```

查询、hydrate、commit、ETag、ACL、增量同步的 dispatch key 是 SP / storage provider，不是 IdP。

## Hexastore / RDF-3X / QLever 的分层关系

这里不能理解成把 Comunica、Hexastore、RDF-3X、QLever 作为多套并列 engine
互补运行。它们在不同抽象层级上给 `SolidRdfEngine` 提供设计来源；在运行时主查询
路径上，完整 RDF engine 之间是替换关系。

| 来源 | 所在层级 | 和 `SolidRdfEngine` 的关系 | 和 Comunica 的关系 |
| --- | --- | --- | --- |
| Hexastore | 物理存储/索引 | term dictionary + 多排列 quad index 的设计来源 | 不是 SPARQL engine，不和 Comunica 对等 |
| RDF-3X | RDF database engine | local/cloud 共同需要的 planner、统计、join reorder、物理下推内核 | 替换 Comunica 主路径，而不是补在 Comunica 后面 |
| QLever | RDF/SPARQL engine 的执行层参考 | cloud 更早需要的 result table、全文/RDF 一体化、cache/vocabulary 加速方向；依附同一个 `SolidRdfEngine` 契约 | 不是公开 backend，也不是和 Comunica 协同执行 |

Xpod 的方向是用 `SolidRdfEngine` 逐步替换 Comunica 主路径，Comunica 只保留为
fallback / oracle / 过渡兼容层。`SolidRdfEngine` 自身不能被拆成 local/cloud
两套语义不同的 engine；RDF-3X 风格 planner/index 是两端共同内核，QLever 风格能力
是 cloud 更迫切、但仍落在同一契约和同一 RDF-3X-style embedded core 上的执行增强。

分层关系是：

```text
SPARQL / models DSL / app query
  -> SolidRdfEngine
       -> 自有 planner / executor / index
            Hexastore: term dictionary + 多排列索引思想
            RDF-3X: local/cloud 共享的统计、join reorder、物理下推
            QLever: cloud-first 的 result table、全文/RDF 一体化、cache/vocabulary 思路
  -> ComunicaCompatibilityEngine 仅处理未覆盖 shape
```

因此 `RdfQuadIndex` 不是外接 Hexastore，`RdfLocalQueryEngine` 也不是在
Comunica 上做增强；它们是 `SolidRdfEngine` 内部替换 Comunica 主路径的
embedded 执行层。RDF-3X 风格能力是两种部署都要持续内化的共同内核；
QLever 更像 cloud 侧在更大查询负载、并发和缓存需求下优先接入的内部加速层。
后续如果接入 QLever/RDF-3X 风格实现，也只能作为 `SolidRdfEngine` 内部执行层替换，
不能变成对外并列 engine。

### Hexastore

吸收六排列索引思想：

```text
SPOG
SOPG
POSG
POGS
OSPG
OGSP
GSPO / GPOS 作为 graph-scope 快速路径
```

当前 `quints(graph TEXT, subject TEXT, predicate TEXT, object TEXT)` 已经是 Hexastore-like，但字符串在表和多个索引中重复，空间放大明显。

### RDF-3X

RDF-3X 是 local / cloud 都需要的共同内核方向，不是只给 local 的单机实现。
Xpod 吸收的是物理层和 optimizer 思路：

- term dictionary 编码。
- quad 表只存 integer ids。
- 多排列 B-tree / SQL composite index。
- 基于 cardinality / selectivity 统计选择 join 顺序。
- 尽量把 FILTER、ORDER、LIMIT、COUNT 下推到存储层。

部署形态上，local 可以先把这些能力落在 SQLite / PGlite；cloud 则落在 PostgreSQL
或 shared storage 上。两者共享 `SolidRdfEngine` 行为契约，只替换底层持久化和
锁/租约实现。

因此实现优先级不是 “local 用 RDF-3X、cloud 用 QLever”。RDF-3X 风格的字典、
整数 quad、统计和 join/order/count 下推是两端都需要的基础查询内核。cloud/local
只在持久化、并发控制、索引重建和 Pod 迁移上分化；planner 能力和对外语义必须一致。

### QLever

QLever 在当前阶段只作为执行层参考，不作为要接入的 sidecar。

官方 QLever 是单机取向的 RDF/SPARQL graph database：它把原始 dataset 预处理成高度压缩、面向查询优化的本地 index，并用 server 进程提供 SPARQL 查询。Xpod 不直接把 Pod 内容托管给一个独立 QLever 实例，因为这会冲突于 SolidFS 文件权威、Pod 写路径、ACL、workspace 生命周期和集群迁移。

Xpod 应先吸收的是 QLever 的执行层设计，并把存储和生命周期落在 Xpod-controlled embedded engine：

```text
QLever ideas
  query planner / text search / compressed vocabulary / cached result tables
        |
        v
SolidRdfEngine embedded engine
  storage = SQLite(local) / PostgreSQL(cloud)
  authority = SolidFS files
  write path = Xpod journal + delta + index refresh
  cluster = DB locks / versioned indexes / pod ownership routing
```

这不是 cloud/local 各自选择不同品牌 engine 的拆分；cloud 和 local 都应该优先走
同一套 `SolidRdfEngine` 行为契约，只是底层持久化实现不同：

```text
local  -> SolidRdfEngine on SQLite files
cloud  -> SolidRdfEngine on PostgreSQL / shared storage
```

QLever 更适合作为 cloud-first 的后续加速候选：cloud 更早会遇到多 Pod scope、
高并发 SPARQL、全文/RDF 混合排序、查询 cache、materialized result table 和
shared index lifecycle 的压力；local 第一目标仍是零额外服务、可移动、可重建的
embedded index。即便后续 cloud 接入 QLever，也应该是 `SolidRdfEngine` 内部的
可替换执行层 / cache layer，而不是改变 Pod 文件权威或对外协议。

换句话说，QLever 的 cloud-first 含义是 “cloud 更早需要 QLever 那类结果表/cache/
全文-RDF 一体化执行能力”，不是 “cloud 绕过 RDF-3X 内核” 或 “cloud 暴露另一套
QLever API”。local 也可以继续吸收 QLever 的 vocabulary、text search 和 result
table 思路；只是 local 不应该为了这些能力先引入额外常驻服务。

当前只做 embedded 形态，不为 sidecar 提前设计 public backend interface，也不在 Components.js 配置层暴露 `SidecarQLeverBackend` 这类组件。C++/QLever sidecar 进入后续阶段时，必须先以 `SolidRdfEngine` 内部替换 adapter 的方式评估，不能改变 Pod 文件权威和现有 `/-/sparql` 协议边界。

- **现在**：先把 RDF-3X 风格的基础内核翻译进 Xpod 进程内 `SolidRdfEngine`，底层 term table、quad index、delta/journal、cache table 落到 SQLite/PG；同时只吸收 QLever 对 result table、全文/RDF 一体化和 cache 的设计启发。没有额外进程、没有额外协议边界，先和 SolidFS、ACL、runtime lifecycle、事务/journal 统一。
- **以后**：如果复用 QLever C++ 实现作为同机/同 Pod sidecar，Xpod 只通过 `SolidRdfEngine` 内部 adapter 喂数据、校验版本、切换 index 和 fallback。sidecar 仍不是 Pod 内容权威，也不成为当前阶段的公开配置选项，更不能把 cloud 变成一套绕开 RDF-3X 基础内核的独立查询语义。

Sidecar 延期的核心原因不是查询算法，而是存储边界必须补齐；下面只作为未来迁移说明，不进入当前实现：

```text
SolidFS files
  -> Xpod sync journal
  -> SQLite/PG term/delta/version tables
  -> future sidecar loads mapped snapshot or streams delta
  -> query result returns through SolidRdfEngine internal adapter
```

如果 C++ sidecar 只能读本地 index 文件，Xpod 必须把这些文件视为可重建 cache，并用 DB 记录 index version、source hash、lease owner 和 rebuild state。真正权威仍是 SolidFS + DB journal。

第一阶段继续用 `RdfQuadIndex` / `RdfLocalQueryEngine` 做可控的 embedded backend。QLever 方向进入后续替换计划，而不是替代当前 SolidFS + shadow migration 路线。

吸收工程方向：

- RDF 查询和全文检索一体化。
- vocabulary 可压缩、可 on-disk / in-memory tradeoff。
- literal text index 可以从 RDF literals 构建，也可以从外部 text records 构建。
- query cache、materialized view、update persistence / replay 可以作为后续方向。
- 单机高效执行可以通过 Xpod 的 SQLite/PG backend 翻译为集群可共享状态。

QLever 支持 federation、Graph Store HTTP Protocol、updates 等完整能力，但 Xpod server 不把 federation 放进本地 Pod 查询热路径；update 能力也必须通过 Xpod 的文件权威和 delta/journal 协议落地。

参考：

- RDF-3X: https://www.vldb.org/pvldb/vol1/1453927.pdf
- Hexastore: https://www.vldb.org/pvldb/vol1/1453965.pdf
- QLever: https://github.com/ad-freiburg/qlever
- QLever docs: https://docs.qlever.dev/

## 物理模型

目标模型：

```sql
rdf_terms (
  id BIGINT PRIMARY KEY,
  kind TEXT NOT NULL,          -- iri | literal | blank | default_graph
  value TEXT NOT NULL,
  datatype_id BIGINT,
  lang TEXT,
  hash TEXT,
  normalized_text TEXT,
  created_at TIMESTAMP
)

rdf_quads (
  graph_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  predicate_id BIGINT NOT NULL,
  object_id BIGINT NOT NULL,
  source_file_id BIGINT,
  source_line_no INTEGER,
  PRIMARY KEY (graph_id, subject_id, predicate_id, object_id)
)

rdf_sources (
  id BIGINT PRIMARY KEY,
  source TEXT NOT NULL,
  workspace TEXT NOT NULL,
  local_path TEXT,
  content_type TEXT,
  last_indexed_at TIMESTAMP,
  source_version TEXT
)
```

Indexes:

```sql
CREATE INDEX rdf_quads_spog ON rdf_quads(subject_id, predicate_id, object_id, graph_id);
CREATE INDEX rdf_quads_posg ON rdf_quads(predicate_id, object_id, subject_id, graph_id);
CREATE INDEX rdf_quads_ospg ON rdf_quads(object_id, subject_id, predicate_id, graph_id);
CREATE INDEX rdf_quads_gspo ON rdf_quads(graph_id, subject_id, predicate_id, object_id);
CREATE INDEX rdf_quads_gpos ON rdf_quads(graph_id, predicate_id, object_id, subject_id);
CREATE INDEX rdf_quads_source ON rdf_quads(source_file_id);
```

是否保留全部六排列由真实查询统计决定。第一版可以保守保留，后续按空间和命中率裁剪。

### Term 编码

- IRI、literal、datatype、language 分离存储。
- 常见 datatype、predicate、namespace 可以预编码。
- 关键词检索不要扫 `rdf_quads`，只查 term/text index，再回 join quads。
- 对可从路径稳定推导的 graph/source，不重复存长字符串到每一行。

## Text / Chunk / Vector

全文和向量不是 RDF index 的附属字段，而是并列索引层：

```text
rdf_terms
  literal / iri label
    -> text postings

files
  markdown / source / ttl
    -> chunks
    -> text postings
    -> embeddings
    -> rdf relation back to source file / subject
```

文件树和 RDF 图可以合并成一个可查询的大树：

```text
workspace
  file
    heading
      chunk
        mention / entity / rdf subject
```

这不改变内容权威：chunk、embedding、mention 都是派生索引。

当前第一步落地为 `RdfTextIndex` 和 `RdfVectorIndex`：

- `rdf_text_sources` 记录 `source`、`workspace`、本地路径、content type、source version/hash；字段名保持关系语义，值可以是 Solid resource reference 或 `file://` workspace。
- `rdf_text_chunks` 记录确定性的 chunk key、ordinal、heading path、offset、content、normalized text 和 token count。
- Markdown 先按标题层级切 chunk；普通文本先按段落切，单段多行文本退化为行级 chunk。
- text search 支持 query、workspace scope 和 source prefix scope；第一版使用 embedded SQLite 派生索引，不改变文件权威。
- `rdf_vector_sources` / `rdf_vector_chunks` 记录 source/chunk 级 embedding、model、offset、heading path 和 content snapshot；`rdf_vector_components` 物化每个 chunk 的向量分量，第一版用 embedded SQLite 做 dot/cosine/euclidean scoring、threshold 过滤和 source-local order/window，后续可替换成 pgvector/sqlite-vec/QLever-like 执行层。
- 标准 RDF 文档覆盖两层语义：
  - line-addressable RDF：`.ttl` / `.jsonld` / `.nt` / `.nq` / `.trig` / `.n3`。这些格式按扩展名推导 content type，可通过本地 RDF 文件权威路径刷新结构化 index，并进入 by-line 工具文件追踪。
  - 非 by-line 标准 RDF：`.rdf` / `.rdfs` / `.owl` / `application/rdf+xml`。这些格式可解析、镜像并全量同步到结构化 RDF index，但不进入 SolidFS by-line 自动追踪，也不走单文档增量 patch。
- `RdfIndexSolidFsSyncer` 在 direct workspace commit 时会把标准 RDF 文档同步到结构化 RDF index；配置了 text index 时，仅把 line-addressable RDF 文本、Markdown、plain text 同步到 `RdfTextIndex`，RDF/XML 这类非 by-line 标准 RDF 只做全量解析刷新，不进入文本/by-line 索引；syncer 通过 `shouldTrackPath(...)` 声明路径范围，避免 SolidFS 为文本索引监听所有文件。

## Query Engine Scope

第一阶段必须覆盖 app 常用查询，而不是追求一次性完整 SPARQL 1.1：

| 能力 | 第一阶段 |
| --- | --- |
| BGP | 必须 |
| GRAPH / named graph scope | 必须 |
| FILTER 比较 | 必须 |
| FILTER OR | 同一变量的等值/IN 枚举可编译为 `$in`；复杂布尔表达式 fallback |
| FILTER string functions | 常用子集 |
| ORDER BY | 单变量必须；安全表达式会先下放成 local BIND；connected BGP self-join 可下推多变量/混合方向排序；单 pattern 可下推多变量/混合方向排序 |
| LIMIT / OFFSET | 必须 |
| SELECT DISTINCT / REDUCED | `DISTINCT` 已支持；安全 required BGP 的单 pattern / connected BGP 投影去重可随 ORDER/LIMIT 一起下推到 SQL；其他 shape 在 projection 后本地去重；`REDUCED` 不强制去重 |
| COUNT / basic aggregate | `COUNT` / `COUNT DISTINCT` 已支持并有安全 SQL 下推；`SUM` / `AVG` / `MIN` / `MAX` 的 guarded numeric literal 子集已走 embedded aggregate，SPARQL 入口要求 `FILTER(isNumeric(?var))`；安全 required BGP 的非分组与分组 numeric aggregate 均可下推到 SQL self-join，复杂/未守卫聚合 fallback |
| OPTIONAL | 常用 left join 必须；受控 nested OPTIONAL 已支持 |
| BIND | 标准安全子集：变量/IRI/literal、`STR`、`STRLEN`、`CONCAT`、`LCASE/UCASE`、`SUBSTR` / XPath `substring`、`IRI/URI` |
| UNION | 受控子集已进入第二阶段：每个 branch 必须可编译为 embedded BGP/OPTIONAL/FILTER/VALUES；nested UNION 已支持，OPTIONAL 内 UNION 也已支持，空 required branch 和不约束 branch required pattern 的 VALUES 仍 fallback |
| MINUS / FILTER NOT EXISTS / FILTER EXISTS | 受控 dependent-join 子集已进入第二阶段：`MINUS` / `FILTER NOT EXISTS` 作为 anti-join，`FILTER EXISTS` 作为 semi-join；右侧必须有 required BGP 或受控 `UNION` branch，并且和外层 required shape 或所在 OPTIONAL 分支已绑定变量共享变量；nested dependent-join、不相关 dependent-join 仍 fallback |
| property path | 受控固定长度子集已进入第二阶段：`^` 和 `/` 可在 adapter 边界展开成普通 BGP；简单固定谓词 alternative `p1|p2` 会编译成 predicate `$in`，且可作为 sequence 中的一段；`*`、`+`、`?`、不等长/复杂 `|` 组合和 `!` 仍 fallback |
| CONSTRUCT / DESCRIBE | 基础 CONSTRUCT 已进入第二阶段；DESCRIBE 支持直接 IRI、WHERE 绑定变量和标准 `DESCRIBE *` 的 direct-description 子集 |
| SPARQL UPDATE | delta-first，复杂语句 fallback |
| SERVICE / federation | server 默认禁用，不进入 compatibility fallback；后续只能通过显式 allowlist/plugin 打开 |

Local planner 输入可以来自：

- SPARQL parser/algebra。
- drizzle-solid / models query。
- app 内部 SQL-like 查询 DSL。

输出是统一物理计划：

```text
IndexScan
Filter
Join
OptionalJoin
Project
Sort
Limit
Aggregate
TextSearch
VectorSearch
```

`TextSearch` 已有第一版本地 binding source：

- `RdfLocalQuery.textSearch[]` 从 `RdfTextIndex` 产出 bindings，可绑定 `source`、`chunk`、`content`、`heading`、`score`、`workspace`、`localPath`、`contentType`、offset 等变量。
- `source` 是文件/source 资源的 named node，能直接和 RDF BGP 的 graph / subject / object 变量 join。
- `chunk` 是派生 chunk named node（source 资源 + deterministic chunk key），不是内容权威资源。
- `limit` / `offset` 是 text search source 自己的 top-K/window，先在 `RdfTextIndex` 命中集上执行，再和 RDF BGP join；如果需要 join 后分页，使用 `RdfLocalQuery.limit` / `offset`。
- `orderBy` 是 text search source-local ordering，默认按 score 降序；可显式按 `score`、`source`、`localPath`、`ordinal`、offset 等稳定字段排序，然后再执行 source-local `limit` / `offset`。它不替代 join 后的 `RdfLocalQuery.orderBy`。
- text search 会先用 `rdf_text_terms` posting 表按 query token 缩小候选 chunk，再用 normalized phrase `LIKE` 复验，保留原有 substring / phrase 语义。
- 如果 query 使用 `textSearch` 但 engine 未配置 `RdfTextIndex`，必须显式报错，不落回 compatibility engine。

`VectorSearch` 已有第一版本地 binding source：

- `RdfLocalQuery.vectorSearch[]` 从 `RdfVectorIndex` 产出 bindings，可绑定 `source`、`chunk`、`content`、`heading`、`score`、`distance`、`workspace`、`localPath`、`contentType`、offset、`model` 等变量。
- `source` / `chunk` 语义和 `TextSearch` 一致：source 是文件资源，可直接 join RDF named graph 或 subject；chunk 是派生 chunk resource，不是内容权威资源。
- `embedding` 由调用方传入，`vectorModel`、workspace scope、source prefix、limit/offset/threshold 都是受控内部 DSL 参数；公开 SPARQL 向量函数后续再定义。
- `limit` / `offset` 是 vector search source 自己的 top-K/window，先在 `RdfVectorIndex` 排序命中集上执行，再和 RDF BGP join；如果需要 join 后分页，使用 `RdfLocalQuery.limit` / `offset`。
- `orderBy` 是 vector search source-local ordering，默认按 score 降序；可显式按 `score`、`distance`、`source`、`localPath`、`ordinal`、offset 等稳定字段排序，然后再执行 source-local `limit` / `offset`。它不替代 join 后的 `RdfLocalQuery.orderBy`。
- 如果 query 使用 `vectorSearch` 但 engine 未配置 `RdfVectorIndex`，必须显式报错，不落回 compatibility engine。

`TextSearch` / `VectorSearch` 和 RDF BGP 的 required-source planner 已开始统一：

- required RDF pattern、text search source、vector search source 会被放进同一个本地 planner，根据当前 bindings 的 connectedness、索引 count 估算和 search hit 数选择执行顺序。
- 宽 text/vector source 不再固定先执行；当 RDF exact graph/predicate/object scan 更窄时，会先用 RDF index 缩小 bindings，再把 search source 当作 join source 接上。
- 当 RDF pattern 已经把 search source 的 `source` 边/变量绑定到具体文件资源时，planner 会把这个 bound source 作为 exact source 约束传给 text/vector index，避免先拉整个 workspace/prefix 的搜索命中再在内存里过滤。这个约束是从关系绑定推导出来的执行条件，不额外暴露带 `Iri` / `Uri` 后缀的用户字段。
- search source 带 `limit` / `offset` 时不能把 bound `source` 下推成 per-source top-K；source-local window 必须先在完整 search scope 上执行，再做 RDF join。此时 planner 会退回全局 search window，避免 selected source 在全局 top-K 外却被误召回。
- 未被当前 binding 约束的 search source 会先走 source-local cardinality estimate，避免为了 join 顺序提前 materialize text/vector hits；已经被当前 binding 约束的 search source 再用真实 hits 估算兼容行数。
- search source 带 `limit` / `offset` 时，planner 仍可按 source-local hit 窗口参与重排；这个窗口不是 join 后分页，plan 会把 `limit:n` / `offset:n` 标在 `TextSearch(...)` / `VectorSearch(...)` 节点上。
- search source 带 `orderBy` 时，排序同样是 source-local，plan 会把 `order:field:direction` 标在 `TextSearch(...)` / `VectorSearch(...)` 节点上，便于 benchmark gate 区分 search window 和 join-result sort。
- RDF exact term pattern 的 cardinality 估算已通过 `RdfQuadIndex.estimateCardinality(...)` 进入 planner，并带写入/删除失效的缓存；planner 会按 compiled pattern 去重，避免同一批 bindings 里重复的 join key 反复 count。待选 pattern 被一个或多个已绑定 join slot 约束时，会用 `count(pattern) / countDistinctTuple(pattern, slots)` 做保守 fanout 估算，把单列或多列 distinct 分布用于 join 顺序选择；复杂 operator/range/text filter 仍回到精确 count，优先保证语义正确。

## Planner

Planner 的基本规则：

1. graph scope 优先缩小候选。
2. 固定 predicate / object 的 pattern 优先。
3. 选择估计 cardinality 最小的 scan 做 join 起点。
4. FILTER 能转成 term/range 条件时下推。
5. ORDER BY 与索引顺序兼容时避免额外排序。
6. LIMIT 在语义安全时尽早下推。
7. 不确定时宁可慢，不返回错结果。

需要维护的统计。RDF-3X 风格统计是 local / cloud 共同内核的一部分，不是 local-only
能力；cloud 后续更早吸收 QLever 风格 result table/cache 时，也应该复用这套基础统计。
当前第一步已覆盖 exact term pattern 的 `count(...)` 缓存，尤其是 graph/predicate、
predicate/object、subject/predicate、graph/subject 等和现有物理索引一致的组合；同时已
暴露 graph、predicate、predicate/object、subject/predicate 的 top cardinality 分布，
以及单 slot / 多 slot distinct 统计。后续再扩展文本/向量 ranking 统计：

```text
count(graph)
count(predicate)
count(predicate, object)
count(subject, predicate)
distinct(subject|predicate|object per graph)
top graph/predicate/predicate-object/subject-predicate cardinality
literal datatype distribution
text term document frequency
vector model/dimensions distribution
```

## SPARQL Update

文件是权威，SPARQL UPDATE 不能长期只更新 DB。

更新流程：

```text
SPARQL UPDATE
  -> parse
  -> classify
  -> compute quad delta
  -> patch authority file
  -> refresh affected index rows
```

简单语句应走 delta：

- `INSERT DATA`
- `DELETE DATA`
- `DELETE WHERE` 可直接计算删除 delta

Query-backed 语句应先用本地 query engine 计算 bindings，再 materialize 成 delta：

- `DELETE/INSERT WHERE` 先用 query engine 得到实际 delta。
- `INSERT WHERE` 是没有 DELETE template 的标准 SPARQL UPDATE shape，同样先计算 bindings，再 materialize insert quads。
- UPDATE template 仍只接受普通 triple；WHERE 可以复用 embedded query 子集，包括安全的 `FILTER` / `VALUES` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join 和固定长度 property path（`^`、`/`）。`WITH <graph>` 的安全子集会先归一化成同一 named graph 下的模板和 WHERE；`USING <graph>` default graph 会作为 WHERE 默认图编译，多个 default `USING` 按标准 SPARQL Update 语义合并为一个 default dataset scope；basePath scope 内的 `USING NAMED <graph>` 可作为 WHERE named dataset scope，约束 `GRAPH <graph>` / `GRAPH ?g` 可见 graph，base 外 graph 仍 fallback。

复杂/未覆盖语句：

- 如果无法安全映射到文件 patch，则返回明确错误或进入受控 fallback。
- fallback 可以短期全量重写 affected RDF 文件，但必须计数、可观测、可逐步消灭。

Canonical by-line RDF 建议：

- 一行一个 statement。
- 尽量使用完整 IRI 或稳定 prefix policy。
- blank node 需要限制或 skolemize。
- `source_line_no` 只作为优化和诊断，不作为 RDF 身份。

## Comunica 兼容层

保留组件，不保留核心依赖：

```text
SolidRdfEngine
  primary path for xpod-owned Pod

ComunicaCompatibilityEngine
  optional fallback
  test oracle
  client-side external source helper
  federation plugin
```

server-owned Pod 的默认策略：

- `SERVICE` 默认禁用或 require allowlist。
- 本地 query 不通过 remote source federation。
- fallback 命中需要打指标，不能静默成为常态。
- 禁用类能力不能走 compatibility fallback；例如 `SERVICE` 必须直接报错，避免被 Comunica 接手后变成隐式远程 federation。

删除条件：

- 业务查询集全量通过。
- W3C SPARQL query suite 的目标子集通过。
- `/-/sparql` 的 SELECT/ASK/CONSTRUCT 基本兼容。
- SPARQL UPDATE delta 覆盖主要写路径。
- 兼容层 fallback 指标低于约定阈值。

## API / Component Boundary

`/-/sparql` 是协议组件，不等于查询引擎实现。

```text
SubgraphSparqlHttpHandler
  -> SolidRdfEngine.query()
  -> result serializer
```

`MixDataAccessor` 的职责保持：

- 写入 RDF 文件。
- 解析并刷新 RDF index。
- 为 CSS 兼容路径提供 `internal/quads`。

`QuintStore` 可以作为 v1 API 名称继续存在，但内部语义逐步迁移：

```text
QuintStore v1:
  TEXT graph/subject/predicate/object

RdfQuadIndex v2:
  term id graph/subject/predicate/object
```

对外 API 尽量保持 `get(pattern)`、`multiPut(quads)`、`del(pattern)` 兼容，便于分阶段替换。

## Benchmark-first Rollout

实现必须先按 `@undefineds.co/models` 建业务基准，再一层一层替换。不要先写一套脱离业务模型的 synthetic SPARQL benchmark。

基准来源：

```text
@undefineds.co/models resources
  chat / task / thread / message / run / runStep
  agent / workspace / credential / model provider
        |
        v
models repositories / drizzle-solid query builders
        |
        v
canonical business query set
```

第一版 benchmark 至少覆盖：

| 场景 | 目的 |
| --- | --- |
| list chats / tasks | surface 列表和 owner/scope 过滤 |
| list threads by chat/task | relation 和 graph scope |
| list messages by thread with date bucket | 路径型 id、日期分桶、排序和分页 |
| latest message / latest run | ORDER BY + LIMIT |
| run with run steps | one-to-many join / optional |
| pending/running runs | status filter |
| task materialization query | due time / recurrence filter |
| search messages/literals | text index 与 RDF subject 回连 |
| load by exact base-relative id | id 语义和 IRI expansion |
| ACL / graph prefix scoped query | scope filter 不全表扫描 |

数据规模分层：

```text
small:  单 Pod、几十条 chat/task/message/run，用于正确性和 snapshot
medium: 单 Pod、10k~100k quads，用于常规性能
large:  多 Pod scope、1M+ quads，用于索引空间和 planner 选择
```

`bun run benchmark:rdf-models -- --scale=large` 的默认 seed 必须真实达到
1M+ quads，并把 synthetic message 分布到多个 Pod scope。手动传
`--syntheticMessages=N` 可以降规模做 smoke run，但报告里的 `seed.fullScale`
必须为 `false`，CLI 也会非零退出，避免把低规模 override 当成完整 large
benchmark。

每个 benchmark case 必须记录：

- models-level query 名称和输入参数。
- 生成的 SPARQL/algebra/physical plan。
- 返回行数和 checksum。
- 扫描行数、索引选择、join 顺序、fallback reason。
- p50/p95 latency。
- DB 表和索引空间占用。

当前可执行入口：

```bash
bun run benchmark:rdf-models
bun run benchmark:rdf-models -- --scale=small --iterations=1
bun run test:w3c
```

默认输出到 `.test-data/rdf-engine/`：

- `models-baseline-*.json`：只跑 candidate `SolidRdfEngine`，记录 case、checksum、p50/p95、physical plan、scanned rows、index choice 和空间统计。
- `models-shadow-*.json`：同一批 models case 同时跑旧 TEXT `QuintStore` 和 term-id `SolidRdfEngine`，记录 matched / orderedMatched / diff、p95 performance comparison、TEXT vs term-id space comparison 和 plan gate。

这个入口只用于阶段 1/2 的 baseline 和 shadow comparison，不切换 `/-/sparql` 主路径。

`bun run test:w3c` 先落为第一版目标子集，不尝试一次性跑完整 W3C SPARQL suite。当前子集覆盖 embedded primary path 已声明支持的 SELECT BGP / OPTIONAL / OPTIONAL 内 VALUES / FILTER / VALUES / VALUES `UNDEF` / BIND / UNION / MINUS / FILTER EXISTS / FILTER NOT EXISTS / dependent group 内受控 UNION / ORDER / LIMIT、`FROM` / `FROM NAMED` dataset scope、固定长度 property path、GROUP BY COUNT / HAVING、ASK、基础 CONSTRUCT、受控 DESCRIBE、scoped `INSERT DATA` / `DELETE DATA`，以及 query-backed `DELETE/INSERT WHERE` update；每个 case 都断言不会走 compatibility fallback。后续扩大 SPARQL 子集时，先把新增能力补进这个入口，再调整对应 fallback 边界。

### Shadow Replacement Protocol

每一层替换都必须先 shadow，不直接切主路径：

```text
current engine
  -> result A

new layer
  -> result B

compare(A, B)
  same bindings / quads / order when order is semantically defined
  same count / checksum when order is undefined
```

允许的替换顺序：

1. **Instrumentation only**
   - 给现有 `ComunicaQuintEngine` / `QuintStore` 增加 scanned rows、index choice、fallback、latency 指标。
   - 产出 models benchmark baseline。

2. **Term dictionary shadow**
   - 写入时同时生成 `rdf_terms` / `rdf_quads`。
   - 读仍走旧 TEXT `quints`。
   - benchmark 比较空间占用和写入成本。

3. **Index scan shadow**
   - 对单 pattern / graph scoped pattern 用 int quad index 执行 shadow scan。
   - 和旧 `QuintStore.get(pattern)` 比较结果。

4. **Planner shadow**
   - 对 models query 生成 physical plan。
   - 执行 BGP/FILTER/ORDER/LIMIT/COUNT 子集。
   - 和当前 engine 比较结果与性能。

5. **Selective primary**
   - 只对已覆盖且 benchmark 稳定的 query shape 走 `SolidRdfEngine`。
   - 其余 query 明确 fallback 到 `ComunicaCompatibilityEngine`。

6. **Endpoint primary**
   - `/-/sparql` 默认走 `SolidRdfEngine`。
   - fallback 必须有指标和告警，不允许静默常态化。

7. **Comunica de-core**
   - server-owned Pod 默认不加载 Comunica。
   - client external provider / federation plugin 才加载兼容层。

每一阶段的 stop condition：

- models benchmark 正确性 100% 对齐。
- 已定义 query shape 没有 fallback。
- p95 latency 不劣于 baseline；允许短期写放大，但必须量化。
- 空间占用有明确方向，term-id quads 不能比 TEXT quints 更差。
- `bun run test:integration` 通过。

## Migration

阶段 0：现状冻结

- 明确 `ComunicaQuintEngine` 是 compatibility engine，不再继续扩展为战略主引擎。
- 新增指标：query scanned rows、fallback reason、index choice、execution time。
- 先完成 models benchmark baseline，并保存为后续替换的对照。

阶段 1：物理层压缩

- 新增 term dictionary。
- 新增 int quad table。
- 写入时双写 TEXT quints 和 int quads。
- 读路径先 shadow compare，确认结果一致。

当前实现进度：

- `RdfTermDictionary` / `RdfQuadIndex` 已提供 SQLite term dictionary、`rdf_sources`、`rdf_quads` 和 `SPOG` / `POSG` / `OSPG` / `GSPO` / `GPOS` / source indexes。
- `ShadowRdfQuintStore` 已提供 phase 1 的 shadow-first 封装：主读写接口仍兼容 `QuintStore`，写入同步到 term-id index，读取仍走旧 TEXT store，`shadowGet(...)` 用于显式对比。
- `ShadowRdfQuintStore.backfillShadowIndex(...)` 已支持从现有 TEXT `QuintStore` 分批回灌 term-id index；这让已有 Pod 持久化数据可以进入 shadow compare，而不是只覆盖新写入。
- `runRdfModelsBenchmark(...)` 已能基于 `rdfModelsBenchmarkCases` 生成 baseline report，包含 query、返回行数、checksum、p50/p95、physical plan、scanned rows、index choice、join order、fallback reason 和 index 空间统计；空间统计同时记录总 DB bytes、RDF table bytes、RDF index bytes 和 SQLite object breakdown。medium 级 `search message literals` case 会带 `$contains` 条件，证明 literal text index 不是普通 predicate scan。report 同时记录 `planMatched` / `missingPlan` / `failedPlanCases`，把 expected plan 和实际 `metrics.indexChoice` / `metrics.queryPlan` 对齐成可机检 gate。
- `runRdfModelsShadowBenchmark(...)` 已能对同一 models benchmark case 同时执行旧 TEXT `QuintStore` 和新 term-id `SolidRdfEngine` scan，并记录 matched、orderedMatch、diff、两边 checksum、p50/p95、compatibility store stats、candidate index metrics、performance comparison 和 space comparison；TEXT store stats 与 candidate index stats 都包含 table/index space breakdown。medium/large scale 已把 “term-id quads 不能比 TEXT quints 更差” 做成硬 gate；small scale 只记录空间比较，避免固定 schema/index 页开销误判。
- `bun run benchmark:rdf-models` 已提供 repo 内可重复执行的基准入口，会构造覆盖 chat/task/thread/message/run/runStep/provider/model/credential 的 deterministic seed data，回灌 shadow index，并把 baseline / shadow report 保存到 `.test-data/rdf-engine/`。脚本 summary 会打印 baseline/shadow plan gate、shadow performance gate 和 shadow space gate；任何 shadow diff、plan mismatch、明显 p95 退化或 medium/large 空间退化都会让命令退出非 0。
- `rdfModelsLocalQueryBenchmarkCases` 已开始覆盖跨 pattern 的业务查询物理计划，并在 report 中记录 LocalQuery DSL 输入、physical plan 和 checksum：按 thread 拉最新 message 会要求 `ORDER BY createdAt DESC LIMIT 1` 保持在 SQL self-join 内；workspace 内下一条 queued run 会要求 status/workspace/createdAt 三个 pattern 在 SQL self-join 内完成并下推 `ORDER BY createdAt ASC LIMIT 1`；run step 列表会要求 `rdf:type RunStep` 和 `udfs:run` 关系在 SQL self-join 内完成并下推排序/分页；task materialization 会要求 `rdf:type Schedule`、`udfs:status "active"` 和 `udfs:nextRunAt <= cutoff` 在 SQL self-join 内完成，并下推 range filter、排序和分页；这些 timeline/state-center/one-to-many/scheduler 查询会和 grouped message count / message-thread `COUNT DISTINCT` 一起作为 LocalQueryEngine 的 models-level plan gate。
- `RdfLocalQueryEngine` 已开始承接 phase 2 的本地物理查询层，支持 BGP join、OPTIONAL group、COUNT/basic aggregate、FILTER DSL 和 select/order/limit 投影；可下推的 exact/range/prefix filter 会合并到 `RdfQuadIndex.scan(...)`，纯 required-pattern 查询里已经由 index 保证的 filter 不再重复进入后置内存 `Filter(...)`。
- `RdfQuadIndex.scan(...)` 已把 graph/source prefix scope、lexical range filter 和 RDF term text search 改为显式 `JOIN rdf_terms ...`，避免把前缀 graph、range hit 或 text hit 先展开成巨大 `IN (?, ...)` / `IN (SELECT ...)` 候选列表；`$in` / `$notIn` 这类 VALUES-style term filter 在短列表时保留参数化 `IN`，长列表会写入临时候选表并用 JOIN / anti-JOIN 回连 quad scan，避免长 SQL、参数上限和 planner 误判；medium models benchmark 中 `search message literals` 的 physical plan 可机检到 `prefix_graph_id` 和 `text_object_id_contains` JOIN，`task materialization due time` 可机检到 `object_id_range_lte` JOIN。
- connected required BGP 已有受控 SQL self-join 快路径：`RdfLocalQueryEngine` 在没有 OPTIONAL / UNION / dependent join / text-vector source 的安全 shape 下，会先用 `RdfQuadIndex.estimateCardinality(...)` 按选择性和共享变量连通性重排 BGP pattern，再把多 pattern BGP 下推到 `RdfQuadIndex.joinPatterns(...)` / `countJoinPatterns(...)`，由 `rdf_quads q0 JOIN rdf_quads q1 ...` 直接按共享变量连接并返回 bindings 或 aggregate rows。安全的 `SELECT DISTINCT ?x ... ORDER BY ?x LIMIT n` 这类投影去重可在 SQL self-join 内执行：projection、ORDER 和 filter recheck 需要的变量必须保留，避免先丢变量再复验或分页造成错结果。非分组 `COUNT` / `COUNT DISTINCT` 可在 SQL self-join 内直接聚合，避免先 materialize join bindings 再在 TS 层计数。`ORDER BY` 绑定变量支持多变量和混合方向，并可把对应 `LIMIT` / `OFFSET` 一并放进 SQL self-join；安全的 term equality/range/IN/prefix/text operator FILTER、常量 `sameTerm`、term-type、language 和 datatype filter 会按变量所在 term slot 编译进 self-join，并用 pattern-scoped SQL alias 避免多个 pattern 的 `rdf_terms` join 和候选表冲突。变量-变量 FILTER、`BOUND`/stringLength、aggregate `HAVING` 或更复杂 query shape 继续走既有 cardinality planner 和 TS binding merge，避免提前分页或半下推造成错结果。
- 安全的 `GROUP BY ?var + COUNT(...)` 已有 SQL 下推快路径：当 required BGP 只包含可编译 pattern、没有 OPTIONAL / UNION / dependent join / search source / BIND / DISTINCT，且 group/count/order/having 只引用 BGP 变量或聚合别名时，`RdfLocalQueryEngine` 会先做同一套 BGP join reorder，再把连接和分组交给 `RdfQuadIndex.groupCountJoinPatterns(...)`，由 SQL self-join 后直接 `GROUP BY` / `COUNT` / `COUNT DISTINCT` 返回分组行；可下推 FILTER 会在 SQL 内过滤并不再对聚合结果做原始变量复验。grouped result 的 `ORDER BY` / `LIMIT` / `OFFSET` 可继续下推到 SQL，其中 group 变量排序通过 `rdf_terms.value` 保持词法顺序，聚合别名排序直接按 COUNT 数值排序；安全的 numeric aggregate `HAVING` 会编译成 SQL `HAVING`，确保分页发生在聚合过滤之后。`HAVING (COUNT(DISTINCT ?x) > n)` 这类未投影聚合表达式会编译成内部 hidden aggregate alias，用于过滤但不暴露到 SELECT metadata/result。非 numeric `HAVING`、带 `BIND` 的 group expression、非下推 filter 和更复杂 shape 仍留在本地 query 层聚合。
- required BGP pattern 选择已开始使用 embedded index cardinality：每一步基于当前 bindings、可下推 filter 和 `RdfQuadIndex.estimateCardinality(...)` / `count(...)` 估算候选行数，优先选择 connected 且候选更小的 scan 起点，避免固定顺序让宽 pattern 先扫全量；exact term pattern 的估算带写入/删除失效缓存，减少 planner 重复 `COUNT(*)`。
- 单 required pattern 的 `ORDER BY` / `LIMIT` / `OFFSET` 已在语义安全时下推到 `RdfQuadIndex.scan(...)`：排序变量必须能直接映射到该 pattern 的 term slot；分页只有在排序已下推或无排序、相关 filter 都可下推、且 pattern 内没有重复变量跨 term slot 一致性约束时才进入 index，避免先分页再应用未下推 row consistency 过滤造成错结果。多变量 `ORDER BY` 会下推成 SQLite term join 排序，支持每个排序列独立的 ASC/DESC 方向。
- 单 required pattern 的 `COUNT` 已在语义安全时下推到 `RdfQuadIndex.count(...)` / `countDistinct(...)`：count 变量必须来自该 pattern，不能有 optional/order/pagination，所有 filter 都可下推，且 pattern 内不能有重复变量跨 term slot 一致性约束；`COUNT DISTINCT ?var` 只有在 `?var` 映射到单个 term slot 时才下推为 `COUNT(DISTINCT slot)`，多 slot 重复变量仍保留在 query 层聚合。connected BGP 的非分组 `COUNT` / `COUNT DISTINCT` 走 `countJoinPatterns(...)`，grouped `COUNT` / `COUNT DISTINCT` 走 `groupCountJoinPatterns(...)`。
- typed numeric literal range 已按数值语义进入 embedded path：`xsd:integer` / `decimal` / `double` / `float` 及常见派生整数类型会写入 `rdf_terms.numeric_value` 并建立 `(kind, numeric_value)` 索引，`RdfQuadIndex` 用显式 `JOIN rdf_terms ... numeric_value` 执行 numeric range scan，避免 `"10" < "9"` 这类字符串序导致错结果，也避免先扫描 numeric term 再把 id 列表回填到 `IN (...)`；未声明为 numeric datatype 的 literal 仍保持 lexical range 语义。旧 RDF index 打开时会补列、建索引并回填可解析的 numeric literal。
- RDF literal text search 已先走 embedded path：`RdfTermDictionary.normalized_text` 负责 `contains` / `endsWith` 候选集，`regex` 暂用 term 表候选扫描并写入临时候选表，`RdfQuadIndex` 再通过显式 JOIN 回连到 quad scan，避免把命中的 term ids 展开成巨大 `IN (?, ...)`；plan 会记录 `TextSearch(...)`。query 层仍会复验 filter；带 flags 的 `regex` 暂不下推，避免 normalized index 改变语义。
- `STR(...)` 字符串过滤已按标准 SPARQL 词法值语义进入 embedded path：`STR(?term) = "..."`、`STR(?term) IN (...)` 和 `STRSTARTS` / `CONTAINS` / `STRENDS` / `REGEX` 会编译成显式 `stringValue` filter，避免把 IRI 与同词法 literal 误当成同一个 RDF term。`LCASE(STR(?term))` / `UCASE(STR(?term))` 以及对应 XPath `fn:lower-case` / `fn:upper-case` 嵌入字符串 filter 时会编译成本地 case-normalized operand，先作为后置 filter 执行，不提前下推到 term index。`stringValue` 的 equality / IN 保留为本地后置 filter，不下推成 term equality；prefix/contains/endsWith/regex 可按 term slot 推导候选 term kind 后下推，`object` 会覆盖 IRI、literal 和 blank node，避免 `STRSTARTS(STR(?object), "...")` 这类关系 IRI 查询被误当成 literal-only 搜索；`subject` / `graph` / `predicate` 仍按各自 RDF term kind 限定。
- 标准 XPath function-call 形式也已进入 embedded path：`fn:contains` / `fn:starts-with` / `fn:ends-with` / `fn:matches` 会归一成已有字符串 filter，`fn:string-length(...)` 会归一成本地后置 `stringLength` filter，`fn:concat(...)` 会归一成 `CONCAT(...)` BIND 绑定，`fn:lower-case(...)` / `fn:upper-case(...)` 可用于 BIND，也可作为字符串 FILTER 的 case-normalized operand，`fn:substring(...)` 会归一成 `SUBSTR(...)` BIND 绑定，避免 sparqljs 把这些标准写法解析成 `functionCall` 后误落回 compatibility engine；未列入白名单的自定义函数仍明确 fallback。
- SPARQL adapter 已支持变量-常量和常量-变量两种方向的基础比较 FILTER：例如 `?created <= "..."` 和 `"... " >= ?created` 都会编译成等价 local filter，避免因为表达式左右顺序不同落回 compatibility engine。变量-变量比较也已进入 embedded path：`?a < ?b`、`?a = ?b`、`?a != ?b` 会在 local binding 阶段按两侧已绑定值比较；`STR(?a) = STR(?b)` 和 `STRLEN(STR(?a)) < STRLEN(STR(?b))` 会分别按词法值和长度比较。可严格反转的 negated FILTER 也会走 embedded path：`!(?x = value)` / `!(?x > value)` / `!(?x IN (...))` 会分别编译成 `$ne` / 反向范围 / `$notIn`；`!(?x = "a" || ?x = "b")` 这类同变量 OR 枚举会折成 `$notIn`。需要 De Morgan 展开的复杂 `!(A && B)`、跨变量 OR、range OR 和函数 OR 仍 fallback。
- 标准 RDF term-test FILTER 函数已进入 embedded path：`isIRI` / `isURI` / `isBlank` / `isLiteral` / `isNumeric`、`sameTerm(...)`、`lang(?literal) = "..."`、`lang(?literal) != "..."`、`LANGMATCHES(LANG(?literal), "...")`、`datatype(?literal) = <iri>` 和 `datatype(?literal) != <iri>` 会编译成本地行内 filter，覆盖常见类型守卫和语言/datatype 查询；其中常量 `sameTerm`、term-type、language 和 datatype filter 已下推到 term-id index，并继续在 query 层复验，避免 term-test 语义被误当成 lexical scan。变量-变量 `sameTerm`、`datatype/lang` 的范围比较、表达式嵌套和更复杂 EBV 仍 fallback 或留在本地行过滤。
- SPARQL adapter 已支持安全的 same-variable OR 枚举 FILTER：例如 `?status = "open" || ?status = "active"` 以及同一变量上的 `IN(...)` 混合分支会合并成本地 `$in` filter，并继续由 `RdfQuadIndex.scan(...)` 下推；`STR(?term) = "a" || STR(?term) = "b"` 会保留 `stringValue` operand 并作为本地后置 IN filter，避免词法值比较退化成 RDF term 比较。跨变量 OR、混合裸变量/`STR(...)` operand、OR 内字符串函数/range/BOUND/AND 等复杂布尔表达式仍明确 fallback，避免半语义执行。
- SPARQL adapter 已支持常见 OPTIONAL anti-join：`FILTER(!BOUND(?var))` 会编译成本地 `$bound: false`，由 embedded `RdfLocalQueryEngine` 在 OPTIONAL join 后过滤；不需要落回 compatibility engine。
- OPTIONAL 内部的局部 FILTER / BIND / 受控 nested OPTIONAL 已进入 embedded path：adapter 会把 `OPTIONAL { ... FILTER(...) / BIND(...) / OPTIONAL { ... } }` 编译成 optional group 的 local filter/binding/nested group，`RdfLocalQueryEngine` 在 optional 匹配分支内递归应用并保留 left join 语义；可下推的 optional filter 仍能进入 `RdfQuadIndex.scan(...)`，并在 plan 里保留 `OptionalFilter(...)` / `OptionalBind(...)` / `OptionalNestedJoin(...)` 逻辑节点。OPTIONAL 内 dependent-join 仍明确 fallback。
- SELECT DISTINCT / REDUCED 已进入 embedded path：安全 required BGP 的单 pattern 和 connected BGP `DISTINCT` 投影会下推到 `RdfQuadIndex.joinPatterns(...)` 的 SQL `SELECT DISTINCT`，并可和多变量/混合方向 `ORDER BY` / `LIMIT` / `OFFSET` 同步下推；其他 shape 仍在本地查询层 projection 后按 RDF term binding 去重。`REDUCED` 按标准允许不消重的语义走普通 SELECT，不为它强制 fallback。
- `VALUES` 已进入 embedded path：单变量 `VALUES ?var { ... }` 在 `?var` 同时出现在 required BGP 中且所有行都有绑定时会编译成 `$in` filter 并交给 `RdfQuadIndex.scan(...)` 下推，适合按一组资源 IRI 批量查；多变量 tuple `VALUES (?a ?b) { ... }` 会编译成 correlated binding source，保留行相关性，避免拆成多个独立 `IN` 后产生错误组合。`UNDEF` 行会保留为本地 binding source 的未绑定列，不错误下推成 index tuple constraint，从而保留 SPARQL multiset 语义。当 tuple 变量能一一映射到同一个 required quad pattern 的 term slot 且所有行都有绑定时，planner 会把它下推成临时候选表并用 SQL `JOIN rdf_tuple_values_*` 回连 `rdf_quads`；跨多个 pattern、含 `UNDEF`、或已不满足单 pattern 映射的 tuple 继续走本地 binding join。OPTIONAL 内 VALUES 已作为 optional-local binding source 支持，执行时保留 left join 语义，不会把不匹配的 VALUES 行提升成 required filter；不约束 required pattern 的顶层独立 binding 仍 fallback。
- 标准 `BIND` 和非聚合 `SELECT (expr AS ?alias)` 的安全子集已进入 embedded path：支持把已绑定变量、IRI/literal 常量、`STR(?var)`、`STRLEN(STR(?var))`、`CONCAT(...)`、`LCASE(...)` / `UCASE(...)`、`SUBSTR(...)` / XPath `substring(...)`、`IRI/URI(...)` 派生成新的 binding，后续 `FILTER`、`SELECT`、`ORDER`、受控 UNION branch 和 query-backed update materialization 都能读取；`SELECT` 表达式投影复用同一套 bind evaluator，并拒绝 alias 覆盖 WHERE/BIND 已有变量。`SUBSTR` 的起点/长度复用同一套安全 bind 表达式，并在执行时求成有限数字；无法求值为有限数字时不产生该 binding。未绑定依赖、重绑定、复杂表达式和非白名单函数仍明确 fallback，避免部分执行后产生错 binding。
- 受控 `UNION` 已进入 embedded path：adapter 会把每个 branch 编译成独立本地子 join，`RdfLocalQueryEngine` 再把 UNION 结果与外层 required bindings 合并，并在全量结果层执行 ORDER/LIMIT，避免提前下推分页导致错结果。当前支持 branch 内 BGP、局部 FILTER、branch-local BIND、branch-local tuple / single-variable `VALUES`，以及已支持的 OPTIONAL 子集；nested UNION 已支持，OPTIONAL 内 UNION 也已支持。顶层 `VALUES` 必须约束 required pattern 或所有 branch 都绑定的变量；空 required branch 和不约束 branch required pattern 的 VALUES 仍明确 fallback。
- 受控 dependent-join 已进入 embedded path：`MINUS { ... }` 和 `FILTER NOT EXISTS { ... }` 会被 adapter 编译成本地 anti-join group，`FILTER EXISTS { ... }` 会被编译成本地 semi-join group。`RdfLocalQueryEngine` 在外层 required/UNION bindings 之后执行顶层 dependent groups，并在 OPTIONAL 分支内执行 optional-local dependent groups；optional-local group 只筛掉当前 optional 匹配分支，如果分支被筛空，仍保留 left join 的外层 row。当前支持右侧 required BGP、可编译的局部 FILTER/VALUES/OPTIONAL，以及每个 branch 都可编译为 embedded BGP/OPTIONAL/FILTER/VALUES 的 dependent group 内受控 `UNION`；右侧必须至少和外层 required shape 或所在 OPTIONAL 分支已绑定变量共享一个变量。不相关 dependent-join 和 nested dependent-join 继续明确 fallback。
- 受控 property path 已进入 embedded query path：adapter 在 `WHERE` 边界把标准 SPARQL 1.1 AST 中的简单 inverse path（`^<p>`）和固定长度 sequence path（`<p>/<q>`、`^<p>/<q>` 等）展开成普通 BGP join；简单固定谓词 alternative（`<p1>|<p2>`，含整体反向 `^(<p1>|<p2>)`，以及 sequence 中的 `(<p1>|<p2>)/<p3>` 单段 alternative）会编译成 predicate `$in`，走同一套 term-id index scan。递归/可选/不等长分支/negated path（`*`、`+`、`?`、`(<p1>/<p2>|<p3>)`、`!`）继续 fallback。展开产生的内部 join 变量只用于本地执行，不进入 models、Pod 数据或对外 binding metadata。`CONSTRUCT` / UPDATE template 仍只接受普通 triple，不把 path 当成可写目标。
- `GROUP BY ?var + COUNT(...)` 已进入 embedded path：支持按 required BGP 变量分组、多个 `COUNT` / `COUNT DISTINCT` 聚合投影，并保留排序、投影、分页在 grouped rows 上执行；`HAVING` 的安全子集支持对聚合别名、匹配的 `COUNT(...)` 表达式，以及未投影的 `COUNT(DISTINCT ?x)` hidden aggregate 做简单比较并在 aggregate 后过滤。安全的 `GROUP BY` 表达式/别名会先下放成 local `BIND` 再分组，支持的表达式范围与标准安全 `BIND` 子集一致；wildcard grouped SELECT 和不安全的 HAVING 仍 fallback，避免半支持返回错语义。
- guarded numeric aggregate 已进入 embedded path：`SUM(?x)`、`AVG(?x)`、`MIN(?x)`、`MAX(?x)` 支持 required query shape 中已绑定变量上的 RDF numeric literal，SPARQL adapter 要求同一变量存在 `FILTER(isNumeric(?x))` 后才编译，执行层用 decimal literal 返回结果；未守卫变量、`*`、复杂表达式和非 numeric aggregate 继续 fallback。安全的 required BGP numeric aggregate 会下推到 SQL self-join：`FILTER(isNumeric(?x))` 映射为 `rdf_terms.numeric_value IS NOT NULL` join，避免先 materialize 所有 binding 再在 TS 层聚合；非分组与 `GROUP BY` 形态都支持该下推，并可对 aggregate alias 做安全 HAVING/ORDER/LIMIT；`DISTINCT` numeric aggregate、非 required BGP shape 和复杂 HAVING 仍留在本地聚合或 fallback 边界。
- 基础 `CONSTRUCT { ... } WHERE { ... }` 已进入 embedded path：template 只支持普通 triple，WHERE 复用当前 BGP/FILTER/OPTIONAL/VALUES 等已覆盖查询子集，执行后把 bindings materialize 成去重 RDF quads；复杂 CONSTRUCT shape 和未覆盖 query shape 明确 fallback 到 compatibility engine。
- 受控 `DESCRIBE` 已进入 embedded query path：支持 `DESCRIBE <iri>`、`DESCRIBE ?var WHERE { ... }` 和标准 `DESCRIBE * WHERE { ... }`；目标资源必须是显式 IRI，或由 required embedded query shape 绑定出来的可见变量。`DESCRIBE *` 会展开为当前 WHERE 可见 required 变量，执行时只返回 basePath scope 内 named-node target 的 `target ?p ?o` 直接描述，并 materialize 为 default graph quads。未绑定变量、只在 OPTIONAL 中出现的 wildcard 变量，以及需要 CBD/跨 provider 扩展语义的形状继续 fallback。
- graph utility 读路径也已进入 embedded path：`constructGraph(graph)` 会在 basePath scope 内用 `GRAPH <graph>` 构造 default graph quad stream，scope 外 graph 返回空结果且不触发 fallback；`listGraphs(basePath)` 用本地 `SELECT DISTINCT ?g` 列出 Pod scope 内 named graphs。
- `INSERT DATA` / `DELETE DATA` 的 named graph delta 已进入 embedded path：`RdfSparqlAdapter.compileUpdateDelta(...)` 只接受 basePath scope 内的显式 `GRAPH <iri>`、named-node subject/predicate、named-node 或 literal object；默认 graph、graph 变量、blank node 和 base 外 graph 仍明确 fallback，避免半解析写错。
- `DELETE WHERE` 的 named graph BGP delta 已进入 embedded path：adapter 会把 basePath scope 内的显式 `GRAPH <iri> { ... }` 编译成本地查询和删除模板，engine 先用 `SolidRdfEngine.query(...)` 找到实际匹配 quads，再逐 quad 精确删除；default graph、graph 变量和 base 外 graph 仍 fallback。
- `DELETE/INSERT WHERE`、`INSERT WHERE` 和 `DELETE WHERE` 的安全子集已进入 embedded path：模板和 WHERE 都必须落在 basePath scope 内的显式 named graph，或通过 `WITH <graph>` 归一到同一个 basePath named graph；`USING <graph>` default graph 可把 WHERE default BGP 映射到 basePath scope 内的 named graph，多个 default `USING` 会编译成 graph `$in` 读取多个 basePath scope 内 graph，但不会作为写入模板 graph；basePath scope 内的 `USING NAMED <graph>` 可把 WHERE named dataset 映射到受控 graph 集合，`GRAPH ?g` 会保留 graph binding 并附加 `$in` 过滤，模板仍必须显式写入 basePath scope 内 graph。WHERE 至少包含 required graph BGP，且可使用受控 UNION / anti-join / semi-join 子集；adapter 用本地查询计算 bindings，再 materialize delete/insert quads。无 `WITH` / `USING` 的 default graph、base 外 graph、空 required BGP 和不安全模板仍 fallback。
- `SolidRdfSparqlEngine.queryVoid(...)` 已能把上述 update delta 应用到 embedded `SolidRdfEngine`：delete 逐 quad 精确删除，insert 批量写入 term-id index；`DELETE/INSERT WHERE` 会先查询 bindings，按 SPARQL update 语义先删后插；`INSERT WHERE` 会查询 bindings 后只 materialize insert quads，并记录 `UpdateDelta` plan、delete/insert 数量和 `update-delta` index choice。
- `MixDataAccessor.executeSparqlUpdate(...)` 已补上 embedded 文件权威路径：当目标是 `.ttl` / `.jsonld` by-line RDF 文档，并且 UPDATE 属于 `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` / 安全 `DELETE/INSERT WHERE` / 安全 `INSERT WHERE` / 安全 `WITH` scoped update / 单 default `USING` update 的单文档 named graph delta 时，先 patch 本地 RDF authority file，再重建结构化 RDF index；其中 query-backed update 的 local WHERE bindings 复用 embedded `SolidRdfEngine.query(...)` 计算，所以已覆盖安全的 `FILTER` / `VALUES` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join / semi-join / 固定长度 property path 子集。多个 default `USING` 或 `USING NAMED` 需要读取多个 graph/document，不进入单文档 authority patch。无法安全映射到单文档 named graph delta 的 shape 继续进入 compatibility accessor，并在回退后刷新本地 RDF mirror。
- `SolidRdfSparqlEngine` 已接到 `/-/sparql` 默认引擎：受支持的 SELECT/ASK/CONSTRUCT/constructGraph/listGraphs/简单 queryVoid 走 embedded `SolidRdfEngine` primary path；未覆盖能力继续有 fallback reason 和计数。
- `SERVICE` federation 已作为禁用能力从普通 fallback 中拆出：`RdfSparqlAdapter` 会抛 `DisabledSparqlFeatureError`，`SolidRdfSparqlEngine` 和 `MixDataAccessor` 不会把它转给 compatibility engine，防止 server-owned Pod 查询隐式触发 remote federation。
- `SolidRdfSparqlEngine.getMetrics()` 已记录 primary/fallback 次数、总次数、fallback rate、耗时、fallback reason、扫描行数、返回行数、plan 和 index choices；`assertFallbackBudget(...)` 可对全局或指定 operation 设定最大 fallback count/rate，作为 benchmark window / W3C subset 的 no-regression gate。
- `bun run test:w3c` 已补上可执行的第一版 W3C 目标子集入口，覆盖当前 embedded primary path 的 SELECT/ASK/CONSTRUCT/DESCRIBE、`FROM` / `FROM NAMED` dataset scope、VALUES/VALUES `UNDEF`/OPTIONAL 内 VALUES/UNION/MINUS/property path、GROUP BY/HAVING、scoped DATA update 和 query-backed update smoke cases，并把 no-fallback budget gate 作为测试断言。

阶段 2：LocalQueryEngine

- 扩大 SELECT/ASK 覆盖：补齐更多 FILTER、GRAPH、ORDER、多变量排序、aggregate、OPTIONAL、受控 UNION 和受控 dependent-join 边界。
- 让 `/-/sparql` 的 supported query shape 持续走 `SolidRdfEngine`，并用 metrics/benchmark gate 防止 fallback 反弹。
- Comunica 只处理未覆盖 query，并记录 fallback；后续要对 fallback 率设阈值。

阶段 3：Text / Vector

- literal text index 已先在 `RdfTermDictionary.normalized_text` 和 `RdfQuadIndex` 中覆盖 RDF literal/IRI lexical 搜索。
- 文件 chunk index 已先落为 `RdfTextIndex` 派生索引：source/chunk/search 与 `SolidRdfEngine.indexTextSource(...)` / `searchText(...)` wrapper 已具备，direct SolidFS workspace commit 可自动刷新 RDF/text 两类派生索引，内容权威仍是 SolidFS 文件。
- `RdfLocalQuery.textSearch[]` 已支持 text search 结果作为本地 binding source，再与 RDF BGP join；当前是受控内部 DSL，还未映射成公开 SPARQL 全文函数。
- embedding index 已先落为 `RdfVectorIndex` 派生索引：source/chunk/vector search 与 `SolidRdfEngine.indexVectorSource(...)` / `searchVector(...)` wrapper 已具备，`RdfLocalQuery.vectorSearch[]` 可作为本地 binding source 再与 RDF BGP join。
- query planner 已开始把 text/vector + RDF required sources 统一重排：RDF exact pattern 用 `RdfQuadIndex.estimateCardinality(...)` 缓存估算，复杂 pattern 用 `count(...)` 兜底；未被当前 binding 约束的 text/vector source 会先走 `estimateSearchCardinality(...)` 估算 source-local hit window，避免为了 join 顺序提前 materialize 搜索结果；已经被当前 binding 约束的 search source 仍用真实 hits 估算兼容行数。search source 的 `limit` / `offset` 和 `orderBy` 已明确为 source-local window/order，并在 plan 中显式标注。下一步是把这些 search cardinality estimate 接入更细的 ranking 代价模型，以及向量索引后端替换评估。
- bound `source` 关系已下推到 text/vector index exact source 条件：RDF BGP 先绑定少量文件资源后，搜索 source 不再扫描整个 workspace/prefix 命中集。
- exact distinct slot / tuple 统计已先落为 `RdfQuadIndex.countDistinct(...)` / `countDistinctTuple(...)`，并复用写入/删除失效的 cardinality cache；当前同时服务于安全的单 pattern `COUNT DISTINCT ?var` 下推，以及 planner 在 connected join 上的单 slot 和多 slot distinct fanout 估算。
- top cardinality 分布已进入 `RdfQuadIndex.cardinalityDistributions()` / `stats()`：按 graph、predicate、predicate/object、subject/predicate 暴露 quad count 和对应 distinct 计数，先作为 RDF-3X 风格 planner/benchmark 可观测统计；这些统计属于 local/cloud 共同 embedded engine 能力，QLever 后续只在 cloud-first 的 result table/cache/全文-RDF 一体化层面继续吸收。
- literal datatype distribution 已进入 `RdfQuadIndex.stats()`：按 literal datatype 统计字典中的 distinct literal term 数，以及这些 literal 作为 quad object 出现的次数，先作为 planner/benchmark 可观测统计暴露。
- text term document frequency 已进入 `RdfTextIndex.stats()` / `termDocumentFrequency(...)`：`rdf_text_terms` 物化 normalized token posting，按 term 统计出现过的 source 数、chunk 数和总 occurrences，作为 ranking/planner 可观测统计暴露；`RdfTextIndex.search(...)` / `estimateSearchCardinality(...)` 已使用 posting 表缩小候选，并通过 normalized phrase 复验保留 substring / phrase 语义；cardinality estimate 同时支持 workspace、source prefix 和 source-local window。
- vector model/dimensions distribution 已进入 `RdfVectorIndex.stats()` / `modelDistribution()`：按 embedding model 和 dimensions 统计 source 数、chunk 数、magnitude min/max/avg，作为 ranking/planner 可观测统计和后续向量后端替换评估输入；`rdf_vector_components` 已物化向量分量，`RdfVectorIndex.search(...)` 在 SQLite 层完成 dot/cosine/euclidean scoring、threshold 过滤、source-local order/window，返回结果时只解析命中的 embedding snapshot；`RdfVectorIndex.estimateSearchCardinality(...)` 已能按 dimensions、model、workspace、source prefix 和 source-local window 估算候选行数，带 threshold 的估算走 component scoring count，不再为了 planner 估算 materialize 全量命中。

阶段 4：Update delta

- `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` / 安全 `DELETE/INSERT WHERE` / 安全 `INSERT WHERE` 的 embedded index delta 和单文档 authority file patch 已完成第一步。
- 安全的 `FILTER` / `VALUES` / `BIND` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join / semi-join local WHERE 子集已在 embedded update delta 路径覆盖：先用本地查询层计算 bindings，再 materialize delete/insert quads，最后 patch 文件权威并刷新 RDF index。`BIND` 保持 expression-layer 语义，不当作 join source；template 可读取派生 binding。
- 下一步继续扩大复杂 update 覆盖，例如更多 FILTER 表达式、更多 named graph shape 的安全映射评估，以及多文档 delta 的明确事务边界；无法安全映射的 shape 必须保留明确 fallback/错误和指标。
- 复杂 update 逐步消灭全量重写。

阶段 5：去核心 Comunica

- server-owned Pod 默认不加载 Comunica。
- federation/plugin/client external workspace 才加载兼容层。

## 验收

必须有三组测试：

1. Correctness
   - W3C SPARQL query suite 的目标子集。
   - 业务模型查询：chat/task/thread/message/run/step。
   - graph scope、date bucket、relative id、IRI expansion。

2. Performance
   - 扫描行数对比现有 `ComunicaQuintEngine`。
   - TEXT quints vs term-id quads 的空间占用。
   - 常见查询 p50/p95。

3. Consistency
   - `.ttl` 修改后 index 刷新。
   - SPARQL UPDATE delta 后文件和 index 一致。
   - crash/retry 不产生重复 quad。
   - external client workspace 不被 server 当成本地权威。

## Open Questions

- 第一版是否保留全部六排列，还是按 graph-first + predicate/object hot path 裁剪。
- term dictionary 是否先用 SQL 表，还是直接做 mmap/on-disk vocabulary。
- literal FTS 先用 PostgreSQL/SQLite FTS，还是抽象成可替换 backend。
- SPARQL parser 继续使用 `sparqljs` 还是直接复用现有 `sparqlalgebrajs`。
- external provider 的 client-side query spec 是否单独成文档。
