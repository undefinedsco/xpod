# Catalog 与共享定义归属边界

本文回答一个反复出现的问题：**某个 provider / offering / 类型 / 常量，应该放进 `@undefineds.co/models`，还是留在使用它的 applet（或本仓库的共享包）里？**

## 判定规则

1. **models 只放 schema**：实体与属性的定义 —— 表、列、行类型、URI 词表、枚举取值、日期分桶规则。models **不是内容仓库**：不存"内置了哪些 provider/offering"这类目录数据，也不该出现动作或展示语义。
2. **目录内容跟着能力走**：内置项清单及其 endpoint、console URL、展示名、授权动作、quota 策略，归**实现该能力的模块**；当 UI 与服务端都要用时，放进本仓库的共享包（如 `@undefineds.co/ai-connections`），而不是 models。
3. **行为不进共享数据包**：组件、hook、格式化、状态机留在各自 applet。

一句话：**schema 进 models，内容进能力模块，行为留 applet。**

## 判定流程

1. 它在定义**实体属性**（字段、表、URI、枚举），还是在提供**内容/行为**？→ 前者进 models。
2. 内容是**多方共用**还是单个 applet 自用？→ 多方共用放本仓库共享包，单方自用跟 applet。
3. 一旦确定归属，其他地方不得保留第二份副本；迁移期间的回退副本必须显式标注，并把切换点收敛到一个入口。

## 当前归位

### Provider / offering catalog（归 `@undefineds.co/ai-connections`）

先区分两件事，它们经常被混成一句"这是数据"：

| | 是什么 | 归属 |
|---|---|---|
| **Schema** | provider / offering / credential 这些**实体和属性**的定义（表、列、行类型、URI、枚举取值） | `@undefineds.co/models`（已有 `aiProviderResource`、`aiModelResource`、`ai-gateway.schema`） |
| **目录内容** | 内置了哪 8 个 provider、各自的 endpoint、console/subscription URL、展示名、授权动作、quota 策略 | 拥有该能力的模块：`@undefineds.co/ai-connections` |

判断要点：**目录内容不是实体定义**，而且天然耦合动作（设备码/浏览器/导入登录态）与展示（label、console 链接）——把它塞进 models 会把 UI 与交互语义带进一个只该定义属性形状的包 ✗。

因此 provider/offering catalog 的正确归属是**能力自己的模块**（`@undefineds.co/ai-connections/provider-catalog`），UI 与服务端都消费它：

| 项 | 位置 |
|---|---|
| 目录内容（单一副本） | `packages/ai-connections/src/provider-catalog.ts` |
| 服务端 | `ProviderRegistry` 消费同一模块，删除 `LEGACY_PROVIDER_PRODUCT_DESCRIPTORS` 字面量；只保留 `upstream` / `auth` / `supportsDeveloperMessages` 这类**后端运行时能力覆盖**（它们描述 Xpod 怎么和上游通信，非共享内容） |
| schema | 仍在 `@undefineds.co/models`，本仓库只做 adapter |

`ProviderRegistry.ts` 中"The shared models package owns the provider/offering catalog"这句注释与本节冲突，应改为"models 拥有 provider/offering 的 **schema**；目录内容归 `@undefineds.co/ai-connections`"。

### 已发现的目录漂移（重构前置工作）

服务端字面量与共享 catalog 已经漂移，逐字段对比得到 **19 处差异**（14 个 offering），且不只是文案：

- `openai/official-subscription` 建模不同：服务端当**本机登录态导入**（`authModes: ['local']`、`quota: subscription`），共享侧当 **oauth 订阅**（`authModes: ['oauth']`）
- endpoint 级 `region`（bailian ×4、zhipu ×2、kimi ×2）两侧不一致
- `productLabel` 命名（`Moonshot (Kimi)` vs `Moonshot AI` / `Kimi Coding`）
- `region` 语义（ollama `global` vs `local`）、`usagePolicyUrl`（ollama）

因此删掉服务端副本之前必须先**逐条定权威值**（建议：运行时语义以服务端为准，展示字段以共享侧为准），落成显式 reconciliation 表，并用对比脚本做"投影结果与今天逐字段相等"的回归。该对比脚本应升级为常驻守卫测试，防止再次漂移。

### 不归 models 的东西（留在本仓库）

- **展示逻辑**：offering 标题的展示策略、`offeringTitle` 之类的投影函数 —— 非数据。
- **UI 视图模型**：`AiProviderOffering` 在 UI 侧的字段裁剪、`productLabel` 的排版用法 —— 单个 applet 自用。
- **组件与交互**：provider 卡片、凭据列表、授权对话框、额度卡 —— 非数据。
- **运行时能力描述**：`upstream` / `auth` capability 覆盖（`codex-models`、`rolling-quota-windows` 等）—— 与后端运行时绑定，不是共享数据；即使 provider catalog 进 models，这一层也留在服务端。

## 相关约定

- 建模规则（Pod/RDF schema、URI 字段、日期分桶、exact id 操作）以 `@undefineds.co/models` 为权威，Xpod 只实现 adapter —— 见 `AGENTS.md`。
- 共享包通过 `workspace:*` 在仓库内解析；对外发布由 `scripts/publish-package.cjs` 单包发布，并把 `workspace:*` 改写成发布时的版本号。发布顺序：被依赖的包先发。
