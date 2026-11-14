# 开发子代理效果与效率记录

> 当前状态（2026-10-04，账号 B / opencode-go/deepseek-v4.1-flash；本页旧段落均为 HISTORICAL）
> - 当前唯一实现子代理是账号 B（`opencode-go/deepseek-v4.1-flash`）；仅 **CONFIRMED HTTP429** 才转 GPT‑6.1 Sol。旧文“当前主线使用 GPT‑6.1 Sol 子代理”为历史状态。
> - 当前源码：`codex/agentfs-current-release` HEAD `5ce81c679cf7ba0aab82b277a44b3ea469bcc72d`；native HEAD `8d4983c96e9942b8edeb7912659017d5e98762e4`。原生 CI [run 37146470600](https://github.com/undefinedsco/xpod/actions/runs/37146470600) 两 ARM runner 串行成功；服务候选 [run 37148085189](https://github.com/undefinedsco/xpod/actions/runs/37148085189) 只发布 exact 镜像 `ghcr.io/undefinedsco/xpod@sha256:fd2ee44323e3412c9b43e4ee31d4d9aeb6b512bb2524e9907c6c66cd50fb8428`，deploy 在 registry-authority 预检前失败。
> - 实际平台准入（kit5）：macOS NFS 间歇失败（重挂退出 75 `unknown runtime entry retained`），64/512/1024 MiB 与 SIGKILL 崩溃恢复阶段未通过；Linux Docker bookworm FUSE 因 helper 需 `GLIBC_2.39`/`libssl.so.3` 加载失败。远程 bounded clean-body 缓存仍 NOT IMPLEMENTED。下方各模型样本的事实（任务/API 效果）保留。

日期：2026-10-03，Asia/Shanghai。范围为 Xpod 当前开发记录，不是通用模型排行榜。

历史状态（HISTORICAL）：当前主线使用 GPT‑6.1 Sol 子代理实现和测试，负责人设计、独立验收与发布。DeepSeek v4.1 Flash 已交付的代码保留。没有用不同任务的耗时计算模型速度倍率。

## 实际交付

| 样本 | 范围 | 实际结果 | 已记录时间 |
| --- | --- | --- | --- |
| DeepSeek / account B，兼容整合 | 24 个源码/测试/CI 路径 | 完整集成退出 0，但运行入口/SDK/生成产物前后快照不足，日志流关闭证据有缺口；后续独立复审要求修复 | 29 分 20 秒 |
| DeepSeek，首轮修复及同 session 续接 | 4 个诊断/错误处理路径 | 两次自然退出 0，却未交完整 FINAL；复审仍有三个问题，不能按退出码计任务成功 | 6 分 39 秒 + 11 分 48 秒 |
| DeepSeek，新 session 修复 | 同 4 路径 | 三组负例转正，40 单测通过，编译门禁退出 0；独立复审又发现输出路径先 chmod 后校验 | 11 分 38 秒 |
| DeepSeek，输出边界续接 | 2 路径 | 只加入测试用 import；没有断言、产品修复或实际测试，最后 API 连接失败，退出 1 | 53 分 49 秒 |
| GPT‑6.1 Sol，接手输出边界 | 同 2 路径 | 43 单测、直接编译门禁通过，独立 8 项真实 Bun 探针无剩余问题，另外 27 个文件不变 | 10 分 11 秒 |

Sol 的仪器起点在读完初始契约之后，未包含此前阅读时间。它同样经历一次复审返工：首次修改移除了新工作区自动创建 `.test-data` 的能力，补负例后修正。最终两次产品编辑、三次测试编辑；并非无需审核。

新增 Sol 样本进一步区分交付与验收：

| 样本 | 结果与独立复核 | 耗时边界 |
| --- | --- | --- |
| 私有 QLever 合同，12 路径 | 原静态门禁通过后，复审发现容器创建成功／启动失败时漏清理；修复后四项原组合、两项新分支和 existing-RC 门禁通过，负责人接受合同实现。未运行实际镜像或 RC | 首轮没有完整总墙钟记录；一次返工记录 5 分 48 秒 |
| 发布构建文档认证，3 路径 | 旧实现六项负例失败；修复后 28 通过／1 项真实材料测试跳过；负责人接受代码，实际 CI 冷缓存下载仍待验证 | 已记录工作区间 2 分 21 秒，含工具执行 |
| ChatKit 超时诊断 | 原文件单次独立诊断 22 项通过，不能声称修复原完整测试的两个超时；新增默认失败快照 | producer 墙钟 92.37 秒；wrapper 未记录 PID，不补造 |
| 子进程输出收集，4 个测试路径 | 旧实现两项负例失败；保留原 12+2 子进程的实际测试通过。一次复审后合并重复 validator／protocol 回归，最终共享 helper 17 项通过。未证明原 CI 根因或产品密钥竞争 | 首轮记录 5 分 54 秒；实际两组测试约 4.61 秒；最终 helper 2.84 秒，不据此计算模型速度 |
| Native HTTP 与临时文件，2 个 Rust 路径 | 旧实现的超长 206、路径替换、缺失 manifest 三项回归实际失败；修复后完整 37 项通过，包含 HTTP body 中取消及真实 owned child SIGKILL。独立复审两项边界问题已关闭；新安装产物随后通过 Mac 四项实际 NFS 功能测试。64／512／1024MiB 功能与固定 RSS 门禁通过；安装后传输中 SIGKILL 已执行，但死 NFS 清理失败，恢复 GC 尚未进入，整轮仍失败 | 记录工作区间 35 分 9 秒，包含串行排队；其中 Cargo 拉取、编译及测试累计 14 分 20 秒。不能相减后视为模型推理时间 |

新的 source-kit 重建及安装样本：锁定依赖导出、独立校验、实际构建与 37 项测试、包装、独立安装五个成功门禁均自然退出 0；最初离线导出因锁定依赖缓存不足退出 1，保留失败后才执行明确的联网导出。真正 Cargo 重建约 480.77 秒、包装 61.12 秒、独立安装 13.15 秒，是工具执行时间。optional debug stripping 的 rust-objcopy 缺 libLLVM 并 SIGABRT，编译、测试与安装成功不意味着符号裁剪成功。最后 Sol 的 remote compact 连接错误发生在产物和最终回执落盘后；这与此前 DeepSeek 在实现/测试未交付时的 API 连接失败属于不同完成边界，不算通用可靠性倍率。

这些新增任务没有对应的 DeepSeek 同任务样本，只支持当前 Sol 交付的可审查程度。私有合同的复审漏项说明：静态门禁通过仍需要独立检查错误与清理分支。

最新公共 admission 两套件 90 项通过，最终私有 producer 绑定又用 31 项测试核验；实际测试累计约 135.06 秒，任务墙钟 1441.22 秒包含等待私有 lane 与负责人冻结窗口，不能全部算成模型工作时间。后续私有 producer 复审发现最终 receipt 写入失败会覆盖原错误：真实 EACCES 负例先复现，再以六项回归修复，测试约 71.95 秒。绑定随该修复再次更新。这是跨 lane 依赖与独立审查成本，不能把首次通过当成无需返工的交付。

私有最终原始 `bun run test:qlever-isolated-rc` 通过 Python 15 项和 Bun 六文件 57 项，producer 实际 0/null、231.073 秒，覆盖源码及 SDK 前后稳定。首次因未提供既定公共源码路径 ENV 而失败，耗时 15.157 秒；补齐这两个输入后重跑，没有更改门禁。该前提遗漏也计入监督成本，两轮均不代表实际 PG 镜像或 RC 已验收。

负责人对公共源码、测试类型和组件生成直接运行三个门禁，实际均退出 0，约 25.78、41.07、6.36 秒；6,131 个覆盖路径前后无变化。该结果不替代完整集成或真实 Gateway/Pod 验收。 随后原始完整集成实际退出 0、204.89 秒：Lite 162 通过/16 跳过、Full 62 全通过；8,277 项覆盖路径前后稳定。它证明当前隔离集成，仍不代表新原生 RC 或实际登录身份通过。

Native 首次锁定依赖冷编译与红回归用了约 11 分钟，不能当成模型工作耗时。37 项源码单测通过仍不能证明安装后大文件操作的内存上界或 NAS 跨主机锁行为。

新增安装后大文件夹具的三档实际通过，helper 采样峰值约 21.125MiB；这是本机 synthetic HTTP/NFS 结果，不外推 WAN 或原生 FS 性能。整轮失败在崩溃后的 NFS 清理，恢复 GC 尚未执行。负责人随后对死挂载调用 metadata、Sol 恢复 lane 递归发现测试目录，分别留下阻塞的只读进程；这两次可避免的操作及恢复工作也计入监督成本。首次有界 RPC 拒绝响应恢复实际退出 0、58.286 秒，但未解除内核等待，不能计为修复成功。用户授权后，仅删除已通过测试的三档正文和已结束编译缓存，保留结果、安装候选、源码包与失败现场。

第二次NFS错误回复恢复实际58.569秒，16个未知header被拒绝，实际未发错误回复；该次也未解除等待，且超过58秒窗口0.569秒。第三次先补NULL及header分类回归，再以19.814秒的有界服务发送9个NULL、37个NFS错误回复，随后原测试producer实际1/null闭合。负责人另外执行owned强制分离，实际0/null、1.061秒，并核验最新挂载缺项。此过程是运维恢复，原夹具仍失败；协议测试与恢复操作都应计入交付成本，不能把listener退出0当作产品验收0。

DeepSeek 最后一次的 API 连接故障没有 HTTP 429 证据。长等待属于所用服务链路的可靠性样本，不能全部归为推理时间；其失败也不能被忽略，因为实际交付仍受影响。机器同时运行其他工作区编译，16GiB 内存且存在重度 swap；工具耗时必须与模型工作分开看。

后续 RC 类型检查另外观察到 UTC 起止相差约 16 分 51 秒，单调计时却是 40.938 秒；原因尚未确认，不能据此判断是暂停还是时钟调整。该样本保留两套原始时间，不计入模型速度比较。表中已有仪器耗时也不等于扣除工具、等待和阅读后的模型工作时间。

## 决策与限制

客户端流诊断本轮又经历两项独立审查返工：reader getter / Promise then 的观测异常隔离，以及 hook / abort 监听失败时 coverage 与 EOS 的准确降级。三项新增负例先失败、原 34 项仍通过，修后 40 项通过，源码与测试类型检查闭合；负责人构建实际 0/null、10.655 秒。负责人首次直接重放 Vitest 遗漏集成凭据初始化，producer 64595 实际退出 1、4.158 秒、执行 0 tests；这项监督失误计入成本，不能当产品失败。随后经现有 Lite 初始化运行原 Matrix 单文件，producer 68039 实际 0/null、72.286 秒、1 test 通过，源码／SDK／产物快照稳定；成功路径没有保留 raw stream 证据，仍不证明完整集成或旧长请求已修复。

上述卸载冻结材料的第二次实际构建进入 helper 后发现 E0507，producer 419.717 秒、实际退出 1、原生测试未运行。Sol 最小修正及 Pending 诊断经历了独立复审：草案曾误用 tuple enum、在 socket 已删除后仍要求它存在，并依赖调度计时；这些被修正后，又发现真实 pipe 未设置 CLOEXEC 可被并行 child 继承，最终改为标准 UnixStream 屏障。当时只有源码复审接受，尚无新 Rust green 或安装结果。这些编译与复审返工属于有效交付成本，不因模型名称省略。

负责人准备 preview.2 时遗漏了入口的重复版本常量，实际包测试 49 通过／1 失败；统一引用 manifest 后 50 项通过。严格包类型检查另发现一处旧测试 expect 参数与项目声明不匹配，准确修正后通过。此类负责人遗漏也计入监督成本；原始失败与修正后的闭合结果分别保存，不能只选取绿色样本。

最新 `9460a7e` 的 Sol Task 失败诊断样本覆盖十个源码／测试／workflow 路径。独立复审关闭了误入 resume 的变量引用、首个 failed snapshot 被后续查询掩盖、cleanup 断言混淆以及两个真实 await stage 缺口；首次实际专项五文件 77 项通过，producer 13.705 秒。未记录完整任务总墙钟，不将专项耗时当模型开发时间；真实 RC 根因和新 RC 尚未验证。

新增 native 卸载生命周期曾通过只读复审及六项 CLI 夹具；首次官方隔离 Cargo producer 在 764.594 秒后因 ENOSPC 退出 1，第二轮在 419.717 秒后遇 E0507，均未进入原生单测。监督器首次与产物目录重合的记录错误单独保留，后续监督与产物目录分开。Pending 退出信息诊断已修订；第三轮 kit3 的 helper 编译通过，但 producer PID 95501 实际退出 1/null、385.645 秒，单测 55 通过／1 失败／2 忽略，没有成功构建回执。失败测试以固定 sleep 推断 child 已退出，实际同一 child 仍在运行。现在只在测试中改为 CLOEXEC socket 屏障及同 PID 退出观察，产品期限未变；当时尚无修后 Rust green 或安装结果。编译失败、测试同步返工和负责人审查均计入交付成本，工具墙钟不等同模型推理时间。

Linux preview.2 安装验收夹具经过四个 revision 和独立复审。返工包括 helper 未实际 wait、日志短写、host 与容器权限命名空间混用及不可达清理代码。revision4 保留 91/91 原功能行的顺序；63 项纯契约保留原 27 与此前 55 项覆盖。12 项小进程检查对应 7 个实际 spawned child 和一个 EACCES 无 PID 场景，验证晚 EOF、实际退出、短写及失败分类，不能当作 Linux 挂载通过。新冻结材料、Linux ARM64 原生构建、官方安装与实际 FUSE 仍待验证；本轮大文件/RSS、SIGKILL seed GC 和真实 Gateway 尚未通过。新增覆盖和修复审查缺陷分别记录，不能将全部轮次归为同一缺陷反复失败。

上述 Lite 162／16、Full 62 全绿仅证明当时材料。最新原始 Lite&&Full producer PID 33124 实际退出 1/null、524.970 秒：Lite 161 通过／1 失败／16 跳过，Full 未进入。Matrix PUT 约 244.141 秒后返回 500；阶段证据显示写入前的 events.select 等待超时，具体根因未定。8,710 项覆盖快照及 HEAD/status 稳定，三个日志闭合后核验哈希。当时当前完整集成仍失败，不能沿用历史全绿晋级；后续新结果按下段另行记录，不覆盖这一失败样本。新任务没有 DeepSeek 同任务对照，不据此推算模型速度或总费用倍率。

后续完整入口 producer 83821 实际 1/null、203.217 秒，Lite 162／16 通过，Full 启动遇到 local ingress 与待启动 standalone Gateway 的端口冲突；这是测试启动器隔离缺口。Sol 两文件修复经过两个 RED，其中一个使用真实 ingress allocator；类型检查还发现 mock namespace 类型错误，修正记录保留。原三文件组合最终 29 项通过（原 24 + 新 5），保留外部环境／预留文件、显式端口 listener、失败 cleanup 的原错误等断言。负责人独立审查并运行修后原始完整链，producer 13991 实际 0/null、201.617 秒，Lite 162 通过／16 跳过、Full 62 全通过，8,710 项快照与 HEAD/status 稳定，日志闭合及 owned 清理核验通过。没有完整模型工作墙钟，这两次 producer 工具耗时不能变成 Sol 编码速度；真实 Gateway 与修后原生安装验收仍未完成。

磁盘清理与构建准备也有监督成本：kit3 完整归档后退休展开目录，首次 process guard 用字符串前缀误判自己的退休脚本，删除前拒绝；补精确路径边界并保留负例后完成。kit4 官方离线导出成功且逐文件独立核对，随后两次 fresh 容量拒绝发生在 native producer 启动前，没有 Rust 测试结果。用户授权清理旧已验收副本后仍保留当前缓存和失败日志，不将预检拒绝归为模型实现失败或编译绿色。

修后 kit4 producer 20682 实际 0/null、435.554 秒，完整 native 56 passed / 0 failed / 2 ignored；负责人独立核验全部 21,280 源文件。结果整理首次误把名称含 ignored 的通过用例计为忽略，纠正解析后保存准确 58 项清单，未重跑 native 或覆盖失败证据。随后本地 Mac 包装约 44.11 秒，两次官方安装验证各约 12 秒、各 770 项通过。负责人读取 manifest 时误取不存在字段，以及快照比较误用可选 accessor，均纠正为直接验证实际字段和完整 8,710 项字典；这些仪器错误也计入监督成本。

测试清理保护又经两项 P2 复审：父级 NFS/FUSE 挂载重叠，以及删除错误被泛化覆盖。修后 16 项通过、测试类型检查通过；保留首轮负例和中间语法失败。新版 installed Mac 两套件随后实际失败：producer 74818 为 1/null、7.015 秒，2 parser 通过、4 失败、2 占位跳过。内核已无挂载，但卸载客户端返回 1，保护机制保留现场；后续系统 closed 回执与 helper 重放均正常，当前仍须诊断及修复。单元／安装校验绿色不能代替真实挂载结果。Linux 当前仅完成工具材料与 cached-image 只读能力检查。上述任务无匹配的 DeepSeek 对照，工具时间与返工记录不用于模型速度倍率。

新增诊断复验 83221 实际失败，保留 stderr 后才证明两处卸载竞态；Sol 的最小修复已由负责人独立审查，不能将源码接受算作 native 通过。kit5 核验中负责人先误用 registry 包计数字段、再误用文件 size 字段，修正解析后完整 21,280 文件核验通过，这两次是负责人仪器错误。后续 whole 13395 因负责人设计的反复 Docker create 容量探针超过人为 1 秒观察期限而被停止，结果未知；改成独占持续探针的三次实际采样低于 0.1 秒，7 项失败保护通过，原产品测试期限未变。这些编排返工不应算成 Sol 产品代码错误，也不能用轻量绿色替代 whole。最新 release 419 路径整合及 Private17 CI 接线是新增范围，没有 DeepSeek 匹配样本。

最新 combined 0.4.24 原始完整集成由 Sol 执行，producer 50759 实际 0/null、343.921 秒，前置 30 项、Lite 163 通过/16 跳过、Full 63 全通过。ROOT 独立复验 8,916 项正文、集合、日志及所属资源清理；该工具耗时不代表模型推理速度。Private17 CI 接线门禁为 Python 77+Bun 35，隔离链为 Python 15+Bun 57；Sol 在复审中自行发现并修正 job-env 的 GitHub context 不适用问题。ROOT 最初核对 staged patch 遗漏 --full-index，以及读取快照时把 states 列表当成字典，均纠正后完成真实验证；这些是监督工具错误。真实 RC／SealOS 与最新 Rust 安装仍未通过，不将静态和隔离绿色计为远程交付完成。

RC234 的真实失败随后由两个 Sol lane 修复：registry 地址兼容与安全分类，以及 SDK 干净消费者的 JOSE 加载边界。SDK 原始 consumer RED 为 9.427 秒；修后原七包 consumer 为 14.211 秒，源码和测试类型门禁分别为 10.220 与 15.946 秒，均实际退出0。这是命令时间，不是开发墙钟。SDK 没有通过加安装后补丁降低 clean consumer 契约，压缩包增加约248KB，许可文本随包核对。registry 最终相关5项及 ROOT 独立复验通过；后续真实探测证实 namespace secret 根本缺少 CCR entry，不能将兼容修复冒称远程认证已打通。

私有 Sol lane 增加保密 TLS 诊断，84 Python+35 Bun/type 门禁通过，实际诊断 CI 仍保留 TLS 失败，producer 未启动。随后依据运维文档找到已有可信 CO 配置，实际 TLS/namespace 认证通过，并恢复同一个 CI secret；没有抓取未知 CA 当信任根或绕过验证。新增测试 class 先放在 main guard 后面，ROOT 在提交前要求移至 guard 前；失败私密 artifact 与实际超时边界也补齐。ROOT 另一次复验误用40秒监督已有约72秒的整文件测试，监督器超时且产品退出未知；确认所属进程组消失后，以正确的最终相关测试复验通过。这个监督预算错误不算 Sol 产品失败。此批任务仍没有匹配的 DeepSeek 同任务费用或开发墙钟对照，远程交付尚未完成。

这条 Xpod 主线暂以 Sol 作为实现子代理：已有任务接手、边界修复和完整产物交付的有效样本，新的原生客户端重建、打包与独立安装验证闭合后，Sol 子代理发生 remote compact 连接失败；源绑定 final manifest 与实际回执已落盘，负责人仍能独立验收。该传输故障应计入可靠性，不能写成 Sol 链路从不失败。权限、持久化、错误优先级和部署门禁继续独立复核，不以模型名称替代验收。

DeepSeek 的 24 路径任务表明它能执行批量改动；范围明确、验证自动化充分、服务可用时，仍可作为成本敏感任务的候选。但本轮出现提前结束、缺少收口、工具文本未执行及反复边界修复，负责人监督成本必须计入。Sol 的任务更小且继承既有实现，不能据此宣称它总体编码能力或平均速度胜出。

最终比较应记录：成功验收率、首次复审问题、返工轮数、有效开发时间、命令/编译时间、API 等待、负责人审查成本、每个成功任务的总费用。OpenCode 输出的 cost/usage 是工具报告，尚未核对真实账单；Sol 此次实际费用不可取得，所以目前没有可靠的总成本优胜结论。

此评价方法与 [OpenAI 官方按工作负载选择模型的指南](https://developers.openai.com/api/docs/guides/deployment-checklist#choose-a-model-for-the-workload) 一致：用代表性任务比较成功率、延迟和每次成功成本。该来源仅支持方法和 OpenAI 模型定位，不提供 DeepSeek 的效果证据。

原始日志与 producer/哈希回执保存在本次工作区 ignored `.test-data/agent-directory-workers/` 的 `opencode-go-b-current-release-*`、`gpt-6.1-sol-output-boundary`、`root-model-worker-comparison` 目录，均按私密证据管理，不随仓库公开。后续私有 QLever 合同与原生客户端任务完成后，追加样本，不改写已有结果。

最终修复版原始完整集成 producer 实际 0/null、315.520 秒：前置 30、Lite 163 通过／16 跳过、Full 63 全通过。负责人独立验证 8,919 个正文与前后快照、闭合日志及专属进程／容器／卷缺项；这仍是隔离集成证据，不代表新 RC 或 SealOS 已通过。

## 2026-10-04 状态更新（账号 B / deepseek-v4.1-flash）

- 当前源码（HEAD `59224e54` / native `8d4983c96`）的原固定 Bun 1.4.2 完整集成在本机以脱离 shell 生命周期的监督器实际 `Popen.wait` exit 0/null、399.152s：preflight 30、Lite 163+16skip、Full 63；8,920 正文与外部 native 五文件前后一致，专属进程/容器/卷已清理。
- 原生 CI [run 37146470600](https://github.com/undefinedsco/xpod/actions/runs/37146470600) 两 ARM runner 串行成功：在线导出 → `--verify-only` → `--frozen` 重建 60（58/2/0）→ kit5 打包 → `install-verified`。
- kit5 实际平台准入（账号 B，本 worktree）：macOS NFS 用 kit5 helper（`2d4a7360…`）跑 tracked `nativeOverlayScenario.test.ts` 间歇失败（重挂退出 75 `unknown runtime entry retained; daemon retained_pid=… pending actual_wait=null`）；64/512/1024 MiB 三项实际 PASS，SIGKILL 崩溃恢复 FAIL（writer `write-completed`）。Linux Docker `node:22-bookworm-slim`（Node22，无 Bun）FUSE 加载失败：helper 需 `GLIBC_2.39` + `libssl.so.3/libcrypto.so.3`，bookworm glibc 2.36。无残留 mount/daemon/owned 容器。
- 仍未验收：真实 OS 挂载（macOS NFS / Linux bookworm FUSE）、SIGKILL 恢复/GC、dirty412 负载；live Gateway、公开 preview.2。远程 bounded clean-body 缓存仍 NOT IMPLEMENTED。历史失败证据与 Sol 记录保持不变。
