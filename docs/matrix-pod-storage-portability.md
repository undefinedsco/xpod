# Matrix 数据必须走 Pod：多 CSS provider 可移植性约束

日期：2026-09-24。状态：**架构决定**，用于约束后续实现与评审。

## 决定

Matrix 的会话数据（Chat/Thread/Message/Delivery/Run/RunStep）与状态（`m.room.member`、
`co.undefineds.agents`）**必须以 Pod 内的 RDF 资源为权威存储**，且只使用所有 CSS provider
都提供的通用机制：标准 RDF 文档 + SPARQL 读取 + HTTP 写入。

不得为 Matrix 引入只在特定后端可用的存储形态，包括但不限于：SQLite 专用扩展列/表、
依赖 QLever 特有能力的查询、绕过 ORM 的私有索引结构，或把会话事实放进只有本地模式
才有的数据库。

## 为什么

Xpod 要在**所有 CSS provider**上运行同一套 Matrix 能力——本地 SQLite、PostgreSQL、
QLever 后端、以及第三方 CSS 部署。任何"我们这两个后端能跑"的方案，一旦上到别的
provider 就会失效或退化成两套代码路径。

因此判据不是"能不能更快"，而是"**换 provider 之后语义是否不变**"。这决定了：

1. **权威事实放 Pod**：provider 换了，Pod 数据的语义不变；模型定义在
   `@undefineds.co/models`，Xpod 只做 adapter（见 `docs/ai-connections-storage-model.md`
   与 AGENTS 的建模规则）。
2. **读取走 `sparqlEndpoint`**：Message/Thread 声明 `/.data/-/sparql`、Chat 声明
   `/.data/chat/-/sparql`；ORM 的 `ExecutionStrategyFactoryImpl.getStrategy()` 看到 endpoint
   就走服务端 SPARQL，否则退回 LDP。两条路径都是 provider 通用能力。
3. **写入走标准写协议**：当前是 RDF 文档的 PATCH/PUT；不得依赖某个 provider 的私有写语义。

## 这不改变的东西

- SQL journal（`xpod_matrix_transactions` / `xpod_matrix_events`）仍然存在，但它是
  **系统记账**（事务回执、事件引用、游标序号），不是会话事实的权威来源。设计文档的
  "Pod 是权威、SQL 不能替代 Pod 备份"这一条不变。
- 它也不为 SQL journal 争取"可以放任意 provider 私有结构"的许可：journal 只依赖
  关系型数据库的通用能力（唯一约束、事务、`INSERT ... ON CONFLICT`）。

## 对性能讨论的约束

本决定否决了"把去重/游标搬到 Pod 之外的特殊结构、或依赖某个 provider 特性来加速"的
一类方案；性能优化必须在通用机制内完成：

- 减少**调用次数**（批量登记序号、批量查回执），而不是更换存储位置；
- 授权判定复用（见下）；
- 不引入 provider 分支。

## 配套的授权读取优化

授权侧与存储无关，但同样影响 Matrix 写入延迟，已实施（`SubgraphSparqlHttpHandler`）：

- 背景：每次 SPARQL 请求要为 base path 与每个在范围 graph 各做一次判定，而读一份
  ACR 约 80ms；上游 `@solidlab/policy-engine` 的 `ManagedAcpRepository.getRelevantACRs`
  沿祖先链逐个读取，源码自带 `TODO: cache this`，且 CSS 默认 `CachedHandler` 以对象
  同一性为键、实际从不命中。
- 实施：判定结果按 Pod + 主体 + 目标 + 模式缓存，两条失效信号——
  (1) **本 handler 服务的任何成功写入**都递增该 Pod 的世代号；
  (2) **5 秒 TTL 上限**，兜住绕过该 handler 的权限变更。
  未命中一律重新判定（fail-closed）；允许与拒绝都缓存。
- 实测：连续消息写入中位延迟 **1801/2254ms → 918–923ms**（同机隔离栈，同口径），
  回归 `tests/http` + `tests/api/matrix` + `tests/api/reconciler` 242 通过。

## 未覆盖

- 该缓存是**进程内**的；多实例部署下每个实例各自持有，TTL 即最大不一致窗口。
- 没有把 `ObservableResourceStore` 作为失效依赖：它目前只在 `config/cloud.json` 挂载，
  local 没有，押在它身上会让 local 模式的失效静默失灵。
- 未做真实多 provider 一致性验收（同一份 Matrix 会话在 SQLite/PostgreSQL/QLever 后端
  之间的行为对比）。
