# 协议兼容与生态集成架构

## 目标

在不放弃 Pod 数据主权的前提下，让 Xpod 可以快速接入外部生态，并尽量降低用户从现有生态迁移到 Xpod 的成本。

这套设计遵循仓库宪法中的三条原则：

1. 优先对接生态，不重复造轮子
2. 优先封装知名协议 API 以降低迁移成本
3. 协议插件作为次一级扩展机制

## 核心判断

Xpod 不应重写外部生态的调度器、队列、重试器和执行内核；Xpod 应该提供：

- 可被外部生态接入的 **协议兼容层**
- 以 Pod 为主的数据存储模型
- 与运行时解耦的产品抽象

一句话概括：

**Pod 是用户资产的 source of truth；生态系统负责 orchestration；Xpod 负责协议兼容与产品语义。**

## 分层模型

### 1. 用户资产层（Pod）

存放用户真正关心、且未来需要迁移的数据：

- 任务定义
- Agent 配置
- Prompt / Tool 配置
- 会话上下文
- 执行产物
- 协议配置

这些数据应优先通过 Pod 读写，且优先使用 `drizzle-solid`。

### 2. 运行时状态层（Infra）

存放执行器内部状态：

- queue item
- lease / lock
- retry counter
- heartbeat
- next run timestamp
- webhook delivery state

这些状态不是用户主数据，不必强塞进 Pod。它们可以位于 Postgres / Redis / 外部编排系统中。

### 3. 协议兼容层（Xpod API）

位于 Xpod API Server，职责是：

- 接收外部协议请求
- 做认证、租户识别、路由
- 读取/写回 Pod 数据
- 在必要时写入运行时状态层
- 向外暴露稳定的产品语义

只有当某协议必须扩展 Solid 请求链或直接介入 CSS 协议语义时，才考虑进入 CSS 体系。

## 协议分级

### 一级：Pod 原生兼容 API

适用于：

- 已形成稳定主流协议
- 迁移价值高
- 与 Pod 资源模型天然贴近
- 长期会成为产品一等能力

设计要求：

- 优先使用该协议原生的路径约定或 `well-known` 机制
- 在 Pod 边界直接暴露兼容 API
- 外部系统可以把 Xpod 当作该协议的一个后端

例子：

- 某类自动化生态约定的 webhook / task / run API
- 某类 AI 生态约定的兼容接口
- 某类协作协议的标准发现入口

### 二级：协议插件

适用于：

- 协议较垂直或实验性强
- 与核心资源模型耦合较弱
- 需要快速验证而不想污染主路径

设计要求：

- 通过前缀路径挂载，如 `/{protocol}/...`
- 插件对外提供协议兼容入口
- 插件内部再映射到 Pod 数据和运行时状态

例子：

- `/matrix/...`
- `/calendar/...`
- `/inbox/...`

## 路由模型

### 一级协议

优先采用协议原生路由：

```text
/.well-known/{protocol}
/v1/{native-api}
/{native-resource-shape}
```

### 二级协议插件

统一挂在协议前缀下：

```text
/{protocol}/...
```

示例：

```text
/matrix/_matrix/client/v3/...
/automation/webhook/{provider}
/openai/v1/responses
```

## 核心组件

### `ProtocolRegistry`

负责管理当前系统已启用的协议适配器。

```ts
export interface ProtocolRegistry {
  register(adapter: ProtocolAdapter): void;
  list(): ProtocolAdapter[];
  match(requestPath: string): ProtocolAdapter | undefined;
}
```

### `ProtocolAdapter`

每个协议由一个 Adapter 表达其能力边界。

```ts
export interface ProtocolAdapter {
  readonly protocol: string;
  readonly mountMode: 'native' | 'prefixed';
  readonly mountPath?: string;

  canHandle(path: string, method: string): boolean;

  authenticate(request: Request): Promise<ProtocolAuthContext>;

  handle(request: Request, context: ProtocolRequestContext): Promise<Response>;
}
```

### `PodProtocolStore`

对协议数据的 Pod 读写做统一抽象。

```ts
export interface PodProtocolStore {
  getConfig(podUrl: string, protocol: string): Promise<unknown>;
  putConfig(podUrl: string, protocol: string, value: unknown): Promise<void>;

  getResource(podUrl: string, protocol: string, key: string): Promise<unknown>;
  putResource(podUrl: string, protocol: string, key: string, value: unknown): Promise<void>;
}
```

建议的 Pod 目录约定：

```text
/settings/protocols/{protocol}.ttl     # 协议配置
/.data/protocols/{protocol}/...        # 协议资产 / 产物 / 缓存
```

### `ProtocolRuntimeStore`

保存不需要进入 Pod 的运行时状态。

```ts
export interface ProtocolRuntimeStore {
  acquireLease(key: string, ttlMs: number): Promise<boolean>;
  releaseLease(key: string): Promise<void>;

  getCursor(protocol: string, podUrl: string): Promise<string | null>;
  setCursor(protocol: string, podUrl: string, cursor: string): Promise<void>;
}
```

首选实现：

- local: SQLite / Postgres
- cloud: Postgres，必要时辅以 Redis

## 数据边界

### 必须放 Pod

- 用户定义的协议配置
- 用户任务与 Agent 定义
- 用户输入输出
- 会话历史
- 协议产物
- 用户可导出、可迁移的业务数据

### 不必放 Pod

- 调度 lease
- retry 计数
- webhook 去重键
- 工作线程 heartbeat
- 短期 cursor / checkpoint

判断标准很简单：

**如果用户将来要导出、迁移、审计它，就优先放 Pod；如果只是执行器为了把事情跑完而临时记住它，就可以放 Infra。**

## 自动化生态的第一版实现

本架构最适合先落在“自动化生态接入”上。

### 产品语义

Xpod 对外提供统一的自动化抽象：

- `Automation`
- `Trigger`
- `Run`
- `Artifact`

但不要求所有生态都直接理解这些概念。外部生态可以继续使用自己的协议和模型，只要最终通过 Adapter 映射到 Xpod 即可。

### Pod 内数据

建议放置：

```text
/settings/automation/agents.ttl
/settings/automation/triggers.ttl
/.data/automation/runs/{runId}/result.json
/.data/automation/runs/{runId}/artifacts/...
```

### 运行时状态

位于 Postgres：

- `automation_trigger_index`
- `automation_run_state`
- `automation_webhook_dedupe`

这些表只保存运行索引，不作为用户资产主存储。

### 触发方式

#### 手动触发

由 Xpod API 直接创建 run，并把 run 状态写入运行时状态层。

#### Webhook 触发

外部系统调用：

```text
POST /automation/webhook/{provider}
```

Xpod 做：

1. 校验 provider 配置
2. 映射到用户 Pod
3. 读取 Pod 中的自动化定义
4. 创建 run
5. 交给 worker 执行

#### 周期触发

不绑定 Kubernetes。

可选实现：

- local：worker 轮询 Postgres 中的 `next_run_at`
- cloud：同样轮询；如果需要，再额外接 CronJob / 外部 scheduler 作为 trigger backend

这保证 local / self-host / cloud 是同一产品抽象，只是底层 trigger backend 不同。

## 协议插件示例：`/matrix/`

如果未来要支持 Matrix，不应先重写 Matrix homeserver，而应先提供一个路径前缀插件：

```text
/matrix/...
```

它的职责是：

- 暴露 Matrix 兼容路由
- 把房间、消息、成员关系映射到 Pod 数据
- 把同步 cursor、事务去重键等写入运行时状态层

这允许我们：

- 先验证协议接入价值
- 不污染 Pod 主路径
- 保持后续可拆卸、可升级

如果未来 Matrix 变成一等能力，再考虑提升为更原生的协议入口。

## 代码落点建议

### API 层

```text
src/api/protocols/
  ProtocolRegistry.ts
  ProtocolAdapter.ts
  ProtocolRequestContext.ts
  PodProtocolStore.ts
  ProtocolRuntimeStore.ts

src/api/protocols/adapters/
  automation/
    AutomationAdapter.ts
    AutomationWebhookHandler.ts
  matrix/
    MatrixAdapter.ts
```

### 共享服务层

```text
src/protocol/
  ProtocolConfigService.ts
  ProtocolMountResolver.ts
  ProtocolArtifactService.ts
```

### 数据访问层

```text
src/storage/protocol/
  DrizzlePodProtocolStore.ts

src/runtime/protocol/
  PostgresProtocolRuntimeStore.ts
  RedisProtocolLeaseStore.ts
```

## 分阶段实施

### Phase 1：打通协议兼容框架

- 增加 `ProtocolRegistry`
- 增加 `ProtocolAdapter` 接口
- 增加 `PodProtocolStore`
- 支持 `native` / `prefixed` 两种挂载模式

### Phase 2：自动化适配器

- 增加 `AutomationAdapter`
- 支持 webhook 触发
- 支持 run 结果写回 Pod
- 支持 local / cloud 共用的 worker 扫描模型

### Phase 3：协议插件机制

- 支持 `/matrix/` 这类前缀协议
- 支持协议配置发现
- 支持协议级能力开关

## 非目标

当前不做：

- 在 Xpod 内重写通用调度器
- 把所有运行时状态都放进 Pod
- 为每个外部生态做深度 Fork
- 把产品能力绑定到 Kubernetes CronJob

## 总结

这套实现的核心不是“Xpod 自己做完所有事”，而是：

- 用 Pod 托住用户资产
- 用兼容协议承接外部生态
- 用插件机制控制扩展边界
- 用可替换的后端承接运行时复杂度

这样既不会失去数据主权，也不会把 Xpod 做成一个封闭孤岛。
