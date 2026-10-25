# Matrix 跨 Pod 共享房间引用与路由

更新：2026-10-25。本文描述本轮实现的引用目录、同步游标与路由契约，以及仍未闭合的 ORM 适配点。

## 边界

Matrix 房间的数据根始终是房间自己的 Pod。邀请在保留原有 MXID 兼容的同时，可由客户端显式提交受邀者完整 WebID；服务端验证 WebID 与 MXID 的规范映射后，只在持久引用目录写一条索引。该索引：

- 不创建 Solid ACL/ACR，不修改 Pod root、Room 容器或成员权限；
- 不复制消息正文、timeline 或权威 membership；
- 不替代房间 Pod 中的成员校验，也不让调用者借用房间 owner 的凭据。

目录 schema 使用 identity 数据库的既有 lazy-DDL 模式（`xpod_matrix_room_directory`），只存规范 storage 根、受邀完整 WebID、规范 MXID、房间/事件引用和目录序号。`ON CONFLICT` 使同一邀请重试收敛。

## 验证与路由

`verifyRoomBinding` 只接受规范 HTTP(S) 根（保留路径与末尾斜杠，例如 `https://pods.example/alice/`），并要求已登记的 Pod lookup 确认该根是 `baseUrl` 或 `storageUrl`。语法本身不判断“是不是 Pod”，由登记记录判断；子房间路径只有在它本身就是已登记根时才接受。目录写入会再次验证，因此手工构造的 `verified: true` 不会落库。读取时若存储的根不再规范，整行拒绝而不是降级。

受邀者以自己的身份和设备发起 `sync`。所选 Pod 来自其默认选择；引用中的其他 storage 根只用于把该房间绑定到对应 Pod。每个被路由的 `MatrixStoreContext` 保留 `webId`/`auth`，仅增加 `roomStorage`；Pod fetch 仍按调用者取得，Solid ACL 与房间 membership 在目标 Pod 重新校验。`join` 先读取目录指向的单个 invite 文档（精确资源 id），它仍然标为 `invite` 且匹配规范 MXID 时才写 join；`send`/`history` 走同一路由并重新检查 joined。

## sync 契约

- `co.undefineds.matrix.storage_binding`（state_key 为空）只在邀请来自持久目录、且 storage 已验证时由服务端合成，content 为 `{ storage: <规范 Pod 根>, room_container: <房间容器>, chat: <chat 主语 IRI>, thread: <thread IRI>, verified: true }`。`room_container` 是去掉 fragment、保留末尾斜杠的包含容器；`chat`/`thread` 是既有 models 布局生成的规范主语。`storage` 是 Pod 根，绝不是房间子目录。
- 普通 `m.room.member` 与 `m.room.name` 仍来自房间 Pod 的权威数据；客户端伪造的 `verified` 声明不会被采用。
- `v3` 游标的 `bindings` 只是位置提示：每个 key 必须先按 `(storage, roomId)` 从持久目录按当前认证 WebID 重新解析，再用目录行字段路由/合成 provenance；游标里的 `roomContainer`/`chat`/`thread`/`creatorWebId`/`verified` 一律不采信。缺失、已删除、key 不符、未登记或跨用户的行在**任何 fetch 之前**丢弃。游标字节数与条目数在 JSON 解码前设上限。
- `v3` 游标含 `local`、`invites`、按 storage 根的 `rooms`，以及按 `[storage, roomId]` 的 `roomSequences`。同一 Pod 内的待发事件先按该 Pod journal 序号统一排序，再分配页预算，因此 A 房间不会先推进到 100 而把 B 房间的 50 永久跳过。每个房间 cursor 只推进到实际交付的最后一条；`timeline.limited` 表示仍有积压。不同 storage 根的序号从不比较。
- `v2_<n>` 仍按原 Pod 解释；`listMessages.from` 接受 `v3` 时只使用本 Pod 对应序号。

## 房间级 ORM 绑定（已发布）

依赖升级到已发布的 `@undefineds.co/drizzle-solid@0.3.26`（catalog `api-producer`，release 40192797360；0.3.25 的 patch 改名到 0.3.26，`bun scripts/check-dependency-state.ts` 通过）。`PodMatrixStore.getDb` 对路由房间使用该版本公开的 per-database 绑定：

- `sparqlEndpoint: <room_container>/-/sparql` 只作用于 collection SELECT，且不回退到更宽的 `/.data/chat/-/sparql`；
- `resourcePreparation: 'off'`，避免 Bob 只有房间权限时预检 Pod/父容器；
- 精确读取与写入仍使用 models 的规范文档路径；DB 缓存按 `[storage, room container]` 隔离。即使调用者显式选择 Alice 根，也会收窄到已验证房间。

测试用真实 drizzle + models 加 traced fetch，拒绝所有宽泛 Pod/父容器/全局 URL，只允许该房间的精确文档与 `/-/sparql`。

## joined 列表
`joined_rooms` 返回本地房间，加上目录引用中**房间 Pod 当前 membership 为 join** 的共享房间；仅凭 cursor/目录行不会列出房间。

## 目录分页与投递边界

目录读取有 500 条上限。`listForInviteeAfter` 提供 `{references, nextSequence, truncated}` 继续语义；但 sync 仍在单页内读取最新 500 条，这是明确上限，不宣称为全量分页。

目录只能让同一部署内已被邀请的调用者在自己的 sync 中发现引用。它不提供全球 Matrix federation，也不保证跨服务器邀请自动投递；跨宿主投递若需要，应复用实际存在的 Solid Inbox/notification 机制，本轮未新增该入口。
