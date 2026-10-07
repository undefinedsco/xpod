# AgentFS Pod backend 原型与选型验收

状态：2026-10-01，继续开发；原型验证不表示已锁定生产挂载依赖。用户指定 opencode-go/deepseek-v4.1-flash worker 实现与测试，主负责人负责设计和验收。

开发工作区与分支沿用 `/Users/ganlu/develop/.worktrees/xpod-virtual-folder-design` / `codex/virtual-folder-design`。保留所有既有设计和实现改动，不提交、推送或修改其他 checkout。

## 目标

实现一个能够实际挂载的 AgentFS Pod HTTP lower backend，使普通文件操作经现有 Xpod HTTP 认证/授权访问 Pod；验证它是否比其他挂载底座减少自研工作。HTTP 搜索和 rg wrapper 已是独立底座，它们通过不等于本任务完成。

## 实现边界

- 首先核对并固定 AgentFS upstream commit、Rust FileSystem/File trait 及 CLI FUSE/NFS 可复用库入口。上游源码/构建夹具置于 `.test-data/agent-directory-workers/agentfs-upstream/`，不得混入服务运行镜像。
- 原型 helper 归 `tools/agentfs-pod/`，客户端会话/认证桥与启动入口归 `src/cli/agent-fs/`。复用既有 CLI 认证权威入口，不在 Rust 再实现一套用户凭据存储。
- 上游 AgentFS 的引入属于用户明确要求的对接对象；允许为原型声明其固定版本及编译所必需的依赖，不向 Xpod 根 package.json/bun.lock 增加无关依赖。不下载或运行来历不明二进制。
- 后端统一 Pod HTTP。inode/URI、目录名编码、元数据和 range/seek/read 映射由 adapter 负责；枚举目录不获取正文。禁止本机直读 CSS backing directory、全量导入 AgentFS DB 或把复制目录伪装按需挂载。
- lower 读取与 overlay delta 分开：首次修改的 copy-up、dirty/add/delete/whiteout、版本基线与条件 PUT/DELETE 必须明确。Pod 始终是最终文件权威；SQLite delta 只是客户端待写回状态。没有 ETag/可用版本时不得无条件覆盖。
- 同机无持久正文读缓存；远端只缓存实际访问的内容。编辑缓冲和 pending 修改不被淘汰。单个文件大读取必须控制内存，不只验证小文件。
- 写回通过现有 Pod 标准 HTTP 读写链；创建使用条件创建，覆盖/删除使用版本条件。服务端 RDF 验证和索引机制保持有效，不修改底层数据库。
- 挂载缓存必须支持远端其他客户端修改；AgentFS FUSE 无限 TTL 的单写入方假设不适用于 Pod。原型需证明确切的失效/重验证方案，不能用隐含 fork 保持无限缓存。
- 提供可执行的 mount/unmount/commit/status 原型入口，并给出挂载环境要求。不允许声称任意 Agent 已兼容；先验证当前平台原生命令，再连接已有 rg wrapper。

## 独立验证

1. 自定义 HTTP fixture 记录每个资源访问与传输字节：readdir/stat 不读取正文，读取一个文件不下载其余文件，seek/range 字节正确。
2. 在真实挂载点执行 ls/stat/cat/读取偏移、创建/修改/rename/delete 和编辑器临时文件替换；SDK 单元测试不能代替 OS 挂载。
3. HTTP 401/403、外部资源变化、断网、写回失败、412 冲突、重启 pending 恢复都有断言；不访问根外、异源或已撤权资源。
4. 搜索视图合并 dirty/add/delete；unsupported rg 参数只能回退到可用的实际挂载视图，不能对空占位目录返回假零命中。
5. 在同一机器同一数据集下测直接目录与挂载目录：元数据、冷/热读取、首次 copy-up 和确认远端保存；记录延迟与字节/磁盘占用，不预设性能比例。
6. 保留版本、构建命令、平台、实际挂载命令与退出码。若当前平台权限/内核驱动不可用，先完成 helper 编译和 HTTP backend 测试，并继续尝试已有安全平台路径；明确记录 OS 验收缺口，不能把模拟挂载表述为真实挂载。

## 职责分配

- 实现 worker：`tools/agentfs-pod/`、必要 CLI bridge/挂载入口、其实现测试。先读取 `.test-data/agent-directory-workers/review-notes.md`；记录开发进度于 `agentfs-implementation-report.md`。
- 独立测试 worker：只写 `tests/agentfs-pod/`、独立执行/基准脚本 `scripts/accept-agentfs-pod.*` 及自己的报告；不改产品、既有测试、设计或依赖。不与实现 worker 同时修改 Cargo/CLI。
- 主负责人：审查原型与证据，比较接入成本和需求覆盖。测试未完成或只证明搜索层时保持 AgentFS 目标未完成。
