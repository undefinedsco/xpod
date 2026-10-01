# Xpod CLI 目录 MVP 实现与验收记录

日期：2026-10-01。分支：`codex/virtual-folder-design`，工作区：`/Users/ganlu/develop/.worktrees/xpod-virtual-folder-design`。用户授权负责人直接实现；原型 worker 已结束。AgentFS 是唯一产品主线，rclone 保留研究证据。选型理由见 [引擎选型](xpod-cli-engine-selection.md)，历史调查见 [技术研究](agent-filesystem-research.md)。

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

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| Native session/恢复回归 | 最终 22 passed；此前21项连续20轮共420次通过 | `nfs-cookie-native-tests.log`；新增删掉前页 cookie 后继续分页的确定性回归 |
| 目录/CLI 专项 | 166 passed，5 skipped | `nfs-cookie-focused-final.log`；skip 包含真实挂载 opt-in，实际挂载另有独立证据 |
| 代理真实 native/HTTP 桥 | 11 passed（含断流、真实 native 桥和 lost receipt recovery） | `clean-macos-acceptance.log`：真实 OS 挂载通过 loopback proxy 读写/commit/recover，CLI auth 使用 fixture，不是真实账号 |
| macOS 安装产物 | archive 解包 hash/version/help/status 与 helper 实际启动通过 | `clean-macos-package.log`，从中立 cwd 执行真实编译 CLI |
| macOS NFS 重启/冲突/rg | 2 passed，1 gating skip；与代理11项合计13 passed / 1 skip | `clean-macos-acceptance.log`：安装包内 CLI/helper；新增 rapid remount 的 daemon 数量检查、180文件分页递归删除 |
| Linux ARM64 FUSE 与安装 CLI | 真实挂载和完整 CLI 生命周期已通过 | `clean-linux-acceptance.log`、`agentfs-linux-report.json` 的 installedCli=true；基础读取/Range/编辑/替换、默认 mount/unmount、重挂、commit、lost receipt recover、412、proxy 清理和 daemon 数量检查 |
| 完整集成 | 155 passed，6 skipped；四种服务运行配置 46 passed | 最终 NFS 修复后再次运行 `nfs-cookie-integration-final.log`，exit 0，隔离 Docker 栈已清理 |
| TS 类型/组件定义 | build:ts、typecheck:test、build:components、独立包类型检查已通过 | `lifecycle-ts-final.log`、`nfs-cookie-test-types.log`、`lifecycle-components-final.log`、`nfs-cookie-package-types.log` |
| Rust 静态检查 | clippy exit 0，11 warnings | `nfs-cookie-clippy-final.log`；使用匹配 nightly 编译器和 clippy，独立 target。未将 warnings 描述为零告警 |
| 包装回归 | 10 passed | `nfs-cookie-package-tests.log`：新增 runtime 缺失、错误 OS/架构及显式 helper 不回退的回归 |

原始反例日志保留：`session-regression-before.log`、`proxy-lifecycle-before.log`、`proxy-transport-before.log`、`proxy-stream-before.log`。测试先复现再修复；最后一个含断流未处理异常/超时，修复后专项通过。

## 已知限制和发布门槛

1. 这是未公开发布的可安装候选，代码已提交并从 clean exact commit 构建。macOS manifest 为 `install-verified`，Linux 跨编译 manifest 保守保留 `unverified`，实际目标平台验收另存证据；`publicReleaseReady=false`。已附四/五份可核实原文；AgentFS 自身完整版权/许可通知、其余第三方 notices、Bun/TS runtime notices 与发布渠道仍未完成，不执行 npm latest 或生产发布。
2. 当前公共 Gateway `https://id.undefineds.co/` 可达，但已有 CLI OAuth 刷新失败，且新增目录接口未部署。没有本任务真实用户 Pod 写入证据；Docker/fixture 不等同当前 Gateway。真实认证、目录权限与实际 Pod mutation 需部署候选后独立验收。
3. macOS ARM64 和 Linux ARM64 容器已验证对应路径及安装 CLI 生命周期；NAS 实机、x64、Windows 仍未验收。Linux dirty rg 的 native fallback 未在容器验证。Linux release helper约8.1MiB，依赖 glibc/OpenSSL3；纯 Node Debian slim 缺 libssl3 时不能启动，安装验证已实际捕获该错误，补系统依赖后验证通过。
4. 未知写回结果会保留 journal/blob 并拒绝盲重试；现已提供 `agent-fs recover`，仅读取远端，区分 confirmed/retryable/conflicts/errors。内容、媒体类型、LDP 类型与 strong ETag 对应才确认；首次基线仍在才允许按原条件重试。冲突、弱/畸形 ETag、读取中断及缺 blob 保留数据和 in-flight。不会自动合并冲突，不会刷新基线。
5. HTTP rename 不是远端原子操作；目录 rename、symlink/hardlink 不支持。commit 在整个 HTTP 请求期间持锁，可能等待每请求最多 60 秒；不是高并发提交设计。
6. 远程有界 clean cache 尚未实现；旧 dirty revision 的 blob 到 commit GC 才回收。未验证超大文件内存峰值/崩溃全矩阵/并发远端 rename，也没有“99% 原生性能”的证据。
7. 上游 Linux FUSE 补丁只有三处缓存设置；其性能代价仍需代表性负载评估。研究性能文档不能替代本产品最终实现 benchmark。
8. 一次 macOS 单文件目录删除出现 ENOTEMPTY，后续单独诊断与10轮重复通过，尚无该次失败的明确根因。另发现并确定性复现了 NFS 分页 cookie 删除后错误 EOF 的独立问题，已补丁修复并通过180文件挂载删除；不能将此当作原单文件偶发失败已解释的证据。

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
