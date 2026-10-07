# Chat 镜像缺少可恢复的房间权威来源绑定

状态：2026-10-03 独立设计审查发现；C2 尚未验收。共享定义归 models，Xpod 只实现读取 adapter。

## 场景与复现

1. 房主 A 的 Pod 保存房间正本，参与者 B 的 Pod 保存同一 roomId 的 Chat 镜像。
2. B 把本地镜像 author 改为 B，并在 B 的 Pod 放一份 author=B、roomId 相同的 Chat。
3. 若 adapter 从镜像 author 选择 owner，再通过 E3 查 Pod，读取候选 Chat 并校验 author/roomId，伪造仍完全自洽。

候选内容与候选地址来自同一份可改镜像，自校验不能证明它是原房间的正本。WebID host 相同、Pod 已登记、另一份 Chat 自称相同 roomId，也都不构成来源证明。

## 已核对的缺口

- models 0.2.59 的公开 Chat 有 author、participants 和 metadata.memberRoles，没有公开 canonical Chat 来源关系。
- 当前 roomId 为随机名加 WebID host，没有绑定完整 WebID 或 canonical Chat IRI。
- 远端加入结果保存 event/state/authChain，没有已认证的 ownerWebId/canonicalChatIri 固定绑定。
- E3 是路由解析；`createMatrixPodResolver(webId, requestedPodUrl)` 的显式 Pod 分支只检查已登记根，不能据此证明它属于该 WebID。归属核验须使用完整 WebID 的登记 Pod 集合。

## 必须补齐的契约

必须先固定房间身份与正本资源的关系，再实现读取。当前设计采用新 roomId 可逆编码精确 canonical Chat IRI，保持 Matrix 的房间 ID 形状及 255 字节上限；超限明确拒绝。改变来源 URI 会得到不同 roomId，删除 SQL 后仍能恢复来源。编码属于 Xpod 协议行为，Chat 布局及 URI 校验复用 models 与 drizzle-solid 的公开 builder/parser。

若其他 app 需要可查询的镜像来源 URI 属性，其名称及 RDF predicate 仍由 models 维护；本次安全修复不以新增可变属性为前提。
单独增加一个可改的 sourceChat/canonicalChat 属性仍不够：替换来源必须变成另一个房间，或由独立受保护的公开 Pod 事实证明既有 roomId 的固定来源。SQL 只能缓存该绑定，丢失后须能从可信 Pod 事实恢复。

读取端接受在可信创建或加入流程中确定的 `(roomId, 完整 ownerWebId, canonicalChatIri)` 固定句柄，使用当前参与者的 authenticated fetch 读取该精确资源，再校验 author/roomId。后续镜像变更不能重定位这个句柄；迁移或房主变更须由原来源确认。

## 当前处理边界

只有掌握可信固定来源的路径可以读取权威成员事实。仅剩镜像、无法恢复绑定的旧房间可以展示离线内容，新的写入、执行及需确认房间权威的读取应拒绝并报告“房间权威来源未确认”。不得从 author===caller、部署凭据或新增 SQL owner 表恢复信任。

新建时先生成 Chat 的随机布局键与公开 builder 的 IRI，再生成房间 ID，消除 roomId 哈希反推来源的循环。读取只从房间 ID 解出正本，使用当前 caller 的 authenticated fetch；源 author 的完整 WebID 必须登记拥有源 Pod。镜像 author 无权选择地址。来源 URI 读取发生跨资源重定向时拒绝。

Matrix 的完整房间 ID 长度限制见[官方房间 ID 定义](https://spec.matrix.org/latest/appendices/#room-ids)。本记录提出必要的共享契约与 adapter 方案；尚未声明编码、schema 或迁移已经实现。原生事件引用游标可以独立继续开发，但不代替这项 C2 来源验收。

## B46 已核对的公开契约与能力缺口（2026-10-03）

在新标签 `!c1_<base64url(UTF8 exact canonical chat IRI)>:<URL.host>` 的纯编解码/校验 adapter
（`src/api/matrix/canonicalRoomIdentity.ts`）实现中，核对了实际安装版本：

- `@undefineds.co/models` **0.2.59** 导出 `chatResource`（`PodTableWithColumns`，含 `parseRef`/`buildIri`），
  以及 `extractChatIdFromChatRef`、`buildChatTargetRef` 等 chat.utils。
- **`parsePodResourceRef` 不在 models**，实际由 `@undefineds.co/drizzle-solid` **0.3.24** 导出
  （`dist/core/resource-reference`），签名为 `parsePodResourceRef(resource, ref): PodResourceReference | null`，
  `PodResourceReference = { resourceId, templateValues }`。设计文字里的“models 公开导出 parsePodResourceRef”
  与实际安装不符，已按 drizzle-solid 实际签名实现（`chatResource.parseRef` 与之一致）。
- `chatResource` 的 exact 布局：`buildIri(scope,{id:key})` → `<scope>.data/chat/<key>/index.ttl#this`，
  `parseRef(iri).templateValues.key` 给出布局键。**exact roundtrip 的 builder target 是 `{ id: key }`**；
  `buildId({ key })` 会抛 `resolvePodResourceId requires a resource id on target.id`，因此校验器用
  `buildIri(registeredPod, { id: templateValues.key })` 做权威 exact 反建。

结论：**无需新增 models helper** 即可完成本 slice 的 PUBLIC sharedChat layout exact roundtrip 证明；未
shadow models/drizzle helper，未复制路径正则/日期规则/私有 schema 字段。若未来读取端需要“从完整 WebID 的
登记 Pod 集合”这一能力，属于 C2 production read port，另行核对公开契约。
