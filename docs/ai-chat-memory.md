# AI 会话记忆

本文说明 Xpod 如何把 AI 兼容接口产生的对话保存为用户 Pod 中的持久化会话记忆，包括协议归一化、数据模型、写入流程、资源布局和扩展边界。

## 1. 定位与范围

当前能力属于**会话型记忆**：它保存 Thread、用户消息、助手消息和工具调用，使应用或 Agent 能继续一段对话、回看历史，并在不同 AI 协议之间复用同一会话。

它不等同于长期语义记忆。目前不会自动完成事实抽取、偏好归纳、摘要压缩、向量化、遗忘策略或跨 Thread 检索；这些能力应在会话记录之上由独立的记忆处理模块实现。

当前接入以下入口：

| 接口 | 兼容协议 | Thread 来源标记 | 当前响应形态 |
|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | `openai.chat.completions` | JSON 或流式 |
| `POST /v1/responses` | OpenAI Responses | `openai.responses` | JSON |
| `POST /v1/messages` | Anthropic Messages | `anthropic.messages` | JSON |

## 2. 整体流程

```mermaid
flowchart LR
  Client["App / Agent"] --> API["AI 兼容接口"]
  API --> Normalize["协议归一化"]
  Normalize --> Session["创建或加载 ChatKit Thread"]
  Session --> Input["先写入 user / tool 输入"]
  Input --> Provider["调用 AI Provider"]
  Provider --> Output["归一化 assistant / tool call 输出"]
  Output --> Store["PodChatKitStore"]
  Store --> Models["@undefineds.co/models"]
  Models --> Pod["用户 Pod RDF 资源"]
```

一次请求的执行顺序如下：

1. Xpod 根据认证上下文确定用户 Pod，不接受客户端指定任意 Pod 作为写入目标。
2. 读取请求头 `X-Xpod-Thread-Id`。没有该请求头时创建 Thread；提供时加载对应 Thread。
3. 将协议输入归一化为 ChatKit item，并在调用 Provider 前写入最新一条 `user` 或 `tool` 输入。
4. 原始兼容协议请求体不加入 Xpod 私有字段，按原结构交给 Provider service。
5. Provider 成功后，将助手文本和工具调用归一化并写入同一 Thread。
6. 响应头返回 `X-Xpod-Thread-Id`，调用方可在后续请求中继续使用。

输入先于 Provider 调用落盘，因此 Provider 失败时仍会保留用户已经提交的内容，但不会伪造助手成功消息。

## 3. Thread 的创建与复用

首次请求示例：

```http
POST /v1/responses
Authorization: Bearer <token>
Content-Type: application/json

{
  "model": "provider-model",
  "input": "Remember this decision"
}
```

响应包含：

```http
X-Xpod-Thread-Id: chat/default/index.ttl#thread_<id>
```

继续会话时，把该值作为请求头传回。Thread 可以跨协议复用，例如先调用 `/v1/responses`，下一轮再调用 `/v1/messages`：

```http
POST /v1/messages
Authorization: Bearer <token>
Content-Type: application/json
X-Xpod-Thread-Id: chat/default/index.ttl#thread_<id>
```

Thread ID 是 Xpod 的私有会话引用，只存在于 HTTP header 和 Pod 记录中，不会加入 Provider 请求体。

## 4. 统一模型

Xpod 不为三个兼容协议分别建立持久化 Schema。协议 handler 只负责把输入输出映射到现有 ChatKit 类型：

| 统一类型 | 记录内容 | Pod 持久化资源 |
|---|---|---|
| `ThreadMetadata` | 标题、状态、来源协议、模型、创建和更新时间 | `Thread` |
| `UserMessageItem` | 用户文本和推理选项 | `Message`，角色为 user |
| `AssistantMessageItem` | 助手文本和完成状态 | `Message`，角色为 assistant |
| `ClientToolCallItem` | 工具名、调用 ID、参数、状态和输出 | `Message`，角色为 system，工具字段写入 metadata |
| `ThreadRef` | Thread 的完整资源引用 | 不单独建表，用于精确定位 Thread |

持久化资源 `Chat`、`Thread`、`Message` 以及 URI、日期分桶和 exact-id 规则以 `@undefineds.co/models` 为权威。`src/api/chatkit/schema.ts` 只是 Xpod adapter，不维护共享规则副本；Pod CRUD 通过 drizzle-solid 完成。

### 4.1 协议映射

| 协议对象 | 统一结果 |
|---|---|
| Chat Completions `messages[].role=user` | `UserMessageItem` |
| Chat Completions `messages[].role=tool` | 已完成的 `ClientToolCallItem` |
| Chat Completions `choices[].message` | `AssistantMessageItem` |
| Chat Completions `tool_calls[]` | 待执行的 `ClientToolCallItem` |
| Responses `input` 或 input message | `UserMessageItem` |
| Responses `function_call_output` | 已完成的 `ClientToolCallItem` |
| Responses `output[].type=message` | `AssistantMessageItem` |
| Responses `output[].type=function_call` | 待执行的 `ClientToolCallItem` |
| Messages `messages[].role=user` | `UserMessageItem` |
| Messages `tool_result` | 已完成的 `ClientToolCallItem` |
| Messages assistant `text` | `AssistantMessageItem` |
| Messages assistant `tool_use` | 待执行的 `ClientToolCallItem` |

当前归一化关注可继续会话所需的文本与工具调用语义，不承诺无损保存 Provider 的完整原始响应对象。

## 5. Pod 资源布局

默认聊天面使用 `default` surface，逻辑 RDF 资源布局如下：

```text
/.data/chat/default/
  index.ttl
    #this
    #thread_<id>
  YYYY/MM/DD/messages.ttl
    #message_<id>
    #tool_call_<id>
```

- `index.ttl` 保存 Chat parent 和 Thread 元数据。
- `messages.ttl` 按消息 `created_at` 的 UTC 日期分桶，保存消息和工具调用记录。
- 同一 Thread 可以跨多个日期分桶，消息通过 Thread 关系关联，而不是依赖与 Thread 位于同一文件。
- 这些路径描述 Solid/RDF 的逻辑资源。根据运行模式，物理数据可能由文件系统、Quadstore 或 MinIO 承载，不应依赖宿主机一定存在同名普通文件。

## 6. 一致性与失败语义

| 场景 | 已落盘内容 | 响应行为 |
|---|---|---|
| 首次请求成功 | 新 Thread、输入、助手输出、工具调用 | 返回新 `X-Xpod-Thread-Id` |
| 复用 Thread 成功 | 在已有 Thread 追加当前轮次 | 返回同一 Thread ID |
| Provider 失败 | 保留本轮输入，不写助手成功消息 | 保持对应兼容接口的错误响应 |
| Chat Completions 流式成功 | 输入先写入，流结束后写入聚合助手文本 | Thread ID 随响应头返回 |
| 客户端未完整消费流 | 输入已保存；助手消息是否完成取决于流是否走到服务端结束 | 调用方应按失败请求处理 |
| Thread ID 不存在或无权访问 | 不创建同名替代 Thread | 请求失败 |

当前写入不是一次跨资源 RDF 事务：Thread、输入和输出按执行顺序分别持久化。这是保留失败输入的有意语义，而不是“整轮全部成功才提交”的事务模型。

## 7. 读取与后续处理

`POST /v1/chatkit` 及其 Thread 相关操作可以读取和管理同一套 ChatKit 会话数据。AI 兼容接口负责产生会话记录，ChatKit 接口负责会话视图和交互，两者共享 `PodChatKitStore`，不是两套数据。

长期记忆处理模块可以把这里的 Thread 和 Message 作为原始事件源，但建议生成独立的派生资源，并保留来源 Thread、Message 和提取版本，避免把摘要或推断结果覆盖回原始对话。

## 8. 何时扩展模型

以下需求不需要新 Model，只需增加协议 adapter 映射：

- 新增另一个文本对话兼容入口。
- 将协议中的用户文本、助手文本或工具调用映射到现有 item。
- 增加来源协议、模型名等非结构化 metadata。

出现以下情况时，才应评估扩展共享 Model：

- 需要无损保存 Responses reasoning item、Anthropic thinking block 等新的持久化实体。
- 需要把图片、文件、引用、引用区间或 usage 明细作为可查询的一等字段。
- 需要长期记忆的事实、偏好、摘要、证据关系、置信度和生命周期。
- 多个项目都需要查询同一种新 RDF 资源或字段。

扩展顺序必须是：

1. 在 `@undefineds.co/models` 定义或扩展共享 Schema、URI 和 repository 行为。
2. 发布模型包版本并在 Xpod 升级依赖。
3. 在 Xpod 增加协议到共享 Model 的 adapter。
4. 增加 drizzle-solid 读写测试和真实 Pod 集成测试。

不要在 Xpod 内创建只服务于某个 handler 的重复 RDF Schema。

## 9. 当前限制

- `/v1/responses` 和 `/v1/messages` 当前按 JSON 响应处理，尚未实现这两个入口的流式持久化。
- 只写入请求中最新一条 `user` 或 `tool` 输入，避免客户端每轮携带完整历史时重复落盘。
- 不保存 Provider 原始请求/响应副本，也不保存服务端密钥。
- 不自动执行摘要、向量化、事实提取、清理或遗忘。
- 会话保留策略沿用 Pod 数据生命周期，目前没有单独的定期清理任务。

## 10. 实现位置

| 模块 | 职责 |
|---|---|
| `src/api/handlers/ChatHandler.ts` | 三种协议的输入输出归一化、Thread header 和写入时序 |
| `src/api/container/routes.ts` | 将生产 `PodChatKitStore` 注入 AI 路由 |
| `src/api/chatkit/pod-store.ts` | 使用 drizzle-solid 读写 Thread 和 Message |
| `src/api/chatkit/schema.ts` | 将 `@undefineds.co/models` 暴露为 Xpod adapter 名称 |
| `src/api/chatkit/types.ts` | ChatKit API 层的 Thread 和 item 类型 |
| `tests/integration/ChatHandler.integration.test.ts` | 三个兼容入口的会话持久化回归测试 |

相关 API 路由和鉴权说明见 [`api-service-design.md`](./api-service-design.md)。
