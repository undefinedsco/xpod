# AI Connections Provider 与认证设计

> 日期：2026-08-08
>
> 状态：待用户书面评审
>
> 范围：Provider、Offering、凭据池、模型选择与 Gateway 自动解析；不包含页面视觉重做和应用层凭据加密。

## 1. 产品目标

AI Connections 对用户只暴露三个核心概念：

```text
Provider
├── 凭据
│   ├── OAuth 账号
│   └── API Keys
└── 模型
```

用户选择一个 Provider，登录账号或添加 API Key，再选择需要开放给应用的模型。Offering、Endpoint、协议匹配、凭据选择和故障切换由 Provider preset 与 Gateway 自动完成。

产品不得要求用户理解或手工配置 Connection、Binding、Route、Alias，也不得要求用户输入 OAuth `client_id`。

## 2. 界面信息架构

AI Connections 使用 LinX/Xpod 宿主的三栏骨架：

```text
┌──────┬────────────────────────┬──────────────────────────────────────┐
│ Rail │ Provider 列表          │ Provider 详情                        │
│      │                        │                                      │
│      │ 🔍 搜索...        [+]  │ Kimi                                 │
│      │                        │                                      │
│      │ ● Kimi                 │ 认证                                 │
│      │ ● 百炼                 │ 官方账号 / API Keys                  │
│      │ ○ OpenAI               │                                      │
│      │ ○ Anthropic            │ 可用模型                             │
│      │ ○ DeepSeek             │                                      │
└──────┴────────────────────────┴──────────────────────────────────────┘
```

- Rail 由宿主提供，Applet 不绘制自己的产品头。
- 左栏一行一个 Provider，不按 OAuth/API Key/账号拆行。
- 搜索与添加按钮位于列表栏顶部。
- Provider 是否可用由其凭据池和模型状态汇总，不把单个凭据状态当作 Provider 状态。

## 3. Provider 详情

```text
Kimi                                                    [···]

认证

官方账号
● ganlu@example.com                     [重新授权] [退出]
                                         [+ 添加账号]

API Keys
● 生产 Key      sk-••••82fa                  [编辑] [删除]
○ 备用 Key      sk-••••91bc                  [启用] [删除]
                                         [+ 添加 Key]

可用模型                                      [刷新模型]
☑ kimi-k2.5
☑ kimi-thinking
☐ kimi-turbo
                                               [保存]
```

固定操作：

- Provider：更多菜单、刷新状态；
- OAuth：登录、添加账号、重新授权、退出；
- API Key：添加、编辑、启用/停用、删除；
- 凭据池：拖动排序、测试全部；
- 模型：刷新模型、勾选、保存。

## 4. 领域模型

### 4.1 Provider

Provider 是用户看到的一级对象，也是左栏唯一 item 类型。

```ts
interface ProviderDescriptor {
  id: string
  displayName: string
  icon?: string
  source: 'builtin' | 'signedCatalog' | 'custom'
  offerings: OfferingDescriptor[]
}
```

Provider catalog 提供厂商身份、Offering 和集成能力。用户不创建额外的 Provider Group 资源；左栏由 Provider catalog 与用户 Pod 中的状态自动投影。

### 4.2 Offering

Offering 表达产品、区域和计费套餐，但不是左栏 item：

```ts
type OfferingKind =
  | 'payAsYouGo'
  | 'codingPlan'
  | 'tokenPlan'
  | 'officialSubscription'
  | 'local'
  | 'custom'

interface OfferingDescriptor {
  id: string
  providerId: string
  displayName: string
  kind: OfferingKind
  authOptions: AuthOptionDescriptor[]
  endpoints: EndpointDescriptor[]
  quotaStrategy?: string
  modelDiscoveryStrategy?: string
}
```

Token Plan/Coding Plan 是 Offering，不是认证方式。同名套餐可以按厂商分别采用 OAuth 或专属 API Key。

其中认证选项和 Endpoint 由 preset 声明：

```ts
type AuthMode = 'oauthAuthorizationCode' | 'deviceCode' | 'apiKey' | 'local'

interface AuthOptionDescriptor {
  id: string
  mode: AuthMode
  displayName: string
  integrationRef?: string
  apiKey?: {
    prefixHints?: string[]
    consoleUrl?: string
  }
}

interface EndpointDescriptor {
  id: string
  region?: string
  protocol: 'responses' | 'chatCompletions' | 'anthropicMessages'
  baseUrl: string
  modelsUrl?: string
  allowedCredentialKinds: Array<'oauthToken' | 'apiKey' | 'none'>
}
```

当 Provider 有多个差异明显的 Offering，详情页以内部分区或 Tab 表达：

```text
百炼

服务类型
[按量] [Coding Plan] [Token Plan]
```

### 4.3 Credential

所有凭据都归属 Provider，并记录适用 Offering：

```ts
type CredentialKind = 'oauthToken' | 'apiKey' | 'local'

interface ProviderCredential {
  id: string
  providerId: string
  offeringId: string
  kind: CredentialKind
  label?: string
  accountId?: string
  secretRef: string
  enabled: boolean
  priority: number
  status: 'healthy' | 'expired' | 'invalid' | 'unknown'
}
```

OAuth 多账号和多个 API Key 都属于 Provider 的凭据池。界面按凭据类型和 Offering 分区，不把每个凭据显示成左栏 item。

### 4.4 Model Selection

用户只在 Provider 下选择一次模型：

```ts
interface ProviderModelSelection {
  providerId: string
  modelId: string
  enabled: boolean
  preferredOfferingId?: string
}
```

正常情况不要求设置 `preferredOfferingId`。只有多个 Offering 暴露同名模型且语义或计费差异无法自动判断时，Gateway 才提示用户选择首选服务类型。

模型不直接绑定 OAuth 账号或 API Key。凭据轮换发生在 Gateway 内部。

## 5. 认证方式

### 5.1 OAuth

OAuth 是 Provider Offering 提供的一种认证选项：

```ts
interface OAuthIntegration {
  id: string
  clientId: string
  authorizationEndpoint?: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint?: string
  scopes: string[]
  flow: 'authorizationCodePkce' | 'deviceCode'
  clientAuthentication: 'none' | 'clientSecretBasic' | 'clientSecretPost'
}
```

产品规则：

- `client_id`、endpoint、scope 由 Xpod 或受信 Provider preset 提供；
- 用户只看到“使用 Kimi 账号登录”；
- 最终用户不可输入 `client_id` 或 `client_secret`；
- 不复用官方 CLI/桌面应用的 OAuth client id；
- Xpod 没有合法 OAuth 集成时，显示“账号登录暂不可用”，并在该 Provider 支持时提供 API Key 入口；
- OAuth 登录与 API Key 可以分别使用，也可以同时存在。

### 5.2 API Key

API Key 表单显示：

- Key 名称与秘密输入；
- Offering/服务类型；
- 区域和协议（需要时）；
- 根据 preset 自动确定的 Endpoint；
- 打开厂商控制台的辅助链接；
- 测试并保存。

“打开控制台”不是 OAuth，按钮与文案不得叫“浏览器登录”。

### 5.3 首期映射

| Provider | Offering | Auth Option | 用户体验 |
| --- | --- | --- | --- |
| Kimi | 官方订阅 | OAuth | 使用 Kimi 账号登录，不出现 client id |
| Kimi | API 平台按量 | API Key | 粘贴 Moonshot API Key |
| 百炼 | 按量 | API Key | 通用百炼 Key |
| 百炼 | Coding Plan | 专属 API Key | 使用 Coding Plan 专属 Key/Endpoint |
| 百炼 | Token Plan 个人版 | `sk-sp-*` 专属 API Key | 使用个人版专属 Key/Endpoint |
| 百炼 | Token Plan 团队版 | `sk-sp-*` 专属 API Key | 使用席位成员 Key/Endpoint |
| 其他厂商 Token Plan | OAuth 或 API Key | 由 Offering preset 声明 | 不根据套餐名推断认证方式 |

如果厂商后续为现有 Offering 增加 OAuth，只需在该 Offering 中增加 Auth Option，不需要创建新的 Provider。

## 6. Gateway 自动解析

应用只请求稳定的 Provider 模型名：

```text
kimi/kimi-k2.5
```

Gateway 自动执行：

```text
模型请求
  → 找到 Provider
  → 找到支持该模型的 Offering
  → 找到匹配 Offering 的健康凭据
  → 按用户排序选择 OAuth 账号或 API Key
  → 解析 Endpoint 与协议
  → 发起请求
```

用户不配置 Connection、Route、Binding 或 Alias。

默认凭据策略：

1. 只考虑启用、未过期并与 Offering/Endpoint 匹配的凭据；
2. 按用户排序选择；
3. 当前凭据认证失败时标记 invalid，不静默无限重试；
4. 配额耗尽或临时故障时可切换下一凭据；
5. OAuth 不可用时是否回退 API Key，由凭据排序和 Offering 兼容性共同决定；
6. 不允许把百炼按量 Key 发往 Token Plan Endpoint，或把 Coding Plan Key 发往按量 Endpoint。

高级策略如轮询、额度优先和按模型路由暂不进入首期 UI。底层保留扩展点，但默认产品只有凭据排序。

## 7. 模型发现与选择

刷新模型时，Gateway 按 Provider 已配置的 Offering 和健康凭据执行发现，合并结果后展示：

```text
☑ kimi-k2.5
  来源：官方订阅、API 平台

☑ kimi-thinking
  来源：官方订阅

☐ moonshot-v1-128k
  来源：API 平台
```

规则：

- 同一 Provider 的同名模型只显示一次；
- 保留模型来源信息，但默认不要求用户选择来源；
- 已选模型在上游消失时仍显示，并标记“不可用”；
- 只有不同 Offering 的同名模型表现或计费语义不兼容时，提示选择首选服务类型；
- 保存后，Gateway `/v1/models` 只投影用户选中的模型。

## 8. 添加 Provider

全局 `[+]` 打开 Provider catalog：

```text
添加 AI Provider

🔍 搜索供应商...

[Kimi] [百炼] [OpenAI] [Anthropic]
[DeepSeek] [OpenRouter] [Ollama] [自定义服务]
```

选择 Provider 后进入详情页，由用户任选一种动作：

```text
Kimi

[使用 Kimi 账号登录]

或

[配置 API Key]
```

Provider 添加到左栏不代表已连接；只有至少一个凭据通过验证后才标记可用。

## 9. 管理 API

管理面围绕 Provider、Credential 和 Model Selection，而不是暴露 Connection 路由：

```text
GET    /api/ai/providers
POST   /api/ai/providers/:provider/credentials/oauth/begin
POST   /api/ai/providers/:provider/credentials/oauth/poll
GET    /api/ai/oauth/callback/:integration
POST   /api/ai/providers/:provider/credentials/api-key
PATCH  /api/ai/providers/:provider/credentials/:credentialId
DELETE /api/ai/providers/:provider/credentials/:credentialId
POST   /api/ai/providers/:provider/credentials/test
POST   /api/ai/providers/:provider/models/refresh
PUT    /api/ai/providers/:provider/models/selection
```

内部实现可以使用 Connection/Route 类型，但不得让 UI、Pod 公共模型或普通 Applet API 依赖这些内部概念。

## 10. 状态与错误

Provider 汇总状态：

- 未配置：没有可用凭据；
- 可用：至少一个健康凭据，且至少一个选中模型可调用；
- 需处理：存在过期/无效凭据或已选模型失效；
- 服务异常：凭据有效但 Provider 网络或服务不可达。

关键错误：

- `auth_not_available`：Xpod 没有合法 OAuth 集成；不要求用户补 client id；
- `credential_endpoint_mismatch`：Key/Token 与 Offering Endpoint 不匹配；
- `authorization_expired`：OAuth attempt 或 refresh token 失效；
- `authorization_denied`：用户或厂商拒绝授权；
- `provider_test_failed`：认证成功但模型发现或最小推理失败；
- `quota_unknown`：厂商无可靠额度接口，不显示为 0；
- `no_eligible_credential`：没有支持当前模型和 Offering 的健康凭据。

## 11. 安全与数据边界

- Provider/Offering catalog 可公开，Credential 永远不进入 catalog 或管理列表的明文响应；
- OAuth state、PKCE verifier、device code 是短期数据，过期即销毁；
- `client_secret` 不进入浏览器、桌面渲染进程或用户 Pod；
- API Key/OAuth Token 第一阶段依赖 Pod ACL 与最小权限；应用层加密另立安全设计；
- 自定义 Provider 复用统一 SSRF、redirect 和 DNS rebinding 防护；
- 日志只记录 provider/offering/credential correlation id，不记录秘密。

## 12. 测试与验收

### 数据与解析

- Provider 可声明多个 Offering；
- Offering 可同时声明 OAuth 和 API Key；
- Token Plan 不自动推断 Auth Mode；
- 同一 Provider 支持多个 OAuth 账号和多个 API Key；
- 凭据只用于匹配的 Offering、Endpoint 和协议；
- Provider 模型合并、来源保留和失效状态正确。

### OAuth

- PKCE/state 成功、篡改、重复回调、过期；
- Device Code pending/slow_down/denied/expired/success；
- refresh、revocation、logout；
- API、日志和 Pod 非凭据资源不泄漏 secret/token。

### 产品验收

- 左栏始终一行一个 Provider；
- Kimi OAuth 全程不出现 client id 输入框；
- Kimi OAuth 与 API Key 可以单独使用或同时存在；
- 多个 OAuth 账号和多个 API Key 在 Provider 详情内管理；
- 模型只选择一次，不要求绑定具体凭据；
- 百炼按量、Coding Plan、Token Plan 的 Key/Endpoint 不可误配；
- Provider 通过真实模型发现和最小推理检查后才标记可用；
- Codex、Claude Code、Pi、CodeBuddy 只看到用户选中的 Provider 模型。

## 13. 非目标

- 不在首期实现所有厂商 OAuth；
- 不把 Token Plan 统一改成 OAuth；
- 不允许用户自带 OAuth client id/client secret；
- 不把 Connection、Binding、Route、Alias 暴露给用户；
- 不在首期提供复杂按模型路由 UI；
- 不在本设计中解决应用层凭据加密；
- 不重做 Xpod/LinX Layout。
