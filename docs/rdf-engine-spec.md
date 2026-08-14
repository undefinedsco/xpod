# Xpod RDF Engine Spec

本 spec 定义 Xpod 自有 Pod 的 RDF 索引和查询引擎边界。它和 [SolidFS Spec](solidfs-spec.md) 分工如下：

- SolidFS 定义文件权威、workspace materialization、工具面对真实目录的语义。
- RDF Engine 定义标准 RDF 文档解析后的语义索引、查询计划、全文/向量检索和更新回写协议。

## 当前产品边界

- 公开仓库 `xpod-jobs` 同时包含 Local 和 Cloud。
- Local 的 SPARQL authority 是 SQLite-backed 静态 QLever runtime；它是一个固定可执行文件，不加载 `.so`，也不暴露 backend selector。
- 公开 Cloud 的 SPARQL authority 是 `RdfQuerySparqlEngine`：用 Comunica 执行 SPARQL algebra，并只通过 scoped RDFJS source 读取 `PostgresRdfEngine` 的 PostgreSQL/RDF-3X/PG FTS/VEC 公共 facts，不要求 QLever 或私有 PG extension。
- 私有 `xpod-rdf-components` 只提供 Cloud PostgreSQL QLever 加速和 PG-native 验收证据，不拥有公开 Cloud 产品形态。
- `native-builder` 只是构建控制面：按不可变 source commit 产出 artifact，不镜像、托管或拥有 Xpod 源码。

## 目标

- Xpod-owned Pod 的 Local 查询以 QLever authority 作为 SPARQL 语义边界；公开 Cloud 查询以 Comunica + scoped `PostgresRdfEngine` facts source 作为 SPARQL 语义边界。
- 保留 `/-/sparql` 这种组件边界，但内部不保留旧 server-side SPARQL 执行器。
- 以文件为内容权威，DB/RDF index 为全局语义索引。
- 直接以 RDF-3X target 作为公开 Cloud 主查询内核方向；当前 term-id quad index 只是过渡 baseline，不把它包装成 RDF-3X。
- Hexastore 只作为历史/对比参照；私有原生执行层只通过稳定 ABI 或部署专属组件接入，不作为公开 Cloud 并列运行时。
- 让全文、结构化 RDF 查询、未来向量检索在同一套资源身份和索引模型里协同。
- Progressive Semantic Index 的文件级 L0 摘要、reader tree L1..Ln、retrieval point 和 index method 生命周期见 [Progressive Semantic Index](progressive-semantic-index.md)。RDF Engine 只消费这些 retrieval point 与 search/vector/entity 派生索引，不把全量原文 chunk 或 embedding 当作 RDF 事实源。

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
SolidRdfEngine internal index
  current v0 baseline -> RDF-3X target
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
| `RdfQuadIndex` | 当前 v0：基于 term id 的 quad/quint 派生索引，用作 baseline/迁移桥；不是 RDF-3X 实现。 |
| `Rdf3xIndex` | 当前内部 RDF-3X 执行层：复用 `rdf_quads` facts 和六个 covering index，额外维护 projection / graph stats；不作为公开 backend selector。 |
| RDF-3X target implementation | 目标内部实现：压缩排列索引、projection stats、merge join 和 index-only scan；逐步替换 v0 baseline。 |
| `RdfQueryPlanner` | SPARQL algebra / app query 到物理计划。 |
| `RdfTextIndex` | literal、IRI label、文件 chunk 的全文索引。 |
| `RdfVectorIndex` | chunk / resource embedding 索引。 |
| trusted external executor | 显式路由的外部执行器；不是 server-owned Pod 的默认执行路径。 |

第一阶段只实现 embedded 形态：`SolidRdfEngine` 直接作为 Xpod 进程内 RDF engine 接入 Components.js。当前阶段不新增 sidecar/backend selector、不暴露 Components.js backend 注册面，也不区分 cloud/local 的查询引擎类型；cloud/local 只允许在同一行为契约下替换持久化实现。

实现约束：

- `SolidRdfEngine` 的对外消费面必须同时容纳同步与异步实现，调用方只依赖 `RdfEngineLike`。
- local SQLite 仍可保持同步内部实现；cloud PostgreSQL 版可以异步实现同一契约，不要求把 SQLite 内核伪装成异步。
- `QleverSparqlEngine`、`SolidRdfDataAccessor` 这类上层适配器只依赖行为契约，不直接依赖具体 SQLite 类。

同步/异步边界：

- facts 主路径必须同步可见。`put`、`replaceSource`、`deleteSource`、`delete`、`applyDelta` 返回成功后，同一个 `RdfEngineLike` 的 `scan` / `query` 必须能立即读到新的 facts。
- RDF-3X projection / graph stats 是异步派生层。写入只推进 facts `data_version` 并把派生层标记为 needs-refresh，不在请求路径自动重建 stats。
- `scan` / `query` 以 facts + covering index 为可用主路径，不能依赖 RDF-3X stats 已同步；当前 planner 可表达的 shape 可以直接走 PG facts SQL。
- `storageStats()` 只报告当前 facts 与 derived stats 的同步状态，不触发补建。`rdf3x.factsDataVersion`、`rdf3x.rdf3xFactsDataVersion` 和 `rdf3x.refreshLag` 必须直接来自 durable metadata；`rdf3x.syncedWithFacts=false` / `refreshLag>0` 是合法运行态。
- `refreshDerivedIndexes()` 是显式补建入口，供启动、维护任务、测试或运维调用。它可以从当前 facts 重建 `rdf3x_*` stats，但不是普通查询的隐式前置步骤。PostgreSQL backend 每次显式 refresh 都会同步执行 facts / RDF-3X stats 表的 planner stats refresh，并在返回值里暴露 `plannerStats.analyzedTables` 与耗时；即使派生 stats 已追上 facts、无需 rebuild，也不能跳过这个显式运维动作。
- SolidFS journal 只负责本地权威文件到 Pod HTTP / index syncer 的 outbox、replay 和 compaction；它不是 RDF-3X 派生索引新鲜度证明。即使 journal 已 replay 完，仍必须用 facts `data_version` 与 `rdf3x_metadata.facts_data_version` 判断派生索引是否 needs-refresh。
- SQLite/file-backed `SolidRdfEngine` 和 PostgreSQL `PostgresRdfEngine` 都不维护第二套内存 refresh guard；query readiness、refresh skip 和 storage stats 都直接读取 durable metadata。backend 差异只保留在同步/异步 executor 与 SQL 方言上。

当前决策口径：

- Xpod 的默认 RDF 引擎已经切到自有 `SolidRdfEngine` / `PostgresRdfEngine`。Local profile 的 SPARQL 入口指向 `QleverSparqlEngine -> RdfEngineLike`；公开 Cloud profile 的 SPARQL 入口指向 `RdfQuerySparqlEngine`，由 Comunica 在 scoped `PostgresRdfEngine` facts source 上执行。结构化 LDP 写入默认走 `MixDataAccessor -> SolidRdfDataAccessor -> RdfEngineLike`。
- RDF-3X target core 是 local 和 cloud 都必须具备的基础查询内核。
- 当前 `RdfQuadIndex` 不再继续扩写成“准 RDF-3X”；它只服务 facts baseline、benchmark 和结构化查询内部执行。
- `Rdf3xIndex` 是 first embedded slice：已覆盖 RDF-3X 数据布局、projection stats、permutation scan、基于 bound-slot fanout 的 connected BGP join order、term merge join、受控 index-only join，以及受控 single-pattern scan / count、object text contains/endsWith scan、同 pattern tuple VALUES scan、required BGP tuple VALUES join、OPTIONAL / UNION / dependent group 内部 BGP join、join count / basic numeric aggregate / grouped count / grouped numeric aggregate 执行能力；大多数 models 查询带 exact graph 或 graph prefix，因此这类 shape 在 scan/count/join 中优先以 `rdf_quads` facts source 收窄候选，而不是先扫三元组 permutation 再后置过滤 graph；六排列扫描复用 `rdf_quads_spog` / `rdf_quads_posg` 等 facts covering index，不再额外物化 `rdf3x_spo` / `rdf3x_pos` / `rdf3x_triple_membership` 这类事实副本；文件型 `SolidRdfEngine` 标准配置会自动把它接成 selective primary，仍保留 `RdfQuadIndex` 作为 facts baseline。
- `SolidRdfEngine` 已接入内部 `derivedIndexProfile`：`baseline` 只保留事实层 `RdfQuadIndex` baseline，`rdf3x` 会启用 `Rdf3xIndex` 并维护 projection / graph stats。文件型 `index: { path }` 标准配置默认进入 `rdf3x` profile 并启用 selective primary；`:memory:` 和外部传入的 `RdfQuadIndex` 实例不会隐式创建第二个连接，仍可用显式 `rdf3xIndex + rdf3xPrimary` 进入 primary。query 只有在 RDF-3X 当前可表达的 single-pattern scan/count、required BGP、join count 或 count-only grouped aggregate（可含无 `UNDEF` 且所有变量均由 required BGP 绑定的 tuple VALUES；pattern 只含 exact term、exact term `$in` / `$notIn`、graph prefix、object range、object text contains/endsWith，以及 term-type/language/datatype metadata filter）时，才把 scan / count / join / join count / grouped count 下推到 `Rdf3xIndex`。`SUM/AVG/MIN/MAX` 这类 guarded numeric aggregate 当前先保守走 `RdfQuadIndex` SQL aggregate path，避免历史 SQLite/file-backed RDF-3X numeric aggregate 退化重新进入默认 primary；`Rdf3xIndex` 的 numeric aggregate 能力保留给后续 cost gate。object range 会对 typed numeric literal 走 numeric 语义，对其他 term 走 lexical 语义；object text contains/endsWith 走 `rdf_terms.normalized_text` candidate scan 并用原始 value 复验大小写语义。当前 index-only 只用于 `DISTINCT` term projection、无 graph 变量/graph 约束、无 pagination count 的 join；这种 shape 的 named graph multiplicity 对最终 term 集合无影响，所以可直接利用 facts covering index 执行，其他 shape 仍回到 facts source。OPTIONAL / UNION / dependent join 仍由 query layer 保持控制流语义，但其内部无 group-local `VALUES` 的多 pattern BGP 可走 RDF-3X join。未覆盖 shape 留在同一 authority 的 facts baseline，不暴露 backend selector。这个边界同样为未来 PostgreSQL 实现保留空间：同一行为契约下，`RdfEngineLike` 的具体实现可以异步落到 PG，而不改变上层 SPARQL / DataAccessor API。
- `PostgresRdfEngine` 的边界不同：PG facts table 是 baseline authority，PG SQL / RDF-3X planner 只是 fast path。RDF-3X 不能覆盖的 scan/query shape 必须直接基于 PG facts 做后置过滤和执行，或对缺失的 text/vector source 明确报错；不能创建隐藏 SQLite cache，也不能把 unsupported shape 静默丢给另一个持久层。
- Local `QleverSparqlEngine` 没有隐式执行 fallback；公开 Cloud `RdfQuerySparqlEngine` 只使用 Comunica + scoped `PostgresRdfEngine` source，也不配置第二套执行器，因此 server-owned Pod 的 `/-/sparql` 不会把 unsupported shape 静默转给外部执行器。需要外部能力时，由上层产品显式路由到 trusted external executor。
- 私有 native acceleration 只能通过部署专属组件或 `xpod_rdf.native_sparql_*` ABI 接入，不能成为公开 backend selector，也不能改变 Pod 文件权威、权限语义或 `/-/sparql` 协议。
- public cloud / open-source cloud 默认使用 PG RDF-3X / `pg-hot-operators` fast path；部署专属组件不属于公共运行时配置。
- 不提供 “Hexastore / RDF-3X / native backend 三选一” 配置；用户和部署只面对一个 `SolidRdfEngine`。
- Pod RDF facts 只有一份权威数据；六排列是 facts 层 `rdf_quads` 的 covering index，RDF-3X 只额外维护 projection stats、graph stats、result table / cache / text-vector 辅助结构。这些派生数据可删除、可重建、可按 local/cloud 资源预算关闭或延迟构建。

部署矩阵：

| 部署 | 必备查询内核 | 持久化差异 | 可选原生能力 |
| --- | --- | --- | --- |
| local | `SolidRdfEngine` + RDF-3X target planner/index | SQLite / PGlite、本机可移动索引 | 无；保持零额外服务 |
| public cloud / open-source cloud | `PostgresRdfEngine` + RDF-3X target planner/index / PG fast path | PostgreSQL / shared storage、租约、索引生命周期、Pod 迁移 | 无 QLever；默认 PG fast path |
| private cloud acceleration | `PostgresRdfEngine` 等位组件或 ABI 扩展 | 同一 PostgreSQL facts / scope / 权限语义 | PG QLever native acceleration |

cloud/local 的基础差异只能体现在持久化、并发控制、租约、索引生命周期和部署形态上；查询语义和对外协议仍由同一个 `SolidRdfEngine` 行为契约约束。这里的 PostgreSQL 版不是 `PgQuintStore` 的复用，而是同一 `RdfEngineLike` 契约下的 RDF facts/index 实现。

## 数据权威

| 数据 | 权威源 | 索引/派生 |
| --- | --- | --- |
| line-addressable RDF 内容 | SolidFS 真实文件 | RDF quads、term dictionary、text/vector index |
| RDF/XML 等标准 RDF 文档内容 | SolidFS 真实文件 | RDF quads、term dictionary |
| 普通 by-line 文本 | SolidFS 真实文件 | text/vector index |
| 大二进制/特殊格式 | 对象存储或 hydrated working copy | metadata、按需提取的 text/chunk |
| RDF 查询状态 | RDF index | 不是内容源 |

DB 可以先接收 intent、队列、id 壳、索引刷新任务，但 durable 内容事实必须最终写入权威源。

派生索引的生命周期由事实层版本控制，而不是由调用路径猜测。`RdfQuadIndex`
写入、删除、回填或外部 shadow store 更新后必须推进 facts `data_version`；
`Rdf3xIndex` 在 `rdf3x_metadata` 记录自身已同步的 `facts_data_version`，
作为 primary 前要按版本刷新；已同步的同库索引在新 engine 实例启动后可以直接复用。
这样 CSS 兼容写路径、SPARQL update、direct engine put 和 SolidFS sync journal 都能共享
同一份事实层，而不会把 RDF-3X / integrated-planner 索引变成第二份内容事实。

索引补建不是 query-time adaptive indexing，也不需要做成在线动态加索引/热迁移系统。
Xpod 只支持代码定义好的 index profile：`baseline`、`rdf3x`、未来的 `text` /
`vector` / result-cache profile。profile 或 schema 版本变化时，可以直接丢弃本地
facts/derived 索引并从 SolidFS 权威文件或既有 facts 全量重建；不要求在旧索引上做
逐步补丁迁移。query planner 只能在当前 profile 已存在的索引和统计里选择执行路径和
join 顺序，不能因为某个查询临时在线新增一套物化结构。这样可以避免首个查询承担建
索引成本，也避免 cloud 多实例同时建索引导致锁竞争和不可预测的磁盘放大。

当前索引刷新/重建路径固定为以下几类，不做请求期动态创建索引：

- 旧 TEXT `QuintStore` 数据路径已删除；当前只从 SolidFS 权威 RDF 文件或既有 facts 重建 term-id facts。
- SolidFS 权威 RDF 文件刷新 facts：解析被写入或被工具修改的 `.ttl` / `.jsonld`
  / `.nq`，按 source 调用 `SolidRdfEngine.replaceSource(...)`，删除旧 source quads
  后写入新 quads。
- SolidFS sync journal replay/reconcile：journal 只记录待刷新的 source/path、hash
  和 stage；RDF engine 根据当前权威文件执行 `replaceSource(...)` 或删除 source，
  不从 journal 读取 RDF 正文。首次引入 journal 时，bootstrap 扫描已有 SolidFS
  文件生成 checkpoint/op，缺失或过期的 facts/derived 索引由后台 replay 补齐，
  不要求为了 journal 再重制一次业务数据。默认 Agent runtime 的 workspace
  prepare 阶段会触发 journal bootstrap/replay/compact，保证下一次带 context 的
  Run 能继续上一次中断的文件同步。
- RDF-3X 派生 stats 刷新：比较 `rdf_index_metadata.data_version` 和
  `rdf3x_metadata.facts_data_version`，不一致时由维护任务执行
  `SolidRdfEngine.refreshDerivedIndexes()`，内部再调用
  `Rdf3xIndex.rebuildFromCurrentQuads()`；查询路径不得为了某个请求动态补建或刷新
  RDF-3X 派生索引。当前 server-owned `SolidRdfDataAccessor.initialize()` 会在启动
  结构化 RDF 存储时调用该入口；运行期 facts 更新后，在维护任务刷新前，查询 planner
  只能临时回退到 facts baseline。
- profile/schema 不兼容升级：提升本地索引 schema version，整体重制本地 RDF index
  数据库；权威内容来自 SolidFS 文件或可回放的 Pod 数据，不通过动态索引迁移保证兼容。
  当前 facts 层在 `rdf_index_metadata.schema_version` 记录 schema version，RDF-3X
  派生层在 `rdf3x_metadata.schema_version` 记录 schema version；已有 version 与代码
  不一致时直接丢弃对应本地索引状态并重建表；facts 层 schema 不兼容时也会清掉同库
  `rdf3x_*` 派生对象，避免旧 facts 对应的 stats 在新 facts 表旁边残留。首次引入该
  metadata 时，缺失 version 只采用当前 version，避免把同 schema 的现有库误判为不可兼容。

## 空间预算

RDF engine 不能按“每吸收一个算法就永久多存一整套数据”的方式演进。需要区分：

- facts space：`rdf_terms`、`rdf_quads`、`rdf_sources` 等事实层索引，是 RDF 查询的唯一事实快照。
- derived space：RDF-3X projection stats、graph stats、未来 result table / cache / text-vector 辅助结构，都是可删除可重建的派生数据；六排列不再作为 `rdf3x_*` 事实副本重复存储，而是复用 `rdf_quads_*` covering index。
- authority space：SolidFS 中的 `.ttl` / `.jsonld` / by-line 文件，才是内容权威，不由 RDF engine 预算口径重复计为 RDF index facts。

`SolidRdfEngine.storageStats()` 必须暴露 `factsBytes`、`derivedBytes`、`totalBytes`
和 `totalToFactsRatio`；启用 RDF-3X 时还要在 `rdf3x` 里暴露 facts data version、
RDF-3X facts data version、refresh lag 和 synced boolean。benchmark report 也要带这份
storage profile 数据。
空间放大只能作为显式 profile 决策或 benchmark gate 的结果进入默认配置，不能因为
实现了 RDF-3X / integrated-planner 能力就默认叠满所有物化结构。
cloud `PostgresRdfEngine` 也遵循同一口径：facts 表和 facts covering index 是同步查询主路径，
`rdf3x_*` projection / graph stats 只计入可重建 derived space。

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
  client 可自行使用 local mirror / provider SPARQL
  server 只接收 Run 状态、事件、摘要、结果和必要的 durable 数据
```

如果 client 侧使用外部 source router，必须按 storage provider 分发，而不是按 IdP 分发：

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

## Hexastore / RDF-3X / 可选原生执行层的分层关系

这些来源处于不同抽象层级，不是多套并列 engine。公开运行时只有一个 `RdfEngineLike`
行为契约：Hexastore 仅作历史索引参照，RDF-3X 提供 local/cloud 共同查询内核，可选原生
执行层只能通过 native ABI 等位替换内部执行路径。

| 来源 | 所在层级 | 和 `RdfEngineLike` 的关系 |
| --- | --- | --- |
| Hexastore | RDF 三元组多排列索引思路 | 只作为历史 `quints` 和 v0 索引的对比参照 |
| RDF-3X | RDF database engine | local/cloud 共同需要的排列索引、projection stats、merge join、join reorder、物理下推内核 |
| 可选原生执行层 | 内部 planner/executor | 复用同一 facts、权限和 native ABI，不成为公开 backend |

```text
SPARQL / models DSL / app query
  -> SolidRdfEngine
       -> RDF-3X planner / executor / facts indexes
       -> optional native SPARQL ABI
  -> trusted external executor 只由上层产品显式路由
```

### Hexastore

Hexastore 在本 spec 里只作为对比参照：它的核心是 RDF 三元组六排列索引思想，
不是 Xpod 要原样采用的最终存储格式。

```text
SPO
SOP
PSO
POS
OSP
OPS
```

旧 `quints(graph TEXT, subject TEXT, predicate TEXT, object TEXT)` 只能说是
Hexastore-like 的 TEXT 多索引旧实现把 graph/source 和字符串存储混在同一层，字符串在表和多个索引中重复，空间放大明显。它不是 RDF-3X 的过渡格式，也不应该继续作为战略主存储强化。

### RDF-3X

RDF-3X 是 local / cloud 都需要的共同内核方向，不是只给 local 的单机实现。
如果 spec 使用 RDF-3X 这个名字，目标应尽量复刻它的核心结构，而不是把 Hexastore
或 SQLite composite indexes 换个名字：

- dictionary encoding。
- RDF 三元组 6 个排列索引；named graph / source 是 Xpod extension，必须单独建模。
- count-aggregated 二元/一元 projection indexes，用于统计和快速估算。
- compressed index pages / index-only processing；查询热路径不依赖一张巨大 triples/quads heap table。
- merge join 优先的 physical operators。
- 基于统计 synopsis / selectivity 的 join order optimizer。
- 尽量把 FILTER、ORDER、LIMIT、COUNT 下推到存储层。

部署形态上，local 可以先把这些能力落在 SQLite / PGlite；cloud 则落在 PostgreSQL
或 shared storage 上。两者共享 `SolidRdfEngine` 行为契约，只替换底层持久化和
锁/租约实现。

因此实现优先级不是让 local/cloud 使用不同品牌的查询内核。RDF-3X target 的字典、
压缩排列索引、projection stats、merge join 和 join/order/count 下推是两端都需要的
基础查询内核。cloud/local 只在持久化、并发控制、索引重建和 Pod 迁移上分化；
planner 能力和对外语义必须一致。

当前 `RdfQuadIndex` 的定位必须保持清楚：

- 它是 v0 embedded index，用 SQLite/PG 可表达的 term-id quad 表和 composite index
  快速承接现有查询，不是 RDF-3X。
- 它可以作为 benchmark baseline，但不能把自身表结构定义成 RDF-3X 目标。
- 真正进入 RDF-3X 阶段时，必须把 RDF-3X planner、统计和执行边界独立出来；facts 可以继续复用 `rdf_quads` 和它的 covering index，但不能继续把 `RdfQuadIndex` 自身包装成 RDF-3X。

当前 first slice 是 `Rdf3xIndex`：复用现有 `rdf_quads` facts / covering index，并维护 RDF-3X stats，
文件型 `SolidRdfEngine` 标准配置会自动进入 selective primary；未覆盖 shape 必须明确失败或留在同一 authority 的 baseline，不接公开 backend selector。

### 可选原生执行层

公开代码只定义 vendor-neutral native SPARQL ABI。任何部署专属 planner/executor 都必须：

- 读取同一份 PostgreSQL RDF facts，不创建第二套业务事实源；
- 接受同一 snapshot、graph/source scope 与 ACL/ACR access scope；
- 通过 `SolidRdfEngine` 内部等位替换接入，不新增公开 backend selector；
- 保持 SolidFS 文件权威、journal/delta 写路径和 `/-/sparql` 对外协议不变；
- 在能力不可用时 fail closed，不能静默切换到语义不同的持久层。

local 保持零额外服务、可移动、可重建的静态 QLever runtime；公开 cloud 保持不依赖 QLever 的
PostgreSQL/RDF-3X/PG fast path。部署层可提供与 ABI 兼容的私有 PG native extension 或等位
组件作为商业化加速，但公共仓库不依赖其构建、发布或运行时资产。

### Cloud Product-grade RDF acceleration 路线

cloud 的当前路线是把产品级 RDF 查询体验落在 Xpod 自己的 `PostgresRdfEngine` 内：
事实源仍是 SolidFS 权威文件和 PostgreSQL facts 表，RDF-3X
stats、query result cache、planner stats 都是可删除、可重建的 derived space。

公开代码只保留三个 PostgreSQL profile；cloud 默认使用 `pg-hot-operators`：

| Profile | 含义 | 默认用途 |
| --- | --- | --- |
| `baseline` | 使用事实表、普通 B-tree 六排列和共享 RDF 统计 | local / 测试 / 回退 |
| `pg-result-cache` | 在 baseline 上启用按 facts version 失效的查询结果缓存 | 重复列表页、上下文查询 |
| `pg-hot-operators` | 在 baseline + result cache 上启用已验证的 PG SQL fast path | cloud 默认 |

CRv2、shadow custom indexes 和公开 `pg-custom-index` 发布路径已从产品路径删除。
商业化 PG native extension 保留在私有仓库；它只通过显式部署组件或 capability-gated
SQL/native ABI 扩展 `PostgresRdfEngine` 的内部 operator，不构成公开 Cloud 的启动前提、
整查询引擎或用户可见执行车道。

```text
SolidFS / journal
  -> PostgreSQL facts
       rdf_terms
       rdf_quads
       rdf_quads_* ordinary B-tree permutations
       shared RDF statistics
       rdf_query_result_cache
  -> PostgresRdfEngine planner/executor
       PG SQL / RDF-3X fast path
       private native extension operators when capability-gated
```

实施顺序保持 benchmark-first：

1. 先用 PG facts / covering indexes / RDF-3X stats 实现 planner 与 executor fast path，
   验证 query shape、storage profile 和 p95 收益。
2. 再用表级 result cache 和 materialized result 思路覆盖重复 query、列表页、Agent context
   等高频路径，所有缓存都绑定 facts `data_version` 和 auth/cache scope。
3. 最后再评估 text/vector candidate generation、score fusion、template cache 等更高层的
   product-grade 查询能力；这些能力仍然挂在 `SolidRdfEngine` 内部，不改变 Pod 文件权威。

如果某个部署需要更强的查询执行器，正确做法是实现同一个 `RdfEngineLike` / Components.js
等位组件，并在部署配置里替换公开 Cloud 的 engine 实例。公开仓库不为部署定制能力
预留单独 profile 名、环境变量或用户可见开关；公共抽象必须保持完整可用。
如果增强能力对现有 SQL 是透明的，例如部署侧 PostgreSQL 自己能通过普通 index / planner
能力命中，Xpod 不需要新增组件或配置；只有需要 Xpod 主动调用定制函数、改变执行计划或报告
不同 engine 行为时，才放到部署侧等位组件里。

#### 与 RDF-3X baseline 的成本 / 收益估算

RDF-3X baseline 是 local 和 cloud 的共同必备内核。当前 PG 实现不是额外复制一套六排列
facts，而是复用 facts 层 covering indexes，并维护 projection / graph stats 作为 derived
space。所有收益都必须通过 models benchmark 和真实 Pod storage profile 验证后才能进入默认
配置。

| 方案 | 预期收益 | 主要成本 | 默认策略 |
| --- | --- | --- | --- |
| PG RDF-3X baseline | 覆盖 exact graph / graph prefix、single-pattern scan、BGP join、count / aggregate 等主路径；部署简单 | 仍受 PG btree / SQL executor / JS query layer 开销影响 | cloud/local 默认基础 |
| PG result cache | 对重复 models 查询、常用列表页、统计页、Agent context 查询降低延迟 | cache invalidation、权限 scope、storage TTL 和 derived space 配额必须严格控制 | 按 profile 启用，绑定 `data_version` |
| PG SQL hot operators | 让 scan / graph prefix / term-in / required BGP join / count / numeric aggregate 在已验证 fast path 上运行，并通过 metrics 标记 | 仍是 SQL executor 路径，收益依赖 query shape 和 PG stats | cloud 默认 |
| Text / vector candidate fusion | 搜索和 Agent context 更好用，可先筛候选再结构化 join | 需要 chunk、embedding、score、rerank 和权限 scope 统一 | 后续 benchmark gate |

粗略判断：

- 对小 Pod、简单 exact graph 查询，PG RDF-3X baseline 已经足够，额外 profile 收益有限。
- 对复杂 BGP、count / aggregate、分页列表和 repeated models 查询，`pg-hot-operators` 与
  result cache 能提供更稳定的 p95。
- 对 text/RDF/vector 混合检索，RDF-3X baseline 本身不是完整答案，后续收益主要来自
  candidate generation、scoring、cache、materialized result 和结构化 join 的一体化。
- storage profile 必须通过 `storageStats()` 报告 facts bytes、derived bytes、cache bytes
  和 total-to-facts ratio；derived space 必须可删除、可重建。
- 2026-06-09 真实 PG17 `baseline` / `pg-hot-operators` / `pg-custom-index` rerun
  覆盖 19664 quads、2 个 scan case、11 个 query case 和 `--concurrency=4`
  consistency gate。`pg-custom-index` 能加载真实 `xpod_rdf` extension 并命中 13 个
  native operator marker，但只有 exact-graph star、exact-graph ordered page、grouped
  numeric aggregate 等形状明显收益；graph-prefix scan/star、VALUES、count distinct、
  grouped count 和并发 graph-prefix case 仍慢于 RDF-3X / btree baseline，所以 native
  capability presence 不能作为默认 cutover 依据。

#### Product-facing RDF 查询能力缺口

Product-grade 不等于把完整数据库运维能力都产品化。Xpod 对外卖的是一体化服务，用户真正
感知的是两件事：能不能完成更多业务，以及速度体验是否稳定。metrics、部署、观测和 benchmark
是内部验收手段，不是独立产品目标。

| 优先级 | 用户可感知能力 | 需要补的内容 |
| --- | --- | --- |
| P0 | 能表达更多业务查询 | models DSL / repository query 归一化成稳定 query AST；支持 relation traversal、filter、sort、pagination、count / aggregate、OPTIONAL / UNION 的常见业务 shape |
| P0 | 复杂查询速度稳定 | PG SQL fast path、result cache、materialized result、query template cache；避免大范围 join、排序和聚合每次重新全量计算 |
| P0 | 搜索 / Agent context 更好用 | RDF literal text、文件 text chunk、embedding chunk、candidate generation、score fusion、rerank，再和结构化条件 join |
| P0 | 写入后可继续用 | SolidFS journal、SPARQL update、direct engine write、replay/reconcile 后统一推进 facts version，并失效相关 derived data |
| P1 | 失败可理解、可转向 | unsupported query shape 返回明确能力边界和可行 fallback，不能退成 500 或静默走错误路径 |

内部支撑能力仍然必须存在，但只服务于上面的用户体验：cost model / stats、planner controls、
index lifecycle、auth-aware cache、query timeout、slow query backpressure、`EXPLAIN` / trace、
storage profile、benchmark / regression、rollout / rollback 都是工程验收与运维工具。

#### Product-grade P0 / P1 落地清单

这一段是后续逐项落地的执行 spec。它不表示要完整复刻某个外部引擎；所有能力都必须挂在
`SolidRdfEngine` 行为契约下，继续以 SolidFS 文件和 RDF facts 为权威，derived space
只做可删除、可重建的查询加速。

P0 先做用户能明显感知或能保护生产正确性的能力：

| 能力 | 当前状态 | 第一版落地要求 | 验收证据 |
| --- | --- | --- | --- |
| Query template cache | 第一版已落地：bounded in-memory template cache，按去值后的 query AST 记录 hit/miss/eviction；已补 idle TTL、内存 bytes 估算，并把 template bytes 纳入 `storageStats().derivedBytes`；materialized result cache 行会记录并校验 `template_key`，plan / explain 会暴露 `PostgresMaterializedResultTemplate(...)` 与 `cache.materialized.templateKey`，让物化入口绑定到同一 query template key；RDF-3X SQL 编译路径会把实际生成的 compiled SQL physical shape 记录到同一 template entry，plan 暴露 `PostgresCompiledSqlTemplateHit/Miss(...)`，`storageStats().queryTemplateCache` 暴露 compiled SQL shape 数量和 hit/miss/eviction 计数 | 当前不冻结跨参数 join order，只在相同 template key + 相同 SQL physical shape 下复用可观测入口，避免改变查询语义或 cost 决策 | `storageStats()` 暴露 template cache 统计；重复 models query 的 plan 标记 template hit；TTL 过期后同模板 query 重新 miss 且 evict 旧 entry；materialized result hit/store 能证明使用同一 template key；同模板不同参数的 RDF-3X 查询能命中 compiled SQL template marker |
| Materialized result table | 第一版已落地到 PG：`RdfQuery.cache.materialized` 显式 opt-in，独立 `rdf_materialized_result_cache` 表绑定 materialized key、query shape、facts version、结构化 access scope、TTL 和 max entries；命中时不再执行 RDF join，也不会重复写普通 result cache；PG models benchmark 已补 latest-message、thread-context、run-steps、due-schedule、provider/model/credential、settings keyset、active session hydration、AI embedding config 和 vector indexed-file/store 9 个 warm-path materialized case；ChatKit thread history 产品读路径已从手写 SPARQL 收回到 models/drizzle-solid，并在产品 query/materialized selector 边界对 `Message.thread` / `sioc:has_container` 形状自动挂 `chatkit/thread-history/<thread>/<query>` materialized key，覆盖 ChatKit items 和 Managed Run conversation assembly；业务统计页这类 aggregate/groupBy/having 查询会按 message/thread、run priority、provider credential 等稳定形状自动挂 `models/stats/<view>/<query>` materialized key；settings/provider/model/credential 这类 models/drizzle-solid 查询会按 Provider/Model/Credential 类型列表或 provider-model-credential 关系 join 自动挂 `models/settings/<view>/<query>` materialized key；非 thread-history 的 active session + chat/thread Agent context hydration 查询会自动挂 `models/agent-context/<view>/<query>` materialized key；RDF 运维统计页本身走 `storageStats()`，不进入 query result materialized cache；`storageStats()` 已暴露 result/materialized process-local hit/miss/refresh/store/bypass/disabled 计数，慢查询快照会记录 result/materialized cache status、key、templateKey、factsDataVersion、TTL、quota 和 store outcome，stats API 与 dashboard RDF 页已支持按 principal/basePath/permissionVersion 搜索 access scope，并展示 result/materialized scope count、payload、entries、scope pressure 和 hit rate | 后续继续按真实负载补更细的产品视图 drill-down | cache scope 不串用户；facts version bump 后旧 materialized result 不可复用；显式 scope invalidation 会清 materialized cache；max entries 可淘汰；ChatKit thread-history、business stats、settings product-view 和 Agent context hydration query 会生成稳定 materialized key，且 selector 可关闭；dashboard 可按 auth/cache scope 定位 materialized payload、entries 与 hit rate；慢查询可直接定位导致 miss/store 的 materialized key 和 facts version |
| Text / RDF / vector 融合查询 | 第一版本地和 PG gate 已落地：`RdfQuery.textSearch[]`、`vectorSearch[]` 和 required RDF BGP sources 进入同一个 planner；`caseProfile=fusion` seed 会写入文本 chunk / embedding chunk，并用 Agent context 查询验证 text/vector 候选与 message/thread/workspace RDF facts 交集；本地 query layer 已支持 numeric BIND 加权 `fusionScore` 并按数值排序 rerank；`applyRdfAccessScope` 会把 `allowedGraphUrls` / `deniedGraphUrls` / `deniedGraphPrefixes` 投影成 search source allow/deny 条件，纯 text/vector 查询和融合预筛都不会先召回不可读 source；PG engine 可配置同一套 `RdfTextIndexLike` / `RdfVectorIndexLike`，第一版在 RDF-3X 不覆盖 search source 时走 `PostgresFactsScan + TextSearch + VectorSearch + PostgresFactsBind + PostgresFactsSort`；`PostgresRdfTextIndex` 已把 text source / chunk / term posting 持久化到 PG/PGlite，复用 SQLite `RdfTextIndex` 的 chunk、normalize、term、score 和排序逻辑，并可被 `PostgresRdfEngine` 作为 async text index 使用；`PostgresRdfVectorIndex` 已把 vector source / chunk / component posting 持久化到 PG/PGlite，复用 SQLite `RdfVectorIndex` 的 embedding normalize、metric score、filter、排序和 path 解析逻辑，并可被 `PostgresRdfEngine` 作为 async vector index 使用；cloud 默认配置已生成并挂载 `PostgresRdfTextIndex` / `PostgresRdfVectorIndex` 组件，二者与 `PostgresRdfEngine` 共享 `sparqlEndpoint` PG 连接；`MixDataAccessor` 已补 `textSearchIndexingEnabled` 写入开关，cloud 默认打开，RDF PUT、SPARQL 本地 authority patch、SolidFS 回写和删除都会通过 `SolidRdfDataAccessor -> RdfEngineLike.indexTextSource/deleteTextSource` 维护 line-addressable RDF authority 文本 source；`RdfSearchIndexingService` 已作为产品层 vector 文档索引入口落地，使用当前用户 Pod `AIConfig.embeddingModel` 和 AI credential 调 `EmbeddingService.embedBatch`，再写入同一个 `RdfEngineLike.indexVectorSource`，缺 RDF/vector engine、缺 AI config 或缺 embedding model 时返回可解释 skipped 状态；`RdfSearchIndexingSolidFsSyncer` 已接入 Pi driver 默认 SolidFS commit 路径，在 Pod workspace 写入 Markdown/text/line-addressable RDF 后复用当前 Run context 触发 vector source 更新，删除文件时清理 vector source，provider/indexing 异常默认不阻塞 authority commit；产品 Run 边界已接入 `RunContextRetriever` / `retrievedContext`，Chat、Task 和 durable Inngest worker 都会在恢复 Pod 状态后、启动 runtime 前检索当前上下文，API container 在 cloud + PG facts storage 下会默认创建共享 `PostgresRdfEngine`、`RdfRunContextRetriever` 和 `RdfSearchIndexingService`；默认产品 wiring 会先做 text/RDF 检索，并在用户 Pod `AIConfig.embeddingModel` 存在时用同一 Pod AI credential 调用 `EmbeddingService` 生成 query embedding，追加 vector search 和 `fusionScore` rerank；没有显式 embedding model 时保持 text-only，不把 chat default model 当 embedding model；产品 `RdfRunContextRetriever` 默认 fail-closed，缺 text/vector index 会把 engine 的可解释错误抛回 Run，只有显式 `failOpen` 的可选路径才静默跳过；Pi driver 会把检索片段投影成非命令型上下文消息；search index 上层依赖已收敛到 `RdfTextIndexLike` / `RdfVectorIndexLike`，`SolidRdfEngine`、`PostgresRdfEngine`、`RdfQueryExecutor` 和 SolidFS syncer 不再绑死 SQLite 实现；`RdfIndexSolidFsSyncer` 已支持在 direct workspace commit 时选配 `vectorIndex`，并要求显式 `vectorizeText`，避免默认同步路径偷偷绑定某个 embedding provider | 后续补外部 vector backend 替换 | `agent context text vector fusion query` 返回 2 个命中，local plan 同时出现 `TextSearch(...)`、`VectorSearch(...)`、RDF `IndexScan(...)`、`Bind(?fusionScore:=...)` 和 `Sort`；PG plan 出现 `PostgresFactsScan(...)`、`TextSearch(...)`、`VectorSearch(...)`、`PostgresFactsBind(...)` 和 `PostgresFactsSort(...)`；PG text index 覆盖 markdown chunk、source 替换、删除、workspace/source allow-deny filter、term stats 和 async `PostgresRdfEngine` textSearch join；PG vector index 覆盖 cosine/dot/euclidean metric、source 替换、删除、workspace/source allow-deny filter、component backfill、model stats、cardinality estimate 和 async `PostgresRdfEngine` vectorSearch join；MixDataAccessor 集成测试覆盖 cloud-style RDF authority text indexing 与删除清理 search source；RdfSearchIndexingService 测试覆盖 Pod AI credential 下的 vector source 写入、从 text 生成 chunk/sourceHash、空文本清理 stale vector chunks、缺 embedding model 不写和删除 source；SolidFS syncer test 覆盖 Markdown commit 写入 vector index、删除 source 清理 vector index、缺 vectorizer 时 fail fast；RdfSearchIndexingSolidFsSyncer 测试覆盖 SolidFS change 到产品层 vector indexing 的 Pod context/source/text 映射、显式 resource source、删除清理、缺 context 跳过和 indexing failure 不阻塞 commit；cloud config test 证明 `PostgresRdfEngine.options_textIndex/options_vectorIndex` 指向 PG search index 组件，`MixDataAccessor.textSearchIndexingEnabled` 默认打开；API container test 证明 cloud PG 会把同一个 `RdfRunContextRetriever` 接到 Chat、Task 和 durable Run worker，并创建同边界的 `RdfSearchIndexingService` 且传给 Pi runtime driver，local/sqlite 不误启用，Pod `AIConfig.embeddingModel` 存在时会调用 `EmbeddingService` 并生成 `vectorSearch`，没有 embedding model 时保持 text-only；access-scoped 纯 text/vector 查询只返回 allowed source；结果按 `fusionScore DESC` 排序；缺 text/vector index 必须显式报错；RdfRunContextRetriever service test 覆盖缺 text index 默认抛错和显式 failOpen；Chat/Task service test 证明 retriever 输出会进入 `RunExecutionInput.retrievedContext`，Pi projection test 证明上下文会进入 fresh pi session；接口整理通过 text/vector/syncer/query executor regression 与 `bun run build:ts` |
| Ordered-page / keyset join | 第一版 benchmark gate 已落地：消息流 `createdAt < cursor + ORDER BY createdAt DESC + LIMIT`、任务调度 `nextRunAt` keyset continuation、settings `settingKey` continuation 都会要求 range/order/limit 保持在 SQL self-join / RDF-3X join 内；`pg-custom-index` 的 `join.required_bgp.order_page.topn.native` 已接入可选 ABI gate，当前只支持单 ORDER BY 变量且该变量在 project 中的 required BGP；xpod planner 会让排序变量所在 pattern 优先选能形成 bound-prefix 的 permutation，例如 predicate 常量 + object 排序选 `POSG`；只有旧 `join.required_bgp.order_page.native` 时保留 `bgp_join(...)` 行流 + SQL `rdf_terms` wrapper；models extreme profile 已补 `extreme native exact graph ordered-page query`，用 `native-stress.ttl` exact graph 验收 native marker；2026-06-09 真实 PG17 baseline / hot / custom rerun 显示 exact-graph ordered-page wrapper p95 为 `18 ms` / `23 ms` / `14 ms`，公开 hot profile 不是 ordered-page cutover 依据；同日 `xpod-rdf-components` 十参数 `bgp_order_page` 已改为 native term-candidate loop 并正向暴露 `join.required_bgp.order_page.topn.native`；`two_pattern_bgp_value_order_page` benchmark 显示 facts/btree p95 `5.531ms`，`xpod_rdf_bgp_order_page_value_native` p95 `5.393ms`，旧 SPI wrapper p95 `7410.430ms`；旧八参数 `two_pattern_bgp_order_page` 只测 term-id ordered-page，不作为 value-order top-N 证据 | 后续补非 projected order variable、多排序变量和更低 block-hit 的 term-order candidate source；custom operator 继续按 shape/cost gate 使用，不切 cloud 默认 profile | benchmark 覆盖 ordered page correctness、稳定 cursor、任务调度 continuation、设置列表 continuation、p95 对比；mock extension gate 能命中 `PostgresRdfNativeCustomIndexBgpOrderPageTopN(...)` 并断言 top-N shape 传入 `POSG`；旧 capability 只命中 wrapper，native capability 全缺时必须回退 RDF-3X ordered join；公开 hot profile 慢于 RDF-3X 时不能切默认，custom 也必须按 shape/cost gate |
| Incremental derived stats | PG 第一版已落地：写入路径记录 durable dirty graph / pair / term projection key，`refreshDerivedIndexes()` 默认只重算 dirty projection row；PG facts 侧已补 `rdf_dirty_sources` source-level queue，带 source 的 put/replace/delete 会登记待维护 source，refresh 成功后 drain 并在 `sourceQueue` 结果里报告 pending/drained 数；source queue drain 已按 refresh 开始时的数据库 `changed_at` cutoff 删除，且 dirty source 写入和 cutoff 都用 `clock_timestamp()` 而不是事务级 `NOW()`，refresh 期间新写入或被更新到 cutoff 之后的 source 会保留到下一轮维护，避免并发写入被误清；`refreshDerivedIndexes({ maxDirtySources })` 支持按最旧 `changed_at, source` 有界 drain，`PostgresRdfEngine.maintainDerivedIndexes()` 可通过 `maintenanceSourceBatchSize` 控制每轮 source queue drain 数，cloud 默认每 60 秒最多 drain 256 个 source，手动 refresh 不传 batch 时仍保持一次 drain 完；`bun run benchmark:rdf-models:pg` report 已新增 `refreshBenchmark`，记录 refresh wall-clock duration、planner stats duration、rebuild mode、dirty graph/pair/term 数和 source queue pending/drained 数，CLI summary 也直接打印 refresh duration / rebuild mode / source queue；benchmark 可选 `refreshMutationSources` / CLI `--refreshMutationSources=N` 已能在 seed refresh 后写入 N 个 source，再记录 `postWriteRefreshBenchmark` 的 mutation source、dirty pending、incremental refresh duration、rebuild mode 和 source queue drain 摘要；`postWriteRefreshBenchmark.matched/failedReasons` 会校验 pending/drained source、synced、incremental rebuild 和 facts version，并参与 CLI 非零退出 gate；`storageStats().rdf3x.pendingSources` 与 dashboard RDF-3X/生命周期区已能显示当前待维护 source 数；`PostgresRdfEngine.maintainDerivedIndexes()` 已补同库 lease，cloud 配置通过 `options_maintenanceIntervalMs=60000` 启动后台维护循环；SQLite/file-backed `Rdf3xIndex` 第一版也已通过 `rdf_quads` trigger 记录 dirty graph / pair / term key，默认维护刷新走 incremental，`refreshDerivedIndexes({ mode: 'full' })` 保留全量 repair path；dirty 信息缺失时自动回退全量 rebuild | 后续用真实 large / high-write 数据继续校准 refresh 阈值和慢查询运维面板细节 | 写入高频 source 后 stats synced；增量 refresh 后与 full repair stats 一致；缺 dirty 信息不误报 synced；同一 source 连续写入只保留一条维护队列记录，refresh 后 pending source 被 drain；storageStats/dashboard 能在 refresh 前看到 pending source 数并在 refresh 后归零；cutoff 之后的新 dirty source 不会被本轮 refresh 误 drain；另一个 worker 持有未过期 lease 时维护 cycle 不抢跑；配置 source batch 后维护 cycle 每轮只 drain 指定数量，剩余 source 保留到后续 cycle，且不重复 rebuild 已同步的 RDF-3X stats；benchmark report 必须包含 refreshBenchmark duration、planner stats 和 sourceQueue 摘要；启用 refresh mutation benchmark 时必须包含 postWriteRefreshBenchmark 的 mutation source、pending/drained 和 incremental rebuild 摘要 |
| ACL/ACR-aware cache lifecycle | 第一版已落地到 PG result/materialized cache：`RdfQuery.cache.scope` 支持结构化访问 scope，包含 principal、base path、mode、authorization model、权限版本和 allow/deny graph 列表；`RdfAccessScope` 不再拼裸字符串；PG result cache identity 是 `query_shape cache_key + scope_hash + facts_data_version`，materialized cache identity 是 `materialized_key + scope_hash + facts_data_version`，cache table 同时记录 scope 元信息并提供 exact scope invalidation 入口；cache row 会持久化 `scope_allowed_graph_urls` / `scope_denied_graph_urls` / `scope_denied_graph_prefixes`；PG 维护可重建的 `rdf_access_control_overrides` resource override index，解析 WebACL `acl:accessTo` / `acl:default` 和 ACP `acp:accessControl` / `acp:apply` 的真实 target resource，并记录对应 access-control sourceVersion；`.acl` / `.acr` 写入会优先按 override target、graph scope 和已知 sourceVersion/permissionVersion 重叠删除 cache，没有显式 target 或版本未知时才回退 access-control resource path / 全版本保守推导；无 allow-list 的旧/宽 scope 仍按 basePath overlap 保守删除，有 graph scope 的行会按 allow/deny/prefix 与 affected base path 重叠删除；写入只推进 facts version，旧 facts version cache 不会命中，但不再由写入路径全表删除；result/materialized cache 已有 TTL、entry count 和 payload bytes quota，template cache 已有 idle TTL、entry count 和 bytes 估算；`derivedCacheMaxBytes` 第一版会按统一 LRU 预算淘汰 result/materialized/template 三类可重建 cache；`derivedCacheScopeMaxBytes` 会按 access scope + facts version 限制 result/materialized 共享 payload，淘汰时按 cache key + scope + facts version 删除精确 row；`storageStats().accessControlOverrides` 暴露 override index entry/bytes；`storageStats().derivedCache` 已暴露 `cachePressure`、`largestScopePressure`、top scope drill-down 和按 cause 聚合的 process-local eviction 计数；stats API 支持 cache scope 服务端过滤，dashboard RDF 页已展示 result/materialized scope count、最大 scope、payload bytes、scope 明细、scope 搜索和 eviction breakdown | 当前不把授权判断下沉到 RDF 层，只用 sourceVersion/permissionVersion 做可重建 cache 的清理收窄；版本缺失时保持正确性优先的宽失效 | Alice/Bob/anonymous 查询不串 cache；权限版本变化不命中旧 cache；显式 scope invalidation 后旧 cache 不再命中；ACL/ACR source 写入后相关 scope 被清理，无关 graph-scoped cache row 不被删除，显式 ACP/WebACL target 不会误删同容器 sibling graph cache，已知 sourceVersion 只清对应 permissionVersion 和未版本化 cache，下一次读取会按新 facts version 重新 miss/store；payload bytes、scope bytes 或统一 derived cache bytes 超限后会淘汰旧 row / template，并能从 `derivedCache.evictions` 看见淘汰原因；RDF stats 能按 principal/basePath/permissionVersion 定位 top cache scope |

P1 做 planner 稳定性、迁移效率和运维可解释性：

| 能力 | 当前状态 | 第一版落地要求 | 验收证据 |
| --- | --- | --- | --- |
| Cost model / histogram | 第一版 stats surface 已补齐：SQLite/file-backed 与 PG facts stats 都通过 `storageStats().facts` 暴露 literal datatype、graph、predicate、predicate/object、subject/predicate 热点分布；PG `refreshDerivedIndexes()` 仍会 `ANALYZE` facts 与 RDF-3X stats 表；PG `metrics.explain.planner` 已把命中当前 query exact graph/predicate/predicate-object/subject-predicate 的 histogram hint 接入 reason、estimate input 和 `histogramHints`，cache hit 路径不拉 histogram；slow-query ring 也会保存当次 `histogramHints`，dashboard 最近慢查询行显示 histogram hint 数量和摘要；PG grouped numeric aggregate 已补第一版 cost cutover，native numeric operator 未命中、所有 join source 估算都低于低基数阈值且没有 graph-prefix fanout 时才切到 facts path，并用 `PostgresNumericAggregateFactsCutover(...)` 和 `numeric-aggregate-cost-cutover` 标记；PGlite medium/extreme baseline gate 会让 graph-prefix grouped numeric aggregate 和 high-fanout exact graph grouped numeric aggregate 留在 RDF-3X aggregate，只让 provider credential 这类低基数配置聚合显式 facts cutover | 后续把 histogram 从可观测 reason 继续接入更多 native/RDF-3X/facts 的 cost-based cutover，并补 join fanout / skew benchmark | slow query plan 和 `storageStats().slowQueries.entries[].histogramHints` 能解释当前 query 用到了哪些 histogram 输入；dashboard 慢查询行能直接看到 histogram hint 数量；provider credential fail-count aggregate 命中 facts cutover；high-fanout exact graph grouped numeric benchmark 命中 `PostgresRdf3xGroupAggregate` 或 native `aggregate.bgp_numeric`；2026-06-09 PGlite medium/extreme baseline gate 19664 quads、11 个 query case plan matched，graph-prefix grouped numeric aggregate 命中 `PostgresRdf3xGroupAggregate`；benchmark 覆盖高偏斜数据 |
| Bulk load + delayed index build | 第一版已落地：PG custom-index profile 支持启动时延迟创建 native permutation indexes，导入完成后显式 `ensurePgCustomIndexes()` 再进入 native cutover；PG facts 写入已把 dirty projection queue 改成数组 staging / `UNNEST` bulk insert，term dictionary 和 `rdf_quads` 小批仍走数组 `UNNEST`，大批会先写入 transaction-local temp staging table 再一次性 upsert 到 facts，并对 batch 内重复 quad 去重，避免 bulk seed 按 quad 逐条维护 native/custom index 或生成超长 `VALUES` SQL；real `pg` client 支持 COPY FROM STDIN 时，大批 term / quad staging 会优先通过 `PgPoolExecutor.copyFromRows()` 写入 temp table，PGlite 或 fake pg pool 缺 capability 时保持原 staging/UNNEST fallback；engine `storageStats().bulkLoad.copyFromRows` 暴露 COPY attempt/success/fallback、行数和 staging table kind，PG benchmark report 记录 seed ingest duration 与 seed 后 bulkLoad snapshot；PG graph-prefix 条件已避免 real PG collation 依赖，不再用 `prefix + \uffff` 作为精确上界，而是用 `COLLATE "C"` 的 `value_head` 粗筛加 `starts_with(value, prefix)` 精确判断；PG models benchmark 支持 `concurrency` consistency gate，会用消息分页、任务调度 keyset、settings keyset、provider/model/credential ordered join 的串行结果作为基线，再并发复跑并校验 plan / row count / checksum / ordered checksum；benchmark report 必须带 `refresh.rdf3x.plannerStats.analyzedTables` 与 `refreshBenchmark.durationMs`，证明 seed 后执行了一次 `refreshDerivedIndexes()` / `ANALYZE` 且记录 refresh wall-clock 成本；2026-06-09 真实 PG17 medium/extreme baseline、公开 hot profile 与 custom profile 已用 `--concurrency=4` 通过一致性 gate；2026-06-09 disposable PG17 COPY rerun 显示 medium/default 10,448 quads seed 命中 10,446 COPY rows、medium/extreme 45,656 quads seed 命中 65,166 COPY rows，term/quad staging fallback=0，两个完整 benchmark 均退出 0 | large/default `pg-hot-operators` gate 已通过；后续持续用 higher-concurrency 和 extreme case 校准阈值 | benchmark 可选择延迟 custom-index build；延迟期间 native-only operator 不 active、不会 500；ensure 后 6 个 custom permutation index 创建并恢复 native operator；bulk seed 只发固定批次数量的 term/quad insert，1300 quad smoke 仍保持单条 quad bulk insert；超过 staging 阈值时会创建 `rdf_terms_bulk_stage_*` / `rdf_quads_bulk_stage_*` temp table、从 staging upsert 到 facts 并最终 drop；COPY-capable pg client 下 staging table 不再产生 `INSERT INTO rdf_*_bulk_stage_* FROM UNNEST`，缺 COPY capability 时仍走 staging/UNNEST；开启 `--concurrency=N` 时 report 会暴露 `concurrencyGate`，并发复跑不允许串结果或掉 plan；2026-06-09 PGlite medium/extreme baseline gate 在 UNNEST 写入路径下 19,664 quads、2 个 scan case、11 个 query case plan matched，`rdf3x.syncedWithFacts=true`；真实 PG17 `--concurrency=4` baseline/hot/custom rerun 同样 plan matched；large/default `pg-hot-operators` gate 已通过：seed `1,001,024` quads，COPY fallback `0`，`--concurrency=4` matched，warm p95 `2,310 ms`，storage ratio `1.81x` |
| Subject-star / star join operator | 第一版已落地为可观测 gate：local `RdfQuadIndex` 和 PG RDF-3X join 会识别 3+ pattern 共享同一 subject 的 star BGP，并在 plan 中标记 `SubjectStarJoin(...)` / `PostgresRdf3xSubjectStarJoin(...)`；默认 models benchmark 已覆盖 Agent thread context 和 run state center，extreme benchmark 覆盖 8-pattern message star；2026-06-09 真实 PG17 baseline / hot / custom rerun 证明 marker 稳定，8-pattern graph-prefix star p95 为 `175 ms` / `139 ms` / `248 ms`，exact-graph 8-pattern star p95 为 `66 ms` / `62 ms` / `34 ms`；`pg-custom-index` 已把可选 `join.subject_star` / `aggregate.subject_star_count` 接到同一 gate，分别标记 `PostgresRdfNativeCustomIndexSubjectStarJoin(...)` / `PostgresRdfNativeCustomIndexSubjectStarCount(...)`；缺专用能力时回退 RDF-3X，不再回退 generic native BGP / BGP count；grouped count 第一版保持 RDF-3X，grouped numeric aggregate 可复用现有 `bgp_numeric_aggregate(...)` ABI，在 subject-star shape 下额外标记 `PostgresRdfNativeCustomIndexSubjectStarNumericAggregate(...)`，让 planner/explain/benchmark 能区分 subject-star 聚合形状 | exact-graph subject-star 可以作为 native cutover 候选；graph-prefix subject-star 仍保持 RDF-3X / hot path，除非后续 cost model 证明收益；如果需要更强 early-stop，再增加新的 extension ABI | subject-star benchmark 命中专门 plan marker，专用 native capability 命中时使用专门 marker，缺 capability 时回退 RDF-3X；grouped count 不走 native，numeric subject-star 聚合仍走现有 native aggregate ABI 且语义与 RDF-3X baseline 一致；native extension p95 已证明 shape 差异明显，不能把 subject-star 能力整体默认切入 |
| Native operator cutover 策略 | 第一版 explain 已能区分 capability 缺失和 capability 已激活但未被选中的 native 候选：当 query 具备 `pg-custom-index` native 候选、最终却走 RDF-3X / facts 时，`metrics.explain.planner.rejectedNativeOperators` 会记录 capability 和 `shape-gate` / `cost-cutover-*` reason；slow-query ring 也会保存 `rejectedNativeOperators`，dashboard 最近慢查询行显示被拒绝 native operator 数量和摘要；native operator 仍按 shape/cost gate 启用，不能只看 capability 存在；2026-06-09 真实 PG17 baseline/hot/custom rerun 显示 custom 命中 13 个 native operator marker，但 graph-prefix scan/star、VALUES、count distinct、grouped count 和并发 graph-prefix case 都慢于 RDF-3X / btree baseline，只有 exact-graph star、exact-graph ordered-page、grouped numeric aggregate 明显收益；第一版 cost gate 已落地：保留 exact-graph subject-star join/count、exact-graph ordered-page wrapper、single-pattern exact scan/count/distinct 和无 VALUES 的 grouped numeric aggregate；graph-prefix scan/count/join、VALUES join、generic BGP native、BGP count/count distinct、grouped count 统一回退 RDF-3X / PG SQL，并通过 `native-operator-cost-cutover` 暴露拒绝原因；mock extension 回归已锁住 graph-prefix COUNT DISTINCT 和 grouped count，即使有 `aggregate.bgp_count` / `aggregate.bgp_group_count` capability 也继续走 `PostgresRdf3xJoinCount` / `PostgresRdf3xGroupCount` + `GraphPrefixMembershipFilter`，并分别记录 `cost-cutover-count-distinct-native-regression` / `cost-cutover-group-count-native-regression` | 后续继续把真实 PG benchmark 扩到 large / higher-concurrency，并在新的 native ABI 加入前先补 shape benchmark 和 fallback assertion | metrics 和 `storageStats().slowQueries.entries[].rejectedNativeOperators` 标记 rejected native reason；dashboard 慢查询行能直接看到 native rejection 数量；真实 PG benchmark 不因 native profile 退化；profile/capability active 不能单独作为默认 cutover 条件；graph-prefix/count/VALUES/grouped-count negative case 不能命中 native marker，exact-graph star/order/numeric positive case 仍能命中 native marker |
| Unsupported query boundary | 第一版已落地：server-owned Pod 默认不配置第二套执行器，Local `QleverSparqlEngine` 只调用当前 QLever authority，公开 Cloud `RdfQuerySparqlEngine` 只调用 Comunica + scoped `PostgresRdfEngine` source；authority 拒绝的 query/update shape 返回稳定错误码、hint 和 correction。`RdfSparqlBoundary` 只负责 server-owned graph / `SERVICE` scope validation、错误和 correction，不再承担 TS 查询编译。`SubgraphSparqlHttpHandler` 默认保持 text/plain 兼容，在 `Accept: application/json` 时返回结构化 `{ error }`；禁用的 federation/SERVICE 映射为 403。 | 后续接入具体 UI 按钮 / Agent 自动改写策略；HTTP/API 合约层不再要求客户端解析自然语言 hint | unsupported/disabled shape 返回明确 400/403；JSON 请求返回稳定 code、capability、hint 和 correction；HTTP handler 单测覆盖 unsupported 与 SERVICE federation 的结构化 correction；restrictive ACL/ACR scope 不调用第二套执行器；SERVICE federation 不进入 server-owned Pod 默认执行路径 |
| Explain / observability | 第一版已落地到 PG query metrics：`metrics.explain` 结构化输出 engine、facts version、derived profile、template/result/materialized cache 状态、结构化 access scope、acceleration/fallback 摘要、planner histogram hints、rejected native operators、runtime 扫描/返回行数、RDF-3X stale stats 和 slow-query 诊断；`storageStats().rdf3x` 暴露 facts / RDF-3X facts version、refresh lag 和 synced boolean；`storageStats().slowQueries` 暴露 bounded process-local 最近慢查询 ring，记录 query/cache key、selected path、reason、runtime、stale stats、planner histogram hints、rejected native operators、cache scope 摘要、result/materialized cache key 与 facts version、derived cache pressure / eviction 摘要和 acceleration 摘要，不写入 Pod/RDF durable 状态；`storageStats().lifecycle` 暴露 PG engine open count、driver、最近一次冷启动总耗时、ready 时间、失败摘要，以及 executor / text-index / vector-index / term-dictionary / schema / acceleration-probe / custom-index / maintenance-scheduler 分阶段耗时；`runRdfModelsPostgresBenchmark()` 已输出 `coldStartBenchmark`，把 startup/open、stats refresh 后首轮 query、同一 query 的 warm steady-state p50/p95 分开记录；`storageStats().queryResultCache` / `materializedResultCache` 已暴露 process-local hit/miss/refresh/store/bypass/disabled 计数；API 已暴露鉴权版 `GET /v1/rdf/stats` 和 dashboard 只读代理 `GET /api/admin/rdf/stats`，stats service 已进入 API container 并在 cloud PG 下复用同一个共享 `PostgresRdfEngine`，不会在 handler 中为每个 stats service 临时创建第二套 PG engine；`RdfBenchmarkReportCatalog` 会把 benchmark artifact 摘要并入 stats snapshot；cloud dashboard RDF 页已展示 refresh lag、cache/storage、PG acceleration、auth/cache scope drill-down、scope 搜索、eviction breakdown、cache hit rate、最近慢查询 cache target、histogram/native rejection 摘要、行级 cache pressure / scope pressure / eviction、RDF engine lifecycle / cold-start 指标，以及最近 benchmark report 的 plan/concurrency、COPY ingest、refresh、cold/warm p50/p95 和 storage ratio；原有 plan 字符串继续保留给 benchmark gate | 后续把 histogram / scan rows 真正接入 cost-based cutover，并继续补更细的冷启动阶段指标和启动期 slow path 关联 | 慢查询报告可直接定位 fallback / cache miss / materialized miss-store / stale stats / refresh lag / cache pressure / cache eviction / 扫描放大 / histogram 输入 / native operator cutover；dashboard 可直接读取最近慢查询快照、top cache scope、cache hit rate、engine ready 时间、cold-start 最慢阶段和 benchmark artifact 摘要；benchmark report 可区分 startup、refresh 后首轮和 warm steady-state |
| Cache quota / TTL / eviction | result/materialized cache 有 TTL、max entries、payload bytes quota、PG table/index bytes 和 payload bytes stats；template cache 已补 max entries、idle TTL、eviction count 和 in-memory bytes 估算，`storageStats().derivedBytes` 汇总三类 cache；`storageStats().derivedCache` 暴露三类 cache 的统一 bytes 占用、可选 `derivedCacheMaxBytes` 总预算、可选 `derivedCacheScopeMaxBytes` scope/facts-version 预算、最大 scope 占用、`cachePressure` / `largestScopePressure`，以及 `factsVersion`、`ttl`、`maxEntries`、`payloadBytes`、`scopeBytes`、`totalBytes`、`templateTtl`、`templateMaxEntries`、`templateBytes` eviction cause 计数；慢查询记录会附带 derived cache pressure / eviction 摘要，dashboard RDF 页已展示 payload/table/index bytes、scope pressure、eviction breakdown，并在最近慢查询行展示当次 cache pressure、最大 scope pressure 和 eviction count | 当前 eviction 计数是进程内压力观测，不作为 durable Pod/RDF 状态；后续按真实负载继续校准 quota 阈值和 eviction 策略 | cache 压测后不会无限增长；不同 scope 的淘汰互不污染；template TTL 过期后不会继续命中；result/materialized payload quota、scope quota 或统一 derived cache quota 超限后不会留下可命中的 cache row，并能通过 `storageStats().derivedCache.evictions`、dashboard 最近慢查询行和 `storageStats().slowQueries.entries[].derivedCache` 定位淘汰原因 |

落地顺序：

1. Query template cache：内存模板记录、metrics、stats、idle TTL 和 bytes 估算已完成，不改变查询语义；materialized result 入口已复用同一模板 key 并写入 cache row / explain；compiled SQL physical shape 也已挂到同一模板 entry，第一版只记录同形状 hit/miss，不跨不同 join order 强行复用。
2. Cache lifecycle：第一步已完成结构化 access scope 与 PG result cache exact
   invalidation；`.acl` / `.acr` 写路径已从全表清理收敛为 affected basePath + graph
   scope overlap 失效，会同时清普通 result cache 和 materialized result cache 的相关 scope。
   resource override index 已通过 WebACL/ACP target 解析接入；sourceVersion /
   permissionVersion 版本过滤已接入已知版本下的更细失效，版本未知时保守清理。后续把 template /
   materialized、TTL 和 quota 统一到同一套 derived cache 口径。result/materialized
   payload bytes quota 已完成第一版，template cache 已纳入 bytes 估算，PG 统一
   `derivedCacheMaxBytes` bytes guard 和 `derivedCacheScopeMaxBytes` scope/facts-version
   bytes guard 已完成第一版。
3. Materialized result：PG 第一版表和 lifecycle 已完成；ChatKit thread history 读路径已回到
   models/drizzle-solid，不再手写 SPARQL 绕开 RDF query 层；产品 query/materialized selector
   已对 thread-history 形状和 settings Provider/Model/Credential product-view 形状自动挂
   materialized key，并已覆盖业务 aggregate 统计 query 和 active session + chat/thread 这类
   非 thread-history Agent context hydration query。PG models benchmark 已把 settings keyset、
   active session hydration、AI embedding config 和 vector indexed-file/store 这类产品
   drill-down warm path 纳入 materialized hit gate。RDF 运维统计页走 `storageStats()`，
   不进入 query result materialized cache。
4. Ordered-page / keyset join 与 subject-star：消息流 keyset case 和 subject-star plan marker 已先作为 models benchmark gate；2026-06-09 真实 PG17 custom rerun 已给出 native p95 对比，第一版已把 positive/negative shape 固化进 cost gate，而不是按 capability 全量切换。
5. Text / RDF / vector fusion：Agent Runtime 已有产品接入点：`RunContextRetriever`
   在 Chat、Task 和 durable worker 中恢复当前 Pod 状态后执行，输出的
   `retrievedContext` 不进入队列 payload，只进入当次 `RunExecutionInput`。
   第一版 `RdfRunContextRetriever` 通过 `RdfEngineLike.query()` 生成 workspace-scoped
   `textSearch`，有 embedding 函数时追加同 source 的 `vectorSearch` 和
   `fusionScore` rerank；默认 fail-closed，缺 text/vector index 会沿 Run 启动路径显式报错，
   只有明确设置 `failOpen: true` 的可选检索场景才允许 best-effort 退化。`RdfTextIndexLike` /
   `RdfVectorIndexLike` 已把上层调用从具体 SQLite 类中解开，PG text/vector 持久化和 cloud
   默认组件注入已完成。API container 现在会在 cloud + PG facts storage 下创建共享
   `PostgresRdfEngine` / `RdfRunContextRetriever`，并注入 Chat、Task 和 durable
   Inngest worker；默认产品 wiring 会先启用 text/RDF 检索，并在用户 Pod 显式配置
   `AIConfig.embeddingModel` 时用同一 Pod AI credential 生成 query embedding 后追加 vector
   检索。CSS 写入链已通过 `MixDataAccessor.textSearchIndexingEnabled` 在 cloud 默认维护
   line-addressable RDF authority 文本 source；`RdfSearchIndexingService` 已补有用户
   credential 上下文的 vector 文档索引产品入口，并已通过 `RdfSearchIndexingSolidFsSyncer`
   接入 Pi driver 默认 SolidFS commit 路径。后续补外部 vector backend 替换。
6. Bulk load + delayed index build：PG custom-index 在 disposable benchmark / 迁移导入时的
   第一层 write amplification 已缓解；`pg-custom-index` 可以先以 PG SQL hot path 写入 facts，
   facts 写入内部使用数组 staging / `UNNEST` 批量 dirty queue upsert；大批 term dictionary 和 `rdf_quads` 写入会先进入 transaction-local temp staging table，再一次性 upsert 到 facts，seed 完成后显式
   `ensurePgCustomIndexes()` 创建 native permutation index，再执行 `refreshDerivedIndexes()` /
   benchmark。PG models benchmark 已补 `--concurrency=N` 一致性 gate，默认不启用，启用后用串行基线对并发复跑做 plan / checksum 验收。后续再补真实 PG COPY stream 和 large / real-PG high-concurrency gate。
7. Incremental stats：PG 与 SQLite/file-backed dirty projection refresh 第一版已完成；PG
   source-level dirty queue 第一版也已进入 `refreshDerivedIndexes()` 维护入口，能报告并
   drain pending source；`maintainDerivedIndexes()` 通过同库 lease 包住显式 refresh，
   cloud 配置每 60 秒调度一次；PG query explain 已能报告 runtime scan rows、RDF-3X
   stale facts version、slow-query 触发原因和 derived cache pressure / eviction 摘要；后续补更大数据量 benchmark 和慢查询运维面板细节。

参考：

- RDF-3X: https://www.vldb.org/pvldb/vol1/1453927.pdf
- Hexastore: https://www.vldb.org/pvldb/vol1/1453965.pdf
## 物理模型

当前 v0 / fallback baseline：

```sql
rdf_terms (
  id BIGINT PRIMARY KEY,
  kind TEXT NOT NULL,          -- iri | literal | blank | default_graph
  value TEXT NOT NULL,
  value_head TEXT NOT NULL,    -- fixed-size prefix for prefix candidates; raw value is not indexed
  datatype_id BIGINT,
  lang TEXT,
  hash TEXT,                   -- SHA-256 term identity digest for exact lookup
  normalized_text TEXT,
  numeric_value DOUBLE,
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

上面的 `rdf_quads` 形态是当前 v0 / fallback baseline，不是 RDF-3X target。
RDF-3X target 的查询热路径应是压缩排列索引和 projection stats；`rdf_quads`
最多作为导入、校验、调试或兼容桥。

Current v0 indexes:

```sql
CREATE UNIQUE INDEX rdf_terms_identity_hash ON rdf_terms(hash);
CREATE INDEX rdf_terms_kind_value_head ON rdf_terms(kind, value_head);
CREATE INDEX rdf_terms_kind_datatype ON rdf_terms(kind, datatype_id);
CREATE INDEX rdf_terms_kind_lang ON rdf_terms(kind, lang);
CREATE INDEX rdf_terms_kind_numeric_value ON rdf_terms(kind, numeric_value);

CREATE INDEX rdf_quads_spog ON rdf_quads(subject_id, predicate_id, object_id, graph_id);
CREATE INDEX rdf_quads_sopg ON rdf_quads(subject_id, object_id, predicate_id, graph_id);
CREATE INDEX rdf_quads_psog ON rdf_quads(predicate_id, subject_id, object_id, graph_id);
CREATE INDEX rdf_quads_posg ON rdf_quads(predicate_id, object_id, subject_id, graph_id);
CREATE INDEX rdf_quads_ospg ON rdf_quads(object_id, subject_id, predicate_id, graph_id);
CREATE INDEX rdf_quads_opsg ON rdf_quads(object_id, predicate_id, subject_id, graph_id);
CREATE INDEX rdf_quads_gspo ON rdf_quads(graph_id, subject_id, predicate_id, object_id);
CREATE INDEX rdf_quads_gpos ON rdf_quads(graph_id, predicate_id, object_id, subject_id);
CREATE INDEX rdf_quads_source ON rdf_quads(source_file_id);
```

`rdf_terms.value` 和 `rdf_terms.normalized_text` 是事实 payload，不进入 raw B-tree
key。长 literal exact lookup 走固定长度 `hash`，graph/source prefix 这类候选收窄先走
`value_head` 再用完整 `value` 复验。RDF-3X permutation scan 复用 facts 层
`rdf_quads_*` covering index，projection / graph stats 只存 `*_id`，因此长 object
不会进入 RDF-3X 派生表的主键。
全文辅助索引同样不能索引 unbounded 文本：`rdf_text_chunks.normalized_text` 只做 payload /
phrase scan 复验，posting term 超过固定长度时不写入 `rdf_text_terms`，查询回退到 phrase scan。

RDF-3X target indexes:

```text
permutation indexes:
  SPO
  SOP
  PSO
  POS
  OSP
  OPS

projection/stat indexes:
  SP -> count / O range
  SO -> count / P range
  PS -> count / O range
  PO -> count / S range
  OS -> count / P range
  OP -> count / S range
  S  -> count
  P  -> count
  O  -> count

Xpod extensions:
  graph/source -> source document membership and refresh scope
  workspace/basePath -> Pod scope and ACL boundary
```

是否给 named graph 做完整 quad permutations 不是 RDF-3X 原论文问题，属于 Xpod extension。
第一版 target 把 exact graph / graph prefix 当成业务主路径：先用 facts 层 graph
membership 缩小 source set，再在 source scope 内执行 term 条件、range、排序和分页；
没有 graph 约束时才优先走三元组 permutation scan。当前实现不再维护独立的
`rdf3x_triple_membership` 或 `rdf3x_*` 六排列事实副本；`rdf_quads` 的
`(graph, subject, predicate, object)` primary key 和 `rdf_quads_spog` /
`rdf_quads_posg` 等 covering index 直接承担这些 lookup。SQLite embedded 形态下，
RDF-3X 派生的 stat 表继续使用 `WITHOUT ROWID`，旧 rowid / materialized fact-copy
派生表可以丢弃并从 facts 重建。

### Term 编码

- IRI、literal、datatype、language 分离存储。
- 常见 datatype、predicate、namespace 可以预编码。
- 关键词检索不要扫 `rdf_quads`，只查 term/text index，再回 join quads。
- 对可从路径稳定推导的 graph/source，不重复存长字符串到每一行。

### Term dictionary rewrite for SolidFS move

`rdf_quads` 的 graph、subject、predicate、object 都存 term id，所以 SolidFS move projection
不需要默认重写所有 quad fact rows。只要移动影响的是 Xpod 生成或可证明安全的 URI projection
term，RDF engine 应优先通过 `rewriteTerms(...)` 更新 distinct term dictionary rows：

```text
oldPrefix = previousResource / previous graph URI prefix
newPrefix = moved resource / moved graph URI prefix
scope     = safe_projection
mode      = safe
```

实现要求：

- 只匹配 IRI/named-node term；literal、blank node、datatype/language identity 不参与路径 move rewrite。
- 重新计算 term identity 字段（例如 hash、value_head、normalized_text），不能只改 `value`。
- 如果新 identity 已被其他 term 占用，必须 skip 并记录 `collision_conflict`，不能把两个 term 合并成同一个 id。
- 成功 rewrite 后必须清理 term/cache/cardinality 等派生缓存，并推进 facts `data_version`，让 result cache、
  materialized view 和 RDF-3X stats 通过版本机制自然失效或重建。
- API 返回 `matchedTerms`、`rewrittenTerms`、`remappedTerms`、`skippedTerms`、`affectedQuads`，便于 journal
  replay、运维和后续 fallback/reconcile 判断。

这个能力只优化路径投影变更的写放大；它不改变标准 URI 语义，也不把 GSPO 改成相对路径存储。
无法证明安全的用户手写绝对 IRI，应跳过并交给更高层 reconcile 或内容重写策略处理。

## 默认图语义

Xpod 采用标准 SPARQL dataset 语义。物理 DefaultGraph 是独立 graph；access scope
只限制可见 graph/source，不把 DefaultGraph 改写成 Pod、目录或资源 named graph 的隐式 union。
应用侧提供本次请求的 `basePath` / 资源 IRI 只用于权限和 source 过滤。

`/-/sparql` query/read 路径：

- 没有显式 `FROM` / `FROM NAMED` 时，普通 BGP 只读取物理 DefaultGraph。
- named graph 必须通过 `GRAPH <g>` / `GRAPH ?g` 访问，并仍受 basePath/source access scope 限制。
- 显式 `FROM <graph>` 总是按 SPARQL dataset 语义构造查询默认图；多个 `FROM` 合并为查询默认图。
- 只有 `FROM NAMED` 且没有 `FROM` 时，默认图为空；普通 BGP 不应隐式读整个 Pod，
  只有 `GRAPH <g>` / `GRAPH ?g` 能看到 named dataset scope。
- `FROM` / `FROM NAMED` 指向 server-owned Pod scope 外时，默认禁用并返回明确错误；
  不能静默走 federation 或第二套执行器。

SPARQL UPDATE/write 路径：

- HTTP `PATCH` / local RDF authority patch 的隐式默认图必须是请求目标资源的 exact graph。
  写入不能因为目标是目录或 Pod scope 就使用 prefix graph。
- `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` 的 default graph 只有在调用方显式传入
  write target graph 时才可编译；否则必须报错，避免把默认图误写进错误文件。
- `WITH <graph>` 和安全 `USING <graph>` 只影响 update 内部 template / WHERE dataset scope，
  并且仍必须落在 basePath scope 内。写入模板最终必须能落到明确的 named graph。

## ACL / ACR Query Scope

RDF engine 不重新实现 WAC/ACL 或 ACP/ACR 规则。协议入口仍由 CSS 的
`CredentialsExtractor`、`PermissionReader` 和 `Authorizer` 决定当前请求身份在某个
resource 上是否具备对应 mode；RDF engine 只接收一个不含 token/secret 的
`RdfAccessScope`：

```text
basePath + mode + principal + allowedGraphUrls / deniedGraphUrls / deniedGraphPrefixes + version
```

读查询的语义：

1. `SubgraphSparqlHttpHandler` 先对 sidecar `baseUrl` 做 `Read` 授权。
2. handler 用当前 engine 列出 `baseUrl` scope 下的 named graphs。
3. 对每个 graph/resource，再用同一套 CSS 授权链检查 `Read`。
4. 大多数 graph 继承父容器权限时，`RdfAccessScope` 不带收紧列表，query 按原 fast path
   执行。
5. 如果某个 graph 因 `.acl` 或 `.acr` override 不可读，scope 带
   `deniedGraphUrls`；当前 authority 在执行 SELECT / ASK / CONSTRUCT / DESCRIBE /
   `constructGraph` / `listGraphs` 时必须应用这些 allow/deny graph 条件。

内部 prefixed graph 也必须落到源资源授权，而不是按 graph 字符串跳过检查。例如
`meta:https://pod/alice/file.png` 作为 engine graph 参与过滤，但授权时要规范化成
`https://pod/alice/file.png` 交给 CSS 的 `PermissionReader` / `Authorizer`。如果源资源
不可读，`deniedGraphUrls` 记录的仍是原始 graph 名 `meta:...`，让 engine 精确过滤对应
graph。

写查询的语义：

1. `SubgraphSparqlHttpHandler` 先检查 UPDATE 中所有显式 graph 都在 sidecar `baseUrl`
   scope 内；graph 变量不允许进入这个入口。
2. 没有 `GRAPH` 的 INSERT / DELETE template 会在 handler 层改写到当前 sidecar
   `baseUrl` graph。
3. 对 base graph 保留原有 `Append` / `Delete` 授权要求；对每个 child graph 写目标，再用
   同一套 CSS 授权链检查对应的 `Append` / `Delete` mode。
4. `DELETE WHERE`、`INSERT ... WHERE` 和 `DELETE/INSERT ... WHERE` 还需要 `Read`，
   并把 read `RdfAccessScope` 传入 `queryVoid`，让 WHERE 匹配过程同样排除不可读 graph。

这让 ACL 和 ACR 统一落在 CSS 授权组件，不在 RDF 层分叉。切换默认授权模式只改变 CSS
组件链，RDF query scope 的形状不变。

安全边界：

- 收紧 scope 下禁止调用不理解 ACL/ACR 的第二套执行器；unsupported query
  shape 必须返回明确错误，不能回到只做 graph prefix filter 的路径。
- query result cache 的 scope key 必须包含 principal、basePath、mode、authorization
  model、权限版本和 allow/deny graph 列表；不能只用 normalized query + facts
  `data_version`。当前 PG result/materialized cache 会把结构化 scope 写入 key，并在 cache
  table 保留 scope 元信息和 graph allow/deny/prefix 列；`.acl` / `.acr` source 或 graph 写入会
  优先使用 `rdf_access_control_overrides` 中从 WebACL/ACP target triples 派生出的 affected
  resource，再按 affected base path、graph scope 和已知 sourceVersion / permissionVersion
  重叠删除相关 PG result/materialized cache；版本未知时仍按全版本保守删除。
- 当前第一版按请求实时列 graph 并逐 graph 授权，适合“绝大多数资源继承父权限、少量资源
  有 override”的业务假设。后续可把 override/resource permission version 做成派生索引，
  但不能牺牲 per-resource 授权语义。
- Search/vector 端点的资源级 ACL/ACR 过滤必须单独落在 search candidate / subject
  hydration 边界；不能把 `/-/sparql` 的 read scope 证明外推到独立 vector result。第一版已把
  `RdfRunContextRetriever` 接到 `RdfAccessScope`，让产品 Run context 的 text/vector 检索复用
  source allow/deny/prefix 条件和 cache scope；旧 OpenAI-compatible `VectorStoreService.search`
  会对当前 vector store 下已索引文件做有界 read prefilter，把不可读 `vectorId` 作为
  `excludeIds` 下推给 `/-/vector/search`，并在 hydrate 成 fileUrl 后再次用当前 access token
  做 read proof，无法证明可读或无法映射 fileUrl 的结果不返回。

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
- `rdf_vector_sources` / `rdf_vector_chunks` 记录 source/chunk 级 embedding、model、offset、heading path 和 content snapshot；`rdf_vector_components` 物化每个 chunk 的向量分量，第一版用 embedded SQLite 做 dot/cosine/euclidean scoring、threshold 过滤和 source-local order/window，后续可替换成 pgvector/sqlite-vec/native 执行层。
- 标准 RDF 文档覆盖两层语义：
  - line-addressable RDF：`.ttl` / `.jsonld` / `.nt` / `.nq` / `.trig` / `.n3`。这些格式按扩展名推导 content type，可通过本地 RDF 文件权威路径刷新结构化 index，并进入 by-line 工具文件追踪。
  - 非 by-line 标准 RDF：`.rdf` / `.rdfs` / `.owl` / `application/rdf+xml`。这些格式可解析、镜像并全量同步到结构化 RDF index，但不进入 SolidFS by-line 自动追踪，也不走单文档增量 patch。
- `RdfIndexSolidFsSyncer` 在 direct workspace commit 时会把标准 RDF 文档同步到结构化 RDF index；配置了 text index 时，仅把 line-addressable RDF 文本、Markdown、plain text 同步到 `RdfTextIndex`；配置了 vector index 时也只消费同一批 text-indexable source，并且必须显式提供 `vectorizeText`，不在 syncer 内部绑定 embedding provider；RDF/XML 这类非 by-line 标准 RDF 只做全量解析刷新，不进入文本/by-line 索引；syncer 通过 `shouldTrackPath(...)` 声明路径范围，避免 SolidFS 为文本/向量索引监听所有文件。


### Full-text index boundary

PG `tsvector`、SQLite FTS5、term posting table、trigram/LIKE 这类全文能力只是 physical text operator。
它们的输入模型是“文本行/文档 -> token postings -> candidate rows”，不原生理解 RDF 的 S/P/O/G、
BGP 变量绑定、named graph、ACL/ACR、predicate 选择性或 SPARQL algebra。因此不能把“启用 PG/SQLite
FTS”理解成已经获得完整的 SPARQL+Text 执行模型。

Xpod 需要区分三类 text search：

1. **RDF term lexical index**：面向 `rdf_terms` 的 lexical value，例如 literal、IRI、label 或
   `STR(?term)` 的 contains/prefix/regex 子集。执行形态是 text operator 命中 `term_id`，再 join
   `rdf_quads.g/s/p/o = term_id`。它服务 SPO/G term 查询，但不是文档全文检索。
2. **RetrievalPoint / document FTS**：面向文件、folder summary、heading、chunk、OCR/reader 输出等
   retrieval point。执行形态是 text operator 返回 `pointId` / `sourceNodeId` / `chunkKey`，再与 RDF、
   path、ACL/ACR 和 vector source join。
3. **Integrated planner**：把 text candidates 作为 query planner 的一等 source，和 RDF BGP、
   path scope、ACL/ACR、vector、ORDER/LIMIT/top-k 在同一个 plan 中 cost、join 和排序。

因此：

```text
PG/SQLite FTS = physical index/operator
RDF-3X        = RDF join/statistics baseline
Integrated plan = RDF/search/path/auth 的统一 planner/executor
```

PG/SQLite FTS 可以作为第 1 类或第 2 类的底层 operator，但不能替代第 3 类。真正的性能目标是让
`TextMatchSource` 在 `SolidRdfEngine` planner 内产生可 join 的候选，而不是先把大批 text hits materialize
到 TS 层再做 RDF/path/ACL 过滤。

公开 SPARQL 层暂不承诺完整 SPARQL+Text 语法。当前已支持的是内部 `RdfQuery.textSearch[]` /
`vectorSearch[]` source；如果后续暴露 SPARQL+Text，需要先定义函数语义、score 变量、top-k、权限过滤和
fallback/correction 行为，再映射到同一套 planner source。


### Integrated fusion planner and path handling

公开 `SolidRdfEngine` 把 RDF BGP、FTS、vector、path scope 和 ACL/ACR 建模为同一个
logical plan，再把 physical operator 下放到当前 SQLite/PostgreSQL profile。可选 native
SPARQL 实现只能消费相同的 term dictionary、permutation scan、cardinality stats、candidate
source 和 access scope，不能引入第二套 SPO 事实源。

```text
Query / Search Request
  -> SolidRdfEngine logical planner
      - RdfBgpSource
      - TextMatchSource
      - VectorMatchSource
      - PathScopeSource
      - FolderSemanticSource
      - AclScopeSource
  -> SQLite / PostgreSQL / optional native physical operators
```

性能目标不是在 TS 层拼接多个检索结果，而是让 text/vector/path/ACL/RDF 在 planner 内统一
cost、join、filter、fusion score、top-k 和 fallback。FTS / vector 返回的候选必须尽早变成可
join 的 `pointId` / `sourceNodeId` source，而不是先 materialize 成大数组再由应用层过滤。

路径处理分两层：

1. **Path structural index**：结构硬约束，负责 exact path、prefix/subtree、parent-child、depth、workspace、
   extension、ACL/ACR 继承和文件移动。它由 `SourceNode` / closure / ltree-like 派生表提供，不依赖 FTS
   或 embedding 保证正确性。
2. **Folder retrieval point**：folder 本身进入 FTS/VEC，表达路径所在信息架构的语义。不要把 full path
   作为每个 file/chunk 的独立 vector 事实；folder semantic score 可和 file/heading/content score 融合。

FTS 可以把 basename、folder title、folder summary、path segments 当成弱字段或 boost；vector 可以检索
folder summary / locator projection。但 raw path embedding 不能替代 ltree 语义。移动目录时，content FTS、
semantic vector、reader cache 和 entity mention 应通过 stable `sourceNodeId` / `pointId` 复用；需要追赶的只是
current path / URI / breadcrumb / weak path tokens / graph prefix materialization 等派生层。

一个典型融合计划：

```text
PathScopeSource(folderNode)
  -> AclScopeSource(principal)
  -> TextMatchSource(query) OR VectorMatchSource(queryEmbedding)
  -> RdfBgpSource(relationships)
  -> score fusion + top-k
```

当 text/vector 命中很窄时，planner 也可以先走 `TextMatchSource` / `VectorMatchSource`，再 join
`PathScopeSource` 和 `AclScopeSource`。顺序由统计信息、candidate cardinality 和权限 scope 决定。

## Query Engine Scope

第一阶段必须覆盖 app 常用查询，而不是追求一次性完整 SPARQL 1.1：

| 能力 | 第一阶段 |
| --- | --- |
| BGP | 必须 |
| GRAPH / named graph scope | 必须 |
| FILTER 比较 | 必须 |
| FILTER OR | 由 QLever authority 负责 |
| FILTER string functions | 由 QLever authority 负责 |
| ORDER BY | 由 QLever authority 负责 |
| LIMIT / OFFSET | 必须 |
| SELECT DISTINCT / REDUCED | 由 QLever authority 负责 |
| COUNT / basic aggregate | 由 QLever authority 负责 |
| OPTIONAL | 由 QLever authority 负责 |
| BIND | 由 QLever authority 负责 |
| UNION | 由 QLever authority 负责 |
| MINUS / FILTER NOT EXISTS / FILTER EXISTS | 由 QLever authority 负责 |
| property path | 由 QLever authority 负责 |
| CONSTRUCT / DESCRIBE | 由 QLever authority 负责 |
| SPARQL UPDATE | prepared-delta authority path；无法证明为 base scope 内有限文件/graph 目标时返回明确错误 |
| SERVICE / federation | server 默认禁用；后续只能通过显式 allowlist/plugin 打开 |

Local planner 输入来自产品层结构化查询：

- `RdfQuery` DSL。
- text/vector/RDF 融合 source。
- drizzle-solid / models 选择器。
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

- `RdfQuery.textSearch[]` 从 `RdfTextIndex` 产出 bindings，可绑定 `source`、`chunk`、`content`、`heading`、`score`、`workspace`、`localPath`、`contentType`、offset 等变量。
- `source` 是文件/source 资源的 named node，能直接和 RDF BGP 的 graph / subject / object 变量 join。
- `chunk` 是派生 chunk named node（source 资源 + deterministic chunk key），不是内容权威资源。
- `limit` / `offset` 是 text search source 自己的 top-K/window，先在 `RdfTextIndex` 命中集上执行，再和 RDF BGP join；如果需要 join 后分页，使用 `RdfQuery.limit` / `offset`。
- `orderBy` 是 text search source-local ordering，默认按 score 降序；可显式按 `score`、`source`、`localPath`、`ordinal`、offset 等稳定字段排序，然后再执行 source-local `limit` / `offset`。它不替代 join 后的 `RdfQuery.orderBy`。
- text search 会先用 `rdf_text_terms` posting 表按 query token 缩小候选 chunk，再用 normalized phrase `LIKE` 复验，保留原有 substring / phrase 语义。
- 如果 query 使用 `textSearch` 但 engine 未配置 `RdfTextIndex`，必须显式报错，不调用第二套执行器。

`VectorSearch` 已有第一版本地 binding source：

- `RdfQuery.vectorSearch[]` 从 `RdfVectorIndex` 产出 bindings，可绑定 `source`、`chunk`、`content`、`heading`、`score`、`distance`、`workspace`、`localPath`、`contentType`、offset、`model` 等变量。
- `source` / `chunk` 语义和 `TextSearch` 一致：source 是文件资源，可直接 join RDF named graph 或 subject；chunk 是派生 chunk resource，不是内容权威资源。
- `embedding` 由调用方传入，`vectorModel`、workspace scope、source prefix、limit/offset/threshold 都是受控内部 DSL 参数；公开 SPARQL 向量函数后续再定义。
- `limit` / `offset` 是 vector search source 自己的 top-K/window，先在 `RdfVectorIndex` 排序命中集上执行，再和 RDF BGP join；如果需要 join 后分页，使用 `RdfQuery.limit` / `offset`。
- `orderBy` 是 vector search source-local ordering，默认按 score 降序；可显式按 `score`、`distance`、`source`、`localPath`、`ordinal`、offset 等稳定字段排序，然后再执行 source-local `limit` / `offset`。它不替代 join 后的 `RdfQuery.orderBy`。
- 如果 query 使用 `vectorSearch` 但 engine 未配置 `RdfVectorIndex`，必须显式报错，不调用第二套执行器。

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
4. 起点之后先选与已绑定变量连通的 pattern；多个连通候选之间按 bound-slot fanout 估算排序。
5. FILTER 能转成 term/range 条件时下推。
6. ORDER BY 与索引顺序兼容时避免额外排序。
7. LIMIT 在语义安全时尽早下推。
8. 不确定时宁可慢，不返回错结果。

需要维护的统计。RDF-3X 风格统计是 local / cloud 共同内核的一部分，不是 local-only
能力；cloud 的 result table/cache 也应该复用这套基础统计。
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
  -> native QLever authority validation
  -> prepared scoped delta
  -> append/update SolidFS sync journal
  -> patch authority file
  -> refresh affected index rows
```

简单语句应走 delta：

- `INSERT DATA`
- `DELETE DATA`
- `DELETE WHERE` 可直接计算删除 delta

Query-backed 语句由 native QLever authority 计算 WHERE binding 和写入 delta：

- `DELETE/INSERT WHERE`、`INSERT WHERE` 和 `DELETE WHERE` 都必须产出 base scope 内的有限 delta。
- UPDATE template 仍只接受普通 triple；graph 目标必须是显式 base scope graph，或能被 authority 证明为 finite graph set。
- 写入提交前仍按显式 `append` / `delete` / `write` access scope 复验目标 graph。HTTP sidecar 负责 Read / Append / Delete 授权切分，prepared delta 提交边界不能把 read scope 误当成 write scope。

复杂/未覆盖语句：

- 如果无法安全映射到 authority file patch，则返回明确 unsupported/disabled 错误。

Canonical by-line RDF 建议：

- 一行一个 statement。
- 尽量使用完整 IRI 或稳定 prefix policy。
- blank node 需要限制或 skolemize。
- `source_line_no` 只作为优化和诊断，不作为 RDF 身份。

## No Implicit Server-side Fallback

`/-/sparql` 只进入当前产品 authority：Local 是
`QleverSparqlEngine -> RdfEngineLike.sparqlQuery(...)`，公开 Cloud 是
`RdfQuerySparqlEngine` + Comunica + scoped `PostgresRdfEngine` RDFJS source。server-owned Pod
不配置旧 server-side SPARQL 或外部 federation 执行器作为隐式兜底。

默认策略：

- `SERVICE` 默认禁用或 require allowlist。
- 本地 query 不通过 remote source federation。
- local/public cloud 不配置第二套执行器；`/-/sparql` 上未覆盖的 query shape 返回明确 `400`，禁用能力返回明确 `403`。
- 不存在执行 fallback 计数作为常态运行指标；unsupported shape 必须暴露能力边界。

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
  session / audit / agent / workspace / credential / model provider
  ai config / vector store / indexed file / agent status
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
| active sessions / session hydration | AgentSession/SessionManager lifecycle projection |
| audit entries / approval trace | audit supervision and approval-policy joins |
| AI config / vector store / indexed file / agent status | settings-runtime registries and vector indexing metadata |
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

历史 local models benchmark 的 large seed 要求是 1M+ quads，并把 synthetic message
分布到多个 Pod scope。当前公开仓库不再保留该 local benchmark CLI；local 发布语义改由静态
QLever runtime semantic gate 验证。

每个 benchmark case 必须记录：

- models-level query 名称和输入参数。
- 生成的 SPARQL/algebra/physical plan。
- 返回行数和 checksum。
- 扫描行数、索引选择、join 顺序、fallback reason。
- p50/p95 latency。
- DB 表和索引空间占用。

当前可执行入口：

```bash
bun run benchmark:rdf-models:pg -- --scale=small --iterations=1
bun run benchmark:rdf-models:pg -- --scale=medium --iterations=1 --warmupIterations=0 --caseProfile=extreme
bun run benchmark:rdf-models:pg:gate -- --root=.test-data/rdf-engine
bun run test:qlever:semantic-contract
```

`--caseProfile` 支持 `default` / `extreme` / `fusion` / `all`。默认 profile 保持业务常规
chat/task/thread/message/run/session/audit/provider/vector/indexed-file case；`extreme` 只跑高 fanout / 深 BGP /
large VALUES / COUNT DISTINCT / grouped count / grouped numeric aggregate / graph-prefix
scan 等压力形状，并额外加入 `native-stress.ttl` exact graph case，强制覆盖
`pg-custom-index` native extension operator。它用于对比 PG RDF-3X baseline 和
`pg-custom-index` native extension。
`fusion` 是 search/RDF 融合 gate：它不跑 scan case，只跑
`agent context text vector fusion query`，会 seed `RdfTextIndex` / `RdfVectorIndex`
派生索引并验证 text/vector/RDF source 同一个 query plan。该 case 会用 numeric BIND
计算 `fusionScore = textScore * 0.55 + vectorScore * 0.45`，再按 `fusionScore DESC`
rerank，所以同时覆盖 candidate generation、结构化 join、score fusion 和本地数值排序。
PG benchmark 会给 `PostgresRdfEngine` 配置同一套 in-process text/vector index；第一版
不会把 search source 伪装成 RDF-3X/native 下推，而是显式走 PG facts fallback，并用
`PostgresFactsScan`、`TextSearch`、`VectorSearch`、`PostgresFactsBind` 和
`PostgresFactsSort` 作为 gate。
`all` 仍表示 default + extreme；fusion 需要额外 search index seed，所以保持显式 opt-in。
PG benchmark 是 custom-index 发布前的主 gate；local SQLite 语义由 QLever semantic contract
和静态 runtime image gate 负责。

默认输出到 `.test-data/rdf-engine/`：

- `models-baseline-*.json` / `models-rdf3x-shadow-*.json`：历史 local artifacts，保留用于解释旧 RDF-3X rollout 数据，不是当前可执行发布入口。
- `models-postgres-*.json`：同一批 models scan / query case 跑 `PostgresRdfEngine` PGlite baseline，默认关闭 query result cache 并刷新 RDF-3X derived stats，记录 PG physical plan、planMatched / failedPlanCases、storage profile 和 `pgAcceleration` fallback/capability 状态。

最新 medium 级实测摘要和迁移计划单独维护在
[RDF Performance Report and Data Migration Plan](rdf-performance-and-migration-plan.md)，
避免把历史 benchmark 记录误读成当前上线 gate。

这些历史 local artifact 只用于解释阶段 1/2 的 baseline 和 shadow comparison，不切换 `/-/sparql` 主路径。

`bun run test:qlever:semantic-contract` 先落为第一版目标子集，不尝试一次性跑完整 W3C SPARQL suite。当前子集覆盖 QLever authority path 已声明支持的 SELECT BGP / OPTIONAL / OPTIONAL 内 VALUES / FILTER / VALUES / VALUES `UNDEF` / BIND / UNION（含 branch-local required BGP 后执行 nested UNION）/ MINUS / FILTER EXISTS / FILTER NOT EXISTS / dependent group 内受控 UNION / ORDER / LIMIT、`FROM` / `FROM NAMED` dataset scope、固定长度 property path、GROUP BY COUNT / HAVING、ASK、基础 CONSTRUCT、受控 DESCRIBE、scoped `INSERT DATA` / `DELETE DATA`，以及 query-backed `DELETE/INSERT WHERE` update；每个 case 都断言走当前 authority path。后续扩大 SPARQL 子集时，先把新增能力补进这个入口，再调整对应 unsupported 边界。

### Current Execution Contract

当前 public RDF 查询边界只有两类：

1. local / SQLite：静态 QLever runtime 作为 SPARQL authority，TypeScript 只负责启动、协议适配、fixture 和语义 gate。
2. public cloud / PostgreSQL：`PostgresRdfEngine` 作为 server-owned Pod 的 PG backend，`RdfQuerySparqlEngine` 用 Comunica 在 scoped facts/source 上执行 SPARQL，不要求 QLever 或私有 PG extension。私有 cloud acceleration 只能通过部署专属组件接入。

旧 server-side SPARQL 执行器已经从生产与测试入口删除。unsupported shape 必须返回明确错误、capability 和 hint/correction；不能静默改走别的执行器后让用户以为当前产品 authority 支持该能力。

## Current Implementation

当前实现进度：

- `RdfTermDictionary` / `RdfQuadIndex` 已提供 SQLite term dictionary、`rdf_sources`、`rdf_quads` 和 `SPOG` / `SOPG` / `PSOG` / `POSG` / `OSPG` / `OPSG` 六排列 covering indexes，加上 `GSPO` / `GPOS` / source indexes；term dictionary 的 exact identity 走固定长度 `hash`，prefix candidate 走 `value_head`，不再把 unbounded `value` / `normalized_text` 放进 raw B-tree key。
- 当前代码不保留旧 TEXT `QuintStore` 兼容读写层。
- term-id facts 的当前来源是 SolidFS 权威 RDF 文件或既有 facts 表重建，不再从旧 TEXT store 分批回灌。
- `runRdfModelsBenchmark(...)` 已能基于 `rdfModelsBenchmarkCases` 生成 baseline report，包含 query、返回行数、checksum、p50/p95、physical plan、scanned rows、index choice、join order、fallback reason 和 index 空间统计；空间统计同时记录总 DB bytes、RDF table bytes、RDF index bytes 和 SQLite object breakdown。medium 级 `search message literals` case 会带 `$contains` 条件，证明 literal text index 不是普通 predicate scan。report 同时记录 `planMatched` / `missingPlan` / `failedPlanCases`，把 expected plan 和实际 `metrics.indexChoice` / `metrics.queryPlan` 对齐成可机检 gate。
- local models benchmark 会构造覆盖 chat/task/thread/message/run/runStep/session/audit/provider/model/credential/profile/ACL/ACR/issue/approval/grant/inbox/contact/favorite/aiConfig/vectorStore/indexedFile/agentStatus 的 deterministic seed data。当前 local SQLite 发布 gate 使用静态 QLever runtime semantic contract。
- `bun run benchmark:rdf-models:pg` 已提供同 seed / 同 models case 的 PostgreSQL baseline gate，默认使用 PGlite 跑 `PostgresRdfEngine`，默认关闭 query result cache，执行前调用 `refreshDerivedIndexes()`，并把 `models-postgres-*.json` report 保存到 `.test-data/rdf-engine/`；也可用 `--driver=pg --connectionString=... --allowPgWrites` 跑真实 PostgreSQL，但只允许指向 disposable empty database，脚本会在写入前拒绝非空 RDF facts。任何 plan mismatch、seed 未达到目标规模、derived stats 未同步都会让命令退出非 0；当 `--rdfAccelerationProfile=pg-custom-index` 且 `--caseProfile=extreme|all` 时，还要求 report 中至少出现一个 `XpodRdfExtensionOperator(...)`，避免 custom-index 只启用了 profile 却没有命中 native operator。2026-06-06 PGlite extreme smoke：`bun run benchmark:rdf-models:pg -- --scale=medium --iterations=1 --warmupIterations=0 --caseProfile=extreme --rdfAccelerationProfile=baseline` 生成 `19483` quads，2 个 scan case 和 10 个 query case 均 plan matched，`rdf3x.syncedWithFacts=true`，storage total/facts ratio `1.41x`。同日真实 PG17 extreme gate 证明 `pg-custom-index` 可命中 5 个 native operator case；当时 graph-prefix product cases 仍是 PG SQL hot path。2026-06-07 已补 bounded graph-prefix native slot-filter 下推，并完成真实 PG17 rerun：`join.slot_filter.native` active，native extension plan hits `11`，storage total/facts ratio `1.25x`；graph-prefix grouped numeric aggregate 从旧 native 94ms 降到 28ms，但 `COUNT DISTINCT` / grouped count 仍未超过 RDF-3X / btree baseline。
- `rdfModelsQueryBenchmarkCases` 已开始覆盖跨 pattern 的业务查询物理计划，并在 report 中记录 RdfQuery DSL 输入、physical plan 和 checksum：按 thread 拉最新 message 会要求 `ORDER BY createdAt DESC LIMIT 1` 保持在 SQL self-join 内；thread message keyset page 会要求 `createdAt < cursor`、`ORDER BY createdAt DESC` 和 `LIMIT` 同时保持在 SQL self-join 内；thread context window 会要求 message type/thread/created/score 星型 join 与分页保持在 SQL self-join 内；workspace 内下一条 queued run 会要求 status/workspace/createdAt 三个 pattern 在 SQL self-join 内完成并下推 `ORDER BY createdAt ASC LIMIT 1`；run step 列表会要求 `rdf:type RunStep` 和 `udfs:run` 关系在 SQL self-join 内完成并下推排序/分页；task run execution detail 会把 Task、Run、Thread、RunStep hydration 放进同一个 BGP gate；task materialization 会要求 `rdf:type Schedule`、`udfs:status "active"` 和 `udfs:nextRunAt <= cutoff` 在 SQL self-join 内完成，并下推 range filter、排序和分页；AI credential selection 会按 shared models 的 `ai:` / `cred:` vocab 连接 provider default model、active/default credential、`apiKey` 和 `failCount`；active session hydration、audit approval policy trace、AI config embedding model、vector indexed-file store 这些新增 case 覆盖 SessionManager、监督审计、AI runtime 配置和向量索引元数据；profile ACL authorization、profile ACR authorization、profile inbox activity、approval grant action match、favorite target chat、contact entity profile 这些 models join case 用于防止 WebID/profile、权限图、审批授权、联系人和收藏回退成 pod-wide scan；这些 timeline/context/state-center/one-to-many/scheduler/provider-credential/session/audit/profile/access/contact/favorite/vector 查询会和 non-grouped numeric aggregate、grouped message count、grouped credential `failCount` aggregate、message-thread `COUNT DISTINCT` 一起作为 RdfQueryExecutor 的 models-level plan gate。PG 专用 `rdfModelsPostgresQueryBenchmarkCases` 在通用 query cases 基础上额外覆盖 5 个显式 business-view materialized warm-path case，要求 warmup 后出现 `PostgresMaterializedResultHit` 和 `PostgresQueryTemplateCacheHit`，且不写普通 result cache。
- `RdfQueryExecutor` 已开始承接 phase 2 的本地物理查询层，支持 BGP join、OPTIONAL group、COUNT/basic aggregate、FILTER DSL 和 select/order/limit 投影；可下推的 exact/range/prefix filter 会合并到 `RdfQuadIndex.scan(...)`，纯 required-pattern 查询里已经由 index 保证的 filter 不再重复进入后置内存 `Filter(...)`。
- `RdfQuadIndex.scan(...)` 已把 graph/source prefix scope、lexical range filter 和 RDF term text search 改为显式 `JOIN rdf_terms ...`，避免把前缀 graph、range hit 或 text hit 先展开成巨大 `IN (?, ...)` / `IN (SELECT ...)` 候选列表；`$in` / `$notIn` 这类 VALUES-style term filter 在短列表时保留参数化 `IN`，长列表会写入临时候选表并用 JOIN / anti-JOIN 回连 quad scan，避免长 SQL、参数上限和 planner 误判；medium models benchmark 中 `search message literals` 的 physical plan 可机检到 `prefix_graph_id` 和 `text_object_id_contains` JOIN，`task materialization due time` 可机检到 `object_id_range_lte` JOIN。
- connected required BGP 已有受控 SQL self-join 快路径：`RdfQueryExecutor` 在没有 OPTIONAL / UNION / dependent join / text-vector source 的安全 shape 下，会先用 `RdfQuadIndex.estimateCardinality(...)` 按选择性和共享变量连通性重排 BGP pattern，再把多 pattern BGP 下推到 `RdfQuadIndex.joinPatterns(...)` / `countJoinPatterns(...)`，由 `rdf_quads q0 JOIN rdf_quads q1 ...` 直接按共享变量连接并返回 bindings 或 aggregate rows。安全的 `SELECT DISTINCT ?x ... ORDER BY ?x LIMIT n` 这类投影去重可在 SQL self-join 内执行：projection、ORDER 和 filter recheck 需要的变量必须保留，避免先丢变量再复验或分页造成错结果。非分组 `COUNT` / `COUNT DISTINCT` 可在 SQL self-join 内直接聚合，避免先 materialize join bindings 再在 TS 层计数。`ORDER BY` 绑定变量支持多变量和混合方向，并可把对应 `LIMIT` / `OFFSET` 一并放进 SQL self-join；安全的 term equality/range/IN/prefix/text operator FILTER、常量 `sameTerm`、term-type、language 和 datatype filter 会按变量所在 term slot 编译进 self-join，并用 pattern-scoped SQL alias 避免多个 pattern 的 `rdf_terms` join 和候选表冲突。变量-变量 FILTER、`BOUND`/stringLength、aggregate `HAVING` 或更复杂 query shape 继续走既有 cardinality planner 和 TS binding merge，避免提前分页或半下推造成错结果。
- `RdfQueryExecutor` 已支持 `rdf3xPrimary` selective primary，文件型 `SolidRdfEngine` 标准配置会通过 `derivedIndexProfile: "rdf3x"` 自动启用；`derivedIndexProfile: "baseline"` 会保持同库 `RdfQuadIndex` baseline 且不维护 RDF-3X stats，测试/外部实例也可显式打开 RDF-3X primary：只有 `rdf3x_metadata.facts_data_version` 已追上 facts `data_version` 时，query 才把 `Rdf3xIndex` 交给 planner；如果派生索引落后，query 不会同步 rebuild，而是在 plan 中标记 `Rdf3xPrimaryNeedsRefreshFallback` 并走 facts baseline。在 single-pattern scan/count 或 required BGP shape 被 `Rdf3xIndex` 完整覆盖时，直接走 RDF-3X permutation/membership scan/join，并在 plan 中暴露 `Rdf3xPrimaryScan(...)`、`Rdf3xPrimaryCount(...)`、`Rdf3xJoinBGP(...)` / `Rdf3xPrimaryJoin...`；RDF-3X join order 会先用 projection / membership stats 选择最窄起点，再每步优先接入与已绑定变量连通的 pattern，并用 `count(pattern) / countDistinctTuple(pattern, boundSlots)` 估算 connected 候选 fanout，避免窄但不相关的 pattern 或高 fanout pattern 提前造成 cross product；连通 term equality 会落到 facts covering index `JOIN ... ON ...` 并在 plan 中标记 `Rdf3xMergeJoin(...)`，graph equality 仍在 facts graph 条件中保持 named graph 语义；typed numeric literal range、lexical object range、object `$contains` / `$endsWith` text filter、exact term `$in` / `$notIn`、term-type、language 和 datatype metadata filter 都可进入 RDF-3X scan/join，metadata / text filter 会 JOIN `rdf_terms` 并在 plan 中标记 `TermType(...)` / `Language(...)` / `Datatype(...)` / `TextSearch(...)`，`$in` / `$notIn` 会编译成 SQL `IN` / `NOT IN` 条件并在 plan 中标记 `TermIn(...)` / `TermNotIn(...)`；`DISTINCT` term projection 在无 graph 变量/graph 约束、无 limit/offset 的安全子集里会标记 `Rdf3xIndexOnlyJoin` 并直接利用 facts covering index 执行；同 pattern tuple VALUES scan 可用 `TupleValuesJoin(...)` 下推，required BGP 中无 `UNDEF` 且所有变量均由 required pattern 绑定的 tuple VALUES 可用 `Rdf3xJoinTupleValues(...)` 下推，join count 和 grouped count 可分别走 `Rdf3xJoinCount(...)` / `Rdf3xJoinGroupCount(...)`。`Rdf3xIndex` 仍实现 `Rdf3xJoinAggregate(...)` / `Rdf3xJoinGroupAggregate(...)`，但文件型默认 primary 对 guarded numeric aggregate 先走 `RdfQuadIndex` SQL aggregate path，后续只有在 cost gate 证明收益时才重新切入 RDF-3X。OPTIONAL / UNION / dependent group 仍在 query layer 维持 left join / branch / semi-join / anti-join 语义，但内部无 group-local `VALUES` 的 connected BGP pattern list 可批量走 `Rdf3xJoinBGP(...)`，避免退回逐 pattern scan。不支持的 regex / search source 等 shape 不尝试半执行；文件型 `SolidRdfEngine` 继续落回同库 `RdfQuadIndex` baseline，`PostgresRdfEngine` 则落回 PG facts baseline。
- `Rdf3xIndex` 的 SQLite schema 已改为 facts-reuse schema：不再物化 `rdf3x_spo` / `rdf3x_pos` / `rdf3x_triple_membership` 这类事实副本，只保留 `rdf3x_stat_*` 和 `rdf3x_metadata`，stat 表使用 `WITHOUT ROWID`；旧 rowid / materialized fact-copy 派生表打开时会被丢弃并从 facts 重建 stats。facts / RDF-3X 均已记录 schema version，不兼容版本走整套本地索引重建，不走查询时动态建索引。
- graph-scoped scan/count/count-distinct/join 已走 RDF-3X membership source：当 pattern 带 exact graph 或 graph prefix 时，`Rdf3xIndex` 不再固定先扫三元组 permutation 再后置过滤 graph，而是直接以 `rdf_quads` facts source 作为该 pattern 的 source，使业务里常见的 `.data/chat/`、`.data/task/`、provider/model/contact/favorite 前缀能先收窄候选。graph prefix 先经 `rdf3x_stat_g` 图投影表收缩到真实 graph id，再进入 facts source，避免 `rdf_terms` 里同前缀的 subject/object IRI 参与候选。2026-05-28 medium models benchmark 里，seed 为 `10063` quads，22 个 shadow case 和 7 个 RDF-3X join case 均 matched / ordered matched，baseline/shadow/RDF-3X plan gate、performance gate 和 space gate 均通过；`rdf3x` profile facts space `5758976` bytes，derived space `1036288` bytes，`total/facts` 为 `1.18x`。
- 安全的 `GROUP BY ?var + COUNT(...)` 已有 SQL 下推快路径：当 required BGP 只包含可编译 pattern、没有 OPTIONAL / UNION / dependent join / search source / BIND / DISTINCT，且 group/count/order/having 只引用 BGP 变量或聚合别名时，`RdfQueryExecutor` 会先做同一套 BGP join reorder，再把连接和分组交给 `RdfQuadIndex.groupCountJoinPatterns(...)`，由 SQL self-join 后直接 `GROUP BY` / `COUNT` / `COUNT DISTINCT` 返回分组行；可下推 FILTER 会在 SQL 内过滤并不再对聚合结果做原始变量复验。grouped result 的 `ORDER BY` / `LIMIT` / `OFFSET` 可继续下推到 SQL，其中 group 变量排序通过 `rdf_terms.value` 保持词法顺序，聚合别名排序直接按 COUNT 数值排序；安全的 numeric aggregate `HAVING` 会编译成 SQL `HAVING`，确保分页发生在聚合过滤之后。`HAVING (COUNT(DISTINCT ?x) > n)` 这类未投影聚合表达式会编译成内部 hidden aggregate alias，用于过滤但不暴露到 SELECT metadata/result。非 numeric `HAVING`、带 `BIND` 的 group expression、非下推 filter 和更复杂 shape 仍留在本地 query 层聚合。
- required BGP pattern 选择已开始使用 embedded index cardinality：每一步基于当前 bindings、可下推 filter 和 `RdfQuadIndex.estimateCardinality(...)` / `count(...)` 估算候选行数，优先选择 connected 且候选更小的 scan 起点，避免固定顺序让宽 pattern 先扫全量；exact term pattern 的估算带写入/删除失效缓存，减少 planner 重复 `COUNT(*)`。
- 单 required pattern 的 `ORDER BY` / `LIMIT` / `OFFSET` 已在语义安全时下推到 `RdfQuadIndex.scan(...)`：排序变量必须能直接映射到该 pattern 的 term slot；分页只有在排序已下推或无排序、相关 filter 都可下推、且 pattern 内没有重复变量跨 term slot 一致性约束时才进入 index，避免先分页再应用未下推 row consistency 过滤造成错结果。多变量 `ORDER BY` 会下推成 SQLite term join 排序，支持每个排序列独立的 ASC/DESC 方向。
- 单 required pattern 的 `COUNT` 已在语义安全时下推到 `RdfQuadIndex.count(...)` / `countDistinct(...)` / `countDistinctTuple(...)`：count 变量必须来自该 pattern，不能有 optional/order/pagination，所有 filter 都可下推，且 pattern 内不能有重复变量跨 term slot 一致性约束；`COUNT DISTINCT ?var` 只有在 `?var` 映射到单个 term slot 时才下推为 `COUNT(DISTINCT slot)`，`COUNT(DISTINCT *)` 会按 pattern 实际暴露的变量 tuple 去重，避免默认图 prefix 读取多个 named graph 时把同一 solution 重复计数；多 slot 重复变量仍保留在 query 层聚合。connected BGP 的非分组 `COUNT` / `COUNT DISTINCT` 走 `countJoinPatterns(...)`，grouped `COUNT` / `COUNT DISTINCT` 走 `groupCountJoinPatterns(...)`；其中 `COUNT(DISTINCT *)` 使用结构化 `RdfQuery` metadata 记录的可见 solution 变量构造 tuple key，不使用内部 path join 变量或底层 rowid。
- typed numeric literal range 已按数值语义进入 embedded path：`xsd:integer` / `decimal` / `double` / `float` 及常见派生整数类型会写入 `rdf_terms.numeric_value` 并建立 `(kind, numeric_value)` 索引，`RdfQuadIndex` 用显式 `JOIN rdf_terms ... numeric_value` 执行 numeric range scan，避免 `"10" < "9"` 这类字符串序导致错结果，也避免先扫描 numeric term 再把 id 列表回填到 `IN (...)`；未声明为 numeric datatype 的 literal 仍保持 lexical range 语义。旧 RDF index 打开时会补列、建索引并回填可解析的 numeric literal。
- RDF literal text search 已先走 embedded path：`RdfTermDictionary.normalized_text` 负责 `contains` / `endsWith` 候选集，`regex` 暂用 term 表候选扫描并写入临时候选表，`RdfQuadIndex` 再通过显式 JOIN 回连到 quad scan，避免把命中的 term ids 展开成巨大 `IN (?, ...)`；plan 会记录 `TextSearch(...)`。query 层仍会复验 filter；带 flags 的 `regex` 暂不下推，避免 normalized index 改变语义。
- `STR(...)` 字符串过滤已按标准 SPARQL 词法值语义进入 embedded path：`STR(?term) = "..."`、`STR(?term) IN (...)` 和 `STRSTARTS` / `CONTAINS` / `STRENDS` / `REGEX` 会编译成显式 `stringValue` filter，避免把 IRI 与同词法 literal 误当成同一个 RDF term。安全的 `!STRSTARTS` / `!CONTAINS` / `!STRENDS` / `!REGEX` 作为本地后置 filter 支持，暂不下推到 text candidate index，避免否定谓词错误缩小候选集。`LCASE(STR(?term))` / `UCASE(STR(?term))` 以及对应 XPath `fn:lower-case` / `fn:upper-case` 嵌入字符串 filter 时会编译成本地 case-normalized operand，先作为后置 filter 执行，不提前下推到 term index。`stringValue` 的 equality / IN 保留为本地后置 filter，不下推成 term equality；prefix/contains/endsWith/regex 可按 term slot 推导候选 term kind 后下推，`object` 会覆盖 IRI、literal 和 blank node，避免 `STRSTARTS(STR(?object), "...")` 这类关系 IRI 查询被误当成 literal-only 搜索；`subject` / `graph` / `predicate` 仍按各自 RDF term kind 限定。
- 标准 XPath function-call、基础比较 FILTER、RDF term-test FILTER 和 same-variable OR 枚举等 SPARQL 语义由当前产品 authority 负责：Local 是 QLever，公开 Cloud 是 Comunica + scoped `PostgresRdfEngine` source。本文保留本地 `RdfQueryExecutor` 的结构化查询能力描述，但不再把这些能力写成 TS SPARQL adapter 的执行边界。
- `RdfSparqlBoundary` 只保留 server-owned graph / `SERVICE` scope validation、稳定错误码、hint 和 correction，避免 server-owned Pod 把越界 graph 或 remote federation 隐式交给执行层。
- SELECT / ASK / CONSTRUCT / DESCRIBE 的 SPARQL 语义由当前产品 authority 负责。Local 的 `QleverSparqlEngine` 是薄适配层，只把查询转给 `RdfEngineLike.sparqlQuery(...)`，不在 TS 层复刻 SPARQL algebra；公开 Cloud 用 Comunica 执行 algebra，不要求通过 QLever 才能启动或查询。
- `RdfQueryExecutor` 保留为 drizzle-solid / models 结构化查询 API 的内部 executor。它可以服务业务级 `RdfQuery` DSL、text/vector/RDF 融合和 planner 统计，但不作为 `/-/sparql` 的 SPARQL authority。
- UPDATE 统一走 prepared-delta authority path：`SparqlUpdateResourceStore` 接收 `application/sparql-update` PATCH，`MixDataAccessor.executeSparqlUpdate(...)` 转入 `SolidRdfDataAccessor.prepareSparqlUpdate(...)`，由当前产品 authority 生成 scoped delta，再 patch authority RDF files 并刷新 authority index。
- prepared delta 只能提交被当前 authority 证明在 basePath scope 内的有限 graph/file 目标。basePath 外 graph、未证明 finite 的 graph 变量、非 by-line RDF 写目标、`SERVICE` 和管理型 UPDATE 操作必须返回明确 unsupported/disabled 错误，不进入第二套执行器。
- `QleverSparqlEngine.queryVoid(...)` 禁止直接执行 SPARQL UPDATE；UPDATE 必须走 Pod SPARQL HTTP 入口的 prepared-delta authority path，再由 authority 按文件权威和 access scope 原子提交。这样可以避免 thin adapter 绕过本地 RDF authority、journal 和多文件恢复视图。
- Local `QleverSparqlEngine` 已接到 `/-/sparql` 默认引擎：SELECT/ASK/CONSTRUCT/constructGraph/listGraphs 统一通过 `rdfEngine.sparqlQuery(...)` 发送到静态 QLever runtime。公开 Cloud authority 是 `RdfQuerySparqlEngine` + Comunica + scoped `PostgresRdfEngine` source；capability-gated private native extension 只能作为部署专属加速层。
- `bun run test:qlever:semantic-contract` 已补上可执行的第一版语义目标子集入口，覆盖当前 QLever authority path 已声明支持的 SELECT/ASK/CONSTRUCT/DESCRIBE、`FROM` / `FROM NAMED` dataset scope、VALUES/VALUES `UNDEF`/OPTIONAL 内 VALUES/UNION（含 branch-local required BGP 后执行 nested UNION）/MINUS/property path、GROUP BY/HAVING、scoped DATA update 和 query-backed update smoke cases。

阶段 2：RdfQueryExecutor

- 扩大 SELECT/ASK 覆盖：补齐更多 FILTER、GRAPH、ORDER、多变量排序、aggregate、OPTIONAL、受控 UNION 和受控 dependent-join 边界。
- 让 `/-/sparql` 的 supported query shape 持续走 `QleverSparqlEngine -> RdfEngineLike.sparqlQuery(...)`，并用 semantic gate 防止能力反弹。
- 默认 server-owned Pod 不再把未覆盖 query 静默交给第二套执行器；未覆盖 shape 应返回明确错误并保留指标。

阶段 3：Text / Vector

- literal text index 已先在 `RdfTermDictionary.normalized_text` 和 `RdfQuadIndex` 中覆盖 RDF literal/IRI lexical 搜索。
- 文件 chunk index 已先落为 `RdfTextIndex` 派生索引：source/chunk/search 与 `SolidRdfEngine.indexTextSource(...)` / `searchText(...)` wrapper 已具备，direct SolidFS workspace commit 可自动刷新 RDF/text 两类派生索引，内容权威仍是 SolidFS 文件。
- `RdfQuery.textSearch[]` 已支持 text search 结果作为本地 binding source，再与 RDF BGP join；当前是受控内部 DSL，还未映射成公开 SPARQL 全文函数。
- embedding index 已先落为 `RdfVectorIndex` 派生索引：source/chunk/vector search 与 `SolidRdfEngine.indexVectorSource(...)` / `searchVector(...)` wrapper 已具备，direct SolidFS workspace commit 在配置 `vectorIndex + vectorizeText` 后可自动刷新 text source 的 vector 派生索引，`RdfQuery.vectorSearch[]` 可作为本地 binding source 再与 RDF BGP join。
- query planner 已开始把 text/vector + RDF required sources 统一重排：RDF exact pattern 用 `RdfQuadIndex.estimateCardinality(...)` 缓存估算，复杂 pattern 用 `count(...)` 兜底；未被当前 binding 约束的 text/vector source 会先走 `estimateSearchCardinality(...)` 估算 source-local hit window，避免为了 join 顺序提前 materialize 搜索结果；已经被当前 binding 约束且没有 source-local window 的 search source 仍用 exact source 条件估算兼容行数。search source 的 `limit` / `offset` 和 `orderBy` 已明确为 source-local window/order，并在 plan 中显式标注；planner 同时把 window 后输出行数和 window 前候选行数拆成不同代价，避免 broad top-K search 因为输出很小而压过更便宜的 RDF 绑定扫描。下一步是继续做向量索引后端替换评估。
- bound `source` 关系已下推到 text/vector index exact source 条件：RDF BGP 先绑定少量文件资源后，搜索 source 不再扫描整个 workspace/prefix 命中集。
- `rdfModelsSearchFusionQueryBenchmarkCases` 已把 Agent context 场景固定为 models benchmark gate：
  text query `runtime approvals`、cosine embedding、workspace/sourcePrefix scope 和
  message/thread/workspace RDF facts 必须在同一个 `RdfQuery` 里执行；plan gate 要求
  `text-search-source`、`vector-search-source` 和 `search-rdf-join` 同时命中。
- exact distinct slot / tuple 统计已先落为 `RdfQuadIndex.countDistinct(...)` / `countDistinctTuple(...)`，并复用写入/删除失效的 cardinality cache；当前同时服务于安全的单 pattern `COUNT DISTINCT ?var` 下推，以及 planner 在 connected join 上的单 slot 和多 slot distinct fanout 估算。
- top cardinality 分布已进入 `RdfQuadIndex.cardinalityDistributions()` / `stats()`：按 graph、predicate、predicate/object、subject/predicate 暴露 quad count 和对应 distinct 计数，先作为 RDF-3X 风格 planner/benchmark 可观测统计；这些统计属于 local/cloud 共同 embedded engine 能力，任何可选原生执行层也必须复用同一统计语义。
- literal datatype distribution 已进入 `RdfQuadIndex.stats()`：按 literal datatype 统计字典中的 distinct literal term 数，以及这些 literal 作为 quad object 出现的次数，先作为 planner/benchmark 可观测统计暴露。
- PG query explain 已把 planner reason 第一版接入 `RdfQueryResult.metrics.explain.planner`：selected path 会区分 materialized result cache、query result cache、native extension、RDF-3X 和 facts fallback；reasons 会记录 cache hit、RDF-3X join order、subject-star、VALUES、aggregate、regex fallback、unsupported capability、runtime scan rows、RDF-3X stale stats 和 slow-query 触发原因；estimate inputs 和 available stats 会暴露 facts exact counts、facts cardinality distributions、literal datatype distribution、RDF-3X projection stats、PG table stats 和当前 query 的 graph / predicate / predicate-object / subject-predicate histogram hints；runtime 字段记录 scanned/joined/returned rows、duration、filter 下推和 index choices，staleStats 字段记录 facts 与 RDF-3X version lag。当前这是慢查询解释和 benchmark gate 的可观测层，后续还要把 histogram / scan rows 真正接入 cost-based cutover。
- text term document frequency 已进入 `RdfTextIndex.stats()` / `PostgresRdfTextIndex.stats()` / `termDocumentFrequency(...)`：`rdf_text_terms` 物化 normalized token posting，按 term 统计出现过的 source 数、chunk 数和总 occurrences，作为 ranking/planner 可观测统计暴露；`RdfTextIndex.search(...)` / `PostgresRdfTextIndex.search(...)` / `estimateSearchCardinality(...)` 已使用 posting 表缩小候选，并通过 normalized phrase 复验保留 substring / phrase 语义；cardinality estimate 同时支持 workspace、source prefix、source allow/deny 和 source-local window。
- vector model/dimensions distribution 已进入 `RdfVectorIndex.stats()` / `modelDistribution()`：按 embedding model 和 dimensions 统计 source 数、chunk 数、magnitude min/max/avg，作为 ranking/planner 可观测统计和后续向量后端替换评估输入；`rdf_vector_components` 已物化向量分量，`RdfVectorIndex.search(...)` 在 SQLite 层完成 dot/cosine/euclidean scoring、threshold 过滤、source-local order/window，返回结果时只解析命中的 embedding snapshot；`RdfVectorIndex.estimateSearchCardinality(...)` 已能按 dimensions、model、workspace、source prefix 和 source-local window 估算候选行数，带 threshold 的估算走 component scoring count，不再为了 planner 估算 materialize 全量命中。

阶段 4：Update delta

- `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` / 安全 `DELETE/INSERT WHERE` / 安全 `INSERT WHERE` 的 embedded index delta 和 authority file patch 已完成第一步；SolidFS 层已具备默认 runtime journal/bootstrap/replay/compact，且同一次多文件 commit 会写入同一个 `tx_id`；SPARQL 多文件 PATCH 在配置本地 RDF authority journal 时也会用同一个 `tx_id` 登记，成功统一 `done`，刷新失败统一进入 `reconcile_required`。
- 安全的 `FILTER` / `VALUES` / `BIND` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join / semi-join local WHERE 子集已在 embedded update delta 路径覆盖：先用本地查询层计算 bindings，再 materialize delete/insert quads，最后 patch 文件权威并刷新 RDF index。`BIND` 保持 expression-layer 语义，不当作 join source；template 可读取派生 binding。
- Embedded index delta 已有 operation 级 `applyDelta(...)` 事务边界；文件权威层已支持多 default `USING` 和 `USING NAMED` 读取多个本地 RDF authority files，并支持一个安全 UPDATE 同时 patch 多个明确的本地 by-line RDF authority files；`GRAPH ?g` 模板在 `?g` 有 finite named graph scope 时也可 materialize 成多文件写入，且不再必须依赖 `USING NAMED`，显式 finite graph filter 和 finite `VALUES` graph rows 也可证明安全。显式写 access scope 会在 materialized quads 提交前挡住越界目标 graph。多文件 patch 已有进程内尽力 rollback：任一目标写入或 index 刷新失败时，已写目标会恢复到更新前 quads；带 journal 的路径会额外保留同 tx 的 reconcile 视图。下一步继续扩大复杂 update 覆盖，例如更多 FILTER 表达式、更复杂 named graph shape 的安全映射评估。无法安全映射的 shape 必须保留明确 fallback/错误和指标。
- 复杂 update 逐步消灭全量重写。

## Product-grade acceleration slice（2026-06）

本 slice 继续保持一个原则：Pod RDF facts / SolidFS 文件是事实源；下列能力都是
`SolidRdfEngine` / `PostgresRdfEngine` 内部派生执行层，不暴露为独立 backend，也不
形成第二份业务事实。

### n-column materialized views

`PostgresRdfEngine` 提供可 join 的 n-column materialized view，而不是只缓存最终 JSON
结果：

- `materializeView({ key, version, query, variables, scope, activate })` 执行源查询并把
  binding rows 写入 `rdf_materialized_views` 与 `rdf_materialized_view_cells`。
- `readMaterializedView(...)` 读取当前 active 版本，可选择变量、`limit`、`offset`。
- `activateMaterializedView({ key, version, scope, factsDataVersion })` 在同一事务里关闭旧
  active build 并打开目标 build，实现 versioned rebuild + atomic cutover。
- `RdfQuery.materializedViews[]` 会在执行前展开成 `VALUES` binding source，再参与既有
  BGP / RDF-3X / PG hot-operator join 计划。

Materialized view 的身份是：

```text
view_key + view_version + scope_hash + facts_data_version
```

同一个 `view_key + view_version + scope_hash` 同时只允许一个 active build。`scope` 必须
包含 principal / basePath / auth model / permission version / allow-deny graph 信息中会影响
可见结果的部分；否则跨用户、跨权限复用会返回错误结果。缺失 active build 时默认报错；只有
`required: false` 的 query source 可静默跳过。

它和 `rdf_materialized_result_cache` 的区别：

| 能力 | materialized view | materialized result cache |
| --- | --- | --- |
| 数据形态 | 行/列 binding cells，可继续 join | 完整 query result payload |
| 使用位置 | `RdfQuery.materializedViews[]` -> `VALUES` | 同一 query/template 的 warm result |
| 生命周期 | build inactive -> atomic activate | 按 ttl/bytes/entries prune |
| 权威性 | 派生，可重建 | 派生，可删除 |

### Entity-aware text index

全文索引粒度对齐 `source/chunk`，不是 SPO/triple。SPO/GSPO 继续承担结构化事实查询；
text/vector 承担文件和资源上下文的检索。二者通过 entity mention bridge 相连：

```text
rdf_text_sources
  -> rdf_text_chunks
      -> rdf_text_terms       # normalized posting / DF statistics
      -> rdf_text_entities    # chunk -> entity/predicate mentions
```

`RdfTextChunkInput.entities[]` 写入 chunk 中出现的 RDF entity、可选 predicate、label 和
occurrences。`RdfTextSearchOptions.entities[]` 表示返回 chunk 必须同时包含这些 entity；
`query: ''` 时可以执行 entity-only search。这让检索可以表达：

1. 先按 FTS/text 命中文本 chunk；
2. 再要求 chunk 含有某些 RDF resource / predicate；
3. 最后用 RDF BGP 对命中的 source/chunk 做结构化过滤或补齐上下文。

Embedding 也应复用同一个 chunk 语义：`rdf_vector_chunks.chunk_key/source` 与
`rdf_text_chunks.chunk_key/source` 对齐，entity bridge 继续作为 chunk 到 RDF graph 的公共锚点。
不要把 embedding 做到单条 SPO 上；那会把语义上下文切得过碎，并让召回结果难以和文件/标题层级对应。

### Schema explorer / autocomplete

`exploreSchema({ query, graphPrefix, limit })` 是第一版产品可用的 schema/autocomplete surface。
它只从当前 facts 和 `rdf_terms` 派生建议，不写 durable schema resource：

- `graphs`: graph cardinality candidates；
- `predicates`: predicate cardinality candidates；
- `classes`: `rdf:type` object candidates；
- `terms`: 任意 term 的 subject/predicate/object/graph 出现计数。

`query` 是面向 term value 的轻量 substring/prefix 过滤，`graphPrefix` 用于限制到某个 Pod
目录/业务 surface。这个接口用于 UI autocomplete、schema explorer 和调试，不替代 RDF schema / OWL
推理。

### Bounded path search

`searchPaths({ start, target, direction, predicates, graphPrefix, maxDepth, maxPaths })` 提供受限
BFS 图邻接搜索：

- `direction`: `out | in | both`；
- `predicates`: 可选谓词白名单；
- `graphPrefix`: Pod 目录级限制；
- `maxDepth` / `maxPaths`: 必填语义上的硬上限，防止递归 path 查询拖垮 server-owned Pod。

该接口不是完整 SPARQL property path 替代品；它是产品功能里的“找关系路径/解释上下文”工具。
不支持无界 `*` / `+` 递归；需要更复杂图算法时应先有明确产品 case 和 benchmark。

### W3C compliance/deviation gate

`docs/rdf-sparql-compliance-gate.json` 是机器可读的 compliance/deviation manifest：

- `gateCommand` 固定到 `bun run test:qlever:semantic-contract`；
- `w3cTargetSubset` 列出当前 embedded primary path 必须保持无 fallback 的 W3C 子集；
- `deviations` 列出有意不支持或暂缓的能力，并要求 runtime correction action 与 manifest 一致。

server-owned Pod 默认禁止隐式 fallback 到外部/federated executor。unsupported shape 必须返回明确错误、
capability、hint/correction；不能 silently fallback 后让用户以为本地 engine 支持该能力。

GeoSPARQL 当前策略是 `deferred-until-product-need`：只有出现具体 Xpod 产品查询、数据规模、正确性语义和
benchmark 目标后，才把 native GeoSPARQL 纳入 embedded engine。当前 GeoSPARQL query 应 route 到可信
external executor 或由上层产品显式拒绝。

## 验收

必须有三组测试：

1. Correctness
   - W3C SPARQL query suite 的目标子集。
   - 业务模型查询：chat/task/thread/message/run/step。
   - graph scope、date bucket、relative id、IRI expansion。

2. Performance
   - 扫描行数对比 QLever semantic runtime 或 PG native baseline。
   - TEXT quints vs term-id quads 的空间占用。
   - 常见查询 p50/p95。

3. Consistency
   - `.ttl` 修改后 index 刷新。
   - SPARQL UPDATE delta 后文件和 index 一致。
   - crash/retry 不产生重复 quad。
   - external client workspace 不被 server 当成本地权威。

## Open Questions

- 是否按 workload 裁剪 facts 层六个 covering index；当前先保留全部 `rdf_quads_*`，不再额外物化 `rdf3x_*` 六排列副本。
- term dictionary 是否先用 SQL 表，还是直接做 mmap/on-disk vocabulary。
- literal FTS 先用 PostgreSQL/SQLite FTS，还是抽象成可替换 backend。
- SPARQL parser 继续使用 `sparqljs` 还是直接复用现有 `sparqlalgebrajs`。
- external provider 的 client-side query spec 是否单独成文档。
