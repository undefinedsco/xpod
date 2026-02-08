# 边缘节点部署模式

本文档描述 XPod 边缘节点的不同部署模式及其网络配置。

## 概述

边缘节点支持两种主要场景：

| 场景 | 描述 | DNS/证书管理 | 用户配置复杂度 |
|------|------|-------------|---------------|
| **场景 1** | 使用 XPod Cloud 服务 | Cloud 托管 | 零配置 |
| **场景 2** | 用户自己的域名 | 用户自己管理 | 需要配置 |

---

## 场景 1：使用 XPod Cloud 服务

用户使用 `*.pods.undefineds.co` 域名，由 Cloud 统一管理。

### 架构

```
┌────────────┐                    ┌─────────────┐                    ┌────────────┐
│   用户      │      HTTPS        │   XPod      │      内部通信       │  边缘节点   │
│   浏览器    │ ◄───────────────► │   Cloud     │ ◄─────────────────► │           │
└────────────┘                    └─────────────┘                    └────────────┘
```

### 子场景

#### 1A：边缘节点有公网 IPv6 ⭐ 推荐模式

- Cloud 检测到边缘节点有公网 IPv6
- Cloud 创建 AAAA DNS 记录指向边缘节点 IPv6
- Cloud 代签 Let's Encrypt 证书（DNS-01 验证）
- **流量直连边缘节点，不经过 Cloud 代理**

```
用户浏览器 ──HTTPS──► 边缘节点 (IPv6 直连)
                      │
                      └── Let's Encrypt 证书（Cloud 代签）
```

**性能特点：**
- ✅ 速度快（实测本地 18ms）
- ✅ 低延迟
- ✅ 无额外转发开销

**适用条件：**
- 边缘节点有公网 IPv6 地址
- 用户也有 IPv6 访问能力

**用户配置：**
```yaml
# 边缘节点配置
CSS_SIGNAL_ENDPOINT=https://cloud.undefineds.co/api/signal
CSS_NODE_ID=node-xxx
CSS_NODE_TOKEN=xxx
# IPv6 自动检测，无需配置
```

#### 1B：边缘节点无公网 IP（Tunnel 模式）⚠️ 备选方案

- 使用 FRP/Tunnel 穿透
- 流量经过 Cloud 代理
- SSL 终止在 Cloud

```
用户浏览器 ──HTTPS──► Cloud ══Tunnel══► 边缘节点
                       │
                       └── SSL 终止点
```

**性能特点：**
- ❌ 速度慢（实测 SSL 握手 6.5s，总耗时 20s+）
- ❌ Cloudflare Tunnel 路由到境外节点（LAX）
- ❌ Tunnel 协议额外开销

**适用条件：**
- 边缘节点无公网 IP
- 用户没有 IPv6

**用户配置：**
```yaml
# 边缘节点配置
CSS_SIGNAL_ENDPOINT=https://cloud.undefineds.co/api/signal
CSS_NODE_ID=node-xxx
CSS_NODE_TOKEN=xxx
# 自动检测无公网 IP，启用 Tunnel
```

### DNS 与证书

| 子场景 | DNS 记录 | 证书签发 | 证书存储 |
|--------|---------|---------|---------|
| 1A (有 IPv6) | Cloud 创建 AAAA | Cloud 代签 (DNS-01) | 边缘节点本地 |
| 1B (无公网 IP) | Cloud 创建 CNAME → Tunnel | Cloud 管理 | Cloud |

### 安全性

| 子场景 | 端到端加密 | Cloud 可见明文 |
|--------|-----------|---------------|
| 1A | ✅ 是 | ❌ 否 |
| 1B | ❌ 否 | ⚠️ 是（SSL 终止在 Cloud） |

---

## 场景 2：用户自己的域名

用户有自己的域名（如 `mypod.example.com`），通过 Cloudflare 管理。

### 子场景

#### 2A：用户有公网 IPv6 ⭐ 推荐模式

用户服务器有公网 IPv6 地址。

```
用户浏览器 ──HTTPS──► 用户服务器 (IPv6 直连)
                      │
                      └── Let's Encrypt 证书（本地签发）
```

**Cloudflare 配置（用户手动）：**
1. DNS 记录：AAAA 记录指向用户公网 IPv6
2. 代理状态：**灰色云（仅 DNS，不代理）**
3. SSL 模式：不适用（不经过 Cloudflare）

**边缘节点配置：**
```yaml
CSS_BASE_URL=https://mypod.example.com/
CSS_ACME_EMAIL=user@example.com
CSS_ACME_DOMAINS=mypod.example.com

# Cloudflare DNS API（用于 DNS-01 验证签证书）
CSS_CLOUDFLARE_API_TOKEN=xxxx
CSS_CLOUDFLARE_ZONE_ID=xxxx  # 可选
```

**或者使用腾讯云 DNS：**
```yaml
CSS_BASE_URL=https://mypod.example.com/
CSS_ACME_EMAIL=user@example.com
CSS_ACME_DOMAINS=mypod.example.com

# 腾讯云 DNS API
TENCENT_SECRET_ID=xxxx
TENCENT_SECRET_KEY=xxxx
```

**证书签发方式：**

| 条件 | 验证方式 | 需要 DNS API |
|------|---------|-------------|
| 80 端口可访问 | HTTP-01 | ❌ 不需要 |
| 443 端口可访问 | TLS-ALPN-01 | ❌ 不需要 |
| 端口被封（常见于家庭宽带） | DNS-01 | ✅ 需要 Cloudflare/腾讯 API |

**性能特点：**
- ✅ 速度快（直连）
- ✅ 低延迟
- ✅ 无额外转发开销

**安全性：**
- ✅ 端到端加密
- ✅ Cloudflare 无法看到明文
- ✅ 完全安全

#### 2B：用户无公网 IP（Tunnel 模式）⚠️ 备选方案

用户服务器没有公网 IP，需要使用 Cloudflare Tunnel 穿透。

```
用户浏览器 ──HTTPS──► Cloudflare ══Tunnel══► 用户服务器
                       │
                       └── SSL 终止点（Flexible 模式）
```

**Cloudflare 配置（用户手动）：**
1. 创建 Tunnel，获取 Token
2. 配置 Public Hostname：`mypod.example.com` → `localhost:端口`
3. SSL 模式：**Flexible**

**边缘节点配置：**
```yaml
CSS_BASE_URL=https://mypod.example.com/
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoixxxx...
# 不需要本地证书
```

**性能特点：**
- ❌ 速度慢（Cloudflare Tunnel 路由到境外节点）
- ❌ Tunnel 协议额外开销

**安全性：**
- ⚠️ SSL 终止在 Cloudflare
- ⚠️ Cloudflare 可以看到明文
- 适合对隐私要求不高的场景

---

## 配置对比总结

| 场景 | 公网 IP | DNS 管理 | 证书管理 | SSL 终止点 | 安全性 | 速度 |
|------|--------|---------|---------|-----------|--------|------|
| 1A | ✅ IPv6 | Cloud | Cloud 代签 | 边缘节点 | ✅ 端到端 | ⭐⭐⭐⭐⭐ |
| 1B | ❌ | Cloud | Cloud | Cloud | ⚠️ Cloud 可见 | ⭐ |
| 2A | ✅ IPv6 | 用户 (Cloudflare/腾讯) | 本地 ACME | 用户服务器 | ✅ 端到端 | ⭐⭐⭐⭐⭐ |
| 2B | ❌ | 用户 (Cloudflare) | Cloudflare | Cloudflare | ⚠️ CF 可见 | ⭐ |

---

## 自动检测与最优路径选择

### 检测流程

边缘节点启动时自动检测网络环境，选择最优流量路径：

```
启动
  │
  ▼
检测公网 IPv6
  │
  ├─── 有公网 IPv6 ───► 场景 A（直连模式）
  │                      │
  │                      ├── 场景 1A: 使用 XPod Cloud
  │                      └── 场景 2A: 用户自己的域名
  │
  └─── 无公网 IPv6 ────► 场景 B（隧道模式）
                        │
                        ├── 场景 1B: 使用 FRP Tunnel
                        └── 场景 2B: 使用 Cloudflare Tunnel
```

### 检测实现

#### 1. 公网 IPv6 检测 (`EdgeNodeCapabilityDetector`)

```typescript
class EdgeNodeCapabilityDetector {
  async detectNetworkAddresses(): Promise<NetworkAddressInfo> {
    const publicIpv6 = await this.fetchPublicIPv6();
    const publicIpv4 = await this.fetchPublicIPv4();
    return { publicIpv4, publicIpv6, localAddresses };
  }

  private async fetchPublicIPv6(): Promise<string | null> {
    const response = await fetch('https://api64.ipify.org');
    return await response.text();
  }
}
```

#### 2. 模式选择 (`EdgeNodeModeDetector`)

```typescript
class EdgeNodeModeDetector {
  async detectMode(nodeInfo: NodeRegistrationInfo): Promise<ModeDetectionResult> {
    const hasPublicIpv6 = Boolean(nodeInfo.publicIpv6);

    if (hasPublicIpv6) {
      // 优先使用 IPv6 直连
      const connectivityTest = await this.testDirectConnectivity(
        nodeInfo.publicIpv6,
        nodeInfo.publicPort ?? 443
      );

      if (connectivityTest.success) {
        return {
          accessMode: 'direct',
          reason: 'IPv6 direct connection available',
          subdomain: this.generateSubdomain(nodeInfo.nodeId)
        };
      }
    }

    // Fallback to Tunnel mode
    return {
      accessMode: 'proxy',
      reason: 'No public IPv6, using Tunnel',
      subdomain: this.generateSubdomain(nodeInfo.nodeId)
    };
  }
}
```

#### 3. 用户侧检测与路由

**场景 1（使用 XPod Cloud）：**
- 由 Cloud 根据边缘节点上报的 IPv6 信息决定 DNS 记录类型
- 用户无需配置，自动优化

**场景 2（用户自己的域名）：**
- 用户根据是否有公网 IPv6 选择配置：
  - 有 IPv6：使用灰色云（DNS only）+ 本地 ACME
  - 无 IPv6：使用橙色云 + Tunnel

---

## 性能对比实测

| 连接方式 | SSL 握手 | 总时间 | 节点 |
|---------|----------|--------|------|
| 本地直连 | 18ms | 18ms | - |
| Cloudflare Tunnel (LAX) | 6.5s | 21s | 洛杉矶 |
| 直接 nginx (无 CDN) | 0.9s | 2.5s | 弗吉尼亚 |

**结论：**
- IPv6 直连是最优方案
- Tunnel 模式速度慢 1000 倍以上
- Tunnel 路由到境外节点，导致高延迟

---

## DNS Provider 配置

### Cloudflare DNS Provider (场景 2A)

```typescript
import { CloudflareDnsProvider } from './dns/cloudflare/CloudflareDnsProvider';

const dnsProvider = new CloudflareDnsProvider({
  apiToken: process.env.CSS_CLOUDFLARE_API_TOKEN,
  zoneId: process.env.CSS_CLOUDFLARE_ZONE_ID,
  domain: 'example.com'
});

// DNS-01 验证
await dnsProvider.upsertRecord({
  name: '_acme-challenge.mypod',
  type: 'TXT',
  value: '验证token'
});
```

### 腾讯云 DNS Provider (场景 2A)

```typescript
import { TencentDnsProvider } from './dns/tencent/TencentDnsProvider';

const dnsProvider = new TencentDnsProvider({
  secretId: process.env.TENCENT_SECRET_ID,
  secretKey: process.env.TENCENT_SECRET_KEY,
  domain: 'example.com'
});
```

---

## 开发任务

### 已完成

- [x] IPv6 公网地址自动检测 (`EdgeNodeCapabilityDetector`)
- [x] 心跳上报 IPv4/IPv6 地址 (`EdgeNodeHeartbeatService`)
- [x] EdgeNodeAgent 集成网络检测
- [x] DNS 协调器支持 IPv6 优先 (`EdgeNodeDnsCoordinator`)
- [x] 模式检测支持 IPv6 (`EdgeNodeModeDetector`)
- [x] 信令处理支持 IPv6 (`EdgeNodeSignalHttpHandler`)
- [x] CloudflareDnsProvider 实现
- [x] 多 DNS Provider 接口统一 (`ListableDnsProvider`)

### 待开发

- [ ] 2A/2B 配置区分实现（配置驱动）
- [ ] HTTP-01 验证支持（端口可用时免 API）
- [ ] TLS-ALPN-01 验证支持（端口可用时免 API）
- [ ] AcmeCertificateManager 集成多种验证方式
- [ ] 用户配置文档和示例
- [ ] 自动路由选择 UI（帮助用户选择最优配置）

---

## 附录

### Cloudflare API Token 权限

场景 2A 用户需要创建受限的 Cloudflare API Token：

**权限设置：**
- Zone - DNS - Edit
- Zone - Zone - Read

**Zone 范围：**
- 指定域名（如 `example.com`）

这样 Token 只能编辑 DNS 记录，无法访问其他 Cloudflare 功能。

### 腾讯云 API 密钥权限

场景 2A 用户使用腾讯云 DNS：

**权限设置：**
- 访问管理 → API 密钥管理 → 创建密钥
- 选择：`DNSPod 访问权限`

**域名绑定：**
- 在腾讯云 DNSPod 控制台绑定密钥到指定域名

### Tunnel 性能优化建议

如果必须使用 Tunnel 模式（无 IPv6），可以尝试：

1. **使用国内服务器 + FRP** - 替代 Cloudflare Tunnel
2. **Cloudflare WARP** - 可能优化路由（效果不确定）
3. **Cloudflare 付费版** - 更好的路由优化（未验证）

但无论如何，这些方案都不如 IPv6 直连。

### 推荐部署策略

**优先级排序：**

1. ⭐⭐⭐⭐⭐ **IPv6 直连**（场景 1A/2A） - 最优方案
2. ⭐ **Tunnel 模式**（场景 1B/2B） - 备选方案，仅当无 IPv6 时使用

**IPv6 普及率：**
- 中国大陆：约 70%+
- 全球：约 40%+
- 家庭宽带：大部分已支持

**建议：**
- 优先推广 IPv6 直连模式
- Tunnel 作为 fallback，明确告知性能影响
