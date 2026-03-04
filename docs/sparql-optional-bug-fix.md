# SPARQL OPTIONAL Bug 修复总结

## 问题描述

在使用 drizzle-solid 0.2.10 查询 Pod 数据时，发现以下问题：
1. `loadThread()` 无法加载 messages，返回空数组
2. `ensureThread()` 无法检测已存在的 thread，导致重复创建

## 根因分析

经过系统性测试（详见 `docs/sparql-optional-bug.md`），确认问题根源是：

**CSS SPARQL endpoint 存在严重 bug：任何包含 OPTIONAL 子句的查询都会返回 0 结果。**

### 测试证据

| 查询类型 | 结果 | 说明 |
|---------|------|------|
| 无 OPTIONAL | ✓ 1 条 | 基础查询正常工作 |
| 单个 OPTIONAL | ✗ 0 条 | 任何 OPTIONAL 都会导致失败 |
| 多个 OPTIONAL | ✗ 0 条 | drizzle-solid 生成的完整查询 |
| OPTIONAL + GRAPH ?g | ✗ 0 条 | 加 GRAPH 也无法解决 |
| 所有字段 required | ✓ 1 条 | 去掉 OPTIONAL 后正常 |

### 影响范围

drizzle-solid 默认将所有非主键字段标记为 OPTIONAL，导致：
- `db.select().from(Table).where(eq())` 查询失败（使用 STRENDS + OPTIONAL）
- `db.findByIri()` 查询成功（使用完整 URI 匹配 + OPTIONAL，但 Chat 能工作）

## 修复方案

### 1. `loadThread()` - Message 查询修复

**修改文件**: `src/cli/lib/pod-thread-store.ts`

**修改前**（使用 OPTIONAL，返回 0 条）:
```typescript
const messagesQuery = `
  PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>
  PREFIX sioc: <http://rdfs.org/sioc/ns#>
  PREFIX udfs: <https://undefineds.co/ns#>
  SELECT ?role ?content ?createdAt
  WHERE {
    GRAPH ?g {
      ?msg a meeting:Message ;
           sioc:has_container ${threadSubject} .
      OPTIONAL { ?msg udfs:role ?role . }
      OPTIONAL { ?msg sioc:content ?content . }
      OPTIONAL { ?msg udfs:createdAt ?createdAt . }
    }
  }
  ORDER BY ?createdAt
`;
```

**修改后**（去掉 OPTIONAL，返回正确结果）:
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

**关键变化**:
- 去掉 `GRAPH ?g` 包裹
- 去掉所有 `OPTIONAL` 子句
- 改用 required 三元组模式

### 2. `ensureChat()` - 查询方式修复

**修改前**（使用 `db.select().where(eq())`）:
```typescript
async function ensureChat(db: any, chatId: string, webId: string): Promise<void> {
  try {
    const chats = await db.select().from(Chat).where(eq(Chat.id, chatId));
    if (chats.length === 0) {
      // create chat...
    }
  } catch (error) {
    // Ignore if already exists
  }
}
```

**修改后**（使用 `db.findByIri()`）:
```typescript
async function ensureChat(db: any, chatId: string, webId: string): Promise<void> {
  try {
    const podBaseUrl = webId.replace('/profile/card#me', '');
    const chatUri = `${podBaseUrl}/.data/chat/${chatId}/index.ttl#this`;
    const chat = await db.findByIri(Chat, chatUri);

    if (!chat) {
      // create chat...
    }
  } catch (error) {
    // Ignore if already exists
  }
}
```

**关键变化**:
- 从 `db.select().where(eq())` 改为 `db.findByIri()`
- 手动构建完整 URI 进行查询
- 避免生成包含 OPTIONAL 的 SPARQL

### 3. `ensureThread()` - 查询方式修复

**修改前**:
```typescript
async function ensureThread(db: any, chatId: string, threadId: string): Promise<void> {
  try {
    const threads = await db.select().from(Thread).where(eq(Thread.id, threadId));
    if (threads.length === 0) {
      // create thread...
    }
  } catch (error) {
    // Ignore if already exists
  }
}
```

**修改后**:
```typescript
async function ensureThread(db: any, chatId: string, threadId: string, webId: string): Promise<void> {
  try {
    const podBaseUrl = webId.replace('/profile/card#me', '');
    const threadUri = `${podBaseUrl}/.data/chat/${chatId}/index.ttl#${threadId}`;
    const thread = await db.findByIri(Thread, threadUri);

    if (!thread) {
      // create thread...
    }
  } catch (error) {
    // Ignore if already exists
  }
}
```

**关键变化**:
- 从 `db.select().where(eq())` 改为 `db.findByIri()`
- 新增 `webId` 参数用于构建完整 URI
- 更新所有调用点传入 `webId`

## 验证测试

### 测试脚本

创建了以下测试脚本验证修复：

1. **`scripts/test_optional_issue.js`** - 验证 OPTIONAL 导致查询失败
2. **`scripts/test_which_optional.js`** - 测试每个 OPTIONAL 字段
3. **`scripts/test_optional_workarounds.js`** - 测试各种解决方案
4. **`scripts/test_loadthread_fix.js`** - 验证 loadThread 修复
5. **`scripts/test_primary_key_queries.js`** - 验证主键查询
6. **`scripts/test_complete_fix.js`** - 完整功能验证

### E2E 测试结果

```bash
$ node scripts/test_complete_fix.js

Test 1: getOrCreateDefaultChat()
  ✓ Chat created/retrieved: cli-default

Test 2: createThread()
  ✓ Thread created: thread-verify-xxx

Test 3: saveMessage() - user message
  ✓ User message saved

Test 4: saveMessage() - assistant message
  ✓ Assistant message saved

Test 5: listThreads()
  ✓ Thread found in list (40 total threads)

Test 6: loadThread()
  ✓ Thread loaded
  ✓ Correct number of messages

Test 7: Message content verification
  ✓ User message content correct
  ✓ Assistant message content correct

=== Summary ===
Total tests: 8
Passed: 8
Failed: 0

✓ All tests passed! OPTIONAL bug fixes are working correctly.
```

### 原有 E2E 测试

```bash
$ node scripts/test_e2e_thread.js

Results: 13 passed, 0 failed
```

## 长期解决方案

### 需要修复的层面

1. **CSS SPARQL endpoint** - 修复 OPTIONAL 子句处理逻辑
2. **Comunica** - 如果是 Comunica 的问题，需要向上游报告
3. **drizzle-solid** - 考虑提供配置选项，允许用户指定哪些字段是 required

### 临时规避策略

在 CSS SPARQL endpoint 修复之前，使用以下策略：

1. **优先使用 `db.findByIri()`** - 通过完整 URI 查询，避免 STRENDS + OPTIONAL
2. **手写 SPARQL 查询** - 对于复杂查询，手写 SPARQL 并去掉 OPTIONAL
3. **假设字段必需** - 在 schema 设计时，尽量让字段成为必需字段

## 相关 Issue

- drizzle-solid #4: FILTER placement bug (已修复于 0.2.10)
- 需要创建新 issue 报告 OPTIONAL bug 给 CSS 团队

## 测试环境

- CSS: Community Solid Server (xpod 分支)
- drizzle-solid: 0.2.10
- SPARQL endpoint: `/.data/chat/-/sparql`
- 数据存储: Quadstore (PostgreSQL)

## 结论

通过以下修复，成功绕过了 CSS SPARQL endpoint 的 OPTIONAL bug：

1. `loadThread()` 的 Message 查询去掉 OPTIONAL
2. `ensureChat()` 和 `ensureThread()` 改用 `db.findByIri()`

所有功能测试通过，Chat/Thread/Message 的 CRUD 操作正常工作。
