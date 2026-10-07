> 本文维护协议设计；当前开发与验收状态见[迁移清单](solid-multiparty-migration.md)，下方旧状态记录仅作历史证据。

# Solid 多方通信协议（设计）

> 当前修复进展：B 已修复精确空 ACP 状态，Root 三项真实 HTTP 测试全部通过（根空策略、叶空策略继承、私有全局 deny）。新增完整 WebID 含 query/fragment 的反例仍待修复：实际 HEAD 200、无 query 的不同主体 403，而观察返回 400。B 继续负责修复；还需同步其自有 capability 单测夹具的 accessor 身份字段并纳入最终门禁。最新原始完整集成实际退出 1，lite 165 通过/6 环境跳过，Docker 端口查询有限超时、45 项未执行，1955 输入未变化；启动 Docker 命令仅返回已运行，实际引擎仍 503。A1 及发布未完成。


> 当前验收口径补正：空 ACP 文档必须作为 `present-empty` 与 404 区分并继续继承，观察接口仍返回 415。Root 曾错误地把该状态视为不支持；现有 1955 输入的 44/155/375 通过不能证明这一项，也不代表 A1 最终完成。保持当前原始完整测试输入冻结，终止结果到达后恢复正确断言，交给 B 修复并重新验收。此前错误归于 Root 验收口径，不能计作 B 的测试或效率问题。


> 2026-10-04 当前冻结门禁结果（1955 个输入）：B 修复逐次路由证明和目录快照并发缺口，Root 冻结验收 A1 44 项、Matrix 单测 155 项、原有 375 项独立回归全部通过，构建/测试类型/依赖/diff 检查退出 0；输入文件均未变化。新鲜观察使用同一锁实例的房间独占锁及外部策略依赖读锁，保持零数据写入。只有完整有效网络响应能够进入下一阶段证据绑定；当前启动原始完整集成，并由同一 B 账号/模型只读预检 A2，无 429。完整集成、真实 Gateway、A2/A3、其他 Matrix 指标及合入发布仍未完成。


> 2026-10-04 当前 A1 独立验收更新：opencode-b 同一账号/模型完成第一轮修复，实际退出 0，无 HTTP 429。Root 实际 HTTP/CSS 验收 11/11 通过（原始 7 项 + 隐私/身份/凭据 4 项）；前三个反例及 accessor 身份缺口已修复。随后新增逐次调用反例：requester 的 room Control 路由覆盖仍可认证后续绕过路由的 room Read，实际 200 应为 415；新增文件 1 失败、1 通过，已交给同一 B 会话修复。A1 尚未最终验收；原始完整集成、真实 Gateway、A2/A3、其余 Matrix 指标、合入和发布仍待完成。


状态：**2026-09-28 起，本文件是"协议方向"的权威记录**。参考 Matrix 的**设计思路**（房间、事件、成员、
状态、去重、因果），**不以兼容 Matrix 生态为目标**——互通延后（见"延后事项"）。
历史决策与验收证据仍记在 [协作决策登记册](matrix-collaboration-decisions.md) 和 [历史验收记录](matrix-collaboration-acceptance.md)。
**方向看这里，当前进度只维护在[迁移清单](solid-multiparty-migration.md)，通过条件见[验收指标](solid-multiparty-acceptance-criteria.md)。**

## 一句话

**每个参与者一个 Pod + 一个 api-server；房间是这些 Pod 之间的多方通信；谁的数据在谁的 Pod 里，
每个 Pod 只由它的所有者（或其部署，持其授权）写入。**

## 范围与非目标

- **范围**：身份、房间与成员、事件与事件身份、投递、授权、幂等与恢复、Pod 内的存储形态。
- **非目标（现阶段）**：与 Matrix homeserver 互通；事件级密码学签名；共享的中央房间服务器；联邦握手与密钥发布的生态兼容。
  保留 `/_matrix/*` 路径与 PUT 形状，不据此承诺 Matrix 互通；兼容边界见"延后事项"。

## 已定设计（目标，完成状态见改造清单）

1. **身份 = WebID**。事件的作者与成员键**直接用 WebID**；不引入 MXID、不做哈希派生、不需要 server name。
   （Matrix 的 `sender` / `state_key` 位置放 WebID。）
2. **不签事件、不管理密钥**。真实性由两层保证：
   ① **写入这一跳的 Solid 认证**——谁在写、以什么身份写，由现有认证能力回答；
   ② **作者 Pod 里的正本**——需要核对来源时，按 URL 取回作者 Pod 中的事件并比对内容哈希。
   **代价（明确接受）**：Pod 里的副本不再自证来源；"这个 Pod 只被它自己的部署写过"成为信任前提。
3. **授权分两层，各管各的**：
   - **Solid（ACL/ACP）**：谁可以写这个 Pod / 这个资源——**已有能力，不重造**；
   - **协议层**：这条事件在房间语义上是否合法（成员/角色）——只保留必要的判定，不搬整套 power level 与状态解析。
4. **房间的成员与元数据以房主 Pod 为权威（C2）**：`members` 与 `owner` 只存在房主的 Pod 里，其他人按 Solid
   读权限读取。于是**没有状态解析、没有收敛规则**：判定就是"读房主的房间记录 + 你是不是成员"。
   其他参与者 Pod 里的房间记录只是**本地镜像（读缓存）**，**存 `members` 副本**（离线可读、UI 直接可用），
   但不是第二份真相——本地镜像与房主记录冲突时以房主为准，**且不得据此放行写入**。
5. **投递 = 参与者 api-server 到参与者 api-server 的认证 PUT**（api-server 就是参与者的 server）。
   **2026-10-02 确认**：HTTP 方法跟 [Matrix Server-Server API](https://spec.matrix.org/latest/server-server-api/#put_matrixfederationv1sendtxnid)，
   保留 `PUT /_matrix/federation/v1/send/{txnId}`；认证按 O1 使用 Solid。
   路径前缀就是 **`/_matrix/*`**——协议叫 matrix：**参考 Matrix，参考它的形状，但不承诺兼容**。
   既然前缀不变，路由与 Pod 命名空间（`protocols.matrix`）**一律不改名**；
   将来若要真互通，是在同一个前缀上加一层认证/字段适配，而不是换一套 API。
   **两条路径收敛成一条**：`/_xpod/matrix/inbound` 当初是为了"既走自己的路又不碰 Matrix 语义"而开的，
   在"前缀就是 `/_matrix`、只换认证"的框架下它没有独立意义，随改造清单第 9 项并入。
6. **事件 id 由写入方生成，随机即可**：客户端发送时带上自己生成的 `msgid`（足够长的随机 id），
   服务端为自己发起的事件（join/invite/改成员/助手结果）自己命名。id **随事件一起传播**，因此：
   - **2026-10-02 确认**：`roomId + eventId` 是逻辑唯一键，事务 id 与日期分桶不改变事件身份；跨事务、跨日期重试也不能新建第二条。
   - **重试/重投复用同一个 id**：同 id、同内容返回原事件；同 id、不同内容返回 **409**，**保留原内容、不覆盖**。
   - 跨 Pod 身份天然稳定：接收方 Pod 里那行的 id 就是作者给的 id；
   - **不需要哈希推导、不需要事务预留、不需要两阶段**——id 是"谁写的谁定"，不是"算出来的"。
   **代价（明确接受）**：id 不再证明任何事（随机 id 谁都能声称），这与第 2 条"不签事件"是同一个取舍；
   防重放靠"**同 id 不覆盖**"这条写入规则，而不是靠 id 的不可伪造。
   **时间不另造**：用这一行自己的创建时间（models 的 `createdAt`，Pod 写入时落定），不是客户端给的、
   也不是自增序号；排序由 `(createdAt, id)` 决定。
7. **投递以拉为主**：接收方订阅作者 Pod 的变更并拉增量，推只作为"提醒一下"的可选优化。
   **2026-10-02 游标口径确认**：正常拉取从上次成功确认的游标继续，返回下一页与下一游标；
   本页事件经作者正本核对并持久写入接收 Pod 后才推进游标。通知只唤醒拉取，丢失通知不能推进或跳过游标。
   同步位置与历史展示位置分开：`createdAt + id` 用于稳定历史分页，不能用创建时间截断变更发现，
   否则晚到旧日期的消息会被漏掉。重建索引后须继续正确处理旧 token，或明确要求重同步。
   先读取全部房间历史再按 `since` 过滤响应，不算完成正常增量；离线对账及重建采用有持久检查点的分页扫描。
   因此**不做入站回执、不做出站批次**：回执只为"同一 txnId 两次答复逐字一致"，批次只为"推模型下记得欠谁"。
8. **API 形状只有一套**：向对端的 api-server PUT 一批事件、路径带事务 id、逐条应答——**形状与现有联邦投递一致**，
   差别只在**认证适配**（Solid 会话 vs `X-Matrix` 签名）与**事件字段**（WebID vs MXID）。
   于是"将来要互通"不是再造一套 API，而是在同一个 handler 前面换一个认证/字段适配。
9. **Pod 内存储仍用 `@undefineds.co/models` 布局**：房间 = chat/thread；事件 = 按天的 message 行；
   记录类资源按天分桶，且**写入前先把父容器建出来**——这是 bug 级要求。
   **2026-10-02 确认：一条消息对应一个 RDF 主体，不要求一个物理文档**。`messages.ttl#msg-id` 可以标识单条消息，
   同一日文档可存多条消息；消息与其 metadata 子主体均须具有唯一身份。保留 models 的每日 `messages.ttl#…` 布局，
   [已有问题记录](issues/drizzle-solid-matrix-metadata.md)证明显式子主体 `@id` 可以隔离同文档的多条消息。
   此前“一条记录一个文档”是控制记录碰撞的规避方案，不推广为消息协议要求，不据此修改共享 schema。

## 游标与对账实施约束（2026-10-03）

C2 读取的房主位置必须在可信创建或加入流程中固定到完整 owner WebID 与精确 canonical Chat IRI。
本地镜像的 author 只可提示发现，不能据此建立或重定位既有房间的权威绑定；候选 author、roomId 与候选内容自洽也不足以证明来源。
SQL 只能缓存可从可信 Pod 事实恢复的绑定。缺少固定来源时拒绝新的写入或执行；共享模型与旧房间迁移缺口见
[Chat 权威来源问题记录](issues/models-chat-canonical-authority.md)。

**命名授权引导（设计已确认，产品生命周期仍待实现）**：房主以自己的当前 Solid caller 读取精确 canonical Chat、核对登记 Pod 与完整作者 WebID，再显式发布 membership purpose、credentialRef、冻结 version、issuer 到现有 `metadata.protocols.matrix`。普通创建无需预先取得后台授权。定位缓存只保存该非秘密指针；每次后台阶段仍须重新核对当前权威绑定和指定 lease 的 owner、版本、issuer、状态及有效期，不从当前 active grant 中隐式择取，也不把请求者改写成房主身份。

前置读取合约固定为 `metadata.protocols.matrix.membershipAuthority`，只含四个字段：`purpose: "membership"`、非空原样 `credentialRef`、正安全整数 `version`、非空原样 `issuer`。字段缺失时普通房间读取仍合法；存在但为 null、畸形或含未知字段时拒绝该权威证明。raw RDF 与公开 ORM 必须在同一份响应体上各自验证并逐字段一致，不合并多个 protocol 值，不补版本或隐式替换 ref。其他 Matrix 协议字段不受此对象白名单限制。该合约只读非秘密数据，不赋予后台权限；发布、定位恢复及 membership 生命周期分别验收。

发布使用 Matrix state PUT：事件类型 `co.undefineds.membership.authority`、空 state key，content 就是上述严格四字段对象。房主原始 caller 的完整 WebID、规范 Pod 登记、canonical author 和输入的当前 named lease 必须在任何副作用前成立；issuer 使用部署已有规范值。每个物理请求重新验证同一 ref/version/owner/issuer 的状态与有效期，认证内部重试也受此检查。

canonical 同一 protocol 对象另保留 `membershipAuthorityPublication`，严格只含 `eventId`、非负安全整数毫秒 `createdAt`、`state: "pending" | "complete"`，且必须同时存在 binding。条件写只替换一个精确 protocol RDF term，WHERE 同时约束原 type、author、metadata 边、完整参与者集合、root roles 和完整原 protocol term，保留其他内容。204 之后须重新严格回读，不能当作条件写赢得的证据。

发布顺序为 pending 条件提交、原 id/time/content 的持久事件确认、complete 条件提交与回读、当前授权下入队。完整 winner 校验先于 journal 和 queue；重试确认第一份 PDU，不重建它的父事件或时间。complete 重试补队列；新 binding 覆盖前，先补旧 complete 事件。旧 pending 使用旧 binding 作为历史内容，只有原房主显式提交新的有效 binding 才能用新 lease 补齐它，之后发布新值；已撤销的旧输入不能触发恢复。

发布批次独立保存一条原始 PDU及非秘密四字段 named actor；新授权批次完整持久化并回读后，才按旧批次完整 snapshot 条件删除。混合旧批次返回冲突并保留其他事件。迟到发送结果只能在原批次仍存在且完整 snapshot 相同时更新／转移；503 保留原 transaction id，200 部分拒绝采用新 transaction id，原批次已被替换时不得复活。后台控制记录使用明确 named task principal，逐请求检查当前 lease；原用户调用保持其原身份。定位缓存和成员／ACL 操作还须遵守后续 C2 合约。

普通 canonical reader 不按本部署 issuer 拒绝跨部署房间的数据；精确 issuer 匹配在发布和使用 named lease 时执行。现有 `TaskCredentialSource.forRef` 也须与 `activeFor` 一样遵守 configured issuer 合约，一般任务的可选 version 表面不因此改变。

定位 adapter 只保存按精确 source IRI 索引的候选 Pod ID／root、完整 owner WebID 与非秘密四字段 binding，不保存成员事实或授权通过标志。当前 resolver 的重建入口仅允许房主或 canonical participants 中确实可读的成员；非成员 Agent 的单独合法 admission 入口另行实现。命名读取独立于 caller-only reader，以显式 owner task principal 作一次内部 sealed GET，逐请求验证同一 lease；同一响应体须重新证明完整来源、作者、候选 binding 和 complete publication。候选变化立即拒绝并失效，不自动改用新 ref，不返回通用 owner fetch，不据此批准 join/write。跨部署 issuer 的 ordinary caller 读取合法，但没有本地 issuer task authority 时 named 分支拒绝。

缓存丢失时，由房主或当前确实可读取权威文档的成员／Agent caller 重新读取同一 Pod 事实、核对指定授权后重建。尚未加入者提交的 ref 不建立可信来源；没有合法读取主体或已有显式可信 dispatch 时，拒绝新的变更与执行，待当前授权恢复后续跑。invite 本身不自动赋予整份 Chat 文档 Read；该文档可能含 preview 或同文档其他主体，不能为取得指针而扩大其读取范围。

恢复门禁只清空可重建 SQL 索引与队列，保留独立的凭据 vault、撤销／版本历史及 Pod 权威事实。非秘密 Pod 指针不能重建凭据 secret，整库擦除后须重新显式授权，不能复用旧 ref/version。上述可用性边界允许合法主体回来后恢复，不承诺无人可读时自动恢复。

成员准入依据当前 canonical 的 `membershipInvitations`，不是历史 PDU 或本地镜像。邀请只冻结完整 target WebID 与 `{id, inviterWebId, createdAt}`，不添加参与者、角色或 Read。`membershipOperation` 保存唯一当前控制操作的原 actor／登记 Pod、id、时间、历史授权、完整 expected roster／原始 roles／被消费邀请与阶段；roles 缺失与空对象不能互换。join／leave 必须保留真实 caller，使用已有可信来源候选与当前 named lease；不能因为邀请对象尚不能读 canonical 而假扮房主或从请求 ref 引导权威来源。

| 操作 | 必须顺序 |
| --- | --- |
| invite | 完整 canonical CAS 写邀请与 committed → 原 actor PDU 持久确认 → complete |
| join | CAS 消费当前邀请、添加参与者及明确 member 角色并进入 join-read-pending → 实际有效 Read 授权确认 → committed → 原 actor PDU 确认 → complete |
| leave | leave-read-pending，保留 roster → 实际有效 Read 撤回确认 → leave-roster-pending → CAS 移除本人参与者及角色 → committed → 原 actor PDU 确认 → complete |

不可变原作者不能自退。未完成操作不可覆盖或超时抢占；同一合法 actor 仅恢复原 id／时间／expected，且每步保护当前完整 canonical 与授权。`complete` 只在该操作全部必要恢复义务完成后写入。下一项合法成员控制操作可用完整当前 CAS 原子替换严格合法的 completed slot，无需再次读取上一作者私有 PDU；新 join 消费的邀请也不必对应最后一个 completed slot。替换本身不确认、复制或登记旧事件，不推进 pull cursor。后续实际取得旧事件仍须核对原作者正本；此规则不适用于 complete 后仍欠队列补交的授权发布记录。

当前受支持 WAC 阶段已有实际 ACL delta、严格读回、全历史有效 Read 与必须携带私有证据的 source phase CAS；实际 CSS 正负例已加入独立验收，业务入口仍待接线。内部 mark 必须使用新观察的完整策略守卫；单独调用标记、HTTP204、结果未知或删除一条 grant 都不足以证明授撤 Read。`metadata.protocols.matrix.membershipReadGrants` 以完整参与者 WebID 保存原join操作、原作者／绑定、完整source IRI与实际策略／授权指针；reserve与installed分别随原有reserveJoin和Read阶段CAS写入。leave只删除严格匹配的持久归属节点，旧授权、其他成员与额外权利保留；残留有效Read则保持pending。此记录属于Matrix应用控制状态，不能用授权URI拼写代替创建凭据。所有 canonical CAS 与 ACL 修改共用完整原始源的原子 WHERE 条件，保留 RDF 项的词法值、语言和数据类型，并拒绝原生执行时新增、移除或修改任意源 quad；提交后拒绝回执不能替代零写入。当前 ground 范围不支持的 blank node、RDF-star 或外部 graph 必须在编译前拒绝，不能丢弃或改写。严格 ACP 服务端闭包已覆盖实际授权根及缺失／空策略，客户端有效Read证明、授权增量和 ownerRecovery 仍待完成。WAC 的直接 ACL 覆盖祖先 default，ACP 合并到实际服务器根的所有相关祖先 memberAccessControl 并考虑 deny。必须发现实际 `rel=acl`、验证完整有效策略与历史覆盖，并在提交时保护依赖与缺失条件；HTTP preflight 只证明读取时状态。规范依据：[WAC](https://solid.github.io/web-access-control-spec/)、[ACP](https://solid.github.io/authorization-panel/acp-specification/)。

复用现有 Matrix journal 保存可重建的事件引用，不为本次迁移新建存储 CDC/WAL，也不改变 models 消息布局。
该游标表示**已经成功发现的事件引用位置**，不是“Pod 在这一位置之前的所有写入都已被发现”的承诺。
无通知的原生写入，或 Pod 已持久化但引用登记前发生的崩溃，由周期对账补入引用流。

| 用途 | 游标与范围 | 确认边界 |
| --- | --- | --- |
| 正常拉取与客户端同步 | 固定订阅范围、索引 epoch、发现序号、固定本次页集上界 | 正本核对及目标 Pod 持久化完成后，原子写入引用并推进来源检查点；半页失败不推进 |
| 历史分页 | 固定快照、`createdAt + id` | 稳定翻页；新发现的晚到事件由后续同步交付 |
| 对账与重建 | 扫描轮次、房间/日期桶及桶内复合分页位置 | 每页引用登记与扫描检查点同事务提交；崩溃后重读未确认页 |

源扫描每轮先固定该范围的最大 `(createdAt, 完整主体 IRI)`，随后每页从最后一个实际源行继续，
不扩大 LIMIT 重读前缀。固定上界不依赖通知源是否存在；捕获的空范围本轮保持为空，后来追加的数据留到下一轮。
上界与本轮开始时的通知观察随引用页一同持久绑定，跨请求及重启保持不变；完成只确认原观察，不能确认扫描期间的新通知。
没有绑定观察的旧检查点续读结束时不借用当前观察，下一轮才重新绑定。完成后清除本轮视图并开始新轮次，
以便发现早于上一轮分页位置的补写。通知观察只证明哪些提示已覆盖，不是客户端交付游标。

引用至少保存 `roomId/eventId/messageIri/createdAt/sequence`，正文始终从当前授权可读的 Pod 正本取得。
正常 API 写入在 Pod 持久化后登记精确引用；通知保留变化的 document IRI，只对账该文档或其规范日期桶，
不把文档通知压缩为 room 后重新读取全部房间历史。没有可靠通知时，独立对账继续运行，正常同步仍消费引用页。

周期对账覆盖全部已授权历史范围，不以最近两天/七天截断。完成一轮后再从全范围起点覆盖；
已扫描旧桶随后新增的晚到消息不能永久被桶内创建时间游标排除。恢复预算中的 R 包含全范围再次覆盖的时间，
不能仅报告启动扫描的定时器间隔。索引丢失时分页重建并更换 epoch，旧 token 明确要求重同步。

来源检查点按接收 Pod、作者 Pod 和固定订阅范围隔离，并以比较更新保护并发确认。扩大订阅范围需补建新增范围；
读取引用和正本都重新检查当前授权，403 不等于没有事件，也不能据此确认整页。
房间权限按 C2 房主记录判断，不为旧 v11 状态解析增加持久状态索引。

集合分页与 exact IRI 读取优先使用锁定版本 drizzle-solid 的公开 API。共享文档的一次 GET 仍可能解析整份文档，
必须分别记录请求数、字节与反序列化行数，不能把 API limit 当作物理读取成本。
若公开 API 无法限定已知文档/日期桶，或同页精确读取重复下载同一文档，先记录 drizzle-solid 问题再处理临时绕过。
这些接口与恢复边界仍须开发及实际验收；本节不声明已经实现。

## 已定：投递采用参与者身份认证（O1，2026-10-02）

> 进度与逐项状态见[改造清单的「进度总览」](solid-multiparty-migration.md)——那是唯一记进度的地方，
> 本节只记这个决定本身。**E（对端端点怎么解析）已按 E3 记为工作决定**（标识用 WebID、端点用登记信息），
> 以下记录已确认的认证决定；消息存储粒度的决定见第 9 条。

**用户已确认 O1**：部署使用参与者明确授权的 Solid 会话/委托凭据，以**参与者本人 WebID**调用对端。
对端验证真实认证身份，不接受部署以自身身份自称代表参与者。缺少有效授权时拒绝，不回退到部署身份。
这是设计决定，投递侧认证替换仍待实现。

换认证目前只做了一半：**接收侧**已经接受 Solid 会话（`/send` 的 `optionalAuth` + `solidPeerMayDeliver`），
但**投递侧**仍然用 `X-Matrix` 请求签名（`buildXMatrixAuthorization`，`outboundTransaction.ts:658`）。
这一半没换，第 3 项（删每事件签名与密钥托管）就走不动：我们自己的事件仍在被签名、对端仍在验签。

当时比较的三条路（O1 已选，O2/O3 不作为当前方案）：

| 选项 | 部署怎么向对端证明"我代表这位参与者" | 代价 |
| --- | --- | --- |
| **O1** 持有参与者的 Solid 会话/委托凭据 | 以**参与者本人**的身份调用对端；对端只认会话 | 需要参与者把可跨域使用的凭据交给部署（比"给 Pod 写权限"更进一步）；跨域 Solid 认证要 DPoP 那套 |
| **O2** 部署以**自己**的身份认证，并声明代表谁 | 对端按"这位参与者是否在房间里"判定（C2），不再需要签名 | 对端无法验证"部署确实受该参与者委托"——只能信任声明；把信任面移到部署间 |
| **O3** 继续用 `X-Matrix` 请求签名（互通面），仅在 Xpod↔Xpod 时用 O1/O2 | 两种并存 | 签名与密钥体系不能删（第 3 项做不完） |

**选择 O1 的理由**：它与"身份就是 WebID、事件由本人授权"这条主线一致——部署是参与者的**代理**，
代理出示的是**本人的凭据**，而不是自己的身份 + 一句声明。O2 看着省事，但它把"这条事件是不是你的"
变成"我信任那个部署"，而我们刚刚才把真实性从签名搬到"写入这一跳的身份"上——那一跳如果是部署自己，
搬过去的意义就少了一半。O3 则等于承认第 3 项不做。

## Agent 执行与恢复

唤醒逻辑键采用 `(roomId, triggerEventId, agentIdentity)`，物理 Pod、日期与 executor 不改变身份。
C2 发布稳定执行位置，executor 更换后以自身当前 O1 权限访问同一 Run。完整首次结果及提交来源先与 Run
终态同文档条件提交，再幂等生成正式 Message；已合法完成的结果重试不要求旧 lease 仍有效，也不重新执行。
删除预留前必须补齐 admission、持久 fence/预算、来源核对和崩溃恢复，固定 ID 或队列摘要本身不够。
实施边界、服务器时间与历史迁移见 [Agent 恢复设计](solid-multiparty-agent-recovery.md)；完成状态仍看迁移清单与 G09/G11。

## 已否的取法（留档，别再走一遍）

| 取法 | 为什么否 |
| --- | --- |
| **C1** 每个参与者的 Pod 各存一份成员表 | 并发改成员时两个 Pod 可能看法不同，需要一条收敛规则；用一份权威就能不引入这个复杂度 |
| **C3** Matrix 式 power levels + 状态解析 | 表达力最强，但要整套事件图解析、分叉收敛与"权限自改"的授权链；这个场景换不来收益 |
| **A'** 客户端提供时间戳（或自增序号） | 行自己的 `createdAt` 就够；id 又不含时间戳，另造时间只是多一个可被伪造的输入 |

## 落地清单

见 [Solid 多方通信协议改造清单](solid-multiparty-migration.md)。

## 与现有实现的关系（保留 / 改造 / 删除候选）

| 面 | 处置 | 说明 |
| --- | --- | --- |
| 每参与者一个 Pod、只由自己部署写 | **保留** | 这是目标本身 |
| models 布局（房间 chat/thread、事件按天 message 行） | **保留** | 已按 models 权威落地 |
| 房间成员状态（谁在房间里） | **保留** | 协议层需要的最小状态；权威位置见第 4 条（**C2**：只在房主 Pod） |
| 跨 Pod 稳定的事件 id、写入幂等 | **改造中** | 用户消息已支持写入方命名；服务端事件与跨事务/跨日防重复仍待补齐（见第 6 条） |
| 身份派生（MXID、server name、哈希） | **改造→删除** | 改为 WebID 直用 |
| 事件签名、密钥托管、公钥发布 | **删除候选** | 第 2 条的代价已接受 |
| 事务预留（身份库表 + `MatrixEventJournal`） | **删除候选** | R08 原子事件身份与持久执行恢复共同替代，固定 id 本身不够 |
| 入站回执、出站批次队列 | **删除候选** | 投递已定为拉为主（B），两者随之失去理由 |
| 联邦握手（make_join/send_join）、`/send` 语义 | **延后** | 只服务互通 |
| 写路径 v11 规则强制 | **改造** | 降到"成员/角色"判定 |

## 延后事项（不是现在的工作，但不丢）

- **Matrix 生态互通**：`/_matrix/*` 面、`/send`、联邦握手、密钥发布（`/_matrix/key/v2/server`）、
  事件签名与 room v11 语义。保留路径形状，签名、密钥与 v11 不再作为核心实现的依赖；将来要互通时，它是一层**适配**，
  而不是协议本体。
- 与互通相关的验收项（`full` 门禁需要 Docker 等）继续挂在[验收记录](matrix-collaboration-acceptance.md)。

## 证据（来自实测，影响上面的取舍）

- **父容器必须先建**：文档写进不存在的目录能按 URL 读，但**列不到、也订阅不到**。
- **控制记录历史碰撞**：默认 inline 子主体命名曾把同文档的回执和批次 metadata 合并，因此控制记录采用一记录一文档规避。
  这不是通用协议限制；消息的显式子主体 `@id` 隔离证据见[问题记录](issues/drizzle-solid-matrix-metadata.md)。
- **预留搬进 Pod 的成本**：真实 Pod 上稳态 ≈110–150 ms/次（首次 1.4 s），SQL ≈1 ms/条语句——
  确定性事件 id 正好绕开这笔开销。
- **`If-Match` 不是版本检查**（ETag 是修改时间毫秒）；**容器 `ldp:contains` 可用**（之前的判断是解析错误）。

## 已完成 / 待办 / 待确认

**已有实现**（历史门禁与本次复跑边界见[改造清单「进度总览」](solid-multiparty-migration.md)）：
投递路径收敛为一条（`/_matrix/federation/v1/send`）、接收侧接受 Solid 会话、用户消息支持写入方命名、
授权降到成员/角色（本地写入 + 会话投递的批次）。

**待办**：补齐所有事件的写入方命名与跨事务/跨日幂等；按 O1 替换投递侧认证；身份改为 WebID、删签名；
删事务预留、C2 房间权威、拉取投递与删回执/批次；补齐普通消息写前建父容器。

**已确认**：O1、事件逻辑唯一键与冲突 409、HTTP 方法跟 Matrix（PUT）、消息以独立 RDF 主体共享每日文档。
O1 解锁第 3 项（删签名）与第 1 项（身份 WebID）；保留 models 消息布局，metadata 子主体碰撞在对象隔离层处理。

## 相关文档

- [协作决策登记册](matrix-collaboration-decisions.md)（落地状态与历史决策）
- [开发与最终验收指标](solid-multiparty-acceptance-criteria.md)（分工、通过条件与证据门禁）
- [验收记录](matrix-collaboration-acceptance.md)（门禁与证据）
- [Pod 存储契约](matrix-pod-storage-portability.md)、[控制记录契约](matrix-control-records-contract.md)（现状实现细则）
