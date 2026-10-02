# RC PostgreSQL / QLever 接入与验收

状态：接入实现与本机完整回归已通过，尚未部署或通过真实 QLever RC 验收。

## 部署边界

RC 使用 PostgreSQL facts 与数据库侧 QLever 原生扩展，通过既有
`PostgresRdfEngine` / `QleverSparqlEngine` 接口接入。身份、内部 KV、配额仍在
PostgreSQL，非 RDF 内容继续使用 RC 专用 R2 bucket。不迁移到 SQLite。

原生扩展由私有 `undefinedsco/xpod-pro` 提供，公开 Xpod 只负责配置、adapter 与
协议验收。扩展安装在数据库镜像中，遵守 [镜像边界](../docker-image-boundaries.md)。
RC 显式使用 QLever 配置入口；通用 Cloud 配置的独立运行能力不应依赖私有产物。
配置入口为 `config/cloud.qlever.json`。数据库 digest 的历史来源已核对，
本轮不可变镜像和真实 RC 的兼容性仍待后续门禁证明。

接入候选采用
`ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:de247beacf40af59a9e209e02cf257b0bdb33d9f47a7f77e4eb379635a2488ba`。
已核对 [原始 CNB 运行](https://cnb.cool/undefineds.co/native-builder/-/build/logs/cnb-ouo-1k1kcsrgm)
及不可变 receipt
`enterprise-rc-acceptance@sha256:18581a288eb93e361b9cb0a3c46d94a7552ec096c7ed7561aa9a83399107a6f9`。
该历史运行的私有源码为 `c5665e33a80507798a39a4290b97013a9904cfeb`，
与私有 main `3de06d6acce80f13d8767f278b1fef6569059b58` 的 tree 相同；
部署前后各 17 项语义检查通过，镜像请求值与实际 imageID 相符。
这证明候选的来源，不代表它与本轮 Xpod 已通过兼容性和真实 RC 验收。

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

## 本机提交门禁

2026-10-02 最终冻结实现经独立复审，修复了已有 GHCR 配置读取/解析异常被
空 catch 吞掉的问题。损坏配置与读取失败均非零退出，只输出固定安全错误，
并清理临时认证目录；正常配置保留指定认证并以 0600 写入。
候选 workflow 29 项回归、源码与测试类型检查、依赖状态检查均退出 0。
真实 ComponentsManager 配置解析核对了 QLever 引擎引用与其余 PG 参数，
该检查未启动完整 profile 或数据库，不能当作配置启动验收。

最终完整集成 `bun run test:integration` 的进程实际退出 0：

- Lite：32 文件通过、4 文件跳过；162 测试通过、16 测试跳过。
- Full：6 文件、61 测试全部通过。
- 运行：`root-final-20261002T124203Z-66520`，UTC `12:42:03` 至 `12:47:52`，
  348400 ms。测试前后源码快照一致。
- 原始日志 SHA256：
  `a79cad9568a2afe5c5e4f8735e7b276f2dccb8dd7c7b52c884527316cef9b4d1`。
- 受保护的本机证据：
  `.test-data/agent-directory-workers/root-rc-qlever-final/`。

当前实现包含部署前的精确镜像/原生语义门禁、namespace 私有镜像拉取门禁、
同一 PG 中独立临时数据库验收、服务与 PG 的 UID/imageID 不变检查及清理校验。
这些门禁的真实运行结果仍待新候选提供；上述本机成功不代表 public16、private17、
真实 Cloud、Gateway 或目录客户端已在新后端通过。

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
- [只读 RC 诊断](https://github.com/undefinedsco/xpod/actions/runs/36992315119)
  核对运行中的服务 imageID 与原接受 digest 一致。PostgreSQL StatefulSet 创建于
  `00:44:57Z`，当前 Pod 却在 `08:40:48Z` 创建、容器 `08:40:49Z` 启动，
  restartCount 为 0；数据卷为 EmptyDir，Pod 替换会丢失该卷。
  同一 owned client ID 与 WebID 的 SHA256 定位查询返回 credentialRows 0、
  ownedWebIdLinks 0。accountRows 是以 credential 为起点的关联计数，不能用其
  0 值独立断言账号被删除。Pod 替换原因仍未证实，现象不能归因于认证缓存。
- namespace 中实际存在 `tcr-creds`（dockerconfigjson）。新候选须在修改运行
  secret 或删除旧实例之前，用它预拉取上面的精确 PostgreSQL digest，并核对
  PostgreSQL 版本和扩展文件；凭据名称存在不等于镜像拉取已通过。
  真实性能验收同时记录数据库 Pod UID 与服务/数据库 imageID；采样期间数据库
  被替换或数据丢失的运行作为失败现场保留，不作为有效的性能对比。
- 证据保存在本 worktree ignored 目录
  `.test-data/agent-directory-workers/matrix-real-baseline-b5238f24/`。
  账号私密文件不入库、不输出。

这些结果证明现有真实路径未通过，并未证明单一故障根因。已有 logger ICU 热点
修复通过本机测试；其效果以及 QLever 接入效果需要分别用新 RC 实测。
