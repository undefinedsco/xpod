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

## 已解决（跨请求复用）

三个待决问题的落地口径（2026-09-24，提交 `bee50085`）：

1. **失效键**：Pod 根 + 主体（WebID/clientId）+ 目标路径 + 模式；
2. **失效时机**：本 handler 服务的任何成功写入都递增该 Pod 的世代号；绕过 handler 的
   权限变更由 TTL 兜底；
3. **TTL 与集群**：TTL 5 秒，即多实例部署下的最大不一致窗口；缓存是进程内的，不引入
   跨实例失效通道。

未命中一律重新判定（fail-closed）；允许与拒绝都缓存。**未**采用
`ObservableResourceStore` 作为失效依赖：它只在 `config/cloud.json` 挂载，local 没有，
押在它身上会让 local 的失效静默失灵。

实测把连续消息写入的中位延迟从 1801/2254ms 降到 918–923ms（同机隔离栈，两次独立测量）。
回归：`tests/http` + `tests/api/matrix` + `tests/api/reconciler` 242 通过。

## 仍受 TTL 约束的部分

授权缓存只覆盖**经该 handler** 的路径。多实例部署下，A 实例写的权限变更在 B 实例上
最多 5 秒后生效。如果部署要求"撤销立即全局生效"，需要跨实例失效通道，那是独立议题。
