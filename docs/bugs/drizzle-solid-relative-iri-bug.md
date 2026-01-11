# drizzle-solid 相对 IRI 解析 Bug

## 问题描述

drizzle-solid 在 SELECT 查询返回数据后，解析 `id` 字段时返回了相对 IRI（如 `google-gemini-test`），而不是完整的 URI。这导致后续使用该 ID 进行查询时，SPARQL 解析器报错。

## 错误信息

```
Error: Cannot resolve relative IRI google-gemini-test because no base IRI was set.
    at resolveIRI (/Users/ganlu/develop/xpod/node_modules/sparqljs/lib/SparqlParser.js:869:13)
    at Object.anonymous (/Users/ganlu/develop/xpod/node_modules/sparqljs/lib/SparqlParser.js:613:35)
    at Parser.parse (/Users/ganlu/develop/xpod/node_modules/sparqljs/lib/SparqlParser.js:778:36)
    ...
```

## 复现步骤

1. 使用 drizzle-solid 插入一条 ModelProvider 记录：
```typescript
await db.insert(modelProviderTable).values({
  id: 'google-gemini-test',
  enabled: true,
  apiKey: 'xxx',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  proxy: 'http://127.0.0.1:7890',
  models: ['gemini-pro'],
  updatedAt: new Date()
});
```

2. 查询启用的 providers：
```typescript
const providers = await db.select()
  .from(modelProviderTable)
  .where(eq(modelProviderTable.enabled, true));
```

3. 查询成功返回数据，但后续处理时报错

## 根本原因

SPARQL 查询返回的数据中，`linx:provider` 的值是字面量 `"google-gemini-test"`，而不是完整的 URI。drizzle-solid 在将这个值映射回 `id` 字段时，没有正确处理，导致后续使用时被当作相对 IRI。

## Pod 中的实际数据

```sparql
# SPARQL 查询结果显示：
{
  "s": { "type": "uri", "value": "http://localhost:3000/test/.data/model-providers/google-gemini-test.ttl" },
  "p": { "type": "uri", "value": "https://linx.ai/ns#provider" },
  "o": { "type": "literal", "value": "google-gemini-test" }  # <-- 这是字面量，不是 URI
}
```

## 影响

- `InternalPodService.getAiConfig()` 无法正确返回 Pod 中的 AI Provider 配置
- 导致 Chat API 无法使用 Pod 中配置的 AI 服务

## 临时解决方案

绕过 Pod 配置，使用环境变量配置 AI Provider。

## 发现日期

2026-01-05
