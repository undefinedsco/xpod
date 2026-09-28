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

1. **点查，不扫描**：按 `(scope, key)` 取一条，读成本与记录总数无关。落地形态是**按天分桶**：
   点查 = 直接读那一天的文档里的那一个主体，最多 `CONTROL_RECORD_LOOKBACK_DAYS + 1` 次读（§6.1）。
2. ~~**原子预留**：`reserve` 必须只有一个赢家~~ **已按 §6.3 调整为"写入幂等 + 记录优先"**：入站回执不需要
   唯一赢家（事件 id 由发送方定、接受按 event id 幂等），所以共享文档 + 幂等插入就够了；真正需要唯一赢家的
   本地事件预留由身份库 SQL 的唯一键保证。
3. **不透明 metadata**：记录自身的字段放进 metadata，不要求 models 为每个 Matrix 字段建列；models 提供 keyed
   资源、日期分桶与两个时间戳。**key 的唯一性由主体 IRI 保证**（同一天的文档里一个 key 一个主体，§6.1）。
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
2. **回收策略**：**已由查找窗口回答**（§6.1）：`CONTROL_RECORD_LOOKBACK_DAYS`（2 天）就是保留期——
   窗口外的同一 `txnId` 会被当成新事务重跑（按 event id 幂等，不会写第二遍，但会重新处理并可能给出不同应答）。
   超过窗口的天文档仍在 Pod 里；**物理回收（删旧天文档/条数上限）仍未定**，现在不做。
3. **同步游标**是否也纳入控制记录（当前游标是编码在 token 里的，可重建）。
   **用户口径（2026-09-27）**：服务端不为同步进度记账，恢复由发起方负责——所以游标不进控制记录。
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

### 6.1 布局已定：跟随 models 的"按天累积"约定（2026-09-27 用户指示）

用户 2026-09-27："先进房间，房间里面再安装时间分 message 吧"——即 **models 已有的约定**：
`src/message.schema.ts` 的 `{parent.dir}/{yyyy}/{MM}/{dd}/messages.ttl#{key}`（deliveries 同形）。
控制记录是同一类东西，于是落在 models 的 task base + models 的日期分桶里：

```
<pod>/.data/task/{yyyy}/{MM}/{dd}/<key 的 sha256>.ttl#self
```

**一天一个目录，一条记录一个文档**。文档名用哈希是因为一半的键由对端给（事务 id 是任意字符串），
且同一天里两个键必须分得开。

**为什么不是"一天一个文档、多条记录"（2026-09-27 真实 Pod 实测）**：drizzle-solid 把 `object` 列
（这里就是 `metadata`）写成**自己的主体**，而这个主体是按行在文档里的位置推出的（`<文档>#metadata-1`），
不是按行的身份推的。于是同一文档里的两行会把 `metadata` 写到**同一个主体**上、三元组合并——
实测把一条入站回执和一条出站批次读成了**同一条记录**，`kind` 变成
`["inbound-transaction","outbound-batch"]`。一条记录一个文档让每个嵌套主体都是自己的。
日期目录仍然是这个布局要的东西：**目录是真容器**，客户端可以列它（并订阅它）来发现当天有哪些记录
（见下条）。

查找是**有界的**：从今天往回最多 `CONTROL_RECORD_LOOKBACK_DAYS`（2）天，最多三次文档读；
**这个窗口就是保留期**——超窗的重放会被当成新事务（安全：接受事件按 event id 幂等；代价：回执重写一份）。

**日期目录必须真的存在**（`ensureDayContainers`，逐层条件 `PUT` BasicContainer，201/409 都算成功）：
实测把一个文档写进 `.data/task/2026/09/28/` 后，文档本身按 URL 读得到，但 `GET 2026/` 与
`GET 2026/09/28/` 都回 **404**——因为**没有任何东西创建过这些容器**。没有容器就没有 `ldp:contains`，
客户端既列不到、也订阅不到（这正是用户口径"客户端自己负责同步"所依赖的能力）。

### 6.2 实测记录：为什么这里没有 compare-and-swap

同一批实测（真实部署，2026-09-27），结论保留下来当"别再踩"的说明：

| 条件 | 结果 | 结论 |
| --- | --- | --- |
| `If-Match: <同一 ETag>` 并发两次 | **205 + 205**，ETag 未变 | **`If-Match` 不是版本检查**（ETag = `DC.modified` 毫秒 + content type）→ 它守不住任何东西 |
| `If-None-Match: *`（文档不存在） | 201；两个并发 → **201 + 412** | create-once **是**可靠的，但它是**文档级**的 |
| `PATCH` 建出的文档在容器不存在时 `DELETE` | 404，文档仍在 | 只在"要删文档"的方案里才是问题 |
| `db.deleteByResource` 之后 | 行没了、文档仍在 | 同上 |

create-once 需要"一个 key 一个文档 + `If-None-Match: *`"才能按 key 守门；这里**不做 CAS**，
因为入站回执不需要唯一赢家（§6.3）。布局上仍然是"一条记录一个文档"，但理由不是 create-once，
而是 §6.1 实测的嵌套主体合并。上面两条"删文档"的坑因此也不适用：这个方案**从不删文档**，
释放只删记录自己的三元组（留下一个空文档，见 §8 第 2 条）。

### 6.3 "判赢家"到底为了什么，以及这里为什么不要它（2026-09-27）

`reserve` 的"唯一赢家"不是在争"谁有资格写"，而是在保证**同一笔事务只有一个结果**。它服务两处，
强度完全不同：

1. **本地写入的事件预留**（客户端 `PUT …/send/{txnId}` 重放）：**必须有唯一赢家**。事件 id 由内容推导，
   内容里含 `origin_server_ts` 与 `prev_events`，两次并发处理会推出**两个不同的事件**——客户端一次发送
   变成两条消息。**这部分的原子性由身份库 SQL 的唯一键提供**（`PRIMARY KEY (scope, transaction_key)`），
   不在 Pod 承载里。
2. **入站事务回执**：**不需要**。事件 id 由发送方定，接收方只校验+落库，接受按 event id 幂等 →
   两个赢家的**数据后果为零**。要守的只有"重放答首次应答"，而"写入幂等 + 读记录"就够了。

**已按此实现**（2026-09-27）：`writeControlRecord` 是"读、无则插、返回记录"，**不是** CAS；
`created: true` 只表示"这次调用写了它"，并发下两个调用者都可能拿到 `true`——而 Pod 里只有**一条**记录
（同一主体重复插入是集合语义）。**代价写在这里**：并发重放会重复校验（成本，不是正确性）；若房间状态在两次
处理之间变化导致应答不同，回执里留下的是**最后写入的那份**，而不是严格"首次应答"。

### 6.4 仍未定

- **物理回收**：超窗的天文档仍在 Pod 里，删旧文档/条数上限未定（逻辑保留期见 §6.1）。
- **grant 的时机与界面**（§5.4）：未定；现在没有 grant 就是 403。

## 7. 与已落地实现的关系

- **入站**：`PodMatrixInboundTransactionStore`（`src/api/matrix/federation/podInboundTransaction.ts`）是**生产承载**，
  容器已按它装配；`InMemoryMatrixInboundTransactionStore` 保留给测试与"没有 Pod 的嵌入方"。
  两者实现同一接口，`reserve/complete/release/find` 都接受同一个可选句柄，内存实现忽略它。
- **出站**：`PodMatrixOutboundStore` 是生产承载（容器已装配，§9.2）；`InMemoryMatrixOutboundStore` 保留给
  测试与"没有 Pod 的嵌入方"`。
- `release`（未完成即释放）与"失败按真实状态回答"已落地，是本文 §3.1 的直接实现。
- 服务身份与 Pod 归属（server name 派生、歧义即拒绝）见[服务身份契约](matrix-service-identity-contract.md)与
  `participantRoutes.ts`；本文只覆盖其中"写 Pod 用哪份授权"的部分。

## 8. 记录在案的 drizzle-solid / Pod 缺口（2026-09-27）

按仓库规则"绕过前先报告"。**当前实现不绕过 drizzle-solid**——控制记录的读写全部走 ORM
（`insert(...).values(...).execute()` / `findByResource` / `updateByResource` / `deleteByResource`），
加上一次显式的容器 `PUT`（Solid 协议操作，不是绕过）。三条按严重程度排：

1. **同一个文档里的两行会合并 `object` 列（最严重，实测）**：`object` 列（这里是 `metadata`）被写成
   自己的主体，主体名按行在文档中的位置推出（`<文档>#metadata-1`）而不是按行身份。于是同文档两行的
   `metadata` 写进**同一个主体**、三元组合并——实测把一条入站回执与一条出站批次读成了同一条记录
   （`kind` 成了 `["inbound-transaction","outbound-batch"]`）。**规避**：一条记录一个文档（§6.1）。
   期望的修法是嵌套主体按行身份命名（例如 `<行主体>-metadata`）。
2. **`deleteByResource` 只删行、留下（可能为空的）文档**：文档是"一条记录一个文档"时，释放会留下一个
   空文档；它仍出现在日期目录的 `ldp:contains` 里，读它得到空表示。**暂时接受**：不影响正确性
   （再写同一个 key 会重新长出记录）。`deleteResourceWithDocument` 是现成的"连文档一起删"的 ORM 入口，
   需要时改用它。
3. **无法表达"只在不存在时创建"**：`insert` 走 `INSERT DATA`（集合语义，重复写不报错），
   `insertExactRecordOnce` 是"先查再写"（TOCTOU），SPARQL executor 在 412 之后还会
   `refreshed-etag` → `no-etag` 逐级重试（等于 last-write-wins）。**曾经**因此用原生条件 `PATCH`
   （`If-None-Match: *`）做严格预留；现在不需要严格预留（§6.3），只把这条留作能力缺口的记录。

另一条是 **Pod 侧**的（不是 drizzle-solid）：**任何写入者都必须自己创建容器**。SPARQL `PATCH` 可以把
文档写进一个不存在的路径并让它按 URL 可读，但 `GET` 那个路径上的目录会回 404——没有容器就没有
`ldp:contains`，客户端列不到也订阅不到（§6.1 的 `ensureDayContainers` 就是为此）。

## 9. 出站批次的承载（2026-09-27）

### 9.1 已落地：一条批次 = 一条 `taskResource`

`federation/outboundBatches.ts` 是载荷那一半的映射：

- `metadata` 原样保存 `pdus`/`edus`（**签名覆盖内容，重编码就不是同一个事件了**）、`origin`、
  `destination`、`txnId`、`createdAt`、`attempts`、`notBefore`、`lastReason`；`kind: 'outbound-batch'`。
- `status` 一律 `open`：**批次存在就等于"这笔事务还欠着"**。进度（attempts/notBefore/lastReason）不进
  status，因为每次重试都要改 status，而"改"正是两个写入者互相覆盖的来源。
- key = `[origin, destination, txnId]`：txnId 是对端的去重键、队列中途绝不重铸，但同一个 txnId 在
  两个目的 server（或本部署的两个 origin）下不是同一批。
- 解码失败**不跳过**：那是本部署欠对端的事件，队列没有第二份副本，宁可报错（`MatrixError`）。

证据：单元 6 项（含可选字段不臆造默认值、按队列而非仅按 txnId 分键、非批次记录返回 `undefined`、
载荷缺失即报错）；真实 Pod 1 项（带签名的 PDU 与 EDU **原样往返**，换读者读回同一批）。

### 9.2 枚举已定：列目录（并已落地、已接线）

**用户 2026-09-27 的口径**（"client 端自己负责，服务端不用帮他记那些同步"）把这条从"要不要给 models 加列"
改成了"用 Solid 本来就有的能力回答"。落地形态：

- 批次落在同一套日期布局里，**用 kind 前缀与回执分开**：`<day>/outbound-<sha256(key)>.ttl#self`
  （回执是 `<day>/txn-…`）。前缀是**文档名**的一部分，所以列举者拿到容器响应就能筛出要读的那些，
  不必先读一遍再判断。
- `pending(scope)` = 窗口内每天**一次容器列举**（`ldp:contains`，一个请求就拿到全部成员）+ **每条批次一次读**。
  成本随"欠多少"增长，不随 Pod 有多大增长。窗口 7 天（`OUTBOUND_BATCH_LOOKBACK_DAYS`）：批次是对对端的承诺，
  对端下线一周后回来仍应拿到；代价只是每天一次列举。
- `scopes()` 由**部署**回答（已服务的路由派生，不记录）：没有提供者时，store 只回答"被问到过的 scope"，
  这是诚实的答案，而不是假装知道全部。
- `remove` 接收**整条批次**而不是 txnId：载体按文档寻址，必须知道这个 id 属于哪个队列
  （txnId 只在 `(origin, destination)` 内唯一）。

实现：`federation/podOutboundStore.ts`（`PodMatrixOutboundStore`）、`federation/outboundBatches.ts`（载荷映射）、
`controlRecords.ts` 的 `listControlRecords`。**已接进容器**：`createMatrixOutboundDelivery` 接受一个 store，
容器装的就是 Pod 版；`handleFor`（scope → 句柄）由**已服务的路由**派生，并在写入时才解析
（构造期解析会与它服务的 store 成环），`scopes()` 同样来自路由。没有身份、或没有 Pod 登记时 `scopes()` 是空的
——队列空转，而不是写到不确定的地方。

证据：`podOutboundStore.test.ts` 7 项（当天文档与它需要的容器链、按队列过滤与排序、重复忘掉、
跨天可枚举与超窗不可见、**一天只列举一次而不是每条一次**、`scopes()` 两种来源、无授权即 403）；
真实 Pod 1 项（换一个 store 实例靠列目录把欠的批次找回来，删一条后只剩另一条）；
`MatrixOutboundContainer.test.ts` 2 项（容器装的 store 是 Pod 版且 `scopes()` 等于已服务的 Pod 根；
对本部署不服务的 scope 入队被拒）。

### 9.3 曾经走过的弯路（留作记录）

在被"用 Solid 的能力回答"纠正之前，这条线上试过三种枚举，都记在这里以免重走：

1. **整表 `select`**：1 次 SPARQL 查询 + **每行 1 次文档 GET**，成本随表增长（任务系统的任务、回执都在这张表里）。
2. **带过滤的 `select`**：过滤能下推、只读命中行，但需要一个**可查询的判别列**——`kind` 藏在 `metadata`
   对象列里查不到，`status='open'` 又不具选择性。这条引出了"要不要让 models 加列"的问题，用户否掉了这个方向。
3. **容器列成员**：曾被判"不可信"，实际是**测量写错了**（Turtle 逗号列表）；更正后它正是这里的答案。
