# Matrix 协作：决策登记册

更新：2026-09-26。状态：**目标已确定，分布式实现与验收尚未完成**。

本文登记目标决定、实现状态与尚需细化的机制。不能从当前单 Pod adapter 的局限反推产品边界。
实现契约见 [协作设计](matrix-collaboration-design.md) 与
[Pod 存储契约](matrix-pod-storage-portability.md)，历史证据见
[验收记录](matrix-collaboration-acceptance.md)。

## 状态规则

- **已定**：用户已明确或既有项目规则确定的目标；实现尚缺不构成重新打开目标的理由。
- **待细化**：目标不变，需选择具体机制、补齐故障处理及验收。
- **现状**：已存在的代码行为，不等于被接受的目标或已通过目标验收。
- **已撤销**：旧前提不再约束后续实现，保留原因供追溯。

## 已定目标与实现差距

| 决定 | 依据 | 实现状态 / 证据边界 |
| --- | --- | --- |
| 实现 Matrix 分布式房间与事件语义，参与者数据持久化到各自 Pod | 用户 2026-09-25 明确目标，2026-09-26 授权修订 | 当前是单 Pod Client–Server adapter，分布式能力待实现 |
| 一个逻辑房间、稳定 room/event 身份，事件复制不改变身份 | Matrix 协议；用户确认 | URI 派生 event_id 的旧提案撤销；需补协议事件模型及迁移 |
| Pod 保存消息、同步/投递进度、事务记录及必要执行凭证 | 用户确认存储归属 | 旧 SQL journal 待迁移移除，不能作为长期权威或回退路径 |
| Solid Chat 是共享消息表达，协议事件的验证材料必须无损保存 | 项目 models 归属规则；Matrix 验证要求 | 当前 Message 投影不等于完整可验证 PDU |
| Pod 资源 URI 是持久资源地址，不是浏览器缓存 | 用户 2026-09-26 澄清要求 | 不要求浏览器缓存、额外镜像库或独立映射表 |
| 副本接收不自动获得 Agent 执行权 | 多智能体执行正确性要求 | 需将本地 URI 去重改为稳定逻辑触发与明确执行归属 |
| 去重、同步和执行证明职责分开，持久事实均在 Pod | 用户确认；存储契约 | 本地加速状态必须可重建，不能是唯一持有者 |
| 当前阶段停用跨请求 allow/deny 判定缓存，只保留请求内复用 | 本轮授权修复方向；用户授权按审查修订 | 当前 fresh 标记仅绕过部分路径，停用尚未完成；不能记作全局修复完成 |

Matrix 原生按参与房间的 homeserver 复制事件，一个 homeserver 可以服务多个用户；不把
“每个用户一个 homeserver”当作协议要求。Xpod 将各参与者的持久数据落其 Pod，具体服务
身份、部署与 Pod 的对应关系需要落实，但跨 Pod 分发本身已在目标范围。

## 签名身份与密钥归属（2026-09-27 讨论，按参与者身份登记）

- **签名主体是参与者身份，不是部署**：数据在各自 Pod、控制记录在房间主 Pod，因此不存在部署级
  homeserver；server name 取参与者的稳定域名（不是 Pod 地址、也不是部署域名），MXID 形如
  `@<localpart>:<参与者域名>`。Pod 迁移不改 MXID、room_id、event_id。
- **私钥以密文存于该身份自己的 Pod**，通过 Pod API 读写：复用 models 已有的 `credential` 资源
  字段（`secretPayload`/`encryptedSecret`/`wrappedDataKey`/`algorithm`/`keyVersion`/`status`/
  `expiresAt`）与既有 `SecretCellVault` + `DeploymentRootKeyProvider`（根密钥本身支持多 keyId +
  activeKeyId）。**公钥明文**，由 `/_matrix/key/v2/server` 按身份发布。
- 签名服务端读取后内存缓存，按 `keyVersion`/etag 失效；轮换两阶段：先发布新公钥 → 切 active →
  旧 key 保留到 `expiresAt` 之后再移除。每把 key 不需要环境变量；env 只保留部署根密钥与显式 PEM
  兜底（宿主没有原生 JWKS 时）。
- **明确不做**：明文私钥写进 RDF/metadata；把某把能被用来冒充他人或整个部署的私钥放进别人的 Pod。
- 现状实现（部署级单一 `serverName` + `MatrixServiceIdentity`）不再是目标形态，只作为
  **旧房间兼容边界**保留，迁移按 D5 处理；新签名身份上线前必须先定这两者的边界。

边界（上线前必须先定的两件事，2026-09-27 记录）：

1. **server name = 参与者 WebID 的 host**，不是 Pod 地址、也不是部署域名。Pod 换地址/换节点
   不改 MXID、room_id、event_id；换 WebID 域才是换身份。
2. **一个 server name 一把签名身份，事件只能由 `sender` 所属 server 的密钥签名**。本部署没有
   该 server name 的密钥时**必须拒绝写入**（`identityRegistry.ts` 已实现：只认自己注册过的
   server name，没注册就报错），不得用别的密钥代签——代签会让验签方无法区分它与伪造。
3. **一个房间跨多个 server 是正常 Matrix 语义**，不需要"整房间迁移"：历史事件的 `sender` 与
   签名是历史事实，不回写、不重签。
4. **per-participant server name 与 `m.federate: false` 互相约束**：v11 授权规则第 3 条会拒绝
   非创建者 server 的事件，因此开启每参与者身份必须同时让房间可联邦。已改：缺省即 federated，
   只有显式传 `false` 才写 `m.federate: false`；仍写 false 的房间只能容纳同一 server 的参与者，
   属兼容边界而非目标形态。
5. **仍需你定的一个子问题**：切换 server name 会改变 MXID，而房间里的 `sender`/`state_key` 是
   历史事实不能改写，所以"老房间继续用老身份、新房间用新身份"需要把房间所属的 server name
   记在房间里（候选位置 `metadata.protocols.matrix.serverName`）。上传 per-participant 身份前
   需要先定这条记录位置与切换规则，否则同一个人的新老 MXID 会在同一房间里并存而不互认。

实现进度：

- **已落地**（2026-09-27）：签名身份注册表（`identityRegistry.ts`）与事件按 `sender` 所属
  server 选身份；写入路径经 `signingIdentity(context)` 取身份，未注册的 server name 直接失败。
  容器把现有部署级身份注册为其自身 server name 下的默认身份（行为不变），为每参与者密钥铺路。
- **已落地**（2026-09-27）：key set 状态机与两阶段轮换、`/_matrix/key/v2/server` 的发布投影
  （active + staged 进 `verify_keys`；retired 进 `old_verify_keys`，`expired_ts` = 停止使用时
  刻，保留窗口过后 `prune` 移除）、secret-cell 封装的存储层与内存缓存 provider
  （版本一致则复用，读取失败绝不回退生成新 key）。见 `protocol/signingKeys.ts`、
  `signingKeyStore.ts`，测试 `tests/api/matrix/protocol/signingKeys.test.ts`、
  `tests/api/matrix/signingKeyStore.test.ts`。
- **已落地**（2026-09-27）：密文落 Pod 的传输层 `signingKeyChannel.ts` —— 该身份自己 Pod 的
  一条 `credential` 行承载 secret-cell 信封；行上另记只读的描述列（`service: matrix`、
  server name、信封算法与 root keyId）便于运维识别与轮换，**信封本身仍是字节的唯一来源**，
  且该层永远看不到明文私钥。`createPodSigningKeyDb` 用 drizzle-solid 绑定该身份的 Pod
  （fetch 必须已带该身份授权；拿不到 Pod 访问权即拒绝）。测试覆盖：读写同一行（第二次写是
  update）、只存密文、跨进程重启后读到同一身份、轮换写回同一行且旧 key 仍可验、换部署根密钥
  打不开时**响亮失败且不覆盖原行**、无 Pod 访问权即拒绝。
- **待接线**：把每参与者 provider 注册进注册表还缺一件已定但未建的持久事实——
  **server name → 身份 Pod 绑定**（服务身份契约 §2.2 第 4 步要求绑定落用户选定的 Pod），
  以及随后的 `getServerName` 翻转（现在仍是部署域名优先）与上面第 5 条的房间级 server name
  记录位置。三件要一起上，否则会在没有对应密钥时签名失败或错签。

## 消息身份与表示

- Matrix event_id 按所选 room version 的协议规则生成/验证，跨部署和 Pod 副本保持一致。
  当前讨论的 room version 11 使用事件 reference hash，不用 Pod URI hash 代替。
- Message 继续使用 models 定义的父关系、日期分桶、作者、正文和回复关系。不同 Pod 中的
  存储 URI 可不同；这不产生新的协议事件身份，也不授权重写签名事件内的引用。
- 需要能从 event_id 查找相应持久事件，但具体表达可采用 schema 中的协议标识、可推导资源
  地址或可重建索引；**不预设必须有独立映射表**。持久可查询字段由 models 定义。
- 不为 Matrix 改写共享消息布局。原始事件验证所需内容、图关系、签名等的持久表达另按
  models 规则确定；不能只保存展示正文而丢掉协议事实。
- 旧随机 event_id 按兼容边界保留，不宣称可直接升级为合法 federation 事件；旧房间导入或
  新建协议房间的迁移过程须明确，不能悄悄重算并破坏已有引用。
- 三种派生值各有覆盖对象，不得混用：内容哈希覆盖事件（排除 `unsigned`/`signatures`/
  `hashes`/`event_id`）、reference hash 覆盖 redaction 后的事件（即 event_id）、签名覆盖
  redaction 后且去掉 `signatures`/`unsigned` 的对象。`event_id` 必须排除的理由与外部实现
  证据见[实现参考 §2.1](reference/matrix-event-hashes-and-signing.md)。已落地。
- 协议事件（含 `hashes`/`signatures`）作为事件本身持久到 Message 的
  `metadata.protocols.matrix.event`；作者 WebID、txnId 等应用簿记留在同一 metadata 的
  其他键上，不进入被签名的对象。已落地（`src/api/matrix/persistedEvent.ts`）。
- 事件在房间 DAG 中的位置（`prev_events` 前向极值点、`auth_events` 授权事件、`depth`）是
  事件的一部分，必须真实写入并签名，不得用占位值：写入 Pod 的事件要能被独立复核，且状态解析
  所需的依赖必须能从同一房间取回。规则与来源见[房间事件图](reference/matrix-room-event-graph.md)。
  已落地（`src/api/matrix/protocol/roomGraph.ts`），无悬挂引用有测试固定。
- 并发写同一房间可以分叉（Matrix 语义），下一个事件列出全部极值点即完成合并；分叉期间哪一侧
  状态获胜属于状态解析，本仓库尚未实现，本地顺序仍以 journal 序号为准，两者不得互相代替。
  **未落地**：状态解析与事件授权规则的执行。

## 三种同步各自承担什么

| 层次 | 职责 | 不可混淆的状态 |
| --- | --- | --- |
| homeserver 间同步 | 传输和验证事件、缺失事件获取、历史回填、状态解析 | 服务器交易/接收状态，不是客户端 since |
| 本部署到参与者 Pod | 按资格及历史可见性持久化已接受事件，恢复部分成功的投递 | 每个目的 Pod 的持久投递进度，不是一次服务器响应 |
| 客户端同步 | 从自己的 Pod 提供授权范围内增量及分页 | 客户端 token / 本地发布位置，不是跨服务器全局排序 |

三层通过稳定协议事件身份关联，所需持久记录全部在适当的 Pod。具体资源归属需细化并覆盖
部署重启、部分成功及重放；不得用身份 SQL 库补上唯一持久状态。

不要求全局单调序号，但替代发布日志的方案必须同时证明：晚到事件不漏、分页稳定、token
及查询量有界、状态变化可同步、清空本地派生状态后可恢复。已见 ID 集合本身不提供变更发现。

## 去重与可恢复提交

- 同一组固定、无新 blank node 的 RDF 三元组可以安全重放；这只是持久写入的条件性质，
  不是整个请求、事件发布或执行副作用天然幂等。
- 事务记录固定首次标识、时间、内容指纹及可恢复载荷。不同正文写入同一主体不会自动冲突，
  必须由事务/提交契约拒绝；不能用 INSERT DATA 的集合语义代替冲突检查。
- 客户端 txnId 重放按身份/设备及完整端点作用域处理，返回首次响应。它与远端交易去重、
  event_id 副本去重、Agent 执行去重是不同职责，不能共用一个含混的 key。
- If-None-Match: * 保护 HTTP 文档，不保护日期桶中的单条消息；可用于独立事务记录，
  但创建后的正文与发布恢复仍需定义。
- 事务记录与事件身份不得各说一套：event_id 由事件本身推导，因此**预占 id 时必须先构建
  事件**，并由事务记录持有该次构建的时间戳；重放（同 txnId、并发重试）一律采用记录里的
  时间戳与 id 重建事件，而不是采用本次请求自己的时间。`buildPersistedEvent` 对不一致的 id
  直接报错，避免同一事务写出两个事件身份。已落地（`reserveTransaction` /
  `eventForReservation`，并发 8 次同 txnId 只产生 1 个事件与 1 行）。
- 事务记录只有在**其输出从未写入 Pod** 时才可整体替换（含 id）：崩溃后由新执行接替时，
  新正文推导出新 id，记录必须改名为将要存在的事件；若旧 id 对应的事件已经存在，必须
  409 而不是覆盖。已落地（`MatrixEventJournal.replaceReservation`，in-memory 与 SQL 两个
  实现同步；对应崩溃恢复测试断言存储事件的 id 与记录一致）。
- 重放的三条分支要分清（位置已进入事件 ID，所以预占即固定位置）：①首次尝试已写入 → 直接按
  预占寻址读回返回，不重建；②首次尝试未写入且房间未前进 → 用记录里的时间戳与 id 重建；
  ③首次尝试未写入但房间已前进 → 记录钉住的 id 已无法推导，由本次尝试在当前位置重新预占。
  ③ 仅以「该事件确实不在 Pod」为前提，因此不产生孤儿事件；但若首个尝试只是很慢、随后落盘，
  就会形成分叉。已落地；**未知结果处理仍未定契约**，不得把 ③ 记作恰好一次。
  三条分支的实现见 `reserveEventTransaction` / `reservationInForce`。

## 授权与执行

Matrix 房间成员、power levels、事件授权链与状态解析按所选 room version 执行。Solid ACL
负责 Pod 资源访问，不能替代 Matrix 事件授权；Matrix 邀请也不意味着获得对方 Pod 写权限。

用户访问自己的 Pod 采用调用者权限；接收服务写入目的 Pod 使用其明确获授的能力，并校验
目的参与者的事件接收资格。不得借其他用户存量密钥或扩大调用者权限。

Matrix 的协议签名/事件验证与 Agent 的执行授权分别成立。执行证明不能被普通消息写入伪造；
收到有效 Matrix 事件也不等于获得工具执行权。逻辑执行由明确的执行归属处理，副本传播不得
额外生成独立执行。执行仍至少一次，工具以稳定操作标识幂等，不承诺跨网络分区恰好一次。

后续请求不得复用跨请求的旧 allow/deny；在途请求及断网期间是否允许新的外部副作用，需在
执行租约和授权新鲜度契约中单独规定，不能声称本地重新读取即可知道尚未收到的远端撤权。

实现进度与发现：

- **已落地**（2026-09-27）：room v11 事件授权规则实现为纯函数
  （`protocol/authRules.ts`，按规范条目编号注释，便于逐条对账），覆盖 create、
  auth_events 选取一致性、非联邦房间来源限制、成员全状态（join/invite/leave/ban/knock）、
  third_party_invite/restricted join 的**失败即拒绝**、state/message 的 power level 门槛、
  `@` 开头 state_key 限制、power_levels 变更的 9.1–9.10 全部检查。测试
  `tests/api/matrix/protocol/authRules.test.ts` 28 项。
- **发现的缺口（写入路径尚未启用这些规则的原因）**：Agent 结果事件的 `sender` 是 Agent 的
  MXID（`commitResult` 用 `job.agent` 派生），但本仓库从不为 Agent 追加 `m.room.member`，
  只按 grants 授权。因此一旦在写入路径按 v11 规则校验，Agent 消息会被 rule 5
  （sender 未 join）拒绝。两种可选收口，都属 D6「执行归属」范围，需先定：
  1. **让 Agent 成为房间成员**：建 grant 时同时写入 Agent 的成员事件；难点是 join 要求
     `sender == state_key`，需要 Agent 以自己身份完成 join（服务身份代签），或走 restricted
     join 的附加签名（本仓库尚未实现）；
  2. **sender 改为执行者**（已 join 的人类身份），Agent 只记录在
     `co.undefineds.execution.agent` 里：规则可通过，但 Agent 归属变成事件内容而非协议身份。
  在定之前，授权规则只作为**纯校验器**使用（入站事件校验、测试、后续状态解析），不在写入
  路径强制，避免把未定的归属语义固化进历史事件。
- **已落地**（2026-09-27）：room v11 的 **v2 状态解析**实现为纯函数
  （`protocol/stateResolution.ts`，五步算法按规范编号注释）：状态后置 `S′(E)`、unconflicted/
  conflicted 分类、auth chain 与 auth difference、reverse topological power ordering（含
  发送者 power 优先、时间与 event_id 决胜）、mainline ordering（含「位置越大越先」与
  「不引用 power levels = 位置 ∞」）、iterative auth checks（槽位缺失时回退到事件自身 auth
  events，且**不使用被 rejected 的条目**）。测试
  `tests/api/matrix/protocol/stateResolution.test.ts` 15 项，覆盖分叉收敛（ban 与自助 leave
  两个分支都收敛到 ban，与分支到达顺序无关）、并发 power_levels 变更的确定性、auth
  difference、以及 unconflicted 覆盖规则。
- **已接线**（2026-09-27）：`src/api/matrix/roomState.ts` 用 Pod 里已有的事件回放房间
  （按 `prev_events` 拓扑排序，父事件缺失的事件自成链起点），对**前向极值点**的状态集合调用
  `resolveState`，得到当前状态。已改为读解析后状态的位置：`requireJoined`（写入与读取的成员
  门禁）、`sync` 的邀请/离开/加入判定、`sync` 的 timeline 起始 state、`getMembers`、
  `getState`、`agentGrants`。对线性历史结果与旧的「序号最大」一致（全部既有测试不变），只在
  分叉时不同：测试注入「ALICE 封禁 BOB」与「BOB 重新加入（序号更靠后）」两个分支，解析结果
  取 ban，因而 BOB 发消息被 403，即使本地顺序上最后的成员事件是 join。
- **待收口**：`requireJoined` 等在没有现成事件列表时的回退路径仍用单槽位 Pod 读
  （`findLatestStateEvent`），未走解析；解析目前每次调用 O(事件数 × 状态数)，未来需要按房间
  缓存或增量重放。写入路径强制执行授权规则仍等 D6 定案。

## 已撤销或否决的前提

| 前提 | 处置依据 |
| --- | --- |
| 房间事实只能存在一个共享 Pod，跨 Pod/federation 超出 V1 | 用户已明确分布式目标；单 Pod 是历史实现范围 |
| event_id 由每份 Pod Message URI hash 生成，或直接等于 URI | 副本地址不是协议身份；遵守 room version 的事件 ID 规则 |
| RDF 集合语义使消息冲突/提交恢复成为不存在的问题 | 仅固定三元组重放幂等，不保证唯一内容与完整提交 |
| 不要全局序号就能省去全部变更发现/发布机制 | 必须另证有界增量与恢复，而非只换 token 形状 |
| SQL journal 保留为长期权威；用行锁优化代替迁出 | 已确定 Pod 存储归属；SQL 仅在有界迁移阶段存在 |
| 给 claim/complete 加 fresh 标记就算授权缓存问题已解决 | 当前代码覆盖 agent-wakes 路由，但普通 Matrix 路径仍有旧判定窗口 |
| 签名身份由部署单一持有（现状实现） | 数据与控制记录都已按 Pod/房间归属，部署不再是 homeserver；部署级身份仅作旧房间兼容边界 |

## 待细化的实现事项

| 事项 | 必须产出的契约 |
| --- | --- |
| 协议服务身份与 Pod 归属 | MXID/WebID、server name、服务签名身份、参与者 Pod、执行 Agent 的关系及授权；草案见 [服务身份契约](matrix-service-identity-contract.md) |
| 完整事件与 Solid Chat 表示 | 原始事件验证材料、图关系与 room version 已落地（见[房间事件图](reference/matrix-room-event-graph.md)）；剩余：状态解析与事件授权规则、索引与旧房间迁移；共享 schema 归 models |
| 传输与落 Pod | 接收持久化、去重、确认、部分投递失败、补发与恢复各自的责任和进度 |
| 客户端增量 | 有界发现/分页、晚到事件、授权状态变化、token 版本与重建 |
| 可恢复事务 | 记录寻址、首次结果、载荷保留、发布、回收及未知结果处理 |
| Agent 执行 | 唯一逻辑触发、执行归属、接替、撤权、工具幂等与分区处理 |
| 验收 | 两个独立部署/身份/Pod 的真实互通和故障注入，见主设计；原单 Pod 测试只作回归基线 |

这些是实现待办，不重新讨论存不存 Pod、要不要跨 Pod，或共享 schema 是否归 models。
