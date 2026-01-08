# Xpod Edge 管控架构总览

> **提示**：旧版 Admin Console（`/admin` SPA 与 `AdminConsoleHttpHandler`）已经完全移除。节点注册、证书续签、配额调整等操作均通过 API、CLI 或业务门户完成。本文件聚焦仍在使用的云边组件及其依赖关系，便于持续演进。

---

## 1. Handler 装配顺序

Xpod 在 `config/xpod.json` 中覆盖了 CSS 的 `BaseHttpHandler`，将自研 Handler 插入默认链路之前。当前顺序如下：

1. **`EdgeNodeSignalHttpHandler`**（默认开启：`/api/signal` / `/api/signal/certificate`）  
   负责边缘节点注册、心跳、模式判定、证书协商等。
2. **`EdgeNodeProxyHttpHandler`**（默认开启，`/pods/*` 请求在 proxy 模式下落到该 Handler）  
   当节点处于隧道/代理模式时执行反向代理，并追加 `X-Xpod-Edge-Node` 等诊断头。
3. **`EdgeNodeDirectDebugHttpHandler`**（前身为 `EdgeNodeRedirectHttpHandler`，默认关闭，仅调试用途）  
   提供显式 307 跳转，方便开发人员验证节点直连入口（绕过 DNS 缓存）。
4. **`QuotaAdminHttpHandler`**（默认关闭）  
   仍保留配额 API 能力，启用后需管理员 Bearer Token。
5. **`SubgraphSparqlHttpHandler`**  
   处理 `.sparql` 结尾的请求，集成 UsageTracking。
6. **CSS 默认链路**：Static → OIDC → Notifications → StorageDescription → AuthResource → IdentityProvider → LDP。

---

## 2. 自定义组件速览

| 类型 | 组件 / Handler | 位置 | 作用 |
| --- | --- | --- | --- |
| 数据访问 | `QuadstoreSparqlDataAccessor` / `MinioDataAccessor` / `MixDataAccessor` | `src/storage/accessors/**` | 统一结构化与对象存储访问，实现 “结构化 → Quadstore / SQLite / Postgres，非结构化 → MinIO”。 |
| 数据装饰 | `RepresentationPartialConvertingStore` / `UsageTrackingStore` / `PerAccountQuotaStrategy` | `src/storage/**` | RDF 转换、用量采集、账号配额策略。 |
| HTTP Handler | `EdgeNodeSignalHttpHandler` / `EdgeNodeProxyHttpHandler` / `EdgeNodeRedirectHttpHandler` / `QuotaAdminHttpHandler` / `SubgraphSparqlHttpHandler` | `src/http/**` | 处理心跳、代理、调试跳转、配额配置及子图 `.sparql` 请求。 |
| 服务 / 工具 | `EdgeNodeCertificateService` / `EdgeNodeDnsCoordinator` / `FrpTunnelManager` / `EdgeNodeHealthProbeService` / `ConfigurableLoggerFactory` 等 | `src/service/**`、`src/edge/**`、`src/logging/**` | 管理证书、DNS、隧道、健康探测以及日志配置。 |

---

## 3. 边缘节点生命周期

1. **注册与鉴权**  
   - 节点通过 `/api/signal` 上报 `nodeId + nodeToken`。`EdgeNodeSignalHttpHandler` 调用 `EdgeNodeRepository` 校验 token 并合并最新的系统信息、Pod 列表、探测结果。
2. **模式判定与 DNS**  
   - `EdgeNodeModeDetector` 结合 reachability、隧道状态等指标推导 `direct/proxy`。  
   - `EdgeNodeDnsCoordinator` 读取 `xpodClusterIngressIp`（proxy 模式）或节点公网 IP（direct 模式），驱动 `TencentDnsProvider` 更新记录。
3. **证书协商**  
   - 节点将 CSR 发送至 `/api/signal/certificate`。`EdgeNodeCertificateHttpHandler` 与 `EdgeNodeCertificateService`、`Dns01CertificateProvisioner` 协作，完成 DNS-01 challenge 与证书下发。
4. **隧道与心跳**  
   - `FrpTunnelManager` 根据 `XPOD_FRP_*` 配置下发 `frpc` 参数，必要时激活隧道。  
   - `EdgeNodeHealthProbeService` 将多地探测结果写回节点 metadata，供下一次模式判定和 DNS 更新使用。

---

## 4. 代理 / 重定向层

- **`EdgeNodeProxyHttpHandler`**  
  - 当节点处于 proxy 模式时匹配请求，基于节点心跳中的 `publicAddress`/隧道入口执行反向代理。  
  - 对响应追加 `X-Xpod-Edge-Node`、`X-Xpod-Proxy-Mode` 等 headers，方便排查。
- **`EdgeNodeRedirectHttpHandler`**（可选）  
  - 仅用于调试阶段，按照节点 metadata 中的 `publicAddress` 进行 307 跳转。默认为关闭状态，避免真实流量暴露内部入口。

---

## 5. 常用变量速查表

| 变量 ID | CLI 参数 | 环境变量示例 | 默认值 | 影响范围 |
| --- | --- | --- | --- | --- |
| `identityDbUrl` | `--identityDbUrl` | `CSS_IDENTITY_DB_URL` | `sqlite:./identity.sqlite` | 所有 Drizzle 仓储、Edge/Quota handler。 |
| `sparqlEndpoint` | `--sparqlEndpoint` | `CSS_SPARQL_ENDPOINT` | `sqlite:./quadstore.sqlite` | Quadstore / MixDataAccessor。 |
| `xpodEdition` | `--xpodEdition` | `XPOD_EDITION` | `server` | 控制边缘特性与 UI/文案（目前主要用于 API 标识）。 |
| `xpodEdgeNodesEnabled` | `--xpodEdgeNodesEnabled` | `XPOD_EDGE_NODES_ENABLED` | `false` | 是否接受节点注册/心跳。 |
| `xpodAcmeEmail` | `--xpodAcmeEmail` | `XPOD_ACME_EMAIL` | `""` | ACME 账号联系邮箱。 |
| `xpodClusterIngressIp` | — | `XPOD_CLUSTER_INGRESS_IP` | `""` | proxy 模式下 DNS 指向的集群入口 IP。 |
| `xpodFrpServerHost` | `--xpodFrpServerHost` | `XPOD_FRP_SERVER_HOST` | `""` | frps 服务端地址（为空则禁用隧道）。 |
| `xpodFrpServerPort` | `--xpodFrpServerPort` | `XPOD_FRP_SERVER_PORT` | `7000` | frps 端口。 |
| `xpodFrpToken` | `--xpodFrpToken` | `XPOD_FRP_TOKEN` | `""` | frps 认证 Token。 |
| `xpodFrpProtocol` | `--xpodFrpProtocol` | `XPOD_FRP_PROTOCOL` | `tcp` | frp 代理类型（tcp/http 等）。 |
| 其余 DNS、探测、Quota 相关变量 | 详见 `config/resolver.json` | `XPOD_*` | —— | 驱动 DNS/探测/Quota 组件。 |

---

## 6. 变量维护流程（务必同步三处）

1. **声明 Variable**：在相应配置（如 `config/xpod.cluster.json`）添加 `{"@id":"urn:solid-server:default:variable:xxx","@type":"Variable"}` 并在组件参数中引用。
2. **绑定解析**：在 `config/resolver.json` 中为该 URN 配置 `KeyExtractor`（或其他 resolver），才能从 CLI/ENV 注入。
3. **补文档与示例**：更新 `docs/edge-cluster-architecture.md`、`example.env` 等位置，提醒运维如何配置。  

严格执行以上步骤，可避免 `Invalid predicate IRI` 或 “Undefined variable” 这类问题。

---

## 7. 运行模式与测试

Xpod 支持 6 种运行模式，适用于不同场景：

| 模式 | 命令 | 端口 | 正确访问 URL | 配置文件 | 用途 |
| --- | --- | --- | --- | --- | --- |
| **start** | `yarn start` | 3000 | `http://localhost:3000/` | `extensions.json` | 快速体验，SQLite + 本地文件 |
| **local** | `yarn local` | 3000 | `http://localhost:3000/` | `.env.local` + `extensions.local.json` | 桌面/单机部署，配额禁用 |
| **dev** | `yarn dev` | 3000 | `http://localhost:3000/` | `.env.local` + `extensions.dev.json` | 开发调试，无认证 |
| **server** | `yarn server` | 3000 | `http://localhost:3000/` | `.env.server` + `extensions.cloud.json` | 生产部署，PostgreSQL + MinIO |
| **cluster:server** | `yarn cluster:server` | 3100 | `http://localhost:3100/` | `.env.cluster` + `extensions.cluster.json` | 集群控制面 |
| **cluster:local** | `yarn cluster:local` | 3101 | `http://node-local.localhost:3101/` | `.env.cluster.local` + `extensions.local.json` | 边缘节点本地测试 |

**重要说明**：
- `cluster:local` 必须通过 `http://node-local.localhost:3101/` 访问（带 subdomain），因为 `CSS_BASE_URL` 配置为该地址
- 若使用 `http://localhost:3101/` 访问会返回 500 错误（Host header 不匹配 baseUrl）
- 集群模式下，边缘节点流量通过 `ClusterIngressRouter` 从 cluster:server 代理到 cluster:local

### 快速验证所有模式

```bash
# 验证单个模式
yarn start &
sleep 8 && curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
pkill -f "community-solid-server"

# cluster:local 需要使用 subdomain
yarn cluster:local &
sleep 8 && curl -s -o /dev/null -w "%{http_code}" http://node-local.localhost:3101/
pkill -f "community-solid-server"
```

---

## 8. 调试与部署建议

1. **启动**：使用 `yarn cluster:server`（读取 `.env.cluster`）启动控制面，观察日志确认 `EdgeNodeSignalHttpHandler`、`ClusterIngressRouter` 是否注册成功；本地节点用 `yarn cluster:local` 读取 `.env.cluster.local` 并连接到控制面。
2. **节点验证**：通过 API 注册测试节点，观察 `/api/signal` 返回的 metadata 中 `accessMode`、`dns`、`tunnel` 字段是否符合预期。
3. **DNS / 证书**：借助 `dig`、`nslookup`、`openssl s_client` 验证 DNS 记录与证书链；若失败，重点排查 `CSS_TENCENT_DNS_*` 与 `CSS_ACME_*`。
4. **隧道**：查看 `EdgeNodeSignalHttpHandler` 心跳日志中的 `tunnel.client` 字段和 `frpc` 日志，确保直连/隧道切换时可以快速恢复。

以上流程覆盖了当前云边架构的主要模块。后续若扩展新的 Handler 或前端入口，请以本文件为基准同步更新，保持"配置 ⇄ 代码 ⇄ 文档"一致。 
