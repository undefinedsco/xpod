# 多方协作 Agent 执行与恢复设计

状态：2026-10-02 的实施设计；代码和真实 Pod 验收尚未完成。通过条件仍以 [G09/G11 与全部验收指标](solid-multiparty-acceptance-criteria.md) 为准。本设计替代历史“队列携带内容摘要 + 固定结果 ID 即可删除预留”的方案。

## 逻辑身份与权威执行位置

唤醒逻辑键为 `(roomId, triggerEventId, agentIdentity)`。执行者、runtime、租约、事务、日期和复制 Pod 不进入身份；物理 thread/message IRI 只定位资源。

房主 C2 权威的 `protocols.matrix` Agent grant 发布稳定执行位置绑定：执行 Pod、canonical Thread 和绑定版本。授权代际与位置版本分开。更换 executor 时保持同一权威 Run，使用新 executor 本人的当前 O1 凭据；没有访问权就拒绝或等待，不能在另一 Pod 新建任务，也不能借旧执行者、房主或部署凭据。`workspace` 仍表示工作区，不冒充存储位置。该绑定是协议行为载荷；跨应用共享关系继续使用 models 的 URI 字段，需要新关系时先报告 models 缺口。

Run/Delivery 的日期布局不改变逻辑唯一性。创建须沿用可重建的首次权威定位与时间，或经全日期 first-winner 条件创建后读取胜出记录；不能按每个 API 的观察时间另选分桶。位置迁移必须有显式接管与唯一性证明，不能以换 executor 隐式迁移。

## 持久执行事实

| 现有 models 实体 | 职责 |
| --- | --- |
| Delivery | 已获准的 admission，绑定原触发身份、内容摘要、角色、agent、授权来源；assistant 交接绑定可信前一完成结果 |
| Run | 持久状态、claim/fence、lease、尝试预算与终态 |
| RunStep | 每次尝试和完整完成输出；由 models 的 `run.doc` 布局与 Run 共文档 |
| Message | 正式传播的结果事件，沿用共享每日文档和 R08 原子逻辑唯一写入 |

不能凭消息自报 execution metadata 或 mentions 推定 admission。消息写后、admission 写前的中断，由认证重试或受当前授权的恢复入口重新核对 W3 作者正本与 C2；不能从镜像补造旧授权。队列和 SQL 索引是可重建工作集，不保存唯一的触发信任、正文或不可替代终态。

claim/renew/fail/complete 通过同一权威 Run 的条件转换，核对当前 executor/grant/触发、预期状态、fence、expiry 和持久预算。首次 Run 创建也需竞争保护。重复请求不重复计次；不同 claim 的 started Step 必须独立。清空队列不得复活 completed/failed/cancelled 或重置预算。

## 完整结果先落权威文档

合法提交时，在同一 `runs.ttl` 条件操作中将 Run 转 completed，并写唯一 completed RunStep。完成 Step 包含完整首次输出、eventId、首次时间、body/evidence/handoff/root/hops/reply、触发身份和摘要、实际认证提交者、claim/runtime/fence、授权代际、来源与结果摘要及重建版本。使用 ORM 序列化和独立子主体；不写 eventId-only 的成功占位。

然后幂等 materialize Message，补 Delivery completed、队列确认与交接。`runs.ttl → messages.ttl → deliveries.ttl` 不是跨文档事务；第一份完整输出已可读，才允许从中恢复而不重新执行。没有同文档条件原子提交证明就不能删除旧保护。

Runtime 的历史完成读取先于旧 lease 的 authorize/renew。用当前有效 O1 读取权威完成事实并核对来源、逻辑键、agent、输入和输出：相同提交返回完整原结果；不同 body/evidence/handoff 返回 409 并保留原结果。不得重新运行工具/LLM、生成新时间或复活执行。旧 grant 撤销不抹去合法历史事实，也不授予新的读取、补写或交接权限；补 Message 仍需当前实际写权限。来源不足的旧历史保持可读，明确拒绝自动继续，不能用现在重算的摘要补造历史来源。

## 服务器时间与条件执行

条件评估和权威文件、索引提交在 R08 的共同服务器锁内执行。准备与索引追平后采样一次服务器时间，将标准无参数 `NOW()` AST 降为同一 `xsd:dateTime` 常量，再评估条件。只转换标准 operator，不改字符串、IRI、自定义函数或其他函数；native/embedded、HTTP/PATCH 走同一边界。该时间是条件评估时刻，不宣称等于磁盘落盘瞬间。[SPARQL NOW 规范](https://www.w3.org/TR/sparql11-query/#func-now)

当前编译器拒绝 `NOW()`，且执行器与范围下推会按词法比较非数值日期。需要在既有 `RdfTermSemantics` 补共享 typed-dateTime 值比较，两种执行器复用；尚未具备正确日期值语义的范围索引不得下推，应保留剩余 FILTER。合法日历、时区、精度与不可比较值须显式处理；plain/malformed/无时区 expiry 不得借词法或宽松日期猜测获得效力。保留 `sameTerm` 的 RDF term 身份语义。

模型已声明 timestamp；已安装 ORM 的合法 Date 输入实际产生 `xsd:dateTime`，可以复用，不在 Xpod 新造日期 codec。字符串输入的旧编译探针只有右侧常量 typed，不能证明实际租约比较；旧 plain expiry 必须明确拒绝或经有来源的迁移。

匹配完整旧 JSON 和预期三元组不足以排除额外值。条件还须拒绝并存的 status/owner/expiry/metadata/JSON 值和已完成 Step；保留旧 fence、授权代际及精确原值匹配。歧义记录失败关闭，不任选一值。C2 撤权与另一 Pod 的 Run 转换并非跨 Pod 原子事务；每次新效果重读权威，接替改变同一 Run fence，并遵守已定在途语义。

## 崩溃恢复与删除顺序

| 崩溃位置 | 权威恢复来源与行为 |
| --- | --- |
| claim 后 | admission、Run claim/fence/预算；有效 lease 排除第二执行，合法接替产生新 fence |
| 完成事实前 | 没有完整输出，当前合法 claim 可重试；完成事实已在时只能恢复输出 |
| 输出已存、确认前 | 完整 Step/可能已有 Message；保留首次 ID/时间/内容，补终态，不要求旧 lease 仍有效 |
| 交接前 | 父完成结果；核对当前 handoff，推导唯一下一 job 并补 admission，不重做父任务 |

四处都清空队列与可重建 SQL 后从 Pod 恢复。完成事实前的外部工具副作用仍是至少一次，不宣称天然恰好一次。

R08 全日期/跨进程事件唯一性先替代事件预留；完整执行事实与 fencing 再替代结果预留；可信 admission 与作者核对替代触发回执；可靠 W3 拉取、断线对账先替代出站批次。随后移除 journal reservation 与 queue 的权威租约作用。历史迁移须全量枚举、核对结果集合与摘要，不能只依赖旧两天/七天窗口；无法核对的记录显式保留，不默认删除用户数据、重写作者/ID 或重新执行。

## 必须取得的证据

两个独立 API/队列对同一执行位置竞争；旧 executor/fence 零写；executor 更换及权限不足；四崩溃点和队列/索引清空；完成确认丢失后的旧 lease 过期重试；异内容 409；预算与终态不复活；角色、正文、handoff/root/hops 篡改拒绝；不同 executor WebID 的 author→reviewer；跨日重投。实际 RDF 须检查首次完整值、单值和同文档其他 Run/Step 不变。

时间专项覆盖过去/未来/精确边界、等价偏移时区、不同精度、plain/malformed/无时区、等待锁时过期、多处 NOW 同值、续租与旧 fence 竞争，以及 native/embedded 运行一致性。现有 public ORM 与 compiler 小探针仅证明序列化和编译，不证明真实存储 CAS、租约或 G09。
