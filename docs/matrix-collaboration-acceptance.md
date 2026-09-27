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
**仍未**验证跨部署互操作，也**未**实现状态解析与事件授权规则的执行：依赖图完整，缺的是
resolution——仍属下方待执行的分布式门禁。

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
| `tests/api/matrix/federation/twoDeployment.test.ts` 4 项 | 通过：房间状态与邀请跨 Pod 送达且被授权；Bob 在 B 上加入、其加入事件由 `bob.example` 签名、A 原样保存；Alice 的消息以**相同 event_id** 落到 B；**重放事务返回首次响应且不写第二次**；未服务的目的地 403、未知签名 401、非 JSON 400；缺依赖的 PDU 报 error 且不落库 |
| `tests/api/matrix/federation/inboundRoute.test.ts` 8 项 | 通过：接受已知服务器签名的整笔事务并逐条报告、未知密钥拒绝、未服务目的地 403、非 JSON/非对象 400、超 50 PDU 拒绝、body origin 与签名 origin 不一致拒绝、处理中返回可重试 503、事务 id 从路径解析（含 URL 编码） |
| 接收方可见性（`PodMatrixStore.materializeReceivedRoom`） | 通过：收到的事件若属于本 Pod 尚未记录的房间，会**按事件本身**补出房间记录（room id 用对端 id、author 用 create 事件的 sender，**绝不写成 Pod 所有者**），因此邀请在接收方可见、也能被加入 |

对照门禁的现状：

| 门禁 | 现状 |
| --- | --- |
| 两个独立部署、两种身份、两个 Pod | **已取得模块级证据**（上表）；真实 HTTP/TLS 跳转与部署级 Pod 授权（谁有权读写哪个 Pod）仍未验证 |
| 协议身份一致 | **已取得模块级证据**：同一 room_id 与 event_id 跨两个 Pod 一致，接收副本按推导 id 保存 |
| 传输与落盘恢复 | 部分：事务重放与去重已证；**逐条拒绝后的重发已落地并端到端验证**（邀请先被拒、依赖到达后自动重发成功）；接收方主动补取（`/event_auth` + `/get_missing_events` 两半）已落地并端到端验证；**出站队列已由调度器驱动、随 API server 启停，并被写入本身触发**（端到端：一次写入无需任何手工 flush 即到达对端 Pod）；投递记录落控制 Pod 仍待做 |
| 授权与房间状态 | 已证：非法签名、缺依赖、未知 server 被拒（本表 + `inboundPdu` / `authRules` / `stateResolution` 单测） |
| Agent 执行归属 | 未做（待决策） |
| 仅凭 Pod 恢复 | 未做（旧 SQL journal 仍在） |
| 有界同步与权限更新 | **模块级证据已取得**（见"规模与 Pod 操作数"）：写入/状态/分页与房间数无关；接上变更信号后，空闲 sync 为 **0 次 Pod 读**、单房间变更 **4 次**（原 42 次）；订阅侧已实现并有测试，**尚缺**把订阅挂到各房间当天文件的接线 |

**本轮发现的两个缺口与处置**：

1. **逐条 error 被当成已投递** —— **已修复**：事务返回 200 不再等于每条 PDU 都被接受，被拒 PDU 换新
   txnId 有界退避重试，用尽次数报 `abandoned`；对端没点名的 PDU 不算被接受；退避中的批次不阻塞队列
   （否则会与"它等的依赖排在后面"死锁）。`twoDeployment.test.ts` 端到端证明：邀请先被拒、依赖到达后
   自动重发并被接受。
2. **依赖顺序** —— **两侧闭环已取得模块级证据**：发送侧同批次内按依赖拓扑排序；接收侧遇到无法授权的
   PDU 时向发送方索取 `/event_auth` 链、按旧到新校验并接受、再重校验原事件（`twoDeployment.test.ts`
   证明：B 自己取回链并接受邀请，event_id 与 A 一致，无测试手工递状态）。**仍缺**两个端点各自的 HTTP
   外壳与 Pod 归属解析（服务侧算法已实现为纯函数）。

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
`all`（读遍所有房间）。代价明确：R 房间的 Pod 需要 R 条通道 / R 个 socket。**仍未接的**：挂到"本部署服务
哪些参与者"（即参与者 ↔ Pod 归属那条待定项），以及对端方向。

**联邦读取端点（服务侧算法已就绪，等 HTTP 外壳）**：`/event_auth`、`/get_missing_events`、`/backfill`、
`/state`、`/state_ids` 五个端点的服务侧都已实现为纯函数/处理体并各有测试（回溯方向与语义按规范：
`/backfill` 含点名事件且从新到旧，`/state` 返回事件**之前**的状态），客户端调用也已就位；
**只差"从请求取 roomId/eventId → 从某个 Pod 取房间事件 → 应答"这一层**，它与入站 `/send` 共用同一个
Pod 归属解析。

**加入/离开握手（同样只差 HTTP 外壳）**：`GET /make_join`、`PUT /send_join`、`GET /make_leave`、
`PUT /send_leave` 四个端点的服务侧已实现（`federation/membershipHandshake.ts`）并有 16 项测试，客户端的
`makeJoin`/`sendJoin`/`makeLeave`/`sendLeave` 也已就位（10 项）。已写死的语义：模板由常驻方用
`roomGraphPosition` 给图位置（与本地写入同一函数）、加入方丢弃不符的模板、常驻方复用入站 PDU 流水线校验
提交、加入方拿到的是**加入之前**的解析状态与带常驻方签名的加入事件、`omit_members` 只当提示（本部署永不
声称省略）、房间版本按 `ver` 协商（缺省为 `['1']`）。**未验证的部分**仍是跨部署真实 HTTP 跳转：现有证据是
两侧纯函数 + 客户端签名往返，不是两个部署之间真的跑了这四步。

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
| 有界同步与权限更新 | 晚到事件不漏，分页稳定，token 和读取工作量有界；普通 ACL/ACR 写入后后续请求不复用旧授权判定 |

LLM/工具质量、跨身份隔离、容量与长期故障测试仍须另取证据。单 Pod 历史闭环继续作为回归基线，不能替代以上分布式协议准入门禁。
