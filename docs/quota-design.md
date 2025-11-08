# Account & Pod Quota Design

## 1. Background
- CSS 默认的配额策略只针对整体存储容量，无法限制到个人/Pod。
- 当前账号与 Pod 元数据保存在 `.internal`（文件）或 Quadstore/SPARQL 中，缺少可查询的用量字段。
- 拓展目标：为每个账号/POD 增加容量上限与使用量统计，同时避免大范围重构现有存储栈。

## 2. Scope
- 保留现有 SPARQL/Quadstore、MinIO 数据通道。
- 扩展 Account/POD 设定字段，增加 `quotaLimit` 等配置。
- 封装资源写入流程，实时更新用量计数。
- 提供夜间对账脚本，比对真实占用与计数差异。
- 不在本阶段引入新的数据库或迁移现有 JSON 数据。

## 3. Current Behaviour
- `AccountStore` 使用 `ACCOUNT_STORAGE_DESCRIPTION` 中的 `rememberLogin` 唯一字段。
- `PodStore` 记录 baseUrl、owner，但不跟踪大小。
- CSS `QuotaStrategy` 只校验全局限制；`.internal` 由文件系统或共享卷支撑。

## 4. Proposed Changes
### 4.1 Account & Pod Metadata
- 创建 `ExtendedAccountStore`，在 `ACCOUNT_STORAGE_DESCRIPTION` 中添加 `quotaLimit: 'number?'`。
- 可选：在 Pod 元数据中增加 `podQuotaLimit`、`podQuotaGraceBytes` 字段。
  - 对未配置的账号返回全局默认值（当前为 10 GiB，可通过 `XPOD_DEFAULT_QUOTA` 覆盖）。

### 4.2 Usage Tracking Wrapper
- 新增 `UsageTrackingStore`，包装现有 `DataAccessorBasedStore`：
  - 写入/删除时计算 `deltaBytes`，并用 SPARQL `DELETE/INSERT WHERE` 更新 `xpod:usedBytes`。
  - 结构化资源可通过 metadata 获取 `posix:size`；非结构化资源由 MinIO SDK 给出大小。
- 在 Components.js 中，用 `UsageTrackingStore` 替代默认的 `ResourceStore`。

### 4.3 Quota Enforcement
- 新增 `PerAccountQuotaStrategy`：
  - 当前实现仅对比账号的全局默认上限（10 GiB），忽略数据库中的个性化配额字段。
  - 若 `usage + delta > 默认上限`，抛出 413；否则调用原先的 CSS `QuotaStrategy`。
  - 本地 `local` 配置未覆盖 `QuotaStrategy`，因此无配额限制。
- 用 Components override 注入新的策略。

### 4.4 Nightly Reconciliation
- `scripts/reconcileUsage.ts`：
  1. 遍历账号与其 Pod（通过 `AccountStore` + `PodStore`）。
  2. SPARQL 聚合结构化资源；MinIO 列举对象统计字节数。
  3. 重写 `xpod:usedBytes` 三元组，对比实时计数，记录差异。
- 通过 cron/CI 运行，输出报告。

## 5. Data Model
- 命名空间：`xpod:`，新增属性：
  - `xpod:quotaLimit`（账号/Pod 对象上的上限）。
  - `xpod:usedBytes`、`xpod:accountUsedBytes`。
- RDF Structure 示例：
  ```turtle
  :account/123 xpod:quotaLimit "536870912"^^xsd:integer ;
                xpod:usedBytes  "123456"^^xsd:integer .
  :pod/abc     xpod:quotaLimit "268435456"^^xsd:integer ;
                xpod:usedBytes  "65432"^^xsd:integer .
  ```

## 6. Configuration Updates
- 账号存储：Components override `urn:solid-server:default:AccountStore` → `ExtendedAccountStore`。
- 资源存储：`DataAccessorBasedStore` 外层包装 `UsageTrackingStore`。
- 配额策略：重写 `urn:solid-server:default:QuotaStrategy`。
- 新增环境变量（可选）：`XPOD_DEFAULT_QUOTA` 记录全局默认配额。
- 默认账号配额：集群/开发构建中通过 `PerAccountQuotaStrategy._options_defaultAccountQuotaBytes` 配置为 10 GiB；`local` 配置未启用配额覆盖，可无限制写入。
- 用量统计：`UsageRepository` / `ResourceUsageRepository` 在节点本地的身份库中维护账号/Pod 以及资源级的已用字节，`QuotaService` 仅负责返回上限数值；集群无需集中收集数据，节点之间可通过对账脚本共享汇总结果。

## 7. Testing Plan
- 单元：模拟 `UsageTrackingStore` 的写入/删除，验证 SPARQL 更新语句。
- 集成：SQLite 环境下一次完整流程（创建账号 → 设置 quota → 填充资源 → 校验拒绝）。
- 并发：多实例/多线程写入，确保计数不会冲突。
- Reconcile：制造数据偏差 → 运行脚本 → 确认修正。

## 8. Rollout Strategy
1. 实现并在开发环境验证。
2. 运行一次手动对账，确认 baseline。
3. 在 staging 启用新策略，观察日志/告警。
4. 写使用文档（Quota 设置、手动对账）并共享给运维。
5. 正式上线后，开启夜间 reconcile job。

## 9. Open Points
- SPARQL 更新的性能与事务一致性：是否要批量提交或引入缓存。
- MinIO 前缀统计的优化：需不需要引入 Sidecar 或 Lambda 触发器。
- 配额超限后的用户体验（错误提示、告警机制）。
- 长期目标：是否迁移 account/pod metadata 到 PostgreSQL/Drizzle，避免 RDF 操作复杂化。

## 10. Interface Roadmap

## 10. Interface Roadmap
- `QuotaService` 接口仅负责“配额上限”读写（`get/setAccountLimit`、`get/setPodLimit`），不再承担用量统计。
- `UsageTrackingStore`、`SubgraphSparqlHttpHandler` 与 `UsageRepository`/`ResourceUsageRepository` 负责记录账号/Pod 已用字节，并在资源写入时更新节点本地数据库。
- `DefaultQuotaService` (`src/quota/DefaultQuotaService.ts`) 提供无数据库依赖的默认上限（内存存储），`DrizzleQuotaService` (`src/quota/DrizzleQuotaService.ts`) 则复用 Drizzle 表持久化自定义上限；`NoopQuotaService` (`src/quota/NoopQuotaService.ts`) 供本地完全关闭配额使用。
- `PerAccountQuotaStrategy`、`QuotaAdminHttpHandler` 等组件通过依赖注入获取 `QuotaService`，因此可根据环境自如切换配额来源。
- 未来可实现外部计费/支付驱动的 `QuotaService`，让配额策略与支付/MGM 系统彻底解耦；替换时保证相同方法契约即可。
