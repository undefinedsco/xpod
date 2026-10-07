# Solid 多方通信迁移：开发侧实现与验收证据

状态：**开发侧阶段报告（非最终验收）**。本报告记录当前工作区代码上真实跑出的命令、退出码与观察值，
并逐项标注 `passed / failed / not_verified`。最终通过与否由主负责人独立复核后给出。

- 分支：`codex/solid-multiparty-migration`
- 交付基点：`d5835f47c484e9b8dbb13f4c3825aba8895996bd` + 未提交工作区改动（本轮未提交、未推送）
- 本轮新增原始证据目录：[`../.test-data/solid-multiparty-acceptance/provider-b/root-review/`](../.test-data/solid-multiparty-acceptance/provider-b/root-review/)
- 运行环境：Bun `1.3.8`、Node `v23.6.0`、darwin
- 关键源文件哈希（本轮 2026-10-02 收尾后）：
  - `src/storage/HierarchicalReadWriteLocker.ts` = `affc49e1acce031c9fa86a7c71b63a150d8aa0980ca5bc11d80e8ad2a6dfdbf5`
  - `src/http/SubgraphSparqlHttpHandler.ts` = `0198115e44a4f1ef52bb8230e30101cae06b77c5bf368730d1cb107dbe5402f0`
  - `src/util/identifiers/MultiDomainIdentifierStrategy.ts` = `427e1a6c5aca15c708f36f0c3e92ac3d5b7e247838beb31be94d546b2fd25725`
  - `src/api/matrix/federation/outboundBatches.ts` = `f45c2feee4910f5d5e27f9d259ab20e4055875defbc972c06b2e76b8b9ef79bf`
  - `scripts/env-file.ts` = `0887aba402c90101a1138c8291fac46789a009f89e4b3343d609388321d9aa7f`
  - （早期基线哈希见下，保留不覆盖）`src/api/matrix/PodMatrixStore.ts` = `a1a160923c3528d5e9c57e3c130e285177a3714ddb55389853897bbdfea66b49`
  - `src/api/matrix/federation/outboundActor.test.ts` 见下轮 R11 更新
- R08 缺口报告（主负责人拥有，权威）：`docs/issues/drizzle-solid-matrix-atomicity.md`；
  R08 服务端层级锁设计（主负责人，权威）：`root-review/atomic-identity-design.md`、
  `root-review/r08-hierarchy-review.md`（R14）。

> 主负责人拥有的 `docs/solid-multiparty-protocol.md`、`docs/solid-multiparty-migration.md`、
> `docs/solid-multiparty-acceptance-criteria.md`、`docs/matrix-collaboration-acceptance.md` 未被本代理修改或提交。
> 本代理只改 `src/`、`tests/`、配置与本文档。

---

## 1. 本轮新增实现（相对交接基点）

### 1.1 R02：真实 Pod 上的逻辑事件身份、并发与跨日

交接时 `tests/integration/MatrixLogicalIdentity.integration.test.ts` 在 `createRoom` 之前即失败：
全局 `vi.useFakeTimers({ toFake: ['Date'] })` 把 DPoP proof 的 `iat` 也拨回 9 月 20 日，而 issuer 仍在 10 月 2 日，
issuer 正确返回 `invalid_dpop_proof - DPoP proof iat is not recent enough`（红日志 `root-review/real-pod-r02-first-failure-redacted.log`）。

本轮的修法（不弱化认证、不关闭 iat 校验）：

1. `PodMatrixStoreOptions` 增加可注入的**事件/存储时钟** `clock?: () => number`（缺省 `Date.now`），
   仅用于事件时间戳与日期分桶；认证 fetch、队列与租约期限仍用真实墙钟。
2. 事件写入路径的存储时间戳改用该时钟，覆盖 `createRoom`、`sendEvent` 的事件时间与
   `appendMembershipEvent`、`setState`、`remoteJoin` 待定身份、`acceptReceivedEvent` 回退时间。
3. 同一 `PodMatrixStore` 实例内给 `sendEvent`/`acceptReceivedEvent` 增加**按逻辑键
   `(scope, roomId, eventId)` 的进程内写串行化**（`runExclusive`）。

**重要更正（R08，主负责人独立实测驳回）**：第 3 项只对**单个 store 实例**有效，不是 G03 的存储证明。
主负责人在同一真实隔离 Pod 上用**两个独立 `PodMatrixStore`/journal 实例**复跑 16 路 ×3 同内容与
×3 竞争内容（`root-review/multi-store-rdf-probe.ts`，实际退出码 1，源哈希 `5e97f658…`）：

- 每个同内容轮次在同一 metadata 主体上持久化 **2 个 protocol JSON 值**；
- 每个竞争轮次 **9 成功 / 7 拒绝**，两个不同正文都被接受，同一主体上持久化 **2 个 `sioc:content`
  值与 2 个互相冲突的 protocol JSON 值**（`root-review/multi-store-rdf-860ff450-…/result.json`
  与原始 `round-*.ttl`）。

因此：
- 本代理此前声称的「10→2→1 条消息主体」**不准确**：那是**字符串/JSON 值出现次数**，不是 RDF 主体数；
  实际需要同时统计**主体数、protocol JSON 基数、content 语义**；
- 单实例的 `MatrixLogicalIdentity.integration.test.ts` 通过只证明**单 store 顺序/单实例并发**，
  **不代表 G03**；跨 writer 的 first-writer 语义在当前代码上**失败**；
- `runExclusive` 的注释一度写了“一个 Pod 只由它的部署写”，这是**自造限制**，不是已接受协议设计，
  已删除；该串行化只作为单实例的部分防护保留。

单实例夹具（真实 drizzle-solid + 真实认证 HTTP）覆盖：同/不同 txn、跨日、重启、响应丢失、
16 路并发 ×3 同内容 + ×3 竞争内容，抓真实 Turtle 按“主体自身的 `event_id`”计数。它证明
**单 store** 的语义，不被当作跨 writer 存储唯一性证据。

### 1.2 已确认在现状代码中已满足的根审查项

- **R04**：`PodMatrixStore.inviteUser` 现要求 `webIdServerName(userId) !== undefined`，
  MXID 形态 `@local:server` 会被拒（`webIdServerName` 对 `@` 开头的字符串返回 `undefined`）。
  本轮新增显式负例 `tests/api/matrix/roomState.test.ts`「refuses a new invite that names a legacy MXID」，
  `tests/api/matrix` 由 610 增至 **611 passed / 3 skipped**（`gate-matrix-final.log`）。
- **R05**：`FederationHandler` 的 `solidSession.identityOf` 已返回 WebID 本身；
  `tests/api/handlers/FederationHandler.test.ts` 的会话路径正例已改为 WebID 成员事件（`sender`/`state_key` 均为 WebID），
  负例（冒名、非成员）保留。
- **R06**：`typecheck:test` 已修复通过。

### 1.3 W2 O1 出站接线（本轮新增，部分完成）

沿 R07 要求把「参与者授权」接进**实际出站传输**，复用现有 `OwnerPodAccess`/`SolidSessionFactory`，
不新建第二套凭据/会话设施：

1. 出站队列批次携带 **actor 引用**（`{ webId, podUrl }`，非凭据）：`EnqueueInput`/`MatrixOutboundBatch`
   新增 `actor`；`PodMatrixStore.queueFederationDelivery` 在 `deliverAsActor` 打开时写入（生产
   `common.ts` 打开；默认关闭以保持内存夹具的旧签名路径）。不持久化 bearer/session。
2. `MatrixFederationClient` 新增 `actorFetch`：带 actor 的请求**只**用解析出的参与者 Solid fetch
   发出，**不带** `X-Matrix` 头；解析不到凭据或没有 `actorFetch` 时返回 `rejected`（fail-closed），
   **不**回退部署身份或签名；凭据在**每次尝试**重新解析（撤权不会被重放）。
3. `outboundSender`/`outboundDelivery` 透传 `actor` 与 `actorFetch`；`common.ts` 的
   `matrixOutboundDelivery` 以 `ownerPodAccess.getPodFetch(actor.webId, { taskCredential: 当前授权,
   podBaseUrl })` 解析，权限缺失/撤权即拒。
4. `deliverAsActor` 只改变「队列里记什么」，不改变本地写入。

测试：新增 `tests/api/matrix/federation/outboundActor.test.ts`（6 项）覆盖——使用参与者 fetch 且无
X-Matrix、actor 引用传给解析器、解析不到凭据拒绝、无 `actorFetch` 拒绝、每次尝试重新解析、无 actor 仍走签名路径；
`tests/api/matrix/outboundDelivery.test.ts` 断言批次携带 actor 引用。

**未完成**：入站 `inboundRoute` 的 `X-Matrix` 主路径回退仍在（与其耦合的签名/密钥/v11 未删）；
真实跨域 Solid 认证未验证；`clientFor` 仍要求存在签名身份。因此 W2/G02 仍为 **partial**。

### 1.4 R14：层级锁 fail-closed 与 GET 取消生命周期（本轮）

R08 的服务端层级锁（`HierarchicalReadWriteLocker`）经主负责人独立复核（`root-review/r08-hierarchy-review.md`、
`r14-read-cancellation-design.md`、`r14-redis-repair-design.md`）后做如下修复，源哈希：

- `src/storage/HierarchicalReadWriteLocker.ts` = `53b3657e…`
- `src/storage/LockingResourceStore.ts` = `c8417dbe…`（本轮重写）
- 组件与配置：`ResourceLocker` 仍为层级锁；`ResourceStore_Locking` 等位替换为 Xpod `LockingResourceStore`
  （`docs/COMPONENTS.md` 已登记）；`SubgraphSparqlHttpHandler.locks` 引用同一实例。

1. **全链 fail-closed**：任何加锁前先解析并校验完整祖先链；父解析抛错、无进展、成环、深度 >64 一律拒绝，
   回调绝不进入（用根探针 `hierarchy-depth-probe`/`hierarchy-parent-error-probe` 复跑，本工作区退出码 0）。
   合法 root 是单元素链。`MultiDomainIdentifierStrategy.isRootContainer` 修正为「每个配置基址都是 root」，
   次宿主链不再走到非法 `https://` 父。
2. **通用回调绝不超时释放**：层级锁全程只用底层原始 locker，读/写都持有到回调真正 settle
   （`hierarchy-read-lifetime-probe` 复跑退出码 0：读回调被显式 barrier 持有时，scope WRITE 一直阻塞）。
3. **GET 取消在已知生命周期内完成**：Xpod `LockingResourceStore` 读取超时改为——装 `close` 监听**再**
   `destroy`，等待真实 close 确认后才让回调返回并解锁。**错误**（自发/外部 destroy 的 error）与取消同路，
   不再当成正常结束；偶发 error 也会等待真实 close。排队中的 GET 超时后**不再执行 authority 工作**。
   正常结束仍按 end/close 释放。复刻根探针 `locking-stream-review-postfix-probe.ts`（保留原始 negative
   `locking-stream-review-result.json`）退出码 0：`errorBeforeClose.writerEnteredBeforeCleanup=false`、
   `queuedRead.callbackStartedDespiteExpiredRequest=false`，lateRepresentation 正值保持。
4. **stream facade 根因**：此前 `Object.create(source,{read})` 会破坏 `asyncIterator`（根基线
   `stream-facade-baseline.ts` 证明同对象装饰正常、Object.create 挂起）。改为装饰**同一个** source 的
   `read`（`originalRead.call(source,size)`），representation 携带同一对象，end/close/error 时恢复并标记完成。

新增/更新测试：`tests/storage/HierarchicalReadWriteLocker.test.ts`（10 项：链序、合法 root、深度/成环/父错误
fail-closed、scope-first 与 document-first 互斥、同文档互斥、兄弟并发、回调抛错后重获）；`tests/storage/
LockingResourceStore.cancellation.test.ts`（5 项：事件消费正常结束、返回流 asyncIterator 回归、超时 teardown
确认前持锁、error-before-cleanup 视为取消、排队的 writer 等活跃读结束）。

**R14 未完成**：`UrlAwareRedisLocker` 的 owner token/续租/owner-release/local final exclusion（内存 Redis 之外）
未实现，也没有真实 Redis 多实例证据；这不影响 Memory/local 路径的上述结论，但 Cloud 共享 Redis 不能据此声称安全。

---

## 2. 必须执行的回归命令（对本工作区跑出的真实结果）

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `bun scripts/check-dependency-state.ts` | 0 | 补丁依赖与工作区构建一致 | `root-review/r14b-gate-0.log` |
| `bun run build:ts` | 0 | tsc 通过 | `root-review/r14b-gate-1.log` |
| `bun run build:components` | 0 | Components.js 生成通过 | `root-review/r14b-components.log` |
| `bun run typecheck:test` | 0 | 测试类型检查通过 | `root-review/r14b-typecheck.log` |
| `bun run test -- tests/api/matrix tests/api/handlers/MatrixHandler.test.ts tests/api/handlers/FederationHandler.test.ts` | 0 | 72 passed / 1 skipped（文件），**687 passed / 3 skipped** | `root-review/r14b-gate-3.log` |
| `bun run test -- tests/drizzle-solid/inline-metadata-subject-isolation.test.ts` | 0 | 1 file，**5 passed** | `root-review/r14b-gate-4.log` |
| `bun run test -- tests/api tests/http` | 0 | 192 passed / 11 skipped（文件），**2087 passed / 67 skipped** | `root-review/r14b-gate-5.log` |
| `bun run test:integration` | 0 | lite **164 passed / 6 skipped**；full **45 passed / 0 skipped** | `root-review/r14b-integration-full.log` |
| `git diff --check` | 0 | 无空白错误 | `root-review/r14b-gate-6.log` |

补充真实隔离栈专项：`bun scripts/run-integration-lite-local.ts tests/integration/chatkit-pod-store.integration.test.ts`
退出码 **0**，22 passed（`root-review/r14b-chatkit.log`）；`tests/storage/*` 新增 15 项退出码 0
（`root-review/r14-cancellation-fix.log`）。

补充真实 Pod 专项（`bun scripts/run-integration-lite-local.ts tests/integration/MatrixLogicalIdentity.integration.test.ts`）：
退出码 **0**，`Test Files 1 passed (1)`，`Tests 2 passed (2)`，用时 48.85s —
日志 `w1-r02-20261002-050603/r02-concurrency-4.log`。

一次性说明：首次 `bun run test:integration` 的 full 半段出现瞬时 `EADDRINUSE 5741`
（端口分配竞态，非测试失败；见 `gate-full-integration.log`）。单独重跑 full 得 45/45
（`gate-full-retry.log`），随后完整命令再跑一次退出码 0（`gate-full-integration-final.log`）。

---

## 3. W0–W5 阶段状态

| 阶段 | 状态 | 依据 / 缺口 |
| --- | --- | --- |
| W0 固定回归基线 | **partial** | 日期夹具已修、时钟改为注入；但此前“并发多主体 10→2→1”是**字符串/JSON 值计数**，不是主体数，已作废；真实基线仍有效，缺口测试的跨 writer 形态由 R08 暴露 |
| W1 事件身份与存储 | **failed（跨 writer）/ partial（单实例）** | 写入方命名、逻辑键 409、metadata 隔离、单 store 并发语义通过；**跨两个独立 store/journal 的 first-writer 冲突失败（R08）**；普通消息写前父容器仍未系统化验证；G04 未逐类验收 |
| W2 身份与 O1 | **partial** | 主写侧身份已 WebID；接收侧处理器映射已改为 WebID，正负例通过。**出站 O1 传输已接线**（actor 引用穿队列、`actorFetch` 用参与者当前授权发实际请求且无 X-Matrix、缺授权 fail-closed，见 §1.3 与 `outboundActor.test.ts`）。**未完成**：入站 X-Matrix 主路径回退未删、签名/密钥依赖未删、真实跨域 Solid 认证未验证 |
| W3 房间与拉取 | **not_verified** | C2 房主权威、作者正本核对生产接线、订阅/拉取/离线对账均未实现 |
| W4 删除预留及推控制记录 | **not_verified** | 事务预留、入站回执、出站批次、每事件签名、密钥、v11 强制仍在；其承重职责（唤醒回执、唯一助手结果）未替换 |
| W5 完整验收 | **not_verified** | 真实 Gateway 多身份协作、故障矩阵、性能测量未执行 |

---

## 4. G01–G12 逐项

| 指标 | 状态 | 说明 |
| --- | --- | --- |
| G01 身份 | **not_verified** | 代码与单元/处理器测试显示新事件 `sender`/成员键为 WebID、新 invite 拒绝 MXID；未跑 A/B/C 三个 WebID、三个 Pod、两个部署 |
| G02 O1 与 Pod 授权 | **not_verified** | 会话投递正负例（冒名/非成员）通过；无真实跨域 O1、无出站参与者凭据接线；五类负例中的 grant 撤销、无 grant 未在真实实例验证 |
| G03 事件幂等 | **failed（跨 writer）** | 单 store 顺序/并发夹具通过，但主负责人用两个独立 store/journal 在同一真实 Pod 上复跑：同内容轮次留 **2 个 protocol JSON 值**，竞争轮次 **9 成功/7 拒绝**、两个不同正文都被接受并留下 **2 个 content 值与 2 个冲突 protocol JSON 值**（R08）。first-writer 语义未成立 |
| G04 全部事件命名 | **not_verified** | 主路径已写入方命名；未逐类验证重试复用 id、唤醒↔助手结果一一对应 |
| G05 房主权威 C2 | **not_verified** | 未实现；成员/角色/元数据仍读本地镜像 |
| G06 拉取传播 | **not_verified** | 未实现；72h/8 天离线、丢通知、乱序、跨日新增未测 |
| G07 内容真实性 | **not_verified** | `authorCopy.verifyAgainstAuthorCopy` 仅 helper + 单测，无生产调用；E3 定位未接 |
| G08 RDF 与父容器 | **partial** | 同文档 100 条 metadata 主体隔离 5/5 且真实 RDF 回读通过；父容器 `ldp:contains`/通知证据未系统验证 |
| G09 唤醒与恢复 | **not_verified** | 既有唤醒测试回归通过；四处中断、交接、重建恢复、唯一结果未被本轮独立验收 |
| G10 分页/增量/有界读取 | **not_verified** | 200 条、同毫秒/晚到、limit 1/7/20、读取计数门禁未执行 |
| G11 删除与迁移边界 | **not_verified** | 无静态依赖审查结论；签名/密钥/v11/预留/回执/批次均未删除；旧 MXID 数据策略未逐类说明 |
| G12 全链路与回归 | **not_verified（回归 passed）** | 相关自动化门禁 0 失败（见上表）；**当前实际用户 Gateway 未参与本轮**，无多身份协作证据 |

---

## 5. R01–R14 根审查项

| 项 | 状态 | 本轮证据 |
| --- | --- | --- |
| R01 同资源冲突语义 | **partial** | 既有内存探针 409；单 store 真实 Pod 竞争内容 16×3 全部 409；但跨 writer 竞争失败（R08） |
| R02 真实 Pod 并发/跨日/重启/响应丢失 | **partial** | 单 store 夹具 `r02-concurrency-4.log` 2 passed；主负责人跨实例复跑失败（R08），故 R02 未达成 |
| R03 远端 join 重试身份 | **partial** | 现借助 `journal.reserveTransaction` 固定 id/时间；重启验证通过；**删预留后等价保证未完成**（W4/G11） |
| R04 新成员键必须 WebID | **resolved（代码 + 显式负例）** | `inviteUser` 拒绝 `@local:server`；`roomState.test.ts` 负例通过；未在真实多部署验证 |
| R05 WebID 接收路由 | **resolved（处理器级）** | 会话正例（WebID sender/state_key）与冒名/非成员负例通过；真实跨域认证未验证 |
| R06 typecheck:test | **resolved** | 退出码 0 |
| R07 O1 / C2 生产接线 | **partial** | 出站 O1 传输已接线（actor→`actorFetch`，见 §1.3）；但 `verifyAgainstAuthorCopy` 仍无生产调用；`requireJoined`/`requireRoomOwner`/`inboundAuthority` 仍读本地镜像；入站 `X-Matrix` 主路径回退仍在 |
| 跨 writer 原子 first-writer（R08） | **failed（主负责人实测；服务端锁已修）** | 两个独立 store/journal、同一真实 Pod：同内容留 2 个 protocol JSON 值；竞争留 2 正文/2 content/2 protocol 值（`multi-store-rdf-860ff450-…/result.json`）。**服务端层级锁 + GET 取消已实现并过根探针（§1.4）**；客户端 guarded ORM AST 条件写入尚未接入 `appendEvent`，故 R08 仍 failed |
| R09 凭据 actor 严格匹配 | **resolved（本地 dummy）** | 根探针 `credential-actor-mismatch` 退出码 0（5 场景精确匹配、双向拒绝）；真实 O1/G02 仍未验证 |
| R11 队列批次授权合并 | **partial** | 不同 named ref 现为两批；helper 单测通过；真实 O1 撤权/持久化重启/fetchTarget 正值待做 |
| R12 dotenv WebID fragment | **resolved（helper + 根探针 0）** | 序列化器用 dotenv 解析校验往返；合法 `?hint='#me` 保留，混合引号+`#` 明确拒绝（`env-quote-fragment-final.log`） |
| R13 ownerGrant 形状 | **resolved（dummy decode）** | `ownerGrant:false` 现拒绝，`true`/named 正值保留（`task-grant-shape-final.log`）；真实 grant/O1 撤销未验证 |
| **R14 层级锁 fail-closed / 读取消 / Redis** | **partial（read-cancel 已过根探针；Redis 未做）** | depth/parent-error/read-lifetime/locking-stream 根探针在本工作区退出码 0（§1.4）；`UrlAwareRedisLocker` owner lease/local exclusion 未实现 |

---

## 6. 故障矩阵与性能

**not_verified**：本轮未执行故障矩阵（写入成功响应丢失、同键竞争跨日、订阅断线漏更新、拉取中断游标、
房主不可达/撤权、结果落 Pod 后崩溃、索引/队列重建、作者副本不匹配）与读取工作量/延迟测量
（10/200/1000 房间、200/2000 历史、请求级读取计数、p50/p95/max、30 样本、R/L 预算）。
真实实例的 `2R+L` 恢复预算与 72h/8 天离线未测。

## 7. 真实 Gateway

**not_verified**：本轮未连接当前实际运行的 Xpod Gateway，未记录交付构建、`/service/status`、
真实账号/Pod URL、不同 WebID 的多身份协作。`test:integration` 使用的是 Xpod 自管的隔离 lite/full 栈，
不能表述为真实实例通过。使用过的真实测试账号/Pod 仅由测试脚本私下读取凭据，未在本报告或日志中输出。

---

## 8. 剩余缺口（按依赖顺序）

0. **R08 客户端原子 first-writer（服务端锁已完成，客户端条件写入未接）**：`HierarchicalReadWriteLocker`
   与 Xpod `LockingResourceStore` 已按 `root-review/atomic-identity-design.md` 落地并过根探针（§1.4）。
   仍缺：`PodMatrixStore.appendEvent` 未改为「ORM `insert.values.toSPARQL()` → 单一候选日文档 GRAPH 的
   条件 `INSERT WHERE` + CORRELATED `NOT EXISTS`（`VALUES ?existingGraph` 需在服务端持锁时由
   `engine.listGraphs(scope)` 注入）」，也未做 POST 后全日期 ORM 回读 winner/409。因此
   `multi-store-rdf-probe.ts` 与 `independent-process-rdf-probe.ts` 尚未在修复后的写入路径上重跑。
   （旧结论「必须等上游新契约」已被主负责人驳回：安装的 ORM 0.3.24 公共 API 足够。）
1. **R14 Redis owner lease / 本地最终互斥**：`UrlAwareRedisLocker` 仍是 CSS 的匿名 reader 计数 +
   固定 `locked` 值 + 60s TTL；未实现唯一 owner token、续租、owner-checked release、本地
   `GreedyReadWriteLocker` 兜底、shutdown 只释放本实例。Cloud 共享 Redis 不能据此声称安全；
   需真实 Redis 多实例证据（`root-review/r14-redis-repair-design.md`）。
2. **O1 出站接线（R07，部分完成）**：actor 引用穿队列、`actorFetch` 用参与者当前授权发实际
   请求（无 X-Matrix、缺授权 fail-closed）已接。**剩余**：入站移除 `X-Matrix` 主路径回退、
   去掉 `fetchTarget` 在 O1 路径的绕过/统一传输、真实跨域 Solid 认证正负例。
3. **C2 房主权威（W3/G05）**：E3 登记的权威 Pod 定位 + 以当前参与者身份读房主 Pod 的 drizzle reader，
   未知/不可读/撤权 fail-closed；`verifyAgainstAuthorCopy` 接生产。
4. **拉取与对账（W3/G06/G10）**：订阅/拉增量、断线对账、稳定分页、有界读取。
5. **W4/G11 删除**：先替换唤醒回执与助手唯一结果职责，再删事务预留、入站回执、出站批次、
   每事件签名/密钥/v11，并保留可重建本地索引。
6. **W5/G12**：真实 Gateway 多身份多 Pod、故障矩阵、性能测量、主负责人独立复核。

---

## 9. R15/R16/R17 修复与当前边界（2026-10-02 续作）

本轮在 `PodMatrixStore` 条件写入、`SubgraphSparqlHttpHandler` 存在图注入、`SparqlUpdateResourceStore`
PATCH 序列化三处做了具体修复，并在本工作区复跑主负责人独立探针（均为 UUID/新增输出，历史 negative 不覆盖）：

- **R15 AST/作用域**：`FILTER(NOT EXISTS { GRAPH ?g ... })` 的表达式遍历、bare 存在块包装为 group、
  `VALUES ?g` 键、嵌套存在各自作用域注入。主负责人探针 `r15-serialized-scope-probe.ts` 在本工作区
  exit 0（序列化后仍有 VALUES，嵌套 Comunica ASK 真值不变）；`existence-ast-boundary` 克隆探针
  exit 0。**未完成**：完整当前库存 + 本地 ACL/ACR 新鲜快照（`r15-local-authorization-snapshot-design.md`）。
- **R16 完整 modeled-fact 守卫**：确认路径只信任 RDF authority 文档，不再信任 ORM 解码行；
  从 models 公共列元数据（`getPredicate`/`dataType`/`isInverse()`）派生谓词、标量/数组基数与方向；
  必需 `createdAt` 单个可解析 Literal 且与协议事件时间同instant；RDF content 与
  `messageContentFromMatrixEvent` 一致；inverse Chat 唯一且指向本房间。`committed-winner-full-facts-probe.ts`
  42/42 在本工作区 exit 0；`committed-winner-routes`、`committed-winner-shape`、`event-semantics-boundary`
  亦 exit 0。`missing state_key` 与 `''` 严格不等（两方向）。已加 tracked 回归
  `tests/api/matrix/committedWinnerGuard.test.ts`（10 项）。安装 ORM 的解码基数局限记入
  `docs/issues/drizzle-solid-matrix-atomicity.md`。
- **R17 PATCH 字面量边界**：`SparqlUpdateResourceStore.normalizeGraphs` 不再手写字面量转义，改用公共
  sparqljs `Generator` 序列化，保留图边界/类型/语言。主负责人 `actual-orm-literal-request-probe.ts`
  在本工作区 exit 0（实际认证 PATCH 成功）。tracked 回归
  `tests/SparqlUpdateResourceStore.test.ts` 增加混合引号/Unicode/换行/反斜杠往返。**100 行
  `shared-document-100-acl-probe.ts` 仍在第 12 次写入遇到本地 QLever 60000ms 超时（非解析错误）**，
  未通过。

门禁（本边界真实退出码）：depstate 0、build:ts 0、build:components 0、typecheck:test 0、
matrix+handlers 0、drizzle+store 0、`tests/api tests/http` 0、`git diff --check` 0、
`bun run test:integration` 0（lite **164 passed / 6 skipped**，full **45 passed / 0 skipped**）。

**未完成/未验证**：R15 本地授权快照；R14 Cloud Redis（root 已接管该文件，本代理不改）；
G08 100 行共享文档与通知证据；W2 真实 O1、W3 C2/拉取/离线/分页/性能、W4 唯一唤醒/结果/崩溃恢复与旧控制删除、
W5 真实 Gateway 多身份协作与故障/性能。隔离栈结果不能表述为真实 Gateway 通过。

### 9.1 R15 授权快照尝试与当前边界（2026-10-02 续作二）

- `HierarchicalReadWriteLocker` 增加内部 `mutationSnapshot()`（单调 write revision + 活动 writer 数），
  write 回调开始即登记、真正 settle（含抛错）才清除；已加 tracked 回归
  `tests/storage/HierarchicalReadWriteLocker.test.ts`（13 项，含并发写检测）。
- **未接入 `SubgraphSparqlHttpHandler`**：先试过「授权前快照 → 持 scope WRITE 内比较，stale 则释放重试 3 次」。
  实测该全局版本把同一 room scope 的普通并发写当成 stale，导致必做的
  `independent-process-rdf-probe.ts` 竞争轮从 8 成功/8 拒绝退化为 5 成功/11 拒绝（exit1）。
  条件首写守卫本身已在锁内重读 `engine.listGraphs`，因此回退为单次尝试，仅保留「每次尝试使用全新
  metadata 缓存」（`metadataRequestContext.run({metadataCache:new Map()})`）。完整「按权威范围(ACL/ACR)
  的授权快照 + 有界重试」仍未实现，需要按 scope/权威键跟踪突变而非全局版本。
- 复跑 `independent-process-rdf-probe.ts` 恢复 exit0（3 same ×16 全成功、3 competing 8/8）。
- 门禁（本边界）：depstate/build:ts/build:components/typecheck:test 0、matrix+handlers 0、
  storage+drizzle 0、`git diff --check` 0、`bun run test:integration` 0（lite 164 passed/6 skipped，
  full 45 passed/0 skipped）。`tests/api tests/http` 中 3 个 AI-gateway 用例在整包并发下 30s 超时，
  单独运行 96/96 通过（与本次改动无关的负载抖动）。

### 9.2 W4/G09 结果优先恢复（2026-10-02 续作三）

- `PodMatrixStore.commitResult` 现在在检查当前 grant/lease **之前**读取权威完成事实：Run 已 `completed` 时，
  从 Run metadata 取首次结果 eventId，回读该 ASSISTANT Message，核对 agent/sender/body/handoff/evidence。
  相同提交返回**首次**完整结果（`eventId`/`run`），不重新执行、不要求旧 grant 仍有效；不同 body/handoff/evidence
  返回 409 并保留原结果。新（未 completed）执行仍需当前 grant，撤销后拒绝（403）。
- tracked 回归 `tests/api/matrix/MatrixCollaboration.test.ts` 新增：
  「completed 结果在撤权后仍可回放，且不同结果 409、原记录不变」与「新执行在撤权后 403、零助手消息」。
- 门禁（本边界）：depstate/build:ts/typecheck:test 0；matrix+handlers **700 passed / 3 skipped**；
  `bun run test:integration`：lite **164 passed / 6 skipped**、full **45 passed / 0 skipped**
  （首次复合运行因动态端口 6310/5741 冲突失败一次，非产品错误；单独重跑 full 45/0）。
- 未验证：真实 Pod 上的双执行者/fence、四崩溃点、队列/SQL 清空重建、Cloud Redis；真实 Gateway G12 仍必需。

### 9.3 R15：退役被否决的全局 epoch（2026-10-02 续作四）

- 按 root 批准的 `r15-local-authorization-snapshot-design.md`（否决 whole-instance revision），已删除
  `HierarchicalReadWriteLocker` 的 `mutationSnapshot()`/`mutationRevision`/`activeWriters` 全局 epoch 及其
  4 个测试；**保留 root 的 `withWriteLockAndReadDependencies` 统一锁计划方法与其测试**，未改动该方法。
  现无任何 `mutationSnapshot` 引用。
- 门禁（本边界）：depstate 0、`build:ts` 0、`typecheck:test` 0、`tests/api/matrix` 640 passed/3 skipped、
  `tests/storage` **744 passed / 22 skipped**（0 失败），`tests/storage/HierarchicalReadWriteLocker.test.ts`
  14/14。`test:integration:lite` 首次因 MatrixCollaboration 子进程启动 flake（stderr 仅 oidc 警告，无断言）
  失败一次，重跑 **164 passed / 6 skipped**。
- **未完成**：R15 的 permission-only ALS 收集器、按权威资源的 generation/active 追踪、严格 group checker、
  Handler ≤3 次预突变新鲜重试、以及 Mix 的 R15 hook（root 拥有 Mix parent/lease，需按方法级 handoff 协调）。
  这些仍是 mandatory gap。

### 9.4 R15 权限快照实现（2026-10-02 续作五）

按 root 批准的 `r15-local-authorization-snapshot-design.md` 实现 authority-scoped 快照（非全局 epoch）：

- 新增 `src/storage/AuthorityResourceTracker.ts`：按**权威资源**（ACL/ACR 或数据资源）记录单调
  generation + 在途 mutation 数；`isFresh(resourceUri, snapshot)` 要求 generation 不变且当前无 mutation。
- 新增 `src/storage/AuthoritySnapshotContext.ts`：permission-only ALS；`captureAuthorityDependency(resourceUri, lockUri)`
  在授权尝试中记录**首次**快照（warm cache 重读不刷新），`authorityDependenciesFresh(state)` 校验全部依赖。
- `src/storage/LockingResourceStore.ts`：`getRepresentation`/`hasResource` 在读之前捕获（resourceUri=实际 `.acl`，
  lockUri=经 auxiliary 映射的 subject，含 404）；`addResource`/`setRepresentation`/`deleteResource`/
  `modifyResource` 包 `runMutation`（覆盖写入+失败）。
- `src/http/SubgraphSparqlHttpHandler.ts`：授权（`inspectUpdateGraphs`/`authorizeFor`/逐图授权/
  `resolveReadAccessScopeForCredentials`）在 `collectAuthorityDependencies` 中执行；commit 前先校验
  `authorityDependenciesFresh`，stale 抛错；用 **root 的 `withWriteLockAndReadDependencies`** 一次获取 scope WRITE
  + 所有依赖 lockUri；`executeUpdate` ≤3 次**突变前**重试（每次全新 metadataCache），耗尽返回 400（零副作用）。
- tracked 回归 `tests/storage/AuthoritySnapshotContext.test.ts`（5 项）：generation/active、捕获后 mutation 失效、
  warm-cache 不刷新、ALS 外不记录、真实 `LockingResourceStore` ACL→subject 映射且 ACL 写入后失效。

门禁（窄）：`typecheck:test` 0、`tests/storage` **748 passed / 22 skipped**、`tests/api/matrix` **658 passed / 3 skipped**、
`tests/storage/AuthoritySnapshotContext.test.ts` 5/5；R08 `independent-process-rdf-probe.ts` **exit 0**
（3 same ×16 全成功、3 competing 8/8），说明 authority-scoped 重试不会被同 scope 普通并发数据写误判。

**仍未完成**：Mix `getMetadata`/`getData` 读路径捕获（在缓存命中/未命中之前）；严格 group checker
（普通路径委托原实现、strict 仅 group 拒绝）；**完整未过滤库存 `listGraphs` + 对全部候选图逐一 READ 授权 +
精确集合（非计数）复校验**；普通 `queries` 语义保持。全量回归待 root 释放边界。

### 9.5 R15 Mix 读取捕获 + 实际突变边界（2026-10-02 续作六）

- 修复 B26 缺陷：`LockingResourceStore` 曾把 `runMutation` 包在 `super` 之外（入队即登记），使排队中的 `.acl`
  写入在依赖 READ 持有时被误判 active→false stale。现写入方法不再登记；登记改到**实际突变边界**。
- `MixDataAccessor`（B27 已授权本代理改，保留 root lease/parent）：
  - `getMetadata`/`getData` 在任何 memo/缓存/404 之前 `captureAuthorityDependency(identifier.path, identifier.path)`；
  - `writeContainer`/`writeMetadata`/`deleteResource` 在 `assertCurrentLockOwnership()` **之后**才 `runMutation`；
    `writeDocument`、`executeSparqlUpdate`（覆盖 prepare+persist+rollback）在实际写入边界 `runMutation`。
  - 排队中的写入不登记 generation；只有真正取得锁并开始写入才登记。
- tracked 回归 `tests/storage/AuthoritySnapshotContext.test.ts` 6 项：新增「排队 `.acl` 写入在依赖 READ 持有时
  不使快照 stale」以及真实 `LockingResourceStore` 的 `.acl`→subject 映射。
- 门禁（窄）：`typecheck:test` 0、`tests/api/matrix` **661 passed / 3 skipped**、
  `AuthoritySnapshotContext.test.ts` 6/6；R08 `independent-process-rdf-probe.ts` **exit 0**（3×16 全成功、3×8/8）。
  另：`tests/storage` 中 `PostgresRdfEngine.test.ts` 一例 30s 超时（与本改动无关的 Postgres 环境抖动）。

**仍未完成**：严格 equal-interface `GroupAccessChecker`（普通路径 `super` 委托、strict 仅 group 拒绝）；
严格 variable-graph 的**未过滤 `listGraphs(base)` + 对全部候选图逐一 READ 授权 + 精确集合复校验**；
每次尝试的 AST 全新 clone/parse（当前 stale 检查在注入前，已避免复用旧库存）。这些仍属 R15 mandatory gap，
以及后续 W2-W5/G01-G12 与最终全量门禁（待 root 释放 Docker 边界）。

### 9.6 R15 未过滤库存授权 + B24 结果绑定（2026-10-02 续作七）

- item1：`tests/storage/AuthoritySnapshotContext.test.ts` 类型已修正，`bun run typecheck:test` **exit 0**。
- item3（handler）：授权阶段新增**未过滤候选库存** `engine.listGraphs(baseUrl)`（去重），对**每个候选图**按
  `resourceUrlForGraphValue` 逐一 READ 授权（不可读即抛出、fail closed，不退回过滤 deny-list）；commit 内先校验
  权威依赖快照，再对当前库存做**精确集合**比较（非计数），集合变化即 stale 释放重试。≤3 次**突变前**尝试，
  第三 stale 转 400、零副作用；stale 检查在 AST 注入之前，故不会复用旧库存/旧 AST。
- item4（b24 绑定）：`commitResult` completed 分支在回放前校验绑定：Run `matrix.roomId/jobId` 必须等于本次 room/job，
  `Run.thread`/`Run.input` 必须等于 `job.thread`/`job.triggerMessage`；输出必须是 `ASSISTANT` role、本 room、
  本 agent sender、`replyTo=job.triggerMessage`、`execution.jobId/agent` 匹配、body/handoff/evidence 一致，
  否则 409（另：绑定不匹配 503）。有效 completed 回放仍不要求旧 grant 有效、不重新执行；新执行仍需当前 grant。
- tracked 回归：`MatrixCollaboration.test.ts` 18 项（新增「Run metadata 指向别的 room 拒绝 503」、
  「指向非 ASSISTANT 记录拒绝 409」）；`AuthoritySnapshotContext.test.ts` 6 项。
- 窄门禁（真实退出码）：`build:ts` 0、`build:components` 0、`typecheck:test` 0、
  `AuthoritySnapshotContext + MatrixCollaboration` **24 passed**；R08 `independent-process-rdf-probe.ts` **exit 0**
  （3 same ×16 全成功、3 competing 8/8）。

**仍未完成**：item2 严格 equal-interface `GroupAccessChecker`（普通路径 `super`、authority ALS 内 group-only
外部/未跟踪授权拒绝、direct/public 保留）+ 最小 component/config/export；R15 的 Mix 端 generation 与 handler
精确集合比较的**联合**实际认证 HTTP 负例（撤权/私有候选/同计数交换/warm404）与 third-stale 零效果证明；
随后 `b24-result-replay-review.md` 其余（durable output exists but Run not completed 恢复）与原始 W2-W5/G01-G12。

### 9.7 R15 剩余项：active 语义、AST 重解析、严格库存分支、组检查器（2026-10-02 续作八）

- item3 `AuthorityResourceTracker.isFresh`：现在要求**捕获时 active===false** 且当前 inactive 且 generation 相同；
  若首次读取时突变已在进行，即使随后 settle 且 generation 未变也不再视为 fresh。新增回归。
- item2 handler：每次重试**重新 parse 原始 query**（`new Parser({baseIRI}).parse(queryRequest.query)`）并
  全新 `metadataCache`，注入的 VALUES 不会泄漏到下次尝试；非 stale 错误不重试，突变后绝不重试。
- item4 handler：严格「未过滤库存 + 每候选图 READ 授权 + 精确集合复校验」**仅**对 variable-GRAPH 存在守卫
  生效（普通 INSERT/DELETE 保持 CSS 兼容可见数据集语义，不被无关私有 sibling 阻塞）；严格分支在注入时使用
  已授权的未过滤库存，不再重新读取过滤库存。
- item1 严格组检查器：新增 `src/authorization/StrictAgentGroupAccessChecker.ts`（等位替换
  `urn:solidlab:policy-engine:AgentGroupAccessChecker`）：无 authority 快照时委托 `super`；快照内若存在
  **未跟踪** group grant 则 `agent.success=false`（fail closed），已跟踪 group 仍走原生逻辑；direct/public
  由其它 checker 处理不受影响。已 export 并写入 `config/xpod.base.json` Override。
- tracked 回归：`tests/authorization/StrictAgentGroupAccessChecker.test.ts` 3 项（未跟踪拒绝/已跟踪放行/普通委托）；
  `AuthoritySnapshotContext.test.ts` 7 项。
- 窄门禁（真实退出码）：`build:ts` 0、`build:components` 0（生成
  `dist/authorization/StrictAgentGroupAccessChecker.jsonld` 且 context 已注册）、`typecheck:test` 0、
  4 个 focused 文件 **32 passed**；R08 `independent-process-rdf-probe.ts` **exit 0**（3 same ×16、3 competing 8/8）。

**仍未完成**：item5 真实 closed-ACL/current-auth 负例（private candidate deny、same-count swap fresh attempt、
撤权拒绝、warm404 替换拒绝、third stale 零效果、writer-already-active stale、queued unrelated 不 stale）；
完整 `test:integration` 全量门禁；B24 durable-output-but-Run-not-completed 恢复；原始 W2-W5/G01-G12；
cursor 架构待 root。以上不得以窄测试绿替代。

### 9.8 B29 两处强制修正（2026-10-02 续作九）

- `request.__xpodSparqlAuthz` 不再跨重试复用：`executeUpdate` 每次尝试前**重建**决策 Map（与全新 AST/`metadataCache`
  一致），因此在「先正授权、随后撤权」的 stale 重试中会重新调用 permissionReader/authorizer，不会命中旧正决策。
- `StrictAgentGroupAccessChecker`：严格上下文内**任何 group grant 都拒绝**（`agent.success=false`），不再因依赖 Map
  命中而放行后走 `super` 外部 HTTP 抓取；普通上下文仍委托 `super`，direct/public 由其它 checker 处理。删除原先的
  「tracked map 放行」假阳性测试。
- 严格 authority 快照/组收集器**仅在 variable-GRAPH 存在守卫**时激活；普通 CSS 兼容写不进入 strict 上下文。
- tracked：`tests/authorization/StrictAgentGroupAccessChecker.test.ts`（严格拒绝、普通委托）；
  `AuthoritySnapshotContext.test.ts` 7 项。
- 窄门禁（真实退出码）：`build:ts` 0、`typecheck:test` 0、focused 4 文件 **31 passed**（未启动 runtime fixture，
  遵守 root 正在运行全量门禁的约束）。

**未完成**：cursor 增量路径（已批准 `root-review/cursor-incremental-approved-design.md`）——journal 精确 refs/分页/
epoch、`sync` 消费 ref 页 + `db.findByIri`、C2 权威替换、durable paged reconcile checkpoint、receiver 页 CAS、
bounded 读取与全部回归；以及 R15 真实 ACL 负例、G09 durable-output-but-Run-not-completed、W2-W5/G01-G12 与
最终全量门禁。以上不得以窄测试绿替代。

### 9.9 cursor 基础：精确 refs / 分页 / epoch + 写入登记（2026-10-03）

- `MatrixEventJournal` 新增 `MatrixEventReference{scope,roomId,eventId,messageIri?,createdAt,sequence}` 与
  `registerReference`（按 `(scope,roomId,eventId)` 幂等，返回既有 sequence，不移动）、
  `listReferences(scope,{afterSequence,limit,roomId})`（按 discovery sequence 升序、有界、可房间过滤）、
  `getEpoch`/`bumpEpoch`（durable scope epoch，旧 token 可强制 resync）。discovery order 是登记顺序，不是
  native-commit watermark；晚到旧 `createdAt` 仍获得新的 discovery sequence。
- `InMemoryMatrixEventJournal` 与 `SqlMatrixEventJournal` 均实现：SQL 侧新增
  `xpod_matrix_event_refs(sequence,scope,room_id,event_id,message_iri,created_at, PRIMARY KEY(scope,room_id,event_id), UNIQUE(scope,sequence))`
  与索引 `(scope,sequence)`、`(scope,room_id,created_at,event_id)`，以及 `xpod_matrix_journal_epoch`；
  `PodMatrixEventJournal` 透传。
- 写入路径：`appendEvent` 与 `acceptReceivedEventLocked` 改为 `registerReference`（含 `messageIri` 与
  `createdAt`），depth 用返回的 sequence（内部仍走 `registerEvent`，高水位语义不变）。
- tracked 回归 `tests/api/matrix/MatrixEventJournal.cursor.test.ts` 5 项：幂等登记、分页/过滤、
  晚到旧 createdAt 的新 sequence、epoch、Pod wrapper 透传。
- 窄门禁：`build:ts` 0、`typecheck:test` 0、cursor/Pod journal/协作 **28 passed**。

**仍未实现**：`sync`/`syncOnce` 消费 ref 页 + `db.findByIri`（当前仍 `listEvents`），root 的
`tests/api/matrix/cursorIncrementalReads.acceptance.test.ts` 因此仍未通过；C2 权威状态、durable paged
reconcile checkpoint、receiver 页 CAS、并行 native hinted/full reconcile 与设计列出的回归。

### 9.10 cursor journal 生产正确性（2026-10-03）

按 root B32 指标修正 SQL/内存/Pod 三实现：

- **原子发布**：`SqlMatrixEventJournal.registerReference` 在**同一事务**内分配/插入 discovery sequence
  （`xpod_matrix_events`）与精确 ref（`xpod_matrix_event_refs`）；PG 先 `LOCK TABLE ... SHARE ROW EXCLUSIVE`。
  SQLite 分支**当时并未使用事务**（错误描述，见 §9.11 更正）；§9.11 改为同步 `BEGIN IMMEDIATE … COMMIT`。
  高水位不再可能先于未发布 ref 前进。
- **返回已存首值**：冲突时先查 `xpod_matrix_event_refs`，重复登记返回**实际存储的**首条 ref（ID/时间/IRI），
  不再回显重试提案。root 独立测试 `cursorJournal.acceptance.test.ts`（memory+SQLite）**6/6 通过**。
- **固定上界分页**：`listReferences` 新增 `throughSequence`（固定快照上界，快照后新 ref 被排除），
  `limit` 经 `clampLimit` 限制为有限正整数并设 `MAX_REFERENCE_PAGE=1000`，非有限请求返回空页。
- **持久随机 epoch**：`getEpoch` 在全新操作索引上生成 `randomUUID`（不再是 0），同一 store 重读稳定；
  全索引丢失/重建（新 store/新库）得到不同 identity；`bumpEpoch` 换新 identity。
- 内存/SQL/Pod 三实现签名一致（`getEpoch/bumpEpoch: Promise<string>`）。
- tracked：`MatrixEventJournal.cursor.test.ts` 6 项（含 throughSequence 固定上界、epoch 稳定性/重建、Pod 透传）。

门禁（真实退出码）：`build:ts` 0、`typecheck:test` 0、root `cursorJournal.acceptance.test.ts` 6/6、
`MatrixEventJournal.cursor.test.ts` 6、`PodMatrixEventJournal.test.ts` 5；`tests/api/matrix` **680 passed / 3 skipped**，
仅 `cursorIncrementalReads.acceptance.test.ts` 失败（预期：`sync` 消费 ref 页尚未实现）。

**sync 消费 ref 页已尝试并回退**：直接切到 ref 页会使 root 的 `notificationSync`（原生 Pod 行在长轮询内被通知、
尚无登记 ref 时需被索引）与 `syncChangeSource`（每次两趟读取计数）失败——原生 hinted/full reconcile 与 C2 权威
状态尚未实现，故按设计保留后续步骤，未削弱 root 测试。**下一步**：在 root C2 最小指令就绪后实现
`sync` 消费 ref 页 + native hint 登记/reconcile，使 `cursorIncrementalReads.acceptance.test.ts` 与
`notificationSync` 同时通过；随后 durable paged reconcile checkpoint、receiver 页 CAS、W2-W5/G01-G12。

### 9.11 cursor journal 原子发布修正（2026-10-03）— 更正 §9.10

更正：§9.10 声称 SQLite 分支“走实际事务语义”**不准确**。此前 SQLite 分支只是 `await apply(this.db)`，无事务；
若 exact-ref INSERT 被 trigger abort，legacy event 行仍可见（root 负例 `root-cursor-journal-publication-before2.log`：
sequence=1，期望 0）。

本次修正（`MatrixEventJournal.ts`）：
- SQLite：`insertReferenceSqlite` 使用**同一连接上的同步事务语句** `BEGIN IMMEDIATE … COMMIT`（`db.run`/`db.all`
  同步、块内无 await，不可被打断）；legacy event 行与 exact ref 行一起提交或一起回滚。PG 分支保留
  `LOCK TABLE … SHARE ROW EXCLUSIVE` + 单事务。
- 新增 `getPublishedReferenceWatermark(scope)`（接口/内存/SQL/Pod）：只取 `xpod_matrix_event_refs` 的
  `MAX(sequence)`；legacy event-only 登记（`registerEvent` 无 exact ref）**不**提升该水位，避免 feed token 越过
  未发布的精确 ref。
- 内存 `registerReference` 改为**同步临界区**：先领 sequence、写入 ref，再发布 high watermark，读者不可能看到
  水位而对应 ref 尚未可见。
- 新增 tracked 回归：`getPublishedReferenceWatermark` 只随完整 exact ref 提升（legacy-only 不提升）。

门禁（真实退出码）：`build:ts` 0、`typecheck:test` 0；**root `tests/api/matrix/cursorJournal.acceptance.test.ts`
（9 项）全部通过**；`MatrixEventJournal.cursor.test.ts` 7、`PodMatrixEventJournal.test.ts` 5。

**下一步（未完成）**：正常增量 `sync` 消费固定 `publishedWatermark through` 的 ref 页 + public `db.findByIri`、
selected-unique Chat 读取、C2 `readRoomAuthority` 端口与 canonical `Chat.participants` join/leave 维护、
invite/leave 分页、native hint 登记与 durable paged reconcile；随后 W2-W5/G01-G12。`cursorIncrementalReads` 与
`notificationSync`/`syncChangeSource` 需在完整 sync+C2 后同时通过；root 的 `syncChangeSource.selects()` 是实现计数，
待 root 转为 bounded-read 断言。

### 9.12 cursor journal 并发/legacy 边界 + 正常 ref 页 sync（2026-10-03）

**journal（root 13 项验收全绿）**
- 并发同逻辑事件：SQLite ref INSERT 加 `ON CONFLICT (scope,room_id,event_id) DO NOTHING`，16 路并发全部返回**已存首条 ref**，无唯一约束错误。
- legacy-behind-ack：`registerReference` 计算 `sequence = max(eventSequence, publishedReferenceWatermark + 1)`（内存/PG/SQLite 一致），晚发现的 legacy `registerEvent` 行不会发布在已确认水位之后；`getPublishedReferenceWatermark` 只取 refs 的 MAX。
- SQLite 原子发布（`BEGIN IMMEDIATE … COMMIT` 同步块）与 trigger rollback、close/reopen epoch 稳定均通过 root 测试。

**sync 正常 ref 页（部分）**
- `syncOnce`：受限房间且 `since>0` 时走 `syncFromReferences` —— 固定 `publishedReferenceWatermark through`，`listReferences(after,through,limit+1)`，selected 逐个 `db.findByIri`（fallback 派生 id `findById`），未解析 fail closed；`state.events=[]`；`next_batch`=最后成功处理的 ref sequence。无 `listEvents/listRooms/resolvedState/requireJoined`。
- 无已发布 ref（原生 Pod 写入尚未登记）时**回退**到有界历史路径，原生行仍被发现。
- 结果：root `notificationSync.test.ts` **全部通过**（原生行在长轮询内被索引后 ack；无 quiet 全量读）；`cursorIncrementalReads` 首个「delivers a page of new events / ZERO listEvents」通过。

**仍未通过（root 独立计 5）**
- `cursorIncrementalReads.acceptance.test.ts`：固定 backlog 快照 limit=1/7/20 + 8 天晚到旧事件的分页回填、以及 epoch 改变时拒绝旧 token —— 需要不透明 token（version+epoch+through+position）与分页回填；当前 token 仍 `v2_<seq>`。
- `syncChangeSource.test.ts`「reads only the room the source names」：root 标注为**实现计数**（`selects()===4`），待 root 转为 bounded-read 断言；B 不修改 root 断言。

门禁：`build:ts` 0、`typecheck:test` 0、root cursorJournal 13/13；`tests/api/matrix` 688 passed / 3 skipped，5 项失败均为上述 cursor/计数项。

### 9.13 正常增量 cursor + 原生回退（2026-10-03）

按 root B35 bounded slice 实现（`PodMatrixStore.ts`）：

1. **不透明 token** `v3.<epoch>.<through>.<position>`（`encodeSyncCursor`/`parseSyncCursor`）：校验 epoch 与当前
   `journal.getEpoch` 一致，否则显式 `M_UNKNOWN_POS` 要求 resync；through/position 为有限安全整数；token 大小
   与历史/事件 id 无关（≤1024）。`sync`/`syncOnce` 同时兼容 v2 数值 token。
2. **单一 scope ref 页**：`syncFromCursor` 每次只读 `listReferences(after=position, through, limit+1)`，不按
   notification rooms 循环；空 room hints 不再过滤 backlog。remaining backlog 时保留原固定 `through`；到达
   `through` 后下一次 poll 才扩展到新的 published watermark。`next_batch`=最后成功处理的 ref sequence。
3. **精确 IRI 唯一**：selected ref 必须有 `messageIri`，只用 public `db.findByIri(messageResource, iri)`；未解析
   fail closed（整页拒绝、不 settle hints）。**移除了派生 id/`findById` fallback。**
4. **canonical owner Chat 校验**：selected unique room 读取精确 Chat，校验 protocol `roomId` 与 `author===context.webId`；
   未知/不可读/非本人 fail closed（远端 C2 读端口为后续步骤，暂不盲信 mirror）。
5. **原生回退保留**：无已发布 ref（原生写入尚未登记）时 `syncFromCursor` 返回 undefined，回落既有有界历史路径；
   `notificationSync` 行为（长轮询内原生行被索引后 ack、无 quiet 全量读）保持。

**root 独立测试结果**（真实退出码）：
- `cursorJournal.acceptance.test.ts` **13/13**、`cursorIncrementalReads.acceptance.test.ts` **6/6**、
  `notificationSync.test.ts` **4/4**、`syncChangeSource.test.ts` **6/6**（共 29 全过）。
- `build:ts` 0、`typecheck:test` 0。
- `tests/api/matrix` **693 passed / 3 skipped**，仅 `scaleOperations.test.ts`「reads every room once per sync pass,
  which is the part that is not bounded」失败：它断言旧的**非有界**行为（增量 select 数 =2*(rooms+1)=102），
  新实现正确为 0 历史读。按 root 指示这是**实现计数**，待 root 转为 bounded-read 断言；B 未修改该断言。

**后续**：C2 `readRoomAuthority` 读端口、canonical `Chat.participants` join/leave 维护、native hint/durable paged
reconcile checkpoint、receiver CAS、G09/W2-W5/G01-G12 与最终全量门禁。

### 9.14 v3-only sync cursor 严格校验（2026-10-03）

- `parseSyncCursor`：提供 token 时**只接受** `v3.<epoch>.<through>.<position>`；长度 >128、非 v3（含 legacy
  `v2_n`）、position>through、非有限安全非负整数一律 `M_UNKNOWN_POS` 显式要求 resync，**不再静默退化为初始
  历史**。无 token 才 bootstrap。`sync`/`syncOnce` 均使用该解析；`listMessages` 仍保留自身旧 token。
- `syncOnce` limit 校验：提供时必须为有限正安全整数，否则 `M_INVALID_PARAM`；上限 1000。
- journal `MAX_REFERENCE_PAGE` 提高到 4096，使 `limit=1000` 的 `limit+1` look-ahead 不被截断，`hasMore` 判定正确。
- tracked 回归 `tests/api/matrix/syncCursorToken.test.ts`（4 项）：v3 bootstrap 格式/长度、拒绝 v2/畸形/超长、
  拒绝非法 limit、limit+1 look-ahead。

门禁（真实退出码）：`build:ts` 0、`typecheck:test` 0、`syncCursorToken` 4 + root `cursorJournal` 13 全过；
锁定四文件（journal/cursorIncremental/notificationSync/syncChangeSource）此前 **29/29**。

**联系到新 root 验收**：`cursorIncrementalReads` 新增「delivers a page…」（全量套件运行时偶发失败，focused 通过）与
「does not discard an undiscovered native append while delivering a known reference」（lost-hint）。后者要求：原生
document/room hint 必须在**实际读到并发布精确 ref 后**才能 ack；`scaleOperations` 旧「非有界」计数需 root 转换。
**items 2–4 未完成**：移除重复 `syncOnce` hydration（与原生发现耦合，单独移除会破坏 `notificationSync`）、
documentChanges/reconcileRooms 的真实有界发现与 checkpoint/CAS。这些需要 root tracker 的精确 document-read 契约；
我未猜测实现（避免错误代码），保持既有锁定测试绿。

### 9.15 B37/B38 discovery 尝试与当前失败边界（2026-10-03）

- 已交付并保持绿：v3-only cursor 严格校验（§9.14）、`tests/api/matrix/syncCursorToken.test.ts`、
  fixture `select` 增加真实的 where/orderBy/limit/whereCursor 语义 + tracked 回归
  `tests/helpers/MatrixMemoryDatabase.select.test.ts`。
- 尝试实现 B38 discovery（`discoverRoomReferences` + 单次 hydrate + 显式 ack）并接线；局部使
  `cursorIncrementalReads`「delivers a page」的重复 hydration（40→20 次精确读）通过，但同时破坏
  `notificationSync`（原生 append 长轮询索引）与 `syncChangeSource` 全量读语义，故**回退**该接线，
  保留既有行为测试绿。删除未完成的 `discoverRoomReferences` 猜测实现，未交付错误代码。
- 当前 `tests/api/matrix`：**697 passed / 3 skipped / 5 failed**（全部为 root cursor/scale 验收的确定性目标）：
  - `cursorIncrementalReads` 2：正常 ref 页的**单次精确 hydrate**（当前重复 `syncOnce` 导致 40 vs 20）与
    **lost-hint**（原生未发布 ref 前不 ack）。
  - `scaleOperations` 3：10/200/1000 rooms 增量期望 **2 次精确读**（1 Chat + 1 事件），当前 4（重复 hydration）。
- `typecheck:test` 0、`build:ts` 0；journal 13、notificationSync 4、syncChangeSource 6、syncCursorToken 4 仍绿。

**结论**：B38 的 discovery/单次 hydrate 尚未完成，且与原生 ack 语义耦合；下一步应以
`discoverRoomReferences`（`db.select...where(parent=ChatIRI).orderBy(createdAt,id).limit` + `resolveRowSubject`）
为核心，正确实现「发现发布 ref → 单次固定窗口 hydrate → 仅 ack 已完成 hint」，再放开重复 `syncOnce`。

### 9.16 B39 discovery 精确诊断（2026-10-03）

alias linkTable cycle 修复后再次接入 discovery + 单次 hydrate（`cursor && !full` 分支，先 `discoverRoomReferences`
发布 ref，再单次 `syncOnce`）。实测 `scaleOperations` 仍为 4 次精确读而非 2；加入临时探针（已移除）显示：**在同一次
被测量的 `sync` 内 `syncFromCursor` 被调用了两次**（相同 pos/through/refs=1），即 `sync` 的外层 `read→while`
循环对 cursor 响应判定为「无新闻」而重读一次。这是外层长轮询与 cursor 响应的耦合点，需修正 `hasSyncNews`/循环
判定后才能让单次 hydrate 生效。为避免交付重复读回归，该接线再次回退；保留 v3-only token、fixture select 语义
与 tracked 回归。确认根因后即可完成 B38/B39 的 discovery 切片。

### 9.17 B41 durable reconcile checkpoint + atomic reference-page CAS（2026-10-03）

Bounded scope: `src/api/matrix/MatrixEventJournal.ts` + `PodMatrixEventJournal.ts` 及其新测试，未触碰
`PodMatrixStore`/fixture/通知/root 验收/Handler/locks/config/依赖补丁，未跑 runtime/Docker。

设计（root `cursor-incremental-approved-design.md` step4）：
- 新契约 `MatrixReconcileCheckpoint`（scope/sourceUri/epoch/scanGeneration/revision/view/
  roomCursor/bucketCursor/lastCreatedAt/lastId/startedAt/lastCompletedAt）、`BeginMatrixReconcileScan`、
  `MatrixReconcileScanCursor`、`MatrixReferencePage`/`Result`，并导出 `validateReconcileSourceUri`
  （绝对 HTTP(S)、无凭据/query/fragment）。
- `beginReconcileScan`：开启/重置一个从历史起点开始的新 generation；传入 `epoch` 与当前不符即拒绝（stale）。
- `publishReferencePage`：**一个事务里**发布不可变 exact refs（首个 IRI/时间/sequence 不被覆盖）并 CAS
  推进 checkpoint；CAS 元组 `(scope, sourceUri, epoch, scanGeneration, revision)`。stale epoch 或丢失 CAS
  一律 `advanced:false` 且不写任何 ref；单页插入失败（如 trigger abort）整体回滚、checkpoint 不动。
- `complete:true` 轮转到新 generation 并从起点开始：丢弃 cursor（`createdAt` 不是永久 watermark，晚 8 天
  仍可发现）。页大小/计数做有限性校验，超 4096 页拒绝而非静默截断。
- SQLite 用既有 `BEGIN IMMEDIATE … COMMIT` 同步事务（跨连接写锁串行，两个消费者恰好一个 CAS 赢）；
  PostgreSQL 用 `SELECT … FOR UPDATE` + 事务。Memory 同样语义。Pod journal 委托给既有 operational journal，
  不引入新 Pod 凭据/控制记录。

新测试 `tests/api/matrix/MatrixEventJournal.checkpoint.test.ts`（memory + SQLite 双实现，共 **13**）：
CAS 推进/丢失 CAS 无写入、complete 轮转丢 cursor、stale epoch 拒绝、source URI 校验、超大页拒绝、
新连接重开持久 checkpoint、两独立连接同 CAS 仅一个 advance、SQLite trigger abort 整页回滚且 checkpoint 不变。

门禁（真实退出码，root-review 日志）：`build:ts` 0、`build` 0、`typecheck:test` 0；checkpoint 13、既有
journal 6+cursor 7+Pod journal 5+`cursorJournal.acceptance` 13+`syncCursorToken` 4+`notificationSync` 4+
`cursorNativePagination` 4 全绿（组合 **56 passed**）。全量 `tests/api/matrix` **717 passed / 1 failed /
3 skipped**；唯一失败 `PodMatrixStore.reliability.test.ts > drains backlog ... discovers late native writes`
属 root 正在进行的 Store/source 集成（`rooms.join[roomId]` 未产出），该路径不调用本 checkpoint API，
且 root 最后一次全量绿（`root-public-source-cursor-matrix.log` 706PASS）早于当前 scoped-source 改动，
非本次 journal 变更引入，交由集成 dispatch 处理。

### 9.18 B42 独立评审三处 journal 正确性修复（2026-10-03）

范围仍限 `MatrixEventJournal.ts` + `PodMatrixEventJournal.ts` + `MatrixEventJournal.checkpoint.test.ts`，未触碰
Store/helper/root 验收/通知/Handler/locks/config/patch/native fixture，未跑 runtime/Docker。

1. **epoch 必须在同一事务、加锁之后读取**：`publishReferencePage`/`beginReconcileScan` 原先把 `getEpoch`
   放在 `BEGIN IMMEDIATE` 之前，bump 与 await 间隙会导致旧 epoch 被使用。现在 SQLite 在 `BEGIN IMMEDIATE`
   之后用同步 `readEpochSqlite`（不存在则插入）读当前 epoch；PG 在事务内 `readEpochForUpdate`（`FOR UPDATE`，
   锁序恒为 epoch→checkpoint→events，无反向环）。新增确定性「读 epoch 后、拿锁前 bump」回归（memory+SQLite），
   stale 时 `advanced:false` 且零 ref；bump 后 checkpoint 视为不存在（SQLite 用 join epoch 行判定）。
2. **memory CAS 原子性**：原 `publishReferencePage` 在读取 checkpoint 与提交之间有 `await`，并发两页
   `advanced:[true,true]`。改为同步临界区（无 `await`，复用同步 `insertReference`），并保留 `(epoch,
   scanGeneration, revision)` CAS。新增 memory+SQLite 共用两消费者并发用例：恰好一个 `advanced:true`，败者零 ref。
3. **durable source cursor 契约**：`MatrixReconcileScanCursor` 改为 `{roomId?, bucket?, last?:{createdAt,
   sourceIri}}`，`last` 必须成对：`createdAt` 有限、`sourceIri` 为绝对完整 HTTP(S)、无凭据/query（允许
   source-appropriate fragment）；checkpoint 字段 `lastId` 更名为 `lastSourceIri`。校验在**任何写入之前**完成，
   非成对/非源 IRI/NaN/带 query 一律拒绝且 checkpoint 不动。room/bucket 粗边界可省略 `last`。
   测试 `pageAt` 改用真实源 IRI（`…/messages.ttl#<name>`），并新增负例说明 event id 不是 source key。

保留 firstIRI/time/sequence/published-watermark、trigger 整页回滚、reopen 持久、complete 轮转丢弃 cursor、
stale epoch 拒绝。门禁（真实退出码）：`build:ts` 0、`typecheck:test` 0；checkpoint **19**、journal 组合
（checkpoint+journal+cursor+Pod journal+cursorJournal 13+syncCursorToken 4+notificationSync 4+
cursorNativePagination 4+cursorIncrementalReads）**71 passed / 9 files**；全量 `tests/api/matrix`
**726 passed / 3 skipped / 0 failed**（root reliability fixture 修正后已绿）。全量 W2 未宣告完成。

### 9.19 B43 把 durable checkpoint/CAS 接入真实 source discovery（2026-10-03）

所有权转移后，本轮限 `PodMatrixStore.ts` 的 source discovery/sync 集成 + 新测试
`tests/api/matrix/sourceDiscoveryResume.test.ts` + 既有 journal 集成；未触碰
`MatrixMemoryDatabase`/root 验收/通知/Handler/locks/config/native fixture/依赖补丁，未跑 runtime/Docker。

**改动**：`discoverRoomReferences` 由「每次请求最多 128 页、逐条 registerReference」改为：
- 每次调用只读**一页**（固定 500）source（`roomDirectoryIri(scope,roomId)` 的 SPARQL 目录端点，公共 alias
  messageResource、`whereCursor` Date/完整 IRI、严格 parent/time/source/order 守卫——全部保留）。
- 用 `getReconcileCheckpoint(scope,directory)` 读持久 checkpoint；仅当缺失或 epoch 不符才
  `beginReconcileScan`（不每次重置未完成 checkpoint）。keyset 取自 `lastCreatedAt+lastSourceIri`。
- 整页先校验再 `publishReferencePage`：refs + `(createdAt,sourceIri)`（取最后一 **SOURCE** 行，即使全已知）
  + checkpoint 一步事务；短页=complete（轮转新 cycle 从起点）；满页=推进 keyset、房间不完成、保留 hint。
- CAS 失配（或 stale epoch）发布零 refs，返回 incomplete，保留 hint，绝不用 stale 页 settle；后端返回超页
  越界在发布前拒绝。partial room/full scope 的 notification 与 pending full-pass 时间戳保留；仅整房间 cycle
  完成才 ack。

**新回归**（`sourceDiscoveryResume.test.ts`，6）：>500 原生行跨页在下一 SOURCE 行续读且不重读前缀、complete
轮转丢弃 cursor；Store 重开（真实 SQLite journal）续跑未完成 checkpoint 并交付完整集合；第二 ref 触发
trigger ABORT → 零 ref、checkpoint 不动、hint 保留且去掉 trigger 后重试成功完整交付；两 source 消费者同
CAS 恰一个赢；complete/newcycle 后更早时间戳行仍可达；index-loss epoch bump 后需显式 resync、新 cycle 从
头开始。

**门禁**（真实退出码）：`build:ts` 0、`build` 0、`typecheck:test` 0；关键组合 8 文件 **68 passed**（含
sourceDiscoveryResume 6、cursorNativePagination 6、cursorIncrementalReads 9、notificationSync 4、
syncChangeSource、syncBoundedReads、cursorJournal 13、checkpoint 19）；全量 `tests/api/matrix`
**734 passed / 3 skipped / 0 failed / 82 files**。

**当前限制（交 root 下一 slice）**：exact-document fast path 与 all-history canonical C2 **尚未实现**；
source 仍按 room directory 分页（未做 per-document alias 快速路径）。未从本轮宣称 W2/全局完成。

### 9.20 B44 修复独立审查 2 项 MEDIUM（2026-10-03）

窄写范围：`MatrixEventJournal.ts`（+测试）。未新增 exact-doc 实现，未放宽 guards，未触碰
root 验收/fixtures/依赖补丁/notifications/Handler/locks/config，未跑 runtime/Docker。

**缺陷 1（未完成页可清空 cursor）**：`validateReferencePage` 原先允许 `complete:false` 且 `next` 缺失/`{}`，
随后 `advanceReconcileCheckpoint` 会清掉 cursor 并把 `revision` 加一，静默丢失源剩余项。现在：运行时明确校验
`last` 必须是 `{createdAt:finite number, sourceIri:绝对完整 HTTP(S)}` 成对；**未完成页**必须提供完整成对 keyset
或显式非空有效 `roomId`/`bucket` 边界，否则在任何写入前拒绝（refs/旧 cursor/revision 不变）。`complete:true`
才可整体轮转清 cursor。新增 Memory+SQLite 反例（既存 cursor 后 `next` 缺失 / `{}` / 半对）与合法边界（仅
`roomId`、不伪造 keyset）用例。

**缺陷 2（epoch race 测试未真正复现 SQLite 锁边界）**：原 `describe.each` 中的 RacyJournal 固定是 Memory
子类，SQLite case 实际测的是 Memory 实例，且 bump 在 `super` 前、不落在真实锁窗口。现在在真实 SQLite 块新增
两条：其一，第二连接在发布前 bump（独立连接），发布返回 `advanced:false`、零 ref、stale 后 checkpoint 视作
不存在；其二，hook 第一连接公开 `SqliteDatabase.run`，在首个 `BEGIN IMMEDIATE` 之前由第二连接提交 bump，
精确落在「读 epoch 与拿锁之间」窗口，发布同样 `advanced:false`、零 ref。hook 仅测试侧包装公开句柄，不侵入产品。
另加 `beginReconcileScan` 携带 stale epoch 在本连接 bump 后被拒、省略 token 则在新 epoch 下开启新 cycle 的
保护用例。SQLite `getReconcileCheckpoint` 现按 live epoch 内连接读取，使 epoch 丢失后旧 checkpoint 一致地
读作不存在。

**门禁**（真实退出码）：`build:ts` 0、`typecheck:test` 0；重点组合 8 文件 **75 passed**（checkpoint 27、
sourceDiscoveryResume 6、cursorNativePagination 6、cursorIncrementalReads 9、cursorJournal 13、
notificationSync 4、syncChangeSource、syncBoundedReads）；全量 `tests/api/matrix` **741 passed / 3 skipped /
0 failed / 82 files**。

**说明**：PostgreSQL 路径经类型/静态审查，本轮**未做并发实测**（无 PG 实例）；SQLite 两连接为真实并发验证。
按游标语义保持：客户端固定 window 首页 9/limit7、下一页剩 2 为正确，不跳未完成 window；服务端未完成源扫描
继续 persisted last SOURCE row，complete 后新 generation 从头补漏（旧时间补写可达），非永久时间水位。完整
integration/ChatKit/全链路仍归 root，本轮不宣称整体通过。

### 9.21 B45 执行 root `source-cycle-observation-design.md`（2026-10-03）

窄写范围：`PodMatrixStore.ts`、`MatrixEventJournal.ts`、`notifications/roomChangeTracker.ts`、source 接口类型、
`sourceCycleObservation.test.ts`（新）、`notifications/roomChangeTracker.test.ts`、checkpoint 测试、本证据文件。
未改 root 的 MatrixMemoryDatabase/root 验收/订阅/watchservice/Handler/locks/config/native fixture/依赖补丁，
未跑 runtime/Docker/fullintegration。

**先写回归**（`sourceCycleObservation.test.ts`）：dirtyv1 + 600 source → 首页 500 → 页间补一条 oldtimestamp 行 +
dirtyv2 → tail 完成旧 cycle；修复前 FAIL（v2 误清），修复后 PASS（v2 保留，下一 cycle 恰好一次交付 old 行）。

**实现**：
1. **cycle view**（journal）：`MatrixReferencePage.view?` + `MatrixReconcileCycleView{version:1, upper:{createdAt,
   sourceIri}|null, observation:string|null}` + `parseReconcileCycleView`。首 source 读前用同一 PUBLIC scoped
   alias `DESC(createdAt,id) LIMIT 1` 捕获 fixed upper（不用 Date.now）。`publishReferencePage` 首 CAS 原子绑定
   view：仅当 current 无 view 且无 source/room/bucket cursor 可绑定；已绑定则要求相等，否则零 ref/view/ack 失败；
   partial 保留 view；complete 轮转 generation 并清 view。
2. **Store discover**：每请求一页、`lower=persisted last SOURCE row`、`upper<=fixed upper`，one-500 page/time/
   fullIRI/whole-validation 保留；all-known 页仍推进 cursor。不再每次 begin/reset。完成时返回**绑定前的 cycle
   observation**（不是 latest pending），lost CAS 零效果保留 hint。
3. **sync 结算**：按每个完成 room 的**原 cycle observation** 分组结算，绝不用最新 pending 结算 resumed room；
   新 cycle 单页可结算当前 pending。`full:true` 仅在全部实际 room 完成且同一 observation 时清除 uncertainty；
   混合 old-cycle 保持保守，`lastFullPassAt` 同样只代表已验证 scope-cycle。无 observation 的 legacy 源保留按
   room 结算。
4. **tracker**：WeakMap 对象观察改为常量大小 HMAC 认证 token（canonical scope + random incarnation + lifecycle +
   revision cutoff + uncertainty），snapshot 接口 `string|object` 兼容。settle 只清 revision<=cutoff 的明确
   read room/doc；document-only 不清 room-wide reconcile marker；tampered/wrongscope/wrongincarnation/lifecycle/
   invalid cutoff 零清除。source 重启使旧 token 失效并保留新 untrusted；同 source 重启后可 verify。无新 config/
   dependency/authority。

**新回归**（共 32 条新增/修改）：cycle v1/v2 保留 + SQLite Store close-reopen 续跑、all-known 继续、双消费者
view CAS 一胜、rollback 保留 view/cursor、upper-bound（post-bound 下一 cycle 可达）、tracker token 常量大小/
tamper/wrongscope/reincarnation/document-only 不清 marker，及 journal 首绑+immutability+complete 清 view。

**门禁**（真实退出码）：`build:ts` 0、`build` 0、`typecheck:test` 0；重点组合 13 文件 **134 passed**（native6、
incremental9、journal13、notificationSync、syncChangeSource、syncBoundedReads、sourceDiscoveryResume6、
sourceCycleObservation6、checkpoint30、notifications）；全量 `tests/api/matrix` **755 passed / 3 skipped /
0 failed / 83 files**。

**限制**：PostgreSQL 路径仅静态/类型审查，本轮**无 PG 并发实测**；SQLite 为真实并发验证。W2/C2/真实 user
Gateway/fullacceptance 仍 pending，本轮不宣称整体通过。上游 DateTimeHelpers 秒/毫秒精度补丁归 root（未触碰）。

### 9.22 B46 source-bound canonical room identity（纯 adapter，未接入，2026-10-03）

本轮为 W2/C2 source authority 的**独立 slice**，仅新增 `src/api/matrix/canonicalRoomIdentity.ts` 与
`tests/api/matrix/canonicalRoomIdentity.test.ts`；**冻结**的 `PodMatrixStore.ts`/`MatrixEventJournal.ts`/
`notifications/roomChangeTracker.ts` 本轮未改（等 root 审核 B45 三文件）；未改 `roomResources.ts`/`src/index.ts`，
未改 models/schema/依赖，未接入 Store，未运行 runtime/Docker/integration。

**编码**：`encodeSourceBoundRoomId(canonicalChatIri)` = `!c1_<base64url(UTF8 exact IRI)>:<URL.host>`，遵守
Matrix 官方 255 UTF-8 字节上限；超限显式拒绝，绝不 hash + SQL 映射。

**解码/校验**：`decodeSourceBoundRoomId` 对非 `!c1_` 返回显式 `{status:'not-source-bound'}`（legacy 不猜）；
对 malformed `!c1_` 抛错、永不 legacy fallback。严格项：base64url 正则、`TextDecoder(fatal)` 拒绝 invalid UTF8、
decode→re-encode exact 相等（防 padding/trailing bits）、suffix 必须 exact `URL.host`（含 port/IPv6 多冒号，按首个
冒号切分编码组件）、URL 必须 HTTP(S)、无凭据/query、`href===decoded` 规范形式。`validateCanonicalChatIri(iri,
registeredPod)` 用安装版 `chatResource.parseRef` + `chatResource.buildIri(registeredPod,{id:templateValues.key})`
做**权威 exact roundtrip**，不复制布局正则/日期规则，不返回 owner 推测；`registeredPodForChatIri` 取最长匹配
Pod 前缀。host suffix 仅路由提示，非 full WebID owner。

**TDD（17 测试，先 FAIL 后 PASS）**：同 layout key 不同 Pods → 不同 roomId；host 相同但不同 full WebID 不通过
Podownership；different registered root segment boundary 拒绝；port/IPv6 suffix；unicode key 规范编码；
`models.buildIri → encode → decode → parse → exact buildIri` 证明；padding/trailing bits/invalid UTF-8/alteredsuffix/
query(userinfo/host case)/unexpected fragment/non-Chat path/`c1` malformed/over-255；SQL index wipe 解码不依赖 SQL；
legacy 显式 not-source-bound。

**契约核对**：`parsePodResourceRef` 实际在 drizzle-solid 0.3.24（非 models），`buildId({key})` 不可用，
exact builder target 为 `{id:key}`；详见 `docs/issues/models-chat-canonical-authority.md` 新增缺口小节。**无需新增
models helper**。

**门禁**（真实退出码）：`build:ts` 0、`typecheck:test` 0、新纯测试 **17 passed**。按 slice 要求未重跑全 Matrix。

**报告**：模块**未接入** Store/room 创建/读取端口；**PG 未测**；当前 user Gateway **未验收**。C2/真实三 Pod
远程加入/owner 反例仍 pending，本 slice 不宣称 C2 完成。

### 9.23 B47 B46 复核整改 + committed-winner RDF 三项缺陷（2026-10-03）

所有权仅限 `canonicalRoomIdentity.ts` + 其测试、`PodMatrixStore.ts` 的 committed-winner RDF 校验 guard
（`readCommittedMessageFromPod` 区域）+ 其测试、窄 issue/证据文档。未改 Store 的
sync/discoverRoomReferences/create/join/leave、journal、roomChangeTracker、roomResources、index、root 的
Native12/Incremental9/Journal13 测试；未改依赖/model/schema；未运行 runtime/Docker/integration。

**先 TDD 复现（全部先 FAIL 后 PASS）**：

B46 复核 REQUEST CHANGES（`canonicalRoomIdentity.test.ts` +6，先 FAIL）：
1. **decode 未做 PUBLIC Chat 布局校验**：`https://pod-a.example/not-a-chat#evil`、合法 Chat 改 `#evil`、无
   `#this`、错文档名、`%ZZ`/`%FF`、空 query `?#this`、带 query 均被接受。现在 decode 复用单一
   `validateChatLayout`：strict HTTP(S)、`href===input`、无 userinfo/query（含空 query marker）、用 PUBLIC
   `chatResource` builder 推导布局后缀 + `parsePodResourceRef` 的 key 做**exact rebuild**，非 Chat path/意外
   fragment 在**编解码两个边界**都拒绝。encode 同样先走该 validator，不再产生“自身 decode 拒绝”的 ID。
   无硬编码/复制的 Chat 路径正则；推断出的 base 仅为**语法** base，不作 owner/登记权威。
2. **registered Pod 候选把 WebID 当 root**：原 `buildIri` 会把 `.../profile/card#me` 重写为 root 并被最长字符串
   选中。现在 `isCanonicalPodRoot` 要求严格 canonical HTTP(S) **root URL**（trailing slash、无 creds/query/
   fragment、无默认端口归一化意外、`href===input`），再做 origin + path-segment 边界 + 权威 exact builder
   比较；malformed 候选项跳过而非抛出。WebID 候选永不作为 root；同 host 不同 full WebID 不通过。

W1 stable-guard 三项 RDF 缺陷（`committedWinnerGuard.test.ts` +3，先 FAIL）：
3. **createdAt 同文本不同 datatype**：要求列 `dataType==='datetime'` 且字面量 datatype 为
   `xsd:dateTime`，再校验 value/protocol instant 相等；offset 合法值保留。
4. **inverse 边按 `quad.object.value` 匹配忽略 termType**：现在只有 `object.termType==='NamedNode'` 的边计入
   incoming identity；`<chat> wf:message "messageIRI"` 字面量拼写不再冒充，其他 chat 的字面量不误判为竞争者。
5. **重复 quad 被当 scalar multiple**：解析后用 `termToId(subject/predicate/object/graph)` 做全 term 去重，再算
   cardinality；重复同一 payload quad 合法，不同内容/scalar/inverse 真 IRI 仍拒绝，数组合法 mentions 保留。
   复用安装的 `n3` `termToId`，无新依赖、无 schema fork。

**门禁**（真实退出码）：`build:ts` 0、`typecheck:test` 0、`check-dependency-state` 0；
canonical 23、winner guard 13、conditional/eventIdentity 边界 7 文件 **67 passed**；
全量 `tests/api/matrix` **786 passed / 3 skipped / 0 failed / 84 files**（3 skip = `MatrixEventJournal.postgres`
无 PG 实例，独立于本改动）。

**报告**：仅 committed-winner guard 改变产品行为（纯 REST 读取校验），canonical 模块仍未接入 Store。**PG 未测**；
当前 user Gateway **未验收**。C2/真实三 Pod 远程加入/owner 反例仍 pending；root 最终 integration 为其独立证据，
非 B 验收。原 W0-W5/G01-G12 未完成。

### 9.24 B48 canonical read port（未接入）+ codec percent 加固（2026-10-03）

所有权仅限 `canonicalRoomIdentity.ts` + 其测试（新增 1 个 malformed percent 负例与 1 个 nested-root 正例）、
新 `canonicalRoomSource.ts` + 新聚焦测试、issue/证据文档。**冻结** `PodMatrixStore` 全部、journal/tracker/
roomResources/podAccess/common/types/index、root 的 Native12/Incremental9/Journal13/scale/winner/Nested 测试；
未运行 runtime/Docker/integration；未改依赖/model/schema。

**1) codec malformed percent 加固**：在既有 strict URL 校验器加通用 `%HH` 语法守卫（`%` 后必须两位十六进制），
base/root/key 一律生效，不改 rawIRI、不复制布局正则。测试：`https://a/alice/%ZZ/` 在 encode/decode/器/selector
全拒绝；编码后的 `%25ZZ` key（IID 值含引号前）仍合法；canonical root 的 port/IPv6/Unicode 保持通过。新增
nested-root 正例 `https://a/alice/.data/chat/tenant/`，证明 PUBLIC builder nested-root exact roundtrip（root
已修 drizzle 解析用最后布局出现）。codec 精确 proof 改用 PUBLIC builder 以 **raw key 段**重建，兼容编码 key。

**2) `canonicalRoomSource.ts`（未接入）**：`read(roomId,context)` 仅从严格 `!c1_` 解码取 source；legacy/未知
fail closed；仅 caller-session（`auth.type==='solid'` 且 `auth.webId===context.webId`，拒绝 service/task/错配，
在**任何网络读取前**）；registry `findByResourceIdentifier`+`findAllByWebId` 登记事实；source root 必须过严格
codec 且恰好一个 canonical root；source 作者完整 WebID 须登记拥有该精确 source Pod；**一次** caller-authenticated
GET（`redirect:error`、拒绝非 GET/非声明资源/3xx/最终 URL 不符/403/不可解析），捕获 Turtle；用既有 `n3` +
PUBLIC `chatResource.config.type`/列 `getPredicate/dataType` 做**窄 exact-shape proof**（精确 `rdf:type`、
一个 NamedNode 完整 URI author、participants、`metadata.protocols.matrix.roomId` 精确匹配、RDF set 去重）；
ORM 行 author 与 RDF 一致。返回 current facts（含非成员），不暴露事件。测试用真实公开 ORM+models TripleBuilder+N3，
HTTP transport 隔离。

**3) issue-first 精确形状**：先建 `docs/issues/drizzle-solid-canonical-chat-exact-shape.md`，记录
`mapPredicateObjectRows` 不强制 `rdf:type`、折叠 NamedNode/Literal、标量取首值；追加实测 `participants`
数组元素被序列化为**带引号字面量**（`effectiveType` 不认数组元素类型）。proof 因此接受安装模型的字面量 URI
形式（剥一层引号后须绝对 URI），拒绝非 URI 字面量。

**门禁**（真实退出码）：`build:ts` 0、`typecheck:test` 0、`check-dependency-state` 0；canonical **25**、
winner guard **14**、source **10**、sourceNative 12、syncChangeSource 6，聚焦 5 文件 **67 passed**。按设计
source **未使用**，未跑全 Matrix/integration。

**报告**：模块**未接入** Store/写/Agent 网关；**PG 未测**；C2 **部分**（仅 caller-session 读端口，无创建/本地
存储 helper/生产注入/3 Pod 验收）；当前 user Gateway **未验收**。后续同 B 集成新创建/本地 helper/当前成员/生产门禁。

### 9.25 B51 canonical source read port 角色命名空间更正 + 真实 ORM RDF 契约（2026-10-03）

所有权仅限 `src/api/matrix/canonicalRoomSource.ts`、`tests/api/matrix/canonicalRoomSource.test.ts`
（及其 codec 测试 `canonicalRoomIdentity.test.ts` 的核对）与本证据/issue 文档。**冻结** Store/journal/tracker/
rootSDK 测试/依赖补丁/runtime；未运行 server/fullintegration/Docker；未改 models/schema/依赖。source 模块
**仍未接入** 产品路径。源哈希（本 slice 收尾）：`canonicalRoomSource.ts` = `83fa806c…`、
`canonicalRoomSource.test.ts` = `b753741a…`（`canonicalRoomIdentity.ts` 与其测试未改）。

**根因（角色放置错误）**：§9.24 的读端口与测试把共享 `ChatMetadata.memberRoles` 当成
`protocols.matrix.memberRoles` 读取——**位置错误**。共享模型里 `memberRoles` 是 **root metadata** 事实
（`models/chat.schema.d.ts: ChatMetadata.memberRoles`），`protocols.matrix` 只承载协议字段（如 `roomId`）。
root 独立验收测试 `tests/api/matrix/canonicalSourceAuthority.acceptance.test.ts` 一直用 root 形状，且专门验证
「protocol 镜像不能提权」；B51 使读端口与主测试与之一致。

**读端口修正**（`canonicalRoomSource.ts`）：
1. `readMetadataFacts` 从 **public `metadata` 谓词的命名空间** 派生 root 键谓词（`<ns>memberRoles`、
   `<ns>protocols`），不再硬编码/复制 schema；`protocols.matrix.roomId` 与 root `memberRoles` **分开**读取。
2. root `memberRoles` 缺失视为「无显式角色」`{}`，**绝不**从缺失/本地权力级/历史提升默认角色；仅在
   `protocols.matrix.memberRoles` 里出现的角色**不被采纳**，不产生提权。
3. 角色键必须是绝对完整 HTTP(S) WebID，值必须 ∈ `owner/admin/member`，否则整条读 fail closed；重复/竞争
   的 root 角色边（>1）拒绝。
4. codec/transport 保持严格：唯一 `!c1_` 解码；source root 过严格 codec 且恰好一个 canonical root；
   仅 caller-session（`auth.type==='solid'`、`auth.webId===context.webId`）；**任何网络前**先归一化
   `string`/`URL.href`/`Request.url` 与实际方法（`init.method` 覆盖优先，其次 `Request.method`，否则 GET），
   非声明资源/非 GET 在发出请求前拒绝；`redirect:error`、保留 Request headers、单一 GET（成功后 sealed，
   失败也 sealed，SDK 重试/回退零网络副作用）；拒绝 3xx/`redirected`/空或不同的 final URL/403/不可解析。

**真实 ORM RDF 契约（更正 §9.24 第 3 点）**：root 官方的既有 `drizzle-solid@0.3.24` Bun 补丁已完整生效
（CJS 与 ESM 两套构建一致，实测同输出）：URI `participants`/`mentions` 数组元素现在是**独立 NamedNode**，
root metadata 的 `memberRoles`/`protocols` 是同一子主体的两个 JSON 字面量。因此读端只接受 NamedNode
participants（URI 形状的字面量、含自定义 datatype 的字面量一律拒绝），**不再**接受 §9.24 记录的“带引号字面量”
兼容路径。测试正例全部改为**真实公开 ORM（`drizzle` + models TripleBuilder）原样生成的 RDF**，仅用
`callerFetch` 合成传输；删除了 `withNamedNodeParticipants` 之类的 seam/改写/伪造行。§9.24 第 3 点的字面量
兼容描述作废，以本节为准（issue 文件同步记录）。

**测试**（`canonicalRoomSource.test.ts`，16 项，全部先 FAIL 后 PASS）：真实 ORM root 角色正例 + 单 GET；
legacy/未知/服务/错配认证在读前零网络（含 `callerFetchFor` 未被调用）；registry 负例零预取；redirect/
`redirected`/空或不同 final URL/403/不可解析；字面量与自定义 datatype participant、字面量 author、错 type、
竞争 author；RDF exact 重复按 set 去重但竞争真值拒绝；root 角色非法键/非法值/非对象与缺失即 `{}`；
**protocol 命名空间角色不提权**；root 角色字面量必须是 `xsd:json`（plain/custom/language 即使文本是 JSON 也拒绝）
且 present 的 JSON `null` 拒绝；`protocols` JSON 为 `null`/标量/数组/`matrix=null` 时返回 403（不再抛 TypeError）；
连续读的 root 角色降级与 participant 撤销（无缓存）；**Bob 作为 caller 经 BOB fetch 读 Alice source，且 exact
Alice full WebID 拥有登记 source**；非成员 caller 仍得已验证 facts（无 events）；**N3 parser baseIRI=source
document** 的相对 TTL 正例（`<#this>` 解析回 exact source；前置断言 fixture 确为相对）。`canonicalRoomIdentity.test.ts`
25 项保持通过（codec 未改）。

**门禁**（真实退出码，本工作区本 slice）：
| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `bunx vitest run canonicalRoomSource canonicalRoomIdentity committedWinnerGuard cursorNativePagination syncChangeSource` | 0 | 5 files / **73 passed**（source 16、codec 25、winner 14、Native 12、syncChangeSource 6） |
| `bunx vitest run tests/api/matrix/canonicalSourceAuthority.acceptance.test.ts`（root 验收，非本代理写） | 1 | **8 passed / 1 failed**；唯一失败为下述 root 夹具/契约冲突 |
| `bun run build:ts` | 0 | tsc 通过 |
| `bun run typecheck:test` | 0 | 测试类型检查通过 |
| `bun scripts/check-dependency-state.ts` | 0 | 补丁依赖与工作区构建一致 |

**更正（B52）：null-role 夹具冲突已由 root 修正、非产品缺陷**：B51 收尾时 root 用例
「rejects an explicit null role record instead of treating it as missing」曾失败，B51 按证据上报为夹具冲突。root
随后修正夹具：先由 public writer 生成真实 root 角色字面量，再**只把该对象替换为 typed JSON `"null"^^xsd:json`**，
使“显式 null”与“真缺失”在 RDF 中可区分。B51 读端的 `parseMemberRoles(null) → 403` 已正确处理，root
`canonicalSourceAuthority.acceptance.test.ts` 现 **9/9 PASS**（实跑）。当时 B51 报告的失败是**无效夹具**（它实际
测的是 true absence）；**真缺失仍必须是 `{}`**，不得改为拒绝。底层写入侧事实仍成立（`inline.js` 对 JS `null`
属性静默跳过，即 JS `null` 无法在 RDF 中表达为 present-null），已记入 issue 文件供 models 决策，不影响读端口。

**报告边界**：source 读端口**仍未接入** Store/写/Agent 网关；本 slice **未创建/未改** room 布局、本地
helper、生产注入；**PG 未测**；当前 user Gateway/G12 **未验收**；不宣称 C2/task 完成，root 后续验收后再做
产品集成。本代理**未改** Store/journal/tracker/rootSDK 测试/依赖补丁/runtime。

### 9.26 B52 same-body ORM agreement（source read step 4，2026-10-03）

所有权仅限 `src/api/matrix/canonicalRoomSource.ts`、`tests/api/matrix/canonicalRoomSource.test.ts` 与本节。
root 的 `canonicalSourceAuthority.acceptance.test.ts`（现 9 案）**冻结且已修正**，本代理只读不写。Store/journal/
tracker/common/SDK/patches/codec/runtime 未改；未激活产品路径；未跑 server/fullintegration/Docker。

**新增 step 4 校验（同一捕获读取，非第二次 fetch、非伪造 seam）**：RDF 窄 proof（term/cardinality 权威）通过后，
对**同一次** GET 的 ORM 行做 SAMEBODY agreement，全部通过才接受，任一 malformed 返回 403：
1. **participants**：ORM 行数组与 raw RDF participants 做**全 WebID 精确集合相等**（顺序无关；空集与缺失数组等价）。
2. **memberRoles**：ORM `metadata.memberRoles` 与 raw root 角色 map 深度相等（key 全 WebID、值 ∈ owner/admin/member、
   无多余/缺失；**真缺失两侧都是 `{}`**）。缺失与显式 `"null"^^xsd:json` 均由 raw proof 先行区分。
3. **protocols**：ORM `metadata.protocols.matrix.roomId` 必须等于请求/raw 已证明的 roomId。
只有 agreement 全部通过后才做 author ownership `findAllByWebId` 登记核对；raw RDF proof 保持 issue-linked
（ORM 会折叠 term/基数，故不以其为精确证据）。

**测试**（`canonicalRoomSource.test.ts` 现 19 项）：新增真实 public ORM 正例——empty/single/multiple
participants（空 participants 由 writer 省略谓词、与空 ORM 数组一致）、true-absent root roles → `{}`、
metadata 属性插入顺序（protocols 先 / memberRoles 先）不影响结果；保留 B51 的 datatype（plain/custom/language）、
protocol-null（403 非 TypeError）、present JSON-null、current role/降级、root namespace/镜像不提权、Bob caller、
单 GET、相对 TTL baseIRI 等全部用例。

**门禁**（真实退出码，本工作区本 slice）：
| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `bunx vitest run canonicalSourceAuthority(9) canonicalRoomSource(19) canonicalRoomIdentity(25) committedWinnerGuard(14) cursorNativePagination(12) syncChangeSource(6)` | 0 | 6 files / **85 passed** |
| `bun run build:ts` | 0 | tsc 通过 |
| `bun run typecheck:test` | 0 | 测试类型检查通过 |
| `bun scripts/check-dependency-state.ts` | 0 | 补丁依赖与工作区构建一致 |
| `git diff --check` | 0 | 无空白错误 |

源哈希（本 slice 收尾）：`canonicalRoomSource.ts` = `72c8bc7e…`、`canonicalRoomSource.test.ts` = `56d03267…`
（`canonicalRoomIdentity.ts` 与其测试未改）。

**报告边界**：本 slice 交付 **bounded read port**（仍 **UNUSED**，未接入 Store/写/Agent 网关，未做创建/本地
helper/生产注入/3 Pod 验收）；**PG 未测**；当前 user Gateway/G12 **未验收**；**不宣称 C2/task 完成**，root 下一步
成员关系设计只读、产品集成待 root 指派。


### 9.27 B53 creation ownership + exact local layout（2026-10-03，完成）

所有权：`src/api/matrix/canonicalRoomSource.ts`、`canonicalRoomIdentity.ts`、`roomResources.ts`、
`PodMatrixStore.createRoom` 与 storage-id helper/调用点/布局、`src/api/container/common.ts` 注入、
`tests/helpers/MatrixMemoryDatabase.ts` 及需要的 Matrix fixture、自有创建权威测试与本节。未改
journal/tracker/root SDK 测试/SDK/patches/models/storage/auth/controlrecords；未改 Store
discoverRoomReferences/sync AST 区域；未跑 server/Docker/fullintegration。源哈希（收尾）：
`canonicalRoomSource.ts`=`a136ce22…`、`canonicalRoomIdentity.ts`=`91d39cb4…`、`roomResources.ts`=`72929c66…`、
`PodMatrixStore.ts`=`7246ce95…`、`common.ts`=`21f3a57d…`、`MatrixMemoryDatabase.ts`=`592d47bc…`、
`canonicalCreationAuthority.test.ts`=`fd01dd29…`。

**实现**：
1. `CanonicalRoomSource.assertCreationOwner(sourceIri,context)`：caller-session only（`auth.type==='solid'` 且
   `auth.webId===context.webId`，拒 service/task）；**作者 WebID 必须是完整绝对 HTTP(S) 且无凭据、带 fragment**
   （**不要求 fragment**；否则任何效应前 403）；`findByResourceIdentifier` 取登记 Pod、恰好一个严格
   canonical root；`findAllByWebId(context.webId)` 证明完整 WebID 拥有该 root；返回 `{sourceRoot}`。**零网络**
   （不调 `callerFetchFor`、不 init、不 mint、不写）。
2. `canonicalChatResourceId(source,registeredScope)`：复用 codec 私有 `validateChatLayout.rawKey` +
   `validateCanonicalChatIri`，再由 public `chatResource.buildId({id:rawKey})` 并要求
   `chatResource.buildIri(scope,{id})===source`；percent key/嵌套 root 均精确。
3. `roomResources.ts`：`roomChatIri` 对 source-bound own source 返回**精确 decoded source**（`validateCanonicalChatIri`），
   foreign source 返回本地 hashed display copy，malformed `!c1_` 抛错；thread/messages 用 **actual local Chat
   parent**，删除 `layout.invalid`。
4. `PodMatrixStore.createRoom`：qualification 先于**任何副作用**（无 getDb/init/mint/write）；随机 storageKey →
   `chatResource.buildIri(scope,{id})` → `encodeSourceBoundRoomId`（255 字节，超限 400）；`podUrl` 必须等于返回的
   `sourceRoot`（不静默迁移）；author=caller、participants=[caller]、**root `metadata.memberRoles[caller]='owner'`**，
   不写 `protocols.matrix.members`；保留 protocol roomId/display metadata 与 setup events。
5. 精确本地寻址：`chatResourceId(roomId,scope)` 对 own source-bound 用 `canonicalChatResourceId`，否则 hashed；
   `findRoomSource` 对 source-bound **只认精确 source**，缺失即 404（hashed copy 不能冒充）；thread/message 用
   actual local Chat parent。
6. 生产注入：`common.ts` 用 `podLookupRepo` + `matrixPodWriteFor(context,ownerPodAccess).fetch` 构造
   `CanonicalRoomSource` 传入 store；registry 缺失则不注入 → 创建 fail closed。

**测试**：自有 `tests/api/matrix/canonicalCreationAuthority.test.ts`（8，真实 SQLite `PodLookupRepository`
登记 + 真实 public ORM Turtle + `CanonicalRoomSource.read` 回读）：精确 owner 正例零 fetch；session 不匹配/
service 拒；未知 Pod/同 host 不同 WebID 拒；非 canonical source 拒；不同 full WebID owner 拒（真 owner 接受）；
`canonicalChatResourceId` percent 精确 vs public buildId 解码差异；创建出的 source 经端口回读 author/participants/
root roles。fixtures：`canonicalSourceFor`/`canonicalSourceForOwners` 显式注册，harness 支持 `webId`/`podUrl`/
`canonicalSource`；`MatrixCollaboration`/`PodMatrixStore`/`eventIdentityIdempotency`/`roomStateCache`/`federation/
twoDeployment`/participant 三个 fixture 注入。

**门禁（真实退出码）**：
| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| root `canonicalCreationLayout.acceptance.test.ts`（9，root 冻结） | 0 | **9 passed**（baseline 7FAIL1PASS） |
| root `canonicalCreationAuthority.acceptance.test.ts`（12，root 冻结） | 0 | **12 passed** |
| 自有 `canonicalCreationAuthority.test.ts` | 0 | **8 passed** |
| 全量 `tests/api/matrix` | 0 | **88 files passed / 1 skipped；846 passed / 3 skipped（PG 条件跳过，非通过）** |
| `tests/api/container + tests/api/handlers + tests/http` | 0 | 50 files / **638 passed / 60 skipped** |
| handlers/owner/routes/identity-owner-boundary/authorization focused | 0 | 7 files / **132 passed** |
| `bun run build:ts` / `typecheck:test` / `check-dependency-state` / `git diff --check` | 0 / 0 / 0 / 0 | 全通过 |

**说明（host 语义已澄清）**：B53 早期把 `!c1_` host=Pod host 视为与 federation 冲突；实为**旧 fixture 假设**
（twoDeployment 把 Pod host 与 Matrix server 分开）。对齐后（Pod 由自身 server 提供）federation 16/16、participant
三文件 15/15 全绿，无需改冻结 federation 行为。room-id host 取 `URL.host`（Pod host）不变。

**报告边界**：read gates/成员/ACL lifecycle 未切换（本 slice 不激活 C2 权限）；**PG 未测**（3 skip）；当前
user Gateway/G05/G09/G12 **未验收**；**不宣称 C2/task 完成**。B53 交付 bounded creation ownership + exact layout；
root 下一步 membership 设计只读。

### 9.28 B54 B53 独立复核缺陷的三处修复（2026-10-03）

所有权：仅 `PodMatrixStore.ts` 的 `createRoom`/`findRoomSource` 与 `roomResources.ts` 的 `roomThreadIri`，及其
匹配单测与本节。未改 runtime/依赖/SDK/models/journal/tracker/source cursor AST/federation/storage/auth。源哈希：
`PodMatrixStore.ts`=`8dd11a63…`、`roomResources.ts`=`99259ec0…`。

**修复 1（genuine，HIGH：noncanonical scope 静默写成 hash mirror）**：此前 context `podUrl` 无尾斜杠、登记 root
有尾斜杠时，`normalizeRoot` 让校验通过，`canonicalChatResourceId(scope)` 返回 `null` 又被
`?? chatResource.buildId({id})` 兜底，于是 Chat `@id`/Thread.parent 落到 hash mirror。现在：
- 在 **getDb/ensureParticipantIdentity 之前**计算 `chatId = canonicalChatResourceId(sourceIri, scope)`，`null`
  直接 403（scope 不是严格 canonical Chat root），**删除 `?? buildId` 兜底**；
- 删除 `normalizeRoot`，改为 `scope !== sourceRoot` **精确**比较（缺尾斜杠等规范化不会静默移动 Pod）；
- 无任何副作用（不 init/fetch/identity/write）后才继续。
契合 root 冻结 `canonicalCreationAuthority.acceptance.test.ts` 第 13 案（注册 root 带斜杠、context 缺斜杠 → 403
零副作用）。

**修复 2（findRoomSource 二次查找导致 hash 冒充 own source）**：删除 `decoded`/`own`/`fallback` 分支，改为
**单一 `findById(chosenKey)`**（`chatResourceId` 已自行选择 exact own source 或 foreign/legacy hash）。own source
缺失即 404，绝不用 hashed copy 顶替。契合 root 冻结 `canonicalCreationLayout.acceptance.test.ts` 的 404 负例。

**修复 3（roomThreadIri 冗余分支）**：删除 source-bound 分支与已不用的 `canonicalChatResourceId` import，只保留
**一个** public `threadResource.buildIri(scope,{id:'thread', parent: roomChatIri(scope,roomId)})`，parent 即 actual
local Chat。

**测试**：未改 root 冻结文件。自有 `canonicalCreationAuthority.test.ts`(8)、`canonicalRoomSource.test.ts`(19)、
`canonicalRoomIdentity.test.ts`(25) 保持通过。

**额外授权 fixture 更正（`participantIdentity.test.ts`）**：上游复核用默认 Pod `https://pod.example/alice/`、
Alice/Bob WebID host `alice.example`/`bob.example` 证明 publishedKey 可验签 create/join，说明该文件 4 处
cohost `podUrl` override 不必要。已恢复默认 Pod（4 个 harness），Carol 的注册 Pod root 恢复为默认
`https://pod.example/alice/`，并**仅把旧「roomId host === participant 服务器名」断言**改为
`decodeSourceBoundRoomId(room.roomId).canonicalChatIri === chatResource.buildIri(context.podUrl,{id:实际持久化Chat.id})`；
账户/签名/成员断言保留，删除过时的「room named deployment」注释。源哈希 `participantIdentity.test.ts`=`08458d51…`。

**门禁（真实退出码）**：
| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| root `canonicalCreationAuthority.acceptance.test.ts`(13)+`canonicalCreationLayout.acceptance.test.ts`(9) | 0 | **22 passed** |
| 目标 6 文件（root creation13/layout9 + own creation8/codec25/source19/participantIdentity4） | 0 | **78 passed** |
| 聚焦 6 文件（own creation8/codec25/source19/sourceAuthority9/winner14/syncChange6） | 0 | **81 passed** |
| 全量 `tests/api/matrix` | 0 | **88 files passed / 1 skipped；847 passed / 3 skipped（PG 条件跳过，非通过）** |
| `bun run build:ts` / `typecheck:test` / `check-dependency-state` / `git diff --check` | 0/0/0/0 | 全通过 |

**边界**：仍**未激活 C2 当前权威读闸/成员/ACL lifecycle**；无 runtime/fullintegration；root 后续运行。**不宣称
C2/task 完成**。下一 scope 为 source-server conditional ACL primitive（待 root 冻结/完成 fullintegration）。
