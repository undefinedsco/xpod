# Matrix 协作历史基线与分布式验收门禁

日期：2026-09-23。设计见 [协作契约](matrix-collaboration-design.md)，使用方法见 [可执行样例](examples/matrix-collaboration.md)。下表是首次运行的记录；同一分支上的逐条复跑证据见下文「特性分支复跑记录」。

## 证据定位（2026-09-26 更新）

以下通过数字是 **2026-09-23 单部署、单身份、单 Pod 实现的历史基线**，保留用于回归对照。目标现已明确为 Matrix 分布式房间与事件语义、参与者数据分别持久化到其 Pod，见 [决策登记册](matrix-collaboration-decisions.md)。历史通过项不构成 federation、跨 Pod 持久化或分布式 Agent 执行的验收证据；SQL journal 专项仅证明待迁移旧实现的行为。

Pod 资源 URI 指 Pod 中持久资源的位置，不是浏览器缓存；同一协议事件在不同 Pod 中必须保持同一 event_id，不要求在各参与者 Pod 的持久数据之外额外引入镜像层或映射表。

## 本轮结果

| 验证 | 结果 | 覆盖范围 |
| --- | --- | --- |
| `bun run build:ts` | 通过 | 最终产品代码类型检查 |
| Matrix/队列/Handler/路由/身份/Run/RDF 专项 | 180 通过，7 条环境条件测试跳过（复跑为 185，见下文） | 同时间分页、积压、晚到消息、事务并发、授权撤销、篡改、失败和崩溃恢复、HTTP 输入边界、RDF 对象隔离 |
| 真实 Redis 队列专项 | 10/10 通过，其中 4 项连接真实 Redis | 原子入队、领取、续租、旧租约拒绝，重启/数据清空后的 token 不重用；临时实例已关闭 |
| 真实 PostgreSQL journal 专项 | 空库冷启动 3/3 通过；合并 SQLite 为 9/9 | 12 实例并发初始化/事务预留、提交顺序、连接池重开；仅清理独立 scope 数据 |
| ChatKit 兼容回归及消息关系 | 7/7 通过 | 共享唤醒接口使用持久化 participants；请求伪造名单无效，client-owned/缺少 roster 不唤醒 |
| `bun run test:integration` | 完整命令通过 | lite：153 通过、6 跳过；cluster：45/45 通过 |
| 依赖状态与 `git diff --check` | 通过 | 无新增依赖，无手改 node_modules |

环境条件测试的跳过没有被计为成功；Redis/PostgreSQL 对应能力另行在实际服务上执行并读取了通过结果。

## 特性分支复跑记录（2026-09-23，分支 `codex/matrix-collaboration`）

在独立 git worktree 中按上述门禁逐条复跑。专项集合比首次记录多出 `MatrixPodResolver`、`AgentWakeHandler`、`RunRelations` 与协调者回归，因此通过数由 180 变为 185；跳过仍是同 7 条环境条件。

| 验证 | 复跑结果 | 备注 |
| --- | --- | --- |
| 依赖状态、`bun run build:ts`、`git diff --check` | 通过 | 无依赖漂移，未手改 node_modules |
| Matrix/队列/Handler/路由/身份/Run/RDF 专项 | 185 通过，7 跳过 | 同时间分页、积压、晚到消息、事务并发、授权撤销、篡改、失败与崩溃恢复、HTTP 输入边界、RDF 对象隔离 |
| 真实 Redis 队列专项 | 10/10 通过 | `WAKE_QUEUE_TEST_REDIS_URL` 指向本次临时启动的本机 Redis |
| 真实 PostgreSQL journal 专项 | 3/3 通过 | `XPOD_MATRIX_TEST_POSTGRES_URL` 指向本次临时启动的 PostgreSQL 18.4 空库，12 实例并发初始化 |
| `bun run test:integration` | lite 153 通过、6 跳过；cluster 45/45 通过 | 完整命令 `exit 0`，耗时约 352 秒 |
| 真实 Gateway 协作闭环复跑 | 1/1 通过，约 275 秒（随后两次完整门禁中为 309 秒） | `XPOD_RUN_INTEGRATION_TESTS=true SOLID_ENV_FILE=.test-data/integration/lite.env` 下单独复跑该用例，并随完整门禁再次通过 |

复跑使用的 Redis/PostgreSQL 是本次临时启动的本机实例，只清理自身 scope/namespace 后关闭，不代表生产托管版本的容量结论。真实 Gateway 闭环仍由测试自建的严格认证栈提供证据，未重启或使用常驻 localhost:3000 实例。

### 门禁抖动与处理

前两次完整门禁中该真实 Gateway 用例失败，失败点分别是积压第 21 条消息写入与随后清空 grants 的 state 写入，均为单次请求超出样例固定 120 秒预算。实测本机 Pod 单次写入约 7.5 秒、4 路并发写被串行化；并行跑完整套件时单个请求会被拖到分钟级。处理方式不是放宽事件数量或跳过该用例，而是让样例对可重复步骤按同一幂等语义重试（同 txnId / state key / 租约字段，单步总预算 480 秒），并在完成响应丢失时按 jobId 读取已存储结果；事件数量、交接与 409 断言均未放宽。回归见 `tests/api/matrix/PodMatrixStore.reliability.test.ts` 的「returns the stored event when a client retries after an unanswered write」。

## Matrix HTTP 闭环证据

正常集成开关 `XPOD_RUN_INTEGRATION_TESTS=true` 下，Matrix 测试启动独立 Bun Gateway，明确设置 `open:false`、`authMode:'acp'`，通过 HTTP 创建新账号、Pod 和客户端凭据。匿名 whoami 被拒绝。不会借用共享 open 测试栈的虚拟身份。

测试调用仓库样例，实际验证：

1. 房间与 Agent grants 写入后能够正确读回。
2. 相同发送事务返回同一事件 ID。
3. author runtime 领取、续租、提交助手结果，并显式交给 reviewer。
4. reviewer 获得前置结果并回写第二个助手结果；重复完成返回 409。
5. 每批 4 条并发追加 60 条消息，再以 limit=7 分页，核对原始消息、两个助手结果及积压消息共 **63 个事件的 ID 和正文**。
6. 最终报告断言 `status=passed`、`mode=deterministic-runtime`、`expectedEvents=observedEvents=63`、两份结果和多页同步。

该单项集成耗时约 435 秒，包含夹具与严格授权下的存储访问；不是性能基准，也不能用这个结果宣称生产延迟达标。测试完成后清理独立账号数据目录、证据临时文件与服务进程。可使用样例的 `--output` 在自己的验收环境保留报告。

## 本轮发现并处理的问题

除原审查中的身份、游标、事务去重、成员/Agent 授权和缺少执行闭环外，实际运行还暴露并处理了：

- 同文档对象 metadata 子节点重名，导致多条消息状态混合：使用 ORM 支持的显式子节点 `@id` 隔离，见 [问题记录](issues/drizzle-solid-matrix-metadata.md)。
- 队列重建后 fencing token 复用、失败终态复活、已排队触发未重验当前授权和内容。
- 助手结果已落盘而 Run/Delivery 确认中断：恢复时验证回执并补齐终态。
- PostgreSQL 首次建表的并发 catalog 冲突：初始化使用事务级 advisory lock。
- shared Reconciler 收紧名单后 ChatKit 调用方未提供 roster：改读持久化 Chat.participants。

## 尚不能由本轮证据推导的结论

- 没有重启或验收用户当前常驻的 localhost:3000 实例；这里的 HTTP 证据来自独立测试 Gateway。
- 样例由同一 WebID 下两个确定性执行器运行，没有调用 LLM、真实外部工具，也没有证明独立 executor 身份之间的完整 ACL 隔离。
- 集成存储使用仓库 QLever 测试夹具；不是生产原生 QLever 的专项认证。
- 队列、SQL 和 Pod 不是同一事务。执行保持至少一次；Pod 写入不能宣称受到原子 fencing，外部工具仍需幂等。
- 大历史量、生产并发、网络分区与长时故障恢复仍需单独验收。当前 ORM hydration 成本已记录于 [性能问题](issues/drizzle-solid-matrix-hydration.md)。
- 旧 metadata 碰撞数据、旧 MXID/游标和旧 Redis 队列没有自动修复迁移，按设计文档的迁移边界处理。

## 分支 `codex/matrix-event-primitives` 复跑记录（2026-09-27）

实现内容：协议事件随消息持久化并可仅凭 Pod 验证（内容哈希、reference hash、签名），
事务记录与事件身份对齐。设计落点见[决策登记册](matrix-collaboration-decisions.md)，
字段与排除项的规范依据见[事件哈希与签名 §2.1](reference/matrix-event-hashes-and-signing.md)。

| 验证 | 结果 | 备注 |
| --- | --- | --- |
| 依赖状态、`bun run build:ts`、`bun run typecheck:test`、`git diff --check` | 通过 | 无依赖漂移；分支自身引入的测试类型错误已清零 |
| `./node_modules/.bin/vitest --run tests/api tests/http` | 129 文件通过、11 跳过；1508 用例通过、67 跳过 | 含 `eventIntegrity` 15、`serviceIdentity` 6、`persistedEvent` 4 与并发/崩溃恢复专项 |
| `bun run test:integration` | 完整命令 `exit 0` | lite：30 文件通过、3 跳过，153 用例通过、6 跳过；cluster：4 文件 45/45 通过 |
| 真实 Gateway 协作闭环 | 通过，144.8 秒 | `tests/integration/MatrixCollaboration.integration.test.ts`；63 事件、交接与 409 断言未放宽 |

本轮新增的可验证性证据边界：验证材料（`hashes` / `signatures` / `event_id`）与房间依赖图
（`prev_events` / `auth_events` / `depth`）都随事件持久化，可从单个 Pod 的消息 metadata 独立
复核，且有跨实现依据（内容哈希排除 `event_id`，规则见[房间事件图](reference/matrix-room-event-graph.md)）。
**当时仍未**验证跨部署互操作、也**未**实现状态解析与事件授权规则的执行。**现状（2026-09-27 更正）**：状态解析
（v2，含分叉收敛）与事件授权规则（v11）都已落地并有测试；跨部署互操作已取得**进程内真实 HTTP** 证据（见下文
"两个部署经真实 HTTP 的闭环"），**真实实例证据仍缺**（本机 3000 跑的是别的构建，见"真实实例探测"）。

| 追加验证 | 结果 |
| --- | --- |
| 图与依赖（`tests/api/matrix/protocol/roomGraph.test.ts` 11 项、`persistedEvent.test.ts` 8 项） | 通过：create 为根、链式 depth、auth 选择顺序、极值点 >20 保留最深、分叉合并、无悬挂引用、房间前进后重占预占 |
| `./node_modules/.bin/vitest --run tests/api tests/http` | 130 文件通过、11 跳过；1523 用例通过、67 跳过 |

## 跨部署闭环证据（2026-09-27，分支 `codex/matrix-event-primitives`）

两个**独立部署**参与同一逻辑房间的闭环：各自一个 Pod 数据库、各自签名身份（`alice.example` /
`bob.example`，部署名只是回落）、各自出站队列与入站事务记录。出站请求交给对端
`handleFederationSend`（`PUT /_matrix/federation/v1/send/{txnId}` 的处理体）处理，等价于真实
HTTP 跳转；**唯一的测试替身是"缺依赖事件如何送到对端"**——规范路径是 `/get_missing_events`（未建），
测试按真实部署会做的那样先把房间状态交过去。

| 验证 | 结果 |
| --- | --- |
| `tests/api/matrix/federation/twoDeployment.test.ts` 9 项 | 通过：房间状态与邀请跨 Pod 送达且被授权；Bob 在 B 上加入、其加入事件由 `bob.example` 签名、A 原样保存；Alice 的消息以**相同 event_id** 落到 B；**重放事务返回首次响应且不写第二次**；未服务的目的地 403、未知签名 401、非 JSON 400；缺依赖的 PDU 报 error 且不落库 |
| 对端不可达与恢复（同文件 2 项） | 通过：断网期间的写入**不等投递**（写入返回时对端一条都没有）；整批留在队列里（3 条 PDU 不被拆散）；再次尝试**复用同一 txnId**、`attempts` 递增、`lastReason` 记不可达；恢复后这条事务送达且 3 条消息**恰好一次**、顺序与写入一致、两侧 event_id 集合相同；**队首未被应答时后面的批次不越队**（`deferred` 只提队首），恢复后仍按写入顺序到达 |
| `tests/api/matrix/federation/inboundRoute.test.ts` 8 项 | 通过：接受已知服务器签名的整笔事务并逐条报告、未知密钥拒绝、未服务目的地 403、非 JSON/非对象 400、超 50 PDU 拒绝、body origin 与签名 origin 不一致拒绝、处理中返回可重试 503、事务 id 从路径解析（含 URL 编码） |
| 接收方可见性（`PodMatrixStore.materializeReceivedRoom`） | 通过：收到的事件若属于本 Pod 尚未记录的房间，会**按事件本身**补出房间记录（room id 用对端 id、author 用 create 事件的 sender，**绝不写成 Pod 所有者**），因此邀请在接收方可见、也能被加入 |

对照门禁的现状：

| 门禁 | 现状 |
| --- | --- |
| 两个独立部署、两种身份、两个 Pod | **已取得模块级证据 + 进程内真实 HTTP 证据**（上表；两侧各自在真 socket 上跑入站路由）；TLS/SNI 已由传输层与真实握手测试覆盖；**仍未验证**：真实实例（本机 3000 是别的构建）与 grant 的签发流程 |
| 协议身份一致 | **已取得模块级证据**：同一 room_id 与 event_id 跨两个 Pod 一致，接收副本按推导 id 保存 |
| 传输与落盘恢复 | 部分：**未完成的事务会释放预留**（写失败/记录失败后对端重试即可重跑，已完成的重放仍不重复处理；"正在处理中"的并发重放仍回 503），**Pod 无授权时回 403 并点名是哪个 Pod**；事务重放与去重已证；**逐条拒绝后的重发已落地并端到端验证**（邀请先被拒、依赖到达后自动重发成功）；接收方主动补取（`/event_auth` + `/get_missing_events` 两半）已落地并端到端验证；**出站队列已由调度器驱动、随 API server 启停，并被写入本身触发**（端到端：一次写入无需任何手工 flush 即到达对端 Pod）；**断网与恢复已取得模块级证据**（保序、同 txnId 重试、恢复后恰好一次，见上表）；**仍缺**与真实委派对端的 TLS 握手验证、对端重启后的恢复（接收侧事务存档与投递进度目前是内存实现）、投递记录落控制 Pod |
| 授权与房间状态 | 已证：非法签名、缺依赖、未知 server 被拒（本表 + `inboundPdu` / `authRules` / `stateResolution` 单测） |
| Agent 执行归属 | 未做（待决策） |
| 仅凭 Pod 恢复 | 未做（旧 SQL journal 仍在）。**承载已定**（用户 2026-09-27）：用 models 已有的 `taskResource`（keyed、status、不透明 metadata、两个时间戳）装出站批次与入站事务回执，**不新建表**；**剩余**：`reserve` 的原子性需要 Pod 条件写（ETag/If-Match），回收策略待定（见[控制记录契约](matrix-control-records-contract.md)） |
| 有界同步与权限更新 | **授权判定不跨请求复用已用测试固定**（`agentGrantFreshness.test.ts` 2 项：撤销后下一次调用立即 403、重新授予立即通过；给别人的执行授权不算我们的）； **模块级证据已取得**（见"规模与 Pod 操作数"）：写入/状态/分页与房间数无关；接上变更信号后，空闲 sync 为 **0 次 Pod 读**、单房间变更 **4 次**（原 42 次）；订阅侧与"挂到本部署服务的哪些 Pod"都已落地并有测试（Pod 集合派生自注册表，周期对账，未 watch 的 scope 回 `trust: 'all'`）；**仍缺**在真实部署上重取这些数字与对端方向 |

**本轮发现的两个缺口与处置**：

1. **逐条 error 被当成已投递** —— **已修复**：事务返回 200 不再等于每条 PDU 都被接受，被拒 PDU 换新
   txnId 有界退避重试，用尽次数报 `abandoned`；对端没点名的 PDU 不算被接受；退避中的批次不阻塞队列
   （否则会与"它等的依赖排在后面"死锁）。`twoDeployment.test.ts` 端到端证明：邀请先被拒、依赖到达后
   自动重发并被接受。
2. **依赖顺序** —— **两侧闭环已取得模块级证据**：发送侧同批次内按依赖拓扑排序；接收侧遇到无法授权的
   PDU 时向发送方索取 `/event_auth` 链、按旧到新校验并接受、再重校验原事件（`twoDeployment.test.ts`
   证明：B 自己取回链并接受邀请，event_id 与 A 一致，无测试手工递状态）。**现状**：两个端点的 HTTP 外壳与 Pod
   归属解析都已落地，且这条端到端证据已改成**经 HTTP 调真路由**（不再有测试内直接调用的处理体）。

## 规模与 Pod 操作数（2026-09-27 测量）

门禁要求的是「token 和读取工作量**有界**」。有界的单位在这里是 **Pod 往返次数**（一次 Pod 读是一次
带授权的网络往返）与**读到的行数**，不是 CPU 时间；测量用内存 harness（`db.select`/`db.insert` 计数），
断言写成"10 房间与 200 房间相同"这类相对性质，所以它同时是回归门禁。

| 操作 | Pod 往返 | 读到的行 | 随房间数增长 |
| --- | --- | --- | --- |
| 写一条消息 | 1 select + 1 insert | 仅本房间 | **否**（10 与 200 房间完全相同） |
| 读房间状态 | 1 select | 仅本房间 | **否** |
| `/messages` 一页（limit 5） | 2 selects | ≤16 行（本房间事件） | **否** |
| 增量 sync（只有 1 个房间有新事件） | **2 × (房间数 + 1)**：50 房间 = 102 | **≈ 全量 sync 的行数**（602 vs 600） | **是** |
| 空闲 sync（timeout=1000） | 2 × (房间数 + 1)：20 房间 = 42 | — | **是**，但**不随等待时长增长**（等待循环零读取） |
| 1000 房间 + 2000 事件 | — | — | 堆增量 **9.6 MB** |

结论与边界（都已登记）：

- **写入、状态读、分页是有界的**，与 Pod 里有多少房间无关，也与房间历史长度无关（分页由 limit 约束）。
- **sync 不是有界的**：每趟固定做两次「房间列表 + 每个房间整条时间线」的读取（第一趟是**索引趟**，
  用于发现直接写进 Pod 的原生行；第二趟读数）。因此一趟的成本是 **O(Pod 内事件总数)**，
  而不是"变化的部分"—— 一个房间一条新事件仍要读整个 Pod。
- 把它变成有界需要 **Pod 侧变更信号或索引**（Solid 通知已在本仓库就绪，正是登记册推荐的原生机制），
  或者让房间读取带上可下推的范围（需要 models 侧的可索引字段/分桶规则，属"客户端增量"待办）。
- 注意这是**每个 Pod 的**成本：它随该 Pod 内的房间数增长，不随部署总量增长。

**变更信号接上后的实测（同日，`tests/api/matrix/syncChangeSource.test.ts` 6 项）**：把 `roomChanges`
（由通知订阅驱动的"哪些房间变了"）接进 sync 后，**20 房间**下：

| 场景 | 接入前 | 接入后 |
| --- | --- | --- |
| 已追平的调用者、无任何变更 | 42 次 Pod 读 | **0 次**（不读房间列表也不读时间线） |
| 已追平的调用者、1 个房间变了 | 42 次 | **4 次**（两趟 × (房间列表 + 该房间)） |
| 调用者落后（无 token 或 token 落后于上次索引水位） | 42 次 | 42 次（**故意**：落后的调用者必须拿到它的房间） |
| 来源承认无法完整交代（刚启动/断线） | 42 次 | 42 次 |
| 每 5 分钟一次的全量兜底趟（`roomChangeFullPassMs`，0 = 永不信任来源） | — | 42 次（防止漏掉的变更永久丢失） |

即：**"有界"从"每次调用都要读遍 Pod"变成"只在真的变了时读变了的房间"**，并且通知丢失由周期兜底
覆盖。注意 `settle` 语义：一次 sync 期间到达的变更**不会**被当作已读（只有本次真正读过的房间才允许
从来源里移除），否则等待中的变更会被永久吞掉。

订阅侧本身（`notifications/roomChangeSubscription.ts`，7 项测试）：按 topic 建 WebSocketChannel2023
通道、连接 `receiveFrom`、解析通知体、断线后**重新建通道**（通道在最后一个 socket 关闭时会被回收，
所以不能复用旧 URL）、失败上报且持续重试直到 stop、`start` 幂等。
**接线已落地**（`notifications/roomChangeTracker.ts`，7 项测试）：每个房间订阅**当天消息文档**（真正被
改写的资源；容器看不到"已存在资源被更新"），跨天 `refresh()` 续订并停掉旧 topic；`trust` 只有在每个
想要的 topic 都订上时才是 `changed`，**订阅失败 / socket 断开（含干净 close）/ 无法归属的变更**一律降级为
`all`（读遍所有房间）。代价明确：R 房间的 Pod 需要 R 条通道 / R 个 socket。

**已接上"本部署服务哪些 Pod"**（`notifications/roomWatchService.ts`，8 项测试 + 容器 1 项）：Pod 集合派生自
`participantRoutes.routes()`，每个 Pod 一个 watcher（房间列表来自 `listJoinedRooms`），服务本身就是 store 的变更
来源（容器测试断言是同一个对象），**未被 watch 的 scope 一律回 `trust: 'all'`**，周期对账接住 Pod 的出现/离开，
单个 Pod 失败只上报且它继续 `trust: 'all'`。**仍未接**：对端方向（对端订阅房间目录取增量）。

**密钥按名字发布（已落地）**：`GET /_matrix/key/v2/server` 现在按 `Host` 认定名字并只发**该名字**的密钥
（参与者是自己的 server，所以对端要的是她的密钥）；不持有的名字回 404 而不是发部署密钥——此前那条路由不看
`Host`，等于让对端永远验不过参与者签名的事件。测试见 `MatrixHandler.test.ts`（含 `Host: alice.example:8448`
得到 alice 的密钥、`bob.example` 得到 404）。

**Pod 归属解析（已落地）**：入站请求按"被寻址的 server name"找 Pod 这一层现在是**派生**的
（`src/api/matrix/participantRoutes.ts`，7 项测试 + 容器 1 项）：server name = WebID 的 host，Pod = 该 WebID
已登记的 Pod（`pod_lookup`），因此不需要第二份 Matrix 绑定记录；同一名字被多个参与者认领、或一个参与者登记了
多个 Pod 时**拒绝**而不是猜（写错 Pod 无法撤销），未登记的名字报 unknown 由外壳回 403。**现状**：外壳本身已全部
落地（`/send`、读取端点、握手、查询、版本）；"部署写目标 Pod 用的服务授权"也已落地为 `service` 上下文（参与者任务层
grant，缺 grant 即 403 点名 Pod），**仍未做**的是 grant 的**签发流程**（索取时机与界面）。

**邀请握手闭环（已取得证据）**：`/invite` 经真 socket 请被邀请方加签——事件 id 不变、双方签名都在，且被邀请方的 Pod 仍为空
（`/invite` 只负责签名，送达仍走事务）。

**按 alias 加入的闭环（已取得证据）**：`joinRoom('#lobby:alice.example')` → `/query/directory` → 握手，三步都经真 socket，
两侧 event id 一致。

**密钥闭环（已取得证据）**：Bob 的部署向 Alice 的部署**真的请求** `/_matrix/key/v2/server`（携带 `Host: alice.example`），
用取回的密钥验过 Alice 签名的事件；不发布的名字取不到密钥（而不是别人的密钥）。

**读取端点的端到端闭环（已取得证据）**：`twoDeployment.test.ts` 新增一项——Bob 加入后向 Alice 的部署经 HTTP 问
`/state`、`/state_ids`、`/backfill`、`/get_missing_events`、`/event_auth`，逐条与 Alice 真实持有的行核对（含"状态里没有
Bob 的 join，因为两条消息写在它加入之前"这条语义），并断言五条请求都真的发生过。

**远端加入的端到端闭环（已取得证据）**：`twoDeployment.test.ts` 新增一项——Bob 加入只有 Alice 的部署托管的房间，
**经 HTTP 走完 `make_join` → 签名 → `send_join`**；断言请求确实发生过、两侧 join 同 id、Bob 的 Pod 因常驻方随加入送来的
状态而持有 create 与 join_rules、事件上同时有双方签名、随后 Alice 的消息仍能到达 Bob。这一项当场暴露并修掉了三个真实缺陷
（"公开房间"没写 join rules、常驻方接受加入却不保存、由调用方提供的事件被存成无 id 事件），详见登记册同轮条目。

**两个部署经真实 HTTP 的闭环（已取得证据）**：`twoDeployment.test.ts` 新增一项——两侧各自把入站路由跑在真
socket 上（随机端口 + `registerFederationRoutes` + 真实的 Pod 路由派生），出站传输把 `https://<name>:8448/…`
改写到回环端口但**保留 `Host: <name>:8448` 与路径/查询**。房间引导、邀请、Bob 的 join（B→A）与 Alice 的消息
（A→B）全部经 HTTP，两侧 `event_id` 集合一致、两个队列清空，并断言请求次数与每次的 `Host` 都是被寻址的 server
name。**写入用的授权**：外壳新增 `contextFor`，容器接的是"以该参与者的任务层 grant 落库"（`service` 上下文）；
store 拒绝"既是会话又是部署干活"的上下文，拿不到 grant 就 403 并点名 Pod（`storePodAccess.test.ts` 4 项）。
**仍未证**：grant 的签发与撤销流程（真实 TLS/SNI 已由 `federationFetch.ts` 与真实握手测试补上）。

**入站 `/send` 的 HTTP 外壳（已落地，真实 HTTP 证据）**：`PUT /_matrix/federation/v1/send/{txnId}` 现在有真正的
路由与外壳（`src/api/handlers/FederationHandler.ts`，容器在有 Pod 注册表与验签密钥时注册）。测试
`tests/api/handlers/FederationHandler.test.ts` 6 项**全部经真实 HTTP 套接字**（随机端口 + `node:http` 以便设置
`Host`）：签名事务被接受并写进被路由的 Pod、重放同一 txnId 只写一次、同一事务内"后一条依赖刚接受的那条"可解析、
不服务的名字 403、伪造签名与 `destination` 不符 401、`Host: <name>:8448` 与 `<name>` 视为同一个名字。
**并且两个部署之间已经真的经 HTTP 跑过完整闭环**（见下）……

**联邦读取端点（服务侧与外壳都已落地）**：`/event_auth`、`/get_missing_events`、`/backfill`、`/state`、
`/state_ids` 五个端点现在都有 HTTP 外壳（`FederationHandler.ts`，与 `/send` 共用"认定被寻址名字 → X-Matrix 验签 →
按名字派生 Pod → 读协议事件"的前奏；房间为空回 404、缺参数回 400）并有 6 项真实 HTTP 测试；`twoDeployment` 里
"接收方补取 auth chain"也已改成**经 HTTP 调真路由**（断言请求过 `/event_auth` 且 `event_id` 与发送方一致）。
**失败按真实状态回答（已落地）**：读取端点此前会把 store 的 `MatrixError`（例如"没有这条 Pod 的授权"）冒成
**500**，对端会当成未知故障一直重试；现在统一按它的 status/errcode 回答，其它错误才是 500。`/version` 的客户端
一半也已就位。测试：`FederationHandler.test.ts` 26 项、`outboundTransaction.test.ts` 49 项。

**传输层（已落地，SNI/Host 缺口补上）**：`federation/federationFetch.ts` 把"连到解析出的地址、但以**被寻址的
server name** 作 SNI 与 `Host`"做成真正的传输（`fetch` 两者都改不了），出站投递与密钥获取共用同一实例；非 2xx 返回
Response 而非抛错，只有传输失败才抛。5 项测试（含真实回环往返断言对端看到的 `Host` 就是 server name），另有 **2 项真实 TLS 握手测试**
（`federationTls.test.ts`：证书只覆盖 `alice.example` 时，连回环地址也能握手成功且对端同时从 SNI 与 `Host` 看到
这个名字；同一张证书下声称 `bob.example` 则**握手被拒**，证明校验按 server name 而非连接地址）。**仍未证**：与公网上
真实委派对端的一次握手。

**不做联邦发现文档（决定）**：`.well-known/matrix/server` 按用户判断**不实现**——Pod 稀疏，拓扑来自房间成员
关系网，不需要按 host 做联邦发现；本部署的联邦端点按 server name 自身的主机可达。

**资料查询（已落地，答案为空是决定）**：`GET /_matrix/federation/v1/query/profile` 能认出"这是不是我们的用户"
（MXID 由 WebID 推导，比对而非查表），不属于本部署的用户回 404；但**字段一律省略**——展示名要来自 Solid profile
（发布给任意对端是个人数据决定），头像规范要求 `mxc://` 而本部署无媒体仓库。2 项真实 HTTP 测试 + 客户端 2 项。

**版本与自报（已落地）**：`GET /_matrix/federation/v1/version` 回 `{server: {name: 'xpod', version}}`，刻意不验签
（它只回答"是谁在应答"）；版本来源收敛到 `src/runtime/deploymentVersion.ts` 一处（CLI 与联邦端点共用）。2 项真实
HTTP 测试。

**目录查询（已落地）**：`GET /_matrix/federation/v1/query/directory` 按 alias 回答 `{room_id, servers}`——alias 是
房间记录上的字段，所以答案来自 alias 里那个 server 的 Pod，不搜索其它 Pod；`servers` 用与出站投递同一套
"joined member → 其 server"选择。2 项真实 HTTP 测试 + 客户端 2 项。

**远端加入的编排（已落地）**：`federation/remoteJoin.ts` 把"要模板 → 只补自己的事实 → 签名 → 提交 → 取回加入前的
状态与 auth chain"收在一处，并且**刻意不持久化**（写进加入者 Pod 是调用方的事）。4 项测试含真实验签（自己的密钥过、
别人的密钥不过）。**已接线**：`joinRoom` 在房间不属于本部署时走这套编排——向房间 id 里的 server 提问、把回来的状态/auth chain 以
"收到的事件"落库、我们自己的 join 用提交的那个事件经本地写入落库（`remoteJoinStore.test.ts` 2 项）。**按 alias 加入也已落地**：`resolveRoomId` 先查本地、再向 alias 命名的 server 发 `/query/directory`，解析出房间 id 后走
同一条远端加入路径（`remoteJoinStore.test.ts` 4 项）。

**成员资格握手端点也已落地外壳**：`make_join`/`send_join`(v2)/`make_leave`/`send_leave`(v2)/`invite`(v2)/
`make_knock`/`send_knock` 七个端点现在都能应答（同一份 `FederationHandler.ts`，5 项真实 HTTP 测试：模板带图位置、
`ver` 不符 400 带 `room_version`、`send_join` 回"加入前状态 + 双方签名"、leave 回空对象、敲门回四字段 stripped
state、`/invite` 为我们的用户加签且不读 Pod）。加签用**被寻址参与者的身份**（`signerFor`），查不到就不签。
**仍未做**：`send_join`/`send_leave` 的 v1（已弃用、只为 room version 1/2 存在）。

**成员资格握手（同样只差 HTTP 外壳）**：`GET /make_join`、`PUT /send_join`、`GET /make_leave`、
`PUT /send_leave`、`PUT /invite`、`GET /make_knock`、`PUT /send_knock` 七个端点的服务侧已实现
（`federation/membershipHandshake.ts`，展示状态在 `federation/strippedState.ts`）并有 29 项测试，客户端的
`makeJoin`/`sendJoin`/`makeLeave`/`sendLeave`/`sendInvite`/`makeKnock`/`sendKnock` 也已就位（16 项）。已写死的语义：模板由常驻方用
`roomGraphPosition` 给图位置（与本地写入同一函数）、加入方丢弃不符的模板、常驻方复用入站 PDU 流水线校验
提交、加入方拿到的是**加入之前**的解析状态与带常驻方签名的加入事件、`omit_members` 只当提示（本部署永不
声称省略）、房间版本按 `ver` 协商（缺省为 `['1']`）；`/invite` 是唯一只校验不授权的一个（被邀请方通常不认识
房间），只回带自己签名的那个事件；敲门回的是房间的 stripped state（敲门方客户端拿它显示"在申请加入什么"）。**未验证的部分**仍是跨部署真实 HTTP 跳转：现有证据是两侧纯函数 + 客户端签名
往返，不是两个部署之间真的跑了这几步。

测试：`tests/api/matrix/scaleOperations.test.ts` 4 项（写/状态/分页在 10 与 200 房间下逐项相同且为小常数、
增量 sync 的往返与行数性质、空闲等待循环零读取、1000 房间的堆增量与单房间读取仍为常数）。

## 分布式目标的新增验收门禁（均待实现与执行）

以下条目是准入要求，不是本次已经通过的测试：

| 门禁 | 必须取得的证据 |
| --- | --- |
| 两个独立部署、两种身份、两个 Pod | 参与同一逻辑房间；各服务仅依授权写入自己负责的 Pod，参与者无需相互持有 Pod 写权限 |
| 协议身份一致 | 相同 room_id、event_id 及事件引用跨 Pod 保持一致；Pod 资源位置变化不改变事件身份，原始协议事件可供验证（单 Pod 内的持久化与验证已落地，跨 Pod 一致性未验证） |
| 传输与落盘恢复 | 断网后补发、重复和乱序投递、缺失事件补取均恢复；分别核对服务器传输确认、各 Pod 持久化进度和客户端同步游标 |
| 授权与房间状态 | 非法签名/事件授权被拒绝；并发成员和 power-level 变更按 room version 的状态解析收敛；历史可见性符合房间规则 |
| Agent 执行归属 | 同一事件的多份持久副本不会分别触发独立执行；归属、接替与重试使用稳定逻辑标识，复制不授予执行权 |
| 仅凭 Pod 恢复 | 移除旧 SQL journal 并清空可重建本地状态后，去重、投递进度、同步与必要执行凭证仍可恢复 |
| 有界同步与权限更新 | **授权判定不跨请求复用已用测试固定**（`agentGrantFreshness.test.ts` 2 项：撤销后下一次调用立即 403、重新授予立即通过；给别人的执行授权不算我们的）；**"跨请求判定缓存"已指认并结案（2026-09-27）**：Pod 侧元数据缓存由 `AsyncLocalStorage` + `TracingHandler` 的每请求 `new Map()` 持有，本来就是请求内复用；CSS `CachedResourceSet` 只缓存存在性（WeakMap 按对象）；`agentGrants` 每次读当前状态。晚到事件不漏，分页稳定，token 和读取工作量有界；普通 ACL/ACR 写入后后续请求不复用旧授权判定 |

LLM/工具质量、跨身份隔离、容量与长期故障测试仍须另取证据。单 Pod 历史闭环继续作为回归基线，不能替代以上分布式协议准入门禁。

## 真实实例探测（2026-09-27，本机 127.0.0.1:3000）

本机有一个**正在运行的 Xpod Gateway**（进程 `xpod`，监听 3000）。按 AGENTS.md"真实实例验收不可替代"的要求探测了它，
结论是**它跑的不是本分支的构建**，因此不能用它验收本轮工作：

| 探测 | 结果 | 说明 |
| --- | --- | --- |
| `GET /.well-known/matrix/client` | **200** `{"m.homeserver":{"base_url":"https://<hash>.nodes.undefineds.co"}}` | 客户端发现可用，Gateway→API 路由通 |
| `GET /_matrix/client/versions` | **200**（含 `co.undefineds.matrix.pod_storage`） | 客户端面在运行构建里 |
| `GET /_matrix/key/v2/server` | **404** `{"error":"Not Found"}` | **API server 自己的 404**（不是 Matrix 形状的 `M_NOT_FOUND`）→ 这条路由在该构建里根本没注册 |
| `PUT /_matrix/federation/v1/send/txn-1` | **404** 同上 | 联邦路由不存在 |
| `GET /_matrix/federation/v1/version` | **404** 同上 | 同上 |
| `GET /.well-known/matrix/server` | **401**（CSS 侧对未知 `.well-known` 路径的响应） | 与"不做联邦发现文档"的决定一致；无需处理 |

**待办**：要取得真实实例证据，需要**用本分支的构建重启一个栈**（不能覆盖用户正在运行的那个）。做法二选一：
① 用户同意后用本分支重启 3000；② 用独立 env（另一些端口 + 独立数据目录 + 独立凭据，参照
`SOLID_ENV_FILE=.test-data/integration/lite.env`）起第二个栈，再按上表逐条探测（`/version`、`/key/v2/server` 按名字发布、
`/send` 无签名 401、`/query/directory` 无签名 401、`/state` 404/401 等）。

## 实现对照表（登记册 → 代码 → 证据）

用途：把登记册里每条**已定**的事落到文件与测试上，便于逐条审计"目标是否达成"；**未达成**的四项单列在末尾。

| 登记册条目 | 实现 | 证据 |
| --- | --- | --- |
| 事件格式、ID、内容哈希、reference hash、签名与验签 | `src/api/matrix/protocol/eventIntegrity.ts`、`persistedEvent.ts` | `protocol/eventIntegrity`/`persistedEvent` 测试；`serverKeys.test.ts` 9 项（含篡改、过期密钥窗口） |
| v11 事件授权规则 | `src/api/matrix/protocol/authRules.ts` | `protocol/authRules.test.ts`；`federation/inboundPdu.test.ts` 7 项 |
| v2 状态解析（分叉收敛） | `src/api/matrix/protocol/stateResolution.ts`、`roomState.ts` | `protocol/stateResolution.test.ts`、`roomState.test.ts`（含分叉） |
| 房间事件图（`prev_events`/`auth_events`/`depth`） | `src/api/matrix/protocol/roomGraph.ts`、`storedEvent.ts` | `protocol/roomGraph.test.ts` 11 项 |
| 参与者身份与密钥归属（MXID 派生、Pod 内封存） | `protocol/serverName.ts`、`identityRegistry.ts`、`signingKeyStore.ts`、`identityProvisioning.ts`、`podParticipantIdentity.ts` | `participantProvisioning` 7 项、`podParticipantIdentity` 7 项、`serverName` 4 项 |
| server name → Pod 归属（派生、歧义即拒绝） | `src/api/matrix/participantRoutes.ts` | `participantRoutes.test.ts` 7 项 + 容器 1 项 |
| 密钥发布（按被寻址名字）与获取（含委派） | `handlers/MatrixHandler.ts`、`federation/serverKeys.ts` | `MatrixHandler.test.ts`（alice 的名字得 alice 的密钥、未知名字 404）；`twoDeployment` 端到端取密钥验事件 |
| 出站事务（签名、txnId 语义、退避、拒绝重试） | `federation/outboundTransaction.ts`、`outboundQueue.ts`、`outboundSender.ts` | 三个文件各 45/24/7 项；`twoDeployment` 断网恢复 2 项 |
| 入站事务（去重、首次应答、释放未完成预留） | `federation/inboundTransaction.ts`、`inboundRoute.ts` | `inboundTransaction` 15 项（含并发预留唯一赢家）、`inboundRoute` 8 项 |
| 缺失事件、历史、状态读取 | `federation/missingEvents.ts`、`roomHistory.ts`、`roomStateSnapshot.ts`、`authChain.ts` | 各 7/6/7/5 项；`twoDeployment` 端到端（读取端点 + 经 HTTP 补取链） |
| 加入/离开/敲门/邀请握手（服务侧 + 客户端） | `federation/membershipHandshake.ts`、`strippedState.ts`、`remoteJoin.ts` | `membershipHandshake` 26 项、`strippedState` 3 项、`remoteJoin` 4 项；`twoDeployment` 端到端加入（含 alias） |
| 目录、资料、版本查询 | `FederationHandler.ts`（+ `outboundTransaction.queryDirectory/queryProfile/getVersion`） | `FederationHandler` 29 项、`outboundTransaction` 49 项 |
| 传输层（委派下的 SNI/Host、真实 TLS） | `federation/federationFetch.ts` | `federationFetch` 5 项 + `federationTls` 2 项 |
| 有界同步的变更信号（订阅 → sync） | `notifications/roomChangeSubscription.ts`、`roomChangeTracker.ts`、`roomWatchService.ts` | 各 7/7/9 项；`syncChangeSource` 6 项、`syncBoundedReads` 5 项、`scaleOperations` 4 项 |
| 远端加入接线（按 id 与 alias） | `PodMatrixStore.joinRoom/joinRemoteRoom/resolveRoomId` | `remoteJoinStore.test.ts` 4 项；`twoDeployment` 端到端两项 |
| 授权判定不跨请求复用 | `PodMatrixStore.agentGrants/authorize` | `agentGrantFreshness.test.ts` 2 项 |
| 入站事务回执落 Pod（控制记录承载） | `matrix/controlRecords.ts`（create-once 文档）、`federation/podInboundTransaction.ts`、`matrix/podAccess.ts`（写入身份唯一解析点）、容器装配 + `FederationHandler.recordsFor` | 单元 8 项 + 句柄透传 1 项 + 写入身份 3 项；**真实 Pod 2 项**（见下） |

**未达成（等拍板，见登记册开头）**：写入侧 ①②③、控制记录的**每记录一文档布局**确认、出站批次的 Pod 承载
（等 `scopes()` 来源）、grant 索取流程、D6 Agent 归属、真实实例验收（另起栈或重启 3000）。
另：`full` 门禁因本机 Docker Desktop 无响应未能运行。

## 控制记录的 Pod 承载（2026-09-27，分支 `codex/matrix-event-primitives`）

这一轮把"事务回执只活在进程内存里"换成了 Pod 里的记录，并在**真实 Pod** 上先把存储语义量出来再写实现。
量出来的三条（探针输出记录在提交信息与契约 §6.1/§6.2）：

| 探测 | 结果 | 后果 |
| --- | --- | --- |
| `PATCH` + `If-None-Match: *`（文档不存在） | **201** | create-once 可用 |
| 两个并发 `If-None-Match: *` | **201 + 412** | 唯一赢家由服务端在同一把资源锁内裁决 |
| 两个并发 `If-Match: <同一 ETag>` | **205 + 205**，ETag 未变 | **`If-Match` 不是版本检查**（ETag = `DC.modified` 毫秒 + content type）→ 不能做预留 |
| `PATCH` 建出的文档 + `DELETE`（容器不存在） | **404**，文档仍在 | 写记录前必须先建容器，否则释放会永久卡住该 key |
| `db.deleteByResource` 后 `findByResource` | 行没了、文档仍在 → 再 `If-None-Match: *` 仍 **412** | 释放必须删**文档** |

证据（可复跑）：

- `tests/integration/MatrixControlRecords.integration.test.ts`（2 项，lite 门禁内、真实栈 + 真实 Pod）：
  三个并发 `reserve` **恰好一个** `created: true` 且失败方读到赢家记录；换一个 store 实例（模拟重启）仍能读到回执、
  重放（载荷不同）取**首次应答**并标记 `conflictAt`；`release` 后同一 key 可再次预留；
  以及 `handleInboundTransaction` 真的把回执写进参与者 Pod 并从记录回答重放。
- `tests/api/matrix/federation/podInboundTransaction.test.ts`（8 项，脚本化 Pod 模型同一套语义）：
  首次创建即写入 Pod、重放取赢家记录、并发唯一赢家、冲突标记不覆盖、完成后重放取首次应答、
  释放后可重试、句柄缺失/scope 不符即拒绝、Pod 拒绝写入时不假装成功。
- `tests/api/matrix/federation/inboundTransaction.test.ts` 新增 1 项：事务层把已解析句柄传给 store 的**每一次**调用。
- `tests/api/matrix/storePodAccess.test.ts` 新增 5 项：`podWriteFor` 每个 context 只解析一次并复用同一 fetch；
  注入的 db 没有 fetch 时拒绝（不给半个授权）；部署自持工作时**不借**调用方会话；
  `controlRecordHandleFor` 把"哪个 Pod"和"以谁的身份"一起解析；context 不含 Pod 时拒绝而不是默认成空 scope。

### 本地顺序可从 Pod 重建（2026-09-27，回应"序号为什么要进 Pod"）

- 结论：**序号不进 Pod**。它是部署本地加速器：事件按 `(createdAt, id)` 读、按该顺序发号，
  清空本地表后两次独立重建得到**同一份确定性顺序**。
- 证据：`PodMatrixStore.test.ts` 新增 1 项——同一份 Pod 内容、两个全新的日志实例，sync 出来的事件顺序完全一致，
  且消息按写入顺序出现；**同时记下它重建不出"同毫秒内的到达序"**（按 id 决胜），这既是它不能当客户端游标的理由，
  也是"游标归客户端"这条口径的技术根据。

### 事件预留迁往 Pod 的前置一步（2026-09-27）

- 事件行现在记下**写它的设备**：`metadata.protocols.matrix.txnDevice`（`MatrixEventRecord.txnDevice`）。
  预留记录的 key 是 `[设备, roomId, type, txnId]`，只有设备不在事件上；记下它之后，
  "这个事件属于哪条预留"从事件本身就能回答（两次点查），这是预留记录能搬进 Pod 的前提。
  测试：`PodMatrixStore.test.ts` 新增 1 项（形状 `XPOD…`、不含引号、`event.txnDevice` 不存在——
  它是记账不是协议字段）。
- **为什么是设备而不是整个 key（实测教训）**：key 是 JSON 数组字符串、含引号，而这个存储会把
  `metadata` 里带引号的字符串写坏——整轮 `MatrixCollaboration` 验收因此从 200 变成 **409**
  （`JSON Parse error: Expected '}'`）。改用无引号的设备 token 后恢复。这条缺口记在契约 §8 第 3 条。
- **序号那一半仍未定**：三个选项见契约 §10.2（留 SQL / Pod 计数器 / 取消序号改用
  `(origin_server_ts, event_id)` 游标，推荐第三条——它同时让"有界读取"成为可能）。

### 出站队列的 Pod 承载（2026-09-27）

- `federation/podOutboundStore.ts`：`PodMatrixOutboundStore` 实现队列的四个操作，批次落
  `<day>/outbound-<sha256(key)>.ttl#self`（与回执同一套日期布局，靠文档名的 kind 前缀分开）。
- **枚举靠列目录**：`pending(scope)` = 窗口（7 天）内每天一次容器列举 + 每条批次一次文档读；成本随"欠多少"增长，
  不随 Pod 有多大增长。`scopes()` 由部署回答（已服务的路由派生）；没有提供者时只回答被问到过的 scope。
- `remove` 改为接收整条批次（txnId 只在 `(origin, destination)` 内唯一），队列接口与内存实现同步调整。
- 证据：`podOutboundStore.test.ts` **7 项**（当天文档与容器、按队列过滤与排序、忘掉后可重复忘掉、
  跨天可枚举与超窗不可见、**一天只列举一次而不是每条一次**、`scopes()` 两种来源、无授权即 403）；
  真实 Pod 新增 1 项——写入两条批次后，**换一个 store 实例（模拟重启）靠列目录把欠的批次找回来**，
  删一条后只剩另一条。真实 Pod 用例现共 5 项。
- **已接线**（2026-09-27）：`createMatrixOutboundDelivery` 接受 store，容器装的是 `PodMatrixOutboundStore`；
  `handleFor`（scope → 该 Pod 的句柄）由**已服务的路由**派生、写入时才解析（构造期解析会与它服务的 store 成环），
  `scopes()` 同样来自路由。证据：`MatrixOutboundContainer.test.ts` 新增 2 项——交付对象带的 store 是
  `PodMatrixOutboundStore` 且 `scopes()` 等于已服务的 Pod 根；对**本部署不服务**的 scope 入队被拒
  （`holds no grant`），不会写到不确定的地方；整轮 lite 门禁在该接线生效的情况下通过（容器能起、路由能注册）。

### 控制记录改按 models 的按天累积布局（2026-09-27，回应"为什么要判赢家"）

- **布局**：`<pod>/.data/task/{yyyy}/{MM}/{dd}/<key 的 sha256>.ttl#self`——与 `message.schema.ts`
  的 `{parent}/{yyyy}/{MM}/{dd}/messages.ttl#{key}` 同一约定（日期目录 + 目录内一条记录一个文档）；
  查找窗口 2 天（`CONTROL_RECORD_LOOKBACK_DAYS`）。
- **一天一个文档（多条记录）被实测否决**：drizzle-solid 把 `object` 列写成按行位置命名的嵌套主体
  （`<文档>#metadata-1`），同文档两行的 `metadata` 因此合并——实测把一条回执与一条批次读成同一条记录
  （`kind` 变成两个值的数组）。改为一条记录一个文档后消失；这条缺口记在契约 §6.1/§8。
- **日期目录必须由我们创建成容器**：实测文档写进 `.data/task/2026/09/28/` 后按 URL 读得到，但
  `GET 2026/` 与 `2026/09/28/` 都是 **404**——没有容器就列不到、也订阅不到。现在逐层条件 PUT。
- **更正一条早先的测量**："容器 `ldp:contains` 只列出 4 个中的 1 个"是**解析错误**（Turtle 逗号列表），
  容器列成员本来就可用于 PUT 与 PATCH 建出的文档。这条更正重新打开了"客户端按目录列举记录"的路径。
- **语义**：`writeControlRecord` 从"create-once + CAS"改为"**幂等插入 + 记录优先**"。`reserve` 的保证从
  "恰好一个赢家"改为"Pod 里只有一条记录、重放从记录回答"——这是这次实测 + 用户提问共同得出的结论
  （契约 §6.2/§6.3）。
- **顺带消掉两处复杂度**：不再需要"写前先条件 PUT 容器"与"释放要删文档"（从不删文档，
  `deleteControlRecord` 只删记录自己的三元组）；`controlRecords.ts` 现在**全部走 drizzle-solid**，
  没有任何绕过。
- 证据：单元 9 项（含"并发只为同一 id 留下一条记录"、跨天查找与超窗当新事务、释放后可再预留、
  句柄缺失/scope 不符即拒绝、Pod 拒绝写入不假装成功）；真实 Pod 3 项——**断言记录真的落在
  `.data/task/<yyyy>/<MM>/<dd>/transactions.ttl`**（HEAD 200）、重启后仍可读、重放取首次应答并标
  `conflictAt`、释放后可重预留、批次载荷原样往返。

### 原生入站端点（2026-09-27，③ 的第一步）

- `POST /_xpod/matrix/inbound/:txnId`：两个 Xpod 部署之间的写入路径，复用 `/send` 的全部判定
  （签名认证、origin 一致、体积上限、事务预占/重放、Pod 回执），只去掉联邦传输（`:8448`/SNI/`.well-known`）。
  响应按事件命名（`events`），错误码与 `/send` 同一套。
- 证据：`tests/api/handlers/FederationHandler.test.ts` 新增 4 项（经真实 HTTP 写入并逐事件应答、
  重放取首次记录不写第二遍、签名/origin/被寻址名字同样被校验、非 JSON `400 M_NOT_JSON` 与超限 `413 M_TOO_LARGE`），
  该文件 33 项全过。**未做**：部署间的客户端与出站选传输（下一步）。

### 原生传输的客户端与选择（2026-09-27，③ 的第二、三步）

- **客户端**（`federation/outboundTransaction.ts`）：`sendNativeTransaction` / `deliverNativeTransaction`
  把同一份已签名内容 POST 到 `<server name>/_xpod/matrix/inbound/<txnId>`；应答里的 `events` 折成与 `/send`
  同一个 `pdus` 结果图，所以队列只认一种形状。**404 读作"对方没有这条路由"（`unsupported`），不是拒绝**；
  其它 4xx 仍是对方的决定。地址规则是**名字本身 + 普通 HTTPS**（`nativeTargetOf`，`via: 'native-endpoint'`）：
  没有 `:8448`、没有 `.well-known`、没有 SRV——原生调用不是联邦流量，没有可委派的东西。
- **选择**（`federation/outboundSender.ts`）：**原生优先**；对方 404 就回退 `/send`（**同一个 txnId**——
  两条路共用同一份回执记录，所以"对方其实收到了"时它会直接重放首次应答）；**拒绝不回退**（那是对事件的
  决定，换个传输再问一次等于让它决定两遍）；**不可达只重试原生**（"对方还没决定"，换传输可能重复投递）。
  每个目的地记住一次答案，TTL 10 分钟（本地加速器，重启即丢，只影响先发哪个请求）。
- 证据：`outboundTransaction.test.ts` 49 → **54 项**（真实签名可被对端认证、原生路径与 POST、`events`→`pdus`、
  404=unsupported 与 403=rejected 的区别、同 txnId 重试、默认地址规则）；`outboundSender.test.ts` 7 → **12 项**
  （原生优先且不再联邦、404 回退并记住、TTL 过后重探、拒绝不回退、不可达保持重试）；
  `twoDeployment.test.ts` 的真实 HTTP 一项改为断言**事务走原生路径**（到 B ≥3 次、到 A ≥1 次，
  且 `/_matrix/federation/v1/send/` **一次都没有**），握手/读取端点仍是 Matrix；
  `outboundDelivery.test.ts` 的夹具明确扮演"只会 Matrix 的对端"，把回退路径也覆盖到。

### 出站批次载荷（2026-09-27，同一分支）

- `federation/outboundBatches.ts`：一条批次 ↔ 一条 `taskResource` 的映射（`metadata` 原样保存
  pdus/edus/attempts/notBefore/lastReason，`status` 一律 `open`，key = `[origin, destination, txnId]`）。
  证据：单元 6 项 + 真实 Pod 1 项（带签名的 PDU 与 EDU **原样往返**，换读者读回同一批）。
- **枚举实测**（同一轮，真实 Pod 的 `.data/task/` 4 行）：全表 `select` = **1 次 SPARQL 查询 + 每行 1 次文档 GET**；
  带 `FILTER(?status=…)` 的 select 只 GET 命中行（过滤可下推，但 `status='open'` 不具选择性）；
  容器 `ldp:contains` **只列出 4 个文档中的 1 个** → 对 PATCH 建出的文档不可信。
  结论与三个选项见[控制记录契约](matrix-control-records-contract.md) §9.2；**Pod 版出站 store 在定案前不实现**。

门禁（提交前在冻结代码上复跑）：`typecheck:test` 通过；`tests/api/matrix tests/api/handlers`
**1002 passed / 3 skipped**（其中 `handlers/FederationHandler.test.ts` 33 项，含新增 4 项）；
`tests/api tests/http` **2015 passed / 67 skipped**；
`test:integration:lite` **156 passed / 6 skipped（31 文件通过 / 3 跳过）**，
含上面 3 项真实 Pod 用例与 `MatrixCollaboration` 的真实运行时夹具。
**未做**：真实实例（本机 3000 是别的构建）、`full`（Docker 无响应）、自动回收（保留期未定）。
