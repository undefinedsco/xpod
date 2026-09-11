# drizzle-solid 精确更新与版本条件的 API 边界

2026-09-09，本机安装版在重读 Kimi 订阅时，刷新上游令牌后写回 Pod 失败。`PodConnectedCredentialRepository.updateCredential` 的旧路径使用 `update(...).where(and(eq(id, ...), eq(keyVersion, ...)))`，drizzle-solid 0.3.24 抛出 `Using 'id' or '@id' in where() is not supported`。

修复使用正式的 `findById` / `updateById` 精确资源 API，去除更新载荷中的 id/@id；精确重读检查版本，并在当前进程串行处理同一 owner、同一凭据的更新。rewrap 路径复用同一更新函数。没有使用原生 SPARQL 或绕过 drizzle-solid。

现行 `updateById(resource, id, data)` 不提供期望版本或 If-Match 参数，因此读取版本再更新不能保证跨进程的原子比较并交换。后续应由 drizzle-solid 提供精确目标与条件更新组合接口（或明确支持的 ETag/事务契约），再补跨进程竞争测试；当前锁不能被描述为分布式 CAS。

回归必须让旧 `where(id)` 路径抛错，验证只更新目标记录、拒绝陈旧版本、同进程并发不覆盖。真实实例还需验证刷新后的 secret 能持久化，不能仅依赖宽松数据库 mock。刷新与 Pod 保存之间的失败也可能导致上游 refresh token 已轮换、旧记录无法再次刷新，需保持明确的重新登录提示。
