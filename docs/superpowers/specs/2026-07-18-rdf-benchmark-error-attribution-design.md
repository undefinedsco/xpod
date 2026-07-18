# RDF Benchmark 隔离、错误归因与引擎修复设计

## 背景

2M facts benchmark 已暴露两类不同问题：

1. `cacheMode=off` 并发数据通过本机 `kubectl port-forward` 采集，连接中断后被 checkpoint 带入后续集群内直连运行，导致 RDF3X 错误率被错误放大到 99.77%。
2. 集群内直连的 `production` 数据中，RDF3X 为 141,788 次成功、20 次错误（0.014%），QLever 为 3,129 次成功、7,800 次错误（71.37%）。现有报告只保存错误计数，没有保存错误分类和有限样本，无法据此确定引擎根因。

因此，必须先修复 benchmark 的证据边界，再修复可稳定复现的 RDF3X 问题，最后才在同一基线上处理 QLever。

## 目标

1. checkpoint 不得跨执行位置、数据库实例或传输方式复用并发证据。
2. 并发错误必须按类别统计，并保存有限、脱敏的代表样本。
3. 基础设施连续失败不得被紧循环放大为几十万次“引擎错误”。
4. 并发 workload 完成后立即 checkpoint，避免整引擎阶段失败导致全部重跑。
5. 在集群内直连环境重新建立 RDF3X 基线，修复所有可复现的 RDF3X 引擎错误。
6. RDF3X 基线稳定后，以完全相同的环境、数据和 workload 定位 QLever 的正确性、计划和并发问题。

## 非目标

- 本轮不跑 10M facts。
- 不因 benchmark 基础设施错误修改 RDF3X 或 QLever 执行语义。
- 不重写整个 benchmark runner。
- 不把 timeout 自动视为引擎缺陷；必须先确定错误发生边界。

## 设计

### 1. 执行环境身份

benchmark 增加显式的 `executionContext`，至少包含：

- `location`：例如 `local`、`cluster`；
- `transport`：例如 `direct`、`port-forward`；
- `databaseIdentity`：数据库实例的非敏感稳定标识；
- `runnerIdentity`：runner 类型或版本；
- `engineCommit` 与 workload 集合。

checkpoint fingerprint 必须包含以上字段。任一字段变化时，旧的并发证据不得恢复。

为避免浪费，延迟和并发 checkpoint 分别带证据上下文。只有上下文完全一致的记录才可恢复；不能为了复用延迟结果而接受不一致的并发结果。

### 2. 错误归因

每个并发记录新增错误分类：

- `timeout`
- `connection`
- `cancelled`
- `engine`
- `correctness`
- `unknown`

每类保存：

- 总数；
- 最多三个脱敏代表样本；
- 首次和末次出现时间；
- workload、engine、cache mode、concurrency；
- 错误发生阶段，例如 acquire、query、materialize、cancel、cleanup。

样本不得包含连接串、凭据、Pod IP 或用户数据。

### 3. 失败节流与基础设施熔断

并发 worker 在一次操作失败后不得立即无延迟重试：

- timeout、engine error：按正常下一次操作继续；
- connection error：短退避后重试；
- 连续 connection error 达阈值后，该 workload 标记为基础设施失败并提前结束。

基础设施失败单独报告，不计入引擎 error rate。只有已进入引擎执行边界的错误才计入引擎错误率。

### 4. checkpoint 粒度

checkpoint 从“整个 engine/cache phase 完成后保存”改为“每个 workload × concurrency 完成后保存”。恢复时只跳过上下文一致且完整的记录。

checkpoint 只保存报告所需摘要，不保存结果行或大 digest，继续保持小文件和原子替换。

### 5. RDF3X 修复流程

1. 在集群内 direct runner 上只跑 RDF3X、2M、并发 1/8/32。
2. 将 20 个 production 错误按新分类重新采样。
3. 如果错误属于基础设施或主动取消，修 benchmark，不改引擎。
4. 如果错误进入 RDF3X 执行边界，建立最小可重复测试，再修对应执行路径。
5. 验收要求：RDF3X 引擎错误率为 0；若存在主动 timeout，必须作为 workload 结果而不是未知错误，并有明确样本。

### 6. QLever 修复流程

RDF3X 验收后，在同一 runner、数据库、数据集、cache mode 和 timeout 下运行 QLever：

1. 先修正确性失败：排序、LIMIT/keyset、聚合、ACL deny 等。
2. 再修计划异常：绑定未下推、中间结果爆炸、错误 join order。
3. 最后修并发和取消：连接生命周期、query cancellation、错误传播。
4. 每修一类问题，先跑最小 workload，再跑完整 2M 对比；不先扩到 10M。

## 测试与验收

### 单元测试

- execution context 任一字段变化都会拒绝对应 checkpoint 记录。
- 延迟记录可在延迟上下文一致时恢复，但污染的并发记录不可恢复。
- 错误分类、脱敏、样本上限和阶段标注正确。
- connection error 有退避和熔断，不会产生紧循环错误洪水。
- 每个 workload/concurrency 完成后都写入原子 checkpoint。

### 集成测试

- runner 断连后，报告将其标为 infrastructure failure，不计入 RDF3X error rate。
- direct runner 重启后只能恢复同一数据库身份的证据。
- RDF3X 与 QLever 使用相同数据快照和执行上下文。

### 最终证据

- 一份未混用传输环境的 RDF3X 2M 并发报告；
- RDF3X error rate 为 0，或所有非零项均有明确、可复现且分类正确的证据；
- 一份基于稳定 RDF3X baseline 的 QLever 问题清单和修复后报告；
- 报告中不再出现由连接故障放大的几十万次引擎错误。

## 风险

- 数据库身份若只取连接串会泄漏凭据；必须由数据库内稳定、非敏感信息生成。
- 熔断阈值过低会掩盖短暂抖动；测试需覆盖一次性失败和持续失败。
- QLever timeout 可能同时包含计划问题和取消问题；必须按执行阶段分开归因。
