# Local QLever / Embedding Parity 实施计划（归档）

状态：实施完成后归档；不得按本文重新执行。

当前状态、部署矩阵和未完成生产项见：
[RDF Search / QLever 当前状态](../../rdf-search-release-status.md)。

## 已交付边界

- Public Local：`QleverSparqlEngine -> LocalQleverNativeSparqlClient ->`
  静态 QLever runtime -> SQLite physical backend。
- Public Cloud：`RdfQuerySparqlEngine` 以 Comunica 计算 SPARQL algebra，
  通过 scoped RDFJS source 读取 `PostgresRdfEngine`；不要求私有 PG QLever。
- Private Cloud：`xpod-pro` 可通过 `cloud.enterprise.json` 显式替换为
  `QleverSparqlEngine`，并调用同一 PostgreSQL facts authority 上的 native ABI。
- Search：FTS 与可选 VEC 使用 `sourceKey + retrievalPointKey`；模型和 credential
  必须来自 Pod 的明确配置，没有隐式默认 embedding model。
- Reader：负责把非文本资源转换为一等文本表示；索引层直接消费 retrieval points。

## 已验收证据

- Public Local / public Cloud installed-image gate：SQLite 与普通 PostgreSQL 各完成
  14/14 semantic cases，canonical digest 相同。
- Embedding / reconciliation focused suite：81/81。
- SQLite / PostgreSQL text-vector parity：128/128。
- Private PG boundary suite：163 passed，2 个需要 live DSN 的可选测试 skipped。
- Local runtime、private PG artifact 和完整 digest 见
  [public/private acceptance record](2026-08-13-qlever-local-cloud-public-private-acceptance.md)。

## 被否决或替代的历史方案

本文旧版本中的下列任务描述已经被最终边界替代：

- “Local 与 Cloud 都必须使用 QLever”；
- “`PostgresRdfEngine.sparqlQuery` 永远启用，并在私有 extension 缺失时阻止公开
  Cloud 启动”；
- “产品中不得存在 Comunica”；
- 为 Local 暴露 `.so`、provider path、backend selector 或 per-request fallback；
- 为缺少 embedding 配置的 Pod 注入平台默认模型；
- 在用户工作站执行 QLever/CMake/Docker native build；
- 按历史任务逐个提交中间 commit。

最终实现只保留单一模式内的 query authority，不保留请求级 fallback：Local 是
QLever；公开 Cloud 是 Comunica + scoped PostgreSQL facts；私有 Cloud 只有在部署层
显式加载 enterprise overlay 时才是 PG QLever。

旧版 800 余行的逐任务命令、旧工作树路径和 RED/GREEN checkpoint 已从工作树删除，
需要考古时使用 Git 历史，不再让过期步骤与当前实现同时出现在维护文档中。
