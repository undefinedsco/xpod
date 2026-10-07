# Matrix 实现复审：性能与恢复阻塞项

日期：2026-09-24。审查对象为当前工作区实现、协作设计和 2026-09-23 验收报告。本轮没有修改产品代码。

结论：已有测试证明部分功能路径成立，但实现还不适合作为生产多智能体协作基建。性能问题同时来自 Matrix 访问路径和 ORM；不能只以 hydration 上游问题解释。此前“基础闭环可运行”的结论必须限定在已测场景，不能扩大为恢复机制完整。

## 本轮证据

执行 `bun .test-data/matrix-review/scan-probe.ts`，使用现有 MatrixMemoryDatabase、实际 PodMatrixStore / Runtime / Queue，计数调用，不模拟或宣称生产延迟。100 和 1,000 条历史均复现线性增长。1,000 条历史的结果如下，额外事件为房间 state 和随后新增的触发消息：

| 操作 | 全历史扫描次数 | registerEvent 调用 | 历史 receipt 查询 |
| --- | ---: | ---: | ---: |
| 无新消息的 sync，limit=1 | 2 | 2,008 | 0 |
| 无任务的 claim | 2 | 2,008 | 1,000 |
| 发送一条有目标的消息 | 3 | 3,014 | 2 |
| 领取现有任务 | 3 | 3,015 | 1,003 |
| 续租 | 1 | 1,005 | 0 |

计数使用内存 journal；生产 SQL 的 registerEvent 对每个已登记事件仍执行一次 SELECT（MatrixEventJournal.ts:91–98、130–134），且调用方逐条 await。表中数字不是 SQL 实测耗时，也不包含 ORM 额外文档 hydration。

## P1：分页与增量同步的成本仍取决于全部历史

位置：`src/api/matrix/PodMatrixStore.ts:316–376、622–643`。

listEvents 全量读取 thread 的 Message，逐条登记/查询 journal 后才排序；sync 的 since、limit 在此之后应用。每次请求先丢弃一轮 syncOnce 的输出，再扫描第二轮。长轮询无消息时仍继续重复扫描。历史分页亦全量读取后 slice。

影响：limit=1 并没有限制读取量；历史越长，空闲客户端开销越大。完整读取 N 条积压、页大小 L 时，扫描量约为 O(N²/L)，并叠加逐事件 SQL 往返及逐文档 RDF hydration。

修复方向：提供按 scope/room/sequence 范围分页的事件引用索引，读取该页正文；把原生 Pod 消息发现与请求分页分开，设计持久增量发现及有界补偿扫描。不能仅靠 createdAt 截断，否则会漏晚到消息。

## P1：常规 claim 每次执行全历史灾难恢复

位置：`src/api/reconciler/AgentWakeRuntimeService.ts:25–30`；`src/api/matrix/PodMatrixStore.ts:834–844`。

即使队列健康、没有新任务，claim 仍先 authorize 全扫描，然后 recover 再扫描并逐条查询历史 receipt；有任务时 loadInput 第三次扫描。恢复还遍历其他 Agent 的历史任务，不按本次领取的 lane 限定。

影响：多 Agent 的空闲轮询放大 Pod 与 SQL 负载；任务越多，领取下一项越慢。这个开销不能通过优化一个 ORM 查询消除。

修复方向：正常调度读取 pending 工作索引，恢复采用持久检查点、受控批次和互斥恢复任务；限定恢复 scope/lane，保留崩溃窗口的可对账记录。不可简单删除 recover，否则会失去当前依赖它的补偿能力。

## P1：租约心跳依赖全扫描，claim 可返回已过期任务

位置：`src/api/reconciler/AgentWakeRuntimeService.ts:27–30、37–38、71–78`；`src/api/matrix/PodMatrixStore.ts:824–830、847–867`。

renew 在访问队列前先通过 reference/options 调用 authorize，读取全部历史。claim 在队列授予租约后才加载历史、校验输入、写 Run，返回前不检查剩余有效期。

复现：队列使用可控时钟，租约 1 秒，模拟 loadInput 消耗 2 秒；claim 返回 job，返回时租约已过期，立即 renew 返回 409。此为故障时间模拟，不是生产耗时测量。

影响：存储延迟可能在执行器收到任务前耗尽租约；续租自身也可能错过期限，导致接替、重复执行及尝试预算耗尽。

修复方向：以可精确读取的当前成员/授权状态完成检查，续租不加载 timeline；输入准备阶段维护租约，返回前确认并续期，租约已丢失时不得返回可执行任务。增加延迟注入和竞争领取测试。

## P1：队列耗尽次数可能永远不收敛到 Pod 终态

位置：`src/api/reconciler/WakeAgentQueue.ts:76–81、144–146`；`src/api/matrix/PodMatrixStore.ts:988–1002`。

复现：连续三次在 queue.claim 成功后、loadInput/Run 落盘前中断。队列 attempts 达到 3，但 Pod 没有对应次数。后续 claim 将队列 job 标为 failed 并移出 pending；recover 依据 Pod Run 判断仍可执行，但 enqueue 被已存在的 failed job 去重挡住。

实际复现结果：后续 claim 连续返回 null，队列无待领取项，Delivery 永久 pending。当前失败终态没有可查询/可靠回写的恢复协议。

修复方向：对齐唯一的持久尝试记录和终态对账机制；队列不能静默吞掉需要持久化的失败转换。加入每个 claim 持久化边界前后的进程中断测试。

## P1：未写出结果的事务预留会阻断替代执行器

位置：`src/api/matrix/PodMatrixStore.ts:893–900`。

复现：complete 成功预留结果 hash，但在 ASSISTANT Message 写入前中断。租约接替后，第二次执行生成不同正文；complete 因固定 job 预留 hash 不同返回 409。此时没有已提交输出，SQL 又只存 hash，无法恢复原正文。

实际复现结果：第二次领取成功、attempts=2，第二次 complete 返回内容冲突，ASSISTANT 输出数为 0、Delivery 仍 pending。真实模型重试通常不能保证字节级相同正文，工具幂等也不能解决此结果提交问题。

修复方向：为预留结果提供可恢复提交载荷/提交意图，或建立受合法 attempt 控制的未提交预留接替协议；已提交结果仍须保持幂等。不能直接允许覆盖所有预留。

## P2：PostgreSQL 新事件写入跨 Pod 争用同一表锁

位置：`src/api/matrix/MatrixEventJournal.ts:102–106`。

所有 scope 新事件注册都获取 SHARE ROW EXCLUSIVE 表锁并持有到事务提交；该锁解决提交顺序问题，但也串行化无关 Pod 的登记。新建或首次同步大历史房间会与其他租户的新消息竞争。

修复方向：使用 scope 级的提交有序序号分配，保持高水位不能越过未提交事件的保证；补跨 Pod 并发验收，不能简单去掉锁、退回裸 BIGSERIAL。

## 验收报告需要补的证据

原报告说明 63 条消息样例耗时约 435 秒，包含夹具启动及存储访问；不能直接换算吞吐量。样例的 180 秒租约和 120 秒请求超时也不能证明默认 30 秒租约下可用。目前集成断言验证内容和分页，没有分阶段延迟、查询数或规模增长门禁。

下一轮至少增加：

- 历史 100 / 1,000 / 10,000 条的空 sync、单页 sync、send、空 claim、renew；分别记录端到端 p50/p95/p99、Pod 请求数、SQL 查询数、CPU/内存。
- 多 Agent 空闲轮询、多 Pod 并发、积压恢复，验证健康 Pod 不被另一 Pod 的历史扫描拖慢。
- 默认 30 秒租约及存储延迟注入；返回任务仍有效、心跳及时完成、租约丢失不返回可执行结果。
- claim→Run、结果预留→Message 两个崩溃窗口，验证任务最终 completed/failed，不能永久 pending。
- 真实原生 QLever、Redis/PostgreSQL 环境，启动/账号准备耗时与业务 API 耗时分开记录。延迟门槛先按部署目标确定，不能用放大超时替代。

本轮为代码复审与隔离故障复现，没有重新执行完整集成，也没有对用户常驻 Gateway 做负载测试。性能计数和故障复现不等于生产基准。
