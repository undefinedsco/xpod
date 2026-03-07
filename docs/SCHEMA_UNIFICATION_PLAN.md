# Schema 统一重构计划

## 目标

1. **统一 timestamp**：PG 和 SQLite 都用 bigint 存储 Unix timestamp
2. **统一 JSON**：PG 和 SQLite 都用 text 存储 JSON 字符串
3. **精简 metadata**：把重复字段提取为独立列

## 第一步：分析 metadata 字段

### 当前 metadata 存储的内容

```typescript
{
  lastHeartbeatAt: string,      // ❌ 重复：已有 lastSeen 列
  baseUrl: string,              // ❌ 重复：已有 publicUrl 列
  publicAddress: string,        // ❌ 重复：已有 publicIp 列
  hostname: string,             // ✅ 新字段，需要加列
  ipv4: string,                 // ❌ 重复：已有 publicIp 列
  ipv6: string,                 // ✅ 新字段，需要加列
  version: string,              // ✅ 新字段，需要加列
  status: string,               // ❌ 重复：已有 connectivityStatus 列
  subdomain: string,            // ❌ 重复：已有 subdomain 列
  connectivityStatus: string,   // ❌ 重复：已有 connectivityStatus 列
  tunnel: object,               // ✅ 保留：复杂对象
  certificate: object,          // ✅ 保留：复杂对象
  metrics: object,              // ✅ 保留：复杂对象
}
```

### 重构后的 schema

```typescript
export const edgeNodes = pgTable('identity_edge_node', {
  id: text('id').primaryKey(),
  ownerAccountId: text('owner_account_id'),
  displayName: text('display_name'),
  tokenHash: text('token_hash').notNull(),
  nodeType: text('node_type').default('edge'),

  // 网络信息（独立列）
  subdomain: text('subdomain').unique(),
  hostname: text('hostname'),                    // 新增
  publicIp: text('public_ip'),
  ipv6: text('ipv6'),                           // 新增
  publicPort: pgBigint('public_port', { mode: 'number' }),
  publicUrl: text('public_url'),
  internalIp: text('internal_ip'),
  internalPort: pgBigint('internal_port', { mode: 'number' }),

  // 状态信息
  version: text('version'),                      // 新增
  accessMode: text('access_mode'),
  connectivityStatus: text('connectivity_status').default('unknown'),

  // 认证信息
  serviceTokenHash: text('service_token_hash'),
  provisionCodeHash: text('provision_code_hash'),

  // 复杂对象（text 存储 JSON）
  capabilities: text('capabilities'),             // 改为 text
  metadata: text('metadata'),                     // 改为 text，只存 tunnel/certificate/metrics

  // 时间戳（bigint 存储 Unix timestamp）
  lastConnectivityCheck: pgBigint('last_connectivity_check', { mode: 'number' }),
  createdAt: pgBigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: pgBigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  lastSeen: pgBigint('last_seen', { mode: 'number' }),
});
```

### 重构后的 metadata 内容

```typescript
interface EdgeNodeMetadata {
  tunnel?: {
    status: string;
    config: Record<string, unknown>;
    updatedAt: string;
  };
  certificate?: {
    expiresAt: string;
    domains: string[];
    updatedAt: string;
  };
  metrics?: {
    cpu: number;
    memory: number;
    disk: number;
    network: Record<string, unknown>;
  };
  // 允许扩展其他动态字段
  [key: string]: unknown;
}
```

## 第二步：数据库迁移脚本

### PostgreSQL 迁移

```sql
-- 1. 添加新列
ALTER TABLE identity_edge_node
  ADD COLUMN hostname text,
  ADD COLUMN ipv6 text,
  ADD COLUMN version text;

-- 2. 从 metadata 提取数据到新列
UPDATE identity_edge_node
SET
  hostname = metadata->>'hostname',
  ipv6 = metadata->>'ipv6',
  version = metadata->>'version'
WHERE metadata IS NOT NULL;

-- 3. 转换 timestamp 列为 bigint
ALTER TABLE identity_edge_node
  ALTER COLUMN last_connectivity_check TYPE bigint USING EXTRACT(EPOCH FROM last_connectivity_check)::bigint,
  ALTER COLUMN created_at TYPE bigint USING EXTRACT(EPOCH FROM created_at)::bigint,
  ALTER COLUMN updated_at TYPE bigint USING EXTRACT(EPOCH FROM updated_at)::bigint,
  ALTER COLUMN last_seen TYPE bigint USING EXTRACT(EPOCH FROM last_seen)::bigint;

-- 4. 转换 jsonb 列为 text
ALTER TABLE identity_edge_node
  ALTER COLUMN capabilities TYPE text USING capabilities::text,
  ALTER COLUMN metadata TYPE text USING metadata::text;

-- 5. 清理 metadata，移除已提取的字段
UPDATE identity_edge_node
SET metadata = (
  SELECT jsonb_build_object(
    'tunnel', metadata->'tunnel',
    'certificate', metadata->'certificate',
    'metrics', metadata->'metrics'
  )::text
)
WHERE metadata IS NOT NULL;

-- 对其他表执行类似操作
-- identity_account_usage, identity_pod_usage, identity_service_token, etc.
```

### SQLite 迁移

```sql
-- SQLite 不支持 ALTER COLUMN TYPE，需要重建表
-- 1. 创建新表
CREATE TABLE identity_edge_node_new (
  id TEXT PRIMARY KEY,
  -- ... 所有列定义（使用新的类型）
  hostname TEXT,
  ipv6 TEXT,
  version TEXT,
  capabilities TEXT,
  metadata TEXT,
  last_connectivity_check INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen INTEGER
);

-- 2. 迁移数据
INSERT INTO identity_edge_node_new
SELECT
  id,
  -- ... 其他列
  json_extract(metadata, '$.hostname') as hostname,
  json_extract(metadata, '$.ipv6') as ipv6,
  json_extract(metadata, '$.version') as version,
  capabilities,
  json_object(
    'tunnel', json_extract(metadata, '$.tunnel'),
    'certificate', json_extract(metadata, '$.certificate'),
    'metrics', json_extract(metadata, '$.metrics')
  ) as metadata,
  last_connectivity_check,
  created_at,
  updated_at,
  last_seen
FROM identity_edge_node;

-- 3. 替换表
DROP TABLE identity_edge_node;
ALTER TABLE identity_edge_node_new RENAME TO identity_edge_node;
```

## 第三步：代码修改

### 1. 修改 schema 文件

**删除文件：**
- `src/identity/drizzle/schema.sqlite.ts` （与 PG 完全一致后可以删除）

**修改文件：**
- `src/identity/drizzle/schema.pg.ts` - 应用上述 schema 修改
- `src/identity/drizzle/schema.ts` - 直接导出 PG schema

### 2. 删除数据库判断逻辑

**删除函数：**
- `isDatabaseSqlite()`
- `toDbTimestamp()`
- `fromDbTimestamp()`
- `UsageRepository.now()`

**修改文件：**
- `src/identity/drizzle/db.ts` - 删除 SQLite 相关逻辑
- `src/storage/quota/UsageRepository.ts` - 统一使用 `Math.floor(Date.now() / 1000)`
- `src/identity/drizzle/EdgeNodeRepository.ts` - 删除所有 if/else 判断
- `src/identity/drizzle/AccountRepository.ts` - 删除 SQLite 分支
- `src/identity/drizzle/AccountRoleRepository.ts` - 删除 SQLite 分支
- `src/identity/drizzle/DrizzleIndexedStorage.ts` - 删除 `::jsonb` 判断

### 3. 更新 metadata 处理逻辑

**修改文件：**
- `src/api/handlers/EdgeNodeSignalHandler.ts` - 更新 `mergeMetadata` 函数
- `src/service/EdgeNodeSignalClient.ts` - 更新 metadata 构建逻辑

**新增类型定义：**
```typescript
// src/identity/drizzle/types.ts
export interface EdgeNodeMetadata {
  tunnel?: TunnelInfo;
  certificate?: CertificateInfo;
  metrics?: NodeMetrics;
  [key: string]: unknown;
}

export interface TunnelInfo {
  status: string;
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface CertificateInfo {
  expiresAt: string;
  domains: string[];
  updatedAt: string;
}

export interface NodeMetrics {
  cpu: number;
  memory: number;
  disk: number;
  network?: Record<string, unknown>;
}
```

## 第四步：测试验证

### 1. 单元测试
- 测试 timestamp 读写
- 测试 JSON 序列化/反序列化
- 测试 metadata 字段提取

### 2. 集成测试
- 运行完整的 Docker 集成测试
- 验证 PG 和 SQLite 行为一致

### 3. 手动验证
- 创建节点，检查字段存储
- 更新心跳，检查 metadata 合并
- 查询节点，检查数据正确性

## 预期效果

### 代码简化

**删除的代码：**
- ~500 行数据库判断逻辑
- 3 个转换函数
- 1 个 schema 文件

**统一的代码：**
```typescript
// 之前：需要判断数据库类型
const ts = isDatabaseSqlite(this.db)
  ? Math.floor(Date.now() / 1000)
  : new Date();

if (isDatabaseSqlite(this.db)) {
  await executeStatement(this.db, sql`UPDATE ... SET metadata = ${payload}`);
} else {
  await executeStatement(this.db, sql`UPDATE ... SET metadata = ${payload}::jsonb`);
}

// 之后：完全统一
const ts = Math.floor(Date.now() / 1000);
await executeStatement(this.db, sql`UPDATE ... SET metadata = ${payload}`);
```

### Schema 一致性

**之前：**
- 2 个 schema 文件，内容差异大
- timestamp vs integer
- jsonb vs text

**之后：**
- 1 个 schema 文件（或 2 个完全一致的文件）
- 都用 bigint
- 都用 text

### 字段清晰度

**之前：**
- metadata 混杂了简单字段和复杂对象
- 无法直接查询 hostname, version 等

**之后：**
- 简单字段有独立列，可以直接查询
- metadata 只存储真正的复杂对象
- 类型定义清晰

## 实施时间估算

1. **编写迁移脚本**：1 小时
2. **修改 schema 定义**：30 分钟
3. **删除判断逻辑**：1 小时
4. **更新 metadata 处理**：1 小时
5. **测试验证**：1.5 小时

**总计：5 小时**

## 风险评估

**低风险：**
- 只影响开发环境（生产环境可以逐步迁移）
- 有完整的迁移脚本
- 可以回滚

**注意事项：**
- 迁移前备份数据库
- 先在测试环境验证
- 逐步部署到生产环境

## 下一步

如果同意此计划，我将按以下顺序执行：
1. 先修改 schema 定义和类型
2. 编写并测试迁移脚本
3. 删除判断逻辑，统一代码
4. 运行完整测试验证
