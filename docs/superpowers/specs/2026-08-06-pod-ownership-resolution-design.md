# Pod Ownership Resolution 统一设计

日期：2026-08-06

## 背景

AI Connection 本地验收暴露出两个耦合问题：

1. 旧启动入口把裸 SQLite 文件路径直接传给 `getIdentityDatabase()`；该函数只识别带 `sqlite:` 前缀的 SQLite URL，因此错误创建 PostgreSQL 连接。
2. `ScopedPickWebIdHandler` 为筛选 Consent 中可选的 WebID，直接根据 `identityDbUrl` 创建 `PodLookupRepository`。OIDC 处理器因而感知数据库类型，并绕过 CSS 已有的 account、Pod 和 WebID 存储边界。

结果是同一账号通过 CSS Account API 可以看到 Pod，但 Consent 因数据库连接误判而返回空 WebID，错误显示“Create your first storage”。

## 目标

- Local 使用 SQLite 时绝不尝试 PostgreSQL 连接。
- 所有启动入口对数据库配置采用同一规范化规则。
- Consent 不直接打开 SQLite 或 PostgreSQL。
- Pod 是否属于当前账号和当前存储提供方，由一个明确的领域接口判断。
- Local、Cloud 和远端 SP 使用同一授权语义。
- 不通过扫描本地 Pod 文件目录推断所有权。

## 非目标

- 不修改 Pod 内容的文件、RDF 或对象存储布局。
- 不引入新的数据库或第三方依赖。
- 不改变 Solid OIDC、DPoP 或 CSS Account API 的协议。
- 不把 deployment 的 `local | cloud` 概念暴露给 Applet。

## 设计

### 1. 数据库 URL 规范化

建立一个共享的 `normalizeIdentityDatabaseUrl()` 边界，并由新旧启动入口共同调用：

- `sqlite:`、`postgres://`、`postgresql://`、`mysql://` 保持原样。
- 绝对路径和相对文件路径转换为 `sqlite:<absolute-path>`。
- 无法识别且不是明确数据库 URL 的输入立即报配置错误，不再默认尝试 PostgreSQL。

`getIdentityDatabase()` 仍只消费规范化后的数据库 URL。它不负责猜测部署模式，但会对非法裸路径给出明确错误，防止静默连接 PG。

### 2. PodOwnershipResolver

新增领域接口：

```ts
interface PodOwnershipResolver {
  listAccountWebIds(accountId: string): Promise<string[]>;
  resolveOwnedWebIds(input: {
    accountId: string;
    candidateWebIds: string[];
    targetStorageUrl: string;
  }): Promise<Array<{
    webId: string;
    storageUrl: string;
    storageMode?: 'cloud' | 'local' | 'custom';
  }>>;
}
```

接口表达的是授权事实，不暴露数据库、文件路径或部署类型。

### 3. Local/CSS 实现

Local 实现从 CSS 的权威身份存储读取：

- `WebIdStore` 提供 account → WebID links。
- CSS account/Pod 存储提供 account → Pod 和 Pod → WebID 绑定。
- 解析结果必须同时满足：WebID 关联当前账号，Pod 归属于目标 storage root。

底层身份存储当前可以是 SQLite，未来也可以替换；OIDC 处理器不感知实现。Pod 内容目录只属于数据平面，不参与身份判断。

### 4. Cloud 与远端 SP

同一 Xpod/CSS 进程内的 Cloud 使用相同 resolver 语义，底层实现可由 canonical identity repository 支撑。

存在 `provisionCode` 且目标是远端 SP 时，保留 `/provision/webids` 校验：

- provision code 仅决定目标 storage provider 和短期服务授权。
- 远端响应必须同时匹配候选 WebID 与目标 storage root。
- 远端不可达、响应异常或归属不匹配时 fail closed，Consent 不展示该 WebID。

远端校验应封装为 resolver 的另一实现或组合器，不继续散落在 `ScopedPickWebIdHandler`。

### 5. ScopedPickWebIdHandler

处理器只负责 OIDC 流程：

1. 解析当前 account 和 OIDC interaction。
2. 解析目标 storage scope。
3. 调用 `PodOwnershipResolver` 获取可选 WebID。
4. 返回 picker view，或校验用户提交的 WebID 是否在允许集合中。
5. 完成 OIDC interaction。

构造参数移除 `identityDbUrl` 和 `podLookupRepository`，替换为 resolver 注入。处理器不再 import `getIdentityDatabase` 或 `PodLookupRepository`。

## 数据流

```text
OIDC Consent
  -> ScopedPickWebIdHandler
  -> target storage scope
  -> PodOwnershipResolver
       -> local/same-process: CSS identity stores
       -> remote SP: /provision/webids
  -> owned WebID entries
  -> user selection
  -> OIDC interaction completion
```

## 错误处理

- 裸数据库文件路径进入数据库工厂：抛出包含修复建议的配置错误。
- SQLite 文件不可打开：启动失败，不回退 PG。
- 身份存储暂时不可用：记录脱敏错误并 fail closed。
- 当前账号已有 Pod，但 resolver 返回空：记录 account id、目标 origin 和候选数量，不记录 token 或敏感内容。
- 远端 SP 校验失败：不显示未经证实的 WebID。

## 兼容与迁移

- 环境变量名称 `CSS_IDENTITY_DB_URL` 和 `DATABASE_URL` 保持不变。
- 现有 `sqlite:` 和 PostgreSQL URL 行为保持不变。
- 裸路径在启动层自动规范化；直接调用底层数据库工厂的裸路径改为明确失败。
- `PodLookupRepository` 继续服务路由、配额和迁移等控制面场景，但不由 OIDC handler 直接构造。

## 测试与验收

### 单元测试

- 新旧启动入口把相对、绝对 SQLite 路径规范化为 `sqlite:` URL。
- 明确 PostgreSQL URL 保持不变。
- 数据库工厂拒绝未规范化裸路径，且不创建 PG pool。
- resolver 只返回当前账号且属于目标 storage root 的 WebID。
- 外部 WebID、其他账号 WebID、其他 storage provider WebID 均被排除。
- 远端 SP 错误和空响应 fail closed。
- `ScopedPickWebIdHandler` 不依赖数据库实现即可完成 GET/POST。

### 集成测试

- 使用固定 seed 启动 Local Xpod，SQLite 日志中没有 PG migration/connection 尝试。
- Seed account 的 Account API、PodOwnershipResolver 和 Consent 返回相同 Pod/WebID。
- 浏览器登录后 Consent 直接展示已有 WebID，不显示 FirstPodCreator。
- 同一流程完成授权并回到 `/settings/auth/callback`。
- Alice/Bob Pod 隔离仍通过。

### 回归检查

- `bun run build:ts`
- `bun run build:packages`
- OIDC、provision scope、Pod lookup 和 runtime bootstrap 相关测试。
- `bun run test:integration`

## 完成标准

- 本地 seed 账号登录后无需重复创建 Pod。
- Local SQLite 启动期间零次 PostgreSQL 连接尝试。
- Consent 的授权判断不扫描本地目录，也不直接构造数据库 repository。
- Local、Cloud、远端 SP 的 WebID 选择都由统一 resolver 契约覆盖。
