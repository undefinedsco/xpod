# 任务系统设计

## 愿景

让 AI 成为用户 Pod 的智能管家，自主地帮助用户管理和处理数据。

与外部协议和自动化生态的接入方式，见 [`docs/protocol-integration-architecture.md`](./protocol-integration-architecture.md)。

## 解决什么问题

### 传统方案的问题

1. **固化流程难以进化**：传统的自动化流程（如 IFTTT、Zapier）一旦配置就锁死，无法随着理解加深而改进
2. **策略难以满足所有人**：不同用户对"什么时候处理"、"处理到什么程度"有不同期望，硬编码策略众口难调
3. **成本与效果难平衡**：全量处理成本高，按需处理又需要复杂的决策逻辑

### 我们的解法

**让 AI 自己决策**：我们只提供工具和标准，AI 根据上下文自主决定用什么工具、做到什么程度。

## 设计原则

### 1. 消息驱动

任务系统是一个**消息路由器**：
- 接收消息
- 路由到对应的 AI Agent
- 记录执行状态

### 2. 工具与标准分离

| 我们提供 | AI 决定 |
|---------|--------|
| 工具（API、Lib） | 用什么工具 |
| 标准（规范文档） | 做到什么程度 |
| 存储规范 | 什么时候做 |

### 3. AI 可以写代码

AI 不仅能调用 API，还能生成代码来完成任务：

- **Python**：用 `langchain-text-splitters` 分块、用 `pypdf` 提取 TOC
- **Shell**：调用命令行工具
- **任何合适的方式**：AI 选择最佳方案

这让 AI 不受限于我们预先封装的工具。

### 4. 不做固化流程

- AI 的使命是**帮助用户**，不是执行固定流程
- 随着 AI 理解加深，处理方式持续进化
- 比如"用户添加待办"：早期只同步消息，后来可能关联文件、提醒最佳时间...

### 4. 用户 ROI 最大化

AI 始终平衡用户的投入产出比：
- **渐进式处理**：不一次做到最深，按需逐步深入
- **缓存已完成的工作**：避免重复投入
- **根据重要程度分配资源**：收藏的、常用的值得更多投入

## 当前落地模型

当前任务系统已经收敛到 Managed Agents 边界。`Run` 是这里必须完成的功能，不是附属说明:

```text
Task     # 任务式命令，和 Chat 并列
Thread   # 观察和 steer 的会话线索
Run      # 一次具体 Agent Runtime 执行
RunStep # Run 的 append-only 执行事实
Message  # 用户/Agent 可见消息
```

`Task` 不直接表示执行过程；执行过程是 `Run`。一次性任务、周期任务、事件任务都会 materialize 成 `Run` 后再交给 Agent Runtime。

当前实现已经把 `Run` 落为一等 Pod 资源，并接到 Chat/Task 两条入口:

- Chat 调用 Agent Runtime 时先创建 `Run`，执行中追加 `RunStep`。
- Task 创建/触发时通过 `TaskMaterializer` 创建 `Run`，再走同一个 `RunExecutionBackend`。
- scheduled/event Task 由内部 `TaskService` / `InngestTaskScheduler` materialize，不作为公共 REST 协议暴露。

### Task

Pod 位置:

```text
/.data/task/index.ttl#{id}
```

字段:

- `prompt`: 任务式命令内容。
- `thread`: URI，观察和 steer 的 Thread。
- `workspace`: URI，指向 workspace Container 或 `file://<runner>/...`。
- `runner`: runner adapter 字符串，例如 `pi:pi`、`pi:codex`。
- `status`: `active | paused | completed | failed`。
- `triggerKind`: `once | interval | cron | event`。
- `intervalSeconds` / `cron` / `eventName`: 触发定义。
- `nextRunAt` / `lastRunAt`: materializer 的调度状态。
- `authBinding`: 任务执行时使用的 Pod credential snapshot/reference，只包含 `id`、`webId`、`clientId`、状态等可持久化信息，不包含 `clientSecret` / `accessToken`。

创建 Task 时，核心 service/API 只接收已经确定的 `authBinding` 值。`existing` / `create` 这类“选择已有密钥还是新建密钥”的分支属于 UI、CLI 或命令向导的交互逻辑：交互层先调用凭据服务读取或创建 Pod credential，再把返回的 binding 作为普通字段写入 Task。Task 存储不记录用户当时选择了哪条交互路径，也不会把 secret 放进 Task、Run 或 Inngest event。

### Run

Pod 位置:

```text
/.data/{chat|task}/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}
/.data/{chat|task}/{surfaceId}/{yyyy}/{MM}/{dd}/runs.ttl#{stepId}
```

Run/Message 的路径归档槽位从 `Thread.parent` / 资源 id 派生；`surfaceId` 只是 API/运行时 DTO 中的派生投影，不是 Thread 的持久归属字段。ChatKit 协议参数 `chat_id` 不写入 Pod metadata。它不表示谁下发任务、谁执行任务，也不表示 runner。

`Run.id` 是相对 `/.data/` base 的资源 id，例如 `chat/default/2026/05/18/runs.ttl#run_x`，不是 `run_x` 这个 fragment/local id。`Run.task`、`Run.thread`、`Run.workspace` 都是边关系。`RunStep.runId` 是本地查询/定位字段，值仍是 Run 的 base-relative resource id；语义关系使用 `RunStep.run`。

`Message` / `Run` / `RunStep` 这类 append-heavy 资源最终应通过字段级 `id.default((key) => ...)` 生成完整 resource id，而不是让业务调用方传日期分桶或 locator。业务 schema 不显式写 `subjectTemplate`；省略模板就是 exact-id subject 模式，完整 `id` 不再被模板反解析。`key` 只存在于 `id.default` 的函数入参里，不进入资源 schema。`default` 只表示“调用方不传 id 时的默认生成函数”；调用方显式传 id 时，也必须传同格式完整 id。

### 对外 API 边界

`Task` 现在还不是著名协议，也不是已经稳定的公共资源 API。第一版不暴露 `/v1/tasks*`，只保留内部 service:

- `TaskService.createTask`
- `TaskService.listTasks`
- `TaskService.loadTask`
- `TaskService.materializeDueTasks`
- `TaskService.materializeEventTasks`
- `InngestTaskScheduler` 的 due/event function

当前公共观察面只暴露 `Run`:

```text
GET /v1/runs
GET /v1/runs/:runId
GET /v1/runs/:runId/steps
POST /v1/runs/:runId/cancel
```

行为:

- `once`: 创建 `Task` 后立即创建并执行 `Run`。
- `interval`: 创建 `Task` 并设置 `nextRunAt`；到期后由 Inngest due function 或内部 scheduler materialize 成 `Run`，再推进 `nextRunAt`。
- `cron`: 记录 cron 表达式；当前通过每分钟 due materializer 触发，复杂 cron 解析后续增强。
- `event`: 内部事件入口和 `xpod/task.event` 都经由 `InngestTaskScheduler` 触发匹配任务，创建 `Run`；payload 进入本次 Run prompt 和 `Run.metadata.trigger`。

### Inngest 边界

Task 的业务事实仍在 Pod，Inngest 只是执行基础设施:

```text
xpod/task.materialize_due or cron
  -> InngestTaskScheduler function
  -> TaskService.materializeDueTasks
  -> Run + RunStep + Message

xpod/task.event
  -> InngestTaskScheduler function
  -> TaskService.materializeEventTasks
  -> Run + RunStep + Message
```

第一版在 API 进程内保留内部 service bridge，但不把它定义成公共 `/v1/tasks` 协议。后续如果 Task 成为稳定跨客户端协议，再单独设计 REST/ACP/MCP 入口。out-of-process worker 要从 Pod 按 `Run`/`Task` URI 恢复状态并 claim 执行。

Task UI 不直接读 Inngest 内部状态。现阶段同进程 UI/后台逻辑通过 `TaskService` 读写 Task 定义，通过 Run API 观察执行:

- `TaskService.listTasks` / `TaskService.loadTask`: 任务定义、状态、触发配置和下一次调度时间。
- `GET /v1/runs?commandKind=task&task=<Task URI>`: 任务产生过的执行流水。
- `GET /v1/runs/:runId/steps`: 执行过程中的输出、tool/auth/error 等 append-only 事实。
- `POST /v1/runs/:runId/cancel`: 写入 `Run.cancelRequestedAt` 和 `run.cancel_requested`，worker 在执行边界停止并写 `run.cancelled`。
- 等待输入/审批不是终结态。Run 进入 `waiting_input` 后保留同一个 `Run.id`；输入或审批结果写入 Pod 后发 `xpod/run.continue_requested`，同一个 Run 被放回队列继续推进这条消息。

`Run` API 的过滤字段使用语义字段值，例如 `task`、`thread`、`workspace` 都传 URI；路径里的 `runId` 表示 Run 的 base-relative resource id。客户端只有 `run_x` 这种局部 template id 时，必须先通过索引/仓储解析，不把 fragment 当业务 id。

## 任务产品直觉

当前模型保留两条产品直觉:

- AI 仍然可以根据消息、资源 `.meta` 状态、用户行为和关联资源自主决定处理深度。
- 当某个 AI 处理模式足够稳定和高频时，可以再固化成更便宜的工具或流程，但固化只是优化手段。

实现上必须使用本文上半部分的 `Task / Thread / Run / RunStep / Message` 模型: `Task` 记录任务式命令定义，`Run` 记录每次执行，`RunStep` 记录执行事实。
