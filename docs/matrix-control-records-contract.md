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
   "有界"这条验收门禁作废。
2. **原子预留**：`reserve` 必须只有一个赢家（接口已写明"Pod 实现必须让这一步原子"）。因此承载表必须有
   **`(owner/scope, kind, key)` 唯一索引**；仅靠"先查再写"在并发重试下会让同一笔事务被处理两次。
3. **不透明 metadata**：记录自身的字段放进 metadata，不要求 models 为每个 Matrix 字段建列；models 只需保证
   key 的唯一性与 `createdAt`/`updatedAt` 两个时间戳（回收要用）。
4. **保留与回收**：事务存档必须回收，但**回收不得把"未知结果"变成"可重放"**——回收后同一 `txnId` 会被当成新事务
   重新处理。因此回收期必须**长于对端的最长重试窗口**，或在回收时留一条**墓碑**（只留 key 与"已处理过"）。
   取值待定（见 §5）。
5. **可重建**：内存实现是缓存，Pod 记录是权威。启动时从 Pod 恢复；**本地状态可以丢，记录不能丢**。
6. **scope 隔离**：记录按 Pod（scope）分片，一个 Pod 的记录不可见/不可写于另一个 Pod；读取用与入站写入同一份
   部署侧授权（见 §4）。

## 3. 两条记录的具体语义

### 3.1 入站事务存档

字段：`origin`、`transactionId`、`payloadFingerprint`（规范化 JSON 的指纹，键序无关）、`receivedAt`、
`completedAt?`、`response?`（每条 PDU 的应答原样保留）、`conflictAt?`、`status`（`reserved`/`completed`）。

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

1. **models 提供什么**：一张按 `(owner, kind, key)` 唯一索引的 keyed 记录表 + 不透明 metadata + 两个时间戳；
   表名/列名与是否复用现有表由 models 决定。**是否接受"一张通用控制记录表"**是第一个要拍的点。
2. **回收策略**：保留期（建议长于对端最长重试窗口，例如 24h）与条数上限；是否需要墓碑。
3. **同步游标**是否也纳入控制记录（当前游标是编码在 token 里的，可重建）。
4. **grant 索取流程**：在什么时机问参与者（第一次 provision 时 / 第一次进房间时）、界面上如何表达
   "让这个部署替你写收到的消息"、撤销后是否立即失效（当前行为：立即失效，写失败即 403）。

## 6.5 承载已定：用 `taskResource`（2026-09-27，用户提问"任务不是有建模吗"）

models 里已经有那张表，**不需要新建**：`taskResource`（`src/task.schema.ts`，已从 index 导出）是
`id: 'index.ttl#{key}'` 的 **keyed** 资源（点查），带 `status`（open/ready/active/blocked/completed/failed/
cancelled）、不透明 `metadata`、`createdAt`/`updatedAt`；它自己的注释就是"**durable executable work unit**：说该做什么，
不管调度/runner/执行尝试"。映射：

| 控制记录 | 承载 | 说明 |
| --- | --- | --- |
| 出站投递批次 | 一条 `taskResource` | 要做什么 = 把这批 PDU 发给那个 server；`metadata` 带 origin/destination/txnId/pdus/attempts/lastReason；status 走 open→completed/failed/cancelled |
| 入站事务存档 | 一条已完成的 `taskResource` | 回执：`metadata` 带 origin/txnId/fingerprint/首次应答；status=completed |

**`scope → Db` 怎么解**（实现前必须定的一件事）：接口按 `scope`（Pod 根）分片，而 Pod 写入需要一个带授权的上下文。
可选：① 由调用方（外壳）把**已经解好的上下文/Db 句柄**传进来（外壳本来就有 `contextFor(route)` 的结果），接口保留
`scope` 仅作分片键与隔离校验；② store 自己持有 `dbFor(scope)` 提供者（容器用 `ownerPodAccess` + 该 Pod 参与者的
WebID 构造）。**推荐 ①**：外壳已经为这次请求解过一次上下文，再解一次等于把同一份授权决定做两遍，而且 ② 需要一个
"scope → 参与者"的全局映射——那正是我们**刻意不记录**的东西（见 `participantRoutes.ts`）。

**唯一未决的能力点**：`reserve` 要"并发只有一个赢家"，而 Pod 写入是整份 `index.ttl` 的读-改-写，因此需要**条件写
（ETag/If-Match）**。没有条件写时：并发重试可能各自处理一次（接受事件按 event id 幂等，不会写出重复事件，但"首次
应答"可能不是同一个）——这一点必须写进实现与文档，不能假装原子。

## 6. 与已落地实现的关系

- 内存实现（`InMemoryMatrixInboundTransactionStore`、`InMemoryMatrixOutboundStore`）是**当前承载**，接口已按
  `scope` 分片、`reserve` 已按原子语义定义，替换实现不需要改调用方。
- `release`（未完成即释放）与"失败按真实状态回答"已落地，是本文 §3.1 的直接实现。
- 服务身份与 Pod 归属（server name 派生、歧义即拒绝）见[服务身份契约](matrix-service-identity-contract.md)与
  `participantRoutes.ts`；本文只覆盖其中"写 Pod 用哪份授权"的部分。
