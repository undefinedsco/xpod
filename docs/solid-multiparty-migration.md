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
| 5 | 事件图字段（`prev_events`/`auth_events`/`depth`）与 v11 规则强制 | **本地与接收（会话路径）已完成**；签名路径与事件图字段待办 | `roomState` 回放、`protocol/authRules`、`appendEvent`、`inboundPdu` 第 4 步 | 本地写入只剩成员/角色判定；**会话投递的批次**只剩"发送者是 join 成员"（判断用事件自己声明的成员事件，无需 E）；v11 只留给 Matrix 形状的对端 |
| 6 | 房间权威（**C2**）：成员与元数据只在房主 Pod | 新增/改 | 房间记录读写、成员事件写入路径、`resolvedState` 的用途 | 房主 Pod 是唯一权威；其他 Pod 的房间记录标注为**本地镜像**；镜像冲突不得放行写入 |
| 7 | 投递：推 + 批次 → **拉为主** | 改 | `outboundDelivery`/`outboundSender`/`PodMatrixOutboundStore`/`outboundBatches` | 新增"订阅 + 拉增量"的验收；不再有"欠账批次" |
| 8 | 入站回执（`txn` 控制记录）与出站批次控制记录 | **删候选** | `controlRecords.ts`、`PodMatrixInboundTransactionStore`、控制记录契约文档 | 不再断言"重放答回首次应答"；幂等写入即验收点 |
| 9 | API 形状：**一套**（对端 api-server POST 批量事件 + 事务 id + 逐条应答），前缀 `/_matrix/*` | 留形、换认证、收敛路径（**路径已收敛**；认证见下） | `FederationHandler`、`inboundRoute`、`federation/*`、`/_xpod/matrix/inbound` | **路径与命名空间都不改名**；认证从 `X-Matrix` 换为 Solid；两条投递路径（原生 + 联邦）收敛成一条 |
| 10 | 事件存进 Pod 的形状 | 改 | `metadata.protocols.matrix.event`（完整 PDU） | 存"事件本身 + 内容哈希"即可（不再需要 hashes/signatures/auth_events）；**命名空间仍是 `matrix`，不改名** |
| 11 | models 布局（房间 chat/thread、事件按天 message 行）与"先建父容器" | **留** | — | 不变（已在 models 契约与测试里） |
| 12 | Pod 写授权（任务层 grant） | **留** | `matrixPodWriteFor` | 不变：没有 grant 就 403 |

## 顺序（2026-09-28 按两次试行修订）

原来的"第一刀 = 身份 + 事件 id"**不成立**：两次试行（切身份 89 项失败、1.0a 25 项失败）说明这半刀的两个半边
各自牵着后面的项：

| 第一刀的半边 | 牵到谁 | 实测 |
| --- | --- | --- |
| 身份 → WebID | **E（对端端点怎么解析）**、1.0c（签名身份解析）、1.0d（夹具与期望值） | `getServerName` 改用 WebID host 后 25 项失败，其中一条测试专门记录"不为该 server 签名时回退部署身份" |
| 事件 id → 写入方生成 | **接收路径的完整性校验**：`computeEventId` 是 `inboundPdu`、`membershipHandshake`、`outboundTransaction`、`remoteJoin` 用来验"id 与内容一致"的手段（属第 2、5、9 项） | 去掉它 = 同时拿掉防篡改校验，接收路径必须先有替代的**真实性模型** |

### 第三次尝试的结论：**E 是整场迁移的总闸**（2026-09-28）

把第 2 步推到接线时，发现它同样落在 E 上：`computeEventId`（reference hash）是 `inboundPdu` 用来验
"id 与内容一致"的手段，换掉它就必须同时接上替代校验；而替代校验（`verifyAgainstAuthorCopy`）**要先能
找到作者的 Pod**——那正是 E 要回答的问题。于是：

| 想做的事 | 被谁挡住 |
| --- | --- |
| 事件 id 换成写入方生成 | 接收路径的替代校验 → **E** |
| 身份换成 WebID | 1.0c 签名身份解析、寻址 → **E** |
| 删签名/密钥 | 上一条 |
| 删事务预留 | "幂等由 id 承担"要先生效 → 第 2 步 → **E** |
| 删回执/批次 | 拉取投递要能定位对端 → **E** |
| C2 房间权威 | 读房主的 Pod 要能定位它 → **E** |
| **删原生投递路径（`/_xpod/matrix/inbound`）** | **不被挡**——它是"本机有几条路"，与"对端怎么寻址"无关 |

#### 删原生路径这一刀：顺序定了，批量删除试了一次（回退）

**顺序（已定）**：**先停用客户端、再摘服务端**——已经部署出去的对端可能还在尝试原生路径，
先把服务端摘掉会把它们打断；先停自己的客户端只会让对端少收到一条路，回退也容易。

**试行（2026-09-28，两次都回退）**：按这个顺序删客户端（`outboundSender` 的"原生优先 + TTL 记忆"、
`outboundTransaction` 的原生客户端与 `nativeTargetOf`）。

- 第一次：一次批量删两个文件 → 两处接口块被切坏；
- 第二次：改成逐块"括号配对"删除、每步编译 → **仍然切坏**，且失败点很具体：删一个**单行可选属性**时，
  配对逻辑一路吞到**接口的收尾 `}`**；删类型别名时又吞掉了**类的声明与私有字段**。

**第三次试行（2026-09-28，成功）**：改用**字面替换**（先读出精确文本、断言命中、再整块删除），
逐块做、每步编译：`NativeRequestOutcome` → 两个原生交付类型 → 两个原生方法 → `executeNative` →
文件末尾的 `nativeTargetOf` → 类字段与构造赋值 → `execute` 的 `native` 开关；随后删 `outboundSender`
的原生优先分支、TTL 记忆与 `resolveNative` 选项。**踩到一个新坑并记录**：`NativeDeliveryOutcome`
的收尾行是 `  | { transport: 'native'; … };`（不是 `};`），按"找下一个 `};`"扫描会一路吃掉紧随其后的
`DEFAULT_POLICY` 常量——恢复它，并把这条写进规程：**删除块的收尾行必须按该块的语法形态判断，不能统一
找 `};`**。

**认证适配的进展（2026-09-28）**：`ApiServer` 已有 `optionalAuth`（接受匿名调用者，但有凭据时
仍填充 `request.auth`），所以"同一路由既收 Solid 会话、也收 `X-Matrix` 签名"是现成的机制。
判定这一层先落地为可测的组合件：`src/api/matrix/solidPeerBatch.ts` 的 `solidPeerMayDeliver`
（把 `writerMayClaim` 应用到整批事件上；**身份按批次声明的 `origin` 拼写**——对端是在它自己的名字下
派生 sender 的，用我们的名字去比会拒掉每一批诚实的投递）。四种拒绝分开报：`no-session` /
`no-origin` / `empty`（空批次不放过）/ `impersonation`。单元 4 项。
**已接线（2026-09-28）**：`/send` 注册为 `optionalAuth`；处理器把 `request.auth` 交给
`handleFederationSend` 的 `solidSession`，核心在**读任何事件之前**先判这批投递——
`impersonation` → 403，其余三种 → 401。**踩到并修掉一个真问题**：`optionalAuth` 与 `X-Matrix`
**共用 `Authorization` 头**，中间件会抢先把同行签名当会话验，于是所有联邦请求在处理器之前就 401；
修法是 `ApiServer` 只对**非 `X-Matrix` 方案**的 `Authorization` 触发可选认证（签名方案由认识它的
路由自己处理）。测试：夹具新增可注入认证器；新增用例覆盖"会话冒名 → 403（在任何事件被读之前）"
与"认证器不认的会话 → 401（回落签名路径）"。

**服务端也已摘下（2026-09-28）**：`NATIVE_INBOUND_PATH`、`FederationHandler` 的原生路由与
`createNativeInboundHandler`（含 `nativeAnswer`）、`MatrixServerNameResolver.resolveNative` 与
`via: 'native-endpoint'` 变体全部删除；`outboundTransaction` 里残留的常量 import 一并清掉。
测试删除原生端点 4 项与探针里的原生用例，并把探针的断言改成"**未签名一律被拒**"而不是钉死 401——
整套 lite 跑起来时 `/send` 会先判"是否服务被寻址的名字"（403）再验签（401），钉死状态码会让探针
依赖"这套栈恰好服务哪些名字"。

**这一刀完成的部分**：客户端一侧已停用原生传输（`outboundTransaction` 的 4 个导出类型、3 个方法、
1 个注入选项与 `nativeTargetOf`；`outboundSender` 的原生优先 + TTL 记忆）。测试随之更新：
删掉原生客户端与"两部署选传输"的用例（约 10 项），并把两部署用例的断言从"走原生、`/send` 未用"
翻成"走 `/send`、原生路径未被使用"。**服务端端点 `/_xpod/matrix/inbound` 暂留**（已部署的对端可能
还在尝试它），摘下它是下一刀。

**规程（保留）**：不要用任何"按括号配对自动删除"的办法动这两个文件——它们把
`export interface` / `export class` 与相邻声明挤在一起，自动配对会吃掉边界。正确做法是**用 `edit`
工具对精确文本做字面替换**（先读出整块、再整块替换为空），**每块之后编译一次**，顺序：
`NativeRequestOutcome` → `resolveNative` 选项 → `NativeDeliveryResult` → `NativeDeliveryOutcome` →
类字段与构造赋值 → `sendNativeTransaction` → `deliverNativeTransaction` → `executeNative` →
文件末尾的 `nativeTargetOf`。客户端一侧约 150 行（4 个导出类型、3 个方法、1 个注入选项）。

**E 已按 E3 记为工作决定（2026-09-28）**：**标识用 WebID，端点用登记信息**。理由是它把两件事分开——
身份永远是 WebID（事件里可读、可校验），端点是可以随部署迁移的登记事实。**这一决定解开的不只是投递**：
它同时说明"server name"只服务**标识**（房间 id 的域、事件的域），因此第 1 项（身份 WebID）**不再被端点解析挡住**，
只剩 1.0c（签名身份的键）与第 3 项（删签名）相关，而后者等 O。

**仍未拍的只有 O**（投递时部署以谁的身份认证），它只挡第 3 项（删每事件签名与密钥托管）。

**所以现在的阻塞只有一个：E（对端端点怎么解析）。** 我按 **E3**（标识用 WebID、端点用登记信息）继续，
除非你说别的。E 一旦定下，上面六项会依次解开；而"删原生路径"这一项不依赖它，是下一刀最稳的起点。

### 第 1 项（身份 WebID）的执行方案：一轮做完（按 E3）

第 1、2 轮各试过一次（89 / 25 项失败），失败原因已全部查清；下面是把它们一次做完的清单：

1. **1.0a 标识**：`getServerName(context)` **本来就优先 WebID 的 host，只要该名字已在部署注册**——
   所以 1.0a 基本不是源码改动，而是**夹具与期望值的事**：实测把测试夹具的部署名从 `example.test`
   换成 `alice.example`（参与者 WebID 的 host），`tests/api/matrix` 出现 **18 项失败**，且全部集中在
   "期望值里写死了部署名"的文件（`persistedEvent` 用 `'example.test'` 验签、`participantIdentity`
   断言回退到部署身份、`participantProvisioning` 断言"保留部署名"、`PodMatrixStore` 的 Agent 与别名用例）。
   **这意味着第 1 项的真实工作量是"把身份注册到 WebID host 下 + 更新这些期望值"**，源码侧只剩
   1.0d 的字段替换。
   **已开始去硬编码（2026-09-28）**：夹具导出 `MATRIX_TEST_SERVER_NAME`，测试引用它而不是自己写
   `'example.test'`——这样夹具切到 WebID host 时这些文件**自动跟随**。已改完 4 个文件
   （`persistedEvent`、`PodMatrixStore`、`receivedEvent`、`roomStateCache`，矩阵 600 项仍全过）；
   **已全部改完（2026-09-28）**：`participantProvisioning`、`participantIdentity`、`MatrixCollaboration`
   也改为引用常量；`authRules`/`signingKeys` 用的是任意 server name，**不需要跟随**。
   现在**切换夹具名只需改 `MATRIX_TEST_SERVER_NAME` 一行**，1.0a 的成本从"18 处同时红"降到一行。
   **1.0a 已落地（2026-09-28）**：`MATRIX_TEST_SERVER_NAME` 改为 **`alice.example`**（参与者 WebID 的 host）
   ——部署以**参与者自己的 host** 签名，房间 id 与别名也按它寻址。切换后只剩 **6 项**失败（去硬编码前是 18 项），
   且全是"期望值跟着名字走"：5 处 MXID 后缀断言改为按常量构造正则、1 处别名按常量拼；
   `tests/api/matrix` **600 passed / 3 skipped**、`tests/api tests/http` 2054、lite 162。
   **1.0d 试行（2026-09-28，已回退）**：把 `getMatrixUserId` 改成返回 WebID（`sender`/`state_key`/成员键
   随之全部就位），失败 **16 项**。与前面几次不同，这次失败**不是期望值问题，而是概念消失**：
   `participantIdentity`（4 项）与 `participantProvisioning`（6 项）里有十项**专门验证 MXID 派生**
   （"以持有密钥的 server 命名并签名每位参与者"、"报告每位成员所属的 server"、"在报告 MXID 之前先
   provision"）——MXID 不存在了，这些测试要**重写**成"身份是 WebID、`serverNameOf(webId)` 给出所属 server"，
   而不是改几个字。另外要记得保留 `matrixUserIdFor`（测试仍用它构造历史形状的期望值）。
   **十项已改成"断言属性而非拼法"（2026-09-28）**：它们此前断言 `@u_…:example.test` 的**形状**，
   现在断言 `serverNameOf(id) === MATRIX_TEST_SERVER_NAME`——即"**这个身份属于哪个 server**"，
   而那正是迁移要保留的性质（MXID 换成 WebID，所属 server 不变）。测试名里"报告 MXID 之前先 provision"
   也改成"报告**身份**之前"。矩阵 600 项仍全过。
   **于是 1.0d 只剩"改字段 + 看回退"**：翻转 `getMatrixUserId` 后，这十项不再因为"拼法变了"而失败；
   预计剩下的失败集中在别处（历史形状的期望值、`matrixUserIdFor` 的使用）。
2. **1.0b 房间 id 的域**：随 1.0a 自动统一（`!xxx:<WebID host>`）。
3. **1.0c 签名**：**不动**——请求签名（`X-Matrix`）与事件签名仍用部署密钥，键名与参与者标识无关；
   删签名是第 3 项的事，等 O。**这一条正是第 1 轮 89 项失败的主因**（当时把标识与签名键混在一起改）。
4. **1.0d 身份字段**：`sender` / `state_key` / 成员键 / `inboundAuthority` 入参 → WebID；Agent 用自身 URI。
   **前置已落地（2026-09-28）**：`serverNameOf` 现在**认 URL 身份**（WebID 或 Agent URI → 其 host），
   MXID 分支保留给历史数据与签名路径；`isUserIdentity` 同时认两种形态。这一步是纯加法（MXID 行为不变），
   单元 5 项（含"与 `webIdServerName` 同一条规则，不是第二套"）。**没有它，sender 一变成 WebID，
   路由与密钥解析就会读到 `//alice.example/card#me` 这种半截字符串。**
5. **夹具与期望值**：`participantIdentity.test.ts` 断言 MXID 以 `:example.test` 结尾、别名按部署名匹配等，
   按 WebID host 更新（约 25 项，属机械改动）。
6. **验收**：事件里 `sender` 是 WebID；跨 Pod 同一事件 id 相同；不再出现 `@u_<hash>:host`（历史不追溯）；
   四道门禁（基线 1036 / 2049 / 162）。

**修订后的顺序**

0. **拍 E**（对端端点解析）——它是第 1 刀的前置，也影响"取作者 Pod 正本"这一步怎么找到正本。
   我按 **E3**（标识用 WebID、端点用登记信息）继续推进；你要改随时说。
1. **真实性模型（加法，先不删任何东西）**：把"去掉签名之后靠什么判断来源"落成可测的东西——
   ① 写入这一跳的身份（谁在写，已有认证能力）；② **作者 Pod 正本**（按 E 找到作者的 Pod，读回事件、
   比内容哈希）。这一步只**新增** helper 与测试，不改变现有行为，因此可以独立验收。
   **进度（2026-09-28）**：②已落地——`src/api/matrix/authorCopy.ts` 的 `verifyAgainstAuthorCopy`
   + `contentHashOf`（复用 `computContentHash`/`encodeUnpaddedBase64` 这一条规则，与
   `verifyPersistedEvent` 的 `hashes.sha256` 同源，不造第二套哈希）。三种拒绝理由分开表达：
   `no-id` / `no-copy`（作者 Pod 根本没有这条——**不等于同意**）/ `mismatch`（作者那里的同 id 是另一个内容）
   / `unreadable`（读不到作者 Pod）。查找方式**注入**，因此 E1/E2/E3 任何选择都不用改这个模块。
   单元 5 项。
   **①也已落地**：`src/api/matrix/writerIdentity.ts` 的 `writerMayClaim`——写入这一跳的身份由认证给出
   （Solid 会话的 WebID），要检查的是"这一跳能不能替这条事件的作者说话"；没有会话与冒名顶替**分开报**
   （`no-session` / `impersonation`），因为运维看日志时不该猜。身份**拼法注入**（今天是 MXID 派生，
   目标是 WebID 本身），所以第 3 刀切身份时这里不用改。单元 4 项。
   两个 helper 都**还没有被任何路径调用**——这是有意为之：先让替代方案可测，再去掉签名。
   第 1 步至此完成（加法、可独立验收），下一步进入第 2 步（事件 id 由写入方生成 + 接收路径改用它们）。
2. 事件 id 由写入方生成（接收路径改用它 + 第 1 步的校验）。
   **接收路径已能收下写入方的 id（2026-09-28）**：会话投递的批次带 `writerVerified`——**不验事件签名**
   （会话已经证明是谁在写）、**保留事件自带的 id**（不再重算 reference hash）。两处都必须改，否则
   同一个事件会在两个 Pod 里有两个名字：`inboundPdu.verifyInboundPdu`（第 2 步签名检查按标记跳过、
   id 取自事件）与 `PodMatrixStore.acceptReceivedEvent`（原来无条件重算 id）。签名路径**行为不变**：
   它照旧重算 id，因为 Matrix 形状的事件 id 本来就是这个哈希。
   **这一步不依赖 E**：会话投递里"作者"就是会话本身，不需要作者正本比对；正本比对是为**从别处读来的
   副本**准备的（拉取模型，那才需要 E）。
   测试：`FederationHandler.test.ts` 新增"会话投递一批无签名、自带 id 的事件 → 200 且回执里就是那个 id"。
   **写侧也接上了（2026-09-28）**：发送请求可带 `msgid`（`MatrixHandler` 把它**从内容里取出**，不当事件内容存），
   `sendEvent` 用 `eventIdForWrite(msgid)` 给事件命名；**没带就由部署生成**。同时删掉两处"id 必须等于内容哈希"
   的断言（`persistedEvent.buildPersistedEvent` 与 `PodMatrixStore.appendEvent`）——那是自证模型，本协议不再依赖它。
   `verifyPersistedEvent` 的 `eventIdMatches` 因此改名为 **`hasEventId`**（id 是写入方给的名字，不是待校验的声明），
   接收侧则**一律保留事件自带的 id**（原来只在会话投递时保留）。
   **进度（2026-09-28）**：规则先落地并有测试——`src/api/matrix/eventIdentity.ts`（`generateEventId`
   / `isEventId` / `eventIdForWrite`，单元 4 项）。三条语义写进了代码注释与测试：id 由写入方决定、
   重试复用同一个 id（**幂等由 id 承担，这正是预留表能删掉的原因**）、以及 **id 本身不证明任何事**
   （随机 id 谁都能声称——所以真实性只能来自"写入这一跳的身份 + 作者 Pod 正本"）。
   **接线被 E 挡住**（见下）。
3. 身份 → WebID（含 1.0a–1.0d）。
4. 删签名与密钥托管（第 3 项）。
5. 删事务预留（第 4 项）。**已拆成两步，且第二次试行给出了完整替换方案（2026-09-28）**：

   - **试行**：把发送路径的预留去掉（幂等已由写入方 id 承担，`events.find(e => e.eventId === eventId)` 读回即可）
     ——`MatrixCollaboration` 立刻红：唤醒链断了。
   - **原因（预留的三个承重用途，之前只看到第一个）**：

     | 用途 | 现在的实现 | 替换方案 |
     | --- | --- | --- |
     | ① 客户端发送幂等 | `reserveEventTransaction` + 409 冲突 | **已完成**（写入方 id：同 id 即同事件） |
     | ② 唤醒/交接的"回执"校验（这个事件当时的内容是什么） | `findReservation(...)` 再比对 `contentHash`（第 1687/1812/1818 行） | 回执要**随队列项携带**（入队时记录的内容哈希），校验时与**事件行**比——现在这两处是拿"事件算出来的哈希"跟"事件算出来的哈希"比，只有预留那份**入队时的副本**才有意义 |
     | ③ 一个唤醒只能有一个结果（严格唯一赢家） | 结果事件也走预留，冲突即 409（第 1778-1798 行，含"悬空预留接管"） | **结果事件的 id 由 job id 确定性推导**（`H('assistant', job.id)`）→ 同一个唤醒天然只有一个事件，冲突与"接管"逻辑一起消失 |

   - **③ 单独做也不行（2026-09-28 第二次试行）**：把结果事件的 id 改成由 job id 推导
     （`$wake-<H('wake-result', job.id)>`，同一唤醒天然一个事件、连"悬空接管"都不需要）之后，
     `MatrixCollaboration` 仍然红——因为**交接校验读的正是"结果事件的那条预留"**（②的 assistant 一侧）。
     所以 **②③ 必须同一刀落地**，不能拆。
   - **为什么停下来**：②③ 都在 Agent 执行核心里（`MatrixCollaboration` 约 15 项验收测试覆盖），
     且 ② 需要先定"回执放在哪"（队列项携带 vs 事件行现算）。**结论：这一项要一整轮完整预算，
     不要再单轮试拆**——两次试行（发送路径、结果 id）都因此回退。
   - **落地时的顺序（一次做完）**：先让**队列项携带入队时的内容哈希**（用户侧回执），
     再把**结果事件的 id 由 job id 推导**（assistant 侧因此不再需要回执），
     然后删掉三处 `findReservation` 与预留四法、`xpod_matrix_transactions` 表。
6. C2 房间权威（第 6 项）。
7. 降授权规则与事件图字段（第 5 项）。**本地一半已完成（2026-09-28）**：`appendEvent` 里的
   `authorizeEvent` 调用与 `authEventsFor` 助手删除——本地写入此前是"成员/角色判定 + 完整 v11 规则"，
   现在只剩前者（那三项检查本来就在调用方做过）。`protocol/authRules` 与状态解析**保留**：它们仍服务
   接收侧（对端可能只说 Matrix 形状）。**接收侧与事件图字段（`prev_events`/`auth_events`/`depth`）
   仍待办**，且与"对端模型"（E/O）相关。
   **接收侧（会话路径）也已完成（2026-09-28）**：`validateInboundPdu` 第 4 步对 `writerVerified` 的批次
   不再跑 `authorizeEvent`，改为**成员判定**——用事件自己声明的成员事件（`auth_events` 里的
   `m.room.member`，`state_key === sender`）判断 `membership === 'join'`；**没声明成员身份的事件直接拒**
   （"成员才能发言"，而不是"看不见就当通过"）。这一步不需要 E：它只读事件自己带来的授权事件，
   与"房间权威在哪"无关（C2 落地后，成员事件的来源会变，判定不变）。
   测试：会话投递一批"发送者是本人、但没声明 join 成员身份"的事件 → 该条被拒且理由含 `membership`。
8. 拉为主，删回执/批次/控制记录（第 7、8 项）。
9. 收敛路径与存储形状（第 9、10 项）+ 文档与验收口径收尾。

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

### 1.0a 试行结果（2026-09-28）：动的是**寻址语义**，不是命名，先拍一个问题

把 `getServerName` 改成"以 WebID host 为准"后：`tests/api/matrix` **25 项失败**（远少于切身份的 89），
失败形态两类：

- **期望值跟着部署名走**（机械）：如 `participantIdentity` 断言 MXID 以 `:example.test` 结尾、
  别名查找按部署名匹配——这些是 1.0d 的活；
- **一条语义分叉**：`falls back to the deployment identity for a WebID whose server it does not sign for`
  ——这条测试**专门记录**了"本部署不为该 WebID 的 server 签名时回退到部署身份"。也就是说，把 server name
  换成 WebID host 会连带改变**签名身份的解析**（1.0c）与**对端端点的解析**。

**必须先拍的问题：对端端点按什么解析？** 三条候选：

| 候选 | 怎么解析 | 代价 |
| --- | --- | --- |
| **E1** WebID host | 对 `alice.example` 做 `/.well-known` 发现，再打它的 `/_matrix/*` | 要求每个人的 WebID host 都真的提供这个协议（或至少提供 well-known 指向） |
| **E2** Pod 注册里的 host | 用参与者登记的 Pod URL 的 host 作为端点 | 端点不依赖 WebID host，但"server name"就变成登记事实，而不是身份的事实 |
| **E3** 两者都支持：**标识用 WebID，端点用登记信息** | 身份/事件里写 WebID；投递时按登记信息找端点（找不到再试 WebID host 的 well-known） | 概念上最清楚（身份与寻址分离），但要多一处登记解析 |

我倾向 **E3**：它把"身份"和"往哪送"彻底分开——身份永远是 WebID（事件里可读、可校验），
而端点是可以随部署迁移的登记事实（Pod 搬家不该改身份）。E1 太依赖"人人的 WebID host 都跑这个协议"，
E2 会把 server name 变成登记事实、与"参与者即自己的 server"这句话打架。

**E 定了再回到 1.0a**：`getServerName` 的语义取决于它——如果采用 E3，"server name"只用于**标识**
（房间 id 的域、事件的域），而 `signingIdentity`/`nativeTargetOf` 这类**寻址**改走登记信息（或随第 2 刀删掉签名）。
