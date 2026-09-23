# 对 Matrix 实现复审的处置记录

日期：2026-09-24。复审对象见主仓库 `docs/matrix-implementation-review.md`
（本 worktree 不含该文件）。本文只记录**已核对的结论**、**已修复项的证据**与**未解决项的处置**。

## 结论

复审的六条发现全部核对属实，代码位置与复现描述一致。其中三条 P1 已在本次修复：

| 复审条目 | 状态 | 提交 |
| --- | --- | --- |
| P1 租约心跳依赖全扫描，claim 可返回已过期任务 | **已修复**（返回前确认并续租） | `35ce49b0` |
| P1 队列耗尽次数可能永远不收敛到 Pod 终态 | **已修复**（队列耗尽≠Pod 终态，按 Pod 事实放回） | `35ce49b0` |
| P1 未写出结果的事务预留会阻断替代执行器 | **已修复**（悬空预留可由当前 attempt 接管） | `cb7de983` |
| P1 分页与增量同步成本取决于全部历史 | 未修复，需设计决定 | 见下 |
| P1 常规 claim 每次执行全历史灾难恢复 | 未修复，需设计决定 | 见下 |
| P2 PostgreSQL 新事件写入跨 Pod 争用表锁 | 未修复，需设计决定 | 见下 |

## 已修复项的证据

三条都按复审的复现方式先写出失败测试，再修复，并验证测试能抓到原缺陷。

### 租约（`AgentWakeRuntimeService.claim`）

修复：输入准备完成后确认租约，续租成功才返回任务；返回的 job 从队列回读最新租约状态；
续租失败时把任务放回队列并返回 409。续租不再重新加载 timeline（复用 `options` 已解析的
thread/owner）。

测试：`does not hand an executor a job whose lease already died while input was prepared`
——在 `loadInput` 期间把队列时钟推过租约，断言要么拒绝（409）、要么返回后仍可 `renew`。

### 队列终态（`WakeAgentQueue` / `coordination`）

修复：队列仅因自身在途尝试耗尽而终结的 job 标记 `exhausted`，与 Pod 验证过的 `failed`
区分；新增 `listExhausted` / `requeue`；显式 `fail` 或成功完成会清除该标记（不可复活）。
`claim` 在领取前用 Pod 事实（Delivery/Run 终态、Run attempts 预算）核对并把仍可执行的
job 放回对应 lane，队列耗尽且 Pod 仍可执行时重试一次领取。内存与 Redis 实现同步，
Redis 用独立 exhausted 集合记录已移出 pending 的 job，`requeue` 在 Lua 内原子完成。

测试：`keeps a job reclaimable when the queue marks it failed but the Pod has no terminal record`、
`leaves a Pod-terminal job failed instead of resurrecting it`、
`exposes exhausted jobs and requeues them`。

### 悬空结果预留（`commitResult`）

修复：`MatrixEventJournal` 新增 `updateReservation`（只替换既有预留的 content hash，
保留 eventId 与时间）；`commitResult` 在 hash 冲突时先核对预留的**确定性 eventId** 是否
真的存在于 Pod——不存在即表示没有任何已提交输出，由当前 attempt 接管该预留。
已提交结果仍返回 409，不允许覆盖。

测试：`lets a replacement execution commit after a reservation whose output never reached the Pod`
——通过 spy 注入"预留后崩溃"，接替执行提交不同正文。**回退修复后该测试变红**
（`A different result was already reserved for this wake`），确认能抓到原缺陷。

## 未解决项与所需决定

### 扫描放大（复审的两条 P1）

`listEvents` 全量读取 thread 后再排序、逐条登记，`sync` 的 since/limit 在此之后应用；
`recover` 与 `authorize` 各自全扫一遍；`renew` 也经 `options` 触发授权扫描。改为有界
增量需要按 scope/room/sequence 的事件引用索引与持久发现水位。**不能只用 `createdAt`
截断**，否则漏晚到原生消息（复审已指出，与 `drizzle-solid-matrix-hydration.md` 的
结论一致）。这属于新的持久状态设计，需要先确定：

1. 索引放在 SQL journal 还是 Pod；
2. 原生 Pod 写入的发现方式（无变更订阅器，当前靠读取时登记）；
3. 有界补偿扫描的窗口与误判代价。

### PostgreSQL 表锁（复审的 P2）

`xpod_matrix_events` 新事件登记使用 `SHARE ROW EXCLUSIVE` 并持有到提交，保证高水位不
越过未提交事件，但会串行化无关 scope 的登记。改为 scope 级提交有序序号分配需要新的
分配表与崩溃语义。与上面同属"新增持久结构"的决定。

## 全量门禁的当前状态（如实记录）

本次修复后完整门禁跑了三轮：

- Matrix 真实 Gateway 闭环用例：三轮均通过（427–559 秒）；
- 三次中出现过与 Matrix 无关的**超时失败**：`chatkit-pod-store.integration.test.ts`
  （15s 超时）、`CliPasswordLogin.integration.test.ts`（240s）、`PasswordRecovery`（120s）、
  `IdentityStaleCookie`（120s），全部是 timeout 而非断言失败。

**A/B 对照**：在修复前的提交 `6f3b2c12` 上单独运行 `chatkit-pod-store`，得到同样的失败；
在修复后的 HEAD 上同样失败。因此这不是本次改动引入的，而是该套件在并行/负载下不稳定
（也是复审指出的"夹具启动耗时与业务耗时混在一起"的同一类问题）。没有把它算作通过。

隔离运行该套件时还出现过 `ECONNREFUSED` 连不上临时栈，说明它依赖共享测试栈状态；
这需要在测试隔离层面单独处理，不属于本次修复范围。

## 未验证的部分

- 复审要求的规模门禁（100/1,000/10,000 条历史、p50/p95/p99、Pod 请求数、SQL 查询数、
  多 Agent 空闲轮询、多 Pod 并发、默认 30 秒租约下的延迟注入）**尚未建立**；
- 未对常驻 Gateway 做负载测试；
- 三条修复只在单元/隔离回归与真实 Gateway 集成用例上验证，未在生产 QLever/PostgreSQL
  多实例环境验证。
