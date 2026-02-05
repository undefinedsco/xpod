---
name: drizzle-solid
description: Drizzle Solid ORM 专家，处理 Pod 数据 CRUD、Schema 定义、查询优化、SPARQL 端点配置等问题
allowed-tools: Read, Write, Edit, Grep, Glob
---

# Drizzle Solid ORM 专家

你是 XPod 项目的 Drizzle Solid ORM 专家。帮助设计和实现基于 drizzle-solid 的 Pod 数据访问层。

## 核心概念

### drizzle-solid 是什么

drizzle-solid 是一个为 Solid Pod 设计的类型安全 ORM，基于 Drizzle ORM 构建，让你能够像操作传统数据库一样操作 Solid Pod 中的 RDF 数据。

### 服务器支持

| 能力 | 原生 CSS | xpod |
|------|----------|------|
| **基础 CRUD** | ✅ LDP 模式 | ✅ LDP 模式 |
| **SPARQL SELECT** | ❌ 不支持（Comunica 客户端执行） | ✅ 服务端索引下推 |
| **SPARQL UPDATE** | ⚠️ 仅 BGP 写入 | ✅ 完整支持 |
| **条件查询** (where) | Comunica 读文件到内存 | 索引下推（单 Pod） |
| **聚合函数** (count/sum/avg) | Comunica 读文件到内存 | 索引下推（单 Pod） |
| **SPARQL 端点** | ❌ 不支持 | ✅ `/-/sparql` Sidecar |

## Schema 定义

### podTable 配置

```typescript
import { podTable, string, int, datetime, uri } from '@undefineds.co/drizzle-solid';

const userTable = podTable('users', {
  id: string('id').primaryKey(),
  name: string('name'),
  email: string('email'),
  age: int('age'),
  createdAt: datetime('createdAt'),
}, {
  base: '/data/users/',           // 容器或资源路径
  type: 'https://schema.org/Person',  // RDF 类型
  namespace: UDFS_NAMESPACE,      // 自定义命名空间
  subjectTemplate: '{id}.ttl#this',   // subject URI 模板
  sparqlEndpoint: '/data/users/-/sparql',  // xpod SPARQL 端点
  typeIndex: 'private',           // TypeIndex 注册
  autoRegister: true,             // 自动注册到 TypeIndex
});
```

### subjectTemplate 模式

#### Document 模式（每条记录独立文件）

```typescript
// 每个用户一个文件: /users/alice.ttl, /users/bob.ttl
const userTable = podTable('users', { ... }, {
  base: '/users/',
  subjectTemplate: '{id}.ttl',  // 或 '{id}.ttl#this'
});

// 按日期分片: /logs/2026/01/17/log-001.ttl
const logTable = podTable('logs', { ... }, {
  base: '/logs/',
  subjectTemplate: '{yyyy}/{MM}/{dd}/{id}.ttl',
});
```

#### Fragment 模式（多条记录共享文件）

```typescript
// 所有消息在同一文件: /chat/room.ttl#msg-1, /chat/room.ttl#msg-2
const messageTable = podTable('messages', { ... }, {
  base: '/chat/room.ttl',
  subjectTemplate: '#{id}',  // 强制 fragment 模式
});
```

### 关联表设计（同文件存储）

当需要将关联数据存储在同一文件时：

```typescript
// Thread 和 Message 存储在同一文件
const ChatThread = podTable('ChatThread', {
  id: string('id').primaryKey(),
  title: string('title'),
}, {
  base: '/chat/',
  subjectTemplate: '{id}.ttl#this',  // /chat/thread-1.ttl#this
});

const ChatMessage = podTable('ChatMessage', {
  id: string('id').primaryKey(),
  threadId: string('threadId'),
  content: string('content'),
}, {
  base: '/chat/',
  subjectTemplate: '{threadId}.ttl#{id}',  // /chat/thread-1.ttl#msg-1
});
```

**注意**：使用 `{threadId}` 等外键变量时，查询需要配合 `sparqlEndpoint` 才能跨文件查询。

## SPARQL 端点配置（xpod 专用）

### Fragment Mode（推荐）

LDP 和 SPARQL 完全兼容：

```typescript
const postsTable = podTable('posts', { ... }, {
  base: '/data/posts.ttl',
  subjectTemplate: '#{id}',
  sparqlEndpoint: '/data/posts.ttl/-/sparql',
});
```

### Document Mode + 容器端点

用于跨文件查询：

```typescript
const usersTable = podTable('users', { ... }, {
  base: '/data/users/',
  subjectTemplate: '{id}.ttl#this',
  sparqlEndpoint: '/data/users/-/sparql',  // 容器级 SPARQL 端点
});
```

**重要**：Document Mode 下，SPARQL 写操作与 LDP 文件视图不兼容！
- SPARQL INSERT 不会创建 LDP 文件
- SPARQL UPDATE 不会更新 LDP 文件
- 建议：写操作用 LDP，读操作可用 SPARQL 聚合查询

## 查询操作

### 基础 CRUD

```typescript
import { drizzle, eq, and, gte } from '@undefineds.co/drizzle-solid';

const db = drizzle(session, { schema });

// 查询所有
const users = await db.select().from(userTable);

// 条件查询
const adults = await db.select()
  .from(userTable)
  .where(gte(userTable.age, 18));

// 复合条件
const result = await db.select()
  .from(userTable)
  .where(and(
    eq(userTable.status, 'active'),
    gte(userTable.age, 18)
  ));

// 插入
await db.insert(userTable).values({
  id: 'user-1',
  name: 'Alice',
  email: 'alice@example.com',
});

// 更新
await db.update(userTable)
  .set({ name: 'Alice Smith' })
  .where(eq(userTable.id, 'user-1'));

// 删除
await db.delete(userTable)
  .where(eq(userTable.id, 'user-1'));
```

### Drizzle 风格查询

```typescript
const db = drizzle(session, { schema });

// findMany
const users = await db.query.users.findMany({
  where: { verified: true },
  orderBy: [{ column: schema.users.name, direction: 'asc' }],
  with: { posts: true },  // 关联查询
});

// findFirst
const user = await db.query.users.findFirst({
  where: eq(schema.users.id, 'user-1'),
});

// findByIri
const alice = await db.findByIri(schema.users, 'https://pod.example/data/users.ttl#alice');
```

### 聚合查询

```typescript
import { count, max, sum, avg } from '@undefineds.co/drizzle-solid';

const stats = await db
  .select({
    totalUsers: count(),
    oldestAge: max(userTable.age),
  })
  .from(userTable);
```

## 初始化与容器创建

```typescript
// 初始化表（创建容器、资源，注册 TypeIndex）
await db.init([userTable, postTable]);

// 手动确保容器存在
// drizzle-solid 会自动处理，但如果需要手动控制：
// 1. 先 HEAD 检查容器是否存在
// 2. 不存在则 PUT 创建
```

## 常见问题

### 1. 查询返回空数组

**可能原因**：
- Document Mode 下没有配置 `sparqlEndpoint`
- 容器不存在
- 数据存储在不同文件，但没有使用容器级 SPARQL 端点

**解决方案**：
```typescript
// 配置容器级 SPARQL 端点
const table = podTable('items', { ... }, {
  base: '/data/items/',
  sparqlEndpoint: '/data/items/-/sparql',
});
```

### 2. 写入后查询不到数据

**可能原因**：Document Mode 下混用了 SPARQL 写入和 LDP 读取

**解决方案**：
- 使用 Fragment Mode（推荐）
- 或者统一使用 LDP 操作

### 3. subjectTemplate 中的变量不生效

**正确用法**：
```typescript
// 使用 {id} 引用主键
subjectTemplate: '{id}.ttl#this'

// 使用其他字段（如 threadId）
subjectTemplate: '{threadId}.ttl#{id}'
```

**注意**：变量必须是 schema 中定义的字段名。

### 4. TypeIndex 注册失败

**检查**：
- 确保 `typeIndex: 'private'` 或 `'public'` 已设置
- 确保 `autoRegister: true`（默认）
- 确保用户有权限写入 TypeIndex

## 最佳实践

### 1. 优先使用 Fragment Mode

```typescript
// 推荐：所有数据在一个文件
const table = podTable('items', { ... }, {
  base: '/data/items.ttl',
  subjectTemplate: '#{id}',
  sparqlEndpoint: '/data/items.ttl/-/sparql',
});
```

### 2. 需要文件隔离时使用 Document Mode + SPARQL 端点

```typescript
// 每条记录独立文件，但通过 SPARQL 端点聚合查询
const table = podTable('items', { ... }, {
  base: '/data/items/',
  subjectTemplate: '{id}.ttl#this',
  sparqlEndpoint: '/data/items/-/sparql',
});
```

### 3. 关联数据存储在同一文件

```typescript
// Thread 和 Message 在同一文件，便于原子操作
const ChatThread = podTable('ChatThread', { ... }, {
  base: '/chat/',
  subjectTemplate: '{id}.ttl#this',
});

const ChatMessage = podTable('ChatMessage', { ... }, {
  base: '/chat/',
  subjectTemplate: '{threadId}.ttl#{id}',
});
```

### 4. 使用 namespace 统一管理自定义谓词

```typescript
import { UDFS_NAMESPACE } from '@/vocab';

const table = podTable('items', {
  status: string('status'),  // 映射到 udfs:status
}, {
  namespace: UDFS_NAMESPACE,
});
```

## 参考资料

- drizzle-solid README: `node_modules/@undefineds.co/drizzle-solid/README.md`
- 项目 vocab 定义: `src/vocab/`
- 现有 schema 示例: `src/api/chatkit/schema.ts`, `src/credential/schema/tables.ts`

## 问题反馈

如果发现 drizzle-solid 设计不合理或存在 bug，通过 git MCP 向 drizzle-solid 仓库提 issue：

```
仓库: undefinedsco/drizzle-solid
```

提 issue 时请包含：
1. 问题描述
2. 复现步骤
3. 期望行为 vs 实际行为
4. 相关代码片段
