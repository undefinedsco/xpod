# RDF Performance Report and Data Migration Plan

记录当前 RDF-3X / PostgreSQL RDF baseline 的性能结论、已验证边界和数据迁移计划。本文档描述公开仓库已经落到代码和 benchmark 的能力：`baseline`、`pg-result-cache`、`pg-hot-operators`、可选 `pg-custom-index` capability probe，以及表级 query result cache / PG SQL fast path。

## Current Decision

- 默认查询内核：`SolidRdfEngine` / `PostgresRdfEngine` 自有 RDF engine。
- 默认索引 profile：`rdf3x`。
- 事实源：SolidFS 权威文件和 RDF facts 表；RDF-3X derived stats / query cache 都是可删除、可重建的派生数据。
- 不提供用户可见的 `Hexastore / RDF-3X / QLever` backend selector。
- PostgreSQL acceleration profile 包含公开实现：`baseline | pg-result-cache | pg-hot-operators | pg-custom-index`。
- cloud 默认启用 `pg-hot-operators`：scan / graph prefix / term-in / required BGP join / VALUES join / count / numeric aggregate 由 `PostgresRdfEngine` 内置 PG SQL fast path 提供，`cache.result` 使用表级 query result cache。
- `pg-custom-index` 不改变 cloud 默认；它要求部署侧 PostgreSQL 安装 `xpod_rdf` native extension 并声明 `index.xpod_rdf_perm`。缺 extension 或缺能力时，`storageStats().pgAcceleration` 必须报告 `fallbackReason=capability-missing` 和 `missingCapabilities`，查询语义回退 RDF-3X / PG SQL baseline。
- 开源 cloud 不依赖额外数据库扩展；缺少部署侧定制能力时，Pod 读写和查询语义不受影响。

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
- Product-grade P0 不应该先做新存储；应先巩固已经证明有收益的大 BGP join、count distinct、result cache，再处理 numeric aggregate。

### Historical PostgreSQL / PGlite Baseline Gate

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --scale=small --iterations=1 --out=.test-data/rdf-pg-debug
```

运行时间：2026-06-04 本地机器。该记录保留为历史 smoke；当前 seed 已扩展为
`9` quads/message，并新增 `--caseProfile=extreme` gate。

输入规模：

| Item | Value |
| --- | ---: |
| scale | small |
| target quads | 48 |
| seed quads | 114 |
| scan cases | 19 |
| query cases | 9 |
| iterations | 1 |

通过情况：

| Gate | Result |
| --- | --- |
| PG/PGlite models plan matched | true |
| `rdf3x.syncedWithFacts` | true |
| query result cache disabled for benchmark | true |
| PG acceleration profile | `baseline` |

本次 PG/PGlite small gate 不是性能容量结论，只证明 PostgreSQL facts/RDF-3X baseline 能跑同一组 models query case，且不会用 result cache 掩盖实际执行路径。`queued run priority numeric aggregate` 已下推到 `PostgresRdf3xJoinAggregate`，`message score by thread numeric aggregate` 已下推到 `PostgresRdf3xGroupAggregate`，都不再走 `PostgresFactsQuery` fallback。

### Historical PostgreSQL / PGlite Hot-operator Profile Smoke

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --scale=small --iterations=1 --rdfAccelerationProfile=pg-hot-operators --out=.test-data/rdf-pg-hot-small
```

运行时间：2026-06-04 本地机器。该记录保留为历史 smoke，不代表新增 extreme
profile 或 native extension 的性能结论。

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
`pg-hot-operators` profile 已能在开源实现中启用 PG SQL hot operator
路径；benchmark CLI 会校验请求的 acceleration profile 已实际 enabled，避免 fallback 后
仅因 correctness 通过而误判为 acceleration 验收通过。它仍不是 medium/real-PG 性能容量结论。
`join.values` 是后续补入的 PG SQL hot operator：它把单/多 pattern BGP 上的完整 term
tuple `VALUES` source 编译成 term-id inline relation join，避免回到 JS facts binding join。
上表中的 smoke 计数尚未重跑 VALUES 专项 benchmark，不能把它当成 `join.values` 性能结论。

### PostgreSQL / PGlite Extreme Baseline Smoke

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --scale=medium --iterations=1 --warmupIterations=0 --caseProfile=extreme --rdfAccelerationProfile=baseline --out=.test-data/rdf-pg-extreme-pglite-native-smoke
```

运行时间：2026-06-06 本地 PGlite。

输入规模：

| Item | Value |
| --- | ---: |
| scale | medium |
| case profile | extreme |
| target quads | 10000 |
| seed quads | 19483 |
| scan cases | 2 |
| query cases | 10 |
| iterations | 1 |
| warmup iterations | 0 |

通过情况：

| Gate | Result |
| --- | --- |
| PGlite models plan matched | true |
| `rdf3x.syncedWithFacts` | true |
| acceleration profile | `baseline` |
| full scale seed | true |
| total / facts ratio | 1.41x |

该 smoke 证明 extreme case set 自身可复跑，并覆盖高 fanout message/thread、8-pattern
star BGP、large VALUES、COUNT DISTINCT、grouped count / grouped numeric aggregate 和
graph-prefix scan；同时新增 `native-stress.ttl` exact graph，用来让 `pg-custom-index`
发布 gate 必须命中 native extension operator。PGlite 仍不能证明 native extension
性能，只证明这组 case 在无 extension baseline 下语义和 plan gate 成立。

### PostgreSQL / PG17 Extreme Custom-index Gate

执行命令：

```bash
bun run benchmark:rdf-models:pg -- --driver=pg --connectionString=postgres://postgres:postgres@localhost:55433/xpod_models_base --allowPgWrites --scale=medium --iterations=3 --warmupIterations=1 --caseProfile=extreme --rdfAccelerationProfile=baseline --out=.test-data/rdf-pg-extreme-real-baseline-native-cases
bun run benchmark:rdf-models:pg -- --driver=pg --connectionString=postgres://postgres:postgres@localhost:55433/xpod_models_custom --allowPgWrites --scale=medium --iterations=3 --warmupIterations=1 --caseProfile=extreme --rdfAccelerationProfile=pg-custom-index --out=.test-data/rdf-pg-extreme-real-custom-native-cases-2
```

运行时间：2026-06-06 本地 PostgreSQL 17 Docker，`xpod_models_custom`
预先安装最新版 `xpod_rdf` extension。

通过情况：

| Gate | Baseline | `pg-custom-index` |
| --- | --- | --- |
| seed quads | 19483 | 19483 |
| scan cases | 2 | 2 |
| query cases | 10 | 10 |
| plan matched | true | true |
| `rdf3x.syncedWithFacts` | true | true |
| acceleration matched request | true | true |
| native extension plan hits | n/a | 5 |
| total / facts ratio | 1.41x | 1.25x |

Warm p95：

| Case | Baseline p95 | `pg-custom-index` p95 | Ratio | Path |
| --- | ---: | ---: | ---: | --- |
| month message score range scan | 13 ms | 16 ms | 1.23x | PG SQL graph-prefix |
| month message text scan | 15 ms | 15 ms | 1.00x | PG SQL graph-prefix |
| message eight-pattern star query | 142 ms | 186 ms | 1.31x | PG SQL graph-prefix |
| message large VALUES thread query | 26 ms | 32 ms | 1.23x | PG SQL graph-prefix |
| message count distinct thread query | 11 ms | 15 ms | 1.36x | PG SQL graph-prefix |
| message grouped count by thread query | 6 ms | 10 ms | 1.67x | PG SQL graph-prefix |
| message grouped numeric aggregate by thread query | 46 ms | 73 ms | 1.59x | PG SQL graph-prefix |
| native exact graph eight-pattern join query | 66 ms | 49 ms | 0.74x | `join.required_bgp.native` |
| native exact graph VALUES thread query | 14 ms | 15 ms | 1.07x | `join.values.limit.native` |
| native exact graph count distinct thread query | 6 ms | 3 ms | 0.50x | `aggregate.bgp_count` |
| native exact graph grouped count by thread query | 4 ms | 3 ms | 0.75x | `aggregate.bgp_group_count` |
| native exact graph grouped numeric aggregate by thread query | 14 ms | 6 ms | 0.43x | `aggregate.bgp_numeric` |

结论：原先的 extreme case 不够证明 custom index，因为全是 graph-prefix product
shape，实际只走 `XpodRdfPgHotOperator(...)`。新增 exact-graph native gate 后，
`pg-custom-index` 能在 5 个 case 中命中 extension operator；BGP count、grouped
count、grouped numeric aggregate 和 8-pattern exact graph join 已经比 RDF-3X /
btree baseline 快，VALUES native 仍接近持平略慢。当前不能把 graph-prefix product
shape 宣传为 native custom-index 收益；如果要让常规 Pod 日期桶查询也吃到 native，
下一步需要为 graph-prefix BGP 设计保持语义正确的 native 下推。

#### 36k Oversized Extreme Rerun

运行时间：2026-06-07 本地 PostgreSQL 17 Docker，`--scale=medium
--syntheticMessages=3000 --iterations=1 --warmupIterations=0 --caseProfile=extreme`。
这组比默认 medium smoke 的 `19483` quads 更重，用来回答 native/custom-index
是否只是小 case 偶然变快。

| Gate | Baseline | `pg-custom-index` |
| --- | ---: | ---: |
| seed quads | 36475 | 36475 |
| query cases | 10 | 10 |
| plan matched | true | true |
| `rdf3x.syncedWithFacts` | true | true |
| native extension plan hits | 0 | 5 |
| total / facts ratio | 1.40x | 1.24x |

Single-run p95：

| Case | Baseline p95 | `pg-custom-index` p95 | Ratio | Path |
| --- | ---: | ---: | ---: | --- |
| message eight-pattern star query | 233 ms | 335 ms | 1.44x | PG SQL graph-prefix |
| message large VALUES thread query | 46 ms | 57 ms | 1.24x | PG SQL graph-prefix |
| message count distinct thread query | 22 ms | 27 ms | 1.23x | PG SQL graph-prefix |
| message grouped count by thread query | 8 ms | 14 ms | 1.75x | PG SQL graph-prefix |
| message grouped numeric aggregate by thread query | 70 ms | 95 ms | 1.36x | PG SQL graph-prefix |
| native exact graph eight-pattern join query | 63 ms | 50 ms | 0.79x | `join.required_bgp.native` |
| native exact graph VALUES thread query | 13 ms | 19 ms | 1.46x | `join.values.limit.native` |
| native exact graph count distinct thread query | 3 ms | 3 ms | 1.00x | `aggregate.bgp_count` |
| native exact graph grouped count by thread query | 3 ms | 6 ms | 2.00x | `aggregate.bgp_group_count` |
| native exact graph grouped numeric aggregate by thread query | 16 ms | 9 ms | 0.56x | `aggregate.bgp_numeric` |

结论：36k seed 下 native exact graph 仍能稳定命中 5 个 extension operator，
8-pattern join 和 grouped numeric aggregate 继续变快；VALUES 和 grouped count
仍不是 cutover 依据。graph-prefix product cases 在 `pg-custom-index` profile 下变慢，
因为它们仍走 PG SQL hot path，却承担了 shadow custom index 的写入/维护成本。
这再次说明 P0 cutover 不能只看 profile 是否启用，必须按 query shape 区分：
exact graph native shape 可继续推进，常规日期桶 graph-prefix shape 需要单独做 native
graph-prefix 下推或保持 RDF-3X / PG SQL baseline。

同时尝试 `--scale=large`（目标 `1_000_000` quads）时，benchmark 长时间停在
逐条 `INSERT INTO rdf_quads ... ON CONFLICT` seed 阶段；`--syntheticMessages=10000`
的约 100k seed 在 `pg-custom-index` 下同样主要消耗在写入阶段。这个失败点是
benchmark 工具 / bulk-load 策略问题，不是 native operator 查询语义失败。正式 large
gate 前需要把 disposable benchmark 改成 bulk insert 后统一建 custom indexes，或显式
拆分 write amplification 和 warm query benchmark。

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
标记和部署边界的完成，不是已经产生数量级性能收益的新执行引擎。PGlite medium 上
它相对 RDF-3X baseline 的 query p95 大多在 0.92x-1.20x 之间，存储比完全一致。
因此后续更强查询执行器的价值必须继续用 RDF-3X baseline 做对照，不能再用旧 TEXT
baseline 来宣传收益。

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
| message score by thread numeric aggregate | 16 ms | numeric aggregate PG SQL path |
| latest message by thread query | 17 ms | large 2-pattern message join, SQL self-join stays in PG |
| message join count distinct | 8 ms | large count-distinct join, PG SQL count path |

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
边界的 product-grade 化，不是额外数据库扩展的性能结论。

## PostgreSQL Status

`PostgresRdfEngine` 当前已有：

- PG facts table 作为 baseline authority。
- RDF-3X stats / BGP join path。
- grouped count / grouped and non-grouped numeric aggregate PG SQL path。
- query result cache by facts data version。
- `rdf_query_result_cache.scope_hash` 记录 normalized cache scope 的摘要；`storageStats()` 中暴露 facts / derived / query cache 统计，包括 cache `entryCount` 和 `scopeCount`。
- `refreshDerivedIndexes()` 返回 PG planner stats refresh 结果，能证明迁移/维护动作已 `ANALYZE` facts 与 RDF-3X stats 表。
- `rdfAccelerationProfile` capability probe 暴露公开 profile：`baseline`、`pg-result-cache`、`pg-hot-operators`、`pg-custom-index`。
- `pg-hot-operators` engine-sql provider：scan / graph prefix / term-in / required BGP join / VALUES join / count / numeric aggregate 走已验证的 PG SQL fast path，并在 metrics plan 中标记 `XpodRdfPgHotOperator(...)`。
- `pg-custom-index` provider：启动时探测 `xpod_rdf.version()` / `xpod_rdf.capabilities()`，只有 `pg_extension` 里存在 `xpod_rdf` 时才把 native-only capability 标记为 `extension`；满足 `index.xpod_rdf_perm` 后创建六个 shadow custom permutation indexes，并把 `perm_index_stats(regclass)` JSON 投影到 `storageStats().pgAcceleration.customIndexes`；schema-local SQL ABI 只能声明 `cache.result`。
- `pg-custom-index` native executor：当 extension 声明 `index.xpod_rdf_perm.scan_any` 时，单 pattern exact / `$in` leading-prefix scan 会下沉到 `xpod_rdf.perm_index_scan_any(...)`，再 JOIN `rdf_quads` 做 heap recheck；当 extension 同时声明 `index.xpod_rdf_perm.count_any` 时，单 pattern、非 DISTINCT、无 group/order/pagination/values 的 scalar `COUNT` 会下沉到 `xpod_rdf.perm_index_count_any(...)`；当 extension 声明 `index.xpod_rdf_perm.distinct_any` 时，单 pattern、单投影变量、无 order/group/values 的 `DISTINCT` 会下沉到 `xpod_rdf.perm_index_distinct_any(...)`；当 extension 声明 `join.required_bgp.native` 时，2..8 pattern、最多 8 变量、无 VALUES/ORDER/GROUP/aggregate/distinct 的 exact-id required BGP 会下沉到 `xpod_rdf.bgp_join(...)`；当 extension 声明 `join.values.native` / `join.values.limit.native` 时，受限 required BGP + 单个 tuple `VALUES` source 会下沉到 `xpod_rdf.values_join(...)`；当 extension 声明 `aggregate.bgp_count` 时，2..8 pattern、最多 8 变量、无 GROUP/ORDER/HAVING/pagination 的 `COUNT(*)` / `COUNT(?x)` / `COUNT DISTINCT ?x` 会下沉到 `xpod_rdf.bgp_count(...)`，并支持同 ABI 的单个 tuple `VALUES` source；当 extension 声明 `aggregate.bgp_group_count` 时，1..8 pattern、最多 8 变量、GROUP BY 1..8 变量、COUNT / COUNT DISTINCT 聚合会下沉到 `xpod_rdf.bgp_group_count(...)`，HAVING / ORDER / LIMIT 在返回分组行后由 xpod 做语义收尾；当 extension 声明 `aggregate.bgp_numeric` 时，1..8 pattern、GROUP BY 最多 8 变量、同一个 numeric 变量上的非 DISTINCT `SUM/AVG/MIN/MAX` 和非 DISTINCT `COUNT` 会下沉到 `xpod_rdf.bgp_numeric_aggregate(...)`，只接受该 numeric slot 的 `isNumeric`/`$termType:numeric` guard，HAVING / ORDER / LIMIT 仍由 xpod 对 native grouped rows 做语义收尾。metrics plan 分别标记 `XpodRdfExtensionOperator(index.xpod_rdf_perm.scan_any)` / `XpodRdfExtensionOperator(index.xpod_rdf_perm.count_any)` / `XpodRdfExtensionOperator(index.xpod_rdf_perm.distinct_any)` / `XpodRdfExtensionOperator(join.required_bgp.native)` / `XpodRdfExtensionOperator(join.values.native|join.values.limit.native)` / `XpodRdfExtensionOperator(aggregate.bgp_count)` / `XpodRdfExtensionOperator(aggregate.bgp_group_count)` / `XpodRdfExtensionOperator(aggregate.bgp_numeric)`；能力缺失或遇到 graph-prefix/range/text/excluded/id-set/multiple VALUES sources、DISTINCT numeric aggregate、多 numeric variable 等不支持 shape 时回退 RDF-3X / PG SQL。
- `storageStats().pgAcceleration.capabilityProviders` 会按 capability 标记实际来源；`pg-hot-operators` 当前来自 `engine-sql`，`pg-custom-index` 的 custom/native capability 只能来自 `extension`。
- `bun run benchmark:rdf-models:pg` PGlite benchmark gate，对齐 SQLite models benchmark 的 deterministic seed 和 query cases；`--caseProfile=extreme` 已覆盖高 fanout message/thread、8-pattern star BGP、large VALUES、`COUNT DISTINCT`、grouped count / grouped numeric aggregate、graph-prefix scan，以及 5 个 exact-graph native custom-index gate。
- `bun run benchmark:rdf-models:pg -- --driver=pg ... --allowPgWrites` 真实 PG disposable benchmark gate；历史 medium gate 已覆盖 10066 quads、22 个 scan case 和 8 个 query case；2026-06-06 PG17 extreme gate 已覆盖 19483 quads、2 个 scan case 和 10 个 query case，并要求 `pg-custom-index` + `extreme/all` 至少命中一次 `XpodRdfExtensionOperator(...)`。

未完成：

- 更大数据量 / 并发 benchmark gate；当前已有 `caseProfile=extreme` 覆盖高 fanout message/thread、8-pattern star BGP、large VALUES、`COUNT DISTINCT`、grouped count / grouped numeric aggregate、大范围日期桶 graph prefix，以及 exact-graph native gate，并已补 36k oversized smoke。`large=1_000_000` 目前主要卡在 disposable seed 的逐条写入和 custom-index write amplification，正式 gate 前需要 bulk load / 延迟建 custom index。
- graph-prefix BGP native 下推尚未完成；常规日期桶 product shape 当前仍走 PG SQL hot path，不能把这部分宣传成 custom-index native 收益。
- `pg-custom-index` 的 native scan limit early-stop、ordered-page join 仍未作为 xpod models cutover gate。VALUES join 已完成受限形状接线并能命中 native operator，但当前 real PG extreme p95 略慢于 RDF-3X / btree baseline。
- text / vector candidate generation 与 RDF structured join 的一体化。
- query template cache、materialized result 生命周期和 auth-aware cache dashboard。
- 冷启动 stats refresh / warm steady-state 的自动化运维指标。

因此 cloud 当前可以把 PG RDF-3X baseline 当作默认正确性和 warm steady-state 性能底座，并用 `pg-hot-operators` 打开已验证的 PG SQL hot operator 与 repeated-query cache acceleration。真实 PG medium benchmark 显示 baseline 对 scan、scheduler 查询、numeric aggregate、大 fanout message join/count 的 warm steady-state 都已可用；cloud product-grade 性能发布仍应把这两个大 message case 作为 release-blocking performance gate，同时单独记录冷启动首轮耗时，避免 planner stats 或连接预热噪声被误判为稳态性能。
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

## Open Follow-ups

- 优化或禁用当前 SQLite/file-backed numeric aggregate 的 RDF-3X unconditional path。
- 增加真实 PG cold-start benchmark case：区分首次连接/首次执行、stats refresh 后首轮、warm steady-state 三个口径。
- 为 `storageStats()` 增加 cloud dashboard 指标：facts bytes、derived bytes、cache bytes、refresh lag、facts data version。
