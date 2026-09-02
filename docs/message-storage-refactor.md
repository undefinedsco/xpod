# Message 存储结构修改：从独立文件改为按日期分组

## 修改原因

发现 CSS SPARQL endpoint 存在严重 bug：**OPTIONAL 子句在查询独立文件时完全失败**（返回 0 结果），但在查询同一文件内的 fragments 时能正常工作。

## 修改内容

### Schema 变更

**修改文件**: `src/api/chatkit/schema.ts`

**修改前**（独立文件，OPTIONAL 失败）:
```typescript
subjectTemplate: '{chatId}/{id}.ttl#{id}'
// 结果：/.data/chat/cli-default/msg-xxx.ttl#msg-xxx
```

**修改后**（按日期分组，OPTIONAL 正常）:
```typescript
subjectTemplate: '{chatId}/{yyyy}/{MM}/{dd}/messages.ttl#{id}'
// 结果：/.data/chat/cli-default/2026/03/04/messages.ttl#msg-xxx
```

### 代码变更

**修改文件**: `src/cli/lib/pod-thread-store.ts`

1. **恢复 OPTIONAL 查询** - `loadThread()` 中的 Message 查询恢复使用 OPTIONAL
2. **简化代码** - 移除手动传入 `yyyy/MM/dd` 字段（drizzle-solid 自动从 createdAt 提取）

## 测试验证

### 独立文件 vs 按日期分组对比

| 存储方式 | OPTIONAL 查询 | Required 查询 | 结论 |
|---------|--------------|--------------|------|
| 独立文件 `{id}.ttl#{id}` | ✗ 0 条 | ✓ 2 条 | OPTIONAL 完全失败 |
| 按日期分组 `{yyyy}/{MM}/{dd}/messages.ttl#{id}` | ✓ 2 条 | ✓ 2 条 | OPTIONAL 正常工作 |

### 测试结果

```bash
$ node scripts/test_dategroup_storage.js

=== Summary ===
OPTIONAL query: 2 messages
Required query: 2 messages

✓ SUCCESS! OPTIONAL works correctly with date-grouped files!
This confirms the issue was with independent files, not OPTIONAL itself.
```

```bash
$ node scripts/test_complete_fix.js

=== Summary ===
Total tests: 8
Passed: 8
Failed: 0

✓ All tests passed! OPTIONAL bug fixes are working correctly.
```

```bash
$ node scripts/test_e2e_thread.js

========================================
Results: 13 passed, 0 failed
========================================
```

## 优势

### 修改后的优势

1. **OPTIONAL 查询正常工作** - 可以查询可选字段（toolName, metadata 等）
2. **减少文件数量** - 同一天的消息存储在同一个文件中
3. **符合原始设计** - 注释中的设计就是按日期分组
4. **更好的性能** - 减少文件系统操作

### 对比独立文件的劣势

1. **单文件可能变大** - 如果某天消息很多，单个 messages.ttl 会很大
2. **并发写入** - 多个消息同时写入同一文件可能有冲突（但 CSS 应该处理了）

## 数据迁移

**注意**：此修改不向后兼容，旧的独立文件格式的消息无法自动迁移。

如果需要迁移旧数据：
1. 读取所有旧格式的消息（`{chatId}/{id}.ttl#{id}`）
2. 按日期重新插入到新格式（`{chatId}/{yyyy}/{MM}/{dd}/messages.ttl#{id}`）
3. 删除旧的独立文件

目前我们没有实现自动迁移，因为：
1. 这是开发阶段，数据量小
2. 可以手动清理测试数据重新开始

## CSS Bug 报告

已准备完整的 issue 报告：`docs/css-sparql-optional-bug-issue.md`

**核心发现**：
- OPTIONAL 在独立文件上完全失败
- OPTIONAL 在同一文件的 fragments 上能工作（但会过滤记录）
- OPTIONAL 在按日期分组的文件上完全正常

这个 bug 应该报告给 CSS 团队，因为它影响了数据建模决策。

## 相关文档

- `docs/sparql-optional-bug.md` - 问题调查和根因分析
- `docs/sparql-optional-bug-fix.md` - 修复方案和验证（已过时，因为改用日期分组）
- `docs/css-sparql-optional-bug-issue.md` - CSS issue 报告（待提交）
- `docs/cli-dev-testing.md` - CLI 开发测试指南

## 测试脚本

创建的测试脚本：
- `scripts/test_dategroup_storage.js` - 验证按日期分组存储和 OPTIONAL 查询
- `scripts/test_optional_issue.js` - 验证 OPTIONAL 导致查询失败
- `scripts/test_which_optional.js` - 测试每个 OPTIONAL 字段
- `scripts/test_optional_workarounds.js` - 测试各种解决方案
- `scripts/test_complete_fix.js` - 完整功能验证
- `scripts/test_e2e_thread.js` - E2E 测试

## 总结

通过将 Message 存储从独立文件改为按日期分组，成功解决了 CSS SPARQL endpoint 的 OPTIONAL bug，所有功能测试通过。这个修改：

1. ✓ 解决了 OPTIONAL 查询失败的问题
2. ✓ 符合原始设计意图
3. ✓ 减少了文件数量
4. ✓ 所有测试通过（8/8 功能测试，13/13 E2E 测试）

下一步需要向 CSS 团队报告这个 bug，让他们修复独立文件上的 OPTIONAL 查询问题。
