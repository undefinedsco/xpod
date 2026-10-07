# Matrix 协作本轮验收记录

日期：2026-09-23。设计见 [协作契约](matrix-collaboration-design.md)，使用方法见 [可执行样例](examples/matrix-collaboration.md)。

## 本轮结果

| 验证 | 结果 | 覆盖范围 |
| --- | --- | --- |
| `bun run build:ts` | 通过 | 最终产品代码类型检查 |
| Matrix/队列/Handler/路由/身份/Run/RDF 专项 | 180 通过，7 条环境条件测试跳过 | 同时间分页、积压、晚到消息、事务并发、授权撤销、篡改、失败和崩溃恢复、HTTP 输入边界、RDF 对象隔离 |
| 真实 Redis 队列专项 | 10/10 通过，其中 4 项连接真实 Redis | 原子入队、领取、续租、旧租约拒绝，重启/数据清空后的 token 不重用；临时实例已关闭 |
| 真实 PostgreSQL journal 专项 | 空库冷启动 3/3 通过；合并 SQLite 为 9/9 | 12 实例并发初始化/事务预留、提交顺序、连接池重开；仅清理独立 scope 数据 |
| ChatKit 兼容回归及消息关系 | 7/7 通过 | 共享唤醒接口使用持久化 participants；请求伪造名单无效，client-owned/缺少 roster 不唤醒 |
| `bun run test:integration` | 完整命令通过 | lite：153 通过、6 跳过；cluster：45/45 通过 |
| 依赖状态与 `git diff --check` | 通过 | 无新增依赖，无手改 node_modules |

环境条件测试的跳过没有被计为成功；Redis/PostgreSQL 对应能力另行在实际服务上执行并读取了通过结果。

## Matrix HTTP 闭环证据

正常集成开关 `XPOD_RUN_INTEGRATION_TESTS=true` 下，Matrix 测试启动独立 Bun Gateway，明确设置 `open:false`、`authMode:'acp'`，通过 HTTP 创建新账号、Pod 和客户端凭据。匿名 whoami 被拒绝。不会借用共享 open 测试栈的虚拟身份。

测试调用仓库样例，实际验证：

1. 房间与 Agent grants 写入后能够正确读回。
2. 相同发送事务返回同一事件 ID。
3. author runtime 领取、续租、提交助手结果，并显式交给 reviewer。
4. reviewer 获得前置结果并回写第二个助手结果；重复完成返回 409。
5. 每批 4 条并发追加 60 条消息，再以 limit=7 分页，核对原始消息、两个助手结果及积压消息共 **63 个事件的 ID 和正文**。
6. 最终报告断言 `status=passed`、`mode=deterministic-runtime`、`expectedEvents=observedEvents=63`、两份结果和多页同步。

该单项集成耗时约 435 秒，包含夹具与严格授权下的存储访问；不是性能基准，也不能用这个结果宣称生产延迟达标。测试完成后清理独立账号数据目录、证据临时文件与服务进程。可使用样例的 `--output` 在自己的验收环境保留报告。

## 本轮发现并处理的问题

除原审查中的身份、游标、事务去重、成员/Agent 授权和缺少执行闭环外，实际运行还暴露并处理了：

- 同文档对象 metadata 子节点重名，导致多条消息状态混合：使用 ORM 支持的显式子节点 `@id` 隔离，见 [问题记录](issues/drizzle-solid-matrix-metadata.md)。
- 队列重建后 fencing token 复用、失败终态复活、已排队触发未重验当前授权和内容。
- 助手结果已落盘而 Run/Delivery 确认中断：恢复时验证回执并补齐终态。
- PostgreSQL 首次建表的并发 catalog 冲突：初始化使用事务级 advisory lock。
- shared Reconciler 收紧名单后 ChatKit 调用方未提供 roster：改读持久化 Chat.participants。

## 尚不能由本轮证据推导的结论

- 没有重启或验收用户当前常驻的 localhost:3000 实例；这里的 HTTP 证据来自独立测试 Gateway。
- 样例由同一 WebID 下两个确定性执行器运行，没有调用 LLM、真实外部工具，也没有证明独立 executor 身份之间的完整 ACL 隔离。
- 集成存储使用仓库 QLever 测试夹具；不是生产原生 QLever 的专项认证。
- 队列、SQL 和 Pod 不是同一事务。执行保持至少一次；Pod 写入不能宣称受到原子 fencing，外部工具仍需幂等。
- 大历史量、生产并发、网络分区与长时故障恢复仍需单独验收。当前 ORM hydration 成本已记录于 [性能问题](issues/drizzle-solid-matrix-hydration.md)。
- 旧 metadata 碰撞数据、旧 MXID/游标和旧 Redis 队列没有自动修复迁移，按设计文档的迁移边界处理。

本轮交付的是可运行且有回归保护的协作基础闭环；生产准入仍须完成上述环境、权限和容量门禁。
