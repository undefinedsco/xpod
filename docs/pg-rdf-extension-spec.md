# PG RDF Extension Spec

本 spec 定义 Xpod 后续 `xpod_rdf` PostgreSQL extension 的边界。它是
`PostgresRdfEngine` 的内部加速层，不是新的 Pod 数据模型、不是新的公开 SPARQL
endpoint，也不是替代 SolidFS / `rdf_quads` 的第二套事实源。

相关总览见 [RDF Engine Spec](rdf-engine-spec.md) 的 Cloud Product-grade RDF
acceleration 路线。

## 目标

- 把已经在 `PostgresRdfEngine` 中验证过的热点 RDF 查询算子下沉到 PG 进程内，减少
  JS/SQL 往返、中间结果搬运和重复解析成本。
- 保留 `rdf_terms` / `rdf_quads` 作为唯一事实表；extension 只读 facts 和 derived
  tables，cache / materialized result / custom index 都是可删除、可重建的派生空间。
- 在 hot operators 证明收益后，再评估 custom RDF index access method，用更适合
  RDF term-id permutation 的 postings / ordered stream 替代部分 PG btree covering
  index。
- 对外继续只暴露 `SolidRdfEngine` 行为契约和现有 `/-/sparql` 边界，不暴露
  “QLever backend / PG extension backend” 用户选择项。

## 非目标

- 不把官方 QLever 嵌进 PG，也不把 QLever index 文件作为 Xpod 的持久事实。
- 不让应用直接调用 extension SQL API；这些函数只作为 `PostgresRdfEngine` 生成计划的
  private ABI。
- 不绕开 SolidFS journal、SPARQL update 或 `SolidRdfEngine` 写路径。
- 不在 P0 要求 custom index access method；P0 先做 hot operators 和 result cache
  的能力边界。
- 不要求托管 PG 必须支持 native extension。托管 PG 不允许安装自定义 extension 时，
  自动回退 PG RDF-3X baseline。

## 分层架构

```text
SolidFS / journal / SPARQL update
  -> Postgres facts
       rdf_terms
       rdf_quads
       rdf_quads_* covering indexes
       rdf3x_stat_*
       rdf_query_result_cache
  -> xpod_rdf extension
       hot table functions / operators
       plan cache helpers
       result cache helpers
       text/vector candidate merge helpers
       optional xpod_rdf_perm index access method
```

`xpod_rdf` 分两个阶段：

| 阶段 | 交付物 | 是否默认 | 主要价值 |
| --- | --- | --- | --- |
| H0 | SQL/PLPGSQL wrapper + capability probe | 可默认探测 | 让 `PostgresRdfEngine` 能按能力选择 path |
| H1a | Engine-sql hot operator profile | cloud 默认 | 复用 `PostgresRdfEngine` 已验证的 PG SQL scan / join / aggregate fast path，明确 product profile 与 metrics |
| H1b | Native extension scaffold / capability ABI | 可探测，随 `pg-custom-index` gate 验证 | 建立真实 C extension、版本/能力探测和部署边界 |
| H1c | Native hot operators | benchmark 通过后可替换 engine-sql operator | 降低 CPU 和中间结果搬运 |
| H2 | Result cache / materialized result helpers | cloud-first | 改善 repeated models query、列表页、Agent context |
| I0 | custom index AM storage prototype | 不默认 | 提供 `xpod_rdf_perm` AM、opclass、DDL、自有 index-relation entry storage 和 planner path |
| I1 | `xpod_rdf_perm` 替代部分 btree covering index | benchmark gate 后 | 降低复杂 join IO / storage ratio |

## Extension Packaging

`xpod_rdf` 是普通 PostgreSQL extension，不需要重新编译 PostgreSQL core。需要编译并发布
的是 extension artifact，且必须匹配 PostgreSQL major version、CPU 架构和运行镜像。

安装形态：

```sql
CREATE EXTENSION IF NOT EXISTS xpod_rdf;

SELECT xpod_rdf.version();
SELECT xpod_rdf.capabilities();
```

源码位于 `native/postgres/xpod_rdf`，本地构建入口是：

```bash
scripts/build-xpod-rdf-extension.sh
```

当前 `0.1.0-native` 已提供真实 C extension、`xpod_rdf.version()`、
`xpod_rdf.capabilities()`、`cache.result` SQL ABI、`xpod_rdf.scan_quads(...)` /
`xpod_rdf.count_quads(...)` 单 pattern scan ABI、`xpod_rdf.execute_plan_json(text)`
private plan execution ABI、`xpod_rdf_perm` custom index access
method 和 `xpod_rdf.term_id_ops` bigint opclass。`term_id_ops` 同时注册常见整数字面量
cross-type operators（`bigint` vs `integer` / `smallint`），scan-key 解码会安全转回 int64
term id。`scan_quads` 当前只接收已经由
`PostgresRdfEngine` 解析好的 term-id exact / IN pattern 和 graph-prefix 边界，并且只在
无排序、无分页、无 DISTINCT、无同 pattern 变量相等约束的单 pattern 查询上接线；
required BGP join 和 count / numeric aggregate 已可通过 `execute_plan_json` 进入 native
extension provider，但内部仍执行 `PostgresRdfEngine` 已编译好的 scope-safe PG SQL，不是最终
custom C join / aggregate executor。range/text filter 仍回退到 PG RDF-3X engine-sql path。`xpod_rdf_perm` 当前是
compressed posting prototype：它能被 PostgreSQL 创建、维护和扫描，返回正确 heap TID，
也能生成 `Index Scan` / `Bitmap Index Scan` path；build 阶段会按 permutation key 排序写入，并把
重复 full key 聚成 delta-varint TID posting stream。metapage 会记录全局有序 guard；全局有序时 scan 可根据 leading
equality/range bounds 做 block-level lower-bound seek，并在越过 upper prefix 后停止后续 block；
每个 index page 仍维护 key min/max range 和 page-local lower-bound seek；schema version 2
metapage 会记录 leading 1..4 key prefix distinct counts，并在 sorted build / sorted append
场景下标记 `prefixStatsExact=true`。planner cost 会优先使用这些 exact prefix stats 估算
rows/pages，让 selective prefix 条件在正常 planner 下生成 `Index Scan`，包括
`subject_id = 42` 这类 PG 默认解析成 `bigint = integer` 的裸整数 literal。无序 append
会降级 metapage 的全局有序和 exact-prefix 标记，回到保守扫描 / 保守成本以避免漏行和误判。
但它尚未实现 block-level skip table、custom index-aware join 算法和 custom
aggregate operator，因此不作为完整性能收益结论。

注意：`xpod_rdf.term_id_ops` 当前只支持 int64 term id 语义；除了 bigint / integer /
smallint 外的右值类型仍不应进入 custom index scan-key path。

H0 已支持 schema-local SQL ABI：当 `pg_extension` 里没有 native `xpod_rdf`，但
`xpod_rdf.version()` 和 `xpod_rdf.capabilities()` 存在时，`PostgresRdfEngine` 会把
provider 标记为 `sql-abi`。这条路径用于托管 PG / PGlite / 早期自托管部署，只暴露已经
声明的能力位；当前可安装脚本为 `scripts/xpod-rdf-sql-abi.sql`，第一版只提供
`cache.result`。

`pg-hot-operators` 当前不要求 native extension。它使用 `engine-sql` provider：scan /
graph prefix / term-in / required BGP join / count / numeric aggregate 由
`PostgresRdfEngine` 生成并执行 PG SQL，`cache.result` 仍由 schema-local SQL ABI 或 native
extension 提供。安装 native extension 时，`scan.*` 可切到 `scan_quads`，required BGP join 和
aggregate 可切到 `execute_plan_json` private ABI；后续 native extension 的职责是在不改
`PostgresRdfEngine` 物理计划语义的前提下，把这些 ABI 内部替换为 custom join / aggregate
算法，而不是新增第二套查询语义。

`pg-custom-index` 必须看到 native extension 声明 `index.xpod_rdf_perm` 后才启用。启用后
`PostgresRdfEngine` 会创建六个 shadow custom permutation indexes：
`rdf_quads_spog_perm`、`rdf_quads_sopg_perm`、`rdf_quads_psog_perm`、
`rdf_quads_posg_perm`、`rdf_quads_ospg_perm`、`rdf_quads_opsg_perm`。这些 index 进入
`storageStats().facts.spaceObjects`，但在 postings layout 达标前不能替代 btree covering
indexes。native extension 同时提供内部观测函数 `xpod_rdf.perm_index_stats(regclass)`；
`storageStats().pgAcceleration.customIndexes` 会读取 layout、compression flag、sorted
state、tuple/page 分布、prefix distinct / fanout stats、item/posting count、item bytes 和
free bytes。当前 layout 明确报告为 `compressed-posting-v1` / `compressed=true`：build
阶段会把重复 full key 聚成 delta-varint TID posting stream，schema version 2 metapage
会暴露 `distinctPrefix1..4` 和 `avgPostingsPerPrefix1..4`，但还不是 native hot-operator
性能实现。

能力探测是强制的：

- `PostgresRdfEngine` 启动时探测 extension 是否存在、版本是否兼容、能力位是否满足当前
  acceleration profile。
- 探测失败不能影响 Pod 读写；engine 记录 plan marker 后回退 PG RDF-3X baseline。
- extension 版本升级必须支持 `ALTER EXTENSION xpod_rdf UPDATE` 或明确要求重建 derived
  space。
- schema-local SQL ABI 不等价于 native extension；它只能作为 H0/H2 的函数式能力入口，
  不能声明 `scan.*` / `join.*` / `aggregate.*`。这些能力在 native extension 落地前由
  `engine-sql` provider 声明和执行。
- native extension 只能声明已经真实接线的能力。当前 native provider 可声明
  `scan.exact_graph` / `scan.graph_prefix` / `scan.term_in`，对应 `scan_quads` 的单 pattern
  term-id / graph-prefix scan；也可声明 `join.required_bgp`、`aggregate.count` 和
  `aggregate.numeric`，对应 `execute_plan_json` 执行已经由 `PostgresRdfEngine` 编译并完成
  scope 绑定的 PG SQL。
- `capabilities` 只表示 provider 声称可用的能力位；`activeOperators` 表示当前
  `PostgresRdfEngine` 已经实际接线的 operator。profile 已启用但 query 仍落回 PG RDF-3X
  baseline 时，metrics plan 必须标记 `XpodRdfExtensionUnsupported(<capability>)`。
- `capabilityProviders` 按能力位记录实际来源。当前混合 profile 中，`cache.result` 可以来自
  `sql-abi` 或 native `extension`；`scan.exact_graph` / `scan.graph_prefix` / `scan.term_in`
  可以来自 native `extension`；join / aggregate 在 native extension 安装后可以来自
  `execute_plan_json`，没有 native extension 时仍来自 `engine-sql`。

部署约束：

- 自托管 PG：extension 打进 PG 镜像，通过初始化脚本或迁移启用。
- 托管 PG：如果不允许安装 native extension，则保持 baseline profile；不得为此引入
  sidecar SPO 事实副本。
- cloud 多实例：extension 是每个 PG cluster 的能力，Pod 迁移时以目标 cluster capability
  重新选择计划。

## Private Plan ABI

上层 `PostgresRdfEngine` 仍负责把 SPARQL / models DSL 归一化成内部物理计划。extension
接收的是已经完成权限和业务 scope 绑定后的 plan，不接收原始用户 SPARQL。

最小 plan envelope：

```ts
interface XpodRdfPlanEnvelope {
  schemaVersion: number;
  factsDataVersion: number;
  queryShapeHash: string;
  graphScope: RdfGraphScope;
  authScopeHash: string;
  businessScope?: {
    workspace?: string;
    task?: string;
    thread?: string;
  };
  operators: XpodRdfPhysicalOperator[];
  output: {
    variables: string[];
    distinct?: boolean;
    order?: RdfOrderSpec[];
    limit?: number;
    offset?: number;
  };
}
```

scope 规则：

- `graphScope`、`authScopeHash` 和业务 scope 必须在进入 extension 前确定。
- cache / materialized result key 必须包含 normalized query shape、graph scope、auth
  scope 和 facts `data_version`。
- extension 不做 ACL 解释；它只执行已经 scope-safe 的 physical plan。
- 返回 rows 必须只包含 term ids / scores / metrics；term decode 仍走 `rdf_terms` 或
  `PostgresRdfEngine` dictionary。

## 完整 Hot Operators

Hot operators 是 `xpod_rdf` 的第一批 native 能力。它们可以实现为 C/Rust extension 中的
set-returning functions、internal table functions 或后续 custom scan provider，但当前不把
它们作为 public SQL API 文档化给应用。

### Operator Inventory

| Operator | P | 输入 | 输出 | 用途 |
| --- | --- | --- | --- | --- |
| `xpod_rdf.scan` | P0 | graph/source scope、term-id pattern、filter、order/limit hint | term-id row stream、exact/bitmap hit metrics | single-pattern scan、candidate scan |
| `xpod_rdf.values_join` | P0 | input tuple values、变量布局、required BGP plan | filtered bindings | `VALUES` + BGP 下推 |
| `xpod_rdf.bgp_join` | P0 | required BGP physical plan、join order/stats hint、projection | projected bindings / count cursor | multi-pattern BGP、merge/hash join |
| `xpod_rdf.count` | P0 | scan 或 BGP plan、distinct/group hint | scalar count / grouped count | count、pagination count、group count |
| `xpod_rdf.numeric_aggregate` | P0 | BGP plan、group keys、numeric expression | grouped numeric aggregate rows | sum/avg/min/max、duration/size 聚合 |
| `xpod_rdf.distinct_project` | P0 | ordered term-id stream、projection vars | deduped bindings | DISTINCT term projection、index-only result |
| `xpod_rdf.order_page` | P0 | binding stream、sort specs、limit/offset | paged binding stream | 列表页、稳定分页 |
| `xpod_rdf.result_cache_probe` | P0 | query shape、scope hash、facts version | cached rows 或 miss reason | repeated query cache 读 |
| `xpod_rdf.result_cache_store` | P0 | query shape、scope hash、facts version、rows、ttl/profile | cache metadata | repeated query cache 写 |
| `xpod_rdf.text_candidates` | P1 | text query、literal/source scope、limit、normalization profile | candidate term/source ids + score | literal text / chunk text 候选 |
| `xpod_rdf.vector_candidates` | P1 | embedding/vector query、model/profile、limit | candidate chunk/source ids + score | embedding 检索 |
| `xpod_rdf.score_fusion` | P1 | RDF bindings、text/vector candidates、weights | ranked bindings | text/RDF/vector 融合排序 |
| `xpod_rdf.optional_join` | P1 | left bindings、optional BGP group、join vars | left-join bindings | OPTIONAL 内部 group 下推 |
| `xpod_rdf.union_join` | P1 | branch plans、projection layout | unioned bindings | UNION branch 批量执行 |
| `xpod_rdf.exists_filter` | P1 | input bindings、semi/anti BGP plan | filtered bindings | EXISTS / NOT EXISTS / MINUS |
| `xpod_rdf.explain` | P1 | physical plan、capability/profile | plan diagnostics | benchmark、debug、slow query trace |

P0 的定义：支撑 models 查询、列表页、count/aggregate 和 Agent context 的核心速度体验。
P1 的定义：支撑更完整的 SPARQL shape、搜索融合和可观测性。

### Operator Semantics

`scan`

- 支持 exact graph、graph prefix 预展开后的 graph id 集合、subject/predicate/object exact
  term、`IN` / `NOT IN`、typed numeric range、lexical range、language/datatype/kind filter。
- 必须优先利用 graph/source scope 收窄候选，禁止全局扫完后只在 JS 层过滤 graph。
- 对 `$contains` / `$endsWith` 等 text filter，可先走 normalized candidate，再用原始 literal
  复验语义。

`bgp_join`

- 输入必须是 required BGP；OPTIONAL / UNION / dependent group 的控制流由上层拆成
  operator tree。
- join order 可以接受上层 hint，但 extension 必须能用 `rdf3x_stat_*` 和索引局部 stats
  做兜底估算。
- term equality、graph equality、bound prefix scan 应尽量以 ordered stream merge join
  或 bounded hash join 实现，避免物化大 cross product。

`count` / `numeric_aggregate`

- count path 必须能在不 materialize full binding rows 的情况下返回结果。
- grouped aggregate 只支持变量由 required BGP 绑定的安全子集；表达式不安全时回退
  PG RDF-3X baseline。

`result_cache_probe` / `result_cache_store`

- cache key 必须包含 `factsDataVersion`，写入推进 facts version 后旧缓存不可命中。
- cache scope 必须区分 auth/business scope；不同用户、workspace、task/thread 的结果不得复用。
- cache store ABI 必须接收 normalized `scope_hash`，用于索引和可观测性；权限解释仍在进入
  extension 前完成，extension 不根据 `scope_hash` 自行判权。
- cache row 只缓存 term ids / scalar values / score，不缓存可变权限解释。
- 当前 H0 `sql-abi` 已实现 `cache.result`：`PostgresRdfEngine` 在 capability enabled 时会调用
  `xpod_rdf.result_cache_probe(...)` / `xpod_rdf.result_cache_store(...)`，并在 metrics plan 中
  标记 `XpodRdfExtensionResultCacheProbe` / `XpodRdfExtensionResultCacheStore`；函数缺失或执行
  失败时回退 baseline cache table path。
- 当前 native `0.1.0` 已实现最小 `scan.exact_graph` / `scan.graph_prefix` / `scan.term_in` ABI：
  `PostgresRdfEngine` 对受支持的单 pattern 查询调用 `xpod_rdf.scan_quads(...)` 和
  `xpod_rdf.count_quads(...)`，并在 metrics plan 中标记 `XpodRdfExtensionScan(scan_quads)`。
  当前 native `0.1.0` 也提供 `execute_plan_json`，`PostgresRdfEngine` 会把 required BGP join
  和 count / numeric aggregate 的 compiled SQL 交给 extension 执行，并在 metrics plan 中标记
  `XpodRdfExtensionJoin(execute_plan_json)` / `XpodRdfExtensionAggregate(execute_plan_json)`。
  该 ABI 仍不是完整 native planner：排序、分页、DISTINCT、range/text filter 继续使用 PG
  RDF-3X baseline / engine-sql hot path。

`text_candidates` / `vector_candidates` / `score_fusion`

- text/vector 候选属于 candidate generation，不改变 RDF 事实。
- score fusion 后仍必须把候选与结构化 RDF 条件 join，不能用全文/向量结果绕开 graph scope。
- 第一版可以只做 PG 表内候选；pgvector、sqlite-vec、外部 ANN 或 QLever-like postings 都是后续
  execution provider。

### Fallback Contract

每个 operator 都必须有能力位：

```text
scan.exact_graph
scan.graph_prefix
scan.term_in
join.required_bgp
join.values
aggregate.count
aggregate.numeric
cache.result
text.literal_candidates
vector.chunk_candidates
```

如果当前 plan shape 不被 extension 覆盖：

- `PostgresRdfEngine` 回退 PG RDF-3X baseline / facts baseline。
- plan metrics 必须标记 `XpodRdfExtensionUnsupported(<capability>)`。
- 不允许 extension 半执行后静默丢弃 OPTIONAL / UNION / filter 语义。

## Custom Index Access Method

`xpod_rdf_perm` 是 custom PostgreSQL index access method。当前已落地 correctness
prototype；目标终态是给 RDF term-id permutation 提供更适合 merge join 和 count 的压缩
ordered stream。

PostgreSQL 的 custom index AM 通过 `CREATE ACCESS METHOD ... TYPE INDEX HANDLER ...`
注册；handler 返回 `IndexAmRoutine`，其中包含 build、insert、vacuum、scan、cost estimate
等回调。一个可被 planner 正确使用的 AM 还需要 operator class / operator family 来描述
哪些 search strategy 和 support function 可用。

### DDL Shape

优先保留 `rdf_quads` facts 表，不引入新的事实表：

```sql
CREATE EXTENSION IF NOT EXISTS xpod_rdf;

CREATE FUNCTION xpod_rdf_perm_handler(internal)
RETURNS index_am_handler
AS 'MODULE_PATHNAME'
LANGUAGE C STRICT;

CREATE ACCESS METHOD xpod_rdf_perm
TYPE INDEX
HANDLER xpod_rdf_perm_handler;

CREATE FUNCTION xpod_rdf_term_id_cmp(bigint, bigint)
RETURNS integer
AS 'MODULE_PATHNAME'
LANGUAGE C STRICT IMMUTABLE PARALLEL SAFE;

CREATE OPERATOR FAMILY xpod_rdf_term_id_family
USING xpod_rdf_perm;

CREATE OPERATOR CLASS xpod_rdf_term_id_ops
DEFAULT FOR TYPE bigint
USING xpod_rdf_perm
FAMILY xpod_rdf_term_id_family AS
  OPERATOR 1 < (bigint, bigint),
  OPERATOR 2 <= (bigint, bigint),
  OPERATOR 3 = (bigint, bigint),
  OPERATOR 4 >= (bigint, bigint),
  OPERATOR 5 > (bigint, bigint),
  FUNCTION 1 xpod_rdf_term_id_cmp(bigint, bigint);

ALTER OPERATOR FAMILY xpod_rdf_term_id_family USING xpod_rdf_perm ADD
  OPERATOR 1 < (bigint, integer),
  OPERATOR 2 <= (bigint, integer),
  OPERATOR 3 = (bigint, integer),
  OPERATOR 4 >= (bigint, integer),
  OPERATOR 5 > (bigint, integer),
  OPERATOR 1 < (bigint, smallint),
  OPERATOR 2 <= (bigint, smallint),
  OPERATOR 3 = (bigint, smallint),
  OPERATOR 4 >= (bigint, smallint),
  OPERATOR 5 > (bigint, smallint);

CREATE INDEX rdf_quads_spog_perm
ON rdf_quads
USING xpod_rdf_perm (
  subject_id xpod_rdf_term_id_ops,
  predicate_id xpod_rdf_term_id_ops,
  object_id xpod_rdf_term_id_ops,
  graph_id xpod_rdf_term_id_ops
)
WITH (permutation = 'spog', compression = 'delta-varint');
```

当前实现使用 multi-column bigint opclass `xpod_rdf.term_id_ops`。是否后续切到 composite
`xpod_rdf_quad_key` 或 expression index，由 postings prototype benchmark 决定。spec 固定
语义：facts 仍在 `rdf_quads`，index 负责提供 permutation ordered stream。

### Required Permutations

至少支持当前 RDF-3X baseline 对齐的六排列：

| Index | Key order | 主用 shape |
| --- | --- | --- |
| `rdf_quads_spog_perm` | S P O G | subject-bound、subject/predicate-bound scan |
| `rdf_quads_sopg_perm` | S O P G | subject/object-bound scan |
| `rdf_quads_psog_perm` | P S O G | predicate-bound、predicate/subject-bound scan |
| `rdf_quads_posg_perm` | P O S G | predicate/object-bound scan |
| `rdf_quads_ospg_perm` | O S P G | object-bound、object/subject-bound scan |
| `rdf_quads_opsg_perm` | O P S G | object/predicate-bound scan |

Graph 维度的处理策略：

- graph id 必须在 index tuple 或 include payload 中可用于 early scope filtering。
- 对大多数 Xpod 查询，graph/source scope 是高选择性条件；如果 `G` 放最后导致 graph
  prefix 扫描过宽，prototype 必须评估 `G S P O` / `G P O S` 等 graph-first profile。
- 不能因为自定义 permutation 省空间而牺牲 exact graph / graph prefix 的主路径性能。

### Index Layout

当前 `0.1.0-native` 的 AM 已写入 PostgreSQL index relation page，entry 包含 indexed
term-id keys 和 heap TID。它是自有 storage correctness prototype，已有 metapage、global sorted
guard、page min/max、block-level lower seek、page-local lower seek 和 compressed TID postings；
schema version 2 metapage 也已有 leading prefix distinct / fanout stats，并把 exact prefix
stats 接入 `amcostestimate`。但它还没有 block-level skip table 或 custom index-aware
join/aggregate operator。目标布局：

```text
metapage
  magic, schema_version, pg_major, permutation, options
  build_facts_data_version, source_profile_hash
  block counts, tuple counts, compression stats

posting block
  key prefix min/max
  distinct counts / fanout sketch
  compressed suffix term ids
  heap TID list
  optional score/stat payload
```

实现要求：

- 支持 bound-prefix scan、forward/backward ordered scan、bitmap scan。
- 支持 index-only scan 的可行路径评估；如果不能满足 MVCC 可见性和 returnable column
  语义，则必须显式禁用。
- 支持 block-level count / distinct estimate，供 `xpod_rdf.bgp_join` 做 cost model。
- 支持 `REINDEX`、`CREATE INDEX CONCURRENTLY` 可行性评估；不支持 concurrent build 时必须
  在 deployment profile 中说明。

### Index AM Callback Scope

当前 compressed posting prototype 已覆盖 `ambuild`、`ambuildempty`、`aminsert`、
`ambulkdelete`、`amvacuumcleanup`、`amcostestimate`、`ambeginscan`、`amrescan`、
`amgettuple`、`amgetbitmap`、`amendscan` 和 `amvalidate`。build 已经按 key 排序写入，
重复 full key 会聚成 delta-varint TID posting stream，metapage 记录全局有序状态，page opaque 已记录 min/max range；
全局有序时 scan 能从 lower bound 二分定位 data block，并在 page first entry 越过 upper prefix
后结束扫描；sorted page 继续支持 page-local lower-bound seek 和 upper-bound early stop。
schema version 2 metapage 记录 leading 1..4 prefix distinct counts；`amcostestimate` 会在
`prefixStatsExact` 未被乱序 append 清掉时使用这些 stats。下一步还需要把这些 callback 补上
block-level skip hints 和 native hot-operator 接入。目标至少需要覆盖：

| Callback | 要求 |
| --- | --- |
| `ambuild` / `ambuildempty` | 从 `rdf_quads` 构建 postings，输出 tuple/index byte stats |
| `aminsert` | facts insert 后同步维护 index entry |
| `ambulkdelete` / `amvacuumcleanup` | 配合 VACUUM 删除死 TID，维护统计 |
| `amcostestimate` | 基于 bound prefix、graph scope、stats 估算 cost/selectivity |
| `ambeginscan` / `amrescan` / `amgettuple` | 普通 ordered index scan |
| `amgetbitmap` | bitmap scan，用于较宽 candidate set |
| `amcanreturn` | 只有确认能安全 index-only 时才开启 |
| `amoptions` / `amproperty` | 暴露 permutation、compression、graph-first profile 等属性 |
| `amvalidate` | 校验 opclass / support function 完整性 |

### MVCC / WAL / Recovery

custom index AM 必须符合 PG 原生索引语义：

- index entries 指向 heap TID，查询结果仍受 PostgreSQL snapshot / MVCC 可见性约束。
- index 修改必须 WAL-safe，crash 后能通过 recovery 恢复一致状态。
- VACUUM、HOT update、dead tuple cleanup、REINDEX 都必须有明确行为。
- 如果 postings 中保存聚合 stats，stats 只能作为 cost/skip hint，不能绕过 MVCC 返回不可见 rows。
- `storageStats()` 必须报告 index version、layout/compression 状态、facts version、bytes、
  tuple count、page tuple 分布、free bytes、dead tuple pressure 和 rebuild requirement。

### Migration / Rollback

custom AM 不允许和六个 btree covering index 永久全部叠满。

上线顺序：

1. 保留 btree covering index，构建一到两个 custom permutation 做 shadow benchmark。
2. 对同 query shape 比较 correctness、p50/p95/p99、CPU、buffer read、index bytes。
3. 达标后按 profile 替代对应 btree index。
4. 回滚时 drop custom index，重新创建 btree covering index，engine 回退 baseline。

必须保留全局禁用开关：

```text
rdfAccelerationProfile = baseline | pg-result-cache | pg-hot-operators | pg-custom-index
```

这是内部部署 profile，不是用户可见 backend selector。

## Product-grade Benchmark Gate

进入默认 cloud profile 前，必须通过同一套 models benchmark：

| Case | 正确性 Oracle | 性能指标 | 空间指标 |
| --- | --- | --- | --- |
| exact graph single-pattern scan | PG facts baseline | p95、buffer read | index/facts ratio |
| graph prefix scan | PG facts baseline | p95、candidate count | index/facts ratio |
| 3-8 pattern BGP join | PG RDF-3X baseline | p95/p99、CPU、rows materialized | index/facts ratio |
| count / grouped count | PG RDF-3X baseline | p95、no full materialization | derived bytes |
| grouped numeric aggregate | PG RDF-3X baseline | p95、spill count | derived bytes |
| VALUES + BGP | PG RDF-3X baseline | p95、input tuple scale | temp bytes |
| OPTIONAL / UNION common shape | SPARQL oracle / baseline | correctness + p95 | temp bytes |
| text candidate + RDF join | baseline candidate implementation | p95、recall guard | text/vector bytes |
| query cache miss/hit | baseline query result | miss overhead、hit latency | cache bytes/ttl |
| write-after-read invalidation | facts version oracle | stale hit = 0 | stale rows = 0 |

通过标准：

- correctness 与 baseline/oracle 一致。
- p95 在目标数据集上稳定优于 baseline；小数据集无收益时不能引入明显退化。
- total derived/index/cache bytes 必须进入 `storageStats()`，并能按 profile 设置预算。
- extension missing、version mismatch、capability missing 时，业务语义不变。

## Open Questions

- custom AM 是否采用 multi-column bigint opclass、composite key，还是 expression index。
- graph-first permutation 是否应该成为 cloud 默认 profile。
- native operator 用 C、Rust pgrx，还是先用 C ABI + SQL wrapper。
- materialized result 是继续使用普通 PG table，还是进入 extension-owned storage。
- text/vector candidate provider 是否先复用 PG FTS/pgvector，再逐步替换为自研 postings。

## References

- PostgreSQL `CREATE ACCESS METHOD`: https://www.postgresql.org/docs/current/sql-create-access-method.html
- PostgreSQL Index Access Method API: https://www.postgresql.org/docs/current/index-api.html
- PostgreSQL Index Access Method Functions: https://www.postgresql.org/docs/current/index-functions.html
- PostgreSQL Operator Classes and Operator Families: https://www.postgresql.org/docs/current/indexes-opclass.html
- PostgreSQL `CREATE OPERATOR CLASS`: https://www.postgresql.org/docs/current/sql-createopclass.html
