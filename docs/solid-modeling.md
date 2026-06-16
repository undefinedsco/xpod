# Solid / Pod 建模约定

本文档是 Xpod 共享的 Pod/RDF 建模契约。不要只依赖本地 Codex skill 里的隐含规则；涉及 `drizzle-solid` schema、Pod 资源路径、关系字段或 `Run/Task/Chat` 这类共享模型时，都以这里为准。

## 核心原则

- 把 Pod 当作 Linked Data graph，不要当成关系表外键集合。
- 语义关系直接使用边关系字段，例如 `thread`、`task`、`run`、`workspace`；字段名不要写成 `threadUri` / `runIri` 这种传输形态。
- `xxxId` 只表示本地 id、查询 ergonomics 或协议入参，不偷偷承担 RDF link 语义。
- `id` 是相对 `base` 的资源 id，不是 fragment id。例如 `chat/default/2026/05/18/runs.ttl#run_x` 才是 Run 的 `id`，`run_x` 只是生成完整资源 id 时用到的局部 key。
- fragment/local key 只用于生成完整资源 id、局部显示或 runtime session key；进入 store/ORM 的值不能是 `run_x` 或 `#run_x`，从 Pod 回填业务记录时也不要把 `id` 截成 fragment。

## Exact Entity 操作

业务层按资源 id 做精确读写时，使用 `findById` / `updateById` / `deleteById` 这类 ById 能力。现在的 `id` 必须是完整可定位的资源 id；调用方不应该为了命中底层文件路径而补齐日期、父目录或 locator。

不要把日期分桶泄漏成调用方参数。例如 `Run` 可以按天写入：

```text
/.data/chat/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}
/.data/task/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}
```

因此 `loadRun(id)` 接受完整的 base-relative resource id，例如 `chat/default/2026/05/18/runs.ttl#run_x`。如果 UI 只有 `run_x` 这种局部 id，必须先通过 repository/index 解析成完整资源 id；不要把 fragment 当作业务 id 传递。

不要继续使用 `findByLocator` / `updateByLocator` / `deleteByLocator`。现有调用应改为 ById；只有协议/ORM 边界天然持有完整资源地址时才用 ByIri。业务接口不再引入 locator 概念。

## 关系字段和 id 字段

- `Run.thread`、`Run.task`、`Run.workspace`、`RunStep.run` 是边关系，值可以是资源引用，但字段名表达关系本身。
- `Thread.parent` 是 Thread 归属关系的权威字段（`sioc:has_parent`），指向 Chat 或 Task command surface；不要用 `metadata.chat_id`、`metadata.surface_id` 或 `metadata.commandKind` 表达归属。
- `RunStep.runId` 是本地查询字段，值仍是 Run 的 base-relative resource id，用于快速列出某次 Run 的 steps；语义关系仍然是 `RunStep.run`。
- `Thread.id`、`Message.id`、`Task.id`、`Run.id`、`RunStep.id` 都遵循同一规则：进入 store/ORM 的值就是完整 base-relative resource id。业务 schema 不显式写 `subjectTemplate`；省略模板就是 exact-id subject 模式。
- 路径里的 `{surfaceId}` 是从 `Thread.parent` / 资源 id 派生的归档槽位，不是独立持久字段。ChatKit/API 的 `chat_id`、`surface_id`、`commandKind` 只属于边界投影，不能写入 Pod metadata 作为业务语义，也不作为旧数据兼容入口。它不是下发者、不是执行者、不是 runner，也不是 Task assignee。路径上 Chat 和 Task 共用这个槽位：

```text
/.data/chat/{surfaceId}/...
/.data/task/{surfaceId}/...
```

`runner` 只是技术适配器，例如 `pi:codex` 或 `acp:codex`；“谁来干”应由 agent/runtime 配置表达，不塞进路径槽位。

## id 默认生成规则

业务资源默认不写 `subjectTemplate`。不写时，ORM 以 exact-id 模式把完整 `id` 直接拼到 `base` 后面；这不是一条隐式 `{id}` 模板，不能再按模板反解析成 fragment id。只有需要 legacy document/fragment 模板或固定单例 fragment 时，才显式写 `subjectTemplate`。

对日期分桶或父资源路径依赖的资源，不要在业务层新增 `date`、`locator`、`fid`、`rng`、`messageId` 这类概念来补模板槽位。默认生成应挂在 `id` 字段上：

```ts
id: id('id')
  .primaryKey()
  .default((key) => `${parentDir(chat.id)}/{yyyy}/{MM}/{dd}/messages.ttl#${key}`)
```

这里的 `default` 是字段级默认值生成器。调用方不传 `id` 时，ORM 可以生成一个随机 `key` 并代入函数，最终写回完整 base-relative resource id；随后 exact-id subject 解析只负责把这个完整 id 拼到 `base` 后面。调用方显式传 `id` 时，不再走 `default`，传入值必须和默认生成结果同一种格式，例如 `chat/default/2026/05/18/messages.ttl#msg_x`。

关系字段应能给默认生成函数提供 identity projection。`uri('chat').link(Chat)` 在取到 `https://pod/alice/.data/chat/default/index.ttl#this` 后，应根据 `Chat` schema 的 `base` 归一化为可读的关联对象；生成函数里使用 `chat.id`，不要靠固定下标猜路径段。需要目录时使用路径函数，例如 `parentDir(chat.id)`。

`drizzle-solid` 已补字段级 contextual default 的实现方向：默认函数可接收随机 `key` 和当前 row。Xpod 在依赖发布版/共享 models 完成切换前，仍暂时保留显式 `generate*ResourceId(...)` 生成层和 `build*ResourceId(...)` exact-id 校验层；这只是临时桥接，等上游模型能直接生成完整 id 后要删除，不是新的业务模型。进入 store/ORM 的 `id` 必须是完整 base-relative resource id，不再被解析截断成 fragment/local id。

## Chat / Task / Run 路径

Chat 和 Task 是并列的命令形态：

```text
/.data/chat/{surfaceId}/index.ttl#this
/.data/chat/{surfaceId}/index.ttl#{threadId}
/.data/chat/{surfaceId}/{yyyy}/{MM}/{dd}/messages.ttl#{messageId}
/.data/chat/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}
/.data/chat/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{runStepId}

/.data/task/index.ttl#{taskId}
/.data/task/{surfaceId}/index.ttl#{threadId}
/.data/task/{surfaceId}/{yyyy}/{MM}/{dd}/messages.ttl#{messageId}
/.data/task/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}
/.data/task/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{runStepId}
```

`Task` 定义集中放在 `/.data/task/index.ttl`；Task 产生的 thread/message/run/step 目录从 `Thread.parent = task/index.ttl#{taskId}` 派生，当前路径形状仍使用 `task/{taskKey}` 与 Chat 的目录结构对齐。

## 共享资源 id 总表

`@undefineds.co/models` 的 `solidResources` 和资源 id 生成函数是当前权威。下表覆盖 models 包里进入 `solidResources` 的共享资源；`fileResource` 这类 deprecated compatibility resource 不作为新建模契约。

下表里的 `id` 都是相对各自 `base` 的完整 resource id；`{key}` 只是调用方不传 `id` 时交给 `id.default(...)` 的局部随机/自定义 key，不是持久化字段。没有 `id.default(...)` 的特殊资源会在表里单独标注。

| Resource | Base | 默认 id 形状 | 完整资源地址示例 | 说明 |
|---|---|---|---|---|
| `solidProfileResource` | `idp:///profile/card` | 无默认；按 WebID exact IRI | `https://id.example/alice/profile/card#me` | WebID Profile 是 IdP 侧主体，不落在普通 `/.data` 目录。 |
| `chatResource` | `/.data/chat/` | `{key}/index.ttl#this` | `/.data/chat/default/index.ttl#this` | 交互式命令面，`key` 是 chat/counterpart 槽位。 |
| `taskResource` | `/.data/task/` | `index.ttl#{key}` | `/.data/task/index.ttl#task_1` | 任务式命令定义集中索引；执行过程另落到 thread/message/run。 |
| `threadResource` | `/.data/` | `chat/{chatKey}/index.ttl#{key}` | `/.data/chat/default/index.ttl#thread_1` | Chat 下的具体时间线；由 `thread.chat` 推导目录。 |
| `messageResource` | `/.data/` | `{ownerDir}/{yyyy}/{MM}/{dd}/messages.ttl#{key}` | `/.data/chat/default/2026/05/18/messages.ttl#msg_1` | ownerDir 来自 `chat` 或 `thread` 关系；Task 线程可落在 `task/{taskKey}/...`。 |
| `runResource` | `/.data/` | `{ownerDir}/{yyyy}/{MM}/{dd}/runs.ttl#{key}` | `/.data/task/task_1/2026/05/18/runs.ttl#run_1` | ownerDir 优先 `task`，其次 `thread`/`chat`；Run 是执行状态中心。 |
| `runStepResource` | `/.data/` | `{runDocument}#{key}` | `/.data/task/task_1/2026/05/18/runs.ttl#step_1` | 与 Run 放在同一个 `runs.ttl` 文档；语义关系是 `runStep.run`。 |
| `scheduleResource` | `/.data/` | `{taskDir}/{yyyy}/{MM}/{dd}/schedules.ttl#{key}` | `/.data/task/task_1/2026/05/18/schedules.ttl#schedule_1` | 调度计划绑定 Task；没有 task 时落到 `schedules/...`。 |
| `deliveryResource` | `/.data/` | `{ownerDir}/{yyyy}/{MM}/{dd}/deliveries.ttl#{key}` | `/.data/task/task_1/2026/05/18/deliveries.ttl#delivery_1` | 任务分发/投递事实，ownerDir 来自 task/chat/thread。 |
| `automationRuleResource` | `/.data/` | `automation-rules/{key}.ttl` | `/.data/automation-rules/rule_1.ttl` | 规则/策略资源，不是一次执行。 |
| `issueResource` | `/.data/issues/` | `{key}.ttl` | `/.data/issues/issue_1.ttl` | 用户可见事项；可关联 chat/thread/task。 |
| `sessionResource` | `/.data/sessions/` | `{yyyy}/{MM}/{dd}/{key}.ttl` | `/.data/sessions/2026/05/18/session_1.ttl` | runtime/session 类高增长资源按日期分桶。 |
| `approvalResource` | `/.data/approvals/` | `{yyyy}/{MM}/{dd}.ttl#{key}` | `/.data/approvals/2026/05/18.ttl#approval_1` | 一次性审批事实。 |
| `auditResource` | `/.data/audits/` | `{yyyy}/{MM}/{dd}.ttl#{key}` | `/.data/audits/2026/05/18.ttl#audit_1` | 审计事实，高增长按日期分桶。 |
| `agentResource` | `/.data/agents/` | `{key}.ttl` | `/.data/agents/secretary.ttl` | Agent Profile/配置；不是 runtime 实例。 |
| `contactResource` | `/.data/contacts/` | `{key}.ttl` | `/.data/contacts/alice.ttl` | 统一联系人索引，可表示 Solid 用户、外部联系人、AI agent 或群组。 |
| `favoriteResource` | `/.data/favorites/` | `{yyyy}/{MM}/{dd}.ttl#{key}` | `/.data/favorites/2026/05/18.ttl#favorite_1` | 收藏项是用户行为事实，按收藏时间分桶。 |
| `inboxNotificationResource` | `/inbox/` | `{key}.ttl` | `/inbox/notice_1.ttl` | Solid inbox/activity 通知。 |
| `settingsResource` | `/settings/` | legacy `subjectTemplate: {key}.ttl` | `/settings/ui.theme.ttl` | 用户设置仍以 `key` 作为 subject/storage key；新共享模型不要照搬这套写法。 |
| `aiProviderResource` | `/settings/providers/` | `{key}.ttl` | `/settings/providers/anthropic.ttl` | AI provider 配置，如 baseUrl/proxy/defaultModel。 |
| `aiModelResource` | `/settings/providers/` | `{providerDocument}#{key}` | `/settings/providers/anthropic.ttl#claude-sonnet-4` | Model 归属 Provider 文档；由 `isProvidedBy` 推导 providerDocument。 |
| `credentialResource` | `/settings/` | `credentials.ttl#{key}` | `/settings/credentials.ttl#anthropic-default` | 密钥/令牌资源，和 Task/Run 分开；Task 只引用或绑定，不复制 secret。 |
| `aiConfigResource` | `/settings/ai/` | `config.ttl#{key}` | `/settings/ai/config.ttl#embedding` | AI 运行配置。 |
| `vectorStoreResource` | `/settings/ai/` | `vector-stores.ttl#{key}` | `/settings/ai/vector-stores.ttl#main` | 向量库配置。 |
| `indexedFileResource` | `/settings/ai/` | `indexed-files/{key}.ttl` | `/settings/ai/indexed-files/file_1.ttl` | 被索引文件元数据。 |
| `agentStatusResource` | `/settings/ai/` | `agent-status.ttl#{key}` | `/settings/ai/agent-status.ttl#secretary` | Agent 当前状态快照。 |
| `grantResource` | `/settings/autonomy/grants/` | `{key}.ttl` | `/settings/autonomy/grants/grant_1.ttl` | 持久授权/委托策略。 |

Provider、Model、Credential 这组不是 ChatKit 私有概念，也不应在 Xpod 里重复定义 schema。业务层使用 `models` 的 `aiProviderResource`、`aiModelResource`、`credentialResource` 和对应 `*ResourceId(...)` helper；`apiKeyCredentialResource` / `oauthCredentialResource` 只是 `credentialResource` 的兼容 alias，不是两套密钥资源。如果需要 UI 里让用户“选择已有密钥或新建密钥”，那只是交互流程，最终持久化仍然是 `/settings/credentials.ttl#{key}` 里的 Credential 资源，以及 Task/Run 上的语义关系或授权绑定。
