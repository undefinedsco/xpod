# Matrix 多文档消息查询的 inline metadata hydration 开销

状态：2026-09-23 真实集成验收观察到重复查询开销；已完成安装依赖代码调查，未在本次任务修改 ORM。

## 代码证据

安装的 `@undefineds.co/drizzle-solid@0.3.24`：

- `dist/core/execution/strategy-factory.js` 按 `table.getSparqlEndpoint()` 选择 SPARQL 或 LDP。models 的 Message 已配置 `/.data/-/sparql`，主体集合查询有服务端入口。
- `dist/core/query-builders/select-query-builder.js` 的 `execute()` 总是调用 `hydrateInlineColumns()`，然后才应用字段投影。
- `hydrateInlineColumns()` 将父主体按 RDF 文档分组，每组调用 `executeQueryWithSource(sparql, sourceUrl)`，没有传表的 endpoint 或显式 SPARQL source type。
- `dist/core/sparql-executor.js` 对该默认 `auto` source 使用 Comunica；显式 `sparql` source 才使用服务端直接查询。

因此即使主体过滤已经在服务端完成，metadata 仍可能产生逐文档读取和解析；重复 listEvents 会重复承担这部分工作。实际成本取决于文档数量、缓存、运行时和网络；本次没有得到可泛化的精确延迟保证或独立基准。

## 支持的 API 与限制

安装版 SelectQueryBuilder 和 db.query.findMany 没有 per-query access hints、source/scope 或禁用 inline hydration 的公开选项。`alias(resource, name).setSparqlEndpoint(absoluteEndpoint)` 是支持的配置方式，Xpod AI connection adapter 已使用，但不能改变上述 hydration 的文档来源选择。

不能用日期过滤消除历史扫描：晚到的原生消息可能带旧时间戳。也不能默认只读取 Matrix 房间自己的目录：其他客户端可能在其他路径写入关联同一 thread 的消息。前者会丢增量，后者会破坏跨客户端互通。

## 当前缓解与后续验收

Matrix Store 当前通过单次操作内复用已读取事件、事务重试按确定资源 id 精确查找，减少不必要的重复集合扫描。该缓解不宣称消除逐文档 hydration。

后续上游优化应允许 inline hydration 复用已配置的授权 SPARQL endpoint，批量查询父主体，同时保留普通 Solid/LDP 后端兼容。需要真实 RDF 回读、不同文档和相同文档多个 metadata 子主体、授权边界、迟到原生事件等回归，以及独立测量的请求数/耗时基准。不要在产品适配器增加 raw SPARQL 或低层执行器替换来掩盖此缺口。
