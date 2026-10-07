# 公共 alias 遇到关联资源循环时栈溢出

状态：2026-10-03 实际隔离 ACP Pod 复现；安装版本 drizzle-solid 0.3.24。

`alias(messageResource, 'document_messages')` 用于按精确文档创建只读查询资源。
Message 的 chat/thread 列包含 `options.linkTable`，指向 models 的关联资源。
这些资源的 column.table 又指回资源，因此关联图含循环。

`clonePodColumn` 对整个 options 调用未处理循环的 `deepClone`，最终抛出
`RangeError: Maximum call stack size exceeded`，查询尚未执行。
实际证据为 `exact-document-orm-diagnostic-ca28e49c-f327-4923-b025-ebf118b5e5c1/result.json`。

期望：alias 创建独立列对象，普通选项仍复制；linkTable 是关联 schema 身份，保留原引用，
既不递归复制整个关联图，也不改变原资源列的 table。直接用原资源的 `$schema.table`
会重绑定共享列，不作为临时绕过。

修复在既有、版本对齐的 Bun 依赖补丁中同时覆盖 CJS/ESM，保持关联资源身份。
新增真实 models 的 alias 回归，并重跑实际文档分页探针；不手改已安装依赖或复制 schema。
补丁不代表持久对账、游标及 G01–G12 已验收。
