# Xpod CLI 挂载引擎选型与交付计划

状态：2026-10-01，完成源码、测试资产及真实挂载原型比较，本次选择 AgentFS 作为唯一产品开发主线；macOS 安装产物验收和 Linux ARM64 容器 FUSE 基础路径已通过；当前真实 Gateway、NAS 实机和公开发布仍未完成。此文档承接 `agent-filesystem-research.md`，记录当前决策和验收门槛，不替代历史研究。

## 目标与范围

完成 AgentFS 与 rclone 的对比，选择满足目录 MVP 的引擎，交付可安装的 Xpod CLI，并完成开发、独立测试、负责人验收和发布。设备范围 PC + NAS；远程 Agent 聊天与设备控制保留接口边界，本次先完成目录。

继续使用 `codex/virtual-folder-design` 和 `/Users/ganlu/develop/.worktrees/xpod-virtual-folder-design`，不操作其他 checkout。早期实现与测试由用户指定的 `opencode-go/deepseek-v4.1-flash` 执行；用户随后明确“好，你先自己来实现吧”，当前由负责人直接实现并验证，早期 worker 已结束。

## 不可折价的准入条件

1. Pod 是最终数据权威。Local / Cloud 使用相同授权 HTTP；不得直读服务底层目录或全量复制 Pod。
2. 真实 OS 挂载可被普通 shell、rg、Git 和编辑器使用；SDK 与内部自测不能代替挂载验收。
3. 元数据枚举不下载正文；Range/seek 返回正确字节。同机不持久缓存干净正文，远程只按需建立有界缓存；未提交修改独立持久保存。
4. 创建、覆盖、删除及替换目标使用版本条件。409/412、断网、无版本与认证失败不能导致无条件覆盖、远端删除或丢失 pending。
5. 外部客户端修改能在明确的重验证窗口内可见；不使用无限 TTL 的单写者假设。
6. 重启恢复未提交内容及原始版本基线；解析失败不得当成空状态，提交失败不得打印成功。
7. CLI 认证生命周期复用现有权威入口；native helper 不拥有第二套用户凭据库，也不依靠不刷新的静态 token 完成生产接入。
8. 客户端和 helper 独立于 Xpod 服务镜像；依赖、上游补丁、版本、许可和构建方式可追踪。

## 比较方法

先比较准入条件，再比较适配代码与上游补丁量、平台安装成本、运行资源及性能。候选不能通过准入条件时，其快慢不能成为胜出理由。

测试套件充分程度是用户明确要求的选型因素。按层级检查可复用 backend conformance、VFS/cache/writeback/恢复、真实 OS 挂载、平台 CI，以及上游补丁后的回归入口；区分默认执行、凭据门控、skip 与允许失败。不用测试数量、stars 或“CI 绿色”代替关键路径覆盖，也不将本地 fixture 的 61 passed / 2 skipped 表述为真实挂载已通过。最终决策必须说明新增 Pod 语义哪些受上游 suite 保护、哪些需要我们独立长期维护。

同一 HTTP 记录夹具、同一数据集及同一机器执行：目录枚举、stat、冷/热读取、随机偏移、首次修改、关闭/提交并确认远端版本、编辑器临时文件替换、外部修改、412、断网和重启恢复。记录操作延迟、HTTP 请求及字节、缓存和 dirty 磁盘量。容器 FUSE、macOS NFS 与真实 NAS 分别标注，不互相冒充。

rclone 先验证固定版本的真实 backend / VFS 扩展点，不将通用 WebDAV 的无条件写回误当 Pod 安全协议。AgentFS 使用固定 `0a014ebd4918615baff589ed17486e557e7c6a23`，核查 HTTP adapter 与 NFS/FUSE 实际交互。

## 早期执行责任（已结束）

以下为原型阶段分工，不能据此重启已结束的 worker。最新实现和验收见 [MVP 验收记录](agent-directory-mvp-acceptance.md)。

- AgentFS 实现：现有 worker 继续拥有 `tools/agentfs-pod/`、必要 `src/cli/agent-fs/` 与其实现测试。修复负责人审查清单后执行实际挂载。
- rclone 候选验证：独立实现 worker 拥有 `tools/rclone-pod/` 与其局部测试/构建夹具；暂不改共享 CLI、根依赖、配置或 AgentFS 代码。先证明可扩展性与条件写安全，再决定是否完整适配。
- 独立验收：测试 worker 拥有 `tests/agentfs-pod/`、`tests/xpod-cli-engines/` 及 `scripts/accept-agentfs-pod.*`、`scripts/accept-xpod-cli-engines.*`，不改产品代码；统一准入测试不能为某候选删除断言。
- 负责人：只读审查、文档和最终证据核对；选型后派 worker 收敛为一套挂载接口及一个默认实现。未选候选退出产品发布路径，保留研究证据，不维护两套默认产品。

各 worker 不独占代码库；不得回退他人修改、全局清理进程或并发运行含全局 pkill 的测试脚本。

## 固定版本源码审查结论

本轮 rclone 固定 v1.75.1 / `687d264b689b8c49a67e2e52a8a5e0caa01c04ce`；AgentFS 固定版本见上。综合依赖专家、两个原型源码审查与架构复核，本次选择 AgentFS 作为写目录主线。rclone 研究代码保留作比较证据，退出默认产品构建与发布路径，不继续维护两套产品。此选择依据状态模型、适配边界和升级成本，不声称稳定性或性能胜出。

| 需求 | AgentFS | rclone |
| --- | --- | --- |
| Pod HTTP adapter | `FileSystem/File` 可替换 lower，写入语义由 adapter 控制 | `Fs/Object` 可注册自定义 backend；Object 内存版本不足以保证跨重启编辑基线 |
| 同机干净正文不持久重复 | lower 可直接按需 HTTP；delta 提交清理仍需实现 | `writes` 对只读打开不落盘，但写后已干净正文仍会留缓存；需要明确清理策略 |
| 远端 lazy 范围缓存 | 需补缓存策略 | `full` sparse 范围缓存是明确优势 |
| dirty / 条件写恢复 | 可用 SQLite delta，但现有 prototype 仍需 durable journal 和条件提交 | 有 dirty cache/retry，但旧 ETag 基线持久化、删除失败恢复及冲突终态不能直接复用 |
| 外部修改 | 上游 FUSE 无限 TTL 需明确缓存政策补丁；macOS NFS 需验证 noac | 已有缓存时效控制，但 fingerprint 不等同不可变写入基线 |
| 编辑器替换 | adapter 可管理条件覆盖/删除及恢复日志；HTTP rename 仍非原子 | 公共 operations 层可能预删除既有目标，不能仅在 backend Move 中补安全 |
| 平台 / 管理 | Linux FUSE、macOS NFS；需客户端生命周期接口 | WinFsp 等平台及 RC 更成熟；RC 不等同设备或 Agent 管理 |

### rclone 必须验证的公共层风险

1. [WebDAV Object 与 updateSimple](https://github.com/rclone/rclone/blob/v1.75.1/backend/webdav/webdav.go)：Object 未持有 ETag 写基线，PUT 错误清理会调用无条件 DELETE；MOVE 使用 `Overwrite: T`。因此排除“现成 WebDAV + 少量配置”的安全写回路线，不靠 Pod 412 响应自动变安全。
2. [vfscache item](https://github.com/rclone/rclone/blob/v1.75.1/vfs/vfscache/item.go)：持久 Info 记录 fingerprint/ranges/dirty，dirty reload 会重新获取远端 Object。推断：仅给内存 Object 加 ETag，可能将旧内容与重启后新 ETag 结合而绕过冲突；独立实验必须验证并固定原始基线。
3. [File.Remove / rename](https://github.com/rclone/rclone/blob/v1.75.1/vfs/file.go) 与 [operations.Move](https://github.com/rclone/rclone/blob/v1.75.1/fs/operations/operations.go)：删除前先清缓存，替换 Move 前可能先删除目标。必须注入失败与退出验证恢复；不能只测正常 mv。
4. [writeback](https://github.com/rclone/rclone/blob/v1.75.1/vfs/vfscache/writeback/writeback.go)：上传错误退避重试，不提供本项目明确的 412 冲突处理终态。[RC](https://rclone.org/rc/) 可复用队列与挂载状态，但不提供原始版本基线和提交凭证。

两者都不能默认大文件改一行只传一行：AgentFS 首次 copy-up 与 rclone 关闭 dirty 文件补齐范围后全对象上传均需实测。性能没有准入优先权。

### 测试套件充分程度（用户追加因素）

固定版本源码/CI 审查表明，rclone 在可复用的测试资产上明确领先。此表记录已存在的入口，不表示负责人运行了所有上游测试。

| 层级 | AgentFS | rclone | 选型影响 |
| --- | --- | --- | --- |
| backend 通用契约 | 主要 SDK FileSystem/overlay 测试；未确认同等的任意 backend conformance 入口 | `fstests.Run` 覆盖 List/Put/Update/Remove/Range/Move 等 | rclone 接 Pod backend 后可复用，需实际授权测试 remote |
| VFS 与缓存组合 | HostFS + SQLite delta 的 inode/copy-up/whiteout/rename/rebuild 测试 | `vfstest.RunTests` 可切进程内 VFS 与 OS mount，4 种缓存模式、7 组配置 | rclone 升级验证面更系统 |
| dirty、缓存与恢复 | overlay 恢复及 whiteout；没有 HTTP 写回条件基线 | reload、stale、quota、writeback retry/cancel/rename 等 | rclone 覆盖更广，仍缺本项目不可变 ETag / 真崩溃冲突证据 |
| OS suite | Linux shell mount，另有 pjdfstest / xfstests 指南 | 共用文件断言覆盖 FUSE / NFS 挂载入口 | 指南和测试入口不能冒充当前平台执行通过 |
| CI 门禁 | Rust 3 OS × 2 项目；shell mount 仅 Linux，all.sh 的 10 个入口中 4 个带 `|| true` | 7 个 job 配置、5 个 quicktest、3 个 racequicktest；部分架构只构建 | 不将跨平台构建等价跨平台挂载测试 |
| skip / 外部配置 | all.sh 部分允许失败；Pod 后端不在上游 CI | quicktest 用 `/notfound` config，多数真实 remote suite skip；macOS cmount 有 SkipUnreliable，NFS 是独立入口 | CI 绿色不证明我们的真实 Pod 兼容 |

来源：[AgentFS Rust CI](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/.github/workflows/rust.yml)、[all.sh](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/cli/tests/all.sh)、[标准 suite 指南](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/TESTING.md)、[rclone backend suite](https://github.com/rclone/rclone/blob/v1.75.1/fstest/fstests/fstests.go)、[VFS 组合](https://github.com/rclone/rclone/blob/v1.75.1/vfs/vfstest/fs.go)、[真实 mount 子进程](https://github.com/rclone/rclone/blob/v1.75.1/vfs/vfstest/submount.go)、[CI](https://github.com/rclone/rclone/blob/v1.75.1/.github/workflows/build.yml)、[NFS suite](https://github.com/rclone/rclone/blob/v1.75.1/cmd/nfsmount/nfsmount_test.go)。

若两个候选都通过安全准入，rclone 的成熟测试资产应成为优先选择它的重要理由。若修 VFS/operations，则升级时同时重跑 backend conformance、VFS/cache/writeback/operations、已支持平台 OS mount，以及本项目并发/断网/崩溃/认证 suite。AgentFS 修改 FUSE / delta 同样须跑 SDK/CLI/OS 与 Pod 专属 suite。不能只为选定方案补 happy path 单元测试。

### 推翻当前推荐的证据

rclone 原型若以小而可维护的扩展通过全部准入门槛，并在已验证平台、安装或性能上占优，则选 rclone。AgentFS 若需广泛维护挂载内核，或无法可靠恢复 dirty / 感知远端变化，则退出主线。不因已有 Rust 原型保留沉没成本。

## 本次决定及实际原型反证

本次明确选择 AgentFS，置信度中等；选型完成不等于实现通过。rclone 在上游 testsuite、缓存和平台管理上更成熟，这一优势已重权计入。决定性差别是当前产品要求有版本基线的持久工作副本、显式提交和统一的挂载/搜索未提交视图：AgentFS 的可替换 lower + SQLite delta / OverlayFS 与此状态模型直接契合；rclone 的默认对象 VFS 自动写回模型则需要介入 dirty 恢复、Remove、writeback、版本传递和提交后缓存清理等公共层。

实际 rclone Pod 原型已在 Linux Docker FUSE 上运行普通 ls/cat/mv/rm，证明接口可扩展。其 Copy-only 实现确实避开 Move 分支的目标预删除，不能继续用已解决的风险淘汰它。未满足的独立审查证据为：创建 412 后 HEAD 最新 ETag 再覆盖；Update 缺基线时提交前抓新版本；PUT 后 HEAD 绑定他人新版本；Copy 重新获取目的地基线；VFS dirty 重启无强版本基线且 Remove 先清缓存。其局部测试中两项反而要求这种危险覆盖成功，故原型报告的“全部条件请求已证明安全”不能采信。上游完整 suite 不覆盖本项目新增语义。

早期 AgentFS 原型同样未准入（下述缺陷已由当前单一 native journal 实现修复；验收范围及剩余限制见验收记录）：真实 macOS NFS 的基础文件操作成立，但 native 当前写穿 Pod，failed-write pending 不是未提交 delta；native/TS 有两个状态入口，commit 二次 base64 解码可损坏正文。必须修复，不能因已选型删除失败断言或只发布只读子集。

### 唯一主线的实现收敛

1. `PodTransport` 仅提供授权元数据、范围读及条件 mutation，读取版本与正文必须对应，禁止冲突后刷新写基线。
2. `SessionOverlay` 复用 AgentFS 的持久 delta / 文件系统抽象；状态绑定 Pod 与身份，由一个 native session owner 管理，mount/status/commit/rg 消费同一权威。
3. `VersionJournal` 保存不可变首次基线、内容 revision、blob 引用及 rename 两端关系和提交阶段；不再另存 TS JSON pending 或重复 base64 编码正文。
4. `CommitCoordinator` 冻结 revision，409/412 和不确定响应保留数据；仅清理已确认且未被并发编辑替换的 revision。
5. `MountAdapter` 复用 NFS/FUSE，处理生命周期和缓存重验证。dirty/new/delete/rename 在本地持久后立即进入统一视图，只有 commit 写 Pod。

现成 OverlayFS 的整文件 pread copy-up 与先建可见 delta 再写正文并不自动满足有界内存/崩溃恢复。必须有分块 copy-up、staging/完成标记与恢复方案，保持固定上游最小补丁可追踪；提交后按 revision 释放 clean delta，不清整个库或其他 dirty。FUSE 无限 TTL 也必须修正并跑对应回归。

下一发布准入场景为同一真实 session：edit → Pod 未变 → kill/restart → 外部改写 → commit 冲突 → dirty 保留 → rg 可见，并验证大文件内存上界、metadata/Range/rename/delete/权限、CLI 会话桥和已承诺平台。不得用引擎矩阵中 3/10 个已运行项目生成总体 PASS。

### 发布前上游授权与来源

rclone 为 MIT；AgentFS SDK manifest / README 声明 MIT，但固定树缺 README 所链接的根 LICENSE.md。发布 helper 前须核实可分发授权文本及第三方 notices，不能自行猜测或补写权利人许可。原型的 ignored 上游源码路径不构成可复现发布依赖；最终产物需可追踪版本及补丁。[AgentFS 固定 README](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/README.md)、[SDK manifest](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/sdk/rust/Cargo.toml)。

## 发布门槛

先形成明确选择与已验收平台清单，再准备独立客户端安装产物和 SHA-256 manifest；安装后以产物执行验收。Xpod 服务端新增接口同样需完整回归及真实 Gateway 认证/Pod 读写证据。真实 Gateway 或目标平台未验证不能标成通过。

公开发布目标尚在向用户确认；准备阶段不修改 npm latest，不部署生产。服务发布沿用 `docs/RELEASE.md` 的 RC 与 exact commit/digest 提升流程；独立 CLI 预览版的包名、渠道及版本另在确认后记录。本目标包含发布，产物准备不等于发布完成。
