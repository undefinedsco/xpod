# Matrix 协议事实的 Pod schema 提案（给 models）

日期：2026-09-26。状态：**提案，未定案**；§1、§3 的现状与落位已在 2026-09-27 按用户决定更新。
Xpod 不单方面决定共享布局；本文件列出需要 models 定义的字段与理由，供跨仓库评审。

依据：[服务身份契约](../matrix-service-identity-contract.md)（§3.3 验证材料无损保存）、
[存储契约](../matrix-pod-storage-portability.md)、[决策登记册](../matrix-collaboration-decisions.md)。
哈希与签名规则见 [事件哈希与签名](matrix-event-hashes-and-signing.md)。

## 1. 现状（2026-09-27 更新）

**起草时**一条真实消息的 `metadata.protocols.matrix` 只有投影字段，没有 `signatures`、
没有 `hashes`、没有 room version，因此无法从 Pod 独立复核事件的协议合法性。

**现已落地**（`src/api/matrix/persistedEvent.ts`）：整份协议事件保存在
`metadata.protocols.matrix.event`，包含 `event_id`、`room_id`、`type`、`sender`、
`origin_server_ts`、`content`、`hashes.sha256`，配置了服务身份时还有 `signatures`。
因此现在可以从 Pod 独立完成：

- 重算内容哈希并与 `hashes.sha256` 比对（`contentHashMatches`）；
- 重算 reference hash 并与 `event_id` 比对（`eventIdMatches`）；
- 按 redaction 后的对象验签（`verifyPersistedEventSignature`）。

**仍然缺**：`room_version`、`prev_events`、`auth_events`、真实 `depth`。因此状态解析与
授权链复核仍无法仅凭 Pod 完成——这仍是需要 models 定义的部分。刻意不写入的字段：本地事件
不写 `depth`（事件自身的 depth 只有拿到 prev_events 才成立，本仓库的顺序由 journal 序号承载，
写占位值会把假字段签进 event_id）；作者 WebID、txnId 等应用簿记也留在 event 之外。

## 2. 需要持久保存的三类事实

### 2.1 协议事件（每个事件一条，随消息副本走）

| 字段 | 为什么必须 | 备注 |
| --- | --- | --- |
| `room_version` | 决定 redaction 算法与事件授权规则 | 房间级属性，事件侧冗余一份便于独立验证 |
| `event_json` | 重算内容哈希与 reference hash、验签的唯一依据 | **原始 JSON 文本**，见 2.4 |
| `signatures` | 验签与历史回填 | 服务器 → key id → 签名的映射；**不得**与展示正文混存 |
| `depth` / `prev_events` / `auth_events` | 状态解析与依赖获取 | 缺失即无法做状态解析 |
| `origin_server_ts` | 事件时间语义 | 已有投影，但需与协议字段区分 |
| `event_id` | 事件身份 | 已有；须为 reference hash 形式 |

`content` 已由 Solid Chat 表示承载（`sioc:content` 等），**不再复制一份**；`event_json`
是协议事实的载体，两者并存但不互为来源。

### 2.2 事务记录（按 txnId 寻址，用于去重与可恢复提交）

| 字段 | 为什么必须 |
| --- | --- |
| 事务键（scope + 身份/设备 + 完整端点作用域 + 版本域） | 客户端重放要按同一键找回首次结果 |
| 首次 `event_id` / `created_at` / 内容指纹 | 重放返回原响应；内容不同要能判冲突 |
| 目标消息引用 | 与 Pod 内消息关联 |
| 提交阶段 | 崩溃恢复要知道进行到哪一步 |
| 可恢复载荷或指向它的引用 | 只有 hash 无法恢复正文（契约已明确） |

### 2.3 控制 Pod 的事务与投递记录（Federation 侧，属于部署而非参与者）

| 字段 | 为什么必须 |
| --- | --- |
| 入站事务键（来源 server、transaction_id） | 重放同一事务必须返回原响应 |
| 载荷引用与处理状态（收到／待依赖／已接受／已投递） | 未接受的事件不得发布给客户端或 Agent |
| 逐目的 Pod 投递记录（目的 Pod、event_id、绑定版本、状态、尝试时间、错误） | 部分成功要能只补未完成阶段 |

**这三者职责不同，不能挤在一张表/一个资源里**：参与者 Pod 存消息与协议事件；控制 Pod 存
"我们收到了什么、投给了谁"；事务记录存"这次客户端请求首次被接受成什么"。

## 3. 表示形式（2026-09-27 决定，原建议已被否决）

原建议是"优先显式字段、不要把协议事实塞进 `metadata` JSON 字面量"。**用户已决定按现方案
落地**：协议事件整体放在 `metadata.protocols.matrix.event`（该列本就是开放的不透明列，
不需要 models 改动），本次不新增协议字段表。

选择的理由：`event` 的内容恰好就是事件本身，没有超出 metadata 承载范围的分类维度；拆成
列会引入"哪些字段是 schema、哪些是协议内部结构"的持续分界问题（嵌套的 `signatures`、
`content` 尤其如此）。

代价（须在需要时重新上报 models，而不是就地绕过）：

- 验签、依赖获取、状态解析若需要**按协议字段查询**，当前只能读出来再解析；
- `signatures` 不是结构化对象属性，无法按 server/key id 单独查询；
- 一旦出现这种查询需求，按决定登记册的"id 只表达布局 / schema 进 models"规则，应回到
  models 补属性，而不是在 adapter 里继续用 metadata 伪装。

`event_json` 的往返保真仍按 §4.1 处理：本实现保存的是解析后的对象（规范化后哈希可复现），
不是"收到的原始字节"；若未来要支持逐字节复核其它实现的入站事件，须重新评估这一取舍。


## 4. 必须一起定死的两个陷阱

### 4.1 `event_json` 的往返保真

内容哈希与 reference hash 是对**规范化 JSON** 计算的，但规范化是对**解析后的值**做的。
因此：

- 存**收到的原始 JSON 文本**，不要存"我们自己序列化过"的副本；
- 若某实现把 JSON 解析成对象再存，规范 JSON 的整数必须落在 `±(2**53-1)`，否则会静默改值
  （规范对 v1–v5 的历史事件另有宽容，本项目的目标是 v11，不适用）；
- 验签路径必须能证明"存储的 JSON 重新规范化后与签名时一致"，这需要测试向量固定
  （见 [事件哈希与签名](matrix-event-hashes-and-signing.md) §7）。

### 4.2 不得与展示字段互为来源

`sioc:content` 是给人看与会话互通的表示；`event_json`／`signatures` 是协议事实。
从任一方推导另一方都会在两者出现分歧时给出错误结论。冲突时以协议事实为准，
展示层按自己的规则降级（例如使用 redacted 副本）。

## 5. 待 models 决定的问题

| # | 问题 | 影响 |
| --- | --- | --- |
| Q1 | 协议事件是 Message 的**属性**，还是独立资源（Room 下的事件集） | **已决定（2026-09-27）**：作为 Message 属性，整体存于 `metadata.protocols.matrix.event`；独立事件集留待需要跨 Message 查询或状态解析时再提 |
| Q2 | `signatures` 的 RDF 表达（嵌套对象的建模方式） | 决定能否按服务器/key id 查询；随 Q1 决定暂缓 |
| Q3 | `event_json` 用字符串字面量还是分字段表达 | **已随 Q1 决定**：存解析后的对象，规范化后哈希可复现；逐字节保真留待入站事件复核需求 |
| Q4 | 事务记录与控制 Pod 记录的资源命名与日期分桶 | 与"id 只表达布局"规则一致即可，不要用路径段表达分类 |
| Q5 | 旧房间（随机 event_id、无签名）如何标记 | 迁移契约要求保留兼容面或导入新房间，不能伪造历史 |

## 6. 本提案不覆盖

- 具体字段的 RDF 谓词 IRI 命名（需与既有 `UDFS` 词表风格一致）；
- 状态解析与授权规则实现；
- 控制 Pod 的运维（入口、授权、容量、保留期）。
