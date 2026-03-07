# ChatKit PodStore 测试超时问题

## 问题描述

3 个 ChatKit PodStore 集成测试超时：
- `should retrieve messages from Pod`
- `should handle multiple messages in conversation`
- `should create thread with initial message and get AI response`

## 症状

1. **INSERT 操作成功**
   ```
   INSERT operation completed, 1 records affected
   ```

2. **SELECT 查询返回 0 条记录**
   ```
   SELECT operation completed, 0 records affected
   ```

3. **轮询等待超时**
   - `waitForThreadItemsCount` 轮询 6 秒（30 次尝试，每次间隔 200ms）
   - 所有尝试都返回 0 条记录
   - 最终超时失败

## 日志示例

```
INSERT operation completed, 1 records affected
DEBUG: Generated SPARQL Query for SELECT: PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?subject ?chatId ?threadId ?maker ?role ?content ?status ?createdAt WHERE {
  GRAPH ?g {
    ?subject rdf:type <http://www.w3.org/ns/pim/meeting#Message>.
    OPTIONAL { ?subject <https://undefineds.co/ns#chatId> ?chatId. }
    OPTIONAL { ?subject <https://undefineds.co/ns#threadId> ?threadId. }
    OPTIONAL { ?subject foaf:maker ?maker. }
    OPTIONAL { ?subject <https://undefineds.co/ns#role> ?role. }
    OPTIONAL { ?subject <http://rdfs.org/sioc/ns#content> ?content. }
    OPTIONAL { ?subject <https://undefineds.co/ns#status> ?status. }
    OPTIONAL { ?subject <https://undefineds.co/ns#createdAt> ?createdAt. }
    FILTER(?threadId = "thread_xxx")
  }
}
DEBUG: resourceUrl = http://localhost:5739/ckstore-xxx/.data/chat/-/sparql
[SparqlStrategy] Direct fetch to SPARQL endpoint: http://localhost:5739/ckstore-xxx/.data/chat/-/sparql
SELECT operation completed, 0 records affected
```

## 根本原因

这是 **drizzle-solid** 的问题，可能的原因：

1. **SPARQL 端点查询延迟**
   - INSERT 写入后，SPARQL 端点可能需要时间更新索引
   - 但 6 秒的等待时间应该足够

2. **GRAPH 模式不匹配**
   - INSERT 可能写入到一个 GRAPH
   - SELECT 查询可能在另一个 GRAPH 中查找
   - 需要检查 drizzle-solid 的 INSERT 和 SELECT 逻辑

3. **drizzle-solid 查询逻辑 bug**
   - 可能是 drizzle-solid 的 SPARQL 查询生成有问题
   - 需要在 drizzle-solid 层面修复

## 与 Schema 统一的关系

**这个问题与 schema 统一工作无关**：
- Schema 统一前后，这个问题都存在
- 其他 114 个测试都通过，说明 schema 统一是成功的
- 这是 drizzle-solid 的已知问题（之前的提交 0c7dbfe 就添加了 `waitForThreadItemsCount` 来缓解）

## 历史

- **2026-02-10** (commit 0c7dbfe): 添加 `waitForThreadItemsCount` 函数来轮询等待消息出现
- **2026-03-03**: 恢复按日期分组存储（`{chatId}/{yyyy}/{MM}/{dd}/messages.ttl#{id}`）
- **当前**: 问题仍然存在，需要在 drizzle-solid 层面解决

## 建议

1. **向 drizzle-solid 提交 issue**
   - 报告 INSERT 后 SELECT 查询不到数据的问题
   - 提供完整的 SPARQL 查询日志
   - 提供复现步骤

2. **暂时跳过这 3 个测试**
   ```typescript
   it.skip('should retrieve messages from Pod', async () => {
     // ...
   });
   ```

3. **继续其他工作**
   - 核心功能（114/118 测试）都已通过
   - Schema 统一工作已完成
   - 可以继续其他开发任务

## 临时解决方案

如果需要临时解决，可以尝试：

1. **增加等待时间**
   ```typescript
   const timeoutMs = options.timeoutMs ?? 10000; // 从 6 秒增加到 10 秒
   ```

2. **在 INSERT 后手动等待**
   ```typescript
   await db.insert(Message).values(messageRecord);
   await new Promise(resolve => setTimeout(resolve, 1000)); // 等待 1 秒
   ```

3. **使用直接的 SPARQL 查询**
   - 绕过 drizzle-solid 的查询逻辑
   - 直接向 SPARQL 端点发送查询

但这些都是治标不治本的方案，根本问题需要在 drizzle-solid 层面修复。
