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
- `storageStats()` 只报告当前 facts 与 derived stats 的同步状态，不触发补建。`rdf3x.syncedWithFacts=false` 是合法运行态。
- `refreshDerivedIndexes()` 是显式补建入口，供启动、维护任务、测试或运维调用。它可以从当前 facts 重建 `rdf3x_*` stats，但不是普通查询的隐式前置步骤。
- SolidFS journal 只负责本地权威文件到 Pod HTTP / index syncer 的 outbox、replay 和 compaction；它不是 RDF-3X 派生索引新鲜度证明。即使 journal 已 replay 完，仍必须用 facts `data_version` 与 `rdf3x_metadata.facts_data_version` 判断派生索引是否 needs-refresh。
- SQLite/file-backed `SolidRdfEngine` 和 PostgreSQL `PostgresRdfEngine` 都不维护第二套内存 refresh guard；query readiness、refresh skip 和 storage stats 都直接读取 durable metadata。backend 差异只保留在同步/异步 executor 与 SQL 方言上。

当前决策口径：

- Xpod 的默认 RDF 引擎已经切到自有 `SolidRdfEngine`。local/cloud/xpod/bun profile 的 `DefaultSparqlEngine` 均指向 `SolidRdfSparqlEngine -> SolidRdfEngine`，结构化 LDP 写入默认走 `MixDataAccessor -> SolidRdfDataAccessor -> SolidRdfEngine`。
- RDF-3X target core 是 local 和 cloud 都必须具备的基础查询内核。
- 当前 `RdfQuadIndex` 不再继续扩写成“准 RDF-3X”；它只服务迁移、benchmark 和 fallback。
- `Rdf3xIndex` 是 first embedded slice：已覆盖 RDF-3X 数据布局、projection stats、permutation scan、基于 bound-slot fanout 的 connected BGP join order、term merge join、受控 index-only join，以及受控 single-pattern scan / count、object text contains/endsWith scan、同 pattern tuple VALUES scan、required BGP tuple VALUES join、OPTIONAL / UNION / dependent group 内部 BGP join、join count / basic numeric aggregate / grouped count / grouped numeric aggregate primary path；大多数 models 查询带 exact graph 或 graph prefix，因此这类 shape 在 scan/count/join 中优先以 `rdf_quads` facts source 收窄候选，而不是先扫三元组 permutation 再后置过滤 graph；六排列扫描复用 `rdf_quads_spog` / `rdf_quads_posg` 等 facts covering index，不再额外物化 `rdf3x_spo` / `rdf3x_pos` / `rdf3x_triple_membership` 这类事实副本；文件型 `SolidRdfEngine` 标准配置会自动把它接成 selective primary，仍保留 `RdfQuadIndex` 作为迁移、benchmark 和 fallback。
- `SolidRdfEngine` 已接入内部 `derivedIndexProfile`：`baseline` 只保留事实层 `RdfQuadIndex` baseline，`rdf3x` 会启用 `Rdf3xIndex` 并维护 projection / graph stats。文件型 `index: { path }` 标准配置默认进入 `rdf3x` profile 并启用 selective primary；`:memory:` 和外部传入的 `RdfQuadIndex` 实例不会隐式创建第二个连接，仍可用显式 `rdf3xIndex + rdf3xPrimary` 进入 primary。query 只有在 RDF-3X 当前可表达的 single-pattern scan/count 或 required BGP（可含无 `UNDEF` 且所有变量均由 required BGP 绑定的 tuple VALUES；pattern 只含 exact term、exact term `$in` / `$notIn`、graph prefix、object range、object text contains/endsWith，以及 term-type/language/datatype metadata filter）时，才把 scan / count / join / join count / basic numeric aggregate / grouped count / grouped numeric aggregate 下推到 `Rdf3xIndex`。object range 会对 typed numeric literal 走 numeric 语义，对其他 term 走 lexical 语义；object text contains/endsWith 走 `rdf_terms.normalized_text` candidate scan 并用原始 value 复验大小写语义。当前 index-only 只用于 `DISTINCT` term projection、无 graph 变量/graph 约束、无 pagination count 的 join；这种 shape 的 named graph multiplicity 对最终 term 集合无影响，所以可直接利用 facts covering index 执行，其他 shape 仍回到 facts source。OPTIONAL / UNION / dependent join 仍由 query layer 保持控制流语义，但其内部无 group-local `VALUES` 的多 pattern BGP 可走 RDF-3X join。未覆盖 shape 自动保持 `RdfQuadIndex` fallback，不暴露 backend selector。这个边界同样为未来 PostgreSQL 实现保留空间：同一行为契约下，`RdfEngineLike` 的具体实现可以异步落到 PG，而不改变上层 SPARQL / DataAccessor API。
- `PostgresRdfEngine` 的边界不同：PG facts table 是 baseline authority，native SQL / RDF-3X planner 只是 fast path。native 不能覆盖的 scan/query shape 必须直接基于 PG facts 做后置过滤和执行，或对缺失的 text/vector source 明确报错；不能创建隐藏 SQLite cache，也不能把 unsupported shape 静默丢给另一个持久层。
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
和 `totalToFactsRatio`。benchmark report 也要带这份 storage profile 数据。
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

cloud 后续不把 QLever 作为外部 sidecar，也不把官方 QLever index 文件作为第二套事实源。
更合适的路线是把产品级 RDF 查询体验所需的 planner、executor、cache、text/vector
和索引能力翻译成 Xpod 自己的 PostgreSQL extension，暂名 `xpod_rdf`：

```text
SolidFS / journal
  -> PostgreSQL facts
       rdf_terms
       rdf_quads
       rdf_quads_* covering indexes
       rdf3x_stat_*
  -> xpod_rdf extension
       planner helpers
       RDF pattern scan / BGP join executor
       result cache / materialized result tables
       text / vector candidate merge
       future custom RDF index access method
```

这个路线的语义是 “PG-backed RDF accelerator”，不是把官方 QLever 换一个 storage
backend 后直接运行。RDF-3X、QLever、SQL optimizer 和列式/全文/vector engine 的算法
都可以作为参考，但 cloud 的事实权威仍然只有 PG facts 表；extension 里的索引、cache、
materialized result 和 text/vector 候选结构都属于 derived space，可删除、可重建，并且
必须按 facts `data_version` 失效或刷新。

实施顺序必须分层推进：

1. 先用现有 PG facts / covering indexes / RDF-3X stats 实现 planner 与 executor
   fast path，验证 query shape、storage profile 和 p95 收益。
2. 再把热点算子下沉到 PostgreSQL extension，例如 permutation scan、term-id merge
   join、count / aggregate、result cache probe 和 text candidate scoring。
3. 只有 benchmark 证明 PG btree / SQL executor 成为瓶颈时，才实现 custom scan
   provider 或 custom RDF index access method。

`xpod_rdf` 作为 PostgreSQL extension 不需要重新编译 PostgreSQL core。需要编译的是
extension 自身，并且 extension binary 必须匹配目标 PostgreSQL major version、CPU
架构和运行镜像。自托管 PG 可以把 extension 打进镜像并通过 `CREATE EXTENSION`
启用；托管 PG 如果不允许安装自定义 C/C++/Rust extension，则不能走这条路线，只能保留
PG SQL / query service 形态。

即使实现 custom index access method，也不能把 extension 变成第二套 SPO 权威。索引
可以物化 term-id postings 或排序结构，但它们只计入 derived/index space；业务 facts
仍以 `rdf_quads` 和 SolidFS journal 为准。对外仍只暴露 `SolidRdfEngine` 行为契约和
现有 `/-/sparql` 协议，不提供 “QLever backend / PG extension backend” 用户选择项。

#### 与 RDF-3X baseline 的成本 / 收益估算

RDF-3X baseline 是 local 和 cloud 的共同必备内核；`xpod_rdf` extension 不是替代这条
主线，而是 cloud 在更大数据量、更高并发、更多 text/vector 混合查询后才启用的 product-grade
acceleration profile。所有收益都必须通过 models benchmark 和真实 Pod storage profile 验证后才能
进入默认配置。

| 方案 | 预期收益 | 主要成本 | 默认策略 |
| --- | --- | --- | --- |
| PG RDF-3X baseline | 已覆盖 exact graph / graph prefix、single-pattern scan、BGP join、count / aggregate 等主路径；无需 PG extension，部署简单 | 仍受 PG btree / SQL executor / JS query layer 开销影响；text/RDF 混合和重复复杂查询需要额外 profile | cloud/local 默认继续依赖 |
| `xpod_rdf` hot-operator extension | 将 permutation scan、merge join、count / aggregate、cache probe 等 CPU 热点下沉到 PG 进程内，减少 JS/SQL 往返和中间结果搬运 | 需要编译 extension、维护 PG major version ABI、增加部署镜像复杂度；收益依赖热点 query shape | benchmark 证明 RDF-3X baseline CPU-bound 后启用 |
| `xpod_rdf` result cache / materialized result | 对重复 models 查询、常用列表页、统计页、Agent context 查询可能带来数量级延迟下降；不需要第二套 SPO | cache invalidation、权限 scope、storage TTL 和 derived space 配额必须严格控制 | 适合 cloud-first，必须绑定 `data_version` |
| `xpod_rdf` custom RDF index access method | 有机会把 PG btree 六排列替换成更接近 QLever/RDF-3X 的压缩 term-id postings / ordered stream，降低大 join 的 IO 和 CPU | 难度最高；需要处理 WAL、MVCC、VACUUM、crash recovery、rebuild、统计和 planner 接入 | 只作为后续阶段，不作为第一版 |

粗略判断：

- 对小 Pod、简单 exact graph 查询，PG RDF-3X baseline 已经足够，extension 收益有限。
- 对复杂 BGP、count / aggregate、分页列表和 repeated models 查询，hot-operator extension
  可能提供稳定的倍数级改善；如果命中 materialized result/cache，延迟改善可以远大于
  单纯 RDF-3X join 优化。
- 对 text/RDF/vector 混合检索，RDF-3X baseline 本身不是完整答案，product-grade acceleration
  profile 的收益主要来自 candidate generation、scoring、cache、materialized result 和结构化
  join 的一体化。
- storage 不能把 RDF-3X baseline、custom index 和 cache 全部叠满。若 custom RDF index
  access method 成熟，它应该逐步替代部分 PG btree covering index，而不是长期额外复制
  一整套 permutation facts。
- 如果 extension 只新增 cache / materialized result，空间增长应由 TTL、profile 和
  `storageStats()` 控制；如果新增 custom postings，必须单独报告 index/facts ratio，并以
  benchmark gate 决定是否启用。
- 当前 PG-backed query result cache 第一版已落在 `PostgresRdfEngine` 内：缓存表为
  `rdf_query_result_cache`，cache key 由 normalized query shape + facts `data_version`
  组成，写入推进 `data_version` 后旧版本缓存会被清理；engine option 提供
  `queryResultCacheEnabled`、`queryResultCacheMaxEntries`、`queryResultCacheTtlMs`
  作为 baseline 回退和 derived space 生命周期控制。

#### 完整 PG extension hot operators

`xpod_rdf` 的第一类 native 能力是 hot operators：把当前 `PostgresRdfEngine` 中已经验证
有价值、且在 PG btree / SQL executor / JS 中间结果搬运上 CPU-bound 的算子下沉到
PostgreSQL extension。它不是独立查询服务，也不是 raw SPARQL endpoint；上层仍由
`SolidRdfEngine` 传入已归一化、已 scope 的 query AST / physical plan。

首批 hot operators 范围：

| Operator | 输入 | 输出 | 用途 |
| --- | --- | --- | --- |
| `rdf_scan` | graph/source scope、term-id pattern、filter、limit/order hint | term-id row stream + metrics | single-pattern scan / candidate scan |
| `rdf_bgp_join` | required BGP physical plan、变量投影、join order / stats hint | projected binding rows / count | 多 pattern BGP join、term-id merge join |
| `rdf_count_aggregate` | BGP physical plan、group keys、aggregate expression | grouped count / numeric aggregate rows | count、group count、duration/size 等数值聚合 |
| `rdf_result_cache_probe` | normalized query shape、graph scope、auth scope、facts `data_version` | cached rows / miss reason | repeated models query、列表页、Agent context |
| `rdf_materialized_result_scan` | materialized result id、version、projection、pagination | cached/materialized row stream | 常用 dashboard / context query |
| `rdf_text_candidates` | text/vector query、source scope、limit、score options | candidate ids + score | text/vector candidate generation 后再结构化 join |

约束：

- 输入必须是 `SolidRdfEngine` 归一化后的内部 plan；不接受任意用户 SQL 或公开 SPARQL。
- 所有 scope 必须在进入 extension 前确定，包括 graph/source prefix、principal/auth scope、
  workspace/task/thread 等业务约束。
- extension 只读 PG facts 与 derived tables；写路径仍由 `SolidRdfEngine` / SolidFS journal
  负责推进 facts version。
- cache / materialized result 必须以 query shape、graph scope、auth scope、facts
  `data_version` 为 key；不能跨权限复用。
- hot operators 的收益必须由 benchmark gate 证明：同一 query shape 相比 PG RDF-3X
  baseline 有稳定 p95 改善，且 storage ratio / CPU / memory 没有超过 profile 预算。

不做：

- 不在第一版注册 public SQL API 给应用直接调用。
- 不要求 PG planner 自动理解任意 SPARQL；custom scan provider 只有在函数式 hot
  operator 接口稳定后才考虑。
- 不实现第二套更新协议；SPARQL update 仍先进入 Xpod 写路径。

#### Custom RDF index access method

`xpod_rdf` 的第二类 native 能力是 custom RDF index access method，暂名
`xpod_rdf_perm`。它只有在 hot operators + PG btree covering index 已经证明瓶颈明显时
才进入实现，不作为 P0 或第一版 extension 的前置条件。

目标：

```sql
CREATE ACCESS METHOD xpod_rdf_perm TYPE INDEX HANDLER xpod_rdf_perm_handler;

CREATE INDEX rdf_quads_spo_perm
ON rdf_quads
USING xpod_rdf_perm (subject_id, predicate_id, object_id, graph_id);
```

`xpod_rdf_perm` 应提供面向 RDF term-id 的 ordered stream / postings，而不是通用 btree：

- 支持 SPO / SOP / PSO / POS / OSP / OPS 等排列的 bound-prefix scan。
- 支持 graph/source scope 收窄，避免先扫全局三元组再后置过滤 graph。
- 支持按 term-id 有序输出，供 merge join、distinct、count、pagination 使用。
- 支持 cardinality / fanout stats 读取，供 `rdf_bgp_join` 做 join order。
- 可使用 block compression / postings layout，但它们只属于 derived/index space。

生命周期约束：

- `rdf_quads` 仍是事实权威；custom index 只是 PG index，不是第二套 SPO 业务事实。
- custom index 必须服从 PostgreSQL 的 WAL、MVCC、VACUUM、crash recovery 和 REINDEX
  语义；如果做不到，就不能进入默认 profile。
- schema version、index version、facts `data_version`、source hash 必须能在
  `storageStats()` / index metadata 中报告。
- 如果 custom index 替代部分 PG btree covering index，必须有 migration / rollback
  profile；不能长期把 btree 六排列和 custom postings 全部叠满。
- 托管 PG 不支持自定义 native extension 时，cloud 必须回退到 PG RDF-3X baseline /
  hot-operator-free profile。

验收：

- correctness 必须与 PG RDF-3X baseline / oracle query 一致。
- benchmark 必须覆盖 simple exact graph、multi-pattern BGP、graph prefix、count /
  aggregate、text candidate join、cache miss/hit、write-after-read invalidation。
- 必须报告 facts bytes、index bytes、derived/cache bytes 和 total-to-facts ratio。
- 必须提供禁用开关；禁用后 `SolidRdfEngine` 回退到 PG RDF-3X baseline，而不改变业务语义。

#### Product-facing RDF 查询能力缺口

Product-grade 不等于把完整数据库运维能力都产品化。Xpod 对外卖的是一体化服务，
用户真正感知的是两件事：能不能完成更多业务，以及速度体验是否稳定。metrics、部署、
观测和 benchmark 是内部验收手段，不是独立产品目标。

| 优先级 | 用户可感知能力 | 需要补的内容 |
| --- | --- | --- |
| P0 | 能表达更多业务查询 | models DSL / repository query 归一化成稳定 query AST；支持 relation traversal、filter、sort、pagination、count / aggregate、OPTIONAL / UNION 的常见业务 shape |
| P0 | 复杂查询速度稳定 | hot-operator pushdown、result cache、materialized result、query template cache；避免大范围 join、排序和聚合每次重新全量计算 |
| P0 | 搜索 / Agent context 更好用 | RDF literal text、文件 text chunk、embedding chunk、candidate generation、score fusion、rerank，再和结构化条件 join |
| P0 | 写入后可继续用 | SolidFS journal、SPARQL update、direct engine write、replay/reconcile 后统一推进 facts version，并失效相关 derived data |
| P1 | 失败可理解、可转向 | unsupported query shape 返回明确能力边界和可行 fallback，不能退成 500 或静默走错误路径 |

内部支撑能力仍然必须存在，但只服务于上面的用户体验：

- Cost model / stats、planner controls、index lifecycle、auth-aware cache、query timeout、
  slow query backpressure、`EXPLAIN` / trace、storage profile、benchmark / regression、
  PG extension packaging 和 rollout / rollback 都是工程验收与运维工具。
- 这些内部能力不单独驱动产品路线；只有当它们能改善业务覆盖或速度体验时才进入
  `xpod_rdf` 的优先实现范围。

因此 `xpod_rdf` 的目标不是 “实现某个著名引擎”，也不是补齐数据库厂商级全量能力，
而是在 `SolidRdfEngine` 上优先补齐用户可感知的业务查询覆盖、全文/向量融合、缓存和速度体验。

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
- `models-rdf3x-shadow-*.json`：同一批 models scan / query case 同时跑 `SolidRdfEngine` baseline 和 `Rdf3xIndex` candidate，记录 RDF-3X rebuild、matched / orderedMatched / diff、candidate physical plan、planMatched / missingPlan / failedPlanCases 和 storage profile；plan gate 只验证已存在的固定 index profile，不触发 query-time 动态建索引。

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
- `bun run benchmark:rdf-models` 已提供 repo 内可重复执行的基准入口，会构造覆盖 chat/task/thread/message/run/runStep/provider/model/credential 的 deterministic seed data，回灌 shadow index，并把 baseline / shadow / RDF-3X shadow report 保存到 `.test-data/rdf-engine/`。脚本 summary 会打印 baseline/shadow/RDF-3X plan gate、shadow performance gate 和 shadow space gate；任何 shadow diff、plan mismatch、明显 p95 退化或 medium/large 空间退化都会让命令退出非 0。
- `rdfModelsQueryBenchmarkCases` 已开始覆盖跨 pattern 的业务查询物理计划，并在 report 中记录 RdfQuery DSL 输入、physical plan 和 checksum：按 thread 拉最新 message 会要求 `ORDER BY createdAt DESC LIMIT 1` 保持在 SQL self-join 内；workspace 内下一条 queued run 会要求 status/workspace/createdAt 三个 pattern 在 SQL self-join 内完成并下推 `ORDER BY createdAt ASC LIMIT 1`；run step 列表会要求 `rdf:type RunStep` 和 `udfs:run` 关系在 SQL self-join 内完成并下推排序/分页；task materialization 会要求 `rdf:type Schedule`、`udfs:status "active"` 和 `udfs:nextRunAt <= cutoff` 在 SQL self-join 内完成，并下推 range filter、排序和分页；这些 timeline/state-center/one-to-many/scheduler 查询会和 grouped message count / message-thread `COUNT DISTINCT` 一起作为 RdfQueryExecutor 的 models-level plan gate。
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
- `SolidRdfSparqlEngine.queryVoid(...)` 已能把上述 update delta 应用到 embedded `SolidRdfEngine`：`DELETE/INSERT WHERE` 会先查询 bindings，按 SPARQL update 语义先删后插；`INSERT WHERE` 会查询 bindings 后只 materialize insert quads。每个 update operation 的 delete patterns 和 insert quads 会通过 facts index 的单次 `applyDelta(...)` transaction 提交，避免一个多 graph delta 在同一 operation 内推进多次 facts `data_version`；多条 update operation 仍保持顺序语义，后一条 operation 的 WHERE 可以读到前一条 operation 的结果。指标仍记录 `UpdateDelta` plan、delete/insert 数量和 `update-delta` index choice。
- `MixDataAccessor.executeSparqlUpdate(...)` 已补上 embedded 文件权威路径：当目标是 `.ttl` / `.jsonld` by-line RDF 文档，并且 UPDATE 属于 `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` / 安全 `DELETE/INSERT WHERE` / 安全 `INSERT WHERE` / 安全 `WITH` scoped update / default `USING` / `USING NAMED` update 的 named graph delta 时，先读取需要参与 WHERE 的本地 RDF authority files，patch 受影响的本地 RDF authority files，再逐个重建结构化 RDF index；其中 query-backed update 的 local WHERE bindings 复用 embedded `SolidRdfEngine.query(...)` 计算，所以已覆盖安全的 `FILTER` / `VALUES` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join / semi-join / 固定长度 property path 子集。多 default `USING` 和 basePath scope 内的 `USING NAMED` 已支持读取多个本地 by-line RDF graph；写入模板可以同时落在多个明确的 basePath scope 内 by-line RDF graph document，也可以在 `GRAPH ?g` 被 finite graph set、finite graph filter 或多列 `VALUES` rows 约束时按 binding 写回多个本地 graph。单进程写入过程中如果某个 authority file 或结构化 index 刷新失败，已应用的本地 authority/index 会按原始 quads 逆序尽力回滚；跨进程 crash、重启后重试和 journal 恢复仍留给后续 SolidFS sync journal。无限 graph 变量、basePath 外 graph、非 by-line RDF 写目标或其他无法安全映射到本地 graph document 的 shape 继续进入 compatibility accessor，并在回退后刷新本地 RDF mirror。
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
- embedding index 已先落为 `RdfVectorIndex` 派生索引：source/chunk/vector search 与 `SolidRdfEngine.indexVectorSource(...)` / `searchVector(...)` wrapper 已具备，`RdfQuery.vectorSearch[]` 可作为本地 binding source 再与 RDF BGP join。
- query planner 已开始把 text/vector + RDF required sources 统一重排：RDF exact pattern 用 `RdfQuadIndex.estimateCardinality(...)` 缓存估算，复杂 pattern 用 `count(...)` 兜底；未被当前 binding 约束的 text/vector source 会先走 `estimateSearchCardinality(...)` 估算 source-local hit window，避免为了 join 顺序提前 materialize 搜索结果；已经被当前 binding 约束且没有 source-local window 的 search source 仍用 exact source 条件估算兼容行数。search source 的 `limit` / `offset` 和 `orderBy` 已明确为 source-local window/order，并在 plan 中显式标注；planner 同时把 window 后输出行数和 window 前候选行数拆成不同代价，避免 broad top-K search 因为输出很小而压过更便宜的 RDF 绑定扫描。下一步是继续做向量索引后端替换评估。
- bound `source` 关系已下推到 text/vector index exact source 条件：RDF BGP 先绑定少量文件资源后，搜索 source 不再扫描整个 workspace/prefix 命中集。
- exact distinct slot / tuple 统计已先落为 `RdfQuadIndex.countDistinct(...)` / `countDistinctTuple(...)`，并复用写入/删除失效的 cardinality cache；当前同时服务于安全的单 pattern `COUNT DISTINCT ?var` 下推，以及 planner 在 connected join 上的单 slot 和多 slot distinct fanout 估算。
- top cardinality 分布已进入 `RdfQuadIndex.cardinalityDistributions()` / `stats()`：按 graph、predicate、predicate/object、subject/predicate 暴露 quad count 和对应 distinct 计数，先作为 RDF-3X 风格 planner/benchmark 可观测统计；这些统计属于 local/cloud 共同 embedded engine 能力，QLever 后续只在 cloud-first 的 result table/cache/全文-RDF 一体化层面继续吸收。
- literal datatype distribution 已进入 `RdfQuadIndex.stats()`：按 literal datatype 统计字典中的 distinct literal term 数，以及这些 literal 作为 quad object 出现的次数，先作为 planner/benchmark 可观测统计暴露。
- text term document frequency 已进入 `RdfTextIndex.stats()` / `termDocumentFrequency(...)`：`rdf_text_terms` 物化 normalized token posting，按 term 统计出现过的 source 数、chunk 数和总 occurrences，作为 ranking/planner 可观测统计暴露；`RdfTextIndex.search(...)` / `estimateSearchCardinality(...)` 已使用 posting 表缩小候选，并通过 normalized phrase 复验保留 substring / phrase 语义；cardinality estimate 同时支持 workspace、source prefix 和 source-local window。
- vector model/dimensions distribution 已进入 `RdfVectorIndex.stats()` / `modelDistribution()`：按 embedding model 和 dimensions 统计 source 数、chunk 数、magnitude min/max/avg，作为 ranking/planner 可观测统计和后续向量后端替换评估输入；`rdf_vector_components` 已物化向量分量，`RdfVectorIndex.search(...)` 在 SQLite 层完成 dot/cosine/euclidean scoring、threshold 过滤、source-local order/window，返回结果时只解析命中的 embedding snapshot；`RdfVectorIndex.estimateSearchCardinality(...)` 已能按 dimensions、model、workspace、source prefix 和 source-local window 估算候选行数，带 threshold 的估算走 component scoring count，不再为了 planner 估算 materialize 全量命中。

阶段 4：Update delta

- `INSERT DATA` / `DELETE DATA` / `DELETE WHERE` / 安全 `DELETE/INSERT WHERE` / 安全 `INSERT WHERE` 的 embedded index delta 和单文档 authority file patch 已完成第一步；后续需要把这些文件 patch 纳入 SolidFS sync journal，避免 crash 后只靠进程内 rollback。
- 安全的 `FILTER` / `VALUES` / `BIND` / `OPTIONAL` / 受控 `UNION` / 受控 anti-join / semi-join local WHERE 子集已在 embedded update delta 路径覆盖：先用本地查询层计算 bindings，再 materialize delete/insert quads，最后 patch 文件权威并刷新 RDF index。`BIND` 保持 expression-layer 语义，不当作 join source；template 可读取派生 binding。
- Embedded index delta 已有 operation 级 `applyDelta(...)` 事务边界；文件权威层已支持多 default `USING` 和 `USING NAMED` 读取多个本地 RDF authority files，并支持一个安全 UPDATE 同时 patch 多个明确的本地 by-line RDF authority files；`GRAPH ?g` 模板在 `?g` 有 finite named graph scope 时也可 materialize 成多文件写入，且不再必须依赖 `USING NAMED`，显式 finite graph filter 和 finite `VALUES` graph rows 也可证明安全。多文件 patch 已有进程内尽力 rollback：任一目标写入或 index 刷新失败时，已写目标会恢复到更新前 quads。下一步继续扩大复杂 update 覆盖，例如更多 FILTER 表达式、更复杂 named graph shape 的安全映射评估，以及 crash/retry 级 SolidFS sync journal。无法安全映射的 shape 必须保留明确 fallback/错误和指标。
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
