# 条件授权资源（ACL/ACR）更新

本文说明 scoped SPARQL 侧车（`/-/sparql`）如何支持**以单个授权资源为写目标的带条件 UPDATE**，
以及它当前能保证什么、不能保证什么。实现见 `src/http/SubgraphSparqlHttpHandler.ts`、
`src/storage/accessors/MixDataAccessor.ts`、`src/storage/AuthorityResourceTracker.ts`。

## 形状

一条被识别的条件授权资源更新必须满足：

- **单一 ACL/ACR 写图**：`writeTargets` 恰好一个，且经 CSS 辅助标识策略判定为辅助授权资源。
- **写图即源文档**：native prepared delta 要求 `graphIri === sourceUri`，且只能写 server-owned Pod 范围内的逐行本地 RDF 文档（`.acl`/`.acr` 已按 `text/turtle` 逐行建模）。
- **定长命名图守卫**：WHERE 中出现的每个 `GRAPH <fixed>`（含嵌套 `FILTER [NOT] EXISTS`）都是明确命名的图；不支持变量 `GRAPH ?g`、默认图读取、`SERVICE`、子查询或 dataset 形式。
- **prepared native authority 必需**：必须注入 `MixDataAccessor`（原生 prepared 写权威），否则 fail-closed，绝不退回到未加锁的 `queryVoid`。
- **共享写锁 + 读依赖必需**：锁必须是带 `withWriteLockAndReadDependencies` 的层级锁（与 `ResourceStore_Locking` 同实例），否则 fail-closed。

不支持的 UPDATE 形状在授权之前拒绝；缺少 native authority 或共享依赖锁则在授权之后、任何写入之前返回 capability 错误（`rdf.sparql.conditional_acl_unsupported`）。

## 授权与控制流

1. **授权在锁外**：进入 store 读 ACL/ACR 会与本次写锁自锁，因此逐图授权（写目标模式 + 固定守卫图的 `Read` + 主体的 `Control`）在加锁前完成。真实 CSS `AuthAuxiliaryReader` 把 `.acl` 映射到**主体资源**的 `Control`：写 ACL 即要求对主体具备 Control。
2. **权限缓存每尝试一份**：`metadataRequestContext` 为每次授权尝试提供新的 `metadataCache`，缓存的拒绝/404 不会跨重试存活。
3. **同一锁计划内提交**：`withWriteLockAndReadDependencies(scope, lockDependencies, commit)` 一次性获取 scope 写锁与授权实际读取到的精确 authority 资源（ACL/ACR、主体图）的读依赖。
4. **提交前复检新鲜度**：`authorityDependenciesFresh(state)` 在任何 mutation 之前比对每个资源的 generation 与 active 状态；任一变化判为 stale，带新缓存重试，且**绝不提交过期授权**。
5. **成功返回 204**：它不是 CAS 响应，不返回 ETag/version，也不在响应体里协商并发。调用方须精确读回确认条件更新是否胜出；权限新鲜度由锁与 generation 快照保护。

### 定长作用域与 native 边界

条件分支的读作用域是有限的：显式固定守卫图 + ACL 写图（`fixedReadAccessScope`），并作为
native delta 校验的 `allowedGraphUrls` 边界传入。因此**授权与提交路径不会枚举整个目录**，无关的私有同级资源不会被读取。

> **限定说明（重要）**：这不等于“整个 HTTP 请求零图扫描”。提交成功后，当生产 usage DB
> 已配置时，`refreshUsage(baseUrl)` 仍会列出/构造图来刷新用量。该配额刷新不在本切片的重构范围内；
> “有限守卫/不 listGraphs”只描述授权与提交路径，不覆盖配额刷新阶段。

## authority generation（目录 fence + 精确资源 fence）

`MixDataAccessor.executeSparqlUpdate` **保留既有的外层 `baseIri` 目录 mutation fence**：
只要 server-owned base IRI 已知且 caller 的 scope 锁已持有，prepare、persist 与 rollback 全部在该
`runMutation(baseIri)` 边界内；**空 delta 也照样运行**这个外层 fence。在此之上，
`writeLocalRdfAuthorityPatches` 对 prepared delta **实际写到的每个精确资源**（`graphIri === sourceUri`，
去重）在任何文件/索引写入之前 `beginMutation`，并在文件、索引、journal 与回滚全部落定后 `endMutation`：

- 外层 `baseIri` 在 prepare、写入与回滚期间保持 active；精确 ACL/ACR 资源从 prepared patch 提交前开始 active，直到文件、索引、journal 与回滚全部落定。
- 未触及的图与无关同级资源不产生**额外精确**版本噪音（目录级 fence 仍会照常 bump base IRI）。
- 空 delta 不注册任何**精确** mutation、不写文件；外层目录 fence 仍然照常运行。

**限制**：`authorityResourceTracker` 是**进程内**的 generation。它不能单独作为多个 CSS 实例共享同一存储时的
fencing；跨进程互斥依赖共享 Redis 锁（`UrlAwareRedisLocker` + 层级锁），而 Redis 锁本身**不提供**跨进程的
permission/authority generation 共享。单个进程的快照也无法感知另一个进程的 mutation。

## 旧 ACL / LocalRecovery 与 Cloud 的差异

- **Local + 启动 Recovery**：本地启动恢复会扫描真实的本地授权文件（含隐藏的 `.acl`），即使索引里没有
  对应行也会保留/重建；`readLocalRdfState` 先读文件，再把 prepared delta 与真实旧 quad 合并。因此本地
  旧 ACL 在 Recovery 之后的条件写入具备前置条件。
- **Cloud 未运行 LocalRecovery**：Cloud 当前没有等价的本地启动恢复。native prepare 发生在
  `readLocalRdfState` 之前，**不会自动导入未索引的旧 ACL 文件**。文件字节被保留，并不证明索引中的
  条件前置是最新的。因此**不得声称任意 Cloud 未索引旧 ACL 的条件写入有保证**；若真实验收失败，应报告
  实际原因并安全地补足 authority readiness，而不是无条件 PUT/复制规则、改条件或新增通用迁移层。

## 覆盖状态与未决项

- 上述“锁定 + generation fence + 有限守卫”已由 prepared-delta 替代夹具的单测/接受测试覆盖；
  这**不代表**真实 QLever / 当前 USER Gateway / 多 CSS 的端到端验收。
- **旧 ACL Recovery + WHERE/reopen 已有独立真实夹具并通过**（root 实际 8 例）：真实文件 + SQLite 恢复后
  旧 ACL 的 WHERE 求值与 reopen、canonical raw typed 歧义（`!sameTerm` guard）、真实 WAC Read/Append/Delete
  与 Control、以及真实两 handler 的“B 在 A 加锁前 revoke 后 A 当前重新授权 403”。它是 **Comunica 协议夹具**，
  **不是**生产 QLever / 当前 USER Gateway / 多 CSS 的证明。
- 不支持的条件 AST 在**授权之前**拒绝；缺 prepared native authority 或缺 shared locker 在**授权之后、写入之前**拒绝。
  成功返回 **204 不是 CAS 胜出**：调用方必须读回校验实际状态。
- 有限守卫/不 listGraphs 只覆盖授权与提交路径；提交成功后当生产 usage DB 已配置时，配额刷新仍可扫描图。

## 配置接线

处理器构造参数 `authStrategy` 使用 CSS `AuxiliaryIdentifierStrategy` 类型与生成参数别名
（`SubgraphSparqlHttpHandler:_authStrategy`）。两个运行时配置组装器——CLI/`start` 路径的
`createCssChildRuntimeConfig` 与公共 SDK `startXpodRuntime` 路径的 `createCssRuntimeConfig`——共用
`conditionalAuthStrategyWiring`：仅在 `acl`/`acp` 模式下把 `urn:solid-server:default:AuthIdentifierStrategy`
按 `@id` 合并到处理器资源上；`allow-all` 组装的是空辅助策略，没有 `AuthIdentifierStrategy`，因此
**省略**该可选参数，而不是留下一个无法实例化的悬空引用。处理器构造参数保持可选，缺失时条件分支不可达——
ACL/ACR 写会被当作普通数据写。

不定义重复的后缀策略，也不新增环境变量开关。`config/xpod.base.json` 的本地 `@context` 声明了规范参数别名，
供各模式组装时使用。`config/cloud.json` 对同一处理器已有一个带宽 `Override`，因此接线采用同 `@id` 的属性合并，
而不是第二个 `Override`（后者会与既有链接冲突）。
