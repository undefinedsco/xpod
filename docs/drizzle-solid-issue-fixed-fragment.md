# Drizzle-Solid Issue: Fixed Fragment in subjectTemplate

## 状态：✅ 已修复 (drizzle-solid@0.2.8)

**修复版本**: drizzle-solid@0.2.8
**修复日期**: 2026-01-25

升级到 0.2.8 后，固定 fragment 的 id 提取问题已修复。现在使用 `{id}/index.ttl#this` 模式时，查询返回的 `id` 是正确的路径 id（如 `chat-123`），而不是 fragment 部分（`this`）。

---

## 问题概述（已修复）

当 `subjectTemplate` 包含固定的 fragment（如 `'{id}/index.ttl#this'`）时，查询返回的记录的 `id` 字段值为 fragment 部分（`'this'`），而不是从路径中提取的实际 id 值（如 `'chat-123'`）。

**影响版本**: drizzle-solid@0.2.x (< 0.2.8)

---

## 验证场景

### Schema 定义

```typescript
import { podTable, string, datetime, uri } from '@undefineds.co/drizzle-solid';

export const Chat = podTable(
  'Chat',
  {
    id: string('id').primaryKey(),
    title: string('title'),
    author: uri('author'),
    status: string('status'),
    createdAt: datetime('createdAt'),
    updatedAt: datetime('updatedAt'),
  },
  {
    base: '/.data/chat/',
    type: 'http://www.w3.org/ns/pim/meeting#LongChat',
    namespace: 'https://undefineds.co/ns#',
    subjectTemplate: '{id}/index.ttl#this',  // 固定 fragment #this
    sparqlEndpoint: '/.data/chat/-/sparql',
  },
);
```

### 写入和查询

```typescript
const db = drizzle(session, { schema: { chat: Chat } });
await db.init([Chat]);

await db.insert(Chat).values({
  id: 'chat-123',
  title: 'Test Chat',
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const chat = await db.query.chat.findFirst({
  where: eq(Chat.id, 'chat-123'),
});

console.log(chat.id);
// ✅ 0.2.8+: 输出 "chat-123"
// ❌ 0.2.7-: 输出 "this"
```

---

## 升级指南

```bash
yarn add @undefineds.co/drizzle-solid@0.2.8
```

升级后无需修改代码，原有的 schema 定义可以正常工作。

---

## 验证测试

`tests/integration/chatkit-pod-store.integration.test.ts` 中使用固定 fragment 模式的测试已全部通过：

- Chat schema 使用 `{id}/index.ttl#this`
- Thread schema 使用 `{chatId}/index.ttl#{id}`
- 所有 11 个测试通过

---

## Solid 规范支持

现在可以正常使用 Solid 规范中的常见模式：

| 模式 | 说明 | 状态 |
|------|------|------|
| `{id}/index.ttl#this` | 资源本身 | ✅ 支持 |
| `{id}/card#me` | 个人资料 | ✅ 支持 |
| `{id}/profile#card` | 个人卡片 | ✅ 支持 |

---

## 相关文档

- `docs/drizzle-solid-issue-multiple-records.md` - 多记录查询问题（已修复）
- `docs/drizzle-solid-type-issues.md` - 类型问题

---

**报告日期**: 2026-01-18
**修复确认日期**: 2026-01-25
