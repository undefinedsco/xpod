# 域名与隧道方案

> 本文档描述 xpod 边缘节点的域名分配和隧道穿透方案。

## 目标

为 Edge 用户提供：
1. **免费二级域名** - 如 `mynode.pods.undefieds.co`
2. **公网访问** - 有公网 IP 直连，没公网走隧道
3. **自动 HTTPS** - 证书由 Cloudflare 处理

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
CSS_EDITION=local

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
CSS_EDITION=local

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
CSS_EDITION=cloud

# 启用子域名功能
XPOD_SUBDOMAIN_ENABLED=true
XPOD_SUBDOMAIN_BASE_DOMAIN=pods.undefieds.co

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
