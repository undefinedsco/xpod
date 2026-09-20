# Applet Runtime 参考与采用决策

**Status:** Decided baseline  
**Date:** 2026-08-14  
**Scope:** Applet 公共契约、宿主运行时、生命周期、能力组合，以及
VS Code、Cordis、Pi、DeepSeek Harness（DSH）的参考边界  
**Out of scope:** 完整安全沙箱、Marketplace 运营、数据中台和 Agent Loop
实现

## 1. 决策摘要

Applet 生态的公共模型以 **VS Code Extension Model** 为主要参考；运行时
内部借鉴 **Cordis** 的可撤销生命周期、作用域和能力组合；Agent 的执行
循环、工具管线与 Session 同时参考 **Pi** 的极小可编程内核和
**DeepSeek Harness** 的可替换能力缝隙。Pi 与 DSH 都是内部 Agent Runtime
候选，不进入 Applet 公共契约。

我们自己维护稳定的 Applet 协议与最小运行时，不把 Cordis 类型、配置格式
或术语暴露成生态 ABI。第一版也不以“重新实现 Cordis”为目标，只实现真实
Applet 所需的最小机制：

- Manifest、版本与兼容性声明；
- Contribution Points 与宿主注册 API；
- 激活、停止、逆序释放和统一取消；
- Applet 实例及 Agent/Worker 子作用域；
- 类型化 Host Capabilities；
- 权限校验、独立 Test Host 和可机器验证的卸载结果。

公共概念继续叫 **Applet SDK**，当前包名继续使用
`@undefineds.co/extension-sdk`。是否把内部 Runtime 抽成独立包，应由第二个
真实 Applet 的复用证据决定，不提前新增公共包。

```text
Applet / Extension Package
  -> @undefineds.co/extension-sdk        stable public contract
  -> Linx / Xpod Applet Host             product composition
  -> minimal host-owned runtime          lifecycle + capabilities
       -> optional Cordis adapter        internal, replaceable
       -> optional Pi / DSH adapter      Agent execution
  -> Solid / Xpod                        identity + Pod + authority
```

## 2. 为什么主要参考 VS Code

我们需要建设的是长期可演进的 Applet 生态，而不只是一个通用插件容器。
VS Code 已验证了这组生态契约：

- Manifest 定义身份、兼容版本、激活条件和静态贡献；
- Contribution Points 描述宿主允许扩展的位置；
- `activate()` / `deactivate()` 与 `Disposable` 管理生命周期；
- Extension Host 隔离扩展执行与产品主界面；
- Extension Test Host 支持独立开发和验收；
- Marketplace、版本兼容和弃用策略建立长期生态边界。

这些能力直接对应 Applet Factory 的输出：AI 不应任意修改 Linx/Xpod，
而应生成一个声明完整、只使用稳定 Host API、可以单独启动与验收的 Applet。

对应关系如下：

| VS Code | Undefineds |
| --- | --- |
| Extension Manifest | Extension/Applet Manifest |
| Contribution Points | views、commands，以及后续 API、Worker、Agent Tool 等贡献类型 |
| Extension API | `@undefineds.co/extension-sdk` |
| Extension Context / subscriptions | Applet 生命周期作用域与 Disposable 集合 |
| Extension Host | Linx/Xpod Applet Host |
| Workspace Trust | Manifest 权限声明、用户授权与 Host Permission Broker |
| Extension Test Host | 独立 Applet Test Host 与 AppletBench |
| Marketplace | Discovery 之上的安装与分发体验 |

VS Code 的 Manifest、Activation Events 和 Contribution Points 是静态契约；
运行时 API 提供具体实现。这种“先声明、再注册”的双层约束对 AI 生成代码
尤其重要：Factory 可以在运行前检查声明与实际注册是否一致。

## 3. 从 Cordis 借鉴什么

Cordis 的核心价值不是另一套插件 Manifest，而是对动态组合的两个运行时
问题进行了系统化处理：

1. **时间可组合性：** 组件卸载时，完整撤销安装期间产生的副作用；
2. **空间可组合性：** 组件声明依赖的能力，并在适当作用域内组合这些能力。

对 Applet Runtime 有价值的具体原则是：

- 所有注册操作都必须返回或产生可释放句柄；
- 一个生命周期作用域拥有自己产生的全部副作用；
- 父作用域停止时，子作用域必须停止；
- 释放顺序与注册顺序相反；
- 能力消费者依赖接口，不依赖提供者实现；
- 能力、监听器、Timer、后台任务和注册项都使用同一套退出语义；
- 卸载后的残留可以被测试，而不是依赖开发者自觉清理。

第一版不照搬以下 Cordis 机制：

- Proxy 驱动的动态 `ctx.xxx` Service Locator；
- Fiber、effect/coeffect 完整理论模型；
- 响应式依赖重组；
- 通用配置树、Patch 语言和 HMR 框架；
- Cordis 类型或配置作为 Applet 的公共 ABI。

原因不是这些设计无价值，而是当前产品还没有证明需要相应复杂度；Cordis
官方也明确说明 API 尚未稳定。我们先用较小的 TypeScript 原语实现相同的
必要语义，并保持将来在内部替换实现的可能。

## 4. Pi 与 DSH 的位置

Pi 与 DSH 都是 Agent Harness，不是 Applet SDK，也不是 Applet Factory。
二者提供了不同但互补的参考。

本文所称 Pi 指当前官方仓库 `earendil-works/pi`。项目已从旧的
`badlogic/pi-mono` 路径和 `@mariozechner/*` npm scope 迁移；设计引用以新
仓库和 `@earendil-works/*` 包为准。

### 4.1 Pi：极小内核和用户可编程 Harness

Pi 的核心思想是：默认内核只提供少量可靠原语，把工作流选择留给扩展、
Skill 和普通 CLI 工具。默认 Coding Agent 只需要 read、write、edit、bash
等基础工具；计划模式、子代理、权限交互和更多工作流不被固化进内核，用户
可以通过扩展或 Package 自行组合。

对我们的价值主要在 Agent Runtime 和 Applet Factory 的开发面：

- **极小可嵌入内核：** Agent Core、统一模型 API、Coding Agent、TUI 和
  Web UI 分包，既能程序化创建 Session，也能通过 JSONL RPC 嵌入其他 Host；
- **资源不是一种东西：** Extension、Skill、Prompt Template 和 Theme 分开
  建模，再由一个 Package 组合发布，避免把代码、指令和表现层揉成一个插件；
- **全局与项目作用域：** 同一资源可以全局安装，也可以由项目本地配置；
- **低摩擦扩展：** TypeScript 扩展可以注册 Tool、Command、事件和 UI，
  ResourceLoader 支持发现与重载；
- **Agent Loop 事件缝隙：** 扩展可以在 Session 启停、Agent 启动、Context
  组装、Tool Call/Result、Compaction 和资源发现等阶段观察、阻断或改写行为；
- **Progressive Disclosure：** 启动时只向模型提供 Skill 的名称和描述，模型
  真正需要时再读取完整 `SKILL.md`、脚本和引用资料，避免能力增长直接挤满
  Context；
- **透明 Session：** Session 使用带 `id` / `parentId` 的 JSONL 树，支持
  恢复、原地分支、Fork、Compact 和导出，适合审计与评测；
- **AI 自举：** 官方直接把“让 Pi 帮你创建 Extension/Package”作为使用方式，
  与 Applet Factory 让 AI 在稳定边界内扩展自身能力的目标一致。

我们应借鉴 Pi 的原则，而不是复制其安全模型：

- Runtime 内核只保留不可替代的机制，产品工作流尽量由组合产生；
- UI、工具、指令、Skill 和可执行扩展保持不同资源类型；
- Agent Runtime 同时提供库 API、Headless/RPC 和交互式 Host；
- Agent Loop 提供有限、类型化且可测试的事件缝隙，而不是要求扩展 Fork Loop；
- Discovery 先暴露能力摘要，Agent 按需加载完整 Skill/Applet 开发资料；
- Session/Event 采用开放、可回放、可分支的数据格式，并为评测保留完整证据；
- Factory 生成的 Extension/Applet 应能立即在隔离 Test Host 中加载，而不是
  先修改主产品源码。

Pi 的第三方 Package 和 Extension 默认具有完整系统权限，官方也要求用户在
安装前审查源码。这不适合面向普通用户、允许 AI 大量生成 Applet 的生态。
Xpod/Linx 不能照搬以下选择：

- 未签名扩展直接获得宿主进程和文件系统权限；
- 项目本地 Package 未经产品授权自动安装或执行；
- 把安全交互完全交给扩展自行实现；
- 把“No MCP”“无内置子代理/计划模式”等极简取舍变成平台限制；这些能力在
  我们这里可以是一等、但必须保持可替换的 Protocol/Runtime Capability；
- 用本机 JSONL 文件替代用户 Pod 中应持久、同步或受权的数据；
- 因为内核追求极简，就省略长期任务、授权、撤销和审计等产品责任。

### 4.2 DSH：可替换的 Agent 产品能力

DSH 已经提供 Agent Loop、模型适配器、工具管线、Session Event Log、
Sandbox/Approval、子代理、后台任务以及 Web/Headless Profile。

DSH 证明了 Cordis 能够支撑一个复杂 Agent 产品，也可以成为我们 Agent
Runtime 的集成候选；但 Applet 平台仍需自行定义：

- Applet 身份、Manifest 和兼容性；
- UI/API/Worker/Agent Tool 的贡献边界；
- Solid 身份、Pod 数据和授权；
- 安装、验收、升级、撤销与 Discovery；
- Linx/Xpod 产品布局和公共 UI。

Pi 更能说明一个极小 Harness 如何把可编程权交给用户与 AI；DSH 更能说明
一个完整 Agent 产品如何通过能力缝隙和插件树替换底层实现。两者都最多通过
Host Capability 或内部 Adapter 接入。Applet 不应直接依赖 Pi/DSH 的内部
Session、Context、插件树或 Package 格式。

在做过相同任务、相同模型和相同安全约束下的 Spike 之前，不预先选择 Pi、
DSH 或自研 Agent Loop。比较至少包括启动和常驻开销、嵌入 API、Session
可移植性、工具/事件扩展、取消恢复、Sandbox 接入、可观测性和升级成本。

## 5. C 端运行时边界

Linx/Xpod 桌面端是单用户 C 端产品。这里不建立并列的 User A/User B
Context，也不使用 Cordis 来证明服务端多租户隔离。

一个宿主窗口拥有一套当前 Account/WebID 状态。用户切换身份时，产品外壳
可以保留，但与旧身份绑定的 Runtime Scope 必须完整释放，再使用新的身份与
Pod 绑定重新创建。

```text
Product Host
└── current session-bound runtime scope (zero or one)
    ├── Applet instance: AI Connections
    │   ├── UI registrations
    │   ├── commands
    │   └── requests / tasks
    ├── Applet instance: Files
    └── Agent session / workspace scopes
        ├── tools
        └── workers / jobs
```

这里的 Scope 用于生命周期和能力选择，不是安全边界：

- Solid OIDC、WebID、ACP/ACL 和服务授权决定数据权限；
- Worker/进程/容器 Sandbox 决定代码执行边界；
- Runtime Scope 只保证能力不误用、资源能停止、注册能撤销。

Account Login 与 WebID Login 仍是两个不同的产品事务；Applet 只消费 Host
给出的状态和能力，不持有原始 Token，也不自行创建 OIDC Session。

## 6. 最小自研 Runtime

目标语义可以由少量明确的原语组成，不需要先引入通用元框架：

```ts
interface Disposable {
  dispose(): void | Promise<void>
}

interface AppletRuntimeScope {
  readonly signal: AbortSignal
  add(disposable: Disposable | (() => void | Promise<void>)): Disposable
  child(label: string): AppletRuntimeScope
  dispose(): Promise<void>
}
```

公开 API 的具体签名仍需实现 Spec，但必须满足以下语义：

- Host 为每个 Applet 实例创建一个 Scope；
- `activate` 期间产生的注册进入该 Scope；
- 注册 API 返回 Disposable，也由 Scope 自动持有；
- `AbortSignal` 统一取消请求、Timer、Worker 和异步任务；
- 禁用、替换、卸载、宿主退出和身份切换走同一条释放路径；
- 单项释放失败不阻止其余项目释放，最终报告聚合错误；
- Scope 释放是幂等的；
- Applet 只能取得 Manifest 已声明且 Host 已授权的 Capability。

当前 `@undefineds.co/extension-sdk` 已有这些基础：

- Extension/Applet Manifest 和有限的 Host Capability 白名单；
- 单/双/三栏 Layout 描述；
- `useApplet` 调用 `activate`，并在卸载或替换时执行其返回的清理函数；
- Host-owned Solid Session、Pod 和 Permission Broker；
- Mock Host 与独立 Test Host。

当前缺口是：

- 通用 `Disposable` / `DisposableStore` 与子 Scope；
- 统一的 `AbortSignal` 和异步释放规则；
- Manifest 声明与实际注册的一致性验证；
- Commands 的执行注册总线；
- API、Worker、Agent Tool 等贡献类型及其 Host 通道；
- 不依赖 React `useEffect` 的 Headless 生命周期；
- 释放残留、权限负例和身份切换的系统验收。

## 7. Contribution 与 Capability 的边界

两者不能混为一谈：

- **Contribution** 是 Applet 向 Host 提供的产品扩展，例如页面、命令、工具
  或 Worker；
- **Capability** 是 Host 向 Applet 提供的受控能力，例如 Pod、Models、
  Navigation、Jobs 或 Agent Runtime。

```text
Applet --contributes--> Host
Applet <--capabilities-- Host
```

未来 Extension Package 可以包含完整 Applet，也可以包含更小的组件页面、
API、Worker 或 Agent Tool。哪些类型进入第一版公共契约、采用何种隔离级别，
仍需由真实参考 Applet和安全验收决定；不能因为某个类型出现在 Manifest 中，
就默认它已具备可信运行能力。

## 8. 验证门槛

在决定是否引入 Cordis 之前，最小 Runtime Spike 必须通过以下测试：

1. 一个测试 Applet 同时注册 UI、命令、事件和可取消后台任务；
2. 禁用或替换后，所有注册消失，请求/任务停止，重复释放无副作用；
3. 某个 disposer 抛错时，其他资源仍能完成释放；
4. Applet 请求未声明或未授权 Capability 时，加载或调用明确失败；
5. 身份切换后旧 Pod Fetch、Worker 和 Agent Tool 不再可用；
6. 同一 Applet 在独立 Test Host、Xpod 和 Linx 中具有相同生命周期语义；
7. Headless Worker/Agent Tool 不依赖 React 才能激活和停止；
8. Applet 无法获得原始 OIDC Token、DPoP 材料或真实 Provider Credential；
9. 测试能够断言零残留注册、零未完成任务和零未处理 Promise；
10. 与直接、轻量实现对比后，Cordis 只有在明显减少复杂度且不泄漏进公共
    ABI 时，才进入内部依赖候选。

## 9. 采用结论与演进规则

### 已决定

- VS Code 是公共 Applet 生态和开发体验的主要参考；
- 我们自己定义并维护 Applet SDK、Manifest、Contribution Points 和 Host
  Capability；
- 借鉴 Cordis 的可撤销生命周期、作用域和能力组合；
- Cordis 不进入公共 ABI，也不是权限或安全沙箱；
- 借鉴 Pi 的极小内核、资源分型、可嵌入 API 和透明可分支 Session；
- Pi 与 DSH 属于 Agent Runtime 集成层，不替代 Applet Factory；
- 桌面 Host 只维护一个当前用户的 session-bound runtime scope；
- 先实现最小 Runtime，再由真实 Applet推动扩展点晋升。

### 尚未决定

- 内部 Runtime 最终是否直接依赖 Cordis；
- Agent Runtime 采用 Pi、DSH、自研最小 Loop，还是它们的组合；
- API、Worker、Agent Tool 分别使用同进程、Worker Thread、子进程还是远端
  Executor；
- 第一版 Activation Events 与条件表达式的范围；
- Extension Host 的进程隔离与资源配额；
- 哪些 Contribution 能进入 Trusted Applet 标准。

### 演进规则

新增公共抽象必须满足至少一个条件：

- 两个独立真实 Applet 已经需要它；
- 它跨越身份、权限、持久数据或安全边界，必须提前统一；
- AppletBench 证明它显著提高成功率或降低修复成本。

不得为了匹配 Cordis、VS Code 或 DSH 的完整功能表而增加抽象。

## 10. 一手参考

- [VS Code Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [VS Code Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [VS Code Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Cordis repository](https://github.com/cordiverse/cordis)
- [A Programming Paradigm for Spatiotemporal Composability](https://github.com/cordiverse/paper)
- [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [Pi repository migration announcement](https://pi.dev/news/2026/5/7/pi-has-a-new-home)
- [Pi Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi Session Format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

## 11. 相关仓库文档

- [Pod-native Applet Platform Architecture](2026-08-12-pod-native-applet-platform-architecture.md)
- [Shared Linx Applet Shell Design](2026-08-01-shared-linx-applet-shell-design.md)
- [Applet Service Access and Host SDK Design](2026-07-27-applet-service-access-design.md)
- [Extension Runtime and Credential Resolution](../../extension-runtime-and-credential-resolution.md)
- [Applet SDK README](../../../packages/extension-sdk/README.md)
