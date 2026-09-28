# Solid 多方通信协议：改造清单

状态：**2026-09-28 起为落地清单**。设计以 [Solid 多方通信协议](solid-multiparty-protocol.md) 为准，
本文件只回答"现在这套代码怎么改、按什么顺序、验收口径怎么变"。每一项都是独立可验收的一刀，
**未动的项保持现状**（现有实现已验证，不做大爆炸式重写）。

## 一览

| # | 项 | 处置 | 影响面（依赖方） | 验收口径怎么变 |
| --- | --- | --- | --- | --- |
| 1 | 身份：MXID → **WebID** | 改 | 事件 `sender`/`state_key`、成员与角色键、`inboundAuthority`、`roomResources` 的房间元数据 | 事件里 `sender` 就是 `https://…/card#me`；跨 Pod 一致；不再有 `@u_<hash>:host` |
| 2 | 事件 id：reference hash → **写入方生成的随机 `msgid`** | 改 | `computeEventId`、写入路径、`eventIntegrity`、去重 | 同一 id 重发**只产生一行**（**同 id 不覆盖**）；id 随事件传播、跨 Pod 相同；时间是行自己的 `createdAt` |
| 3 | 每事件签名 + 密钥托管 + 公钥发布 | **删候选** | `identityProvisioning`、`signingKeyStore`、`credential` 私密封存、`/_matrix/key/v2/server` | 不再需要"验签通过"这类断言；改为"写入这一跳的身份 + 作者 Pod 正本比对" |
| 4 | 事务预留（`xpod_matrix_transactions`、`MatrixEventJournal` reserve 半、`PodMatrixEventJournal`） | **删候选** | 发送路径、`PodMatrixStore` 五个反查点 | 幂等由确定性 id 保证，不再有预留表；**sequence 保留**（sync 增量本地加速，可重建） |
| 5 | 事件图字段（`prev_events`/`auth_events`/`depth`）与 v11 规则强制 | 改/删候选 | `roomState` 回放、`protocol/authRules`、`appendEvent` 的 `authorizeEvent` | C2 下判定只剩"是不是成员/owner"；排序用 `(createdAt, id)`，不再需要授权链与状态解析 |
| 6 | 房间权威（**C2**）：成员与元数据只在房主 Pod | 新增/改 | 房间记录读写、成员事件写入路径、`resolvedState` 的用途 | 房主 Pod 是唯一权威；其他 Pod 的房间记录标注为**本地镜像**；镜像冲突不得放行写入 |
| 7 | 投递：推 + 批次 → **拉为主** | 改 | `outboundDelivery`/`outboundSender`/`PodMatrixOutboundStore`/`outboundBatches` | 新增"订阅 + 拉增量"的验收；不再有"欠账批次" |
| 8 | 入站回执（`txn` 控制记录）与出站批次控制记录 | **删候选** | `controlRecords.ts`、`PodMatrixInboundTransactionStore`、控制记录契约文档 | 不再断言"重放答回首次应答"；幂等写入即验收点 |
| 9 | API 形状：**一套**（对端 api-server POST 批量事件 + 事务 id + 逐条应答），前缀 `/_matrix/*` | 留形、换认证、收敛路径 | `FederationHandler`、`inboundRoute`、`federation/*`、`/_xpod/matrix/inbound` | **路径与命名空间都不改名**；认证从 `X-Matrix` 换为 Solid；两条投递路径（原生 + 联邦）收敛成一条 |
| 10 | 事件存进 Pod 的形状 | 改 | `metadata.protocols.matrix.event`（完整 PDU） | 存"事件本身 + 内容哈希"即可（不再需要 hashes/signatures/auth_events）；**命名空间仍是 `matrix`，不改名** |
| 11 | models 布局（房间 chat/thread、事件按天 message 行）与"先建父容器" | **留** | — | 不变（已在 models 契约与测试里） |
| 12 | Pod 写授权（任务层 grant） | **留** | `matrixPodWriteFor` | 不变：没有 grant 就 403 |

## 顺序（每刀单独提交、单独跑门禁）

1. **第 1+2 项一起做**（身份与事件 id 互相牵连：id 里的 `sender` 就是 WebID）——影响面最大，其余多项随之失去理由。
2. 第 3 项（删签名/密钥）——依赖 1、2。
3. 第 4 项（删预留）——依赖 2。
4. 第 6 项（C2 房间权威）——独立可做，做完第 5 项才有意义。
5. 第 5 项（降授权规则、去事件图字段）。
6. 第 7+8 项（改拉、删回执与批次、清控制记录）。
7. 第 9、10 项（换认证、改存储形状与命名）+ 文档与验收口径收尾。

## 已定细节（2026-09-28 拍板）

1. **事件 id 由写入方生成**，随机即可：客户端给 `msgid`，服务端为自己发起的事件（join/invite/改成员）自己生成。
   id 随事件传播；接收方**同 id 只读回、不覆盖**——幂等由这条写入规则保证，而不是由 id 的不可伪造保证。
2. **路径前缀就是 `/_matrix/*`**（协议叫 matrix：参考 Matrix，不承诺兼容），Pod 命名空间继续用
   `protocols.matrix`——**一律不改名**；将来要互通就在同一前缀上加认证/字段适配。
   同时把两条投递路径（`/_xpod/matrix/inbound` 与 `/_matrix/federation/v1/send`）收敛成一条。
3. **本地镜像存 `members` 副本**（离线可读、UI 直接用），但标注为镜像，判定一律回房主 Pod 读。

## 第 1 刀边界：身份 WebID + 事件 id 由写入方生成（开工中）

**为什么这两项同一刀**：事件 id 里含 `sender`，身份换了 id 的来源也换——分开做会有一刀处于"半新半旧"。

**改动点**

1. **身份**：事件的 `sender`、`state_key`、成员/角色键、`inboundAuthority` 的判定入参，一律换成 **WebID**；
   停用身份路径上的 `matrixUserIdFor` / `webIdServerName`（**函数先留着**，第 2 刀再看是否还有互通用途）。
2. **事件 id**：`buildPersistedEvent` 不再 `computeEventId`，改为**取写入方给的 id**：客户端请求里带 `msgid`，
   服务端自发起的事件（join/invite/改成员）自己生成一个（随机、足够长）。
3. **落库规则**：同一 id **只读回、不覆盖**（把"存在即返回"做实；不得走 update 路径）。
4. **校验口径**：`readPersistedEvent` 的 `eventIdMatches`（`computeEventId(event) === event.event_id`）
   不再成立，替换为"**内容哈希与存储时记录的一致**"；`appendEvent` 里"提供的 id 与内容推导不一致就报错"
   这条断言删除。
5. **接收路径**：`acceptReceivedEvent` 用事件自带的 id 做幂等键（已经是按 id 查重，改用自带 id 后语义不变）。

**关键耦合点（已查清）**：`buildPersistedEvent` 先 `signEvent(base)`、**再**算 id 并附上
（`persistedEvent.ts:94-105`）——**签名不覆盖 `event_id`**。所以本刀换成随机 id **不会破坏签名验签**，
第 2 刀（删签名）可以按原顺序独立进行；只需要改上面第 4 条的**校验**。

**验收口径**

- 新断言：写入的事件 `sender` 是 WebID；同一 `msgid` 重发**只产生一行且内容不被覆盖**；
  同一事件在两个 Pod 里的 id 相同。
- 反向断言：新写入的事件里不再出现 `@u_<hash>:host`。
- 历史数据不追溯（已有 `@u_…` 的旧事件保持原样）。

**门禁**：`typecheck:test`、`tests/api/matrix`、`tests/api tests/http`、`test:integration:lite`
（上一刀基线：587 / 2044 / 162）。

**不在本刀**：不删签名与密钥（第 2 刀）、不删预留（第 3 刀）、不动房间权威（第 4 刀）、
不降授权规则与事件图字段（第 5 刀）、不改投递与路径（第 6–7 刀）。

### 试行结果（2026-09-28）：本刀**不独立**，先补一步 1.0

按上面的边界真的改了一遍（`getMatrixUserId` 返回 WebID、agent 用自身 URI、`serverNameOf` 认得 URL、
删掉 MXID 派生与 `matrixUserIdFor`），`typecheck` 与 `typecheck:test` 都过，但 `tests/api/matrix`
**89 项失败**，且失败集中在同一条：

> `v11-1.2: room_id domain does not match the sender domain`

原因不是实现错，而是**暴露了一个一直存在的分歧**：`sender` 现在是 WebID，`serverNameOf(sender)` 得到的是
**WebID 的 host**（`alice.example`）；而 `room_id` 仍是 `!xxx:<部署配置的 server name>`（`example.test`）。
`PodMatrixStore.getServerName` 只有在"该 host 在本部署注册的身份名里"时才用 WebID host，否则退回部署名——
所以两者不一致，规则 1.2 判死**每一次写入**。

**结论**：身份切换必须先定一件事——**参与者的 server name 就是其 WebID 的 host**（设计文档已经这么写：
"每个参与者自己就是一台 server"），并把四处一起对齐，否则 sender 与 room 的域永远对不上：

| # | 要一起改的 | 现在 |
| --- | --- | --- |
| 1.0a | `getServerName` | 先看部署注册的身份名、再退回部署名 → 改为**以 WebID host 为准** |
| 1.0b | 房间 id 的域 | 由 1.0a 生成，随之统一 |
| 1.0c | 签名身份的解析（按 server name 取密钥） | 注册表以**部署名**为键 → 改为以 **WebID host** 为键（或随第 2 刀一起删） |
| 1.0d | 身份注册表与夹具 | 测试夹具注册的是部署名 → 随之改成 WebID host |

另外：规则 1.2 之所以此刻"咬人"，是因为**写路径的 v11 强制**（第 5 刀才降）还在生效。
所以第 1 刀有两条可行路径，二选一后再动手：

- **路径 A（推荐）**：先做 1.0a–1.0d（把 server name 统一到 WebID host），再切身份——语义上最干净，
  因为"参与者即自己的 server"本来就是这个协议的前提；
- **路径 B**：先把第 5 刀（降授权规则、去事件图字段）提前做掉，再切身份——改动面小，但会先失去一层校验。

已回退，树保持绿色（`tests/api/matrix` 恢复到 587 通过）。
