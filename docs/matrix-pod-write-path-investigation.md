# Matrix Pod 写入延迟调研

日期：2026-09-23。范围：一次 Matrix 消息写入在真实 Local 栈上的耗时构成、已做的优化、
以及尚未解决的部分。原始问题记录见 [ACR 祖先链读取](issues/2026-09-23-acp-ancestor-reads-per-authorization.md)。

本文只有本机实测数据，没有生产压测；所有数字都是同机、单实例、隔离测试栈的结果，
不能当作容量或延迟承诺。

## 结论摘要

1. 一次消息写入约 4.5 秒（空房间约 3.2–4.8 秒），其中**授权读取占一半以上**；
2. 慢的不是 SPARQL 引擎、不是 QLever、不是 ORM hydration，而是**每次授权都沿祖先链重读 ACR**；
3. 已把一条消息写入的 Pod 操作从 5 次降到 3 次（适配层复用），但那只省掉零头；
4. 真正的杠杆是跨请求复用授权结果，属于授权语义变更，需要先定失效策略，尚未实施。

## 测量条件

- 隔离 Local 栈（`XpodTestStack`，同进程起 Gateway + CSS + API + 本地身份库），
  `open:false`、`authMode:'acp'`，Pod 数据落在 `.test-data/`。
- SPARQL 运行时是**测试夹具** `tests/fixtures/fake-qlever-native-runtime.js`
  （n3 + sparqljs，406 行），由 `XPOD_QLEVER_LOCAL_RUNTIME_COMMAND` 指定；
  生产路径的 `xpod_qlever_local_runtime`（QLever 引擎 + `qlever/rdf_sqlite_backend`）
  在本机不存在，未参与本次测量。
- CSS 日志级别 `error` 或 `verbose`；`verbose` 只用于统计请求与操作，计时用插桩，
  插桩已全部撤回。
- 消息写入指 `PUT /_matrix/client/v3/rooms/:roomId/send/m.room.message/:txnId`。

## 观察到的现象

### 单次写入的耗时与并发表现

| 场景 | 实测 |
| --- | --- |
| 单条消息写入（空房间） | 3.2–4.8s |
| 单条消息写入（房间 12 条消息） | 约 1.8–2.3s |
| 单条消息写入（房间 60 条消息） | 约 2.3s |
| 4 路并发写入，每批墙钟 | 约 7.8s（≈ 单条耗时，写入被串行化） |
| `sync?limit=7`（60 事件） | 约 2.6s |

「4 路并发被串行化」是**推断**：只观测到批次墙钟 ≈ 单条耗时，没有拿到并发下 Pod
出站请求的计数，也没有证明是文档锁、CSS 还是身份库造成的排队。

### 一次写入的 Pod 操作数

优化前 5 个，优化后 3 个（同一房间、同一天桶）：

| 操作 | 优化前 | 优化后 |
| --- | --- | --- |
| chat 资源 SPARQL SELECT | 2（`roomSource` + `getRoomContext`，各约 1.4s） | 1 |
| `messages.ttl` GET | 2（`requireJoined` + `authorizeTargets` 各扫一遍时间线） | 1 |
| `messages.ttl` PATCH | 1（约 260ms） | 1 |

### SPARQL 阶段的拆分（插桩 `executeSelect`）

| 项 | 房间 12 条 | 房间 60 条 |
| --- | --- | --- |
| 单次写入墙钟 | 1801ms | 2254ms |
| SPARQL 调用次数 | 2 | 2 |
| `resolveReadAccessScope` 合计 | **817ms** | **993ms** |
| `engine.queryBindings` 合计 | **54ms** | **149ms** |
| `sync?limit=7` 墙钟 / scope / engine | — | 2617ms / **1768ms** / **261ms** |

### 再往下拆（插桩 `authorizeIdentifier`）

| 项 | 实测 |
| --- | --- |
| 判定次数 | 12（2 次 SPARQL × 6 个在范围 graph） |
| `permissionReader.handleSafe` 合计 | **938ms**（约 78ms/次） |
| `authorizer.handleSafe` 合计 | **12ms**（约 1ms/次） |
| 在范围 graph / graph 总数 | 6 / 21 |
| `engine.listGraphs` | 5–8ms |

日志侧计数（单条写入窗口）：`MemoryResourceLocker` 223 次、`ManagedAcpRepository` 49 次、
`AclPermissionsEngine` 6 次、`AcpPolicyEngine` 6 次、`WrappedExpiringReadWriteLocker` 9 次。

## 代码层证据

- `@solidlab/policy-engine` 的 `dist/ManagedAcpRepository.js`：
  `getRelevantACRs(target)` 对每个祖先调用 `readAcrData`，源码注释即
  `// TODO: cache this as we might have many duplicates if we also need to check the parent`；
  `readAcrData` 每次都经 `manager.getAuthorizationData(identifier)` 重新取并解析该层 ACR。
- CSS 默认 `urn:solid-server:default:PermissionReader`
  （`config/ldp/authorization/readers/default.json`）是 `CachedHandler`，
  而 `CachedHandler` 用 `WeakMap` 且以**对象同一性**为键
  （`fields: ["credentials", "requestedModes"]`）。Xpod 的 SPARQL 处理器每次调用都新建
  `{ credentials, requestedModes }` 对象，因此该缓存层在实际流量中**从不命中**。
- 消息资源是**按日期分桶的单文档**（`/.data/chat/<id>/<yyyy>/<MM>/<dd>/messages.ttl`），
  所有写入都是 read-modify-write；实测 63 条消息时该文档约 84 KB，PATCH 本身约 260ms。
- 读取路径不受分桶影响：`messageResource` 与 `threadResource` 的 SPARQL 端点是 Pod 级
  `/.data/-/sparql`，`chatResource` 是 `/.data/chat/-/sparql`；消息查询用
  `FILTER(?thread = <...>)` 一次覆盖所有日期分区。

## 被排除的解释

| 假设 | 结论 | 依据 |
| --- | --- | --- |
| drizzle-solid inline metadata hydration 是瓶颈 | **不成立** | 插桩 `executeQueryWithSource` 与 LDP executor，调用数均为 0 |
| QLever / SPARQL 引擎慢 | **不成立** | 引擎执行仅 54–261ms，占请求 6–10% |
| 测试夹具（假 QLever）拖慢 | **不成立** | 规模从 12 → 60 条消息，engine 从 54ms → 149ms，斜率温和 |
| 日志量拖慢 | 不成立 | 计时在 `logLevel: 'error'` 下取得 |

## 已实施

| 提交 | 内容 | 效果 |
| --- | --- | --- |
| `0e738d40` | `sendEvent` 读一次时间线同时供成员与授权检查使用 | Pod 操作 5 → 4 |
| `9ef23adf` | 请求 context 上复用房间记录（chat 资源只写一次） | chat SELECT 2 → 1，Pod 操作 4 → 3 |
| `d109b27c` | `authorizeIdentifier` 请求内判定复用（成功与失败都缓存） | 同一请求内重复判定去重；本例收益有限 |

期间验证过并**否决**的方案：跨子操作的事件列表缓存。它会让 `MatrixCollaboration` 的
「直接篡改 Pod 内容」「晚到原生消息」用例失败——该 store 的设计要求绕过 API 的 Pod 改动
必须可见，缓存会掩盖它们。

## 未解决

1. **跨请求授权复用（主杠杆）**。同一批 6 个 graph 在连续请求中被反复判定，每次都重读祖先链 ACR。
   需要先定：失效键（Pod 根+主体+路径+模式，还是 ACR/ACL 资源版本）、失效时机
   （处理器自身的 SPARQL update 可主动失效，但普通 `PUT/PATCH` 写 `.acl`/`.acr` 不经过它）、
   TTL 兜底与多实例一致性。任何方案都必须 fail-closed。
2. **单文档 read-modify-write**。当前 PATCH 不是大头，但随文档内消息数增长；属长期隐患。
3. **4 路并发是否真被串行化**，以及串行点在哪，未证明。

## 本次调研不能推导的结论

- 生产（真实 QLever 引擎、PostgreSQL、多实例、Redis 集群）下的延迟与容量；
- 桌面端或常驻 Gateway 实例上的表现；
- 任何"优化后达到某个性能指标"的承诺。以上数据只说明本机隔离栈上的相对构成。
