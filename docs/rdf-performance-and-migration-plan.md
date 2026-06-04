# RDF Performance Report and Data Migration Plan

记录当前 RDF-3X / PostgreSQL RDF baseline 的性能结论、已验证边界和数据迁移计划。本文档只描述已经落到代码和 benchmark 的能力；H0 schema-local SQL ABI 已覆盖 `cache.result`，`pg-hot-operators` 在没有 native extension 时由 `PostgresRdfEngine` 内置 PG SQL fast path 提供 scan / join / aggregate operator 标记，`xpod_rdf` native PostgreSQL extension 已提供 `0.1.0-native` scaffold、`execute_plan_json` legacy private plan execution ABI、`xpod_rdf_perm` custom-index storage prototype、single-pattern scalar count 原型和受限 `subject_star_join` native join prototype，但这些 custom C/Rust hot-operator 的性能收益仍必须通过 benchmark gate 后才能计入默认能力。

## Current Decision

- 默认查询内核：`SolidRdfEngine` / `PostgresRdfEngine` 自有 RDF engine。
- 默认索引 profile：`rdf3x`。
- 事实源：SolidFS 权威文件和 RDF facts 表；RDF-3X derived stats / query cache 都是可删除、可重建的派生数据。
- 不提供用户可见的 `Hexastore / RDF-3X / QLever` backend selector。
- PG extension 路线只作为 `PostgresRdfEngine` 内部 acceleration profile：
  `baseline | pg-result-cache | pg-hot-operators | pg-custom-index`。
- cloud 默认启用 `pg-hot-operators`：启动时安装 schema-local SQL ABI 提供
  `cache.result`，并把已接线的 PG SQL scan / join / VALUES join / count / numeric aggregate
  标记为 active hot operators；`pg-custom-index` 仍必须等独立 benchmark gate。

## Benchmark Evidence

### SQLite / File-backed RDF-3X

执行命令：

```bash
bun run benchmark:rdf-models -- --scale=medium --iterations=3 --out=.test-data/rdf-performance-report
```

运行时间：2026-06-04 本地机器。

输入规模：

| Item | Value |
| --- | ---: |
| scale | medium |
| target quads | 10000 |
| seed quads | 10066 |
| synthetic messages | 2500 |
| synthetic pods | 1 |
| iterations | 3 |
| shadow backfilled rows | 10066 |
| shadow backfill duration | 338 ms |

通过情况：

| Gate | Result |
| --- | --- |
| old TEXT `QuintStore` vs term-id `SolidRdfEngine` matched | true |
| ordered matched | true |
| baseline plan matched | true |
| shadow plan matched | true |
| shadow performance matched | true |
| shadow space matched | true |
| `SolidRdfEngine` vs `Rdf3xIndex` matched | true |
| RDF-3X ordered matched | true |
| RDF-3X plan matched | true |
| RDF-3X skipped scan cases | 0 |
| RDF-3X skipped join cases | 0 |

Generated report files:

- `.test-data/rdf-performance-report/models-baseline-2026-06-03T18-43-18-151Z-71082-8c016955-6b73-43b0-a4ce-827fc9be7614.json`
- `.test-data/rdf-performance-report/models-shadow-2026-06-03T18-43-18-151Z-71082-8c016955-6b73-43b0-a4ce-827fc9be7614.json`
- `.test-data/rdf-performance-report/models-rdf3x-shadow-2026-06-03T18-43-18-151Z-71082-8c016955-6b73-43b0-a4ce-827fc9be7614.json`

## Storage Profile

本次 medium seed 下的 RDF storage profile：

| Space | Bytes | Notes |
| --- | ---: | --- |
| facts bytes | 5754880 | `rdf_terms`、`rdf_quads`、source table 和 facts covering indexes |
| facts table bytes | 2269184 | tables only |
| facts index bytes | 3485696 | includes current covering indexes |
| RDF-3X derived bytes | 1036288 | projection / graph stats，no duplicated six fact-copy tables |
| total bytes | 6791168 | facts + derived |
| total / facts ratio | 1.18x | current default profile |

RDF-3X stats:

| Item | Value |
| --- | ---: |
| membership count | 10066 |
| unique triples | 10066 |
| graph count | 38 |
| pair projection rows | 50360 |
| term projection rows | 7583 |
| total projection rows | 57943 |

结论：当前实现不是“再额外存一套六排列事实副本”。六排列扫描复用 facts 层 covering indexes，RDF-3X derived space 主要是 projection / graph stats，本次 total/facts 约 1.18x。

## Latency Findings

### Scan Cases

22 个 scan case 全部正确、plan matched。常见 graph-scoped / predicate-object / exact id 查询在 medium seed 下 p95 大多在 0-4 ms。

代表性 case：

| Case | Baseline p95 | RDF-3X p95 | Scanned Rows | Notes |
| --- | ---: | ---: | ---: | --- |
| list messages by thread | 2 ms | 3 ms | 2503 | graph prefix + predicate |
| latest message | 3 ms | 3 ms | 2504 | graph prefix + order by object desc |
| search message literals | 4 ms | 4 ms | 2500 | graph prefix + literal contains |
| latest run | 2 ms | 0 ms | 4 | task run date bucket |
| acl graph prefix scoped query | 0 ms | 3 ms | 4 | ACL-style graph prefix |

结论：scan path 没有明显退化，主要收益不是来自简单 scan，而是来自多 pattern join、count 和后续 cache/operator 下沉。

### Join / Query Cases

7 个 join/query case 全部正确、plan matched，RDF-3X 对大结果 join/count 有明显收益：

| Case | Baseline p95 | RDF-3X p95 | Improvement | Notes |
| --- | ---: | ---: | ---: | --- |
| latest message by thread query | 3372 ms | 33 ms | 102x | 2-pattern BGP + order/limit |
| message join count distinct | 1539 ms | 96 ms | 16x | count + distinct over message/thread |
| next queued run by workspace query | 4 ms | 5 ms | 0.8x | tiny result set, noise level |
| message count by thread with having | 3 ms | 5 ms | 0.6x | small grouped count |
| message score by thread numeric aggregate | 4 ms | 2006 ms | regression | current numeric aggregate plan is not ready as unconditional fast path |

结论：

- RDF-3X 作为默认 profile 是合理的，因为核心 chat/message 逆向关系和 count distinct 从秒级降到几十毫秒。
- 但当前 numeric aggregate 不能直接按“所有 aggregate 都更快”宣传。下一步要么优化 `Rdf3xJoinGroupAggregateNumeric`，要么让 planner 对小样本/低选择性 numeric aggregate 回退 baseline。
- PG extension P0 不应该先做新存储；应先下沉已经证明有收益的大 BGP join、count distinct、result cache，再处理 numeric aggregate。

### PostgreSQL / PGlite Baseline Gate

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --scale=small --iterations=1 --out=.test-data/rdf-pg-debug
```

运行时间：2026-06-04 本地机器。

输入规模：

| Item | Value |
| --- | ---: |
| scale | small |
| target quads | 48 |
| seed quads | 114 |
| scan cases | 19 |
| query cases | 8 |
| iterations | 1 |

通过情况：

| Gate | Result |
| --- | --- |
| PG/PGlite models plan matched | true |
| `rdf3x.syncedWithFacts` | true |
| query result cache disabled for benchmark | true |
| PG acceleration profile | `baseline` |

本次 PG/PGlite small gate 不是性能容量结论，只证明 PostgreSQL facts/RDF-3X baseline 能跑同一组 models query case，且不会用 result cache 掩盖实际执行路径。`queued run priority numeric aggregate` 已下推到 `PostgresRdf3xJoinAggregate`，`message score by thread numeric aggregate` 已下推到 `PostgresRdf3xGroupAggregate`，都不再走 `PostgresFactsQuery` fallback。

### PostgreSQL / PGlite Hot-operator Profile Smoke

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --scale=small --iterations=1 --rdfAccelerationProfile=pg-hot-operators --out=.test-data/rdf-pg-hot-small
```

运行时间：2026-06-04 本地机器。

通过情况：

| Gate | Result |
| --- | --- |
| PGlite models plan matched | true |
| `rdf3x.syncedWithFacts` | true |
| PG acceleration profile | `pg-hot-operators` |
| PG acceleration provider | `engine-sql` |
| PG acceleration enabled | true |
| active operators | `scan.exact_graph`, `scan.graph_prefix`, `scan.term_in`, `join.required_bgp`, `join.values`, `aggregate.count`, `aggregate.numeric`, `cache.result` |

本次 smoke 覆盖 114 quads、19 个 scan case 和 8 个 query case；physical plan 中出现
`XpodRdfPgHotOperator(scan.graph_prefix)` 15 次、`scan.exact_graph` 2 次、
`join.required_bgp` 7 次、`aggregate.count` 3 次、`aggregate.numeric` 2 次。该结果证明
`pg-hot-operators` profile 已能在没有 native extension 的情况下启用 PG SQL hot operator
路径；benchmark CLI 会校验请求的 acceleration profile 已实际 enabled，避免 fallback 后
仅因 correctness 通过而误判为 acceleration 验收通过。它仍不是 medium/real-PG 性能容量结论。
`join.values` 是后续补入的 PG SQL hot operator：它把单/多 pattern BGP 上的完整 term
tuple `VALUES` source 编译成 term-id inline relation join，避免回到 JS facts binding join。
上表中的 smoke 计数尚未重跑 VALUES 专项 benchmark，不能把它当成 `join.values` 性能结论。

### PostgreSQL / PGlite Medium RDF-3X Baseline Rerun

这组重跑把 `--rdfAccelerationProfile=baseline` 明确定义为 PG RDF-3X baseline。benchmark
脚本在 PG 路径中设置 `queryResultCacheEnabled: false`，因此结果不会被 result cache
掩盖。它回答的是：在同一套 PostgresRdfEngine / RDF-3X facts + derived stats 上，
`pg-hot-operators` 相对 RDF-3X baseline 的增量是多少。

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --scale=medium --iterations=3 --warmupIterations=1 --rdfAccelerationProfile=baseline --out=.test-data/rdf-pg-rdf3x-baseline-rerun
bun run benchmark:rdf-models:pg -- --scale=medium --iterations=3 --warmupIterations=1 --rdfAccelerationProfile=pg-hot-operators --out=.test-data/rdf-pg-hot-vs-rdf3x-rerun
```

运行时间：2026-06-04 本地 PGlite。

输入规模：

| Item | Value |
| --- | ---: |
| scale | medium |
| target quads | 10000 |
| seed quads | 10066 |
| scan cases | 22 |
| query cases | 8 |
| iterations | 3 |
| warmup iterations | 1 |

通过情况：

| Gate | RDF-3X baseline | `pg-hot-operators` |
| --- | --- | --- |
| plan matched | true | true |
| `rdf3x.syncedWithFacts` | true | true |
| acceleration profile | `baseline` | `pg-hot-operators` |
| acceleration enabled | false | true |
| acceleration matched request | true | true |
| active operators | none | `scan.exact_graph`, `scan.graph_prefix`, `scan.term_in`, `join.required_bgp`, `join.values`, `aggregate.count`, `aggregate.numeric`, `cache.result` |
| facts bytes | 22487040 | 22487040 |
| derived bytes | 8691712 | 8691712 |
| total / facts ratio | 1.39x | 1.39x |

Query p95 对比：

| Case | RDF-3X baseline p95 | `pg-hot-operators` p95 | Ratio |
| --- | ---: | ---: | ---: |
| latest message by thread query | 36 ms | 30 ms | 1.20x |
| next queued run by workspace query | 13 ms | 11 ms | 1.18x |
| run steps by run query | 6 ms | 5 ms | 1.20x |
| task materialization active due query | 17 ms | 15 ms | 1.13x |
| message count by thread with having | 7 ms | 6 ms | 1.17x |
| queued run priority numeric aggregate | 4 ms | 4 ms | 1.00x |
| message score by thread numeric aggregate | 9 ms | 8 ms | 1.13x |
| message join count distinct | 12 ms | 13 ms | 0.92x |

Representative scan p95:

| Case | RDF-3X baseline p95 | `pg-hot-operators` p95 |
| --- | ---: | ---: |
| list messages by thread | 7 ms | 9 ms |
| latest message | 3 ms | 3 ms |
| search message literals | 13 ms | 13 ms |
| latest run | 2 ms | 2 ms |
| acl graph prefix scoped query | 2 ms | 2 ms |

结论：以 RDF-3X 作为 baseline 后，当前 `pg-hot-operators` 是 product profile / capability
标记和部署边界的完成，不是已经产生数量级性能收益的 native engine。PGlite medium 上
它相对 RDF-3X baseline 的 query p95 大多在 0.92x-1.20x 之间，存储比完全一致。
因此后续 native PG extension / custom index AM 的价值必须继续用 RDF-3X baseline 做对照，
不能再用旧 TEXT baseline 来宣传收益。

本次尝试重跑 real PostgreSQL disposable benchmark 时，Docker VM 中 `postgres:17-alpine`
初始化 WAL 失败：`No space left on device`。没有执行 `docker system prune` 这类会清理用户
Docker 缓存的操作；真实 PG rerun 需要在 Docker 空间释放后补跑。

### Real PostgreSQL / Disposable Medium Gate

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --driver=pg --connectionString=<disposable-empty-pg> --allowPgWrites --scale=medium --iterations=3 --warmupIterations=1 --out=.test-data/rdf-pg-real-medium-warmup
```

运行时间：2026-06-04，本机 `postgres:17-alpine` disposable container。

输入规模：

| Item | Value |
| --- | ---: |
| scale | medium |
| target quads | 10000 |
| seed quads | 10066 |
| scan cases | 22 |
| query cases | 8 |
| iterations | 3 |
| warmup iterations | 1 |

通过情况：

| Gate | Result |
| --- | --- |
| real PG models plan matched | true |
| `rdf3x.syncedWithFacts` | true |
| query result cache disabled for benchmark | true |
| PG acceleration profile | `baseline` |
| cold report | `.test-data/rdf-pg-real-medium/models-postgres-2026-06-03T19-43-00-499Z-79511-61ee15df-e22c-4400-8176-9df6b8aeb5bb.json` |
| warm steady-state report | `.test-data/rdf-pg-existing-warmup/models-postgres-existing-warmup-1780517362264.json` |

真实 PG storage profile：

| Space | Bytes | Notes |
| --- | ---: | --- |
| facts bytes | 22503424 | PG facts tables + facts covering indexes |
| RDF-3X derived bytes | 8724480 | projection / graph stats + derived indexes |
| total bytes | 31227904 | facts + derived |
| total / facts ratio | 1.39x | PG baseline profile |

真实 PG warm steady-state representative p95：

| Case | p95 | Notes |
| --- | ---: | --- |
| list messages by thread | 7 ms | scan, graph prefix + predicate |
| latest message | 3 ms | scan + order/limit |
| search message literals | 6 ms | text contains source-membership path |
| next queued run by workspace query | 11 ms | tiny 3-pattern scheduler query |
| task materialization active due query | 23 ms | tiny 3-pattern scheduler query |
| message score by thread numeric aggregate | 16 ms | numeric aggregate native path |
| latest message by thread query | 17 ms | large 2-pattern message join, SQL self-join stays native |
| message join count distinct | 8 ms | large count-distinct join, native count path |

冷启动说明：同一批数据在未区分 warmup 的首次 disposable PG run 中，`latest message by thread query` 曾记录 `2600 ms`，`message join count distinct` 曾记录 `1674 ms`。随后对同一 seeded PG 执行 `refreshDerivedIndexes()` 后会同步 `ANALYZE` facts / RDF-3X stats 表，benchmark 也会先跑 warmup 再采样，两个 case 分别稳定到 `17 ms` 和 `8 ms`。因此旧秒级结果归类为 cold-start / planner stats artifact，不能再作为 steady-state 结论，但必须保留为冷启动观测项。PostgreSQL `refreshDerivedIndexes()` 的返回值会暴露 `plannerStats.analyzedTables`，运维和 benchmark 需要把它作为 stats refresh 已执行的证据。

结论：真实 PG medium gate 已证明 schema、refresh、planner gate、numeric aggregate 下推和 warm steady-state 性能都可用。当前 PG baseline 可以作为 cloud RDF-3X 的默认正确性和性能底座；下一步 product-grade acceleration 不应重做事实存储，而应继续补 hot operators、result cache 策略、并发和更大数据量 gate，把冷启动、统计刷新和 query cache 生命周期纳入运维指标。

### Real PostgreSQL / Hot-operator Profile Gate

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --driver=pg --connectionString=<disposable-empty-pg> --allowPgWrites --scale=medium --iterations=3 --warmupIterations=1 --rdfAccelerationProfile=pg-hot-operators --out=.test-data/rdf-pg-hot-real-medium
```

运行时间：2026-06-04，本机 `postgres:17-alpine` disposable container。

输入规模：

| Item | Value |
| --- | ---: |
| scale | medium |
| target quads | 10000 |
| seed quads | 10066 |
| scan cases | 22 |
| query cases | 8 |
| iterations | 3 |
| warmup iterations | 1 |

通过情况：

| Gate | Result |
| --- | --- |
| real PG models plan matched | true |
| `rdf3x.syncedWithFacts` | true |
| PG acceleration profile | `pg-hot-operators` |
| PG acceleration provider | `engine-sql` |
| PG acceleration enabled | true |
| active operators | `scan.exact_graph`, `scan.graph_prefix`, `scan.term_in`, `join.required_bgp`, `join.values`, `aggregate.count`, `aggregate.numeric`, `cache.result` |

真实 PG hot-profile storage profile：

| Space | Bytes | Notes |
| --- | ---: | --- |
| facts bytes | 22487040 | PG facts tables + facts covering indexes |
| derived bytes | 8658944 | RDF-3X projection / graph stats + query cache table/index |
| total / facts ratio | 1.39x | same storage profile class as PG baseline |

真实 PG hot-profile warm steady-state representative p95：

| Case | p95 | Notes |
| --- | ---: | --- |
| latest message by thread query | 35 ms | large 2-pattern message join |
| next queued run by workspace query | 20 ms | scheduler query |
| task materialization active due query | 23 ms | scheduler query |
| message count by thread with having | 26 ms | grouped count |
| queued run priority numeric aggregate | 9 ms | non-grouped numeric aggregate |
| message score by thread numeric aggregate | 15 ms | grouped numeric aggregate |
| message join count distinct | 15 ms | large count-distinct join |

physical plan 中出现 `XpodRdfPgHotOperator(scan.graph_prefix)` 18 次、`scan.exact_graph`
2 次、`join.required_bgp` 7 次、`aggregate.count` 3 次、`aggregate.numeric` 2 次。`join.values`
为后续补入，尚未包含在这次 real PG 计数里。该 gate
证明 cloud 默认 `pg-hot-operators` profile 在真实 PostgreSQL 上可启用并保持同一套 models
plan correctness；当前 hot profile 复用 PG SQL fast path，所以它是 profile/metrics/部署
边界的 product-grade 化，不是 native extension 的额外性能结论。

## PostgreSQL Status

`PostgresRdfEngine` 当前已有：

- PG facts table 作为 baseline authority。
- RDF-3X stats / BGP join path。
- grouped count / grouped and non-grouped numeric aggregate native SQL path。
- query result cache by facts data version。
- `rdf_query_result_cache.scope_hash` 记录 normalized cache scope 的摘要；`storageStats()` 中暴露
  facts / derived / query cache 统计，包括 cache `entryCount` 和 `scopeCount`。
- `refreshDerivedIndexes()` 返回 PG planner stats refresh 结果，能证明迁移/维护动作已 `ANALYZE`
  facts 与 RDF-3X stats 表。
- `rdfAccelerationProfile` capability probe，能在 `xpod_rdf` extension 缺失时稳定 fallback。
- schema-local `xpod_rdf` SQL ABI provider：当前可通过 `scripts/xpod-rdf-sql-abi.sql` 安装
  `cache.result`，engine 会调用 `xpod_rdf.result_cache_probe(...)` /
  `xpod_rdf.result_cache_store(...)`，并在 metrics plan 中标记实际 cache operator。
- `pg-hot-operators` engine-sql provider：当前不要求 native extension，scan / graph prefix /
  term-in / required BGP join / count / numeric aggregate 走 `PostgresRdfEngine` 已验证的 PG SQL
  native path，并在 metrics plan 中标记 `XpodRdfPgHotOperator(...)`。
- `storageStats().pgAcceleration.capabilityProviders` 会按 capability 标记实际来源；当前
  `pg-hot-operators` 中 `cache.result` 来自 `sql-abi`，scan / join / aggregate 来自
  `engine-sql`。
- native `xpod_rdf` extension scaffold：`native/postgres/xpod_rdf` 已提供 PG17 C extension、
  `xpod_rdf.version()`、`xpod_rdf.capabilities()`、`cache.result` SQL ABI、
  `xpod_rdf.scan_quads(...)` / `xpod_rdf.count_quads(...)` 单 pattern term-id scan ABI、
  `xpod_rdf.execute_plan_json(text)` private plan execution ABI、
  `xpod_rdf.perm_index_probe(regclass, bigint, bigint, bigint, bigint)` private index probe ABI、
  `xpod_rdf.perm_index_scan(regclass, bigint, bigint, bigint, bigint)` private leading-prefix
  custom-index scan ABI、`xpod_rdf.perm_index_scan_any(regclass, bigint[], bigint[], bigint[], bigint[])`
  private leading-prefix array custom-index scan ABI、`xpod_rdf.perm_index_count(...)` /
  `xpod_rdf.perm_index_count_any(...)` private leading-prefix scalar count ABI、`xpod_rdf.subject_star_join(...)`
  narrow native subject-star join prototype、
  `xpod_rdf_perm` custom index access method 和 `xpod_rdf.term_id_ops` bigint opclass。
- `PostgresRdfEngine` 已能在 native extension 声明 `scan.exact_graph` / `scan.term_in` 时，
  对无排序、无分页、无 DISTINCT、无同 pattern 变量相等约束的单 pattern 查询调用
  `xpod_rdf.scan_quads(...)`，并在 metrics plan 中标记
  `XpodRdfExtensionScan(scan_quads)`；普通 required BGP join、group aggregate 和 numeric
  aggregate 不再通过 `xpod_rdf.execute_plan_json(...)` 进入 extension wrapper，而是继续走
  direct PG RDF-3X SQL。只有受限 constant-predicate subject-star shape 会走
  `xpod_rdf.subject_star_join(...)` native seed/probe/recheck path；这类 shape 的 count /
  count-distinct aggregate 会复用 native subject-star rows 作为输入，aggregate 本身仍由 PG
  SQL 执行。
- `pg-custom-index` profile：只有 native extension 声明 `index.xpod_rdf_perm` 后才启用；
  engine 会创建 6 个 `rdf_quads_*_perm` shadow custom indexes。当前 AM 已写入自有
  index-relation entries，并能生成 `Index Scan` / `Bitmap Index Scan` path；build 阶段会把
  重复 full key 聚成 delta-varint compressed TID posting stream，但它仍不是完整 native
  hot-operator performance implementation。
- native direct custom-index scan foundation：native extension 声明
  `index.xpod_rdf_perm.scan` 后，`PostgresRdfEngine` 可对 exact-id leading-prefix 的单
  pattern 查询生成 `xpod_rdf.perm_index_scan(...) + rdf_quads ctid heap recheck`。C 函数直接读
  `xpod_rdf_perm` index pages 和 compressed postings；SQL 层再按 `ctid` JOIN heap 并重检四元组列，
  因此 MVCC 可见性和 stale-index 安全仍由 PG heap 负责。native extension 声明
  `index.xpod_rdf_perm.scan_any` 后，连续 leading prefix 的 `$in` / scalar 混合数组可进一步走
  `xpod_rdf.perm_index_scan_any(...) + heap recheck`。当前不覆盖 graph-prefix、range/text filter、
  排序/分页、DISTINCT 或 join。单 pattern、非 DISTINCT `COUNT` aggregate 在 native provider
  声明 `index.xpod_rdf_perm.count` / `index.xpod_rdf_perm.count_any` 后会走
  `xpod_rdf.perm_index_count(_any)(...)`，由 extension 直接扫描 custom index pages、应用完整
  graph/subject/predicate/object id filters 并进行 heap visibility recheck；能力缺失或遇到
  graph-prefix/range/text/excluded filter 时回退到 direct custom-index scan 的
  `COUNT(*) + heap recheck` SQL。完整 grouped / numeric aggregate 仍未进入 custom C/Rust executor。
- `storageStats().pgAcceleration.customIndexes` 会读取 native
  `xpod_rdf.perm_index_stats(regclass)` 和 `xpod_rdf.perm_index_probe(...)`，报告每个 shadow
  index 的 layout、compression flag、sorted state、tuple/page 分布、prefix distinct / fanout
  stats、item/posting count、item bytes、free bytes 和 native leading-prefix probe 页访问统计。当前 layout 必须显示
  `compressed-posting-v1` / `compressed=true`；
  schema version 2 的 metapage 会在 sorted build / sorted append 场景下报告 exact prefix
  stats，并让 AM cost estimate 使用这些真实前缀基数。直到后续 skip table 和 hot operators
  落地前，它仍只能作为 native index storage / planner milestone。
- `bun run benchmark:rdf-models:pg` PGlite benchmark gate，对齐 SQLite models benchmark 的 deterministic seed 和 query cases。
- `bun run benchmark:rdf-models:pg -- --driver=pg ... --allowPgWrites` 真实 PG disposable benchmark gate；当前 medium gate 已覆盖 10066 quads、22 个 scan case 和 8 个 query case。

未完成：

- `xpod_rdf_perm` block-level skip table / skip hints；当前已经完成 delta-varint
  compressed posting storage、metapage prefix distinct / fanout stats 和 prefix-stats-aware
  planner cost，也补了 `perm_index_probe` 来直接验证 native index page seek / skip / match 行为；
  但还没有把这些 stats 变成 join 算法的跳跃执行结构。
- native PG extension custom hot operators。当前 `scan_quads/count_quads` 单 pattern scan ABI
  已接线；exact leading-prefix 单 pattern 可进一步走 `perm_index_scan + heap recheck` direct
  custom-index path，`$in` leading-prefix 单 pattern 可走 `perm_index_scan_any + heap recheck`
  direct custom-index path；单 pattern 非 DISTINCT `COUNT` aggregate 可走 native
  `perm_index_count(_any)`，受限 subject-star join 可走 `subject_star_join`。普通 required BGP join、group
  aggregate 和 numeric aggregate 仍复用 direct PG RDF-3X SQL，不是 custom C/Rust join /
  aggregate execution。
- native PG extension medium/large 性能报告；small correctness gate 已有，性能收益仍必须对比
  RDF-3X baseline。

因此 cloud 当前可以把 PG RDF-3X baseline 当作默认正确性和 warm steady-state 性能底座，并用
`pg-hot-operators` 打开已验证的 PG SQL hot operator 与 repeated-query cache acceleration；
`pg-custom-index` 仍不能进入默认 cloud profile，只能作为 shadow/correctness profile 验证
native extension packaging、capability 和 custom-index DDL。
真实 PG medium benchmark 显示 baseline 对 scan、scheduler 查询、numeric aggregate、大 fanout message join/count 的 warm steady-state 都已可用；cloud product-grade 性能发布仍应把这两个大 message case 作为 release-blocking performance gate，同时单独记录冷启动首轮耗时，避免 planner stats 或连接预热噪声被误判为稳态性能。

## Migration Strategy

### Principle

这次不做复杂在线动态索引迁移。RDF facts 和 derived index 都可从权威数据重建，因此允许清空 RDF 索引数据后重建。

迁移必须保护非 RDF 业务表：

- 账号、OIDC、client credentials、session、quota、billing、AI gateway 等非 RDF 数据不能被清理。
- R2 / COS blob 不是 RDF derived index，除非明确全量重置 Pod 内容，否则不清理。
- `rdf_query_result_cache` 可随时删除。
- `rdf3x_*` derived stats 可随时删除。
- `rdf_query_result_cache.scope_hash` 是派生观测字段；旧行可用 `legacy` 默认值，清 cache 后会自然重建。

### Data Classes

| Data | Migration Action |
| --- | --- |
| SolidFS authority files | 保留；作为重建 facts 的输入 |
| `rdf_terms` / `rdf_quads` / `rdf_sources` | schema/profile 不兼容时清空并重建 |
| `rdf3x_*` stats | 清空并通过 `refreshDerivedIndexes()` 重建 |
| `rdf_query_result_cache` | 清空；写入后按 facts version 自然重建 |
| old TEXT `quints` compatibility store | 只作为迁移源或 oracle，不作为新默认查询事实 |
| R2 / COS objects | 默认不动；当前如果确认无业务数据，可跳过 |
| identity / auth / quota tables | 不动 |

### Local Migration

适用于本地 SQLite / file-backed engine。

1. 停止 xpod 进程，避免写入竞争。
2. 保留 workspace / SolidFS 文件。
3. 删除本地 RDF index 数据库或让 schema version guard 自动重建。
4. 启动 xpod。
5. bootstrap / journal replay 扫描 SolidFS 权威文件，按 source 调用 `replaceSource(...)` 回填 facts。
6. 运行 `refreshDerivedIndexes()` 重建 RDF-3X stats。
7. 跑 `bun run benchmark:rdf-models -- --scale=small --iterations=1` 做本地 smoke；发布前跑 medium。

### Cloud Migration

适用于 PostgreSQL-backed xpod cloud。

1. 进入维护窗口，暂停写请求、Agent run 调度和后台 index refresh。
2. 备份 PG schema 或至少备份待清理表：
   - `rdf_terms`
   - `rdf_quads`
   - `rdf_sources`
   - `rdf_index_metadata`
   - `rdf3x_*`
   - `rdf_query_result_cache`
3. 确认清理 scope 只包含 xpod cloud RDF 表，不包含 ai-gateway 或其他服务 schema。
4. 先 dry-run RDF-only reset，确认脚本只列出 RDF facts / RDF-3X / query cache / metadata 表：

   ```bash
   bun run ops:rdf:reset:pg -- --connectionString=<cloud-xpod-pg-url>
   ```

5. 清理 RDF derived/cache：

   ```bash
   bun run ops:rdf:reset:pg -- --connectionString=<cloud-xpod-pg-url> --execute --confirm=RESET_XPOD_RDF_DERIVED
   ```

6. 如果 facts schema 也不兼容或现网数据可丢，继续清理 facts。这个模式会额外 truncate
   `rdf_quads` / `rdf_sources` / `rdf_terms`，并重置 facts `data_version`：

   ```bash
   bun run ops:rdf:reset:pg -- --connectionString=<cloud-xpod-pg-url> --includeFacts --execute --confirm=RESET_XPOD_RDF_FACTS
   ```

   该脚本只触碰 xpod RDF 表，不能用于清理 identity、auth、quota、billing、AI gateway 或 R2/COS。
7. 启动新版本 xpod，执行 Pod bootstrap / SolidFS replay。
8. 执行 `refreshDerivedIndexes()`，直到 `storageStats().rdf3x.syncedWithFacts=true`，且 refresh 返回值包含 `plannerStats.analyzedTables`。
9. 跑 smoke：
   - GET WebID profile
   - list chat/task
   - load message by id
   - run/task scheduler query
   - ACL/ACR profile access
   - SPARQL graph prefix query
10. 检查 `storageStats().queryResultCache.scopeCount` 能随不同 principal / workspace cache scope
    增长，确认 result cache 没有跨 scope 复用。
11. 打开写流量。
12. 观察 p95、500、401、index refresh duration、storage ratio、cache entry/scope ratio。

### Rollback

如果新索引导致 correctness 或 auth 查询异常：

1. 关闭写流量。
2. 切回上一版镜像。
3. 如果只清了 derived/cache：直接启动旧版，让旧版使用 facts。
4. 如果 facts 已清空：从备份恢复 RDF 表，或重新从 SolidFS 权威文件回填。
5. 清空 query result cache，避免 facts version 不一致造成误判。

如果 `xpod_rdf` extension profile 出问题：

1. 将 acceleration profile 改回 `baseline`。
2. 不需要迁移数据。
3. 删除 extension-owned custom index/cache 之前先确认 `storageStats()` 中没有 active profile 依赖。

### Native PG Extension / Custom-index Small Gate

执行命令：

```bash
scripts/build-xpod-rdf-extension.sh
bun run benchmark:rdf-models:pg -- --driver=pg --connectionString=<pg17-db-with-create-extension-xpod_rdf> --allowPgWrites --scale=small --iterations=1 --warmupIterations=1 --rdfAccelerationProfile=pg-custom-index --out=.test-data/rdf-pg-custom-index-native-small
```

运行时间：2026-06-04，本机 `postgres:17-alpine` disposable container。

通过情况：

| Gate | Result |
| --- | --- |
| native extension build | passed (`xpod_rdf.so`) |
| `CREATE EXTENSION xpod_rdf` | passed |
| `xpod_rdf.version()` | `0.1.0-native` |
| native capability includes `scan.exact_graph`, `scan.term_in`, `index.xpod_rdf_perm`, `index.xpod_rdf_perm.scan_any` | true |
| `xpod_rdf.scan_quads(...)` / `xpod_rdf.count_quads(...)` smoke | passed |
| `CREATE INDEX ... USING xpod_rdf_perm` | passed |
| `xpod_rdf.perm_index_stats(...)` / `xpod_rdf.perm_index_probe(...)` smoke | passed |
| `xpod_rdf.perm_index_scan(...) + rdf_quads.ctid heap recheck` smoke | passed |
| `xpod_rdf.perm_index_scan_any(...) + rdf_quads.ctid heap recheck` smoke | passed |
| forced planner path | `Index Scan` on `rdf_quads_spog_perm` |
| insert + vacuum smoke | passed |
| real PG models plan matched | true |
| `rdf3x.syncedWithFacts` | true |
| acceleration profile | `pg-custom-index` |
| acceleration enabled | true |
| active operators | `aggregate.count`, `aggregate.numeric`, `cache.result`, `index.xpod_rdf_perm`, `index.xpod_rdf_perm.scan`, `index.xpod_rdf_perm.scan_any`, `join.required_bgp`, `join.values`, `scan.exact_graph`, `scan.graph_prefix`, `scan.term_in` |
| custom indexes created | 6 (`rdf_quads_*_perm`) |
| storage total/facts ratio | 1.69x on small seed |

报告文件：

```text
.test-data/rdf-pg-custom-index-ordered-small/models-postgres-2026-06-04T08-33-59-083Z-44597-a4697222-29af-4af2-a57a-a42faae57021.json
.test-data/rdf-pg-custom-index-seek-small/models-postgres-2026-06-04T08-50-26-959Z-47420-e073c466-cde2-4c0c-b0fc-f41531d02f91.json
.test-data/rdf-pg-custom-index-block-seek-small/models-postgres-2026-06-04T09-14-52-335Z-51557-b2b17107-76d4-497b-9d5a-aa8098398592.json
```

结论：native extension packaging、capability probe、`pg-custom-index` profile、custom AM DDL
和 benchmark correctness gate 已打通。当前 `xpod_rdf_perm` 已从 heap-scan prototype 升级为
index-relation storage prototype，能支持 build / insert / index scan / bitmap scan / vacuum；
build 已按 permutation key 排序，metapage 记录 global sorted guard，page opaque 记录 min/max
range；全局有序时 scan 会按 leading equality/range bounds 做 block-level lower-bound seek，
并在越过 upper prefix 后停止后续 block；sorted page 继续做 page-local lower-bound seek 和
upper-bound early stop。`storageStats().pgAcceleration.customIndexes` 会暴露每个 shadow
index 的 `layout=compressed-posting-v1`、`compressed=true`、page tuple count、prefix distinct /
fanout stats、item/posting count、item bytes、free bytes 和 `perm_index_probe` 页访问统计，用作后续
skip table 和 hot operators 的基线。custom index AM 当前已有 prefix-stats-aware planner cost：schema version 2
metapage 会记录 leading 1..4 key prefix distinct counts；当 index 保持 sorted append 时这些
stats 维持 exact，一旦乱序 append 就清掉 exact flag 并回到保守成本。真实 PG17 smoke 中，100k-row `rdf_quads` + `xpod_rdf_perm(S,P,O,G)`
在 leading equality 和 leading range 条件下均由正常 planner 选择 `Index Scan`。smoke 同时覆盖
bigint-typed 参数、裸整数 literal（PG 解析为 `bigint = integer`）和 `smallint` literal；
custom opfamily 会把 `integer` / `smallint` scan key 安全转成 int64 term id。其他非 bigint
右值类型仍不进入 custom index path。
无序 append 会降级全局有序标记，
回到保守扫描以保证正确性。仍需要注意：这还不是完整 native hot-operator performance
implementation，因此不能把这组 gate 作为默认引擎性能收益证明。下一步性能工作是在 medium/large +
concurrency gate 中对比 RDF-3X baseline，并把 native hot operators 接到 join / aggregate path。

同一轮还跑了真实 PG small RDF-3X baseline 对照：

```text
.test-data/rdf-pg-rdf3x-baseline-small-ordered/models-postgres-2026-06-04T08-32-58-378Z-44497-952fde4c-945b-4eff-9bf0-9abb0472d06a.json
```

small seed 为 114 quads，baseline 与 `pg-custom-index` 都是 19 个 scan case / 8 个 query
case plan matched，`rdf3x.syncedWithFacts=true`。这些旧报告生成时，`pg-custom-index` 的
`scan.*` / `join.*` / `aggregate.*` provider 仍是 `engine-sql`，native extension 只提供
`cache.result` 和 `index.xpod_rdf_perm`；查询物理计划仍主要是 `Rdf3xMembershipScan` /
`PostgresRdf3xJoin`。当前代码已经补上 `scan_quads/count_quads` ABI、`perm_index_scan`
leading-prefix direct custom-index ABI、`perm_index_scan_any` leading-prefix array direct
custom-index ABI 和受限 `subject_star_join` ABI，`scan.exact_graph` /
`scan.graph_prefix` / `scan.term_in` 可由 native extension provider 执行受支持的单 pattern
scan；exact leading-prefix 单 pattern 在 `index.xpod_rdf_perm.scan` 存在时可绕过 `scan_quads`
SPI 包装，直接读 custom index pages 后 heap recheck。2026-06-04 的 disposable PG17 smoke
已确认 `(subject_id=1,predicate_id=10)` prefix scan 返回两个 heap TID，join 回 `rdf_quads`
并按四元组列重检后得到预期两行；同日新增的 `perm_index_scan_any` smoke 已确认
`ARRAY[1,2,2] x ARRAY[10]` prefix scan 会去重并返回预期两行。ordinary join 和 aggregate 仍由
direct PG RDF-3X SQL 执行，受限 subject-star shape 可由 native extension
provider 执行 seed/probe/recheck。

因此 small 对照没有稳定性能收益：例如 `latest message by thread query` 从 6 ms 到 14 ms、
`list messages by thread` 从 2 ms 到 7 ms、`task materialization active due query` 从
14 ms 到 21 ms；少数 case 持平或略快。

2026-06-04 的真实 PG17 medium rerun 已补齐 `engine.scan()` 的 direct custom-index path、
`subject_star_join` prototype、ordinary join/aggregate direct SQL fallback，以及 DISTINCT
aggregate graph-prefix plan fence 后重新验证：

```text
.test-data/rdf-pg-product-grade-alpine-baseline/models-postgres-2026-06-04T17-25-09-888Z-29538-ef98b917-4ecd-45a9-83be-231e2120090c.json
.test-data/rdf-pg-subject-star-final3/models-postgres-2026-06-04T18-56-11-341Z-35577-71ebe490-3fcc-4516-8d1b-800d2ff9b5ea.json
```

medium seed 为 10066 quads，baseline 和 `pg-custom-index` 都是 22 个 scan case / 8 个 query case
plan matched，`rdf3x.syncedWithFacts=true`，`pg-custom-index` active operators 包含
`index.xpod_rdf_perm.scan`、`index.xpod_rdf_perm.scan_any`、`join.subject_star`、
`scan.graph_prefix`、`join.required_bgp`、`join.values` 和 aggregate capabilities。存储口径为
`pg-custom-index` facts bytes `28,975,104`、RDF-3X derived bytes `8,617,984`、custom perm
index bytes `3,244,032`、total/facts `1.30x`。refresh 阶段 reindex 6 个 perm index 约
`1.4s`，planner analyze 约 `0.1s`。

关键 scan case：

| Case | RDF-3X baseline p95 | `pg-custom-index` p95 | Custom path |
| --- | ---: | ---: | --- |
| load by exact id | 2 ms | 2 ms | `perm_index_scan(SPO,prefix:1)` |
| list providers | 3 ms | 5 ms | `scan_quads` graph-prefix |
| models by provider | 2 ms | 7 ms | `perm_index_scan(POS,prefix:2)` |
| credentials by provider | 2 ms | 4 ms | `perm_index_scan(POS,prefix:2)` |

关键 query case：

| Case | RDF-3X baseline p95 | `pg-custom-index` p95 | Custom path |
| --- | ---: | ---: | --- |
| latest message by thread query | 21 ms | 22 ms | `subject_star_join(seed:POS,probes:PSO)` |
| next queued run by workspace query | 10 ms | 12 ms | `subject_star_join(seed:POS,probes:PSO>PSO)` |
| run steps by run query | 6 ms | 7 ms | `subject_star_join(seed:POS,probes:PSO)` |
| task materialization active due query | 25 ms | 21 ms | direct `Rdf3xJoinBGP` |
| message count by thread with having | 6 ms | 9 ms | direct `Rdf3xJoinBGP` |
| queued run priority numeric aggregate | 5 ms | 6 ms | direct `Rdf3xJoinBGP` |
| message score by thread numeric aggregate | 10 ms | 11 ms | direct `Rdf3xJoinBGP` |
| message join count distinct | 10 ms | 16 ms | direct `Rdf3xJoinBGP` with graph-prefix fence |

`execute_plan_json` 不再作为 ordinary join / aggregate 执行路径。之前 `message join count
distinct` 在 cold full benchmark 中会被 PG 拉平成坏 semi-join，产生约 `200ms` p50；现在只对
DISTINCT aggregate 的 graph-prefix subquery 加 plan fence，p95 回到 `16ms`。整体结论仍然是
`pg-custom-index` 只能作为 shadow/experimental profile：它证明 native extension packaging、
custom index storage、direct single-pattern scan 和 narrow subject-star join，但 medium
models benchmark 尚未稳定快过 RDF-3X baseline。下一步不是扩大默认启用面，而是补成本模型：
只有当 custom path 的估算收益明确高于 source-membership/BTree/RDF-3X SQL 时才路由过去。

## Operational Gates

上线前必须满足：

- `bun run build:ts` 通过。
- `bun run test:integration` 通过。
- `bun run benchmark:rdf-models -- --scale=medium --iterations=3` 通过。
- `bun run benchmark:rdf-models:pg -- --scale=small --iterations=1` 通过。
- `bun run benchmark:rdf-models:pg -- --driver=pg --connectionString=<disposable-empty-pg> --allowPgWrites --scale=medium --iterations=3 --warmupIterations=1` 通过；cloud 性能发布必须同时记录 warm steady-state p95 和 cold first-run 观测，且 `latest message by thread query` / `message join count distinct` warm p95 不能回到秒级。
- 显式传入 `--rdfAccelerationProfile=<profile>` 的 PG benchmark 必须显示
  `pg acceleration matched request: true`；非 baseline profile fallback 时命令必须非零退出。
- `storageStats().totalToFactsRatio` 可接受；当前 medium 参考值为 SQLite/file-backed 1.18x、真实 PG 1.39x。
- `rdf3x.syncedWithFacts=true`。
- profile / schema version 不一致时重建逻辑可重复执行。
- profile 401、models 读取、ACL/ACR 查询 smoke 通过。
- result cache smoke 需要覆盖不同 cache scope：同一 query 在 Alice/Bob scope 下应产生不同 cache
  entry，`storageStats().queryResultCache.scopeCount` 应反映该隔离。

native PG extension 或 `pg-custom-index` 进入默认 cloud profile 前还必须额外满足：

- extension missing / capability missing fallback 不影响业务读写。
- hot operator p95 稳定优于 PG RDF-3X baseline。
- query result cache stale hit = 0。
- custom index AM 不和 btree covering indexes 永久叠满；替换前必须有 shadow benchmark 和 rollback DDL。

## Open Follow-ups

- 优化或禁用当前 SQLite/file-backed numeric aggregate 的 RDF-3X unconditional path。
- 增加真实 PG cold-start benchmark case：区分首次连接/首次执行、stats refresh 后首轮、warm steady-state 三个口径。
- 为 `storageStats()` 增加 cloud dashboard 指标：facts bytes、derived bytes、cache bytes、refresh lag、facts data version。
