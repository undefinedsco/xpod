# 房间事件图：`prev_events` / `auth_events` / `depth`

日期：2026-09-27。用途：说明持久化到 Pod 的事件如何表达它在房间 DAG 中的位置，附可复现来源。
实现见 `src/api/matrix/protocol/roomGraph.ts`；哈希与签名见
[事件哈希与签名](matrix-event-hashes-and-signing.md)，存储落位见
[Pod schema 提案](matrix-pod-schema-proposal.md)。

来源（本仓库网络下用 `curl` 拉取 `matrix-spec` 源码；MCP fetch 对 `raw.githubusercontent.com`
有 SSRF 限制）：

- `content/server-server-api.md` § PDUs → `prev_events` 的语义
- `content/server-server-api.md` § Auth events selection → `auth_events` 的选取规则
- `data/api/server-server/definitions/components/depth_v6.yaml` → `depth` 的定义与上限
- `data/api/server-server/definitions/components/auth_events_prev_events_v4.yaml` → v4+ 的结构与条数上限
- `content/rooms/fragments/v8-auth-rules.md`（v10/v11 沿用）→ create 事件不得有 `prev_events`、v11 必须选入 create

## 1. `prev_events`

> The `prev_events` field of a PDU identifies the "parents" of the event … The sending
> server should populate this field with all of the events in the room for which it has
> not yet seen a child.

即**前向极值点**（forward extremities）：没有任何事件把它列为 parent 的那些事件。v4+ 的结构是
事件 ID 数组，**上限 20 条**。

由此得到本实现的两条性质：

- **fork 合法且自愈**：两个并发写入者可能各自挂到同一个父事件上，形成分叉；下一个事件的
  `prev_events` 会同时列出两个极值点，把分叉合并。分叉的**状态**由状态解析决定，本仓库尚未
  实现 resolution，所以分叉期间 Pod 的本地顺序仍以 journal 序号为准。
- **延迟事件合法**：重放（同 txnId）时如果房间已经前进，预占时的事件位置可能已经不存在；
  见 §4。

## 2. `depth`

> The maximum depth of the `prev_events`, plus one. Must be less than the maximum value
> for an integer (2^53 - 1). If the room's depth is already at the limit, the depth must
> be set to the limit.

- create 事件没有 `prev_events`，其 depth 记为 **1**；
- 其余事件 = 各 parent depth 的最大值 + 1，并被 `2^53 - 1` 截断；
- 早期写入、没有记录 depth 的事件按 1 处理：这保持 `depth` 真正表达的断言（**大于每个
  parent**）成立，而不去编造历史；
- 本仓库的**同步顺序**是 journal 序号，与事件自带的 `depth` 是两个量，不得互相代替
  （journal 序号是本地实现细节，`depth` 是随事件签名传播的协议字段）。

## 3. `auth_events`

选取规则（规范原文）：「`m.room.create` 事件的 `auth_events` 为空；其它事件应为房间状态的
如下子集」：

| 条目 | 条件 |
| --- | --- |
| `m.room.create` | v11 必须选入（v8 auth rules：缺少即 reject） |
| `m.room.power_levels`（当前） | 存在时 |
| 发送者当前的 `m.room.member` | 存在时 |
| 目标当前的 `m.room.member` | 仅 `m.room.member`，目标为 `state_key` |
| 当前 `m.room.join_rules` | 仅 `m.room.member` 且 `membership` ∈ {join, invite, knock} |
| `m.room.third_party_invite` / `join_authorised_via_users_server` 的 member | 本仓库不支持第三方邀请与 restricted join，未实现 |

**上限 10 条**。选取顺序固定（create → power_levels → 发送者 member → 目标 member →
join_rules），因为数组在 canonical JSON 里是**有序**的：同一房间状态下必须得到同一数组，
否则同一事件的哈希与 ID 不可复现。

「当前」= 该 `(type, state_key)` 槽位中 journal 序号最大的事件。本仓库把生成事件时依据的
授权状态一并写进事件，因此**授权链可以仅凭 Pod 复核**；是否允许（auth rules 本身、power
level 判定、状态解析）仍未实现。

## 4. 预占与重放：位置变了怎么办

事件 ID 覆盖 `prev_events` / `auth_events` / `depth`，所以「先预占 ID、再写 Pod」的流程必须
在预占时就固定位置。规则：

1. 重放且首次尝试**已写入** → 直接按预占记录寻址读回该事件返回，不重建、不重签（首次响应
   语义，见[决策登记册](../matrix-collaboration-decisions.md)「去重与可恢复提交」）；
2. 重放且首次尝试**未写入**、房间位置未变 → 用预占记录里的时间戳与 ID 重建，落到同一地址；
3. 重放且首次尝试**未写入**、房间已前进 → 预占记录钉住的 ID 已经无法由当前内容推导，于是由
   本次尝试在当前位置重新预占（`replaceReservation`）。这以「预占对应的事件确实不在 Pod 里」
   为前提，因此不会产生孤儿事件；若此时首个尝试其实只是很慢、随后才落盘，就会形成 §1 的分叉
   ——这正是登记册里「未知结果处理」尚未定契约的部分，不能宣称已解决。

## 5. 与 Synapse 的差异（待对账）

Synapse 的 Rust 事件格式对 v4+ 把 `prev_events` / `auth_events` 表示为
`[event_id, {"sha256": …}]` 二元组（`rust/src/events/mod.rs` 的 `EventFormatEnum::V4`）；
而当前 `matrix-spec` 的 `auth_events_prev_events_v4.yaml` 已写成**纯事件 ID 字符串数组**。
本仓库按当前规范文本写字符串数组。这条差异在实现 Federation 端点（登记册待办）时必须逐
peer 处理：入站事件两种形态都要能接受，出站形态按对端与所选 room version 决定。

## 6. 测试向量

`tests/api/matrix/protocol/roomGraph.test.ts` 固定：

- create 事件：`prev_events` / `auth_events` 为空、depth 1，即使调用方给了事件列表也一样；
- 链式 depth：子事件 depth = parent depth + 1，超过上限时截断；
- auth 选择：create + power_levels + 发送者 member 的顺序；同槽位取最新；member 事件追加目标
  member 与 join_rules；leave/ban 不追加 join_rules；未知发送者只选 create；
- 分叉合并：两个极值点全部列出，depth 取两者最大值 + 1；
- 极值点超过 20 条时保留最深（最新）的 20 条；
- 没有图字段的旧事件按「链的起点」处理；
- 同一房间状态下位置可复现（与输入顺序无关）。

`tests/api/matrix/persistedEvent.test.ts` 固定端到端性质：真实房间中 create/join/state/message
的图形态、`prev_events` 指向上一极值点、无悬挂引用（每个引用都能在同一房间内取回）、两个极值点
被后续事件合并、以及 §4 第 3 条的重占路径。
