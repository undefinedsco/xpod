# Xpod CLI 目录预览发行记录

记录日期：2026-10-02。客户端 `0.1.0-preview.1` 已公开；服务端 `0.4.21` 正式发布仍未完成。两者分别记录源码与验收身份，不用客户端发布代替服务生产发布。

- [客户端公开附件](https://github.com/undefinedsco/xpod/releases/tag/xpodcli-0.1.0-preview.1)
- [客户端源码与全部 22 项 CI](https://github.com/undefinedsco/xpod/actions/runs/36951645641)：`1cb00bdf0a1ad2ff424e4745ecf97b2c9682af57`。
- [已接受的服务 RC223](https://github.com/undefinedsco/xpod/actions/runs/36946171908)：`d938792f3e2a6035f81429ab19dbab1d18f6c775`；镜像 `ghcr.io/undefinedsco/xpod@sha256:eddecb89f06c785ceeddb1d043bb5df0b4b9eb5dedd42d248b5a5cd456701d14`。

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
