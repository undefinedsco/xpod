# XPOD 架构 V2：身份与存储分离

> 本文档描述 XPOD 从"Pod 托管平台"向"去中心化 Pod 管理与身份服务平台"的架构升级。

## 1. 核心目标

通过实施**身份(IdP)与存储(SP)分离架构**，实现：

1. **WebID 永久稳定** - 用户身份 URL 不因网络环境变化而改变
2. **灵活的存储选择** - 用户可选择托管或自托管
3. **数据主权** - 自托管用户数据在用户侧，平台不接触
4. **合规安全** - 自托管模式规避内容审核风险

---

## 2. 部署模式

### 2.1 三种模式概览

| 模式 | WebID 位置 | 数据存储 | 适用场景 |
|------|-----------|---------|---------|
| **Cloud 托管** | Cloud | Cloud | 普通用户，开箱即用 |
| **Local 自托管** | Cloud | Local | 技术用户，数据主权 |
| **完全自托管** | Local | Local | 企业用户，完全自主 |

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Cloud (IdP + 可选 SP)                            │
│                         undefineds.co                                   │
│                                                                         │
│  ┌──────────────────────────────────┐  ┌─────────────────────────────┐ │
│  │ 身份服务 (IdP)                    │  │ 托管存储 (SP) - 可选        │ │
│  │                                  │  │                             │ │
│  │ - WebID Profile 托管             │  │ - 用户 Pod 数据             │ │
│  │ - OIDC 认证                      │  │ - 文件存储 (COS/Minio)      │ │
│  │ - Storage 指针管理               │  │ - 元数据 (PostgreSQL)       │ │
│  │                                  │  │                             │ │
│  │ 域名: id.undefineds.co           │  │ 域名: pods.undefineds.co    │ │
│  └──────────────────────────────────┘  └─────────────────────────────┘ │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 控制面服务                                                        │  │
│  │ - DDNS 服务 (*.undefineds.xyz)                                   │  │
│  │ - 节点注册与心跳                                                  │  │
│  │ - Cloudflare Tunnel 管理                                         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 心跳 / Storage 指针更新
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Local (SP) - 可选                                │
│                         alice.undefineds.xyz                            │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 本地存储服务                                                      │  │
│  │ - Solid Pod 服务 (CSS)                                           │  │
│  │ - 数据存储 (用户硬盘)                                             │  │
│  │ - HTTPS 证书 (Let's Encrypt)                                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  网络接入: 公网IP / UPnP / CF Tunnel / SakuraFRP                        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 模式详解

### 3.1 Cloud 托管模式

**适用用户**: 普通用户，不想折腾，开箱即用

```
WebID:    https://pods.undefineds.co/alice/profile/card#me
Storage:  https://pods.undefineds.co/alice/
```

**特点**:
- WebID 和 Storage 在同一位置
- 数据存储在我们的服务器
- 用户无需任何技术配置
- 我们负责备份、可用性、安全

**合规要求**:
- 需要 ICP 备案
- 需要内容审核机制
- 需要用户实名认证（如适用）

### 3.2 Local 自托管模式（推荐）

**适用用户**: 技术用户，关注数据主权，有公网访问能力

```
WebID:    https://id.undefineds.co/alice/profile/card#me   (永久稳定，Cloud托管)
Storage:  https://alice.undefineds.xyz/                    (动态，指向 Local)
```

**WebID Profile 示例**:
```turtle
# https://id.undefineds.co/alice/profile/card
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<#me>
    a foaf:Person;
    foaf:name "Alice";
    solid:oidcIssuer <https://id.undefineds.co/>;
    solid:storage <https://alice.undefineds.xyz/>.  # 动态更新
```

**特点**:
- WebID 永久稳定（托管在 Cloud）
- 数据存储在用户本地
- IP 变化时自动更新 DDNS 和 storage 指针
- 平台不接触用户数据

**合规优势**:
- Cloud 仅存储几 KB 的 RDF Profile
- 不存储用户上传的任何文件
- 降低内容审核风险

### 3.3 完全自托管模式

**适用用户**: 企业用户，有自己的域名和基础设施

```
WebID:    https://pod.alice.com/profile/card#me
Storage:  https://pod.alice.com/
```

**特点**:
- 用户完全自主
- 使用自己的域名
- 不依赖我们的任何服务
- 可选择性使用我们的 OIDC 服务

---

## 4. 域名策略

### 4.1 域名规划

| 域名 | 用途 | 说明 |
|------|------|------|
| `undefineds.co` | 主站 | 官网、文档 |
| `id.undefineds.co` | 身份服务 | WebID 托管、OIDC |
| `pods.undefineds.co` | 托管存储 | Cloud 托管用户的 Pod |
| `*.undefineds.xyz` | DDNS | Local 自托管用户的动态域名 |

### 4.2 WebID 稳定性保证

**问题**: 用户 IP 变化、域名变化会导致 WebID 失效

**解决方案**: WebID 与 Storage 分离

| 场景 | WebID | Storage | 说明 |
|------|-------|---------|------|
| 初始状态 | `id.undefineds.co/alice` | `alice.undefineds.xyz` | 免费 DDNS |
| IP 变化 | 不变 | 不变（DDNS 自动更新） | 无感知 |
| 升级付费 | 不变 | `alice.pods.undefineds.co` | 仅更新 storage 指针 |
| 绑定自有域名 | 不变 | `pod.alice.com` | 仅更新 storage 指针 |
| 迁移到自托管 | 不变 | `alice.undefineds.xyz` | 仅更新 storage 指针 |

---

## 5. 网络接入策略

### 5.1 Local 节点网络方案

不提供 STUN/TURN 穿透服务，用户需自行解决公网访问：

| 优先级 | 方案 | 说明 | 配置难度 |
|--------|------|------|----------|
| **Level 1** | 公网 IP | 直接使用公网 IP | 无需配置 |
| **Level 2** | IPv6 | 自动检测公网 IPv6 | 无需配置 |
| **Level 3** | UPnP | 自动端口映射 | 无需配置 |
| **Level 4** | Cloudflare Tunnel | 零配置，保底方案 | 一键启用 |
| **Level 5** | 第三方穿透 | SakuraFRP 等 | 用户自行配置 |

### 5.2 为什么不提供 STUN/TURN？

**政策风险**:
- 用户可通过平台基础设施对外提供服务而不进行 ICP 备案
- 平台可能被认定为协助用户规避监管

**决策**: 仅支持用户自行解决公网访问的方案

---

## 6. 合规与风控

### 6.1 托管模式合规

对于 Cloud 托管用户：
- 标准的 ICP 备案流程
- 内容审核机制
- 用户协议和隐私政策

### 6.2 自托管模式风控

对于 Local 自托管用户：

**ACL 限制（可选）**:
- 默认私有化：Pod 初始化时不包含公开权限
- 可配置拦截公开分享请求

**应用白名单（可选）**:
- 仅允许认证的 Solid App 连接
- 防止恶意 App 滥用

**说明**: 这些限制是可选的，用户可以选择完全开放。

---

## 7. API 设计

### 7.1 身份服务 API (Cloud)

```
# WebID Profile
GET  /alice/profile/card                  # 获取 WebID Profile (Solid 标准)
PUT  /alice/profile/card                  # 更新 Profile (需认证)

# Storage 指针更新 (内部 API)
POST /api/v1/identity/{username}/storage
Authorization: Bearer {NODE_TOKEN}
Body: { "storageUrl": "https://alice.undefineds.xyz/" }

# OIDC 端点
GET  /.well-known/openid-configuration
GET  /idp/jwks
POST /idp/token
```

### 7.2 DDNS 服务 API (Cloud)

```
# 更新 DNS 记录
POST /api/v1/ddns/{subdomain}
Authorization: Bearer {NODE_TOKEN}
Body: { "ip": "1.2.3.4", "type": "A" }

# 查询 DNS 记录
GET  /api/v1/ddns/{subdomain}
Authorization: Bearer {NODE_TOKEN}
```

### 7.3 节点管理 API (Cloud)

```
# 节点注册
POST /api/v1/signal/register
Body: { "username": "alice", "publicAddress": "..." }

# 心跳上报
POST /api/v1/signal/heartbeat
Authorization: Bearer {NODE_TOKEN}
Body: { "status": "online", "publicAddress": "...", "metrics": {...} }
```

---

## 8. 数据模型

### 8.1 identity_webid 表 (Cloud)

```sql
CREATE TABLE identity_webid (
  username TEXT PRIMARY KEY,
  webid_url TEXT NOT NULL,           -- https://id.undefineds.co/alice/profile/card#me
  storage_url TEXT,                  -- https://alice.undefineds.xyz/ 或 https://pods.undefineds.co/alice/
  storage_mode TEXT,                 -- 'cloud' | 'local' | 'custom'
  oidc_issuer TEXT,                  -- https://id.undefineds.co/
  profile_data JSONB,                -- WebID Profile 的 JSON-LD 表示
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

### 8.2 ddns_record 表 (Cloud)

```sql
CREATE TABLE ddns_record (
  subdomain TEXT PRIMARY KEY,        -- alice
  domain TEXT NOT NULL,              -- undefineds.xyz
  ip_address TEXT,
  record_type TEXT DEFAULT 'A',      -- 'A' | 'AAAA'
  node_id TEXT REFERENCES edge_node(node_id),
  ttl INT DEFAULT 60,
  updated_at TIMESTAMP
);
```

### 8.3 edge_node 表 (Cloud)

```sql
CREATE TABLE edge_node (
  node_id TEXT PRIMARY KEY,
  username TEXT REFERENCES identity_webid(username),
  public_address TEXT,               -- 当前公网地址
  access_mode TEXT,                  -- 'direct' | 'tunnel'
  tunnel_provider TEXT,              -- 'cloudflare' | 'sakura' | null
  tunnel_token TEXT,                 -- Tunnel Token (加密存储)
  status TEXT,                       -- 'online' | 'offline'
  capabilities JSONB,                -- 节点能力
  last_heartbeat TIMESTAMP
);
```

---

## 9. 配置规范

### 9.1 配置前缀约定

| 前缀 | 用途 | 示例 |
|------|------|------|
| `CSS_*` | Community Solid Server 原生配置 | `CSS_BASE_URL`, `CSS_PORT` |
| `XPOD_*` | XPOD 扩展功能配置 | `XPOD_EDITION`, `XPOD_NODE_TOKEN` |
| `CLOUDFLARE_*` | Cloudflare 服务配置 | `CLOUDFLARE_TUNNEL_TOKEN` |
| `SAKURA_*` | SakuraFRP 服务配置 | `SAKURA_TOKEN` |

### 9.2 Cloud 模式配置

```bash
# === XPOD 配置 ===
XPOD_EDITION=cloud
XPOD_EDGE_NODES_ENABLED=true     # 接受 Local 节点注册
XPOD_SUBDOMAIN_ENABLED=true      # 提供 DDNS 服务

# === CSS 配置 ===
CSS_BASE_URL=https://pods.undefineds.co
CSS_PORT=6300
CSS_SPARQL_ENDPOINT=postgresql://user:pass@host:5432/db
CSS_IDENTITY_DB_URL=postgresql://user:pass@host:5432/db

# === 对象存储 ===
CSS_MINIO_ENDPOINT=cos.ap-beijing.myqcloud.com
CSS_MINIO_ACCESS_KEY=xxx
CSS_MINIO_SECRET_KEY=xxx
CSS_MINIO_BUCKET_NAME=xxx

# === Redis (分布式锁) ===
CSS_REDIS_CLIENT=redis://host:6379

# === DNS Provider (Cloudflare) ===
CLOUDFLARE_API_TOKEN=xxx
CLOUDFLARE_ACCOUNT_ID=xxx
```

### 9.3 Local 托管式配置

连接 Cloud，使用 Cloud 的身份服务和 DDNS。

```bash
# === XPOD 配置 ===
XPOD_EDITION=local
XPOD_NODE_TOKEN=xxx              # 包含用户信息，有此项则自动连接 Cloud

# === CSS 配置 ===
CSS_PORT=5737

# === 隧道 (可选，根据网络情况选择) ===
# 方案1: 有公网 IP / UPnP - 无需配置

# 方案2: Cloudflare Tunnel
CLOUDFLARE_TUNNEL_TOKEN=xxx

# 方案3: SakuraFRP
SAKURA_TOKEN=xxx
```

### 9.4 Local 独立式配置

不连接 Cloud，完全独立运行。

```bash
# === XPOD 配置 ===
XPOD_EDITION=local
# 没有 XPOD_NODE_TOKEN，表示独立运行

# === CSS 配置 ===
CSS_BASE_URL=https://pod.alice.com    # 自己的域名
CSS_PORT=5737
CSS_OIDC_ISSUER=https://id.undefineds.co  # 可选，使用 Cloud IdP
```

### 9.5 隧道检测逻辑

Local 节点启动时，按以下顺序检测网络接入方式：

```typescript
function detectNetworkAccess() {
  // 1. 用户指定了域名，假设已配置好
  if (process.env.CSS_BASE_URL) {
    return { mode: 'custom', url: process.env.CSS_BASE_URL };
  }

  // 2. Cloudflare Tunnel
  if (process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    return { mode: 'cloudflare', token: process.env.CLOUDFLARE_TUNNEL_TOKEN };
  }

  // 3. SakuraFRP
  if (process.env.SAKURA_TOKEN) {
    return { mode: 'sakura', token: process.env.SAKURA_TOKEN };
  }

  // 4. 自动检测: 公网 IP / IPv6 / UPnP
  return detectPublicAccess();
}
```

---

## 10. 实现计划

### 10.1 Phase 1: 清理 WebRTC 代码 ✅

删除不再需要的 STUN/TURN/WebRTC 相关代码：

```
# 已删除目录
src/webrtc/
src/ice/
src/signaling/
src/sdk/

# 已删除测试文件
scripts/test-webrtc-*.ts
scripts/test-turn-*.ts
scripts/test-signaling-*.ts
scripts/test-werift-*.ts
scripts/test-scenarios.ts

# 已删除 Docker 配置
docker-compose.webrtc-*.yml

# 已删除测试目录
tests/webrtc/
tests/signaling/
tests/ice/
tests/sdk/
```

已清理配置文件中的 WebRTC 相关配置：
- `XPOD_SIGNALING_*`
- `XPOD_STUN_*`
- `XPOD_TURN_*`

### 10.2 Phase 2: 配置重构 ✅

已更新环境变量前缀：
- `CSS_EDITION` → `XPOD_EDITION`
- `CSS_EDGE_NODES_ENABLED` → `XPOD_EDGE_NODES_ENABLED`
- 删除 `CSS_EDGE_AGENT_ENABLED`（由 `XPOD_NODE_TOKEN` 存在与否决定）

已更新配置文件：
- `example.env`
- `example.env.cloud`

### 10.3 Phase 3: 身份服务与 DDNS ✅

**新增数据表：**
- `identity_webid_profile` - WebID Profile 托管
- `identity_ddns_domain` - DDNS 域名池
- `identity_ddns_record` - DDNS 记录

**新增 Repository：**
- `WebIdProfileRepository` - WebID Profile 管理
- `DdnsRepository` - DDNS 记录管理

**新增 API：**
- `GET /{username}/profile/card` - 获取 WebID Profile (Turtle)
- `POST /api/v1/identity` - 创建 Profile
- `POST /api/v1/identity/{username}/storage` - 更新 storage 指针
- `POST /api/v1/ddns/allocate` - 分配子域名
- `POST /api/v1/ddns/{subdomain}` - 更新 DNS 记录
- `DELETE /api/v1/ddns/{subdomain}` - 释放子域名
- `POST /api/v1/ddns/{subdomain}/ban` - 封禁子域名

### 10.4 Phase 4: 已完成

- [x] 在 Cloud 容器中注册 WebIdProfileRepository 和 DdnsRepository
- [x] Local 节点启动时自动向 Cloud 注册并获取 DDNS
- [x] Local 连接 Cloud IdP 进行认证
- [x] 完善 Cloudflare Tunnel 集成
- [x] 接入 SakuraFRP API

---

## 11. 总结

### 11.1 平台定位

通过 V2 架构，XPOD 提供：

1. **身份服务** - WebID 托管、OIDC 认证
2. **托管存储** - 可选，为不想折腾的用户提供
3. **DDNS 服务** - 为自托管用户提供廉价域名
4. **软件工具** - Local 节点软件

### 11.2 核心原则

- **选择自由**: 用户可选择托管或自托管
- **WebID 稳定**: 无论存储在哪，WebID 永不变化
- **合规清晰**: 托管模式走正规流程，自托管模式责任在用户
- **不做穿透**: 不提供 STUN/TURN，避免政策风险
