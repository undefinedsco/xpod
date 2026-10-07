# macOS Bun 的向量扩展启动缺口

2026-10-05，Root 实际 macOS ARM64 Bun1.3.8 探针经公开 SqliteVectorStore API，在健康向量写入前遇到 `This build of sqlite3 does not support dynamic extension loading`。失败发生在锁断言之前，不能计作锁缺陷。没有安装依赖、修改系统配置或启动用户 Gateway。

证据在 `.test-data/solid-multiparty-acceptance/provider-b/root-review/`：

- `local-vector-public-admission-root-baseline.json`：默认 Bun 实际退出1，4输入不变。
- `local-vector-public-admission-root-node-baseline.json`：显式 Node23.6 的真实 sqlite-vec 写入、768维回读和搜索成功，随后旧实现的操作锁断言失败。
- `local-vector-public-admission-root-custom-bun-baseline.json`：显式 Root preload 已安装的 Homebrew SQLite3.53.4，同一 Bun 真正完成向量正例，随后旧操作锁断言失败。

后两项是独立诊断，不是默认产品启动通过。夹具的 Homebrew 绝对路径不能进入产品；Node 对照不能成为静默运行时回退。Vector admission 修复另行验收，不消除此缺口。

## 已确认边界

只读源码复核确认以下事实：

1. `src/storage/sqlite/factory.ts` 在 Bun 默认选 bun-sqlite；`src/storage/sqlite/backends/BunSqliteRuntime.ts` 直接构造 Database，没有 setCustomSQLite。
2. LocalPhysicalOperationService 构造依赖的 SqliteAuthorityExclusionGate 已打开协调库；身份库也经共享 runtime 打开 SQLite。VectorStore 的延迟 ensureOpen 不是可靠的进程首次初始化点。不据此断言所有 DI 实例间唯一的首开顺序。
3. Local ready 不证明 vec0 可用。普通 RdfVectorIndex 使用普通 SQLite 表和 SQL 聚合，不加载 sqlite-vec；Cloud 主 RDF 向量索引使用 PostgreSQL，也不能推出整个 Cloud 没有 SQLite。
4. 正式 macOS 原生包、npm JS 路径及 Bun 父进程的 CSS/API 子服务均优先 Bun。已检查的集成脚本没有显式选择 Node SQLite backend；普通 RDF/fake-QLever 用例不验证真实 vec0 扩展。
5. 现有 macOS QLever runtime 构建使用 dylibbundler 收集 lib/、移除 Homebrew 链接并签名；manifest 记录全部 lib/ SHA，平台包提取整个 archive，npm 与桌面已有 runtime 定位。但构建没有明确要求包含动态 libsqlite3，当前 checkout 也无可检查的候选 payload，不能声称已交付可加载库。
6. `scripts/bundle-sqlite-libs.js` 使用主机固定路径，未找到主发布调用；根包 files 和 Bun single 文件筛选也未接通它。不要另建平行资产路径。

## 修复与验收要求

在共享 `createBunSqliteRuntime()` 中、首次 Database 构造前执行一次进程级 SQLite 初始化。库路径须来自已有、已验收的原生 artifact 定位与 manifest，覆盖单例、独立 runtime 及每个 Bun 子进程。先复用既有 SQLite 构建输入和分发；不得硬编码本机路径、静默切换 Node、掩盖加载失败或未经授权新增依赖。

实际验收须证明候选动态库存在、扩展能力及 Bun ABI 适配，并在正式 npm/桌面冷启动后完成 RDF/FTS/VEC conformance。测试 preload 不能代替交付验证。当前 Vector 切片不承担此 runtime 修复；由同一授权开发负责人后续实现，Root 独立验收。

Bun 官方说明 macOS Apple SQLite 禁止加载扩展，setCustomSQLite 须早于 Database 构造：[SQLite 文档](https://bun.com/docs/runtime/sqlite)、[loadExtension](https://bun.com/reference/bun/sqlite/Database/loadExtension)、[setCustomSQLite](https://bun.com/reference/bun/sqlite/Database/setCustomSQLite)。本 issue 不宣称跨文档事务或断电持久化已验证。

## 资产选择与进程初始化的独立复现

Root 随后经公开 `createSqliteRuntime('bun-sqlite')`，在三个独立冷 Bun 进程中运行私有夹具。证据为 `root-review/macos-bun-sqlite-root-prerequisite-20261005-first/safe-result.json`，6个输入哈希前后不变，整体实际退出1：

- 源码模式的同名非发布布局 command：普通磁盘库和 `:memory:` 均写入并回读41，实际退出0。这是必须保留的合法普通 SQLite 用途，不是向量能力证明。
- 明确选择 `qlever/bin/xpod_qlever_local_runtime` 发布布局，但没有 manifest：当前实现仍创建业务数据库并回读41，没有拒绝，契约检查实际退出1。
- 先在源码模式打开普通数据库，再在同一进程改选上述发布布局：当前实现仍创建第二个业务库，没有报告初始化冲突，契约检查实际退出1。

后两项是刻意不完整的负例资产夹具；没有执行 fake native command，也没有证明任何真实发布包可用。现有源码忽略资产选择，因此只能把它们用于确定修复边界。

最小契约应区分“没有选定发布资产的源码普通 SQLite”和“已经选定的发布资产缺失或损坏”。前者可以保留普通 SQLite；后者须在首个数据库构造前明确失败。环境变量有值或 command 仅同名不足以识别发布资产，因为既有 fake-QLever 夹具也使用同名命令。npm/桌面一旦选择平台 payload，就不得因文件丢失把它降格为源码模式。

初始化状态须由共享 Bun factory 在进程内冻结，覆盖独立 factory 与单例；后续更改选择不得静默切库。SQLite 文件身份、摘要及所需角色应复用现有 artifact manifest，避免第二份清单。此处记录设计与真实失败证据，尚未实现产品修复；正式候选库、npm/桌面及 Bun 子进程的 RDF/FTS/VEC 冷启动验收仍待完成。

## 当前共享初始化实现与未完成的候选证明

共享 Bun factory 在 macOS 上于首个 Database 构造前验证选定原生 manifest 的 ABI、唯一 `sqlite-runtime` 角色、相对路径与真实 symlink containment、大小及 SHA；初始化结果在进程内冻结。独立 factory、单例和已取得 runtime 的后续 open 共用该状态。没有选定发布资产的源码普通 SQLite 仍合法，不赋予 vec0 能力。Node/Linux 不新增 macOS 自定义库要求。

现有 macOS native build 显式携带构建输入的 SQLite dylib，经原 dylibbundler/签名路径和 verifier 检查 ARM64、可迁移依赖、SQLite ABI，并在冷 Bun 中验 FTS/768维 vec0。角色仍在原 artifacts 文件记录中。平台包在提取后的同一 payload 上验共享 factory；consumer smoke 保留 Node 对照并追加 Bun 冷进程，无主机库 preload。

2026-10-05 实际候选构建前置检查退出64：`dylibbundler is required`。当前没有已构建候选 manifest/payload；没有安装宿主工具或制造替代资产。因此真正发布库加载、npm/桌面父子服务 RDF/FTS/VEC 冷启动仍待交付环境证据，不能关闭本 issue 或据源码负例通过宣布 runtime 发布可用。
