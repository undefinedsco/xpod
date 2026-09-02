# AI Connection 模型发现与 Pick 设计

> **文档状态：Internal supporting design。** 本文只保留模型发现、选择和失效
> 模型处理的内部设计。页面结构、用户术语、登录与验收顺序以
> [`docs/ai-connections-product-spec.md`](../../ai-connections-product-spec.md)
> 为准；冲突内容视为已被替代。

## 目标

AI Connection 在供应商连接成功后立即读取该供应商的模型目录，让用户把需要的模型 Pick 到自己的 Pod。Gateway 和编码客户端只暴露当前 WebID 已 Pick、凭证可用且模型仍有效的模型。供应商下架的已选模型仍保留在设置界面中，避免配置静默消失。

## 边界

- 凭证继续由 `credentialResource` 表达，只负责供应商鉴权和连接状态。
- 用户选择继续复用 `@undefineds.co/models` 的 `aiProviderResource` 与 `aiModelResource`，不在凭证中复制 `models` 元数据。
- 供应商完整模型目录是瞬时发现结果，不整表写入 Pod；只有 Pick 结果写入 Pod。
- Applet 不感知 Xpod 的 local/cloud 部署形态。所有读取和写入均以当前 Solid 会话的 WebID 与 Pod 为边界。
- 第一版不保存模型目录历史快照，也不自动替用户 Pick 新出现的模型。

## 状态语义

设置界面把模型分为四种状态：

| 状态 | 含义 | Pod 记录 | Gateway 可见 |
| --- | --- | --- | --- |
| `available` | 本次供应商目录存在，尚未 Pick | 无 | 否 |
| `selected` | 已 Pick，且本次供应商目录仍存在 | `aiModelResource.status = active` | 是 |
| `unavailable` | 曾 Pick，但供应商目录已明确不存在 | `aiModelResource.status = inactive` | 否 |
| `statusUnknown` | 本次目录拉取失败，无法确认有效性 | 保持上次持久化状态 | 保持上次有效状态，但设置界面显示无法确认 |

凭证处于 disconnected、reauthRequired、disabled 或 quota exhausted 时，已 Pick 模型仍保存在 Pod 并展示，但不通过 Gateway 投影给应用。

## 数据模型

Pick 使用共享 models schema：

- `aiProviderResource`：供应商配置和已选默认模型关系。
- `aiModelResource`：只保存用户 Pick 过的模型。
- `aiModelResource.isProvidedBy`：关联供应商。
- `aiModelResource.status`：`active` 表示目录中仍有效，`inactive` 表示已明确失效。
- `displayName`、`modelType`、`updatedAt`：保存最后一次成功发现时的可读元数据。

取消 Pick 会删除对应的 `aiModelResource`，而不是写入另一种“未选择”状态。这样 Pod 中存在的模型记录本身就表达用户选择，`inactive` 专门保留已选择但失效的模型。

共享 schema 与 CRUD 规则以 `@undefineds.co/models` 为权威。Xpod 只实现鉴权后的 Pod adapter；不维护 schema 副本，不用原生 SPARQL 绕过 drizzle-solid。

## 服务端组件

### ProviderModelDiscoveryService

职责是使用当前 WebID 的已连接凭证调用原供应商模型目录接口，并把供应商响应归一化为稳定结构：

```ts
type DiscoveredProviderModel = {
  id: string
  displayName?: string
  modelType: 'chat' | 'embedding' | 'image' | 'audio' | 'other'
}
```

每个供应商由独立 adapter 负责 URL、鉴权头和响应解析。adapter 复用 Gateway 已打开的 Pod 凭证，API 不接收也不返回供应商密钥。

### PodModelSelectionRepository

职责是通过 drizzle-solid：

- 读取某供应商已 Pick 的模型；
- 将用户提交的选择集按 exact id 做 upsert/delete；
- 在一次成功目录刷新后，把已 Pick 但目录缺失的模型标记为 `inactive`；
- 不在发现失败时改写任何模型状态。

### Gateway 投影

`AiGatewayService.listModels` 与 `ModelRouter` 读取 Pod 中的 active Pick 集，而不是把“连接了供应商”等同于“供应商所有模型均可见”。模型必须同时满足：

1. 当前 WebID 已 Pick；
2. `aiModelResource.status = active`；
3. 对应凭证 active 且不要求重新鉴权；
4. 配额未耗尽，且不在 cooldown。

`/v1/models` 是 Codex、Claude Code、Pi、CodeBuddy 以及其他兼容客户端的唯一模型投影来源。

## API

所有接口要求现有 Solid OIDC/DPoP 或该用户签发的 client credentials，授权主体必须能解析到同一 WebID。

### 发现并对账

`POST /api/ai/gateway/providers/:provider/models/discover`

返回：

```json
{
  "provider": "openai",
  "fetchedAt": "2026-08-05T00:00:00.000Z",
  "models": [
    { "id": "gpt-5", "displayName": "GPT-5", "selected": true, "availability": "available" }
  ]
}
```

成功响应会先用发现结果对已 Pick 模型做有效/失效对账。供应商请求失败返回可归因、已脱敏的错误，不修改 Pod。

### 保存 Pick

`PUT /api/ai/gateway/providers/:provider/models/selection`

请求只包含模型 ID 数组及可选默认模型：

```json
{ "modelIds": ["gpt-5", "gpt-4.1"], "defaultModel": "gpt-5" }
```

服务端只允许选择最近一次成功发现结果中的模型，防止任意字符串进入路由配置。保存后返回新的选择集和版本，用于处理并发覆盖。

### 读取设置态模型

`GET /api/ai/gateway/providers/:provider/models`

返回已 Pick 模型（包括 unavailable）以及可用的最近发现目录。该接口供 Settings/Applet 使用；`/v1/models` 继续只返回可用于推理的模型。

## 交互

连接成功后，供应商详情页立即进入模型发现状态：

1. 显示“正在读取供应商模型”；
2. 成功后在当前详情栏展开带搜索的多选列表；
3. 用户勾选模型并保存；
4. 保存成功后顶部连接状态保持不变，模型区域显示已选数量；
5. 已失效模型固定显示在已选区域，带“供应商已不可用”标记，可由用户移除；
6. 发现失败显示重试，不回滚已保存的连接或选择。

列表沿用统一的搜索区域和轻量操作按钮，不新增模态产品壳。键盘操作、loading、空状态和错误状态均由 applet 内部处理。

## 错误与安全

- 供应商 API Key、access token、refresh token 不出现在发现 API 响应、日志或浏览器状态中。
- 供应商 401/403 会把凭证标记为 reauthRequired；网络错误只影响本次发现。
- 供应商 429 保留选择状态，并返回可重试提示。
- 无法解析的单条模型记录被跳过；整个响应不可解析时本次发现失败。
- 不用服务器环境变量保存用户模型选择或用户供应商凭证。
- Alice 的发现缓存、选择与 Gateway 投影不得被 Bob 读取。

## 测试与验收

### 单元测试

- 五家供应商目录响应归一化与错误脱敏；
- Pick exact-id upsert/delete、默认模型约束和并发版本；
- 成功发现标记失效模型，失败发现不改变状态；
- Gateway 只投影 active Pick，凭证失效时不投影。

### 集成测试

- 使用真实 Solid OIDC/DPoP 会话把选择写入 Alice Pod；
- 页面重载后选择仍存在，Bob 无法看到；
- `/v1/models` 只返回 Alice 已 Pick 的 active 模型；
- 模型从供应商 fixture 消失后，Settings 仍展示为 unavailable，`/v1/models` 不再返回；
- OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 继续只能路由到已 Pick 模型。

### 浏览器验收

- 连接成功自动拉取模型；
- 搜索、勾选、保存、重载可用；
- 空目录、请求失败、失效模型均有明确状态；
- 不在 DOM、截图、控制台和网络响应中泄漏密钥。

### 客户端验收

Codex、Claude Code、Pi、CodeBuddy 的配置计划从 `/v1/models` 选择默认模型；不得配置未 Pick 或 unavailable 的模型。真实供应商凭证存在时再执行一次真实 Codex 推理；没有正式凭证时必须明确保留为外部验收项，不能以 fixture 冒充。

## 发布与兼容

- 已连接但尚无 Pick 记录的供应商在升级后不再向应用暴露全部模型；Settings 会提示用户完成选择。
- 旧的错误 edition 凭证 ID 继续由 Connections repository exact-id 兼容读取和更新。
- 本功能随 RC 服务发布验证，RC 不发布正式 npm 包；通过后再进入正式版本发布流程。
