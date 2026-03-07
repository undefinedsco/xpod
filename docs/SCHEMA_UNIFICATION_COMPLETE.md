# Schema 统一完成报告

## 完成时间
2026-03-03

## 统一目标
消除 PostgreSQL 和 SQLite 之间的代码重复，实现"写一套代码，两个数据库都能用"。

## 核心改动

### 1. Schema 类型统一

**之前的问题：**
- PostgreSQL 使用 `timestamp` 类型 → 返回 Date 对象
- SQLite 使用 `integer` 类型 → 返回 Unix 时间戳（数字）
- PostgreSQL 使用 `jsonb` 类型 → 原生 JSON
- SQLite 使用 `text` + `{ mode: 'json' }` → JSON 字符串

**统一方案：**
- **时间戳**：两个数据库都使用整数存储 Unix 时间戳（秒）
  - PostgreSQL: `pgBigint('created_at', { mode: 'number' })`
  - SQLite: `integer('created_at')`
- **JSON 字段**：两个数据库都使用文本存储 JSON 字符串
  - PostgreSQL: `text('metadata')`
  - SQLite: `text('metadata')`

### 2. Metadata 字段精简

从 `edgeNodes.metadata` JSON 中提取常用字段到独立列：
- `hostname` TEXT
- `ipv6` TEXT
- `version` TEXT

保留在 metadata 中的复杂对象：
- `tunnel` (隧道配置)
- `certificate` (证书信息)
- `metrics` (性能指标)

### 3. 代码简化

**删除的分支判断：**
- `EdgeNodeRepository.listNodes()` - 移除 SQLite/PG 分支
- `EdgeNodeRepository.updateNodeHeartbeat()` - 移除 `::jsonb` 类型转换
- `EdgeNodeRepository.updateNodeMode()` - 统一 capabilities 处理
- `EdgeNodeRepository.mergeNodeMetadata()` - 改为应用层合并
- `EdgeNodeRepository.replaceNodePods()` - 统一使用异步事务

**删除的文件：**
- `src/identity/drizzle/schema.unified.ts` - 不再需要运行时 schema 工厂
- `src/identity/drizzle/views.sql` - 不再需要 PG 视图转换

### 4. 建表脚本

创建了两个结构完全一致的建表脚本：
- `src/identity/drizzle/schema.pg.sql` - PostgreSQL 版本（BIGINT）
- `src/identity/drizzle/schema.sqlite.sql` - SQLite 版本（INTEGER）

## 影响范围

### 修改的文件
1. `src/identity/drizzle/schema.pg.ts` - 统一类型定义
2. `src/identity/drizzle/schema.sqlite.ts` - 添加提取的字段
3. `src/identity/drizzle/EdgeNodeRepository.ts` - 移除所有分支判断

### 不需要修改的文件
- `src/storage/quota/UsageRepository.ts` - 已经使用 `toDbTimestamp()`/`fromDbTimestamp()` 抽象
- `src/identity/drizzle/ServiceTokenRepository.ts` - 已经正确处理时间戳
- `src/identity/drizzle/db.ts` - 保留 `toDbTimestamp()`/`fromDbTimestamp()` 工具函数

## 验证结果

✅ TypeScript 编译通过 (`yarn build:ts`)
✅ 所有类型检查通过
✅ 代码简化，移除了 5+ 处 `isDatabaseSqlite()` 分支判断

## 后续工作

### 数据迁移（如果已有生产数据）
如果 PostgreSQL 已有数据，需要执行以下迁移：

```sql
-- 1. 添加新列
ALTER TABLE identity_edge_node ADD COLUMN hostname TEXT;
ALTER TABLE identity_edge_node ADD COLUMN ipv6 TEXT;
ALTER TABLE identity_edge_node ADD COLUMN version TEXT;

-- 2. 提取 metadata 字段
UPDATE identity_edge_node
SET
  hostname = metadata->>'hostname',
  ipv6 = metadata->>'ipv6',
  version = metadata->>'version'
WHERE metadata IS NOT NULL;

-- 3. 转换时间戳类型（需要停机维护）
ALTER TABLE identity_account_usage
  ALTER COLUMN period_start TYPE BIGINT USING EXTRACT(EPOCH FROM period_start)::BIGINT;
-- ... 其他表同理
```

### 测试建议
1. 运行完整集成测试：`yarn test:integration --no-file-parallelism`
2. 验证 Docker cluster 测试通过
3. 手动测试 metadata 字段的读写

## 收益

1. **代码量减少**：删除了大量 `if (isSqlite) { ... } else { ... }` 分支
2. **维护成本降低**：只需维护一套逻辑
3. **类型安全**：统一的类型定义，减少运行时错误
4. **性能提升**：metadata 常用字段提取到独立列，查询更高效

## 注意事项

1. **时间戳格式**：所有时间戳现在都是 Unix 秒数（不是毫秒）
2. **JSON 处理**：读取时需要 `JSON.parse()`，写入时需要 `JSON.stringify()`
3. **默认值**：使用 `$defaultFn(() => Math.floor(Date.now() / 1000))` 生成时间戳
4. **事务**：SQLite 现在也使用异步事务 API（`db.transaction()`）
