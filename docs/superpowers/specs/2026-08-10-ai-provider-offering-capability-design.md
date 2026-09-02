# AI Provider Offering 与接口能力组合设计

> **文档状态：Internal runtime design。** Offering 和 capability 用于内部路由、
> 发现与适配，不直接定义 C 端列表或文案。产品界面与用户流程以
> [`docs/ai-connections-product-spec.md`](../../ai-connections-product-spec.md)
> 为准。

## 目标

AI Gateway 不以供应商为单位实现整套 Connect、模型发现、推理和额度逻辑。系统维护少量稳定的 Offering 类型与接口能力协议，供应商通过元数据组合这些能力；只有上游协议真实不兼容时才增加可复用的协议实现或窄范围 override。

## 两个正交维度

### Offering 类型

Offering 表达用户购买和持有凭证的方式，以及对应的额度语义。第一版固定三类：

| Offering kind | 产品含义 | 常见认证 | 额度语义 |
| --- | --- | --- | --- |
| `oauth-subscription` | 官方账号订阅 | OAuth / Device Code OAuth | 滚动窗口、周限制、重置时间 |
| `api-platform` | 按量计费 API 平台 | API Key | 余额、账单或官方不支持查询 |
| `token-plan` | 使用 Key 交付的订阅套餐 | Subscription Key / API Key | 套餐额度、周期窗口、重置时间 |

`apiKey` 只是认证方式，不能作为 Offering 类型。`api-platform` 和 `token-plan` 都可能录入 Key，但它们的模型入口、额度接口、控制台和计费语义不同。

### 上游接口能力

上游接口能力表达 Xpod 内部如何连接该 Offering。能力独立于 Provider 和 Offering 类型，可被任意供应商 Offering 复用，但不是用户需要选择或配置的产品概念。

第一版能力族：

- `auth`：API Key、OAuth Device Code、OAuth Authorization Code 等连接流程。
- `models`：OpenAI Models 或其他模型目录协议。
- `inference`：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
- `quota`：滚动额度窗口、套餐额度。
- `balance`：API 平台余额。

一个 Offering 可以声明多个上游推理能力。例如同一个 API 平台可同时原生提供 Chat Completions 与 Responses。Xpod 根据元数据选择直通或内部事件流转换；应用只看到用户已经选择进入 Pod、且经 Xpod 标准接口可调用的模型。

Xpod 对外稳定提供 `models`、`chat/completions`、`responses` 和 `messages` 等标准接口。配置端不要求用户选择这些协议，也不把供应商原生协议作为连接表单的一部分。模型详情可以展示工具调用、视觉、reasoning 等最终能力，但不以协议名称替代产品能力。

## 元数据模型

Provider 是品牌和产品分组，不承担运行逻辑。Provider 元数据包含一个或多个 Offering：

```ts
interface ProviderMetadata {
  id: string;
  label: string;
  offerings: ProviderOfferingMetadata[];
}

interface ProviderOfferingMetadata {
  id: string;
  kind: 'oauth-subscription' | 'api-platform' | 'token-plan';
  label: string;
  auth: AuthCapabilityRef[];
  upstream: UpstreamCapabilityRef[];
  endpoints?: Record<string, string>;
  consoleUrl?: string;
  subscriptionUrl?: string;
  usageUrl?: string;
}

interface CapabilityRef {
  protocol: string;
  options?: Record<string, unknown>;
}
```

`protocol` 引用代码中注册的一份可复用能力实现。`options` 只提供 base URL、path、允许的 header、字段位置等数据参数，不能嵌入任意代码或按 Provider 分支的业务逻辑。

Kimi 示例：

```ts
{
  id: 'kimi',
  offerings: [
    {
      id: 'official-subscription',
      kind: 'oauth-subscription',
      auth: [{ protocol: 'oauth-device-code' }],
      upstream: [
        { protocol: 'openai-chat-completions' },
        { protocol: 'openai-models' },
        { protocol: 'rolling-quota-windows', options: { profile: 'kimi-code' } }
      ]
    },
    {
      id: 'subscription-key',
      kind: 'token-plan',
      auth: [{ protocol: 'subscription-key' }],
      upstream: [
        { protocol: 'openai-chat-completions' },
        { protocol: 'openai-models' },
        { protocol: 'rolling-quota-windows', options: { profile: 'kimi-code' } }
      ]
    },
    {
      id: 'api-platform',
      kind: 'api-platform',
      auth: [{ protocol: 'api-key' }],
      upstream: [
        { protocol: 'openai-chat-completions' },
        { protocol: 'openai-models' },
        { protocol: 'api-balance', options: { profile: 'moonshot' } }
      ]
    }
  ]
}
```

## 运行时结构

运行时只按上游能力协议查找 Handler。配置端不参与 Handler 选择：

```text
Provider metadata
  -> Offering metadata
  -> Credential compatible with Offering auth capability
  -> Upstream capability reference
  -> Protocol handler registry
  -> normalized internal request/event/result
  -> Xpod public protocol projection
```

建议的核心边界：

```ts
interface CapabilityHandler<TInput, TOutput> {
  readonly protocol: string;
  execute(input: TInput, options: Record<string, unknown>): Promise<TOutput>;
}
```

实际实现按能力族使用有类型的接口，不能让所有输入输出退化成 `unknown`。例如模型发现统一返回 `DiscoveredProviderModel[]`，额度统一返回 `NormalizedQuotaSnapshot`，推理统一经过内部事件流。

现有 `ProviderRuntimeAdapter`、`ProviderConnectAdapter` 和 `ProviderQuotaAdapter` 逐步改为协议 Handler。业务服务不再维护 `provider -> adapter` 映射，而维护 `protocol -> handler` 注册表，并从 Offering 元数据选择协议。

## Provider 差异处理

差异处理顺序固定为：

1. 复用已有协议 Handler，仅由元数据提供 endpoint/path/header/字段位置。
2. 如果响应结构是同一协议的稳定 profile，给通用 Handler 增加具名 profile；profile 必须可被多个 Provider/Offering 引用。
3. 只有无法由已有协议表达时新增协议 Handler。
4. 禁止在通用业务服务和 UI 中增加 `if (provider === ...)`。

供应商品牌、Logo、控制台链接和产品说明属于展示元数据；OAuth client id 等部署配置由能力 Handler 的安全配置解析，不写入用户 Pod，也不伪装成供应商运行逻辑。

## Pod 持久化

Pod 中保存：

- Provider ID 与 Offering ID。
- Offering kind 的持久语义或可校验版本。
- Credential 的 auth protocol、SecretCell 引用、优先级、健康状态和过期信息。
- 用户选择进入 Pod 的模型及其来源 Offering。
- 标准化额度快照及产生它的 capability protocol/profile。

Provider 元数据负责发现和默认展示，但已保存数据必须自表达。元数据升级不能把一个已有 `api-platform` Credential 静默解释成 `token-plan`。

共享 RDF schema、ID helper 和 drizzle-solid repository helper 继续由 `@undefineds.co/models` 所有；Xpod 只实现运行时 adapter 和 API。

## UI 行为

AI Connections 仍以 Provider 分组，但 Provider 下按 Offering item 展示：

- 账号订阅
- API 平台
- Token 套餐

每个 item 的录入方式、官方链接、模型发现和额度显示由 Offering 元数据驱动。多个 Credential 属于同一个 Offering item，并在 item 内排序、启停和验证。配置端不展示或编辑上游接口协议；协议只用于 Xpod 内部执行和诊断。

额度 UI 根据 Offering kind 选择语义：

- `oauth-subscription`、`token-plan` 展示额度窗口与重置时间。
- `api-platform` 展示余额，或明确显示供应商不支持查询。
- 不根据 Provider 名称猜测额度类型。

编码客户端配置是 Xpod 的统一出口能力，不属于供应商 Offering。Codex、Claude Code、Pi、CodeBuddy 始终获得 Xpod endpoint、Xpod Gateway Key 和用户已选模型；它们不会获得上游协议配置或 Provider Credential。

## 错误与安全边界

- Metadata 引用未注册协议时启动校验失败，不能运行时静默回退。
- Credential auth protocol 必须与 Offering 声明兼容。
- Provider 响应解析失败返回标准化 capability 错误，不暴露响应正文或秘密。
- 浏览器 Solid Bearer/DPoP 不允许服务端重放；调用者拥有的 Pod 会话仍通过现有调用路径使用。
- 编码客户端永远只获得 Xpod 虚拟 Gateway Key，不获得上游 Credential。

## 迁移策略

1. 增加 Offering kind 与 capability metadata 的类型和启动校验。
2. 把现有 Provider 清单改为三类 Offering 和接口能力组合。
3. 先迁移 quota/balance，因为当前 Provider-specific adapter 最集中且已有回归夹具。
4. 再迁移 models、connect 和 inference。
5. 删除不再被引用的 Provider-specific adapter 和 UI Provider 分支。

迁移期间允许旧字段只读兼容，但新写入必须使用 Offering kind 与 capability reference。不得同时维护两套可写事实源。

## 验收标准

- 新增一个完全兼容已有协议的 Provider 只需增加元数据和元数据测试。
- 同一 Provider 可同时声明账号订阅、API 平台和 Token 套餐。
- 同一 Offering 可组合多个推理接口能力。
- API Platform Key 与 Token Plan Key 不会共享错误的额度语义或 endpoint。
- Provider、Offering、Credential、模型和额度记录都能追溯到明确的上游 capability protocol/profile。
- 通用服务和 UI 中不出现新增的 Provider 名称条件分支。
- 元数据完整性、协议注册、Credential 兼容性、模型发现、推理、额度与客户端投影均有契约测试。
- 配置端不要求用户选择上游协议；所有编码客户端只配置 Xpod 的标准接口。
