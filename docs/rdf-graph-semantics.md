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

## 底层支持（用已有原语，不需要新协议）

| 引擎 | 原语 | 位置 |
|---|---|---|
| PG | 图前缀**已真下推**：`graph: { $startsWith }` → `graphPrefix` → `JOIN rdf_terms graph ON graph.id = q.graph_id AND graph.value LIKE '…%'`；`rdf_terms(kind, value_head)` 索引；planner 有 `hasGraphPrefixFanout` 代价/缓存键 | `PostgresRdfEngine.ts:7025 / 2713 / 7195 / 1080` |
| SQLite（TS） | `$startsWith` 走通用 `prefixSearchConditionJoin(key, column, …)`，图槽同样适用 | `RdfQuadIndex.ts:1963` |
| 原生扫描后端 | 图作用域本来就有三种形态，前缀是其中之一：`PREFIX` → `graph_id IN (SELECT id FROM rdf_terms WHERE value >= ? AND value < ?)`；集合仍是 `graph_id IN (…)` | `rdf_sqlite_backend/src/xpod_rdf_sqlite_backend.cpp:1009 / 1041` |
| QLever 适配器 | 图过滤器 → 物理图作用域的翻译。查询里的容器 IRI（以 `/` 结尾）在这里变成**前缀作用域**，并与请求作用域取交集（只收窄、不放宽） | `XpodQleverPhysicalIndex.hpp`：`applyQleverGraphFilterScope` / `applyGraphContainerPrefixScope` |
| QLever 计划层 | 上游 `GRAPH <iri>` 被改写成 dataset clause，`getActiveGraphs()` 把该 IRI 原样放进 `Filter::Whitelist(TripleComponent)`（不做词表校验，所以容器 IRI 一定到得了适配器）；物理索引在场时"无名字"变成 `Whitelist({default-graph})` | `QueryPlanner::getActiveGraphs` + `qlever/patches/qlever-queryplanner-physical-default-graph.patch` |

结论：三条规则都能翻译成**已有原语**——容器→图前缀，文档→精确，无名字→作用域容器前缀。**没有新增 ABI 字段**：`XPOD_RDF_GRAPH_SCOPE_PREFIX` 与 `iri_prefix` 原本就在协议里（`xpod_rdf_physical_backend.h:209-222`），缺的只是"容器 IRI 要按前缀读"这条翻译规则。

## 分叉与收敛（实测）

原来的 fixture 用例 `graph/default-and-named` 里有一份种进**默认图**的文档、一份种进命名图的文档，查询是 `{ ?s ?p ?o BIND(<…g:default> AS ?g) } UNION { GRAPH ?g { ?s ?p ?o } }`。两条权威给出不同答案：

| 权威 | 为什么不同 | 修前 | 修后 |
|---|---|---|---|
| 公有（云 `.sparql`） | 无名字那支按"容器的图前缀"读 | 3 行（把命名图文档读了两次：一次当默认图、一次当命名图） | 与原生一致 |
| 原生（QLever，`defaultDataset=physical`） | 无名字那支按"物理默认图"读，且 fixture 那条容器 IRI 的 `GRAPH` 无法匹配任何图 | 2 行（容器查询 0 行） | 与公有一致 |

根因不是"原生和公有本来就该不同"，而是两处**替身**：公有侧用"丢图约束 + 来源前缀"冒充图语义（只在 graph IRI 恰好等于文档 IRI 时成立），原生侧没有把容器 IRI 翻成前缀。收敛动作：

- 无名字：容器端点在生产里本来就传 `defaultDataset=scopedUnion`（`SubgraphSparqlHttpHandler`），原生一致；一致性测试的执行器也改成同一个 dataset 模式，不再用 `physical`。
- `GRAPH <容器/>`：原生的图过滤器翻译补上"容器 IRI → 前缀作用域"（含与请求作用域取交集、与请求图集合取交集）。
- fixture 不再制造"图 ≠ 文档 IRI"的人造数据：每份文档都带图，`graph/default-and-named` 的期望改成"无名字那支必须读到容器里的那份文档"（2 行），另加 `graph/container-prefix` 用例钉住容器前缀与边界（`box/` 不得读到 `boxed/`，但要读到 `box/deep/`）。

## 迁移顺序与状态（fixture 不能提前改）

1. **接线**（已完成）：TS 查询层引入容器规则；PG 把"无名字"从丢约束改成显式容器图前缀。落在 `RdfAccessScope.ts`（容器规则只有这一份）与 `RdfEngineRdfJsSource.ts`（前缀作用域的行按自身图 IRI 上报）。本地证据：`PublicCloudSemanticConformance` 16 个用例全绿。
2. **原生对齐**（已完成）：QLever 适配器把容器 IRI 翻成前缀作用域，不枚举图、不加 ABI 字段。本地证据：`qlever/tests` 全量 310 通过，其中新增的假头 C++ 冒烟用例覆盖"容器→前缀 / 作用域收窄 / 文档仍精确 / 无斜杠不算容器 / 前缀与集合求交 / 不可表达的组合 fail closed / 前缀字节在结构体移动后仍有效"。
3. **fixture 收敛**（已完成）：去掉人造的默认图构造，两条权威与 parity 门禁一起验。原生端到端证据来自 `publish-qlever-local-runtime.yml` 的 "Run SQLite QLever semantic and native search conformance"（它用刚构建的镜像跑这份 fixture）。

⚠️ **顺序不能颠倒**：只做第 1 步就改 fixture，会把红从公有验收挪到原生 parity，而后者依赖重新发布的运行时。

## 验证记录（可复现）

| 层 | 门禁 | 结果 |
|---|---|---|
| 公有权威（PG + Comunica） | `bun run test -- tests/acceptance/PublicCloudSemanticConformance.test.ts`（本机 pglite） | 18/18 通过（16 个 fixture 用例 + 2 个契约用例） |
| 原生适配器 seam | `bun test qlever/tests`（含假头 C++ 冒烟：id seam、移动后前缀字节、作用域求交、不可表达组合 fail closed） | 310 通过 / 0 失败 |
| SDK 门禁 | `publish-qlever-runtime-sdk.yml` run `35529085898`（该 run 的 fast gate 已包含 `QleverPhysicalIndex.test.ts`） | success，SDK `sha256:34341ea0…` |
| 原生端到端（真实运行时镜像） | `publish-qlever-local-runtime.yml` run `35530100541`：用上面的 SDK 构建本地运行时镜像，并在该镜像上跑这份 fixture | `{"status":"ok","backend":"sqlite","semanticCases":16}`，镜像 `sha256:5e56178d…` |
| 双权威 parity（安装镜像） | `rdf-installed-image-conformance.yml` run `35530558460`：同一镜像内 sqlite 与 pg-public 各跑一遍，再断言 canonical parity | success（该脚本在 parity 不一致时必然失败） |

顺带修掉一个与本规则无关、但挡住这道门禁的问题：`rdf-installed-image-conformance` / `publish-xpod-image` / `guangzhou-test` 三个工作流都在 `target: server` 上构建根 `Dockerfile`，而 `server` 这个 stage 从 0.4.0 的 QLever 整合（`1dac88bd`，`FROM runtime-base AS server` → `FROM qlever-local-runtime AS runtime`）起就不存在了，所以它们连第一步都过不去（`target stage "server" could not be found`）；现在都指向 `runtime`，两个工作流契约测试也跟着改了。

第一次原生端到端是**红**的，这条记录比结论更有用：`GRAPH <pod/box/>` 返回 0 行，原因是容器 IRI 在生产 seam 上已经是 QLever `Id`（`IndexScan::getScanSpecAndBlocks()` → `ScanSpecification` → `GraphFilter<Id>`），而当时的翻译只覆盖 `TripleComponent`。修法是通过既有的 export id seam（连同 scan specification 的 local vocabulary）把 id 还原成 IRI；容器 IRI 只存在于查询里，所以它一定是 local vocabulary 项。

## 已知边界（写下来，不靠猜）

- **不可表达的图过滤器组合**：一次扫描的图集合若同时包含"容器前缀"和"它覆盖不到的具名图"，或包含两个互不包含的容器前缀，物理协议没法表达这种并集。这种情况返回 `UNSUPPORTED`（由 `physicalScanSpecAndBlocks` 的无约束重试路径收敛），而不是丢掉容器只答一半。`GRAPH <容器/>` 单独出现时是最常见形态，不受影响。
- **容器规则只落在原生树执行路径上**：实测（`executionMode`）plain / ORDER BY / LIMIT / ORDER BY+LIMIT / join / OPTIONAL / UNION / COUNT / ASK 九种形状都走 `native-qlever-tree`，也就是这次改的这条路径；只有当原生树不可用、回退到 bridge 计划时，容器 IRI 仍会被当作"不存在的具名图"。回退路径的容器支持属于后续工作，不是本规则的例外条款。
- **默认图过渡条款**：原生扫描后端在"作用域前缀 == 来源前缀"时会额外放行默认图（`append_graph_prefix_condition` 里的 `OR graph_id = default`），公有侧只在无名字读取时走默认图分支。产品写入路径始终带图（`SolidRdfDataAccessor`），所以这条只对历史/导入数据有意义；fixture 已不再制造默认图数据，删除条件见下。
- **原生运行时是随镜像发布的**：适配器改动必须重新发布 SDK/本地运行时镜像（`publish-qlever-runtime-sdk.yml` → `publish-qlever-local-runtime.yml`）才会进入安装镜像与桌面端；`build-qlever-macos-runtime.yml` 在 `qlever/**` 推送到 `main` 时重建 macOS 运行时。

## 未决

- **过渡条款何时删除**：取决于默认图数据是否还有来源（历史数据迁移脚本 / 导入路径）。fixture 已经不再依赖它，所以删除时不需要改一致性用例，只需要去掉原生后端 `append_graph_prefix_condition` 里的 `OR graph_id = default` 分支和本节这条记录。
- **`GRAPH <端点自己的容器/>`**：作用域前缀恰好等于来源前缀时，原生会按上面的过渡条款放行默认图。若要严格按规则表（显式容器不含默认图）执行，删除点与上一条相同。
- **原生侧是否需要为前缀作用域建图索引**：现在前缀翻译不枚举图（SQL 直接按 `rdf_terms.value` 的范围比较），成本与普通前缀扫描同级；如果将来出现"一次扫描要并集多个容器"的真实需求，才需要考虑枚举或扩展协议。

