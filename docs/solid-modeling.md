# Solid / Pod 建模约定

本文档是 Xpod 共享的 Pod/RDF 建模契约。不要只依赖本地 Codex skill 里的隐含规则；涉及 `drizzle-solid` schema、Pod 资源路径、URI 字段或 `Run/Task/Chat` 这类共享模型时，都以这里为准。

## 核心原则

- 把 Pod 当作 Linked Data graph，不要当成关系表外键集合。
- 语义关系使用 URI 字段，例如 `thread`、`task`、`run`、`workspace`。
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

不要继续使用 `findByLocator` / `updateByLocator` / `deleteByLocator`。现有调用应改为 ById；天然持有完整 URI 的场景用 ByIri。业务接口不再引入 locator 概念。

## URI 字段和 id 字段

- `Run.thread`、`Run.task`、`Run.workspace`、`RunStep.run` 是 URI 关系。
- `Thread.chat` 是 Chat 的 URI 关系；ChatKit 协议里的 `chat_id` 只在 adapter metadata/API 参数里出现，不作为 RDF 字段名。
- `RunStep.runId` 是本地查询字段，值仍是 Run 的 base-relative resource id，用于快速列出某次 Run 的 steps；语义关系仍然是 `RunStep.run`。
- `Thread.id`、`Message.id`、`Task.id`、`Run.id`、`RunStep.id` 都遵循同一规则：进入 store/ORM 的值就是完整 base-relative resource id。业务 schema 不显式写 `subjectTemplate`；省略模板就是 exact-id subject 模式。
- `surfaceId` 表示命令从哪个 command surface/channel 产生并归档。ChatKit 边界仍叫 `chat_id`，进入 Xpod durable model 后映射为 `surfaceId`。它不是下发者、不是执行者、不是 runner，也不是 Task assignee。路径上 Chat 和 Task 共用这个槽位：

```text
/.data/chat/{surfaceId}/...
/.data/task/{surfaceId}/...
```

`runner` 只是技术适配器，例如 `pi:codex` 或 `acp:codex`；“谁来干”应由 agent/runtime 配置表达，不塞进 `surfaceId`。

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

`Task` 定义集中放在 `/.data/task/index.ttl`；Task 产生的 thread/message/run/step 按 `task/{surfaceId}` 与 Chat 的目录结构对齐。
