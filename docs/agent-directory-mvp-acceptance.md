# Xpod CLI 目录 MVP 实现与验收记录

最新分发方向：用户明确“不内嵌 Bun”，当前客户端使用外部运行时。后文旧内嵌候选和 Bun/JSC 记录是历史证据；本次变更和验收状态见末尾“当前客户端分发变更”。

日期：2026-10-01。分支：`codex/virtual-folder-design`，工作区：`/Users/ganlu/develop/.worktrees/xpod-virtual-folder-design`。用户授权负责人直接实现；原型 worker 已结束。AgentFS 是唯一产品主线，rclone 保留研究证据。选型理由见 [引擎选型](xpod-cli-engine-selection.md)，历史调查见 [技术研究](agent-filesystem-research.md)。

## 声明发行材料增量

五项固定发行声明及所选标准 MIT 条款已进入安装包，来源和限制见 [许可证据](agentfs-license-evidence.md)。公开门槛从“根目录必须有 LICENSE”改为固定 engine commit 的索引与全部对象 hash 绑定；旧 preview 可读取，但缺材料不能通过 public gate。Cargo 声明的包名／版本必须匹配原文，SDK／registry 不能冒充 README。原始 native notices 保持不变，未将声明核验扩大为整个 helper／Bun 的许可完成结论。

本次独立 CLI 包回归为15 passed / 0 failed、106 assertions；源码、测试和包类型检查通过。macOS ARM64 安装归档在中立 cwd 解包执行 version/help/status/helper，通过新增 engine 材料校验；Linux ARM64 跨编译通过材料／哈希校验，仍标为 unverified，不声称本轮重复了目标平台挂载验收。提交前完整集成为 lite 160 passed / 15 skipped、full 60 passed / 0 skipped，exit 0，owned Docker 栈已清理；日志 `native-declaration-integration-submit.log` 另存忽略目录。`--public` 确实退出1：整包/Bun 等 pending、local-preview 和非 full-verified 条件仍阻止发布。

这些包装验证沿用前一安装候选的 native helper，未修改挂载运行代码。最终 clean commit 的重打包结果独立记录，不把开发中的 dirty preview 冒称正式发行。公共 Gateway 登录／部署候选／实际 Pod 验收和发布渠道仍未就绪。

## 当前实现

- 服务端 `src/http/agent-directory/`：已授权 Pod 上的目录元数据、精确 glob、内容搜索和范围读取。Local/Cloud 配置注册同一入口；外部项目的 Git/worktree 不写进 Pod。
- 客户端 `src/cli/agent-fs/`、`src/cli/commands/agent-fs.ts`：统一 CLI 认证、单 Pod loopback 代理、挂载、状态、显式提交、卸载和会话级 rg wrapper。
- Native `tools/agentfs-pod/`：AgentFS FileSystem/File adapter；macOS NFS、Linux FUSE；一个持久 session manifest 和 dirty blobs，由 native 独占写入。跨进程锁内重载，提交期间串行化修改。
- 只读枚举不拉正文；干净文件按 HTTP 范围读取，不保留持久 clean body 副本。首次修改分块 copy-up，之后本地偏移读写；上传流式处理。
- 新增、修改、删除和文件替换立即进入本地视图，commit 前 Pod 不变。首次 ETag/不存在基线不可变，重启恢复，冲突保留 dirty，不抓新版本强行覆盖。
- 提交前落盘 in-flight 标记，确认响应后落盘 receipt，再释放 blob。文件 rename 先写目标再删除源；部分失败保留阶段，避免删除唯一内容。
- rg 的支持子集在 clean session 走 HTTP；有 dirty 时回到真实挂载上的 native rg，保证搜索与未提交视图一致。正则等不支持参数也回退，不把 VEC 当精确 grep。
- helper 与 CLI 使用 canonical Pod + WebID 绑定 journal；loopback 随机端口不是会话身份。代理只重写自身 exact origin 的 Pod 路径，拒绝其他端口/Pod。native 禁止自动重定向，代理不放行未处理的 3xx；断流只终止当前请求，代理继续服务。
- 卸载成功后通过随机 capability 关闭该代理，不对磁盘旧 PID 发信号。默认挂载/卸载使用同一 session/mnt 路径。
- `packages/xpod-cli/` 输出独立 `xpodcli` 和 native helper、SHA-256 manifest、notices、tar.gz，不携带 Xpod 服务镜像。

## 验证证据

所有日志位于 ignored `.test-data/agent-directory-workers/`；以下区分已运行和未运行，不将 skip 当作通过。

### 真实候选协议增量：存储版本与互斥

新增 `AgentDirectoryProtocol.integration.test.ts` 启动生产 CSS/API/Gateway，建立隔离账号、Pod、client credentials 和 DPoP session，使用默认 ACP 的 `.acr` 限定私有目录。Local 与 Cloud 共10项通过，覆盖匿名/另一账号拒绝、Range/list/search、条件创建与安全清理、快速外部更新后的旧 If-Match 412、目录 membership 的版本变化，以及协作者按实际 ACP 授权完成 SPARQL UPDATE。Local 的 QLever 进程为测试夹具，不能把此项描述成完整 native RDF 验收或当前公共 Gateway 验收。

这些测试先复现了旧秒级 ETag 导致快速更新仍被旧条件覆盖、目录成员变化版本不变，以及 PUT 缺少自身回执。当前服务改用现有服务器 metadata 中的独立 revision；PUT 仅返回本次持久化回执，RDF 转换后不误发 validator。全部祖先按固定顺序写锁、取得锁后的 metadata cache 刷新，以及 GET 至正文结束的祖先读锁，使普通文件、递归祖先创建和 sidecar SPARQL 使用同一个互斥边界。授权读取在 mutation 锁外完成，避免非重入锁自锁。详见 [版本与锁](agent-directory-storage-versions.md)。

真实 Redis 的4项回归通过：另一实例初始化/关闭不清活动锁，旧 owner 不删除替换 owner，读写获取/释放的相同 owner 重放幂等。重放在 client 边界注入且每次 EVAL 都实际执行，不作为完整 TCP 故障或 Redis failover 证明。Local 长写、迟到获取、预锁旧 cache 与 GET 流并发都有独立 barrier/虚拟时钟回归。专项共102 passed（78项存储/HTTP加24项 Mix/DI），源码/测试类型与组件生成通过。

再次完整执行 `bun run test:integration`：lite 为160 passed / 15 skipped，full 为60 passed / 0 skipped，exit 0；`candidate-directory-integration-third.log` 保存结果，任务拥有的 Docker 容器、卷和网络已清理。lite 的 opt-in Cloud/Redis 跳过由 full 的显式隔离端点实际补测，不把跳过计入通过。专项日志为 `candidate-directory-focused-sixth.log` 和 `candidate-directory-di-sixth.log`，反例为 `candidate-directory-protocol-regression-before.log`。

本地全仓单元运行 `candidate-directory-unit-full.log` 为6,492 passed / 296 skipped / 1 todo，并有1项生成资源前置条件失败：此 worktree 尚未构建 UI 的共享 helper chunk。按现有 CI 顺序执行 `bun run build:ui` 后，该文件3项全部通过（`candidate-directory-static-retest.log`）；没有改动测试断言或页面源码。生成资源已保留于任务测试目录，不纳入本次存储提交；这不是一次从头全绿的本地单元日志，完整 clean-build 单元结果以新提交 CI 为准。

服务端修改尚不改变已验收安装包的源提交身份；旧安装包仍绑定 `6df51382c`。新存储 revision 不自动迁移旧资源，旧资源缺少 revision 时读取可用但无安全强 ETag，目录客户端须保留未提交修改并拒绝不安全写回。同一 identifier root 的写入保守串行，还需等待正在流式读取的 GET。Cloud 无 fencing 时不自动过期锁，崩溃可能留下阻塞锁；升级必须停止全部旧写入者，禁止混用旧新 locker 滚动发布。公开 Gateway 部署、实际用户 Pod 与发行材料门槛仍未完成。

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| Native session/恢复回归 | 最终 22 passed；此前21项连续20轮共420次通过 | `nfs-cookie-native-tests.log`；新增删掉前页 cookie 后继续分页的确定性回归 |
| 目录/CLI 专项 | 166 passed，5 skipped | `nfs-cookie-focused-final.log`；skip 包含真实挂载 opt-in，实际挂载另有独立证据 |
| 代理真实 native/HTTP 桥 | 11 passed（含断流、真实 native 桥和 lost receipt recovery） | `clean-macos-acceptance.log`：真实 OS 挂载通过 loopback proxy 读写/commit/recover，CLI auth 使用 fixture，不是真实账号 |
| macOS 安装产物 | archive 解包 hash/version/help/status 与 helper 实际启动通过 | `clean-macos-package.log`，从中立 cwd 执行真实编译 CLI |
| macOS NFS 重启/冲突/rg | 2 passed，1 gating skip；与代理11项合计13 passed / 1 skip | `clean-macos-acceptance.log`：安装包内 CLI/helper；新增 rapid remount 的 daemon 数量检查、180文件分页递归删除 |
| Linux ARM64 FUSE 与安装 CLI | 真实挂载、完整 CLI 生命周期和 dirty rg 已通过 | `linux-dirty-rg-acceptance-final.log`、`agentfs-linux-report.json` 的 installedCli=true / dirtyRg=true；基础读取/Range/编辑/替换、重挂、commit/recover、412、native rg、proxy 清理和 daemon 数量检查；报告绑定实际 CLI/helper hashes |
| 完整集成 | 155 passed，6 skipped；四种服务运行配置 46 passed | 最终 NFS 修复后再次运行 `nfs-cookie-integration-final.log`，exit 0，隔离 Docker 栈已清理 |
| TS 类型/组件定义 | build:ts、typecheck:test、build:components、独立包类型检查已通过 | `lifecycle-ts-final.log`、`nfs-cookie-test-types.log`、`lifecycle-components-final.log`、`nfs-cookie-package-types.log` |
| Rust 静态检查 | clippy exit 0，11 warnings | `nfs-cookie-clippy-final.log`；使用匹配 nightly 编译器和 clippy，独立 target。未将 warnings 描述为零告警 |
| 包装回归 | 10 passed | `nfs-cookie-package-tests.log`：新增 runtime 缺失、错误 OS/架构及显式 helper 不回退的回归 |

原始反例日志保留：`session-regression-before.log`、`proxy-lifecycle-before.log`、`proxy-transport-before.log`、`proxy-stream-before.log`。测试先复现再修复；最后一个含断流未处理异常/超时，修复后专项通过。

## 已知限制和发布门槛

1. 这是未公开发布的可安装候选，代码已提交并从 clean exact commit 构建。macOS manifest 为 `install-verified`，Linux 跨编译 manifest 保守保留 `unverified`，实际目标平台验收另存证据；`publicReleaseReady=false`。已附四/五份可核实原文；AgentFS 自身完整版权/许可通知、其余第三方 notices、Bun/TS runtime notices 与发布渠道仍未完成，不执行 npm latest 或生产发布。
2. 当前公共 Gateway `https://id.undefineds.co/` 可达，但已有 CLI OAuth 刷新失败，尚无它运行本次目录候选接口的验收证据。没有本任务真实用户 Pod 写入证据；Docker/fixture 不等同当前 Gateway。真实认证、目录权限与实际 Pod mutation 需在已部署候选上独立验收。
3. macOS ARM64 和 Linux ARM64 容器已验证对应路径及安装 CLI 生命周期；NAS 实机、x64、Windows AgentFS 挂载仍未验收。Linux dirty rg 的 native fallback 已在真实 FUSE 挂载上验证；服务安装 CI 的 Windows 通过不等于 Windows AgentFS 挂载通过。Linux release helper约8.1MiB，依赖 glibc/OpenSSL3；纯 Node Debian slim 缺 libssl3 时不能启动，安装验证已实际捕获该错误，补系统依赖后验证通过。
4. 未知写回结果会保留 journal/blob 并拒绝盲重试；现已提供 `agent-fs recover`，仅读取远端，区分 confirmed/retryable/conflicts/errors。内容、媒体类型、LDP 类型与 strong ETag 对应才确认；首次基线仍在才允许按原条件重试。冲突、弱/畸形 ETag、读取中断及缺 blob 保留数据和 in-flight。不会自动合并冲突，不会刷新基线。
5. HTTP rename 不是远端原子操作；目录 rename、symlink/hardlink 不支持。commit 在整个 HTTP 请求期间持锁，可能等待每请求最多 60 秒；不是高并发提交设计。
6. 远程有界 clean cache 尚未实现；旧 dirty revision 的 blob 到 commit GC 才回收。未验证超大文件内存峰值/崩溃全矩阵/并发远端 rename，也没有“99% 原生性能”的证据。
7. 上游 Linux FUSE 补丁只有三处缓存设置；其性能代价仍需代表性负载评估。研究性能文档不能替代本产品最终实现 benchmark。
8. 一次 macOS 单文件目录删除出现 ENOTEMPTY，后续单独诊断与10轮重复通过，尚无该次失败的明确根因。另发现并确定性复现了 NFS 分页 cookie 删除后错误 EOF 的独立问题，已补丁修复并通过180文件挂载删除；不能将此当作原单文件偶发失败已解释的证据。

## 安装包 dirty rg 目标平台增量

安装包源码提交 `6df51382c026ff92410c0a2137544e2e91b2a77a` 的 [CI](https://github.com/undefinedsco/xpod/actions/runs/36824285492) 全部22项通过：主单元6,471 passed / 283 skipped / 1 todo，Bun32 passed，独立客户端12 passed，浏览器12 passed，以及服务集成和18个跨系统服务安装任务。跳过和 todo 不计入通过；服务安装矩阵不证明 AgentFS 在所有系统上均可挂载。

`scripts/accept-agentfs-pod.linux.mjs` 使用独立记录请求的 HTTP/auth fixture、真实 Linux ARM64 FUSE 以及上述安装包，新增三次 dirty rg 比较：未提交新增、卸载重挂恢复、以及存在412冲突时的覆盖/删除/文件重命名。wrapper 使用安装 CLI 生成，执行记录工具仅转交到真实 `/usr/bin/rg`（本次13.0.0），输出与直接 native rg 的 stdout/stderr 比较；三个调用均被记录，HTTP search 次数为0，明确拒绝用远端旧内容代表本地未提交视图。rg 只安装于本次临时测试容器，没有加入发行包或修改宿主机。

最终 `linux-dirty-rg-acceptance-final.log` 和 `agentfs-linux-report.json` 为 pass / installedCli=true / dirtyRg=true。实际执行 helper SHA-256 为 `12b827b932a4fbd600dec891d7c9c5000cdd1e9bc9fe51bba481d0d1852a071e`，CLI 为 `a95b80e0db6c2a2e501352315984f6abe56b82a9718f9f0043d53d230ee1b0cf`，执行前均与 manifest 核对。挂载/commit/recover/冲突与 owned-process 清理仍执行，测试容器和网络已清理。此次改动只扩大测试覆盖，未改动安装包 runtime；仍不是真实公共 Gateway、NAS 实机或公开发行的验收。

`linux-artifact-drift.log` 还验证了 CLI hash 不符的反例：在创建挂载之前退出1，报告 fail，不作为环境 unavailable 跳过。脚本语法、源码/测试类型检查及提交前完整集成通过；`linux-dirty-rg-integration-final.log` 为155 passed / 6 skipped，加46项运行配置通过，隔离栈已清理。

macOS 原单文件 ENOTEMPTY 的只读审计确认：日志仅保存最终 rmdir 失败及下一测试的 rg ENOENT，没有失败当刻的 NFS READDIR/REMOVE/RMDIR 顺序、目录 entries 或 journal。两例复用会话，后一例可能受到前例残余状态影响。后续诊断和10轮重复通过不能补回这些缺失证据，因此继续保留未定位限制；若再次复现，需先保存请求顺序和 NotEmpty 当刻的目录视图，不能直接套用独立 cookie 回归的结论。

## 已部署 Gateway 的独立 HTTP 验收入口

`scripts/accept-live-agent-directory.ts` 连接指定的实际 Gateway，复用当前 CLI 登录，不启动服务、创建账号或改写凭据。必须显式提供 canonical Pod storage URL；不从 WebID 推导 Pod，不接受带 userinfo/query/fragment 的目标。当前登录的 Gateway 必须与参数一致，不将已有凭据用于另一部署。

```sh
# 只读 preflight：OIDC discovery、CLI 登录、Pod HEAD、目录 API
bun scripts/accept-live-agent-directory.ts --gateway https://gateway.example/ --pod-root https://pod.example/alice/
# 明确启动写入验收；仅操作随机 xpod-cli-acceptance-UUID/ 子目录
bun scripts/accept-live-agent-directory.ts --gateway https://gateway.example/ --pod-root https://pod.example/alice/ --write
```

写入模式检查条件创建/同名冲突、准确 Range 正文及版本、完整目录枚举和 literal search、另一次写入后的旧版本 PUT/DELETE 冲突及新正文保留。清理仅对已确认回执使用 If-Match，删除后 HEAD 确认404；目录使用空枚举之前的版本，避免将旧的空目录观察绑定到后来新增子项的版本。未知写入结果、并发变化、缺 strong ETag 或非空目录保留，并在报告中列出路径及失败状态，不无条件删除或盲重试。报告默认保存在 `.test-data/agent-directory-workers/live-directory/`，记录阶段、固定错误码、目标 URL、遗留路径和 checker 的源码 hash/Git SHA/dirty 状态，不包含 token、正文或服务器错误响应；缺 Git 的源码归档标记身份未知，不伪称 clean commit。

`phase=preflight` 只证明只读前置；`phase=pod-http-contract` 才执行上述 Pod HTTP 场景。两种模式都明确 `mount=not-run`，不能据此声明实际账号的 OS 挂载已通过。9项 injected-transport 回归只证明该验收入口的保护与判定行为，不是已部署 Gateway 证据。临时取消删除确认、将目录 HEAD 移到枚举之后的反例变体在当时8项测试中恰好失败2项；恢复保护后全部通过。后续新增丢失 conflict 回执的回归，确保每次 mutation 发送之前统一撤回旧的清理依据。日志为 `live-directory-cleanup-counterexamples.log` / `live-directory-utility-tests-final.log`。本轮只读检查 Gateway 的 discovery 为200且具备 issuer/token endpoint，OPTIONS 为204；OPTIONS 成功不证明本次目录接口已部署。现有 CLI 登录当前仍不可用，没有实际 Pod mutation；需要可用登录、canonical Pod URL 与已部署候选才能运行后续验收。

## 最小用法

安装预览解包目录中的 `bin/xpodcli` 和 `helper/agentfs-pod` 保持相邻布局。登录使用 CLI 现有 auth/login 能力，随后：

```sh
xpodcli agent-fs mount --pod-root https://pod.example/alice/ --session-dir ~/.xpod/alice
# 默认目录 ~/.xpod/alice/mnt，第三方 Agent 可把它当普通目录使用
xpodcli agent-fs status --session-dir ~/.xpod/alice --json
xpodcli agent-fs commit --pod-root https://pod.example/alice/ --session-dir ~/.xpod/alice
xpodcli agent-fs recover --pod-root https://pod.example/alice/ --session-dir ~/.xpod/alice --json
xpodcli agent-fs unmount --session-dir ~/.xpod/alice
```

自定义 mountpoint 时卸载也传同一 `--mountpoint`。会话中启用 rg wrapper 使用 `agent-fs install/shell --root 挂载目录=PodURL --session-dir 同一会话目录`。不要在当前未部署目录接口的公共 Gateway 上将这些例子视为已验收能力。

## 本地候选产物

候选 `0.1.0-preview.1` 位于 `.test-data/agent-directory-workers/xpod-cli-package/release-candidate-f0452849/<target>/`，sourceSHA 为代码提交 `f04528496127ded20fb74cf36e369ce92da77f50`，source.dirty=false、dirtyTreeHash=null。这份文档的后续证据编辑不属于该构建源提交。

macOS ARM64 归档 SHA-256 为 `90dd2ee25e06a8b4b505d8915766f978775ba0ac5ffdc77e2fb5d33f49ef2a96`；CLI约57.8MiB、helper约6.4MiB。Linux ARM64 归档 SHA-256 为 `9b30c4146199898407cd6b3d20d94a2925e0076ec2f29c944e0416074a1d81f0`；CLI约92.6MiB、release helper约8.1MiB。两者均未公开发布，publicReleaseReady=false。此前 recovery/lifecycle/nfs-cookie-final 的 dirty 候选留作历史反例与回归证据。

## 安装生命周期增量

Linux 的真实安装 CLI 测试先复现了 Bun1.3.8 对一次断开写入连接发出两次 PUT，导致第二次消耗后的正文重试。代理现对有 body 的请求禁用连接复用并声明 Connection: close；`linux-proxy-replay-before.log` 失败，修复后与最终 Linux 验收均记录 lost.txt 只有一次 PUT，recover 只读核对而不重放。这个结论绑定已测 Bun 版本，不泛化所有版本的传输行为。

快速卸载重挂测试在两平台旧 helper 上复现 daemon 残留。FUSE mount 调用阻塞至卸载，返回后应直接结束；旧代码反而开始轮询新挂载。NFS 现在跟踪原挂载设备 dev，避免追随之后的新挂载。最终测试分别断言重挂后仅1个 owned daemon、卸载后0个，代理 marker 也被清理，不用全局 pkill。

NFS 固定上游以当前目录中能找到前页 inode 为续读条件；删除该 inode 后 skip 始终为 true，隐藏未删除条目。`nfs-cookie-before.log` 是确定性失败，补丁按 inode 排序并选择大于 cookie 的条目，22项 native 回归与真实180文件递归删除通过。两平台构建均在隔离目录应用该补丁；共享准备脚本与 --locked 保留源 pin/依赖版本，不手改全局 Cargo 缓存。

## 恢复与发行准备增量

本轮新增 `recover`：单 native journal 继续作为权威，CLI 的 commit/recover 复用同一认证代理桥，commit/recover 共用已确认阶段清理与 GC，避免第二套状态写入者。重构范围仅限这两个入口的共用流程；原有回归保留。HTTP 比较流式处理，不将整个 blob 或远端正文载入内存。确认代表当前远端满足目标状态，不伪称证明了请求是谁发起的。

恢复回归包含 lost PUT/DELETE receipts、rename 两端中间阶段、重启、unsent create/overwrite、不可变首基线、不同媒体/LDP 类型、HEAD→GET 版本变化、弱/畸形 ETag、断流和缺 blob。`recovery-kind-before.log` 先复现类型误确认，修复共用 Link 类型解析后重跑。Link 只将当前资源的 rel=type 当作类型证明，anchor 指向其他上下文不适用；对应 [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288#section-3.2)。

许可调查证据见 [固定版许可记录](agentfs-license-evidence.md)。发行包现在实际附带两份 vendored 原文和 manifest hashes；不再将 CLI 缺 Cargo license 字段描述为全项目未声明许可。AgentFS 自身完整版权/许可通知与 transitive notices 仍未解决，不绕过 public gate。

最终重复运行定位了两项独立问题。macOS 夹具的 accepted socket 继承 listener 的非阻塞模式，分段请求导致 WouldBlock 后提前关闭；现在在每连接处理前显式改回阻塞模式，并有强制非阻塞 socket + 分段请求回归。提交报告原先通过错误文本包含 `409`/`412`/`conflict` 判断冲突，可能误中 URL 端口或文件名；现在仅 `CommitFailure::Conflict` 进入冲突分类，transport/未知结果保留 in-flight 并进入 errors。lost receipt 回归使用包含这些文本的资源路径，防止再次退回文本匹配。修复前诊断见 `recovery-native-cause.log`；修复后 21 项连续 20 轮全部通过。Linux 构建脚本已显式解除仓库 `*.sh` 忽略，确保检出后可复现。

## 传递通知收集增量

后续收集已将 macOS 481/Linux 502 个原始通知文件引用实物化，分别去重为200/209份（并集211份），逐目标加入安装 manifest。仍保持 partial-collection：不是将扫描候选当作完整法律许可证明。Turso/SimSIMD 单独补充；五个包（含AgentFS和SDK）的完整通知来源、first-party 通知、Bun/TS runtime 等缺口仍由许可记录追踪；option-ext 的 MPL 对应源码告知已补充。

包装回归现为11 passed，新增复制字节一致、重复对象去重、漂移/越界/目标错配拒绝，日志 `notice-collection-tests-final.log`。两目标重新构建成功，macOS archive 解包校验通过；`notice-collection-integration.log` 再次155 passed/6 skipped、运行配置46 passed，根源码/测试和独立包类型检查通过。没有改动 native helper 或重新宣称当前 Gateway 已验收；本轮认证复查 `notice-collection-gateway-recheck.log` 仍为 invalid_client。

## 源码取得告知与 runtime 发行记录

安装包 NOTICES 已加入 option-ext 0.2.0 的源码 URL、Cargo.lock archive hash 和所附 MPL 原文路径。归档实际下载并与两平台缓存中的 8 个文件逐份比对一致。两目标重新打包通过，macOS 解包安装校验通过；Linux 跨编译 manifest 仍为 unverified。此轮仅修改通知文本，没有重新执行 native 挂载测试，挂载结论继续绑定此前已测候选。

Bun 1.3.8 调查已保存为 [runtime 发行记录](bun-runtime-distribution.md)。官方 ARM64 ZIP 已校验 digest；固定源码有 LGPL 静态库说明与重建入口，但当前 CLI 的完整 notices、对应源码和修改库后重建／重链接验收尚未完成。未发布、未部署，也没有把材料存在等同于完成发行准入。

本轮提交前再次执行完整集成，`mpl-final-integration.log` 为155 passed/6 skipped，加46项运行配置通过，测试 Docker 栈清理完成。`mpl-final-package-tests.log` 为11 passed/0 failed；源码、测试和独立包类型检查均退出0。

## 应用 JavaScript 通知增量

`packages/xpod-cli/src/javascript-notices.ts` 已接入同一次 `bun --compile --metafile` 的打包输入。两平台各228个输入、15个 package instances、11份去重原文随包保存；索引绑定 CLI hash，安装 manifest 绑定索引及所有原文。覆盖 nested 版本、type-only package.json 与 staging node_modules 符号链接，拒绝作用域外输入和无法规范化的绝对 external import；不将缺原文许可声明推成准入。详细范围及两个 Inrupt 原文缺口见 [JavaScript 发行记录](xpod-cli-javascript-notices.md)。

本轮 `javascript-notice-tests-final.log` 为12 passed/0 failed；独立包、源码、测试类型检查退出0；`javascript-notice-integration-final.log` 再次155 passed/6 skipped，加46项运行配置通过，Docker 栈清理完成。两目标打包与全部新增 objects/索引/CLI 哈希一致性核对通过，macOS 安装 CLI 执行通过；Linux 跨编译仍标记 unverified。没有修改挂载 runtime，也没有新增真实 Gateway 或 NAS 验收证据。

`javascript-notice-cli-only.log` 也通过：CLI-only 仍收集应用 JS 通知，native helper 和 native collection 均不存在，validationState 保持 cli-only。

## Inrupt 固定源码通知补充

两个 Inrupt 3.1.1 归档的 registry SHA-512 integrity 已核对，发布元数据共用 gitHead `94e54693a4fabf67c331c7b9af2bdb5e9d390992`，固定源码 LICENSE 原文已取得并保留。构建通过声明式 name/version supplement 索引加入现有 JS packages/files 及安装 manifest；不会套用到其他版本，重复声明、越界 object 和原文漂移会失败。两平台现在各15个包、12份去重原文，不再存在这两个独立原文缺口。来源与实际已安装 core 现有补丁的哈希差异见 [来源证据](inrupt-notice-source-evidence.json)。

`inrupt-notice-tests.log` 为12 passed/0 failed，覆盖 version 隔离、去重、补充原文漂移/越界/重复声明拒绝；依赖状态自检、源码/测试/包类型检查通过。`inrupt-notice-integration.log` 再次155 passed/6 skipped，加46项运行配置通过，Docker 栈清理完成。两平台打包及原文/CLI 绑定检查通过，没有改动认证补丁或挂载 runtime。public gate 保持阻止。

## 应用源码包与独立重建增量

独立客户端的每次编译现生成 `sources/application-source.json` 和 `sources/application-source.tar.gz`，绑定本次 CLI/source/target，保存实际 staging 的第一方源码、选中的已安装依赖树（含 nested 版本及现有补丁）、lockfile、原始通知和重建脚本。安装检查先验证归档路径、重复项及 regular-file 类型，随后逐文件检查实际大小/hash，缺源码或 notice 的归档即使更新外层 manifest hash 也会失败。

同平台编译与重建共用参数和环境处理，不传选择另一 runtime 的 cross-target 参数；原 compiler hash 只用于 provenance，允许兼容的修改版 Bun。重建在独立临时目录只使用清单内已验证字节，不安装依赖，执行完删除 staging，避免原仓库 helper 漏入产物。完整用法见 [源码包说明](../packages/xpod-cli/APPLICATION-SOURCE-README.md)。

本轮 macOS ARM64 候选源码包包含2,007个文件；在 `/tmp` 的仓库外目录成功重建，228个实际输入的路径/hash集合与原编译一致，编译后的 CLI version/help/status 退出0、helperPresent=false。`source-kit-outside-checkout-rebuild.json` 与完整 receipt 保存目标、compiler/CLI hashes 和输入集合；没有声称二进制逐字节可复现。实际仍使用原版 Bun1.3.8，不是修改JSC后的重链接验收。

Linux ARM64 独立源码包包含2,017个文件；在 `--network none` 的 Debian 容器中逐个通过GNU tar归档成员/字节校验并重建，228个实际输入的路径/hash集合一致，CLI version/help/status退出0且helperPresent=false。仅挂载源码归档、已校验的官方Bun1.3.8和本次输出目录，未挂载仓库或node_modules；`source-kit-linux-detached/evidence.json`、receipt和原始日志记录结果。此项不启动FUSE或目录服务，不能扩大此前native挂载验收范围。

`source-kit-package-tests-final.log` 为19 passed/0 failed、147 assertions；覆盖 input drift/escape、patched/nested 目录保留、脱离仓库重建、归档漏源/漏 notice/重复项/symlink/hardlink/body漂移/index不符与错误CLI绑定。源码、测试和独立包类型检查通过。`source-kit-integration-final.log` 为 lite160 passed/15 skipped，加 full60 passed，无失败，隔离 Docker 栈已清理。两平台预览包生成与安装材料验证通过；Linux 跨编译 manifest 仍保留 unverified。本轮未修改 Pod 挂载 runtime，没有新增公共 Gateway、NAS 实机或公开发行证据。

## Native source kit 与重建验收（2026-10-01）

新增导出与独立重建入口，保存固定 AgentFS Git 原始归档、完整打补丁源码、原始/working helper manifest 与 lock、340个 registry packages 的完整 vendor 源码及原始通知。21,254个文件均按路径/hash/size保存。working lock 只移除两个 AgentFS Git identity；逐 crate archive checksum 和全部 vendor file checksum 验证防止遗漏 C/ASM 源文件。安装包新增 native archive/index/build receipt，绑定实际 helper hash、engine和target。应用/native复用同一套归档预检与字节校验，拒绝缺项、链接、重复成员和越界路径。

独立包当前27 passed/0 failed、172 assertions，其中8项native材料回归覆盖母 Git 仓库静默跳过补丁、显式 `GIT_DIR` 污染、必需归档/重建 imports缺失、lock版本漂移、vendor C文件遗漏、错误helper/target/kit回执。此前错误隔离边界确实使native删页cookie回归失败21/22；改成上级ceiling并清全部Git环境后，两平台均22/22通过，不使用失败构建回执。

同一源码kit hash `4c657c29d9d0c4a7d5b240be335b57836ab075d6d7c91954162bed68b4320fec` 在macOS ARM64和Linux ARM64分别通过空Cargo home的 `build/test --release --frozen`。Linux容器禁用网络，只挂载kit、已安装nightly、官方Bun和输出目录，未挂载Xpod仓库、Cargo cache或node_modules。工具链/SDK/sysroot/system library仍是外部前置，不宣称已交付其对应源码或逐字节可复现。

此次重建helper hashes：macOS `467455ed027cf63db8fb49dedaae3b9ff5b7ce83a4cedd2c93ffc5dfaed71779`，Linux `40e29c32cf2fdf9e865857659db02670c1ac79da76d3251038835d041e4062a6`。两平台预览安装包完整归档校验均通过。包内macOS NFS/auth proxy/重启恢复/冲突/rg为13 passed、1 gating skip；包内Linux真实FUSE/external fixture/dirty rg/lifecycle为pass，含仅1个重挂daemon、卸载0个和owned容器清理。原始receipt/logs/报告保存在 `.test-data/agent-directory-workers/native-source-kit/`。这些是HTTP/auth夹具上的真实OS挂载；仍不能称为公共Gateway实际账号/Pod或NAS硬件通过。

源码kit和回执没有改写发行准入：macOS `--public` 反例仍仅公开门槛失败，安装校验通过。Bun/JSC修改重建/重链接、外部系统材料及整体文件级发行审核仍未闭合；真实公共Gateway候选和可用登录/Pod URL、NAS硬件也没有新增证据。

本轮源码、测试、独立包三项类型检查退出0；完整 `bun run test:integration` 为lite160 passed/15 skipped、full60 passed/0 skipped，无测试失败，owned Docker栈/volumes/network清理完成。证据为 `native-source-kit/{source-types-final,test-types-final,package-types-final,integration-final}.log`。
## 当前客户端分发变更：外部运行时（2026-10-01）

用户明确“不内嵌 Bun”。当前开发主线改为 Node-compatible ESM + 外部 Bun/Node + 原 AgentFS helper；旧内嵌候选、Bun/JSC 材料与对应日志均为历史证据，不扩大到新产物。启动器优先使用设备上的 Bun >=1.3.8，没有 Bun 时使用 Node >=22；执行失败不会换运行时重试。JS payload 与启动脚本分别 hash 绑定，schema 2 强制两者都存在且路径唯一；任一完整性失败后不执行入口。支持外部绝对／相对／链式符号链接。没有新增 Xpod 依赖。

实际外部运行时验收：macOS Node23.6.0 从中立 cwd 安装验证通过并自动发现 helper；实际 NFS overlay 与认证回归 13 passed／1 gated skipped。Linux ARM64 Node22（容器明确无 Bun）实际 FUSE + 安装 CLI 的代理生命周期、dirty rg、conditional commit、断回执恢复与 unmount 通过；测试容器中的 Node/ripgrep/curl 不进入安装包。第一轮 apt HTTP500、第二轮 slim 镜像缺 CA 使环境不可用，复用 Debian helper 测试基座后通过，保留原始失败日志。

包内29项测试／200断言、三组类型检查通过；对应应用 source kit 在仅核验材料的 staging 下独立重建229个输入，生成 JS 分别在 Bun/Node 运行 --version 通过。候选 payload742,610字节（0.71MiB），helper Mac6.67MiB／Linux8.09MiB。包含完整源码材料的候选压缩包仍约65.85MiB／66.42MiB，源码未拆出。当前工作树候选证据位于 `.test-data/agent-directory-workers/external-runtime/{candidate-evidence.json,node-macos-install.json,node-macos-overlay.log,node-linux-report.json,detached-rebuild.log}`；不扩大到 clean commit、公共 Gateway、NAS 或公开发布。首次完整回归因磁盘 ENOSPC，lite159 passed／1 failed／15 skipped，登录测试无法创建目录，未进入 full。保留日志后清理已停止的旧 Bun/JSC 构建缓存约4GiB，再重跑；不改变产品或测试预期。空间恢复后的完整 `bun run test:integration` 退出0：lite160 passed／15 skipped，full60 passed／0 skipped；owned Docker容器、卷和网络清理完成，日志为 `external-runtime/integration-after-space-recovery.log`。CLI-only 安装包在 Node 下也验证无 checkout helper 泄漏（`node-macos-cli-only.json`）。
