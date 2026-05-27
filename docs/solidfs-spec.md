# SolidFS Spec

SolidFS 是 Xpod 给 Agent Runtime 和普通文件工具暴露的 workspace 文件系统抽象。它不等同于 Managed Agents，也不等同于底层对象存储；它负责把 Solid Pod 里的文件、RDF 资源、索引和对象存储组织成一个运行端可访问的真实 `cwd`。

## 目标

- Agent、bash、`rg`、`grep`、`find`、`cat` 等工具始终面对真实目录。
- Pod 资源或文件是权威事实，DB 只做快速索引和派生视图。
- local 场景也必须经过 SolidFS；只是普通文件不做 workspace 级投影，直接映射本机目录。
- cloud 场景按资源类型决定本地持久副本、COS/MinIO 冷备、按需 materialization 和回写。
- 每个 Pod 是独立可移动单元；资源计数和配额按账号维度记录，不按单个 Pod 分裂成多个计费实体。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| `workspace` | 指向 Solid Container 或 host path 的工作区关系，值可以是 `https://pod/alice/projects/demo/` 或 `file://device/path`。 |
| `FileMetadata` | Pod 内关于文件的最小路由事实，例如 resource、path、contentType、size、storage backend、object key 和权限。不要为默认本地文件重复写 authority、原生 `ETag`、hash 或版本状态。 |
| `WorkspaceIndex` | DB 中的派生索引层，用于快速路径枚举、metadata 查询、RDF/SPARQL 查询、全文或向量检索。 |
| `MaterializedWorkspace` | 给 runtime 和 bash 工具使用的真实本地目录。 |
| `Manifest` | 一次 Run 的短期投影和回写清单，记录每个条目的来源、projection、写回状态和冲突信息。版本只记录本次 Run 需要的原生 version token 快照。 |

## 状态最小化原则

SolidFS 不额外维护一套文件状态系统。持久状态只保存恢复和路由必需的信息：

- `storageBackend`: 内容实际在哪里，例如 filesystem、cos。默认 filesystem 文件就是权威源，不再额外保存 authority。
- `objectKey` / `localPath`: 只有后端无法从 `resource` 稳定推导时才保存。
- `contentType`、`size`、权限等 Solid/HTTP 原生需要的信息。

权威源从 `storageBackend` 和 workspace 类型推导：

| storageBackend | 推导出的权威源 | 说明 |
| --- | --- | --- |
| `filesystem` | workspace 内真实文件 | 默认路径。local 和 cloud 的 line-addressable 文件都走这里。 |
| `quadstore` / `rdf` | 兼容索引层 | 新数据不能只存在 graph 中；旧 graph-only 数据进入 workspace 前必须迁移或修复为真实 `.ttl` / `.jsonld` 文件。 |
| `object` / `cos` | 对象存储对象 | 只用于大二进制、特殊格式或冷对象；GET 可 302，runtime 需要时 hydrate。 |
| `index` | 无权威性 | 只表示派生索引，不能作为内容事实源。 |

不要把原生机制复制成业务字段：

- HTTP `ETag` / `Last-Modified` 由响应层或底层 store 产生。
- COS/S3 object version、ETag、mtime 只在读写时从对象存储查询。
- 本地文件版本用 `stat` 或按需 hash 判断。
- RDF 图版本由 store/revision/hash 能力提供；没有能力时只能用乐观锁外的冲突策略。

Run 需要防止覆盖并发修改时，只在 `Manifest` 中保存短期 `sourceVersion`。`sourceVersion` 是 opaque token，可以来自 HTTP `ETag`、COS object version、本地 `mtime+size` 或 RDF revision；它不是 Pod 业务 metadata。

## 接口

```text
SolidFS.prepare(run, workspace) -> {
  cwd,
  manifest,
  commit(),
  rollback()
}
```

`cwd` 必须是真实目录。Runtime 不应该关心底层是本地文件、Pod 资源源文件、COS 对象、RDF working copy，还是索引命中的懒加载文件。

## local 策略

local 上普通文件一定在本机，但仍然必须经过 SolidFS，才能统一处理结构化数据、Pod store 回写和 manifest：

- `file://` workspace 的普通文件直接映射为 `cwd`。
- 不启用 bubblewrap。
- 不做普通文件的 workspace 级 projection/sync。
- `rg`、`grep`、`find`、`cat` 等普通文件工具都直接跑真实文件。
- 新产生的 durable 数据仍然写回本机 Pod store。
- `.ttl` / `.jsonld` 必须有本地真实文件作为权威内容；DB 中的 SPO/索引是派生视图。
- 旧的 graph-only RDF 数据需要迁移或生成真实文件后再进入 Agent/workspace 工具边界，不能把“只在 DB 中”作为新数据的正常形态。

## cloud 策略

cloud 上需要解决运行端本地目录、Pod/COS 权威源和同步时机：

- runtime 只能操作 `SolidFS.prepare` 返回的 `cwd`。
- 需要受限的是工具调用、文件读写和编辑边界，不是强制把整个 Agent Loop 和模型调用都塞进 sandbox。
- 能按行处理的文本、源码、Markdown、Turtle 等文件，一律倾向本地权威；不再按大小做主要分层依据。
- 不能按行处理的特殊软件格式、对象型资源或工具无法直接理解的内容，才保留对象存储 / materialize 路径。
- 写入先落到本地工作副本；`commit()` 负责把结果写回权威源，版本不匹配时返回冲突信息，由 AI 决策继续、重试或申请人工介入。
- `rollback()` 只回滚本次 materialized workspace 中未提交的变更；已经提交的 durable 写入不应被静默撤回。

这里的“本地”必须是可跨 Run 恢复的持久 workspace 存储，不是容器临时盘。

## Local-first 读取

GET 和工具读取都应优先走本地持久副本，不把 DB 作为默认绕行层。

- by-line 文件必须先在本地留一份权威数据；读请求直接命中本地文件。
- 本地命中时不需要为了内容读取先查 DB；DB 只用于权限、索引、搜索候选、路由缺失补充等辅助场景。
- 本地没有、且资源是对象存储权威时，用户 GET 可以 302，工具/运行端读取可以 hydrate 到本地后再读。
- by-line / `.ttl` / `.jsonld` 不应把“本地没有”作为正常状态；旧 graph-only 数据需要先迁移或生成真实文件，再进入工具边界。
- 写入也先落本地可恢复副本，再由系统同步到 RDF/DB 索引或 COS 冷备。

## Hydrated 生命周期

hydrated 副本需要生命周期管理，但不要把它做成新的业务状态系统。

- 只有 `dirty`、当前 Run 正在使用、或被显式 pin 的副本不允许回收。
- 其余 hydrated 副本可以按空闲时间、最后访问时间、空间压力删除。
- 被回收后再次访问时，SolidFS 重新从权威源 hydrate。
- 生命周期和回收策略属于 SolidFS 的内部 cache/working-copy 管理，不暴露成 Pod 业务 metadata。

第一版不实现 FUSE，因此裸 shell 访问一个尚未存在的对象文件不会自动触发网络下载。工具层或 runtime adapter 必须在读对象前显式调用 `workspace.hydrate(relativePath)`，拿到真实文件后再执行 `cat`、解析器或编辑器。这样 SolidFS 仍然保持“工具面对真实文件”的语义，同时避免把全量对象预下载到工作目录。

## 双副本写入规则

两份物理数据不等于两个事实源。每个资源在任一时刻只能有一个权威写入口，另一份只能作为索引、缓存、冷备或 working copy。

| 场景 | 写入规则 |
| --- | --- |
| 本地 by-line 文件 + DB 索引 | 写本地权威文件；系统同步解析并刷新 DB/SPO/全文索引。业务和 AI 不直接写索引层。 |
| `.ttl` 文件 + RDF store | 写 `.ttl` 文件；系统负责解析、校验并同步 RDF store。中间过程中如果上下文持有旧片段，需要告知 AI 文件已变。 |
| 本地 by-line 文件 + COS 冷备 | 写本地权威文件；COS 只做异步冷备或过期副本，不能参与读写仲裁。 |
| hydrated object + COS 权威对象 | 写 hydrated working copy；提交时带 `sourceVersion` 上传回 COS。提交前副本为 `dirty`，不能回收；提交成功后可作为 clean cache 保留或回收。 |

写入失败或版本冲突时，SolidFS 返回足够信息和工具入口，由 AI 决策重试、改写或申请人工介入；系统不自动合并两份内容。

## DB-first 接口

有些 app 接口会先更新 DB，例如生成 id、记录 intent、挂队列、刷新索引或创建待办壳。
这可以接受，但只能落在暂存层，不等于内容事实已经生效。

- `pending` / `intent` / `projection` 记录可以先写 DB。
- 真正的内容事实仍然必须最终写入权威源。
- 权威源写入成功后，再回填 DB 索引或把暂存记录标成 committed。
- 如果权威源写入失败，DB 里只能留下可追踪的失败/冲突状态，不能把临时记录当成最终数据对外读。

所以接口形态可以是 DB-first，数据语义不能是 DB-authoritative。

## 对 MixDataAccessor 的边界

`MixDataAccessor` 已经从旧的“RDF 内容只进入 structured store”改为 local-first RDF mirror：

- by-line RDF 文件的写入先落真实本地文件；系统再解析并同步 structured store / DB 索引。
- SPARQL PATCH 仍先作用在 structured graph 上，成功后刷新对应的本地 RDF 文件，让文件和索引重新对齐。
- 删除 RDF 资源时同时删除本地文件副本和 structured index，本地副本已经缺失时仍继续清理索引。
- structured store 保留为 RDF 查询、索引和 CSS 内部转换兼容层，不再是 by-line 文件工具面对的唯一内容事实源。
- 对象资源本地没有时仍可走 COS/S3 302 或 hydrate。

`MixDataAccessor.getData()` 保留 CSS DataAccessor 的内部 RDF 语义：RDF 资源返回 `internal/quads`，让转换链和旧接口继续工作。面向用户 HTTP GET 和 SolidFS/tool 的内容读取必须走 local-first 路径：Store 层通过 `getLocalRdfDocument()` 优先返回真实 `.ttl` / `.jsonld` 文件，找不到时才进入兼容 fallback。

API 进程和 CSS Components.js 存储容器不是同一个 DI 容器。API 侧 durable callback 不能假设可以直接拿到 CSS 内的 `MixDataAccessor` 实例；默认写回应走 Pod HTTP 面，通过 CSS/MixDataAccessor 触发文件写入和索引刷新。同进程测试或嵌入式路径可以使用 `RdfIndexSolidFsSyncer` 这样的 adapter，但它不是 API 默认跨进程路径。

## 工具语义

metadata 和索引只能加速，不能替代内容语义：

| 工具/能力 | SolidFS 行为 |
| --- | --- |
| `ls` / `find` / `rg --files` | 面向已经就绪的真实本地目录；进入工具边界前，可搜索的 by-line 文件集合必须已存在。 |
| `stat` | 优先使用底层 store / filesystem / object storage 的原生信息，metadata 只提供无法稳定推导的最小补充。 |
| `cat` / editor / shell 读文件 | 必须 hydrate 真实内容到 `cwd`。 |
| `rg "text"` / `grep` | 直接对真实本地文件执行。不能在命中时再临时投影，否则一次 grep 就需要全量投影。DB 全文索引只能作为上层优化，不替代 shell 工具语义。 |
| patch / formatters | 必须基于真实 working copy。Git 状态和 diff 原则上不由 SolidFS 管理。 |

SPO 数据进 DB 不自动等于全文索引。DB 至少需要明确维护 literal/text index 或外部全文索引，才能作为 `grep` 候选筛选层。

## RDF 和 `.ttl`

RDF 资源在 SolidFS/workspace 边界只接受文件权威形态：`.ttl` / `.jsonld` 源文件是事实源，DB 中 SPO 是解析后的索引。

旧的 graph-only RDF 数据是迁移/修复对象，不是新的运行时投影模式。系统可以在兼容路径上从 structured graph 修复出缺失的本地 RDF 文件，但修复应发生在进入 Agent 文件工具边界之前；不能把 `grep` / `rg` 的首次访问设计成触发全量 RDF 投影。

## Manifest 字段

Manifest 至少记录：

- `workspace`
- `cwd`
- `entries[]`
- 每个 entry/change 的 `path`、`resource`、`source`、`sourcePath`、`contentType`、`projection`
- `sourceVersion`: materialize 时看到的 opaque version token；来自原生 `ETag`、object version、`mtime+size` 或 RDF revision，不能作为业务字段长期维护
- `dirty`、`committed`、`conflict` 状态

`path` 是 runtime `cwd` 内的相对路径；`resource` 是对应 Pod / file authority 的完整资源地址，adapter 应优先使用 `resource`，只有缺失时才从 `workspace + path` 推导。`sourcePath` 是本轮 materialized workspace 中的真实本地文件路径，只能作为读写 working copy 的文件入口，不应被当成 Pod 资源身份。

`projection` 是 Run manifest 内的短期枚举，不写回 Pod metadata：

| projection | 含义 |
| --- | --- |
| `direct` | `cwd` 直接指向权威文件或其真实目录，不需要投影和回写。local workspace 的普通文件默认如此。 |
| `copy` | Run 使用隔离工作副本；完成时把 dirty 文件写回 filesystem 权威源。cloud sandbox 或需要隔离并发写入时使用。 |
| `hydrated-object` | 仅当对象不是本地 by-line 权威文件时，才从 COS/S3/对象存储按需下载到工作目录；任何消费方需要时都走同一条 hydrate 路径，本地 by-line 权威文件直接读。hydrated 副本是可回收缓存，不是长期事实源。 |

`projection` 只描述本次 Run 的工作方式，不是系统级资源类型。第一版不急着替换已有逻辑，先把 SolidFS 做成独立模块，通过 API、CLI 或测试接口验证；Finder/launcher 只是后续产品入口，不是 MVP 前置条件。

## MVP 验证

第一版不要求先做 launcher 或 Finder 集成，但必须通过 API、CLI 或测试接口验证 Agent 能真实在 SolidFS workspace 中执行：

1. `SolidFS.prepare(workspace)` 返回真实 `cwd`。
2. pi Agent Runtime 使用该 `cwd` 启动一次请求作用域的 `AgentSession`。
3. Agent 通过工具读取文件、搜索文本、创建或修改文件。
4. `commit()` 把变更写回 Pod 权威源，并刷新 DB 索引。
5. 再次 `prepare()` 能看到上一轮 Agent 产生的结果。

最小冒烟用例：

- `direct`: 在 local workspace 中让 Agent 读取一个文本文件并写入新文件。
- `copy`: 在 cloud-style 隔离工作副本中让 Agent 修改文件，提交后从权威 workspace 读取到修改。
- `rdf-file`: `.ttl` / `.jsonld` 在进入 Agent workspace 前已经是真实本地文件；Agent 修改后系统把该文件解析回 DB/SPO 索引。
- `hydrated-object`: 只有当本地不是权威文件、且任何消费方需要读取对象时才 hydrate；本地 by-line 权威文件直接读，普通用户 GET 本地没有时走 302。第一版通过显式 `hydrate()` 验证对象物化、dirty 提交和 clean 副本回收。
- `conflict`: commit 时版本不匹配，返回足够的冲突信息和可用工具，由 Agent 决策重试、改写或申请人工介入。

## 非目标

- 不实现完整 FUSE。
- 不让 Agent 直接理解 Pod/COS/RDF 的内部同步规则。
- 不用 DB 索引替代真实文件内容。
- 不要求 cloud 对所有对象全量同步。

## 当前实现边界

当前代码已经落地的部分：

- `LocalSolidFS` 支持 `direct`、`copy` 和 `hydrated-object` 三种 projection。
- `LocalSolidFS.prepare()` 会先校验 source workspace 必须存在且是目录，避免 runtime 拿到无效 `cwd`。
- `direct` 直接返回真实 workspace `cwd`；没有 syncer 时不扫描全仓、不维护全量 manifest，避免 runtime 启动被 `node_modules`、`.git` 或大目录拖慢。带 Pod syncer 时只跟踪 `.ttl` / `.jsonld` 这类 RDF by-line 文件变更。
- `copy` 创建隔离工作副本，`commit()` 前基于 prepare 时的文件快照做冲突检测，成功后写回 filesystem 权威源，`rollback()` 清理工作副本。
- `hydrated-object` 支持显式 `workspace.hydrate(relativePath)`：按需把对象权威源写成真实本地文件，manifest 记录 authority `sourceVersion` 和本地 `workingVersion`；`commit()` 只写回 dirty hydrated 文件，`prune()` 只回收 clean hydrated 副本，dirty 文件不会被删除。
- manifest entry 和 change 已记录 `resource` 与 `source`：`filesystem` 表示 file authority，`pod-http` 表示通过 Pod HTTP 写回，`object` 表示对象资源 hydrate/commit；Pod HTTP adapter 优先使用 `resource`，避免在 adapter 内重复猜资源身份。
- `PodSolidFsHydrator` 通过 Pod HTTP `GET` 下载对象资源到本地工作目录，记录 `ETag` / `Last-Modified` 为本次 manifest 的 `sourceVersion`；提交 dirty hydrated 文件时用 `PUT` 写回并带 `If-Match`，`409` / `412` 转成 `SolidFsConflictError`。
- `PodSolidFsSyncer` 只跟踪 `http:` / `https:` workspace。提交 `.ttl` / `.jsonld` 变更时通过 Pod HTTP `PUT` / `DELETE` 写回 CSS，让 `MixDataAccessor` 完成真实文件写入和 structured index 刷新；`file://` workspace 不走这个远程 syncer。
- durable callback 可使用请求时记录的 Solid auth context：已有 access token 时直接使用；只有 client credentials 时先向 CSS token endpoint 换 token，再写回 Pod。
- `RdfIndexSolidFsSyncer` 是同进程 adapter，用于测试或嵌入式场景直接刷新 `LocalRdfIndexAccessor`。跨进程 API worker 不应依赖它访问 CSS DI 内部对象。
- `PiAgentRuntimeDriver` 启动 pi AgentSession 前统一调用 `SolidFS.prepare()`，runtime 只拿 `workspace.cwd`，完成后 `commit()`，失败或 runtime error 后 `rollback()`；默认 SolidFS 同时配置 Pod HTTP RDF syncer 和对象 hydrator。pi 的 read/edit/write 工具路径已包装 `workspace.hydrate(relativePath)`，对象文件缺失时会先显式 hydrate 再交给工具读取或修改。
- 当前测试已覆盖 pi runtime 在真实 `LocalSolidFS` `copy` workspace 中写文件、成功后 commit 回源目录、再次 `prepare()` 能读到上一轮结果；也覆盖 hydrated-object read 前显式 hydrate 和 runtime error rollback。
- `MixDataAccessor` 对 `internal/quads` 写入采用 local-first mirror：先按资源扩展序列化成真实 `.ttl`/`.jsonld` 文件，再写 structured store；SPARQL PATCH 更新 structured graph 后会刷新本地 RDF 文件；删除 RDF 资源时同时清理本地文件副本和 structured 索引，本地副本已缺失时仍会清理 structured 索引。
- `LocalFirstRdfRepresentationResolver` 负责 local-first RDF HTTP GET：在 accessor 支持 `getLocalRdfDocument()` 且目标不是辅助资源时，优先返回真实 RDF 文件内容；`SparqlUpdateResourceStore.getRepresentation()` 只负责委托 resolver 并在 resolver 未命中时回退 CSS 默认路径。`MixDataAccessor.getData()` 对 RDF 仍返回 structured quad stream，这是 CSS 内部 DataAccessor/转换链需要的行为。

尚未落地的部分：

- `hydrated-object` 已经具备 Pod HTTP hydrate / commit adapter；尚未做 MinIO/COS SDK 直连 adapter，也没有 FUSE 级裸 bash 自动 hydrate。
- cloud 持久 workspace 与 COS 冷备的同步策略还没有完整实现。
- `LocalFirstRdfRepresentationResolver` 目前仍由 `SparqlUpdateResourceStore` 构造和调用；后续如果 GET 链路继续拆分，可以把它挂到更靠近 HTTP 内容读取的 Store/handler 层，但语义已经从 SPARQL PATCH 逻辑中抽离。
