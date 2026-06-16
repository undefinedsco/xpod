# Task / Chat / Managed Agents 边界设计备忘

来源:

- Anthropic Engineering, [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents), 2026-04-08.
- OpenAI, [Codex 编排的开源规范: Symphony](https://openai.com/zh-Hans-CN/index/open-source-codex-orchestration-symphony/), 2026-04-27.
- Inngest Docs, [Durable Execution](https://www.inngest.com/docs/learn/how-functions-are-executed), [Inngest Functions](https://www.inngest.com/docs/learn/inngest-functions), [Realtime](https://www.inngest.com/docs/features/realtime), [Crons](https://www.inngest.com/docs/guides/scheduled-functions), [Cancellation](https://www.inngest.com/docs/features/inngest-functions/cancellation), and [Self-hosting](https://www.inngest.com/docs/self-hosting), checked 2026-05-17.
- LinX 本地实现: `~/develop/linx/packages/agent-runtime/src/symphony.ts`、`~/develop/linx/docs/agent-collaboration-model.md`。

## 核心修正

之前把 `Task`、Managed Agents、Symphony 混成了一层，这是错误方向。它们是三个不同层级:

| 层级 | 含义 | xpod 第一阶段 |
| --- | --- | --- |
| `Chat / Task` | 用户命令形态: 交互式命令 vs 任务式命令 | 要实现 |
| Managed Agents | 无状态 Agent Runtime: brain/harness 和 hands/sandbox 的稳定接口 | 要实现 |
| Symphony | 更上层 multiple agents 编排: 多 agent 分工、投递、审查、任务图 | 暂不实现，只保持可对接 |

因此 xpod 现在应该先做前两者:

1. `Chat` 和 `Task` 都是对 Agent Runtime 的调用方式，不是 Symphony 的项目管理资源。
2. Agent Runtime 应该是无状态的: 接收 command + context refs，执行，事件和结果写回 Pod。
3. Symphony 以后可以消费 xpod 的 Chat/Task/Run/Message，但不应该决定 xpod 第一阶段的数据模型。

## Chat 和 Task 的关系

`Chat` 与 `Task` 的区别不是“是否持久化”，而是命令交互模式不同:

- `Chat`: 交互式命令。用户持续发消息，Agent 持续回应。核心体验是 conversation / steer。
- `Task`: 任务式命令。用户提交一个目标，Agent 异步执行。核心体验是 observe / steer / cancel / resume。

两者都可以产生执行记录:

```text
Chat command
  -> Thread
  -> Message*
  -> Run         # 调用 Agent Runtime 时创建一等执行记录

Task command
  -> Task
  -> Thread      # 用于观察和 steer
  -> Run
  -> Message*
```

`Task` 不应被建模成 Chat 的子对象；`Chat` 也不应被理解成工作空间。它们只是两种 command surface。下面的 `Thread / Message / Run / RunStep` 可以共用。

## Managed Agents 在 xpod 里的含义

Anthropic 文章里的关键拆分:

- **Session**: 持久事件日志，记录发生过什么。
- **Harness**: Agent 循环，负责模型调用、上下文组织和工具分发。
- **Sandbox / Hands**: 真正执行代码、读写文件、访问外部系统的环境或工具。

xpod 里不要直接把这个 `Session` 命名为一等资源，因为已有 Solid auth session、ChatKit session、runtime session 等歧义。共享模型中使用:

- `Run`: 一次 Agent Runtime 执行。
- `RunStep`: Run 的 append-only 事实日志。
- `Message`: 用户和 Agent 可见的沟通、steer、工具请求和结果。

Agent Runtime 的目标边界:

```text
POST /api/agent-runs
  input:
    thread: Thread URI
    parent: derived from Thread.parent
    prompt/message: string
    runner: pi adapter by default; ACP runner id when the selected runner speaks ACP
    workspace/context refs

  behavior:
    load durable context from Pod
    start runner for this invocation
    stream output/events
    write Message/RunStep/Run state to Pod
    stop runner or leave only external resumable handle
```

Runtime 进程本身不拥有长期状态。长期事实在 Pod:

- Thread/Message 保存可见上下文和 steer。
- Run 保存执行状态、runner、workspace、external id。
- RunStep 保存可恢复/可审计事实。

## 当前 xpod 状态

当前代码里有三个容易混淆的 runtime:

| 名称 | 当前含义 | 处理方向 |
| --- | --- | --- |
| `src/runtime/*` | xpod 服务运行时，启动 CSS/API/Gateway | 保留，但不要叫 Agent Runtime |
| xpod CLI agent mode | 用 `@mariozechner/pi-coding-agent` 做本地交互 agent | 清理；CLI 只保留运维功能 |
| `ChatKit` thread-bound runtime | 按 threadId 在内存里维护 ACP runner 进程 | 已改成 `RunStateCenter` + 无状态 runner adapter 方向 |

`xpod login` 应表示 xpod/Solid 登录或凭据建立，不表示 AI provider OAuth 登录。AI provider 配置仍应写入用户 Pod，主要通过配置 API/UI 或 descriptor-backed object/secret 操作完成，不复用 pi 的 login/OAuth registry，也不占用顶层 `xpod config`。

当前已落地的代码边界:

- `src/api/runs/schema.ts`: 定义一等 `Run` / `RunStep` Solid 资源。
- `Thread.id`、`Message.id`、`Task.id`、`Run.id`、`RunStep.id` 都是相对各自 `base` 的资源 id；不要把它们回填成 fragment/local id。
- `Run.workspace`、`Run.thread`、`RunStep.run` 都是 RDF 边关系；`runId` 是本地查询字段，值仍是 Run 的 base-relative resource id，不是 RDF link。
- `src/api/runs/RunStateCenter.ts`: Chat runtime 调用 Agent Runtime 时创建 `Run`，并 append `run.created`、`run.started`、`runtime.*`、`run.completed/run.failed` 事件。
- `src/api/chatkit/pod-store.ts`: `PodChatKitStore` 初始化并读写 `Run` / `RunStep`，source of truth 在用户 Pod。
- `src/api/tasks/*`: Task 已作为和 Chat 并列的任务式 command surface；once/interval/event Task 都会 materialize 成 `Run`，不是自己保存执行过程。
- `src/api/tasks/InngestTaskScheduler.ts`: Task due/event 触发通过 Inngest event/function 边界进入 materializer；API 手动触发也走这条 bridge。
- `InngestRunExecutionBackend` 支持 API 进程内 inline bridge，也支持 Inngest function 在没有 pending HTTP stream 时通过 `ManagedRunWorker` 从 Pod 恢复 `Run/Thread/Message` 后执行。
- `ManagedRunWorker` 执行前会 claim `Run` lease，避免重复 Inngest callback/多 worker 重复执行；执行中会检查 `cancelRequestedAt` 并写入 `run.cancelled`。
- `Run` API 暴露观察面和取消入口；steer 当前仍走 ChatKit client tool output/消息入口，后续可补专用 Run steer endpoint。

## pi Agent Runtime 边界

pi 是 Xpod 当前采用的自研 Agent Runtime 能力层，不需要用其它项目替换。第一阶段以 pi 为默认 runtime engine，Codex / CodeBuddy 只作为兼容 runner/projection 目标:

- `createAgentSession(...)`: 创建一次请求作用域的 pi AgentSession。
- `SessionManager.inMemory(...)` 或 `SessionManager.create(...)`: 只作为 pi runtime 内部需要的会话载体。
- `createCodingTools(cwd)` / `createReadOnlyTools(cwd)`: 使用 pi 的 read/bash/edit/write/grep/find/ls 等工具实现。
- `DefaultResourceLoader`: 使用 pi 的 system prompt / skills prompt 拼接能力。
- local 部署直接在 Pod 根目录里运行这套 pi Agent Loop，不额外进入沙盒。
- cloud 部署不单独包 bash；把需要受限的工具调用、文件读写和编辑放入 sandboxed worker/process，Agent Loop 和模型调用可以保留在外层，便于 server/client 执行位置切换。

关键约束:

- pi 的 `SessionManager` 不是 xpod 状态中心，也不是业务事实源。
- 每次执行都从 xpod 的持久状态恢复: 读取 `Run / Thread / Message / Task`，投影成 pi 可理解的 `AgentMessage[]`，再调用 `session.prompt(...)`。
- 每次要使用 pi 的原子 runtime 能力时，都新建一次请求作用域的 `AgentSession`，先用 `session.agent.replaceMessages(...)` 写入 Xpod 恢复出的历史，再执行当前 prompt。
- pi 可以在一次执行内部维护工具调用、模型循环、事件流和临时 session id；执行结束后，重要事实必须写回 `RunStep / Message`。
- 若为了调试保留 pi JSONL session，也只能作为 `externalRunId` 或诊断副本，不能替代 Pod 里的 RunStep。

因此代码里的 `PiAgentRuntimeDriver` 应该长成 adapter:

```text
RunExecutionInput
  runId
  threadId
  prompt
  conversation     # 从 Pod Thread/Message 恢复出的历史
  runtime config
    |
    v
PiAgentRuntimeDriver
  resolve workdir
  if local:
    create pi SessionManager
    create pi AgentSession
    replace pi messages with conversation
    prompt current message
  if cloud:
    start sandboxed worker at workdir
    worker creates pi SessionManager / AgentSession
    worker replaces messages and prompts
  map pi events -> RunStep/Message projection
```

这符合 managed-agents 的“无状态 runtime”边界: runtime 每次可以被重建，状态恢复来自 durable log。

## Agent Profile 存储格式

持久存储格式主参考 Solid/RDF/drizzle-solid 和 `@undefineds.co/models`，不是 pi、Codex 或 Kiro 的本地文件格式。Pod 里只保留一套通用 Agent Profile；runtime 差异通过 projector/adapter 投影。

人类可编辑入口参考 Codex 的 `AGENTS.md` / `SKILL.md` 习惯，但机器可查询配置放在 `.meta#config`:

```text
/agents/{agentId}/
  AGENTS.md          # 纯 Markdown 指令入口
  .meta              # RDF 结构化配置，subject 为 .meta#config
  skills/{name}/SKILL.md
```

`AGENTS.md` 可以很长，语义等同 Codex 的项目指令文件；resolver 把整个文件作为 agent instructions，不解析 YAML frontmatter。稳定机器配置放在 `.meta#config`:

```ttl
<#config>
  a udfs:AgentConfig ;
  udfs:provider </settings/providers/anthropic.ttl> ;
  udfs:credential </settings/credentials.ttl#cred-anthropic> ;
  udfs:model </settings/providers/anthropic.ttl#claude-sonnet> ;
  udfs:runtimeKind "claude" ;
  udfs:maxTurns 20 ;
  udfs:allowedTool "Read", "Write" ;
  udfs:skill <skills/solid-modeling> ;
  udfs:mcpServer "{\"name\":\"jina\",\"transport\":\"stdio\",\"command\":\"npx\",\"args\":[\"-y\",\"@jina-ai/mcp-server\"]}" ;
  udfs:enabled "true" .
```

`skills/` 是 Markdown package 文件，resolver 读取后提供给 runtime:

- pi 当前通过 `appendSystemPrompt` 消费 skill 正文。
- Codex 通过 `CodexRuntimeProjector` 投影成 invocation-scoped `CODEX_HOME/skills/{name}/SKILL.md`。
- CodeBuddy / cc 通过 ACP session 参数或后续 projector 消费。

不要在 Pod Agent Profile 中猜测 runtime 私有布局，例如 `rules/*.md` 或 `mcp/*.json`。MCP server 定义先作为 `.meta` 的结构化字段保存；如果后续需要 RDF 可查询的 MCP 资源，再在 shared model 中定义对应资源。

## Workspace 与 Sandbox 边界

Chat/Task 发起 Run 时应该带明确的 `workspace` 关系；没有显式 workspace 时不应悄悄回退到 Pod root 或服务端 `cwd`。workspace 在 Solid 模型中是指向 Container 的边关系:

```text
Pod workspace:  https://pod.example/alice/projects/demo/
Host workspace: file://ganlu-mbp/Users/ganlu/projects/demo/
Local dev:      file://localhost/Users/ganlu/develop/xpod-jobs/
```

稳定的 workspace 信息挂在对应 Container 的 `.meta`，不塞进 Thread/Run 的 metadata。Thread/Run 只记录 workspace reference。workspace 的文件权威、DB 索引、COS 同步和 materialization 语义由 [SolidFS spec](solidfs-spec.md) 单独定义；Managed Agents 只依赖它提供一个可执行的工作目录。

### SolidFS 接口

最小接口形态:

```text
SolidFS.prepare({ run, workspace }) -> { cwd, manifest, commit(), rollback() }
PiAgentRuntimeDriver.start(input)
  -> workspace = SolidFS.prepare(...)
  -> run pi loop with cwd = workspace.cwd
  -> workspace.commit() on completed/approved write
  -> workspace.rollback() on failed/cancelled before commit
```

`manifest` 只在 Managed Agents 层作为执行证据和回写句柄使用；其字段和 projection 语义由 SolidFS spec 管理。Runtime 不直接理解 Pod/COS/RDF 的内部同步细节。

执行策略:

- local: `SolidFS.prepare` 仍然必须执行，只是退化成本机直连映射：返回本机可访问的真实 workspace cwd，必要时把 `.ttl` / RDF 资源映射成本地工作副本。Runtime 不加沙盒，便于本地开发和低延迟交互。
- cloud: `SolidFS.prepare` 应返回 sandboxed worker/process 可访问的真实 cwd；优先只把工具包和文件操作放进受限边界，Agent Loop 与模型调用尽量保留在外层，方便 server/client 之间切换执行位置。
- 如果 cloud 节点没有可用的 OS sandbox，Run 应失败为 runtime error，而不是降级成未沙盒执行。

## Run 中心与执行后端

`Run` 是状态中心，不是 ChatKit，也不是 pi 的 `SessionManager`。

`Run` 现在是一等 Pod 资源，而不是代码内临时概念:

- `Run`: `/.data/{chat|task}/{parentKey}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}`
- `RunStep`: `/.data/{chat|task}/{parentKey}/{yyyy}/{MM}/{dd}/runs.ttl#{stepId}`
- `Run.thread`、`Run.workspace`、`Run.task` 都是 RDF 边关系。
- `Run.id` 回填为 `chat/default/2026/05/18/runs.ttl#run_x` 这种 base-relative resource id；`run_x` 只是在生成完整 id 时使用的局部 key。
- `RunStep.run` 是指向 Run 的 RDF URI；`RunStep.runId` 是本地查询字段，值同样使用 Run 的 base-relative resource id。
- 路径归档槽位从 `Thread.parent` / 资源 id 派生；`commandKind` / `surfaceId` 只属于 Run API 兼容投影，存储 DTO 和 durable model 不保留。ChatKit 外部协议里的 `chat_id` 不写入 Pod metadata，内部 durable model 不再使用 `chatId` / `targetId` 表达这个含义。
- 默认 id 生成应是字段级能力，例如 `id.default((key) => ...)`。`key` 是 ORM 生成的随机局部 key；最终 `id` 仍是完整 base-relative resource id。业务 schema 不显式写 `subjectTemplate`；省略模板就是 exact-id subject 模式，完整 `id` 不再被模板反解析。不要把 `key`、`fid`、`rng` 或日期 locator 暴露成业务接口概念。

这意味着功能是否完成不能只看 ChatKit 是否能 stream。每次 Chat 或 Task 调用 Agent Runtime，都必须先有 `Run`，并且执行中/执行后要 append `RunStep`。UI 观察、steer、cancel、审计和后续 Symphony 编排都以 `Run` 为执行事实中心。

代码层可以拆成:

```text
RunStore       # 持久化 Run / RunStep，source of truth 在 Pod
RunScheduler   # 创建、排期、把 Task/trigger materialize 成 Run
RunExecutionBackend
  - InngestRunBackend   # durable execution / cron / retry / flow control
  - PollingRunBackend   # 本地/降级: immediate kick + 周期 sweep
RunWorker      # 后端内部执行已 claim 的 Run，可由 Inngest function 或本地 worker 承担
RunnerAdapter  # pi | acp | other，把 engine 事件映射成 RunStep
```

最小接口:

```text
RunExecutionBackend.enqueue(run: Run): Promise<EnqueueResult>
RunExecutionBackend.kick(run: Run): Promise<void>
RunExecutionBackend.cancel(run: Run): Promise<void>
```

`enqueue` 负责把 `Run` 交给执行后端。`kick` 用于 Chat 这类低延迟入口，允许当前 API 进程立即推动执行或立即通知 Inngest。`cancel` 只通知执行后端；取消事实仍写在 Pod 的 `Run.cancelRequestedAt` 和 `RunStep` 里。

本地 fallback 可以实现“立即 kick + 周期 sweep”:

- API 创建 Run 后立即尝试在本进程执行，保证 Chat 交互延迟低。
- Worker 每 10-60 秒扫描 `queued`、`scheduledAt <= now`、`leaseExpired` 的 Run，负责异步任务和崩溃恢复。
- Worker claim Run 时写 `leaseOwner / leaseExpiresAt / heartbeatAt`，避免多进程重复执行。
- 所有输出、auth、tool call、error、steer、cancel 事实都 append 到 `RunStep`。

这个抽象接近 Celery 的 queue + worker + result backend。Inngest 可以直接作为第一版生产执行后端，因为它已经提供 event/cron/webhook triggers、step 级 retry/checkpoint、concurrency/throttling/rate-limit、Realtime 和自托管部署能力。但 xpod 的 source of truth 仍应是 Pod 里的 `Run / RunStep`，不是 Inngest 的内部 run state。

## Inngest 集成边界

Inngest 可以直接接入 xpod 的业务模型，但只能拥有“执行基础设施状态”，不能拥有“业务事实”。

```text
Xpod Pod
  Chat / Task / Thread / Message / Run / RunStep
  # 用户可见、可迁移、可审计、可被 Solid app 读取

Inngest
  Event queue / durable function run / steps / retry / cron / concurrency / realtime
  # 执行交付、重试、限流、可观测性
```

因此:

- `Run.id` / `Run` IRI 是 xpod 的业务主键；前者是 base-relative resource id，后者是绝对 IRI。
- Inngest function run id 只能写入 `Run.externalRunId`，用于追踪和排查。
- Inngest event payload 只携带 `run`、`thread`、`task` 这些资源 URI 或 id，不携带完整上下文快照。
- Inngest function 每次执行都从 Pod 读取最新 `Run / Thread / Message / Task`，执行过程写回 `RunStep / Message`。
- Inngest Realtime 可以用于低延迟 UI 推送，但重要状态仍必须落 `RunStep`，Realtime 只是投影。

推荐事件:

```text
xpod/run.requested
  data: { run: Run URI }

xpod/run.cancel_requested
  data: { run: Run URI, reason?: string }

xpod/run.continue_requested
  data: { run: Run URI, continuation: { kind, item?: Message URI } }

xpod/run.steer_requested
  data: { run: Run URI, message: Message URI }

xpod/task.due
  data: { task: Task URI, scheduledFor: datetime }
```

推荐 Inngest function:

```text
xpod.agent.run
  trigger: xpod/run.requested
  steps:
    1. load Run from Pod
    2. claim Run / write running RunStep
    3. start RunnerAdapter (default pi adapter)
    4. stream adapter events to RunStep and Message
    5. mark completed / failed / waiting_input / cancelled

`waiting_input` / approval-like pauses are not terminal message results. They
park the same message-level `Run` until the required input is written to Pod;
then xpod emits `xpod/run.continue_requested` for the same `Run.id`. The queue
still works at Run/continuation granularity, not token/tool-chunk granularity.

xpod.task.materialize-due-runs
  trigger: cron, e.g. every minute
  steps:
    1. read due Task definitions from Pod
    2. create one Run per due occurrence
    3. send xpod/run.requested for each Run
```

Chat 入口不应等待 cron/sweep:

```text
ChatKit threads.add_user_message
  -> write User Message
  -> create Run
  -> send xpod/run.requested
  -> SSE subscribes to RunStep projection and/or Inngest Realtime channel
```

Task 入口可以统一 materialize 成 Run:

```text
one-shot Task
  -> create Task
  -> create Run immediately
  -> send xpod/run.requested

scheduled Task
  -> Task stores recurrence in Pod
  -> xpod.task.materialize-due-runs creates Runs when due

triggered Task
  -> webhook/event handler validates trigger
  -> create Run
  -> send xpod/run.requested
```

当前已落地的 Task 内部 service:

```text
TaskService.createTask(input, context)
TaskService.listTasks(context, options?)
TaskService.loadTask(taskId, context)
TaskService.materializeDueTasks(context, options?)
TaskService.materializeEventTasks({ eventName, payload, context })
```

`Task` 暂时不是公共 REST 协议资源，不暴露 `/v1/tasks*`。Chat、调度器和 agent runtime 在服务内部调用 `TaskService`；如果未来要给外部客户端开放，需要重新设计稳定协议入口。

当前已落地的 Run 观察 API:

```text
GET /v1/runs
  query:
    task?: Task URI
    thread?: Thread URI
    workspace?: Workspace reference
    commandKind?: chat | task
    status?: queued | running | waiting_input | waiting_runner | completed | failed | cancelled
    limit?: number

GET /v1/runs/:runId

GET /v1/runs/:runId/steps
```

这些 API 读取 Pod 里的 `Run / RunStep`，不是读取 Inngest 的内部 function run 状态。UI 管理 Task 时应该用 Task 定义做列表，用 Run 列表和 RunStep 做执行观察。

API 行为:

- `once`: 创建 `Task` 和观察用 `Thread` 后立即 materialize 成 `Run`，然后走同一个 `RunExecutionBackend`。
- `interval`: `Task.nextRunAt` 到期后由内部 scheduler 或 Inngest due function materialize 成 `Run`，成功触发后推进 `nextRunAt`。
- `cron`: 先记录 cron 表达式；当前最小实现由每分钟 due function 调用 materializer，已支持基础 next tick 推进，复杂 cron 解析后续替换为标准 parser。
- `event`: 由内部事件入口或 `xpod/task.event` materialize 成 `Run`，event payload 会进入本次 Run prompt 和 `Run.metadata.trigger`。

Inngest 侧已注册:

```text
xpod.task.materialize-due-runs
  trigger: cron */1 * * * * and xpod/task.materialize_due

xpod.task.event
  trigger: xpod/task.event
```

注意: Inngest cron function 自身没有某个用户 Pod 的 Solid auth 上下文。它是执行基础设施入口，真正扫描哪个 Pod 必须来自认证 API、服务授权上下文，或未来的 pod/account index + service token。第一版可通过认证 API 直接 materialize 当前用户 Pod 的 due/event tasks；Inngest function 在有上下文 payload 或部署侧提供服务上下文时调用同一套 `TaskService`。

动态用户周期任务的 source of truth 是 Pod 里的 Task recurrence。Inngest cron 可以每分钟扫描 due Task，也可以以后镜像成 Inngest schedule，但镜像不是业务事实来源。

取消和 steer 的边界:

- Cancel API 先写 `Run.cancelRequestedAt` 和 `RunStep(type=cancel_requested)`，再通知 Inngest。
- Inngest cancellation 可以阻止尚未开始的 run 或在 step 边界停止 function；正在执行的 ACP/pi 子进程仍需要 `RunnerAdapter` 自己 interrupt/kill。
- Steer 是写入 Thread/Message/RunStep 的用户事实。Inngest function 可以通过 event 唤醒、Realtime、或 worker 轮询把 steer 转给 runner。
- 对于长时间运行的 runner，`RunnerAdapter` 必须定期 heartbeat 并检查 Pod 中的 cancel/steer，不应只依赖 Inngest step 边界。

部署策略:

- 没有配置 Inngest 时，xpod API 不启动 Inngest、不暴露 `/api/inngest`，Chat/Run 仍走进程内 inline execution。
- Local 单机可以显式配置 `XPOD_INNGEST_MODE=spawn`，由 xpod API runtime spawn 一个内嵌 Inngest dev/server 进程，使用本地 `.inngest`/SQLite 状态。
- Cloud/cluster 不是每个 xpod API replica 各自 spawn 孤立 Inngest。部署层提供一个 cluster-scoped Inngest service URL，例如 `XPOD_INNGEST_BASE_URL=http://xpod-inngest:8288`。
- Inngest 回调 xpod 的 function endpoint 固定是 `{apiBaseUrl}/api/inngest`，由 xpod 从 `XPOD_API_BASE_URL`、`CSS_BASE_URL` 或当前 API 监听地址推导；多个 xpod API replica 通过 service/LB 暴露同一个 `/api/inngest`。
- 这个 Inngest service 属于 xpod 部署内部控制面，不是用户外接 Inngest Cloud；它在集群模式下使用共享 Postgres/Redis 形成一个逻辑 Inngest 集群。
- 所有 backend 都只调用 `RunStore` 和 `RunnerAdapter`，不让 ChatKit/Task API 直接拥有 Inngest SDK 状态。

当前环境变量约定:

```text
XPOD_INNGEST_ENABLED=false          # 显式禁用 Inngest；未配置任何 Inngest 变量时也默认禁用
XPOD_INNGEST_MODE=managed|spawn     # 显式启用 Inngest；cloud 通常 managed，local 通常 spawn
XPOD_INNGEST_BASE_URL=...           # xpod API -> Inngest service；cloud/managed 启用时需要
XPOD_API_BASE_URL=...               # 可选；覆盖 xpod 推导出的 API callback base
XPOD_INNGEST_EVENT_KEY=...          # Inngest event key；cloud/managed 必填
XPOD_INNGEST_SIGNING_KEY=...        # Inngest signing key；cloud/managed 必填；self-hosted start 要求偶数长度 hex
XPOD_INNGEST_BIN=...                # local spawn 时覆盖 inngest CLI 路径
XPOD_INNGEST_SQLITE_DIR=...         # local spawn 的 Inngest SQLite/state 目录
CSS_REDIS_CLIENT / REDIS_URL        # cloud spawn/cluster 可供 Inngest 使用的 Redis URL
```

若本地显式启用了 `XPOD_INNGEST_MODE=spawn`，但 `inngest-cli` 的 native binary 因安装脚本未执行而不可用，xpod 会让 Chat 走 inline runner，`durableDelivery=false`。这只是本地开发降级；生产/cloud 应保证 `XPOD_INNGEST_BASE_URL` 指向可用的 Inngest service，并提供显式 event/signing key。

集群模型:

```text
xpod-api replicas
  -> XPOD_INNGEST_BASE_URL
  -> xpod-inngest service
     -> shared Inngest Postgres / Redis

xpod-inngest
  -> {apiBaseUrl}/api/inngest
  -> /api/inngest on xpod-api service/LB

Pod
  -> Run / RunStep / Thread / Message / Task source of truth
```

即使 Inngest 负责队列、retry 和 concurrency，xpod 的 Run worker 入口仍要做原子 claim/lease: 已完成或已被其它 replica claim 的 Run 必须 no-op。

## Runner 选择

Agent endpoint 的协议边界可以统一成 `RunnerAdapter`，第一版默认走 pi adapter。原因:

- pi 的 `AgentSession / SessionManager / createAgentSession` 是公开导出的，可以作为 `PiRunnerAdapter` 内部 engine 使用。
- pi 已经提供工具、模型调用、事件流、prompt/resource loading 等原子 runtime 能力，xpod 不应重写这些。
- ACP 是协议 adapter，第一阶段兼容 `codex` 和 `codebuddy/cc` runner；如果 `claude` runner 过重，可以暂缓。
- 但 pi 的 `SessionManager` 是 JSONL session tree，默认写本地 `.pi/agent/sessions`，不能成为 xpod 的状态中心。

第一阶段明确兼容三条执行线:

- `pi`: 默认 Agent Runtime engine，直接从 Pod `Run/Thread/Message/Agent Profile` 恢复状态。
- `codex`: ACP runner，通过 `CodexRuntimeProjector` 把同一套 Agent Profile 投影成 Codex 本地配置。
- `cc` / `codebuddy`: CodeBuddy 兼容路径，走 ACP runner 或已有 SDK adapter。

runner 数量不是核心；核心是 `Run` 和 Pod 状态边界先正确。

## 推荐数据边界

```text
Chat
Task

Thread
  owner?: URI -> Chat | Task       # 后续泛化项，当前 Chat thread 仍按 chat 容器组织
  workspace: URI -> Container
  metadata.runtime?: runtime config snapshot

Message
  thread: URI -> Thread
  maker: URI
  role/content/status/richContent

Run
  task?: URI -> Task
  thread: URI -> Thread
  workspace: URI -> Container
  runner: pi adapter id / ACP runner id
  status: queued | running | waiting_input | completed | failed | cancelled
  scheduledAt?: datetime
  nextAttemptAt?: datetime
  attempt?: number
  leaseOwner?: string
  leaseExpiresAt?: datetime
  heartbeatAt?: datetime
  cancelRequestedAt?: datetime
  externalRunId?: string   # Inngest function run id / pi session id / other backend trace id

RunStep
  run: resource -> Run
  type: status | output | tool_call | tool_result | auth_required | steer | error
  payload: JSON
```

`ownerType` 不需要在每个对象重复。若后续泛化 `Thread.owner`，使用资源关系归属即可；下游对象跟着 `thread` 或 `run` 走。`workspace` 是边关系，不是 metadata，也不是 TS 类型层面的重点。

## ChatKit Task 命名

ChatKit 里的 `TaskItem` 不是 xpod 的持久 `Task` 资源。它更像聊天协议里的进度块或 UI projection:

- 如果只是 message 下的执行进度，映射到 `RunStep / Step / richContent`。
- 如果是用户提交的任务式命令，才创建 xpod `Task`。

## Symphony 边界

Symphony 是更上层的 multiple agents 编排实现。它可以建立在 xpod 的前两层之上:

```text
Symphony
  -> creates Tasks
  -> starts Runs
  -> watches RunSteps/Messages
  -> sends steer Messages
  -> reviews results
```

LinX 里已有 `Issue / Delivery / Session` 的 Symphony MVP。xpod 第一阶段不复制这套模型:

- `Issue`: LinX 产品层工作项。
- `Delivery`: 上层投递/projection 信封。
- `Session`: LinX runtime 生命周期命名，可映射到 xpod `Run`。

等 xpod 的 Chat/Task command surface 和 Agent Runtime 稳定后，Symphony 再作为编排层对接。

## 第一阶段落地顺序

1. 清理 xpod CLI agent mode，只保留运维命令。
2. `xpod login` 回到 Solid/xpod 登录和 client credentials 建立语义。
3. 已引入 `RunStateCenter` 作为 Chat 与 runner 中间层；ChatKit 只做协议投影。
4. 已补 `RunStore / RunStep` RDF schema，并把 Chat runtime output、tool/auth/error 等事件 append 到 Pod。
5. 已定义 `RunExecutionBackend` 并接入 Inngest 边界；inline execution 保持 Chat SSE 低延迟，store-backed worker 支持 durable function 从 Pod 恢复执行。
6. 已新增内部 Task command service: 创建 Task、启动 Run、通过 Task thread 观察和 steer；Task 暂不暴露公共 REST API。
7. 已新增 Task materializer: one-shot 立即生成 Run，scheduled/triggered Task 通过 Inngest scheduler 生成 Run。
8. 已实现 Inngest function/worker 路径 `xpod/run.requested`: claim Run、从 Pod 恢复 Run/Thread/Message 状态、调用 `PiAgentRuntimeDriver`、写 RunStep/Message，并处理重复 callback 与 cancel。

## 暂缓事项

- 不实现 Symphony 多 agent 编排。
- 不引入 Inngest 作为 Pod 模型 owner；Inngest 只是执行后端。
- 不把 pi `SessionManager` 作为 xpod source of truth；pi 只能作为 runner adapter 内部实现。
- 不把 AI provider OAuth 放在 `xpod login`。
- 不在第一阶段做专用 Run steer REST endpoint；ChatKit tool output/消息已能作为当前 steer surface。
