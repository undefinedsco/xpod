# Xpod 边缘节点控制面与数据面架构

## 目标与约束

- **Solid 语义稳定**：Pod WebID、资源 URL 始终使用 `https://<pod>.<域名>/`，无论路由走向如何都保持一致。
- **控制面/数据面解耦**：cluster 负责域名、证书、服务发现与健康检查；节点负责数据存储与最终的 ACL/ACP 鉴权。
- **优先直连**：默认通过公网直连把数据流量送到节点；仅在直连失败时才回落到“盲转发”隧道，cluster 不解密实际内容。
- **节点自助**：用户可登录 cluster 控制台自助创建节点，获得二级域名与节点凭证；节点上线后自动完成证书与路由编排。

## 核心流程

### 1. 节点注册

1. 用户登录 cluster 控制台，触发“创建节点”。
2. cluster 为节点签发 `nodeId`/`nodeToken`，并分配二级域名（例如 `alice.xpod.example`）。
3. 节点拿到凭证后，与 cluster 的信令端点建立首次心跳：
   - 请求证书：节点生成私钥与 CSR，cluster 通过 ACME DNS-01 写入权威 DNS 并返回证书链。
   - 同步初始元数据：节点报告版本、主机名、可见 IP、能力列表等。
4. cluster 将节点写入注册表，标记状态为“在线但未探测”。

### 2. 可达性与路由编排

- **直连探测**：
  - 节点主动尝试 UPnP/NAT-PMP/PCP 握手，更新公网 IP、映射端口、IPv6 可用性等信息。
  - cluster 多地域探测节点的 443 端口连通性，记录探测结果与耗时。
- **反向隧道兜底**：
  - 当直连失败或网络波动时，节点向 cluster 申请反向隧道（frp/ssh/自研 L4 隧道）。
  - cluster 在入口（HAProxy/Nginx stream 等）根据 SNI 把 TLS 流量透明转发至隧道，保持端到端加密。
- **DNS 切换**：
  - 正常情况 DNS A/AAAA 指向节点公网地址。
  - 若直连不可达，cluster 把 DNS 指向入口 IP；直连恢复后再切回。
  - TTL 设置为 30–60 秒，配合健康检查确保切换及时。

### 3. Pod 元数据同步

- 节点在创建/删除 Pod 成功后，调用 cluster 的控制面 API 上报 `podBaseUrl → nodeId` 映射。
- 心跳 payload 中附带完整或增量 Pod 列表，以便 cluster 对账并修复遗漏。
- Pod 相关 ACL/ACP 文件仍存放在节点上，cluster 不读取资源级权限，只维护路由信息。

### 4. 请求处理路径

1. 客户端访问 `https://alice.xpod.example/resource`。
2. cluster 根据 DNS 与注册表判断：
   - **直连可达**：客户端直接与节点握手，节点验证 token/DPoP，并按 ACL/ACP 返回资源。
   - **使用隧道**：cluster 入口仅做 SNI 透传，节点终止 TLS 并完成所有鉴权逻辑。
3. 若 DNS 尚未生效或隧道资源不可用，cluster 会返回明确的错误（例如 503 + 故障排查指引），而不会尝试做 HTTP 重定向。
4. cluster 在控制平面记录连接元数据（字节数、耗时、错误码），不解密 HTTP 载荷。

## 心跳与信令扩展

- 心跳 payload 中新增以下字段：
  - `reachability`: 直连可达性（如 `direct`, `ipv6`, `natType`, `lastProbeAt`）。
  - `tunnel`: 隧道状态（如 `tunnelId`, `status`, `entrypoint`）。
  - `directCandidates`: 公网候选地址或端口列表，用于 cluster 探测。
  - `certificate`: 证书指纹、到期时间及 ACME 状态。
  - `metrics`: 节点本地指标快照（CPU、磁盘、资源占用）。
  - `dns`: 包含 `subdomain`、`target` 等字段，为 DNS 编排提供强提示。
  - `certificate.dns01`: 携带 `subdomain`/`host`/`value` 用于 DNS-01 TXT 记录。
    - `action`: 默认为 `set`，值为 `remove` 时 cluster 会删除对应 TXT 记录。
- `tunnel.config`: 控制面返回给 Agent 的隧道配置（frp server、token、remotePort），Agent 可据此生成 `frpc.ini`。
- cluster 将这些字段存入 `identity_edge_node.metadata`，为控制面 UI、路由决策与告警提供数据支撑。

## 安全性策略

- **私钥留在节点**：ACME 全程采用 DNS-01 挑战，cluster 只写入 TXT 记录并返回证书链。
- **节点鉴权**：所有心跳/注册操作必须携带 `nodeId` 与 `nodeToken`，并通过速率限制与审计日志记录。
- **端到端加密**：即便经过 cluster 入口，TLS 由节点终止；可选在隧道层再启用 mTLS 确保最小信任面。
- **最小日志**：cluster 仅保留必要元数据（连接计数、失败原因），禁止记录资源路径或请求体。

## 迭代路线

1. **P0**：完成自助节点注册、心跳扩展、直连/隧道切换、DNS 编排与证书自动化。
2. **P1**：多地域健康检查仪表板、Alt-Svc/HTTP3 动态广告、流量命中率统计。
3. **P2**：为原生客户端接入 WireGuard/Tailscale overlay，实现更高可用的直连路径。
4. **P3**：研究 WebRTC 浏览器直连能力，进一步降低 cluster 数据面参与度。

## 与现有实现的映射

- `EdgeNodeHeartbeatService` 增强后可发送丰富的元数据字段，与本文档中的心跳扩展相对应。
- `EdgeNodeSignalHttpHandler` 负责验证 token、落库心跳信息，并在未来驱动 DNS/隧道编排。
- `EdgeNodeRedirectHttpHandler` 仅作为调试工具保留（例如验证节点是否已经可达），**不会**在生产路由中用来对最终用户做 HTTP 重定向兜底；实际兜底策略是返回可诊断的错误码，引导用户或节点自愈。
- **DNS Provider 抽象**：`src/dns/DnsProvider.ts` 定义了统一的 `DnsProvider` 接口，`TencentDnsProvider` 基于 DNSPod v2 API 实现 `upsertRecord`/`deleteRecord`/`listRecords` 三个核心能力。集群可按需扩展其它供应商适配器，仅需实现相同接口即可。
- **DNS 编排协调器**：`EdgeNodeDnsCoordinator` 会在 `EdgeNodeSignalHttpHandler` 成功落库后自动调用 DNS Provider，同步节点心跳中携带的 `metadata.dns.subdomain` 与 `target` 信息，确保二级域名实时指向最新探测到的出口地址。若缺少有效候选，将记录警告并保持现状。
- **证书自动化（DNS-01）**：`Dns01CertificateProvisioner` 解析心跳中的 `metadata.certificate.dns01` 字段，为 `_acme-challenge` 写入 TXT 记录，配合外部 ACME 客户端完成证书签发。未提供 challenge 时将跳过处理并输出告警。
- **隧道协调**：`SimpleEdgeNodeTunnelManager` 监听心跳中的 `reachability` 状态，当检测到直连失败时自动选取兜底入口，将 `metadata.tunnel` 标记为 `active`；直连恢复后切回 `standby`。若需要接入真实隧道控制面，可实现 `EdgeNodeTunnelManager` 接口替换。
- **健康探测**：`EdgeNodeHealthProbeService` 基于节点上报的 `directCandidates`/`publicAddress` 发起 `HEAD` 探测，写回 `reachability` 的候选列表、延迟和结果，供 DNS 与隧道决策使用。
- **节点守护 Agent**：`EdgeNodeAgent` 封装心跳上报脚本，可在节点主机启动后自动采集系统指标、Pod 列表并推送给 `EdgeNodeSignalHttpHandler`，同时携带 `metadata.dns`/`certificate.dns01` 触发控制面的自动化流程。
- **节点 Agent 指南**：详见 `docs/edge-node-agent.md`，提供命令行示例与 systemd 集成建议。

## 配置要点

- 通过 `XPOD_EDGE_NODES_ENABLED=true` 开启信令与路由组件；本地模式保持 `false` 可避免误注册。
- 若需自动编排二级域名与证书，请设置：
  - `XPOD_TENCENT_DNS_TOKEN_ID` / `XPOD_TENCENT_DNS_TOKEN`：DNSPod API 凭证，缺失时模块自动退化为只读并跳过同步。
- DNS 根域名默认取自 CSS `baseUrl`，只需配置 `XPOD_TENCENT_DNS_*` 和 `XPOD_DNS_RECORD_TTL`（秒）即可。
- FRP 隧道：
  - `XPOD_FRP_SERVER_HOST` / `XPOD_FRP_SERVER_PORT` / `XPOD_FRP_TOKEN`：frps 基础信息，缺失时隧道管理自动关闭。
  - `XPOD_FRP_PROTOCOL`：默认为 `tcp`，仅当自定义 frps 行为时需要调整。
- `XPOD_TUNNEL_ENTRYPOINTS` 仍可作为手工兜底列表；若提供且同时启用 FRP，可作为前端入口映射或监控参考。
- `XPOD_EDGE_HEALTH_PROBES_ENABLED=true` 可启用外向健康探测，配合 `XPOD_EDGE_HEALTH_PROBE_TIMEOUT`（毫秒）调整超时；默认关闭以避免额外链路压力。
- 节点端需运行 `frpc` 并与 Agent 协同：`EdgeNodeAgent.frp` 选项会根据心跳返回的配置自动生成 `frpc.ini`、启动/重启进程，确保隧道一直连向 cluster 的 frps；若不需要隧道，请勿配置相关变量。
- 节点若启用 Agent ACME 功能，需要在本地配置 `acme.email`、`acme.domains` 及证书存储路径；Agent 会调用 cluster 发布 DNS-01 challenge，自动续签后返回 PEM 文件，可直接挂载给 CSS 或本地反代。
