# drizzle-solid SPARQL 查询生成 Bug

## 问题描述

在执行 SELECT 查询时，生成的 SPARQL 查询中出现了错误的 FILTER 条件，包含未序列化的 JavaScript 对象 `[object Object]`。

## 错误的 SPARQL 输出

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX dc: <http://purl.org/dc/terms/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?subject ?id ?enabled ?apiKey ?baseUrl ?models ?updatedAt WHERE {
  GRAPH ?g {
    ?subject rdf:type <https://linx.ai/ns#ModelProvider>.
    ?subject <https://linx.ai/ns#provider> ?id;
      dc:modified ?updatedAt.
    OPTIONAL { ?subject <https://linx.ai/ns#status> ?enabled. }
    OPTIONAL { ?subject <https://linx.ai/ns#apiKey> ?apiKey. }
    OPTIONAL { ?subject <https://linx.ai/ns#baseUrl> ?baseUrl. }
    OPTIONAL { ?subject <https://linx.ai/ns#aiModels> ?models. }
    FILTER(((?decoder = "[object Object]") && (?shouldInlineParams = "false"^^xsd:boolean)) && (?queryChunks IN("[object Object]", "[object Object]", "[object Object]", "true"^^xsd:boolean, "[object Object]")))
  }
}
```

## 问题点

1. FILTER 中出现了不应该存在的变量：`?decoder`, `?shouldInlineParams`, `?queryChunks`
2. 这些变量的值是 `[object Object]` —— 说明某个 JS 对象被直接 `.toString()` 而不是正确序列化
3. 这个 FILTER 导致查询无法匹配任何结果，最终导致 500 错误

## 复现方式

```bash
yarn vitest tests/integration/ChatMockFlow.test.ts --run
```

## 相关信息

- **测试文件**: `tests/integration/ChatMockFlow.test.ts`
- **涉及的 table**: `modelProviders`
- **操作**: 调用 `podService.getAiProviders()` → 触发 SPARQL SELECT
- **发现日期**: 2026-01-03
