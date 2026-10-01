# Agent 文件系统与按需目录调研

首次记录：2026-09-30；最近核对：2026-10-01（Asia/Shanghai）。状态：保留各阶段调研证据；后续比较已选择 AgentFS，最新依据见 [选型记录](xpod-cli-engine-selection.md)，实际通过范围见 [MVP 验收](agent-directory-mvp-acceptance.md)。以下“尚未选型／验收”描述对应调查阶段，不代表当前进度。

本文件集中维护本轮调研的官方来源、核实范围、性能宣传和待验证事项。[SolidFS Spec](solidfs-spec.md#独立目录入口2026-09-30-设计尚未实现) 维护 Xpod 目录产品设计，[生态关注清单](ecosystem-watchlist.md#agent-文件系统与按需目录) 提供入口。

初次调研完成文档检索及部分 AgentFS 源码核对，未安装候选、运行兼容性原型或复现候选性能测试。后续增加了本机直接 FS / SQLite API 基线，其条件、原始数据和与挂载层的区别见 [性能比较](agent-filesystem-performance.md)。2026-10-01 已续派 AgentFS Pod backend 原型与独立测试，尚无原生挂载验收结论，任务边界见 [原型计划](agentfs-pod-prototype-plan.md)。链接包含滚动更新的官网和 main 分支；进入原型时应记录确切版本/commit。用户记忆中的“挂技能、毫秒级”项目尚未确定，下面是相关候选。

## Xpod 的比较边界

- 已同意的 MVP：本机与远端统一经过授权 HTTP；本机禁用持久正文读缓存，远端按需缓存，待提交修改独立持久化。Local/Cloud 部署标签不代替同机/异机判断。
- Pod 仍拥有自己的文件；外部项目在 Pod 至多维护 Link，Git/worktree 由外部工具管理。
- Agent 内容搜索允许通过 FTS/VEC 接口完成，文件发现允许查询元数据。精确 glob、精确文本匹配和语义排名分别表达。
- 索引与本地缓存是派生数据。未写回的修改与删除要参与搜索视图，不允许查询旧远端内容后冒充当前工作空间。
- 区分 OS 挂载、程序内 VFS、技能分层加载、写时复制、缓存写回和两份目录的双向同步；这些能力不能互相替代。

## 候选总览

| 项目 | 核实深度 | 相关能力 | 对 Xpod 的主要问题 | 后续关注 |
| --- | --- | --- | --- | --- |
| Turso AgentFS | 官方文档 + Rust 接口/overlay 源码 | 可替换 lower filesystem、持久 delta、CLI 挂载 | Pod adapter、读缓存及条件写回需要实现 | 优先验证扩展点 |
| Mesa | 官网 + 官方介绍 | 按需物化、技能目录、版本化文件系统 | 目前以 Mesa repository 为中心 | 跟踪存储来源扩展 |
| Redis AFS | 官方 README | 本地同步/live mount、grep、索引查询、checkpoint/fork | Redis 是 canonical store | 参考目录和搜索产品接口 |
| Nexus（nexi-lab） | 官方 README/指南 + skill-hub | 多 backend VFS、上下文搜索、可选 FUSE、技能包 | 接入 Pod 的 backend 与平台边界未验证 | 跟踪轻量 backend 接口 |
| Rivet agentOS | 官方官网/架构/registry | 程序内执行环境、VFS、host/S3/Drive mounts | 是执行环境，不等同于现有宿主进程的目录驱动 | 跟踪文件系统 driver 扩展 |
| OpenViking | 官方 skills/WebDAV 文档 | 技能与上下文分层访问 | 上下文接口与 OS 目录支持有边界 | 参考检索/分层读取 |
| rclone VFS | 官方 mount/WebDAV/bisync 文档 | 按需读取、缓存、写回、OS 目录入口 | 缺经验证的 Solid/Pod 协议适配 | 保留为挂载底座候选 |

## Turso AgentFS

官方来源：[仓库](https://github.com/tursodatabase/agentfs)、[CLI 手册](https://github.com/tursodatabase/agentfs/blob/main/MANUAL.md)、[OverlayFS 源码](https://github.com/tursodatabase/agentfs/blob/main/sdk/rust/src/filesystem/overlayfs.rs)、[FileSystem 接口](https://github.com/tursodatabase/agentfs/blob/main/sdk/rust/src/filesystem/mod.rs)、[远端同步说明](https://turso.tech/blog/agentfs_browser)。

已核实：

- Rust `OverlayFS::new(base: Arc<dyn FileSystem>, delta: AgentFS)` 提供可替换基础层；FileSystem 有 lookup/readdir/open，文件句柄提供 pread。
- Overlay 读取回退到 base，首次修改复制文件到 SQLite delta，删除记录 whiteout；它不会自动回写 base，也不自动构成读缓存。
- CLI 支持 Linux FUSE / macOS NFS。`--base` 是本地路径；远端 sync/partial bootstrap 接 Turso 数据库，不能直接当作 Pod URI 读取。
- 可考虑 Local HostFS lower、Cloud Pod lower，加本地 delta；这是适配方案，尚未验证。只用 SDK/just-bash 不等于任意原生程序都兼容。

待验证：Pod lower 的 URI/inode 映射与缓存失效、资源权限、ETag 基线、条件写回、删除恢复、跨进程状态，以及 macOS/Linux 原生工具。README 仍标为 Beta；本轮未复现速度或兼容性。

接口与性能补充核对（2026-09-30）：

- Rust `FileSystem` 是 inode-based trait，另有 `File` trait 提供 pread/pwrite/truncate/fsync。Pod adapter 需要实现 URI 与 inode/handle 的映射，不只是几个 HTTP 回调。TypeScript SDK 的文件 API 不等于这套原生挂载扩展接口。
- [FUSE mount 源码](https://github.com/tursodatabase/agentfs/blob/main/cli/src/fuse.rs) 的 `mount` 接受 `Arc<dyn FileSystem>`；[NFS adapter 源码](https://github.com/tursodatabase/agentfs/blob/main/cli/src/nfs.rs) 的 `AgentNFS::new` 也接收 FileSystem。因此可验证实现 Pod backend 后复用 OS 对接层，但需要客户端 Rust helper 与构建/分发适配，不是现成 CLI 注册一个 Pod URL。
- FUSE 源码启用内核缓存和 writeback 等优化；当前 entry/attribute TTL 为 `Duration::MAX`，注释以单写入方及本地 mutation 通知为前提。远端 Pod 可被其他客户端修改，必须另行验证通知、失效/重验证及权限撤销；不能直接沿用无限缓存并声称远端视图实时。
- 本轮官方文档、源码与定向检索未找到支持“原生性能 99%”的可比基准，也没有 99% POSIX/工具兼容率的验收证据。热缓存读取、冷远端读取、metadata 密集操作、小文件写入、首次 copy-up 和持久化写回应分别测量；本地写成功与远端保存完成分别计时。
- 原型基准应在同一机器/数据集下比较直接目录与挂载目录，区分冷/热缓存和本机/远端 Gateway，记录 p50/p95、吞吐及下载字节；包含 ls/stat、随机/顺序 read、编辑器原子保存和实际 Agent 流程。

测试套件核对（2026-09-30）：官方 tree 固定在 `0a014ebd4918615baff589ed17486e557e7c6a23`，本轮未运行候选测试。

- [Rust CI](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/.github/workflows/rust.yml) 对 cli / sdk/rust 在 Linux、macOS、Windows 执行 cargo test；CLI shell 集成测试仅在 Linux 任务执行，不能把 Rust 跨平台测试等同跨平台挂载验收。
- [CLI 测试入口](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/tests/all.sh) 覆盖初始化、syscalls、挂载、overlay whiteout/delta、FUSE cache invalidation、bash/git/symlink 等。ptrace 测试被注释；run-syscalls、bash/git 和 symlink 项使用 `|| true` 允许失败，不能将整个入口零退出等同所有项目通过。
- [官方 TESTING.md](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/TESTING.md) 给出 pjdfstest 的挂载目录测试方法和 xfstests quick/generic 的 FUSE 配置；是可运行指南，不是已证明全部通过的报告。标准挂载目录测试可用于我们的 backend；权限/特性支持范围应逐项声明。
- [test-mount.sh](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/tests/test-mount.sh) 和 [cache invalidation 测试](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/tests/test-fuse-cache-invalidation.sh) 初始化 AgentFS SQLite DB 并调用 cargo run mount，不能原样当作 HTTP backend 测试；可复用断言，替换启动/fixture。该 invalidation 测试验证经挂载发生的 mutation，不覆盖其他客户端在远端修改 Pod 后的失效。
- [Rust Cargo 配置](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/sdk/rust/Cargo.toml) 声明 Criterion 的 overlayfs/workload benchmarks；与前述 syscall 性能脚本一并用于原型比较。测试/bench 存在不等于本轮已取得挂载性能数字。

MVP 的测试分两层：复用/适配文件语义和挂载测试；Xpod 自补真实 HTTP 身份/权限、ETag 条件写、跨客户端变化、按需读取字节数、禁用持久读缓存、缓存回收不丢 pending 修改、网络失败与重启恢复。上游 suite 不会自动覆盖这些 Pod 契约。

## Mesa

官方来源：[官网与 FAQ](https://mesa.dev/)、[介绍与技能目录示例](https://www.mesa.dev/blog/introducing-mesa-filesystem-for-agents)。

官方描述：按需物化文件、缓存/预取、版本化 repository；支持 OS FUSE 挂载及 SDK 程序内挂载。介绍示例同时配置可写项目目录与只读 `/agent-skills`，SDK bash 入口使用 just-bash。

性能宣传需保留测量口径：官网列出 10GB 文件随机读取 p95 小于 50ms、10GB repository 挂载小于 1 秒，以及毫秒级 fork/branch。挂载耗时不代表完整下载；这些数字未由本轮复现，不能当作 Xpod 验收结果。

待验证：能否把 Pod 作为按需读取来源，而非先导入 Mesa repository；官网当前 FAQ 说明现有 upstream sync 主要是 Git，非 Git 来源是后续方向。跟踪外部 backend、条件写入、平台和可用版本。它仍是用户记忆中的可能候选，不能确认就是所指产品。

## Redis Agent Filesystem（AFS）

官方来源：[README、架构与性能数据](https://github.com/redis/agent-filesystem)。

已核实：默认通过同步 daemon 提供普通本地目录，也提供 macOS NFS / Linux FUSE live mount；有文件 grep、排名查询、checkpoint、workspace fork 和 Agent skill 安装入口。Redis 明确是工作空间的 canonical store。

性能记录：README 的测试是 macOS NFS、33 个文件、7 轮中位数；literal grep 1.26ms、ignore-case grep 3.07ms、覆盖 2KB 文件 0.91ms。它没有证明跨地域冷读取、任意规模查询或整次 Agent 调用也有相同延迟。

待验证：读写 cache 与 remote authority 是否可拆分，能否接独立 Pod backend；参考 grep/query 区分与工作空间生命周期。不能把现成 Redis 模型直接替换成用户 Pod。

## Nexus（nexi-lab）

官方来源：[仓库](https://github.com/nexi-lab/nexus)、[用户指南](https://nexi-lab.github.io/nexus/guides/user-guide/)、[skill-hub](https://github.com/nexi-lab/skill-hub)。

已核实：提供 filesystem/context plane、多 backend 抽象、搜索与可选 FUSE；skill-hub 可把技能包放到 Nexus 路径。README 的按需范围读取与其 CAS 冷存储分层有关，不等于任意 HTTP/Pod URL 开箱接入。

待验证：backend 最小契约、原生目录的权限/一致性、外部内容来源、可独立复用范围。本轮没有核实一项能与 Xpod 直接比较的“毫秒级技能挂载”基准。

## Rivet agentOS

官方来源：[官网及性能口径](https://rivet.dev/agentos/)、[架构](https://rivet.dev/agentos/docs/architecture/)、[文件系统与软件 registry](https://rivet.dev/agentos/registry/)。

已核实：提供 WebAssembly/V8 执行环境与虚拟文件系统，可挂 host directory、S3、Google Drive 等来源；registry 有 grep、ripgrep、git 等命令包及 Agent 集成。目录属于 guest 视图，不能据此认定既有宿主 Claude/Codex 进程会直接获得 OS 挂载路径。

性能记录：官网的 4.8ms p50 测的是请求执行到第一段代码运行；列明 Intel i7-12700KF、10,000 次运行。不是 Pod 文件读取、技能下载或模型响应时间。本轮未复现。

待验证：VFS driver 能否独立接 Pod、远端内容与 metadata 的读取路径、guest 与宿主工具兼容边界。仅做目录产品时，完整 Agent runtime 的接入范围需要单独判断。

## OpenViking

官方来源：[skills API](https://github.com/volcengine/OpenViking/blob/main/docs/en/api/04-skills.md)、[WebDAV 范围](https://docs.openviking.ai/en/api/20-webdav)。

已核实：用上下文/文件层级组织 skills，支持分层访问；技能激活和执行仍由 Agent harness 负责。当前 WebDAV 文档限定 resources，排除 skills；不能当作完整技能 OS 挂载能力。

待验证：元数据/摘要检索与全文读取分离的接口、检索权限、新鲜度和外部 backend；以产品/API 参考为主。本轮没有核实可比较的低延迟基准。

## rclone VFS 与平台底座

官方来源：[mount/VFS](https://rclone.org/commands/rclone_mount/)、[WebDAV](https://rclone.org/webdav/)、[bisync](https://rclone.org/bisync/)。

已核实：mount 的 full 模式缓冲读取与写入，可按需读取文件范围；写缓存关闭文件后延迟上传。目录缓存和 remote polling 有支持范围，不能默认远端变化立即可见。bisync 比较两份独立目录，和挂载缓存写回是不同机制。

待验证：Solid OIDC/DPoP、资源 listing、ETag 条件写入、冲突处理与 CSS 索引更新。WebDAV Bearer 配置不是现成的 Solid proof/刷新实现。可考虑 Pod backend 或协议 bridge，尚未安装或选定。

| 平台技术 | 官方来源 | 已核实范围 |
| --- | --- | --- |
| Linux FUSE | [内核文档](https://docs.kernel.org/filesystems/fuse/fuse.html) | 用户态文件系统入口；缓存、Pod 认证与资源语义另由 adapter 实现 |
| Linux bind mount | [mount 系统调用](https://man7.org/linux/man-pages/man2/mount.2.html) | 同一目录内容映射到另一入口，无需两份文件同步；本身不维护 RDF 索引 |
| macFUSE / FSKit | [macFUSE backends](https://github.com/macfuse/macfuse/wiki/FUSE-Backends)、[Apple FSKit](https://developer.apple.com/documentation/fskit/) | 有用户态路线；具体 OS 版本、挂载位置、通知和性能限制须按采用版本再核对 |
| Windows WinFsp | [官方接口](https://winfsp.dev/apiref/) | 用户态文件系统平台；本轮没有执行 Windows 验收 |
| Windows ProjFS | [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/projfs/projected-file-system) | 可投影目录；官方指出慢远端场景需要考虑 Cloud Files API，本轮只核对概念 |

## 接口与 MVP 适配比较（2026-10-01）

这几类产品都有接口，但接口所在层级与需要采用的存储权威不同。当前比较的是接入 Pod 所需工作，尚无相同环境的候选挂载性能结果。

| 维度 | AgentFS | rclone VFS | Redis AFS |
| --- | --- | --- | --- |
| 扩展接口 | Rust inode/handle 层 `FileSystem` / `File` | Go 路径/对象层 `Fs` / `Object` | SDK/API/MCP；未核实可替换 canonical store 的契约 |
| Pod 适配 | 实现 URI/inode 映射、HTTP lower，再接挂载层 | 实现 Pod backend，或另做 WebDAV bridge | 需要先证明可以保持 Pod 为权威 |
| 同机只读不存第二份正文 | lower 可直接 HTTP 读取；持久读缓存策略需实现 | `writes` 模式只读直接访问 remote，写及读写文件落盘 | 默认同步目录不直接符合此要求 |
| 远端按需范围缓存 | lower/cache 适配工作 | `full` 模式使用 sparse 文件记录已下载范围 | live mount 存在，但 Pod 来源与缓存契约未验证 |
| 待提交修改 | overlay delta / whiteout；写回 base 需实现 | VFS 写缓存、上传与重试已有；需补 Pod 条件写和状态契约 | workspace 功能已有，权威存储仍是 Redis |
| 当前主要缺口 | 缓存失效、条件写回、大文件 copy-up、原生兼容 | Pod 认证/资源语义、ETag 冲突、外部变化、确认远端提交 | 存储边界是否适配，而非仅有没有 SDK |

证据：[rclone Fs/Object 源码](https://github.com/rclone/rclone/blob/master/fs/types.go)、[VFS 缓存模式](https://rclone.org/commands/rclone_mount/)、[AgentFS FileSystem](https://github.com/tursodatabase/agentfs/blob/main/sdk/rust/src/filesystem/mod.rs)、[AgentFS overlay](https://github.com/tursodatabase/agentfs/blob/main/sdk/rust/src/filesystem/overlayfs.rs)、[Redis AFS README](https://github.com/redis/agent-filesystem)。

初步推断：若目标集中在“Pod 文件成为普通目录、按需读、可写回”，rclone 的对象接口与现成 VFS 缓存可能更直接贴合 MVP；若持久 delta、隔离修改与后续工作空间能力成为重点，AgentFS 更值得验证。AgentFS 首次 copy-up 当前会读取整个文件，不能默认大文件编辑只下载修改范围。rclone 文件关闭及本地保存也不能等同远端提交确认。两者都仍需 Pod adapter，不能仅配置一个 Pod URL 就完成集成。

平台与认证不能省略：rclone 的 [NFS mount](https://rclone.org/commands/rclone_nfsmount/) 当前文档标为 Experimental；[WebDAV](https://rclone.org/webdav/) 的 bearer token/命令刷新能力不等同 Solid DPoP。AgentFS 的 FUSE 无限 TTL 依赖单写入方假设，远端 Pod 多客户端修改需要补重验证或失效机制。

保留 AgentFS 原型开发与独立测试，暂不切换实现，也不把候选锁成生产依赖。HTTP 目录与搜索契约应独立于挂载引擎。后续判断以四项证据为准：Pod backend 的实际适配工作、编辑/冲突/恢复正确性、外部修改可见性，以及同数据集的冷/热读取与磁盘占用。没有证据支持任一候选“原生性能 99%”。

## 系统安装与设备管理（2026-10-01）

安装重量应区分可分发的用户态 helper 与系统挂载前提，不能只比较 SDK 大小。rclone 和 AgentFS 均有预编译 CLI；自定义 Pod backend 可在构建端编译后分发，不要求用户安装 Rust/Go 工具链。我们的 helper 产物大小、签名和安装流程尚未验收，不报估计包体积。来源：[rclone 安装](https://rclone.org/install/)、[AgentFS 安装](https://docs.turso.tech/agentfs/installation)。

| 平台 | AgentFS | rclone | 安装判断 |
| --- | --- | --- | --- |
| Linux | FUSE 挂载，官方说明 fuse3 前提 | FUSE，fusermount/fusermount3 | 通常是客户端与系统 FUSE 包；容器设备权限等需单独验证 |
| macOS | 官方默认 NFS 路线 | macFUSE 或仍标 Experimental 的 nfsmount | NFS 可复用系统客户端；系统权限和原生文件语义仍需验收 |
| Windows | CLI 可安装；当前手册未建立原生挂载支持结论 | mount 使用 WinFsp | rclone 盘符挂载路径更明确，需要 WinFsp 安装 |

来源：[AgentFS 手册](https://github.com/tursodatabase/agentfs/blob/main/MANUAL.md)、[rclone mount](https://rclone.org/commands/rclone_mount/)、[rclone nfsmount](https://rclone.org/commands/rclone_nfsmount/)、[WinFsp 安装](https://winfsp.dev/rel/)。

macFUSE 新 FSKit backend 可减少传统内核扩展路线的首次授权负担，不能继续笼统说 macOS 挂载必须进入 Recovery。其官方限制包括 `/Volumes` 挂载位置、文件总以读写方式打开、缺少 FUSE 通知和性能差异。特别是读写打开可能改变 rclone `writes` 的缓存行为，尚未实测；不能据此承诺同机不存第二份正文。来源：[Getting Started](https://github.com/macfuse/macfuse/wiki/Getting-Started)、[FUSE Backends](https://github.com/macfuse/macfuse/wiki/FUSE-Backends)。

rclone 已有 [RC 挂载管理接口](https://rclone.org/rc/#mount-mount-create-a-new-mount-point)：创建、列出、卸载挂载可供设备端服务复用。AgentFS 可由设备服务管理 CLI/helper 生命周期，尚需我们的控制适配。两者都不会自动提供远程 Agent 启动、设备配对或聊天会话路由。

用户提出后续通过接口/聊天界面控制已授权设备的 Xpod、Pod 挂载和 Agent。设计方向：每台执行设备一个独立 companion 服务，管理该设备的挂载与 Agent 子进程，主动连接控制入口；Xpod 提供数据服务及授权路由，Agent 仍在选定设备运行。Local Xpod 可与 companion 同一安装包分发，但运行能力独立，第三方 Agent 机器不必安装完整 Xpod 服务。Cloud 执行设备可为独立 VM，保持此前的隔离边界。

控制请求应定位 `deviceId + workspaceId/mountId + agentType`，由设备根据已登记目录解析 cwd；运行后返回 `sessionId`，续聊/中断路由至同一会话。Pod URI、设备上的挂载路径与外部项目 Link 是不同对象；同一 Pod 可在多设备挂载。只管理已登记且有授权的挂载/服务，不能默认任意现有系统挂载可被接管。Pod 读写权限与设备执行权限分别验证；卸载需检查活动会话及 pending 修改。设备离线可返回明确状态，连接恢复不能重复启动同一请求。

ChatKit 可作为可替换聊天入口：其自定义服务端与 actions 能接收用户交互并流式返回事件，设备寻址、进程启动、原生 Agent 会话适配仍由我们实现。来源：[ChatKit 自定义集成](https://developers.openai.com/api/docs/guides/custom-chatkit)、[actions](https://developers.openai.com/api/docs/guides/chatkit-actions)。这属于后续设计约束，不自动扩大当前 worker 的目录原型实现范围。

### PC + NAS 收敛

用户将设备范围限定为 PC 与 NAS，并提出 SolidFS 独立产品方向，产品边界见 [SolidFS Spec](solidfs-spec.md#独立产品边界2026-10-01最新设计方向)。NAS 首批按 Linux amd64/arm64、可用容器运行时与挂载能力声明支持，不以品牌名代替实机验收。

NAS 两个部署级别应分开：设备服务、挂载与 Agent 同容器访问，可减少挂载传播配置；要让 NAS 宿主或其他容器看到新挂载，则需专用 bind path、shared/rshared 及宿主传播支持。Docker bind mount 默认 rprivate，普通 volume 不足以自动传播新增挂载，Docker Desktop 也不支持此传播。FUSE 容器示例需要 `/dev/fuse` 和 `CAP_SYS_ADMIN`，是否还需安全配置调整由宿主决定，不默认使用整个容器 privileged。来源：[Docker run](https://docs.docker.com/engine/containers/run/)、[bind propagation](https://docs.docker.com/engine/storage/bind-mounts/#configure-bind-propagation)、[rclone Docker](https://rclone.org/install/#docker-installation)。

多架构可使用同一个镜像 tag，但实际是多个构建产物；第三方 Agent 的 Linux ARM64 运行能力仍需逐项确认。原生 SSH 安装可作为后续宿主集成路径，NAS 服务管理、FUSE 可用性和文件管理器可见性按实际设备验证。来源：[Docker 多架构构建](https://docs.docker.com/build/building/multi-platform/)、[rclone 下载](https://downloads.rclone.org/)。当前未安装 NAS 服务或执行 NAS 验收。

## 后台管理与 Agent 协议补充（2026-10-01）

产品名最新收敛为 XpodCli（展示名 Xpod CLI），替代此前 XpodFS 候选，因为客户端还包含设备及 Agent 会话管理；SolidFS 留作通用文件访问抽象。继续沿用本调研文件及 `solidfs-spec.md` 路径，不创建第二份事实记录。外部协议以下按查询日的滚动官方文档核对，尚未执行远程设备/第三方 Agent 集成。

- rclone RC 除 mount/list/unmount，还提供 `vfs/stats`、`vfs/queue`、`vfs/refresh`，可辅助设备服务显示待上传、错误和刷新状态。队列为空不等于某一提交已持久化成功，仍需具体操作的结果及版本验证。RC 控制面由设备内部适配成受限操作，不直接等同远程用户的设备 API。来源：[RC 文档](https://rclone.org/rc/)。
- ACP 当前 v1 定义 `session/new` 的绝对 cwd、prompt、流式 update、cancel；loadSession 和 session/resume 能力需初始化协商。ACP 的 `fs/read_text_file` / `fs/write_text_file` 不会让 native shell、Git、rg 或编译器自动看到 Pod，不能省略系统挂载。来源：[会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[prompt/取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[文件接口](https://agentclientprotocol.com/protocol/v1/file-system)、[提问](https://agentclientprotocol.com/protocol/v1/elicitation)。v2 尚为 [Draft](https://agentclientprotocol.com/announcements/acp-v2-draft)，不默认按草案实现。
- Codex app-server 提供 JSONL stdio 接口，线程 start/resume、turn start/interrupt、流式通知及权限/用户输入请求。设备服务可持有子进程和协议连接，再向聊天入口转发；当前官方标记远端 WebSocket 路线为 experimental，不默认采用该路线作为产品设备连接。来源：[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)。这不是任意既有 Codex TUI 会话可接管的证据。
- OpenCode 官方 server/SDK 提供 HTTP、会话和 SSE；已有 TUI 的服务端可接入，另起 `opencode serve` 则是新的 server，不会自动附着旧 TUI。查运行服务的版本/OpenAPI，不能直接把 dev 分支能力套到所有已安装版本。SSE 重连与历史补齐分别处理，本轮未建立通用事件游标重放保证。来源：[server](https://opencode.ai/docs/server/)、[SDK](https://opencode.ai/docs/sdk/)。
- pi 有 SDK 与长期 JSONL RPC；RPC 适合设备服务持有外部进程，提供 prompt/事件/存储会话等能力。当前官方仓库重定向至 earendil-works/pi，具体安装版本需另核对，不能直接替换本仓库已有依赖。取消当前操作与清队列是不同命令，用户交互及工具拦截依赖具体 RPC/extension 能力。来源：[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)、[extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)。

接口推断：同一个 AgentDriver，以 ACP 为通用实现候选，Codex/OpenCode/pi 原生协议为注册实现。能力声明分开表示 stored-session resume、live attach、history snapshot/cursor、permission、question、cancel-turn/clear-queue。聊天前端断线后运行继续、设备服务重启后恢复、连接已有 Agent，各自提供验收证据，不用一个 `resume=true` 掩盖差异。Claude 的官方接入细节和原先所提 dsh 尚未在本轮展开，不能宣称所有 Agent 已支持。

本仓库只读核对：`src/api/chatkit/service.ts` 已注入 RunExecutionBackend，适合复用聊天事件投影；`src/api/runs/RunExecutionBackend.ts` 的 start/AsyncIterable 适合新增设备分发实现，但未定义设备注册、mount 管理或完整会话生命周期。PiAgentRuntimeDriver 的 sandboxed worker 是本机进程，Pod URL 目前映射本机 CSS 路径，不代表能远程启动 PC/NAS。`src/edge/EdgeNodeAgent.ts` 的心跳/连通性与设备执行命令也不同。另 `src/runtime/driver/types.ts` 的 RuntimeDriver 管理 CSS/API/Gateway，不能因名称相似当成 AgentDriver 使用。

因此建议复用 ChatKit→Run 执行边界，在控制侧扩展设备路由 backend；Xpod CLI daemon 独立负责 mount/cwd/Agent 协议。对现有入口的代码发现不等于生产验收，用户选择 device/mount、断线恢复、挂载检查和远程交互仍待实现。客户端不反向依赖完整 Xpod 服务 runtime，目标设备字段及公共 schema 变更按 models 权威处理。

## 仅初筛的线索

- [Arg.ai filesystem](https://arg.ai/product/filesystem)：页面展示 API/CLI mount/MCP，以及 28ms median、p99 小于 200ms；本轮未核实测试环境或 Pod adapter，不作可比性能结论。
- [ANOLISA / SkillFS changelog](https://agentic-os.sh/changelog/)：有技能目录 FUSE 视图与读取 SKILL.md 时转换的描述；本轮只初筛，尚未核实源码、远端内容拉取和性能，不作候选底座承诺。

## DB as FS 补充调研（2026-09-30）

区分“文件系统用数据库存储”与“把已有数据库内容投影成目录”。前者通常要求采用项目自己的 filesystem schema，后者仍需约定路径、内容序列化、版本与修改映射；支持 SQL 不代表能直接挂载任意现有数据库。

| 项目 | 官方来源 | 已核实范围 / 对 Xpod 的限制 |
| --- | --- | --- |
| AgentFS | [SQLite 文件系统规范](https://github.com/tursodatabase/agentfs/blob/main/SPEC.md) | 文件元数据、目录项、分块正文及 overlay 状态有指定表结构；可复用 SDK 管理工作空间/本地 delta。普通 DB 文件模式要求相应内容已入库，不能只写元数据便自动从 Pod 拉正文 |
| libsqlfs | [官方仓库](https://github.com/guardianproject/libsqlfs) | SQLite 上的 POSIX-style 文件系统库，包含 FUSE 支持；不是现有 RDF/任意 SQL 表的即插即用挂载器。本轮未安装、核实维护版本或测试平台 |
| JuiceFS | [内部架构](https://juicefs.com/docs/community/internals/)、[metadata engine](https://juicefs.com/docs/community/databases_for_metadata/) | metadata 可使用 SQLite/PostgreSQL/Redis 等，正文经其客户端存入对象存储；使用自己的 metadata 和内容布局。接上已有 DB/S3 不等于原有 Pod 数据立即成为目录，属于存储底座采用/迁移评估 |
| postgresqlfs | [官方仓库](https://github.com/petere/postgresqlfs) | 将 PostgreSQL 数据库对象结构展示成目录/文件，定位于数据库浏览与操作；不是完整的 Agent 项目文件存储。本轮只核对 README |

Xpod 已同意的 MVP：客户端统一通过授权 HTTP 获取目录与正文，同机避免持久正文读缓存；服务端可复用现有 DB 查询目录元数据与索引，正文实际访问时读取。DB-backed FS 可用于客户端持久 delta/cache；原 Pod 内容权威不变，不能把整个 Pod 复制入 DB 才声称实现按需读取。本机直读是后续优化候选，不是当前 MVP 的第二条实现路径。

若投影 RDF 业务实体为 JSON/Turtle 等文件，应另行定义文件表现与写回契约；共享 schema 消费 models，业务 RDF 操作首选 drizzle-solid，不让挂载进程直接写底层 quad/SQL 表绕过授权、验证和索引。若直接修改 filesystem DB，还必须验证已挂载进程的内部/内核缓存失效、事务一致性及 schema 迁移，不默认“改表即实时更新挂载”。

待验证：DB-backed 存储接口是否可独立替换、能否在正文缺失时调用外部内容源、能否仅维护可重建元数据、同步/缓存失效及改表通知契约。本轮无依赖采用或性能复测。

## 后续追踪方式

每次复查在本文件更新最近核对日期，并追加变更记录；记录官方 release/commit、能力变化、证据链接及对 Xpod 的影响。优先追踪以下问题：

1. 是否新增可插拔 HTTP/Solid lower filesystem/backend，能否保持 Pod 权威。
2. 目录枚举是否只读取元数据；正文是否在 open/read 或 range-read 时才拉取。
3. 搜索能否走独立 FTS/VEC 接口，权限过滤、版本定位与本地 delta 是否完整。
4. Local / Cloud / guest / host 的适配范围是否改变；原生 shell 与程序内工具分别验收。
5. 条件创建、更新、删除与部分失败恢复是否有可验证契约。
6. 性能数据是否公开数据集大小、操作范围、冷热缓存、网络距离、并发、硬件和统计分位。

采用依赖前另核对发布版本、维护状态、平台与许可证；本文件当前不等于依赖选型或生产验收。新增项目沿用“来源 / 已核实 / 待验证 / 性能口径”的格式。

## 变更记录

| 日期 | 记录 | 验证范围 |
| --- | --- | --- |
| 2026-09-30 | 初次汇总 7 个候选、平台底座及 2 个初筛线索；记录 AgentFS 扩展点与三类毫秒指标 | 官方文档及部分源码，无安装、原型或性能复测 |
| 2026-09-30 | 补充 AgentFS 接口/挂载缓存边界及 DB as FS 路线，初筛 libsqlfs、JuiceFS、postgresqlfs | 官方规范/源码/README，无运行验证 |
| 2026-09-30 | 新增性能比较、原生挂载基准证据及本机直接 FS / SQLite 对照 | 两次独立进程、每项预热 + 七轮；无候选挂载或 Pod 验收 |
| 2026-09-30 | 记录已确认统一 HTTP MVP，补 AgentFS 测试入口、标准 suite 与 CI 的允许失败边界 | 官方测试指南/脚本/配置，无候选测试运行 |
| 2026-10-01 | 对比 AgentFS/rclone/Redis AFS 接口与存储边界，核对 writes/full 缓存策略；记录 AgentFS 原型和独立测试已续派 | 官方文档与源码；无候选挂载性能或生产验收结论 |
| 2026-10-01 | 补三平台安装前提、FSKit 限制、rclone RC；记录远程设备/挂载/Agent 会话管理的后续设计方向 | 官方安装/API 文档；设备控制未实现或验收 |
| 2026-10-01 | 将产品设备范围收敛 PC + NAS，区分容器内自用与宿主挂载传播；记录 SolidFS 独立发布方向 | Docker/rclone 官方资料与设计记录；无 NAS 实机验收 |
| 2026-10-01 | 采用 XpodFS 产品名，补 RC 管理状态、ACP/Codex/OpenCode/pi 会话接入与能力差异 | 官方协议/API 文档；无远程 Agent 集成验收 |
| 2026-10-01 | 用户将产品名收敛为 XpodCli，文件挂载作为能力模块，沿用现有记录与开发任务 | 设计口径更新；未拆仓、改命令入口或发布 |
