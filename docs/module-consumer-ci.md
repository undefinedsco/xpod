# 手动候选消费者准备

`module-installed-consumer.yml` 在 macOS 15 上使用 Node 22.21.1、Bun 1.4.2，支持明确选择 CSS 或 API。手动选择工具 workflow 的版本，再填写 `request_json`。默认生成消费者计划并调用对应 driver 的验证模式；显式勾选 `execute_consumer` 后，验证通过才执行该 driver 的 Node、Bun 顺序消费者。此流程不发布产物，也不产生 release qualification。

新 workflow 先随 PR 自然运行仅含 Node 契约检查的 job；PR 不获取候选、不安装项目依赖、不执行消费者。产物准备 job 严格限定 `workflow_dispatch`。按 [GitHub 官方触发规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)，workflow 至少运行一次后，可用 API/CLI 对指定分支或 tag 手动 dispatch；默认分支上的文件决定网页 Run workflow 按钮。首次接入须核对实际 PR run 和 workflow 注册状态，不能预先宣称手动触发已成功。

请求字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 固定 `1` |
| `module` | `css` 或 `api`，单次只验收一个模块 |
| `sourceSha` | 产物实际构建 checkout 的完整 40 位 SHA |
| `product`、`cli` | 各自精确的 acquisition tuple，见下文 |
| `budget` | driver 的 `estimatedPeakBytes`、`remainingFloorBytes`、`cushionBytes`，单位字节 |
| `timeoutSeconds` | 可选，driver 单阶段超时，范围 1–600 秒 |

每个 acquisition tuple 包含 `schemaVersion: 1`、`sourceSha`、`runHeadSha`、`runId`、`runAttempt`、`artifactId`、`artifactSha256`。两个 tuple 的 `sourceSha` 必须与请求一致；PR 的事件 head 可以与实际 checkout 不同，不要求两个生产运行的事件 head 相同。数值 ID 必须为正整数，摘要必须为完整 SHA-256。必须选已完成且成功的精确运行与 attempt，CLI 必须为正常 publication preparation artifact，测试产物不能替代。

工具复用现有 acquisition 和 projection helper，保留原始 GitHub 元数据及 ZIP，再生成绑定投影 receipt 和归档摘要的 plan。没有第二套解压器。工具 checkout 与产物源码 checkout 分开记录；获取目录、投影目录和消费者输出位于 checkout 外的私有临时目录。

上传仅包含显式选择的计划、选择器、custody/projection receipt、原始 GitHub JSON 元数据和消费者结果。raw 必须有已知 wait、关闭及进程组不存在的记录，并再次核对最终大小与 SHA-256；进程组状态未知时只保留结果状态，不导出 raw/provenance。导出单文件上限 16 MiB、总计 128 MiB，缺失、超限、摘要不符或不安全路径记录在 `export.json` 的 skipped 中，不能当作完整证据。provenance 先验证 plan → projection receipt → producer receipt 的摘要绑定，再按 producer materials 显式枚举 JSON，并对照预期大小与 SHA-256；保留 `terms/index.json`、`native/inngest/index.json` 等嵌套相对路径，拒绝重复路径、逃逸、符号链接和篡改。消费者的 verified 布尔值不能替代这些核验。ZIP、tgz、安装目录、保留的数据和消费者 stdout 不上传；原件在 runner 保留到 job 结束，原生产 artifact 的精确引用仍在 custody 中。导出 artifact 保留七天。

专门探测结果也在明确白名单内：CSS 的 Node/Bun discovery（含 QLever 进程快照），API 的 Node/Bun api-health、rdf-api-health（含静态资源核对结果）。它们只在对应唯一 service/RDF phase 关闭且全局进程组已知后导出原字节，导出索引记录 phase 和观察摘要；这些快照没有 driver 预先记录的文件摘要，不能冒充 producer 原件。PGlite/RDF 依赖探测的实际 JSON 响应位于对应已关闭 phase 的 raw 中。installed-package manifest 必须匹配 `installedVerification.manifestSha256`，并有已关闭安装 phase 和完整 inventory 验证；pointer 再核对 manifest 摘要、包名、版本及 plan 的 integrity。manifest 与 pointer 同样适用每项 16 MiB、全导出 128 MiB 预算；不把约 8 MiB 的 manifest 当成产品大归档排除。缺失材料和未知 phase 均在 skipped 显示，不能据此声称证据完整。

本机验证只使用小夹具，不下载真实大归档。Workflow 在获取前检查磁盘，另为获取与投影预留 6 GiB。该检查不能替代 driver 的运行期预算，也不构成内核硬限制。

现有 CSS driver 在每轮创建独立 HOME 后运行离线安装。独立空缓存的小夹具安装已成功，尚无真实冷 CI 失败证据，不能据此添加依赖预热或认定真实归档已通过。默认 validate-only 成功只表示准备与验证通过；开启执行后也必须检查实际消费者结果、服务与 QLever、进程退出和保留证据。真实 Chat 链路仍是独立验收层级。

API 沿用公共字段契约，将 `cssReceipt` / `cssArchive` 替换为 `apiReceipt` / `apiArchive`。API 的版本、target 和 archive 读取哈希绑定的 producer receipt，并核对 collector input 的源码与归档关系；不伪造 CSS projection。相同获取入口分别调用现有 CSS/API projector，未增加解压器。消费者 driver 只能通过已验证的模块值选择固定路径；artifact 名包含模块名，避免混淆。执行 API 时，工具 checkout 必须包含共享 Runner 和 `scripts/api-module-consumer.py`；缺少文件会失败，不能借用其他源码树补齐。
