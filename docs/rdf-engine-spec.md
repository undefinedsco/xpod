# Xpod RDF Engine Spec

本 spec 定义 Xpod 自有 Pod 的 RDF 索引和查询引擎边界。它和 [SolidFS Spec](solidfs-spec.md) 分工如下：

- SolidFS 定义文件权威、workspace materialization、工具面对真实目录的语义。
- RDF Engine 定义标准 RDF 文档解析后的语义索引、查询计划、全文/向量检索和更新回写协议。

## 目标

- Xpod-owned Pod 的 server 端查询不再以 Comunica 作为主路径。
- 保留 `/-/sparql` 这种组件边界，但内部查询执行逐步切到 Xpod 自己的本地引擎。
- 以文件为内容权威，DB/RDF index 为全局语义索引。
- 直接以 RDF-3X target 作为主查询内核方向；当前 term-id quad index 只是过渡 baseline，不把它包装成 RDF-3X。
- Hexastore 只作为历史/对比参照，QLever 只作为后续执行层参考；三者不作为并列运行时组合。
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
| `ComunicaCompatibilityEngine` | 可选兼容层、测试 oracle、过渡 fallback；不是主路径。 |

第一阶段只实现 embedded 形态：`SolidRdfEngine` 直接作为 Xpod 进程内 RDF engine 接入 Components.js。当前阶段不新增 sidecar/backend selector、不暴露 Components.js backend 注册面，也不区分 cloud/local 的查询引擎类型；cloud/local 只允许在同一行为契约下替换持久化实现。

实现约束：

- `SolidRdfEngine` 的对外消费面必须同时容纳同步与异步实现，调用方只依赖 `RdfEngineLike`。
- local SQLite 仍可保持同步内部实现；cloud PostgreSQL 版可以异步实现同一契约，不要求把 SQLite 内核伪装成异步。
- `SolidRdfSparqlEngine`、`SolidRdfDataAccessor` 这类上层适配器只依赖行为契约，不直接依赖具体 SQLite 类。

同步/异步边界：

- facts 主路径必须同步可见。`put`、`replaceSource`、`deleteSource`、`delete`、`applyDelta` 返回成功后，同一个 `RdfEngineLike` 的 `scan` / `query` 必须能立即读到新的 facts。
- RDF-3X projection / graph stats 是异步派生层。写入只推进 facts `data_version` 并把派生层标记为 needs-refresh，不在请求路径自动重建 stats。
- `scan` / `query` 以 facts + covering index 为可用主路径，不能依赖 RDF-3X stats 已同步；当前 planner 可表达的 shape 可以直接走 PG facts SQL。
- `storageStats()` 只报告当前 facts 与 derived stats 的同步状态，不触发补建。`rdf3x.factsDataVersion`、`rdf3x.rdf3xFactsDataVersion` 和 `rdf3x.refreshLag` 必须直接来自 durable metadata；`rdf3x.syncedWithFacts=false` / `refreshLag>0` 是合法运行态。
- `refreshDerivedIndexes()` 是显式补建入口，供启动、维护任务、测试或运维调用。它可以从当前 facts 重建 `rdf3x_*` stats，但不是普通查询的隐式前置步骤。PostgreSQL backend 每次显式 refresh 都会同步执行 facts / RDF-3X stats 表的 planner stats refresh，并在返回值里暴露 `plannerStats.analyzedTables` 与耗时；即使派生 stats 已追上 facts、无需 rebuild，也不能跳过这个显式运维动作。
- SolidFS journal 只负责本地权威文件到 Pod HTTP / index syncer 的 outbox、replay 和 compaction；它不是 RDF-3X 派生索引新鲜度证明。即使 journal 已 replay 完，仍必须用 facts `data_version` 与 `rdf3x_metadata.facts_data_version` 判断派生索引是否 needs-refresh。
- SQLite/file-backed `SolidRdfEngine` 和 PostgreSQL `PostgresRdfEngine` 都不维护第二套内存 refresh guard；query readiness、refresh skip 和 storage stats 都直接读取 durable metadata。backend 差异只保留在同步/异步 executor 与 SQL 方言上。

当前决策口径：

- Xpod 的默认 RDF 引擎已经切到自有 `SolidRdfEngine`。local/cloud/xpod/bun profile 的 `DefaultSparqlEngine` 均指向 `SolidRdfSparqlEngine -> SolidRdfEngine`，结构化 LDP 写入默认走 `MixDataAccessor -> SolidRdfDataAccessor -> SolidRdfEngine`。
- RDF-3X target core 是 local 和 cloud 都必须具备的基础查询内核。
- 当前 `RdfQuadIndex` 不再继续扩写成“准 RDF-3X”；它只服务迁移、benchmark 和 fallback。
- `Rdf3xIndex` 是 first embedded slice：已覆盖 RDF-3X 数据布局、projection stats、permutation scan、基于 bound-slot fanout 的 connected BGP join order、term merge join、受控 index-only join，以及受控 single-pattern scan / count、object text contains/endsWith scan、同 pattern tuple VALUES scan、required BGP tuple VALUES join、OPTIONAL / UNION / dependent group 内部 BGP join、join count / basic numeric aggregate / grouped count / grouped numeric aggregate primary path；大多数 models 查询带 exact graph 或 graph prefix，因此这类 shape 在 scan/count/join 中优先以 `rdf_quads` facts source 收窄候选，而不是先扫三元组 permutation 再后置过滤 graph；六排列扫描复用 `rdf_quads_spog` / `rdf_quads_posg` 等 facts covering index，不再额外物化 `rdf3x_spo` / `rdf3x_pos` / `rdf3x_triple_membership` 这类事实副本；文件型 `SolidRdfEngine` 标准配置会自动把它接成 selective primary，仍保留 `RdfQuadIndex` 作为迁移、benchmark 和 fallback。
- `SolidRdfEngine` 已接入内部 `derivedIndexProfile`：`baseline` 只保留事实层 `RdfQuadIndex` baseline，`rdf3x` 会启用 `Rdf3xIndex` 并维护 projection / graph stats。文件型 `index: { path }` 标准配置默认进入 `rdf3x` profile 并启用 selective primary；`:memory:` 和外部传入的 `RdfQuadIndex` 实例不会隐式创建第二个连接，仍可用显式 `rdf3xIndex + rdf3xPrimary` 进入 primary。query 只有在 RDF-3X 当前可表达的 single-pattern scan/count 或 required BGP（可含无 `UNDEF` 且所有变量均由 required BGP 绑定的 tuple VALUES；pattern 只含 exact term、exact term `$in` / `$notIn`、graph prefix、object range、object text contains/endsWith，以及 term-type/language/datatype metadata filter）时，才把 scan / count / join / join count / basic numeric aggregate / grouped count / grouped numeric aggregate 下推到 `Rdf3xIndex`。object range 会对 typed numeric literal 走 numeric 语义，对其他 term 走 lexical 语义；object text contains/endsWith 走 `rdf_terms.normalized_text` candidate scan 并用原始 value 复验大小写语义。当前 index-only 只用于 `DISTINCT` term projection、无 graph 变量/graph 约束、无 pagination count 的 join；这种 shape 的 named graph multiplicity 对最终 term 集合无影响，所以可直接利用 facts covering index 执行，其他 shape 仍回到 facts source。OPTIONAL / UNION / dependent join 仍由 query layer 保持控制流语义，但其内部无 group-local `VALUES` 的多 pattern BGP 可走 RDF-3X join。未覆盖 shape 自动保持 `RdfQuadIndex` fallback，不暴露 backend selector。这个边界同样为未来 PostgreSQL 实现保留空间：同一行为契约下，`RdfEngineLike` 的具体实现可以异步落到 PG，而不改变上层 SPARQL / DataAccessor API。
- `PostgresRdfEngine` 的边界不同：PG facts table 是 baseline authority，PG SQL / RDF-3X planner 只是 fast path。RDF-3X 不能覆盖的 scan/query shape 必须直接基于 PG facts 做后置过滤和执行，或对缺失的 text/vector source 明确报错；不能创建隐藏 SQLite cache，也不能把 unsupported shape 静默丢给另一个持久层。
- `SolidRdfSparqlEngine` 的 compatibility fallback 已改为显式 opt-in；local/cloud 默认 `DefaultSparqlEngine` 不配置 fallback，因此 server-owned Pod 的 `/-/sparql` 默认不会把 unsupported shape 转给 Comunica。迁移测试、oracle 和外部 source 兼容路径仍可显式传入 `QuintstoreSparqlEngine`。
- QLever-style capability 是 cloud 更早需要吸收的增强能力，不是 cloud 的替代内核。
- 对外不暴露 “RDF-3X backend / QLever backend” 选择；即便后续引入 QLever，也只能作为 `SolidRdfEngine` 内部执行层、result table 或 cache layer。
- 不提供 “Hexastore / RDF-3X / QLever 三选一” 配置；用户和部署只面对一个 `SolidRdfEngine`。
- 存储不能按 “Hexastore + RDF-3X + QLever 全部常驻叠满” 理解。Pod RDF facts 只有一份权威数据；六排列是 facts 层 `rdf_quads` 的 covering index，RDF-3X 只额外维护 projection stats、graph stats、未来 result table / cache / text-vector 辅助结构。这些派生数据可删除、可重建、可按 local/cloud 资源预算关闭或延迟构建。

部署矩阵：

| 部署 | 必备查询内核 | 持久化差异 | QLever-style 能力 |
| --- | --- | --- | --- |
| local | `SolidRdfEngine` + RDF-3X target planner/index | SQLite / PGlite、本机可移动索引 | 可延后吸收 vocabulary/text/result-table 思路，不引入额外常驻服务 |
| cloud | 同一套 `SolidRdfEngine` + RDF-3X target planner/index | PostgreSQL / shared storage、租约、索引生命周期、Pod 迁移 | 更早吸收 result table、query cache、全文/RDF 一体化、高并发执行层 |

cloud/local 的差异只能体现在持久化、并发控制、租约、索引生命周期和部署形态上；查询语义、planner 能力和对外协议仍由同一个 `SolidRdfEngine` 行为契约约束。这里的 PostgreSQL 版不是 `PgQuintStore` 的复用，而是同一 `RdfEngineLike` 契约下的 RDF facts/index 实现。

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
同一份事实层，而不会把 RDF-3X / QLever-style 索引变成第二份内容事实。

索引补建不是 query-time adaptive indexing，也不需要做成在线动态加索引/热迁移系统。
Xpod 只支持代码定义好的 index profile：`baseline`、`rdf3x`、未来的 `text` /
`vector` / result-cache profile。profile 或 schema 版本变化时，可以直接丢弃本地
facts/derived 索引并从 SolidFS 权威文件或既有 facts 全量重建；不要求在旧索引上做
逐步补丁迁移。query planner 只能在当前 profile 已存在的索引和统计里选择执行路径和
join 顺序，不能因为某个查询临时在线新增一套物化结构。这样可以避免首个查询承担建
索引成本，也避免 cloud 多实例同时建索引导致锁竞争和不可预测的磁盘放大。

当前索引刷新/重建路径固定为以下几类，不做请求期动态创建索引：

- 旧 TEXT `QuintStore` 数据迁移到 term-id facts：使用
  `ShadowRdfQuintStore.backfillShadowIndex(...)` 分批回灌。
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
实现了 RDF-3X / QLever-style 能力就默认叠满所有物化结构。
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
| Hexastore | RDF 三元组多排列索引思路 | 只作为历史 `quints` 和 v0 索引的对比参照 | 不是 RDF-3X 的存储格式，不和 Comunica 对等 |
| RDF-3X | RDF database engine | local/cloud 共同需要的压缩排列索引、projection stats、merge join、join reorder、物理下推内核 | 替换 Comunica 主路径，而不是补在 Comunica 后面 |
| QLever | RDF/SPARQL engine 的执行层参考 | cloud 更早需要的 result table、全文/RDF 一体化、cache/vocabulary 加速方向；依附同一个 `SolidRdfEngine` 契约 | 不是公开 backend，也不是和 Comunica 协同执行 |

Xpod 的方向是用 `SolidRdfEngine` 逐步替换 Comunica 主路径，Comunica 只保留为
fallback / oracle / 过渡兼容层。`SolidRdfEngine` 自身不能被拆成 local/cloud
两套语义不同的 engine；RDF-3X target 是两端共同内核，QLever 风格能力
是 cloud 更迫切、但仍落在同一契约上的执行增强。

分层关系是：

```text
SPARQL / models DSL / app query
  -> SolidRdfEngine
       -> 自有 planner / executor / index
            current v0: term-id quad index baseline
            RDF-3X target: compressed permutations + projection stats + merge joins
            QLever: cloud-first 的 result table、全文/RDF 一体化、cache/vocabulary 思路
  -> ComunicaCompatibilityEngine 仅在显式配置时作为 oracle / migration / external-source 兼容层
```

因此 `RdfQuadIndex` 不是外接 Hexastore，也不是 RDF-3X 的原样复刻；它是
`SolidRdfEngine` 当前 v0 的 embedded baseline。`RdfQueryExecutor` 不是在
Comunica 上做增强；它是 `SolidRdfEngine` 内部替换 Comunica 主路径的执行层。
RDF-3X target 能力是两种部署都要持续内化的共同内核；
QLever 更像 cloud 侧在更大查询负载、并发和缓存需求下优先接入的内部加速层。
后续如果接入 QLever 或 RDF-3X 的具体实现，也只能作为 `SolidRdfEngine` 内部执行层替换，
不能变成对外并列 engine。

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
Hexastore-like 的 TEXT 多索引 compatibility store：它把 graph/source 和字符串存储
混在同一层，字符串在表和多个索引中重复，空间放大明显。它不是 RDF-3X 的过渡格式，
也不应该继续作为战略主存储强化。

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

因此实现优先级不是 “local 用 RDF-3X、cloud 用 QLever”。RDF-3X target 的字典、
压缩排列索引、projection stats、merge join 和 join/order/count 下推是两端都需要的
基础查询内核。cloud/local 只在持久化、并发控制、索引重建和 Pod 迁移上分化；
planner 能力和对外语义必须一致。

当前 `RdfQuadIndex` 的定位必须保持清楚：

- 它是 v0 embedded index，用 SQLite/PG 可表达的 term-id quad 表和 composite index
  快速承接现有查询，不是 RDF-3X。
- 它可以作为 benchmark baseline、迁移桥和 fallback，但不能把自身表结构定义成 RDF-3X 目标。
- 真正进入 RDF-3X 阶段时，必须把 RDF-3X planner、统计和执行边界独立出来；facts 可以继续复用 `rdf_quads` 和它的 covering index，但不能继续把 `RdfQuadIndex` 自身包装成 RDF-3X。

当前 first slice 是 `Rdf3xIndex`：复用现有 `rdf_quads` facts / covering index，并维护 RDF-3X stats，
文件型 `SolidRdfEngine` 标准配置会自动进入 selective primary；未覆盖 shape 在 engine 内回到 `RdfQuadIndex` baseline，不接公开 backend selector，也不会默认交给 Comunica。

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
  -> SolidFS sync journal
  -> SQLite/PG term/delta/version tables
  -> future sidecar loads mapped snapshot or streams delta
  -> query result returns through SolidRdfEngine internal adapter
```

如果 C++ sidecar 只能读本地 index 文件，Xpod 必须把这些文件视为可重建 cache，并用 DB 记录 index version、source hash、lease owner 和 rebuild state。真正权威仍是 SolidFS + DB journal。

第一阶段继续用 `RdfQuadIndex` / `RdfQueryExecutor` 做可控的 embedded backend。QLever 方向进入后续替换计划，而不是替代当前 SolidFS + shadow migration 路线。

吸收工程方向：

- RDF 查询和全文检索一体化。
- vocabulary 可压缩、可 on-disk / in-memory tradeoff。
- literal text index 可以从 RDF literals 构建，也可以从外部 text records 构建。
- query cache、materialized view、update persistence / replay 可以作为后续方向。
- 单机高效执行可以通过 Xpod 的 SQLite/PG backend 翻译为集群可共享状态。

QLever 支持 federation、Graph Store HTTP Protocol、updates 等完整能力，但 Xpod server 不把 federation 放进本地 Pod 查询热路径；update 能力也必须通过 Xpod 的文件权威和 delta/journal 协议落地。

### Cloud Product-grade RDF acceleration 路线

cloud 的当前路线是把产品级 RDF 查询体验落在 Xpod 自己的 `SolidRdfEngine` /
`PostgresRdfEngine` 内：事实源仍是 SolidFS 权威文件和 PostgreSQL facts 表，RDF-3X
stats、query result cache、planner stats 都是可删除、可重建的 derived space。

公开代码支持这几个 profile；cloud 默认仍只打开 `pg-hot-operators`，`pg-custom-index`
是部署侧安装 `xpod_rdf` native extension 后才会启用的可选 profile：

| Profile | 含义 | 默认用途 |
| --- | --- | --- |
| `baseline` | 只使用 facts 表和 RDF-3X derived stats | local / 测试 / 回退 |
| `pg-result-cache` | 在 baseline 上启用按 facts version 失效的查询结果缓存 | 重复列表页、上下文查询 |
| `pg-hot-operators` | 在 baseline + result cache 上标记并启用已验证的 PG SQL fast path | cloud 默认 |
| `pg-custom-index` | 在 `pg-hot-operators` 上要求 native extension 声明 `index.xpod_rdf_perm`，创建 shadow custom permutation indexes；当 extension 声明 `index.xpod_rdf_perm.scan_any` / `index.xpod_rdf_perm.scan_any.limit` / `index.xpod_rdf_perm.count_any` / `index.xpod_rdf_perm.distinct_any` / `join.required_bgp.native` / `join.required_bgp.order_page.native` / `join.slot_filter.native` / `join.subject_star` / `join.values.native` / `join.values.limit.native` / `aggregate.bgp_count` / `aggregate.subject_star_count` / `aggregate.bgp_group_count` / `aggregate.bgp_numeric` 时，单 pattern scan / 无显式排序的 limited scan / scalar `COUNT` / 单变量 `DISTINCT` / 受限 required BGP row stream / projected-order ordered-page BGP / graph-prefix slot filter / subject-star row stream / 受限 VALUES BGP / 受限 BGP count / subject-star scalar count / grouped count / grouped numeric aggregate 会调用 native `perm_index_scan_any(...)` / `perm_index_count_any(...)` / `perm_index_distinct_any(...)` / `bgp_join(...)` / `values_join(...)` / `bgp_count(...)` / `bgp_group_count(...)` / `bgp_numeric_aggregate(...)` | enterprise / 自托管 PG 扩展验证，不作为开源 cloud 默认 |

这些 profile 都是开源实现的一部分，不要求额外进程，也不要求用户选择查询 backend。对外
仍只有 `SolidRdfEngine` 行为契约和现有 `/-/sparql` 协议边界。

```text
SolidFS / journal
  -> PostgreSQL facts
       rdf_terms
       rdf_quads
       rdf_quads_* covering indexes
       rdf3x_stat_*
       rdf_query_result_cache
  -> PostgresRdfEngine
       RDF-3X planner stats
       PG SQL scan / BGP join / aggregate fast paths
       result cache by normalized query shape + facts data_version
       optional xpod_rdf capability probe / custom index shadow DDL gate
       optional native single-pattern scan / limited scan via xpod_rdf.perm_index_scan_any + heap recheck
       optional native single-pattern COUNT via xpod_rdf.perm_index_count_any
       optional native single-pattern DISTINCT via xpod_rdf.perm_index_distinct_any
       optional native exact-id required BGP via xpod_rdf.bgp_join
       optional native BGP ordered-page wrapper via xpod_rdf.bgp_join + rdf_terms outer order/page
       optional graph-prefix slot filters via join.slot_filter.native
       optional native subject-star BGP/count markers via join.subject_star / aggregate.subject_star_count
       optional native tuple VALUES BGP via xpod_rdf.values_join
       optional native BGP count / grouped count via xpod_rdf.bgp_count / bgp_group_count
```

实施顺序保持 benchmark-first：

1. 先用 PG facts / covering indexes / RDF-3X stats 实现 planner 与 executor fast path，
   验证 query shape、storage profile 和 p95 收益。
2. 再用表级 result cache 和 materialized result 思路覆盖重复 query、列表页、Agent context
   等高频路径，所有缓存都绑定 facts `data_version` 和 auth/cache scope。
3. 最后再评估 text/vector candidate generation、score fusion、template cache 等更高层的
   product-grade 查询能力；这些能力仍然挂在 `SolidRdfEngine` 内部，不改变 Pod 文件权威。

如果某个部署需要更强的查询执行器，正确做法是实现同一个 `RdfEngineLike` / Components.js
等位组件，并在部署配置里替换 `SolidRdfEngine` 的 engine 实例。公开仓库不为部署定制能力
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
| PG native custom index | 探测 `xpod_rdf` extension 和 `index.xpod_rdf_perm`，满足能力后创建六个 shadow `xpod_rdf_perm` permutation index，并把 `perm_index_stats(regclass)` 投影到 `storageStats().pgAcceleration.customIndexes`；`index.xpod_rdf_perm.scan_any` 已接入单 pattern exact / `$in` leading-prefix scan 并在 heap recheck 后分页，`index.xpod_rdf_perm.scan_any.limit` 已接入无显式排序的 limited scan gate 并用 `PostgresRdfNativeCustomIndexScanAnyLimit(...)` 标记 early-stop 候选，`index.xpod_rdf_perm.count_any` 已接入单 pattern、非 DISTINCT scalar count，`index.xpod_rdf_perm.distinct_any` 已接入单 pattern、单投影变量、exact / `$in` leading-prefix `DISTINCT`，`join.required_bgp.native` 已接入 2..8 pattern、最多 8 变量、无 VALUES/ORDER/GROUP/aggregate/distinct 的 BGP row stream；`join.required_bgp.order_page.native` 已接入第一版 projected-order ordered-page gate：ORDER BY 变量必须在 project 中，`bgp_join(...)` 先返回 BGP 行流，外层 JOIN `rdf_terms` 按 projected order 变量排序并应用 LIMIT/OFFSET，因此语义正确但还不是真正 extension-level top-N early-stop；`join.subject_star` 已接入 3..8 pattern 共享同一 subject 的 BGP row stream，使用同一 `bgp_join(...)` ABI 并额外标记 `PostgresRdfNativeCustomIndexSubjectStarJoin(...)`，缺能力时回退 generic native BGP；`join.values.native` / `join.values.limit.native` 已接入 1..8 pattern、最多 8 变量、用户 tuple VALUES source 的 required BGP row stream；bounded graph-prefix 会先展开实际 graph ids，再作为 `join.slot_filter.native` slot-level allowed-set 传给 `bgp_join(...)` / `values_join(...)` / native aggregate ABI，避免把 filter 编成 hidden tuple `VALUES` 并引入 `29x29` 这类组合成本；`aggregate.bgp_count` 已接入 2..8 pattern、最多 8 变量、无 GROUP/ORDER/HAVING/pagination 的 `COUNT(*)` / `COUNT(?x)` / `COUNT DISTINCT ?x`，并支持用户 VALUES source 与 graph-prefix slot filter；`aggregate.subject_star_count` 已接入 subject-star scalar count，使用同一 `bgp_count(...)` ABI 并额外标记 `PostgresRdfNativeCustomIndexSubjectStarCount(...)`，缺能力时回退 generic native BGP count；`aggregate.bgp_group_count` 已接入 1..8 pattern、最多 8 变量、GROUP BY 1..8 变量、COUNT / COUNT DISTINCT，HAVING / ORDER / LIMIT 由 xpod 在 native 分组结果上做语义收尾，subject-star shape 会额外标记 `PostgresRdfNativeCustomIndexSubjectStarGroupCount(...)`；`aggregate.bgp_numeric` 已接入 1..8 pattern、GROUP BY 最多 8 变量、单 numeric 变量上的非 DISTINCT `SUM/AVG/MIN/MAX` 与非 DISTINCT `COUNT`，HAVING / ORDER / LIMIT 由 xpod 在 native 分组结果上做语义收尾，subject-star shape 会额外标记 `PostgresRdfNativeCustomIndexSubjectStarNumericAggregate(...)` | 需要部署匹配 PG major/arch 的 extension artifact；native capability 不等于自动 active operator；graph-prefix graph id 展开和用户 VALUES Cartesian rows 都有上限，超限回退；2026-06-09 真实 PG17 rerun 证明 exact-graph ordered-page wrapper 有 p95 收益，但仍不是 extension-level top-N early-stop，且多类 graph-prefix / VALUES / count shape 会退化 | 可选，不满足能力时回退；满足能力后仍按 shape/cost gate |
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

这一段是后续逐项落地的执行 spec。它不表示要完整复刻 QLever；所有能力都必须挂在
`SolidRdfEngine` 行为契约下，继续以 SolidFS 文件和 RDF facts 为权威，derived space
只做可删除、可重建的查询加速。

P0 先做用户能明显感知或能保护生产正确性的能力：

| 能力 | 当前状态 | 第一版落地要求 | 验收证据 |
| --- | --- | --- | --- |
| Query template cache | 第一版已落地：bounded in-memory template cache，按去值后的 query AST 记录 hit/miss/eviction；已补 idle TTL、内存 bytes 估算，并把 template bytes 纳入 `storageStats().derivedBytes`；materialized result cache 行会记录并校验 `template_key`，plan / explain 会暴露 `PostgresMaterializedResultTemplate(...)` 与 `cache.materialized.templateKey`，让物化入口绑定到同一 query template key；RDF-3X SQL 编译路径会把实际生成的 compiled SQL physical shape 记录到同一 template entry，plan 暴露 `PostgresCompiledSqlTemplateHit/Miss(...)`，`storageStats().queryTemplateCache` 暴露 compiled SQL shape 数量和 hit/miss/eviction 计数 | 当前不冻结跨参数 join order，只在相同 template key + 相同 SQL physical shape 下复用可观测入口，避免改变查询语义或 cost 决策 | `storageStats()` 暴露 template cache 统计；重复 models query 的 plan 标记 template hit；TTL 过期后同模板 query 重新 miss 且 evict 旧 entry；materialized result hit/store 能证明使用同一 template key；同模板不同参数的 RDF-3X 查询能命中 compiled SQL template marker |
| Materialized result table | 第一版已落地到 PG：`RdfQuery.cache.materialized` 显式 opt-in，独立 `rdf_materialized_result_cache` 表绑定 materialized key、query shape、facts version、结构化 access scope、TTL 和 max entries；命中时不再执行 RDF join，也不会重复写普通 result cache；PG models benchmark 已补 latest-message、thread-context、run-steps、due-schedule、provider/model/credential、settings keyset、active session hydration、AI embedding config 和 vector indexed-file/store 9 个 warm-path materialized case；ChatKit thread history 产品读路径已从手写 SPARQL 收回到 models/drizzle-solid，并在 `SolidRdfSparqlEngine` 边界对 `Message.thread` / `sioc:has_container` 形状自动挂 `chatkit/thread-history/<thread>/<query>` materialized key，覆盖 ChatKit items 和 Managed Run conversation assembly；业务统计页这类 aggregate/groupBy/having 查询会按 message/thread、run priority、provider credential 等稳定形状自动挂 `models/stats/<view>/<query>` materialized key；settings/provider/model/credential 这类 models/drizzle-solid 查询会按 Provider/Model/Credential 类型列表或 provider-model-credential 关系 join 自动挂 `models/settings/<view>/<query>` materialized key；非 thread-history 的 active session + chat/thread Agent context hydration 查询会自动挂 `models/agent-context/<view>/<query>` materialized key；RDF 运维统计页本身走 `storageStats()`，不进入 query result materialized cache；`storageStats()` 已暴露 result/materialized process-local hit/miss/refresh/store/bypass/disabled 计数，慢查询快照会记录 result/materialized cache status、key、templateKey、factsDataVersion、TTL、quota 和 store outcome，stats API 与 dashboard RDF 页已支持按 principal/basePath/permissionVersion 搜索 access scope，并展示 result/materialized scope count、payload、entries、scope pressure 和 hit rate | 后续继续按真实负载补更细的产品视图 drill-down | cache scope 不串用户；facts version bump 后旧 materialized result 不可复用；显式 scope invalidation 会清 materialized cache；max entries 可淘汰；ChatKit thread-history、business stats、settings product-view 和 Agent context hydration query 会生成稳定 materialized key，且 selector 可关闭；dashboard 可按 auth/cache scope 定位 materialized payload、entries 与 hit rate；慢查询可直接定位导致 miss/store 的 materialized key 和 facts version |
| Text / RDF / vector 融合查询 | 第一版本地和 PG gate 已落地：`RdfQuery.textSearch[]`、`vectorSearch[]` 和 required RDF BGP sources 进入同一个 planner；`caseProfile=fusion` seed 会写入文本 chunk / embedding chunk，并用 Agent context 查询验证 text/vector 候选与 message/thread/workspace RDF facts 交集；本地 query layer 已支持 numeric BIND 加权 `fusionScore` 并按数值排序 rerank；`applyRdfAccessScope` 会把 `allowedGraphUrls` / `deniedGraphUrls` / `deniedGraphPrefixes` 投影成 search source allow/deny 条件，纯 text/vector 查询和融合预筛都不会先召回不可读 source；PG engine 可配置同一套 `RdfTextIndexLike` / `RdfVectorIndexLike`，第一版在 RDF-3X 不覆盖 search source 时走 `PostgresFactsScan + TextSearch + VectorSearch + PostgresFactsBind + PostgresFactsSort`；`PostgresRdfTextIndex` 已把 text source / chunk / term posting 持久化到 PG/PGlite，复用 SQLite `RdfTextIndex` 的 chunk、normalize、term、score 和排序逻辑，并可被 `PostgresRdfEngine` 作为 async text index 使用；`PostgresRdfVectorIndex` 已把 vector source / chunk / component posting 持久化到 PG/PGlite，复用 SQLite `RdfVectorIndex` 的 embedding normalize、metric score、filter、排序和 path 解析逻辑，并可被 `PostgresRdfEngine` 作为 async vector index 使用；cloud 默认配置已生成并挂载 `PostgresRdfTextIndex` / `PostgresRdfVectorIndex` 组件，二者与 `PostgresRdfEngine` 共享 `sparqlEndpoint` PG 连接；`MixDataAccessor` 已补 `textSearchIndexingEnabled` 写入开关，cloud 默认打开，RDF PUT、SPARQL 本地 authority patch、SolidFS 回写和删除都会通过 `SolidRdfDataAccessor -> RdfEngineLike.indexTextSource/deleteTextSource` 维护 line-addressable RDF authority 文本 source；`RdfSearchIndexingService` 已作为产品层 vector 文档索引入口落地，使用当前用户 Pod `AIConfig.embeddingModel` 和 AI credential 调 `EmbeddingService.embedBatch`，再写入同一个 `RdfEngineLike.indexVectorSource`，缺 RDF/vector engine、缺 AI config 或缺 embedding model 时返回可解释 skipped 状态；`RdfSearchIndexingSolidFsSyncer` 已接入 Pi driver 默认 SolidFS commit 路径，在 Pod workspace 写入 Markdown/text/line-addressable RDF 后复用当前 Run context 触发 vector source 更新，删除文件时清理 vector source，provider/indexing 异常默认不阻塞 authority commit；产品 Run 边界已接入 `RunContextRetriever` / `retrievedContext`，Chat、Task 和 durable Inngest worker 都会在恢复 Pod 状态后、启动 runtime 前检索当前上下文，API container 在 cloud + PG facts storage 下会默认创建共享 `PostgresRdfEngine`、`RdfRunContextRetriever` 和 `RdfSearchIndexingService`；默认产品 wiring 会先做 text/RDF 检索，并在用户 Pod `AIConfig.embeddingModel` 存在时用同一 Pod AI credential 调用 `EmbeddingService` 生成 query embedding，追加 vector search 和 `fusionScore` rerank；没有显式 embedding model 时保持 text-only，不把 chat default model 当 embedding model；产品 `RdfRunContextRetriever` 默认 fail-closed，缺 text/vector index 会把 engine 的可解释错误抛回 Run，只有显式 `failOpen` 的可选路径才静默跳过；Pi driver 会把检索片段投影成非命令型上下文消息；search index 上层依赖已收敛到 `RdfTextIndexLike` / `RdfVectorIndexLike`，`SolidRdfEngine`、`PostgresRdfEngine`、`RdfQueryExecutor` 和 SolidFS syncer 不再绑死 SQLite 实现；`RdfIndexSolidFsSyncer` 已支持在 direct workspace commit 时选配 `vectorIndex`，并要求显式 `vectorizeText`，避免默认同步路径偷偷绑定某个 embedding provider | 后续补外部 vector backend 替换 | `agent context text vector fusion query` 返回 2 个命中，local plan 同时出现 `TextSearch(...)`、`VectorSearch(...)`、RDF `IndexScan(...)`、`Bind(?fusionScore:=...)` 和 `Sort`；PG plan 出现 `PostgresFactsScan(...)`、`TextSearch(...)`、`VectorSearch(...)`、`PostgresFactsBind(...)` 和 `PostgresFactsSort(...)`；PG text index 覆盖 markdown chunk、source 替换、删除、workspace/source allow-deny filter、term stats 和 async `PostgresRdfEngine` textSearch join；PG vector index 覆盖 cosine/dot/euclidean metric、source 替换、删除、workspace/source allow-deny filter、component backfill、model stats、cardinality estimate 和 async `PostgresRdfEngine` vectorSearch join；MixDataAccessor 集成测试覆盖 cloud-style RDF authority text indexing 与删除清理 search source；RdfSearchIndexingService 测试覆盖 Pod AI credential 下的 vector source 写入、从 text 生成 chunk/sourceHash、空文本清理 stale vector chunks、缺 embedding model 不写和删除 source；SolidFS syncer test 覆盖 Markdown commit 写入 vector index、删除 source 清理 vector index、缺 vectorizer 时 fail fast；RdfSearchIndexingSolidFsSyncer 测试覆盖 SolidFS change 到产品层 vector indexing 的 Pod context/source/text 映射、显式 resource source、删除清理、缺 context 跳过和 indexing failure 不阻塞 commit；cloud config test 证明 `PostgresRdfEngine.options_textIndex/options_vectorIndex` 指向 PG search index 组件，`MixDataAccessor.textSearchIndexingEnabled` 默认打开；API container test 证明 cloud PG 会把同一个 `RdfRunContextRetriever` 接到 Chat、Task 和 durable Run worker，并创建同边界的 `RdfSearchIndexingService` 且传给 Pi runtime driver，local/sqlite 不误启用，Pod `AIConfig.embeddingModel` 存在时会调用 `EmbeddingService` 并生成 `vectorSearch`，没有 embedding model 时保持 text-only；access-scoped 纯 text/vector 查询只返回 allowed source；结果按 `fusionScore DESC` 排序；缺 text/vector index 必须显式报错；RdfRunContextRetriever service test 覆盖缺 text index 默认抛错和显式 failOpen；Chat/Task service test 证明 retriever 输出会进入 `RunExecutionInput.retrievedContext`，Pi projection test 证明上下文会进入 fresh pi session；接口整理通过 text/vector/syncer/query executor regression 与 `bun run build:ts` |
| Ordered-page / keyset join | 第一版 benchmark gate 已落地：消息流 `createdAt < cursor + ORDER BY createdAt DESC + LIMIT`、任务调度 `nextRunAt` keyset continuation、settings `settingKey` keyset continuation 都会要求 range/order/limit 保持在 SQL self-join / RDF-3X join 内；`pg-custom-index` 的 `join.required_bgp.order_page.native` 已接入第一版 cutover gate，当前只支持 ORDER BY 变量在 project 中的 required BGP，并通过 native `bgp_join(...)` 行流外包 SQL `rdf_terms` 排序分页；models extreme profile 已补 `extreme native exact graph ordered-page query`，用 `native-stress.ttl` exact graph 验收该 native marker；2026-06-09 真实 PG17 baseline / hot / custom rerun 显示 exact-graph ordered-page p95 为 `18 ms` / `23 ms` / `14 ms`，公开 hot profile 不是 ordered-page cutover 依据，custom wrapper 有收益但仍不是 extension-level top-N early-stop | 后续补真正 extension-level ordered early-stop、非 projected order variable 支持，以及 xpod models cutover gate | benchmark 覆盖 ordered page correctness、稳定 cursor、任务调度 continuation、设置列表 continuation、p95 对比；mock/real extension gate 均能命中 `PostgresRdfNativeCustomIndexBgpOrderPage(...)`；native capability 缺失时必须回退 RDF-3X ordered join；公开 hot profile 慢于 RDF-3X 时不能切默认，custom 也必须按 shape/cost gate |
| Incremental derived stats | PG 第一版已落地：写入路径记录 durable dirty graph / pair / term projection key，`refreshDerivedIndexes()` 默认只重算 dirty projection row；PG facts 侧已补 `rdf_dirty_sources` source-level queue，带 source 的 put/replace/delete 会登记待维护 source，refresh 成功后 drain 并在 `sourceQueue` 结果里报告 pending/drained 数；source queue drain 已按 refresh 开始时的数据库 `changed_at` cutoff 删除，且 dirty source 写入和 cutoff 都用 `clock_timestamp()` 而不是事务级 `NOW()`，refresh 期间新写入或被更新到 cutoff 之后的 source 会保留到下一轮维护，避免并发写入被误清；`refreshDerivedIndexes({ maxDirtySources })` 支持按最旧 `changed_at, source` 有界 drain，`PostgresRdfEngine.maintainDerivedIndexes()` 可通过 `maintenanceSourceBatchSize` 控制每轮 source queue drain 数，cloud 默认每 60 秒最多 drain 256 个 source，手动 refresh 不传 batch 时仍保持一次 drain 完；`bun run benchmark:rdf-models:pg` report 已新增 `refreshBenchmark`，记录 refresh wall-clock duration、planner stats duration、rebuild mode、dirty graph/pair/term 数和 source queue pending/drained 数，CLI summary 也直接打印 refresh duration / rebuild mode / source queue；benchmark 可选 `refreshMutationSources` / CLI `--refreshMutationSources=N` 已能在 seed refresh 后写入 N 个 source，再记录 `postWriteRefreshBenchmark` 的 mutation source、dirty pending、incremental refresh duration、rebuild mode 和 source queue drain 摘要；`postWriteRefreshBenchmark.matched/failedReasons` 会校验 pending/drained source、synced、incremental rebuild 和 facts version，并参与 CLI 非零退出 gate；`storageStats().rdf3x.pendingSources` 与 dashboard RDF-3X/生命周期区已能显示当前待维护 source 数；`PostgresRdfEngine.maintainDerivedIndexes()` 已补同库 lease，cloud 配置通过 `options_maintenanceIntervalMs=60000` 启动后台维护循环；SQLite/file-backed `Rdf3xIndex` 第一版也已通过 `rdf_quads` trigger 记录 dirty graph / pair / term key，默认维护刷新走 incremental，`refreshDerivedIndexes({ mode: 'full' })` 保留全量 repair path；dirty 信息缺失时自动回退全量 rebuild | 后续用真实 large / high-write 数据继续校准 refresh 阈值和慢查询运维面板细节 | 写入高频 source 后 stats synced；增量 refresh 后与 full repair stats 一致；缺 dirty 信息不误报 synced；同一 source 连续写入只保留一条维护队列记录，refresh 后 pending source 被 drain；storageStats/dashboard 能在 refresh 前看到 pending source 数并在 refresh 后归零；cutoff 之后的新 dirty source 不会被本轮 refresh 误 drain；另一个 worker 持有未过期 lease 时维护 cycle 不抢跑；配置 source batch 后维护 cycle 每轮只 drain 指定数量，剩余 source 保留到后续 cycle，且不重复 rebuild 已同步的 RDF-3X stats；benchmark report 必须包含 refreshBenchmark duration、planner stats 和 sourceQueue 摘要；启用 refresh mutation benchmark 时必须包含 postWriteRefreshBenchmark 的 mutation source、pending/drained 和 incremental rebuild 摘要 |
| ACL/ACR-aware cache lifecycle | 第一版已落地到 PG result/materialized cache：`RdfQuery.cache.scope` 支持结构化访问 scope，包含 principal、base path、mode、authorization model、权限版本和 allow/deny graph 列表；`RdfAccessScope` 不再拼裸字符串；PG result cache identity 是 `query_shape cache_key + scope_hash + facts_data_version`，materialized cache identity 是 `materialized_key + scope_hash + facts_data_version`，cache table 同时记录 scope 元信息并提供 exact scope invalidation 入口；cache row 会持久化 `scope_allowed_graph_urls` / `scope_denied_graph_urls` / `scope_denied_graph_prefixes`；PG 维护可重建的 `rdf_access_control_overrides` resource override index，解析 WebACL `acl:accessTo` / `acl:default` 和 ACP `acp:accessControl` / `acp:apply` 的真实 target resource，并记录对应 access-control sourceVersion；`.acl` / `.acr` 写入会优先按 override target、graph scope 和已知 sourceVersion/permissionVersion 重叠删除 cache，没有显式 target 或版本未知时才回退 access-control resource path / 全版本保守推导；无 allow-list 的旧/宽 scope 仍按 basePath overlap 保守删除，有 graph scope 的行会按 allow/deny/prefix 与 affected base path 重叠删除；写入只推进 facts version，旧 facts version cache 不会命中，但不再由写入路径全表删除；result/materialized cache 已有 TTL、entry count 和 payload bytes quota，template cache 已有 idle TTL、entry count 和 bytes 估算；`derivedCacheMaxBytes` 第一版会按统一 LRU 预算淘汰 result/materialized/template 三类可重建 cache；`derivedCacheScopeMaxBytes` 会按 access scope + facts version 限制 result/materialized 共享 payload，淘汰时按 cache key + scope + facts version 删除精确 row；`storageStats().accessControlOverrides` 暴露 override index entry/bytes；`storageStats().derivedCache` 已暴露 `cachePressure`、`largestScopePressure`、top scope drill-down 和按 cause 聚合的 process-local eviction 计数；stats API 支持 cache scope 服务端过滤，dashboard RDF 页已展示 result/materialized scope count、最大 scope、payload bytes、scope 明细、scope 搜索和 eviction breakdown | 当前不把授权判断下沉到 RDF 层，只用 sourceVersion/permissionVersion 做可重建 cache 的清理收窄；版本缺失时保持正确性优先的宽失效 | Alice/Bob/anonymous 查询不串 cache；权限版本变化不命中旧 cache；显式 scope invalidation 后旧 cache 不再命中；ACL/ACR source 写入后相关 scope 被清理，无关 graph-scoped cache row 不被删除，显式 ACP/WebACL target 不会误删同容器 sibling graph cache，已知 sourceVersion 只清对应 permissionVersion 和未版本化 cache，下一次读取会按新 facts version 重新 miss/store；payload bytes、scope bytes 或统一 derived cache bytes 超限后会淘汰旧 row / template，并能从 `derivedCache.evictions` 看见淘汰原因；RDF stats 能按 principal/basePath/permissionVersion 定位 top cache scope |

P1 做 planner 稳定性、迁移效率和运维可解释性：

| 能力 | 当前状态 | 第一版落地要求 | 验收证据 |
| --- | --- | --- | --- |
| Cost model / histogram | 第一版 stats surface 已补齐：SQLite/file-backed 与 PG facts stats 都通过 `storageStats().facts` 暴露 literal datatype、graph、predicate、predicate/object、subject/predicate 热点分布；PG `refreshDerivedIndexes()` 仍会 `ANALYZE` facts 与 RDF-3X stats 表；PG `metrics.explain.planner` 已把命中当前 query exact graph/predicate/predicate-object/subject-predicate 的 histogram hint 接入 reason、estimate input 和 `histogramHints`，cache hit 路径不拉 histogram；slow-query ring 也会保存当次 `histogramHints`，dashboard 最近慢查询行显示 histogram hint 数量和摘要；PG grouped numeric aggregate 已补第一版 cost cutover，native numeric operator 未命中、所有 join source 估算都低于低基数阈值且没有 graph-prefix fanout 时才切到 facts path，并用 `PostgresNumericAggregateFactsCutover(...)` 和 `numeric-aggregate-cost-cutover` 标记；PGlite medium/extreme baseline gate 会让 graph-prefix grouped numeric aggregate 和 high-fanout exact graph grouped numeric aggregate 留在 RDF-3X aggregate，只让 provider credential 这类低基数配置聚合显式 facts cutover | 后续把 histogram 从可观测 reason 继续接入更多 native/RDF-3X/facts 的 cost-based cutover，并补 join fanout / skew benchmark | slow query plan 和 `storageStats().slowQueries.entries[].histogramHints` 能解释当前 query 用到了哪些 histogram 输入；dashboard 慢查询行能直接看到 histogram hint 数量；provider credential fail-count aggregate 命中 facts cutover；high-fanout exact graph grouped numeric benchmark 命中 `PostgresRdf3xGroupAggregate` 或 native `aggregate.bgp_numeric`；2026-06-09 PGlite medium/extreme baseline gate 19664 quads、11 个 query case plan matched，graph-prefix grouped numeric aggregate 命中 `PostgresRdf3xGroupAggregate`；benchmark 覆盖高偏斜数据 |
| Bulk load + delayed index build | 第一版已落地：PG custom-index profile 支持启动时延迟创建 native permutation indexes，导入完成后显式 `ensurePgCustomIndexes()` 再进入 native cutover；PG facts 写入已把 dirty projection queue 改成数组 staging / `UNNEST` bulk insert，term dictionary 和 `rdf_quads` 小批仍走数组 `UNNEST`，大批会先写入 transaction-local temp staging table 再一次性 upsert 到 facts，并对 batch 内重复 quad 去重，避免 bulk seed 按 quad 逐条维护 native/custom index 或生成超长 `VALUES` SQL；PG models benchmark 支持 `concurrency` consistency gate，会用消息分页、任务调度 keyset、settings keyset、provider/model/credential ordered join 的串行结果作为基线，再并发复跑并校验 plan / row count / checksum / ordered checksum；benchmark report 必须带 `refresh.rdf3x.plannerStats.analyzedTables` 与 `refreshBenchmark.durationMs`，证明 seed 后执行了一次 `refreshDerivedIndexes()` / `ANALYZE` 且记录 refresh wall-clock 成本；2026-06-09 真实 PG17 medium/extreme baseline、公开 hot profile 与 custom profile 已用 `--concurrency=4` 通过一致性 gate | 后续补真实 PG COPY stream，以及真实 PG large / 更高并发 benchmark | benchmark 可选择延迟 custom-index build；延迟期间 native-only operator 不 active、不会 500；ensure 后 6 个 custom permutation index 创建并恢复 native operator；bulk seed 只发固定批次数量的 term/quad insert，1300 quad smoke 仍保持单条 quad bulk insert；超过 staging 阈值时会创建 `rdf_terms_bulk_stage_*` / `rdf_quads_bulk_stage_*` temp table、从 staging upsert 到 facts 并最终 drop；开启 `--concurrency=N` 时 report 会暴露 `concurrencyGate`，并发复跑不允许串结果或掉 plan；2026-06-09 PGlite medium/extreme baseline gate 在 UNNEST 写入路径下 19664 quads、2 个 scan case、11 个 query case plan matched，`rdf3x.syncedWithFacts=true`；真实 PG17 `--concurrency=4` baseline/hot/custom rerun 同样 plan matched；million-scale gate 仍需重跑 |
| Subject-star / star join operator | 第一版已落地为可观测 gate：local `RdfQuadIndex` 和 PG RDF-3X join 会识别 3+ pattern 共享同一 subject 的 star BGP，并在 plan 中标记 `SubjectStarJoin(...)` / `PostgresRdf3xSubjectStarJoin(...)`；默认 models benchmark 已覆盖 Agent thread context 和 run state center，extreme benchmark 覆盖 8-pattern message star；2026-06-09 真实 PG17 baseline / hot / custom rerun 证明 marker 稳定，8-pattern graph-prefix star p95 为 `175 ms` / `139 ms` / `248 ms`，exact-graph 8-pattern star p95 为 `66 ms` / `62 ms` / `34 ms`；`pg-custom-index` 已把可选 `join.subject_star` / `aggregate.subject_star_count` 接到同一 gate，分别标记 `PostgresRdfNativeCustomIndexSubjectStarJoin(...)` / `PostgresRdfNativeCustomIndexSubjectStarCount(...)`；缺专用能力时回退 RDF-3X，不再回退 generic native BGP / BGP count；grouped count 第一版保持 RDF-3X，grouped numeric aggregate 可复用现有 `bgp_numeric_aggregate(...)` ABI，在 subject-star shape 下额外标记 `PostgresRdfNativeCustomIndexSubjectStarNumericAggregate(...)`，让 planner/explain/benchmark 能区分 subject-star 聚合形状 | exact-graph subject-star 可以作为 native cutover 候选；graph-prefix subject-star 仍保持 RDF-3X / hot path，除非后续 cost model 证明收益；如果需要更强 early-stop，再增加新的 extension ABI | subject-star benchmark 命中专门 plan marker，专用 native capability 命中时使用专门 marker，缺 capability 时回退 RDF-3X；grouped count 不走 native，numeric subject-star 聚合仍走现有 native aggregate ABI 且语义与 RDF-3X baseline 一致；native extension p95 已证明 shape 差异明显，不能把 subject-star 能力整体默认切入 |
| Native operator cutover 策略 | 第一版 explain 已能区分 capability 缺失和 capability 已激活但未被选中的 native 候选：当 query 具备 `pg-custom-index` native 候选、最终却走 RDF-3X / facts 时，`metrics.explain.planner.rejectedNativeOperators` 会记录 capability 和 `shape-gate` / `cost-cutover-*` reason；slow-query ring 也会保存 `rejectedNativeOperators`，dashboard 最近慢查询行显示被拒绝 native operator 数量和摘要；native operator 仍按 shape/cost gate 启用，不能只看 capability 存在；2026-06-09 真实 PG17 baseline/hot/custom rerun 显示 custom 命中 13 个 native operator marker，但 graph-prefix scan/star、VALUES、count distinct、grouped count 和并发 graph-prefix case 都慢于 RDF-3X / btree baseline，只有 exact-graph star、exact-graph ordered-page、grouped numeric aggregate 明显收益；第一版 cost gate 已落地：保留 exact-graph subject-star join/count、exact-graph ordered-page wrapper、single-pattern exact scan/count/distinct 和无 VALUES 的 grouped numeric aggregate；graph-prefix scan/count/join、VALUES join、generic BGP native、BGP count/count distinct、grouped count 统一回退 RDF-3X / PG SQL，并通过 `native-operator-cost-cutover` 暴露拒绝原因 | 后续继续把真实 PG benchmark 扩到 large / higher-concurrency，并在新的 native ABI 加入前先补 shape benchmark 和 fallback assertion | metrics 和 `storageStats().slowQueries.entries[].rejectedNativeOperators` 标记 rejected native reason；dashboard 慢查询行能直接看到 native rejection 数量；真实 PG benchmark 不因 native profile 退化；profile/capability active 不能单独作为默认 cutover 条件；graph-prefix/count/VALUES/grouped-count negative case 不能命中 native marker，exact-graph star/order/numeric positive case 仍能命中 native marker |
| Unsupported query boundary | 第一版已落地：server-owned Pod 默认不配置 compatibility fallback，`SolidRdfSparqlEngine` 对 unsupported query shape 返回 `UnsupportedSparqlQueryError`；无 fallback 时用户可见文案统一为 `Embedded SPARQL engine cannot execute <operation>: ... not supported by the embedded RDF engine`，ACL/ACR 收紧 scope 下文案会说明 restricted scope，不再泄漏 “fallback to compatibility engine” 这种过期执行心智；`UnsupportedSparqlQueryError` 已带稳定 `code`、`capability`、`hint`，并已把 rewrite hint 细化到 subquery、property path、default graph / graph variable / graph scope、embedded update、CONSTRUCT、DESCRIBE、wildcard projection、HAVING、GROUP BY、aggregate、VALUES、BIND、MINUS、FILTER EXISTS、OPTIONAL、UNION、FILTER、function 和 RDF-star 等常见 unsupported shape；`UnsupportedSparqlQueryError.correction` 与 JSON `{ error.correction }` 已按 capability 暴露稳定 `primaryAction` / `availableActions` / `target`，覆盖 rewrite、materialize intermediate、constrain graph scope、write API 和 trusted external executor 路由；`SubgraphSparqlHttpHandler` 默认保持 text/plain 兼容，在 `Accept: application/json` 时返回结构化 `{ error }`；unsupported shape 映射为 400，禁用的 federation/SERVICE 映射为 403 且返回 `route_external_executor` correction | 后续接入具体 UI 按钮 / Agent 自动改写策略；HTTP/API 合约层不再要求客户端解析自然语言 hint | unsupported subquery/property-path/VALUES/BIND/MINUS/EXISTS/aggregate/HAVING/DESCRIBE/function 等 shape 在无 fallback 时返回 400 且错误文案说明 embedded engine 不支持；JSON 请求返回 `rdf.sparql.unsupported_query_shape`、具体 capability、hint 和 correction；adapter 单测覆盖真实 compile path 的 capability/hint/correction 输出；HTTP handler 单测覆盖 unsupported 与 SERVICE federation 的结构化 correction；`onFallback` 不被调用、fallback metrics 不增长；restrictive ACL/ACR scope 不调用 fallback；SERVICE federation 不进入 fallback |
| Explain / observability | 第一版已落地到 PG query metrics：`metrics.explain` 结构化输出 engine、facts version、derived profile、template/result/materialized cache 状态、结构化 access scope、acceleration/fallback 摘要、planner histogram hints、rejected native operators、runtime 扫描/返回行数、RDF-3X stale stats 和 slow-query 诊断；`storageStats().rdf3x` 暴露 facts / RDF-3X facts version、refresh lag 和 synced boolean；`storageStats().slowQueries` 暴露 bounded process-local 最近慢查询 ring，记录 query/cache key、selected path、reason、runtime、stale stats、planner histogram hints、rejected native operators、cache scope 摘要、result/materialized cache key 与 facts version、derived cache pressure / eviction 摘要和 acceleration 摘要，不写入 Pod/RDF durable 状态；`storageStats().lifecycle` 暴露 PG engine open count、driver、最近一次冷启动总耗时、ready 时间、失败摘要，以及 executor / text-index / vector-index / term-dictionary / schema / acceleration-probe / custom-index / maintenance-scheduler 分阶段耗时；`storageStats().queryResultCache` / `materializedResultCache` 已暴露 process-local hit/miss/refresh/store/bypass/disabled 计数；API 已暴露鉴权版 `GET /v1/rdf/stats` 和 dashboard 只读代理 `GET /api/admin/rdf/stats`，stats service 已进入 API container 并在 cloud PG 下复用同一个共享 `PostgresRdfEngine`，不会在 handler 中为每个 stats service 临时创建第二套 PG engine；cloud dashboard RDF 页已展示 refresh lag、cache/storage、PG acceleration、auth/cache scope drill-down、scope 搜索、eviction breakdown、cache hit rate、最近慢查询 cache target、histogram/native rejection 摘要、行级 cache pressure / scope pressure / eviction 和 RDF engine lifecycle / cold-start 指标；原有 plan 字符串继续保留给 benchmark gate | 后续把 histogram / scan rows 真正接入 cost-based cutover，并继续补更细的冷启动阶段指标和启动期 slow path 关联 | 慢查询报告可直接定位 fallback / cache miss / materialized miss-store / stale stats / refresh lag / cache pressure / cache eviction / 扫描放大 / histogram 输入 / native operator cutover；dashboard 可直接读取最近慢查询快照、top cache scope、cache hit rate、engine ready 时间和 cold-start 最慢阶段 |
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
   models/drizzle-solid，不再手写 SPARQL 绕开 RDF query 层；`SolidRdfSparqlEngine` 已对
   thread-history 形状和 settings Provider/Model/Credential product-view 形状自动挂
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
- QLever: https://github.com/ad-freiburg/qlever
- QLever docs: https://docs.qlever.dev/
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

## 默认图语义

默认图不是应用侧随手传不同值的问题，应由 RDF engine 在协议边界按请求目标统一归一化。
应用侧只提供本次请求的 `basePath` / 资源 IRI，engine 负责把 SPARQL dataset 语义翻译成
本地 named graph scope。

`/-/sparql` query/read 路径：

- 没有显式 `FROM` / `FROM NAMED` 时，`basePath` 以 `/` 结尾表示容器 scope，默认图读取
  `graph startsWith(basePath)`，用于 Pod / 目录级查询读到其子资源 named graphs。
- 没有显式 `FROM` / `FROM NAMED` 时，`basePath` 不以 `/` 结尾表示资源/文件 scope，默认图只读取
  `graph = basePath`，避免 `index.ttl` 误读到 `index.ttl.bak` 这类前缀 sibling。
- 显式 `FROM <graph>` 总是 exact graph scope；多个 `FROM` 编译成 exact graph `$in`。
- 只有 `FROM NAMED` 且没有 `FROM` 时，默认图为空；普通 BGP 不应隐式读整个 Pod，
  只有 `GRAPH <g>` / `GRAPH ?g` 能看到 named dataset scope。
- `FROM` / `FROM NAMED` 指向 server-owned Pod scope 外时，默认禁用并返回明确错误；
  不能静默走 federation 或 compatibility fallback。

SPARQL UPDATE/write 路径：

- HTTP `PATCH` / local RDF authority patch 的隐式默认图必须是请求目标资源的 exact graph。
  写入不能因为目标是目录或 Pod scope 就使用 prefix graph。
- `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` 的 default graph 只有在调用方显式传入
  write target graph 时才可编译；否则必须 fallback/报错，避免把默认图误写进错误文件。
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
   `deniedGraphUrls`；`SolidRdfSparqlEngine` 会在编译后的 `RdfQuery` 上把这些 graph 从
   SELECT / ASK / CONSTRUCT / DESCRIBE / `constructGraph` / `listGraphs` 中排除。

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

- 收紧 scope 下禁止 fallback 到不理解 ACL/ACR 的 compatibility engine；unsupported query
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
- `rdf_vector_sources` / `rdf_vector_chunks` 记录 source/chunk 级 embedding、model、offset、heading path 和 content snapshot；`rdf_vector_components` 物化每个 chunk 的向量分量，第一版用 embedded SQLite 做 dot/cosine/euclidean scoring、threshold 过滤和 source-local order/window，后续可替换成 pgvector/sqlite-vec/QLever-like 执行层。
- 标准 RDF 文档覆盖两层语义：
  - line-addressable RDF：`.ttl` / `.jsonld` / `.nt` / `.nq` / `.trig` / `.n3`。这些格式按扩展名推导 content type，可通过本地 RDF 文件权威路径刷新结构化 index，并进入 by-line 工具文件追踪。
  - 非 by-line 标准 RDF：`.rdf` / `.rdfs` / `.owl` / `application/rdf+xml`。这些格式可解析、镜像并全量同步到结构化 RDF index，但不进入 SolidFS by-line 自动追踪，也不走单文档增量 patch。
- `RdfIndexSolidFsSyncer` 在 direct workspace commit 时会把标准 RDF 文档同步到结构化 RDF index；配置了 text index 时，仅把 line-addressable RDF 文本、Markdown、plain text 同步到 `RdfTextIndex`；配置了 vector index 时也只消费同一批 text-indexable source，并且必须显式提供 `vectorizeText`，不在 syncer 内部绑定 embedding provider；RDF/XML 这类非 by-line 标准 RDF 只做全量解析刷新，不进入文本/by-line 索引；syncer 通过 `shouldTrackPath(...)` 声明路径范围，避免 SolidFS 为文本/向量索引监听所有文件。

## Query Engine Scope

第一阶段必须覆盖 app 常用查询，而不是追求一次性完整 SPARQL 1.1：

| 能力 | 第一阶段 |
| --- | --- |
| BGP | 必须 |
| GRAPH / named graph scope | 必须 |
| FILTER 比较 | 必须 |
| FILTER OR | 同一变量的等值/IN 枚举可编译为 `$in`；复杂布尔表达式 fallback |
| FILTER string functions | 常用子集；安全的否定字符串过滤作为本地后置 filter |
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

- `RdfQuery.textSearch[]` 从 `RdfTextIndex` 产出 bindings，可绑定 `source`、`chunk`、`content`、`heading`、`score`、`workspace`、`localPath`、`contentType`、offset 等变量。
- `source` 是文件/source 资源的 named node，能直接和 RDF BGP 的 graph / subject / object 变量 join。
- `chunk` 是派生 chunk named node（source 资源 + deterministic chunk key），不是内容权威资源。
- `limit` / `offset` 是 text search source 自己的 top-K/window，先在 `RdfTextIndex` 命中集上执行，再和 RDF BGP join；如果需要 join 后分页，使用 `RdfQuery.limit` / `offset`。
- `orderBy` 是 text search source-local ordering，默认按 score 降序；可显式按 `score`、`source`、`localPath`、`ordinal`、offset 等稳定字段排序，然后再执行 source-local `limit` / `offset`。它不替代 join 后的 `RdfQuery.orderBy`。
- text search 会先用 `rdf_text_terms` posting 表按 query token 缩小候选 chunk，再用 normalized phrase `LIKE` 复验，保留原有 substring / phrase 语义。
- 如果 query 使用 `textSearch` 但 engine 未配置 `RdfTextIndex`，必须显式报错，不落回 compatibility engine。

`VectorSearch` 已有第一版本地 binding source：

- `RdfQuery.vectorSearch[]` 从 `RdfVectorIndex` 产出 bindings，可绑定 `source`、`chunk`、`content`、`heading`、`score`、`distance`、`workspace`、`localPath`、`contentType`、offset、`model` 等变量。
- `source` / `chunk` 语义和 `TextSearch` 一致：source 是文件资源，可直接 join RDF named graph 或 subject；chunk 是派生 chunk resource，不是内容权威资源。
- `embedding` 由调用方传入，`vectorModel`、workspace scope、source prefix、limit/offset/threshold 都是受控内部 DSL 参数；公开 SPARQL 向量函数后续再定义。
- `limit` / `offset` 是 vector search source 自己的 top-K/window，先在 `RdfVectorIndex` 排序命中集上执行，再和 RDF BGP join；如果需要 join 后分页，使用 `RdfQuery.limit` / `offset`。
- `orderBy` 是 vector search source-local ordering，默认按 score 降序；可显式按 `score`、`distance`、`source`、`localPath`、`ordinal`、offset 等稳定字段排序，然后再执行 source-local `limit` / `offset`。它不替代 join 后的 `RdfQuery.orderBy`。
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
4. 起点之后先选与已绑定变量连通的 pattern；多个连通候选之间按 bound-slot fanout 估算排序。
5. FILTER 能转成 term/range 条件时下推。
6. ORDER BY 与索引顺序兼容时避免额外排序。
7. LIMIT 在语义安全时尽早下推。
8. 不确定时宁可慢，不返回错结果。

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
  -> append/update SolidFS sync journal
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
- UPDATE template 仍只接受普通 triple；WHERE 可以复用 embedded query 子集，包括安全的 `FILTER` / `VALUES` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join 和固定长度 property path（`^`、`/`）。`WITH <graph>` 的安全子集会先归一化成同一 named graph 下的模板和 WHERE；`USING <graph>` default graph 会作为 WHERE 默认图编译，多个 default `USING` 按标准 SPARQL Update 语义合并为一个 default dataset scope；basePath scope 内的 `USING NAMED <graph>` 可作为 WHERE named dataset scope，约束 `GRAPH <graph>` / `GRAPH ?g` 可见 graph，base 外 graph 仍 fallback；当模板里的 `GRAPH ?g` 能由 query 中 finite named graph filter（例如 `USING NAMED` 产生的 `$in`、显式 `FILTER(?g IN (...))` / `sameTerm` / 等值过滤，或 finite `VALUES` graph rows）约束到 basePath scope 内 graph 时，可 materialize 成多 graph 写入，否则继续 fallback/报错。UPDATE WHERE 中的 graph 变量同样必须能静态枚举为 basePath scope 内 named graph 集合，避免文件权威路径扫描未知本地文件。
- `queryVoid` 不能只信任调用方已经做完权限切分：如果调用方传入的是显式 `append` / `delete` / `write` access scope，静态 DATA update 和 query-backed materialized quads 在提交 `applyDelta` 前都必须再次检查目标 graph 是否落在该写 scope 内。HTTP sidecar 仍由 `SubgraphSparqlHttpHandler` 分别授权 Read / Append / Delete；它传给 WHERE 的 read scope 不能被 RDF engine 误当成写权限 scope，否则会错误阻止 “可 Append 但不可 Read” 的合法 Solid 权限组合。

复杂/未覆盖语句：

- 如果无法安全映射到文件 patch，则返回明确错误或进入受控 fallback。
- fallback 可以短期全量重写 affected RDF 文件，但必须计数、可观测、可逐步消灭。

Canonical by-line RDF 建议：

- 一行一个 statement。
- 尽量使用完整 IRI 或稳定 prefix policy。
- blank node 需要限制或 skolemize。
- `source_line_no` 只作为优化和诊断，不作为 RDF 身份。

## Comunica 兼容层

保留组件，不保留主查询路径依赖：

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
- local/cloud 默认不配置 compatibility fallback；`/-/sparql` 上未覆盖的 query shape 返回明确 `400`，禁用能力返回明确 `403`，不能退成未知 `500`，也不能静默交给 Comunica。
- fallback 命中需要打指标，不能静默成为常态。
- 禁用类能力不能走 compatibility fallback；例如 `SERVICE` 必须直接报错，避免被 Comunica 接手后变成隐式远程 federation。

打包边界：

- 当前阶段不拆 npm package/profile，也不删除 Comunica 相关依赖。`@solid/community-server` 的 RDF parser / dereference 路径和 drizzle-solid 的 SPARQL client 配置仍会在普通 Xpod 进程中引用 Comunica 生态包；强行拆包只能省几十 MB 依赖 footprint，收益不足以承担 profile split、条件打包和 Components.js 解析复杂度。
- 现阶段只要求 Xpod 自有 `SolidRdfEngine`、`SubgraphQueryEngine` 和显式 fallback 边界不静态导入 compatibility engine；真正的 “server-owned Pod 默认不加载 Comunica” 留到 CSS/drizzle-solid 相关入口也完成 lazy/de-core 后再验收。

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
bun run benchmark:rdf-models -- --scale=small --iterations=1 --caseProfile=fusion
bun run benchmark:rdf-models:pg -- --scale=small --iterations=1
bun run benchmark:rdf-models:pg -- --scale=medium --iterations=1 --warmupIterations=0 --caseProfile=extreme
bun run test:w3c
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
SQLite shadow benchmark 也能接收该参数，但会同时跑旧 TEXT compatibility store，
大规模 extreme 主要作为离线对照；PG benchmark 才是 custom-index 发布前的主 gate。

默认输出到 `.test-data/rdf-engine/`：

- `models-baseline-*.json`：只跑 candidate `SolidRdfEngine`，记录 case、checksum、p50/p95、physical plan、scanned rows、index choice 和空间统计。
- `models-shadow-*.json`：同一批 models case 同时跑旧 TEXT `QuintStore` 和 term-id `SolidRdfEngine`，记录 matched / orderedMatched / diff、p95 performance comparison、TEXT vs term-id space comparison 和 plan gate。
- `models-rdf3x-shadow-*.json`：同一批 models scan / query case 同时跑 `SolidRdfEngine` baseline 和 `Rdf3xIndex` candidate，记录 RDF-3X rebuild、matched / orderedMatched / diff、candidate physical plan、planMatched / missingPlan / failedPlanCases 和 storage profile；plan gate 只验证已存在的固定 index profile，不触发 query-time 动态建索引。
- `models-postgres-*.json`：同一批 models scan / query case 跑 `PostgresRdfEngine` PGlite baseline，默认关闭 query result cache 并刷新 RDF-3X derived stats，记录 PG physical plan、planMatched / failedPlanCases、storage profile 和 `pgAcceleration` fallback/capability 状态。

最新 medium 级实测摘要和迁移计划单独维护在
[RDF Performance Report and Data Migration Plan](rdf-performance-and-migration-plan.md)，
避免把历史 benchmark 记录误读成当前上线 gate。

这个入口只用于阶段 1/2 的 baseline 和 shadow comparison，不切换 `/-/sparql` 主路径。

`bun run test:w3c` 先落为第一版目标子集，不尝试一次性跑完整 W3C SPARQL suite。当前子集覆盖 embedded primary path 已声明支持的 SELECT BGP / OPTIONAL / OPTIONAL 内 VALUES / FILTER / VALUES / VALUES `UNDEF` / BIND / UNION（含 branch-local required BGP 后执行 nested UNION）/ MINUS / FILTER EXISTS / FILTER NOT EXISTS / dependent group 内受控 UNION / ORDER / LIMIT、`FROM` / `FROM NAMED` dataset scope、固定长度 property path、GROUP BY COUNT / HAVING、ASK、基础 CONSTRUCT、受控 DESCRIBE、scoped `INSERT DATA` / `DELETE DATA`，以及 query-backed `DELETE/INSERT WHERE` update；每个 case 都断言不会走 compatibility fallback。后续扩大 SPARQL 子集时，先把新增能力补进这个入口，再调整对应 fallback 边界。

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
   - 其余 query 在 `SolidRdfEngine` 内回到 `RdfQuadIndex` baseline；只有显式配置的兼容/oracle 路径才会调用 `ComunicaCompatibilityEngine`。

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

- `RdfTermDictionary` / `RdfQuadIndex` 已提供 SQLite term dictionary、`rdf_sources`、`rdf_quads` 和 `SPOG` / `SOPG` / `PSOG` / `POSG` / `OSPG` / `OPSG` 六排列 covering indexes，加上 `GSPO` / `GPOS` / source indexes；term dictionary 的 exact identity 走固定长度 `hash`，prefix candidate 走 `value_head`，不再把 unbounded `value` / `normalized_text` 放进 raw B-tree key，旧 raw-value term schema 打开时会迁移。
- `ShadowRdfQuintStore` 已提供 phase 1 的 shadow-first 封装：主读写接口仍兼容 `QuintStore`，写入同步到 term-id index，读取仍走旧 TEXT store，`shadowGet(...)` 用于显式对比。
- `ShadowRdfQuintStore.backfillShadowIndex(...)` 已支持从现有 TEXT `QuintStore` 分批回灌 term-id index；这让已有 Pod 持久化数据可以进入 shadow compare，而不是只覆盖新写入。
- `runRdfModelsBenchmark(...)` 已能基于 `rdfModelsBenchmarkCases` 生成 baseline report，包含 query、返回行数、checksum、p50/p95、physical plan、scanned rows、index choice、join order、fallback reason 和 index 空间统计；空间统计同时记录总 DB bytes、RDF table bytes、RDF index bytes 和 SQLite object breakdown。medium 级 `search message literals` case 会带 `$contains` 条件，证明 literal text index 不是普通 predicate scan。report 同时记录 `planMatched` / `missingPlan` / `failedPlanCases`，把 expected plan 和实际 `metrics.indexChoice` / `metrics.queryPlan` 对齐成可机检 gate。
- `runRdfModelsShadowBenchmark(...)` 已能对同一 models benchmark case 同时执行旧 TEXT `QuintStore` 和新 term-id `SolidRdfEngine` scan，并记录 matched、orderedMatch、diff、两边 checksum、p50/p95、compatibility store stats、candidate index metrics、performance comparison 和 space comparison；TEXT store stats 与 candidate index stats 都包含 table/index space breakdown。medium/large scale 已把 “term-id quads 不能比 TEXT quints 更差” 做成硬 gate；small scale 只记录空间比较，避免固定 schema/index 页开销误判。
- `bun run benchmark:rdf-models` 已提供 repo 内可重复执行的基准入口，会构造覆盖 chat/task/thread/message/run/runStep/session/audit/provider/model/credential/profile/ACL/ACR/issue/approval/grant/inbox/contact/favorite/aiConfig/vectorStore/indexedFile/agentStatus 的 deterministic seed data，回灌 shadow index，并把 baseline / shadow / RDF-3X shadow report 保存到 `.test-data/rdf-engine/`。provider/model/credential seed 使用 models 实际 `ai:` / `cred:` vocab，credential grouped numeric aggregate 走 `cred:failCount`，不再用临时 `udfs:priority`。合成 message seed 现在按 `9` quads/message 写入 type/thread/created/modified/content/score/rank/status/workspace，并额外生成 64 个 synthetic thread，使深 BGP、VALUES、COUNT DISTINCT 和 grouped numeric aggregate 不再是空测。脚本 summary 会打印 baseline/shadow/RDF-3X plan gate、shadow performance gate 和 shadow space gate；任何 shadow diff、plan mismatch、明显 p95 退化或 medium/large 空间退化都会让命令退出非 0。
- `bun run benchmark:rdf-models:pg` 已提供同 seed / 同 models case 的 PostgreSQL baseline gate，默认使用 PGlite 跑 `PostgresRdfEngine`，默认关闭 query result cache，执行前调用 `refreshDerivedIndexes()`，并把 `models-postgres-*.json` report 保存到 `.test-data/rdf-engine/`；也可用 `--driver=pg --connectionString=... --allowPgWrites` 跑真实 PostgreSQL，但只允许指向 disposable empty database，脚本会在写入前拒绝非空 RDF facts。任何 plan mismatch、seed 未达到目标规模、derived stats 未同步都会让命令退出非 0；当 `--rdfAccelerationProfile=pg-custom-index` 且 `--caseProfile=extreme|all` 时，还要求 report 中至少出现一个 `XpodRdfExtensionOperator(...)`，避免 custom-index 只启用了 profile 却没有命中 native operator。2026-06-06 PGlite extreme smoke：`bun run benchmark:rdf-models:pg -- --scale=medium --iterations=1 --warmupIterations=0 --caseProfile=extreme --rdfAccelerationProfile=baseline` 生成 `19483` quads，2 个 scan case 和 10 个 query case 均 plan matched，`rdf3x.syncedWithFacts=true`，storage total/facts ratio `1.41x`。同日真实 PG17 extreme gate 证明 `pg-custom-index` 可命中 5 个 native operator case；当时 graph-prefix product cases 仍是 PG SQL hot path。2026-06-07 已补 bounded graph-prefix native slot-filter 下推，并完成真实 PG17 rerun：`join.slot_filter.native` active，native extension plan hits `11`，storage total/facts ratio `1.25x`；graph-prefix grouped numeric aggregate 从旧 native 94ms 降到 28ms，但 `COUNT DISTINCT` / grouped count 仍未超过 RDF-3X / btree baseline。
- `rdfModelsQueryBenchmarkCases` 已开始覆盖跨 pattern 的业务查询物理计划，并在 report 中记录 RdfQuery DSL 输入、physical plan 和 checksum：按 thread 拉最新 message 会要求 `ORDER BY createdAt DESC LIMIT 1` 保持在 SQL self-join 内；thread message keyset page 会要求 `createdAt < cursor`、`ORDER BY createdAt DESC` 和 `LIMIT` 同时保持在 SQL self-join 内；thread context window 会要求 message type/thread/created/score 星型 join 与分页保持在 SQL self-join 内；workspace 内下一条 queued run 会要求 status/workspace/createdAt 三个 pattern 在 SQL self-join 内完成并下推 `ORDER BY createdAt ASC LIMIT 1`；run step 列表会要求 `rdf:type RunStep` 和 `udfs:run` 关系在 SQL self-join 内完成并下推排序/分页；task run execution detail 会把 Task、Run、Thread、RunStep hydration 放进同一个 BGP gate；task materialization 会要求 `rdf:type Schedule`、`udfs:status "active"` 和 `udfs:nextRunAt <= cutoff` 在 SQL self-join 内完成，并下推 range filter、排序和分页；AI credential selection 会按 shared models 的 `ai:` / `cred:` vocab 连接 provider default model、active/default credential、`apiKey` 和 `failCount`；active session hydration、audit approval policy trace、AI config embedding model、vector indexed-file store 这些新增 case 覆盖 SessionManager、监督审计、AI runtime 配置和向量索引元数据；profile ACL authorization、profile ACR authorization、profile inbox activity、approval grant action match、favorite target chat、contact entity profile 这些 models join case 用于防止 WebID/profile、权限图、审批授权、联系人和收藏回退成 pod-wide scan；这些 timeline/context/state-center/one-to-many/scheduler/provider-credential/session/audit/profile/access/contact/favorite/vector 查询会和 non-grouped numeric aggregate、grouped message count、grouped credential `failCount` aggregate、message-thread `COUNT DISTINCT` 一起作为 RdfQueryExecutor 的 models-level plan gate。PG 专用 `rdfModelsPostgresQueryBenchmarkCases` 在通用 query cases 基础上额外覆盖 5 个显式 business-view materialized warm-path case，要求 warmup 后出现 `PostgresMaterializedResultHit` 和 `PostgresQueryTemplateCacheHit`，且不写普通 result cache。
- `RdfQueryExecutor` 已开始承接 phase 2 的本地物理查询层，支持 BGP join、OPTIONAL group、COUNT/basic aggregate、FILTER DSL 和 select/order/limit 投影；可下推的 exact/range/prefix filter 会合并到 `RdfQuadIndex.scan(...)`，纯 required-pattern 查询里已经由 index 保证的 filter 不再重复进入后置内存 `Filter(...)`。
- `RdfQuadIndex.scan(...)` 已把 graph/source prefix scope、lexical range filter 和 RDF term text search 改为显式 `JOIN rdf_terms ...`，避免把前缀 graph、range hit 或 text hit 先展开成巨大 `IN (?, ...)` / `IN (SELECT ...)` 候选列表；`$in` / `$notIn` 这类 VALUES-style term filter 在短列表时保留参数化 `IN`，长列表会写入临时候选表并用 JOIN / anti-JOIN 回连 quad scan，避免长 SQL、参数上限和 planner 误判；medium models benchmark 中 `search message literals` 的 physical plan 可机检到 `prefix_graph_id` 和 `text_object_id_contains` JOIN，`task materialization due time` 可机检到 `object_id_range_lte` JOIN。
- connected required BGP 已有受控 SQL self-join 快路径：`RdfQueryExecutor` 在没有 OPTIONAL / UNION / dependent join / text-vector source 的安全 shape 下，会先用 `RdfQuadIndex.estimateCardinality(...)` 按选择性和共享变量连通性重排 BGP pattern，再把多 pattern BGP 下推到 `RdfQuadIndex.joinPatterns(...)` / `countJoinPatterns(...)`，由 `rdf_quads q0 JOIN rdf_quads q1 ...` 直接按共享变量连接并返回 bindings 或 aggregate rows。安全的 `SELECT DISTINCT ?x ... ORDER BY ?x LIMIT n` 这类投影去重可在 SQL self-join 内执行：projection、ORDER 和 filter recheck 需要的变量必须保留，避免先丢变量再复验或分页造成错结果。非分组 `COUNT` / `COUNT DISTINCT` 可在 SQL self-join 内直接聚合，避免先 materialize join bindings 再在 TS 层计数。`ORDER BY` 绑定变量支持多变量和混合方向，并可把对应 `LIMIT` / `OFFSET` 一并放进 SQL self-join；安全的 term equality/range/IN/prefix/text operator FILTER、常量 `sameTerm`、term-type、language 和 datatype filter 会按变量所在 term slot 编译进 self-join，并用 pattern-scoped SQL alias 避免多个 pattern 的 `rdf_terms` join 和候选表冲突。变量-变量 FILTER、`BOUND`/stringLength、aggregate `HAVING` 或更复杂 query shape 继续走既有 cardinality planner 和 TS binding merge，避免提前分页或半下推造成错结果。
- `RdfQueryExecutor` 已支持 `rdf3xPrimary` selective primary，文件型 `SolidRdfEngine` 标准配置会通过 `derivedIndexProfile: "rdf3x"` 自动启用；`derivedIndexProfile: "baseline"` 会保持同库 `RdfQuadIndex` baseline 且不维护 RDF-3X stats，测试/外部实例也可显式打开 RDF-3X primary：只有 `rdf3x_metadata.facts_data_version` 已追上 facts `data_version` 时，query 才把 `Rdf3xIndex` 交给 planner；如果派生索引落后，query 不会同步 rebuild，而是在 plan 中标记 `Rdf3xPrimaryNeedsRefreshFallback` 并走 facts baseline。在 single-pattern scan/count 或 required BGP shape 被 `Rdf3xIndex` 完整覆盖时，直接走 RDF-3X permutation/membership scan/join，并在 plan 中暴露 `Rdf3xPrimaryScan(...)`、`Rdf3xPrimaryCount(...)`、`Rdf3xJoinBGP(...)` / `Rdf3xPrimaryJoin...`；RDF-3X join order 会先用 projection / membership stats 选择最窄起点，再每步优先接入与已绑定变量连通的 pattern，并用 `count(pattern) / countDistinctTuple(pattern, boundSlots)` 估算 connected 候选 fanout，避免窄但不相关的 pattern 或高 fanout pattern 提前造成 cross product；连通 term equality 会落到 facts covering index `JOIN ... ON ...` 并在 plan 中标记 `Rdf3xMergeJoin(...)`，graph equality 仍在 facts graph 条件中保持 named graph 语义；typed numeric literal range、lexical object range、object `$contains` / `$endsWith` text filter、exact term `$in` / `$notIn`、term-type、language 和 datatype metadata filter 都可进入 RDF-3X scan/join，metadata / text filter 会 JOIN `rdf_terms` 并在 plan 中标记 `TermType(...)` / `Language(...)` / `Datatype(...)` / `TextSearch(...)`，`$in` / `$notIn` 会编译成 SQL `IN` / `NOT IN` 条件并在 plan 中标记 `TermIn(...)` / `TermNotIn(...)`；`DISTINCT` term projection 在无 graph 变量/graph 约束、无 limit/offset 的安全子集里会标记 `Rdf3xIndexOnlyJoin` 并直接利用 facts covering index 执行；同 pattern tuple VALUES scan 可用 `TupleValuesJoin(...)` 下推，required BGP 中无 `UNDEF` 且所有变量均由 required pattern 绑定的 tuple VALUES 可用 `Rdf3xJoinTupleValues(...)` 下推，join count、basic numeric aggregate、grouped count 和 grouped numeric aggregate 也可分别走 `Rdf3xJoinCount(...)` / `Rdf3xJoinAggregate(...)` / `Rdf3xJoinGroupCount(...)` / `Rdf3xJoinGroupAggregate(...)`。OPTIONAL / UNION / dependent group 仍在 query layer 维持 left join / branch / semi-join / anti-join 语义，但内部无 group-local `VALUES` 的 connected BGP pattern list 可批量走 `Rdf3xJoinBGP(...)`，避免退回逐 pattern scan。不支持的 regex / search source 等 shape 不尝试半执行；文件型 `SolidRdfEngine` 继续落回同库 `RdfQuadIndex` baseline，`PostgresRdfEngine` 则落回 PG facts baseline。
- `Rdf3xIndex` 的 SQLite schema 已改为 facts-reuse schema：不再物化 `rdf3x_spo` / `rdf3x_pos` / `rdf3x_triple_membership` 这类事实副本，只保留 `rdf3x_stat_*` 和 `rdf3x_metadata`，stat 表使用 `WITHOUT ROWID`；旧 rowid / materialized fact-copy 派生表打开时会被丢弃并从 facts 重建 stats。facts / RDF-3X 均已记录 schema version，不兼容版本走整套本地索引重建，不走查询时动态建索引。
- graph-scoped scan/count/count-distinct/join 已走 RDF-3X membership source：当 pattern 带 exact graph 或 graph prefix 时，`Rdf3xIndex` 不再固定先扫三元组 permutation 再后置过滤 graph，而是直接以 `rdf_quads` facts source 作为该 pattern 的 source，使业务里常见的 `.data/chat/`、`.data/task/`、provider/model/contact/favorite 前缀能先收窄候选。graph prefix 先经 `rdf3x_stat_g` 图投影表收缩到真实 graph id，再进入 facts source，避免 `rdf_terms` 里同前缀的 subject/object IRI 参与候选。2026-05-28 medium models benchmark（`bun run benchmark:rdf-models -- --scale=medium --iterations=3`）里，seed 为 `10063` quads，22 个 shadow case 和 7 个 RDF-3X join case 均 matched / ordered matched，baseline/shadow/RDF-3X plan gate、performance gate 和 space gate 均通过；`rdf3x` profile facts space `5758976` bytes，derived space `1036288` bytes，`total/facts` 为 `1.18x`。
- 安全的 `GROUP BY ?var + COUNT(...)` 已有 SQL 下推快路径：当 required BGP 只包含可编译 pattern、没有 OPTIONAL / UNION / dependent join / search source / BIND / DISTINCT，且 group/count/order/having 只引用 BGP 变量或聚合别名时，`RdfQueryExecutor` 会先做同一套 BGP join reorder，再把连接和分组交给 `RdfQuadIndex.groupCountJoinPatterns(...)`，由 SQL self-join 后直接 `GROUP BY` / `COUNT` / `COUNT DISTINCT` 返回分组行；可下推 FILTER 会在 SQL 内过滤并不再对聚合结果做原始变量复验。grouped result 的 `ORDER BY` / `LIMIT` / `OFFSET` 可继续下推到 SQL，其中 group 变量排序通过 `rdf_terms.value` 保持词法顺序，聚合别名排序直接按 COUNT 数值排序；安全的 numeric aggregate `HAVING` 会编译成 SQL `HAVING`，确保分页发生在聚合过滤之后。`HAVING (COUNT(DISTINCT ?x) > n)` 这类未投影聚合表达式会编译成内部 hidden aggregate alias，用于过滤但不暴露到 SELECT metadata/result。非 numeric `HAVING`、带 `BIND` 的 group expression、非下推 filter 和更复杂 shape 仍留在本地 query 层聚合。
- required BGP pattern 选择已开始使用 embedded index cardinality：每一步基于当前 bindings、可下推 filter 和 `RdfQuadIndex.estimateCardinality(...)` / `count(...)` 估算候选行数，优先选择 connected 且候选更小的 scan 起点，避免固定顺序让宽 pattern 先扫全量；exact term pattern 的估算带写入/删除失效缓存，减少 planner 重复 `COUNT(*)`。
- 单 required pattern 的 `ORDER BY` / `LIMIT` / `OFFSET` 已在语义安全时下推到 `RdfQuadIndex.scan(...)`：排序变量必须能直接映射到该 pattern 的 term slot；分页只有在排序已下推或无排序、相关 filter 都可下推、且 pattern 内没有重复变量跨 term slot 一致性约束时才进入 index，避免先分页再应用未下推 row consistency 过滤造成错结果。多变量 `ORDER BY` 会下推成 SQLite term join 排序，支持每个排序列独立的 ASC/DESC 方向。
- 单 required pattern 的 `COUNT` 已在语义安全时下推到 `RdfQuadIndex.count(...)` / `countDistinct(...)` / `countDistinctTuple(...)`：count 变量必须来自该 pattern，不能有 optional/order/pagination，所有 filter 都可下推，且 pattern 内不能有重复变量跨 term slot 一致性约束；`COUNT DISTINCT ?var` 只有在 `?var` 映射到单个 term slot 时才下推为 `COUNT(DISTINCT slot)`，`COUNT(DISTINCT *)` 会按 pattern 实际暴露的变量 tuple 去重，避免默认图 prefix 读取多个 named graph 时把同一 solution 重复计数；多 slot 重复变量仍保留在 query 层聚合。connected BGP 的非分组 `COUNT` / `COUNT DISTINCT` 走 `countJoinPatterns(...)`，grouped `COUNT` / `COUNT DISTINCT` 走 `groupCountJoinPatterns(...)`；其中 `COUNT(DISTINCT *)` 使用 SPARQL adapter 记录的可见 solution 变量构造 tuple key，不使用内部 path join 变量或底层 rowid。
- typed numeric literal range 已按数值语义进入 embedded path：`xsd:integer` / `decimal` / `double` / `float` 及常见派生整数类型会写入 `rdf_terms.numeric_value` 并建立 `(kind, numeric_value)` 索引，`RdfQuadIndex` 用显式 `JOIN rdf_terms ... numeric_value` 执行 numeric range scan，避免 `"10" < "9"` 这类字符串序导致错结果，也避免先扫描 numeric term 再把 id 列表回填到 `IN (...)`；未声明为 numeric datatype 的 literal 仍保持 lexical range 语义。旧 RDF index 打开时会补列、建索引并回填可解析的 numeric literal。
- RDF literal text search 已先走 embedded path：`RdfTermDictionary.normalized_text` 负责 `contains` / `endsWith` 候选集，`regex` 暂用 term 表候选扫描并写入临时候选表，`RdfQuadIndex` 再通过显式 JOIN 回连到 quad scan，避免把命中的 term ids 展开成巨大 `IN (?, ...)`；plan 会记录 `TextSearch(...)`。query 层仍会复验 filter；带 flags 的 `regex` 暂不下推，避免 normalized index 改变语义。
- `STR(...)` 字符串过滤已按标准 SPARQL 词法值语义进入 embedded path：`STR(?term) = "..."`、`STR(?term) IN (...)` 和 `STRSTARTS` / `CONTAINS` / `STRENDS` / `REGEX` 会编译成显式 `stringValue` filter，避免把 IRI 与同词法 literal 误当成同一个 RDF term。安全的 `!STRSTARTS` / `!CONTAINS` / `!STRENDS` / `!REGEX` 作为本地后置 filter 支持，暂不下推到 text candidate index，避免否定谓词错误缩小候选集。`LCASE(STR(?term))` / `UCASE(STR(?term))` 以及对应 XPath `fn:lower-case` / `fn:upper-case` 嵌入字符串 filter 时会编译成本地 case-normalized operand，先作为后置 filter 执行，不提前下推到 term index。`stringValue` 的 equality / IN 保留为本地后置 filter，不下推成 term equality；prefix/contains/endsWith/regex 可按 term slot 推导候选 term kind 后下推，`object` 会覆盖 IRI、literal 和 blank node，避免 `STRSTARTS(STR(?object), "...")` 这类关系 IRI 查询被误当成 literal-only 搜索；`subject` / `graph` / `predicate` 仍按各自 RDF term kind 限定。
- 标准 XPath function-call 形式也已进入 embedded path：`fn:contains` / `fn:starts-with` / `fn:ends-with` / `fn:matches` 会归一成已有字符串 filter，`fn:string-length(...)` 会归一成本地后置 `stringLength` filter，`fn:concat(...)` 会归一成 `CONCAT(...)` BIND 绑定，`fn:lower-case(...)` / `fn:upper-case(...)` 可用于 BIND，也可作为字符串 FILTER 的 case-normalized operand，`fn:substring(...)` 会归一成 `SUBSTR(...)` BIND 绑定，避免 sparqljs 把这些标准写法解析成 `functionCall` 后误落回 compatibility engine；未列入白名单的自定义函数仍明确 fallback。
- SPARQL adapter 已支持变量-常量和常量-变量两种方向的基础比较 FILTER：例如 `?created <= "..."` 和 `"... " >= ?created` 都会编译成等价 local filter，避免因为表达式左右顺序不同落回 compatibility engine。变量-变量比较也已进入 embedded path：`?a < ?b`、`?a = ?b`、`?a != ?b` 会在 local binding 阶段按两侧已绑定值比较；`STR(?a) = STR(?b)` 和 `STRLEN(STR(?a)) < STRLEN(STR(?b))` 会分别按词法值和长度比较。可严格反转的 negated FILTER 也会走 embedded path：`!(?x = value)` / `!(?x > value)` / `!(?x IN (...))` 会分别编译成 `$ne` / 反向范围 / `$notIn`；`!(?x = "a" || ?x = "b")` 这类同变量 OR 枚举会折成 `$notIn`。需要 De Morgan 展开的复杂 `!(A && B)`、跨变量 OR、range OR 和函数 OR 仍 fallback。
- 标准 RDF term-test FILTER 函数已进入 embedded path：`isIRI` / `isURI` / `isBlank` / `isLiteral` / `isNumeric`、`sameTerm(...)`、`lang(?literal) = "..."`、`lang(?literal) != "..."`、`LANGMATCHES(LANG(?literal), "...")`、`datatype(?literal) = <iri>` 和 `datatype(?literal) != <iri>` 会编译成本地行内 filter，覆盖常见类型守卫和语言/datatype 查询；`LANG(?literal) IN (...)` / `NOT IN (...)` 与 `DATATYPE(?literal) IN (...)` / `NOT IN (...)` 也已作为本地 post-filter 覆盖，不把集合语义误下推成单值 metadata scan。其中常量 `sameTerm`、term-type、language 和 datatype filter 已下推到 term-id index，并继续在 query 层复验，避免 term-test 语义被误当成 lexical scan。安全取反的 term-test 子集（例如 `!isLiteral(?x)`、`!isIRI(?x)`、`!isBlank(?x)`、`!isNumeric(?x)`、`!sameTerm(?a, ?b)`）以及 `!LANGMATCHES(LANG(?literal), "...")` 会作为 embedded local post-filter 执行，不下推到 term-id index。变量-变量 `sameTerm`、`datatype/lang` 的范围比较、表达式嵌套和更复杂 EBV 仍 fallback 或留在本地行过滤。
- SPARQL adapter 已支持安全的 same-variable OR 枚举 FILTER：例如 `?status = "open" || ?status = "active"` 以及同一变量上的 `IN(...)` 混合分支会合并成本地 `$in` filter，并继续由 `RdfQuadIndex.scan(...)` 下推；`STR(?term) = "a" || STR(?term) = "b"` 会保留 `stringValue` operand 并作为本地后置 IN filter，避免词法值比较退化成 RDF term 比较。跨变量 OR、混合裸变量/`STR(...)` operand、OR 内字符串函数/range/BOUND/AND 等复杂布尔表达式仍明确 fallback，避免半语义执行。
- SPARQL adapter 已支持常见 OPTIONAL anti-join：`FILTER(!BOUND(?var))` 会编译成本地 `$bound: false`，由 embedded `RdfQueryExecutor` 在 OPTIONAL join 后过滤；不需要落回 compatibility engine。
- OPTIONAL 内部的局部 FILTER / BIND / `GRAPH ?g` / 受控 nested OPTIONAL 已进入 embedded path：adapter 会把 `OPTIONAL { ... FILTER(...) / BIND(...) / GRAPH ?g { ... } / OPTIONAL { ... } }` 编译成 optional group 的 local filter/binding/graph-scoped pattern/nested group，`RdfQueryExecutor` 在 optional 匹配分支内递归应用并保留 left join 语义；可下推的 optional filter 仍能进入 `RdfQuadIndex.scan(...)`，OPTIONAL 内 `GRAPH ?g` 会把 basePath 或 `FROM NAMED` 有限 scope 约束留在 optional-local filter 中，不把可选图变量提升成顶层 required filter；`rdf3xPrimary` 下无 group-local `VALUES` 的多 pattern optional BGP 可走 RDF-3X join，并在 plan 里保留 `OptionalFilter(...)` / `OptionalBind(...)` / `OptionalNestedJoin(...)` 逻辑节点。OPTIONAL 内 dependent-join 仍明确 fallback。
- SELECT DISTINCT / REDUCED 已进入 embedded path：安全 required BGP 的单 pattern 和 connected BGP `DISTINCT` 投影会下推到 `RdfQuadIndex.joinPatterns(...)` 的 SQL `SELECT DISTINCT`，并可和多变量/混合方向 `ORDER BY` / `LIMIT` / `OFFSET` 同步下推；其他 shape 仍在本地查询层 projection 后按 RDF term binding 去重。`REDUCED` 按标准允许不消重的语义走普通 SELECT，不为它强制 fallback。
- `VALUES` 已进入 embedded path：单变量 `VALUES ?var { ... }` 在 `?var` 同时出现在 required BGP 中且所有行都有绑定时会编译成 `$in` filter 并交给 `RdfQuadIndex.scan(...)` 下推，适合按一组资源 IRI 批量查；多变量 tuple `VALUES (?a ?b) { ... }` 会编译成 correlated binding source，保留行相关性，避免拆成多个独立 `IN` 后产生错误组合。`UNDEF` 行会保留为本地 binding source 的未绑定列，不错误下推成 index tuple constraint，从而保留 SPARQL multiset 语义。当 tuple 变量能一一映射到同一个 required quad pattern 的 term slot 且所有行都有绑定时，planner 会把它下推成临时候选表并用 SQL `JOIN rdf_tuple_values_*` 回连 `rdf_quads`；当 tuple 变量分布在多个 required pattern、所有行都有绑定、且所有变量都由 required BGP 绑定时，`rdf3xPrimary` 可把它下推成 `Rdf3xJoinTupleValues(...)`，在 RDF-3X join SQL 内保留 tuple 相关性；含 `UNDEF`、不约束 required BGP、或当前 RDF-3X 不支持的 tuple 继续走本地 binding join。OPTIONAL 内 VALUES 已作为 optional-local binding source 支持，执行时保留 left join 语义，不会把不匹配的 VALUES 行提升成 required filter；不约束 required pattern 的顶层独立 binding 仍 fallback。
- 标准 `BIND` 和非聚合 `SELECT (expr AS ?alias)` 的安全子集已进入 embedded path：支持把已绑定变量、IRI/literal 常量、`STR(?var)`、`STRLEN(STR(?var))`、`CONCAT(...)`、`LCASE(...)` / `UCASE(...)`、`COALESCE(...)`、安全 `IF(...)`、`STRDT(...)`、`STRLANG(...)`、`SUBSTR(...)` / XPath `substring(...)`、`IRI/URI(...)` 派生成新的 binding，后续 `FILTER`、`SELECT`、`ORDER`、受控 UNION branch 和 query-backed update materialization 都能读取；`SELECT` 表达式投影复用同一套 bind evaluator，并拒绝 alias 覆盖 WHERE/BIND 已有变量。`SUBSTR` 的起点/长度复用同一套安全 bind 表达式，并在执行时求成有限数字；`COALESCE` 会按顺序返回第一个可求值 term，`IF` 复用现有可编译 FILTER 子集作为条件，`STRDT` 要求 datatype 表达式求成 IRI，`STRLANG` 用 language 表达式词法值构造 language literal。未绑定依赖、重绑定、复杂表达式和非白名单函数仍明确 fallback，避免部分执行后产生错 binding。
- 受控 `UNION` 已进入 embedded path：adapter 会把每个 branch 编译成独立本地子 join，`RdfQueryExecutor` 再把 UNION 结果与外层 required bindings 合并，并在全量结果层执行 ORDER/LIMIT，避免提前下推分页导致错结果。当前支持 branch 内 BGP、局部 FILTER、branch-local BIND、branch-local tuple / single-variable `VALUES`，以及已支持的 OPTIONAL 子集；`rdf3xPrimary` 下无 branch-local `VALUES` 的多 pattern branch BGP 可走 RDF-3X join；nested UNION 已支持，包括“branch-local required BGP 先收窄，再执行内层 UNION”的嵌套形态，OPTIONAL 内 UNION 也已支持。顶层 `VALUES` 必须约束 required pattern 或所有 branch 都绑定的变量；空 required branch 和不约束 branch required pattern 的 VALUES 仍明确 fallback。
- 受控 dependent-join 已进入 embedded path：`MINUS { ... }` 和 `FILTER NOT EXISTS { ... }` 会被 adapter 编译成本地 anti-join group，`FILTER EXISTS { ... }` 会被编译成本地 semi-join group。`RdfQueryExecutor` 在外层 required/UNION bindings 之后执行顶层 dependent groups，并在 OPTIONAL 分支内执行 optional-local dependent groups；optional-local group 只筛掉当前 optional 匹配分支，如果分支被筛空，仍保留 left join 的外层 row。当前支持右侧 required BGP、可编译的局部 FILTER/VALUES/OPTIONAL，以及每个 branch 都可编译为 embedded BGP/OPTIONAL/FILTER/VALUES 的 dependent group 内受控 `UNION`；`rdf3xPrimary` 下无 group-local `VALUES` 的多 pattern dependent BGP 可走 RDF-3X join；右侧必须至少和外层 required shape 或所在 OPTIONAL 分支已绑定变量共享一个变量。不相关 dependent-join 和 nested dependent-join 继续明确 fallback。
- 受控 property path 已进入 embedded query path：adapter 在 `WHERE` 边界把标准 SPARQL 1.1 AST 中的简单 inverse path（`^<p>`）和固定长度 sequence path（`<p>/<q>`、`^<p>/<q>` 等）展开成普通 BGP join；简单固定谓词 alternative（`<p1>|<p2>`，含整体反向 `^(<p1>|<p2>)`，以及 sequence 中的 `(<p1>|<p2>)/<p3>` 单段 alternative）会编译成 predicate `$in`，走同一套 term-id index scan。递归/可选/不等长分支/negated path（`*`、`+`、`?`、`(<p1>/<p2>|<p3>)`、`!`）继续 fallback。展开产生的内部 join 变量只用于本地执行，不进入 models、Pod 数据或对外 binding metadata。`CONSTRUCT` / UPDATE template 仍只接受普通 triple，不把 path 当成可写目标。
- `GROUP BY ?var + COUNT(...)` 已进入 embedded path：支持按 required BGP 变量分组、多个 `COUNT` / `COUNT DISTINCT` 聚合投影，并保留排序、投影、分页在 grouped rows 上执行；`HAVING` 的安全子集支持对聚合别名、匹配的 `COUNT(...)` 表达式，以及未投影的 `COUNT(DISTINCT ?x)` hidden aggregate 做简单比较并在 aggregate 后过滤。安全的 `GROUP BY` 表达式/别名会先下放成 local `BIND` 再分组，支持的表达式范围与标准安全 `BIND` 子集一致；wildcard grouped SELECT 和不安全的 HAVING 仍 fallback，避免半支持返回错语义。
- guarded numeric aggregate 已进入 embedded path：`SUM(?x)`、`AVG(?x)`、`MIN(?x)`、`MAX(?x)` 支持 required query shape 中已绑定变量上的 RDF numeric literal，SPARQL adapter 要求同一变量存在 `FILTER(isNumeric(?x))` 后才编译，执行层用 decimal literal 返回结果；未守卫变量、`*`、复杂表达式和非 numeric aggregate 继续 fallback。安全的 required BGP numeric aggregate 会下推到 SQL self-join：`FILTER(isNumeric(?x))` 映射为 `rdf_terms.numeric_value IS NOT NULL` join，避免先 materialize 所有 binding 再在 TS 层聚合；非分组与 `GROUP BY` 形态都支持该下推，并可对 aggregate alias 做安全 HAVING/ORDER/LIMIT；`DISTINCT` numeric aggregate、非 required BGP shape 和复杂 HAVING 仍留在本地聚合或 fallback 边界。
- 基础 `CONSTRUCT { ... } WHERE { ... }` 已进入 embedded path：template 只支持普通 triple，WHERE 复用当前 BGP/FILTER/OPTIONAL/VALUES 等已覆盖查询子集，执行后把 bindings materialize 成去重 RDF quads；复杂 CONSTRUCT shape 和未覆盖 query shape 明确 fallback 到 compatibility engine。
- 受控 `DESCRIBE` 已进入 embedded query path：支持 `DESCRIBE <iri>`、`DESCRIBE ?var WHERE { ... }` 和标准 `DESCRIBE * WHERE { ... }`；目标资源必须是显式 IRI，或由 required embedded query shape 绑定出来的可见变量。`DESCRIBE *` 会展开为当前 WHERE 可见 required 变量，执行时只返回 basePath scope 内 named-node target 的 `target ?p ?o` 直接描述，并 materialize 为 default graph quads。未绑定变量、只在 OPTIONAL 中出现的 wildcard 变量，以及需要 CBD/跨 provider 扩展语义的形状继续 fallback。
- graph utility 读路径也已进入 embedded path：`constructGraph(graph)` 会在 basePath scope 内用 `GRAPH <graph>` 构造 default graph quad stream，scope 外 graph 返回空结果且不触发 fallback；`listGraphs(basePath)` 用本地 `SELECT DISTINCT ?g` 列出 Pod scope 内 named graphs。
- `INSERT DATA` / `DELETE DATA` 的 named graph delta 已进入 embedded path：`RdfSparqlAdapter.compileUpdateDelta(...)` 只接受 basePath scope 内的显式 `GRAPH <iri>`、named-node subject/predicate、named-node 或 literal object；默认 graph、graph 变量、blank node 和 base 外 graph 仍明确 fallback，避免半解析写错。
- `DELETE WHERE` 的 named graph BGP delta 已进入 embedded path：adapter 会把 basePath scope 内的显式 `GRAPH <iri> { ... }` 编译成本地查询和删除模板，engine 先用 `SolidRdfEngine.query(...)` 找到实际匹配 quads，再逐 quad 精确删除；default graph、graph 变量和 base 外 graph 仍 fallback。
- `DELETE/INSERT WHERE`、`INSERT WHERE` 和 `DELETE WHERE` 的安全子集已进入 embedded path：模板和 WHERE 都必须落在 basePath scope 内的显式 named graph，或通过 `WITH <graph>` 归一到同一个 basePath named graph；`USING <graph>` default graph 可把 WHERE default BGP 映射到 basePath scope 内的 named graph，多个 default `USING` 会编译成 graph `$in` 读取多个 basePath scope 内 graph，但不会作为写入模板 graph；basePath scope 内的 `USING NAMED <graph>` 可把 WHERE named dataset 映射到受控 graph 集合，`GRAPH ?g` 会保留 graph binding 并附加 `$in` 过滤。模板中的 `GRAPH ?g` 已支持 safe finite graph-variable write：只有当 `?g` 在 query 中被 finite named graph filter 或 finite `VALUES` graph rows 约束时才会编译，materialization 后按实际 binding 写回对应 graph；显式 `FILTER(?g IN (...))` / `sameTerm` / 等值 graph filter、多列 `VALUES (?g ...)` 都能作为 finite proof，但所有 graph 值必须在 basePath scope 内。WHERE 至少包含 required graph BGP，且可使用受控 UNION / anti-join / semi-join 子集；adapter 用本地查询计算 bindings，再 materialize delete/insert quads。无 `WITH` / `USING` 的 default graph、base 外 graph、空 required BGP 和不安全模板仍 fallback。
- `SolidRdfSparqlEngine.queryVoid(...)` 已能把上述 update delta 应用到 embedded `SolidRdfEngine`：`DELETE/INSERT WHERE` 会先查询 bindings，按 SPARQL update 语义先删后插；`INSERT WHERE` 会查询 bindings 后只 materialize insert quads。每个 update operation 的 delete patterns 和 insert quads 会通过 facts index 的单次 `applyDelta(...)` transaction 提交，避免一个多 graph delta 在同一 operation 内推进多次 facts `data_version`；多条 update operation 仍保持顺序语义，后一条 operation 的 WHERE 可以读到前一条 operation 的结果。显式写 access scope 会在静态 quads 和 materialized quads 提交前做目标 graph guard，越界时返回 `sparql.update.access_scope`，且错误包装不会丢失原 capability/hint/correction。指标仍记录 `UpdateDelta` plan、delete/insert 数量和 `update-delta` index choice。
- `MixDataAccessor.executeSparqlUpdate(...)` 已补上 embedded 文件权威路径：当目标是 `.ttl` / `.jsonld` by-line RDF 文档，并且 UPDATE 属于 `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` / 安全 `DELETE/INSERT WHERE` / 安全 `INSERT WHERE` / 安全 `WITH` scoped update / default `USING` / `USING NAMED` update 的 named graph delta 时，先读取需要参与 WHERE 的本地 RDF authority files，patch 受影响的本地 RDF authority files，再逐个重建结构化 RDF index；其中 query-backed update 的 local WHERE bindings 复用 embedded `SolidRdfEngine.query(...)` 计算，所以已覆盖安全的 `FILTER` / `VALUES` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join / semi-join / 固定长度 property path 子集。多 default `USING` 和 basePath scope 内的 `USING NAMED` 已支持读取多个本地 by-line RDF graph；写入模板可以同时落在多个明确的 basePath scope 内 by-line RDF graph document，也可以在 `GRAPH ?g` 被 finite graph set、finite graph filter 或多列 `VALUES` rows 约束时按 binding 写回多个本地 graph。写入流程已拆成“先落本地 authority file 并登记可选 SolidFS journal，再刷新 structured/text index，最后统一 mark done”的两阶段边界；配置了 `rdfFileMapper + localRdfAuthorityJournal` 时，多文件 PATCH 会用同一个 `solidfs_tx_*` 进入恢复视图，index 刷新失败并触发 rollback 时会把同 tx 的 entry 标记为 `reconcile_required`，避免只靠进程内 rollback 丢失恢复证据。无限 graph 变量、basePath 外 graph、非 by-line RDF 写目标或其他无法安全映射到本地 graph document 的 shape 继续进入 compatibility accessor，并在回退后刷新本地 RDF mirror。
- `SolidRdfSparqlEngine` 已接到 `/-/sparql` 默认引擎：受支持的 SELECT/ASK/CONSTRUCT/constructGraph/listGraphs/简单 queryVoid 走 embedded `SolidRdfEngine` primary path；未覆盖能力继续有 fallback reason 和计数。
- `SERVICE` federation 已作为禁用能力从普通 fallback 中拆出：`RdfSparqlAdapter` 会抛 `DisabledSparqlFeatureError`，`SolidRdfSparqlEngine` 和 `MixDataAccessor` 不会把它转给 compatibility engine，防止 server-owned Pod 查询隐式触发 remote federation。
- `SolidRdfSparqlEngine.getMetrics()` 已记录 primary/fallback 次数、总次数、fallback rate、耗时、fallback reason、扫描行数、返回行数、plan 和 index choices；`assertFallbackBudget(...)` 可对全局或指定 operation 设定最大 fallback count/rate，作为 benchmark window / W3C subset 的 no-regression gate。
- `bun run test:w3c` 已补上可执行的第一版 W3C 目标子集入口，覆盖当前 embedded primary path 的 SELECT/ASK/CONSTRUCT/DESCRIBE、`FROM` / `FROM NAMED` dataset scope、VALUES/VALUES `UNDEF`/OPTIONAL 内 VALUES/UNION（含 branch-local required BGP 后执行 nested UNION）/MINUS/property path、GROUP BY/HAVING、scoped DATA update 和 query-backed update smoke cases，并把 no-fallback budget gate 作为测试断言。

阶段 2：RdfQueryExecutor

- 扩大 SELECT/ASK 覆盖：补齐更多 FILTER、GRAPH、ORDER、多变量排序、aggregate、OPTIONAL、受控 UNION 和受控 dependent-join 边界。
- 让 `/-/sparql` 的 supported query shape 持续走 `SolidRdfEngine`，并用 metrics/benchmark gate 防止 fallback 反弹。
- compatibility engine 只作为显式配置的 oracle / migration / external-source helper；默认 server-owned Pod 不再把未覆盖 query 静默交给它，未覆盖 shape 应返回明确错误并保留指标。

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
- top cardinality 分布已进入 `RdfQuadIndex.cardinalityDistributions()` / `stats()`：按 graph、predicate、predicate/object、subject/predicate 暴露 quad count 和对应 distinct 计数，先作为 RDF-3X 风格 planner/benchmark 可观测统计；这些统计属于 local/cloud 共同 embedded engine 能力，QLever 后续只在 cloud-first 的 result table/cache/全文-RDF 一体化层面继续吸收。
- literal datatype distribution 已进入 `RdfQuadIndex.stats()`：按 literal datatype 统计字典中的 distinct literal term 数，以及这些 literal 作为 quad object 出现的次数，先作为 planner/benchmark 可观测统计暴露。
- PG query explain 已把 planner reason 第一版接入 `RdfQueryResult.metrics.explain.planner`：selected path 会区分 materialized result cache、query result cache、native extension、RDF-3X 和 facts fallback；reasons 会记录 cache hit、RDF-3X join order、subject-star、VALUES、aggregate、regex fallback、unsupported capability、runtime scan rows、RDF-3X stale stats 和 slow-query 触发原因；estimate inputs 和 available stats 会暴露 facts exact counts、facts cardinality distributions、literal datatype distribution、RDF-3X projection stats、PG table stats 和当前 query 的 graph / predicate / predicate-object / subject-predicate histogram hints；runtime 字段记录 scanned/joined/returned rows、duration、filter 下推和 index choices，staleStats 字段记录 facts 与 RDF-3X version lag。当前这是慢查询解释和 benchmark gate 的可观测层，后续还要把 histogram / scan rows 真正接入 cost-based cutover。
- text term document frequency 已进入 `RdfTextIndex.stats()` / `PostgresRdfTextIndex.stats()` / `termDocumentFrequency(...)`：`rdf_text_terms` 物化 normalized token posting，按 term 统计出现过的 source 数、chunk 数和总 occurrences，作为 ranking/planner 可观测统计暴露；`RdfTextIndex.search(...)` / `PostgresRdfTextIndex.search(...)` / `estimateSearchCardinality(...)` 已使用 posting 表缩小候选，并通过 normalized phrase 复验保留 substring / phrase 语义；cardinality estimate 同时支持 workspace、source prefix、source allow/deny 和 source-local window。
- vector model/dimensions distribution 已进入 `RdfVectorIndex.stats()` / `modelDistribution()`：按 embedding model 和 dimensions 统计 source 数、chunk 数、magnitude min/max/avg，作为 ranking/planner 可观测统计和后续向量后端替换评估输入；`rdf_vector_components` 已物化向量分量，`RdfVectorIndex.search(...)` 在 SQLite 层完成 dot/cosine/euclidean scoring、threshold 过滤、source-local order/window，返回结果时只解析命中的 embedding snapshot；`RdfVectorIndex.estimateSearchCardinality(...)` 已能按 dimensions、model、workspace、source prefix 和 source-local window 估算候选行数，带 threshold 的估算走 component scoring count，不再为了 planner 估算 materialize 全量命中。

阶段 4：Update delta

- `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` / 安全 `DELETE/INSERT WHERE` / 安全 `INSERT WHERE` 的 embedded index delta 和 authority file patch 已完成第一步；SolidFS 层已具备默认 runtime journal/bootstrap/replay/compact，且同一次多文件 commit 会写入同一个 `tx_id`；SPARQL 多文件 PATCH 在配置本地 RDF authority journal 时也会用同一个 `tx_id` 登记，成功统一 `done`，刷新失败统一进入 `reconcile_required`。
- 安全的 `FILTER` / `VALUES` / `BIND` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join / semi-join local WHERE 子集已在 embedded update delta 路径覆盖：先用本地查询层计算 bindings，再 materialize delete/insert quads，最后 patch 文件权威并刷新 RDF index。`BIND` 保持 expression-layer 语义，不当作 join source；template 可读取派生 binding。
- Embedded index delta 已有 operation 级 `applyDelta(...)` 事务边界；文件权威层已支持多 default `USING` 和 `USING NAMED` 读取多个本地 RDF authority files，并支持一个安全 UPDATE 同时 patch 多个明确的本地 by-line RDF authority files；`GRAPH ?g` 模板在 `?g` 有 finite named graph scope 时也可 materialize 成多文件写入，且不再必须依赖 `USING NAMED`，显式 finite graph filter 和 finite `VALUES` graph rows 也可证明安全。显式写 access scope 会在 materialized quads 提交前挡住越界目标 graph。多文件 patch 已有进程内尽力 rollback：任一目标写入或 index 刷新失败时，已写目标会恢复到更新前 quads；带 journal 的路径会额外保留同 tx 的 reconcile 视图。下一步继续扩大复杂 update 覆盖，例如更多 FILTER 表达式、更复杂 named graph shape 的安全映射评估。无法安全映射的 shape 必须保留明确 fallback/错误和指标。
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

- 是否按 workload 裁剪 facts 层六个 covering index；当前先保留全部 `rdf_quads_*`，不再额外物化 `rdf3x_*` 六排列副本。
- term dictionary 是否先用 SQL 表，还是直接做 mmap/on-disk vocabulary。
- literal FTS 先用 PostgreSQL/SQLite FTS，还是抽象成可替换 backend。
- SPARQL parser 继续使用 `sparqljs` 还是直接复用现有 `sparqlalgebrajs`。
- external provider 的 client-side query spec 是否单独成文档。
