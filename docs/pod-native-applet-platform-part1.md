# 从个人 Jarvis 到共建生态：Part 1

**状态：** 产品架构与建设策略收敛稿<br>
**日期：** 2026-08-13<br>
**范围：** AI-native Solid Applet 平台、Applet Factory、快速建设方法与成本结构<br>
**Part 2：** Data Capability Platform、数据中台、开发者收益与 Personal AI Model Foundry 的完整设计

## 0. 故事摘要

我们想让每个人都拥有自己的 Jarvis：它不是一个超级 App，而是一组围绕同一用户、同一 Pod 和同一授权边界协作的 Applet。用户提出新需求，AI 先发现和组合已有能力；当确实缺少 Applet 时，由 Applet Factory 把意图转成可验证的新 Applet。

但一个人的需求非常多，而且高度个性化。如果每个人都让 AI 从零实现全部功能，代码虽然能生成，身份、权限、数据、语义、布局、服务端能力、测试和发布仍需要反复集成，成本不会真正降下来；每个人还会得到一套不可共享的新孤岛。

因此平台要同时解决两个看似冲突的问题：

- **个性化：** 每个人都能按自己的数据、偏好和流程获得不同能力；
- **共建：** 共性的语义、模块、Applet、工具、协议和验证证据由所有人复用，而不是重复生成。

我们的解法分成两步：

1. **分层：** 把身份、Pod、ORM、语义、扩展契约、UI、Host、API/Worker 和权限固化成稳定能力，缩小 AI 每次需要自由生成和推理的范围；
2. **发现：** 让人和 AI 能找到社区词汇表、已有数据、Applet、Command、Tool、Model、Adapter 和 Runtime 能力，优先组合，只有真正缺失的部分才生成。

但分层与发现只是原料。即使已经有 AI，要把一个需求稳定交付成真实 Applet，仍要完成脚手架、数据和权限绑定、产品单元组合、测试、打包、发布、安装、升级与撤销。Jarvis 需要的不是偶尔成功生成一个 Applet，而是能够持续生产很多可信、可组合的 Applet。

因此产品平台需要 **Applet Factory**。它包含两部分：

1. **基础流水线：** 把意图稳定地变成可安装、可验证、可升级的 Applet；
2. **可组合产品单元：** 把登录、Session、Pod ORM、语义模型、Layout、权限、API/Worker、测试和发布等共性能力直接提供给 AI 组合。

Applet Factory 不是另一个聊天式代码生成器，而是让 AI 少猜、少重做、少集成的产品生产系统。

新的问题随之出现：**建设 Applet Factory 本身仍是一项很大的开发工作，我们如何把它快速建出来？** AI Connections、Files、Notes/Tasks 和 Worker 先作为目标 Applet 与验收场景，定义 Factory 必须具备的能力；我们围绕第一项目标建出最小 Factory，由 Factory 产出第一个真实 Applet，再用第二个 Applet 扩展和验证 Factory。任务拆分、并发 Agent、独立验收、Integration lane 和证据 Ledger 用来加速这一建设过程。最后通过复用、模型路由、缓存和轻量运行时，持续降低每个 Applet 从意图到可信运行的总成本。

## 1. 第一幕：我们要做的是每个人的 Jarvis

Jarvis 不是一个固定功能的超级 App，也不是一个拥有所有权限的单体 Agent。它是围绕用户自己的 Pod，不断组合和增长的能力图：

```text
WebID + Pod data + permissions + preferences
  + semantic profiles + Applets + commands + tools
  + models + automations + policies + evidence
```

用户体验应该是“言出法随”：

```text
用户表达意图
  -> AI 理解个人上下文与授权边界
  -> 发现已有数据和能力
  -> 优先组合
  -> 只创建缺失部分
  -> 预览、解释权限、测试、执行
  -> 留下用户明确批准的偏好、映射、配方和证据
  -> 下一次用更低成本满足相似意图
```

能力提高来自可审计资产的积累，而不是 AI 静默扩大权限或把不透明模型权重变成唯一事实。

## 2. 第二幕：Jarvis 的功能无限，必须兼顾个性化和共建

两位用户可能都需要“会议助手”，但他们的数据源、工作习惯、审批规则、界面偏好和自动化程度不同。完全统一的 App 很难满足；完全定制又会让所有人重复实现日历、联系人、笔记、权限、模型和同步。

因此要把变化分成三层：

| 层次 | 复用方式 | 个性化方式 |
| --- | --- | --- |
| 共享事实与语义 | 社区 Vocabulary、Application Profile、`@undefineds.co/models` | 私有 Mapping、个人数据选择、Pod 中的设置 |
| 共享能力 | Applet、Command、Tool、API、Worker、Protocol Adapter | 组合、开关、策略、权限和自动化 |
| 共享体验骨架 | Host、Layout、Session、UI primitive | 领域 UI、视图选择、个人工作流 |

共建并不要求所有人的数据完全一致，也不要求每个人使用相同的 UI。它要求共享边界稳定，个性化部分可以声明、替换和组合。

能力从个人使用到生态共建逐级晋升：

1. **Personal：** 私有、可逆，允许临时 Mapping 和快速试用；
2. **Shareable：** 声明输入输出、权限、Capability 和兼容性，通过干净用户测试；
3. **Trusted：** 允许可信安装、无人值守或收费，必须有确定性共享写入、两用户隔离、来源、撤销、审计和签名策略。

用户不需要学习晋升流程。AI 生成 Manifest、Profile 引用、权限解释和测试，用户只批准影响范围扩大。

## 3. 第三幕：有 AI 以后，实现为什么仍然贵

自然语言需求到“生成代码”已经便宜很多，但代码不是最终产品。一个真实 Solid Applet 还要正确处理：

- Account Login 与 WebID Login；
- 共享 Solid Session、Pod/Storage 选择与 Token 续期；
- RDF 语义、资源身份、URI relation、Migration；
- Pod CRUD、Collection hydration 和跨 Applet 数据复用；
- Host Layout、独立/嵌入双模式和公共 UI 状态；
- API、Worker、Protocol Adapter、模型连接与凭据隔离；
- 最小权限、两用户隔离、失败恢复、审计与撤销；
- 打包、兼容、发布和真实产品矩阵验收。

如果每个 Agent 都从原始 Solid/Inrupt SDK 和空仓库开始，它需要在巨大的决策空间中同时完成产品设计、协议集成、语义建模、安全和运维。错误通常不是 TypeScript 编译错误，而是：

- 创建第二组 Session；
- 把 URI 关系当普通 ID；
- 写入另一个 Applet 无法理解的数据；
- 泄漏凭据或请求过大权限；
- Demo 可点，但真实 Pod、配额、模型和失败恢复没有接通；
- 独立运行与嵌入 Linx 出现两套逻辑。

所以真正要优化的不是“生成代码价格”，而是：

> **从用户需求到可信、可复用、可维护能力的总成本。**

## 4. 第四幕：用分层能力缩小 AI 的错误空间

平台不替 AI 决定全部产品细节，而是把高风险、重复且应一致的部分变成稳定 Contract。

### 4.1 产品角色

- **Xpod：** Pod-native Data and Agent Runtime，拥有 Solid 身份、Pod、权限、API/Gateway、Worker、协议适配和受控执行；
- **Linx：** Applet Host，拥有 Rail、导航、Account surface、共享 Session、布局、主题和发现体验；
- **Applet：** 拥有领域交互、Command、Workflow、加载和错误；
- **AI：** intent-to-capability compiler and executor，发现、组合、创建和验证，但不绕过权限和契约。

### 4.2 SDK 与模块分层

| Owner | 固定的复杂度 | 留给 AI 的自由度 |
| --- | --- | --- |
| `@undefineds.co/models` | 共享语义、Application Profile、资源身份、URI helper、Repository | 选择和组合已有模型，必要时提出新 Proposal |
| `drizzle-solid` | 通用 Pod ORM、资源 CRUD 与查询机制 | 领域查询和数据交互 |
| `@undefineds.co/solid-sdk` | Account/WebID 事务、单 Session、Storage/Pod、Authenticated access | 何时要求登录、如何解释当前任务需要的数据 |
| `@undefineds.co/extension-sdk` | Manifest、Lifecycle、Contribution、Host Capability、Layout、测试 | 贡献哪些 View、Command、Tool、API 或 Worker |
| `@undefineds.co/shared-ui` | Token、无状态原语、公共登录和空/错/加载状态 | Applet 的领域 UI |
| Host | Rail、导航、全局账户、两/三栏几何、主题、原生能力 | 选择合适 Layout descriptor 和 Slot |
| Xpod Runtime | API、Gateway、Worker、Adapter、Credential resolution、隔离执行 | 领域服务逻辑与任务编排 |

UI 不是全 Headless，也不是把所有页面做成公共组件：

```text
Headless behavior / capability contracts
  -> Shared presentation primitives
  -> Host composition
  -> Applet domain UI
```

Account Login 与 WebID Login 是不同事务，但复用公共展示原语。一个 Host 窗口只拥有一个 Solid Session boundary，Applet 不自行创建另一套 Provider。

### 4.3 扩展不只是一整页 Applet

一次意图的最小缺口可能是：

```text
Extension Package
  ├─ Applet
  ├─ View
  ├─ Command
  ├─ Agent Tool
  ├─ API Handler
  ├─ Worker
  └─ Protocol Adapter
```

`Protocol Adapter` 指 OpenAI Chat/Responses、Anthropic Messages、ACP、MCP 等外部接口的翻译，不是 AI 模型 Adapter。

当前先把 Applet 作为一等单元；更细 Contribution 的生命周期、签名、沙箱和独立发布仍是开放设计，不能写成已完成。

## 5. 第五幕：Discovery 让所有人站在彼此肩膀上

分层解决“怎样正确复用”，Discovery 解决“怎样找到可以复用的东西”。

Discovery 服务人和 Agent：

| 类型 | 要发现的内容 |
| --- | --- |
| Semantic | 社区 Vocabulary、Ontology、Shape、Application Profile、Mapping、Migration |
| Data | 可访问的 Pod、Storage、Collection、Resource、Index |
| AI Model | Provider、Offering、Model、Capability、协议兼容 |
| Runtime | Host API、Native Capability、Worker、Protocol Handler、Endpoint |
| Ecosystem | Applet、Command、Tool、Adapter、MCP Server、Extension Package |

它可以索引、缓存、验证、排序和推荐，但不成为新的权威：

- 社区词汇表属于其发布者；
- 采用后的 Profile 和 UDFS 语义属于 `@undefineds.co/models`；
- Pod 数据属于用户；
- Runtime Capability 属于 Xpod；
- Manifest 属于 Extension Package。

### 5.1 AI 时代的数据策略

Discovery 让 AI 找到语义，但 AI 能理解差异不代表一致建模不再重要。

原则是：

> **读取宽容，写入收敛。**

- Personal read：AI 可推断结构并建立私有、可逆、带来源/置信度的 Mapping，让既有 Pod 数据立即可用；
- Shareable capability：声明输入、输出、身份、权限、Mapping 和 Profile 兼容；
- Trusted shared write：绑定版本化 Application Profile，通过 Shape、Fixture、RDF round-trip、Migration 与两用户权限测试。

第一期 Discovery 不需要先做 Marketplace。最小交付是版本化 Manifest/Capability/Profile index、来源与兼容性验证、人与 Agent 共用的查询接口，以及从同源生成的文档。

## 6. 第六幕：Jarvis 要靠很多 Applet 协作，所以需要 Applet Factory

分层与 Discovery 解决的是“哪些能力可以复用、应该从哪里取得”，但它们不会自动交付用户可用的功能。Jarvis 的实际增长单位仍然是 Applet：Files、Notes、Tasks、AI Connections、自动化，以及每个人独有的新 Applet，共同围绕同一个 Pod 和授权边界工作。

```text
Personal Jarvis
  = Shared Pod + Identity + Permissions
  + Applet A + Applet B + Applet C + ...
```

即使有 AI，从一句需求到一个可信 Applet 仍有一整条交付链：

```text
Intent
  -> Discover existing capabilities
  -> Compose reusable product units
  -> Generate only the domain-specific gap
  -> Bind data and permissions
  -> Verify with real Pod / OIDC / failure cases
  -> Package and publish
  -> Install, upgrade, revoke and observe
```

因此我们需要的是 **Applet Factory**，而不是让每个 AI 从空仓库重复造一个 Applet。

### 6.1 Applet Factory 提供基础流水线

基础流水线把所有 Applet 都必须经历的步骤固定下来：

1. 接收用户意图并发现已有 Applet、Profile、数据和能力；
2. 选择模板与产品单元，生成最小领域差异；
3. 自动形成 Manifest、依赖、权限说明和兼容声明；
4. 接入真实 Account/WebID、Pod 与 Host 环境；
5. 执行 Contract、集成、权限、失败恢复和视觉验收；
6. 打包、签名、发布、安装、升级、撤销和回滚；
7. 将新的 Applet、Profile、测试证据和兼容信息回流 Discovery。

### 6.2 Applet Factory 提供可组合产品单元

这些不是文档示例，而是 AI 可以直接选择、组合并接受测试的产品积木：

| 产品单元 | Applet 不再重复解决的事情 |
| --- | --- |
| Identity & Session | Account/WebID 登录、单 Session、Token 续期、Storage 选择 |
| Pod Data | `models` + `drizzle-solid`、Collection hydration、Migration、真实 CRUD |
| Semantics | Vocabulary/Profile discovery、Mapping、URI identity、兼容检查 |
| Host & UI | Layout descriptor、主题、公共登录/空/错/加载状态、嵌入与独立模式 |
| Trust | Manifest、最小权限、凭据隔离、来源、撤销、审计 |
| Runtime | API、Worker、Tool、Protocol Adapter、恢复和结果写回 |
| Delivery | Template、fixture、test harness、package、release、upgrade |

Applet Factory 的输出不是一段代码，而是一份可以进入生态的 Applet 产物：

```text
Applet Package
  = Domain experience
  + Manifest and capabilities
  + Profile / Mapping references
  + Permission explanation
  + Tests and evidence
  + Install / upgrade / revoke path
```

## 7. 第七幕：Applet Factory 本身也是大工程，我们如何把它建出来

这才是能力分层之后要继续讨论的问题。我们已经把目标和边界讲清楚，但 Identity、Models、ORM、Shared UI、Host、Extension、Runtime、Discovery 和 Delivery 仍需要真实代码、真实产品和真实验收。

这里要区分：

- **Applet Factory：** 面向用户和 AI 的产品能力，负责稳定生产 Applet；
- **内部 AI 研发流水线：** Undefineds 建设 Applet Factory 的方法，负责把清晰边界变成团队吞吐。

后者不是产品里的第二个“工厂”，也不要求先把 Symphony 强塞进 Xpod。它可以先由 Codex/CLI、任务系统、Git worktree、CI 和现成编排器组成。

### 7.1 Reference Applet 先定义 Factory 的目标与验收

1. **AI Connections：** 身份、Provider/Offering、Credential、Model、Quota、Gateway 与 Coding Client；
2. **Files：** File-primary resource、RDF metadata、Preview、Permission、Search；
3. **Notes/Tasks：** CRUD、Collection hydration、语义复用与跨 Applet 协作；
4. **Worker Applet：** 后台执行、委托、事件、幂等、恢复和写回。

它们不是已经存在、等待手工交付的四个 Applet，而是四类目标产品和验收场景：先用 AI Connections 定义第一期 Factory 必须覆盖的身份、模型和 Gateway 能力，建出能生产它的最小 Factory，再由 Factory 生成并验收 AI Connections。随后用 Files 或 Notes/Tasks 扩展 Factory，并验证已有产品单元是否真的可组合和复用。

### 7.2 第二消费者决定候选实现能否成为产品单元

```text
目标 Applet 定义真实需求与验收
  -> 在 Applet Factory 中实现最小产品单元
  -> Factory 产出并验收第一个 Applet
  -> 第二个 Applet / Host 通过 Factory 独立使用
  -> 晋升为 Applet Factory 产品单元
  -> 发布 SDK + Discovery metadata + fixtures + tests
```

身份、权限、资源身份等不可逆边界仍需 Contract-first；领域交互和可演化实现则由目标 Applet 的验收场景拉动。没有第二消费者证据的抽象留在局部 Applet，不为了“看起来像平台”而提前进入公共 SDK。

### 7.3 把清晰边界变成可并行任务

每个待建设的流水线能力或产品单元，必须变成标准 Task Packet：

```text
Objective           要交付的能力
Owned scope         可修改的仓库 / 模块 / 文件
Contract refs       必须遵守的接口、Profile 与设计决策
Dependencies        前置任务与可并行关系
Acceptance matrix   必须通过的测试、fixture 与负例
Non-goals           明确不允许顺手扩大的范围
Integration target  进入哪个 staging / reference applet
Risk & gates        需要哪些独立审查和人工决策
```

```text
Target Applet / Acceptance Scenario
  -> Minimal Factory Capability / Contract
  -> Task Packets
  -> Parallel Agent worktrees
  -> Independent verification
  -> Integration lane
  -> Factory-generated Applet
  -> Reusable product units
```

AI 并发的关键不是多开窗口，而是 Contract 先稳定、任务写入范围不重叠、实现者不自证、所有结果都进入可运行 staging。人只把关架构、共享契约、安全/数据边界、产品语义和发布。

### 7.4 用 Ledger 和 Bench 判断是否真的加速

研发流水线至少记录四组指标：

- **吞吐：** Applet cycle time、并发任务数、从 Task Packet 到 staging 的时间；
- **质量：** 首次验收通过率、修复轮次、回归缺陷、Contract break、flaky test；
- **成本：** 每个可运行 Applet 或公共产品单元的 Token、缓存、CI、人工分钟和返工率；
- **复用：** Discovery 命中率、第二消费者接入时间、后续 Applet 的边际成本。

可证伪定义：

> 在相同模型、Prompt、上下文、时间、Token、工具和修复预算下，不熟悉代码库的 Agent 使用 Applet Factory，应比直接使用原始 Solid SDK 更快、更可靠、更安全地交付一个真实 Applet。

#### AppletBench

- 复用公共 Account/WebID 登录，不创建第二个 Session；
- 用 `models` + `drizzle-solid` 完成真实 Pod CRUD；
- 同一 Applet 独立/嵌入运行且无 local/cloud 分支；
- 最小权限、两用户隔离、网络/OIDC 失败恢复；
- 使用 Host Layout 与公共状态；
- API/Worker 不泄漏凭据和 Host internals。

#### SemanticModelingBench

- 优先发现和复用社区词汇表与 Profile；
- 正确区分 URI relation、外部 literal ID、class、capability、Offering 和 product role；
- RDF round-trip 保持 exact resource identity；
- Applet B 不看 Applet A 源码，仅使用公共模型和 SDK 即可读写其数据。

#### ExtensionBench

- Manifest 可以生成安装、权限解释和兼容检查；
- API/Worker/Tool 只能获得声明 Capability；
- 升级、撤销和失败恢复产生审计证据；
- Shareable/Trusted 能力在干净用户和第二 Host 中运行。

建议初始门槛：首次结果 ≥ 80%，三次有界修复内 ≥ 95%，相对裸 Solid SDK baseline 成功率至少 +20 个百分点或 Token/修复成本降低 25%，跨 Pod 越权、凭据泄漏和未授权权限增长为 0。

这些是待验证门槛，不是已经取得的成绩。

## 8. 第八幕：如何降低成本

成本不是只有模型账单。真正需要优化的是：

```text
总成本
  = 重复建设
  + Agent 推理和生成
  + 失败修复
  + 验证与人工介入
  + 执行环境
  + 长期维护和迁移
```

### 8.1 先改变工作量，再优化单价

| 成本来源 | 平台机制 | 预期效果 |
| --- | --- | --- |
| 每次重复登录、Schema、Layout、Worker | SDK 分层与 Host Capability | 删除重复代码和重复决策 |
| 找不到已有能力 | Discovery 与组合优先 | 减少需要生成的新代码 |
| AI 决策空间过大 | Contract、类型、Profile、Template | 降低首次出错和修复轮次 |
| Demo 通过、真实产品失败 | Acceptance Matrix 与隐藏 Bench | 提前发现集成、安全和恢复错误 |
| 公共 API 过早膨胀 | 第二消费者 Promotion rule | 减少错误抽象与迁移成本 |
| 每个人重新个性化 | Pod settings、Mapping、Capability composition | 共享实现但保留个人差异 |

最重要的指标不是 token 单价，而是：

- 意图到可用能力的时间；
- 复用组合满足的需求比例；
- 首次成功率和修复轮数；
- 每个可信能力的模型、执行与人工成本；
- 第二用户接入所需改动；
- 后续相似需求相对首次的边际成本。

### 8.2 再降低 AI 与执行现金成本

当前团队拥有五名 OpenAI OSS 扶持成员。公共计划确认六个月 ChatGPT Pro 与 OSS API credits，但实际是否是 Pro 20x、credits 数量和适用范围以获批账户为准。

建议模型路由：

- **Sol / Pro20x（若账户实际具备）：** 架构、Spec、共享语义、安全、发布和最终争议；
- **DeepSeek V4 Pro：** 跨模块实现、复杂调试、深度修复；
- **DeepSeek V4 Flash：** 搜索、机械迁移、局部实现、批量测试和可重试工作。

不是每个 Worker 结果都让 Sol 再审一次；只有共享 Contract、安全、数据迁移、测试失败或达到重试阈值时升级。

DeepSeek 90% 输入缓存是预算目标，不是承诺。接近目标需要稳定前缀：平台规则、Repo 摘要、Spec、工具说明在前，动态 diff、日志和用户输入在后；通过 API usage ledger 记录 hit/miss、输出、修复轮次与任务成功。

执行环境按风险分级，首期保持轻：可信本机使用 process + worktree；Linux 轻量隔离可采用 nsjail；云端标准 OCI 采用 containerd + crun；陌生代码再升级到 gVisor，microVM 延后。它们是待 Benchmark 的候选，不是 Part 1 产品 Contract。

### 8.3 六个月扶持期应该换来什么

不是多生成代码，而是建立可以持续压低边际成本的资产：

1. 稳定 SDK/Host Contract；
2. 可查询 Discovery；
3. 可持续运行的 Task Graph、Task Packet、Acceptance 与 Integration lane；
4. 四类 Reference Applet 的真实产品路径；
5. 隐藏 Benchmark 与安全 Oracle；
6. 模型/Token/Cache/Repair/人工介入 ledger；
7. 第二消费者复用的证据。

六个月后用真实 ledger 决定模型订阅和基础设施，而不是现在按一个示例 token 量预设长期预算。

## 9. Part 1 的落点

Part 1 不是交付完整 Jarvis，也不是声称 Applet Factory 已经建成。它需要形成一个清楚的产品判断和一条可执行的建设路径。

产品判断：先由 Applet Factory 把用户意图稳定地变成可信、可组合的 Applet，再由这些 Applet 共同构成个人 Jarvis：

```text
Applet Factory
  -> Discover / Compose / Generate
  -> Authorize / Verify / Package
  -> Trusted Applets
  -> Personal Jarvis
  -> Share / Reuse / Improve Factory
```

建设路径：先用目标 Applet 定义验收，再建最小 Factory，由 Factory 产出第一个 Applet，并用第二个 Applet 扩展和验证 Factory：

```text
Target Applet / Acceptance
  -> Minimal Factory Capability
  -> Task Packet
  -> Parallel Worktrees
  -> Independent Acceptance
  -> Integration Lane
  -> Minimum Applet Factory
  -> Factory-generated Applet
  -> Second Applet expands the Factory
```

### 立即执行

1. 定义最小 Applet Factory：基础流水线、可组合产品单元、输入/输出与可信 Applet 的完成标准；
2. 以 AI Connections 作为第一项目标 Applet 和验收矩阵，定义最小 Factory 所需的公共登录、Pod persistence、Provider/Offering/Model/Quota、Gateway 与 Coding Client 能力；
3. 建出最小 Factory，并由它生成和验收 AI Connections，而不是绕开 Factory 手工完成产品；
4. 以 Files 或 Notes/Tasks 作为第二项目标，通过 Factory 生成，扩展并验证 SDK、Layout、Models、Discovery 和数据复用；
5. 用 Task Packet、隔离 worktree、独立 Acceptance 与 Integration lane 加速上述建设；
6. 建立 AppletBench、SemanticModelingBench、ExtensionBench 和成本 Ledger，验证是否真的更快、更稳、更便宜。

### 留给 Part 2

- 完整数据中台、Data Product 与开发者收益；
- Personal AI Model 的训练、评测、发布、回滚和删除传播；
- Graph/Vector/Hybrid Index、Pipeline 与 Provenance 的完整生命周期；
- Marketplace 商业和运营体系。

## 10. 相关文档与来源

### 仓库内

- [Pod-native Applet Platform Architecture](superpowers/specs/2026-08-12-pod-native-applet-platform-architecture.md)
- [Shared Linx Applet Shell Design](superpowers/specs/2026-08-01-shared-linx-applet-shell-design.md)
- [Applet Service Access and Host SDK Design](superpowers/specs/2026-07-27-applet-service-access-design.md)
- [Extension Runtime and Credential Resolution](extension-runtime-and-credential-resolution.md)
- [Data Capability Platform TODO](superpowers/plans/2026-08-12-data-capability-platform-todo.md)

### 外部一手来源

- [Shopify App Extensions](https://shopify.dev/docs/apps/build/app-extensions)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Replit Agent](https://docs.replit.com/features/agent/overview)
- [OpenAI Codex for Open Source](https://developers.openai.com/community/codex-for-oss)
- [OpenAI Codex pricing and limits](https://learn.chatgpt.com/docs/pricing)
- [DeepSeek V4 pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)
