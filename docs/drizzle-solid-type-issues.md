# drizzle-solid 类型问题整理

版本：drizzle-solid@0.2.0

---

## 1. PodTable 列直接访问的类型丢失

**问题**：运行时 `Object.assign(this, columns)` 把列挂到 table 对象上，但类型定义没有体现

```typescript
// 运行时可用（文档示例也是这样用的）
userTable.name
userTable.age

// TypeScript 报错，必须用
userTable.columns.name
userTable.columns.age
```

**当前类型定义**：
```typescript
export declare class PodTable<TColumns> {
  columns: TColumns;
  // ... 其他属性
}
```

**建议修改为**：
```typescript
export type PodTable<TColumns> = PodTableClass<TColumns> & TColumns;

// 或者使用交叉类型
export declare class PodTable<TColumns> extends ... {
  columns: TColumns;
}
// 并在 podTable 函数返回类型中使用 Proxy 类型
```

**影响**：所有 where 条件都需要写 `.columns.xxx`，与文档示例不一致

---

## 2. eq() 函数对 primaryKey 列类型不兼容

**问题**：带 `primaryKey()` 修饰的列类型与 `eq()` 函数参数类型不匹配

```typescript
const userTable = podTable('user', {
  id: string('id').primaryKey(),  // PodStringColumn<true, false>
  name: string('name'),           // PodStringColumn<false, false>
});

// ✅ 普通列正常
eq(userTable.columns.name, 'Alice')

// ❌ primaryKey 列报错
// Argument of type 'PodStringColumn<true, false>' is not assignable to
// parameter of type 'PodColumnBase<ColumnBuilderDataType, false, false, null>'
eq(userTable.columns.id, 'some-id')

// 当前需要 as any 绕过
eq(userTable.columns.id as any, 'some-id')
```

**原因**：`eq()` 函数签名中泛型约束过于严格，不接受 `notNull=true` 的列

**建议**：放宽 `eq()` 等条件函数的类型约束，接受任意 `PodColumnBase` 变体

---

## 3. 建议：提供 createSession 工具函数

虽然 `drizzle()` 需要完整 `SolidAuthSession` 是正确设计，但在某些场景（如 server-side、sidecar）只有 authenticatedFetch，需要手动构造 session 对象。

**当前用法**：
```typescript
const session = {
  info: { isLoggedIn: true },
  fetch: authenticatedFetch,
};
const db = drizzle(session);
```

**建议提供**：
```typescript
import { createSession } from 'drizzle-solid';

const session = createSession(authenticatedFetch);
// 或
const session = createSession({ fetch: authenticatedFetch, webId: '...' });
const db = drizzle(session);
```

---

## 临时解决方案

在修复前，可以用以下方式绕过：

```typescript
// 1. 列访问：使用 .columns
eq(table.columns.field, value)

// 2. primaryKey 列：使用 as any
eq(table.columns.id as any, value)

// 3. session 构造：手动构造
const session = { info: { isLoggedIn: true }, fetch };
```
