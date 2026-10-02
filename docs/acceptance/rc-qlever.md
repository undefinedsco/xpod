# RC PostgreSQL / QLever 接入与验收

状态：设计与产物兼容性核对中，尚未部署或通过真实 RC 验收。

## 部署边界

RC 使用 PostgreSQL facts 与数据库侧 QLever 原生扩展，通过既有
`PostgresRdfEngine` / `QleverSparqlEngine` 接口接入。身份、内部 KV、配额仍在
PostgreSQL，非 RDF 内容继续使用 RC 专用 R2 bucket。不迁移到 SQLite。

原生扩展由私有 `undefinedsco/xpod-pro` 提供，公开 Xpod 只负责配置、adapter 与
协议验收。扩展安装在数据库镜像中，遵守 [镜像边界](../docker-image-boundaries.md)。
RC 显式使用 QLever 配置入口；通用 Cloud 配置的独立运行能力不应依赖私有产物。
最终配置入口及数据库 digest 在兼容性验收后填入本记录。

每次候选发布按现有 RC 隔离契约创建本轮数据库与测试账号；该契约并不构成生产
数据库迁移方案。同轮 CSS 重启后，账号、凭据和 Pod 数据仍必须可用。重新部署
之前先保留旧实例的只读诊断与测试证据。

## 接入要求

1. 固定可部署 PostgreSQL 17 / QLever 镜像的不可变 digest，记录真实私有源码
   commit、构建与验收来源。历史文档里的 digest 仅是查找起点。
2. 显式启用 `nativeSparqlEnabled` 并将查询引擎接到 `QleverSparqlEngine`。
   启动验证 `xpod_rdf.native_sparql_capabilities()` 的 ABI 与 ready 状态；
   运行时调用真实 `native_sparql_query`，原生能力缺失或失败时明确报错。
3. RDF、FTS、VEC 保持同一 PostgreSQL authority。验证当前 nested request
   envelope、权限范围、dataset、取消与超时行为，不能用类名或镜像标签代替验证。
4. candidate workflow 必须在执行公共验收前确认数据库原生能力与实际运行
   imageID，并将服务与数据库两份 digest 绑定到同一验收记录。

## 分层验收

| 层级 | 必须提供的证据 |
| --- | --- |
| 配置与产物 | manifest、服务/数据库 digest、actual imageID、原生 ABI/ready、无查询回退 |
| 原生数据能力 | 当前 semantic 与 search conformance；RDF 更新、FTS/VEC 融合、移动/删除与权限过滤 |
| 真实公共 RC | 当前 Gateway 上的真实账号、DPoP、Pod CRUD、SPARQL UPDATE、ACL/ACP 隔离 |
| Matrix | 固定 60 backlog / 63 总事件、两 runtime、limit 7 分页完整同步；真实请求耗时与失败记录 |
| 重启恢复 | 同轮 CSS 重启后旧凭据、WebID/ACL 与业务数据可读写，记录 restartCount 与恢复结果 |
| 目录客户端 | 版本条件提交、冲突与删除；已发布客户端在 macOS NFS 和 Linux FUSE 的真实挂载验收 |

本机完整集成测试是提交门禁，不能替代真实 RC。源码或配置变更后重新运行相关
测试、类型检查与完整集成测试，再发布新的 exact-commit RC 并收集上述证据。

## 切换前失败现场

2026-10-02 对 PostgreSQL / Comunica RC 的真实公共测试：

- 起始验收产物：`0.4.21-rc.223`，源码
  `d938792f3e2a6035f81429ab19dbab1d18f6c775`。
- Matrix 积压写入完成 28 / 60 后，四个并发请求返回 HTTP 500；后段成功请求
  已达到约 55–58 秒。未完成固定 63 事件验收。
- CSS 子进程从 PID 25 / restartCount 0 变为 PID 4096 / restartCount 1，
  lastExitCode 1；API 子进程未变。随后同一测试凭据请求返回 401。
- 使用同一 client ID / secret 重新 discovery 并交换新 access token，也返回
  HTTP 401 / `invalid_client`。因此不能仅以旧 access token 到期解释后续 401；
  账号与凭据持久化仍需单独诊断。
- 证据保存在本 worktree ignored 目录
  `.test-data/agent-directory-workers/matrix-real-baseline-b5238f24/`。
  账号私密文件不入库、不输出。

这些结果证明现有真实路径未通过，并未证明单一故障根因。已有 logger ICU 热点
修复通过本机测试；其效果以及 QLever 接入效果需要分别用新 RC 实测。
