# RDF P0/P1 功能与性能验收交接（归档）

状态：已被替代，不再作为当前验收或生产状态依据。

当前唯一状态入口：
[RDF Search / QLever 当前状态](../../rdf-search-release-status.md)。

## 归档范围

本文原来记录 2026-07-29 至 2026-08-12 期间的 RDF3X/QLever 实验、
生命周期问题、候选镜像、benchmark 和接续命令。任务已经经过多次边界修正：

- Local 最终采用公开的 SQLite-backed 静态 QLever runtime；
- 公开 Cloud 最终采用 `PostgresRdfEngine` + `RdfQuerySparqlEngine` / Comunica，
  不要求私有 QLever；
- 私有 `xpod-pro` 只提供显式部署的 PG QLever overlay；
- FTS 始终可用，VEC 只由 Pod 中显式 embedding model 启用；
- Reader 负责非文本资源的一等文本表示。

原文里的“当前”“尚未验收”“下一步”“工作树”和逐任务 commit 命令都已经过期。
为避免继续把历史接续状态当成当前事实，这些操作性细节不再保留在工作树中；需要追溯
时使用 Git 历史。

## 仍有效的历史证据

- 2026-08-12 的 PG17 native semantic candidate 在 SealOS 广州环境通过 14/14
  corpus、权限拒绝和事务回滚探针。
- 当时的 candidate、runtime SDK 和 canonical result digest 只证明该次候选验收，
  不等于后来的 artifact publication，也不等于生产部署。
- 当前 public/private source commit、artifact digest 和生产 workload 见
  [当前状态文档](../../rdf-search-release-status.md)。

## 相关记录

- [Public/Private acceptance evidence](2026-08-13-qlever-local-cloud-public-private-acceptance.md)
- [Local QLever / embedding 历史实施计划](2026-08-12-local-qlever-embedding-parity.md)
- private `xpod-pro/qlever/reports/2026-08-12-pg17-semantic-acceptance.md`
