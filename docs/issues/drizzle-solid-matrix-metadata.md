# drizzle-solid inline metadata 在同文档多主体之间发生 URI 碰撞

状态：2026-09-23 真实 Xpod 集成验收发现；使用 ORM 已支持的显式 inline `@id` 可隔离新写入。尚未向外部仓库发布 issue。

## 场景与复现

依赖：`@undefineds.co/drizzle-solid@0.3.24`，应用 Xpod 现有 tracked patch。

使用 models `messageResource`，连续插入两条不同 id、同一天同一个 `messages.ttl` 的消息，两条消息分别携带不同的对象 metadata，例如各自的 `protocols.matrix.eventId`。读取实际 Pod Turtle：两条消息的 `metadata` 谓词都指向该文件的 `#metadata-1`，其协议信息累积在同一个资源上。重新读回时出现混合事件 metadata。

本次证据文件：`.test-data/xpod-test-stack/5e8afeeb-9fd6-40a5-93ef-68eca0786b54/data/test-integration-mucvdsa2/.data/chat/matrix-b7a63648691ee96a/2026/09/22/messages.ttl`。证据中多个不同消息主体均引用同一 `messages.ttl#metadata-1`。

## 根因与影响

安装包 `dist/core/triple/builder.js` 的 `TripleBuilderImpl.resolveInlineChildUri` 丢弃父主体的 fragment，仅使用 document URL 加 `#${columnName}-${index + 1}`。不同消息、Run 或同一 index.ttl 中的 Chat/Thread 因而共享子主体。后续修改某个对象还可能删除其他主体引用的共享 metadata。

这不是 Matrix 事件排序问题；内存对象 mock 无法复现 RDF 子主体合并。

## 已支持的应对方式

`resolveInlineChildUri` 优先返回对象的显式 `@id`，其次才使用 `id`；`InlineObjectHandler.buildChildTriples` 忽略这两个标识字段，不把它们当作业务属性写入。可给 metadata 提供基于其所属完整资源 IRI 的唯一绝对 `@id`，例如 `messages.ttl#message-a/metadata`。须在每次写入与更新时统一覆盖该标识，不能继承其他主体的 metadata `@id`。

该方式仍走 drizzle-solid，不使用原生 SPARQL，不修改共享 schema，也不手改 node_modules。需要覆盖 Message、Run、Chat、Thread 以及 RunStep payload 等实际对象字段。旧的已碰撞数据不能仅通过新写入自动修复；验收使用新房间，现有受影响数据应单独评估恢复来源。

## 验收要求

1. 同文件两个 Message 的 metadata 子主体不同，重新读取保留各自 eventId/content。
2. 同文件两个 Run 的 metadata 不混合；更新一个 Run 不改变另一个。
3. 同 index.ttl 的 Chat/Thread metadata 分离。
4. 验证真实 RDF 序列化和读回，不能仅用内存数据库 mock。
5. 上游应默认以完整父主体生成 inline 子主体，并提供相应回归测试；Xpod 临时显式 `@id` 可在修复版本验收后统一移除。

## 当前验证证据

`tests/drizzle-solid/inline-metadata-subject-isolation.test.ts` 使用安装包真实 TripleBuilder 生成 RDF、N3 解析、Comunica 执行 hydrator 生成的 SELECT、安装包 SelectQueryBuilder 读回。Message、Run、Chat、Thread 四组同文档双主体测试均通过（2026-09-23）。该测试证明显式 `@id` 的支持及读回隔离；端到端产品验收仍由真实 Gateway 样例验证。
