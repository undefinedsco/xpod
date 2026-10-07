# 目录 HTTP 条件写的版本与锁

日期：2026-10-01。本次修复来自实际启动 CSS/API/Gateway 的候选集成反例，不是 HTTP fixture 的推测。测试使用隔离账号、Pod、默认 ACP 的 ACR 与 client credentials；本地 QLever 生命周期仍是测试夹具，不能将该结果称为当前公共 Gateway 或完整 native RDF 的验收。

## 已复现的缺口

CSS `updateModifiedDate` 将毫秒清零，`BasicETagHandler` 只组合该时间与媒体类型。同一秒创建、覆盖文件后强 ETag 不变，旧 `If-Match` PUT 实际返回205并覆盖外部版本。新增子项后容器 ETag 同样不变。CSS 默认 PUT 响应没有版本；随后 HEAD 得到的版本不能当作这次写入的回执。反例保存在 `candidate-directory-protocol-regression-before.log`。

另有两个边界会绕过锁：请求 metadata cache 可在取得 mutation 锁之前保存旧版本；SPARQL sidecar UPDATE 原先直接调用 accessor。祖先自动创建也会修改立即父目录之外的 metadata。只补 UUID 或只锁目标文件都不充分。

## 当前实现

`SolidRdfDataAccessor` 在现有服务器 metadata graph 中使用现有 `http-headers:etag` 保存唯一的内部 revision，每次 metadata 持久化替换。它不是 Pod 业务字段，不维护第二张版本表。时间继续用于 Last-Modified；版本独立于时钟。旧资源没有此 revision 时仍可读取，但不提供安全强 ETag；不自动猜测或补写已有数据的版本。

`StorageETagHandler` 为不同表示附上不同媒体类型标签，同时保持同一资源 revision，供 GET/HEAD、条件解析与通知共用。弱或畸形标签不能作为 mutation 基线。成功写入时捕获 request-local metadata 副本，`StoragePutOperationHandler` 只返回目标资源的该次回执。RDF/容器转换时没有原表示媒体类型的回执不发 PUT validator；遵守转换后 PUT 的 HTTP 约束，不能强补类型来凑出 ETag。

`HierarchyLockingResourceStore` 按根到目标顺序锁全部祖先及目标，覆盖缺失祖先的递归创建。成功取得这些锁后重建 metadata cache。GET 持有祖先和目标读锁至正文流结束，使子项读取与 SPARQL base 写锁互斥。SPARQL sidecar UPDATE 的 ACL 授权与 LOAD 正文获取在锁外完成，避免权限读取再次进入非重入写锁；存在性判断、authority 的准备和落盘走同一 mutation 边界。Local 使用既有锁并持续维护所有写 callback；任何层失败后，等待中的迟到获取不得进入写入。

这是保守串行策略：同一 configured identifier root 下的写入会互相等待，写入还会等待同根正在流式读取的 GET，不能宣称高并发写入或原生99%性能。后续若缩小锁范围，必须先证明递归创建、父目录 membership 与空删除仍在同一原子边界，不允许就地读锁升级。

## Cloud 的安全与可用性取舍

原 Redis locker 的固定值、TTL、无 owner 释放及启停清 namespace 会允许旧写入在失锁后继续，并可能删除另一个实例的新锁。仅维护 JS wrapper 不会延长 Redis TTL；当前存储接口也没有 fencing token。

当前 `UrlAwareRedisLocker` 用随机 owner 与原子 Lua 管理共享读写锁，只能释放自己持有的字段。相同 owner 的获取、释放重放保持幂等，以应对 ioredis 在响应丢失后的命令重发；替换 owner 仍不能被旧 owner 释放。初始化只检查连接，关闭只断开连接，不清锁。Cloud 移除会在 callback 结束前释放锁的过期 wrapper；锁不自动 TTL 过期，写入保留互斥直到 action 完成并按 owner 释放。

**限制：进程崩溃、连接故障或过早关闭可能保留锁并阻塞后续访问。** 不能在不确定旧 writer 是否仍活动时自动清理。当前恢复要求停止所有可能写入该 authority 的实例、确认没有残存请求，再由运维修复所需锁；本次没有新增自动修复命令，也没有故障注入证明透明恢复。禁止 Redis flush/清 namespace 作为普通启停流程。

新旧 locker key 格式不兼容。部署需停止全部旧写入者后统一升级，不能混用两套实例做滚动发布。现有资源不会自动迁移 revision；公开发布还需已部署候选的实际 Pod 验收及发行材料检查。本地临时栈或 Redis 两个实例的测试不能替代这些门禁。

## 回归入口

- `tests/integration/AgentDirectoryProtocol.integration.test.ts`：实际账号、私有 ACP、DPoP session、Range、list/search、快速文件条件写、容器 membership 版本、安全空删除及默认 ACP reader 下协作者 SPARQL 写入。Local 通过 lite 自动纳入；Cloud 由 full launcher 显式提供隔离 URL。
- `tests/integration/RedisLockOwnership.integration.test.ts`：full 的真实 Redis；另一实例启停不能清活动锁，旧 owner 不能释放替换 owner，同 owner 获取和释放的重复 EVAL 正常。回包丢失在 client 边界注入，不声称完成 TCP 故障或 Redis failover 全矩阵。
- `HierarchyLockingResourceStore.test.ts`：双方先取得锁的 barrier 交错、GET 流阻挡祖先 mutation、旧请求 cache、长于 lease 的写入、外层失效后的迟到获取。
- `StoragePutOperationHandler.test.ts`：同资源另一个请求先完成时，原响应仍返回自己回执；转换后的 RDF 不误发 validator。
- `SolidRdfDataAccessor.test.ts`：固定时间下不同 revision、metadata-only 写入及重新打开后的持久性。

结果及未覆盖项统一记录在 [目录 MVP 验收](agent-directory-mvp-acceptance.md)。
