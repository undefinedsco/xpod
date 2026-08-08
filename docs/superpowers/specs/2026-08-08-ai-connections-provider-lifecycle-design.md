# AI Connections Provider Descriptor 与认证生命周期设计

> 日期：2026-08-08
>
> 状态：待用户书面评审
>
> 范围：Provider、Offering、认证、Endpoint、Connection 的统一表达；不包含页面视觉重做和应用层凭据加密。

## 1. 目标

AI Connections 使用一套统一描述符表达厂商、产品套餐、认证方式、协议和访问端点，避免以下错误绑定：

- 把 Token Plan 或 Coding Plan 当成认证方式；
- 把 Kimi OAuth 与 Kimi API Key 拆成两个互不相关的 Provider；
- 让最终用户输入 OAuth `client_id`；
- 用一个固定 Base URL 表达同一厂商的不同区域、协议和套餐；
- 把“打开控制台复制 API Key”标成“浏览器登录”。

## 2. 核心原则

1. **Provider 是厂商/服务主体**：如 Kimi、百炼、OpenAI。
2. **Offering 是产品与计费套餐**：如按量、Coding Plan、Token Plan、官方订阅。
3. **Auth Mode 是取得调用凭据的方式**：OAuth、Device Code、API Key、Local。
4. **Protocol 是网关调用语义**：Responses、Chat Completions、Anthropic Messages。
5. **Endpoint 是 Offering、区域和 Protocol 的解析结果**，不是 Provider 的单一固有属性。
6. Token Plan/Coding Plan 与 Auth Mode 正交：不同厂商的同名套餐可以采用不同认证方式。
7. OAuth 客户端身份是应用集成配置：`client_id`、authorization/token/device endpoint、scope 由受信 preset 或 Xpod 发布配置提供，最终用户不可输入。
8. API Key 辅助流程必须叫“API Key”，可以提供“打开控制台”按钮，但不能叫 OAuth 或浏览器登录。

## 3. 领域模型

### 3.1 Provider Descriptor

Provider 描述稳定的厂商身份和可用产品：

```ts
interface ProviderDescriptor {
  id: string
  displayName: string
  icon?: string
  offerings: OfferingDescriptor[]
  source: 'builtin' | 'signedCatalog' | 'custom'
}
```

Provider 不直接持有用户凭据，也不直接决定唯一认证方式。

### 3.2 Offering Descriptor

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

同一个 Provider 可以有多个 Offering，同一个 Offering 也可以允许多种认证方式。

### 3.3 Auth Option

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
```

`integrationRef` 引用 Xpod 受信 OAuth 集成配置。OAuth 密钥或不可公开信息不进入公共 Provider catalog，也不进入用户表单。

### 3.4 OAuth Integration

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

- Public client 优先使用 Authorization Code + PKCE 或 Device Code。
- 如厂商要求 confidential client，`client_secret` 只存在于受控服务端配置，不写入 Pod、不下发浏览器。
- 用户界面只显示“使用 Kimi 账号登录”等产品动作。
- Xpod 未获得合法 OAuth client 时，该 Auth Option 标为不可用；不得借用官方 CLI 的 client id。

### 3.5 Endpoint Descriptor

```ts
interface EndpointDescriptor {
  id: string
  region?: string
  protocol: 'responses' | 'chatCompletions' | 'anthropicMessages'
  baseUrl: string
  modelsUrl?: string
  allowedCredentialKinds: Array<'oauthToken' | 'apiKey' | 'none'>
}
```

Endpoint 必须属于具体 Offering，并校验凭据类型。例如百炼按量、Coding Plan、Token Plan 的 Key 与 Base URL 不可混用。

### 3.6 Connection

Connection 是用户实际创建的实例：

```ts
interface Connection {
  id: string
  providerId: string
  offeringId: string
  authOptionId: string
  endpointId: string
  accountLabel?: string
  credentialRef: string
  status: 'connecting' | 'connected' | 'expired' | 'invalid' | 'disconnected'
}
```

同一 Provider/Offering 可创建多个 Connection，从而支持多账号、多 Key 和轮换策略。

## 4. 首期映射

| Provider | Offering | Auth Option | 说明 |
| --- | --- | --- | --- |
| Kimi | 官方订阅 | OAuth | Xpod 内置合法客户端身份；用户不输入 client id |
| Kimi | API 平台按量 | API Key | 打开 Moonshot 控制台仅是辅助动作 |
| 百炼 | 按量 | API Key | 通用百炼 Key 与对应区域 Endpoint |
| 百炼 | Coding Plan | 专属 API Key | 与按量 Key、Base URL 隔离 |
| 百炼 | Token Plan 个人版 | `sk-sp-*` 专属 API Key | 与 Coding Plan、按量 Endpoint 隔离 |
| 百炼 | Token Plan 团队版 | `sk-sp-*` 专属 API Key | 席位/成员产生 Key，不等于 OAuth |
| 其他厂商 Token Plan | OAuth 或 API Key | 由各自 Offering descriptor 声明 | 不根据 `tokenPlan` 名称推断认证方式 |

如果后续百炼提供面向第三方应用的 OAuth 调用授权，应在同一 Offering 下增加新的 Auth Option，不替换现有 API Key 方式。

## 5. 认证生命周期

### 5.1 API Key

1. 用户选择 Provider 与 Offering。
2. UI 展示正确的 Key 类型、前缀提示、控制台入口和 Endpoint。
3. 用户粘贴 Key；Xpod 不从浏览器 Cookie 或网页内容抓取凭据。
4. 服务端校验 Key/Endpoint 组合，再执行模型发现和最小推理测试。
5. 成功后写入用户 Pod 的 Credential 与 Connection；失败不写活动 Connection。

### 5.2 Authorization Code + PKCE

1. 客户端向 Xpod 请求创建一次性 login attempt。
2. Xpod 生成 state、PKCE verifier/challenge，并返回 authorization URL。
3. 用户在系统浏览器登录厂商。
4. 回调只携带 code/state；Xpod 校验 attempt 后交换 token。
5. Access/refresh token 写入用户 Pod 的 Credential，Connection 标为 connected。
6. refresh 失败或授权撤销后标为 expired/invalid，不伪装成 connected。

### 5.3 Device Code

1. Xpod 使用内置 integration 发起 device authorization。
2. UI 显示 verification URL 与 user code，可一键打开浏览器。
3. Xpod 轮询 token endpoint，处理 pending、slow_down、expired、denied。
4. 成功后保存凭据；用户从不接触 client id。

### 5.4 Logout / Disconnect

- `logout`：如厂商支持 revocation，撤销远端 token；否则明确显示只删除本地授权。
- `disconnect`：删除或停用 Pod Connection/Credential，不删除 Provider/Offering descriptor。
- 多 Connection 场景只影响被选中的连接。

## 6. Product API

管理面建议提供：

```text
GET    /api/ai/providers
GET    /api/ai/providers/:provider/offerings
POST   /api/ai/connections
GET    /api/ai/connections
PATCH  /api/ai/connections/:id
DELETE /api/ai/connections/:id
POST   /api/ai/connections/:id/auth/begin
POST   /api/ai/connections/:id/auth/poll
GET    /api/ai/oauth/callback/:integration
POST   /api/ai/connections/:id/test
```

现有按 Provider 单例的 Connect 路由需要迁移到 Connection ID 语义。迁移期可以保留兼容入口，但新 UI 不再依赖 Provider 单例状态。

## 7. UI 语义

- 一级列表显示 Connection，而不是固定 Provider 清单；未创建的 Provider 进入“添加”目录。
- 添加流程顺序：Provider → Offering → 登录方式 → Endpoint/区域 → 授权 → 验证。
- OAuth 按钮写“使用 Kimi 账号登录”；API Key 写“配置 API Key”。
- “打开控制台”是 API Key 表单的辅助链接，不改变 Auth Mode。
- 状态至少区分：未配置、连接中、已连接、已过期、凭据无效、服务异常。
- 一个 Provider 的多个 Connection 可并列显示，并允许选择默认、禁用或删除。

## 8. 安全与数据边界

- Provider/Offering catalog 可公开；Credential 永远不进入 catalog 或管理列表响应。
- OAuth state、PKCE verifier、device code 是短期 attempt 数据，过期即销毁。
- `client_secret` 不得进入浏览器、桌面渲染进程或用户 Pod。
- API Key/OAuth Token 第一阶段仍依赖 Pod ACL 与最小权限；应用层加密另立设计，不在本设计内草率引入。
- 自定义 Provider 默认禁止任意内网 Endpoint；需复用统一 SSRF、redirect 和 DNS rebinding 防护。
- 不复用厂商官方 CLI/桌面应用的 OAuth client id，不抓取 Cookie。

## 9. 错误处理

- `auth_not_available`：Xpod 没有该 OAuth 集成，不要求用户补 client id。
- `credential_endpoint_mismatch`：Key/Token 与 Offering Endpoint 不匹配。
- `authorization_expired`：attempt 或 refresh token 失效。
- `authorization_denied`：用户或厂商拒绝授权。
- `connection_test_failed`：认证成功但模型/推理验证失败。
- `quota_unknown`：厂商无可靠额度接口；不得显示为 0。

所有错误对用户提供可执行动作，对日志保留 provider/offering/connection correlation id，但不得记录凭据。

## 10. 测试与验收

### Descriptor

- 同一 Provider 可声明多个 Offering；
- 同一 Offering 可同时声明 OAuth 与 API Key；
- Token Plan 不自动推断 Auth Mode；
- Key prefix、Endpoint、Protocol 组合校验。

### OAuth

- PKCE/state 成功、篡改、重复回调、过期；
- Device Code pending/slow_down/denied/expired/success；
- refresh、revocation、logout；
- API 响应、日志和 Pod 非凭据资源不泄漏 client secret/token。

### 产品验收

- Kimi OAuth 全程不出现 client id 输入框；
- Kimi API Key 与 Kimi OAuth 可同时创建为两个 Connection；
- 百炼按量、Coding Plan、Token Plan 的 Key/Endpoint 不可误配；
- OAuth 与 API Key 的按钮、文案和状态明确不同；
- 每个 Connection 都通过真实模型发现和最小推理检查后才标记已连接。

## 11. 非目标

- 不在本阶段实现所有厂商 OAuth；
- 不把 Token Plan 统一改成 OAuth；
- 不允许最终用户自带 OAuth client id/client secret；
- 不在本设计中解决应用层凭据加密；
- 不重做整个 Xpod/LinX Layout。
