# Xpod 产品与 AFS / SolidFS Spec

Xpod 是总产品，CLI 和 App 是使用入口；CSS、API、AFS 是可选功能模块。SolidFS 保留为通用文件访问抽象的名称，AgentFS 是当前 AFS 模块的挂载引擎。设备范围是 PC 与 NAS；Agent 在选定设备上运行。当前开发仍在 Xpod 的独立 worktree 内验证，不代表已拆仓、发布、完成模块可选启动或通用 Solid 兼容。命令布局对照既有 CLI 收敛，不为产品改名另建平行命令入口。

## 产品入口与可选模块（2026-10-01，最新设计方向）

最新用户决定以 Xpod 指总产品，包含 CLI 和 App，CSS/API/AFS 均为可选功能模块。这取代早先“XpodCli 与 Xpod 数据服务是两个产品”的划分；客户端仍可独立安装和连接远端服务。下文“独立目录入口”表示这种运行与交付边界。服务端 workspace、权威存储、projection/journal 章节描述内部设计，不能当作客户端必须复制文件、修改服务端存储或托管 Agent Loop 的要求。

| 层级 | 设计职责 | 当前实现与下一步 |
| --- | --- | --- |
| Xpod | 总产品与能力声明 | 复用现有根包和 `xpod` 总入口 |
| CLI / App | 同一产品的命令行与图形入口 | 根 CLI 和 Electron App 已存在；App 尚无 AFS 管理界面 |
| CSS | Solid 认证、资源协议与存储 | 现有服务；尚未支持统一模块选择 |
| API | 管理与业务接口 | 现有服务；尚未支持统一模块选择 |
| AFS | Pod 目录挂载、搜索、未提交修改与条件提交 | 客户端可独立运行；服务端目录扩展目前随 CSS 配置启用 |
| AgentFS | AFS 内部文件系统引擎 | 已选主线，复用 NFS/FUSE；用户无需另外部署 AgentFS 服务 |

“可选”需要表达依赖，而不是把所有模块都做成一个独立 HTTP 子进程。AFS 客户端可在没有本机 CSS/API 时连接远端 Xpod；AFS 服务端目录扩展依赖 CSS 的存储和授权链。Gateway 按启用的服务提供路由，仅客户端运行时不必启动本机 Gateway。API 关闭后 App 应仍能提供本地状态与 AFS 入口，不能为了打开 App 自动启动整套服务。

下一步模块化实现应由一个运行计划决定组件、配置、路由和 readiness，供 CLI start、App、自启动入口与库入口共同消费。现有多个入口各自启动 CSS/API，不能只在其中一处加开关。AFS 服务端配置按能力启用，关闭的 API 路径应明确不可用，不能回落到 CSS。此处是设计边界，本次目录 MVP 尚未实现统一模块选择，不扩展到远程会话控制。

### 发布与接口

- Xpod CLI 可交付客户端能力组合，包含认证、AFS 与可选设备常驻服务。现有 `packages/xpod-cli` / `xpodcli` 预览产物是客户端构建配置，不是另一个总产品；本次不自动改包名、二进制名或已生成产物。PC 提供对应 OS 安装包，NAS 的 Linux amd64/arm64 容器形态仍需逐架构验收。
- 文件访问、挂载引擎、搜索、Agent 会话分别走能力接口和注册机制。当前只维护 AgentFS 产品主线；rclone 保留调研证据，不随产品分发。引擎不写进上层产品契约。
- 通用 Solid provider 应通过标准 HTTP/LDP、认证与条件请求表达目录和文件能力；Xpod provider 可声明批量 metadata、精确搜索、FTS/VEC 等扩展。当前原型依赖 Xpod 目录接口，通用 provider 尚未实现或验收，不宣称任意 Solid Server 即插即用。
- 客户端不直连 Pod 的 SQL/RDF/对象存储内部表，不要求外部 Solid Server 采用 Xpod 存储布局。普通 RDF 资源的读写仍经过服务端协议验证；业务实体投影另有契约。
- Pod 目录 MVP 继续统一授权 HTTP，同机关闭持久正文读缓存，远端按需缓存，pending 修改独立恢复。外部 Git/worktree 属于设备上的项目，Pod 至多保存 Link。
- 安装体验目标是用户不装 Rust/Go 编译工具，由发布流程构建并分发 helper。OS 挂载驱动、权限及签名要求需真实平台验收；不承诺当前已做到一键安装。

### 设备服务与远程聊天

Xpod CLI 的设备常驻服务独立于 Xpod 服务进程，可与 Local Xpod 同包安装，也可单独部署在第三方 PC/NAS。通过主动连接访问控制入口，不要求每台设备开放公网端口。控制入口可由 Local/Cloud Xpod 提供；ChatKit 等聊天界面只作为入口适配。

首批能力分两组：

1. 挂载：登记/列出、创建、状态、提交、卸载；检查 active session 和 pending 修改后处理卸载。已有目录或挂载仅在明确登记、验证管理权后接入，不能自动接管所有 OS 挂载。
2. Agent 会话：声明可用 runtime，启动、连接已有受管会话、发送消息、取消及订阅事件。设备将已登记 `workspaceId/mountId` 解析为本机 cwd，第三方 runtime adapter 负责协议与交互差异；不承诺任意进程都可续聊。

设备、Pod、挂载和会话分别定位：同一 Pod 可以被多设备挂载，同一设备可以挂多 Pod，多个 Agent 可使用已授权工作区。设备执行权限与 Pod 数据权限分别验证；连接重试使用请求标识避免重复启动。设备离线返回明确状态，不推断任务已执行。

### PC / NAS 首版部署

- PC：设备服务运行在宿主，Pod 挂载供本机程序使用；Windows/macOS/Linux 的系统前提分别验收。
- NAS：优先验证设备服务、挂载和 Agent 在同一容器内使用的路径，减少跨命名空间挂载传播。容器仍依赖宿主挂载能力，不能宣称 Docker 消除了 FUSE 前提。
- NAS 挂载提供给宿主文件管理器/其他容器是独立支持级别，需要 bind propagation 和宿主支持，首版不默认承诺；原生 NAS 服务安装属于后续部署适配。
- NAS 按架构、容器运行时和挂载能力检测；尚无品牌/型号实机验收，不泛称所有 Synology/QNAP 或旧 ARM32 均支持。

下一步先验收当前目录/backend 与安装产物，再落实可选模块的统一运行计划。产品划分不触发实际发布、自动重命名、拆仓或全面实现远程控制。

### 后台管理接入调研（2026-10-01）

上层收敛为设备服务，下层按能力轴注册实现，避免按 Agent/provider 名称散落分支。以下是设计契约，不是当前已实现 API：

| 能力轴 | 最小职责 | 通用实现与专用适配 |
| --- | --- | --- |
| 文件访问 | list/stat/read/条件写/delete、原生版本基线 | 授权 HTTP；标准 Solid provider 与 Xpod 扩展声明能力 |
| 系统挂载 | probe/mount/status/提交状态/unmount | 注册挂载引擎，复用现有 OS 对接层 |
| Agent 会话 | probe/start/prompt/events/snapshot/resume/respond/cancel/close | ACP 为通用候选；原生协议 adapter 实现同一接口 |
| 设备连接 | 身份登记、请求路由、事件转发、断线重连 | 与运行时协议分离，设备主动连接控制入口 |

挂载接口不把“本地保存完成”解释为“远端已提交”；Agent 接口也不把“取消当前 turn”解释为“清空所有排队任务”。能力声明至少区分历史快照/游标、存储会话恢复/活动会话重连、提问/权限决策，以及能否连接已知既有端点。

ACP 会话协议支持 cwd、流式更新和取消，load/resume 为协商能力；其文件回调不产生 OS 挂载，无法替代 shell/Git/编译器使用的真实目录。Codex app-server 可以通过设备内 JSONL 子进程适配；其远端 WebSocket 路线目前标为 experimental，先不把它选作整个设备控制面的协议。OpenCode HTTP/SSE、pi RPC 属于同一 Agent 接口的原生实现候选。具体证据与未验证项见 [研究记录](agent-filesystem-research.md#后台管理与-agent-协议补充2026-10-01)。

首次验收优先选择一个已安装 runtime，覆盖启动、两轮对话、中断、用户提问、前端断线重连和设备服务重启恢复；再增加其他 adapter。已有任意 TUI 进程是否能接入取决于可用端点/协议，不承诺全局劫持或自动接管。

发布形态目标是一个 PC 安装包或 NAS 部署入口，其中可以包含设备服务和独立 native helper；不要求一个二进制囊括所有系统挂载。第三方 Agent 是可选运行能力，不能为单纯挂载 Pod 的用户强制捆绑全部 runtime。Xpod CLI 客户端产物也不应携带 Xpod 服务端存储引擎及构建工具。

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
| `SyncJournal` | 每个 Pod 的私有恢复/outbox 日志，记录本地权威文件写入后，哪些索引、远端冷备或删除动作还需要继续执行。它不是内容权威，也不是用户可见资源。 |
| `SyncCheckpoint` | 从当前权威文件树扫描得到的同步基线，记录文件 hash/version 与 index/remote 进度。checkpoint 用于升级 bootstrap、journal 丢失恢复和全量 reconcile，不记录历史业务语义。 |

## 状态最小化原则

SolidFS 不额外维护一套文件状态系统。持久状态只保存恢复和路由必需的信息：

本节关于权威树扫描、journal/checkpoint 丢失后重建的规则适用于服务端权威 workspace。独立目录客户端的远端工作副本不是权威树，其持久同步基线与删除恢复边界见后文“独立目录入口”；不能仅扫描客户端缓存来推断远端删除。

- `storageBackend`: 内容实际在哪里，例如 filesystem、cos。默认 filesystem 文件就是权威源，不再额外保存 authority。
- `objectKey` / `localPath`: 只有后端无法从 `resource` 稳定推导时才保存。
- `contentType`、`size`、权限等 Solid/HTTP 原生需要的信息。

`SyncJournal` 和 `SyncCheckpoint` 是这个原则的例外边界，但它们只能保存恢复/投影进度，不能保存另一份内容事实：

- 不存文件正文；文件正文只在权威文件或对象存储中。
- 不把 DB index、COS 副本或 remote PUT 结果提升为权威。
- 不暴露为 Solid resource、Finder 文件或 Agent workspace 内容。
- 丢失时必须可以从权威文件树和远端 listing 全量扫描恢复，只是恢复成本更高。

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

Run 需要防止覆盖并发修改时，只在 `Manifest` 中保存短期 `sourceVersion`。`sourceVersion` 是 opaque token，可以来自 HTTP `ETag`、COS object version、本地 `mtime+size` 或 RDF revision；它不是 Pod 业务 metadata。独立目录客户端可以在私有 control 中跨进程保存原生版本基线，但不得把它提升为新的 Pod 业务版本字段；具体 HTTP 条件写必须遵守对应版本类型的协议语义。

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

## Sync Journal / Outbox

SolidFS 的可靠性目标是最终一致，而不是跨本地文件、RDF index、全文/vector index、COS/Pod HTTP 的强事务。journal 负责让程序崩溃后知道“下一步该继续做什么”；内容事实仍然以本地权威文件或对象权威源为准。

### 放置位置

journal 必须跟 Pod 数据同故障域移动，但不能放在 Agent 可以直接删除的普通 workspace 中。推荐 Pod bundle 分层：

```text
pod-bundle/
  data/          # 用户文件、Agent cwd、Solid resource 可见区
  control/       # Xpod 私有控制面状态，不暴露给用户和工具
    sync-journal.sqlite
    sync-manifest.sqlite
    locks/
```

`data/` 才能作为 runtime `cwd` 或 Finder/Solid 文件入口。`control/` 需要由 xpod 服务用户持有并以权限、sandbox 或挂载边界保护；cloud runtime 的文件视图不能越过 `data/` 访问 `control/`。local 用户如果主动删除本机私有控制目录，系统也必须能通过全量扫描恢复，而不是要求再次重制数据。

cloud 如果把 journal 放进 PG，物理上可以是同一张 `pod_sync_ops` 表，但语义上仍然是 per Pod；PG 表只是分布式 lease/outbox 和可观测状态，不取代 Pod 本地权威文件与 checkpoint。

### 粒度

journal 不做全局单日志，也不做每文件一个日志：

- 逻辑归属是每个 Pod 一个 journal。
- entry 粒度是一次资源变更或投影动作。
- 多文件 SPARQL UPDATE、批量 commit 或目录级操作用 `tx_id` 把多个资源 entry 绑定在一起。
- 物理表可以按 `pod_id` 分区或带 `pod_id` 字段，但 replay、reconcile 和权限判断都必须以单个 Pod 为边界。

### Move projection entries

文件或文件夹移动复用现有 SolidFS SyncJournal，不引入第二套 move log。P0 写入者把目录移动
展开成多条 `moved` entry，每条记录旧定位和新定位：

- `previousPath` / `previousResource`：移动前的本地相对路径和 Solid resource URI。
- `path` / `resource`：移动后的本地相对路径和 Solid resource URI。
- 同一次目录移动或批量 commit 的 entry 共享一个 `tx_id`，replay、reconcile 和运维视图按
  同一个恢复单元处理。

P1 可以增加 `moved_prefix` 作为超大目录移动的压缩表示，但它也必须走同一个 journal 生命周期；
不能绕开 `intent -> local_committed -> indexed -> synced -> done` 阶段。

Move replay 的顺序是：先更新文件/对象定位，再让 projection syncer 更新派生状态。RDF URI
projection 优先调用 RDF engine 的 `rewriteTerms(...)` 能力，在安全时只改 term dictionary 中
受控的 URI term；不要把未改内容当成普通 update 重新解析，也不要为每条受影响 quad 重写事实行。
text/vector source 这类按 source URI 建索引的派生数据可以按旧 source 删除、按新 source 重建；
它们仍然是可重建 cache，不是文件移动的权威事实。

最小字段形态：

```text
sync_transactions(
  tx_id,
  pod_id,
  status,
  created_at,
  updated_at
)

sync_ops(
  op_id,
  tx_id,
  pod_id,
  resource,
  path,
  op_type,          # write / delete / rename / index / upload / reconcile
  before_hash,
  after_hash,
  local_version,
  stage,            # intent / local_committed / indexed / synced / done
  retry_count,
  error,
  lease_owner,
  lease_until,
  created_at,
  updated_at
)
```

SQLite 自带 WAL 只能保护 `sync-journal.sqlite` 自己的事务恢复；业务恢复语义必须读 `sync_ops.stage`，不能读取 SQLite WAL 文件来推断 SolidFS 执行进度。

### 写入和 replay 协议

所有跨系统写入都按可重试阶段推进：

1. 写 `intent`。记录资源、目标 path、op 类型、旧 hash/version 和幂等 key。
2. 原子写本地权威文件。文件写入必须使用临时文件、`fsync`、`rename` 和目录 `fsync`；成功后标记 `local_committed`。
3. 刷新 DB/RDF/text/vector index。索引刷新必须幂等：按 source/path 删除旧派生数据，再从当前权威文件重建；成功后标记 `indexed`。
4. 同步远端冷备或 Pod HTTP。PUT/DELETE 必须带 source version、hash 或幂等 key；成功后标记 `synced`。
5. 所有目标完成后标记 `done`。

重启后只扫描非 `done` entry，按 `stage` 继续执行。每个 stage 都必须能重复执行；如果文件 hash 与 journal 记录不一致，说明已有更新的写入覆盖了旧 op，应进入 reconcile 而不是强行回放旧内容。

删除操作需要 tombstone 或 checkpoint 支持。不能把“删除事实”只放在短期 journal entry 里，否则 journal 丢失后无法区分远端多余对象是旧副本还是仍需保留的对象。最终一致策略是：本地权威文件树缺失 + checkpoint/远端 listing 对账，经过 grace period 后清理远端多余副本。

### 生命周期和压缩

journal 不是审计日志，不能无限保留。`sync_ops` 的唯一职责是驱动未完成同步和故障恢复；完成后的历史应该被 checkpoint 吸收并压缩，避免控制面状态随文件改动次数线性增长。

保留规则：

- 非 `done` / 非终态 op 必须一直保留，直到成功、进入永久失败，或被人工/系统 reconcile 取代。
- `done` op 在最新 checkpoint 已覆盖对应 `path + after_hash/local_version` 后，可以按保留期删除。
- tombstone/delete op 需要保留到远端删除确认并经过 grace period；如果没有远端副本目标，只需要保留到本地 checkpoint 已记录删除。
- `failed_retryable` 保留并重试，不能被普通 compaction 删除。
- `failed_permanent` 保留用于诊断和用户决策；解决、重试成功或人工确认放弃后才能压缩。

第一版默认值：

| 类别 | 默认保留 | 说明 |
| --- | --- | --- |
| `done` write/index/upload | 7 天，且已被 checkpoint 覆盖后 | 只保留短期排障窗口；checkpoint 是长期状态。 |
| tombstone/delete | 30 天，且必须已确认远端删除或完成远端 garbage collection | 防止 journal 丢失后无法清理远端旧对象。 |
| `failed_permanent` | 30 天或用户/管理员确认后 | UI/API 应能看到错误摘要；正文不进 journal。 |
| checkpoint 当前版本 | 长期保留 | 每个 path 只保留当前摘要，不保留每次修改历史。 |
| checkpoint 旧版本 | 最近 1 个成功 compaction 周期 | 仅用于 compaction 崩溃恢复。 |

空间上还需要硬阈值触发 compaction：

- 单 Pod journal 超过 64 MiB，触发 compaction。
- 单 Pod `done` op 超过 100000 条，触发 compaction。
- compaction 只能删除已被 checkpoint 覆盖的终态 op，不能删除未完成 op、未确认 tombstone 或当前 checkpoint。

compaction 流程必须可崩溃恢复：

1. 根据当前权威文件树和远端状态写入新的 checkpoint shadow 表/文件。
2. 校验 checkpoint 覆盖所有非删除权威文件，以及仍需保留的 tombstone。
3. 原子切换 active checkpoint。
4. 删除已覆盖且超过保留期的 `done` op。
5. `VACUUM` / `wal_checkpoint` / PG autovacuum 只作为物理回收，不能承担业务 compaction 语义。

### Bootstrap 和重制顺序

新增 journal 不能要求再重制一次数据。升级到 journal 版本时必须支持 bootstrap：

1. 创建空 journal 和 checkpoint 存储。
2. 扫描 `data/` 下当前权威文件树。
3. 为每个文件计算 `path`、content type、hash、mtime/size 或 native version。
4. 和现有 RDF/text/vector/remote 状态比较，生成 `done`、`needs_index`、`needs_upload` 或 `needs_delete_remote` 的 checkpoint/op。
5. 后台 worker 从这些 op 开始补齐派生索引和冷备。

bootstrap 不需要补历史操作日志，只建立当前快照。数据重制应排在 journal 实现之后：先让新版本具备 journal/bootstrap/reconcile 能力，再在 beta/现网中清理旧 graph-only RDF、旧 index 和缺失 profile 的脏数据。这样重制后产生的新 profile/card、`.data/**` 和索引状态都能被 journal 接管，后续 journal schema 升级只需要迁移 control state 或重扫 checkpoint，不应再次清空业务数据。

### 失败与恢复

- journal 丢失：重建空 journal，扫描 `data/` 和远端 listing，生成新的 checkpoint/op；DB index 可从本地权威文件全量重建。
- DB/RDF index 丢失：不影响内容事实，从 `data/` 全量 `replaceSource(...)` 重建。
- 远端冷备丢失：从本地权威文件重新上传。
- 本地权威文件丢失：这是内容丢失，只能从备份、COS 冷备或用户恢复；journal 不能凭空恢复正文。
- 旧 graph-only 数据：进入 Agent 文件工具边界前必须投影/修复成真实 RDF 文件；如果产品允许旧数据丢失，重制时直接丢弃。

### 非目标

- 不把 journal 做成全局队列。
- 不把 journal 暴露为业务模型或 Pod resource。
- 不用 journal 替代账号/identity 数据库。
- 不要求 index query 首次命中时动态补投影；补投影和 reconcile 是后台维护动作。

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
- `journal-recovery`: 模拟本地权威文件已写入但 RDF/text index 或远端同步尚未完成时进程退出；重启后 replay journal 能补齐 index/remote 状态，且重复执行不会产生重复 quads 或错误删除。
- `journal-bootstrap`: 在已有 `data/` 文件但没有 journal 的 Pod 上升级，启动时生成 checkpoint 并补齐缺失索引，不要求再次重制数据。

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
- `RdfIndexSolidFsSyncer` 是同进程 adapter，用于测试或嵌入式场景直接刷新 `LocalRdfIndexAccessor`、可选 `RdfTextIndexLike` 和可选 `RdfVectorIndexLike`。vector index 必须显式传入 `vectorizeText`，避免 SolidFS 默认路径绑定具体 embedding provider；跨进程 API worker 不应依赖它访问 CSS DI 内部对象。
- `SqliteSolidFsSyncJournal` 已实现第一版 per-Pod / workspace outbox：记录本地权威文件提交后的 `local_committed` op，replay 时校验当前文件 hash，成功后写 checkpoint 并标记 `done`，失败则进入 `failed_retryable`，文件已被更新则进入 `reconcile_required`。
- `JournaledSolidFsSyncer` 可以包装单个 `SolidFsSyncer` + 显式 journal；`WorkspaceJournaledSolidFsSyncer` 按 workspace 自动解析持久 journal 路径，让 RDF/text index 刷新或 Pod HTTP sync 共享同一套 journal、bootstrap、replay 和 compaction 机制；journal 只保存 metadata，不保存文件正文。
- `LocalSolidFS.commit()` 会把同一次多文件提交里的 journal entry 绑定到同一个 `tx_id`，便于 replay、reconcile 和运维视图把批量文件 commit 识别为同一恢复单元；单文件提交仍不额外生成 tx。
- `MixDataAccessor` 的本地 RDF SPARQL PATCH 路径可选接入同一个 journal 形态：传入 `rdfFileMapper` 与 `localRdfAuthorityJournal` 后，多文件 PATCH 会在本地 authority file 落盘后、structured/text index 刷新前登记 `local_committed`，同一次 PATCH 共享一个 `solidfs_tx_*`；刷新全部成功后统一 `done`，刷新失败并执行 rollback 时统一标记 `reconcile_required`。未配置 journal 时保持原有同步写入语义。
- journal compaction 已按第一版生命周期执行：`done` op 默认 7 天且必须被 checkpoint 覆盖后删除，delete/tombstone 默认 30 天，`failed_retryable` 和未完成 op 不会被普通 compaction 删除。
- `LocalSolidFS.prepare()` 已调用 syncer 的 workspace 初始化钩子；默认 `PiAgentRuntimeDriver` 使用 `WorkspaceJournaledSolidFsSyncer(PodSolidFsSyncer)`，所以每次 Agent Loop 启动前都会对当前 workspace 执行 bootstrap、pending replay 和 compaction。带用户/任务 auth context 的下一次 Run 会继续上次崩溃或网络失败后留下的 pending sync。
- `PiAgentRuntimeDriver` 启动 pi AgentSession 前统一调用 `SolidFS.prepare()`，runtime 只拿 `workspace.cwd`，完成后 `commit()`，失败或 runtime error 后 `rollback()`；默认 SolidFS 同时配置 journaled Pod HTTP RDF syncer 和对象 hydrator。pi 的 read/edit/write 工具路径已包装 `workspace.hydrate(relativePath)`，对象文件缺失时会先显式 hydrate 再交给工具读取或修改。
- 当前测试已覆盖 pi runtime 在真实 `LocalSolidFS` `copy` workspace 中写文件、成功后 commit 回源目录、再次 `prepare()` 能读到上一轮结果；也覆盖 hydrated-object read 前显式 hydrate 和 runtime error rollback。
- `MixDataAccessor` 对 `internal/quads` 写入采用 local-first mirror：先按资源扩展序列化成真实 `.ttl`/`.jsonld` 文件，再写 structured store；SPARQL PATCH 更新 structured graph 后会刷新本地 RDF 文件；删除 RDF 资源时同时清理本地文件副本和 structured 索引，本地副本已缺失时仍会清理 structured 索引。
- `LocalFirstRdfRepresentationResolver` 负责 local-first RDF HTTP GET：在 accessor 支持 `getLocalRdfDocument()` 且目标不是辅助资源时，优先返回真实 RDF 文件内容；`SparqlUpdateResourceStore.getRepresentation()` 只负责委托 resolver 并在 resolver 未命中时回退 CSS 默认路径。`MixDataAccessor.getData()` 对 RDF 仍返回 structured quad stream，这是 CSS 内部 DataAccessor/转换链需要的行为。

后续增强，不阻塞当前 journal 恢复语义：

- service 级无请求后台 worker 只能做不需要用户/任务 auth context 的 compact/reconcile；Pod HTTP replay 需要沿用下一次 Run 的 context，当前已在默认 runtime prepare 阶段执行。
- 多实例 cloud 的 PG lease、远端 listing 对账和 shadow checkpoint 原子切换可以继续增强；当前恢复路径已经覆盖 SQLite outbox、checkpoint、bootstrap、replay、同 commit `tx_id` 绑定、stale-file reconcile 标记、生命周期压缩和默认 runtime 接入。
- `hydrated-object` 已经具备 Pod HTTP hydrate / commit adapter；尚未做 MinIO/COS SDK 直连 adapter，也没有 FUSE 级裸 bash 自动 hydrate。
- cloud 持久 workspace 与 COS 冷备的同步策略还没有完整实现。
- `LocalFirstRdfRepresentationResolver` 目前仍由 `SparqlUpdateResourceStore` 构造和调用；后续如果 GET 链路继续拆分，可以把它挂到更靠近 HTTP 内容读取的 Store/handler 层，但语义已经从 SPARQL PATCH 逻辑中抽离。

## 独立目录入口（2026-09-30 设计，尚未实现）

状态：用户已确认 MVP 路线（2026-09-30）：Pod 目录统一经 HTTP 访问，同机不启用持久正文读缓存，远端按需缓存；先接受本机 HTTP 开销，不实现本机 FS 直连协商。文件视图底座尚未确定，AgentFS 仍为候选。Agent 内容搜索接入 Xpod FTS/VEC，文件发现查询元数据，不默认要求预下载。下面保留显式全量同步路线作为备选，其 CLI、完整物化和验收步骤不是当前 MVP 要求。

### 产品范围与所有权

把 SolidFS 从需要 Agent Runtime 驱动的库扩展成独立目录能力：文件视图供 Agent、编辑器和 shell 使用，搜索通过统一接口接入 Xpod 索引，不启动或管理 Agent 会话。原生目录兼容性与 Agent 搜索适配分别验收；不能因为一个 Agent 的搜索工具可用，就声称任意 shell 命令已透明接入服务端搜索。

Pod 自身的文件通过 Solid 资源接口访问；外部项目只在 Pod 保留 Link。Git 仓库、分支、commit、worktree、草稿保存及恢复均由外部工作空间工具管理，SolidFS 不在 Pod 保存这些细节，也不实现 Git remote。需要解析共享 Link 时消费 `@undefineds.co/models` 的已有契约，不在 Xpod 新建 schema 或从 URL 域名猜测仓库类型。

显式同步备选提供普通本地目录和 `pull/status/push` 生命周期。按需访问路线必须在原生文件调用处完成读取，不能只依赖某个 Agent 的 hydrate hook；挂载、写回缓存和两份目录的双向同步分别选型，不混为一种能力。

### 复用 Cloud 已有的双路径（2026-09-30 补充）

Cloud 并非一律缺少本地文件。前文已有按行处理文件与对象资源的两条策略，独立目录继续复用，不能因为 edition=cloud 就为所有内容再增加 AgentFS/DB 文件副本：

- 按行处理的文本/RDF：规范以服务/运行端可恢复的真实文件为权威，索引为派生视图；这份文件不是可任意淘汰的 cache。同机且获得目录访问授权的 Agent 使用真实目录；对象存储冷备不参与正文读写仲裁。代码已经具备 RDF local-first GET 与真实文件/索引写入路径；不把它表述为所有文本格式及外部写入索引刷新均已完整验收。
- 对象/特殊格式：权威正文在对象存储或远端源，现有 hydrated-object 模式按需取得真实工作文件，再在 commit 时写回。挂载候选主要补“普通文件 open/read 自动触发 hydrate”的入口，不另建内容权威或同步系统。
- Agent 位于另一台机器时，服务端的本地文件不等于 Agent 的本地文件。远端访问需要传输/缓存，但客户端副本不因此成为服务端权威文件。

已有 `LocalSolidFS.prepare()` 的 direct / hydrated-object 和 hydrate / commit 路径可复用。当前尚无裸 shell 自动 hydrate；跨 Run Cloud 持久 workspace 与 COS 完整同步仍有前文列出的缺口。新增独立目录应验证这些缺口，而不是另造一套 Cloud cache。

### 已确认 MVP：统一 HTTP 与可选正文缓存（2026-09-30）

Pod 目录的打开、元数据、搜索、正文读写及同步状态统一经认证 HTTP 接口访问；Cloud/Local 不是客户端选择两套产品 API 的开关。第一版接受同机 HTTP 开销，不实现服务端 backing directory 暴露或本机 FS 直连授权协商。

- 同机访问不启用持久正文读缓存；远端访问仅缓存实际读取的内容，干净缓存可以回收。均不要求完整物化所选目录树；元数据缓存、内存缓冲和 OS page cache 与持久正文缓存分别处理。
- 判断同机只用于选择缓存策略，不授予访问真实目录的权限。localhost/端口转发等线索判断错误至多影响缓存效率；所有内容访问仍走同一认证与授权链。无法确认时沿用通用缓存策略。
- 编辑允许临时工作文件/缓冲；未保存内容、写回失败和 pending 数据必须保留到成功或显式放弃，不因“禁用读缓存”丢失用户修改。保存完成后释放不再需要的临时副本，不维护整棵目录的长期镜像。
- 按行处理文件继续沿用 Xpod 服务端现有真实文件权威与索引逻辑，对象沿用 hydrate/commit；客户端缓存不新增内容权威，不另造一套服务端同步系统。
- 本机 FS 直连是后续性能优化：只有实际测量显示 HTTP 是瓶颈，才评估可信目录绑定、目录授权与外部写入验证/索引更新的成本。

独立 HTTP 目录入口与上述缓存策略尚未实现。现有 Pod HTTP 客户端、hydrator 和 SolidFS 同步能力可作为基础；不等于已具备独立 CLI 完整认证、原生 shell 按需读取或安全的本机 FS 直连。

### 搜索与读取分离（2026-09-30 产品方向）

Agent 的 grep/glob 能力允许由适配器接管：通过远端索引查找，命中后才按需读取具体文件。Local 和 Cloud 共用同一搜索契约；Local 可以调用本机服务，Cloud 调用 Gateway 接口。索引是派生视图，正文与写入权威仍归 Pod 或外部 Link 目标。

| 能力 | 数据与语义 | 是否要求正文先落本地 |
| --- | --- | --- |
| 路径 glob/list | 在授权范围内按路径/文件名元数据执行确定性通配符和目录查询 | 否 |
| 文件发现 | 对文件名、标题、描述等可用元数据做 FTS/VEC 排名 | 否 |
| 内容搜索 | 对已索引正文做 FTS、VEC 或融合检索，返回资源地址、片段和版本信息 | 否 |
| 读取/编辑 | 对具体资源按需获取真实内容，编辑前记录对应版本基线 | 是，读取所需文件或范围 |

这些是能力契约，不是新增 Pod 业务 schema 或已实现的 HTTP 路由。元数据字段与资源身份消费已有共享定义；额外搜索索引可重建，不保存第二份业务状态。

- glob 的 `**/*.ts` 等精确模式需要路径索引/匹配算法；FTS/VEC 可以扩展自然语言找文件，但相关度候选不能冒充完整 glob 结果。
- 内容 FTS 与 regex/substring grep 的匹配语义不同；VEC 用于概念相似度。搜索请求与结果需标明模式，不给向量近似结果承诺精确匹配或完整性。要求精确行号/regex 时对候选原文校验，并明确没有索引保证时需要原文扫描。
- 检索必须先施加当前身份和所选目录范围的访问过滤；片段、文件名和命中数量都不能泄漏不可访问资源。HTTP 读取仍需重新授权。
- 结果标明索引对应的 source version/hash 与片段定位；正文已更新、索引缺失或过期时返回可解释状态，零命中不能冒充当前全量文件没有匹配。
- 尚未写回的本地修改、新增和 whiteout 删除必须合并进搜索视图：本地路径覆盖同路径远端命中，删除屏蔽远端候选。第一版可直接扫描本地 delta，后续再增加本地派生索引；离线时不得声称云端范围完整。
- 接管可发生在 Agent 搜索工具/MCP/协议 adapter 边界，也可发生在 shell 命令入口；不能假设替换一个 SDK 工具便接管了所有 `bash grep`/`rg`。
- 原生 shell 的全文搜索仍按文件 API 读取，可能下载搜索范围内全部内容。Xpod 的 FTS/VEC 路线让支持搜索 adapter 的 Agent 避免这类全量读取，不承诺任意原生命令自动变成语义搜索。

本阶段按能力选型；候选证据与持续追踪集中维护在 [Agent 文件系统与按需目录调研](agent-filesystem-research.md)。性能验收分别测量目录枚举、缓存读取、远端冷读取、FTS/VEC 查询和挂载/启动耗时，不把厂商某一项“毫秒级”指标扩大成整个目录产品的性能。

已有检索基础：`src/api/runs/RdfRunContextRetriever.ts` 已组合 text/vector 查询；`src/storage/rdf/types.ts` 提供 source/path prefix 与 allow/deny scope；`src/storage/rdf/RdfAccessScope.ts` 可在检索前收敛权限范围。独立目录搜索不能绑定 Run，也不能假定 graph 权限覆盖普通文件 source。`src/http/search/SearchHttpHandler.ts` 的历史 `/-/search` 方案只检查 base 后执行 vector 查询，且当前配置未发现注册；不能作为权限完整、已上线的目录检索入口复用。新的检索服务需对真实 source URI 授权，并报告覆盖度、新鲜度和分页/截断状态。

#### shell 搜索入口：进程范围的 rg/grep wrapper（2026-09-30 已确认 MVP，尚未实现）

启动 Agent 时在其 `PATH` 前置客户端提供的命令目录，让 `rg`/`grep` wrapper 对受管理的 Pod 路径调用同一 HTTP 搜索服务；普通路径与不支持的调用转交预先解析的原生可执行文件，避免 wrapper 递归调用自身。该环境仅作用于 Agent 及其子进程，无需替换系统二进制。首个原型优先验证 `rg`，再按实际调用增加兼容面。

- `rg --files` 可走精确路径元数据枚举；内容搜索先声明支持的参数组合，在服务端执行兼容的精确匹配，并合并本地 dirty、新增和删除。FTS 可用于有完整性保证的候选筛选，VEC 另设语义搜索入口，不静默替换 regex/substring 语义。
- 兼容契约包括 cwd/相对路径、ignore/glob、行号与上下文、输出格式、stdout/stderr、退出码和取消。索引缺失、过期或候选覆盖不完整时，对未覆盖范围执行原文扫描，或明确失败；不能把部分结果当作成功的全量搜索。
- stdin/管道输入、未知参数或不支持的匹配模式回退原生命令；跨 Pod 与普通路径的混合调用在能够正确合并前整体回退。原生命令扫描挂载目录时仍可能按需下载整个搜索范围。
- 绝对路径执行、Agent 自带的 rg、内部搜索库及重设 PATH 的沙箱可能绕过 wrapper，需逐 Agent 验证并在其工具/执行入口适配。仅有文件系统挂载无法取得搜索表达式，因此不会自动将原生搜索转换为 HTTP 查询。

参考：[ripgrep 官方指南](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)。用户已确认先做 `rg` wrapper，按实际调用补充 `grep`；复用统一 HTTP 与可选正文缓存路线，不表示已支持所有 Agent 或完整 rg/grep 参数集。

实现顺序与验收：

| 顺序 | 交付 | 验收条件 |
| --- | --- | --- |
| 1 | 明确目标 Agent 的实际调用与首批兼容参数；定义受管理路径到 Pod URI 的映射 | 记录可执行文件来源、cwd、参数和输出需求；未知调用能无损转交原生命令，且不会递归调用 wrapper |
| 2 | 统一 HTTP 目录枚举与精确搜索服务 | 在当前身份与目录授权范围内检索；缺失/过期索引不产生假阴性，分页或截断不被当作完整结果 |
| 3 | `rg --files` 与首批内容搜索 wrapper | 同一夹具分别执行原生 rg 与 wrapper，对比路径集合、命中内容、行号、stdout/stderr 与退出码；测量传输字节，证明支持的搜索无需下载目录全部正文 |
| 4 | 挂载视图与本地 delta 接入 | 新增、修改、删除后搜索反映当前视图；读取按需获取，条件写入拒绝版本冲突；本机不保留持久正文读缓存 |
| 5 | 第三方 Agent 实际运行验收 | 在实际执行环境验证 PATH 生效与绕过情况；Local/Cloud 复用 HTTP 契约，分别记录冷读取、热读取及搜索耗时，不预设性能比例 |

以上是实现计划与待验证条件；当前没有 wrapper、独立目录搜索路由或挂载 backend 的完成证据。首批参数由调用采样决定，FTS/VEC 扩展与更多命令兼容不得阻塞最小精确搜索链路。

### 按需访问候选：AgentFS

AgentFS 的可替换 lower filesystem 与本地持久 delta 是候选实现；官方能力、源码扩展点、测试套件和当前缺口见 [AgentFS 调研记录](agent-filesystem-research.md#turso-agentfs)。当前 MVP 优先验证统一 Pod HTTP backend，保持 Pod 文件权威及外部 Link 边界；HostFS lower 仅为后续直连优化参考，不是第一版必须实现的另一套路径。

原型需证明：目录枚举不下载正文、原生文件读取按需获取、Agent 搜索使用授权 FTS/VEC、delta 修改可通过条件写入安全回传。Overlay 隔离修改与写回是两个步骤；不能仅因提供 lower 接口就声称已支持 Pod、双向同步或所有原生工具。

以下章节的目录物化、显式 pull/push 和完整下载要求，限定为同步备选。按需路线的 ready 语义、缓存失效和保存确认需要在原型验证后独立确定。

### Local / Cloud 与访问位置

部署模式不能单独决定目录实现；还要判断目标是否属于当前设备，并区分本机目录与 Pod HTTP 资源。

| 场景 | 同步备选行为 | 写入语义 |
| --- | --- | --- |
| 本机外部目录或当前设备可解析的目录 Link | 返回已有真实目录，不复制普通文件 | 原生文件系统；Git/worktree 继续由用户工具管理，不上传到 Pod |
| Local Xpod 的 Pod Container，同机客户端 | 经当前 Gateway 枚举并准备本地工作副本；不暴露 CSS backing directory | `push` 经 Gateway 做认证、授权和资源写入，沿用 CSS 索引更新路径 |
| Local Xpod 的 Pod Container，异机客户端 | 经可达且已认证的 Gateway 准备工作副本 | 与 Cloud 远端访问使用同一契约 |
| Cloud Xpod 的 Pod Container，本机或云端客户端 | 在客户端执行环境准备持久工作副本 | Gateway/Pod 是远端权威，工作副本保存尚未写回的修改 |

服务端的持久 by-line 文件仍是服务端权威；远程客户端下载的文件是工作副本，不能把前文的 server-local-first 规则解释成客户端缓存也有权威性。

同机 Pod 直连目录是后续优化，前提是服务提供可信的目录绑定、明确权限边界和任意文件修改后的可靠校验/索引机制。仅发现同机路径或 `edition=local` 不足以允许绕过 Gateway。普通目录不能提前阻止错误 RDF 落盘，文件监听也不能等同于 HTTP 写入授权。

另一台设备的 `file://` Link 不能用当前机器上的同名路径替代。没有目标 adapter 或目标不可达时报告原因；HTTP 页面、Git 地址不能自动当成 Solid Container。第一版目标输入限定为本机目录和已验证的 Pod Container，通用 Link 解析在共享契约核对后接入。

### 目录就绪与完整性

`open` 必须先完成选定子树的枚举和物化，再返回 `ready`：

- 复用 CLI 的 Container 解析，增加递归遍历；只遍历根 URI 边界内且当前身份可访问的资源，不跟随任意 RDF link。
- 所选范围内的普通文件和 RDF 源文件必须真实存在，包括二进制和空目录。第一版不采用只下载已知路径的懒加载，因为任意 shell 没有 hydrate 钩子。
- 一次打开只处理用户选择的子树，不要求下载整个 Pod。范围过大、文件下载失败或目标文件系统无法表示资源名时，返回不完整状态和原因，不能静默遗漏后声称完整就绪。
- 文件内容与资源版本从同一次 GET 获取；URI 相对路径编码/解码有唯一规则，拒绝路径穿越、大小写/归一化碰撞和指向范围外的重定向。路径验证覆盖符号链接父目录，第一版拒绝缓存树中的符号链接。
- 隐藏用户资源（例如 `.data`）不按“隐藏文件”整体排除。Container listing、内部元数据和 Xpod control state 不伪装成用户文件。
- `.git` 管理项不参加 Pod 工作副本的同步。用户配置的其他排除项必须体现为明确范围；未知或排除资源不能通过本地缺失推断远端删除。
- `ready` 表示已取得可用文件和逐资源基线，不表示下载过程中取得跨文件事务快照，也不表示缓存始终最新。

已打开的文件可离线阅读和编辑；断网时 `push` 报告 pending，不声称已写回。权限撤销后拒绝后续远端访问；普通目录中的已下载内容不能被视为可即时远程收回。

### 持久状态和操作语义

独立目录不绑定某次 Run；控制信息必须跨 CLI 进程和重启保存，并位于工作目录之外：

```text
client-workspace/
  data/      # 返回给用户的真实 cwd
  control/   # source URI、映射、同步基线、pending 操作、恢复进度
```

该布局是示意。路径、基线和同步进度属于本机控制状态，不写进 Pod，也不创建业务文件版本 schema。复用现有 journal/outbox 能力，但需核对其与远端工作副本的权威规则；恢复日志不得通过一次重扫就丢弃未回传的删除意图。凭据由现有 CLI auth store 管理，不放进 `data/`。

客户端 control 丢失后，缓存树无法恢复原始基线或判断哪些缺失是用户删除。保留现有文件，报告恢复所需信息，通过重新读取远端和显式对账建立新基线；不得自动传播删除、覆盖同名远端内容或声称完整恢复。这个边界与服务端权威树重建 journal 不同。

CLI 产品入口见 [CLI Spec 的 Workspace Directories](cli-spec.md#workspace-directories-proposed)。操作契约为：

| 操作 | 行为 |
| --- | --- |
| `open` | 验证目标与身份，准备目录、持久基线，返回真实路径与就绪状态；已有非空目标目录不得被覆盖 |
| `status` | 比较本地树与基线，报告新增/修改/删除和 pending/conflict；不访问网络，不把 local-clean 称为远端最新 |
| `pull` | 明确从远端检查变化；干净文件可以更新，本地修改与远端变化冲突时保留本地文件并报告，失败 listing 不能解释成删除 |
| `push` | 从真实目录计算本地变更，以原生条件请求写回；不要求 Agent 使用特定工具，不是 Git commit/push |
| `close` | 解除客户端工作空间绑定；保留文件及未完成操作的恢复信息，不自动删除目录、未提交修改或 Git 内容 |

本机外部目录使用同一入口返回 `direct` 模式；`pull/push` 明确报告该目录无需 Pod 同步。每个绑定只管理其根目录，外部工具新建的其他 worktree 不会被递归发现或自动同步。

### 写回、并发与恢复

- 创建文件使用 `If-None-Match: *`；更新和删除使用读取时取得的强 ETag 与 `If-Match`。弱 ETag 或 Last-Modified 不得伪装成强 ETag；若服务端没有经过验证的安全条件写能力，第一版仅提供只读目录。
- 必须在真实 Gateway 验证条件请求不会被忽略，包括文件与 Container 创建/删除；本地预检查不能替代服务端原子条件判断。
- 删除只针对基线中明确存在且用户在完整本地视图中删除的资源。目录创建按父到子、删除按子到父；对未下载内容、未知子项或未完成 listing 不执行递归删除。
- 目录含排除项或未知资源时不能删除祖先 Container。即使 listing 完整，远端也可能新增子项而不改变 Container ETag；必须验证服务端拒绝删除非空目录，并仅使用非递归空目录删除，否则第一版保留空 Container 并报告目录删除不受支持。
- 第一版移动表现为有记录的创建与删除，先完成目标写入再删除源；报告非原子语义，不自动改写 RDF 正文中的链接。
- 每次成功操作推进该资源基线，失败保留本地内容和 pending 状态。批量写回可以部分完成，必须逐项报告成功/失败/冲突；不宣称跨资源事务。
- 重启后，pending 操作以本地内容、远端版本和操作记录对账；响应丢失不得直接无条件重试。无法证明原操作已生效时报告冲突，不覆盖别人后续修改。
- CLI 各操作在同一控制目录互斥。任意外部进程仍可能修改文件，因此 push 先取得内容一致的本地快照并固定上传字节，不能直接流式读取仍被修改的工作文件；无法取得稳定快照时推迟该文件。写回基线绑定已上传快照，完成后与当前工作文件比较，不同则继续标为 dirty，不能误报 clean。
- `pull` 的本地替换使用逐文件原子写与恢复机制，禁止套用当前 `copy` 模式删除整个 sourceRoot 再复制的算法。发现本地并发修改必须保留可恢复副本，不静默丢失修改。
- 普通文件通过资源 HTTP 操作，RDF 源文件通过 CSS 的原生资源写入与验证路径刷新索引。共享 Link 模型读写仍优先使用 models/drizzle-solid；二者不是替代关系。

### 现有实现可复用点与缺口

以下是代码审计结论，不代表独立目录已交付或本次已执行测试：

- `src/solidfs/LocalSolidFS.ts`：已有真实 cwd、文件变更检测和显式 commit，但 hydrated manifest 以运行期内存为主，prepare 还要求已存在的本地 sourceRoot。
- `src/solidfs/PodSolidFsHydrator.ts`：已有单资源 GET/PUT/DELETE 和冲突映射；缺远端树枚举，新增写入缺条件创建，Last-Modified 回退不能直接放进 If-Match。
- `src/solidfs/LocalSolidFS.ts` 的 hydrated prune 要保留待回传删除；不能先清除 manifest entry 再漏掉删除提交。
- `src/solidfs/SolidFsSyncJournal.ts`：已有 outbox/checkpoint/replay，可复用恢复思路，不另建内容事实源。
- `src/cli/lib/auth-context.ts`：复用 CLI 认证生命周期；不能把服务端 ENV token endpoint 推导当独立客户端认证来源。
- `src/solidfs/PodSolidFsHttpClient.ts`：DPoP 模式需提供有效 proof 并验证刷新/重连，不能只发送 Authorization 字段。
- `src/cli/commands/resource.ts`：已有 depth=1 的 Container listing，递归能力需要补齐；`src/cli/index.ts` 尚无 workspace 命令。

### 实施顺序与验收

1. **协议与回归基础**：锁定现有行为；补条件创建、版本类型、删除意图保留、真实 Gateway 条件请求与 CLI 认证验证。先确认可安全读写，再实现目录产品。
2. **独立目录生命周期**：新增持久绑定、递归 listing、完整物化、open/status；覆盖中文/编码文件名、空目录、隐藏资源、路径边界和失败状态。共享 `src/solidfs`，CLI 只负责输入输出，不绑定 Agent。
3. **显式同步与恢复**：实现 pull/push/close、逐项冲突和失败恢复；普通 shell 编辑、新建、删除均可被识别，不依赖 Pi hydrate hook。
4. **分别验收 Local 与 Cloud**：连接当前实际 Gateway，用测试账号的独立子目录执行 `ls/cat/rg`、编辑、创建、删除、重新打开，并从 Pod HTTP 校验结果；RDF 修改再校验查询索引。使用另一客户端制造并发覆盖、创建重名和删除冲突，确认条件请求生效。

还必须验证：断网时修改保留、部分 push 后重启恢复、control 丢失不自动删除远端、pull 不覆盖 dirty、上传期间 shell 修改不会产生混合正文或误报 clean、pending 删除不被 prune 丢失、权限错误不触发清空、任意 `.git` 管理项不被上传、排除项或远端并发新增子项阻止祖先目录删除、Git 创建的其他 worktree 不自动归入当前同步根。隔离测试的通过不能表述为真实 Local/Cloud 实例通过。

实现阶段执行相关 SolidFS/CLI 回归、`bun run build:ts`、`bun run typecheck:test` 和完整 `bun run test:integration`，有 lint/static-analysis 门禁时一并执行。本次仅收敛设计，不声称上述验收已通过。后续再评估 watcher、Link adapter 和跨平台挂载，远程 Agent 会话不属于该目录产品的实施范围。
