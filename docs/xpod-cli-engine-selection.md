# Xpod CLI 挂载引擎选型与交付计划

> 当前状态（2026-10-04，账号 B / opencode-go/deepseek-v4.1-flash；本页以下旧段落均为 HISTORICAL）
> - 当前源码：`codex/agentfs-current-release` HEAD `5ce81c679cf7ba0aab82b277a44b3ea469bcc72d`；native HEAD `8d4983c96e9942b8edeb7912659017d5e98762e4`。已公开的 preview.1 通过旧 RC223 的 macOS/Linux 验收，**不能**替代新 kit5 原生准入。
> - 原生 CI [run 37146470600](https://github.com/undefinedsco/xpod/actions/runs/37146470600) darwin+linux 两 ARM runner 串行实际成功；ROOT 19 项独立验收只接受 units/source/install。服务候选 [run 37148085189](https://github.com/undefinedsco/xpod/actions/runs/37148085189) 只发布 exact 镜像 `ghcr.io/undefinedsco/xpod@sha256:fd2ee44323e3412c9b43e4ee31d4d9aeb6b512bb2524e9907c6c66cd50fb8428`，deploy 在 registry-authority 预检前失败，无 Public16/Private17/SealOS。
> - 实际平台准入（kit5）：macOS NFS 间歇失败（重挂退出 75 `unknown runtime entry retained`）；64/512/1024 MiB 与 SIGKILL 崩溃恢复阶段未通过。Linux Docker `node:22-bookworm-slim` FUSE 因 helper 需 `GLIBC_2.39` + `libssl.so.3/libcrypto.so.3` 而加载失败（bookworm glibc 2.36）。
> - 实现子代理路由：账号 B 是当前唯一实现者；仅 **CONFIRMED HTTP429** 才转 Sol。旧文“主线使用 GPT‑6.1 Sol”为历史状态。
> - 存储缓存：远程 bounded clean-body 缓存仍 NOT IMPLEMENTED（仅 dirty blob）；不主张缓存或 99% native。

历史状态（HISTORICAL，2026-10-03）：AgentFS 是目录 MVP 的唯一产品引擎；Xpod 是总产品，CLI/App 是入口，CSS/API/AFS 是可选能力的设计方向。客户端不内嵌 Bun。已公开的 preview.1 通过旧 RC223 的 macOS/Linux ARM64 实际挂载验收，不能替代新原生 QLever RC。当前整合在 `codex/agentfs-current-release`，已 fast-forward 到最新 `release/0.4.23` 的 `cc08174163d71d5bbbb22e13b0b88078d9649e52`，8 处文本冲突已完成语义合并，0.4.24 最终源码门禁及原始完整集成已通过；下文 `9460a7e` 的绿色记录仅对应当时源码。此前 `ab583de` 基线的兼容代码及诊断边界已通过独立语义审查，GPT‑6.1 Sol 最后修复的 43 项单测和编译门禁通过；首轮原始完整集成失败（Lite 两文件/三测试失败，159 通过/16 跳过）；后续冻结回归的唯一失败为旧 RC 静态测试契约，四项字符串修正后，最终原始完整集成实际退出 0（Lite 162 通过/16 跳过、Full 62 全通过，8,277 覆盖路径前后稳定）；原生客户端内存/崩溃准入、新 native RC 仍待验收。273 秒 PUT 500 未证明解决。发行范围见 [预览记录](xpod-cli-preview-release.md)，当前服务门禁见 [RC 验收](acceptance/rc-qlever.md)。历史记录保留原来源与限制。

最新基线与卸载生命周期的服务侧原始完整回归已通过：Lite 162 通过／16 跳过，Full 62 全通过；本轮正常退出 0，见下述最新记录。修后的原生 helper、安装产物与实际挂载仍未完成准入。正常卸载已改为由持有挂载的本地 runtime 管理系统子进程，客户端仅请求与查询结果；断线不取消 flush，只有实际退出 0 加可靠挂载消失才允许退休。六项 CLI 夹具通过。旧 runtime target 的回收守卫已补齐：只有可靠观察为 Absent 才回收，Mounted 或 Unknown 保留；独立源码复审无新增 P1/P2。五项源码与依赖已冻结，新固定补丁源码包导出成功，绑定 21,280 个文件和 340 个 registry 包。第一轮官方隔离重建实际退出 1：libgit2-sys 写入对象文件时 ENOSPC，当时 helper 编译和原生单测尚未进入。源码包与输入保持稳定，失败闭合日志保留；后续 kit4 的实际重建结果见下文，不覆盖原失败。新的安装大文件夹具 v3 已通过轻量门禁，保留固定 RSS、正文完整 SHA、SIGKILL、恢复 GC 与原始版本冲突断言；它未执行新 helper 或真实挂载。不能用旧安装包的通过记录晋级新源码。

## 目标与范围

第二轮同材料重建已实际退出 1（419.717 秒），进入 helper 编译后发现 `mount_control.rs` 的 E0507，原生测试仍未运行。该处已按最小修正处理；Pending 现在保留 owned child 的真实 wait/exit/signal 与同次 kernel 观察，之后 IPC 失联也保留 last-known，退出与退休规则不变。新增真实 child 测试的 FD 继承边界也已修正。第三轮 kit3 的 helper 编译通过，但完整原生测试为 55 passed / 1 failed / 2 ignored，实际进程退出 1（385.645 秒）；没有生成成功构建回执。唯一失败的卸载测试用固定 sleep 推断子进程已退出，实际复现时同一 owned child 仍在运行。现已只在测试中改为 CLOEXEC socket barrier 和同 PID 的真实退出观察，保留断线、挂载状态、重试及退休断言，产品实现与期限未变；修后的 kit4 实际编译／测试结果见下文。旧 kit2 完整归档验证后已退休重复展开目录，失败源码和日志可恢复。

新客户端开发版为 `0.1.0-preview.2`，入口复用 manifest 的版本常量，workspace 锁版本同步。当前 standalone 包 50 项回归与严格包类型检查通过；类型检查首次发现一个测试调用不符合既有 Bun 类型声明，改为保留真实错误详情的准确调用后通过。此版本尚未公开，旧 preview.1 附件保持原字节。

`9460a7e` 整合源码的 workspace 包构建、依赖状态检查、源码类型检查、测试类型检查和组件生成均已实际通过。测试类型检查首次发现 CJS 测试声明遗漏已有的 `obtainSourceArchive`，补齐准确签名后原门禁通过；该失败记录保留。Task 首个失败诊断专项五文件 77 项通过，独立复审已闭合问题，但尚未证明旧 RC 的失败原因或新的真实 RC 通过。原始完整集成在启动前发现 5432/6379/9000 由另一个 worktree 的 Docker 栈占用，没有启动测试 producer；预检失败不能记作测试通过或测试失败。现在仅测试基础设施支持三个规范 host-port 键，容器内部端口不变，启动和复用均在确认本 Compose project 的端口映射后才发送 host/S3 探针；Redis 可写检查在本 project 容器内执行。24 项专项、测试类型检查、默认及自定义端口的真实 Compose 配置渲染通过，负责人独立核验七源和闭合日志哈希。本次用户授权清理累计退休 5,867,802,624 bytes（约 5.87 GB）已分配的可恢复测试缓存；这是各次退休量之和，不是净 APFS 空间增加量，期间也创建了新的源码包、71 MB registry 恢复归档及 78 MB kit5 恢复归档。归档、源码索引、安装包和失败日志保留；已验证的 Mac target 与重复应用源码展开目录已退休，未来 Mac 原生重编须重新生成 target，kit4 重复展开目录已退休，完整逐文件核验的归档仍保留；当前 native 输入已更新为完整归档的 kit5；21,280 文件及 index 全部与归档正文逐一复验后退休展开目录，后续原生重建必须先恢复并重新核验。kit4 官方离线导出已完成，负责人逐文件核对 21,280 项和完整集合，只有测试同步源码与来源索引相对 kit3 改变。编译仍须满足既定 fresh 4GiB 与阶段预算门槛；此前两次容量拒绝发生在 native producer 启动前，不是编译或测试失败。

独立端口下的原始 `bun run test:integration` 已于 UTC 2026-10-03 11:25:58–11:34:43 实际退出 1（524.970 秒、signal null）：Lite 161 passed / 1 failed / 16 skipped，Full 未进入。唯一失败为 Matrix 协作；现有诊断记录本轮第 68 笔请求的 PUT 在约 244.141 秒后返回 HTTP 500，上一笔 PUT 约 5.149 秒返回 200。这是长写现象的新复现，不证明具体根因，也不与此前 262 秒 GET 合并归因。8,710 个入口／源码／SDK／生成产物状态前后完全一致，日志已闭合并由负责人重验哈希；没有触发容量停止，owned 进程组及容器／volume 均已结束。原测试清单和期限保留，需先定位本次等待发生的具体 Solid／存储操作，再修复和重验完整入口。

这次 PUT 的阶段记录进一步定位到写入前的 `events.select` / `listEvents` 等待，约 243 秒后以 DOM TimeoutError code 23 失败；reserve、insert、reconcile 尚未进入。最后一个下游 Pod GET 已在 353ms 收到 HTTP 200 头，但旧诊断不观察 Comunica 直接使用的 `response.body.getReader/read`。因此不能从缺少 text/json 阶段推断正文未被读取，也不能据此断言 SPARQL 写入、数据库锁或 SDK 是根因。现在已补充保持原 reader、Promise 和 chunk 的有界元数据观测。独立复审发现的观测异常隔离和 coverage/EOS 两处问题已修，40 项专项、源码及测试类型检查通过；负责人实际源码构建退出 0。经现有 Lite 启动器初始化后，原 Matrix 单文件 1 test 通过，producer 68039 实际 0/null、72.286 秒，8,710 项源码／SDK／产物状态及 HEAD/status 稳定，无资源停机。成功路径按原行为删除 helper 证据，未保留 raw stream EOS 记录；此单文件通过不证明历史长请求已修复，仍需原始完整入口验收。首次直接 Vitest 因缺集成初始化而退出 1、执行 0 tests，失败记录保留，未作为 Matrix 产品结果。

最新未过滤完整入口复验分两轮保留：producer 83821 实际 1/null、203.217 秒，Lite 162 通过／16 跳过，Full 已进入且基础设施 ready，但 local ingress 占用了尚未启动的 standalone Gateway 端口，导致 EADDRINUSE，Full 测试没有启动。修复只涉及测试 runner：将 12 个待启动 runtime 端口与三个基础设施端口合入现有 `XPOD_RESERVED_PORTS`，保留外部值和文件，结束后精确恢复原环境；没有新增产品配置或修改运行时端口规则。实际 allocator 负例先失败，修后原三文件组合 29 项（原 24 + 新 5）、源与测试类型检查通过，负责人独立复核源码及闭合日志。

修后原始 `bun run test:integration` producer 13991 实际 0/null、201.617 秒，Lite 32 文件通过／4 跳过、162 测试通过／16 跳过；Full 四实例实际 ready，7 文件／62 测试全部通过。8,710 项源码／SDK／产物状态与 HEAD/status 前后相同，无容量停止，owned 进程组、容器和 volume 均已清理。负责人已独立核对闭合 raw 哈希与快照。这证明当前隔离完整回归通过；不证明历史长请求根因已消除，也不替代正在运行的 Gateway 合法身份、修后安装 helper、跨平台挂载或新原生 RC 验收。

当前 kit4 的官方 Mac ARM64 重建 producer 20682 实际 0/null、435.554 秒，完整 58 项为 56 passed / 0 failed / 2 ignored，没有过滤；修复同步的卸载用例通过。源码索引绑定 21,280 文件，负责人再次逐文件核验完整集合。成功 helper SHA 为 `1725f5e92296edec08a931ca9263e8e28a52a510802b78a52e685c209ec06822`，该结果只证明 native 编译与单测。

同材料的本地 preview.2 包装、归档验证及安装目录验证均实际退出 0；两次官方安装验证各 770 项通过，CLI／启动器／helper／源码归档哈希一致。产物仍是 dirty local preview，未公开。许可差异审查没有发现新增第三方包或许可种类，Bun 1.3.8 生成器已单独核对官方来源；237 项机械 pending 状态没有自动晋级为 verified，clean repack 后还须重新绑定所有变化的材料。

新版安装产物的真实 Mac 两套件 producer 74818 实际 1/null、7.015 秒：2 parser passed、4 failed、2 informational placeholders skipped。卸载命令返回 1，而内核可靠观察为 Absent；严格清理保护保留现场及原错误，后续用例因 retained guard 被阻止。原生 owner 回执记录系统卸载 actual_exit=0、actual_signal=null、cleanup_complete=true，随后同 helper 重放返回 0；这证明客户端当次失败与后续完成状态不一致，尚不能从缺失的原命令 stderr 确定根因。发现读取 owner 后再锁 lease 的竞态窗口，当前收集诊断并补回归。不能将这次测试标成挂载通过，旧 helper 三档 RSS 结果也不能晋级新 helper。

Linux ARM64 的独占 Node 22 测试镜像已完成 Debian 签名索引与 22 个包摘要核验，实际包含 FUSE3、OpenSSL 3 和 rg，仍明确没有 Bun；这不是实际 FUSE 挂载通过。Rust/Bun 工具阶段曾在启动前因 fresh 空间不足 4 GiB 拒绝，固定工具材料已准备，尚未执行新 Linux 原生构建、安装或 FUSE 验收。现有 Gateway 公开状态与 Account controls 200 只证明可达，合法身份、Pod 读写和新 RC 仍待验收。

诊断复验 producer 83221 实际 1/null、13.061 秒，同样 4 failed / 2 passed / 2 placeholders skipped。保留的 stderr 分别显示 IPC 消失后仍误判 last-known pending，以及 lease 持有者写原子终态时临时 `.new` 被当成未知条目。最小修复先取得 lease 再读取终态，并在原总期限内观察 IPC 失联后的 closed proof，不发送第二次卸载；新增两项实际 child 回归的源码已经独立复审，尚未编译执行。kit5 官方 offline 导出及 verify-only 实际退出 0，负责人逐一核对 21,280 文件、完整集合和 340 registry 包；当前不将源码核验算作 native green。

用户最新授权先发布服务 RC，再在 SealOS 验证。GitHub rc environment 已有部署 kubeconfig，本机缺配置不再是这条 CI 路线的阻塞。最新发布基线新增 419 路径修复并要求服务 Bun >=1.4.2，8 处冲突已语义合并，最终门禁已通过；官方外部 Bun 1.4.2 已验摘要、ARM64 和实际版本，不内嵌客户端。整合前的提交前 whole producer 13395 被监督器 SIGTERM 停止：容量监测每轮创建 Docker 探针，其中一次超出原人为 1 秒观察上限，VM 状态转为 Unknown；产品完整结果未知，不能记成产品失败或通过。改为同一独占只读探针的三次实测采样均小于 0.1 秒，原容量／产品测试期限保留，该停止记录保留，后续最终整合原始完整链已通过。 最终 source 对齐 0.4.24，148 项整合回归、源码／测试类型检查、官方依赖／包／组件／UI 构建及版本相关 59 项回归通过。新持续探针监督器已绑定实际 Bun 1.4.2，9 项轻量保护检查通过；后续 producer 50759 的原始完整链实际 0/null、343.921 秒：前置 30、Lite 163 通过/16 跳过、Full 63 全通过；ROOT 独立复验 8,916 项源码／SDK／产物正文、闭合日志及 owned 清理。仅证明隔离集成，SealOS 和新客户端原生准入仍待完成。

固定 Bun 1.3.8 官方源码为历史超时提供机制线索：客户端设置 5 分钟 socket long timer，正文数据到达会重置；4 秒 sweep、15 tick 推进一分钟，推导空闲时约 240–300 秒触发，完整 headers 并不统一重置计时。code 23 与 TimeoutError 相符，但也可能来自调用方 abort，因此约 240063ms 的历史差值仅与该机制相容，不足以确认因果。仍需关联同一失败请求的最后正文数据、终态和传入 signal；reader 观察时间不等于 socket 收包时间。此机制与 `Bun.serve` 的服务端 idleTimeout 分开。[HTTPClient](https://github.com/oven-sh/bun/blob/bun-v1.3.8/src/http.zig)、[timer 常量](https://github.com/oven-sh/bun/blob/bun-v1.3.8/packages/bun-usockets/src/libusockets.h)、[timer 推进](https://github.com/oven-sh/bun/blob/bun-v1.3.8/packages/bun-usockets/src/loop.c)。未改变测试预算或绕过 Solid 数据访问。

完成 AgentFS 与 rclone 的对比，选择满足目录 MVP 的引擎，交付可安装的 Xpod CLI，并完成开发、独立测试、负责人验收和发布。设备范围 PC + NAS；远程 Agent 聊天与设备控制保留接口边界，本次先完成目录。

产品归属按最新决定：Xpod 是总产品，CLI/App 是入口，CSS/API/AFS 是可选模块。AgentFS 是 AFS 内部引擎；客户端预览是 Xpod 的能力裁剪构建，不是平行产品。模块依赖与当前尚未可选启动的边界见 [产品设计](solidfs-spec.md#产品入口与可选模块2026-10-01最新设计方向)。此调整不改变选型准入、目录协议或当前产物名称。

客户端开发分支为 `codex/virtual-folder-design`；当前服务整合分支为 `codex/agentfs-current-release`，工作区为 `/Users/ganlu/.codex/worktrees/agentfs-current-release/xpod`，以当前 `release/0.4.23` 为整合基线。旧 `release/0.4.21` worktree 保留为证据来源，不晋级为新发布。用户已将后续开发和测试切换为 GPT‑6.1 Sol 子代理，负责人继续设计、整合、独立验收与发布。DeepSeek 已交付的改动和回执保留；选择依据见 [开发子代理比较](worker-model-comparison.md)。

## 当前 native 客户端的未完成准入

实际 CLI 始终使用 `--session-dir`。copy-up 已流式下载到 seed 文件，commit/recover 也分块处理；不能再把这些当前路径概括为整文件内存缓冲。新增源码已将 `get_range` 的 HTTP 200 路径改为仅保留请求窗口并排空正文，保留尾部传输失败；超长 206 拒绝，不能截断后视为成功。固定上游 source-kit 的真实重建中 37 项单元测试通过，新 macOS 包独立安装验证通过；安装后 Mac 直连 synthetic fixture 的64/512/1024MiB RSS 实测通过，helper sampled peak最高21.125MiB，200仍传输整个响应。这不代表真实Pod/auth proxy/WAN或原生FS比例，详见[性能记录](agent-filesystem-performance.md)。

seed 下载改用持有文件句柄与 exclusive lease；清理只回收已失去 owner 的新版 seed，保留 legacy、活跃 writer、其他 dirty/base/inflight。真实内部 HTTP 取消与 owned 子进程 SIGKILL 回归分别通过。安装后64KiB HTTP barrier的SIGKILL已真实关闭helper，但同轮死NFS的stat/卸载失败，恢复GC仍待完成；离散RSS采样不能证明瞬时内存硬上界。旧预览的69MB包大小不证明运行内存有界。

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

当前Mac崩溃准入暴露了本项目NFS生命周期成本：死helper后的夹具不能再stat挂载目标或先走普通flush，正常卸载又必须保留server直到实际完成。三档大文件已通过，但原kill轮因清理失败而未进入恢复GC；随后仅完成运维分离，不能晋级。产品正在修正等待、挂载状态和完成通知，改动后必须重建并重验安装产物；若因此需要广泛维护挂载内核，仍按下文撤销选择条件处理。

固定rclone版本的 [nfsmount](https://github.com/rclone/rclone/blob/v1.75.1/cmd/nfsmount/nfsmount.go) 也标记为Experimental，mount／unmount使用无界命令等待，Mac默认强制分离。其 [NFS callback](https://github.com/rclone/rclone/blob/v1.75.1/cmd/serve/nfs/handler.go) 在处理UMNT请求时触发；锁定AgentFS也提供同类事件，但均不能据此证明普通卸载已完成。rclone总体测试资产领先，并不自动证明这条Mac NFS路径适合本项目的持久未提交语义。当前调查未执行rclone新平台验收或将回调当作完成凭证。

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

独立 CLI 预览已通过 GitHub Release 公开，具体源码、附件和验收见 [发行记录](xpod-cli-preview-release.md)。服务发布继续沿用 `docs/RELEASE.md` 的 RC 与 exact commit/digest 提升流程；新原生后端须完成实际 Gateway/Pod、同轮重启、固定负载及已发布客户端挂载复验后才可晋级。客户端预览公开不等于服务正式发布完成。

## 2026-10-04 状态更新（账号 B / deepseek-v4.1-flash）

- 原生 CI [run 37146470600](https://github.com/undefinedsco/xpod/actions/runs/37146470600) 在 `darwin-arm64` 与 `linux-arm64` 两 ARM runner 串行实际成功（HEAD `8d4983c96`）：官方在线导出 → `--verify-only` → `--frozen` 离线重建完整 Rust 60（58 通过 / 2 既有 ignore / 0 filtered）→ 新 kit5 helper/源码绑定打包 → 解压安装 `install-verified`。
- source-kit `84c5d586…`；helper darwin `2d4a7360…` / linux `88c299dd…`；archive darwin `6cdd9535…` / linux `1408ec6b…`。
- 原固定 Bun 1.4.2 `bun run test:integration` 实际 exit 0/null、399.152s（preflight 30 / Lite 163+16skip / Full 63）；Node 22.21.1 与 Bun 1.4.2 打包消费端实际通过。
- 未完成：真实 macOS NFS / Linux Node22-without-Bun FUSE 挂载与 64/512/1024MiB、SIGKILL 恢复/GC、dirty412；live Gateway、公开发布。历史失败证据保持不变。
