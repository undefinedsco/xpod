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

本决定否决了"依赖某 provider 私有特性来加速"的一类方案；性能优化必须在通用机制内完成：

- 减少**调用次数**（批量登记序号、批量查回执），而不是更换存储位置；
- 授权判定复用（见下）；
- 不引入 provider 分支。

## 游标与去重也必须可移植

### 现在有什么

SQL journal 在身份库里建了两张表（`SqlMatrixEventJournal`，两个部署都是同一张表）：

```
xpod_matrix_transactions   -- 回执：(scope, transaction_key) → event_id, created_at, content_hash
xpod_matrix_events         -- 序号：BIGSERIAL sequence + UNIQUE(scope, room_id, event_id)
```

**这两样都不是会话事实**：正文、成员、授权、Delivery、Run 都在 Pod。但它们用到的
恰恰是 provider 私有原语：

- `sequence BIGSERIAL PRIMARY KEY` 是 PostgreSQL 专有分配器（SQLite 走
  `INTEGER PRIMARY KEY AUTOINCREMENT` 分支，代码里由 `sql.raw` 选择）；
- 新事件登记要 `LOCK TABLE xpod_matrix_events IN SHARE ROW EXCLUSIVE MODE` 并持有到提交。

也就是说：数据侧立了可移植性规则，机制侧却开了豁免——而机制恰恰是换 provider 时最先碎的部分。

### 这把锁为什么存在

它保护一条硬不变量：**读到高水位 N 时，所有 ≤ N 的序号必须已提交**（否则被跳过的事件
永远不会出现在任何一页）。而 `BIGSERIAL` 在事务提交前就分配了值，默认隔离级别是
read committed，于是并发下可能出现"A 拿 7 未提交、B 拿 8 先提交"，读者推进到 8 就
永久跳过 7。表锁把写入串行化到提交，保证分配顺序 = 提交顺序。

代价是**锁的粒度是整表，而表里是所有 Pod 的事件**：任一 Pod 登记新事件都要等其他 Pod
的事务提交；某个租户首次同步大历史会和另一个租户的新消息互相排队。这就是复审 P2 里
"跨 Pod 争用同一表锁"的由来。

### 与 Matrix 规范的关系

规范对这两件事的要求比我们实现的更宽：

- `/sync` 的 `since` 是**不透明 token**，客户端不得解析。规范没有要求它必须是全局单调
  序号——`v2_<seq>` 是我们自选的形状。
- `txnId` 的幂等范围是 `(user, device)`，规范只要求同一设备重发幂等，没有要求持久化一张回执表。

所以这两张表是在满足**我们自己发明的要求**，不是 Matrix 的要求。

### 决定：两者都改用 Pod 内的可移植表达

1. **去重**：`eventId` 取确定性值 `hash(scope, device, txnId)`，写入用
   `If-None-Match: *` 的原子创建。首次成功、重放一律 412，txnId 语义由写协议本身保证。
2. **游标**：把位置放进 Pod（每 Pod 一个单调位置资源），推进用 `If-Match: <etag>` 的
   compare-and-swap；`v2_<seq>` 的对外语义不变，仍是 per-Pod 顺序。
3. **删除** `xpod_matrix_transactions`、`xpod_matrix_events`、相关索引、建表用的
   advisory lock 与那把表锁。P2 随之消失。
4. 旧 `v2_` 游标继续按既有约定返回 `M_UNKNOWN_POS`，客户端重新同步（见设计文档的兼容性章节）。

### 实测前提（2026-09-24，真实 Local 栈 + DPoP + ACL）

| 场景 | 结果 |
| --- | --- |
| `PATCH` + `If-None-Match: *`，文档不存在 | 201 |
| 同一条 `PATCH` + `If-None-Match: *` 重放 | 412 |
| `PATCH` + `If-Match: <当前 etag>` | 205 |
| `PATCH` + `If-Match: <过期 etag>` | 412 |
| `HEAD` / `GET` 取 ETag | 200，形如 `"1790272036000-text/turtle"` |

代码侧一致：CSS 的 `BasicConditionsParser` 按 RFC7232 解析 `If-Match`/`If-None-Match`
并交给 store 判定；Xpod 的 ORM 自己就在用这套（412 后重取 ETag 重试）。

### 实现约束（已确认，施工时必须处理）

1. **ORM 的自动 412 重试会破坏 CAS**：`ComunicaSPARQLExecutor` 在 412 时会重取 ETag
   并重发整条 PATCH；对盲写无害，对"值 + n"会变成丢更新。位置资源的推进必须**直接发
   HTTP**，即显式豁免"优先 drizzle-solid"，理由与范围要写在实现处。
2. **写入响应不返回 ETag**，必须额外一次 `HEAD` 才能拿到 ETag ⇒ 一次 CAS 是
   读 + 写 + HEAD；可用本地 etag 缓存省掉 HEAD，但要接受缓存过期时的一次重试。
3. **执行身份的写权限未验证**：位置资源放在 Pod 内，需确认 executor 身份（而非只有
   Pod owner）能写它。

### 尚未决定

- 位置资源的路径与形态（每 Pod 一个资源还是一个容器）；
- 旧数据的迁移：是否需要在首次使用时为既有房间补建位置资源；
- 位置资源损坏或缺失时的恢复路径（重建或拒绝服务）。

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
