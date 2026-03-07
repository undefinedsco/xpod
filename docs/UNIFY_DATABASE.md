# 统一数据库方案：只支持 PostgreSQL

## 背景

当前需要维护两套代码：
- 2 个 schema 文件（`schema.pg.ts` 和 `schema.sqlite.ts`）
- 7 个文件中有数据库类型判断
- 64 处原生 SQL 需要考虑兼容性
- 多个辅助函数（`toDbTimestamp`, `fromDbTimestamp`, `now()` 等）

## 方案：移除 SQLite 支持

### 影响范围

**当前使用 SQLite 的场景：**
1. Local 模式（托管式）：`docker-compose.cluster.yml` 中的 `local` 服务
2. Local 模式（独立式）：`docker-compose.standalone.yml`
3. 本地开发：`.env.local`

**迁移后：**
- 所有场景都使用 PostgreSQL
- Local 模式在 Docker 中也连接 PG
- 本地开发使用 Docker PG（`postgres://localhost:5432/xpod_dev`）

### 实施步骤

#### 1. 修改 Docker Compose 配置

```yaml
# docker-compose.cluster.yml
services:
  local:
    environment:
      # 改为连接共享的 postgres 服务
      CSS_IDENTITY_DB_URL: postgres://xpod:xpod@postgres:5432/xpod
      # 或者使用独立的数据库
      CSS_IDENTITY_DB_URL: postgres://xpod:xpod@postgres:5432/xpod_local
```

#### 2. 删除 SQLite 相关代码

**删除文件：**
- `src/identity/drizzle/schema.sqlite.ts`

**修改文件：**
- `src/identity/drizzle/db.ts`
  - 删除 `isDatabaseSqlite()` 函数
  - 删除 `isSqliteUrl()` 函数
  - 删除 `toDbTimestamp()` / `fromDbTimestamp()` 函数
  - 删除 SQLite 相关导入和逻辑
  - `getSchema()` 直接返回 PG schema

- `src/identity/drizzle/schema.ts`
  - 直接导出 PG schema：`export * from './schema.pg';`

- `src/storage/quota/UsageRepository.ts`
  - 删除 `isDatabaseSqlite` 导入
  - 删除 `now()` 方法
  - 所有 `this.now()` 改为 `new Date()`

- `src/identity/drizzle/EdgeNodeRepository.ts`
  - 删除所有 `isDatabaseSqlite` 判断
  - 删除 `toDbTimestamp` / `fromDbTimestamp` 使用
  - 统一使用 PG SQL 语法

- `src/identity/drizzle/AccountRepository.ts`
  - 删除 SQLite 分支代码

- `src/identity/drizzle/AccountRoleRepository.ts`
  - 删除 SQLite 分支代码

- `src/identity/drizzle/ServiceTokenRepository.ts`
  - 已经统一，无需修改

#### 3. 更新文档

- `CLAUDE.md` - 更新数据库要求
- `README.md` - 更新本地开发指南
- `docs/` - 更新相关文档

#### 4. 更新测试

- 删除 SQLite 相关测试
- 确保所有测试使用 PG

### 优势

✅ **代码简化**：
- 删除 ~500 行重复代码
- 删除 7 个文件中的数据库判断
- 删除 3 个辅助函数

✅ **维护成本降低**：
- 只维护一套 schema
- 只测试一种数据库
- 新功能开发更快

✅ **功能一致性**：
- Local 和 Cloud 完全相同
- 不会出现"PG 能用但 SQLite 不行"的问题

✅ **性能更好**：
- PG 的查询优化器更强
- 支持更多高级特性（JSONB、全文搜索等）

### 劣势

❌ **需要 Docker**：
- 本地开发必须运行 Docker PG
- 但现在测试已经依赖 Docker 了

❌ **资源占用**：
- PG 比 SQLite 占用更多内存
- 但对于开发环境可以接受

### 迁移风险

**低风险**：
- 只影响开发环境
- 生产环境本来就用 PG
- 可以逐步迁移（先 Local 模式，再本地开发）

### 时间估算

- 修改配置：30 分钟
- 删除代码：1 小时
- 测试验证：1 小时
- **总计：2.5 小时**

### 回滚方案

如果迁移后发现问题，可以：
1. 恢复 `schema.sqlite.ts` 文件
2. 恢复 Docker Compose 配置
3. Git revert 代码修改

## 决策

**建议：立即执行**

理由：
1. 当前维护成本太高（两套代码）
2. SQLite 只用于开发环境，风险可控
3. 可以显著简化代码，提高开发效率
4. 未来如果真需要 SQLite（如嵌入式场景），可以用 VIEW 或其他方案

## 下一步

如果同意此方案，我可以立即开始实施：
1. 先修改 Docker Compose 配置
2. 运行测试确保 Local 模式用 PG 正常工作
3. 然后删除 SQLite 相关代码
4. 最后运行完整测试验证
