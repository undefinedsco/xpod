# Matrix 协作：决策登记册

更新：2026-09-28。状态：**登记册里已拍板的决策全部实现并有证据**——写入侧 ③（原生端点 / 客户端 / 选传输，
并在真实栈上验证过端到端可达）、控制记录承载（入站回执 / 出站队列 / 物理回收机制，单元 + 真实 Pod 证据）、
布局（models 按天分桶）、"判赢家"（入站不判、本地预留由 SQL 唯一键）、同步序号（不进 Pod，可重建的本地加速）、
grant（房间级授权＝成员资格）、**D6 完整落地**（授权即成员 + **写路径按 v11 规则强制**）。
**真实实例证据也已取得**（lite 真实栈上的端点探测，见验收记录），不再依赖 Docker。

**未做的只剩两件，都不在登记册的实现范围里**：① `full` 门禁（需要 Docker，本机引擎卡死，等你启动）；
② 产品侧 Ask：参与者把 Pod interface key 交给部署的**时机与界面**（授权判定已经按成员身份生效，这一层是交互）。
**已删除**（2026-09-28，用户确认）：`identityBinding.ts`（191 行）及其 7 项测试——"参与者 ↔ Pod 归属"改为派生后它已无消费者
（删除前核实过：全仓只有它自己的测试文件命中）；其中"Pod 迁移版本/状态机"的**语义**仍在待细化清单里，不随代码消失。

本文登记目标决定、实现状态与尚需细化的机制。不能从当前单 Pod adapter 的局限反推产品边界。
实现契约见 [协作设计](matrix-collaboration-design.md) 与
[Pod 存储契约](matrix-pod-storage-portability.md)，历史证据见
[验收记录](matrix-collaboration-acceptance.md)。

## 需要拍板的事项（2026-09-27）

实现面已走完，下面几项**不是实现困难，而是需要你选一个方向**；每项都写明了选项与后果。
**已经拍完并落地的**：第 0 项（走 ③，原生入站端点 → 客户端 → 出站选传输全部实现）、
第 1 项（控制记录承载：随你"按 solid chat 标准/先房间再按时间分"的指示改成 models 的按天布局，
"判赢家"按你的质疑收口）、第 3.5 项（入站回执不判赢家）。
**仍在等你选方向的**：第 2 项（grant 索取流程）、第 3 项（D6 Agent 归属）、第 4 项（真实实例验收方式）。
**同步序号：已按你的判断收口（2026-09-27）**——"同步序号为什么要进 pod，我觉得应该是 client 的工作"。
你是对的，而且这条比我原本的三选一更省：**序号不进 Pod，游标本来就是客户端的事**。
序号留在身份库 SQL，作为**部署本地、可从 Pod 重建**的加速（读事件按 `(createdAt, id)` 排序、
按该顺序发号，所以清空这张表后重放会得到同样的顺序；这条"可重建"需要一个测试来固定，见下）；
部署侧不再把它当作客户端的游标来维护。契约 §10.2 的三个选项因此作废，只保留结论。

0. ~~**写入侧三选一**~~ **已定：走 ③**（用户 2026-09-27 明确选择"调用对方 api-server，由它写自己的 Pod"）。
   实现计划：原生入站端点 → 对应客户端 → 出站队列选传输（先试原生、对方 404 再走 `/send`），
   `/send` 保持不动作为互通边界。
   - **已落地（2026-09-27，第一步）**：**原生入站端点** `POST /_xpod/matrix/inbound/:txnId`
     （`FederationHandler.createNativeInboundHandler` + `registerFederationRoutes` 注册）。
     它不是第二套协议：body、签名认证（`X-Matrix` 那套，含按名字的密钥发布与退役密钥）、origin 一致性、
     体积上限、事务层（预占/重放/逐条应答/处理中 503）与 **Pod 回执**全部复用同一条判定路径
     （`handleFederationSend`，`transactionId` 由外壳显式给，因为原生路径不是 Matrix 路由）；
     去掉的只是**联邦传输**本身：没有 `:8448`、没有 SNI/`Host` 花招、没有 `.well-known` 发现——
     就是对 server name 的普通 HTTPS 端点发一个已签名请求。响应按事件命名（`events`）而不是 `pdus`，
     错误码保持同一套，免得两条路各长出一套语义。测试 `FederationHandler.test.ts` 新增 4 项
     （写入并逐事件应答、重放取首次记录、签名/origin/被寻址名字同样被校验、非 JSON 与超限拒绝）。
   - **剩下**：**对应客户端**（部署之间发这个请求）与**出站队列选传输**（探测原生，对方 404 再回退 `/send`）。

   原始三选一（用户 2026-09-27 先问"直接写对方 Pod"，再补："如果写入比较复杂，调用对方的 api-server 咯？
   api-server 负责写"）：
   - **① 现状**：Matrix 联邦 `PUT /_matrix/federation/v1/send/{txnId}` → 对端部署校验并写**自己的** Pod。
     好处：校验在写入侧、授权面最小；代价：Xpod↔Xpod 内部也走 Matrix 协议栈（事务、txnId 去重规则、密钥交换）。
   - **② 发送方直接写对方 Pod**：需要每个参与者给别人的部署一份**写**授权（信任面最大）、校验移到读取时、
     一条消息写 N 份。
   - **③ 调用对方 api-server，由它写自己的 Pod**（用户本轮补充）——**推荐**。三点理由：**写权限仍只在本部署内**
     （不需要跨参与者写授权）；**校验仍在写入侧**（对端 api-server 收到已签名的事件后，按房间授权规则自行判定）；
     传输是普通认证 HTTP，**Xpod↔Xpod 不再需要 Matrix 联邦协议栈**，而 `/send` 退为**纯互通边界**（真 homeserver
     只会说 Matrix，那部分不因内部机制改变）。
     所需零件基本都已存在：签名请求认证（X-Matrix 那套，含密钥发现与退役密钥规则）、Pod 路由派生
     （`participantRoutes.ts`）、入站校验（`validateInboundPdu`）、写自己的 Pod（`acceptReceivedEvent` + 服务 grant）。
     **当时缺的三件**（2026-09-27 更新：第一件已落地，见本节开头）：一个**原生入站端点**（Xpod 自己的路径，
     不放在 `/_matrix/` 下）、对应客户端、以及出站队列 **怎么选传输**（能力探测 + 回退：先试原生，对方 404 再走
     `/send`）与去重键（按 event id 已经幂等，txnId 可继续用于批内顺序与重放应答）。
   - ~~请确认走 ③（或说明要 ①/②）~~ **已确认走 ③**（2026-09-27）。

1. ~~models 侧那张 keyed 控制记录表~~ / ~~"判赢家"~~ / ~~布局偏离~~ **全部已收口并落地**（2026-09-27）。
   三条线索合成一个已实现的控制记录承载，细节见[控制记录契约](matrix-control-records-contract.md)：

   - **承载**：models 已有的 `taskResource`（不新建表）。布局跟随 models 的"按天累积"约定：
     `<pod>/.data/task/{yyyy}/{MM}/{dd}/<kind>-<sha256(key)>.ttl#self`——一天一目录、**一条记录一个文档**，
     `kind` 前缀把入站回执（`txn-`）与出站批次（`outbound-`）分开。写前逐层条件 PUT 容器
     （**没有容器就列不到、订阅不到**，这正是"客户端自己负责同步"所依赖的）；查找窗口 2 天就是保留期。
   - **不做 CAS，也不判赢家**：入站回执不需要唯一赢家（事件 id 由发送方定、接受按 event id 幂等），
     所以是"幂等插入 + 记录优先"；真正需要唯一赢家的**本地事件预留**由身份库 SQL 的唯一键保证。
     代价写在契约 §6.3（并发重放会重复校验；应答可能取最后写入的那份）。
   - **出站队列也落 Pod**：同一布局的 `outbound-` 前缀，`pending` 靠**列目录**（一天一次容器列举 + 每条一次读，
     窗口 7 天），`scopes()` 由已服务的路由回答；**已接进容器**，重启后靠列目录找回欠账。
   - **两条实测更正**：`If-Match` 不是版本检查（ETag 是 `DC.modified` 毫秒）；容器 `ldp:contains` 本来可用
     （早先"只列出 1 个"是 Turtle 逗号列表的解析错误）。
   - **一条实测缺陷（已规避、待上游修）**：同一文档里的两行会**合并 `object` 列**（嵌套主体按行位置命名），
     实测把回执与批次并成一条记录——这就是"一条记录一个文档"的真正理由（契约 §8）。
2. **grant 的索取流程**（契约 §5.4）——**"加入房间拿授权、出房间取消授权"这条已实现（2026-09-28）**，
   而且不需要另建一套凭证生命周期：**房间级授权就是成员资格本身**。入站写入在
   `acceptReceivedEvent` 里按**解析状态**取本人 membership 判定（`inboundAuthority.ts`，已接线）——
   他加入 → membership 变 join → 允许；他退出/被踢/被封 → 状态明确说他不在 → 403。
   授权随状态**自动取得与失效**，没有第二处需要同步的记账（这正是"状态明确说他不在这房间"与
   "这个 Pod 还不知道"要分开的原因：前者拒绝，后者放行）。
   **仍未定的是更下一层**：参与者把 **Pod interface key** 交给部署（`TaskCredentialStore.grant`）这件事
   **什么时候问、界面上怎么表达**——那是产品流程，不是这里的授权判定；在此之前没有 grant 的部署
   在取 Pod 句柄时就 403（响亮失败，不静默、不写别人的 Pod）。

   **一条必须先写下的边界（否则按字面实现会把邀请打死）**：**"参与者必须已加入房间"只适用于非成员事件**。
   邀请、踢出、封禁、退出的送达对象**本来就不是**（或不再是）房间成员——`m.room.member` 正是"他怎么进/出这个房间"
   的载体，而登记册前面已经落地过"收到未知房间的事件要补出房间记录，否则邀请在接收方不可见、也无法加入"
   （`materializeReceivedRoom`）。所以判定要分两类：
   - **`m.room.member` 事件**：只要授权（grant）在，就允许写入——它们是成员身份的**变更手段**，不是成员身份的**结果**；
   - **其它事件**（消息、状态等）：要求该参与者**此刻在该房间里**（解析状态里的 membership = join）。
   两类都不放松"没有 grant 就 403"这条底线。
   **已落地（2026-09-28）**：判定写成纯函数 `src/api/matrix/inboundAuthority.ts`
   （`inboundWriteAuthority({grant, type, membership})` → `{allowed, reason}`），单元 4 项覆盖：
   无 grant 一律拒（连 `m.room.member` 也拒）、成员可写消息、非成员（invite/leave/ban/knock/未知）拒且理由点名状态、
   `m.room.member` 在房间未知时也允许（这正是邀请能送达的原因）、**状态未知（正在建立成员身份）也允许**。**尚未接线**，接线点已查清（下一轮从这里开始）见下。
   - **接线点**：入站落库入口 `PodMatrixStore.acceptReceivedEvent({event, context})`
     （`PodMatrixStore.ts:1174`）已经拿到 `event.type`、`room_id` 与 `context`，判定所需三样都在手边——grant 的
     有无（没有时 `matrixPodWriteFor` 会先抛 403，判定只是把"为什么"说清楚）、事件类型、该参与者在**解析状态**里的
     membership（同一处已在用的 `resolvedState(roomId, context, events)`，取 `m.room.member` 且 `state_key` 是本人）。
   - **接线时一起验证的三件事（已全部验证通过）**：
     ① **邀请仍能送达**（房间未知时 `m.room.member` 必须放行——这正是它豁免的理由）；
     ② 已落地的"收到未知房间的事件要补出房间记录"不能回归（`materializeReceivedRoom` 必须在判定**之前**跑，
     否则"房间未知"会把该补的房间连同邀请一起拒掉）；
     ③ **加入握手带来的房间初始状态不能被判死**：远端加入时，对端随 `send_join` 回的是**加入之前**的房间状态
     （create/join_rules/power_levels 等**非成员**事件），此刻这个 Pod 里的解析状态**还没有**本人的 join——
     若把"membership 未知"当成"非成员"拒绝，握手的第一步就会被自己拒掉。因此判定要区分**三态**而不是两态：
     - `membership === 'join'` → 放行；
     - `membership` 为 invite/leave/ban/knock（状态**明确说**他不在房间里）→ 拒绝；
     - `membership === undefined`（这个 Pod 还不知道他的成员身份，正在建立）→ **放行**，由后续的 `m.room.member`
       事件把状态补齐；这条也是纯函数里 `m.room.member` 豁免之外必须保留的"未知即放行"。
     换句话说：**拒绝的依据是"状态明确说他不在这房间"，不是"我还不知道"**——纯函数已按三态实现（单元第 5 项
     专门覆盖 create/join_rules/未知 membership 放行）。
3. **D6 Agent 归属**——**已定（2026-09-27）：Agent 作为房间成员（有自己的 MXID）**。写路径因此可以强制 v11 授权规则。
   实现路径（本轮细化，按"复用已有机制、不新增协议路径"排序）：

   - **已落地（2026-09-28，第一步）**：**MXID 推导收进一处并覆盖 Agent**——`protocol/serverName.ts` 的
     `matrixUserIdFor(subject, serverName)`（参与者传 WebID，Agent 传它自己的 URI），`PodMatrixStore` 改为委托它。
     "这个 MXID 是不是我们的"仍然靠**计算**而不是查表；参与者与 Agent 不会长出两种拼法。测试：`serverName.test.ts`
     新增 1 项（同一身份稳定、不同身份/不同 server 不同、Agent URI 与 WebID 共用同一条规则）。
   - **Agent 的身份就是它的 MXID，不需要第二把密钥（2026-09-28 更正上一版）**：Matrix 的密钥是**按 server name**
     的，不是按用户——一个 homeserver 用一把密钥服务它名下所有用户，协议里没有"每用户一把密钥"这回事。
     所以 Agent 的 MXID 取**运行它的那个部署所属参与者的 server name**（`@u_<sha256(agentUri)>:<ownerServerName>`，
     推导已落地），事件由**该 server name 现有的那把身份**签名——这不是"服务身份代签"，就是普通签名：
     sender 的域属于它，签名就该由它出。
     上一版写的"给 Agent 单独铸造一把签名身份、私钥封存在 Pod"会**在同一 server name 下造出第二把身份**，
     与登记册自己的边界第 2 条（"一个 server name 一把签名身份"）冲突，故撤销。
     于是这条路径少一整块：**没有新的密钥托管要做**。
   - **成员事件走正常通道**（两步，都是普通已签名事件）：先由房间里有权的人**邀请** Agent（`m.room.member`
     `membership: invite`），再由 Agent 发 `join`（`sender == state_key == Agent 的 MXID`，授权规则 5.2.2
     允许被邀请者加入）；两步都由该部署现有的 server name 密钥签名，经现有写入路径与其预占/投递，不新增端点、
     不新增密钥。
   - **已落地（2026-09-28）：授权即成员**。`setState('co.undefineds.agents')` 现在先读**上一版**授权
     （diff 必须在写入之前读，否则读到的是刚写进去的那份），写入新状态后为**新增**的 Agent 补两条成员事件：
     邀请（sender = 授权人）+ Agent 的 join（`sender == state_key == Agent 的 MXID`，由本部署的 server name
     密钥签名——Agent 的 MXID 就在这个 server name 下）。已授权过的 Agent 不再重写（不无谓地追加房间历史）。
     测试：`PodMatrixStore.test.ts` 新增 1 项（两条事件、join 的 sender/state_key 都是 Agent、重复写同一条授权
     不追加历史）；`tests/api/matrix` 588 passed / 3 skipped，`test:integration:lite` 159 passed / 6 skipped。
     **撤销授权：已按登记册既有原则收口（2026-09-28）——撤销停执行，不停成员身份**。理由是登记册自己
     已经写下的那条："Matrix 的协议签名/事件验证与 Agent 的执行授权分别成立"：`co.undefineds.agents` 是
     **房间级的执行授权表**，成员身份是**协议事实**，两者不是一件事。删掉一条授权后，该 Agent 仍是房间成员
     （可见、可被提及、历史完整），但 `agentGrants` 不再包含它 → 一切执行路径都在授权处被拒。
     这也与"离开即撤销"不矛盾：后者讲的是**成员身份**变化如何影响写入权限，前者讲的是**执行授权**。
     因此这里**无需改代码**（当前行为已经如此），只把口径写清楚，避免以后误加"撤销即踢出"。
     **仍未做：v11 规则强制**。本轮把"到底缺什么"查清了，比原来那句话小得多：

     - **入站事件已经强制**：`validateInboundPdu` → `protocol/authRules.authorizeEvent`，对端发来的每条 PDU
       都按 v11 规则校验（这正是"规则先当纯校验器"那半）。
     - **本地写入是等价但更粗的门**：`requireJoined`（sender 必须是**解析状态**里的 join 成员）、
       `requireRoomOwner`（房间级状态变更）、`authorizeTargets`（Agent 执行授权）。
     - **真正缺的**：本地写入没有跑 `authorizeEvent` 本身，所以**power level 的细粒度**没有逐条执行——
       谁能改 `m.room.power_levels`、谁能 ban/kick、`join_rules` 允许哪种加入、`@` 开头的 state_key 限制等；
       `requireRoomOwner` 只是粗粒度替代（"是不是房主"≠"power level 够不够"）。
     - **前置已落地（2026-09-28）**：event → `AuthEvent` 的投影收进一处——`protocol/authRules.ts` 的
       `toAuthEvent(event)`（`AuthEvent` 就定义在那个模块），`FederationHandler` 里原先的私有副本改为委托它。
       理由与规则本身一样：同一事件被两处投影会变成"一个事件两种判法"。这一步**不改任何行为**
       （`tests/api/matrix tests/api/handlers` **1032 passed / 3 skipped**）。
     - **启用方式（下一步，钩子点已定位）**：**唯一的构建点**是 `PodMatrixStore.appendEvent` 里的
       `buildPersistedEvent`（`PodMatrixStore.ts:1060`）——本地事件只在那里成形，所以规则强制就落在
       **成形之后、落库之前**：把刚构建的事件（`type`/`sender`/`state_key`/`content`/`prev_events`/`auth_events`）
       连同它的 `auth_events` 从房间**解析状态**里解出的 `AuthEvent[]`（`timeline` 多数调用方已经读过）
       交给 `authorizeEvent(event, authEvents)`，`decision.allowed === false` 就 403 并把 `v11-x.y.z` 原因原样带上。
       **不要在这里判入站事件**：收到的 PDU 走 `acceptReceivedEvent`，且已经在 `validateInboundPdu` 里判过一次
       （重复判定会让同一事件在两处解释，且这里的 auth events 是本地状态、语义不同）。
       **试行结果（2026-09-28，已按此回退，树保持绿色）**：按上面的做法真的接上跑了一轮
       `tests/api/matrix`（584 passed / **4 failed**），失败**不是误判，而是暴露出两条真实缺口**——
       正是"先过规则"这一步要发现的：

       1. ~~**Agent 重新授权时不能重发成员事件**~~ **已修（2026-09-28）**：`admitGrantedAgents` 现在先读
          房间**解析状态**里该 Agent 的成员身份，**只补缺的那一步**——已是成员就什么都不写、是 invite 就只补 join、
          是 leave/knock 才重发邀请；**被封禁的不自动恢复**（撤销封禁是房主的决定，不该是"发执行授权"的副作用）。
          测试：`PodMatrixStore.test.ts` 那项扩到"撤销授权 → 再次授权"后成员事件仍是 `invite, join` 两条
          （此前会写第二条 invite，正是 `v11-4.4.3` 拒掉的那个）。
       2. **远端加入不能只按本地状态判**：`v11-4.3.4: join_rule requires an invite`（`remoteJoinStore` 两项）。
          房间在**别的部署**上时，邀请（或公开 join_rules）只存在于常驻方；本地 `send_join` 回来的状态是
          **加入之前**的，可能既没有邀请也没有 join_rules 的最终形态，于是本地规则把一次**已经被常驻方接受**
          的加入判死。这正是前述"入站 auth events 来源语义不同"的同一条：这类 join 的权威是**常驻方的接受**，
          不是本地重放；强制时必须为"握手产出的 join"留一条**明确的**通道（例如带上常驻方的签名状态作为
          auth events，或对该路径豁免并注明理由），而不是把规则放宽。
       两条修好后重跑全量门禁再上线。
   - **只有到这一步之后**，写路径才可以按 v11 规则强制（rule 5 要求 sender 已 join）——这正是登记册
     "授权与执行"一节把规则只当纯校验器的原因；强制与 Agent 成员事件要在同一轮落地，否则 Agent 的消息会被拒。
   - **restricted join 的附加签名**（`join_authorised_via_users_server`）先不做：它是"房间在别的 server 上、
     由常驻方替你背书"的场景，而 Agent 与它的部署同侧，用不上；等出现跨部署 Agent 再补。
3.5（已落地，保留在此便于追溯）~~**"判赢家"要不要保留**~~ **已按你的问题收口并实现**（2026-09-27）。你的质疑成立：**入站回执不需要
   唯一赢家**。它服务两处、强度不同——① **本地事件预留**必须有唯一赢家（事件 id 由内容推导，两个赢家＝
   客户端一次发送变成两条消息），而这部分的原子性由**身份库 SQL 的唯一键**提供，不在 Pod 承载里；
   ② **入站回执**很弱（事件 id 由发送方定、接受按 event id 幂等，两个赢家的数据后果为零），只需
   "重放答首次应答"。因此：
   - `writeControlRecord` = **读、无则插、返回记录**（幂等插入，不是 CAS）；并发下两个调用者都可能拿到
     `created: true`，而 Pod 里只有**一条**记录。代价写进契约 §6.3：并发重放会重复校验；应答可能取最后写入的那份。
   - **布局随之自由**，并已按你的指示改成与 models 一致：`<pod>/.data/task/{yyyy}/{MM}/{dd}/transactions.ttl#<hash>`
     ——和 `message.schema.ts` 的 `{parent}/{yyyy}/{MM}/{dd}/messages.ttl#{key}` 同一个约定（deliveries 同形），
     也顺带消掉了 create-once 带来的"必须先建容器、释放必须删文档"两个坑（现在从不删文档）。
   - 查找窗口 `CONTROL_RECORD_LOOKBACK_DAYS = 2` 天就是保留期：超窗重放当新事务（安全，因为按 event id 幂等）。
   - **回退成本很低**：若哪天要严格唯一赢家，只需把 `controlRecordAddress` 改回"一条记录一个文档"。

4. **真实实例验收方式**：你问"Docker？"——**刚测过，本机 Docker 仍无响应**（`docker info` 与 `docker ps`
   挂住 90 秒被 SIGTERM 杀掉），所以既跑不了 `full` 门禁，也用不了 Docker 起的真实实例。需要你**重启
   Docker Desktop**（或告诉我用别的运行时/远端 docker context），之后我用它跑 `full` 并补真实实例证据。
   备选仍是"用本分支另起一个栈"（① 不动你正在跑的 3000）。原始选项：① 用本分支**另起一个栈**
   （推荐，不动现有实例）；② 用本分支重启 3000；③ 先不补（现状只有模块级 + 进程内真实 HTTP/TLS 证据）。

另有一项**环境阻塞**：`full` 门禁需要 Docker，而本机 Docker Desktop 无响应；重启会停掉你其它容器，所以没有擅自处理。

## 真实实例探测发现的缺陷（2026-09-28，lite 真实栈）

不带 Docker 也能取得"真实实例"证据：lite 门禁跑的就是本分支的**真实栈**（Gateway + CSS + API + 真实 Pod），
于是把验收表里的探测直接打在它上面，并加进门禁（`tests/integration/MatrixInstanceProbe.integration.test.ts`）。
**通过的**：`/.well-known/matrix/client` 200 且带 `m.homeserver.base_url`；`/_matrix/client/versions` 200 且版本非空；
`PUT /_matrix/federation/v1/send/...` 无签名 **401 `M_UNAUTHORIZED`**；`GET /_matrix/federation/v1/version` 200
且带 `server.name`/`server.version`。

**探测出来的问题：一条已修、一条仍开**

1. ~~**原生端点 `POST /_xpod/matrix/inbound/:txnId` 在真实部署上回 404**~~ **已修（2026-09-28）**：网关的
   `Proxy.shouldRouteToApi` 只认 `/_matrix`，`/_xpod` 被当成 CSS 路径 → 404。补上 `/_xpod` 前缀后，
   同一探测现在回 **401 `M_UNAUTHORIZED`**（已写进门禁断言）。**这条曾经意味着 ③ 在真实部署里没有真正生效**
   （客户端会一直 404 回退到 `/send`），所以是必须修的实质缺口，不是测试细节。
2. ~~**`GET /_matrix/federation/v1/query/directory?room_alias=…` 无签名回 404**~~ **已查清：不是缺陷，是探测问错了名字
   （2026-09-28）**。处理器**先解析被寻址的 server name**（`contextForName(serverName)`），本部署不服务该名字就回
   404 `M_NOT_FOUND`，之后才验签；探测当时问的是 `#nobody:stranger.example`（本部署不服务）→ 404 合理。
   改问**本部署服务的名字**后，同一探测回 **401 `M_UNAUTHORIZED`**，已写成断言。
   **顺带明确一条设计取舍**：这个顺序让未签名调用者能问出"你服务这个名字吗"（信息量极小：服务与否本就可以由
   能否解析出来推断），换来的是一条更清楚的回答——"不是我服务的名字"与"你没签名"是两回事，对端与运维都能立刻看懂。

不带 Docker 也能取得"真实实例"证据：lite 门禁跑的就是本分支的**真实栈**（Gateway + CSS + API + 真实 Pod），
于是把验收表里的探测直接打在它上面，并加进门禁（`tests/integration/MatrixInstanceProbe.integration.test.ts`）。
**通过的**：`/.well-known/matrix/client` 200 且带 `m.homeserver.base_url`；`/_matrix/client/versions` 200 且版本非空；
`PUT /_matrix/federation/v1/send/...` 无签名 **401 `M_UNAUTHORIZED`**；`POST /_xpod/matrix/inbound/...` 无签名
**401 `M_UNAUTHORIZED`**；`GET /_matrix/federation/v1/version` 200 且带 `server.name`/`server.version`。

## 剩下的唯一实现项：本地事件预留迁出 SQL（2026-09-28 设计已定，未动代码）

登记册的准入表里只有"仅凭 Pod 恢复"是**部分达成**：回执 / 批次 / 密钥都在 Pod，**本地事件预留**仍在身份库
`xpod_matrix_transactions`。迁出所需的一切都已就位，且**只需要一处接口改动**：

- **四个反查点都手里有完整事件**（`PodMatrixStore.ts:1679/1802/1861/1886`，形如
  `findReservation(scope, event.eventId)`），而事件行现在带 `txnDevice`，于是
  `[txnDevice, roomId, type, txnId]` 这个 key 可以**算出来**——不需要按 event id 建索引，更不需要扫描。
  **已落地（2026-09-28）**：`MatrixEventJournal.reservationKeyForEvent(event)` 就是这个重建，
  并有测试**把写入侧与读取侧钉在一起**——用 spy journal 记下 `reserveTransaction` 实际收到的 key，
  再从**存下来的那一行**（只有 `metadata.protocols.matrix`）重建，断言两者相等；没有预留的事件返回
  `undefined` 而不是一个错的 key。
- **接口已改成"按事件查"（2026-09-28 落地）**：`MatrixReservationLookup`（`eventId` + 可选的
  `roomId`/`type`/`txnId`/`txnDevice`），`findReservation(scope, event)` / `findReservations(scope, events)`；
  四个反查点改为把**整个事件**传进去。SQL 版仍按 `event_id` 索引回答（它本来就该那样），
  **内存版先用 key 点查、拿不到再退回原来的扫描**——这正是 Pod 版将采用的路子，先在一个实现里跑通。
  这一步**不改行为**（`tests/api/matrix tests/api` **1898 passed / 7 skipped**、`typecheck:test` 通过）。
- **序号三法留在 SQL**（`registerEvent`/`registerEvents`/`getHighWatermark`）：它们是**部署本地、可从 Pod 重建**的
  顺序（测试已钉住"两次独立重建一致"），不属于"事务记录落 Pod"这条目标。
- **迁移的安全网**：接受事件按 event id 幂等，预留只是"这笔客户端事务对应哪个事件身份"；迁出期间两版并存时，
  以 Pod 版为权威（SQL 版保留为回退读取，一个发布周期后删除）。

**为什么现在没做**：它改的是本地写入的**身份钉住**路径（重放必须落在同一个事件上），需要
"实现 → 全量门禁 → 处理回退"的完整迭代余量；本会话上下文已不足以安全完成，因此按惯例停在此处并写下设计。

## 状态规则

- **已定**：用户已明确或既有项目规则确定的目标；实现尚缺不构成重新打开目标的理由。
- **待细化**：目标不变，需选择具体机制、补齐故障处理及验收。
- **现状**：已存在的代码行为，不等于被接受的目标或已通过目标验收。
- **已撤销**：旧前提不再约束后续实现，保留原因供追溯。

## 已定目标与实现差距

| 决定 | 依据 | 实现状态 / 证据边界 |
| --- | --- | --- |
| 实现 Matrix 分布式房间与事件语义，参与者数据持久化到各自 Pod | 用户 2026-09-25 明确目标，2026-09-26 授权修订 | **已落地**：每参与者签名身份与密钥（Pod 内封存）、server name 由 WebID 派生、事件图/状态解析/授权规则、联邦收发与握手、原生端到端传输（③）、入站回执与出站队列都落在各参与者自己的 Pod。证据与门禁见[验收记录](matrix-collaboration-acceptance.md)（含真实 Pod 用例）；**真实实例**验收仍待你选方式 |
| 一个逻辑房间、稳定 room/event 身份，事件复制不改变身份 | Matrix 协议；用户确认 | **已落地**：`event_id` 由 reference hash 推导、签名覆盖 redacted event、跨 Pod 同一 id（`twoDeployment` 双侧断言）；URI 派生 event_id 的旧提案已撤销 |
| Pod 保存消息、同步/投递进度、事务记录及必要执行凭证 | 用户确认存储归属 | **大部分已落地**：消息、事务回执、出站批次、签名密钥都在 Pod。**仍留在身份库 SQL 的**是本地事件预留与同步序号（`xpod_matrix_transactions`/`xpod_matrix_events`）。预留那一半的最后一块拼图已落地（事件行携带 `metadata.protocols.matrix.txnDevice`——设备是 key 里唯一不在事件上的部分，于是"事件 → 预留"是两次点查）；序号那一半需要你在三个选项里选一个（契约 §10.2，推荐取消序号、改用 `(origin_server_ts, event_id)` 游标——它同时让有界读取成为可能） |
| Solid Chat 是共享消息表达，协议事件的验证材料必须无损保存 | 项目 models 归属规则；Matrix 验证要求 | **已落地**：事件以 models 消息行保存，完整可验证 PDU 存在 `metadata.protocols.matrix.event`（含 `hashes`/签名），路由/状态/回执都从它读 |
| Pod 资源 URI 是持久资源地址，不是浏览器缓存 | 用户 2026-09-26 澄清要求 | 不要求浏览器缓存、额外镜像库或独立映射表 |
| 副本接收不自动获得 Agent 执行权 | 多智能体执行正确性要求 | **等 D6**：执行归属（Agent 是否为房间成员）未定，写路径因此不强制 Matrix 授权规则；副本接收本身不触发执行（收到的事件不转发、不入队） |
| 去重、同步和执行证明职责分开，持久事实均在 Pod | 用户确认；存储契约 | **大部分已落地**：事务回执与投递批次都在 Pod（重启可恢复，有真实 Pod 证据）。**例外**是本地事件预留与同步序号仍在身份库 SQL——它是"去重"的一半，迁出与前一行同一件事 |
| 当前阶段停用跨请求 allow/deny 判定缓存，只保留请求内复用 | 本轮授权修复方向；用户授权按审查修订 | **已指认并结案（2026-09-27 代码追查）**：所指的缓存是 Pod 侧的**元数据缓存**，它**本来就是请求内复用**——`src/storage/MetadataRequestContext.ts` 用 `AsyncLocalStorage` 持有 `metadataCache`，而唯一的写入点是每个请求开头的 `TracingHandler`（`enterWith({ metadataCache: new Map() })`），所以 Map 的生命周期就是一次请求；没有请求上下文时（后台任务）根本没有缓存。另两处也不是跨请求判定缓存：CSS 的 `CachedResourceSet` 只缓存**存在性**且键是标识对象（WeakMap，实际按请求）；`agentGrants` 每次都读当前状态，由 `agentGrantFreshness.test.ts` 固定（撤销后下一次调用立即 403、重新授予立即通过）。**结论**：这条登记描述的"跨请求判定缓存"在现有代码里不存在，无需停用（若将来引入，位置应以同样的"只有请求内复用"为准绳） |

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
5. **已按此收口（2026-09-27，依据如下，若你认为需要显式记录请指出）**：不需要房间级
   `serverName` 字段——房间的"来源 server"已经在 create 事件的 `sender` 里；成员身份在
   `m.room.member` 的 `state_key` 里逐字保存，从不按当前 server name 重算；身份选择是按**每个
   事件**的 sender 做的。因此老房间里的老 MXID 保持原样、继续由老身份验证，新房间用新身份，
   不会出现"同一房间内同一人的新老 MXID 互认"问题——真正需要的是**能力判定**（见下条），
   而不是多记一个字段。

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
- **已落地**（2026-09-27）：server name 改为**能力判定**：WebID host 只有在注册表确实持有
  该身份密钥时才作为该参与者的 server name，否则回落到部署自身名字（`getServerName`）。
  因此不可能把事件归给一个签不了的 server；老房间的老 MXID 原样保留；单身份部署行为不变。
  测试 `tests/api/matrix/participantIdentity.test.ts`：alice.example 与 bob.example 两个身份
  下，MXID/room_id/签名各自归属、跨身份验签失败、未注册 host 回落部署身份、成员列表按各自
  server 呈现。
- **已落地**（2026-09-27）：**身份密钥的供给**。`identityProvisioning.ts` 在**该身份自己的 Pod**
  里生成并封存密钥集（用该参与者的 Pod 授权；拿不到访问权即拒绝），幂等——已存在就读回、
  **绝不替换**（替换会让该身份已发布的所有签名失效），并报告 `created`/`keyId`/`storageId`
  供审计与轮换；`MatrixSigningIdentityRegistry.register` 让运行中的部署能把新身份挂上，
  能力判定随之生效。测试 `identityProvisioning.test.ts` 含端到端闭环：供给 → 注册 → Alice 的
  MXID/room_id 变为 `alice.example` → 事件由该身份签名 → 用其发布公钥验签通过。
- **已定（2026-09-27，用户复核后收口）：绑定不需要独立承载**——此前"新增 `matrixIdentityBinding`
  实体 / 通用设置文档加 metadata / credential 再加一行"的三选一**全部撤销**。理由是那条绑定里其实
  没有新事实，三件事分开就各有着落：
  1. **server name 由 WebID 的 host 推导**（边界 1），不需要记；
  2. **WebID 本来就跟着事件走**：`senderWebId` 是事件字段，成员事件的写入者就是该参与者本人，
     所以"这个房间里的这个 MXID 是谁"由**房间自己的成员记录**回答，不需要一张全局每用户表；
  3. **Pod 由既有 WebID → Pod 查询回答**（`PodLookupRepository`），密钥行的位置更是由能力决定
     （`matrix-signing-<serverName>` 就在该 Pod 的 credentials 文档里），不需要额外索引。
  结论：**房间就是索引**。部署要重建"本部署替谁签名"，扫自己服务的房间的成员记录即可
  （`senderWebId` 的 host → server name），既不用动 models，也不用给设置文档加列。
  仍然缺的只有一件，且它本来就是另一个问题：**远端成员的 WebID**——收到的事件 `senderWebId`
  必须为空，因为 MXID 的 localpart 是 `u_sha256(WebID)`，不可反推；它的承载位置同样是房间成员记录
  （由对方的可验证绑定提供），不是全局用户表。
- **待确认（2026-09-27 收窄到一个具体消费方）**：`identityBinding.ts`（含 7 项测试）在"房间就是索引"
  下**没有消费方**——路由与签名都不依赖它，Pod 迁移的版本/确认也由房间成员记录 + WebID→Pod 查询覆盖。
  唯一能想到的真实用途是**多 Pod 参与者**：一个 WebID 注册了多个 Pod 时，"哪一份 Pod 存着他的
  签名密钥"是既有事实，而它推不出来（见下条策略为此拒绝供给）。因此三选一：① 删除（多 Pod 参与者
  就固定用部署身份，行为已文档化）；② 把这个事实收窄成"server name → 存放密钥的 Pod"一条最小记录
  并接存储；③ 改成在**部署侧**（而不是用户 Pod）记这条对应关系，避免写进用户数据。**确认前保留、
  不接存储。**
- **已定（2026-09-27，用户答复"进 room 的时候给"，并按 MXID 的性质收口为"不得晚于第一次命名"）**：
  **供给必须发生在本部署第一次"命名"该参与者之前**。原因不是策略偏好而是协议事实：MXID 是
  Matrix 里唯一的用户标识（事件的 `sender`、成员 state_key、power level、invite 都只能写 MXID），
  它的 localpart 由 WebID 唯一决定（`u_<sha256(webId)>`，与本仓库既有实现一致），**只有 server 段
  取决于供给**；一个参与者在拿到密钥前被命名，就会被命名在**部署名**下，而这条 invite 在他被供给后
  再也匹配不上——新参与者第一步就死锁，且跨部署时对方部署无法替他兜底。
  因此钩子从"进 room 时"上移到**所有会命名他的路径**：`getAccount`（`whoami`/账号信息，客户端据此
  得知自己的 MXID 并对外告知）在返回 MXID 之前调用，`createRoom`/`joinRoom` 在写入该参与者的成员
  事件之前调用。落地为 `PodMatrixStoreOptions.participantIdentity`：钩子正常返回即表示本部署替该身份
  签名（能力判定随之生效），未供给（本部署不服务他）则继续落在部署身份上；**没有钩子的单身份部署
  行为完全不变**。实现细节与理由：
  - **必须在成员事件之前供给**：join 事件的 `sender` 与签名取决于身份，先写后换会让同一个人在一个
    房间里出现两个 MXID；
  - **供给会改变 MXID，所以 join 时按供给后的身份重新查成员**：invite 必须指向该参与者加入时
    使用的身份；**但任一身份下的 ban 都继续生效**，供给不能成为绕过封禁的路径；
  - **`sendEvent`/`leaveRoom` 绝不供给**：房间里已经记下了他的身份，写入时必须继续用同一个身份，
    否则旧房间会被供給"搬走"MXID（这正是需要 per-room 身份选择的地方，属旧房间兼容边界）；
  - 钩子抛错则**整个写入失败**（房间与成员事件都不落），不留半状态；`getAccount` 也因此可能失败——
    宁可响亮失败，也不发出一个随后会变的 MXID。
  测试 `tests/api/matrix/participantProvisioning.test.ts` 7 项（getAccount 前供给使报出的 MXID 属于
  参与者自己的 server、不服务他时保持部署名、create 前供给使 room id 与 create 事件由该 server 命名
  并验签、join 前供给并传 target Pod、已加入/发送/离开不写第二份成员事件、供给失败不落任何事件、
  无钩子行为不变）。
- **已落地**（2026-09-27）：**供给真正接上了运行部署**。新增 `podParticipantIdentity.ts`
  （`createPodParticipantIdentityProvider`）做"选哪个 Pod、什么时候不供给"的判定，容器在
  `matrixParticipantIdentity` 里用 `matrixSigningIdentityForPod`（根密钥封存 + 该参与者自己的
  Pod 授权）把它接上，并只在本部署**自己也能签**（存在 `matrixServiceIdentity`）时启用——否则未被
  供给的参与者会回落到一个签不了的部署名，写入会被拒。判定规则与理由：
  - **只用注册在该 WebID 名下的 Pod**，绝不用"本次请求写入的 Pod"：共享房间 Pod 属于别人，
    私钥不进别人的 Pod；
  - **注册了多个 Pod 时拒绝猜**（记 warn 并保持部署身份）：给同一个 server name 造出第二把 key set
    会让该名字的签名变得有二义，宁可不供给；
  - **已经能签就直接返回**（不读 Pod、不铸造），所以第一次之后零成本；
  - 供给失败**向上抛**（写入失败），不把参与者悄悄挂到别的身份下。
  测试 `tests/api/matrix/podParticipantIdentity.test.ts` 7 项（用注册的 Pod 供给并注册 server name、
  已能签则短路、无 Pod 时不供给、多 Pod 拒绝猜、同一 Pod 重复登记视为一个、WebID 无可用 host 时跳过、
  失败向上抛）。
- **已落地**（2026-09-27）：**server name 的语法与推导收进一处**（`protocol/serverName.ts`：
  `isMatrixServerName`、`splitServerName`、`webIdServerName`）。此前 `PodMatrixStore` 里另有一份
  "WebID 的 host"实现，现在 store、key 拉取、请求认证、域名解析四处共用同一份判定，
  "这个 WebID 属于哪个 server"只有一个答案。测试 `tests/api/matrix/protocol/serverName.test.ts` 4 项。
- **已落地（当时记为"待建"，现更正）**：**入站 federation 的路由归属**。当时的方案是"用 PDU 的 `room_id` 找房间、
  在成员记录里找 `senderWebId` 的 host 等于 destination 的那个成员"；实际落地的方案更简单也更硬：
  **destination name → 参与者 WebID → 该 WebID 已登记的 Pod**，全部由 `participantRoutes.ts` 派生（不记录绑定），
  歧义（同名多参与者、同参与者多 Pod）**直接拒绝**。请求侧只接受本部署持有密钥/登记的 server name，否则 403。
  当时列的两个开放点现状：① **不需要**"远端成员的 WebID 可验证"——路由不看成员记录，只看 destination；
  ② destination 落到**部署名**（旧房间兼容边界）时不再有"写哪个 Pod"的歧义：部署名不在派生出的服务集合里，
  因此**拒绝**（403），而不是猜一个 Pod。
  备选（不推荐）：把 Pod 放进路径前缀（协议插件式前缀入口），能立刻绕开这些，但偏离 Matrix 标准
  路由形状，现有 SDK/对端按标准地址打过来会直接 404。

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
  **metadata 不需要"声明"**（用户 2026-09-27 确认）：它是不透明的 JSON 列，把协议事实放进去不产生 models 变更，
  也不需要为每个键先加 schema；真正需要在 models 声明的，是**成为一等实体或可查询维度**的东西（表、列、可下推的
  索引字段）。这条同时是"哪些控制记录能先落 Pod、哪些必须先补 models"的判据。
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

**已落地 + 测量（2026-09-27）：客户端同步的空闲路径不再重复读房间**。`sync` 的第一趟仍然全量读，
它是**索引趟**：直接写进 Pod 的原生行在 journal 里还没有序号，而"读之前取的 watermark"不可能包含
这趟刚分配的序号，所以这趟的结果按设计丢弃（测试专门守护这一点：模拟原生行写入后必须能被 sync 看见）。
之后的等待循环改为：**watermark 没动就不再逐房间读**（每趟只做一次 watermark 查询）。效果是把空闲
轮询的成本从"每轮 N 个房间的全量读"降到"一次索引读 + 一次读取趟 + 若干次 watermark 查询"；
以 harness 的 `db.select` 调用数为度量：`timeout=1200ms` 的空闲 sync 从"随轮数线性增长"变为
**≤4 次**（不随等待时长增长）。顺带修掉 `/messages` 里一次**结果被丢弃的重复全量读**（现在每页
只读一次时间线）。仍存的成本与出路：每次 sync 调用仍有一次索引性全量读，省掉它需要 Pod 侧的变更
信号（Solid 通知）或索引，属"客户端增量"待办的下一层。测试
`tests/api/matrix/syncBoundedReads.test.ts` 5 项（空闲不再逐房间读且真的等待、token 之后的新事件照报、
原生行仍被索引、`/messages` 每页只读一次、向后分页边界不丢）。

**规模测量（2026-09-27，`tests/api/matrix/scaleOperations.test.ts` 4 项，以 Pod 往返与读到的行数为度量）**：
写入（1 select + 1 insert）、状态读（1 select）、`/messages` 一页（2 selects、≤16 行）在 **10 房间与
200 房间下逐项完全相同**，即有界且与房间数无关；**增量 sync 是 2 × (房间数 + 1) 次往返、行数≈全量 sync**
（50 房间：102 次、602 行 vs 600 行）—— 即一趟的成本是 **O(Pod 内事件总数)** 而不是"变化的部分"，
因为房间读取是整条时间线、且第一趟必须索引原生写。空闲等待循环零读取（20 房间：42 次，不随等待时长增长）。
1000 房间 + 2000 事件的堆增量为 **9.6 MB**，单房间读取仍为常数。把它真正变成有界需要 **Pod 侧变更信号
（Solid 通知）或可下推的索引**，这正是"客户端增量"待办的下一层；注意这是**每个 Pod** 的成本。

## 房间在 Pod 里的形状与 Solid 通知（2026-09-27 查证，用户提问"一个房间一个文件吗，subscribe 能监听内容变化吗"）

**查证结果（都有代码/运行证据，不是推测）**：

1. **一个房间不是"一个文件"，而是一个目录**：`.data/chat/<roomSurface>/`
   - `index.ttl` —— 房间文档（`#this` 是房间本体，`#thread` 是它的消息线）；
   - `YYYY/MM/DD/messages.ttl` —— **该房间当天的事件**，每条事件是文件里的一个**行（subject = hash(event_id)）**，
     房间归属由 `thread` 列表达，不由路径表达。
   所以"一个房间一个文件"接近但不准确：**一个房间一个子树**，其中事件按天分文件（这是 models 的布局规则，
   权威在 models；Xpod 只写值）。查证方式：用 `messageResource.buildIri(scope, {id, parent: chatIri, createdAt})`
   直接算出真实 IRI。
2. **Solid 通知是按"发生变化的那一个资源"投递的**，而且**容器会在子资源变化时收到变化活动** ——
   CSS 的 `DataAccessorBasedStore.writeData` 在创建/更新子资源时会把**父容器**加进 `changes`
   （`addContainerActivity`），`MonitoringStore` 对每个变化标识发 `changed`，`ListeningActivityHandler`
   再按**精确 topic** 查通道（`storage.getAll(topic)`）。通道 topic 需要对该资源有 Read 权限。
   ⇒ **订阅房间目录（`.data/chat/<room>/`）就能收到"这个房间有新东西"的通知**，而且粒度正好是房间、
   权限正好是房间读权限（= 成员），不会泄露别的房间。

**这直接回答了上一轮的两个悬而未决的问题**：

- **sync 的索引趟（O(Pod 内事件总数)）可以去掉**：改为订阅本 Pod 的房间目录（或 Pod 根），
  收到通知就把对应 scope/房间标脏，下一次 sync 只读脏房间。这正是测量里唯一不有界的那一项的解，
  而且**不需要 models 改动**。自己 Pod 的通知不存在隐私问题（订阅者就是本部署自己）。
- **跨部署的原生信号**：对端订阅该房间目录（需要成员读权限），收到通知后**自己去取增量** ——
  这就是"Xpod↔Xpod 用 Solid 通知"的原生路径；`/send` 推送仍是与真 homeserver 互通的兼容面。
  注意：**通知是信号不是投递保证**（离线会漏、没有重放），所以对端仍要有"取增量"的有界读取，
  并且我们这侧仍要保留**投递进度记录**（队列）——通知只替换"什么时候发/什么时候取"。
- **我们自己写的事件不需要通知来发现**（写的人就是自己），所以出站触发器不需要靠通知；
  通知真正解决的是两件事：**别人（原生/外部写入者）改了我们的 Pod**，以及**对端如何知道我们改了**。

3. **通知体里带着"变的是哪个子资源"**：`AddRemoveNotificationGenerator` 生成的通知形如
   `{type: Create|Update|Delete|Add|Remove, object: <变化资源的 IRI>, target: <订阅的容器>, state: <etag>}`。
4. **【更正上面第 2 条的一半，2026-09-27 同日查证】**：**订阅容器收不到"子资源被更新"的通知**。
   `DataAccessorBasedStore.writeData` 里加父容器活动的那段有 `!exists` 守卫 —— 只有资源**被创建**时
   才把父容器放进 changes（`createRecursiveContainers` 也只在创建缺失容器时加）；对**已存在**资源的
   写入，changes 只有 `{该资源: Update}`。所以：
   - 容器订阅只能告诉你"这里**新出现**了资源"（新房间、某天第一次写）；**当天文件里追加一条消息不会
     通知任何容器**；
   - **要监听"内容变化"，topic 必须是那个真正被改写的资源**：房间的**当天消息文件**
     （`…/.data/chat/<room>/YYYY/MM/DD/messages.ttl`），或者一个我们每次写入都会**更新**的
     **每房间标记资源**（更新已存在资源 → 订阅该资源本身能收到）。
   因此上一轮写的"一条通道订阅容器就够"是**错的**，已按此更正；可行的两种粒度是：
   ① **按天文件订阅**（每房间每天一条通道，跨天要续订；不需要额外写入，但通道数 = 房间数 × 活跃天）；
   ② **每房间标记资源**（每房间一条稳定通道；代价是每次事件多一次小写入，且**只有配合的写入者**
   才会碰它 —— 外部原生写入者不会，所以它适合对端通知，不适合发现"别人改了我们的 Pod"）。
   两条的取舍留给实现时按用途选：**对端通知**用②（稳定、每房间一条），**自己 Pod 的原生写入发现**
   用①（不依赖写入者配合）。

## 变更信号与有界 sync（2026-09-27 落地）

- **订阅侧**（`notifications/roomChangeSubscription.ts`）：按 topic 建 WebSocketChannel2023 通道 →
  连接 `receiveFrom` → 解析通知体（`object`/`target`/`type`/`state`/`published`）→ **断线后重新建通道**
  （通道在最后一个 socket 关闭时被回收，复用旧 URL 会静默失效）→ 失败上报且持续重试直到 `stop`，
  `start` 幂等。7 项测试（建通道与 topic、收通知、断线重订、建不成的通道如实报错而不是假装在看、
  socket 失败持续重试、stop 后不再重试、通知体解析与忽略无效体）。
- **消费侧**（`PodMatrixStore` 的 `roomChanges` 端口 + `roomChangeFullPassMs`）：`sync` 只在
  "调用者已追平"且"来源可信"时按来源给的房间清单读取。实测（20 房间）：**空闲已追平的 sync 从 42 次
  Pod 读降到 0 次**，**单房间变更从 42 次降到 4 次**；落后的调用者、来源自认不完整、以及**每 5 分钟的
  全量兜底趟**都会读全部房间 —— 兜底是为了"漏掉的通知不会让变更永久丢失"。
- **`settle` 的语义很关键**：一次 sync 期间到达的变更不能被当成已读，所以只有**本次真正读过**的房间
  才允许从来源移除；否则等待中的变更会被永久吞掉（测试覆盖"等待期间到达的变更会被下一次迭代取到"）。
- **已落地**（2026-09-27）：**订阅 → 变更来源的接线**（`notifications/roomChangeTracker.ts`，
  `implements MatrixRoomChangeSource`）。每个房间订阅**当天**的消息文档（真正会被改写的那个资源；
  容器订阅看不到"已存在资源被更新"，见上一节的更正），房间列表来自 `rooms()`，**跨天时 `refresh()`
  续订并把旧天的通道停掉**；通知体里的 `object` 先按 topic 精确匹配、匹配不上再按**房间目录前缀**归属，
  两者都不行就**放弃自称完整**。
  **信任语义**（这是这套东西最容易骗到自己的地方，所以写死）：`trust` 只有在**每个想要的 topic 都订上了**
  时才是 `changed`；**订阅失败、socket 断开（干净的 close 也算，因为缺口期间会漏）、无法归属的变更**一律
  回到 `all`（= 读遍所有房间），直到重新订上（`onReady`）再恢复。代价也写清楚：**一个 R 房间的 Pod 要
  R 条通道 / R 个 socket** 来换"sync 不再每次读遍所有房间"；不愿付这个代价的部署就不配变更来源，
  `sync` 行为与之前完全一致。测试 `tests/api/matrix/notifications/roomChangeTracker.test.ts` 7 项
  （按房间订当天文档、只报变化的房间、目录内其它资源的变更也归属到该房间、无法归属则降级、
  订不上则降级、跨天续订并停掉旧 topic、断开降级与重连恢复、stop 后清空）。
- **已落地**（2026-09-27）：**把 tracker 挂到"本部署服务的每个 Pod"**（`notifications/roomWatchService.ts`
  + 容器 + 运行时后台服务）。此前 tracker 已经能按房间订阅当天消息文档，但**没人告诉它有哪些 Pod/房间**：
  - Pod 集合**派生**自 `participantRoutes.routes()`，不再需要配置；每个 Pod 一个 watcher，房间列表来自 store 的
    `listJoinedRooms(context)`（部署侧 `service` 上下文，与入站写入同一份授权策略）。
  - 这个服务**本身就是** store 的 `MatrixRoomChangeSource`：`pending({scope})` 按 Pod 根路由到该 Pod 的 watcher；
    **没被 watch 的 scope 一律回 `trust: 'all'`**（"读遍所有房间"）——静默回"没有变化"是唯一错误的答案，
    会永久丢事件。
  - **周期对账**（默认 30s，`intervalMs: 0` 关掉定时器供测试）：参与者出现/离开/换 Pod 由下一趟接住，与出站
    队列的周期兜底同一个理由；单个 Pod 订阅失败**只上报**，其余 Pod 照常 watch，失败的那个继续 `trust: 'all'`；
    stop 停掉全部 watcher 并拒绝之后再新建。store 与 watcher 的循环依赖**靠惰性**打破：watcher 只在启动时才向
    store 要房间列表，而那是容器构建之后的事。
  - 按仓库既有做法加了 `PodMatrixStore.getRoomChanges()`——"store 有没有真的拿到这个 source"是最容易在重构里
    丢掉的一环（与 `getQueue()`/`getOutbox()` 同一理由），容器测试直接断言两者是同一个对象。
  测试：`roomWatchService.test.ts` 8 项（watch 每个服务中的 Pod 且端点由 Pod 根推导、按 scope 路由与"未 watch →
  trust: all"、Pod 出现/消失时新建与停止、单个 Pod 失败不影响其他且它保持 trust: all、stop 后不再新建、没有
  watcher 时什么都不 watch、定时器对账与 stop 清理、端点推导含无尾斜杠的 Pod 根），
  `MatrixOutboundContainer.test.ts` 新增 1 项（服务存在且**就是** store 的变更来源、未启动时回 trust: all、
  无 Pod 注册表时为 undefined）。
- **仍未接**：把同一套订阅用于**对端**（对端订阅房间目录 → 收到通知来取增量）。

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
- **已落地**（2026-09-27）：解析状态**按 Pod + 房间记忆化**，键是"生成该状态的事件列表"的
  指纹（事件数 + 最新事件 id + 序号和），因此追写会改变键、调用方拿不到早于自己写入的状态；
  条目只持有调用方已有记录的引用，上限默认 64 个房间（`stateCacheLimit` 可设，0 关闭），按
  LRU 淘汰。写入路径上 `requireJoined` 与 `agentGrants` 现在共用同一次解析，sync 循环里未变更
  的房间不再重复回放。实测：202 事件的房间连续 200 次读，未缓存 341ms → 缓存 79ms（4.3×，
  其中仍包含每次调用的事件读取，省掉的是回放）；测试 `roomStateCache.test.ts` 6 项覆盖命中、
  追写失效、房间隔离、淘汰后仍正确、可关闭/可设上限。
- **已落地**（2026-09-27）：**增量重放**。缓存改为持有该房间的重放（`MatrixRoomStateReplay`）：
  只保存**极值点的状态**与已见事件的协议形态（后者用于从新事件回溯 auth chain/mainline）。
  追加事件时只处理新增事件与其父状态，极值点集合就地更新，内存不随房间线性增长（只留极值点，
  外加一个 id 集合）；输入列表**不是纯追加**时（回填到中间、少了事件、旧房间无图字段）返回
  undefined，调用方退回整房间重放，而不是悄悄算出错的状态。实测：在 ~200→400 事件的房间上连续
  100 次追加，整房间重放 311ms → 增量 93ms（3.3×）。测试 `roomStateReplay.test.ts` 7 项
  （追加状态事件、未增长返回同一对象、回填拒绝、少事件拒绝、fork 追加与合并、连续单事件追加、
  旧房间回落）。
- **待收口**：现在每次调用仍要**读整条时间线**（`listEvents` 物化全部事件），增量重放省掉的是
  状态计算，不是这次读——写路径的剩余成本已落在"有界读取"上，与"客户端有界增量同步"是同一件
  事（需要存储侧按序号/日期分桶的有界查询）。`requireJoined` 等在没有现成事件列表时的回退路径
  仍用单槽位 Pod 读（`findLatestStateEvent`），未走解析。写入路径强制执行授权规则仍等 D6 定案。

## Federation 兼容面（D4）实现进度

**范围边界（2026-09-27 澄清，用户提问"是否要做 Synapse 那样的 homeserver"）**：目标**不是**做一个
Synapse 等价的 homeserver，而是实现 **Matrix 的分布式房间与事件语义**（见"已定目标"），把 Pod 当持久层、
把参与者身份当签名主体。据此：

- **做**：事件格式/ID/哈希/签名、授权规则、状态解析、房间事件图、密钥发布与获取、入站/出站事务、
  缺失事件与历史获取，以及让真实 Matrix 客户端与服务器**能互通所需的最小协议面**。
- **不做**（明确不在目标内）：账号注册/登录（用 Solid/OIDC）、设备与 E2EE 密钥管理及交叉签名、
  在线状态/输入提示的 fanout（EDU 只做透传）、媒体仓库、房间目录、推送网关、Admin/Appservice API、
  worker/分片等 homeserver 运维面；也**不为别人的用户保存事件副本**——只保存本部署所服务参与者的副本。
- **为什么 `/send` 推送路径还在**：真实 homeserver 不会说 Solid notifications，所以它是**互通边界**，
  不是 Xpod↔Xpod 的原生机制；原生机制是 Solid 通知 + Pod 读取/ACL（见"三种同步"）。
- 顺带一个与范围无关的协议事实：Matrix 本身允许**一个 homeserver 服务多个用户**，"每参与者一个
  server name"是本项目的**身份与数据归属选择**（见"签名身份与密钥归属"），不是协议要求。

- **已落地**（2026-09-27）：**远端 verify key 的获取与信任**（`federation/serverKeys.ts`）。
  `MatrixServerKeyFetcher` 拉取 `GET /_matrix/key/v2/server` 并做三件规范要求的事：
  ① 响应必须**自签**（用自己的 verify_keys 之一验签），否则中继可以替别人的 server name 塞进
  自己的密钥；② 有效期取「发布值与 7 天」的**较小者**（key exchange 要求，防长期密钥绕过撤销）；
  ③ 并发调用共享一次请求、按 `valid_until_ts` 缓存、拉取失败一律报"没有密钥"而不是"未签名"。
  `verifyRemoteEventSignature` 按规范校验事件签名：签名覆盖 **redaction 后**的事件；
  `valid_until_ts` 必须 **≥ 事件的 `origin_server_ts`**（room v5+ 签名要求）；`old_verify_keys`
  里的密钥只接受 `origin_server_ts <= expired_ts` 的事件（那台服务器声明停用该密钥之前的事件）。
  这一步补上了此前 `authorizeEvent` 说明里"签名由调用方负责"的空缺——现在有了可用的实现。
  测试 `tests/api/matrix/federation/serverKeys.test.ts` 9 项（缓存/合并请求/过期重取/7 天截断/
  伪造自签/不可达/内容篡改/过期后才发出的事件/退役密钥窗口/可注入 endpoint 供 discovery）。
- **已落地**（2026-09-27）：**入站 PDU 校验流水线**（`federation/inboundPdu.ts`），按规范
  §"Checks performed on receipt of a PDU" 的顺序执行并逐条注明：① 结构合法（room v11 事件格式；
  `prev_events`/`auth_events` 同时接受纯 id 与 Synapse 历史上用的 `[id, {sha256}]` 二元组，统一
  归一为 id）；② 由 `sender` 所属 server 的密钥验签（复用上一轮的 key 获取与有效性规则）；
  ③ **内容哈希不符时按规范 redact 后继续处理，而不是丢弃**（载荷不可信不等于事件不可信）；
  ④ 授权规则，且**只用事件自己选中的 auth_events** 判定——调用方给的列表只作查表，多给房间
  状态也不会改变判定。另外：事件 ID 由收到的事件推导（v11 reference hash），调用方可据此去重
  而不必相信对方给的 id；`auth_events` 有引用取不到时返回 **`deferred`**（依赖缺口要补，不能猜）；
  本模块不写 Pod——持久化接收到的事件是调用方的事。测试
  `tests/api/matrix/federation/inboundPdu.test.ts` 7 项（接受、结构不符、伪造 sender/无密钥、
  内容篡改→redact、缺 auth event→deferred、未加入者发言被拒、二元组归一）。
- **已落地**（2026-09-27）：**接收到的事件按原样落 Pod**（`acceptReceivedEvent`）。它刻意不复用
  本机写入路径：本机事件是"构建并签名"，而收到的事件已经带着自己的 hashes 与签名，重建或重签会
  毁掉验签材料、加签则会冒认作者。存进 `metadata.protocols.matrix.event` 的是原事件 + **本机推导
  出的 `event_id`**（推导是安全的：内容哈希、reference hash、签名都不覆盖 `event_id`，而读者
  必须对身份有共识）；另标记 `received: true`，因此该行的所有者**不会被误当成作者**——
  `senderWebId` 保持未知，因为远端作者的 WebID 无法从 MXID（哈希）反推，要等对方自己的绑定可查。
  按 event_id **幂等**（对端重放事务不会写出重复事件），并进入房间时间线、解析后的状态与事件图
  （下一条本机事件的 `prev_events` 会指向它，证明写入路径读到的极值点来自 Pod）。测试
  `tests/api/matrix/receivedEvent.test.ts` 5 项，含"远端 join 经 `validateInboundPdu` 接受后
  落 Pod 并在房间状态里显示为 join"的端到端链路。
- **已落地**（2026-09-27）：**入站事务的接收语义**（`federation/inboundTransaction.ts`）。事务 id 是
  **对端去重的键，不是我们的信任来源**，所以先 `reserve` 再处理：同一个 `(scope, origin, txnId)`
  只允许一个处理者，第二个进来拿不到预留就是「事务在处理中」，按规范回
  **503 `M_UNKNOWN` "Transaction is still being processed; retry"**（可重试，绝不重复落库）。
  处理完成后把**每条 PDU 的应答原样记下**，重放事务直接返回首次响应而不重新处理——这是
  `PUT /_matrix/federation/v1/send/{txnId}` 对重试的硬要求（否则对端重发会写出第二份事件或
  拿到不一致的应答）。对端用同一个 txnId 换了载荷（指纹不符）时**保留首次记录**并打上 `conflictAt`
  标记，不覆盖首次结果、也不静默接受新载荷。逐条 PDU 的应答沿用入站校验流水线：通过则
  `{}`，被拒/延后则带 `error`，且**不影响同一事务里其他 PDU**（规范允许部分成功）。
  预留的载荷指纹用规范化 JSON（键序无关），canonical JSON 本身拒绝的载荷也要能算出指纹而不是抛错。
  当前承载是内存实现 `InMemoryMatrixInboundTransactionStore`；**落控制 Pod 是待办**（接口已经按
  `scope` 分片，Pod 实现只需替换 store）。测试
  `tests/api/matrix/federation/inboundTransaction.test.ts` 7 项（接受并逐条应答、重放同一响应且只处理
  一次、同 txnId 异载荷保留首次并标记冲突、验签失败记 error、未完成事务返回 503、
  auth_events 两种列表形态与指纹稳定性、不同 origin 的 txnId 互不干扰）。
- **已落地**（2026-09-27）：**federation 请求签名认证**（`federation/requestAuth.ts`）。每个出站请求带
  `Authorization: X-Matrix origin=…,destination=…,key=…,sig=…`，签名覆盖的 JSON 是**从请求本身重建**的
  `{method, uri, origin, destination, content?}`，因此方法、目标（含 query）与请求体都被签名绑定：
  为 `GET /…/version` 签出的东西不能改成 `POST` 打到别的端点，动一个字节的 body 就失效。头里的
  `origin` 是**发送方的声明**，签名才是让声明可用的东西——所以用 `origin` 选密钥、用头里的 `key` 选试哪把。
  两个容易做错的规范细节在这里定死：① `destination` **可以缺席**（v1.3 以前的发送方不带，
  接收方必须继续接受；这种情况必须按"签名对象里也没有该字段"重建，补上就一定验不过），
  但**一旦出现且不是本机 server name 就必须 401 拒绝**，否则截获的请求能被重放到非目标服务器；
  ② `old_verify_keys`「只用于签事件」，所以**退役密钥永远不能认证请求**，哪怕它仍能验旧事件。
  头解析按 RFC 9110：参数名大小写不敏感、顺序无关、值可加引号（反斜杠转义要还原）也可为裸 token、
  兼容性上允许裸值含冒号、未知参数忽略；规范正文写 `signature` 而所有实现发 `sig`，**两个名字都收**。
  密钥的新鲜度仍由 key source 负责（请求没有事件时间戳可比，不叠加第二层窗口）。
  顺带把「server name 形状」抽成 `isMatrixServerName` 并在 `MatrixServerKeyFetcher` 里使用：server name
  来自对端数据（事件的 `sender`、请求的 `origin`）而会被拼进 URL，先把 `/`、`@`、空白、凭据、fragment、
  非法端口挡掉，避免它把请求引向别的主机或路径。测试
  `tests/api/matrix/federation/requestAuth.test.ts` 13 项（往返与签名字段、验签通过、destination 不符被拒、
  pre-v1.3 无 destination 仍接受、method/uri/query/body 任一被改都失败、密钥不对、退役密钥不认、
  未知 origin 报"无法验证"、非 server name 的 origin、头解析的大小写/空白/引号/转义/别名/未知参数、
  残缺头视为无授权、server name 正反例）。
- **已落地**（2026-09-27）：**server name → 可达目标**（`federation/serverNameResolution.ts`），即
  federation 的客户端解析面。严格按规范的顺序实现：① IP 字面量直接用（无端口则 8448）；
  ② 带显式端口的 server name 直接连，不问 `.well-known`；③ 否则取
  `https://<host>/.well-known/matrix/server`，`m.server` 合法则按 `host[:port]` 处理，
  且**委派不再递归查 `.well-known`**（规范 3.1–3.5 没有第二次查询）；④ `.well-known` 缺失/不可用/
  出错时才查 SRV `_matrix-fed._tcp.<host>`，再退到已弃用的 `_matrix._tcp.<host>`；⑤ 都没有则
  `https://<host>:8448`。**每个分支都按规范保留 Host**，所以结果同时给出 `baseUrl` 与 `hostHeader`
  ——委派到别的 host 时请求仍要声明原 server name，这正是目标机用 TLS 证明"我是合法委派"的方式。
  发现结果按规范缓存：尊重 `Cache-Control: max-age`、缺省 24h、上限 48h、`no-store` 不缓存；
  失败缓存 1h 且**连续失败指数退避**（仍以 48h 封顶）；并发解析共用一次请求；SRV 的缓存交给 DNS 解析器。
  SRV 解析函数是注入的（部署接 `node:dns`，缺省即不查 SRV，测试保持无网络）；`selectSrvRecord` 实现
  RFC 2782 的最低优先级 + 权重选择。测试 `tests/api/matrix/federation/serverNameResolution.test.ts`
  13 项（IP 字面量、显式端口不发请求、合法委派、委派端口/SRV、`.well-known` 缺失与坏 JSON 与 404、
  隐式 8448、24h/max-age/48h 上限/no-store 缓存、失败 1h 与指数退避、并发共请求、非法名、
  `m.server` 解析、server name 拆分、SRV 选择）。
- **已落地**（2026-09-27）：**出站事务发送**（`federation/outboundTransaction.ts`）。规范在这里有一条
  容易忽略的硬规则：**「必须先等到 200 才能换 `txnId`」**——txnId 正是对端做去重的键（`inboundTransaction.ts`
  就是按它去重的），每次重试都换一个新 id 会让对端把同一批 PDU 处理两遍。所以 `deliverTransaction`
  **从调用方拿 txnId 并全程复用**，自己永不生成；`sendTransaction` 只做**一次**尝试。
  一次尝试的结论分三类：`delivered`（200 且能读出 per-PDU 结果）、`rejected`（4xx 非限流：对端已经
  就这次请求做了决定，重试没有意义）、`retry`（5xx、网络不可达、429 限流、以及"200 但读不出结果"——
  对端尚未就绪，重试是安全的，因为对端按 txnId 去重）。**签名覆盖的是实际发出的请求**（含编码后的
  txnId 路径），所以对端不必相信 body 里的任何声称；`content-type` 与 50 PDU / 100 EDU 上限也在
  客户端强制。退避：指数增长 + 抖动（默认 20%，避免多发送方同步重试），对端给的
  `retry_after_ms` / `Retry-After`（秒或 HTTP 日期）优先，但**不得超过退避上限**，否则对端可以借
  限流把我们无限期挂住。测试 `tests/api/matrix/federation/outboundTransaction.test.ts` 16 项，含
  **收发闭环**：我们发出的请求直接交给 `authenticateXMatrixRequest` 用本部署公钥验签通过，包括
  txnId 含 `/` 与空格时路径编码与签名仍然一致。
  已知传输层缺口（**2026-09-27 已补**）：`.well-known`/SRV 委派时规范要求 TLS 证书覆盖**原 server name**、`Host`
  也是原 server name，而 `fetch` 既不能改 SNI 也（在多数运行时）不能改 `Host`。现在由
  `federation/federationFetch.ts` 承担：连接地址与 server name 分离、SNI/`Host` 取 server name，出站投递与密钥
  获取共用同一个实例（见下文该条）。**仍未证**：与真实委派对端的一次真实 TLS 握手（需要真实证书/CA）。
- **已落地**（2026-09-27）：**出站队列**（`federation/outboundQueue.ts`）。客户端知道"一次事务怎么发、
  什么时候值得重试"，队列决定"发什么、按什么顺序"——规范的另一条硬规则在这里：**必须等一个事务拿到
  200 才能换 `txnId`**，所以**每个 (origin, destination) 对是一条严格有序的队列**：队首未送达就绝不
  尝试后面的（那是另一个 txnId），一个卡住的队列不影响其他队列。origin 是队列的一部分，因为
  **每个参与者都是自己的 server**、而对端的去重键是 (origin, txnId)：本部署托管的两个 origin 就是
  两个独立发送方。由此推出两条容易做错、已写死的行为：
  ① **只能往「从未尝试过」的批次追加 PDU**——往对端可能已经处理过的批次里追加，会让新 PDU 藏在一个
  对端会重放其**存档应答**的 txnId 后面（见 `inboundTransaction.ts`），等于永久静默丢失；
  ② **4xx 解锁队列、失败不解锁**——拒绝是对端已就这次事务做了决定，把它当可重试会把目的地卡死。
  另外：txnId 由批次从创建起一直持有到送达或被拒（绝不中途换）；同一个 `event_id` 重复入队会被去掉
  （对端本来也会按 event id 去重，只是省一趟）；超过 50 PDU / 100 EDU 自动切分成多个批次，各自一个
  txnId；store 按 scope 分片、整条记录读写，控制 Pod 实现可以等位替换内存实现。测试
  `tests/api/matrix/federation/outboundQueue.test.ts` 15 项（建批次与 txnId、按 50 切分保序、按 event_id
  去重、无 id 不去重、空入队无操作、**不往已尝试批次追加**、scope 隔离、EDU 与纯 EDU 事务、
  送达即清空、**失败即止步并计 blocked**、跨 flush 保持同一 txnId、拒绝后继续、健康目的地不受影响、
  单目的地 flush、无待办即无调用、默认 id 互不相同）。
- **已落地**（2026-09-27）：**按 origin 选签名身份的出站发送器**（`federation/outboundSender.ts`）。
  这是"每参与者即自己的 server"在出站方向的直接推论：事务的 origin **不是部署**，而是事件所属的
  参与者，必须用**那个身份**的密钥签名——用部署密钥统一签会把所有人的事件都归到部署名下，正是托管
  决策禁止的错签。实现是"每个 origin 一个 client（client 持有签名者），首次使用时创建并复用"；
  **本部署没有该 origin 的密钥就返回 `rejected`**（不重试、也绝不借别的密钥签——验签方无法把它与
  伪造区分开）。注册表若对未知名字抛错，与返回 `undefined` 同义处理。测试
  `tests/api/matrix/federation/outboundSender.test.ts` 7 项，含**跨身份验签**：以 `alice.example` 发出的
  请求用 Alice 的公钥验签通过、用 Bob 的公钥验签失败。
- **已落地**（2026-09-27）：**收件人集合**（`federation/destinations.ts`）。事件发给**房间里参与者的
  服务器**（有 joined 成员的 server），membership 事件额外发给该事件**所涉及成员**的 server（邀请、
  踢出、退出时对方未必是 joined），**绝不发给自己**（本地已有，发给自己是永远清不空的收件箱）。
  结果去重并稳定排序，供 outbox 直接入队。测试 `tests/api/matrix/federation/destinations.test.ts` 6 项。
- **已落地**（2026-09-27）：**写入后入队**（`PodMatrixStoreOptions.outbound` +
  `queueFederationDelivery`）。写入路径只做"该告诉谁"：**origin 取事件 `sender` 的 server**（不是部署，
  所以事务由事件所属身份签名），**destination 取解析后状态里房间参与者的 server**（membership 事件
  额外带上该事件所涉及成员的 server），**PDU 就是持久化的协议事件**——带 `hashes` 与签名、`event_id`
  由内容推导（测试直接断言 `computeEventId(pdu) === pdu.event_id`），正是对端要验的东西。
  **投递不在写入延迟内**：联邦往返不塞进本地写入，对端不可用由队列吸收；没有配置队列时行为与之前
  完全一致（单部署房间 `eventDestinations` 返回空，一个事务都不入队）。测试
  `tests/api/matrix/outboundDelivery.test.ts` 6 项（消息以 sender 的 server 发给对方 server 且 PDU 可验、
  邀请送达被邀请者 server、全本地房间不入队、只邀请未加入的成员不算参与 server、收到的事件**不转发**、
  无队列时写入不变）。
- **已定（2026-09-27，用户拍）**：**收到的事件不转发**。`acceptReceivedEvent` 只落库、不转发给房间里
  其他 server。规范说 resident server "必须把事件发给房间里其他 server"，同时也在别处讨论了"服务器
  可以选择不转发那些绕过 ban 的事件"；转发会引入放大与滥用面，所以按不转发实现（要改时再显式决策）。
- **待定（需要拍）**：**谁触发 flush**。先说清"队列"是什么：它**不是轮询机制**，而是登记册三层同步里
  "每个目的 Pod 的**持久投递进度**"那条要求的落地——重启、部分成功之后必须知道"还欠谁什么"，以及
  Matrix 规范"等 200 才能换 txnId"这条顺序要求。**触发器与记录是两件事**：记录（队列）无论如何都要有，
  触发器可以换。
  用户指出应优先用 **Solid 的 subscribe/notifications 特性**（本仓库已有整套通知栈：
  `config/notifications.json` 的 WebSocketChannel2023、通道记录存 `internal_kv`、启动清扫器；emitter
  挂在 ResourceStore 上，所以 Pod 写入天然会通知订阅者）。据此把选项重列为：
  ① **通知驱动**（推荐，Xpod↔Xpod 的原生路径）：对端订阅房间 Pod 的通道，被通知后自己去取增量；
     我们这侧"被通知/被订阅"就成了 flush 的触发信号，不需要定时器，也不需要把往返塞进写入。
     注意**通知是信号不是投递保证**（离线期间会漏、没有重放），所以仍要配合"有界增量读取"（登记册
     "客户端增量"待办）与投递进度记录；跨 Pod 订阅还依赖 Solid ACL 与"谁有权订阅"的能力判定。
  ② 写入后内联 flush（最简单，但把联邦往返加进写入延迟）。
  ③ 周期后台 worker（写入零影响，但需要"谁跑、多副本如何互斥"的部署决定）。
  ④ 只暴露按需入口（最可控，但要有人真的调用）。
  与它一起待定的是**投递记录落在哪**（内存 store 已就位，控制 Pod 承载去 SQL 仍是待办）。
  另需记住：**真 Matrix homeserver（Synapse 等）不会说 Solid notifications**，所以 `/send` 推送路径
  是"与现有 Matrix 生态互通"的兼容面，不会因为走通知而消失。
- **已落地**（2026-09-27）：**入站 `/send` 的处理体**（`federation/inboundRoute.ts`）。把
  `PUT /_matrix/federation/v1/send/{txnId}` 上"接收方必须做的判断"从 HTTP 传输里剥离出来，按规范顺序
  执行：body 必须是 JSON 对象 → 请求必须带**覆盖本次请求**的有效 `X-Matrix` 签名（复用 `requestAuth`）
  → 事务 id 从路径取（与签名里的 uri 一致）→ **body 里的 `origin` 必须等于签名认证出的 origin**
  （否则等于把别人的请求记到自己名下，而对端按 (origin, txnId) 去重）→ `pdus` 必须是数组且 ≤50 →
  再交给事务层（预占、重放、逐条应答、处理中 503）。**刻意不在处理体里决定**两件事：**写哪个 Pod**
  （按请求所指向的 server name 向调用方要目标；本部署不服务该名字就 403，而不是把别人的房间写进任意
  Pod）与**谁有权读写那个 Pod**（`acceptEvent` / `resolveAuthEvents` 由调用方提供）。因此 HTTP 外壳
  与 Pod 归属解析是仅剩的接线，处理体本身已完整可测。
- **已落地**（2026-09-27）：**收到的事件让房间在接收方可见**（`materializeReceivedRoom`）。此前
  `acceptReceivedEvent` 只写消息行，房间没有 chat 记录，于是 `listRooms` 看不到它——**邀请在接收方
  不可见、也无法加入**。现在收到未知房间的事件会**按事件本身**补出房间记录：room id 用对端的、
  author 用 create 事件的 sender（**绝不写成 Pod 所有者**，否则 `requireJoined` 的兜底会把本地用户
  当成已加入），幂等且不覆盖已有记录。
- **已落地**（2026-09-27）：**两个独立部署的闭环验证**（`tests/api/matrix/federation/twoDeployment.test.ts`
  4 项 + `inboundRoute.test.ts` 8 项）：两个 Pod、两种身份、各自队列与事务记录，出站请求交给对端
  处理体（等价真实 HTTP 跳转）；房间状态与邀请跨 Pod 送达并被授权、Bob 的加入事件由 `bob.example`
  签名且 A 原样保存、Alice 的消息以相同 event_id 落到 B、**重放事务返回首次响应且不写第二次**。
  证据与门禁现状见[验收记录](matrix-collaboration-acceptance.md)的"跨部署闭环证据"。
- **已落地**（2026-09-27）：**出站路径接进了运行部署**（`federation/outboundDelivery.ts` + 容器）。
  此前 `matrixStore` 在容器里**没有拿到 `outbound`**，整个出站实现只有测试在用（"生产里是死的"）。
  现在容器注册 `matrixOutboundDelivery`：把**域名解析**（`.well-known` 优先、SRV 兜底，`node:dns` 的
  答案用 `nodeSrvRecords` 改名成规范里的 target）、**按 origin 选身份签名**、**出站队列**装配成一件东西，
  再把它的 `outbox` 交给 store；store 另加 `getOutbox()` 供触发器取用（与已有的 `getQueue()` 同一形状）。
  **没有自己的身份就不装配**：一个每批都会被放弃的队列比没有队列更糟。测试
  `outboundDelivery.test.ts` 5 项（入队→签名→按解析结果发出、`.well-known` 委派、无法签名的 origin
  直接拒绝、SRV 兜底、dns 答案改名）与 `MatrixOutboundContainer.test.ts` 2 项（有身份时
  `matrixStore.getOutbox()` 就是交付对象的队列——**这条链接最容易在重构里丢掉**；无身份时两者都是
  undefined）。
- **已落地**（2026-09-27）：**出站队列的驱动**（`federation/outboxScheduler.ts` + 容器 + 运行时）。
  此前队列接进了 store 但**没有任何东西推它**，所以生产里投递仍然不会发生。现在：
  **信号可插拔**（`schedule()` 就是写入/通知/运维调用的入口）+ **周期兜底**（默认 30s，`intervalMs: 0`
  只用于测试），**串行**（一趟在跑就不会有第二趟，两个写入者不会各自把同一队列抽干）与**合并**
  （一趟进行中到达的信号只换来"恰好再来一趟"）；单个 scope 失败**不中断**其余 scope 并把错误上报；
  scope 列表来自队列自身（`MatrixOutboundStore.scopes()`，控制 Pod 实现同样能回答），所以调度器不需要
  知道"本部署服务哪些 Pod"。调度器**构造即 armed**（纯信号驱动也能工作），`start()` 只加周期定时器，
  `stop()` 才彻底停止；作为后台服务由 `BackgroundServiceSupervisor` 随 API server 启停（含存活复查）。
  测试 `federation/outboxScheduler.test.ts` 8 项（按 scope 汇总一趟并上报、纯信号驱动、串行与合并为
  恰好一趟、单 scope 失败继续、注册并清除定时器/启停幂等、stop 后不再排、scope 列表读失败只上报、
  无工作时不调用），`MatrixOutboundContainer.test.ts` 追加断言（有身份时调度器存在且能跑空趟、无身份时
  两者都 undefined）。
- **已落地**（2026-09-27）：**写入即信号**（`createSchedulingOutbox` + 容器组合）。store 拿到的
  `outbound` 现在是一层薄包装：`enqueue` 成功且有新批次就调用 `scheduler.schedule()`，所以**一次写入
  之后立刻会有一趟投递**，而不是等最多 30s 的兜底；本地写入**不等待**它（不 await），重复事件（入队返回
  空批次）不触发，入队失败也不触发。**端到端证据**：`twoDeployment.test.ts` 新增一项 —— 两侧都按生产
  方式接线（store → 调度包装 → 调度器 → 队列 → 按 origin 签名 → 对端处理体），**除了最开始的房间引导
  之外不再有任何手工 flush**：Bob 的 join 靠写入自己走到 Alice，Alice 的一条消息靠写入自己走到 Bob 的
  Pod，两侧都断言了 scheduler 没有报错。
- **已落地**（2026-09-27）：**历史与状态读取端点的两半**（`federation/roomHistory.ts` 的
  `selectBackfill`、`federation/roomStateSnapshot.ts` 的 `stateSnapshotBefore`/`stateIdsBefore`、
  `MatrixRoomStateReplay.stateBefore`，以及客户端的 `backfill`/`getState`/`getStateIds`）。
  - **`/backfill`**：`GET /_matrix/federation/v1/backfill/{roomId}?v=…&limit=…`（**GET + query**，`v` 可重复，
    `limit` 必填、按规范上限收敛到 100）。语义与其它回溯**相反的两点**：**包含**点名的事件本身
    （请求方正是因为没有才来要），并**从新到旧**返回（请求方向后翻页，最新的一条是它的锚点，
    拿回的最旧一条是它下次的起点）。
  - **`/state` 与 `/state_ids`**：`?event_id=…` 返回该事件**之前**的房间状态（规范原文"prior to
    considering any state changes induced by the requested event"）与它所依赖的 auth chain。实现是
    `MatrixRoomStateReplay.stateBefore`：状态 = 该事件各父事件之后的状态的解析，**按需从祖先集合算**，
    而不是给每个事件都留一份（replay 只保留极值点状态以保持有界）；`/state_ids` 是同一答案的 id 形式。
  - **顺带更正**：`selectAuthChain` 现在**包含被问的事件本身**（`selectAuthChainFor` 支持一次问多个，
    `/state` 就是用整份状态作为起点）。理由：规范自己的实现这么返回，且调用方要授权"这一组"事件时，
    整组都在链里才自洽；`/event_auth` 因此也把请求的事件带回（对端本来就有，重复无害）。
  测试：`roomHistory.test.ts` 6 项（含点名事件、limit 截断与上下限、多起点合并且不重复、缺件记
  `unavailable`、两种 prev 形态）、`roomStateSnapshot.test.ts` 7 项（状态不含时间线事件、不算被问事件
  自身的状态变化、id 形式、缺 auth 事件如实上报、未知事件无答案、分叉按解析收敛）、客户端 5 项
  （query 与签名一致、多起点、state/state_ids 解析、缺字段重试、拒绝/不可达分类），`authChain.test.ts`
  相应更新为"含被问事件"。
- **已落地（当时记为"待建"，现更正）**：`PUT /_matrix/federation/v1/send/{txnId}`、`GET /event_auth/...`、
  `POST /get_missing_events/...`、`GET /backfill/...`、`GET /state/...`、`GET /state_ids/...`、成员资格握手七个
  （`make_join`/`send_join`/`make_leave`/`send_leave`/`invite`/`make_knock`/`send_knock`）、`GET /query/directory`、
  `GET /query/profile`、`GET /version` 的 **HTTP 外壳都已落地**（`FederationHandler.ts`），Pod 归属由
  `participantRoutes.ts` 派生；**仍未接的**只有：**通知接成调度器的第二个信号**（后已判定**作废**：收到的事件不转发，
  Pod 变更不产生出站工作）、~~**出站投递记录的 Pod 承载**~~（**已落地**：批次写进发送方参与者的 Pod，
  枚举靠列目录，容器已装 Pod 版 store；见[控制记录契约](matrix-control-records-contract.md) §9）、
  以及**联邦可发布的资料内容**（个人数据决定，端点已就位）。互通面上还没动的只剩**联邦可发布的资料内容**（展示名/头像要不要发、依据什么词表、是否需要参与者同意——这是个人
  数据决定，端点已经就位等它）。`.well-known/matrix/server` 已按用户 2026-09-27 的判断**否决**（见"已撤销或否决的
  前提"：Pod 稀疏，拓扑来自房间成员关系网，不做按 host 的联邦发现）。
- **已落地**（2026-09-27）：**逐条拒绝不再等于已投递**（缺口 2 的修复）。事务返回 200 只回答"这笔
  事务收到了"，不回答"每条 PDU 都被接受了"，所以发送方现在按 per-PDU 结果拆分：被接受的落地即完成，
  被拒的**换一个新 txnId** 重新入队（对端会重放旧 txnId 的存档应答，所以必须换 id），带**有界退避**
  （默认 5 次、1s 起、60s 封顶）与 `lastReason`，用尽次数后**放弃并在报告里报 `abandoned`**，绝不无限重试。
  两条容易做错的细节已写死：① **对端没点名的 PDU 不等于被接受**（有结果集却没这条 → 保留重试；
  完全没有结果集则视为整笔送达）；② **退避中的批次不阻塞它所在的队列** —— 它等的依赖往往就排在它后面，
  阻塞会死锁，所以后来的批次照常发送。测试
  `tests/api/matrix/federation/outboundQueue.test.ts` 新增 4 项（拒绝后换新 id 重试并退避、退避中不阻塞
  后续批次、用尽次数后 abandoned、未点名 PDU 保留），并在
  `twoDeployment.test.ts` 里**端到端证明**：邀请先单独发出被拒 → 依赖随后送达 → 邀请自动重发并被接受。
- **已落地**（2026-09-27）：**同一事务内按依赖排序**（缺口 1 的发送侧缓解）。批次里的 PDU 会按
  `prev_events`/`auth_events` 做拓扑排序，让被依赖的事件先发；批次外的依赖忽略（那是对端的事），
  成环时保留输入顺序。测试 3 项。
- **已落地**（2026-09-27）：**`/get_missing_events` 的两半**（`federation/missingEvents.ts` 的
  `selectMissingEvents` + 客户端的 `MatrixFederationClient.getMissingEvents`）。
  - **服务侧（纯函数）**：按规范做 `prev_events` 的**广度优先回溯** —— 从 `latest_events` 的**父事件**
    开始（请求方已有 latest 本身，它要的是更早的），**不返回也不穿过** `earliest_events`（对方说它有，
    再往前的历史是它自己的事），尊重 `limit`（默认 10）与 `min_depth`（浅于它的连父都不必走），
    走到本机没有的事件就记进 `unavailable` 且不继续穿。**返回按 `depth` 从旧到新排序** —— 请求方要按
    顺序给这些事件做授权，而被依赖的事件排在依赖它的事件之后是无法授权的（与批次内排序同一条理由）。
  - **客户端**：`POST /_matrix/federation/v1/get_missing_events/{roomId}`，签名覆盖实际请求（方法、目标
    含编码后的 roomId、body），错误分类与事务一致（4xx 拒绝、429/5xx/不可达可重试、读不出的 200 也可
    重试）。与事务共用同一条 `execute`（抽出来消除重复），所以"签名 + 解析目标 + 分类"只有一份实现。
  - 顺带把 `prev_events`/`auth_events` 两种列表形态的解析抽成 `protocol/eventReferences.ts`，三个调用点
    共用一份（此前 `inboundTransaction` 与 `outboundQueue` 各写了一遍）。
  测试：`missingEvents.test.ts` 7 项（回溯与排序、earliest 截断、limit 与默认值、min_depth、本机没有的
  事件记 unavailable、分叉合并、二元组形态与缺 id），`outboundTransaction.test.ts` 新增 4 项
  （签名往返、省略可选字段、不可读/限流/5xx 可重试、4xx 与不可达的分类）。
- **已落地**（2026-09-27）：**接收方遇到 deferred PDU 会自己去补取**（缺口 1 的接收侧闭环）。
  规范里"授权缺件"用的是**另一个端点**：`GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}`
  —— 授权事件通常是祖先，但状态解析可能选中一个不在 `prev_events` 回溯路径上的事件，
  `/get_missing_events` 永远走不到它。因此补齐了它的两半：`federation/authChain.ts` 的
  `selectAuthChain`（沿 `auth_events` 传递闭包、本机没有的记 `unavailable`、
  **按 depth 从旧到新**返回，理由同前；**【2026-09-27 更正】：链现在**包含**被问的那个事件** ——
  见下方 `/state` 一条，规范自己的实现也是这么返回的）与客户端 `getAuthChain`（GET、**无 body 因此不签 `content`**，
  复用同一条 `execute`）。接线在 `handleInboundTransaction`：PDU 被判定 `deferred` 时，若调用方提供了
  `fetchAuthChain`，就**向发送它的那个 server（origin）要链**（destination 就是发送方，**不需要 Pod
  归属解析**）→ 按旧到新逐条校验并接受（每条都用本机已有的授权事件校验）→ **重新解析并重新校验原 PDU
  一次**。**刻意只做一轮**：链本身仍无法授权的事件跳过而不继续追（否则对端可以靠"永远不给我承诺的
  事件"把我们牵着在房间里绕）。取不到（对端不可达）则保持 deferred 而不判死，让发送方重试。
  `FederationSendTarget` 也把 `fetchAuthChain` 透传给处理体，所以 HTTP 外壳接上后不需要再改逻辑。
  测试：`authChain.test.ts` 5 项、客户端 2 项、`inboundTransaction.test.ts` 新增 4 项（补取后接受、
  不能补取时报 v11-4、链帮不上忙仍 deferred、对端不可达仍 deferred），并在
  `twoDeployment.test.ts` 里**端到端证明**：B 收到一个它无法授权的邀请 → 自己向 A 要 auth chain →
  A 用 `selectAuthChain` 应答 → B 接受 create/join/invite，**邀请的 event_id 与 A 完全一致**，
  全程没有测试手工递状态。
- **已落地**（2026-09-27）：**加入/离开握手的三个函数与四个客户端方法**（`federation/membershipHandshake.ts`
  的 `buildMembershipTemplate` / `checkMembershipTemplate` / `handleMembershipSubmission`，客户端的
  `makeJoin`/`sendJoin`/`makeLeave`/`sendLeave`）。
  - **模板为什么由常驻方给**：`prev_events`/`auth_events`/`depth` 是事件的一部分、被哈希和签名覆盖，只有能
    看见房间事件图的一方才选得出来；规范要求加入方只增改 `origin`/`origin_server_ts`/`event_id`。所以模板用
    `roomGraphPosition` 生成——**与本地写入路径同一个选择函数**，握手进来的成员与本地加入的成员按同一套规则
    挂到房间上。
  - **两侧各自校验推得出来的东西**：加入方在签名前**丢弃**房间/用户/事件类型/成员资格/room version 不符的
    模板（签下去就等于把别人的事件记在自己用户名下）；常驻方先查"是不是本端点要的成员事件、`sender` 是否属于
    签请求的那个 server、路径里的 `event_id` 是否等于事件自己推出的 id"，**然后走同一条入站 PDU 流水线**
    （签名→内容哈希→授权规则），不另开一条更弱的路。路径 id 必须等于推导 id：v11 的 id 由内容决定，在别的
    id 下接受它会让发送方自己的去重失效。
  - **房间版本协商**：`ver` 可重复，**缺省按规范是 `['1']`**（因此 v11 房间会明确回 400
    `M_INCOMPATIBLE_ROOM_VERSION` 并带上 `room_version`），不在清单里一律拒绝；加入方也检查应答里的版本是它
    自己声明支持的版本之一。
  - **授权判定在 make_join 就做**：用**同一批 auth_events**（正是模板会写进事件的那些）跑 `authorizeEvent`，
    所以"make_join 批准"与"send_join 接受"是同一个判定；不通过是 403 `M_FORBIDDEN`（不得加入 / 不在房间），
    未知房间是 404 `M_NOT_FOUND`——把"不认识这个房间"说成 403 等于假装我们知道它。
  - **应答形状**：`/send_join` v2 回 `{state, auth_chain, event}`，其中 `state` 是**加入事件之前**的解析状态，
    实现取该事件各父事件解析后的状态（`stateBeforeParents`，从 `stateBefore` 抽出的同一段逻辑），因此**不必先
    把加入事件写进 Pod**；`event` 带上常驻方加的那个签名（规范原文"resident homeserver then adds its
    signature to this event and accepts it"）。`/send_leave` v2 回空对象 `{}`。
  - **`omit_members` 只当提示**：规范**允许**在请求方要求时省略成员事件、**从不要求**省略，所以本部署一律回
    全量状态，并且**永不设置 `members_omitted`**——那个标记会声称一次没发生的省略。
  - **依赖缺口回"换一台常驻方"的码**：提交事件的 `auth_events` 在本机取不齐时回 400
    `M_UNABLE_TO_GRANT_JOIN`（规范给"应换一台 server 再试"的码），而不是 `M_INVALID_PARAM`（那会说事件格式
    有问题）或 `M_FORBIDDEN`（那会说房间拒绝）。为此 `InboundPduResult` 增加了机器可读的 `stage`
    （structure/signature/authorisation/dependencies）：拒绝原因不再靠解析 `reason` 字符串分类。
  - **尚未接线**（历史记录，已过时）：当时四个端点还没有 HTTP 外壳、本机 `joinRoom` 也还没有"房间在别的部署上"这条
    分支。**现状**：外壳已全部落地（见 D4 各条），远端加入的编排也已落地（`federation/remoteJoin.ts`），
    剩下的只是 store 里那条分支的接线。
  - **顺带消除重复**：三个地方各写了一遍"行 → 协议事件 / 事件图事实"的读取（`roomState`、`PodMatrixStore`、
    `roomStateSnapshot`），现统一到 `src/api/matrix/storedEvent.ts` 的 `storedProtocolEvent` /
    `storedGraphEvent`；`prev_events`/`auth_events` 一律走 `eventReferenceIds`，因此 `[id, {sha256}]` 二元组在
    状态解析与图位置里也被正确读取（此前 `roomState` 会把它当坏数据丢掉）。
  测试：`membershipHandshake.test.ts` 16 项（公开房间模板带图位置、版本协商三态、未知房间 404、未受邀与被封禁
  的 403、leave 模板与陌生用户 403、模板校验的四种不符、接受加入并回"加入前的状态 + 双方签名都在的事件"、
  路径 id 不符、四种非成员事件体、伪造签名、房间不允许→403、auth events 缺失→M_UNABLE_TO_GRANT_JOIN、leave
  空应答），`outboundTransaction.test.ts` 新增 10 项（GET/PUT 目标与签名往返、`ver` 三态、模板不符与版本不符
  被丢弃、send_join 读回 state/auth_chain/event/omit_members、应答事件 id 不符被拒、缺字段重试与 4xx/5xx
  分类、send_leave 空应答）。
- **已落地**（2026-09-27）：**邀请握手的接收侧与客户端**（`handleMembershipSubmission` 的 invite 分支、
  `federation/strippedState.ts`、客户端的 `sendInvite`）。
  - **`/invite` 与 join/leave 的分工不同，这是它特别的地方**：邀请方**不需要模板**（它在房间里，自己建事件），
    被邀请方**通常根本不认识这个房间**，所以它只被要求做一件事——为自己用户的这条 invite 加一个签名。它因此
    **只校验、不授权**：走 `verifyInboundPdu`（结构→签名→内容哈希）而不是 `validateInboundPdu`；房间的授权
    由房间自己的服务器在邀请经事务送达时判定。应答也就**没有状态**可言。
  - **拆出 `verifyInboundPdu`**：收到的 PDU 检查的前三步（结构、签名、内容哈希→必要时 redact）现在是独立导出
    的函数，`validateInboundPdu` = 它 + 第四步授权规则。`/invite` 复用的是同一条实现，不是平行的第二条弱路径。
  - **`state_key` 规则是这一家里唯一不同的地方**：join/leave 要求 `state_key === sender`；invite 要求
    `state_key` 是**接收方服务器**的用户（这正是签名对我们有价值的原因）。其余前置条件（类型、membership、
    `sender` 属于签发请求的 server、路径 `event_id` 等于推导 id）与 join/leave 完全相同，写在同一段代码里，
    靠一个 `stateKey` 参数区分。
  - **没有签名身份就不能服务这个端点**：被邀请方的签名正是端点的意义，所以缺 `counterSign` 时回 500
    `M_UNKNOWN`，而不是回一个没签过名的事件让对端无限重试；不认识的房间版本回 400
    `M_INCOMPATIBLE_ROOM_VERSION`（我们只能用 v11 的规则验哈希）。
  - **`invite_room_state` 只报告不拒绝**：规范对 room version 1–11 明确要求"告警而不是报错"（我们服务的正是
    11），所以 `strippedStateWarnings` 返回原因列表由调用方记录，邀请照常接受。发送侧 `strippedRoomState` 给
    的是 CS 规范定义的 **stripped state 事件**：**只有** `type`/`state_key`/`sender`/`content` 四个字段——
    接收方无法验证其余字段，就不发那些字段；`m.room.create` 必需，其余是规范点名的展示状态
    （name/avatar/canonical_alias/join_rules）加 topic，且取自房间**当前解析后的状态**。
  - **请求体是容器不是事件**：`/invite` v2 的 body 是 `{room_version, event, invite_room_state?}`（与
    `/send_join`、`/send_leave` 的裸事件不同），`sendInvite` 照此发送，签名覆盖这个容器。
  - **客户端不替调用方验签**：`sendInvite` 只检查"回的是同一个 event id"和"对端自己的签名在事件上"；对端签名的
    **密码学验证必须由调用方用客户端的 key source 之外的实现完成**（`MatrixFederationClient` 不持有 key
    source），这条写进了方法注释——邀请在转给房间的服务器之前必须验，否则等于转发一个自称的签名。
  - **v1 不做**：`/invite` v1 只为 room version 1/2 存在且自 v1.1 起弃用，v2 的"400/404 回退 v1"对本部署不适用。
  测试：`membershipHandshake.test.ts` 新增 6 项（签名后只回事件、不是我们的用户被拒、四种非 invite 体、伪造
  签名、版本不符、无签名身份 500、`invite_room_state` 告警四态），`strippedState.test.ts` 3 项（只含四个字段
  与必需 create、取当前解析状态而非每个历史状态、告警逐条），客户端 3 项（容器 body 与签名往返、空展示状态
  省略且版本可指定、缺签名/不可读/换事件/4xx 四类分类）。
- **已落地**（2026-09-27）：**敲门的握手两半**（`buildMembershipTemplate` 支持 `knock`、
  `handleMembershipSubmission` 的 knock 分支、`federation/strippedState.ts` 的 `strippedRoomState`、客户端的
  `makeKnock`/`sendKnock`）。
  - **敲门就是换了个 membership 的加入握手**：模板同样由常驻方给图位置（`roomGraphPosition` 对
    `join`/`invite`/`knock` 都选 `m.room.join_rules`，所以"这个房间收不收敲门"正是授权判定会看的那一条），
    `state_key === sender`，提交的事件走**同一条入站 PDU 流水线**。规范里敲门的 403 原文就是"房间没开敲门
    或被封禁"，与授权规则的 `v11-4.7.1` 判定天然对齐。
  - **唯一的请求形状差异**：`make_knock` 的 `ver` 是**必填**（敲门到 room version 7 才有），所以缺它回 400
    `M_MISSING_PARAM`；`make_join`/`make_leave` 缺省仍按规范的 `['1']` 处理。我们自己的客户端因此总是带上
    `ver`（默认就是本部署实现的版本）。
  - **应答是房间的 stripped state**：`send_knock` 回 `{knock_room_state}`（规范要求字段，回的是敲门方客户端
    用来"看清自己在申请加入什么"的展示状态），不像 join 那样回状态快照、也不回事件本身。取的就是邀请那一轮
    落地的 `strippedRoomState`（四字段 + 必需 create），并因此把 **`m.room.encryption` 也纳入展示集合**——
    规范在 `knock_room_state` 里点名了它，而"房间是否加密"对收邀请的人同样关键。
  - **依赖缺口没有"换一台 server"的码**：`M_UNABLE_TO_GRANT_JOIN` 是 join 专属的名字，敲门遇到 auth events
    取不齐时保留规范点名的 400 `M_INVALID_PARAM`，把真正的缺失写进 reason（不借用 join 的码去表达"换个常驻
    方"）。
  - **敲门不是本部署房间的常态**：Xpod 自己建的房间不会把 `join_rule` 设成 `knock`，所以这一条与本轮之前的
    握手一样，价值在互通（对端房间允许敲门时我们敲得进去，或对端用户敲我们的房间时我们答得对）。
  测试：`membershipHandshake.test.ts` 新增 4 项（可敲门房间给模板且 auth events 含 join_rules、不收敲门的房间
  403、缺 `ver` 400 `M_MISSING_PARAM`、接受敲门并回四字段 stripped state 且不回事件/状态、不许敲门 403 与
  auth events 缺失 400），客户端 3 项（`make_knock` 必带 `ver` 与签名往返、`send_knock` 裸事件 body 与
  `knock_room_state` 解析、缺字段重试与 4xx 分类）。
- **已落地（证据，2026-09-27）**：**对端不可达时的队列行为**（`twoDeployment.test.ts` 新增 2 项，两个部署按
  生产方式接线，只有网络这一跳是进程内的）。在"写入 → 队列 → 发送 → 对端 `handleFederationSend`"整条链路上
  证明：① 断网期间的写入**不等投递**（每次写入返回时对端一条事件都没有）；② 整批留在队列里（一笔事务的 3 条
  PDU 不被拆散）；③ 再次尝试**复用同一个 `txnId`**、`attempts` 递增、`lastReason` 记录不可达——这是规范"拿到
  200 才能换 txnId"的直接证据（换了 id 对端就会把同一批 PDU 处理两次）；④ 恢复后这条事务送达，3 条消息
  **恰好一次**、顺序与写入一致、两个 Pod 的 `event_id` 集合相同；⑤ **队首未被应答时后面的批次不越队**
  （`deferred` 只提队首、`blockBehind` 生效），恢复后仍按写入顺序到达——这条序列正是接收端能按序授权的前提。
  **仍未证**：真实 HTTP/TLS 跳转、**对端进程重启后的恢复**（接收侧事务存档与投递进度目前是内存实现，落控制
  Pod 是待办）与部署级 Pod 授权；本证据因此只对"网络中断"这一故障成立，不对"对端丢状态"成立。
- **已落地**（2026-09-27）：**server name → Pod 的归属改为派生，不新增绑定记录**
  （`src/api/matrix/participantRoutes.ts`，容器里是 `matrixParticipantRoutes`）。
  - **为什么不记录**（用户质疑"server name 跟 webid 本来不就是一一对应了，为什么还要记录"）：参与者的 server
    name 由 WebID **推导**（`webIdServerName` = WebID 的 host，已有模块），Pod 则是部署**已经**为该 WebID 登记的
    那个（`pod_lookup`，部署本来就要为共享 Pod/配额/迁移维护它）。所以"这条请求该写哪个 Pod"是**算出来的**：
    注册表 → WebID → host，而不是第二份 Matrix 专用的绑定记录；参与者换 Pod 只需改登记本身，不需要同步一份
    Matrix 副本。
  - **歧义一律拒绝，不猜**：既有的"一个参与者几个 Pod 不猜"策略（`podParticipantIdentity.ts` 里铸钥匙时的同一
    条）扩展到路由——① 同一个 server name 被多个已登记 WebID 认领（同一 host 上两个账号）；② 同一个 WebID 登记
    了多个 Pod。两种情况都返回 `ambiguous` 并说明原因，因为把房间事件写进"猜出来的" Pod 是读者无法撤销的；
    未知名字返回 `unknown`（HTTP 外壳据此回 403，与既有行为一致）。同一 Pod 被登记两次不算歧义（答案相同）。
  - **一次读取给出全集**：`routes()` 从 `listAllPods()` 一次读取推导出全部 (server name → WebID → Pod)，供需要
    整集的调用方（例如"本部署服务哪些参与者"的订阅接线）使用；`route(name)` 是单点问题。WebID 没有可用 host
    的登记被跳过——它不可能是任何人的 server，编一个名字只会得到谁也签不了的归属。
  - **仍未接线（当时的记录）**：HTTP 外壳本身还没接、以及"用谁的凭据写目标 Pod"。**现状**：外壳已落地（`/send` 与
    读取端点、握手、查询全部），凭据走部署侧 `service` 上下文（参与者任务层 grant，缺 grant 即 403 点名 Pod）。
  测试：`participantRoutes.test.ts` 7 项（两个参与者各自解析、未知名字与带端口的名字不猜、同一名字两个 WebID
  歧义、同一 WebID 两个 Pod 歧义、多 WebID 登记逐个服务且跳过不可用 WebID、同一个 Pod 登记两次不算歧义、没有
  登记时没有路由），`MatrixOutboundContainer.test.ts` 新增 1 项（有 Pod 注册表时容器里的路由能解析出归一化的
  Pod 根；没有注册表时为 undefined 而不是猜）。
- **已落地**（2026-09-27）：**入站 `PUT /_matrix/federation/v1/send/{txnId}` 的 HTTP 外壳**
  （`src/api/handlers/FederationHandler.ts`；容器新增 `matrixServerNameResolver` / `matrixServerKeyFetcher` /
  `matrixInboundTransactions`，路由在 `container/routes.ts` 里"有 Pod 注册表且有验签密钥"才注册）。
  - **被寻址的名字从 `Host` 取，并容忍隐式端口**：`Host` 是 HTTP 唯一携带"这条请求发给谁"的地方；走隐式联邦端口的
    对端会写 `alice.example:8448`，而它签进 `destination` 的 server name 是 `alice.example`。两个拼写都是候选，
    **本部署服务哪个就用哪个**（也就是 `destination` 必须匹配的那个）；都不服务 → 403，与处理体拒绝"不是本 Pod 的
    房间"同一条规则。**前提**：网关/反代必须原样转发 `Host`。
  - **一次事务只读一遍房间**：auth events 要从 Pod 解出来，而一笔事务里的 PDU 通常引用同一个房间；索引按房间建一次，
    并**在接受一条事件后就地打补丁**，所以"后一条 PDU 依赖同一事务里刚接受的那条"也能解析（端到端测试证明了这一
    条），代价是每房间 1 次读 + 每事件 1 次写，而不是每 PDU 读一遍房间。
  - **认证走 X-Matrix、不走会话**：路由是 `public` 的（联邦请求不带用户凭据），由 `handleFederationSend` 用对端发布
    的密钥验签；`destination` 与"我们认定的被寻址名字"不一致即 401，缺 `destination`（v1.3 以前的发送方）仍接受。
  - **补取 auth chain 已接上生产**：PDU 判为 deferred 时，外壳用**出站发送器**、以"被寻址的那个名字"为 origin 去问
    发送方要链（`fetchAuthChain`），所以"接收方自己补齐依赖"这条闭环在有身份时默认开启。
  - **请求体有上限**：4 MiB，超了回 413 `M_TOO_LARGE`，而不是先把对端给的东西收下再说。
  - **顺带修掉的互通缺口**：server keys 的获取现在**可以走委派**——`resolveKeyEndpoint` 允许返回 Promise，容器用
    部署共享的 `MatrixServerNameResolver` 解析出 key 端点，且与出站投递**共用同一个解析器与缓存**；否则一个把联邦
    端点委派到别的 host 的对端（很常见）会因为"默认端口找不到密钥"而永远验不过。**仍未改**的是委派时的 TLS/Host
    缺口（`fetch` 不能改 SNI/Host），出站与这里同样受限，已在册。
  - **仍未证**：两个部署**真的经 HTTP** 跑完整事务（本轮外壳测试是真的 HTTP，但对端是假 store；部署级真实 HTTP
    证据留下一轮）、事务存档与投递进度的 Pod 承载（当前内存）、另外九个端点的外壳，以及**部署用哪份授权写被路由到
    的参与者 Pod**——外壳把 `{webId, podUrl}` 交给 store，实际写入走 store 的 `podAccess`（部署 owner 访问器 +
    任务层 grant 来源）；对"别人的 Pod"是否被授权，要等任务层 grant 落地才能证明。
  测试：`tests/api/handlers/FederationHandler.test.ts` 6 项，**全部经真实 HTTP 套接字**（`ApiServer` 监听随机端口 +
  `node:http` 请求，因此能设置 `Host`）：签名事务被接受并写进被路由的 Pod、重放同一 txnId 只写一次、同一事务里
  "后一条依赖刚接受的那条"能解析、不服务的名字 403、伪造签名 401 与 `destination` 不符 401、隐式端口 `:8448` 被认作
  同一个名字且 deferred 时向发送方索链（只按"无法授权的那条事件"的 id 索要）。
- **已落地**（2026-09-27）：**两个部署真的经 HTTP 跑完整闭环** + **部署侧写 Pod 的授权路径**
  （`twoDeployment.test.ts` 新增 1 项；`FederationHandler` 增加 `contextFor` 接缝；`MatrixStoreContext` 增加
  `service` 上下文；`PodMatrixStore.getDb` 区分"调用者会话"与"部署自己干活"）。
  - **上下文只有一个答案**：一次读写的"我是谁"不允许含糊。`PodMatrixStore` 现在**拒绝**
    `auth` 与 `service` 同时出现的上下文（400），没有会话又没有 `service` 时仍然是 401
    "Solid authentication is required"（老行为不变）。
  - **部署干活时用参与者的任务层 grant，不借任何东西**：`service` 上下文把
    `taskCredential`（默认 `{}` = 该所有者当前生效的 grant，也接受 `credentialRef`/`version` 冻结版本）
    交给 Pod 访问器；访问器拿不到可用 credential 就**失败**，既不会退回用户会话，也不会退回部署自持的 key——
    "这次写入被授权了"必须始终能与"某人曾经注册过"区分开。失败时回 403 并**点名是哪个参与者的 Pod**。
  - **凭据是部署的决定，不是外壳的**：`registerFederationRoutes` 新增 `contextFor(route)`，由部署回答"以谁的名义
    读写被路由到的那个 Pod"；默认只给 `{webId, podUrl}`（**不含任何权限**，真 Pod 会拒绝——这是"没说清自己是谁"
    时最诚实的默认）。容器里接的是 `{webId, podUrl, service: {}}`，也就是"以该参与者的任务层 grant 落库"。
  - **真实 HTTP 证据**：两个部署各自把入站路由跑在**真 socket** 上（`ApiServer` 随机端口 + `registerFederationRoutes`
    + 真实 `participantRoutes` 派生），出站侧用一个把 `https://<name>:8448/...` 改写到回环端口、但**保留
    `Host: <name>:8448` 与完整路径/查询**的传输。于是房间引导（create + Alice 的 join）、邀请、Bob 的 join（B→A）
    与 Alice 的一条消息（A→B）**全部经 HTTP**，两侧 `event_id` 集合一致、两个队列都清空；测试还断言"确实发生了
    至少 3 次 A→B 与 1 次 B→A 请求，每次的 `Host` 都是被寻址的 server name"——**这是验收文档里"唯一的测试替身是
    网络这一跳"被去掉的那一步**。
  - **仍未证（当时的记录）**：真实 TLS/SNI、grant 的签发流程、其余九个端点的外壳。**现状**：TLS/SNI 已由
    `federationFetch.ts` + 真实握手测试补上；外壳全部落地；**grant 的签发流程仍未做**（机制在
    `TaskCredentialStore.grant`，缺的是索取时机与界面——见[控制记录契约](matrix-control-records-contract.md) §5.4）。
  测试：`twoDeployment.test.ts` 新增 1 项（上述跨 socket 闭环，180s 预算）；`FederationHandler.test.ts` 新增 1 项
  （`contextFor` 的答案就是 store 收到的上下文）；`tests/api/matrix/storePodAccess.test.ts` 4 项（无会话无 service
  仍然 401 且**不问** Pod 访问器、`service` 以 `taskCredential` 提问且无 grant 时 403 并点名 Pod、
  `credentialRef`/`version` 原样透传、同时给 `auth` 与 `service` 400）。
- **已落地**（2026-09-27）：**五个联邦读取端点的 HTTP 外壳**（`FederationHandler.ts`：`/event_auth`、`/state`、
  `/state_ids`、`/backfill`、`/get_missing_events`）+ **接收方补取链现在走真路由**。
  - **同一条前奏，四种答案**：五个端点共用一个 `readRoom` 前奏——认定被寻址的名字（同 `/send` 的 `Host` 规则）
    → 用 X-Matrix 验签 → 按名字派生 Pod 与上下文（`contextFor`）→ 读该房间的协议事件；**房间一条都没有就 404**
    （"我不认识这个房间"必须能与"我知道但没有"区分开）。之后各自只做自己那道题：`selectAuthChain`、
    `stateSnapshotBefore`/`stateIdsBefore`、`selectBackfill`、`selectMissingEvents`。
  - **响应形状按规范各自的定义**：`/event_auth` 只回 `{auth_chain}`；`/state` 回 `{pdus, auth_chain}`；
    `/state_ids` 回 `{pdu_ids, auth_chain_ids}`；`/backfill` 回**事务形状** `{origin, origin_server_ts, pdus}`
    （`origin` 就是被寻址的名字）；`/get_missing_events` 回 `{events}`。缺参数一律 400 `M_MISSING_PARAM`
    （`event_id` / `v` / `limit`），不猜默认值。
  - **`/get_missing_events` 的请求体先读后验**：签名覆盖 body，所以先按 4 MiB 上限读完并解析，再交给
    `authenticateXMatrixRequest` 验证；读不出来就是 400，而不是拿一个空 body 去验签。
  - **顺带补上的一个投影**：读取端点从 Pod 拿到的是**协议事件**，而状态解析写在"行"上，于是
    `storedEvent.ts` 增加 `recordOfProtocolEvent`（PDU → 行；没有 id 的事件按内容推导 id，而不是留空身份）——
    两个方向现在各只有一份实现。
  - **端到端证据升级**：`twoDeployment.test.ts` 新增一项——B 收到一个它无法授权的**邀请**，于是**经 HTTP** 向 A
    请求 `GET /_matrix/federation/v1/event_auth/...`（断言请求真的发生过、路径就是该端点），用取回的链接受房间状态
    与邀请，`event_id` 与 A 完全一致。也就是说，此前"接收方主动补取"的证据里那台**在测试内直接调用的**
    `handleAuthChain` 已被真路由取代。
  测试：`FederationHandler.test.ts` 新增 6 项（`/event_auth` 回闭包且最旧在前、`/state` 与 `/state_ids` 回同一份
  状态的两种形式、`/backfill` 含点名事件且从新到旧且带 `origin`/`origin_server_ts`、`/get_missing_events` 从父事件
  起走且停在请求方已有处、缺签名 401/不服务的名字 403/未知房间 404、缺参数 400），`twoDeployment.test.ts` 新增
  1 项（上述经 HTTP 的链补取）。
- **已落地**（2026-09-27）：**七个成员资格握手端点的 HTTP 外壳**（`FederationHandler.ts`：`make_join`、
  `send_join`(v2)、`make_leave`、`send_leave`(v2)、`invite`(v2)、`make_knock`、`send_knock`）——至此**登记册里列出的
  联邦端点全部可达**。
  - **模板端点**：读房间（同一条 `readRoom` 前奏）→ `buildMembershipTemplate` 用 `ver`（`make_knock` 缺它仍 400
    `M_MISSING_PARAM`）与房版本判定 → 直接回该函数的状态与 body，因此"未知房间 404 / 版本不符 400 / 房间不允许 403"
    的优先级与纯函数完全一致，外壳不再重复判定一次。
  - **提交端点**：先按 4 MiB 上限读 body（签名覆盖它）→ 验签 → 读房间 → 把**提交事件点名的 auth_events**从本机
    房间里解出来交给 `handleMembershipSubmission`，走的就是事务那条流水线；因此"房间不知道/依赖取不齐/授权不过"
    的答复与 `/send` 同源。
  - **加签用的是"被寻址那个参与者"的身份，不是部署身份**：新增 `signerFor(serverName)`（容器接
    `matrixSigningIdentities.identityFor`）；查不到就**不签**（而不是拿别人的身份签），`/invite` 自己会因为
    "没有签名身份"回 500——这正是它存在的意义。测试断言被接受的 join/invite 事件上**同时**有发送方与接收方两个
    签名，且 `event_id` 不变（reference hash 覆盖的是 redaction 后的事件，`signatures` 不在其中）。
  - **`/invite` 不读任何 Pod**：被邀请方通常不认识房间，外壳只做"验签 + 为我们的用户加签 + 回事件"；请求体是规范
    的容器 `{room_version, event, invite_room_state?}`，`invite_room_state` 的问题按规范对 v1–11 的要求**告警不拒绝**
    （`getLoggerFor('MatrixFederation')` 记录）。
  - **仍未做**：`send_join`/`send_leave` 的 **v1**（自 v1.1 弃用、只为 room version 1/2 存在，本部署服务 v11，
    没有回退目标）。
  测试：`FederationHandler.test.ts` 新增 5 项（`make_join` 模板带图位置与 `ver=10` → 400 带 `room_version`；
  `send_join` 回"加入前的状态 + 双方签名的事件"且不写 Pod；会员 `make_leave` + `send_leave` 回空对象；
  可敲门房间的 `make_knock` + `send_knock` 回四字段 stripped state；`/invite` 为我们的用户加签且不读 Pod、
  为他人的用户回 400 `M_INVALID_PARAM`），全部经真实 HTTP。
- **已落地**（2026-09-27）：**密钥按"被寻址的 server name"发布**（`MatrixHandler` 的 `GET /_matrix/key/v2/server`
  改为按 `Host` 认定名字，新增 `identities` 选项，容器接 `matrixSigningIdentities`）。
  - **修掉的是一个真实的互通阻断**：此前这条路由**不看 Host**，对任何名字都回**部署身份**的密钥响应。而本部署里
    参与者是自己的 server（事件以 `alice.example` 签名），对端拿到"声称是 alice.example、实际是部署密钥"的响应会
    被 `parseServerKeyResponse` 按 `expected_server_name` 判为**不是这个服务器的密钥**——于是**参与者签名的事件
    在对端永远验不过**。
  - **现在的规则**：用与联邦路由同一条"被寻址名字"规则（`Host`，容忍隐式端口 `:8448`/`:443`）取候选名字，**本
    部署持有哪个名字的密钥就发哪个**：部署自己的名字发部署身份，参与者的名字发该参与者的身份（注册表 provision
    出来的）；都不持有就 **404 `M_NOT_FOUND`**，而不是发别人的密钥——"这个部署不为这个名字发布任何东西"必须能
    与"这是它的密钥"区分开。
  测试：`MatrixHandler.test.ts` 原有 2 项更新为带 `Host` 请求，新增 1 项（`Host: alice.example:8448` 得到
  **alice 的** `server_name` 与她的 key id；`bob.example` 得到 404 而不是部署密钥）。
- **已落地**（2026-09-27）：**房间变更订阅挂到"本部署服务的每个 Pod"**（`notifications/roomWatchService.ts`）。
  此前 tracker 能按房间订阅当天消息文档，但没人告诉它有哪些 Pod/房间；现在 Pod 集合由 `participantRoutes.routes()`
  派生，每 Pod 一个 watcher，房间列表来自 `listJoinedRooms`，服务本身作为 `MatrixRoomChangeSource` 按 scope 路由，
  **未 watch 的 scope 回 `trust: 'all'`**（静默说"没变化"会永久丢事件），周期对账 + 单 Pod 失败只上报。测试 8 项
  + 容器 1 项（含"store 拿到的就是同一个 source"）。**仍有界同步的实测数字未在真实部署上重取**（现有证据是
  20 房间的内存 harness）。
- **已落地**（2026-09-27）：**`GET /_matrix/federation/v1/query/directory` 的两半**（外壳 + 客户端
  `queryDirectory`）与支撑它的两个读接口（`PodMatrixStore.findRoomByAlias` / `roomServers`）。
  - **alias 的答案来自房间自己的记录**：alias 是房间记录上的一个字段（`canonicalAlias`），所以不需要目录服务，也
    **不搜索被寻址 Pod 之外的 Pod**——alias 自带它属于哪个 server，那个 server 就是答案所在的 Pod。这正是
    "房间就是索引"在互通面上的体现。
  - **被寻址的名字取 alias 里的那个，而不是 `Host`**：这是唯一一个"被问的是另一台服务器"的端点，对端签进
    `destination` 的也正是它正在问的 server；对端若寻址了别人，验签直接失败——本就不该由我们代答。
  - **resident servers 用与出站投递同一套选择**：复用 `eventDestinations` 的"joined member → 其 server"选择
    （把 `ourServerName` 改成可选：不传就是"这房间里都有谁"，不过滤自己）；因此"告诉对端谁会收到事件"与
    "我们真的把事件发给谁"不可能不一致。
  - **客户端**：`queryDirectory({destination, roomAlias})` 走同一条 `execute`（签名覆盖含 query 的目标），200 缺
    `room_id`/`servers` 视为可重试，4xx 视为最终拒绝。
  测试：`FederationHandler.test.ts` 新增 2 项（签名查询回 `{room_id, servers}`；未知 alias 404、非本部署服务的
  alias 404、未签名 401、缺 `room_alias` 400），`outboundTransaction.test.ts` 新增 2 项（query 与签名往返、
  缺字段重试与 4xx 分类），`destinations.test.ts` 6 项在新签名下不变。
- **已落地**（2026-09-27）：**`GET /_matrix/federation/v1/version`** + **版本来源收敛成一处**
  （`src/runtime/deploymentVersion.ts`；`main.ts` 的 `getVersion()` 改为委托它，不再各自读 package.json）。
  - **这是唯一一个刻意不验签的联邦端点**：它回答的是"是谁在应答"，不是任何需要认证的事实；对端拿它做连通性与
    实现识别，然后才谈别的。
  - **默认如实自报**：没有额外配置时回 `{server: {name: 'xpod', version: <package 版本>}}`；读不到就回
    `unknown` 而不是编一个。嵌入方（或测试）可以用 `implementation` 覆盖，让答案不依赖它恰好在哪个构建里跑。
  测试：`FederationHandler.test.ts` 新增 2 项（`/version` 无需签名即回实现名与版本；未配置 `implementation` 时
  回部署自己的名字与**非 `unknown`** 的版本），全部经真实 HTTP。
- **已落地**（2026-09-27）：**`GET /_matrix/federation/v1/query/profile` 的两半**（外壳 + 客户端 `queryProfile`），
  以及把 MXID 推导暴露成公开方法（`PodMatrixStore.matrixUserIdFor(webId, serverName)`，`getMatrixUserId` 改为调它）。
  - **"这是不是我们的用户"是算出来的，不是查出来的**：MXID 由 WebID 推导（`@u_<sha256(webId)>:<serverName>`），
    任何地方都没有 MXID 表；外壳对"被寻址名字对应的那个参与者"做一次比较即可——顺带证明这条推导能被外部查询使用。
  - **答案今天是空的，而且这是决定不是缺口**：展示名只能来自参与者的 Solid profile，而把一个人的资料**发布给任何
    来问的对端**是关于个人数据的决定，不是格式选择；头像在规范里必须是 `mxc://`，本部署没有媒体仓库（在登记册的
    "不做"清单里）。所以端点照常应答、字段按规范**省略**（未设置的字段就是省略或 `null`）；等"联邦可发布的资料"
    这个决定落地时，这里就是发布点。
  - 用户不属于本部署 → 404 `M_NOT_FOUND`（规范也允许 403 `M_FORBIDDEN`，404 更准确）；缺 `user_id` → 400
    `M_MISSING_PARAM`；未验签 → 401。
  测试：`FederationHandler.test.ts` 新增 2 项（认领自己的用户并回空资料；非本部署用户 404、未签名 401、缺参数 400），
  `outboundTransaction.test.ts` 新增 2 项（query 与签名往返、空资料视为成功与 403 视为最终拒绝）。
- **已落地**（2026-09-27）：**未完成的事务不再永久占位**（`handleInboundTransaction` +
  `MatrixInboundTransactionStore.release`）。
  - **缺陷**：处理过程中任何一步抛错（最典型的是"这条 Pod 没有授权"——store 会抛 403）都会让预留停在"处理中"，于是
    对端的每次重试都拿到 503 "Transaction is still being processed"，**永远拿不到真正的原因**，也永远不会成功。
  - **处置**：处理体整体包在 try/catch 里，失败就 `release` 掉这次预留并把错误继续抛出。释放是安全的：重试会重跑整条
    流水线，而**接受一条事件按 event id 幂等**，所以上一次已经写进去的事件不会被写第二遍。真正"正在处理中"的并发
    重放仍然回 503（那条路径在预留阶段，不受影响）。
  - **失败原因如实上报**：Pod 写不进去时 store 抛 `MatrixError(403, …)`，`handleFederationSend` 按它的
    status/errcode 回答（外壳不会把它变成 500）——对端看到的是"这个部署写不进这个 Pod"（4xx，不再重试），而不是一个
    可以无限重试的未知错误。
  - **grant 的现状（记录，不是实现缺口）**：授权机制已经存在——用户可以通过 `TaskCredentialHandler` 把自己的 Pod
    interface key 交给部署（`TaskCredentialStore.grant`，按 `(owner, issuer)` 幂等）。缺的是**在参与者开始用 Matrix
    时向他索取这份授权的产品流程**（什么时机问、界面上怎么表达"让这个部署替你写收到的消息"）。在那之前，收到的事件
    会以 403 明确失败，而不是悄悄写进别人的 Pod。
  测试：`inboundTransaction.test.ts` 新增 3 项（写失败后释放并可重试、已完成的重放仍不重复处理、记录响应本身失败也
  释放、真正在处理中的并发重放仍回 503），`FederationHandler.test.ts` 新增 1 项（Pod 无授权时 HTTP 回 403
  `M_FORBIDDEN` 并带上"哪个 Pod"的原因，而不是 500）。
- **已落地**（2026-09-27）：**能证明"被寻址 server name"的传输层**（`federation/federationFetch.ts`；容器里是
  `matrixFederationFetch`，出站投递与密钥获取**共用同一个实例**）。
  - **补上的是登记册里一直挂着的那条传输缺口**：`.well-known`/SRV 委派之后端点在别的 host:port，而规范要求**连接
    证明的是 server name**（证书覆盖它、`Host` 带它），否则被委派的 host 就能替一个它并不拥有的名字作答。`fetch`
    两样都做不到：两者都从 URL 推导，且 fetch 规范禁止设置 `Host`。
  - **做法**：先把请求算成值（`federationRequestOptions`）——连接地址取解析结果（hostname/port），**SNI 与 `Host`
    取 server name**（SNI 只取 host，端口只出现在 `Host` 里，因为 SNI 没有端口概念）——再由 `node:http(s)` 的薄适配
    器发出。非 2xx **返回 Response 而不是抛错**（"对端拒绝"必须与"对端不可达"区分开，这正是调用方分类的依据），
    只有传输失败才抛。
  - **接线**：`MatrixFederationClient` / `MatrixOutboundSender` / `MatrixServerKeyFetcher` 都接受可选的
    `fetchTarget`，容器给的是同一个实例；不传就退回 `fetch`（对端就在自己名字上的部署不需要它）。
  测试：`federationFetch.test.ts` 5 项（连接地址与 server name 分离、带端口的 server name 只把端口放进 `Host`、
  非 HTTP(S) 直接拒绝、真实回环往返且**对端看到的 `Host` 就是 server name**、403 作为 Response 返回而端口无人监听
  时抛错）。
- **已落地**（2026-09-27）：**失败按它真正的状态回答**（`FederationHandler` 的 `safely` 包装）+ **客户端
  `getVersion`**（`/version` 的另一半）。
  - **缺陷**：读取端点（`/event_auth`、`/state`、`/state_ids`、`/backfill`、`/get_missing_events`、`/query/*`）里
    store 抛出的 `MatrixError` 会一路冒到 API server 的兜底 catch，于是"这个部署没有那条 Pod 的授权"被答成
    **500**——对端会当成未知故障一直重试，而它其实是一个**决定**（4xx，不该重试）。`/send` 早就是对的（
    `handleFederationSend` 会映射），只有读取侧漏了。
  - **处置**：所有会读 Pod 的处理体统一经过 `safely()`：`MatrixError` 按它的 status/errcode 回答；其它错误记日志
    后回 500 `M_UNKNOWN`（那确实是我们的事，对端重试是对的）；响应已发出时不再二次写。
  - **客户端 `getVersion`**：`/version` 现在两半齐全（GET、无需签名、只签请求目标），200 缺 `server` 对象视为可
    重试、4xx 视为最终拒绝——与其它客户端方法同一套分类。
  测试：`FederationHandler.test.ts` 新增 1 项（同一个读取问题：store 抛 403 时回 403 并带原因、抛普通错误时回 500
  `M_UNKNOWN`、store 正常时回 200），`outboundTransaction.test.ts` 新增 2 项（读回实现名与版本且只签请求目标、
  缺字段重试与 4xx 最终拒绝）。
- **已落地**（2026-09-27）：**读路径不写、失败不刷屏**（两处小修，都属于"别让对端的一次询问变成我们的写操作"
  这一类）。
  - **`/query/profile` 的端口里删掉了 `getAccount`**：它在 store 里会先 `ensureParticipantIdentity`——**那是一次
    provision（往参与者的 Pod 里写密钥）**。虽然外壳从没调用它，但把它留在端口上等于给读路径备了一把会写 Pod 的
    钥匙，下一个人接上就会让"对端问一句资料"变成"部署替这个参与者铸了一把钥匙"。契约（§4）要求部署的写必须由
    grant 明确授权，读不该有副作用。
  - **watch 服务对同一个 Pod 的失败只报一次**：此前每趟对账（默认 30s）都会把同一条失败再记一次，把日志里其它
    信息淹掉；现在按 scope 去重，Pod 不再被服务时忘记该失败（将来重新出现算新消息），成功 watch 时也清掉标记。
  测试：`roomWatchService.test.ts` 新增 1 项（连续对账只报一次、Pod 消失后忘记、重现时再报一次），
  `FederationHandler.test.ts` 26 项在端口收窄后不变。
- **已探测（2026-09-27）**：本机 3000 上运行的 Xpod Gateway **不是本分支的构建**——`/_matrix/client/*` 与
  `/.well-known/matrix/client` 正常，但 `/_matrix/key/v2/server` 与全部 `/_matrix/federation/*` 都回 **API server 自己的
  404**（`{"error":"Not Found"}`，不是 Matrix 形状的 `M_NOT_FOUND`），说明这些路由在该构建里未注册。因此**本轮工作
  尚未取得真实实例证据**，只有模块级 + 进程内真实 HTTP 证据；要补真实实例验收必须用本分支的构建另起一个栈（细节与
  探测清单见[验收记录](matrix-collaboration-acceptance.md)的"真实实例探测"一节）。
- **已落地（证据，2026-09-27）**：**委派下的真实 TLS 握手**（`tests/api/matrix/federation/federationTls.test.ts`）。
  用一张**只覆盖 `alice.example`** 的自签证书起一个真 TLS 服务器，让传输层连**回环地址**、却声称要访问
  `alice.example`：
  - 握手成功，且对端**两次**看到这个名字——`SNICallback` 收到 `alice.example`（SNI），`Host` 头也是
    `alice.example`。这正是规范要求"被委派的 host 必须证明自己代表这个 server name"的方式。
  - **反例同样成立**：同一张证书、同一个地址、CA 也受信任，但当请求声称的名字是 `bob.example` 时**握手被拒**
    （错误里带 `bob.example`）。这证明校验是**按 server name** 而不是按连接地址做的——`servername` 一设，
    Node 的 `checkServerIdentity` 就用它而不是 `host`，于是"证书覆盖谁"与"我们在跟谁说话"是同一件事。
  - 生产默认**不传 `ca`、也不关校验**（走系统信任库）；`rejectUnauthorized: false` 只是留给"决定与无法验证的
    对端通信"的部署的开关，默认不接。
  **仍未证**：与公网上真实委派对端的一次握手（需要真实证书/CA 与一个真实对端）。
- **已落地**（2026-09-27）：**加入"别的部署托管的房间"的编排**（`federation/remoteJoin.ts`）。三块零件早就有了
  （客户端的 `makeJoin`/`sendJoin`、丢弃不符模板的校验、把模板变成事件的签名身份），这一轮把它们按规范要求的顺序
  收进**一个地方**，免得每个调用方各自再推一遍加入规则：
  1. 向常驻服务器要模板；2. **只补发送方自己才知道的东西**——规范说加入方增改 `origin`/`origin_server_ts`/`event_id`，
     其余（`prev_events`/`auth_events`/`depth`）是常驻方的，因为只有它看得见房间的图；3. 以本部署的 server name 签名；
  4. 提交并取回**加入之前**的房间状态、它所依赖的 auth chain、以及被常驻方加签后的那个事件。
  - **它刻意不持久化任何东西**：返回的状态与 auth chain 是调用方要写进"加入者自己的 Pod"的内容，而写不进去就等于
    没加入——所以这个决定留在 Pod 写入那一侧，而不是藏进编排里。
  - **接线已落地**（见 D4 中"store 的远端加入分支接上了"一条）：`joinRoom` 在房间不属于本部署时走这套编排。
  测试：`remoteJoin.test.ts` 4 项（只补自己的事实、提交的 id 由签名后的事件推导、模板不符则不提交任何东西、
  可重试/最终拒绝原样传递、**签名能用该身份公布的密钥验过、且用别人的密钥验不过**）。
- **已落地**（2026-09-27）：**store 的远端加入分支接上了**（`PodMatrixStore.joinRoom` + 新端口 `remoteJoin` +
  容器接线 `sender.membershipClientFor(serverName)` → `joinRoomOverFederation`，签名身份是该参与者自己）。
  - **房间不在本部署时走握手**：目的地取**房间 id 里的 server**；这条分支**跑在"本地房间记录"要求之前**——我们从没听说过
    的房间本来就没有本地记录，**常驻方的应答才是它在本地被创建的原因**。
  - **收到的状态按"收到的事件"落库**（原样、标 `received`、按旧到新先 auth chain 再 state），因为它们是别人的事件副本，
    也正是这个 Pod 之后能授权房间里后续事件的材料；**我们自己的 join 不走接收路径**——用我们真正提交的那个事件（含常驻方
    签名）经本地写入落库，所以那一行属于这个参与者，而不是看起来像陌生人的事件。
  - **没有联邦客户端就退回原路**：端口缺省时仍写本地成员事件并由投递带给房间的服务器（这是此前的行为，也是"本部署不能
    向常驻方发问"时的诚实退路）。
  - **失败按状态回答**：`rejected` → 403 `M_FORBIDDEN`（带原因），`retry` → 503 `M_UNKNOWN`；已经加入则**不再发问**。
  测试：`remoteJoinStore.test.ts` 2 项（向常驻方提问且只问一次、房间状态以"收到"落库、我们的 join 是自己的行且 id 等于
  提交的那个事件、再次加入不再提问；拒绝→403、可重试→503），`MatrixMemoryDatabase` 的 harness 增加 `remoteJoin` 透传。
  **按 alias 加入也已落地**（见 D4 中"按 alias 加入远端房间"一条）。
- **已落地**（2026-09-27）：**按 alias 加入远端房间**（`resolveRoomId` + 新端口 `directoryQuery` + 容器接线
  `sender.membershipClientFor(serverName)` → `client.queryDirectory`）。
  - **alias 属于一个 server，也只有那个 server 能说它指哪个房间**：所以先查本地房间记录（本部署持有的房间零成本命中），
    查不到再向 **alias 冒号后面那个 server** 发 `/query/directory`（该端点的两半此前都已落地）；两者都没有才 404
    `M_NOT_FOUND`。
  - 解析出房间 id 之后就走**普通远端加入**那条路（房间 id 里的 server 当目的地、握手、把状态/auth chain 落库），
    所以"按 alias 加入"没有第二条实现路径。
  - 顺带把"按 origin 签名的客户端"类型收成一个（`OriginFederationClient`：握手两半 + 目录查询），因为**一个客户端
    只以一个 server 签名**，需要其中任何一个的调用方要的都是同一个东西。
  测试：`remoteJoinStore.test.ts` 新增 2 项（alias 只向它命名的 server 提问、随后按房间 id 完成远端加入并落库；
  两边都不认识时 404 `alias not found`），共 4 项。
- **已落地（当时记为"仍待建"，现更正）**：`/event_auth` 与 `/get_missing_events`（以及 `/state`、`/state_ids`、
  `/backfill`）的 HTTP 外壳与 Pod 归属解析都已完成，`twoDeployment.test.ts` 里"接收方自己补取 auth chain"也已改成
  **经 HTTP 调真路由**。发送侧排序与重试、接收侧补取各自覆盖的缺口不变：两者都不覆盖"对端也没有"（那需要更远的
  backfill，仍待建）。

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
| 为每个 server name 发布 `.well-known/matrix/server` 做联邦委派 | 用户 2026-09-27：**Pod 很稀疏，不需要按 host 做联邦发现；拓扑来自房间成员关系网**（成员列表就是"要跟谁说话"的来源）。因此不实现该文档，本部署的联邦端点仍按 server name 自身的主机可达（部署名义的 `/.well-known/matrix/client` 与 `/_matrix/key/v2/server` 已有）。**前提**：WebID 的 host 与承载其 Pod 的部署 host 是同一个；一旦两者分离，"这条 name 由谁承载"会重新成为问题（与房间关系网是两件事） |
| 参与者 ↔ Pod 归属需要一条 Matrix 自己的绑定记录（`identityBinding.ts` 的方向） | 用户 2026-09-27 质疑"server name 跟 webid 本来不就是一一对应，为什么还要记录"；改为派生（`participantRoutes.ts`）。**"已无消费者"已核实（2026-09-28）**：全仓 `grep -rn identityBinding src tests` 只有它自己的测试文件命中——**零生产引用**（`src/api/matrix/identityBinding.ts` 191 行 + `tests/api/matrix/identityBinding.test.ts` 7 项）。因此删除是纯机械动作，**待你确认**（其中"Pod 迁移版本/状态机"的语义仍作为待细化项保留在册，不随代码删除） |

## 待细化的实现事项

| 事项 | 必须产出的契约 |
| --- | --- |
| 协议服务身份与 Pod 归属 | MXID/WebID、server name、服务签名身份、参与者 Pod、执行 Agent 的关系及授权；草案见 [服务身份契约](matrix-service-identity-contract.md)。**归属已定并落地**：不记录绑定，server name 由 WebID 推导、Pod 取既有登记，歧义即拒绝（`participantRoutes.ts`）；**剩余**：部署写参与者 Pod 用哪份授权（服务 grant，契约草案见[控制记录契约](matrix-control-records-contract.md) §4/§5.4）与迁移时的切换语义 |
| 完整事件与 Solid Chat 表示 | 原始事件验证材料、图关系与 room version 已落地（见[房间事件图](reference/matrix-room-event-graph.md)）；剩余：状态解析与事件授权规则、索引与旧房间迁移；共享 schema 归 models |
| 传输与落 Pod | **已落地**：接收持久化（按 event id 幂等）、去重与首次应答（Pod 回执 `txn-` 记录）、部分投递失败的逐条应答与重试（新 txnId）、补发与恢复（出站批次 `outbound-` 记录 + 列目录枚举）。**剩余**：物理回收旧天文档 |
| 客户端增量 | 有界发现/分页与变更信号已落地（`syncBoundedReads`/`roomWatchService`）。**游标归客户端**（用户 2026-09-28）：部署侧序号只是可重建的本地加速——已用测试钉住「两次独立重建得到同一确定性顺序」，但它重建不出同毫秒内的到达序。**剩余**：晚到事件的增量可见性（当前靠周期全量 pass）、token 版本与重建 |
| 可恢复事务 | 记录寻址、首次结果、载荷保留、发布、回收及未知结果处理。**入站承载已实现**（用户 2026-09-27）：models 已有的 **`taskResource`**，不需要新建表；布局是 models 的日期分桶（`<day>/txn-<hash>.ttl`，一天一目录、一条记录一文档），写前逐层建容器，查找窗口 2 天就是保留期。**出站承载与枚举也已实现**：批次用同一布局的 `outbound-` 前缀，`pending` 靠**列目录**（一天一次容器列举 + 每条一次读），窗口 7 天；`scopes()` 由部署回答。**原子性已实测并按用户判断收口**：入站回执不需要唯一赢家（幂等插入 + 记录优先），真正需要唯一赢家的本地事件预留由身份库 SQL 唯一键保证（契约 §6.3）。**剩下的**：物理回收、同步游标不纳入；容器已装 Pod 版出站 store（§9.2） |
| Agent 执行 | **归属已定**（用户 2026-09-27：**Agent 作为房间成员，有自己的 MXID**）→ 写路径因此可以强制 v11 授权规则。**前置缺口**：Agent 的 join 要能过（服务身份代签，或 restricted join 的附加签名；两者都未实现）。**剩余**：唯一逻辑触发、接替、撤权、工具幂等与分区处理 |
| 验收 | 两个独立部署/身份/Pod 的真实互通与故障注入：进程内 + 真实 HTTP/TLS + lite 真实栈 + 5 项真实 Pod 用例已落地；**剩余**：真实实例（本机 3000 是别的构建）与 Docker 起的 `full` 门禁（引擎卡死，需重启；colima 未运行） |

这些是实现待办，不重新讨论存不存 Pod、要不要跨 Pod，或共享 schema 是否归 models。
- **已落地（证据，2026-09-27）**：**外壳的读取上限与"第一个事件之前"的语义**（`FederationHandler.test.ts` 新增 3 项）。
  - **超限请求由"上限"回答，而不是由 body 内容回答**：`/send` 与 `/get_missing_events` 各自读超过 4 MiB 的 body 都回
    **413 `M_TOO_LARGE`**，且**什么都没写进 Pod**——对端不能靠一个巨大的请求把我们变成缓冲区。此前这条路径没有测试
    （实现一直在，但没人证明它真的在边界上生效）。
  - **"第一个事件之前的状态是空的"不等于"房间未知"**：`/state?event_id=<create>` 回 **200 `{pdus: [], auth_chain: []}`**，
    而不是 404——房间存在、事件已知，只是它前面什么都没有。这条区分是"未知房间 404"与"空状态 200"的边界，容易在
    重构里被合并成一个。
- **已落地**（2026-09-27）：**远端加入的端到端测试暴露并修掉了三个真实缺陷**（`twoDeployment.test.ts` 新增
  "经 HTTP 走完握手加入"一项；`createRoom`/`createSubmissionHandler`/`appendEvent` 各修一处）。
  1. **"公开房间"此前根本不是公开的**：`createRoom({visibility:'public'})` 只把 `visibility` 写进 Solid 侧房间元数据，
     **从不写 `m.room.join_rules`**，而房间版本的默认是 `invite`——于是对端来加入时被 `v11-4.3.4: join_rule requires an
     invite` 拒绝，**没人能加入一个"公开"房间**。现在按 CS API 的语义派生：`preset === 'public_chat'`，或未给 preset 时
     `visibility === 'public'` → 写 `join_rule: public`；调用方自己在 `initial_state` 里声明了 join rules 时不覆盖。
  2. **常驻方"接受"了加入却不保存它**：`send_join` 的外壳校验、加签、把状态回给加入方，**但从不把这条成员事件写进房间的
     事件图**——规范原文是"resident homeserver then adds its signature to this event and **accepts it into the room's
     event graph**"。结果这条 join 只存在于加入方的 Pod 里，靠加入方随后经 `/send` 再送一遍才到常驻方（而且只有它自己
     那一路）。现在接受成功即按"收到的事件"落库（原样、标 `received`、按 event id 幂等）。
  3. **由调用方提供的事件被存成了"没有 id 的事件"**：`appendEvent` 在 `input.event` 存在时直接使用它，而常驻方回给加入方
     的那份事件**不带 `event_id`**（加入方是另算的），于是 B 的 Pod 里那条 join 的 `metadata.protocols.matrix.event`
     没有 id——同一行与其它读者对"这个事件是谁"不再一致。现在**一律推导并校验**：缺 id 就补上，给了 id 但与内容不符就
     报 `EventIntegrityError`（reference hash 不含 `signatures`/`unsigned`，所以常驻方加签不会改变它）。
  - **顺带**：出站客户端拒绝请求时**带上对端的 errcode 与 error 原文**（`destination refused the request with 403
    (M_FORBIDDEN: v11-4.3.4: …)`）——上面第 1 条正是靠这句才一眼定位；此前只有一个状态码，运维得去翻对端日志。
  测试：`twoDeployment.test.ts` 新增 1 项（经 HTTP 的握手加入：断言 make_join/send_join 真的被请求过、两侧 join 同 id、
     B 的 Pod 因常驻方随加入送来的状态而持有 create 与 join_rules、事件上同时有双方签名、随后 Alice 的消息仍能到达 B），
     并因第 1 条带来的"房间现在真的有 join_rules"更新了 4 处既有夹具（bootstrap 要多交一个状态事件、depth 与状态槽各 +1）。
- **已落地（证据，2026-09-27）**：**五个读取端点经 HTTP 对着真实 store 走通**（`twoDeployment.test.ts` 新增一项）。
  此前的读取端点测试是"真 HTTP + 假 store"；这一项让 Bob 加入后用自己的客户端向 Alice 的部署（真 socket、真 Pod 行）
  提问并逐条核对：`/state` 与 `/state_ids` 是同一答案的两种形式（**第二个消息之前**的状态 = create + Alice 的 join +
  join rules；两个消息写在 Bob 加入之前，所以状态里**没有** Bob 的 join——这正是"事件之前的状态"的意思）、
  `/backfill` 含点名事件且从新到旧、`/get_missing_events` 从父事件起走并**停在请求方已有处**（含 first、不含 create）、
  `/event_auth` 含被问事件本身，并断言这五条请求**都真的发生过**。这一轮**没有**发现新缺陷（上一轮的三处是端到端才
  显形的，这一批路径本来就是对的）。
  - **顺带**：把"取一个以某 origin 签名的客户端"收成一个公开方法 `sender.clientFor(origin)`（此前叫
    `membershipClientFor` 且只暴露握手两半）——需要目录查询、状态读取、缺失事件的调用方要的是同一个东西。
- **已落地（证据，2026-09-27）**：**密钥发布与获取的闭环经 HTTP 走通**（`twoDeployment.test.ts` 新增一项）。
  此前两个部署之间是**注入**密钥（`keySourceFor`），从不真的去取；这一项让 Bob 的部署用 `MatrixServerKeyFetcher`
  （配 `createNodeFederationFetch` 以携带 `Host`）**向 Alice 的部署请求 `/_matrix/key/v2/server`**，用取回的密钥
  `validateInboundPdu` 验过 Alice 签名的消息（`outcome: accepted`、`eventId` 一致），并断言**本部署不发布的名字取不到
  密钥**（`undefined`，而不是别人的密钥）。这条正好把第 42 轮那个修复（按被寻址名字发布）钉在真实链路上。
- **已落地（证据，2026-09-27）**：**按 alias 加入的完整链路经 HTTP 走通**（`twoDeployment.test.ts` 新增一项）。
  Bob 用 `joinRoom('#lobby:alice.example')` 加入 Alice 的公开房间：本地查不到这个 alias → 向 **alias 命名的 server**
  发 `/query/directory` → 用返回的房间 id 走**同一条远端加入握手**。测试断言三步请求（directory、make_join、send_join）
  **都真的发生过**，且两侧的 create 与 Bob 的 join **event id 一致**——这是真实客户端加入远端房间的路径，此前只在
  单元层（假 store / 假 port）验证过。
- **已落地（证据，2026-09-27）**：**邀请握手经 HTTP 走通**（`twoDeployment.test.ts` 新增一项）。Alice 的部署邀请 Bob
  （远端用户）时，**向 Bob 的部署请求 `/invite`** 请它加签：测试断言结果 `ok`、**事件 id 不变**、事件上**同时有
  `alice.example` 与 `bob.example` 两个签名**（被邀请方是**添加**签名而不是替换事件），并断言请求确实打到
  `/_matrix/federation/v2/invite/`；同时断言 **Bob 的 Pod 此时仍是空的**——`/invite` 只回答"我签了"，让 Bob 看见邀请
  仍然要靠随后的事务送达（这是规范的分工，不是遗漏）。
