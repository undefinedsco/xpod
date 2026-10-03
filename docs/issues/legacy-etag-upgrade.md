# 旧资源 storage revision 的惰性升级

## 问题与边界

升级前的资源可能只有修改时间，没有持久化的随机 storage revision。修改时间不能保证每次写入唯一，因此不得把时间戳包装成强 ETag，也不得让 Run / Session 条件写在缺少强 ETag 时降级为无条件 PUT。

这是 CSS 存储操作 metadata 的升级，不是 Pod 业务 schema 迁移。初始化仅写 `HH.etag` 对应的 server-owned revision；不改变业务 RDF、修改时间、其他 metadata、容器成员或索引内容。

## 实现

`HierarchyLockingResourceStore` 在锁内 GET / HEAD 读取 metadata 时启用惰性升级检测。`SolidRdfDataAccessor` 检测到没有有效 revision，只发出内部升级信号。所有祖先及资源读锁完全释放后，locking store 使用普通 mutation 相同的 root-first 分布式写锁执行初始化，再重新读取表示。

初始化取得写锁后重新读取实际 metadata：并发写入若已生成 revision，则跳过；资源已被删除则保留 404；持久化失败则请求失败，不能返回未持久化的 ETag。成功后使用正常 representation 读取路径重新取得 body 与 metadata，因此二者仍受同一读锁保护。

Local-first RDF 的 HTTP 表示继续读取真实文件字节和文件 content type，但其 revision 必须使用同锁内读取的 structured metadata authority。旧文件 sidecar 中的 revision 不能覆盖当前 revision；尚未建立 structured metadata 的本地文件保持可读，但不提供条件写版本。真实 HTTP 验收发现只修复存储初始化还不够：原先 `getLocalRdfDocument` 直接返回文件 metadata，导致 revision 已持久化而响应缺少 ETag，因此同步修复这一输出路径。

直接 accessor / startup / permission metadata 读取不触发迁移。已有写锁内的条件 PUT / PATCH 预检关闭升级检测，避免读写锁重入；不合法的旧条件值仍然失败。普通写入继续由现有统一 `stampStorageVersion` 生成新 revision。

## 回归覆盖

`tests/storage/LegacyStorageVersion.test.ts` 使用真实 SQLite RDF engine、CSS `DataAccessorBasedStore` 和共享 read/write locker 验证：

- 旧 metadata 与业务 RDF 原样保留，持久化 revision 可重复读取；新条件写成功，旧 ETag 重放失败。
- 并发首次读取只初始化一次，不持读锁升级。
- 读锁释放后先完成的 writer revision 不会被初始化覆盖。
- revision 持久化失败不返回伪版本，后续读取可以恢复。
- 直接 metadata 读取无副作用，写锁内条件校验不升级重入。
- 不存在的资源仍返回 404，不能因升级而创建。
- 真实 `FileDataAccessor → MixDataAccessor → SparqlUpdateResourceStore → HierarchyLockingResourceStore` 路径首次读取返回已升级 revision 与原文件字节，后续条件写推进 revision，旧版本重放失败。
- 未索引文件不能把 sidecar 中的旧 revision 冒充为 structured storage authority。

完整旧 Run / Session 经 HTTP 的 Stop / 续跑验收仍由桌面集成验收覆盖。

## 实际重启控制组发现的恢复写回问题

2026-10-02 的真实 Gateway 控制组在**未删除 revision**时也复现：重启在首次 Run / Session HTTP 读取前更新了两个文档的 revision 和 modified。原因是 startup recovery 向 `syncLocalRdfDocument` 传入正在读取的 authority 文件流，该方法又写回同一个文件；普通 CSS 写入此前没有完成 journal 凭证，根 workspace 的恢复还无法识别子 workspace 的现有完成记录。

修复计划先以真实 FileDataAccessor / Mix / SQLite / recovery journal 回归锁定文件 mtime 的变化，再收敛三处边界：

1. Recovery 显式选择 authority 读取模式；普通复制同步保留，已映射到同一 authority 路径时避免写回源文件。
2. 普通 CSS RDF 写入复用同一个 journal，核对记录的内容摘要与实际要索引的正文，索引完成后再次核对精确文件版本才 markDone。失败保持未完成状态，不能把并发写入误记为已索引。
3. Root bootstrap 复用同一 journal 中绑定 physical sourcePath、resource URI、精确 fileVersion 的最新 done 凭证。不添加第二张事实表，不以 RDF quads 语义相等推断 HTTP 字节相同。

真正需要恢复时保留既有其他 metadata，并从 authority 文件日期推导 modified；不因恢复复制文件而制造新的文件修改时间。外部纯格式编辑仍应触发索引并生成新的服务端 revision。索引前后发生并发文件变化时，完成校验失败并保留待恢复状态。

复用子 workspace 完成凭证时，同时投影根目录检查点以继续检测外部删除。现有 `sync_checkpoints` 增加 resource 绑定；旧库从保留的 last_op_id 回填，已压缩且无历史证据的检查点保守重放一次。文件版本相同但资源 URI 不同不能跳过恢复。

回放使用稳定插入次序，每项执行前重新读取当前状态；完成或永久失败的操作不会被迟到的失败回调重新激活。authority 文件落盘后，即使 journal INSERT 失败也保留文件并抛出原始错误，后续 startup 扫描补建恢复凭证。
