# RDF P0/P1 功能与性能验收交接

## 2026-08-12 当前权威验收状态

> 本节覆盖下方 2026-08-05 的历史接续状态。历史问题和实验记录继续保留，
> 但不得再据此判断当前 PostgreSQL 17 候选镜像是否通过。

### PostgreSQL 17 / QLever：候选镜像验收通过

已在 SealOS 广州集群对不可变镜像执行启动、运行时能力、原生语义、权限和
事务回滚验收，全程使用 `engine=qlever-native-only`：

- PostgreSQL 候选镜像：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:1865b23c18bf2425f2e7dd2beed154e3766ba21d01f43ba35fd9abd3374b4dc4`
- QLever runtime SDK：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-qlever-runtime-sdk@sha256:ae6ff235d6a1f399734d400ef38160a8e4c6648bdb6bcbde59f6cc9db5fa66ed`
- PostgreSQL `17.10`、`vector` `0.8.6`、`xpod_qlever` `0.4.0`、
  `xpod_rdf` `0.2.0`
- 原生能力：`ready=true`、`abiVersion=1`
- 公共语义矩阵：`14/14` 通过、`0` 失败、`0` 跳过
- 权限：`deniedRowsObserved=0`
- 规范化结果摘要：
  `sha256:905da99f880433558e4fc7f85cf436565c7197b4ebb529b4c81f812f9d4b2458`
- 事务探针：同一请求中第一项允许写入、第二项越权后，最终
  `quadRows=0`、`dataVersion=0`，没有业务事实残留

完整证据位于 RDF components 工作树：

- `qlever/reports/2026-08-12-pg17-semantic-acceptance.md`
- `qlever/reports/data/pg-semantic-conformance.json`

该结论只验收上述 PostgreSQL 17 / QLever 候选镜像，不等于 Local
SQLite/QLever、embedding 回填或最终 Xpod Local/Cloud 安装镜像已经完成。

### 尚未验收

- Local SQLite physical provider 与独立 QLever runtime；
- Local/Cloud 公共语义逐项差分；
- FTS 与可选 VEC 的同一文本实体/检索点集合；
- embedding 缺配置、额度耗尽、Provider 失败后的持久排队与自动恢复；
- embedding 模型切换后的 Pod 级重建；
- 最终 Xpod Local/Cloud 安装镜像端到端验收。

### 后续执行约束

1. SQLite provider 直接读取当前 `rdf_terms`、`rdf_quads`、`rdf_sources`
   等同一事实库，不恢复旧表、不双写、不做 migration。
2. Local QLever 使用持久独立子进程，并通过现有
   `RdfEngineLike.sparqlQuery` 返回与 Cloud 相同的 native envelope。
3. Local runtime 不允许持久执行 `operation=execute` 更新；QLever 只准备
   delta，最终由现有文件 authority 原子提交并刷新 SQLite 派生索引。
4. FTS 始终可用；VEC 缺配置或暂时失败时必须保留可恢复工作，后续配置、
   额度或模型发生变化时自动收敛到同一 retrieval-point identity。
5. 不保留 per-request SPARQL fallback 或兼容层。Local 使用静态 QLever；公开 Cloud 使用
   Comunica 作为唯一 SPARQL algebra evaluator 读取 PostgreSQL facts/source；私有 PG QLever
   只能作为部署专属 Cloud 加速层。
6. 下次首次需要 native 编译前，先完成专用远程构建资源和持久缓存升级；
   不在用户本机执行 QLever/CMake/Docker 编译。
7. 所有改动最终只做一次 squash 提交；不执行历史计划里的逐任务提交命令。

## 2026-08-05 新会话权威接续状态

> 本节是当前权威状态；与后文历史记录冲突时，以本节和 2026-08-04 的设计/实施计划为准。

### 工作性质与安全边界

这是 **本地 RDF/SPARQL 查询引擎、PostgreSQL 扩展、QLever 适配与 Docker 构建调试**，不是网络安全任务。工作不包含端口扫描、入侵、漏洞利用、凭据绕过、外部目标探测或未授权访问。此前被识别为网络安全请求属于误判。

允许的操作范围是用户明确指定的本地仓库、测试容器和 Xpod 自有部署环境。用户已允许在最终验证通过后重置目标 PostgreSQL RDF 数据并切换 QLever，但目前 **尚未执行生产发布或生产数据重置**。SealOS 只用于后续正式构建、推送和部署，不是因为本机不能编译；本机已经成功完成 ARM64 QLever runtime SDK 和 PostgreSQL production-stage 镜像构建。

### 当前目标

当前目标仍在进行中，不得标记完成：

> 完成 RDF3X/QLever 共用统计结构，完成 FTS/VEC 派生数据同步与自愈，补齐 QLever PG 的 SPARQL 1.1 合同，完成测试后将 QLever 切为主引擎，合并并上线。

当前优先级不是重复跑 2M，而是先解决小数据真实 PostgreSQL smoke 暴露的 QLever 生命周期/内存所有权问题，再完成语义矩阵、2K 对比和上线门禁。

### 当前仓库与工作树

- 本交接仓库：`/Users/ganlu/develop/xpod-jobs`
- RDF components 工作树：`/Users/ganlu/develop/xpod-pro/.worktrees/qlever-atomic-backend`
  - 分支：`codex/qlever-atomic-backend`
- Xpod 工作树：`/Users/ganlu/develop/.worktrees/xpod-shared-rdf-statistics-qlever`
  - 分支：`codex/shared-rdf-statistics-qlever`

新会话第一步必须分别运行 `git status --short`，保留所有既有修改，不得重置或覆盖用户文件。RDF components 中以下 benchmark 报告属于用户修改，**不得暂存、回退或改写**：

- `qlever/reports/2026-08-03-pg-atomic-2k-comparison.md`
- `qlever/reports/data/pg-atomic-2k-comparison.json`

当前 RDF components 的未提交实现主要涉及：

- `docker/qlever-runtime-sdk/Dockerfile`
- `qlever/patches/qlever-expression-value-getters-physical-string.patch`
- `qlever/patches/qlever-relational-expression-physical-id.patch`
- `qlever/qlever.lock.json`
- `qlever/qlever_adapter/src/XpodQleverExecutor.cpp`
- `qlever/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp`
- `qlever/qlever_adapter/src/XpodQleverPhysicalHasPredicateContextBridge.hpp`
- `qlever/qlever_adapter/src/XpodQleverPhysicalValueIdContextBridge.hpp`
- `qlever/qlever_adapter/src/XpodQleverNumericLiteralCompare.hpp`（未跟踪）
- `qlever/scripts/check-qlever-pg-extension-build.cjs`
- `qlever/scripts/runtime-overlay-manifest.py`
- `qlever/tests/QleverPgExtension.test.ts`
- `qlever/tests/QleverRuntimeSdkImage.test.ts`
- `qlever/tests/QleverExecutorFactory.test.ts`

统计字段修复已提交在 components 的 `80caf8a`（尚未推送）：共享统计字段从错误的 `distinct_subjects/objects` 改为 `distinct_left/right`。不要重复实现。

### 已确定的架构方向

1. Local 不实现另一套完整 SPARQL 查询引擎；只向 QLever 提供 B-tree/KV/PG 原子操作、typed term、权限和产品边界。
2. Local 由 QLever 负责上层计划、算子组合和可下推判断；公开 Cloud 由 Comunica 负责 SPARQL algebra，并只读取 scoped PostgreSQL facts/source。RDF3X/PG fast path 是 facts 层加速，不作为请求级引擎 fallback 或表达式级分流。
3. 删除历史 CRv2 和 SPI control 旁路概念；保留 direct SQL lower-bound 仅作性能下界诊断，不作为产品引擎。
4. 共享统计采用：
   - 热表：`rdf_stats_pod`、`rdf_stats_dimension`、`rdf_stats_pair`
   - 低频纵表：`rdf_stats_metrics`
   - QLever 专用可选分布：`rdf_stats_distributions`
5. RDF3X 与 QLever 共用事实层和重叠统计；QLever 专用分布单独存储。统计仍需保持写入一致性，不能靠查询后采样补齐。
6. FTS/VEC 使用可持久、Pod 内有序的派生事件消费与 checkpoint；复用现有 journal/订阅入口，不在进程内做不可靠通知。派生结构需支持重放、自愈和未来新增消费者。

对应设计与实施计划：

- `docs/superpowers/specs/2026-08-04-qlever-pg-sparql11-contract-completion-design.md`（`f86ec2f7`）
- `docs/superpowers/plans/2026-08-04-qlever-pg-sparql11-contract-completion.md`（`1cbc5664`）

### 已验证进展

- shared stats 字段错误已修复。
- numeric relational typed-term 语义已在真实 PostgreSQL 镜像 smoke 通过。
- BOOLEAN/EBV 语义已在真实 PostgreSQL 镜像 smoke 通过。
- 干净 lock/patch 输入的完整 QLever runtime SDK 已在本机成功构建，约 31 分钟。
- PostgreSQL production stage 已在本机成功构建；必须使用 `--target production`，因为 parity-runner 的 GHCR 镜像没有 ARM64 版本。
- focused test 曾通过：
  - physical has-predicate：通过
  - request-local executor context：通过
  - 较早聚焦集合：151 pass / 2 skip / 0 fail，之后一轮为 156 pass / 2 skip / 0 fail
- 上述通过发生在最新生命周期实验修改之前，最终修复后必须重跑，不能直接作为完成证据。

### 当前阻塞：QLever 结果生命周期/内存所有权

当前问题已缩小到本地 PostgreSQL 后端进程退出/销毁阶段的内存生命周期，不是网络、SealOS 或 PostgreSQL 数据接口缺功能。

已确认事实：

1. `ql:has-predicate` FULL_SCAN 单独运行通过：返回 35 行、2 列、70 个 term；它不是当前根因。
2. 稳定复现器是带排序的空白节点表达式，尤其在 allocator 扰动下：

   ```sparql
   SELECT ?b WHERE {
     VALUES ?x { 1 2 }
     BIND(BNODE() AS ?b)
   }
   ORDER BY ?x
   ```

   使用 `MALLOC_CHECK_=3 MALLOC_PERTURB_=165` 后可触发段错误。无 `ORDER BY` 的 `BNODE()` 通过；即使把 `?x` 一并投影仍会崩溃，因此问题更像 QLever sort/result 生命周期，而不是自定义 projection。
3. 每次 smoke 的 `psql -c` 都创建独立 PostgreSQL backend，所以不是同一 PG 会话内跨查询复用；后一个查询只是观察到前一个 backend 已崩溃或数据库正在恢复。
4. 将 planner context 改为每次 `execute()` 新建、使用 `Uncached` 后，最小 BNODE + has-predicate 序列通过；但完整 smoke 仍会在累计执行后于 `STRLEN/DATATYPE/LANG` 查询出现 `std::bad_alloc`。该语言查询单独运行通过。
5. `context_.clearCacheUnpinnedOnly()` 只是实验性缓解，不是最终修复；它可能留下 pinned result。

当前最强根因假设是 `OwnedPlannerContextProvider` 的成员析构顺序：cache 最后析构，但 `Index` 更早析构；cache 中的 `Result`/`LocalVocab` 可能仍持有引用 `Index::BlankNodeManager` 的 blank-node block，形成悬空引用和堆破坏。需要用代码和回归测试确认，不能通过提高内存、放宽 timeout 或关闭检查掩盖。

另一个次级风险是 `ResolvedQleverBinding` 的隐式移动/复制与其内部 `xpod_rdf_term` byte view，但 `resolveIdTableTerms()` 当前会在末尾刷新 views；在主假设排除前不要无依据大改这一层。

### 新会话的执行顺序

1. 检查两个工作树状态和当前 diff；保护 benchmark 报告文件。
2. 阅读 `QueryResultCache` 的实际类型/API和 `OwnedPlannerContextProvider` 成员声明，确认 cache、Result、LocalVocab、Index、BlankNodeManager 的所有权及析构顺序。
3. 先写/固化回归：带 `ORDER BY + BNODE()` 的执行结束后销毁 provider，在 `MALLOC_CHECK_=3 MALLOC_PERTURB_=165` 下不得崩溃。
4. 做最小生命周期修复：确保 cache 中所有 result 在 Index/BlankNodeManager 之前销毁。若存在完整 clear API，可在析构中使用；否则调整 owned state/成员所有权。不要把 `clearCacheUnpinnedOnly()` 当作完成。
5. 使用现有增量 SDK 镜像重建 PostgreSQL production image，先跑 isolated reproducer，再跑完整 malloc smoke。
6. 重跑 focused tests、lock/patch 校验、TypeScript/build tests 和完整相关测试；清理只为诊断添加且无长期价值的 harness 参数。
7. 生命周期稳定后继续 SPARQL 1.1 typed-term/atomic operator 合同和 capability gate 收口。
8. 再跑 2K 功能/性能对比；只有小规模功能闭环后才跑最终大规模门禁。
9. 审计 shared stats 与 FTS/VEC journal 自愈的真实实现和测试证据；当前不能宣称它们已经完整上线。
10. 最后才执行 Xpod 集成、正式镜像、目标数据重置、QLever 主引擎切换、发布与生产验证。

### 本地镜像与复现命令

当前有用的本地镜像（均为临时调试产物，不是 release artifact）：

- `xpod-qlever-runtime-sdk:contract-has-predicate-allocator`
- `xpod-qlever-runtime-sdk:contract-has-predicate-trace`
- `xpod-rdf-postgres:contract-request-qec`

完整 SDK：

```bash
docker build --progress=plain \
  --build-arg XPOD_QLEVER_BUILD_JOBS=2 \
  --build-arg XPOD_DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian \
  --build-arg XPOD_DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security \
  --build-arg XPOD_PGDG_MIRROR=http://mirrors.aliyun.com/postgresql/repos/apt \
  -f docker/qlever-runtime-sdk/Dockerfile \
  -t xpod-qlever-runtime-sdk:<tag> .
```

PostgreSQL production stage：

```bash
docker build --progress=plain --target production \
  --build-arg XPOD_QLEVER_RUNTIME_SDK_IMAGE=xpod-qlever-runtime-sdk:<tag> \
  --build-arg XPOD_DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian \
  --build-arg XPOD_DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security \
  -f docker/postgres17-qlever/Dockerfile \
  -t xpod-rdf-postgres:<tag> .
```

强 allocator smoke：

```bash
MALLOC_CHECK_=3 MALLOC_PERTURB_=165 XPOD_QLEVER_RUNTIME_TRACE=1 \
XPOD_QLEVER_PG_EXTENSION_DOCKER_IMAGE=xpod-rdf-postgres:<tag> \
node qlever/scripts/check-qlever-pg-extension-build.cjs \
  --docker-smoke --enable-qlever --use-installed-extension
```

当前 patch lock digest 为：

```text
2cd0e67dbd3600fe30567b0ffe1a6b47d93241d4d361a4fd93234c8482d29e6f
```

smoke 清理偶尔因 Docker volume teardown 与 `rmSync` 竞争而报临时目录 `EACCES/Directory not empty`，它可能遮住原始错误，但不是产品根因。应保留最先出现的 PostgreSQL/QLever 错误，并给清理增加有界重试。

### 完成度判断

- 本机可以编译；无需为了继续根因调试转到 SealOS。
- QLever PG 尚未达到“SPARQL 1.1 全部支持并可上线”的状态。
- 当前没有发布、合并或生产切换完成的证据。
- shared stats、FTS/VEC 同步、自愈、2K 最终对比、正式镜像和生产切换仍须逐项验收。
- 后文的 20K/2M/P0.1/P0.2 结果是历史证据，不代表当前最新未提交修订已通过同样门禁。

## 目标

持续完成以下目标，不要把局部 smoke 或单个 benchmark 通过视为完成：

1. 整理长期能力跟踪文档。
2. 实现 roadmap 中的 P0、P1 能力。
3. 完成功能正确性、权限、无回退和性能验收。
4. 做逐项完成度审计后才能宣告完成。

## 进行中目标状态

当前 Goal 仍为 **进行中**，不得标记完成：

> 先整理长期能力跟踪文档，实现 P0 P1 特性，完成（完型）功能与性能验收。

当前执行阶段：

1. **P0 20k 正确性/权限/no-SPI 验收：已完成。**
2. **P0.1 Multi-pattern / parameterized JOIN：R4，已完成。**
   - 2M facts、`ORDER BY ... LIMIT 2`、c1/c8 已通过。
   - 21/21 query-engine results、42/42 concurrency cells 正确。
   - 正式 PG 路径零 SPI、零 fallback、零 error。
   - 参数化 workload 的中间结果最大 3.25×，低于 10× 门禁。
3. **长期能力 roadmap 与 P0.1 性能证据：已更新。**
4. **P0.2 FILTER + ORDER + LIMIT：R3，linked/2K 中间验收已完成。**
   - plan 审计已确认原 FILTER 主要在 scan 返回后执行，不满足“PG 先过滤、再 LIMIT”。
   - exact term equality 已下推为 scan pattern，提交 `e2b5f03`。
   - term inequality 已通过 ABI v5 scan-filter 协议进入 PostgreSQL `WHERE`，
     同时保留 QLever modifier 和无能力 provider 回退，提交 `5b7b57b`。
   - numeric/date plan-first 审计确认：词典 term id 不能表达数值/日期顺序，
     且 range 阈值可能不在词典中。ABI v5 正在补充完整 typed-literal
     operand 和 cursor 深拷贝，完成前不得生成 range SQL。
   - ABI typed operand、capability gate、SPI/libpq range SQL 已完成：
     integer/decimal 使用 `numeric`，float/double 数据行参与数值比较，
     date/dateTime 使用类型校验后的 `date`/`timestamptz`；SQL 位于
     `ORDER BY` / `LIMIT` 之前并保留 QLever modifier。
   - 小数据真实 PG17 SQL smoke 已验证 numeric `> 8 LIMIT 2` 返回 `11,12`，
     dateTime `<= 2026-07-29Z LIMIT 1` 返回 `20`。smoke 期间发现并修复
     保守 `ELSE TRUE` 假阳性占用 LIMIT 的错误；临时 Pod 已删除。
   - string prefix/contains/suffix/equality 已进入 physical scan filter；
     `LCASE`/`UCASE` 因 Unicode 等价性尚未证明而保留 QLever 语义执行。
   - `LANG()` / `DATATYPE()` equality/inequality 已进入 PostgreSQL `WHERE`，
     并保留 QLever result modifier；inline typed ValueId 增加反向 term-key
     cache，使 metadata 语义兜底能够解析物理结果。
   - linked image 首轮验收发现并修复 QLever `@en@<predicate>` 重写导致的
     LANG 空计划，以及 PostgreSQL `xsd:int` / inline ValueId
     `xsd:integer` DATATYPE 语义分裂。
   - 精确镜像
     `sha256:5eba18f2efafab803d698a2d470d7318e7cb3e769d8b65b46081dd9f628d5495`
     已通过 numeric/prefix/LANG/DATATYPE/asc/desc/ACL/source linked smoke。
   - 2K 功能矩阵 6/6 通过；三类 workload 共 150/150 个 fresh c1/c8
     查询通过，均为 `computed`、`physicalFilterCount=1`、
     `physicalFilterRoute=spi-relational`。
   - 相关聚焦测试当前 `217 pass / 0 fail / 1721 expects`。
   - 2K 只是问题闭环和中间性能证据，不提升 R4；完整
     unsupported-expression reason matrix 和最终 selective/non-selective
     2M c1/c8 仍待完成。
5. **P0.3–P0.5：待实现和验收。**
6. **P1：待实现和验收。**
7. **全量功能/性能完成度审计：待完成。**

完成标准不是“查询能运行”，而是 roadmap 中每个 P0/P1 项均有对应的：

- 实现证据；
- 正确性和权限测试；
- c1/c8 性能数据；
- digest/no-SPI/no-fallback 证据；
- 明确的已完成、未完成或拒绝结论。

## 2026-07-30 P0.3–P0.5 / P1 代码事实审计

正式审计：

`/Users/ganlu/develop/xpod-pro/qlever/reports/2026-07-30-p0-p1-capability-gap-audit.md`

架构结论：

- 继续扩展现有 `XpodQleverOperationPlanBridge`，不新增平行 planner。
- P0.3 现有 `Distinct`/`GroupBy` 入口和 PostgreSQL 聚合内核可以复用，
  但缺少 operation tree 到物理 backend 的 exact aggregate 回调。
- P0.4 已有 `facts_version`/`stats_version`、estimate ABI 和 profile rows，
  但缺少独立维护的 graph/predicate/correlation/distinct/candidate 统计、
  完整 access-scope estimate，以及 estimate/actual 误差验收。
- P0.5 已有分散的 capability/fallback 字段，但缺少所有 P0 操作统一返回的
  machine-readable physical-decision record。
- P1 文本和向量叶子及各自 RDF join 已有功能路径；phrase/字段过滤、
  model/completeness 契约、combined text+vector fusion、shared-corpus
  precision/recall/recall@k 和 c1/c8 仍缺失。

执行顺序已经收敛为：

1. 先统一 P0.5 决策/回退证据；
2. 在现有 planner 内增加有限、exact 的 P0.3 聚合物理 seam；
3. 补 P0.4 versioned/access-aware statistics；
4. 小规模跑通完整 P0 矩阵后再跑 2M；
5. 分别闭合 P1 text/vector 契约，再实现 fusion；
6. 最后执行 P0/P1 完整 2M c1/c8 验收。

这次审计避免把 2M 当成调试循环；在上述实现缺口关闭前，不重复做无意义的
大规模运行。

## 仓库与分支

### Xpod

- 路径：`/Users/ganlu/develop/xpod-jobs`
- 分支：`codex/pg-product-grade-acceleration`
- 工作区长期处于 dirty 状态，包含大量此前的 QLever/native/PG extension 变更。
- 禁止使用 `git add -A`、`git add .`、广域 reset 或 clean。
- 当前与本轮直接相关的本地修改：
  - `src/storage/rdf/PostgresRdfEngine.ts`
  - `scripts/native-rdf3x-benchmark.ts`
  - `tests/native/NativeRdf3xBenchmarkScript.test.ts`
  - `tests/storage/rdf/PostgresRdfEngine.test.ts`

### RDF components

- 路径：`/Users/ganlu/develop/xpod-pro`
- 分支：`codex/sealos-rdf-benchmark-image`
- P0.1 验收提交：`87101e7`。
- P0.2 equality 前置过滤提交：`e2b5f03`。
- P0.2 ABI v5 inequality scan-filter 提交：`5b7b57b`。
- P0.2 typed operand/range 提交：`c45e6a5`、`4acf29b`。
- P0.2 LANG planner/hidden projection 修复：`6c212d2`、`ef80d47`。
- P0.2 DATATYPE physical/semantic normalization 修复：`d79b4d6`。

## 2026-07-30 P0.2 linked 与 2K 中间验收

- 正式报告：
  `/Users/ganlu/develop/xpod-pro/qlever/reports/2026-07-30-qlever-p0-filter-2k-validation.md`
- 精确镜像：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:5eba18f2efafab803d698a2d470d7318e7cb3e769d8b65b46081dd9f628d5495`
- 数据规模：1,000 subjects × 2 quads = 2,000 facts。
- 功能：selective/non-selective asc/desc、prefix、LANG、DATATYPE 共 6/6 PASS。
- c1/c8：每 workload 10/40 次，共 150 次；零错误、零 unexpected fallback。
- 性能：
  - selective asc：c1 p50/p95 `98.665/108.259 ms`，c8
    `476.365/510.321 ms`；
  - non-selective asc：c1 `193.465/240.933 ms`，c8
    `912.344/1082.620 ms`；
  - non-selective desc：c1 `180.938/199.438 ms`，c8
    `901.035/1081.262 ms`。
- 证据哈希：
  - linked smoke：
    `56fb07d2f914353ede66baa934e11ca65a3c32b36bcd7ef90888cc0d4004b025`
  - 2K functional：
    `27b38aa3bccd3bfb8028832d0951e45790a56d8066c8ad138e1a82bf052cb9b1`
  - 2K c1/c8：
    `78f6af322acee90bacfda4f109153f35309f0087af56e436e6ffd48c8429c816`
- 状态判定：P0.2 保持 R3。roadmap 明确规定 small fixture 不能晋升
  R4；2M 最终规模门禁按用户当前指令延后。

## 2026-07-29 P0.1 最终验收

### 结论

P0.1 Multi-pattern / parameterized JOIN 已满足 roadmap 的 R4 标准：

- 2M dataset：`native-parity-2000000-sealos-cn`
- dataset SHA-256：
  `49bba15e73dde3f39a6b3e359b778aa897dbdd2ab26544a72bf171b6423af43b`
- 7 个 P0 workload 全部包含 `ORDER BY ... LIMIT 2`
- 正式结果 21/21 `ok`
- c1/c8 cell 42/42 行数与 ordered/multiset digest 正确
- 正式 PG cell：`spiQuadRows=0`、`fallbackReason=null`、`errorCount=0`
- 参数化 workload 的 top-level/c1/c8 10× 门禁全部通过，最大 3.25×
- CRv2 相对强制 SPI 的 aggregate warm p50 提升 34.20%
- PG-QLever/RDF3X aggregate warm p50 ratio 为 0.241（门槛 1.25）

### 稀疏 ORDER/LIMIT 修复

首次带 LIMIT 的 2M 运行在 `p0-graph-allowed` 卡住。根因是固定谓词、
按 subject 排序的稀疏查询被送入全局 semantic top-N page：它需要遍历全局
subject dictionary，再逐项探测固定谓词/graph/access，LIMIT 只有命中后才推进。

提交 `4747ed8` 会在 ORDER slot 之外存在 exact subject/predicate/object
约束时拒绝该物理路径，改走 CRv2 普通 scan，再由 QLever 执行语义排序和
LIMIT。最终 2M 结果：

- `p0-graph-allowed` 返回 2 行；
- `nativeOrderPageRows=0`；
- `compressedCursorBatches=1`；
- `compressedRows=5`；
- warm p50 约 178 ms，c8 p95 约 678 ms；
- 不再出现 900 秒超时。

### 不可变镜像和证据

- PG/QLever：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:45f6e5fcd50b79611a742f9738ba92c3f885b40aacfc40013b0693f14097047f`
- Runner：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-rdf-parity-runner@sha256:62ad03ba89c6935979264750353c98458223e10dac66dd45c6b3d4565762ded9`
- 完整日志：
  `/private/tmp/rdf-p0-2m-order-limit-fixed.full.log`
- 完整日志 SHA-256：
  `059cc911e8a5db7bc0e37819db4808cdab903af8a5aa0c45ef139443e961e3e3`
- 主报告：
  `/Users/ganlu/develop/xpod-pro/qlever/reports/data/native-parity-p0-order-limit-2m-2026-07-29.json`
- 机器重算门禁：
  `/Users/ganlu/develop/xpod-pro/qlever/reports/data/native-parity-p0-order-limit-2m-gates-2026-07-29.json`
- 验收说明：
  `/Users/ganlu/develop/xpod-pro/qlever/reports/2026-07-29-qlever-p0-join-acceptance.md`
- canonical roadmap：
  `/Users/ganlu/develop/xpod-pro/qlever/specs/2026-07-25-product-capability-roadmap-design.md`

正式 SealOS Job、PostgreSQL Pod/Service/Secret 和镜像构建 Pod 均已清理。

## 已验证结果

### 20k 当前同修订验收

- Xpod runner：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-rdf-parity-runner@sha256:222b0121b0c5e89749b9a19b0243be04523a3684fa9c9c70a0961c82b138ffb1`
- PG extension：
  `szjrccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres:production-929201c`
- 结果：全部 native-QLever、PG-QLever、RDF3X cell 成功。
- 日志：
  `/private/tmp/rdf-p0-20k-current.full.log`
- PG-QLever scoped denied graph 返回 0 行，`spiQuadRows=0`、无 fallback、parameterized path 生效。

### 2M 数据与第一次运行

- 数据规模：`rdf_quads=2,000,040`
- 并发：c1/c8
- P0 join workloads 已启用。
- 第一次运行成功，但 SealOS 上存在额外自动清理器；Job/Pod 在完成后很快被删除，完整日志未及时保存。
- 观察到的事实：
  - 所有最终 cell 状态为 `ok`。
  - RDF3X graph-denied：
    - c1 p50：约 `1780.60 ms`
    - c8 p50：约 `8367.68 ms`
    - c8 throughput：约 `0.789 QPS`
  - PG-QLever graph-denied：
    - 返回 0 行（权限过滤正确）
    - backend scan 返回 0 行
    - 无 SPI fallback

### 2M 复用运行（历史记录，当前已清理）

为避免重新导入，已创建：

- ConfigMap：`rdf-p0-reuse-script`
- Job 清单：`/private/tmp/rdf-p0-2m-reuse.yaml`
- Job：`rdf-p0-2m-reuse`
- PG：`rdf-p0-2m-current-pg`

当时持续抓取日志到：

`/private/tmp/rdf-p0-2m-current.full.log`

抓取命令不要设置 `--request-timeout=20s`，否则长连接会被主动取消：

```bash
kubectl \
  --kubeconfig /Users/ganlu/develop/undefineds/config/kubeconfig.cn.yaml \
  --server=https://106.52.159.126:6443 \
  --tls-server-name=gzg.sealos.run \
  -n ns-iknkxtc8 \
  logs -f job/rdf-p0-2m-reuse \
  > /private/tmp/rdf-p0-2m-current.full.log
```

## 本轮修复

### RDF3X 并发超时根因

旧的 2M 混合修订运行中，RDF3X 每个请求会启动短生命周期进程。慢查询 explain 又触发全表 cardinality distribution 构建；c8 下同时出现约 24 个统计扫描，导致全部 RDF3X c8 timeout。

Xpod 本地修改：

- 当 `queryExplainSlowQueryMaxEntries() === 0` 时，不构建 slow-query histogram diagnostics。
- parity runner 使用：

```ts
queryExplainSlowQueryMaxEntries: 0
```

而不是伪造极大的慢查询阈值。

已通过：

- targeted Postgres test
- targeted parity options test
- `NativeRdf3xBenchmarkScript.test.ts`：109 pass
- `bun run build:ts` 曾通过；最终变更后应重新执行。

### 同修订约束

确认不能混合使用：

- 旧 runner Xpod source
- 新 `PostgresRdfEngine`
- 不同 PG schema

否则会出现 import mismatch 或 schema version mismatch。最终 runner/Xpod source/PG schema 必须来自同一可复现提交。

### 快速增量 runner 镜像

采用 SealOS Kaniko `tar://stdin`，仅覆盖当前 `src` 和 benchmark script：

- context 约 4.8 MB
- 实测构建约 36 秒
- 不在本机编译完整 QLever

## 当前测试状态

RDF components：

```text
bash -n docker/postgres17-qlever/parity-runner.sh
```

通过。

新增 reuse targeted test：

```text
1 pass, 0 fail
```

完整 `NativeParityBenchmarkRunner.test.ts` 在当前任务只读 sandbox 中因 `mkdtemp` 和 `ps` 被拒绝而失败；这些是 `EPERM` 环境错误，不是断言回归。新 Full Access 任务必须重新运行完整测试。

## SealOS

- Kubeconfig：
  `/Users/ganlu/develop/undefineds/config/kubeconfig.cn.yaml`
- API：
  `https://106.52.159.126:6443`
- TLS server name：
  `gzg.sealos.run`
- Namespace：
  `ns-iknkxtc8`

需要远端验证时先检查：

```bash
kubectl \
  --kubeconfig /Users/ganlu/develop/undefineds/config/kubeconfig.cn.yaml \
  --server=https://106.52.159.126:6443 \
  --tls-server-name=gzg.sealos.run \
  -n ns-iknkxtc8 \
  get job,pod,svc,secret,configmap
```

若重新创建以下计费资源，完成报告保存后必须删除：

- `rdf-p0-2m-reuse` Job/Pod
- `rdf-p0-2m-current-pg` Pod/Service/Secret
- `rdf-p0-reuse-script` ConfigMap

不要删除 namespace 中其他服务。

## 下一步执行顺序

1. 继续从 roadmap/query plan/physical request/SQL 顺序审计 P0.2，不用 2M
   benchmark 代替 plan 正确性检查。
2. 先闭合 ABI v5 typed-literal operand：
   lexical value、datatype IRI、language 随 request 传递并由 cursor 深拷贝；
   range 阈值不依赖 dictionary lookup；禁止按 opaque term id 排序。
3. 以定向测试完成 P0.2 numeric/date range、language/datatype、prefix/string
   filter 和 unsupported-expression reason。
4. 用小数据真实 PostgreSQL smoke 验证 FILTER 确实先于 ORDER/LIMIT。
5. 仅在 P0.2 功能闭合后运行一次 2M c1/c8 最终性能门禁。
6. 实现并验收 P0.3 DISTINCT / aggregate。
7. 实现并验收 P0.4 statistics / CBO：
   graph×predicate correlation、ACL-aware estimate、median≤2×、p95≤10×。
8. 实现并验收 P0.5 capability routing 和机器可读 fallback。
9. 实现并验收 P1：
   text/vector candidate、fusion、compressed cursor、Property Path 和 Update matrix。
10. 最后按 roadmap 每一项逐条审计；证据不足即视为未完成。

## 重要边界

- 不在本机执行完整 QLever C++ 编译。
- Native 构建和大规模性能测试放在 SealOS。
- 大规模最终门禁只跑 2M，不跑 10M；小改动先做 plan/定向测试/小数据 smoke，
  不重复运行 2M。
- 并发只测 1 和 8。
- 同时只保留一个临时 benchmark Job。
- 不通过放宽 timeout、内存或 correctness gate 掩盖实现问题。
- QLever 上层策略尽量复用；Xpod 负责 PG physical backend、字典、scan、权限和产品边界。
- 不能因 subset/upstream tests 通过就宣称完整 QLever 已接入。
