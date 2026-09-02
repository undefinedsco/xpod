# Compound Query 性能优化报告

## 概述

本次优化实现了 SPARQL 多模式查询的数据库级 JOIN 优化，将原本需要在 JavaScript 层面进行的 hash join 操作下推到 SQLite 数据库层面执行，实现了 **100-300x** 的性能提升。

## 优化前后对比

### 测试场景
- 数据量：10,000 用户，每用户 2 个属性（name, age）
- 查询：SELECT 同时满足 name 和 age > 9970 的用户
- 预期结果：30 条记录

### 性能对比

| 方法 | 耗时 | 结果数 | 提升倍数 |
|------|------|--------|----------|
| **优化后 (SQL JOIN)** | 0.18ms | 30 | **223x** |
| 优化前 (JS hash join) | 40.62ms | 30 | 基准 |

### 多次运行稳定性

| 运行 | Compound Query | JS Hash Join | 提升倍数 |
|------|----------------|--------------|----------|
| Run 1 | 0.62ms | - | - |
| Run 2 | 0.18ms | 40.62ms | 223x |
| Run 3 | 0.25ms | 31.21ms | 124x |
| Run 4 | 0.22ms | 67.10ms | 305x |
| Run 5 | 0.76ms | - | - |

**平均提升：200x+**

## 技术实现

### 优化前：JavaScript Hash Join
```
1. 查询 pattern1: SELECT * WHERE predicate = 'name'     → 10,000 条
2. 查询 pattern2: SELECT * WHERE predicate = 'age' AND object > 9970  → 30 条
3. JavaScript 层 hash join on subject                   → 30 条
```

**问题**：
- 需要两次数据库往返
- 需要将 10,000 条记录加载到内存
- JavaScript 层面进行 hash 构建和 join

### 优化后：SQL JOIN
```sql
SELECT q0.subject as join_value, 
       q0.object as p0_age, 
       q1.object as p1_name 
FROM quints q0 
JOIN quints q1 ON q0.subject = q1.subject AND q0.graph = q1.graph 
WHERE q0.predicate = 'http://schema.org/age' 
  AND q0.object > 'N\x0050039.97...'
  AND q1.predicate = 'http://schema.org/name'
```

**优势**：
- 单次数据库往返
- 数据库索引优化
- 只返回最终结果（30 条）
- 无需内存中构建 hash 表

## SPARQL 查询集成

通过 Comunica 的 `joinBindings` 机制，SPARQL 多模式查询自动使用 compound query：

```sparql
PREFIX schema: <http://schema.org/>
SELECT ?s ?name ?age WHERE {
  ?s schema:name ?name .
  ?s schema:age ?age .
  FILTER(?age > 9970)
}
```

**执行日志**：
```
[QuintQuerySource] JOIN inputs: 2
[QuintQuerySource] Using compound query with 2 patterns, joined on ?s
[SqliteQuintStore] Compound SQL: SELECT q0.subject as join_value...
Average query time: 5.11ms (over 5 runs)
```

## 三表 JOIN 支持

同样支持三个或更多模式的 JOIN：

```sql
SELECT q0.subject as join_value,
       q0.object as p0_object,
       q1.object as p1_object,
       q2.object as p2_object
FROM quints q0 
JOIN quints q1 ON q0.subject = q1.subject AND q0.graph = q1.graph 
JOIN quints q2 ON q0.subject = q2.subject AND q0.graph = q2.graph 
WHERE q0.predicate = ? 
  AND q1.predicate = ? 
  AND q1.object > ? 
  AND q2.predicate = ?
```

**测试结果**：三表 JOIN 返回 11 条结果，性能同样优秀。

## Bug 修复

### 1. fpstring 编码 bug

**问题**：10 的幂次（10, 100, 1000, 10000）编码错误
- 原因：`while (mantissa > 10)` 应为 `while (mantissa >= 10)`
- 影响：`$gt: 9999` 不会返回 10000

**修复后测试**：
```
$gt 99 results: [100, 101, 999, 1000, 1001, 9999, 10000, 10001]
```

### 2. $in 操作符数字类型

**问题**：`$in: [10, 100, 1000, 10000]` 返回空结果
- 原因：精确匹配需要完整序列化（包含 datatype 和原始值）
- 修复：区分精确匹配和范围比较的序列化策略

**修复后测试**：
```
$in [10, 100, 1000, 10000] results: [10, 100, 1000, 10000]
```

## 总结

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 查询耗时 | 40-70ms | 0.2-0.8ms |
| 性能提升 | - | **100-300x** |
| 数据库往返 | 2次 | 1次 |
| 内存占用 | 高 (需加载全量) | 低 (只返回结果) |
| 三表 JOIN | 支持 | 支持 |
| SPARQL 集成 | - | 自动优化 |

## 文件变更

1. `src/storage/quint/SqliteQuintStore.ts`
   - 新增 `getCompound()` 方法
   - 新增 `buildConditionsForAlias()` 方法
   - 统一数字类型序列化处理

2. `src/storage/quint/serialization.ts`
   - 修复 fpstring 编码 bug

3. `src/storage/sparql/QuintQuerySource.ts`
   - 添加 `joinBindings: true` 支持
   - 实现 JOIN 操作转换为 compound query

4. `tests/storage/quint/compound-query.test.ts`
   - 新增 compound query 测试
   - 新增 xsd:integer 数字比较测试
   - 新增 $in 操作符测试
