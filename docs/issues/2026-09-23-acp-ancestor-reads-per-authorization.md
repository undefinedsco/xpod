# 每次 SPARQL 授权的 ACR 祖先链重复读取

状态：2026-09-23 真实栈实测定位；上游源码已自带 TODO，未修改上游包。
完整测量口径、被排除的解释与已实施的适配层优化见 [Matrix Pod 写入延迟调研](../matrix-pod-write-path-investigation.md)。

## 现象

一次 Matrix 消息写入（同一 Pod、本机真实栈）的 SPARQL 阶段耗时拆分：

| 项 | 实测 |
| --- | --- |
| `resolveReadAccessScope` 两次调用合计 | 817ms（房间 12 条消息时） |
| 其中 `permissionReader.handleSafe` | 938ms / 12 次判定（约 78ms 每次） |
| 其中 `authorizer.handleSafe` | 12ms / 12 次判定 |
| 在范围的 graph 数 | 6（graph 总数 21） |
| `listGraphs` | 5–8ms |

也就是说：**慢的不是策略求值，而是读取 ACR 数据本身**。

## 根因

`@solidlab/policy-engine` 的 `dist/ManagedAcpRepository.js`：

- `getRelevantACRs(target)` 对 target 的每个祖先调用 `readAcrData`，源码注释即
  `// TODO: cache this as we might have many duplicates if we also need to check the parent`；
- `readAcrData` 每次都走 `manager.getAuthorizationData(identifier)` 重新取并解析该层 ACR。

同时 CSS 默认的 `urn:solid-server:default:PermissionReader` 是 `CachedHandler`
（`config/ldp/authorization/readers/default.json`），而 `CachedHandler` 用
`WeakMap` 且以**对象同一性**为键（`fields: ["credentials", "requestedModes"]`）。
Xpod 的 SPARQL 处理器每次调用都新建 `{ credentials, requestedModes }` 对象，
因此该缓存层在实际流量中**从不命中**。

## 已完成

`SubgraphSparqlHttpHandler.authorizeIdentifier` 增加请求内判定复用（成功与失败都缓存），
覆盖 base、各 graph 以及 SPARQL update 的 readTargets/writeTargets 重复判定。

## 未解决

跨请求复用才是主杠杆（同一批 graph 在连续请求中被反复判定），但授权结果缓存属于
安全语义变更，需要先确定：

1. 失效键：按 Pod 根 + 主体 + 路径 + 模式，还是按 ACR/ACL 资源版本；
2. 失效时机：处理器自身的 SPARQL update 可主动失效，但普通 PUT/PATCH 到 `.acl`/`.acr`
   不经过该处理器；
3. TTL 兜底取值与集群下的一致性（多实例各自持有缓存）。

在这些确定之前不应加跨请求缓存。任何方案都必须保留 fail-closed：缓存未命中或失效
不确定时重新判定。
