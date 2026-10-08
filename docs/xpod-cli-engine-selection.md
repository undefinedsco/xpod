# Xpod CLI 挂载引擎选型与交付计划

## mini 验收接续（2026-10-09）

本节取代下方历史记录中的“当前”口径，不覆盖历史失败。

- 整合源码为 `e940b8d26730f22cdbe5abc4b6d08069f9f7ff0f`，
  [PR #37](https://github.com/undefinedsco/xpod/pull/37) 仍为面向 `staging` 的草稿，未合入或晋级。
  [CI 37674200920](https://github.com/undefinedsco/xpod/actions/runs/37674200920)
  全部通过：单元测试 9277 通过、321 跳过、1 todo；修复后两轮本地完整集成均实际退出 0，
  每轮 preflight 30、Lite 163（16 跳过）、Full 63。
- 原生产物来源为最终整合源码 `e940b8d26730f22cdbe5abc4b6d08069f9f7ff0f` 的
  [run 37674192049](https://github.com/undefinedsco/xpod/actions/runs/37674192049)。
  macOS ARM64 与 Linux ARM64 Bookworm 均为 98 通过、2 忽略、0 过滤。
  双平台归档、helper 哈希、阶段退出和源码收据已独立核验；各 3610 个源码条目与 Git 对应提交一致。
  两平台 source kit SHA256 为 `f572f0666de8e6f3baa8a80e9c28561eb5a05041e76c97c02c1ba8f65c94132a`。
- 真实挂载采用独立 harness `ba943aaf80a3f5d5309caac9dd50826d58f903cb`，
  [run 37682488775](https://github.com/undefinedsco/xpod/actions/runs/37682488775)
  的 Linux FUSE 与 macOS NFS 均成功。下载后的 raw/report 哈希、实际退出 0、producer 关闭、
  owned process group 消失及 `mountExecuted` 已核验。Linux 为 15 通过、2 跳过；
  macOS 为 14 通过、3 跳过。按逐项 assertion 统计，不采用将 skipped 计入 passed 的顶层计数；
  跳过项为两个 opt-in 占位及 macOS 上的 Linux procfs 专项，六个必需挂载用例均通过。
- 必需挂载范围包括原始 matrix、shell/PATH rg/Git/worktree 消费、64/512/1024 MiB
  流式正文与 RSS、真实 in-flight SIGKILL copy-up 恢复及 partial GC、dirty 编辑重启与 commit、
  412 冲突保留首次基线。1024 MiB 的 helper RSS 峰值（read/copy-up，KiB）：
  Linux `55644/58480`，macOS `27216/28528`；不是性能优胜或任意部署的内存保证。
- 消费端使用外部 Node 22.21.1，Bun 不在消费端 PATH。上述挂载使用受控 HTTP Pod contract
  server，不是实际 GZ OAuth/DPoP、安装后的服务镜像、desktop permissions 或发行证明。
  本节最终源码、原生产物与挂载消费绑定一致；旧源码的成功记录仅保留为历史。
- PG 只保留一个启用 Pro 扩展的候选，开源功能在同一 PG17 上测试；源码客户端 Public16/Private17
  通过不替代 exact installed-service 验收。共享 RC 未改动，仍只允许合入后的 `staging` 发 RC。
  真实 GZ 账号/Pod、Models/Chat/Tasks、Local、桌面和发行门禁继续保留为未完成。
- CNB 额度仍可用，认证通过；代码写权限不足已通过官方构建 API 的 `config` 字段解决，
  不需要把凭据扩大为仓库写权限。控制配置提交 `e5815d0` 固定原生 amd64、Docker `runtime`
  target 和规范 OCI source/revision 标签，复用已验哈希的 QLever runtime，不重新编译 QLever。
  首个服务候选构建成功，但 source 标签多了 `.git`，不满足正式准入；保留失败边界，不放宽校验。
  修正标签后的 [CNB 构建 cnb-vfi-1k4e9abil](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-vfi-1k4e9abil)
  已成功发布服务候选
  `docker.cnb.cool/undefineds.co/native-builder/xpod-installed@sha256:3293455e7920f471f5b92af64108a16ef1ec4c6f2d5bbd02f81fff6609486e08`。
  OCI revision 为最终整合源码，source 为规范仓库 URL。mini ARM 的 amd64 Bun/QEMU 已实际触发 signal 6，
  相关自有容器已清理；后续安装产物在 CNB 原生 amd64 验收，不静默切换 Node。
- [安装态 SQLite cnb-adp-1k4e9vs7n](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-adp-1k4e9vs7n)
  在上述同一服务 digest 上通过 Public16 与 native search；完整报告经既有
  `validateInstalledReport` 独立重验，实际退出 0、自有容器清空。
  runner SHA256 为 `c47673c52101dbc082dc267f6ea7ed9f1b63eea333216d3b05d27459e22f822f`，
  report SHA256 为 `8a29bff09799848dd74f5046db97ee77c21cb8a48d4abc9659a4d5ac6889a123`。
  前一次任务 `cnb-t4u-1k4e9s63j` 虽退出 0，但单行报告被日志平台截断，未用作完整报告证据；
  后一次改为有序分块与完整报告哈希，未改变产品或验收用例。
- [安装态联合 PG17 cnb-lto-1k4eakcrv](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-lto-1k4eakcrv)
  使用上述同一服务镜像和既定 PG 候选
  `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:1199698c789fb65897e4b0bd370f7faa959bcbdd3499784af256ad5bb8f0a5f3`，
  开源 16/16、Pro 17/17 以及两套 native search 均经既有规范校验器通过，无失败或跳过。
  单一 PG17.10 实例身份为 `7694358013082710061`；公共表 OID `17238` 在 Pro 扩展与两套用例
  前后保持一致，扩展增加 2 列、1 触发器，ABI 为 `1|true`。
  producer/attach 实际退出 0，测试 schema、数据库、自有容器与网络均验证清理。
  开源报告已取回 mini 独立复验；私有原始报告和夹具未输出到公共日志或产物。
  此前首轮 secret 事件白名单拒绝和两轮内存对象/JSON 报告校验差异导致的失败均保留，
  最终改为读取实际落盘 JSON，未改变产品代码、用例或比较标准。
  这仍不代表真实账号、桌面、备份恢复或 RC/发行验收通过；共享 RC 未改动。
- 2026-10-09 的 PR 审查发现正式 RC 准入仍采用旧的独立数据库证明：
  `verifyPrivate17Admission` 与 candidate 汇总都要求 private/public database 名不同，
  不包含同实例身份与公共表扩展证据。因此上述联合执行通过不能写成正式发布自动化已经对齐。
  跟踪 [issue #39](https://github.com/undefinedsco/xpod/issues/39)：私有 producer 应在一个
  自有 PG17 server/database 中运行两套未改夹具，签发带 server/container 身份、表 OID、
  扩展效果、两套语义/search、实际 producer 关闭与清理的 sanitized 联合证明；公开 RC 在
  任何共享变更前强制校验，拒绝旧独立证明及身份/表替换、缺项、混配和不确定清理。
  私有夹具与原始报告继续隔离，不放宽来源、哈希或 registry authority。
- 同次只读 fetch 核实 `staging` 已到 `58d0f917`，新增 PR #36/#38 的桌面 Task 诊断；
  `git merge-tree --write-tree` 对当前整合候选预演成功，无文本冲突，未改分支或工作树。
  现有完整/native/mounted/installed 证据仅绑定 `e940b8d2`，不能继承给合并后的新组合。
  PR #37 仍为草稿；接续先收口联合准入契约，再对最终 staging 候选重新绑定所需验收。

> 历史状态（2026-10-05）：以下仅属于当时源码与产物，其余阶段记录保留各自证据归属。
> - 选型为 AgentFS，置信度中等；持久 delta、不可变基线及显式 commit 是决定因素。rclone 的成熟测试、范围缓存与平台资产仍是优势，不宣称 AgentFS 性能领先。
> - 开发分支 `codex/agentfs-v25-integration` 已正常整合 v0.4.25 与 native 提交链。冻结产品 `0e260a49ce28cb7b5cf8ee0bc4342d893cb742a8` 的 [run 37310635987](https://github.com/undefinedsco/xpod/actions/runs/37310635987) 实际成功：两轮原始完整集成每轮 preflight 30、Lite 163 pass / 16 原有 skip、Full 63 pass；两平台 ARM64 原生各 99 项（97 pass / 2 原有 ignore / 0 filtered）以及源码、许可、安装材料已独立核验。这些结果不替代实际挂载或真实 RC。
> - 下一服务发行目标为 `0.4.27`，另一个 worktree 的 `release/0.4.26` 不改动。CLI 保持 `0.1.0-preview.2`，外部运行时、不内嵌 Bun / Node / JSC；Linux Node22 无 Bun 消费端通过。Darwin 构建保留两次非致命 rust-objcopy / LLVM warning，不宣称零 warning。RC 发布改动在独立 `codex/agentfs-gz-rc-release` 分支。
> - typed native 诊断已真实编译，但 512MiB copy-up 约 60 秒 EIO 仍需新的实际挂载请求定位。新挂载夹具已绑定上述冻结材料；64/512/1024MiB、RSS、SIGKILL、412 与真实 Git/rg 门槛不降低，尚未声称新材料挂载通过。
> - 部署、诊断和远程验收全部限定 GZ `https://gzg.sealos.run:6443` / `ns-iknkxtc8`。已实际证明独占缓存 Pod 到 GHCR 的 DNS/TCP/证书 TLS、认证 manifest 与两层 HEAD（约 14.8 秒），并按原 UID 清理；它不证明 containerd 完整镜像拉取或原始 Public16 / Private17 已执行。
> - RC 当前源库实测为 GZ shared PostgreSQL 上的 `xpod_rc`、PG16.4、约 4.82GiB，尚无 native 扩展；不能原地加载 PG17 ABI。完整私有备份与独立 PG17 恢复、源扩展兼容及真实 Gateway / Pod / Models / Chat / Tasks 验收仍须完成，未发布或晋级。真实 RC 路由为既有 Ingress → `gateway` → `xpod-rc`；本轮独立 managed 任务执行器复用已有组件，不改共享生产执行器。

> 上一阶段记录（2026-10-05）：以下“当前”均指各自记录时的状态，不替代上述最新口径。
> - 产品定义：Xpod 是统一入口，CLI / App 是入口形态，CSS / API / AFS 是可选模块。HTTP 验收的唯一地址参数为 `--base_url`，其次读取 `XPOD_BASE_URL`；内部与报告使用 `baseUrl`，保留凭据所属实例与 canonical Pod 绑定。
> - 选型仍为 AgentFS，置信度中等。固定版 rclone 的通用 backend / VFS 测试资产、范围缓存与平台管理更成熟；AgentFS 的可替换 lower、持久 delta 和本项目不可变写入基线、显式 commit 语义更直接契合。比较及原型反证见下文；没有新的性能优胜结论，也没有因已投入实现而撤销推翻选型的条件。
> - 当前开发分支为 `codex/agentfs-cache-dev-gate`，缓存候选为 `f4c2a32436c6274b1572ed0cbf0dd20101b620ab`，Range 与测试停服修复为 `5d17b36e24a28a15101f6b9cab16b0b071927903`；已验收的挂载夹具／FUSE 补丁提交为 `78d2107fd99e79a2e2718967ad2c57050c1153e5`，此前公开／实际挂载的产品仍为 `c7e9aadbf87302908e766411f4ea1fea6d0a54bf`；`db3309` 新候选包已有实际构建，验收边界见后续记录。两个 ARM64 目标的旧 native unit / 源码 / 安装产物已验收，Linux Bookworm Node22 无 Bun 消费端通过；客户端不内嵌 Bun / Node / JSC。这些检查不等价于新候选或 OS 挂载通过。
> - `f1557c5` 的已提交文件绑定两轮原始完整集成，均实际退出 0：每轮前置 30 项、Lite 163 项通过／16 项既有跳过、Full 63 项全部通过。源码与测试类型检查也已通过。两轮输入一致性、各自测试项目资源清理已独立核实；这只证明该提交的回归，后续修复仍须检查新源码。私有 PG 诊断三稿的 9 项保护测试只接受源码与廉价门禁。
> - 后续实际挂载 [run 37273230777](https://github.com/undefinedsco/xpod/actions/runs/37273230777) 使用 `78d2107` 夹具和旧 `c7e9` 产品。Linux 实际 7 项通过、2 项失败、2 项跳过：SIGKILL 恢复、overlay 重启与 412 基线保存已通过，外部更新可见性与 512 MiB 原地写入 EIO 仍失败；64 MiB 用例通过，1024 MiB 未完成。macOS 作业已失败，部分日志显示 SIGKILL 后恢复时 `scene retained: kernel=mounted`；外层 producer 的闭合、退出码和清理均未证明，不据 GitHub 作业终态补写。三个大小的 RSS 观察与两个已闭合 daemon 记录只按各自范围保留，不等价于必需挂载案例通过。Linux 容器身份安全字段尚未采集，不补写为已证明。旧 [run 37265558948](https://github.com/undefinedsco/xpod/actions/runs/37265558948) 的两平台失败记录保留；上述局部结果不能替代新 helper 的全部必需挂载案例。
> - `78d2107` 的 HEAD 夹具仅 GET 消费正文 barrier，保留 HEAD / Range-HEAD 元数据；Darwin 观察脚本按架构选择 ABI，overlay 清理修正退休标记。负责人独立执行相关测试 29 项，实际退出 0。该批次两轮原始完整集成均实际退出 0，每轮前置 30 项、Lite 163 项通过／16 项既有跳过、Full 63 项通过；首轮只有本设计文档变化，产品、测试和物理输入稳定，第二轮全部输入前后及复验一致。保留首轮整体源码不稳定记录。这些结果只覆盖 `78d2107`，不能继承给缓存候选。
> - 新的 FUSE 产品补丁已移除不适合外部可变 Pod 的 `FUSE_WRITEBACK_CACHE` 能力请求，保留既有零 TTL / direct I/O。负责人使用已验源文件离线还原旧补丁，再按实际构建参数检查并应用新补丁，均实际退出 0；无需重新下载上游。这只证明补丁可应用，尚未证明新 helper 编译、外部更新可见性或新平台挂载通过。
> - A 已实测 HTTP 429／月度额度限制并关闭客户端，真实 wait、日志关闭、进程组消失、活跃工具清空均有证据；现按用户授权由两个边界独立的 GPT-6.1 Sol 执行通道接手原生与私有 PG 工作，负责人独立验收，server 与已启动 CI 保留。SealOS 控制器最后三项保护修复已复审，最终 14 项 guard 检查实际通过。一轮真实 SG 临时诊断已结束：种入 3 个 quad / source，原始容器前缀查询仍返回空结果；外层采集因 compiled runner 的路径与预期哈希错误配对而失败，不能记为诊断或语义通过。实际导入的 RDF 模块与 installed runner 入口须分别绑定。该轮 Pod 与三个 ConfigMap 的精确服务端 NotFound 已独立核实；此前 guard 误调用真实 kubectl 的原始失败和清理记录也保留。
> - 用户已要求后续 SealOS 部署、验收与发布全部走 GZ。当前 GZ kubeconfig 指向 `gzg.sealos.run:6443`，current-context namespace 为 `ns-iknkxtc8`；执行前重新核对目标和资源归属。本任务入口也须默认 GZ 并拒绝非 GZ，不能只依赖单次传参。现有部分 candidate / release / private conformance 入口仍硬编码 SG namespace、域名或自动部署，单改 `region=cn` 不足以切换。修正执行路径后再运行，不再创建 SG 临时资源；macOS / Linux 平台验收继续保留。
> - 本任务的 GZ 诊断入口已完成精确目标、实际 namespace、既有 registry 引用和双模块身份修正；19 项保护检查实际通过。一轮真实 GZ 诊断已完成采集，85 个阶段的原始文件哈希与各自子进程闭合已独立核实，结构快照（`--schema-only`）已保留；它不含数据，不能证明实际 RDF 字典内容。四个临时资源的精确服务端 NotFound 已再次确认。种入 3 个 quad / source 后原始前缀查询仍返回空结果，不能晋级语义验收。外层控制器输出曾管给 summary，未保留其真实退出码；该码保持 unknown，不用 summary 的成功码补写。
> - 原始 Public16 的实际 GZ 结果仍为空。已有 [SDK run 35529085898](https://github.com/undefinedsco/xpod/actions/runs/35529085898) 的 `ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:34341ea01e7f6dc7d4de23dc2709f3828665d91c47a2f4efd4decc10ac5f7e60` 绑定公有源码 `bc9cc4ea`，包含容器前缀与 local-vocab 两项修复；私有新 PG 构建必须显式选择该 SDK，并再次运行原始 GZ 案例。历史 PG `9fef6daf` 来自旧 parity 构建，公有修复归属 unknown；local-runtime `83c04949` 的实际公有源码不含两项修复，不能据旧默认值宣称新产品已部署。
> - 发行材料审查已覆盖源码包内全部 340 个 registry 包及 235 份不同的许可原文，两平台源码文件哈希一致。`quinn-proto 0.11.19` 的 `src/congestion/bbr/min_max.rs` 缺少 Google 2017 BSD 三条款声明，需通过现有 promotion notes 随包补齐；cliui Artistic 2.0 的修改告知也需实际进入发行记录。该源码包通知补充不改变已验 candidate / helper 字节，也不替代挂载、实际 Xpod 或公开发行准入。
> - 远程持久 clean-body 缓存已交付 `f4c2a3` 源码候选，新增用例的实际原始计数与两平台构建证据已取得，具体边界见后续记录；此前仅 rustfmt 解析不代表通过的边界保留。该提交早于当前批次完整集成，提交前未测试的偏差保留，之后的结果不能倒填；负责人要求的 Range 状态、完整 Content-Range 与正文跨度校验，以及 416 后重试的 412 分类，已在 `5d17b36` 源码中修正；新增测试监听器也有停止与 join。上述只通过源码复审，仍须实际编译与用例执行。当前本机空闲不足，未获准启动本地完整／原生构建，首轮 [专用开发 CI](https://github.com/undefinedsco/xpod/actions/runs/37276993771) 已结束：两个原始完整入口在 GitHub 成功，每轮前置 30、Lite 163 通过／16 既有跳过、Full 63 通过；缺完整物理输入快照和逐 producer 回执，按命令结果保留。macOS 原生作业在重建之后的 inventory 检查失败：验收器仍硬编码旧的 69 通过／2 忽略（71 总数），需与新增缓存／Range 测试同步，保留全部既有测试、两项声明忽略和零过滤；首版未上传实际 Rust raw，不补造精确计数或原生通过。CI 后续复用官方两平台原生流程；首版材料不足与后续 wrapper 的误报成功、缺失输入和 symlink 成环问题都须保留并修复，不能把排队、运行中或未经复验的汇总当通过。剩余交付包括这些修复和新源码回归、两平台新 helper 挂载、大文件／SIGKILL／实际 Git-worktree 消费、原始 Public16、真实 Xpod 认证与 Pod 读写、models / chat 分项验收、发行材料与 preview.2 发布；不声称原生 99% 性能或物理 NAS / x64 / Windows 已验收。

> - 后续验收器与完整集成 wrapper 已在 `db3309cc0ecfe8be3c273d45840704616b6a5fc5` 同步：保留既有 71 项，声明新增 24 项，期望 93 通过／2 既有忽略／0 过滤，仍须实际 Rust raw 证明。负责人独立运行 Python 夹具／wrapper 测试，34 项通过、1 项既有平台跳过、实际退出 0、输入哈希稳定；这个范围不包含 Cargo 或实际完整集成。[专用 CI 37278612144](https://github.com/undefinedsco/xpod/actions/runs/37278612144) 的两个原始完整集成已由负责人独立验收：每轮 30／163（16 既有跳过）／63；真实 wait 0、日志关闭与哈希、进程组消失、各自 exact project 资源清空；3495 项 tracked 与 11585 项物理输入前后相等，摘要独立重算且关键源码绑定该提交。只覆盖 `db3309` 回归，不能继承给后续修复。两平台原生作业已结束，原始测试及尚未通过的汇总字段见后续记录。私有 PG 发布验证的旧 Bun 1.3.8 静态断言须同步至既定 1.4.2；实际第二次首错为精确 public checkout 尚未在静态步骤前准备，不能据此回退产品运行时或削减验证。

> - 私有发布工作流已提交 `afc7da95ffd132cfe7000f1cb7cbbc7372ce2052`：默认及唯一 SealOS 区域为 `cn`、拒绝非 `cn`、移除 CO 凭据选择；前置并复用 exact public checkout / install，保留后续完整验证。负责人独立直跑 6 项相关检查，实际退出 0、输入稳定、日志及进程组闭合。[第三次 PG 构建 37280173675](https://github.com/undefinedsco/xpod-pro/actions/runs/37280173675) 的静态步骤（含真实 renderer）已成功，Docker 构建与 smoke 已完成，随后 linked QLever ASK 应为真却返回 false，作业失败；Private17／Public16 尚未执行，也未通过发布或 GZ 语义验收。须修复实际语义错误，不盲重发或修改期望。旧 `202aa` 原生作业的实际首错另为 supervisor 统计动态 target 时遇到已删除临时对象，随后权限错误遮蔽首错；原始日志与未闭合 rebuild 材料保留，不能据空 raw 补写 Rust 计数。
> - SIGKILL 后 NFS detach 的源码缺口已确定：已死亡 runtime 无法产生正常 `owner.closed`，现有卸载路径在执行 OS 卸载前失败，新 cache / FUSE 补丁没有覆盖。下一修复须在同一生命周期内证明原 owner 已死、lease 与 session / 内核挂载身份归属匹配，真实执行受控卸载并观察 absent 后再恢复。测试须保存卸载实际结果、primary 与 cleanup 两种错误，并观察 writer settlement 与 producer exit / close；不以缺少证明视为成功，不卸载外来挂载。

> - db3309 两平台实际 helper 原始测试均为 93 通过／2 既有忽略／0 过滤；原 SDK 102 项、CLI 27 项及 1 项既有 doctest 忽略按各自范围保留。Darwin 13 个、Linux 20 个门禁子进程的真实 wait、关闭日志哈希与进程组消失已独立核实；tracked 输入前后相同，源码 kit、包哈希与实际 tar 中 helper 字节一致。Linux Bookworm 外部 Node 22、Bun 不在 PATH、glibc 最大需求 2.34 与 OpenSSL 3 加载有实际证据，包内未发现 Bun／Node／JSC 运行时执行文件。该轮 final.json 仍写旧 71／69，原字段保留并拒绝；不将这些结果扩大成挂载、真实 Gateway 或公开发行通过。
> - Sol 已提交 supervisor 修复 fd49d97d3 与汇总修复 75abd0c9d，未倒改历史。负责人独立跑当前 38 项 Python 检查，37 通过／1 既有平台跳过，实际退出 0、输入稳定、日志关闭与进程组消失。未完成 wait 即使观察到进程组 absent 也不返回语义日志或关闭证明。这些提交尚无新的完整／原生门禁结果，不能继承 db3309 两轮结果；NFS v2 崩溃卸载实现与 PG ASK 根因修复继续进行。

> - 最新挂载修正为 `d6d609848f6631a3264a74c595574e4d525c4399`：NFS v2 将 daemon 身份和独立 crash-detach 证明纳入同一生命周期；pending Prepared / Spawned 不能因内核 absent 被清除或重挂绕过。每个挂载实例保留实际卸载证明，避免 FUSE 重复卸载；412 案例要求实际关闭的非零退出、原产品冲突诊断及本次对应 PUT 412。独立只读复核的三项问题均在稳定源码上关闭，未给实际挂载通过结论。[新源码 CI 37297166782](https://github.com/undefinedsco/xpod/actions/runs/37297166782) 尚未完成。负责人独立 Python 检查 37 通过／1 既有跳过；直接用 Bun 执行 Vitest 的尝试发生 tinypool 运行时兼容错误，没有执行测试，保留失败记录。随后负责人用显式外部 Node 23.6.0 重验同三文件，实际 28 通过／5 既有挂载跳过、wait 0、日志关闭、进程组消失、5 项输入前后稳定；这仍不证明 Rust 编译、实际 OS 挂载或 Node 22 消费端准入。
> - 私有 PG `fcde189` 将旧原生 seed 的默认图项对齐生产 `default_graph`／空值身份；[构建 37296515137](https://github.com/undefinedsco/xpod-pro/actions/runs/37296515137) 已跨过原 ASK 错误，随后混合数值排序原 seed 错用了另一个案例的 decimal 1.5，和既定 2.5 输入不一致。`22d3d71db67ce8e60cfd57057223aed0bff3ac6f` 仅新增独立 2.5 term 并修正对应 quad，原查询、期望及原 1.5 案例保留；官方 Bun 1.4.2 静态检查实际 372 通过／9 既有跳过。[新完整构建 37297286385](https://github.com/undefinedsco/xpod-pro/actions/runs/37297286385) 尚未完成，没有新发布镜像或 GZ 语义通过结论。原 Private17 installed runner 与 validator 是独立覆盖，不能由 native direct-SQL gate 替代；后续须绑定新 digest 与自有 GZ 临时目标，不能沿用旧 SG 固定目标。

> - 旧 `567a834` 的 [CI 37296516241](https://github.com/undefinedsco/xpod/actions/runs/37296516241) 在 macOS 轻量 Python 门禁实际失败，尚未执行 Rust 构建：两个新增 negative case 直接在不存在的 `.test-data` 下创建临时目录。38 项中 2 项错误、1 项既有跳过；负责人一次取回实际 job raw（SHA `71d4e71a0ffd5fcdcaa03240b7144adcb1c955eb87673d0a20ff455746224f52`），只接受该首错，不把本机已有目录环境的通过扩大成干净 checkout 通过。实施者须修正既有 setup，保留所有用例并以独立干净临时树验证；新 `d6d609` 同样含该缺口，尚不具备原生门禁结论。

> - 干净 checkout 的两行 fixture setup 已正常追加提交 `056d697d8b709327a25f6818fde2194a03f43a0e`，复用既有 `owned_scratch` 创建分类目录，未删除／跳过用例。负责人独立核对两个新建临时树的实际 raw：各自 38 项中 37 通过／1 既有跳过，真实 wait 0、日志哈希与进程组闭合；六份输入与提交字节一致。这个范围只关闭测试 setup 缺口，不能替代新源码的 Cargo、两轮完整集成与真实挂载。
> - 私有 [构建 37297286385](https://github.com/undefinedsco/xpod-pro/actions/runs/37297286385) 已真实失败：混合数值与日期排序跨过之后，默认图查询应仅返回 subject70 却也返回71。原生 producer 在复制 named graph 到 default graph 时，把专用于两图分离的 named-only 反例也复制进默认图；实施者和独立只读审查均确认这是 seed 与既定输入契约不一致。后续修正须保持原查询、期望和反例 quad，仅调整插入时序；同时审查剩余 seed／expected 后再跑完整 gate。原始 raw（SHA `4172af498259335f430f084106b427348f0aac0c2b6c557665898f66736146d1`）保留，没有发布新 PG 镜像或运行 GZ 新实例。

> - 私有 PG [390c33a 构建 37298147010](https://github.com/undefinedsco/xpod-pro/actions/runs/37298147010) 已整体实际成功：原 native runtime-link smoke 完整通过、公有集成 63 项及 HTTP／ACL 4 项通过，发布不可变镜像 `ghcr.io/undefinedsco/xpod-rdf-postgres@sha256:156b6ef3a27d5ee43b8aa54c16583b288cfb33e47e532aaa1f377515f187fed5`；实际 registry digest 与 push raw 一致。模块层的两个 .so hash 及 source revision 已取回，ABI 和原完整 Public16／Private17 的 GZ 实例验证仍待运行。公有 full integration 使用 fake QLever 部分不能替原17 installed runner。
> - Git/worktree 真实消费 harness 已提交本地 `aa8f0d511`，仍未执行 mounted：保留原五项并增加第六项 mandatory；安装包 CLI 实际生成 PATH rg wrapper，shell 读写未提交内容。Git objects／refs／index 留在 owned host separate gitdir，挂载工作树的 .git 仅标准 pointer，清除全部继承 GIT_* 并用自有空模板。独立审查的 wrapper 来源与外部 Git 环境两项问题已修复，类型检查及局部 29 项通过／6 项真实挂载跳过仅按其范围记录。后续新 helper 056d 与 harness commit 分别精确绑定，不为纯测试变化重建同一 helper。
> - [056d CI 37297913343](https://github.com/undefinedsco/xpod/actions/runs/37297913343) 原两轮完整集成的第一轮 Full 为 62 通过／1 失败：CloudManagedPodDeletion 案例 listen EADDRINUSE 127.0.0.1:38504；第二轮 Full 63 通过。输入与 owned cleanup 都已闭合，但第二轮不能补掉第一轮错误；原 raw／ZIP 保留并定位测试端口生命周期，不盲重发或改业务断言。Darwin 原生构建仍进行中，未取消。
> - 真实 GZ RC Gateway 的只读检查返回 `/service/status` HTTP 502；authoritative namespace 的 xpod-rc Deployment replicas 为0、没有对应 Pod，RC域名通过既有 nginx 转至 xpod-rc:80。该现状不等同新 PG／客户端缺陷，后续当前实例验收必须实际恢复可用 RC 运行时并按层验证，不能用临时诊断 Pod 替代；本轮只读取状态，没有修改现有 Deployment／Ingress／ConfigMap／PVC。全程目标仍为 gzg.sealos.run:6443／ns-iknkxtc8。

当前远端正文缓存的实现约束：复用已有 session 的 canonical Pod 与身份绑定，从 canonical Pod 地址推导本地或远端；不能根据认证代理的 loopback transport 判断，否则远端挂载也会被误判为本地。canonical Pod 为本地 loopback 时不创建 clean 正文副本；远端默认启用独立的持久 clean 范围缓存，MVP 内部预算为 64 MiB，不要求用户新增开关。缓存与 dirty 内容、不可变写入基线分开，淘汰只影响 clean 条目。

命中前用现有 HEAD 路径重验权限与强 ETag；权限拒绝、资源不存在或网络／服务错误按现有错误返回，不能回退到旧正文。填充请求用 `If-Match` 绑定该版本，校验响应版本、范围与完整性后才落盘；弱或缺失 ETag 使用原来的 fresh 读取路径。缓存可在重启后复用，但仍须在线重验；不同 Pod 或身份不得共用条目。验收需证明远端再次读取节省正文传输、代理地址不影响模式推导、外部更新与撤权不泄漏旧正文、预算淘汰和重启恢复有效、本地无 clean 副本且 dirty／baseline 不被淘汰。上述属于候选验收契约，不是完成声明。

> 历史状态（2026-10-04，账号 B / opencode-go/deepseek-v4.1-flash；本页以下旧段落均为 HISTORICAL）
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


## 2026-10-05 GZ 与双 ARM 准入更新

- 后续部署、诊断、验收统一使用 GZ：`https://gzg.sealos.run:6443` / `ns-iknkxtc8`。控制器拒绝其他 server 和 namespace，不回退 SG。26 项防护测试（MOCK）通过；真实只读预检退出 0、四个自有资源名均不存在。已创建用于完整 Public16 / Private17 的独立 emptyDir 诊断 Pod；镜像未就绪时 suite 不算执行，这条诊断链也不等于用户当前 Gateway 验收。
- 固定源码 `056d697d8b709327a25f6818fde2194a03f43a0e` 的 [原生 CI](https://github.com/undefinedsco/xpod/actions/runs/37297913343) 两 ARM job 均成功。ROOT 独立核对 ZIP 内所有阶段实际 wait、原始日志哈希、源码稳定与打包 helper：两端均 98 项原生测试 / 96 通过 / 2 原有 ignore / 0 filtered；SDK Mac 102、Linux 103；原 CLI Mac 27、Linux 77，均保留一个原 doctest ignore。
- Mac archive `aa9a715d…` / helper `2a70832b…`；Linux archive `51f07aa5…` / helper `3041843c…`，共同 source-kit `75282988…`。Linux Bookworm 已验证外部 Node 22.21.1、PATH 无 Bun、glibc 2.34 与 OpenSSL 3。仅准入构建、单测、离线重建及解压安装；真实 NFS / FUSE 挂载、远程缓存、当前 Gateway 和公开发布仍未准入。
- 同轮原始全套集成第一次出现 Cloud ingress `EADDRINUSE`，第二次通过；第一次失败保持有效。已定位启动失败后自有 Gateway 监听器未清理的问题，修复增加真实占用端口回归，并只在 Cloud 夹具使用既有重新选端口机制。Local 配置与原业务断言保持；安全重试日志记录 attempt、受限 code/syscall/IP/port。局部 24 项通过，修复后两次原始全套仍待执行。
- 独立证据：`ROOT-darwin-native-review.json` SHA `4385c185…`、`ROOT-linux-native-review.json` SHA `84309dc7…`，均保存在该轮 `.test-data/ROOT-cache-dev-37297913343/`。Linux 下载后 Python 3.9 哈希 API 错误导致 subprocess 退出码未落盘，回执明确标记未知；下载字节数和 SHA 与 GitHub 当前 artifact digest 一致，内层实际阶段回执逐一验明，不伪造下载退出码。

- GZ 第一轮完整测试未进入语义执行：PG156 镜像经节点 registry mirror 返回 HTTP 500，数据库容器无 imageID；服务 readiness 实际退出 7。ROOT 已核对 130 阶段实际闭合、全部 raw SHA、源码稳定及四个自有对象清理。Public16 / Private17 仍是未执行，不能记作案例失败或通过。显式 `ghcr.io:443` 经安全复用现有凭据的本地 manifest probe 实际成功（4503 字节、原 digest 相同），GZ 节点绕行仍待实证；依据 [containerd registry namespace/port 文档](https://github.com/containerd/containerd/blob/main/docs/hosts.md)，该路径可能绕过专有 mirror，但 `_default` 仍可转发。[Kubernetes 1.28 凭据匹配源码](https://github.com/kubernetes/kubernetes/blob/v1.28.9/pkg/credentialprovider/keyring.go) 要求 port 匹配，因此后续候选使用自有临时拉取 Secret，不修改共享 Secret、不改镜像内容或 TLS 校验。
- 现有 GZ RC 路由已存在，但应用 `xpod-rc` 与数据库 StatefulSet `xpod-rdf-postgres-rc` 均为 0 副本；RC 有独立 Bound 20Gi PVC `data-xpod-rdf-postgres-rc-0`。恢复前需核实 PG 主版本、扩展与应用 DSN 归属，不直接将新镜像挂旧卷；生产 PG/PVC、共享 Gateway/Ingress 保持。另一拓扑候选包含删除数据库/PVC的步骤，不得套用。新服务 RC 仍须包含 Gateway 启动失败清理修复并通过两次原始全套。

- 新开发提交 `b4a78f5ee0088eb1a525d5b0faf132877ca1f343` 已正常推进 `codex/agentfs-mounted-platform-acceptance`，主线未动。两次原始全套 [run 37303939235](https://github.com/undefinedsco/xpod/actions/runs/37303939235) 已由 ROOT 独立验收：实际 `bun run test:integration` 各退出 0，均为 preflight 30 / Lite 163 pass + 16 原有 skip / Full 63 pass，耗时 291.118 / 274.120 秒。两轮源码清洁稳定、实际进程闭合、自有 container/volume/network 均已清空，原始日志 SHA `fe51e53d…` / `f9c10445…`，ROOT review `65103dcb…`。该结论仅属于 b4 源码，不覆盖后续合并源码。显式 `native=false` 的既有 CI 入口实际通过双平台 ZIP、源码、stage、helper 与 ABI 复用检查，默认/push 仍跑原生；原生包仍固定 056d。复用守门新增回归后 Python 44 项 / 43 通过 / 1 原有 skip，不新增依赖。

- GZ 显式 443 候选经独立审查补齐临时 Secret 创建响应的 birth UID、未知创建结果保留及成功/失败 stderr 防泄露；最终 34 项 MOCK guard / 34 通过 / 0 失败，review `c80b144d…`。新 nonce `sol-pg443-20261005` 已准许运行真实全 16/17，仅新增一个同 repo 授权的自有 Secret，保持镜像156原内容、模块、TLS、原 validator 与 timeout；运行结果待实证。
- 首轮 b4 真实挂载已失败，记录为实际 8 pass / 2 fail / 2 skip，不能将包含 skip 的摘要计成 10 业务通过。新 consumer 错用初始共享夹具内容，已改为挂载前直接读取 origin 基线。Mac 最初怀疑 PATH 过滤隐藏 rg；后续 `fd872b0…` [run 37305719573](https://github.com/undefinedsco/xpod/actions/runs/37305719573) 的过滤前探测实际证明 runner 未安装 rg，因此该假设被否定，需安装测试工具再验。Linux 已执行普通 shell、已安装 CLI/PATH rg 和实际 Git/worktree，但标准 `--separate-git-dir` 的 main list 路径为宿主 gitdir，旧测试预期错误；改用 mounted main/linked 的实际 `--show-toplevel` 加 exact list/HEAD 检查，不删除真实内容操作。
- Linux 64MiB RSS read 42500KiB / copy-up 46600KiB 已测，512MiB 首次 copy-up 在实际 60,015.489ms 后返回 `EIO/-5/write`，1024MiB 尚未执行。该时间与 HTTP 60s deadline 接近，仍不能仅凭时长确定根因。夹具 `responseBytes=536870912` 在 pipe 前赋值，仅表示计划长度，不是实际消费完正文的证据。下一步在原 `copy_to` 的 HTTP/chunk/file-write/fsync 失败处记录阶段、实际 chunk 字节和受限错误类型，保留原错误返回、大小、timeout 与 RSS 门槛。
- 已发布 [v0.4.25](https://github.com/undefinedsco/xpod/releases/tag/v0.4.25) 的源码为 `a1cec27fa11d5447e0bc0a18373be7250e30d476`，含慢 Representation 锁续租、认证与分发修复。最终开发分支以它为第一父提交，正常合并 AgentFS 提交链，不能从旧 0.4.24 候选倒退发布。两侧存在七处文本冲突，须保留两侧行为和验证。根 package/lock 与 source-kit 输入会改变，因此最终源码必须重跑双平台 `native:true`、打包安装、实际挂载和两次原全套；旧通过收据不重标。固定 QLever SDK/PG156 可保留，新服务与 PG 的实际组合仍需 GZ 验收。
