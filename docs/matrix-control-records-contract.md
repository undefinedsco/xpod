# Matrix 控制记录契约（草案）

更新：2026-09-27。状态：**草案，待评审**。登记册里的两条待细化事项——「可恢复事务」与「协议服务身份与 Pod
归属」中剩余的授权部分——需要先有契约再动代码，本文就是那份契约。**本文不重新讨论**存不存 Pod、要不要跨 Pod、
共享 schema 是否归 models（见[决策登记册](matrix-collaboration-decisions.md)的状态规则）。

## 1. 什么算控制记录

控制记录是**按 key 点查的运维事实**，不属于任何一条消息或某一个房间实体，因此无法"随实体而生"：

| 记录 | key | 为什么需要 |
| --- | --- | --- |
| 入站事务存档 | `(scope, origin, txnId)` | 对端重试要拿到**首次**响应；载荷不同不得覆盖首次结果 |
| 出站投递批次与进度 | `(scope, origin, destination, txnId)` | 重启后未送达的事件不能凭空消失（"仅凭 Pod 恢复"） |

**判据（用户 2026-09-27 的 metadata 澄清）**：随实体而生的控制事实（事件本体、某个房间的投递水位）写进该实体的
`metadata.protocols.matrix` 即可，**不需要 models 声明**；上表两条是**自由存在**的记录，需要一个可寻址的资源去
承载——这一步是 models 的 schema 决定，不是"声明 metadata 键"。

## 2. 共同要求

1. **点查，不扫描**：按 `(scope, key)` 取一条，读成本与记录总数无关。扫描会随房间数/历史增长，等于把
   "有界"这条验收门禁作废。落地形态是"一个 key 一个文档"，点查就是按 URL 读那个文档（`controlRecordAddress`）。
2. **原子预留**：`reserve` 必须只有一个赢家（接口已写明"Pod 实现必须让这一步原子"）。仅靠"先查再写"在并发重试下
   会让同一笔事务被处理两次。**机制在 §6.1 定了**：唯一赢家由服务端对 create-once（`If-None-Match: *`）裁决，
   因此一条记录一个文档，而不是"一张表 + 唯一索引"（这个存储上 `If-Match` 不是版本检查，唯一索引也表达不出来）。
3. **不透明 metadata**：记录自身的字段放进 metadata，不要求 models 为每个 Matrix 字段建列；models 只需提供
   keyed 资源与 `createdAt`/`updatedAt` 两个时间戳（回收要用）。**key 的唯一性不靠 models**：它由"文档名 = key 的
   哈希 + create-once"保证（§6.1）。
4. **保留与回收**：事务存档必须回收，但**回收不得把"未知结果"变成"可重放"**——回收后同一 `txnId` 会被当成新事务
   重新处理。因此回收期必须**长于对端的最长重试窗口**，或在回收时留一条**墓碑**（只留 key 与"已处理过"）。
   取值待定（见 §5）。
5. **可重建**：内存实现是缓存，Pod 记录是权威。启动时从 Pod 恢复；**本地状态可以丢，记录不能丢**。
6. **scope 隔离**：记录按 Pod（scope）分片，一个 Pod 的记录不可见/不可写于另一个 Pod；读取用与入站写入同一份
   部署侧授权（见 §4）。

## 3. 两条记录的具体语义

### 3.1 入站事务存档

字段：`origin`、`transactionId`、`payloadFingerprint`（规范化 JSON 的指纹，键序无关）、`receivedAt`、
`completedAt?`、`response?`（每条 PDU 的应答原样保留）、`conflictAt?`、`status`
（用 `taskResource` 的取值：`active` = 已预留未回执，`completed` = 已回执）。

- `reserve`：不存在则写入 `reserved` 并返回 `created: true`；已存在则返回既有记录、`created: false`，且**载荷指纹
  不同**时只打 `conflictAt` 标记，**不覆盖**首次记录。
- `complete`：写入首次应答与 `completedAt`。此后任何重放**直接返回首次应答**，不再处理。
- `release`：处理中途失败（写 Pod 失败、记录响应失败）时**删掉这次预留**，让对端重试能重跑。释放安全的前提是
  **接受一条事件按 event id 幂等**（已落地），因此重跑不会写第二遍。
- `reserved` 且未完成 → 回 `503 M_UNKNOWN`（"正在处理中，请重试"），这是并发重放唯一的合法答案。

### 3.2 出站投递批次与进度

字段：`origin`、`destination`、`txnId`、`pdus`（**载荷必须留**，否则重启后无法重发）、`edus?`、`createdAt`、
`attempts`、`notBefore?`、`lastReason?`、`status`（`pending`/`delivered`/`abandoned`）。

- **批次必须落 Pod**：只落"水位/进度"救不回队列——队列里那批**尚未发出**的事件本身就是记录的内容。
- 队列语义不变：每个 `(origin, destination)` 一条严格有序队列；**只能往从未尝试过的批次追加**；拒绝后换新 `txnId`
  重试；退避中的批次不阻塞后续。
- 与实体的关系：**进度**（某个房间已投递到哪个事件）可以写进房间实体的 metadata（随实体而生，不需声明）；
  **批次**属于本表。

## 4. 授权：谁读写这些记录

- 读写的**主体是部署**，不是用户会话：用参与者在该 Pod 上的**任务层 grant**（`TaskCredentialStore` 按
  `(owner, issuer)` 幂等登记，用户通过 Pod interface key 授予）。
- **没有 grant 就失败，且要说清楚**：入站写入回 `403 M_FORBIDDEN` 并点名是哪个参与者的 Pod（已落地，不再冒成
  500）；控制记录的读写同样如此，**不退回用户会话、不退回部署自持 key**。
- **不落别人的 Pod**：没有授权时，收到的事件不写进任何 Pod；对端拿到的是拒绝，不是"写进了某个地方"。

## 5. 待定项（需要决定后才动 models）

1. ~~**models 提供什么**~~ **已解决**：不新建表，用已有的 `taskResource`（见 §6）。
2. **回收策略**：保留期（建议长于对端最长重试窗口，例如 24h）与条数上限；是否需要墓碑。
   现在每条记录是一个独立文档，回收就是删文档；**但墓碑问题仍在**：删掉回执后同一 `txnId` 会被当成新事务重跑
   （按 event id 幂等，所以不会写第二遍，但会重新处理并可能给出不同应答）。在定之前**不做任何自动回收**。
3. **同步游标**是否也纳入控制记录（当前游标是编码在 token 里的，可重建）。
4. **grant 索取流程**：在什么时机问参与者（第一次 provision 时 / 第一次进房间时）、界面上如何表达
   "让这个部署替你写收到的消息"、撤销后是否立即失效（当前行为：立即失效，写失败即 403）。

## 6. 承载已定：用 `taskResource`，原子性已实测（2026-09-27 更新）

models 里已经有那张表，**不需要新建**：`taskResource`（`src/task.schema.ts`，已从 index 导出）是
`id: 'index.ttl#{key}'` 的 **keyed** 资源（点查），带 `status`（open/ready/active/blocked/completed/failed/
cancelled）、不透明 `metadata`、`createdAt`/`updatedAt`；它自己的注释就是"**durable executable work unit**：说该做什么，
不管调度/runner/执行尝试"。映射：

| 控制记录 | 承载 | 说明 |
| --- | --- | --- |
| 出站投递批次 | 一条 `taskResource` | 要做什么 = 把这批 PDU 发给那个 server；`metadata` 带 origin/destination/txnId/pdus/attempts/lastReason；status 走 open→completed/failed/cancelled |
| 入站事务存档 | 一条 `taskResource` | 回执：`metadata` 带 origin/txnId/fingerprint/首次应答；status 走 active（已预留）→ completed（已回执） |

**`scope → Db` 怎么解**（原"实现前必须定的一件事"）：采用**方案 ①**，已落地。外壳（`FederationHandler.targetFor`）
把**已经解好的句柄**（`{ scope, write: { db, fetch } }`，由 `PodMatrixStore.podWriteFor` → `matrixPodWriteFor`
解析一次并记忆在 context 上）随调用传给 store；接口保留 `scope` 仅作分片键与隔离校验
（`PodMatrixInboundTransactionStore.requireHandle`：句柄缺失或 scope 不符即报错，不猜哪个 Pod）。
解析授权这件事只有一处（`src/api/matrix/podAccess.ts`）：调用方会话，或部署以参与者任务层 grant 行事，二者互不兜底。

### 6.1 原子预留：实测推翻了"If-Match 就是 CAS"

在真实部署上实测（`tests/integration/MatrixControlRecords.integration.test.ts` 与当轮探针）：

| 条件 | 结果 | 结论 |
| --- | --- | --- |
| `PATCH` + `If-None-Match: *`，文档不存在 | **201**，文档建立 | create-once 可用 |
| 两个并发 `If-None-Match: *`，同一文档 | **201 + 412** | 唯一赢家由**服务端**裁决（条件与写入在同一把资源锁内） |
| 两个并发 `If-Match: <同一 ETag>` | **205 + 205**，且 ETag 未变 | **`If-Match` 不是版本检查** |

原因在 Pod 的 ETag：CSS `BasicETagHandler` 用 `"<DC.modified 毫秒>-<content type>"`，不是内容哈希。
同一毫秒内的两次写入 ETag 相同，于是过期的条件照样通过——而竞争恰恰发生在同一毫秒。
**因此 `If-Match` 不能承载预留**，`reserve` 的原子性只能来自 create-once。

create-once 是**文档级**的，于是：**一条记录一个文档**。记录 `id` 用 `<sha256(key)>.ttl#self`，
而不是 schema 默认的 `index.ttl#{key}`——一个共享文档只能守住它的第一个 key。
行仍然是 models 任务 base（`/.data/task/`）下的 `taskResource`，**只有布局（`id`）由调用方给**。

> **这一处偏离 schema 默认模板，需要确认。** 备选是保留 `index.ttl`（全部 key 一个文档）并接受
> "预留只是尽力而为"：同一毫秒内的两个赢家都会处理，靠"接受事件按 event id 幂等"兜底，回执可能被后者覆盖。
> 契约 §2.2 要求唯一赢家，因此当前实现选了每记录一文档；若 models 要求统一走默认模板，请指出，改动收敛在
> `controlRecords.ts` 的 `controlRecordAddress` 一个函数里。

### 6.2 同一轮实测出的另外两条（实现必须做，否则释放会永久卡住）

- **SPARQL `PATCH` 建出来的文档，在容器不存在时无法 `DELETE`**：文档能读（HEAD 200），但 `DELETE` 回 **404**
  且文档仍在。于是"释放预留"会让该 key 永远拿不回来。修法：写记录前先条件 `PUT` 容器
  （BasicContainer，`If-None-Match: *`；201 或"已存在"的 409 都算成功）。这一步不做记忆，每次写记录前做一次，
  因为重复 PUT 的代价是一个请求，而记错的代价是一个永久卡住的 key。
- **`db.deleteByResource` 不是"忘掉这条记录"**：它删掉行、留下文档，而下一个 `If-None-Match: *` 仍回 412。
  释放必须删**文档**（与预留同一个单位）。这两条都属于 drizzle-solid 侧的可用性缺口，已记录（见 §7）。

另外：412 之后失败方的第一次读**可能早于赢家写入可见**（实测），因此 412 后做**有界重试**（5 次 × 25ms），
仍读不到就报 500——不假装预留成功，也不把可重试的瞬时状态说成永久损坏。

### 6.3 仍未定

- **回收与墓碑**（§5.2）：现在不自动回收。
- **出站批次**：承载相同（一条 task = 一批 PDU），但队列接口的 `scopes()` 要回答"哪些 Pod 还有待发批次"，
  而"scope → 参与者"正是我们**刻意不记录**的映射；需要一个不依赖该映射的来源（例如由已服务的路由枚举，
  或由房间成员关系推导）。定之前不实现 Pod 版出站 store。
- **grant 的时机与界面**（§5.4）：未定；现在没有 grant 就是 403。

## 7. 与已落地实现的关系

- **入站**：`PodMatrixInboundTransactionStore`（`src/api/matrix/federation/podInboundTransaction.ts`）是**生产承载**，
  容器已按它装配；`InMemoryMatrixInboundTransactionStore` 保留给测试与"没有 Pod 的嵌入方"。
  两者实现同一接口，`reserve/complete/release/find` 都接受同一个可选句柄，内存实现忽略它。
- **出站**：仍是 `InMemoryMatrixOutboundStore`；Pod 版等 §6.3 的 `scopes()` 来源定案。
- `release`（未完成即释放）与"失败按真实状态回答"已落地，是本文 §3.1 的直接实现。
- 服务身份与 Pod 归属（server name 派生、歧义即拒绝）见[服务身份契约](matrix-service-identity-contract.md)与
  `participantRoutes.ts`；本文只覆盖其中"写 Pod 用哪份授权"的部分。

## 8. 记录在案的 drizzle-solid 缺口（2026-09-27）

按仓库规则"绕过前先报告"，本契约用到的两处绕过都记在这里：

1. **无法表达"只在不存在时创建"**：`insert` 走 `INSERT DATA`（集合语义，重复写不报错），
   `insertExactRecordOnce` 是"先查再写"（TOCTOU），SPARQL executor 在 412 之后还会
   `refreshed-etag` → `no-etag` 逐级重试（等于 last-write-wins）。**结果**：控制记录的创建走
   原生条件 `PATCH`（`If-None-Match: *`），SPARQL 文本仍由 drizzle-solid 的 `toSPARQL()` 生成，
   所以 schema 与布局知识仍在 models/drizzle-solid 一侧，绕过的只是"执行器不暴露 412"。
2. **`deleteByResource` 留下空文档**（§6.2）：对"删掉这条记录"的语义来说不够，
   且留下的文档会让 create-once 永远 412。**结果**：释放走文档级 `DELETE`。
