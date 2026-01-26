# Drizzle-Solid Issue: SELECT 同资源文件多条记录只返回 1 条

## 状态：✅ 已修复 (drizzle-solid@0.2.8)

**修复版本**: drizzle-solid@0.2.8
**修复日期**: 2026-01-25

升级到 0.2.8 后，以下问题均已修复：
1. 同资源文件多条记录查询 - 现在可以正确返回所有记录
2. `{MM}` 大写时间变量 - 现在支持大写格式

---

## 问题概述（已修复）

当多条记录通过 `subjectTemplate` 被写入同一个 RDF 资源文件（使用 fragment 区分），SELECT 查询只返回 1 条记录，丢失其他记录。

**影响版本**: drizzle-solid@0.2.x (< 0.2.8)

---

## 复现场景

### 1. Schema 定义

```typescript
import { podTable, string, datetime, uri } from '@undefineds.co/drizzle-solid';

export const Message = podTable(
  'Message',
  {
    id: string('id').primaryKey(),
    chatId: string('chatId'),
    threadId: string('threadId'),
    role: string('role'),
    content: string('content'),
    createdAt: datetime('createdAt'),
  },
  {
    base: '/.data/chat/',
    type: 'http://www.w3.org/ns/pim/meeting#Message',
    namespace: 'https://undefineds.co/ns#',
    // 关键：多条消息可能落到同一个 messages.ttl 文件
    subjectTemplate: '{chatId}/{yyyy}/{MM}/{dd}/messages.ttl#{id}',
    sparqlEndpoint: '/.data/chat/-/sparql',
  },
);
```

### 2. 写入多条消息

```typescript
const db = drizzle(session, { schema: { message: Message } });
await db.init([Message]);

// 写入用户消息
await db.insert(Message).values({
  id: 'user-message_abc123',
  chatId: 'default',
  threadId: 'thread-001',
  role: 'user',
  content: 'Hello, what is the weather?',
  createdAt: '2026-01-25T10:00:00Z',
});

// 写入助手消息（同一天，同一个 messages.ttl 文件）
await db.insert(Message).values({
  id: 'assistant-message_def456',
  chatId: 'default',
  threadId: 'thread-001',
  role: 'assistant',
  content: 'The weather is sunny today.',
  createdAt: '2026-01-25T10:00:05Z',
});
```

### 3. 查询消息

```typescript
const messages = await db.select().from(Message).where(
  eq(Message.threadId, 'thread-001'),
);

console.log('Message count:', messages.length);
// ✅ 0.2.8+: 输出 2
// ❌ 0.2.7-: 输出 1

console.log('Message ids:', messages.map(m => m.id));
// ✅ 0.2.8+: ['user-message_abc123', 'assistant-message_def456']
// ❌ 0.2.7-: ['row-1'] 或只有一条
```

---

## 相关问题（已修复）

### subjectTemplate 时间变量大小写

**问题**: `{MM}` 大写月份变量在 0.2.7 及之前版本不被识别

**修复**: 0.2.8 现在支持 `{MM}`、`{DD}` 等大写时间变量

```typescript
// 现在可以正常使用大写
subjectTemplate: '{chatId}/{yyyy}/{MM}/{dd}/messages.ttl#{id}'
```

---

## 升级指南

```bash
yarn add @undefineds.co/drizzle-solid@0.2.8
```

升级后无需修改代码，原有的 schema 定义可以正常工作。

---

## 验证测试

`tests/integration/chatkit-pod-store.integration.test.ts` 中以下测试已恢复并通过：

```typescript
it('should retrieve messages from Pod', async () => { ... });  // ✅ 通过
it('should handle multiple messages in conversation', async () => { ... });  // ✅ 通过
it('should create thread with initial message and get AI response', async () => { ... });  // ✅ 通过
```

---

## 相关文档

- `docs/drizzle-solid-type-issues.md` - 类型问题
- `docs/drizzle-solid-issue-fixed-fragment.md` - 固定 fragment 问题

---

**报告日期**: 2026-01-25
**修复确认日期**: 2026-01-25
