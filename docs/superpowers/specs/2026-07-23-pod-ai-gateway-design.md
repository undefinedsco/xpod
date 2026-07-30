# Pod AI Gateway 设计

## 目标

Xpod 提供一个由用户 WebID 隔离、以用户 Pod 为凭证事实源的 AI 协议网关。用户通过 LinX 管理上游 Provider 和编码客户端，Codex、Claude Code、Pi、CodeBuddy 通过同一个 `xpod` 客户端配置访问当前登录身份对应的 Gateway。

第一期交付必须支持：

- Local Xpod 与 Cloud Xpod 使用同一套 Gateway 核心；当前登录 WebID 决定使用哪一个部署，不同时配置两者。
- OpenAI/Codex、Anthropic/Claude、阿里云百炼支持 browser-assisted API Key Connect：打开官方控制台，由已登录的当前 WebID 通过 Xpod 管理 API 提交 API Key；不得把这种模式称为 OAuth。
- Kimi 支持官方 Kimi Code device-code OAuth 和手工 API Key。
- DeepSeek 支持 API Key；官方未提供第三方 OAuth/Device Code 时不得通过 Cookie 抓取伪造 Connect。
- `POST /v1/responses`、`POST /v1/messages`、`POST /v1/chat/completions`、`GET /v1/models`。
- SSE、工具调用、reasoning、图片输入、usage、Responses 状态、compaction、取消和标准错误映射。
- LinX 为 Codex、Claude Code、Pi、CodeBuddy 提供事务式一键配置和恢复。
- 展示 Provider 官方接口实际提供的余额或额度窗口；不支持查询时明确显示 `unsupported`。
- 最终使用真实 Codex 通过 Xpod 完成流式回答和工具调用。

音频、视频、实时语音和图片生成不属于第一期。

## 产品与部署边界

Xpod 是无界面的 Gateway 后端；LinX 是 Provider、Credential、模型、额度和客户端配置的管理界面。AI Connection 是 LinX 内的管理 applet，不作为独立部署单元，也不感知 Xpod 的运维 deployment。

Xpod 保留 `local` / `cloud` deployment 作为后端运维、安全域、路由和审计概念；Local 与 Cloud 的 WebID、Pod 和 Gateway Key 均不通用。LinX 只管理当前登录身份：登录 Local WebID 时配置 Local Gateway，登录 Cloud WebID 时配置 Cloud Gateway。编码客户端只存在一个稳定的 `xpod` Provider；切换 LinX 身份时事务式替换其 endpoint、Gateway Key 和模型配置。

AI Gateway 位于 Xpod API Server，不进入 CSS/Solid 协议处理链。

```text
控制面
LinX -> Solid OIDC/本地可信会话 -> Gateway Management API -> 当前 WebID Pod

数据面
Codex/Claude Code/Pi/CodeBuddy -> Gateway API Key -> Protocol Frontend
  -> Model Router -> Provider Adapter -> 上游模型
```

## Applet SDK 与 Solid 登录边界

Solid OIDC 的协议与安全实现直接使用 `@inrupt/solid-client-authn-browser`。LinX、独立
Applet Host 和 AI Connection 不自行实现 OIDC、DPoP、token 刷新或 callback 解析。
Inrupt `Session` 是浏览器登录状态的事实源，负责 `login()`、`logout()`、
`handleIncomingRedirect()`、`restorePreviousSession` 和 authenticated fetch。

Undefineds SDK 在 Inrupt 之上提供产品与运行时能力：

- Applet Host 在一个窗口内持有唯一共享 Session。嵌入 LinX 的 applet 复用 LinX
  Session，不显示第二个登录框；独立运行且没有 Session 时才显示统一登录界面。
- 统一登录组件负责 Issuer 选择、OIDC 跳转状态、失败提示、过期重登和返回原页面。
  组件允许使用宿主主题令牌，但认证流程与安全行为不可由 applet 改写。
- Host 只向 applet 暴露 WebID、Pod 描述和受控的 authenticated fetch，不暴露、
  复制或持久化 token。Applet 通过能力声明请求登录和 Pod 访问。
- Solid 运行时负责从 WebID Profile 发现 Pod、初始化 drizzle-solid、注册
  `@undefineds.co/models` schema，以及 collections 的发现、创建、水化、订阅、
  缓存和统一错误处理。
- SDK 提供 mock Session、authenticated fetch adapter、OIDC callback harness 和
  Pod/collections 测试夹具，使 applet 可以脱离 LinX 做集成测试。

包职责保持分离：

- `@undefineds.co/applet-sdk`：生命周期、Manifest、能力声明、Host bridge 和 Session
  消费接口。
- `@undefineds.co/solid-sdk`：Inrupt Session 编排、Pod bootstrap、drizzle-solid 和
  collections 水化。
- 领域包（例如 AI Connection）：领域类型、交互和 Xpod 标准 API client，不拥有
  Session，不复制共享 schema，也不自行定位或初始化 Pod ORM。

AI Connection 页面只声明“需要登录”和所需 Pod 能力。登录、Session 恢复、
Pod 定位、ORM 初始化及 collections 水化不得散落在其组件或领域客户端中。

## 组件

### `AiGatewayHttpHandler`

注册四类公开兼容接口，负责 HTTP、SSE、取消、请求上限和协议错误响应。管理 API 与推理 API 使用独立路由和授权 scope。

### `GatewayAuthenticator`

将 Solid OIDC 登录会话、本地可信管理会话或 Gateway API Key 统一解析为 `GatewayPrincipal`。Principal 至少包含 WebID、部署实例和 scope。调用方不能直接指定任意 Pod URL。

### `ProtocolFrontend`

分别解析 Responses、Anthropic Messages 和 Chat Completions，映射为不丢失供应商扩展信息的内部请求；输出事件再映射回调用方协议。

### `ModelRouter`

解析模型别名、`provider/model`、默认 Provider、默认模型和 Credential 选择；维护会话 Credential 亲和与冷却状态。

### Provider 边界

Provider 拆为三个职责：

- `ProviderRuntimeAdapter`：模型发现、推理、流式事件、usage 和错误分类。
- `ProviderConnectAdapter`：开始 Connect、完成 callback/device/console flow、刷新、撤销和账号身份检查。
- `ProviderQuotaAdapter`：查询官方提供的余额和额度窗口。

### `CredentialVault`

使用 drizzle-solid 从当前 WebID Pod 读取统一 Pod 数据格 SecretCell，并在服务端短暂解开 Provider Credential。Xpod 不为 Local/Cloud 分叉凭证解密路线；不得将 Provider 明文密钥传给 LinX 或编码客户端。

### `ClientConfigAdapter`

运行在 LinX 本地能力层，为四种编码客户端实现检测、检查、变更计划、应用、验证和恢复。它只处理 Xpod Gateway Key，不处理 Provider Credential。

## Pod 数据模型

共享持久语义归 `@undefineds.co/models` 所有。Xpod 必须复用现有 Model Provider/Credential 资源；缺失的 schema、ID helper 和 repository helper 先在 models 中实现并发布，不在 Xpod 复制 RDF 语义。

### Model Provider

记录 Provider 类型、区域或允许覆盖的 base URL、默认模型、可用模型和到 Credential 的 URI 关系。

### Provider Credential

记录到 Model Provider 的 URI 关系、认证模式、SecretCell 引用或密文元数据、脱敏账号标识、scope、过期时间、健康状态及 `metadata.protocols.<provider>` 扩展。

### Gateway Access Key

记录 owner WebID、不可猜测的 key ID、secret hash、部署域、scope、创建/过期/最近使用/撤销时间。明文只在创建时返回一次。

### Quota Snapshot

记录到 Provider Credential 的 URI 关系、观测时间、过期时间、余额、多个额度窗口和 Provider 专属元数据。它是可携带的短期快照，不是假定实时的永久事实。

Connect state、PKCE verifier、SSE 连接、请求执行状态、会话亲和缓存和高频健康缓存不进入 Pod。

## 凭证加密

每条 Provider Credential 使用统一 Pod 数据格 SecretCell 保存序列化后的 secret payload。SecretCell 记录解密所需的非明文元数据、key ID、算法版本和轮换状态；Local 与 Cloud 使用同一数据模型，不引入按部署分叉的密钥设施。

Token 刷新采用带版本的条件更新，避免并发刷新覆盖新 Token。密钥轮换通过 SecretCell 的 key ID 与 previous key 窗口完成，旧 cell 被读取后按需迁移到 active key。解密明文只在上游请求或刷新期间短暂存在内存。

Provider Credential 的 SecretCell 在 Pod；SecretCell active/previous key 只作为部署运行时配置存在，不写入用户 Pod。Gateway Key 的 secret 不可逆哈希后存 Pod。服务端可保存最小的非敏感 key ID 到 WebID 路由索引，但 Pod 记录是授权、撤销和 scope 的最终事实源。

生产 bootstrap 使用 `XPOD_SECRET_CELL_KEY_ID`、严格 base64 的 32 字节
`XPOD_SECRET_CELL_KEY`，以及可选的
`XPOD_SECRET_CELL_PREVIOUS_KEYS`（key ID 到 32 字节 base64 的 JSON 对象）。
这些是 Xpod 运维密钥，不是用户 AI 参数，也不得与 Gateway locator secret
复用。配置缺失、格式错误或 key ring 不含目标 key ID 时 fail closed。

## 身份认证和 Connect

Cloud LinX 使用 Solid OIDC access token/DPoP；Local LinX 使用绑定 Local WebID 的本地可信管理会话。所有管理写操作校验当前 WebID 与目标 Pod 一致。

统一 Connect 流程：

1. LinX 对当前 Provider 调用 connect 管理 API。
2. Xpod 创建五分钟有效、只能消费一次的 ConnectAttempt。
3. LinX 打开系统浏览器。
4. Provider 完成官方 device-code OAuth，或用户在官方 Console 创建 API Key 后回到 LinX。
5. OAuth callback/poll 校验 state、PKCE、WebID、Provider 和部署实例；browser-assisted API Key 只允许走已认证管理 API，不走 public callback。
6. Xpod 交换 Token 或接收 API Key、确认账号身份（官方响应提供时）、加密并写入当前 Pod。
7. LinX 轮询状态或接收本地 deep link 通知。

Local 的 OAuth 仅用于官方支持的 public client + PKCE/device flow，不把 confidential client secret 打进安装包。需要持久化的 OAuth client secret 走同一 SecretCell 机制，不引入 Cloud 专属分支。OpenAI Codex/Claude Code 官方 client id 不复用，Cookie 不抓取。失败日志不包含 code、Token、Cookie、API Key 或 Provider 错误正文中的秘密。

第一期 Provider 认证矩阵：

| Provider | Connect 模式 | API Key | 首选协议 |
| --- | --- | --- | --- |
| OpenAI/Codex | `browserAssistedApiKey`，打开官方 API key 页面后通过认证管理 API 提交 | 必须 | Responses |
| Anthropic/Claude | `browserAssistedApiKey`，打开官方 Console key 页面后通过认证管理 API 提交 | 必须 | Messages |
| Kimi | `deviceCodeOAuth`（官方 Kimi Code device-code） | 必须 | OpenAI-compatible |
| 阿里云百炼 | `browserAssistedApiKey`，打开官方百炼控制台后通过认证管理 API 提交 | 必须 | Messages 或 Chat Completions |
| DeepSeek | `connectUnsupported` | 必须 | Messages 或 Chat Completions |

Connect Credential 与 API Key Credential 不得静默互相回退，避免改变账号或计费来源。

Kimi device-code Connect 只允许使用 Xpod/Moonshot 签发给本产品的 client id，并访问 `https://auth.kimi.com/api/oauth/device_authorization` 与 `https://auth.kimi.com/api/oauth/token`。未配置该 client id 时，capability 必须显示 `configured=false` 和 experimental/disabled 说明，不得复用官方 CLI client id 或伪装为可用。

## Gateway API Key

用户在 LinX 当前身份下创建具名 Gateway Key。默认 scope 为 `models:read` 和 `inference:write`。创建响应只显示一次明文，LinX 立即写入客户端原生认证存储、环境变量安全设施或经用户确认的仅当前用户可读配置。客户端只能使用 Gateway Key，不能读取 Provider Credential。

数据面请求使用 `Authorization: Bearer xpod_...`。Gateway解析部署域与 key ID，定位 WebID，然后读取 Pod 记录并校验 secret hash、scope、过期和撤销状态。Local Key不能用于Cloud，反之亦然。

## 协议内核

内部 `GatewayRequest` 表达 messages、instructions、tools、图片、reasoning policy、cache hints、previous response、conversation identity、stream options 和带命名空间的扩展。

内部 `GatewayEvent` 表达 response started、text/reasoning delta、tool call生命周期、usage、completed 和标准错误。

原则：

- 上游原生支持调用方协议时优先 passthrough，但仍执行鉴权、模型重写和安全 header 过滤。
- 协议不一致时通过统一事件流转换，不以最低公共子集丢字段。
- SSE逐事件转发，不缓冲完整响应。
- 工具参数允许分片，结束时校验完整性。
- reasoning 正文只在调用方协议允许时返回。
- Responses 状态、`previous_response_id` 和 compaction 按 WebID 隔离。
- 客户端取消立即中止上游请求。

## 模型与 Credential 路由

模型路由顺序为用户别名、显式 `provider/model`、已连接 Provider 的精确模型 ID、默认 Provider、默认模型。`GET /v1/models` 只返回当前 WebID 可调用模型，并附带上下文窗口、输入模态、工具调用、reasoning effort 和支持协议等能力。

模型目录动态发现优先，Provider Registry 种子兜底。模型 ID 不应因供应商快速变动而硬编码进业务逻辑。

同一 Provider 可存在多个 Credential。用户可指定优先级和默认项；新会话选择健康且有额度的 Credential，已有会话保持亲和。401/403 标记重新授权，429进入冷却。只有在尚未向客户端输出任何事件时才允许自动故障转移；明确指定 Credential 时不自动切换。

## 额度

额度查询只使用供应商正式提供且当前 Credential 有权调用的接口。支持多个限制窗口、余额、重置时间、观测时间和过期时间。无正式查询能力时返回 `unsupported`；429 cooldown 不得伪装成精确剩余额度。

额度查询失败不影响推理。LinX 显示数据来源、最后刷新时间和 stale 状态。

## LinX 与客户端配置

LinX 只展示当前登录 WebID、对应 Gateway、Pod Providers、Credential、模型、额度和编码客户端配置。切换身份时：

1. 检查现有 `xpod` 客户端配置属于旧 WebID。
2. 移除旧 Gateway Key 的本机引用。
3. 为新 WebID 创建或选择 Key。
4. 事务式替换 `xpod` endpoint、Key 和模型目录。
5. 保留所有非 Xpod 配置。
6. 验证新 Gateway；失败则回滚。

每个 ClientConfigAdapter 在变更前生成摘要和带时间戳备份。默认合并；客户端只能有单 Provider 时，必须明确提示替换。恢复只撤销 Xpod 管理字段。

秘密存储顺序：客户端原生认证存储、环境变量引用/系统安全设施、最后才是在明确提示后写入权限为仅当前用户可读的配置文件。任何情况下都不写 Provider Credential。

## 错误与安全

统一 `GatewayError` 分类包括 authentication、authorization、credential expired、quota exhausted、rate limited、unsupported capability、invalid request、upstream unavailable 和 internal。首事件前失败可返回 HTTP错误并按策略切换 Credential；SSE开始后通过协议终止错误结束，不重放请求。

必须实施：

- 每请求校验 WebID、Pod、scope和部署域。
- Provider endpoint允许列表及SSRF防护。
- 过滤Authorization、Host、Cookie及内部header。
- 请求体、图片、工具schema、SSE事件和执行时间上限。
- 日志统一脱敏，不记录prompt/response正文和任何秘密。
- Gateway Key恒定时间比较和失败限速。
- callback重新确认当前身份，不只相信query参数。
- LinX写配置前拒绝不安全符号链接目标。
- Pod 或 SecretCell 不可用时 fail closed，不使用服务器共享凭证兜底。

## 测试与验收

### 单元和契约

覆盖三类协议、五家Runtime Adapter、四家Connect Adapter、DeepSeek API Key、Token刷新、额度、错误、模型路由、Credential亲和和Pod ID/URI语义。

### Pod集成

验证 drizzle-solid CRUD、WebID隔离、Pod无明文、Local/Cloud密钥包装、条件刷新和key撤销。

### 协议兼容

使用真实客户端请求夹具覆盖流式/非流式、工具调用、reasoning、图片、usage、缓存、`previous_response_id`、compaction、取消、401和429。

### 客户端

四个客户端分别验证安装检测、备份合并、当前WebID替换、回滚、模型列表、最小推理、流式工具调用和恢复。

### 完成门槛

- 五家Provider满足认证矩阵。
- 四类公开接口和四种客户端可用。
- Provider密文仅在对应Pod，日志、客户端配置和测试产物无上游明文。
- 额度按官方能力正确显示或明确unsupported。
- `bun run build:ts`、相关单元测试和`bun run test:integration`全部通过。
- 真实Codex连接Xpod，使用当前WebID Pod Credential完成一次流式回答和一次工具调用。

## 实施顺序

1. shared models 与凭证加密。
2. Gateway认证和管理API。
3. 协议内核和模型路由。
4. 五家Provider Runtime/Connect Adapter。
5. 额度查询。
6. LinX管理页面。
7. 四种客户端配置适配器。
8. 全量回归和真实Codex链路测试。
