# SPARQL OPTIONAL Bug Investigation

## 问题描述

在使用 drizzle-solid 0.2.10 查询 Message 数据时，`db.select().from(Message).where(eq(Message.threadId, threadUri))` 返回 0 条记录，但数据确实存在于 Pod 中。

## 根因分析

经过系统性测试，发现问题不在 drizzle-solid 的查询生成逻辑，而在于 **CSS SPARQL endpoint 对 OPTIONAL 子句的处理存在 bug**。

### 测试结果

| 查询类型 | 结果 | 说明 |
|---------|------|------|
| 无 OPTIONAL | ✓ 1 条 | 基础查询正常工作 |
| 单个 OPTIONAL | ✗ 0 条 | 任何 OPTIONAL 都会导致失败 |
| 多个 OPTIONAL | ✗ 0 条 | drizzle-solid 生成的完整查询 |
| OPTIONAL + GRAPH ?g | ✗ 0 条 | 加 GRAPH 也无法解决 |
| FILTER 位置调整 | ✗ 0 条 | FILTER 位置不影响结果 |
| 所有字段 required | ✓ 1 条 | 去掉 OPTIONAL 后正常 |

### 测试脚本

详见以下脚本：
- `scripts/test_optional_issue.js` - 验证 OPTIONAL 导致查询失败
- `scripts/test_which_optional.js` - 测试每个 OPTIONAL 字段
- `scripts/test_optional_workarounds.js` - 测试各种解决方案
- `scripts/compare_exact_sparql.js` - 对比 drizzle-solid 和手动 SPARQL

### 失败的 SPARQL（drizzle-solid 生成）

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?subject ?chatId ?threadId ?maker ?role ?content ?status ?createdAt WHERE {
  ?subject rdf:type <http://www.w3.org/ns/pim/meeting#Message>.
  ?subject <http://rdfs.org/sioc/ns#has_container> ?threadId.
  OPTIONAL { ?subject <https://undefineds.co/ns#chatId> ?chatId. }
  OPTIONAL { ?subject foaf:maker ?maker. }
  OPTIONAL { ?subject <https://undefineds.co/ns#role> ?role. }
  OPTIONAL { ?subject <http://rdfs.org/sioc/ns#content> ?content. }
  OPTIONAL { ?subject <https://undefineds.co/ns#status> ?status. }
  OPTIONAL { ?subject <https://undefineds.co/ns#createdAt> ?createdAt. }
  FILTER(?threadId = <http://localhost:5739/test/.data/chat/cli-default/index.ttl#thread-xxx>)
}
```

**结果**: 0 条记录

### 成功的 SPARQL（手动编写）

```sparql
PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>
PREFIX sioc: <http://rdfs.org/sioc/ns#>
PREFIX udfs: <https://undefineds.co/ns#>
SELECT ?role ?content ?createdAt WHERE {
  ?msg a meeting:Message ;
       sioc:has_container <http://localhost:5739/test/.data/chat/cli-default/index.ttl#thread-xxx> ;
       udfs:role ?role ;
       sioc:content ?content ;
       udfs:createdAt ?createdAt .
}
```

**结果**: 1 条记录

## 解决方案

### 临时方案（已实施）

在 `src/cli/lib/pod-thread-store.ts` 的 `loadThread()` 中，使用手写 SPARQL 查询，去掉所有 OPTIONAL 子句：

```typescript
const messagesQuery = `
  PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>
  PREFIX sioc: <http://rdfs.org/sioc/ns#>
  PREFIX udfs: <https://undefineds.co/ns#>
  SELECT ?role ?content ?createdAt
  WHERE {
    ?msg a meeting:Message ;
         sioc:has_container ${threadSubject} ;
         udfs:role ?role ;
         sioc:content ?content ;
         udfs:createdAt ?createdAt .
  }
  ORDER BY ?createdAt
`;
```

### 长期方案

需要在以下层面修复：

1. **CSS SPARQL endpoint**: 修复 OPTIONAL 子句处理逻辑
2. **Comunica**: 如果是 Comunica 的问题，需要向上游报告
3. **drizzle-solid**: 考虑提供配置选项，允许用户指定哪些字段是 required

## 影响范围

- 所有使用 OPTIONAL 的 SPARQL 查询都会受影响
- drizzle-solid 默认将所有非主键字段标记为 OPTIONAL
- 这会导致大部分 drizzle-solid 查询在 CSS 上失败

## 相关 Issue

- drizzle-solid #4: FILTER placement bug (已修复于 0.2.10)
- 需要创建新 issue 报告 OPTIONAL bug

## 测试环境

- CSS: Community Solid Server (xpod 分支)
- drizzle-solid: 0.2.10
- SPARQL endpoint: `/.data/chat/-/sparql`
- 数据存储: Quadstore (PostgreSQL)

## 验证步骤

1. 构建项目: `yarn build:ts`
2. 运行测试: `node scripts/test_loadthread_fix.js`
3. 预期结果: Thread 加载成功，包含 2 条 messages

## 结论

这是一个 **CSS SPARQL endpoint 的严重 bug**，而不是 drizzle-solid 的问题。drizzle-solid 生成的 SPARQL 语法完全正确，但 CSS 无法正确处理 OPTIONAL 子句。

临时解决方案是在应用层绕过 OPTIONAL，直接使用 required 三元组模式。长期需要修复 CSS 的 SPARQL 实现。
