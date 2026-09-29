# Symphony 决策模型与分发能力联合升级设计

## 状态与范围

2026-09-26：设计与代码差距分析，**未进入实现，未通过运行时验收**。
用户明确要求本轮只写文档、检查模块、形成与 Symphony 一起升级和验收的方案。
此前误开展的三家 provider 代码与测试已撤回；不得把那些测试结果作为本方案交付证据。

本方案以 Xpod 为被验收系统，覆盖 Jev 类决策模型、用户提到的本地 Laya、前台分发、后台执行、多方案 Delivery、分支更新，以及 AI Connections 新增 OpenCode / TypeSafe / OpenRouter。
“可保存凭据”不能替代“决策能力可用”的目标。若未来分阶段发布，必须明示阶段能力与未完成项。
本轮不安装模型、不新增依赖、不发布插件、不部署服务。

代码检查基线：Xpod `c2fd4b06`，按当前工作区读取，存在其他在途变更，不等同于干净提交。
本方案是 **Xpod case 用例**：Symphony 是组织、分发和验收用例的控制方法，不是 LinX 产品功能。LinX 不在改动、依赖或发布范围内。
Symphony 源码插件为本地 `0.3.32` 文档草案；本会话可用的已安装 skill 路径为 `0.3.31`。源码版本、安装版本、运行时支持和验收状态必须分别记录。

## 目标链路与职责

```text
用户提出需求 / 变更
  → 前台 AI：更新需求与验收文档，观察全部执行线
  → 决策能力：Jev / 本地 Laya，在明确候选项中判断
  → 前台校验并记录分发决定
  → 现有 Reconciler / Scheduler：执行调度
  → 后台 AI：代码、实验、测试、Git、Delivery / 比较报告
  → 前台 + Symphony：核对当前需求、证据并验收
  → 合入事件：推动跟踪同一目标分支的执行线更新、重验、ACK
```

- 前台 AI 负责文档、语义判断、分发、观察和验收，不承担后台实现。实际 Git、构建、测试由执行 owner 完成。
- 决策模型负责有界选择，不直接执行工具、扩大权限或关闭任务。无法判断先升级到前台；前台无法在现有意图与授权内判断，再问用户。
- 每个完整任务默认一个后台 owner 做到底；多方案可由同一个人研究和比较，不默认拆成多个角色。
- 多条独立代码执行线各用 worktree；同一执行线的协作者共享该线工作区。只做备选分析无需创建 worktree。
- 控制面状态仍使用既有 Spec / Task / Run / Delivery / Evidence / Report 及相关资源，不再建一套调度器或任务库。

## 当前模块与建议修改面

以下是 Xpod 源码检查结论，不是全系统运行证明。Symphony skill 源码链接仅作为用例执行规则的依据。

| 模块 | 当前可复用能力 / 已观察事实 | 联合升级需要处理的差距 |
| --- | --- | --- |
| [provider-catalog](../packages/ai-connections/src/contract/provider-catalog.ts) 与 [client types](../packages/ai-connections/src/contract/client/types.ts) | offering 声明包含授权、endpoint、模型发现；provider 联合当前不含新增三家，发现模型类型为 chat / embedding | 新增三家目录；明确决策能力。先对齐共享 schema，不用 chat 冒充 decision |
| [controller](../packages/ai-connections/src/controller.tsx)、[display wording](../packages/ai-connections/src/display-wording.ts)、[offering details](../packages/ai-connections/src/AiOfferingDetails.tsx) | 已有连接列表、授权和详情 UI；存在分散显示映射 | 从统一声明提供名称、能力、不可用原因；不继续增加按 provider 身份分支 |
| [ProviderRegistry](../src/api/ai-gateway/providers/ProviderRegistry.ts) | descriptor、offering 和能力注册机制 | 复用注册机制；`defaultUpstreamCapabilities` 当前对 unsupported discovery 仍生成 models 能力，应修正声明一致性 |
| [Gateway types](../src/api/ai-gateway/types.ts) | `GatewayProtocol` 为 responses / anthropic / chatCompletions；请求围绕 messages/tools | 决策输入 state/questions 与结构化输出不能强塞聊天消息。设计同一能力注册体系下的 decision adapter，优先通用协议实现 |
| [ProviderModelsAdapter](../src/api/ai-gateway/models/ProviderModelsAdapter.ts)、[ProviderModelSelectionService](../src/api/ai-gateway/models/ProviderModelSelectionService.ts) | 已有模型发现和目录内选择 | 按模型真实协议选择；缺协议应明确未知/不可调用，不能按名称猜。保留空目录阻止手动绕过的约束 |
| [ProviderConnectAdapters](../tests/api/ai-gateway/ProviderConnectAdapters.test.ts) 对应连接机制 | 通用 API Key、浏览器辅助申请、Pod 凭据存储可复用 | 新 provider 使用同一机制；不为 Jev / Laya 再包一层账号 Session 或建立第二份凭据 |
| [Xpod ServerGroupReconcilerService](../src/api/reconciler/ServerGroupReconcilerService.ts)、[WakeAgentQueue](../src/api/reconciler/WakeAgentQueue.ts) | 已有目标选择、入队及队列能力；读取的方法按 actor/role 等过滤消息 | 明确控制事件进入路径，不能把模型选择塞进通用 wake 层；在 Xpod case 中验证控制事件与执行端的责任，防止重复派发 |
| Symphony [skill](../../marketplace/plugins/linx-symphony/skills/symphony/SKILL.md) 与 [decision-dispatch](../../marketplace/plugins/linx-symphony/skills/symphony/references/decision-dispatch.md) | 源码草案已描述前后台、选择升级、单 owner 和合入反馈 | 对照 Xpod case 补齐规则与例子；发布 skill 不等于 Xpod case 通过 |

数据归属遵循 [catalog ownership](catalog-ownership.md)、[extension abstraction](extension-abstraction.md) 和 [reconciler boundary](reconciler-wake-runtime.md)：schema 进 models，目录和协议能力跟能力模块，产品行为留 app/runtime。只补必要边界，优先复用。

## Xpod case 与 Symphony 的边界

- 验收宿主确定为 **DSH（DeepSeek Harness）**：DSH 承载前台/后台执行，Symphony 提供控制规则，Xpod 是被验收系统。Codex 仅用于准备和审查，不作为执行链路的隐含依赖。更换验收宿主不等于把 DSH 内核集成进 Xpod 产品。

- Xpod 提供连接配置、凭据/Pod 访问、模型协议适配和已有运行服务；需要新增什么产品能力，由 case 证据及模块差距决定。
- Symphony skill 提供前台文档、分发、选择升级、Delivery 和验收规则；本轮升级的是这些规则及 Xpod 用例说明。
- 后台执行宿主使用现有工具启动任务、管理 worktree、执行 Git 和测试。宿主能力与 Xpod 服务能力分别留证，不把工作树管理强行塞入 Gateway。
- case 使用文档、执行记录和证据串起两者；它不是第二套产品业务状态库。需要写入 Pod 的内容发现既有模型描述，缺口提交 models 设计。
- 通过标准是 Xpod case 的完整闭环，不以 LinX UI、LinX store 或 LinX 发布作为前置条件。

## Provider 与决策协议设计

| 接入项 | 已查证的协议事实 | 设计要求 |
| --- | --- | --- |
| OpenRouter | OpenAI-compatible API，基础地址 `https://openrouter.ai/api/v1` | 复用兼容 adapter 和模型发现；具体模型能力仍需核实。目录中出现 Jev 名称不能证明支持 System One |
| OpenCode Zen | 官方文档按模型列 Responses、Messages、Chat Completions、System One 等入口；观察到的 `/models` 条目未带逐模型协议 | 先确定权威协议元数据来源或用户可验证声明，不做模型名称特判表；未知协议不能默认 chat |
| TypeSafe AI / Jev | `POST https://api.typesafe.ai/v1/systemone`，state/model/questions 结构 | 增加决策能力适配与真实调用验收；不能通过 chat/completions 假接。未找到可直接复用的模型发现契约，需明确录入/目录策略 |
| 本地 Laya | 上游提供 typed choice / score / noul 接口 | 接入本机实际可用入口，记录版本、checkpoint、上下文限制与 readiness；不假定与 Jev JSON 完全相同 |

用户说明本地有 Laya；本轮尚未定位并验证其实际安装入口，因此不填写猜测端口、模型版本或可用性。
实施前应发现现有服务/工具配置并读部署版本契约，避免重复安装。Laya 上游已读，但上游能力不证明本机可用。

统一的是“有界决策能力”语义，不强求所有 provider 同一 wire 格式：输入来源修订、状态摘要、问题类型、候选项、约束；输出有效选项/分数、可用置信信息、模型版本、校验结果。具体共享字段由 models 审查确定。
凭据、用户选择、endpoint 等用户配置沿用 Pod 配置；程序支持哪些协议仍在程序声明，不写进用户数据。

调用策略：

1. 硬规则先排除无权限、必需测试失败、证据缺失、过期修订等不可选动作。
2. 对仍需语义判断的候选调用决策模型，提供显式 abstain/escalate 选项。
3. 按 checkpoint、语言、决策任务校准阈值；不能使用未经评测的统一置信度门槛。
4. 超时、格式错误、未知选项、上下文不足、低置信或候选接近时交前台处理；记录替代判断者。
5. 应用前再次匹配文档和代码基线，由 runtime 条件更新并去重。单纯“先读再写”不足以防并发。
6. local-only 内容不能静默转云；即便前台本身托管也须遵守同一边界，必要时保持 pending。

## 变更准入与前台观察

实施一致性新增三项基准：提问候选含“升级前台”；实际文件变更后触发通用检查；实施文档首次读取后仅在变更或上下文缺失时补读；验收 AI 对照文档与 diff，有偏差 steer，无偏差仅标本次检查通过，TODO 全部验收条件满足后才打勾。行为、钩子边界与对照实验见 [DSH 基准](testing/symphony-dsh-baseline.md)。这些是拟实现要求，不代表宿主已支持。

前台先读取全部执行线的轻量概况，再读受影响线的详细记录：owner、Task/Thread、Run 状态、更新时间、文档修订、工作区、代码基线、依赖、Delivery、待确认变更。无法观察记 unknown，不能据此推断空闲。

| 输入情况 | 处置 | 必需记录与后果 |
| --- | --- | --- |
| 同目标、兼容、小范围追加 | 追加当前任务 | 先更新权威文档，再发 delta；目标 rev 与已 ACK rev 分开 |
| 独立需求、容量不足、打断临近验收收益低 | 下一批 | 记录理由、优先级、依赖与就绪条件；不改当前验收 |
| 纠正使当前接口/目标失效 | 立即修订或 supersede | 先记录失效和暂停意图，再让 owner 到安全点，决定恢复/重启/取消 |
| 已有任务覆盖 | 关联已有工作 | 不重复派发 |
| 意图或授权无法判断 | 前台判断，必要时问用户 | 记录 pending 决策及所需输入，其他独立线可继续 |

“下一批”是需求集合与准入条件，不是固定时间窗或全员屏障。合入、容量释放、验收完成、优先级变化时重新判断。
delta 必须带权威记录、修订、失效假设、变更验收、预期安全点；未 ACK 不能显示已生效。

### 需求变更执行协议

1. 前台根据现有任务、依赖和验收判断影响，选择追加、下一批、立即修订或关联已有。验收 AI 发现需求冲突时提出变更请求，不自行修改需求。
2. 前台先更新权威文档，记录新旧修订、变更理由、失效要求、受影响 TODO/文件/测试及执行处置。下一批需求不改变当前任务的验收。
3. 将同一修订 delta 通知受影响的执行者和验收 AI。分别记录执行者已 ACK 修订、验收所依据修订；文档已更新不代表所有参与者已切换。
4. 执行者在安全点确认。兼容追加可继续；使原目标或接口失效的变更暂停相关工作，由前台决定修正、重启或取消。保留已有改动与证据，不自动清空 worktree。
5. 重新核对受影响 TODO。旧通过记录保留历史，但失效证据不能继续支撑勾选；无关 TODO 经影响判断后保留。旧检查、steer 和 Delivery 只能作为历史证据，不直接应用于新修订。
6. 新修订下的实现与验证完成后，按文件检查、TODO 条件、Delivery 验收逐层确认。迟到 ACK 或并发返回的旧检查不得将状态倒退或错误关闭任务。

变更通知未送达或未 ACK 时明确保持 pending；不默认成功，也不另派重复 owner。相关场景以验收计划 C02/C04/C09、W03、R01 和 DSH 基准 H07/H11/H14/H16 为依据。

## Delivery、多方案与分支反馈

每项任务交付包含目标、依据修订、改动/产物、实测证据、未测项、风险、剩余问题。卡住则提交 blocker/change request，不伪装完成。
出现多个备选时，同一 owner 默认提交比较报告：共同基线、各方案成本/风险/兼容性、实验与证据、推荐理由、被否决原因。标明实测、静态分析、未实现；简单任务无需凑方案。

验收分开记录 Run 完成、Delivery 提交、控制层接受、已集成、已发布。后台退出码或报告“完成”不能独自关闭任务。

合入后记录目标 commit、受影响契约和验证证据，通知跟踪该目标的执行线。owner 保护未提交内容，在安全点按仓库策略 merge/rebase，处理冲突、重验并 ACK。前台负责推动和观察，不代做 Git。
目标基线与各线已 ACK 基线分开；连续合入通知可合并到最新目标，但不能丢失影响集合。Git 无冲突不等于语义兼容。
旧修订 Delivery 需影响审查及更新证据；无关证据可保留理由，不能盲目全部作废或直接接受。

## 方案比较与升级次序

| 方案 | 优点 | 风险 / 结论 |
| --- | --- | --- |
| 只修改 skill 提示词 | 最小，便于验证讨论规则 | 无法保证调度幂等、修订门禁、真实模型调用；仅为文档阶段 |
| 扩展 Xpod 能力声明与 case 执行契约 | 复用认证、存储、调度与 Delivery，边界清楚 | 需与 models 和 Symphony skill 契约对齐；推荐方案 |
| 新建 Symphony 专属 scheduler / provider client / 状态库 | 局部开发自由 | 双重状态与封装重复，拒绝 |

推荐按依赖顺序推进，每阶段一个负责到底的 owner，独立线再拆 worktree：

1. **契约阶段**：冻结需求与验收，审查 models 能力/证据字段、Laya 部署接口、OpenCode 协议来源。输出差距与决策报告。
2. **能力阶段**：AI Connections 三家声明与录入、决策 adapter、本地 Laya 入口、错误与未知能力显示；分别验证录入和真实调用。
3. **控制阶段**：在 Xpod case 执行链路接入选择、前台观察、追加/排队/纠正、ACK、条件应用与去重；复用现有执行宿主能力，不要求增加 LinX runtime。
4. **执行阶段**：单 owner Delivery/多方案比较、独立 worktree、合入事件、更新与重验闭环。
5. **联合验收与升级**：按 [验收计划](testing/symphony-decision-acceptance.md) 产出证据，记录 skill/Xpod/执行宿主/models/能力模块版本组合，再进入发布判断。

阶段顺序不代表本轮已授权开始开发。现阶段交付为这份设计和验收计划。

## 外部依据与待决事项

2026-09-26 查阅：[OpenRouter](https://openrouter.ai/docs/quickstart)、[OpenCode Zen](https://opencode.ai/docs/en/zen/)、[TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart)、[TypeSafe API](https://docs.typesafe.ai/api)、[Laya upstream](https://github.com/NandhaKishorM/laya)。实施时固定并复核实际版本；本轮没有带凭据的推理验收。

实施前待解决：本机 Laya 入口/版本；OpenCode 每模型协议来源；共享 decision schema 与校准策略；Xpod case 执行端的条件应用边界；已安装 skill 到源码版本的升级方式。它们是明确的实施入口条件，不是假定已解决的细节。
