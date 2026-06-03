# RDF Performance Report and Data Migration Plan

记录当前 RDF-3X / PostgreSQL RDF baseline 的性能结论、已验证边界和数据迁移计划。本文档只描述已经落到代码和 benchmark 的能力；`xpod_rdf` native PostgreSQL extension 目前还没有落地，H0 schema-local SQL ABI 已覆盖 `cache.result`，native hot operator / custom index AM 不能计入已实现性能收益。

## Current Decision

- 默认查询内核：`SolidRdfEngine` / `PostgresRdfEngine` 自有 RDF engine。
- 默认索引 profile：`rdf3x`。
- 事实源：SolidFS 权威文件和 RDF facts 表；RDF-3X derived stats / query cache 都是可删除、可重建的派生数据。
- 不提供用户可见的 `Hexastore / RDF-3X / QLever` backend selector。
- PG extension 路线只作为 `PostgresRdfEngine` 内部 acceleration profile：
  `baseline | pg-result-cache | pg-hot-operators | pg-custom-index`。
- cloud 默认可启用 `pg-result-cache`：启动时安装 schema-local SQL ABI 并只激活
  `cache.result`；完整 `pg-hot-operators` / `pg-custom-index` 仍必须等独立 benchmark gate。

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

## PostgreSQL Status

`PostgresRdfEngine` 当前已有：

- PG facts table 作为 baseline authority。
- RDF-3X stats / BGP join path。
- grouped count / grouped and non-grouped numeric aggregate native SQL path。
- query result cache by facts data version。
- `storageStats()` 中暴露 facts / derived / query cache 统计。
- `refreshDerivedIndexes()` 返回 PG planner stats refresh 结果，能证明迁移/维护动作已 `ANALYZE`
  facts 与 RDF-3X stats 表。
- `rdfAccelerationProfile` capability probe，能在 `xpod_rdf` extension 缺失时稳定 fallback。
- schema-local `xpod_rdf` SQL ABI provider：当前可通过 `scripts/xpod-rdf-sql-abi.sql` 安装
  `cache.result`，engine 会调用 `xpod_rdf.result_cache_probe(...)` /
  `xpod_rdf.result_cache_store(...)`，并在 metrics plan 中标记实际 operator。
- `bun run benchmark:rdf-models:pg` PGlite benchmark gate，对齐 SQLite models benchmark 的 deterministic seed 和 query cases。
- `bun run benchmark:rdf-models:pg -- --driver=pg ... --allowPgWrites` 真实 PG disposable benchmark gate；当前 medium gate 已覆盖 10066 quads、22 个 scan case 和 8 个 query case。

未完成：

- native `xpod_rdf` hot operators。
- custom index access method `xpod_rdf_perm`。
- native PG extension 实测性能报告；baseline PG/PGlite/real-PG gate 已有，SQL ABI `cache.result`
  有单测覆盖，native extension profile 还没有。

因此 cloud 当前可以把 PG RDF-3X baseline 当作默认正确性和 warm steady-state 性能底座，并用
`pg-result-cache` 打开已验证的 repeated-query cache acceleration；`pg-hot-operators` /
`pg-custom-index` 仍只能在独立 benchmark gate 通过后进入 cloud profile。
真实 PG medium benchmark 显示 baseline 对 scan、scheduler 查询、numeric aggregate、大 fanout message join/count 的 warm steady-state 都已可用；cloud product-grade 性能发布仍应把这两个大 message case 作为 release-blocking performance gate，同时单独记录冷启动首轮耗时，避免 planner stats 或连接预热噪声被误判为稳态性能。

## Migration Strategy

### Principle

这次不做复杂在线动态索引迁移。RDF facts 和 derived index 都可从权威数据重建，因此允许清空 RDF 索引数据后重建。

迁移必须保护非 RDF 业务表：

- 账号、OIDC、client credentials、session、quota、billing、AI gateway 等非 RDF 数据不能被清理。
- R2 / COS blob 不是 RDF derived index，除非明确全量重置 Pod 内容，否则不清理。
- `rdf_query_result_cache` 可随时删除。
- `rdf3x_*` derived stats 可随时删除。

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
4. 清理 RDF derived/cache：
   - drop / truncate `rdf3x_*`
   - truncate `rdf_query_result_cache`
5. 如果 facts schema 也不兼容或现网数据可丢，继续清理 facts：
   - truncate `rdf_quads`
   - truncate `rdf_sources`
   - truncate `rdf_terms`
   - reset `rdf_index_metadata`
6. 启动新版本 xpod，执行 Pod bootstrap / SolidFS replay。
7. 执行 `refreshDerivedIndexes()`，直到 `storageStats().rdf3x.syncedWithFacts=true`，且 refresh 返回值包含 `plannerStats.analyzedTables`。
8. 跑 smoke：
   - GET WebID profile
   - list chat/task
   - load message by id
   - run/task scheduler query
   - ACL/ACR profile access
   - SPARQL graph prefix query
9. 打开写流量。
10. 观察 p95、500、401、index refresh duration、storage ratio。

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

## Operational Gates

上线前必须满足：

- `bun run build:ts` 通过。
- `bun run test:integration` 通过。
- `bun run benchmark:rdf-models -- --scale=medium --iterations=3` 通过。
- `bun run benchmark:rdf-models:pg -- --scale=small --iterations=1` 通过。
- `bun run benchmark:rdf-models:pg -- --driver=pg --connectionString=<disposable-empty-pg> --allowPgWrites --scale=medium --iterations=3 --warmupIterations=1` 通过；cloud 性能发布必须同时记录 warm steady-state p95 和 cold first-run 观测，且 `latest message by thread query` / `message join count distinct` warm p95 不能回到秒级。
- `storageStats().totalToFactsRatio` 可接受；当前 medium 参考值为 SQLite/file-backed 1.18x、真实 PG 1.39x。
- `rdf3x.syncedWithFacts=true`。
- profile / schema version 不一致时重建逻辑可重复执行。
- profile 401、models 读取、ACL/ACR 查询 smoke 通过。

PG extension 进入默认 cloud profile 前还必须额外满足：

- extension missing / capability missing fallback 不影响业务读写。
- hot operator p95 稳定优于 PG RDF-3X baseline。
- query result cache stale hit = 0。
- custom index AM 不和 btree covering indexes 永久叠满；替换前必须有 shadow benchmark 和 rollback DDL。

## Open Follow-ups

- 优化或禁用当前 SQLite/file-backed numeric aggregate 的 RDF-3X unconditional path。
- 增加真实 PG cold-start benchmark case：区分首次连接/首次执行、stats refresh 后首轮、warm steady-state 三个口径。
- 增加 cloud runbook 脚本：只清理 RDF 表，不碰 identity / ai-gateway。
- 为 `storageStats()` 增加 cloud dashboard 指标：facts bytes、derived bytes、cache bytes、refresh lag、facts data version。
