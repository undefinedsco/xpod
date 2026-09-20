# 扩展抽象：一套接口 + 足够宽的通用实现

> **可以允许独有，但也是一套接口，并且有足够适应面的通用实现。**

本文把这句话落成可执行的判据，并对仓库现状做一次审计。**本文只做审计与设计，不改行为**；任何迁移都是后续独立任务。

## 1. 规则

### 1.1 三条硬规则

1. **一个能力轴一套接口**：`协议适配`、`配额`、`授权方式`、`本机会话导入`、`模型发现`、`凭据存储`、`运行时 provider 映射` 各自只有一个接口。独有实现必须**实现同一套接口**，并且有**注册/声明机制**（注册表或声明表），不能另开一条平行代码路径。
2. **每个能力轴必须有一个通用实现，且适应面被写下来**：通用实现要能声明式地表达真实用例（endpoint、protocol、region、authModes、modelDiscovery、quota 策略、runtimeProviderIds……）。"通用实现只能表达一半，剩下的写成 provider 分支"不算通用实现，算缺口。
3. **禁止**：
   - 散落的 `if (provider === '…')` / `switch (provider)`；
   - 按 provider id 建的第二张表（endpoint 表、label 表、字段表）与第一份副本并存；
   - **UI 按 provider 身份分支**（`AiProviderCard.tsx:351`、`AiConnectionsList.tsx:234` 这类 `switch`，以及 `PROVIDERS[].name`、`providerAvatars` 这类按 id 的常量表）；
   - 同一个事实有两套注册机制（例如既有 provider→adapter、又有 protocol→adapter 两个注册表）。

### 1.2 判断顺序

**先问数据能不能表达 → 再问通用实现能不能覆盖 → 最后才允许独有。**

判断顺序里的"数据"专指**程序侧声明**：随程序发布、随程序 review 的目录常量与配置文件（models discovery 的 `providers.json`、能力模块的声明表、`config/` 配置），**不是用户数据**。**程序能力留在程序里** —— Xpod 支持哪些 provider/offering、applet 服务身份的访问面，都由程序/配置决定，随程序提交与 review；**用户数据只承载用户自己的东西**（凭据、所选 offering、endpoint/key、授权选择）。把程序能力写成用户数据字段（例如"该 offering 对外暴露哪些文档"）是方向相反的修法，不算"数据能表达"。

只有"这个 provider 的上游本身就独有"（它自己的 quota 端点、它自己的登录态文件格式、它自己的 token 校验方式）才落到第三步；落到第三步时，仍然要回答"实现的是哪个接口、通过什么注册"。

### 1.3 分类口径（本审计用）

| 分类 | 含义 | 修法 |
|---|---|---|
| **① 挪进程序侧声明**（旧称"挪进数据"） | 这个判断是机械事实，属于 models discovery / 能力模块目录这类**随程序发布、随程序 review 的声明**（不是用户数据） | 加/用声明行，删掉分支 |
| **② 通用实现适应面不足** | 通用实现（或应有）存在，但声明面表达不了这个用例 | 指出**最小的扩面**，通常同时覆盖同类多站点 |
| **③ 真独有插件** | 上游本身独有，必须是插件 | 指出它实现的接口与注册机制；形状合规的记为合规样板 |
| **④ 程序侧单一来源** | 判断本身正确（程序能力就该留在程序/配置），缺陷是同一个程序事实手写了第二份 | 收敛成一份程序侧清单 + 一条守卫测试；**不加用户数据字段**，也不给 offering 加暴露声明 |

`protocol === …` / `compatibility === …` / `keyType === …` / `deployment === …` 不是 provider 身份分支，不计入 ①②③④（本文单列一节说明）。

### 1.4 与既有归属规则的关系

本文不新开归属口径，直接复用已拍板的三条：

- [`docs/catalog-ownership.md`](catalog-ownership.md)：**schema 进 models，内容进能力模块，行为留 applet**；`authModes`、`endpoints`、`modelDiscovery`、`quota.strategy`、`runtimeProviderIds` 是**互操作契约**，`label`/`consoleUrl`/`productLabel` 是 applet 的展示字段。
- [`docs/ai-connections-storage-model.md`](ai-connections-storage-model.md) §10：**models 的 `src/discovery/providers.json` 是关键元数据**，endpoint/region/authModes/modelDiscovery/quota/runtimeProviderIds 由它随包发布；§11：变化经 store 与订阅可见，迁移不靠手改文件。
- [`AGENTS.md`](../AGENTS.md) `共享定义归属`：归属确定后不得保留第二份副本；文档与注释冲突时以文档为准。

推论：**"数据能表达"的边界就是 §10 的关键元数据 + 能力模块的展示/动作声明** —— 两者都是**随程序发布、随程序 review 的程序侧声明**，不是用户数据；用户数据只承载用户自己的凭据/所选 offering/endpoint。超出这个边界的机器事实，要么补进关键元数据（在 models），要么补进 offering 的声明（在能力模块），不允许用 provider 分支兜；反过来，程序能力（是否支持某个 provider/offering、服务身份的访问面）也不允许改写成用户数据字段。

## 2. 各能力轴现状

| 能力轴 | 接口（名称 + 文件） | 通用实现 | 独有实现 | 声明机制 | UI 按 provider 身份分支？ |
|---|---|---|---|---|---|
| **协议适配（上游推理）** | `ProviderRuntimeAdapter` `src/api/ai-gateway/providers/ProviderRuntimeAdapter.ts:34` | `BaseProviderRuntimeAdapter` + `OpenAiCompatibleRuntimeAdapter`（同文件） | `OpenAi`/`Anthropic`/`Kimi`/`Bailian`/`DeepSeek`/`CustomRuntimeAdapter`（`providers/*.ts`） | `ProviderRuntimeRegistry` 构造器里写死 provider→adapter（`ProviderRuntimeRegistry.ts:36-81`）+ `PROVIDER_UPSTREAM_OVERRIDES[...].inference.protocol` | 否（仅 `offering-endpoints.ts:35,43` 把 protocol 转文案） |
| **协议适配（客户端侧）** | `GatewayProtocolFrontend` `src/api/ai-gateway/AiGatewayService.ts:98` | `ChatCompletionsFrontend` / `ResponsesFrontend` / `MessagesFrontend`（`protocol/`） | 无 | `AiGatewayService` 按 protocol 注册（`AiGatewayService.ts:147-152`） | 否（合规样板：按 protocol，不按 provider） |
| **配额** | `ProviderQuotaAdapter` `quota/ProviderQuotaAdapter.ts:64` + `QuotaCapabilityRegistry.ts:9` | `UnsupportedQuotaAdapter`（兜底） | `OpenAi`/`Anthropic`/`Kimi`/`Bailian`/`DeepSeekQuotaAdapter` + `SubscriptionQuotaAdapters.ts`（Codex/Claude/KimiCode） | offering 的 `upstream[{capability:'quota'\|'balance'}].protocol + options.profile` → `QuotaCapabilityRegistry.resolve`（`QuotaCapabilityRegistry.ts:21`） | 否（`AiQuotaCard` 读快照） |
| **授权/连接方式** | `ProviderConnectAdapter` `connect/index.ts:867` + `OAuthIntegration`（`connect/DeviceCodeProtocol.ts`）+ `OfferingAuthorizationMethod`（`providers/OfferingAuthorization.ts:2`） | `BrowserAssistedApiKeyConnectAdapter`(:1146)、`DeviceCodeConnectAdapter`(:1256)、`AuthorizationCodeConnectAdapter`(:1676) | `DeepSeekConnectAdapter`(:2115)（"不支持"也是实现） | 派生：`providerProductsForDeployment`（`ProviderRegistry.ts:447`）；写死：`SUBSCRIPTION_AUTHORIZATION_BINDINGS`（`OfferingAuthorization.ts:12`）+ `CLIENT_PROFILES`（`connect/ProviderAuthorizationProfiles.ts:7`）+ 目录的 `authorizationMethods` | **是**：`provider-catalog.ts:400` 按 provider 名给 openai 注入授权方式 ✗ |
| **本机会话导入** | `LocalSessionImportAdapter` `connect/FileSessionImportAdapter.ts:24` + `SessionImportProfile` `connect/SessionImportProfiles.ts:4` | `FileSessionImportAdapter`（路径 + 大小/存在性/JSON 校验） | `OPENAI_CODEX_SESSION_IMPORT_PROFILE`、`KIMI_CODE_SESSION_IMPORT_PROFILE`（各自路径与 payload 解析） | `ProviderConnectService` 构造器按 `localSessionImporterKey(provider, offeringId)` 注册（`connect/index.ts:2300`）；container 只在 `edition==='local'` 装配（`src/api/container/common.ts:278`） | 部分：授权方式按 offering 投影，但身份比较（kimi JWT）留在 `connect/index.ts:3350` ✗ |
| **模型发现/目录投影** | `ProviderModelsAdapter` `models/ProviderModelsAdapter.ts:39`；另有 `ProviderModelDiscoveryAdapter` `models/ProviderModelDiscoveryAdapters.ts:16` | `OpenAiCompatibleModelsAdapter`（protocol `openai-models`）、`AnthropicModelsAdapter` | `CodexSubscriptionModelsAdapter`、`OpenAiCompatibleModelsAdapter(provider:'openai')`（产品级 safeBaseUrls） | **两套并存**：offering 的 `upstream.models.protocol` → `ProviderModelsService.protocolHandlers`；以及写死的 `ProviderModelDiscoveryRegistry` provider→adapter | 否，但 `client/normalize.ts:744` 按 provider 反推 offering ✗ |
| **凭据存储/字段写入** | `CredentialVault` `credentials/CredentialVault.ts:8` + `KeyWrapper`（`credentials/KeyWrapper.ts`）+ 行形状 `packages/ai-connections/src/credential-storage.ts` | `PlaintextCredentialVault`（含 legacy）、`WebCryptoCredentialVault` | `SecretCellCredentialVault`、`LocalKeychainWrapper`、`CloudKmsWrapper`（平台独有，不是 provider 独有） | `credentialVaultForConfig`（`src/api/container/common.ts:122`）单点选择；`array+uri` 写入由 `packages/pod-collections` 的 `writeField()` 单一入口承担 | 否（`pod-collections` 里 grep 不到 provider id，合规样板） |
| **运行时 provider 映射** | `ProviderRegistry.resolveManagedProviderId` + `MANAGED_PROVIDER_ALIASES` `providers/ProviderRegistry.ts:143` + offering 的 `runtimeProviderIds` | `resolveManagedProviderId`、`productByRuntimeProvider`（`ProviderRegistry.ts:211,233`）、`ProviderModelsAdapter.ts:271`（按 `runtimeProviderIds` 反查 offering） | `CANONICAL_PROVIDER_SLUGS`(:648)、`XPOD_PROVIDER_TO_MODELS_DEV`(`ModelsDevCatalog.ts:8`)、前端 `providerValue`（`ui/.../XpodAiConnectionsPodStore.ts:1131`） | offering.runtimeProviderIds（唯一词表入口本该只有 `MANAGED_PROVIDER_ALIASES` + 它） | **是**：前端各自再推一次（`PodStore:1134,1140`、`credential-storage.ts:123`）✗ |
| **UI 页面组合** | **无接口**（`AiProviderDefinition` 只是类型） | 无 | 每个 provider 一行展示数据，散在 4 处 | `controller.tsx:67` `PROVIDERS` + `provider-visuals.ts:28,38` + 两个 `providerMark` switch | **是**：这是本轴今天唯一的实现方式 ✗（缺口 G7） |
| （附加）**隧道 provider** | `TunnelProvider` 类型 + `TUNNEL_PROVIDER_FIELDS` `ui/src/pages/admin/SettingsPage.tsx:93` | `getTunnelProviderFields`(:125)、`parameterFieldsFor`(`NetworkPage.tsx:383`) | 每个 provider 一行字段表（数据，不是代码） | 数据表 `TUNNEL_PROVIDER_FIELDS` + `TUNNEL_PROFILE_PROVIDERS`(:128) | 是，但只在**数据表已有答案**的地方重复分支（`SettingsPage.tsx:141`、`StatusPage.tsx:39`、`NetworkPage.tsx:384`）✗ |

**读表结论**：数据面（配额、会话导入、凭据、protocol 分派）已经是"一套接口 + 注册"，缺陷集中在两处 —— **授权方式的声明面**（缺口 G1，导致 UI 出现 provider 分支）和 **provider 关键元数据的副本**（缺口 G2/G3，导致 id 清单、endpoint、label、翻译表各有 2～6 份）；另有 F20 一处**程序侧清单重复**（④，与用户数据无关）。

## 3. 审计

### 3.1 方法与计数复核

起点命令：

```bash
grep -rn "=== '\(openai\|anthropic\|kimi\|bailian\|deepseek\|zhipu\|ollama\|custom\)'" \
  --include=*.ts --include=*.tsx src/api/ai-gateway packages/ai-connections/src ui/src
```

复核结果：**命中 84 行** —— `src/api/ai-gateway` 24 行、`packages/ai-connections/src` 25 行、`ui/src` 35 行（其中 21 行集中在 `ui/src/extensions/XpodAiConnectionsPodStore.test.ts` 的断言里，不是分支）。

> 父任务给的"12 后端 + 13 前端"在本分支复核不出来；按上面的目录口径是 24 / 60，去掉测试断言后生产代码 **63 行**（24 / 25 / 14）。下面按**决策点**（把同一事实的多行合并）计数。

补充扫描：`provider ===` / `switch (provider` / `=== providerId` / `Record<…Provider…>` 常量表 / 按 provider 建的第二张表。去重后生产代码 **54 个 provider 身份决策点**（后端 30、前端 24），另有 10 处按 protocol / compatibility / keyType / deployment 分派（非 provider 身份）。

### 3.2 后端 `src/api/ai-gateway`（30 点）

| # | file:line | 决定什么 | 分类 | 说明 / 最小修法 |
|---|---|---|---|---|
| B1 | `providers/ProviderRegistry.ts:301` | `isProvidedInDeployment` 里 `providerId === 'custom'` 直接排除 | **①** | "本部署是否提供"应读数据：`custom` 的 local-only 是产品事实，加 `deploymentScope`/`ownership` 字段即可删 |
| B2 | `providers/ProviderRegistry.ts:626` | `offeringsForProduct` 给 custom 特判 | **①** | `CUSTOM_DEFAULT_OFFERINGS` 已在目录里，只是没进 `PROVIDER_OFFERINGS` 表；补一行，分支消失 |
| B3 | `providers/ProviderRegistry.ts:580` | `PROVIDER_PRODUCT_LABELS` 8 条 label 表 | **①** | 展示数据第 4 份副本（models discovery `label`、目录 `productLabel`、`controller.tsx:67` `name`） |
| B4 | `providers/ProviderRegistry.ts:591` | `PROVIDER_UPSTREAM_OVERRIDES`（provider→offering→capability） | **②** | 形状对（声明表）但键是 provider id 且写死在服务端；扩面：offering 数据引用 runtime capability 名，服务端只留 protocol→handler 注册表（同 G5） |
| B5 | `providers/ProviderRegistry.ts:630` | 用 `Object.keys(PROVIDER_PRODUCT_LABELS)` 当 provider 清单 | **①** | provider 清单是数据；这里是第 5 份副本 |
| B6 | `providers/ProviderRegistry.ts:648` | `CANONICAL_PROVIDER_SLUGS`（kimi→moonshot、bailian→qwen） | **①** | id 翻译属于关键元数据（§10），服务端不该存第二份 |
| B7 | `providers/ProviderRegistry.ts:719` | `product.id !== 'openai'` 决定是否重写订阅 offering | **②** | 通用投影无法表达"该 offering 在部署中被覆盖为 local 导入"；扩面：offering 数据声明 `sessionImport`/`authModes` 覆盖（并入 B4 的声明表） |
| B8 | `providers/ProviderRegistry.ts:742` | 单独 `getBuiltinProvider('ollama')` 拼 standalone product | **①** | 又一次硬编码 provider id；应随 B5/B6 一起数据化 |
| B9 | `providers/ProviderRegistry.ts:815-1035` | `DEFAULT_PROVIDER_DESCRIPTORS`：8 个 provider 的 endpoints / models / capabilities 字面量 | **①** | 同一份目录的第 6 份副本（含 deepseek 系模型清单、glm、kimi-k2）；权威应是 models discovery + models.dev |
| B10 | `providers/ProviderRegistry.ts:143` | `MANAGED_PROVIDER_ALIASES` 运行时词表翻译 | **③** | 合规样板：单一翻译表 + `resolveManagedProviderId` 单入口；缺口只在"另有 3 份同类表"，见 G3 |
| B11 | `providers/ProviderRuntimeRegistry.ts:36-81` | 构造器写死 provider→runtime adapter | **②** | 通用注册面不足：offering 已声明 `upstream.inference.protocol`，注册表却按 provider id；扩面：改成 protocol→adapter（配额那边已是这个形状） |
| B12 | `providers/ModelsDevCatalog.ts:8` | `XPOD_PROVIDER_TO_MODELS_DEV` 6 条映射 | **①** | provider→上游目录 id 是数据；与 B6/B10 同类，见 G3 |
| B13 | `providers/ModelsDevCatalog.ts:97` | `provider.id === 'deepseek'` 纠正 flash 的 reasoningEffort | **②** | models.dev 投影无法表达"该 family 实际支持 reasoningEffort"；扩面：声明式 capability 覆盖表（按目录 provider + 模型 id 模式），同时可覆盖 `fast` 这类策展能力 |
| B14 | `models/ProviderModelDiscoveryAdapters.ts:53-72` | 第二个注册表：provider→discovery adapter | **②** | 同一接口的两套注册（另一套在 `ProviderModelsService.protocolHandlers`，`ProviderModelsService.ts:44-48`）；扩面：按 `upstream.models.protocol` 解析，本表退化为 handler 表 |
| B15 | `models/ProviderModelsService.ts:250` | custom 走 protocol handler 而非 provider adapter | **②** | 通用路径读 offering 的 `upstream.models.protocol`；把 custom 登记为 product 即可删分支 |
| B16 | `models/ProviderModelsService.ts:275` | `provider === 'custom' && compatibility === 'auto'` 双协议探测 | **②** | 探测本身合规（实现同一 `ProviderModelsAdapter`），缺的是"按**声明的** compatibility 选 adapter"——查找键应是策略名而不是 provider id |
| B17 | `models/ProviderModelsService.ts:374,382,385` | 用 `offeringId === 'anthropic-compatible'` + compatibility 推协议 | **①** | offering 数据已带 `modelDiscovery.strategy`/`endpointProtocol`；用 id 字面量再判一次 |
| B18 | `models/ProviderModelsAdapter.ts:271` | 按 `runtimeProviderIds` 反查 offering | **③** | 合规样板：凭据→offering 的唯一解析路径，值得其它轴照抄 |
| B19 | `models/ProviderModelsAdapter.ts:383` | `=== 'custom'` 判定用户自有 provider | **②** | descriptor 缺"用户自有"属性，只能按 id 判；扩面：`ownership: 'managed' \| 'user'` |
| B20 | `connect/index.ts:2346` | custom 不回显 endpoints | **②** | 扩面：offering/descriptor 声明"端点由用户提供、不可回显"（`userSuppliedEndpoints`） |
| B21 | `connect/index.ts:3334,3350` | `provider === 'kimi'`：按 JWT `iss` 推账号身份提示 | **③** | 真独有（kimi token 格式），但位置错：应实现 `SessionImportProfile` 上的身份钩子，而不是在 connect 服务里跨 provider 判断 |
| B22 | `connect/index.ts:3975` | bailian 旧 offering 文档名折回 | **①** | 迁移别名是数据；与 `ui/.../XpodAiConnectionsPodStore.ts:851,864` 重复两份 |
| B23 | `connect/index.ts:4127,4150,4151,4159,4196` | custom provider id 家族（含 `custom-instance-<credentialId>`） | **①** | 同一文件 `queryProviderIds` 的 `${provider}-${offeringId}` 通用推导已经覆盖 `custom-openai-compatible` 等；custom 分支冗余。`custom-instance-` 前缀判断应改用 `credential-storage.ts` 的共享规则（现为两份） |
| B24 | `connect/index.ts:1654,2086` | `credential.provider === this.provider` | **③** | 合规样板：适配器实例内的相等比较，不是身份分派 |
| B25 | `connect/OfferingAuthorization.ts:12` | `SUBSCRIPTION_AUTHORIZATION_BINDINGS`（provider×offering→integration） | **③** | 形状正确（声明表→注册插件），也是"浏览器登录"唯一的来源；但它是 provider 命名的第二份声明，与目录 `authorizationMethods` 重复 → G1 |
| B26 | `connect/ProviderAuthorizationProfiles.ts:7,78,92` | `CLIENT_PROFILES` / `BROWSER_PROTOCOLS` 描述符表 | **③** | 合规样板：纯描述符 + 注册，实现 `OAuthIntegration` |
| B27 | `connect/SessionImportProfiles.ts:12,20` | 两个本机登录态 profile | **③** | 合规样板：接口 + 按 provider/offering 注册；"独有"应该长这样 |
| B28 | `quota/SubscriptionQuotaAdapters.ts:64,84,105` | `supports()` 里再判 `offeringId === 'official-subscription'` | **①** | offering→capability 已由 `PROVIDER_UPSTREAM_OVERRIDES` 的 protocol+profile 声明；`supports` 再判一次是第二份判断 |
| B29 | `providers/OpenAiRuntimeAdapter.ts:29` | `offeringId === 'official-subscription'` 决定订阅路径 | **①** | offering 已声明 `codex-models` capability；adapter 应读声明，不读 id 字面量 |
| B30 | `AiGatewayService.ts:845,873` | 按 protocol 生成响应 | **③** | 协议插件维度（非 provider 身份），形状合规 |

### 3.3 前端 `packages/ai-connections` + `ui/src`（24 点）

| # | file:line | 决定什么 | 分类 | 说明 / 最小修法 |
|---|---|---|---|---|
| F1 | `packages/ai-connections/src/controller.tsx:67` | `PROVIDERS`：id/name/description/homeUrl/apiKeyUrl/placeholder/defaultBaseUrl | **①** | provider 目录第 3～4 份副本；`name` 与 B3、目录 `productLabel`、models discovery `label` 重复 |
| F2 | `packages/ai-connections/src/client/types.ts:9` | `AI_CONNECTIONS_PROVIDERS` id 清单 | **①** | 清单第 N 份副本；`controller.tsx:102` 用**运行时断言**保证两份一致，正是两份数据的症状 |
| F3 | `packages/ai-connections/src/provider-catalog.ts:88-101` | endpoint/console/usage URL 常量 + `PROVIDER_OFFERINGS` 字面量 | **①** | §10 已裁决 endpoint/region/authModes 由 models discovery 投影，本文件仍存第二份（"收敛动作 #1"未完成） |
| F4 | `packages/ai-connections/src/provider-catalog.ts:400` | `provider === 'openai'` 时才给订阅 offering 注入"设备码 + 已有登录态" | **②** | **头号缺口 G1**：推导无法表达"本部署有 importer 时该 offering 多一种入口"，于是写成 provider 名分支 |
| F5 | `packages/ai-connections/src/provider-catalog.ts:419` | `offeringId === 'anthropic-compatible'` → 兼容模式 | **①** | offering 数据已带 `modelDiscovery.strategy` |
| F6 | `packages/ai-connections/src/provider-catalog.ts:424-441` | `providerName()` switch | **①** | display name 分支；与 F1/B3 重复 |
| F7 | `packages/ai-connections/src/provider-catalog.ts:445,448` | openai/kimi 的 authMode→offering 归属 | **②** | 通用推导只覆盖 `api-platform`/`apiKey` 一档；扩面：offering 行声明"我承接哪些 authMode"（`defaultForAuthModes`），见 G1 |
| F8 | `packages/ai-connections/src/provider-catalog.ts:451,452,453` | bailian/ollama/custom 的默认 offering | **①** | 同上，数据可表达（`isDefault` / `defaultForAuthModes`） |
| F9 | `packages/ai-connections/src/authorization-methods.ts:18-48` | authModes → authorizationMethods 推导 | **②** | 通用实现，但输入只有 `authModes` + `kind`：缺"该 entry 由哪个已注册 profile 提供、在本部署是否可用"；与 F4 是同一条缺口 |
| F10 | `packages/ai-connections/src/authorization-methods.ts:90` | `modeForOffering` 兜底只剩两档 | **②** | 同上：`oauth/deviceCode → deviceCodeOAuth`、其余 → `browserAssistedApiKey`，表达不了 authorization-code / 本机导入 |
| F11 | `packages/ai-connections/src/credential-storage.ts:123` | `name.startsWith('custom-')` 推 provider | **①** | 前缀约定写死；应从目录 provider 清单派生（且服务端 B23 有一份平行实现） |
| F12 | `collection-runtime.ts:122`；`controller.tsx:414,749,795,827`；`AiConnectionsPanel.tsx:786,864,1250`；`AiConnectionsMain.tsx:60,66`；`ui/.../XpodAiConnectionsPodStore.ts:104,148,442,445,573,578,581,893` | "custom ⇒ 凭据即 provider 实例"（凭据作用域、行 id、provider 行生成…） | **②** | 同一事实散落 **16 处**。扩面：provider 数据声明 `credentialScope: 'provider' \| 'instance'`（或把 custom 实例提升为一类 kind），见 G6 |
| F13 | `packages/ai-connections/src/AiConnectionsMain.tsx:125,132,134,136` | compatibility → 端点/发现策略/文案 | **①** | 读 offering 的 `endpoints`/`modelDiscovery` 即可 |
| F14 | `AiProviderCard.tsx:351` + `AiConnectionsList.tsx:234` | `providerMark()` 两份 switch | **①** | mark 是展示数据，且复制两份 → G7 |
| F15 | `packages/ai-connections/src/provider-visuals.ts:28,38` | `providerAvatars` / `providerAvatarBackgrounds` id→资源表 | **①** | 表的形状对、位置错：应随 provider 目录数据走（一份），别散在 applet |
| F16 | `ui/src/extensions/XpodAiConnectionsPodStore.ts:48` | `POD_PROVIDERS` 再拼一份清单 | **①** | 且重复加入了已在 `AI_CONNECTIONS_PROVIDERS` 里的 zhipu/ollama/custom |
| F17 | `ui/src/extensions/XpodAiConnectionsPodStore.ts:851,864` | bailian 旧 offering 名折叠 | **①** | 与 B22 重复两份 → G8 |
| F18 | `ui/src/extensions/XpodAiConnectionsPodStore.ts:1134` | zhipu 前缀特判 | **①** | 下方通用前缀循环（:1138）已覆盖，冗余分支 |
| F19 | `ui/src/extensions/XpodAiConnectionsPodStore.ts:1140` | `bailian-token-plan` / `bailian-coding-plan` 特判 | **①** | `bailian-` 前缀规则已覆盖，冗余分支 |
| F20 | `packages/ai-connections/src/service-access.ts:15` + `src/api/ai-gateway/service-access/AiConnectionsServiceAccess.ts:10` | 两份 24 条 provider 文档 id 清单 | **④** | 判断本身合规：applet 服务身份的访问面是**程序能力**，留在程序/配置。缺陷是同一程序事实手写两份 —— 服务端 `AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS`（24 条）在 `:96` 逐条发出 `access: { read, append, write }` 的 `providerDocument:*` 资源；能力模块 `PROVIDER_DOCUMENT_IDS`（同样 24 条）在 `service-access.ts:42` 建 Set、`:126` 校验 `providerDocument:*` 的文档路径，两份必须逐条对齐。撤回早前"给 offering 加 `exposedDocuments` 式暴露字段 / 由目录 `${provider}-${offeringId}` 投影"的建议：把"服务能访问什么"写进数据方向相反，且会随目录新增 offering 自动扩权。修法：**一份程序侧清单**（随程序 review）+ 一条守卫测试 |
| F21 | `packages/ai-connections/src/offering-endpoints.ts:35,43` | protocol → 端点文案 | **①** | protocol 维度的文案表（非 provider 身份），应做表而不是分支 |
| F22 | `packages/ai-connections/src/AiCustomProviderDialog.tsx:188` | compatibility → offering id | **①** | 反向映射；offering 数据自带 id 与 protocol |
| F23 | `packages/ai-connections/src/client/normalize.ts:744` | `provider === 'kimi'` → `subscription-key` | **②** | 服务端已经知道答案（offering 由 B18 解析）；wire 上应直接带 `offeringId`，前端不该按 provider 反推 |
| F24 | `packages/ai-connections/src/AiConnectionsPanel.tsx:1019,1214` | `PROVIDERS.find(...).name ?? provider` | **①** | 同一份 display name 的第 4 次投影 |

### 3.4 非 provider 身份的分派（不计入 ①②③④）

按 protocol / compatibility / keyType / deployment 分派，**不是** provider 身份分支，规则不禁止；其中前 3 处仍建议改为**程序侧声明表**（表驱动）：

`ProviderRegistry.ts:556`（discovery strategy → models protocol）、`ProviderRegistry.ts:776`（endpoint protocol → 默认 discovery strategy）、`ProviderRegistry.ts:810`（`toGatewayProtocol` 词表）、`CustomRuntimeAdapter.ts:51`（compatibility）、`ProviderModelSelectionService.ts:584`（compatibility 校验）、`types.ts:181`（image part 形状）、`AiGatewayService.ts:750`（compatibility 读元数据）、`BailianRuntimeAdapter.ts:33,37,41`（keyType 三档，插件内部）、`XpodAiConnectionsPodStore.ts:691`（compatibility 校验）、`quota/ProviderQuotaAdapter.ts:118` 等 authMode 联合类型。

### 3.5 分类计数

| 分类 | 后端 | 前端 | 合计 |
|---|---|---|---|
| **① 挪进程序侧声明** | 13 | 17 | **30** |
| **② 通用实现适应面不足** | 9 | 6 | **15** |
| **③ 真独有插件**（允许；标 ⚠ 的需补接口） | 8 | 0 | **8** |
| **④ 程序侧单一来源** | 0 | 1 | **1** |
| 合计决策点 | 30 | 24 | **54** |
| 非 provider 身份分派（不计入） | 9 | 1 | 10 |

④ 只有 F20 一点（清单前后端共用，按出现位置计入前端列）：它是**程序侧去重**，与用户数据无关，因此 ① 由 31 降为 30，决策点总数 54 不变。

③ 的 8 点里，合规样板 6 个（B10 运行时词表、B18 offering 解析、B24 适配器内比较、B26 OAuth 描述符、B27 会话导入 profile、B30 协议 frontend），需补接口的 2 个（B21 kimi 身份钩子、B25 订阅绑定声明）。

**UI 按 provider 身份分支的实际位置**：`AiProviderCard.tsx:351`、`AiConnectionsList.tsx:234`、`provider-visuals.ts:28,38`、`provider-catalog.ts:400`、`controller.tsx:67`、`client/types.ts:9`、`XpodAiConnectionsPodStore.ts:48,1134,1140` —— 一共 9 处。

### 3.6 隧道 provider 附录（另一能力轴，同形，3 点）

| # | file:line | 决定什么 | 分类 | 说明 |
|---|---|---|---|---|
| T1 | `ui/src/pages/admin/SettingsPage.tsx:141` | `getTunnelProfileLabel` switch | **①** | `TUNNEL_PROVIDER_FIELDS`(:93) 已是数据表，再加一个 label 字段即可 |
| T2 | `ui/src/pages/admin/StatusPage.tsx:39` | `resolveActiveTunnelUrl` switch（ngrok/cloudflare/sakura_frp/frp → env key） | **①** | env key 已在 `TUNNEL_PROVIDER_FIELDS` 的 `publicEndpointKey`，直接查表 |
| T3 | `ui/src/pages/settings/NetworkPage.tsx:384` | `parameterFieldsFor` 三分支 | **①** | 第三份 provider→字段表；应复用 `TUNNEL_PROVIDER_FIELDS` + 参数字段数据 |

这条轴值得当成"小样板"先做：它的数据表已经存在，去掉分支不需要任何新接口。

### 3.7 新增一个 provider 需要做什么（理想答案）

目标：**加程序侧声明行；最多再实现一个已声明形状的 profile/source 插件**。用户数据不新增任何字段 —— 用户侧只有凭据、所选 offering、endpoint/key 这些属于用户自己的东西。

1. 在 `@undefineds.co/models` 的 `src/discovery/providers.json` 加 provider 行：`id`/`label`/`endpoints(protocol+baseUrl+region)`/`authModes`/`modelDiscovery`/`quota`/`runtimeProviderIds`/offerings（§10 的权威来源）。
2. **先假设不改代码**：如果它的推理与 `/models` 是 OpenAI 或 Anthropic 兼容，通用实现（`OpenAiCompatibleRuntimeAdapter` + `openai-models`/`anthropic-models` handler + api-key/browser 授权 + unsupported quota）应当已经跑通。
3. 若它的上游协议不兼容：实现**一个** `ProviderRuntimeAdapter`（必要时再加 `ProviderModelsAdapter`），并在注册表里按 **protocol** 声明（今天还要改 `ProviderRuntimeRegistry` 的构造器——这是 G5 要修掉的部分）。
4. 若它有订阅/设备码/浏览器授权：加一条 OAuth 集成描述符（`CLIENT_PROFILES` 形状）+ 一条 binding 声明（**程序侧声明**，随程序发布与 review，不是 if，也不是用户数据）。
5. 若它有额度端点：实现**一个** `ProviderQuotaAdapter`，声明 `capability { protocol, profile }`，在 offering 的 `upstream` 里引用（今天写 `PROVIDER_UPSTREAM_OVERRIDES`——G5）。
6. 若它的本机登录态是自有文件：加**一个** `SessionImportProfile`（路径 + payload 解析 + 身份钩子，后者今天还没有——B21）。
7. 展示元数据（mark/avatar/描述/console/申请入口）在能力模块补一行，**只补一行**。
8. 若该 provider 的文档要开放给 applet 服务身份：在**程序侧唯一清单**里加它的文档 id（今天 `AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS` 与 `PROVIDER_DOCUMENT_IDS` 是两份，先收敛成一份，见 F20/④），并补一条守卫测试；**不得**为此在 offering 或任何用户数据上加 `exposedDocuments` 之类的暴露字段 —— 服务身份的访问面是程序能力，随程序提交与 review。
9. **禁止**：在任何 UI 或服务代码里加 `provider === '<new-id>'`；禁止在第二处重写 endpoint / label / id 清单。
10. 验收：`tests/api/ai-gateway/ProviderCatalogWiring.test.ts` 一类守卫之外，加一条机械检查 —— `grep -rn "'<new-id>'"` 只应命中**程序侧声明文件**（catalog / discovery / 展示数据）。

## 4. 接口缺口（按优先级）

### G1（最高）授权方式的推导缺"部署可用性"输入

- **症状**：`authorizationMethodsForOffering`（`authorization-methods.ts:18`）只能从 `authModes` + `kind` 推；`modeForOffering`(:90) 只剩两档。于是"浏览器登录（authorization code + 本机回调）"和"已有登录态（本机导入）"表达不出来，UI 只能写 `provider === 'openai'` 注入（`provider-catalog.ts:400`），服务端再维护一份 `SUBSCRIPTION_AUTHORIZATION_BINDINGS`（`OfferingAuthorization.ts:12`）。
- **同一事实的副本**：F4、F7、F10、F23、B7、B25（6 处）。
- **建议**：把 `SUBSCRIPTION_AUTHORIZATION_BINDINGS` 提升为**目录数据**（offering 上的 `authorizationBindings: { integrationId, browserIntegrationId? }`），服务端把 `CLIENT_PROFILES` 投影成"本部署可用绑定"，UI 只按 `method.connectMode` + `method.lifecycle` 渲染并删除 provider 判断；`defaultOfferingFor` 改读 offering 上声明的 `defaultForAuthModes`。**不做代码改动，列为后续任务。**

### G2 目录数据源仍有两份以上副本

- **症状**：models discovery（§10 权威）之外，`provider-catalog.ts:88-101` 仍有 baseUrl/region/console 字面量，`ProviderRegistry.ts:815-1035` 又有一份 descriptor，`controller.tsx:67` 还有一份展示行。（两份 24 条的文档 id 清单（F20）不属于本条：那是**程序侧清单重复**，见 ④。）
- **建议**：按 §10 已裁决的收敛动作 #1 执行：`provider-catalog.ts` 只补展示/动作字段，其余从 `@undefineds.co/models/discovery` 投影；provider 清单（`AI_CONNECTIONS_PROVIDERS` 等）从目录派生，删除独立副本。F20 的文档 id 清单按 ④ 单独处理：收敛成一份**程序侧**清单 + 守卫测试，不并入本条的数据投影（服务身份的访问面不随目录自动扩张）。

### G3 运行时 provider 词表翻译有四份

- **症状**：`MANAGED_PROVIDER_ALIASES`(B10)、`CANONICAL_PROVIDER_SLUGS`(B6)、`XPOD_PROVIDER_TO_MODELS_DEV`(B12)、前端 `providerValue`/`POD_PROVIDERS`(F16/F18/F19)。
- **建议**：一个数据块（models discovery 的 `runtimeProviderIds` + 目录 id + 上游目录 id）派生出这三张表；翻译只保留 `resolveManagedProviderId` 一个入口，前端不自行推断（配合 G1 让 wire 直接带 offeringId）。

### G4 模型发现有两套注册机制

- **症状**：`ProviderModelDiscoveryRegistry`（provider→adapter，`ProviderModelDiscoveryAdapters.ts:53`）与 `ProviderModelsService.protocolHandlers`（protocol→adapter，`ProviderModelsService.ts:44`）是同一件事的两套注册。
- **建议**：只留 protocol 注册表（配额轴已经是这个形状：`QuotaCapabilityRegistry` 按 `protocol+profile`），provider 通过 offering 的 `upstream.models.protocol` 选到 handler。

### G5 上游运行时适配器按 provider id 注册

- **症状**：`ProviderRuntimeRegistry.ts:36-81` 写死 8 个 provider；`PROVIDER_UPSTREAM_OVERRIDES` 也是 provider 键的第二份声明。
- **建议**：注册表键改为 `upstream.inference.protocol`（与 G4 同一形状），provider 只通过 offering 数据选到 protocol；独有 adapter 不变（仍实现 `ProviderRuntimeAdapter` 并按 protocol 注册）。

### G6 "用户自有 / provider 实例"没有声明位

- **症状**：`custom` 的 16 处分支（F12）实际是三件事没有数据位：凭据即 provider 实例、端点由用户提供、协议可自动探测。
- **建议**：provider/offering 数据加 `ownership: 'managed' | 'user'`（可拆 `instanceScopedCredentials` / `userSuppliedEndpoints` / `protocolDetection: 'auto'`）；`CustomRuntimeAdapter` 的探测逻辑保留为同一接口的实现，删除按 id 的判断（B19/B20/F12）。

### G7 展示元数据没有声明位

- **症状**：`name`/`description`/`mark`/`avatar`/`homeUrl`/`apiKeyUrl`/`apiKeyPlaceholder` 散在 4～5 处（F1/F6/F14/F15/F24 + B3 + B9）。
- **建议**：按 `catalog-ownership.md`「展示字段归 applet，但只留一份」：能力模块的 provider 行加 `mark`/`avatar`/`description`/`homeUrl`/`apiKeyUrl`/`apiKeyPlaceholder`，UI 只做投影，两个 `providerMark` switch 与两张视觉表删除。

### G8 迁移别名散落

- **症状**：bailian 旧 offering 文档名（`token-plan-personal`/`coding-plan-pro`）在 B22 与 F17 各有一份。
- **建议**：一张显式标注 `MIGRATION WINDOW` 的别名表，收敛到一个入口（`AGENTS.md` 已要求），迁移完成后删除。

**优先级**：G1 → G2 → G3 → G6/G4/G5 → G7/G8。G1 是规则点名的那个缺口，也是唯一让 UI 必须按 provider 身份分支的原因。

## 5. 边界

- 本文是**审计 + 设计**：没有行为改动，没有新增/修改任何生产代码；§3 的 54 个决策点与 §4 的 8 个缺口都只是结论。
- 迁移是后续任务，按缺口拆开做；每条都要能写成"删掉哪些分支、加了哪行数据/哪条声明"，并配一条机械守卫（如 §3.7 第 10 步的 grep 检查）。
- 本文与 `catalog-ownership.md`、`ai-connections-storage-model.md` §10/§11 冲突时，以那两份为准并回来修本文。
