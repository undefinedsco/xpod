# 域名与隧道方案

> 本文档描述 xpod 边缘节点的域名分配和隧道穿透方案。Local Pod 的 route / signaling 规范以 [`local-reachability-signaling-spec.md`](./local-reachability-signaling-spec.md) 为准。

## 目标

为 Edge 用户提供：
1. **稳定二级域名** - 如 `mynode.pods.undefieds.co`，用于 WebID、Pod Root、OIDC audience 等 canonical URL
2. **多 route 可达性** - same-device、LAN、公网 IPv4/IPv6 直连、P2P、用户自管 tunnel 按优先级选择
3. **自动 HTTPS / 证书协作** - 通过 DNS-01 等方式让节点持有可用于 canonical 域名的证书
4. **受控兜底** - Xpod Cloud relay 只能作为显式、限额、临时或诊断路径，不作为默认数据面

---

## 可达性方案评估框架

不要只按 Cloudflare Tunnel、Tailscale、FRP 这类产品名分类。对 Xpod 来说，
每一种穿透/访问方案首先要回答三个问题：

1. **是否需要客户端**：边缘节点上是否必须运行 `cloudflared`、`frpc`、
   `tailscaled`、Xpod Agent 等本地进程。
2. **是否需要域名**：浏览器、Solid WebID、OAuth 回调和 HTTPS 是否需要稳定
   URL；域名由 Xpod 托管、用户自带，还是第三方服务分配。
3. **是否需要服务器/中转**：流量是否需要经过 Xpod Cloud、自建 `frps`、
   Cloudflare、Tailscale Funnel、SakuraFRP 等公网中转。

这三个条件决定了用户配置复杂度、TLS 终止点、隐私边界、性能和我们能否自动化。

| 方案 | 需要客户端 | 需要域名 | 需要服务器/中转 | 公网浏览器可访问 | TLS 终止点 | Xpod 定位 |
| --- | --- | --- | --- | --- | --- | --- |
| 公网 IPv4/IPv6 直连 | 不需要专用 tunnel client；可需要 Xpod Agent 做心跳/证书 | 是：Xpod 子域名或用户自有域名 | 否 | 是 | 边缘节点 | 首选路径 |
| Cloudflare Tunnel / `cloudflared` | 是 | 是：Cloudflare 托管域名或用户域名 | 是：Cloudflare | 是 | 通常在 Cloudflare；也可配置到源站 HTTPS | 零公网 IP 备选 |
| Tailscale Serve | 是：`tailscaled` | 不一定需要公网域名 | 是：Tailscale 控制面 + tailnet peer 连接 | 否，默认只在 tailnet 内 | 本机或 tailnet 内服务 | 私有访问/管理面 |
| Tailscale Funnel | 是：`tailscaled` | 使用 Tailscale 分配/管理的公网入口 | 是：Tailscale Funnel | 是 | Tailscale Funnel / 本机配置相关 | 公网备选，域名控制弱 |
| ScaleTail | 是：Tailscale sidecar | 取决于 Serve/Funnel | 取决于 Serve/Funnel | 取决于 Serve/Funnel | 取决于 Serve/Funnel | Tailscale 部署形态，不是独立 provider |
| 自建 FRP | 是：`frpc` | 是：Xpod 子域名或用户域名 | 是：我们或用户维护 `frps` | 是 | Xpod Cloud / frps 前置网关 / 边缘节点，取决于部署 | 可控但运维成本高 |
| Xpod Cloud Relay | 是：Xpod Agent 或本地网关 | 是：Xpod 子域名 | 是：Xpod Cloud | 是 | 优先节点端到端；若 L7 relay 终止 TLS 必须明示 | 显式、限额、临时/诊断兜底，非默认路径 |
| SakuraFRP / 公共 FRP | 是：`frpc` | 通常由第三方或用户配置 | 是：第三方 FRP 平台 | 是 | 第三方平台或源站，取决于配置 | 个人用户备选 |
| raw TCP 打洞 / NATMap 类 | 是：native/CLI/desktop/mobile runtime 或路由器插件 | 可选；普通浏览器、WebID、OAuth 回调仍需要稳定 HTTPS URL | 默认不走固定数据中转；可用 Xpod 控制面做发现/信令辅助 | 普通浏览器不可直接使用 raw TCP；native client 可用 | 边缘节点或 native client | 非浏览器数据面优化路径 |
| ngrok / localtunnel 类 | 是 | 通常第三方分配临时域名 | 是：第三方平台 | 是 | 第三方平台 | 开发调试，不作为生产默认 |

### raw TCP 打洞类方案

raw TCP 打洞和 NATMap 这类方案需要单独看待：它们的目标不是把流量经由固定
中转服务器转发，而是在 native runtime 中用 TCP simultaneous open 尽量直连到边缘节点。网上也有
“无服务器打洞”的变体讨论，例如《其实最优雅的TCP打洞算法，连一台服务器都不需要》
提到的 Aul Ma `tcp_punch.py` 思路：用时间 bucket 作为双方无需通信即可共享的
参数，再由 bucket 派生端口候选列表，双方并行发起 TCP SYN，并用简单的 winner
selection 选出成功连接。

这类方案很有启发，但对 NAT 类型、运营商 CGNAT、端口保持、路由器能力、
系统权限和发现机制都更敏感。上述文章也明确把可用性取舍放在核心位置：牺牲
一部分路由器覆盖率，换取零额外探测服务、零 NTP、零固定数据中转服务器的极简实现。

参考：

- https://zhuanlan.zhihu.com/p/2049858541763220757
- https://robertsdotpm.github.io/_downloads/3ff8af7dd7b8df02dc52551b4bbaa7d1/tcp_punch.py

对 Xpod 的判断：

- 它通常**仍需要客户端/守护进程**，例如在边缘节点或路由器上运行打洞程序。
- 普通浏览器不能直接使用 raw TCP socket、同号端口 bind 或 TCP simultaneous open；浏览器
  访问仍应走 HTTPS/SP route。Chrome Isolated Web App 的 Direct Sockets 可作为安装式 runtime 研究项，但不作为
  普通浏览器能力或当前产品承诺。
- 如果要给 WebID、OAuth 回调或普通浏览器使用，**稳定域名问题仍然存在**；即使
  打洞本身不需要域名，也需要 Xpod 控制面把动态公网地址/端口和 route 状态分发给 managed client。
- 它可以减少或消除固定流量中转服务器，但仍可能需要 Xpod 控制面提供最近观测到的公网地址、
  在线状态和会话鉴权；“完全无服务器”不应作为默认可用性假设。
- 适合 Desktop / CLI / Native app 的非浏览器数据面优化；不适合作为普通浏览器的默认公网 Pod 入口。

### 产品判断

- Xpod 的默认优先级应是：**same-device / LAN > 公网 IPv4/IPv6 直连 > 信令协助的 P2P > 用户自管 tunnel > 显式限额的 Xpod Cloud relay**。
- 只要要给普通浏览器、Solid WebID、OAuth/OIDC 回调使用，最终都需要稳定
  HTTPS URL；“不需要域名”的方案通常只适合作为私有管理通道。
- “需要客户端”不是坏事。Local / Edge 场景本来就有 Xpod Agent，可以由 Agent
  管理 `cloudflared`、`frpc` 或 `tailscaled` 的生命周期；关键是要明确进程由谁
  安装、启动、升级和回收。
- “需要服务器/中转”决定信任边界和成本。流量经过 Cloudflare、Tailscale、第三方 FRP
  或 Xpod Cloud 时，需要在文档和 UI 中明确 TLS 终止点、可见明文范围、带宽限额和性能预期。
- Xpod Cloud 已经解决域名分配问题，但域名分配不等于默认 Cloud 数据转发；Web 远程访问 Local Pod 不是当前主推路径，Desktop / CLI / Native client 才是 Local Pod 的主力访问端。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloud 模式                               │
│  (api.undefieds.co - 持有所有密钥)                              │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 密钥:                                                    │   │
│  │  - CLOUDFLARE_API_TOKEN (创建 Tunnel + DNS)              │   │
│  │  - CLOUDFLARE_ACCOUNT_ID                                 │   │
│  │  - TENCENT_DNS_SECRET_ID/KEY (管理 DNS 记录)             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  服务:                                                          │
│  - SubdomainService: 域名注册、连通性检测、DNS 管理              │
│  - TunnelProvider: 创建 Cloudflare Tunnel                       │
│  - DnsProvider: 创建 DNS 记录 (A/CNAME)                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ API 调用
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Local 模式                               │
│  (用户本地运行)                                                  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 托管式 (使用我们分配的域名):                              │   │
│  │  - XPOD_CLOUD_API_ENDPOINT=https://api.undefieds.co      │   │
│  │  - XPOD_NODE_ID=node-xxx                                 │   │
│  │  - XPOD_NODE_TOKEN=xxx (调用 Cloud API)                  │   │
│  │  - CLOUDFLARE_TUNNEL_TOKEN=xxx (启动 cloudflared)        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 自管式 (用户自己的域名):                                  │   │
│  │  - CSS_BASE_URL=https://my-pod.example.com               │   │
│  │  - CLOUDFLARE_TUNNEL_TOKEN=xxx (可选，我们帮启动)         │   │
│  │  - 用户自己配置 DNS                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  服务:                                                          │
│  - SubdomainClient: 调用 Cloud API (托管式)                     │
│  - LocalTunnelProvider: 启动 cloudflared (检测已运行则跳过)     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 域名结构

```
undefieds.co                           ← 根域名
     │
     └── pods.undefieds.co             ← Pod 服务域名
              │
              ├── pods.undefieds.co/<pod-id>           ← 托管用户（Center）
              │
              └── xxx.pods.undefieds.co/<pod-id>       ← 边缘用户（Edge）
                   │
                   └── xxx = 边缘节点名称（如 mynode、home、office）
```

### WebID 示例

```
托管用户: https://pods.undefieds.co/alice/profile/card#me
边缘用户: https://mynode.pods.undefieds.co/alice/profile/card#me
```

---

## Local 模式配置

### 托管式 (使用我们分配的域名)

用户在 Web 控制台注册节点后，获得以下配置：

```bash
# .env
XPOD_EDITION=local

# Cloud API 认证 (调用 api.undefieds.co)
XPOD_CLOUD_API_ENDPOINT=https://api.undefieds.co
XPOD_NODE_ID=node-abc123
XPOD_NODE_TOKEN=sk-xxxxxxxxxxxxx

# Cloudflare Tunnel (启动 cloudflared)
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoixxxxxxxxx
```

**启动流程**：

```
1. Local 启动
2. 检测 cloudflared 是否已运行
   ├── 已运行 → 跳过，使用现有隧道
   └── 未运行 → 用 CLOUDFLARE_TUNNEL_TOKEN 启动 cloudflared
3. 隧道连接成功
4. 访问 https://mynode.pods.undefieds.co
```

### 自管式 (用户自己的域名)

用户自己有域名，自己配置 DNS：

```bash
# .env
XPOD_EDITION=local

# 外部访问地址
CSS_BASE_URL=https://my-pod.example.com

# 可选：我们帮启动 cloudflared
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoixxxxxxxxx
```

**两种子情况**：

| 情况 | DNS 配置 | 隧道 |
|------|---------|------|
| 有公网 IP | A 记录指向服务器 | 不需要 |
| 无公网 IP | 用户自己在 Cloudflare 创建 Tunnel | 用户启动或我们帮启动 |

---

## Cloud 模式配置

Cloud 模式运行在 `api.undefieds.co`，持有所有密钥：

```bash
# .env
XPOD_EDITION=cloud

# 启用子域名功能
XPOD_SUBDOMAIN_ENABLED=true
# Cloudflare (创建 Tunnel + DNS)
CLOUDFLARE_API_TOKEN=xxx
CLOUDFLARE_ACCOUNT_ID=xxx

# 腾讯云 DNS
TENCENT_DNS_SECRET_ID=xxx
TENCENT_DNS_SECRET_KEY=xxx
```

---

## API 设计

### Cloud API (api.undefieds.co)

```
# 检查域名可用性
GET /v1/subdomain/check?name=mynode
Authorization: Bearer {XPOD_NODE_TOKEN}
Response: { "available": true, "suggestion": null }

# 注册域名
POST /v1/subdomain/register
Authorization: Bearer {XPOD_NODE_TOKEN}
Body: { "name": "mynode" }
Response: {
  "subdomain": "mynode.pods.undefieds.co",
  "mode": "tunnel",
  "tunnelToken": "eyJhIjoixxxx..."
}

# 释放域名
DELETE /v1/subdomain/{name}
Authorization: Bearer {XPOD_NODE_TOKEN}

# 启动隧道 (通知 Cloud 隧道已启动)
POST /v1/subdomain/{name}/tunnel/start
Authorization: Bearer {XPOD_NODE_TOKEN}

# 停止隧道
POST /v1/subdomain/{name}/tunnel/stop
Authorization: Bearer {XPOD_NODE_TOKEN}
```

### Local API (代理到 Cloud)

托管式 Local 提供相同的 API 端点，内部调用 Cloud：

```
Local /v1/subdomain/* → SubdomainClient → Cloud /v1/subdomain/*
```

---

## Cloudflared 检测逻辑

Local 启动时检测 cloudflared 是否已在运行：

```typescript
async isCloudflaredRunning(): Promise<boolean> {
  // 方法1：检测进程
  // pgrep -x cloudflared (Linux/macOS)
  // tasklist | find "cloudflared" (Windows)
  
  // 方法2：检测 metrics 端口
  // GET http://localhost:33863/ready
  
  return processRunning || metricsPortOpen;
}

async start(config: TunnelConfig): Promise<void> {
  if (await this.isCloudflaredRunning()) {
    console.log('cloudflared already running, skipping start');
    this.managedByUs = false;
    return;
  }
  
  // 启动 cloudflared
  spawn('cloudflared', ['tunnel', 'run', '--token', config.tunnelToken]);
  this.managedByUs = true;
}

async stop(): Promise<void> {
  if (!this.managedByUs) {
    console.log('Not managed by us, skipping stop');
    return;
  }
  // 停止进程
}
```

---

## 代码结构

```
src/
├── api/
│   ├── container/
│   │   ├── types.ts              # 容器类型定义
│   │   ├── index.ts              # 容器入口 + 配置加载
│   │   ├── common.ts             # 共享服务注册
│   │   ├── cloud.ts              # Cloud 模式服务注册
│   │   ├── local.ts              # Local 模式服务注册
│   │   └── routes.ts             # 路由注册
│   │
│   ├── handlers/
│   │   ├── SubdomainHandler.ts       # Cloud 模式路由
│   │   └── SubdomainClientHandler.ts # Local 托管式路由
│   │
│   └── main.ts                   # API 入口
│
├── subdomain/
│   ├── SubdomainService.ts       # Cloud 模式核心逻辑
│   └── SubdomainClient.ts        # Local 调用 Cloud 的客户端
│
├── tunnel/
│   ├── TunnelProvider.ts             # 隧道接口
│   └── CloudflareTunnelProvider.ts   # Cloudflare 实现
│
└── dns/
    ├── DnsProvider.ts            # DNS 接口
    └── TencentDnsProvider.ts     # 腾讯云实现
```

---

## 测试准备

### Cloud 模式测试

需要准备：

1. **Cloudflare 账号**
   - [ ] 创建 API Token (Cloudflare Tunnel + DNS 权限)
   - [ ] 获取 Account ID
   - [ ] 域名托管到 Cloudflare (或使用 Cloudflare DNS)

2. **腾讯云 DNS**
   - [ ] 创建 API 密钥 (SecretId + SecretKey)
   - [ ] 域名 `pods.undefieds.co` 已配置

3. **环境变量**
   ```bash
   XPOD_EDITION=cloud
   XPOD_SUBDOMAIN_ENABLED=true
   XPOD_SUBDOMAIN_BASE_DOMAIN=pods.undefieds.co
   CLOUDFLARE_API_TOKEN=xxx
   CLOUDFLARE_ACCOUNT_ID=xxx
   TENCENT_DNS_SECRET_ID=xxx
   TENCENT_DNS_SECRET_KEY=xxx
   ```

### Local 托管式测试

需要准备：

1. **在 Cloud 注册节点**
   - [ ] 获取 NODE_ID
   - [ ] 获取 NODE_TOKEN
   - [ ] 获取 CLOUDFLARE_TUNNEL_TOKEN

2. **环境变量**
   ```bash
   XPOD_EDITION=local
   XPOD_CLOUD_API_ENDPOINT=https://api.undefieds.co
   XPOD_NODE_ID=node-xxx
   XPOD_NODE_TOKEN=xxx
   CLOUDFLARE_TUNNEL_TOKEN=xxx
   ```

3. **安装 cloudflared**
   ```bash
   # macOS
   brew install cloudflared
   
   # Linux
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
   chmod +x cloudflared
   ```

### Local 自管式测试

需要准备：

1. **自己的域名和 Tunnel**
   - [ ] 在 Cloudflare 创建 Tunnel
   - [ ] 获取 Tunnel Token
   - [ ] 配置 DNS (CNAME 到 tunnel)

2. **环境变量**
   ```bash
   XPOD_EDITION=local
   CSS_BASE_URL=https://my-pod.example.com
   CLOUDFLARE_TUNNEL_TOKEN=xxx  # 可选
   ```

---

## 阶段规划

| 阶段 | DNS | 隧道 | 状态 |
|------|-----|------|------|
| **阶段 1** | 腾讯云 | Cloudflare Tunnel | 当前 |
| **阶段 2** | 腾讯云 | 自建 FRP | 计划中 |

### 阶段 2：自建 FRP

迁移时机：
- 边缘用户 > 100
- 国内用户占比 > 50%
- 用户反馈 Cloudflare 延迟问题

届时新增 `FrpTunnelProvider`，实现相同接口，平滑迁移。
