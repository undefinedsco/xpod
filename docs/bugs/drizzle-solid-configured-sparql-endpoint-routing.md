# drizzle-solid 未使用表级 SPARQL endpoint

## 状态

- 发现日期：2026-08-25
- 影响版本：`@undefineds.co/drizzle-solid` 0.3.18 至 0.3.21
- 影响产品：AI Connections 的 Provider、Credential 与 Model 配置读回
- 修复版本：`@undefineds.co/drizzle-solid` 0.3.24（configured endpoint 来自 `25e4a1f`；LDP document-source update 来自 `6b49416`）
- 处理原则：修复留在 drizzle-solid upstream；Xpod 直接使用正式版本，不保留 dependency patch，也不复制查询执行逻辑到产品层。

## 现象

AI Connections 首次保存 Provider API Key 时，Provider 与 Credential RDF 可以写入 Pod；同一页面随后刷新或再次更新时，读取已有配置失败。真实 Xpod 日志显示：

```text
POST /{pod}/settings/providers/openai.ttl -> 405 Method Not Allowed
```

浏览器最终只能显示通用的 AI Connection 读取失败，表现为“第一次能写，刷新后读不出来”。

## 预期行为

模型表已声明 SPARQL endpoint，例如：

```text
Provider / Model: /settings/providers/-/sparql
Credential:       /settings/-/sparql
```

当表存在 `sparqlEndpoint` 时，SELECT 应把解析后的 endpoint 传给查询引擎；RDF 文件 URL 只用于物理存储和目标 graph，不应被当作 SPARQL Protocol endpoint。

普通 `.ttl` URL 不是 SPARQL Protocol endpoint，但仍可以作为 RDF document source：Solid client 先认证 GET 文档，Comunica 再对 RDF 文档源做本地查询。Xpod 不在产品层手写 Turtle parser。

## 实际行为与根因

`ExecutionStrategyFactoryImpl` 会因为 `table.getSparqlEndpoint()` 存在而选择 `SparqlStrategy`，但 `SparqlStrategy.executeSelect` 随后仍把 `PodDialect.resolveTableUrls()` 返回的物理 `resourceUrl` 交给 `executeQueryWithSource`。

因此，Xpod 注入的 SPARQL Protocol query engine 会对 `openai.ttl` 发 `POST application/sparql-query`，CSS 按 LDP 资源规则返回 405。配置的 `/settings/providers/-/sparql` 从未进入这次查询。

## 最小复现

1. 使用带 `sparqlEndpoint` 的 `aiProviderResource` 初始化 drizzle-solid 数据库。
2. 插入 `openai` Provider；确认 RDF 资源创建成功。
3. 新建数据库实例并执行 `select().from(aiProviderResource).execute()`。
4. 观察请求目标为 `settings/providers/openai.ttl`，而不是 `settings/providers/-/sparql`。

## 验收标准

1. `SparqlStrategy` 对相对和绝对 endpoint 都使用规范化后的 endpoint 作为查询 source。（`tests/drizzle-solid/sparql-strategy-endpoint.test.ts`）
2. 物理 resource URL 仍只用于 target graph / LDP 写入，不改变现有 RDF 文件布局。
3. 覆盖同源 Pod、相对 endpoint、绝对 endpoint 的回归测试。
4. Xpod 升级依赖后，真实 Web 流程满足：保存 API Key → 刷新页面 → 配置仍可读 → 更新配置成功。
