# 统一 Timestamp 方案：PG 也用 Unix Timestamp

## 问题

当前需要维护两套代码的根本原因：
- **PG 用 `timestamp` 类型**（返回 Date 对象）
- **SQLite 用 `integer` 类型**（返回 Unix timestamp number）
- 导致需要 `toDbTimestamp()` / `fromDbTimestamp()` / `now()` 等转换函数
- 导致需要在多处判断数据库类型

## 方案：统一使用 Unix Timestamp

### 修改 PG Schema

将所有 `timestamp` 字段改为 `bigint`，存储 Unix timestamp（秒）：

```typescript
// schema.pg.ts - 修改前
export const accountUsage = pgTable('identity_account_usage', {
  accountId: text('account_id').primaryKey(),
  storageBytes: pgBigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  // ...
  periodStart: timestamp('period_start', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// schema.pg.ts - 修改后
export const accountUsage = pgTable('identity_account_usage', {
  accountId: text('account_id').primaryKey(),
  storageBytes: pgBigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  // ...
  periodStart: pgBigint('period_start', { mode: 'number' }),
  updatedAt: pgBigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});
```

### 数据库迁移

```sql
-- 迁移现有 PG 数据
ALTER TABLE identity_account_usage
  ALTER COLUMN period_start TYPE bigint USING EXTRACT(EPOCH FROM period_start)::bigint,
  ALTER COLUMN updated_at TYPE bigint USING EXTRACT(EPOCH FROM updated_at)::bigint;

ALTER TABLE identity_pod_usage
  ALTER COLUMN period_start TYPE bigint USING EXTRACT(EPOCH FROM period_start)::bigint,
  ALTER COLUMN updated_at TYPE bigint USING EXTRACT(EPOCH FROM updated_at)::bigint;

ALTER TABLE identity_service_token
  ALTER COLUMN created_at TYPE bigint USING EXTRACT(EPOCH FROM created_at)::bigint,
  ALTER COLUMN expires_at TYPE bigint USING EXTRACT(EPOCH FROM expires_at)::bigint;

-- 其他表类似...
```

### 代码简化

**删除的代码：**
1. `toDbTimestamp()` 函数 - 不再需要
2. `fromDbTimestamp()` 函数 - 不再需要
3. `UsageRepository.now()` 方法 - 统一用 `Math.floor(Date.now() / 1000)`
4. 所有 `isDatabaseSqlite` 判断（timestamp 相关）

**统一的代码：**
```typescript
// 之前：需要判断数据库类型
const ts = isDatabaseSqlite(this.db)
  ? Math.floor(Date.now() / 1000)
  : new Date();

// 之后：统一
const ts = Math.floor(Date.now() / 1000);
```

### 剩余的差异

统一 timestamp 后，还剩下这些差异：

1. **SQL 语法差异**（少量）：
   - `COUNT(*)::integer` vs `COUNT(*)`
   - `${json}::jsonb` vs `${json}`
   - 可以通过辅助函数封装

2. **Schema 定义**（两个文件）：
   - 但内容几乎完全一致
   - 可以考虑用脚本生成

## 优势 vs 劣势

### ✅ 优势

1. **代码大幅简化**：
   - 删除 3 个转换函数
   - 删除 ~200 行判断逻辑
   - 统一的 timestamp 处理

2. **Schema 几乎一致**：
   - 两个 schema 文件 90% 相同
   - 只剩 `pgTable` vs `sqliteTable` 的差异

3. **维护成本降低**：
   - 新增字段时不需要考虑类型转换
   - 不会出现"忘记转换"的 bug

4. **性能一致**：
   - PG 和 SQLite 行为完全相同
   - 测试更可靠

### ❌ 劣势

1. **失去 PG timestamp 优势**：
   - 无法使用 PG 的时区功能
   - 无法使用 `NOW()`, `INTERVAL` 等 SQL 函数
   - 查询优化器对 timestamp 的优化失效

2. **可读性下降**：
   - 数据库中看到的是数字而不是日期
   - 需要手动转换才能阅读

3. **需要数据迁移**：
   - 现有 PG 数据需要迁移
   - 有一定风险

## 对比：保留 timestamp 的成本

如果保留 PG 的 timestamp 类型：
- ✅ 保留 PG 的时区和查询优势
- ✅ 数据库中日期可读
- ❌ 需要维护两套代码
- ❌ 需要 3 个转换函数
- ❌ 需要在 7 个文件中判断数据库类型
- ❌ 容易出错（忘记转换）

## 建议

**推荐：统一到 Unix Timestamp**

理由：
1. **实用性优先**：我们的场景不需要 PG timestamp 的高级特性
2. **代码质量**：统一的代码更易维护，bug 更少
3. **开发效率**：新功能开发更快，不需要考虑兼容性
4. **可逆性**：如果未来真需要 timestamp 特性，可以再改回来

## 实施步骤

1. **修改 PG Schema**（30 分钟）
   - 修改 `schema.pg.ts` 所有 timestamp 字段为 bigint
   - 修改默认值为 `$defaultFn(() => Math.floor(Date.now() / 1000))`

2. **创建迁移脚本**（30 分钟）
   - 编写 SQL 迁移脚本
   - 测试迁移脚本

3. **简化代码**（1 小时）
   - 删除 `toDbTimestamp` / `fromDbTimestamp`
   - 删除 `UsageRepository.now()`
   - 统一所有 timestamp 处理为 `Math.floor(Date.now() / 1000)`

4. **测试验证**（1 小时）
   - 运行完整测试套件
   - 验证 PG 和 SQLite 行为一致

**总计：3 小时**

## 决策

你觉得这个方案可行吗？主要权衡是：
- **牺牲**：PG timestamp 的高级特性（时区、SQL 函数）
- **获得**：统一的代码，更低的维护成本

如果同意，我现在就可以开始实施。
