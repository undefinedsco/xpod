# Xpod CLI 目录预览发行记录

状态：2026-10-03。此页记录已公开的 preview.1 及其旧 RC223 证据，附件字节没有因后续兼容修复而更新。当前整合与未完成准入见 [选型记录](xpod-cli-engine-selection.md)，新原生服务见 [RC 验收](acceptance/rc-qlever.md)。

- [客户端公开附件](https://github.com/undefinedsco/xpod/releases/tag/xpodcli-0.1.0-preview.1)
- [客户端源码与全部 22 项 CI](https://github.com/undefinedsco/xpod/actions/runs/36951645641)：`1cb00bdf0a1ad2ff424e4745ecf97b2c9682af57`。
- [已接受的服务 RC223](https://github.com/undefinedsco/xpod/actions/runs/36946171908)：`d938792f3e2a6035f81429ab19dbab1d18f6c775`；镜像 `ghcr.io/undefinedsco/xpod@sha256:eddecb89f06c785ceeddb1d043bb5df0b4b9eb5dedd42d248b5a5cd456701d14`。

## 当前 preview.2 状态

本地 Mac 候选使用 kit4，native 完整测试为 56 passed / 0 failed / 2 ignored，官方归档与安装目录验证各 770 项通过。它尚未公开：真实 installed Mac 两套件实际失败（2 passed / 4 failed / 2 informational skips），卸载返回 1 与随后 closed 回执／内核 Absent 不一致，正在补充诊断及竞态回归。Linux 新 native／FUSE、合法 Gateway 身份及新 RC 仍未验收。旧 preview.1 的公开字节与绿色证据保持原来源，不能用于晋级这个新候选。

kit4 的诊断复验确认 lease/终态临时文件和 IPC 失联观察的竞态；最新最小修复已完成源码复审，kit5 官方导出与全部 21,280 文件核验通过，但尚无新编译／安装绿色结果。服务已整合最新 release/0.4.23，0.4.24 的原始完整集成通过（Lite 163/16、Full 63）；接着发布服务候选并通过现有 CI 在 SealOS 验证；服务运行时升级到外部 Bun 1.4.2 不改变客户端不内嵌 Bun 的边界，服务候选不会自动晋级此客户端预览。

## 选择与产品边界

本次选 AgentFS，因为可替换 lower filesystem、持久本地修改和显式条件提交更适合工作副本与冲突恢复。rclone 的上游 testsuite、缓存与平台管理更成熟，比较结果保留在 [选型记录](xpod-cli-engine-selection.md)、[调研来源](agent-filesystem-research.md) 和 [性能口径](agent-filesystem-performance.md)。没有声称 AgentFS 比原生 FS 或 rclone 更快。

Xpod 是总产品，CLI/App 是入口，CSS/API/AFS 是可选能力。此预览只交付认证与目录客户端，AgentFS 是内部引擎；统一模块启动、远程 Agent 控制仍是后续工作。Pod 管理自己的资源，外部 Git/worktree 项目最多在 Pod 保存 Link。目录重命名、symlink/hardlink 和透明 Git/worktree 托管不在本次支持范围。

客户端不内嵌 Bun、Node 或 JavaScriptCore，使用外部 Bun >=1.3.8；没有 Bun 时使用 Node >=22。启动器一次选择运行时，命令失败不会换运行时重放。远端正文通过 HTTP Range 按需读取；持久化干净正文缓存仍未交付。未提交修改与首次版本基线持久保存，显式 commit 才写回 Pod。

## 实际验收

| 层级 | 当前证据 |
| --- | --- |
| 客户端 CI | 22 jobs 成功；675 files / 6522 tests passed，42 files / 301 tests skipped，1 todo。skip 不算通过。 |
| 缓存回归 | 修复前 7 failures；修复后 16 passed，相关 auth/bridge 合计 29 passed / 1 skipped；源码与测试类型检查通过。 |
| 独立包装 | 49 tests passed；两目标逐项材料审查分别 250 / 260 artifacts；228 实际 bundle inputs、15 第三方 package records。 |
| Native | 同一已审 helper/source kit 的 macOS/Linux receipt 各 22 passed / 0 failed / 0 ignored。本次认证增量不改 native 字节，没有冒称重新运行 native 编译测试。 |
| macOS ARM64 | 干净安装 CLI，外部 Bun 1.3.8，真实系统 NFS，实际 RC Gateway/账号/Pod；7 checks、2 scenarios、0 failures，owned mount/proxy 清理通过。安装挂载夹具另外 17 passed / 2 informational skips。 |
| Linux ARM64 | 干净安装 CLI，Node 22 容器明确无 Bun，真实 FUSE 与同一实际 Pod；7 checks、2 scenarios、0 failures，owned mount/proxy/container 清理通过。 |
| 公开下载 | 两份附件均由不含认证头的 HTTPS GET 下载，逐字节 SHA-256 与已通过严格 public gate 的 promoted archive 一致；公开 checksum 与 acceptance 附件字节也一致。下载后的 macOS 安装通过 770 项严格 public 检查；Linux 在无网络、无 Bun 的 Node 22 容器逐项核对 260 份材料并实际执行 CLI/helper。 |

真实挂载的七项检查为：native rg 可见 dirty bytes、内核挂载、规范 Pod 枚举/读取、提交前远端仍无新文件、卸载重挂恢复、条件提交后远端内容正确、并发修改冲突同时保留本地与远端。验收不是仅测试 SDK，也不是拿 HTTP/auth 夹具冒充公共 Gateway。

长期挂载进程现在复用当前 client-credential token，并合并并发 exchange；仅采用服务声明的有效 lifetime，保留既有 60 秒 expiry skew。凭据、issuer、WebID 变化与 logout 不复用旧代；401 清失效缓存但不重放 mutation。真实重复 HEAD 从每次 discovery/token exchange 改为一次认证加各次实际资源请求，没有新增凭据库或依赖。

## 公开包与安装

| 目标 | 附件 | SHA-256 |
| --- | --- | --- |
| macOS ARM64 | `xpod-cli-0.1.0-preview.1-darwin-arm64-promoted.tar.gz`（69,291,257 bytes） | `0230b8c9acfed8781bb595d36e8b3b763fdf3369f310907e60433d860c89b99d` |
| Linux ARM64 | `xpod-cli-0.1.0-preview.1-linux-arm64-promoted.tar.gz`（69,889,675 bytes） | `7703c0860720fa686632e90cc6f08d78d51fa84e77353f969694e4c979e8ecac` |

下载同一 release 的 `SHA256SUMS`、`release-acceptance.json`、[公开下载与安装验收](https://github.com/undefinedsco/xpod/releases/download/xpodcli-0.1.0-preview.1/public-download-acceptance.json) 和对应架构附件，校验后解压，把 `install/bin` 加入 PATH。完整包约 66 MiB，包含原始通知、对应应用/native 源码与重建配方；混合组件保留各自许可，不能把整个分发产物标为 MIT。

macOS 使用系统 NFS，无需附加 FUSE 驱动。Linux 需要 glibc、OpenSSL 3、FUSE3、`/dev/fuse` 和挂载权限。物理 NAS 型号、x64 与 Windows 挂载尚未验收；Linux ARM64 容器通过不等于这些设备通过。

```sh
export PATH="$PWD/install/bin:$PATH"
xpodcli --version
xpodcli login --url https://your-xpod.example/
# POD_ROOT 使用 WebID Profile 公布的实际 storage，不能猜路径。
# macOS 示例；Linux 用 --backend fuse。
xpodcli agent-fs mount --pod-root "$POD_ROOT" --backend nfs --session-dir "$PWD/pod-session"
xpodcli agent-fs commit --pod-root "$POD_ROOT" --session-dir "$PWD/pod-session"
xpodcli agent-fs unmount --session-dir "$PWD/pod-session"
```

## 尚未完成与保留失败

当前实际网络验收使用直连 HTTPS。在一套本机 HTTP 代理环境中，Bun 1.3.8/1.3.12 流式 PUT 得到 Gateway 502；相同 production bridge 与 Pod 改为直连后两次 201、内容正确并清理 205。尚未确定组合路径里具体哪一跳断开，不能泛化为所有代理不支持，也没有修改客户端绕开代理或自动重试写入。失败 commit 保留 pending；不确定回执应先 status/recover 核对。

服务正式发布仍待完成。早期发布分支的本地完整回归在 Bun 1.3.8、1.3.12 都曾因 MatrixCollaboration 的 900 秒验收期限失败，其余 161 passed / 16 skipped，Full 未进入。首次逐请求诊断也曾只完成 52/60 backlog；这些失败保留，worker 进程正常退出不能替代产品验收。

后续 formatter 复用与 headers/body、单调计时、失败现场诊断已完成源码门禁。发布分支 `b2aa971c374f510d7894c338db02f0b582ae89f1` 所包含的最终 formatter/诊断源码，独立完整集成 exit 0，Lite 162 passed / 16 skipped、Full 61 passed；固定 Matrix 的完整集成样本为 325958ms，另一个单项样本为 55910ms。仍有约整轮启动后 300 秒 HTTP 500 的间歇失败，不能拿局部绿色结果替代后续源码的最终门禁。已接受的 formatter 修复现集成到客户端开发分支，供文档提交前串行回归；不重新打包已公开的客户端。

16 条 backlog 的隔离诊断另外保留日志格式化对照与 Intl 调用次数；这类短装置不构成真实 Gateway、完整 63 事件或 AgentFS/rclone 的性能结论。日志开销和原生查询改动的效果需要分别理解，不能把新 RC 的整体耗时差异全部归因于 QLever。

实际 Cloud 的固定 63 事件测试只完成 28/60 backlog，四条并发请求返回 HTTP 500；后段成功请求约 55–58 秒。CSS 子进程随后重启，同一 client ID/secret 重新交换 token 返回 invalid_client。[只读 RC 诊断](https://github.com/undefinedsco/xpod/actions/runs/36992315119) 确认服务仍为原已接受 digest，PostgreSQL Pod 却在 08:40:48Z 被替换、使用 EmptyDir；该 owned client 与 WebID 链接的数据库计数均为 0。替换原因未证明，此运行保留为失败现场，不能作为有效的查询性能对比。

RC 后续改为 PostgreSQL facts 加数据库侧原生 QLever，使用已验证历史来源的不可变 PG 镜像；尚未完成新候选部署或真实验收。后续依次验证精确镜像的语义/search、运行配置与实际镜像身份、真实 Gateway/账号/Pod/权限、同轮重启、固定 63 Matrix 和两目标挂载。RC223 的旧绿色证据不代表新配置通过，客户端预览也不代表服务端稳定发布。

公开后文档提交前再次运行开发分支完整集成：Lite 为 159 passed / 16 skipped / 2 failed，Full 未执行。失败分别是通知订阅 GET 1395ms 超过原有 1000ms 门槛，以及 SPARQL PUT 后查询达到原有 30 秒期限；当时多个 worktree 同时运行重型集成。保留失败并待串行复验，不以负载为由直接判为误报或放宽断言。当时仅有文档修改，公开客户端仍绑定已通过 22 项 CI 的 `1cb00bdf0`。

接入已接受的 formatter 修复后，开发分支于 10:57:08Z 再次完整回归，进程 exit 1：Lite 160 passed / 16 skipped / 1 failed，Full 未进入。原先两项失败已通过，此次线程删除用例达到原有 15 秒期限。随后接入发布分支 `d938792f3` 已接受的集成启动器参数透传，定向运行同一用例；用例 2922ms、进程 exit 0，1 passed / 21 因筛选 skipped。没有放宽期限或修改业务逻辑，隔离通过不替代提交前的完整回归，也未证明先前超时的根因。

最终串行回归 `original-20261002T115937Z-7245` 于 11:59:38Z–12:03:32Z 完成，真实进程 exit 0、signal null，前后源码快照一致：Lite 161 passed / 16 skipped，Full 62 passed，234754ms。先前通知、SPARQL 和线程删除失败均保留；这次完整通过支持提交已接受的 formatter/启动器移植与记录，不代表新 QLever RC 或新客户端发行已完成。原始日志 SHA256 为 `c239b75366037cad94bdcfc68101a52b4eaac429f5f92c43b162bc0a59363f92`。

忽略目录中的原始材料：开发 worktree `.test-data/agent-directory-workers/client-token-cache/`、`xpod-cli-package/{clean-1cb00bdf0-release,public-1cb00bdf0-release}/`；发布 worktree `live-directory-acceptance-token-cache-direct-fresh/`、`client-token-cache-integration-release*.log` 与 `opencode-go-b-matrix-diagnosis/`。公开包内的 manifest/promotion record 和 release 附件可独立核对来源与公开验收范围。


## 当前服务兼容整合（2026-10-03）

该历史兼容运行的服务基线为 `release/0.4.22` 的 `70a8bf94`，整合分支 `codex/agentfs-current-release`。一次未经观察器或预算覆盖的原始完整集成于 UTC 2026-10-02 23:52:57 自然退出 0：Lite 162 passed / 16 skipped，Full 62 passed，整体 145953 ms，Matrix 协作用例 52248 ms。24 个授权改动前后哈希一致；完整入口/SDK/生成产物前后快照未交付，独立语义审查与新 native RC 验收仍待完成。此次未复现不能证明历史 273 秒 PUT 500 已修复，也不改变公开客户端绑定的源码或附件字节。

当前整合基线已更新到 `ab583de48c3ecb86527269e11349c92bb26914d7`。UTC 2026-10-03 03:12:29–03:23:12 的原始完整集成实际退出 1：Lite 159 passed / 3 failed / 16 skipped，Full 未进入；完整入口、源码、SDK 和生成产物共 8272 个路径前后快照无变化。两项 ChatKit 达到原有 15 秒期限，Matrix 的 pagination-sync GET 返回 500，同一操作的 `events.select` 262107 ms 后报 TimeoutError。该 GET 与历史 273 秒 PUT 分开记录，尚未证明共同根因。

随后单次 ChatKit 隔离诊断 22 项通过，只支持诊断装置可用；Matrix 隔离诊断在准备账号 Pod 时因 6000 ms 写锁到期返回 500，实际 workload 未进入。两者均不能替代最终完整门禁。当前继续源码修复、失败边界记录和数据库侧 native RC 准入；实际新候选与客户端发行尚未验收发布。

## 2026-10-03 新源码的 scratch 安装验证

新增两个 Rust 修复与内部 Cargo 并行度 2 的配方已进入新锁定 source-kit，真实重建
37 项单元测试通过。导出、kit 校验、重建、包装及独立 `verify-install` 成功闭合；
第一次离线导出因锁定依赖缓存不足失败，记录保留，成功导出明确使用网络。
新 darwin-arm64 helper SHA256 为
`abda9c611c717b48b0622502f32d183f4f5991cce5f0b280fb7356d740d25d0f`，
新 scratch archive 为
`fc6b5c0451bdbf9794fb4e94f3ebc065a3f5b547f2a3da6be69f5ea1cff8c8ac`。
CLI 为 745,060 字节、helper 为 7,017,544 字节，完整 archive 为 69,374,226 字节；
包含可追踪源码与许可材料，没有复制 Bun/Node 可执行文件。

这是当前 dirty checkout 的 `install-verified` 本地产物，`publicReleaseReady` 为
false。虽然文件名仍含 preview.1，不得上传覆盖已公开的 preview.1 bytes；之后
晋级必须使用干净 exact source、新版本与全部新证据。debug stripping 工具缺
libLLVM 的 SIGABRT 警告保留；编译、测试与安装成功不代表裁剪成功。新 helper
随后新安装 CLI/helper 在 Mac 通过四项实际 NFS 功能测试：默认/显式挂载、
pending 重挂与 recovery、条件提交及递归删除、冲突保留和 dirty rg。两项 parser
测试也通过，另两项是 opt-in 反向 sentinel skip，并非功能平台跳过。producer
PID66343 实际 0/null、29707.246 ms；安装字节与24项覆盖源前后稳定，任务 mount
均已卸载。它使用 synthetic Pod fixture，不是当前实际 Gateway/身份验收。

大文件64/512/1024MiB的 sampled RSS、完整copy-up SHA、重挂与412保留均通过，
helper sampled peak最高21.125MiB。HTTP正文64KiB barrier后helper真实SIGKILL，
但同轮死NFS stat/卸载失败，恢复GC尚未完成；随后运维恢复释放等待，原Node实际退出1/null、19项夹具／安装材料前后稳定。负责人再次核验owned挂载后强制分离实际0/null并确认最新挂载表无该项，失败回执保留；这不是正常卸载或崩溃恢复通过。
本机曾只剩约250MB，用户授权清理后删除两处已结束Cargo target及三档已验
synthetic正文约2.8GB，保留安装候选、源码包、结果摘要和失败现场；已退休
test session正文需再生成。随后又清除原开发 worktree 两处已结束的 native
编译缓存约1.29GB，以及十三份与保留归档逐文件一致的旧 install 暂存约1.29GB。
本次清理累计删除的文件大小约5.38GB，实际可用空间受 APFS 和并发写入影响；
旧安装目录已退休，后续使用须从保留归档重新解包，不得把历史回执当作新验收。
清理计划、逐文件核对和删除后归档／日志哈希检查保存在
`.test-data/agent-directory-workers/root-current-release-acceptance/verified-data-cleanup-20261003/`。
真实Gateway/Pod及新源码Linux安装仍待验收，
旧preview.1附件保持原字节。

最新清理补充（2026-10-03）：旧 source-bound kit2 的 21,279 个源码对象及索引已逐字匹配保留的 native-source.tar.gz 后，删除其重复解压目录（allocated 481,214,464B）。完整源码归档、旧 helper、安装候选、构建日志及失败现场前后哈希保持一致；旧索引另外保存在 ignored 清理证据目录。再用该旧目录时必须从保留归档还原。该清理不是新 native 验收通过；系统可用空间仍随并发写入变化，不能把文件大小之和视为净释放量。

第二处旧 runtime-notices 源码解压目录也已完整匹配保留归档后退休，删除 allocated 481,189,888B，索引和归档 hash 复核通过。累计删除文件约 6.35GB，包含 allocated 缓存／重复目录和 logical 测试正文两种计量，不表示 APFS 净释放相同空间。当前构建、归档、验收日志与失败现场保留；两处退休源码均须从各自已校验归档还原。最终清理核对记录为上述目录内 `cleanup-verified-final.json`。

生命周期 kit2 的第二轮编译在 E0507 处实际失败后，其 21,280 个索引源码文件与索引完整保存为私密 `retired-kit2-native-source.tar.gz`（SHA `8a0cd31531d50d1497731c81d6d5bab1f55e7e19a3c41f3db4bd0c9cedae31da`），逐成员正文核验后退休展开目录。另删除 allocated 481,288,192B，同时新增 63,152,747B 的保留压缩归档；累计删除文件量约 6.83GB，仍不能当作净空间变化。日志、失败回执和当前 target 缓存保留；新源码须使用新的 kit3 绑定。

新的开发版本已改为 `0.1.0-preview.2`，manifest、入口和 workspace 版本一致。真实 standalone 包测试 50 项及包类型检查通过，尚未晋级、打包发布或覆盖已公开附件。先前 E0507 与卸载观察诊断修正后的 helper 仍需完整原生编译和两平台实际安装验收。

## 2026-10-04 状态更新（账号 B / deepseek-v4.1-flash）

- 新 kit5 helper 已完成真实远端两平台原生编译与安装验收：[run 37146470600](https://github.com/undefinedsco/xpod/actions/runs/37146470600) `darwin-arm64` 与 `linux-arm64` 串行成功，官方在线导出 → `--verify-only` → `--frozen` 重建完整 Rust 60（58 通过 / 2 既有 ignore / 0 filtered）→ 打包 → 解压 `install-verified`。
- helper darwin `2d4a7360…` / linux `88c299dd…`；archive darwin `6cdd9535…` / linux `1408ec6b…`；source-kit `84c5d586…`。
- 打包消费端 Node 22.21.1/npm 与 Bun 1.4.2 实际通过；固定 Bun 1.4.2 完整集成 exit 0/null、399.152s。
- 这仅证明 native build/install；公开 preview 附件、真实 OS 挂载（macOS NFS / Linux FUSE）、live Gateway 与正式发布仍未完成。历史附件与失败证据保持不变。
