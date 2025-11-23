# Edge Cluster Dual Mode Architecture

## 概述

本文档说明 Xpod Edge Cluster 的双模式架构设计，基于 `openspec/changes/implement-edge-cluster` 提案实现。

## 双模式定义

### Direct 模式（有公网 IP）

**流量路径**：
```
Client → DNS 查询 node1.cluster.example → 返回 Node Public IP
Client → Node IP:443 (直连，不经过 Cluster)
```

**特点**：
- DNS 指向节点公网 IP
- 客户端直接访问节点
- **零 Cluster 带宽成本**
- 证书部署在节点上，节点终止 TLS

**组件**：
- `EdgeNodeModeDetector`: 检测节点是否有可达的公网 IP
- `EdgeNodeDnsCoordinator`: 更新 DNS A 记录指向节点 IP
- `AcmeCertificateManager` (节点端): 申请和部署证书
- `EdgeNodeRedirectHttpHandler`: 兜底重定向（DNS 缓存过期时）

###proxy 模式（无公网访问）

**流量路径**：
```
Client → DNS 查询 node1.cluster.example → 返回 Cluster IP
Client → Cluster IP:443
         ↓ L4 SNI 路由器 (FRP Server)
         ↓ 根据 SNI (node1.cluster.example) 查找对应隧道
         ↓ TLS 数据包透传
         → Local Node (终止 TLS，内部路由到具体 Pod)
```

**特点**：
- DNS 指向 Cluster IP
- FRP Server 做 L4 SNI 路由，**不解密 TLS**
- 通过隧道转发到节点
- 端到端加密，Cluster 看不到明文数据
- 证书仍然部署在节点上（节点终止 TLS）

**组件**：
- `EdgeNodeModeDetector`: 检测节点无公网访问
- `EdgeNodeDnsCoordinator`: 更新 DNS A 记录指向 Cluster IP
- `FrpTunnelManager`: 配置和管理 FRP 隧道
- `EdgeNodeProxyHttpHandler`: 接收指向 cluster IP 的 HTTP 请求并根据 Host 转发到 `tunnel.entrypoint`
- **FRP Server (frps)**: 独立进程，监听 443/80，基于 SNI 路由
- `AcmeCertificateManager` (节点端): 申请和部署证书
- `Dns01CertificateProvisioner` (集群端): 协调 DNS-01 challenge

## 关键设计决策

### 1. 为什么 proxy 模式使用 L4 SNI 路由而不是 L7 HTTP 代理？

**L4 SNI 路由（当前设计）**：
- ✅ Cluster 只读 SNI，不解密 TLS
- ✅ 端到端加密，隐私保护
- ✅ 性能好，无需 TLS 终止和重新加密
- ✅ 节点独立控制证书
- ✅ 符合 "data sovereignty" 原则

**L7 HTTP 代理（备选方案）**：
- ❌ Cluster 必须终止 TLS 才能解析 Host header
- ❌ Cluster 能看到明文数据
- ❌ 性能损失（TLS 终止 + 重新加密）
- ⚠️ 但可以做应用层功能（缓存、压缩、WAF等）

**结论**：采用 L4 SNI 路由，符合 Solid 协议的隐私和去中心化原则。

### 2. 证书管理策略

**Direct 模式**：
1. 节点通过 `AcmeCertificateManager` 向 Let's Encrypt 申请证书
2. DNS-01 challenge: 节点调用集群的 `/api/signal` API，请求设置 TXT 记录
3. 集群的 `Dns01CertificateProvisioner` 写入 TXT 记录
4. Let's Encrypt 验证 TXT 记录
5. 节点获得证书，部署到本地 HTTPS 服务

**proxy 模式**：
- 流程与 Direct 模式相同
- 证书仍然部署在节点上（因为 TLS 在节点终止）
- FRP 隧道只是透传 TLS 流量，不涉及证书

### 3. CSS EdgeNodeRedirectHttpHandler 的角色

现有的 `EdgeNodeRedirectHttpHandler` 在双模式下的作用：

**Direct 模式**：
- 兜底重定向：万一客户端 DNS 缓存过期，访问到 Cluster
- 返回 307 重定向到节点公网地址
- 代码已修改为只处理 `accessMode === 'direct'` 的节点

**proxy 模式**：
- 不处理（返回 `NotImplementedHttpError`）
- 因为正常流量应该被 FRP Server 拦截处理
- 如果走到这个 Handler，说明配置有问题

## 代码架构设计

### 控制面组件（CSS 内，模式感知）

使用**单一类 + if-else** 策略，因为逻辑简单：

```typescript
// EdgeNodeDnsCoordinator.ts
async updateDnsForNode(node: EdgeNode) {
  if (node.accessMode === 'direct') {
    // DNS → 节点公网 IP
    await this.dnsProvider.setARecord(node.subdomain, node.publicIp);
  } else {
    // DNS → Cluster IP
    await this.dnsProvider.setARecord(node.subdomain, this.clusterIp);
  }
}

// EdgeNodeRedirectHttpHandler.ts
private async resolve(pathname, url) {
  const record = await this.nodeRepo.findNodeByResourcePath(pathname);
  
  if (record.accessMode === 'proxy') {
    // proxy 模式不应该走到这里
    this.logger.warn('Should be handled by L4 SNI proxy');
    return undefined;
  }
  
  // Direct 模式：返回重定向
  return { nodeId, target };
}

// EdgeNodeProxyHttpHandler.ts
public override async handle({ request, response }) {
  const host = this.extractHostname(request);
  const node = await this.repo.findNodeBySubdomain(host);
  if (!node || node.accessMode !== 'proxy') {
    throw new NotImplementedHttpError();
  }
  const upstream = node.metadata?.tunnel?.entrypoint;
  if (!upstream) {
    throw new InternalServerError('Tunnel not ready');
  }
  const target = new URL(this.parseUrl(request).pathname, upstream);
  await this.forwardHttp(request, response, target);
}
```

`EdgeNodeSignalHttpHandler` 会在每次心跳时检视 `reachability.samples` 与 `tunnel.status`：直连探测成功立刻切回 `direct`，直连连续失败且隧道激活则切到 `proxy`，并通过 `EdgeNodeRepository.updateNodeMode` 触发 DNS 与 FRP 路由刷新。

### 数据面组件（CSS 外）

- **Direct 模式**：无需额外组件，客户端直连节点
- **proxy 模式**：FRP Server (独立进程)，不在 CSS 代码中

## 部署架构

### Cluster 服务器运行的进程

1. **CSS (Node.js)** - 监听 3000 或通过 nginx 暴露
   - `/api/signal/*` - 控制面 API
  - （原 `/admin/*` 控制台已移除，需由业务门户替代）
   - Direct 模式的兜底重定向

2. **FRP Server (frps)** - 独立进程，监听 443/80
   - L4 SNI 路由
   - 根据域名查找对应节点的隧道
   - 透传 TLS 流量

### Local Node 运行的进程

1. **CSS (Node.js)** - Solid Pod 服务器
   - 监听 443 (direct) 或内网端口 (proxy)
   - 终止 TLS
   - 内部路由到不同 Pod

2. **EdgeNodeAgent** (可选) - 心跳和监控
   - 定期向 Cluster 发送心跳
   - 报告节点状态、capabilities、metrics

3. **FRP Client (frpc)** (仅 proxy 模式)
   - 建立到 FRP Server 的隧道
   - 转发本地端口到隧道

### 隧道 TLS 转发（Phase 3.4）

- FRP Server 仅做 L4/SNI 路由：监听 443，根据 `SNI=node1.cluster.example` 将完整 TLS 流量转发到对应 frpc 连接。
- TLS 终止仍发生在节点本地。Cluster 获得的证书通过 `/api/signal/certificate` 分发给节点，frps 不接触私钥。
- `FrpTunnelManager` 会在 metadata 中注入 `tunnel.entrypoint/publicUrl`，Agent 或 UI 可以展示「通过 cluster 代理访问」的 URL，并确保 `tunnel.status` 为 `active` 时 DNS 指向 cluster。
- 可通过 `XPOD_EDGE_PROBE_LOCATIONS` 增加探测点，对跨区域 POP 的可达性做健康检查，从而驱动 DNS 及隧道切换。
## 实现状态 (Phase 1 完成)

- ✅ `EdgeNodeModeDetector` - 模式检测和自动切换
- ✅ `EdgeNodeSignalHttpHandler` - 注册/心跳 API
- ✅ `EdgeNodeRepository` - 数据库操作，包含 `accessMode` 字段
- ✅ `EdgeNodeDnsCoordinator` - 直连/代理模式的 DNS 指向策略
- ✅ `EdgeNodeHealthProbeService` - 健康探测
- ✅ `EdgeNodeHeartbeatService` - 心跳客户端
- ✅ `EdgeNodeRedirectHttpHandler` - 支持双模式的重定向
- ✅ `AcmeCertificateManager` - ACME 客户端（节点端）
- ✅ `Dns01CertificateProvisioner` - DNS-01 协调器（集群端）
- ✅ `FrpTunnelManager` - 隧道管理

## 待完成工作

- ⚠️ FRP Server 配置和部署指南
- ⚠️ 模式转换的平滑切换测试
- ⚠️ 集成测试和文档

## 配置更新

- 新增 `xpodClusterIngressIp`（可通过 `XPOD_CLUSTER_INGRESS_IP` 环境变量注入），供 `EdgeNodeDnsCoordinator` 在 proxy 模式下指向 cluster 入口 IP。
- `EdgeNodeSignalHttpHandler` 会直接读取 CSS `baseUrl` 的 hostname 作为集群域，自动完成 DNS/证书编排，无需额外的 `XPOD_DNS_ROOT_DOMAIN`。
- `AcmeCertificateManager` 支持配置 `fallbackDirectoryUrls`，若主 CA 失败会自动回退到备用 ACME 端点。
- Cluster 侧新增 ACME 账号配置：`XPOD_ACME_EMAIL`、`XPOD_ACME_DIRECTORY_URL`、`XPOD_ACME_ACCOUNT_KEY_PATH`、`XPOD_ACME_CERTIFICATE_STORE`、`XPOD_ACME_DNS_PROPAGATION_DELAY`，并暴露 `/api/signal/certificate` 供节点提交 CSR。
- `XPOD_EDGE_PROBE_LOCATIONS` 用于配置多地连通性探测（格式如 `cluster,us-east@https://probe-us.example/api`），探测结果写入 `reachability.samples` 供 DNS/隧道调度参考。

## 参考资料

- `openspec/changes/implement-edge-cluster/` - 完整提案
- `docs/edge-node-control-plane.md` - 控制面设计
- `docs/edge-node-agent.md` - Agent 使用指南
