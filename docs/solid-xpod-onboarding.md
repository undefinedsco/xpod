# Solid / Xpod / drizzle-solid / Models 入门

这份文档给刚加入团队的同学建立共同语境。目标不是把 Solid 规范讲完，而是解释我们为什么用 Solid、Xpod 如何落地、`drizzle-solid` 和 `@undefineds.co/models` 分别负责什么，以及开发时哪些规则不能踩。

## 先记住一句话

Xpod 把用户数据放在用户自己的 Pod 里；`@undefineds.co/models` 定义这些数据长什么样；`drizzle-solid` 负责用类似 ORM 的方式读写 Pod；Xpod 负责身份、存储、API、Agent Runtime 和部署。

## Solid 的最小心智模型

Solid 是一套基于 Web 标准的个人数据存储协议。它的核心不是“又一个数据库”，而是把用户数据建模成可以被不同应用共享的 Linked Data。

| 概念 | 含义 | 在我们这里怎么看 |
| --- | --- | --- |
| WebID | 一个 HTTP URI，表示用户、组织或软件代理的身份 | 用户身份主键，通常形如 `https://id.undefineds.co/alice/profile/card#me` |
| WebID Profile | 解引用 WebID 得到的 RDF 文档 | 记录用户名称、OIDC issuer、storage 指针等 |
| Pod | 用户信任的数据空间 | Xpod 托管或本地自托管的用户数据根目录 |
| Resource | Pod 里的资源，可以是 RDF 文档或二进制文件 | `.ttl`、图片、文件、配置、消息、Run 都是资源 |
| Container | 资源目录 | 类似 Web 目录，不是数据库表 |
| RDF / Triple | 用主语、谓语、宾语表达事实 | `<message> foaf:maker <user>` 这种语义关系 |
| Turtle / JSON-LD | RDF 的序列化格式 | 我们多数业务模型落为 `.ttl` |
| Solid-OIDC | Solid 推荐的认证方式 | Xpod login / API 访问的身份基础 |

Solid 的关键价值是：应用不要把用户数据锁死在自己的后端数据库里，而是读写用户授权的 Pod。数据通过 URI 连接，跨应用可解释、可迁移。

继续阅读:

- Solid 项目介绍: https://solidproject.org/about.html
- Solid Protocol: https://solid.github.io/specification/protocol

## Xpod 在 Solid 上做了什么

Xpod 是我们的 Solid Pod 平台和 AI 数据运行环境。它不是单纯的 CSS 包装，也不是只提供文件存储。

当前 Xpod 主要承担这些职责:

| 层 | 职责 |
| --- | --- |
| Gateway | 对外统一入口，转发到 CSS / API |
| CSS | Solid 协议、LDP 资源、OIDC、访问控制、Pod 存储 |
| API | 管理 API、ChatKit/OpenAI 兼容入口、Run API、AI/Agent 相关服务 |
| Storage | RDF 走 Quadstore/Postgres，Binary 走 FS/S3/MinIO，身份和配额走 SQLite/Postgres |
| Agent Runtime | Chat / Task 触发 Run，调用 pi/ACP runner，执行事件写回 Pod |

部署模式上，Xpod 支持:

| 模式 | WebID | 数据存储 | 典型用途 |
| --- | --- | --- | --- |
| Cloud 托管 | Cloud | Cloud | 普通用户开箱即用 |
| Local 自托管 | Cloud | Local | WebID 稳定，数据在用户本地 |
| 完全自托管 | Local | Local | 企业或高级用户 |

细节见:

- [architecture-v2.md](./architecture-v2.md)
- [storage-overview.md](./storage-overview.md)
- [deployment-modes.md](./deployment-modes.md)

## 三个包/项目的边界

### Xpod

Xpod 是运行平台和业务外壳。它负责:

- 启动 CSS/API/Gateway。
- 提供 Solid 登录、Pod 创建、配额、域名、部署能力。
- 暴露 ChatKit / OpenAI compatible / Run 观察等 API。
- 连接 Agent Runtime、Inngest、workspace、sandbox。
- 调用 shared models 读写用户 Pod。

Xpod 不应该重新定义核心 durable model。如果 Chat、Task、Run、AI provider 这类资源已经在 `@undefineds.co/models` 里存在，Xpod 只做 adapter、service、API handler。

### drizzle-solid

`drizzle-solid` 是 Solid Pod 的 ORM 风格访问层。它提供:

- `podTable` / `id` / `string` / `uri` / `datetime` 等 schema builder。
- `drizzle(...)` 创建 Pod database client。
- `db.select().from(resource).where(...)` 这类查询。
- `db.insert(...)`、`db.update(...)`、`db.delete(...)`。
- `findById` / `findByIri` 等 exact resource 操作。
- 把 schema/query 转成 RDF/SPARQL/PATCH/HTTP 操作。

它不是关系数据库 ORM。`uri().link(...)` 是 RDF 资源关系字段构造器，不是 SQL foreign key。查询和写入最终要落到 Pod 资源和 RDF triples。

### @undefineds.co/models

`@undefineds.co/models` 是共享 durable model 包。它负责:

- 核心资源 schema: `chatResource`、`threadResource`、`messageResource`、`taskResource`、`runResource`、`runStepResource`、`aiProviderResource` 等。
- 共享 vocab 和 namespace: `UDFS`、`XPOD_AI`、`XPOD_CREDENTIAL` 等。
- repository/helper: `chatRepository`、`messageRepository`、`threadRepository` 等。
- resource id helper: `messageResourceId`、`runResourceId`、`parentDir` 等。
- 可复用的类型、枚举、序列化工具。

原则：只要是跨 Xpod / LinX / CLI / Desktop / agent profile 共享的数据语义，都应优先进入 models，而不是散落在某个 app 里。

## 开发时的默认调用链

典型业务读写链路应该是:

```text
API / Service / Runtime
  -> import schema/helper from @undefineds.co/models
  -> create drizzle-solid db
  -> db.select / insert / update / findById
  -> Pod resource
```

在 Xpod 内部，如果已经有 CSS `ResourceStore`，可以用 `createResourceStoreFetch(...)` 包成 fetch 给 `drizzle-solid` 使用，避免绕一圈外部 HTTP 和 DPoP。

示意代码:

```ts
import { drizzle, eq } from '@undefineds.co/drizzle-solid';
import { messageResource } from '@undefineds.co/models';

const db = drizzle(fetch, {
  baseUrl: 'https://id.undefineds.co/alice/.data/',
});

const messages = await db
  .select()
  .from(messageResource)
  .where(eq(messageResource.thread, thread));
```

代码里不要手写 Turtle parser 来读共享业务资源。如果 ORM 不能表达需要的查询，优先在 `@undefineds.co/models` 或 `drizzle-solid` 补 repository/helper，并加契约测试。

## Pod 建模规则

共享建模规则以 `@undefineds.co/models` 仓库为准；Xpod 只实现 adapter，不在本仓库维护共享建模规则副本。这里列新人最容易踩的几条，遇到冲突以 models 为准。

### 1. Pod 是图，不是外键表

语义关系用边关系字段:

```ts
message.thread // Thread resource
message.chat   // Chat resource
run.workspace  // Workspace reference
run.task       // Task resource
```

不要让 `xxxId` 暗中承担 RDF link 语义。`xxxId` 只能用于本地查询 ergonomics、协议入参或运行时 key。

### 2. id 是完整 base-relative resource id

现在的 durable `id` 不是 fragment id。

正确:

```text
chat/default/2026/05/18/runs.ttl#run_x
```

错误:

```text
run_x
#run_x
```

如果业务层只有 `run_x`，必须先通过 repository/index 解析成完整 resource id，再调用 `findById`。

### 3. 新代码不要用 locator

业务接口使用:

- `findById`：已有完整 base-relative resource id。
- `findByIri`：已有完整 IRI。
- repository helper：调用方只有业务参数，比如 `{ chatId, threadId }`。

不要新增 `findByLocator` / `updateByLocator` / `deleteByLocator` 用法。locator 是 legacy 兼容面。

### 4. subjectTemplate 不应散落在业务层

新模型优先使用 exact-id 模式：调用方写入完整 `id`，ORM 把它拼到 `base` 后形成 subject。复杂路径和日期分桶的默认生成逻辑应挂在 `id.default(...)` 或 models 的 resource id helper 上，不要让 API 调用方传 `{ yyyy, MM, dd }`。

### 5. Chat 和 Task 并列，Run 是执行流水

当前 durable command model:

```text
Chat     # 交互式命令入口
Task     # 任务式命令入口
Thread   # 观察、steer、上下文线索
Message  # 用户/Agent 可见消息
Run      # 一次 Agent Runtime 执行
RunStep  # Run 的 append-only 执行事实
```

`Task` 不是 `Chat` 的子对象；`Chat` 也不是 workspace。Chat / Task 都会产生 Thread / Message / Run / RunStep。

典型路径:

```text
/.data/chat/{parentKey}/index.ttl#this
/.data/chat/{parentKey}/index.ttl#{threadId}
/.data/chat/{parentKey}/{yyyy}/{MM}/{dd}/messages.ttl#{messageId}
/.data/chat/{parentKey}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}

/.data/task/index.ttl#{taskId}
/.data/task/{parentKey}/index.ttl#{threadId}
/.data/task/{parentKey}/{yyyy}/{MM}/{dd}/messages.ttl#{messageId}
/.data/task/{parentKey}/{yyyy}/{MM}/{dd}/runs.ttl#{runId}
```

详细设计见:

- [task-system-design.md](./task-system-design.md)
- [managed-agents-notes.md](./managed-agents-notes.md)

## Xpod 里常见数据放哪里

| 数据 | 放置位置/模型 | 说明 |
| --- | --- | --- |
| 用户 Profile | WebID Profile / profile model | 身份和 storage 指针 |
| AI Provider 配置 | `aiProviderResource` / `aiConfigResource` | 用户级 AI 配置在 Pod，不放服务端环境变量 |
| Credential 引用 | credential models / auth binding | secret 不写进 Task/Run/Inngest event |
| Chat | `chatResource` | command surface |
| Thread | `threadResource` | 上下文线索 |
| Message | `messageResource` | 可见对话、steer、工具结果摘要 |
| Task | `taskResource` | 任务定义和触发配置 |
| Run | `runResource` | 一次 runtime 执行状态 |
| RunStep | `runStepResource` | 执行事实日志 |
| Agent Profile | agent config models + Markdown files | 人类可编辑指令和机器可查询配置分开 |
| Binary 文件 | Pod binary resource | RDF 只记录 metadata/关系 |

## 加一个新资源时怎么做

推荐流程:

1. 判断是不是共享 durable 语义。
   如果会被 Xpod、LinX、Desktop、CLI、Agent runtime 共同理解，放进 `@undefineds.co/models`。

2. 在 models 里定义 schema、vocab、类型和必要的 repository/helper。
   不要只在 Xpod 里复制一份 `podTable`。

3. 明确 `base`、`id` 生成规则和边关系。
   先回答：这个资源是一文档一个资源，还是 append-heavy 的 fragment resource？

4. 给 repository/helper 写契约测试。
   尤其验证 `id` 回填、边关系、date bucket、ById 精确读写。

5. 发布/升级 models 后，Xpod 只 import 并做 adapter。
   Xpod 本地文件可以保留别名导出，例如 `src/api/chatkit/schema.ts`，但不能重新拥有模型。

6. 如果 `drizzle-solid` 表达不了，应先记录 issue 或补能力。
   临时绕过要隔离在 adapter 层，并在文档/issue 里说明删除条件。

## 什么情况可以不用 Pod

不是所有东西都要进 Pod。

适合进 Pod:

- 用户希望长期保存、迁移、审计或跨端共享的数据。
- 需要被多个客户端或 Agent 共同理解的数据。
- 用户授权边界内的业务事实。

不适合进 Pod:

- 纯 UI 临时状态。
- 进程内缓存。
- 一次请求里的中间变量。
- Inngest 内部队列状态。
- runner 私有调试文件，除非被投影成 RunStep/Message。

## 常见误区

| 误区 | 正确做法 |
| --- | --- |
| 把 Pod 当 SQL 数据库 | 把 Pod 当 Linked Data graph |
| 字段叫 `threadId` 但存的是 Thread resource | 字段叫 `thread`，表达一条关系 |
| `id = run_x` | `id = chat/default/.../runs.ttl#run_x` |
| 为了日期分桶让 API 传 yyyy/MM/dd | repository/id default 生成完整 id |
| 在 Xpod 里重新定义 Chat/Task/Run schema | 去 `@undefineds.co/models` 改 |
| 手写 Turtle parser 读业务数据 | 用 `drizzle-solid` / repository |
| 把 secret 写进 Task 或 Inngest event | Task 只记录 binding/reference |
| 让 Inngest 成为业务事实源 | Inngest 只是 durable delivery，事实在 Pod |

## 新同学入门练习

建议按这个顺序做:

1. 先读 `/Users/ganlu/develop/models/README.md` 和 `/Users/ganlu/develop/models/skills/solid-modeling/SKILL.md`。
2. 找 `src/api/chatkit/schema.ts`，确认 Xpod 如何从 `@undefineds.co/models` 复用 Chat/Thread/Message。
3. 找 `src/api/tasks/schema.ts` 和 `src/api/runs/schema.ts`，理解 Task/Run 的模型边界。
4. 找 `src/api/chatkit/pod-store.ts` 里一处 `db.select()` 或 `db.insert()`，看 ORM 如何落到 Pod。
5. 用测试或本地 Pod 写入一条简单 Message，再用 `findById` 读回来。
6. 尝试解释：为什么 `run_x` 不是 Run 的业务 id？

## 术语速查

| 术语 | 简短解释 |
| --- | --- |
| Pod | 用户数据空间 |
| WebID | 用户/agent 的 HTTP URI 身份 |
| IRI / URI | RDF 里的全局资源标识 |
| base-relative id | 相对某个 base 的完整资源 id |
| fragment id | `#` 后面的局部片段，不等于 durable id |
| subject | RDF 事实的主语，也就是资源被描述的 URI |
| exact-id mode | 完整 `id` 直接决定 subject，不再反解析模板 |
| command surface | 命令来源/归档面，例如 chat/default 或 task/default |
| Run | 一次 Agent Runtime 执行 |
| RunStep | Run 的 append-only 事实日志 |
| models | 共享 durable model 包 |
| drizzle-solid | Solid Pod ORM/查询层 |
