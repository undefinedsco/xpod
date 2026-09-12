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

### Pod 只落用户录入的数据，内置项按规则推导

区分两件事：

| | 例子 | 处理 |
|---|---|---|
| **用户录入的数据** | custom provider、credential、model 选择 | 落 Pod（唯一需要持久化的一类） |
| **我们维护的内置项** | openai / anthropic / kimi / bailian / deepseek / zhipu / ollama 及其 offering、展示元数据 | **按规则推导**（catalog），不落 Pod |

反例（待修）：`XpodAiConnectionsPodStore.ensureProviderRow()` 会给**任何** provider —— 包括内置的 —— 在 Pod 里插一行只有 `displayName` 的 provider 行；而 `providerSummariesFromPodRows()` 对非 custom 的 provider 一律用 `providerName(provider)` / `providerOfferings(provider)` 推导，**落盘那行根本没被读用** ✗。内置 provider 的行应当只对 custom 存在。

推论：内置项的展示元数据（`displayName`、`consoleUrl`、`productLabel`…）来自**规则**，不需要服务端透传；custom 的展示元数据来自**用户录入的数据**。因此服务端只需持有契约字段（见上表），不必再持有展示字段。

### 共享面只放互操作契约，展示字段留在 applet

即使同一份 catalog 被 UI 与服务端共用，也**不该把它的所有字段都当成"共享数据"**。判定标准是：这个字段有没有**互操作价值**（决定能不能连、怎么路由、怎么发现模型、怎么计费），还是只是**展示/个性化**。

| 类别 | 字段 | 归属 |
|---|---|---|
| **互操作契约** | `id`、`kind`、`lifecycle`、`authModes`（必须区分"发起登录"与"采集已有登录态"）、`endpoints`（`protocol` / `baseUrl` / `supportsDeveloperMessages` / `region`）、`modelDiscovery`、`quota.strategy`、`runtimeProviderIds` | 共享（服务端 + UI 都消费） |
| **展示 / 个性化** | `label`、`productLabel`、`consoleUrl`、`subscriptionUrl`、`usagePolicyUrl`、`credentialPrefixHints`、`quota.url`、provider 级 `region` | applet（谁渲染谁维护） |

依据：服务端对这些展示字段的引用**只是把它们拷进 API 响应**（见 `src/api/ai-gateway/connect/index.ts`），没有任何功能判断；而 `endpoints`、`modelDiscovery`、`quota.strategy`、`runtimeProviderIds` 参与上游能力推导与路由，属于契约。

**收益**：把展示字段排除出共享面之后，原本 19 处"冲突"里有约一半（`consoleUrl`、`subscriptionUrl`、`quota.url`、`productLabel`、`usagePolicyUrl`、provider 级 `region`）**根本不需要协调** —— 它们只归 applet，不再存在"两侧取值不同"的问题。真正需要定权威的只剩契约字段。

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
