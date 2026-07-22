# Pod AI Gateway 设计

## 目标

Xpod 提供一个由用户 WebID 隔离、以用户 Pod 为凭证事实源的 AI 协议网关。用户通过 LinX 管理上游 Provider 和编码客户端，Codex、Claude Code、Pi、CodeBuddy 通过同一个 `xpod` 客户端配置访问当前登录身份对应的 Gateway。

第一期交付必须支持：

- Local Xpod 与 Cloud Xpod 使用同一套 Gateway 核心；当前登录 WebID 决定使用哪一个部署，不同时配置两者。
- OpenAI/Codex、Anthropic/Claude、Kimi、阿里云百炼均支持浏览器 Connect 和手工 API Key。
- DeepSeek 支持 API Key；官方未提供第三方 OAuth/Device Code 时不得通过 Cookie 抓取伪造 Connect。
- `POST /v1/responses`、`POST /v1/messages`、`POST /v1/chat/completions`、`GET /v1/models`。
- SSE、工具调用、reasoning、图片输入、usage、Responses 状态、compaction、取消和标准错误映射。
- LinX 为 Codex、Claude Code、Pi、CodeBuddy 提供事务式一键配置和恢复。
- 展示 Provider 官方接口实际提供的余额或额度窗口；不支持查询时明确显示 `unsupported`。
- 最终使用真实 Codex 通过 Xpod 完成流式回答和工具调用。

音频、视频、实时语音和图片生成不属于第一期。

## 产品与部署边界

Xpod 是无界面的 Gateway 后端；LinX 是 Provider、Credential、模型、额度和客户端配置的管理界面。第一期不抽取独立微应用，也不新增第二个用户可见的 Xpod 桌面应用。

Local 与 Cloud 是两个独立安全域，WebID、Pod、Gateway Key 和密钥包装设施均不通用。LinX 只管理当前登录身份：登录 Local WebID 时配置 Local Gateway，登录 Cloud WebID 时配置 Cloud Gateway。编码客户端只存在一个稳定的 `xpod` Provider；切换 LinX 身份时事务式替换其 endpoint、Gateway Key 和模型配置。

AI Gateway 位于 Xpod API Server，不进入 CSS/Solid 协议处理链。

```text
控制面
LinX -> Solid OIDC/本地可信会话 -> Gateway Management API -> 当前 WebID Pod

数据面
Codex/Claude Code/Pi/CodeBuddy -> Gateway API Key -> Protocol Frontend
  -> Model Router -> Provider Adapter -> 上游模型
```

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

使用 drizzle-solid 从当前 WebID Pod 读取 Credential 密文，通过 Local Keychain 或 Cloud KMS 解开数据密钥。不得将 Provider 明文密钥传给 LinX 或编码客户端。

### `ClientConfigAdapter`

运行在 LinX 本地能力层，为四种编码客户端实现检测、检查、变更计划、应用、验证和恢复。它只处理 Xpod Gateway Key，不处理 Provider Credential。

## Pod 数据模型

共享持久语义归 `@undefineds.co/models` 所有。Xpod 必须复用现有 Model Provider/Credential 资源；缺失的 schema、ID helper 和 repository helper 先在 models 中实现并发布，不在 Xpod 复制 RDF 语义。

### Model Provider

记录 Provider 类型、区域或允许覆盖的 base URL、默认模型、可用模型和到 Credential 的 URI 关系。

### Provider Credential

记录到 Model Provider 的 URI 关系、认证模式、密文、wrapped data key、算法、key version、脱敏账号标识、scope、过期时间、健康状态及 `metadata.protocols.<provider>` 扩展。

### Gateway Access Key

记录 owner WebID、不可猜测的 key ID、secret hash、部署域、scope、创建/过期/最近使用/撤销时间。明文只在创建时返回一次。

### Quota Snapshot

记录到 Provider Credential 的 URI 关系、观测时间、过期时间、余额、多个额度窗口和 Provider 专属元数据。它是可携带的短期快照，不是假定实时的永久事实。

OAuth state、PKCE verifier、SSE 连接、请求执行状态、会话亲和缓存和高频健康缓存不进入 Pod。

## 凭证加密

每条 Provider Credential 生成独立 DEK。DEK 加密序列化后的 secret payload；Local 使用系统 Keychain 主密钥包装 DEK，Cloud 使用 KMS。Pod 保存 ciphertext、wrapped DEK、算法和 key version。

Token 刷新采用带版本的条件更新，避免并发刷新覆盖新 Token。主密钥轮换通过重新包装 DEK 完成，无需重新加密全部 payload。解密明文只在上游请求或刷新期间短暂存在内存。

Provider Credential 的密文在 Pod；实例主密钥不在 Pod。Gateway Key 的 secret 不可逆哈希后存 Pod。服务端可保存最小的非敏感 key ID 到 WebID 路由索引，但 Pod 记录是授权、撤销和 scope 的最终事实源。

## 身份认证和 Connect

Cloud LinX 使用 Solid OIDC access token/DPoP；Local LinX 使用绑定 Local WebID 的本地可信管理会话。所有管理写操作校验当前 WebID 与目标 Pod 一致。

统一 Connect 流程：

1. LinX 对当前 Provider 调用 connect 管理 API。
2. Xpod 创建五分钟有效、只能消费一次的 ConnectAttempt。
3. LinX 打开系统浏览器。
4. Provider 完成 OAuth、Device Code 或 Console Login。
5. callback 校验 state、PKCE、WebID、Provider 和部署实例。
6. Xpod 交换 Token、确认账号身份、加密并写入当前 Pod。
7. LinX 轮询状态或接收本地 deep link 通知。

Local 使用 public client + PKCE/device flow，不把 confidential client secret打进安装包。Cloud 所需 OAuth client secret 放 KMS。失败日志不包含 code、Token、Cookie 或 Provider 错误正文中的秘密。

第一期 Provider 认证矩阵：

| Provider | 浏览器 Connect | API Key | 首选协议 |
| --- | --- | --- | --- |
| OpenAI/Codex | 必须 | 必须 | Responses |
| Anthropic/Claude | 必须 | 必须 | Messages |
| Kimi | 必须 | 必须 | OpenAI-compatible |
| 阿里云百炼 | 必须 | 必须 | Messages 或 Chat Completions |
| DeepSeek | 官方暂不支持 | 必须 | Messages 或 Chat Completions |

Connect Credential 与 API Key Credential 不得静默互相回退，避免改变账号或计费来源。

## Gateway API Key

用户在 LinX 当前身份下创建具名 Gateway Key。默认 scope 为 `models:read` 和 `inference:write`。创建响应只显示一次明文，LinX立即写入客户端原生认证存储、环境变量安全设施或系统 Keychain。客户端只能使用 Gateway Key，不能读取 Provider Credential。

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
- Pod、KMS或Keychain不可用时fail closed，不使用服务器共享凭证兜底。

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
