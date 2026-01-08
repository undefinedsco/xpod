# SPARQL FILTER Pushdown 优化分析

## 问题描述

在 xpod 的 SPARQL endpoint (`/-/sparql`) 中，FILTER 条件没有被下推到存储层优化。

**症状**：
- 从 10000 条记录中用 `FILTER(?value > 9970)` 过滤出 29 条，耗时与查询全部 10000 条几乎相同（~2.5s）
- 期望 FILTER 查询应该利用索引，时间复杂度 O(log N)

## 架构分析

### 当前查询执行流程

```
SPARQL SELECT Query
     │
     ▼
┌────────────────────┐
│ SubgraphSparql     │
│ HttpHandler        │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ SubgraphQuery      │
│ Engine             │
└────────┬───────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ QuadstoreSparqlEngine                  │
│                                        │
│  queryBindings() ────────────────────► │ 直接使用 Comunica!
│                                        │ ❌ 完全绕过 OptimizedQuadstoreEngine
│  (OptimizedQuadstoreEngine 只用于      │
│   queryVoid 和 listGraphs)             │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────┐
│ Comunica           │
│ (QueryEngine)      │
│                    │
│ 使用 rdfjsSource:  │
│   store.match()    │
│                    │
│ ❌ 无法下推 FILTER  │
└────────────────────┘
         │
         ▼
┌────────────────────┐
│ Quadstore          │
│                    │
│ match() 只支持:    │
│ - subject          │
│ - predicate        │
│ - object           │
│ - graph            │
│                    │
│ ❌ 不支持范围查询   │
└────────────────────┘
```

### 关键代码位置

**1. SELECT 查询直接使用 Comunica（未使用优化引擎）**

文件：`src/storage/sparql/SubgraphQueryEngine.ts:52-55`

```typescript
public async queryBindings(query: string, basePath: string): Promise<any> {
  await this.ready;
  // 直接使用 Comunica QueryEngine，完全绕过 OptimizedQuadstoreEngine！
  return this.engine.queryBindings(query, this.createContext(basePath) as unknown as any);
}
```

**注意**：`OptimizedQuadstoreEngine` 已经实现了 LIMIT/ORDER BY 优化，但 `queryBindings` **没有使用它**！

**2. OptimizedQuadstoreEngine 只用于 UPDATE 和 listGraphs**

文件：`src/storage/sparql/SubgraphQueryEngine.ts:67-89`

```typescript
public async queryVoid(query: string, basePath: string): Promise<void> {
  await this.ready;
  await this.optimizedEngine.queryVoid(query, { baseIRI: basePath });  // ✓ 使用优化引擎
}

public async listGraphs(basePath: string): Promise<Set<string>> {
  // ...
  const stream = await this.optimizedEngine.queryBindings(query);  // ✓ 使用优化引擎
}
```

**3. Comunica 数据源配置**

文件：`src/storage/sparql/SubgraphQueryEngine.ts:110-134`

```typescript
private createContext(basePath: string): QueryContext {
  return {
    sources: [{
      type: 'rdfjsSource',
      value: {
        match: (subject, predicate, object, graph) => {
          // 只能做模式匹配，不能传递 FILTER 条件
          return this.store.match(subject, predicate, object, graph);
        },
      },
    }],
  };
}
```

## 根本原因

**核心问题**：`QuadstoreSparqlEngine.queryBindings()` 直接使用 Comunica，**完全绕过了已实现的 `OptimizedQuadstoreEngine`**。

1. **代码路径问题**
   - `OptimizedQuadstoreEngine` 已经实现了 LIMIT/ORDER BY 下推
   - 但 `queryBindings` 方法没有使用它，直接调用 Comunica
   - 只有 `queryVoid` 和 `listGraphs` 使用了优化引擎

2. **Comunica 的架构限制**
   - `rdfjsSource` 接口只支持 `match(s, p, o, g)` 模式匹配
   - FILTER 由 Comunica 的 actor 系统在内存中执行
   - 没有机制将 FILTER 条件传递给数据源

3. **Quadstore 的设计限制**
   - Quadstore 使用 6 个索引（SPOG, POG, OGS 等）优化四元组匹配
   - 不支持对 object 值的范围查询（如 `value > 9970`）

## 可能的解决方案

### 方案 1：让 queryBindings 使用 OptimizedQuadstoreEngine（简单修复）

修改 `QuadstoreSparqlEngine.queryBindings()` 使用 `OptimizedQuadstoreEngine`：

```typescript
public async queryBindings(query: string, basePath: string): Promise<any> {
  await this.ready;
  // 使用优化引擎，它会分析查询并决定是否使用优化路径
  return this.optimizedEngine.queryBindings(query, this.createContext(basePath));
}
```

**优点**：
- 简单修改，立即生效
- 对于简单 BGP 查询（无 FILTER），可以下推 LIMIT/ORDER BY
- 对于带 FILTER 的查询，仍然使用 Comunica（现有行为）

**缺点**：
- FILTER 仍然无法下推（需要方案 2）

### 方案 2：扩展 OptimizedQuadstoreEngine 支持简单 FILTER（中等难度）

对于简单的数值范围 FILTER（如 `?value > N`），在 `OptimizedQuadstoreEngine` 中：

1. 分析 FILTER 表达式，识别简单比较
2. 使用 better-sqlite3 的原生 SQL 范围查询
3. 对于复杂 FILTER，仍然委托 Comunica

```typescript
case 'filter':
  const filterInfo = this.analyzeFilter(current as Algebra.Filter);
  if (filterInfo?.canPushdown) {
    // 可下推的简单 FILTER
    params.rangeFilter = filterInfo;
    current = (current as Algebra.Filter).input;
  } else {
    // 复杂 FILTER，使用 Comunica
    return null;
  }
  break;
```

### 方案 3：使用 QuintStore + ComunicaQuintEngine

xpod 已经有一个五元组存储（QuintStore）和对应的 SPARQL 引擎（ComunicaQuintEngine）。

`extensions.local.json` 已经配置使用 `QuintstoreSparqlEngine`：

```json
{
  "@id": "urn:undefineds:xpod:QuintstoreSparqlEngine",
  "@type": "QuintstoreSparqlEngine",
  ...
}
```

**需要验证**：QuintStore 的 FILTER 支持范围是否包括数值比较。

## 建议优先级

1. **短期**（方案 1）：扩展 `OptimizedQuadstoreEngine` 支持简单数值 FILTER
2. **中期**（方案 2）：评估 QuintStore 的 FILTER 能力，考虑迁移
3. **长期**（方案 4）：设计混合存储架构

## 测试用例

```sparql
-- 应该能被优化的简单 FILTER
SELECT ?s ?v WHERE {
  ?s <http://schema.org/value> ?v .
  FILTER(?v > 9970)
}

-- 可能无法优化的复杂 FILTER
SELECT ?s ?v WHERE {
  ?s <http://schema.org/value> ?v .
  FILTER(?v > 9970 && REGEX(STR(?s), "item"))
}
```

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/storage/sparql/OptimizedQuadstoreEngine.ts` | 当前优化引擎 |
| `src/storage/sparql/SubgraphQueryEngine.ts` | SPARQL 引擎抽象 |
| `src/storage/sparql/ComunicaQuintEngine.ts` | QuintStore 的 Comunica 适配 |
| `src/http/SubgraphSparqlHttpHandler.ts` | SPARQL HTTP 端点 |

---

**分析日期**: 2025-12-30
**相关 Issue**: drizzle-solid SPARQL 性能测试
